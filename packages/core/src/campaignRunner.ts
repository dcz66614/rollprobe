/**
 * Campaign execution engine.
 *
 * Drives one scenario end to end against real infrastructure:
 *   provision PostgreSQL -> base migration -> start old build (warm) -> baseline ops
 *   -> expand migration -> start new build -> expanded ops -> mixed ops
 *   -> roll back traffic to old -> app_rollback ops -> evaluate invariants -> teardown
 *
 * Everything that happens is written to the hash-chained event log as it happens, so a
 * crash still leaves usable evidence.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  loadScenario,
  type CheckResult,
  type Invariant,
  type Observation,
  type ParsedScenario,
  type ScenarioOperation,
} from '@rollprobe/protocol';
import {
  DockerPostgresBackend,
  MigrationRunner,
  ResourceRegistry,
  type DatabaseInstance,
} from '@rollprobe/postgres';
import { DeploymentManager, type AppHandle, type AppMode } from '@rollprobe/runner';
import { HttpExecutor, interpolate, readPath } from '@rollprobe/scenario';
import { AssertionExecutor, DiscardProxy } from '@rollprobe/oracle';
import { EventLogger } from '@rollprobe/evidence';
import { buildCoverage, determine, exitCodeFor } from './coverageMatrix.js';
import { executeDiscardRetry } from './discardRetry.js';
import type { CampaignResult, CampaignOptions, OperationTrace } from './types.js';

const PHASE_ORDER = ['baseline', 'expanded', 'mixed', 'app_rollback'] as const;

export class CampaignRunner {
  private deployment = new DeploymentManager();
  private registry = new ResourceRegistry();
  private database: DockerPostgresBackend | null = null;
  private instance: DatabaseInstance | null = null;
  private observer: pg.Pool | null = null;
  private logger: EventLogger | null = null;
  private cleanedResources: string[] = [];
  private resultDir: string | null = null;
  private resultRef: CampaignResult | null = null;

  async run(options: CampaignOptions): Promise<CampaignResult> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const observations: Observation[] = [];
    const operations: OperationTrace[] = [];
    const vars = new Map<string, unknown>();
    const apps: AppHandle[] = [];
    const createdResources: Array<{ type: string; identifier: string }> = [];
    let infrastructureFailure: string | null = null;
    let scenario: ParsedScenario | null = null;

    await mkdir(options.outputDir, { recursive: true });
    const logDir = path.join(options.outputDir, 'apps');
    await mkdir(logDir, { recursive: true });

    const gitSha = options.gitSha ?? detectGitSha(options.workspaceRoot);

    try {
      scenario = await loadScenario(options.scenarioPath);

      this.logger = new EventLogger({
        outputDir: options.outputDir,
        campaignId: options.campaignId,
        runId: options.runId,
        gitSha,
        scenarioId: scenario.scenario.id,
      });
      await this.logger.start();
      await this.logger.log('run_started', {
        scenarioId: scenario.scenario.id,
        scenarioSha256: scenario.sha256,
        oldMode: options.oldMode,
        workspaceRoot: options.workspaceRoot,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      });

      this.database = new DockerPostgresBackend(this.registry);
      this.instance = await this.database.create({ runId: `${options.campaignId}-${options.runId}` });
      createdResources.push({ type: 'container', identifier: this.instance.containerName });
      createdResources.push({ type: 'network', identifier: this.instance.networkName });
      createdResources.push({ type: 'volume', identifier: this.instance.volumeName });

      await this.logger.log('environment_created', {
        containerId: this.instance.containerId,
        containerName: this.instance.containerName,
        host: this.instance.host,
        port: this.instance.port,
        postgresVersion: this.instance.postgresVersion,
        postgresMajor: this.instance.postgresMajor,
      });

      this.observer = new pg.Pool({ connectionString: this.database.connectionString(this.instance, 'observer'), max: 2 });

      // Base schema before the baseline phase.
      const adminUrl = this.database.connectionString(this.instance, 'admin');
      const migrations = new MigrationRunner(async () => {
        const client = new pg.Client({ connectionString: adminUrl });
        await client.connect();
        return client;
      });

      const basePath = path.join(options.workspaceRoot, scenario.scenario.baseMigration);
      const baseResult = await migrations.applyFile(basePath);
      await this.database.refreshGrants(this.instance);
      await this.logger.log('phase_started', {
        phase: 'baseline',
        migration: basePath,
        statements: baseResult.statements,
      });

      // Old build is started before the expand migration on purpose: that is what makes the
      // warm-process scenarios (F05) meaningful.
      const oldApp = await this.deployment.startWithRetry({
        version: 'old',
        mode: options.oldMode as AppMode,
        scriptPath: path.join(options.workspaceRoot, 'fixtures/orders-app/server.mjs'),
        databaseUrl: this.database.connectionString(this.instance, 'app'),
        logDir,
      });
      apps.push(oldApp);

      const oracle = new AssertionExecutor({
        query: async (sql) => {
          const result = await this.observer!.query(sql);
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        httpFor: (actor) => new HttpExecutor(this.deployment.baseUrl(actor)),
        vars,
      });

      const appliedMigrations = new Set<string>([basePath]);
      let appRollbackSwitched = false;

      // Invariants are evaluated at the end of the phase they declare, not all at the end of
      // the run: a violation that exists only during the mixed window must still be caught.
      const checks: CheckResult[] = [];
      const evaluated = new Set<string>();

      for (let phaseIndex = 0; phaseIndex < PHASE_ORDER.length; phaseIndex += 1) {
        const phase = PHASE_ORDER[phaseIndex];
        if (phaseIndex > 0) {
          await this.enterPhase(phase, scenario, options, migrations, appliedMigrations, logDir, apps);
        }

        for (const operation of scenario.scenario.operations.filter((item) => item.phase === phase)) {
          const trace = await this.executeOperation(operation, {
            scenario,
            options,
            vars,
            observations,
            logDir,
            apps,
            oracle,
            onSwitch: (target) => {
              if (target === 'old') appRollbackSwitched = true;
            },
          });
          operations.push(trace);
        }

        for (const invariant of scenario.scenario.invariants) {
          if (invariant.phase !== phase || evaluated.has(invariant.id)) continue;
          const check = await this.evaluateInvariant(invariant, oracle);
          checks.push(check);
          evaluated.add(invariant.id);
          await this.logger.log(
            'check_completed',
            {
              invariantId: check.invariantId,
              phase,
              status: check.status,
              observed: check.observed,
              expected: check.expected,
              reason: check.reason,
              evidenceRefs: check.evidenceRefs,
            },
            { phase }
          );
        }
      }

      if (!appRollbackSwitched && this.deployment.isRunning('new')) {
        // The scenario did not explicitly switch back; make the final routing state explicit.
        this.deployment.switchTraffic('old');
      }

      const coverage = buildCoverage(scenario.scenario.invariants, checks);
      const unexecuted = scenario.scenario.operations
        .filter((op) => !operations.some((trace) => trace.operationId === op.id && trace.status !== 'failed'))
        .map((op) => op.id);
      const determination = determine({ checks, coverage, unexecutedOperations: unexecuted });

      // Capture what the run looked like before teardown, then actually tear down, so the
      // result file reports the cleanup that really happened instead of an empty placeholder.
      const appsSnapshot = this.deployment.describe();
      const databaseSnapshot = this.instance
        ? {
            containerId: this.instance.containerId,
            containerName: this.instance.containerName,
            host: this.instance.host,
            port: this.instance.port,
            postgresVersion: this.instance.postgresVersion,
          }
        : null;
      await this.teardown(Boolean(options.keepDatabase));

      const result: CampaignResult = {
        campaignId: options.campaignId,
        runId: options.runId,
        scenarioId: scenario.scenario.id,
        scenarioTitle: scenario.scenario.title,
        scenarioSha256: scenario.sha256,
        oldMode: options.oldMode,
        gitSha,
        status: determination.status,
        determination,
        coverage,
        checks,
        observations,
        operations,
        environment: {
          database: databaseSnapshot,
          apps: appsSnapshot,
        },
        resources: { created: createdResources, cleaned: this.cleanedResources },
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: exitCodeFor(determination.status),
      };

      await this.writeArtifacts(options.outputDir, scenario, result);
      await this.logger.log('run_completed', {
        status: result.status,
        exitCode: result.exitCode,
        coverage: coverage.summary,
      });

      return result;
    } catch (error) {
      infrastructureFailure = error instanceof Error ? error.message : String(error);
      if (this.logger) {
        await this.logger.log('interrupted', { interruptReason: infrastructureFailure }).catch(() => undefined);
      }

      const emptyCoverage = buildCoverage(scenario?.scenario.invariants ?? [], []);
      const determination = determine({
        checks: [],
        coverage: emptyCoverage,
        infrastructureFailure,
      });

      const result: CampaignResult = {
        campaignId: options.campaignId,
        runId: options.runId,
        scenarioId: scenario?.scenario.id ?? path.basename(options.scenarioPath),
        scenarioTitle: scenario?.scenario.title ?? '',
        scenarioSha256: scenario?.sha256 ?? '',
        oldMode: options.oldMode,
        gitSha,
        status: determination.status,
        determination,
        coverage: emptyCoverage,
        checks: [],
        observations,
        operations,
        environment: { database: null, apps: this.deployment.describe() },
        resources: { created: createdResources, cleaned: [] },
        error: infrastructureFailure,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: exitCodeFor(determination.status),
      };

      if (scenario) {
        await this.writeArtifacts(options.outputDir, scenario, result).catch(() => undefined);
      }
      return result;
    } finally {
      // Idempotent: on the happy path this is a no-op, on the error path it performs the cleanup.
      await this.teardown(Boolean(options.keepDatabase));
      if (this.logger) {
        await this.logger
          .log('environment_destroyed', { cleaned: this.cleanedResources, kept: Boolean(options.keepDatabase) })
          .catch(() => undefined);
      }
      // If the result file was written before teardown (error path), refresh its cleanup list.
      if (this.resultDir && this.resultRef) {
        this.resultRef.resources.cleaned = this.cleanedResources;
        await writeFile(
          path.join(this.resultDir, 'run.json'),
          `${JSON.stringify(this.resultRef, null, 2)}\n`,
          'utf8'
        ).catch(() => undefined);
      }
    }
  }

  /** Stops processes, closes the observer pool and destroys the database. Idempotent. */
  private async teardown(keepDatabase: boolean): Promise<void> {
    await this.deployment.stopAll().catch(() => undefined);

    if (this.observer) {
      await this.observer.end().catch(() => undefined);
      this.observer = null;
    }

    if (this.database && this.instance && !keepDatabase) {
      const instanceId = this.instance.id;
      const report = await this.database.destroy(instanceId).catch((error: Error) => ({
        success: false,
        cleaned: [] as string[],
        errors: [error.message],
      }));
      this.cleanedResources = [...new Set([...this.cleanedResources, ...report.cleaned])];
      this.instance = null;
    }
  }

  private async enterPhase(
    phase: (typeof PHASE_ORDER)[number],
    scenario: ParsedScenario,
    options: CampaignOptions,
    migrations: MigrationRunner,
    applied: Set<string>,
    logDir: string,
    apps: AppHandle[]
  ): Promise<void> {
    if (phase === 'expanded') {
      const expandPath = path.join(
        options.workspaceRoot,
        scenario.scenario.expandMigration.replace('{mode}', options.oldMode)
      );
      if (!applied.has(expandPath)) {
        const result = await migrations.applyFile(expandPath);
        applied.add(expandPath);
        await this.database!.refreshGrants(this.instance!);
        await this.logger!.log('phase_started', {
          phase,
          migration: expandPath,
          statements: result.statements,
        });
      }

      if (!this.deployment.isRunning('new')) {
        const newApp = await this.deployment.startWithRetry({
          version: 'new',
          mode: 'fixed',
          scriptPath: path.join(options.workspaceRoot, 'fixtures/orders-app/server.mjs'),
          databaseUrl: this.database!.connectionString(this.instance!, 'app'),
          logDir,
        });
        apps.push(newApp);
        await this.logger!.log('operation_executed', {
          operationId: 'deploy-new',
          phase,
          app: newApp,
        });
      }
      return;
    }

    if (phase === 'mixed') {
      await this.logger!.log('phase_started', {
        phase,
        note: 'old and new builds are both live against the same database',
        apps: this.deployment.describe(),
      });
      return;
    }

    if (phase === 'app_rollback') {
      this.deployment.switchTraffic('old');
      await this.logger!.log('phase_started', {
        phase,
        note: 'traffic routed back to the old build; schema and committed data are preserved',
        apps: this.deployment.describe(),
      });
    }
  }

  private async executeOperation(
    operation: ScenarioOperation,
    context: {
      scenario: ParsedScenario;
      options: CampaignOptions;
      vars: Map<string, unknown>;
      observations: Observation[];
      logDir: string;
      apps: AppHandle[];
      oracle: AssertionExecutor;
      onSwitch: (target: 'old' | 'new') => void;
    }
  ): Promise<OperationTrace> {
    const started = Date.now();
    const trace: OperationTrace = {
      operationId: operation.id,
      kind: operation.kind,
      phase: operation.phase,
      actor: operation.actor,
      status: 'ok',
      durationMs: 0,
    };

    try {
      if (operation.kind === 'migrate') {
        const file = path.join(context.options.workspaceRoot, interpolate(operation.file, context.vars));
        const migrations = new MigrationRunner(async () => {
          const client = new pg.Client({
            connectionString: this.database!.connectionString(this.instance!, 'admin'),
          });
          await client.connect();
          return client;
        });
        const result = await migrations.applyFile(file);
        trace.detail = { file, statements: result.statements };
      } else if (operation.kind === 'switch') {
        this.deployment.switchTraffic(operation.to);
        context.onSwitch(operation.to);
        trace.detail = { trafficTarget: operation.to };
      } else if (operation.kind === 'http') {
        const actor = operation.actor === 'none' ? this.deployment.activeVersion : operation.actor;
        const executor = new HttpExecutor(this.deployment.baseUrl(actor));
        const spec = interpolate(operation.request, context.vars);
        const result = await executor.execute(spec);
        const observation = this.buildObservation(operation, actor, result);
        await this.recordObservation(observation, context.observations);

        if (result.status === null || !operation.expectStatus.includes(result.status)) {
          trace.status = 'failed';
          trace.detail = { status: result.status, expected: operation.expectStatus, transportError: result.transportError };
        } else {
          for (const [name, expression] of Object.entries(operation.capture)) {
            context.vars.set(name, readPath({ body: result.body, headers: result.responseHeaders }, expression));
          }
          trace.detail = { status: result.status };
        }
      } else if (operation.kind === 'discard_retry') {
        const outcome = await executeDiscardRetry(
          {
            target: operation.target,
            retryTarget: operation.retryTarget,
            logicalOperationId: operation.logicalOperationId,
            idempotencyKey: operation.idempotencyKey,
            request: interpolate(operation.request, context.vars),
            effectSql: operation.effectSql,
            effectExpectedMin: operation.effectExpectedMin,
          },
          {
            startProxy: async () => {
              const proxy = new DiscardProxy({
                query: async (sql, params) => {
                  const result = await this.observer!.query(sql, params as unknown[]);
                  return { rows: result.rows as Array<Record<string, unknown>> };
                },
                logger: this.logger ?? undefined,
              });
              return proxy.start();
            },
            targetUrl: (version) => this.deployment.baseUrl(version),
          }
        );

        if (outcome.firstAttempt) {
          await this.recordObservation(
            this.buildObservation(operation, operation.target, outcome.firstAttempt, {
              discarded: outcome.detail.discarded === true,
              effectCount: outcome.effectCount ?? 0,
              failClosed: outcome.failClosed,
            }),
            context.observations
          );
        }

        if (outcome.retryAttempt) {
          await this.recordObservation(
            this.buildObservation(operation, operation.retryTarget, outcome.retryAttempt, {
              retryOf: operation.logicalOperationId,
            }),
            context.observations
          );
        }

        trace.status = outcome.status;
        trace.detail = outcome.detail;

        if (outcome.status === 'ok' && outcome.retryAttempt) {
          for (const [name, expression] of Object.entries(operation.capture)) {
            context.vars.set(
              name,
              readPath({ body: outcome.retryAttempt.body, headers: outcome.retryAttempt.responseHeaders }, expression)
            );
          }
        }
      }
    } catch (error) {
      trace.status = 'failed';
      trace.detail = { error: (error as Error).message };
    }

    trace.durationMs = Date.now() - started;
    await this.logger!.log('operation_executed', {
      operationId: trace.operationId,
      kind: trace.kind,
      phase: trace.phase,
      status: trace.status,
      durationMs: trace.durationMs,
      detail: trace.detail,
    });
    return trace;
  }

  private buildObservation(
    operation: ScenarioOperation,
    actor: 'old' | 'new',
    result: { request: Observation['request']; status: number | null; responseHeaders: Record<string, string>; body: unknown; durationMs: number; transportError?: string; statusClass: Observation['status'] },
    extra: Record<string, unknown> = {}
  ): Observation {
    return {
      id: `${operation.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      operationId: operation.id,
      phase: operation.phase,
      actor,
      timestamp: new Date().toISOString(),
      sequenceNumber: this.logger?.sequence ?? 0,
      status: result.statusClass,
      durationMs: result.durationMs,
      request: result.request,
      response: {
        status: result.status ?? 0,
        headers: result.responseHeaders,
        body: result.body,
        ...(result.transportError ? { transportError: result.transportError } : {}),
      },
      data: { ...extra },
    };
  }

  private async recordObservation(observation: Observation, sink: Observation[]): Promise<void> {
    sink.push(observation);
    await this.logger!.log('observation_made', {
      observationId: observation.id,
      operationId: observation.operationId,
      actor: observation.actor,
      status: observation.status,
      httpStatus: observation.response?.status,
      transportError: observation.response?.transportError,
      data: observation.data,
    }, { phase: observation.phase });
  }

  private async evaluateInvariant(
    invariant: Invariant,
    oracle: AssertionExecutor
  ): Promise<import('@rollprobe/protocol').CheckResult> {
    return oracle.evaluate(invariant);
  }

  private async writeArtifacts(outputDir: string, scenario: ParsedScenario, result: CampaignResult): Promise<void> {
    this.resultDir = outputDir;
    this.resultRef = result;
    await writeFile(path.join(outputDir, 'scenario.yaml'), scenario.raw, 'utf8');
    await writeFile(path.join(outputDir, 'run.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'checks.json'), `${JSON.stringify(result.checks, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'coverage.json'), `${JSON.stringify(result.coverage, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'observations.json'), `${JSON.stringify(result.observations, null, 2)}\n`, 'utf8');
  }
}

function detectGitSha(workspaceRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function scenarioDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function readScenarioRaw(pathname: string): Promise<string> {
  return readFile(pathname, 'utf8');
}
