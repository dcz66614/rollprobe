#!/usr/bin/env node
/**
 * Rollprobe CLI.
 *
 * Every command performs the work it advertises and returns a meaningful exit code:
 *   0  success / BOUNDED_PASS
 *   1  VIOLATION detected
 *   2  INCONCLUSIVE (environment or evidence problem)
 */

import { Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CampaignRunner, type CampaignResult } from '@rollprobe/core';
import { DockerClient, DockerPostgresBackend, ResourceRegistry, resolveDockerBinary } from '@rollprobe/postgres';
import { createBundle, readZip, verifyBundleZip, type BundleFileInput } from '@rollprobe/evidence';
import { Shrinker, type ShrinkResult } from '@rollprobe/shrinker';
import { renderReport, type ReportRun } from '@rollprobe/report';
import { ROLLPROBE_VERSION, loadScenario } from '@rollprobe/protocol';

const program = new Command();

program
  .name('rollprobe')
  .description('Rolling deployment probe and verification tool')
  .version(ROLLPROBE_VERSION);

function resolveWorkspace(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'fixtures', 'orders-app', 'server.mjs'))) return cwd;
  return cwd;
}

async function listScenarios(workspace: string): Promise<string[]> {
  const dir = path.join(workspace, 'fixtures', 'cases');
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.yaml')).map((name) => path.join(dir, name)).sort();
}

function printRunSummary(result: CampaignResult): void {
  const summary = result.coverage.summary;
  console.log('');
  console.log(`  scenario   ${result.scenarioId}`);
  console.log(`  control    ${result.oldMode}`);
  console.log(`  status     ${result.status}  (exit ${result.exitCode})`);
  console.log(`  coverage   ${summary.totalSatisfied}/${summary.totalPlanned} satisfied, ${summary.totalViolations} violated, ${summary.totalInconclusive} inconclusive`);
  console.log(`  duration   ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.error) console.log(`  error      ${result.error}`);
  for (const line of result.determination.reasoning) console.log(`  - ${line}`);
}

/** Collects the artefacts of a finished run into a verifiable evidence bundle. */
async function bundleRun(runDir: string, result: CampaignResult): Promise<{ zipPath: string; manifestSha256: string; verified: boolean; checkedFiles: number; eventLines: number; chainOk: boolean }> {
  const files: BundleFileInput[] = [];

  const pushIfExists = async (name: string, type: BundleFileInput['type']): Promise<void> => {
    const full = path.join(runDir, name);
    if (!existsSync(full)) return;
    files.push({ name, type, content: await readFile(full) });
  };

  // The event log is mandatory evidence; the bundler refuses to call a run verified without it.
  await pushIfExists('events.ndjson', 'events');
  await pushIfExists('run.json', 'run');
  await pushIfExists('checks.json', 'checks');
  await pushIfExists('coverage.json', 'coverage');
  await pushIfExists('observations.json', 'events');
  await pushIfExists('scenario.yaml', 'scenario');
  await pushIfExists('environment.json', 'environment');
  await pushIfExists('shrink.json', 'shrink');
  await pushIfExists('replay.json', 'replay');

  const bundle = await createBundle({
    outputDir: path.join(runDir, 'bundle'),
    campaignId: result.campaignId,
    runId: result.runId,
    gitSha: result.gitSha,
    scenarioId: result.scenarioId,
    scenarioSha256: result.scenarioSha256,
    determination: result.status,
    summary: {
      totalEvents: 0, // measured from the archived log by createBundle
      totalChecks: result.checks.length,
      violations: result.coverage.summary.totalViolations,
      inconclusive: result.coverage.summary.totalInconclusive,
      satisfied: result.coverage.summary.totalSatisfied,
    },
    files,
  });

  const verification = await verifyBundleZip(bundle.zipPath);
  if (!verification.ok) {
    console.error(`  bundle verification FAILED: ${verification.errors.join('; ')}`);
  }
  return {
    zipPath: bundle.zipPath,
    manifestSha256: bundle.manifestSha256,
    verified: verification.ok,
    checkedFiles: verification.checkedFiles,
    eventLines: verification.eventLines ?? 0,
    chainOk: verification.chainOk ?? false,
  };
}

async function writeEnvironment(runDir: string, result: CampaignResult): Promise<void> {
  await writeFile(
    path.join(runDir, 'environment.json'),
    `${JSON.stringify(
      {
        database: result.environment.database,
        applications: result.environment.apps,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        gitSha: result.gitSha,
        capturedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

// ---------------------------------------------------------------- doctor

program
  .command('doctor')
  .description('Verify that this host can actually run a campaign')
  .addOption(new Option('--workspace <dir>', 'repository root').default(undefined))
  .action(async (options) => {
    const workspace = resolveWorkspace(options.workspace);
    const checks: Array<{ name: string; ok: boolean; detail: string; critical: boolean }> = [];

    checks.push({
      name: 'node',
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      detail: `node ${process.version}`,
      critical: true,
    });

    const dockerBinary = resolveDockerBinary();
    const docker = new DockerClient(dockerBinary);
    // PATH commands such as "docker" on Linux are executable even if existsSync("docker") is false.
    // Check CLI availability by executing the CLI, not by treating the name as a file path.
    const dockerCliProbe = await docker.run(['--version'], { allowFailure: true, timeoutMs: 10_000 });
    checks.push({
      name: 'docker-cli',
      ok: dockerCliProbe.exitCode === 0,
      detail: dockerCliProbe.exitCode === 0 ? dockerCliProbe.stdout : dockerCliProbe.stderr || dockerBinary,
      critical: true,
    });
    const backend = new DockerPostgresBackend(new ResourceRegistry(), docker);
    const capabilities = await backend.capabilities();
    checks.push({
      name: 'docker-engine',
      ok: capabilities.engineReachable,
      detail: capabilities.engineReachable ? `engine ${capabilities.dockerVersion}` : (capabilities.error ?? 'unreachable'),
      critical: true,
    });

    if (capabilities.engineReachable) {
      const image = await docker.imagePresent('postgres:17');
      checks.push({
        name: 'postgres-image',
        ok: image,
        detail: image ? 'postgres:17 present' : 'postgres:17 missing (will be pulled on first run)',
        critical: false,
      });
    }

    const fixture = path.join(workspace, 'fixtures', 'orders-app', 'server.mjs');
    checks.push({ name: 'fixture-app', ok: existsSync(fixture), detail: fixture, critical: true });

    const migrations = path.join(workspace, 'fixtures', 'orders', 'migrations');
    for (const name of ['001-base-schema.sql', '002-expand-buggy.sql', '002-expand-fixed.sql']) {
      checks.push({
        name: `migration:${name}`,
        ok: existsSync(path.join(migrations, name)),
        detail: path.join(migrations, name),
        critical: true,
      });
    }

    let scenarios: string[] = [];
    try {
      scenarios = await listScenarios(workspace);
    } catch {
      scenarios = [];
    }
    checks.push({
      name: 'scenarios',
      ok: scenarios.length >= 6,
      detail: `${scenarios.length} scenario file(s) in fixtures/cases`,
      critical: true,
    });

    for (const scenarioPath of scenarios) {
      try {
        const parsed = await loadScenario(scenarioPath);
        checks.push({
          name: `scenario:${parsed.scenario.id}`,
          ok: true,
          detail: `${parsed.scenario.operations.length} operations, ${parsed.scenario.invariants.length} invariants`,
          critical: true,
        });
      } catch (error) {
        checks.push({
          name: `scenario:${path.basename(scenarioPath)}`,
          ok: false,
          detail: (error as Error).message,
          critical: true,
        });
      }
    }

    console.log('Rollprobe doctor\n');
    for (const check of checks) {
      const mark = check.ok ? 'ok  ' : check.critical ? 'FAIL' : 'warn';
      console.log(`  [${mark}] ${check.name.padEnd(34)} ${check.detail}`);
    }

    const criticalFailure = checks.some((check) => !check.ok && check.critical);
    console.log(`\n${criticalFailure ? 'Environment is NOT ready.' : 'Environment looks ready.'}`);
    process.exit(criticalFailure ? 2 : 0);
  });

// ---------------------------------------------------------------- run

program
  .command('run')
  .description('Execute one scenario (or all of them) against real PostgreSQL and real apps')
  .addOption(new Option('--scenario <path>', 'scenario YAML to run').default(undefined))
  .addOption(new Option('--all', 'run every scenario in fixtures/cases').default(false))
  .addOption(new Option('--mode <mode>', 'control build: buggy | fixed | both').default('both'))
  .addOption(new Option('--workspace <dir>', 'repository root').default(undefined))
  .addOption(new Option('--out <dir>', 'output directory').default('.rollprobe/runs'))
  .addOption(new Option('--campaign <id>', 'campaign id').default(undefined))
  .addOption(new Option('--keep-db', 'leave the PostgreSQL container running for inspection').default(false))
  .addOption(new Option('--report', 'render the HTML report after the run').default(false))
  .action(async (options) => {
    const workspace = resolveWorkspace(options.workspace);
    const outRoot = path.resolve(workspace, options.out);
    const campaignId = options.campaign ?? `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const campaignDir = path.join(outRoot, campaignId);
    await mkdir(campaignDir, { recursive: true });

    const scenarios = options.all
      ? await listScenarios(workspace)
      : options.scenario
        ? [path.resolve(workspace, options.scenario)]
        : await listScenarios(workspace);

    const modes: Array<'buggy' | 'fixed'> =
      options.mode === 'both' ? ['buggy', 'fixed'] : [options.mode === 'fixed' ? 'fixed' : 'buggy'];

    const reportRuns: ReportRun[] = [];
    let worstExit = 0;

    for (const scenarioPath of scenarios) {
      const parsed = await loadScenario(scenarioPath);
      for (const mode of modes) {
        const runId = `${parsed.scenario.id}__${mode}`;
        const runDir = path.join(campaignDir, runId);
        console.log(`\n== ${parsed.scenario.id} [${mode}] ==`);

        const runner = new CampaignRunner();
        const result = await runner.run({
          scenarioPath,
          oldMode: mode,
          campaignId,
          runId,
          workspaceRoot: workspace,
          outputDir: runDir,
          keepDatabase: options.keepDb,
        });

        await writeEnvironment(runDir, result);
        printRunSummary(result);

        const bundle = await bundleRun(runDir, result);
        console.log(
          `  bundle     ${bundle.zipPath} (verified: ${bundle.verified}, ${bundle.checkedFiles} files, ${bundle.eventLines} events, chain: ${bundle.chainOk ? 'ok' : 'BROKEN'})`
        );
        if (!bundle.verified) worstExit = Math.max(worstExit, 2);

        reportRuns.push({ result, bundle });
        worstExit = Math.max(worstExit, result.exitCode);
      }
    }

    if (options.report) {
      const html = renderReport({ title: `Rollprobe campaign ${campaignId}`, runs: reportRuns });
      const reportPath = path.join(campaignDir, 'report.html');
      await writeFile(reportPath, html, 'utf8');
      console.log(`\nReport: ${reportPath}`);
    }

    await writeFile(
      path.join(campaignDir, 'campaign.json'),
      `${JSON.stringify(
        reportRuns.map((run) => ({
          scenarioId: run.result.scenarioId,
          oldMode: run.result.oldMode,
          status: run.result.status,
          exitCode: run.result.exitCode,
          coverage: run.result.coverage.summary,
          bundle: run.bundle,
        })),
        null,
        2
      )}\n`,
      'utf8'
    );

    console.log(`\nCampaign ${campaignId} finished with exit code ${worstExit}`);
    process.exit(worstExit);
  });

// ---------------------------------------------------------------- shrink

program
  .command('shrink')
  .description('Reduce a failing scenario by re-execution until it is 1-minimal')
  .addOption(new Option('--scenario <path>', 'scenario YAML').makeOptionMandatory())
  .addOption(new Option('--mode <mode>', 'control build to reproduce with').default('buggy'))
  .addOption(new Option('--invariant <id...>', 'invariants that must remain violated').default([]))
  .addOption(new Option('--workspace <dir>', 'repository root').default(undefined))
  .addOption(new Option('--out <dir>', 'output directory').default('.rollprobe/shrink'))
  .addOption(new Option('--max-runs <n>', 'maximum number of campaign executions').default('24'))
  .action(async (options) => {
    const workspace = resolveWorkspace(options.workspace);
    const scenarioPath = path.resolve(workspace, options.scenario);
    const parsed = await loadScenario(scenarioPath);
    const targets: string[] =
      options.invariant.length > 0 ? options.invariant : parsed.scenario.invariants.map((inv) => inv.id);

    const outDir = path.resolve(workspace, options.out, `${parsed.scenario.id}__${options.mode}`);
    console.log(`Shrinking ${parsed.scenario.id} [${options.mode}] targeting ${targets.join(', ')}`);

    const shrinker = new Shrinker({
      scenarioPath,
      oldMode: options.mode === 'fixed' ? 'fixed' : 'buggy',
      workspaceRoot: workspace,
      outputDir: outDir,
      targetInvariants: targets,
      maxRuns: Number(options.maxRuns),
    });

    const result: ShrinkResult = await shrinker.shrink();
    for (const step of result.runs) {
      console.log(
        `  run ${String(step.index).padStart(2)}  ${step.status.padEnd(12)} reproduced=${step.reproduced ? 'yes' : 'no '}  ops=${step.candidateOperations.length}  removed=[${step.removed.join(',')}]`
      );
    }
    console.log(
      `\n${result.originalOperations.length} -> ${result.reducedOperations.length} operations; 1-minimal: ${result.oneMinimal}`
    );
    console.log(`Artifact: ${result.artifactPath}`);
    process.exit(result.reproduced ? 0 : 2);
  });

// ---------------------------------------------------------------- replay

program
  .command('replay')
  .description('Re-execute a recorded scenario in a fresh environment and compare results')
  .addOption(new Option('--bundle <zip>', 'evidence bundle to replay').makeOptionMandatory())
  .addOption(new Option('--workspace <dir>', 'repository root').default(undefined))
  .addOption(new Option('--out <dir>', 'output directory').default('.rollprobe/replay'))
  .action(async (options) => {
    const workspace = resolveWorkspace(options.workspace);
    const zipPath = path.resolve(workspace, options.bundle);

    const verification = await verifyBundleZip(zipPath);
    if (!verification.ok) {
      console.error(`Bundle failed verification: ${JSON.stringify(verification, null, 2)}`);
      process.exit(2);
    }
    console.log(`Bundle verified: ${verification.checkedFiles} file(s)`);

    const entries = readZip(await readFile(zipPath));
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
    const scenarioRaw = byName.get('scenario.yaml');
    const runRaw = byName.get('run.json');
    if (!scenarioRaw || !runRaw) {
      console.error('Bundle is missing scenario.yaml or run.json');
      process.exit(2);
    }

    const original = JSON.parse(runRaw.toString('utf8')) as CampaignResult;
    const outDir = path.resolve(workspace, options.out, `${original.runId}-replay-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const scenarioPath = path.join(outDir, 'scenario.yaml');
    await writeFile(scenarioPath, scenarioRaw);

    console.log(`Replaying ${original.scenarioId} [${original.oldMode}] in a clean environment`);

    const runner = new CampaignRunner();
    const replayed = await runner.run({
      scenarioPath,
      oldMode: original.oldMode,
      campaignId: 'replay',
      runId: 'replay',
      workspaceRoot: workspace,
      outputDir: outDir,
    });

    // A replay only counts as stable when the *whole* observable outcome matches, not just
    // the pass/fail flag: status, observed value, expectation and coverage must all agree.
    const normalize = (value: unknown): string => JSON.stringify(value ?? null);
    const originalChecks = new Map(original.checks.map((check) => [check.invariantId, check]));
    const replayedChecks = new Map(replayed.checks.map((check) => [check.invariantId, check]));
    const ids = new Set([...originalChecks.keys(), ...replayedChecks.keys()]);

    const differences: Array<{ invariantId: string; field: string; original: unknown; replayed: unknown }> = [];
    for (const id of ids) {
      const before = originalChecks.get(id);
      const after = replayedChecks.get(id);
      if (!before || !after) {
        differences.push({
          invariantId: id,
          field: 'presence',
          original: before ? before.status : 'missing',
          replayed: after ? after.status : 'missing',
        });
        continue;
      }
      if (before.status !== after.status) {
        differences.push({ invariantId: id, field: 'status', original: before.status, replayed: after.status });
      }
      if (normalize(before.observed) !== normalize(after.observed)) {
        differences.push({ invariantId: id, field: 'observed', original: before.observed, replayed: after.observed });
      }
      if (normalize(before.expected) !== normalize(after.expected)) {
        differences.push({ invariantId: id, field: 'expected', original: before.expected, replayed: after.expected });
      }
    }

    const coverageFields = [
      'totalPlanned',
      'totalExecuted',
      'totalSatisfied',
      'totalViolations',
      'totalInconclusive',
    ] as const;
    for (const field of coverageFields) {
      const before = original.coverage.summary[field];
      const after = replayed.coverage.summary[field];
      if (before !== after) {
        differences.push({ invariantId: '<coverage>', field, original: before, replayed: after });
      }
    }

    const stable = differences.length === 0 && replayed.status === original.status;
    const replayReport = {
      originalRunId: original.runId,
      replayRunId: replayed.runId,
      originalStatus: original.status,
      replayedStatus: replayed.status,
      stable,
      failureSignature: {
        original: original.determination.violations,
        replayed: replayed.determination.violations,
      },
      coverage: { original: original.coverage.summary, replayed: replayed.coverage.summary },
      differences,
      replayedAt: new Date().toISOString(),
    };
    await writeFile(path.join(outDir, 'replay.json'), `${JSON.stringify(replayReport, null, 2)}\n`, 'utf8');

    printRunSummary(replayed);
    console.log(`\nReplay ${stable ? 'reproduced the original outcome' : 'DIFFERS from the original outcome'}`);
    if (!stable) console.log(JSON.stringify(differences, null, 2));
    console.log(`Artifact: ${path.join(outDir, 'replay.json')}`);
    process.exit(stable ? 0 : 2);
  });

// ---------------------------------------------------------------- report

program
  .command('report')
  .description('Render an offline HTML report from recorded runs')
  .addOption(new Option('--input <dir>', 'campaign directory or single run directory').default('.rollprobe/runs'))
  .addOption(new Option('--output <file>', 'HTML output path').default(undefined))
  .action(async (options) => {
    const inputDir = path.resolve(options.input);
    const runs: ReportRun[] = [];

    const candidates: string[] = [];
    const rootStat = await stat(inputDir);
    if (rootStat.isDirectory()) {
      const direct = path.join(inputDir, 'run.json');
      if (existsSync(direct)) {
        candidates.push(inputDir);
      } else {
        for (const entry of await readdir(inputDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = path.join(inputDir, entry.name);
          if (existsSync(path.join(child, 'run.json'))) candidates.push(child);
        }
      }
    }

    if (candidates.length === 0) {
      console.error(`No run.json found under ${inputDir}`);
      process.exit(2);
    }

    for (const dir of candidates) {
      const result = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) as CampaignResult;
      const shrinkPath = path.join(dir, 'shrink.json');
      const shrink = existsSync(shrinkPath) ? JSON.parse(await readFile(shrinkPath, 'utf8')) : undefined;
      const manifestPath = path.join(dir, 'bundle', 'manifest.json');
      const bundle = existsSync(manifestPath)
        ? {
            zipPath: `${path.join(dir, 'bundle')}.zip`,
            manifestSha256: existsSync(path.join(dir, 'bundle', 'manifest.sha256'))
              ? (await readFile(path.join(dir, 'bundle', 'manifest.sha256'), 'utf8')).trim()
              : '',
            verified: await verifyBundleZip(`${path.join(dir, 'bundle')}.zip`).then((v) => v.ok).catch(() => false),
            checkedFiles: existsSync(manifestPath)
              ? ((JSON.parse(await readFile(manifestPath, 'utf8')) as { files: unknown[] }).files.length ?? 0)
              : 0,
          }
        : undefined;
      runs.push({ result, shrink, bundle });
    }

    const html = renderReport({ runs });
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(inputDir, 'report.html');
    await writeFile(outputPath, html, 'utf8');
    console.log(`Report written to ${outputPath} (${runs.length} run(s))`);
    process.exit(0);
  });

// ---------------------------------------------------------------- verify

program
  .command('verify')
  .description('Verify an evidence bundle archive offline')
  .addOption(new Option('--bundle <zip>', 'bundle archive').makeOptionMandatory())
  .action(async (options) => {
    const result = await verifyBundleZip(path.resolve(options.bundle));
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  });

// ---------------------------------------------------------------- demo

program
  .command('demo')
  .description('One-command demonstration: run every scenario in both control builds and report')
  .addOption(new Option('--workspace <dir>', 'repository root').default(undefined))
  .addOption(new Option('--out <dir>', 'output directory').default('.rollprobe/demo'))
  .action(async (options) => {
    const workspace = resolveWorkspace(options.workspace);
    const outRoot = path.resolve(workspace, options.out);
    await mkdir(outRoot, { recursive: true });

    const scenarios = await listScenarios(workspace);
    // A unique campaign id per invocation keeps each demo's event log separate.
    const demoCampaign = `demo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.log(`Rollprobe demo: ${scenarios.length} scenarios x 2 control builds\n`);

    const runs: ReportRun[] = [];
    let violations = 0;
    let passes = 0;
    let inconclusive = 0;

    for (const scenarioPath of scenarios) {
      const parsed = await loadScenario(scenarioPath);
      for (const mode of ['buggy', 'fixed'] as const) {
        const runId = `${parsed.scenario.id}__${mode}`;
        const runDir = path.join(outRoot, runId);
        const runner = new CampaignRunner();
        const result = await runner.run({
          scenarioPath,
          oldMode: mode,
          campaignId: demoCampaign,
          runId,
          workspaceRoot: workspace,
          outputDir: runDir,
        });
        await writeEnvironment(runDir, result);
        const bundle = await bundleRun(runDir, result);
        runs.push({ result, bundle });

        const label = `${parsed.scenario.id} [${mode}]`.padEnd(52);
        console.log(
          `${label} ${result.status.padEnd(12)} ${result.coverage.summary.totalSatisfied}/${result.coverage.summary.totalPlanned} satisfied  bundle=${bundle.verified ? 'verified' : 'INVALID'} events=${bundle.eventLines} chain=${bundle.chainOk ? 'ok' : 'BROKEN'}`
        );

        if (result.status === 'VIOLATION') violations++;
        else if (result.status === 'BOUNDED_PASS') passes++;
        else inconclusive++;
      }
    }

    const html = renderReport({ title: 'Rollprobe demo campaign', runs });
    const reportPath = path.join(outRoot, 'report.html');
    await writeFile(reportPath, html, 'utf8');

    console.log(`\n${passes} bounded pass, ${violations} violation, ${inconclusive} inconclusive`);
    console.log(`Report: ${reportPath}`);
    process.exit(inconclusive > 0 ? 2 : 0);
  });

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(`rollprobe: ${error.message}`);
  process.exit(2);
});
