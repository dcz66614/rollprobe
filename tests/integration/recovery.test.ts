/**
 * Gate D: the reduction and replay paths must be reproducible, not one-off manual runs.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CampaignRunner, type CampaignResult } from '@rollprobe/core';
import { createBundle, readZip, verifyBundleZip } from '@rollprobe/evidence';
import { DockerClient, DockerPostgresBackend, ResourceRegistry, resolveDockerBinary } from '@rollprobe/postgres';
import { Shrinker } from '@rollprobe/shrinker';

const workspace = process.cwd();
const outRoot = path.join(workspace, '.rollprobe', 'integration-recovery');
const scenarioPath = path.join(workspace, 'fixtures/cases/F01-cross-version-idempotency.yaml');

beforeAll(async () => {
  // Start from a clean output directory so a previous run's artefacts cannot leak into this one.
  await rm(outRoot, { recursive: true, force: true });

  const backend = new DockerPostgresBackend(new ResourceRegistry(), new DockerClient(resolveDockerBinary()));
  const capabilities = await backend.capabilities();
  if (!capabilities.engineReachable) {
    throw new Error(
      `Docker engine is not reachable (${capabilities.error ?? 'unknown'}). Reduction and replay need a real engine.`
    );
  }
});

describe('causal reduction', () => {
  it('reduces F01 to the retry operation and proves 1-minimality', async () => {
    const shrinker = new Shrinker({
      scenarioPath,
      oldMode: 'buggy',
      workspaceRoot: workspace,
      outputDir: path.join(outRoot, 'shrink'),
      targetInvariants: ['f01-single-effect'],
      maxRuns: 12,
    });

    const result = await shrinker.shrink();

    expect(result.reproduced).toBe(true);
    expect(result.oneMinimal).toBe(true);
    expect(result.reducedOperations.length).toBeLessThan(result.originalOperations.length);
    // The minimal reproducer is the lost-response retry itself, not a health check.
    expect(result.reducedOperations).toContain('lost-response-retry');

    // Every candidate that removed the retry must NOT have counted as a reproduction.
    const withoutRetry = result.runs.filter(
      (step) => !step.candidateOperations.includes('lost-response-retry') && step.index > 0
    );
    expect(withoutRetry.every((step) => step.reproduced === false)).toBe(true);
  }, 300_000);
});

describe('fail-closed discard', () => {
  it('never issues the retry when the first effect cannot be confirmed', async () => {
    const raw = await readFile(scenarioPath, 'utf8');
    // Make the proxy's proof impossible: it can never see 99 matching rows.
    const unprovable = raw.replace('effectExpectedMin: 1', 'effectExpectedMin: 99');
    expect(unprovable).not.toBe(raw);

    const dir = path.join(outRoot, 'fail-closed');
    await mkdir(dir, { recursive: true });
    const modifiedPath = path.join(dir, 'scenario.yaml');
    await writeFile(modifiedPath, unprovable, 'utf8');

    const result = await new CampaignRunner().run({
      scenarioPath: modifiedPath,
      oldMode: 'buggy',
      campaignId: 'recovery',
      runId: 'fail-closed',
      workspaceRoot: workspace,
      outputDir: dir,
    });

    const retryOp = result.operations.find((op) => op.operationId === 'lost-response-retry');
    expect(retryOp?.status).toBe('failed');
    expect(String(retryOp?.detail?.stage)).toBe('effect-confirmation');
    // The decisive check: the harness must not have created a second order on its own.
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.determination.reasoning.join(' ')).toMatch(/did not run|never executed|could not be decided/);
  }, 300_000);
});

describe('evidence bundle and replay', () => {
  it('produces a verifiable bundle and replays to the same outcome', async () => {
    const runDir = path.join(outRoot, 'bundle-run');
    await mkdir(runDir, { recursive: true });

    const runner = new CampaignRunner();
    const original: CampaignResult = await runner.run({
      scenarioPath,
      oldMode: 'buggy',
      campaignId: 'recovery',
      runId: 'original',
      workspaceRoot: workspace,
      outputDir: runDir,
    });
    expect(original.status).toBe('VIOLATION');

    const files = [];
    for (const name of ['events.ndjson', 'run.json', 'checks.json', 'coverage.json', 'observations.json', 'scenario.yaml']) {
      const full = path.join(runDir, name);
      if (existsSync(full)) files.push({ name, type: 'events' as const, content: await readFile(full) });
    }

    const bundle = await createBundle({
      outputDir: path.join(runDir, 'bundle'),
      campaignId: 'recovery',
      runId: 'original',
      gitSha: original.gitSha,
      scenarioId: original.scenarioId,
      scenarioSha256: original.scenarioSha256,
      determination: original.status,
      summary: {
        totalEvents: files.length,
        totalChecks: original.checks.length,
        violations: original.coverage.summary.totalViolations,
        inconclusive: original.coverage.summary.totalInconclusive,
        satisfied: original.coverage.summary.totalSatisfied,
      },
      files,
    });

    const verification = await verifyBundleZip(bundle.zipPath);
    expect(verification.ok).toBe(true);
    expect(verification.checkedFiles).toBe(files.length);

    // Replay in a clean database from the archived scenario only.
    const entries = readZip(await readFile(bundle.zipPath));
    const archivedScenario = entries.find((entry) => entry.name === 'scenario.yaml');
    expect(archivedScenario).toBeDefined();

    const replayDir = path.join(outRoot, 'replay');
    await mkdir(replayDir, { recursive: true });
    const replayScenarioPath = path.join(replayDir, 'scenario.yaml');
    await writeFile(replayScenarioPath, archivedScenario!.data);

    const replayed = await new CampaignRunner().run({
      scenarioPath: replayScenarioPath,
      oldMode: original.oldMode,
      campaignId: 'recovery',
      runId: 'replay',
      workspaceRoot: workspace,
      outputDir: replayDir,
    });

    expect(replayed.status).toBe(original.status);
    const originalStatuses = new Map(original.checks.map((check) => [check.invariantId, check.status]));
    for (const check of replayed.checks) {
      expect(check.status).toBe(originalStatuses.get(check.invariantId));
    }
  }, 300_000);
});
