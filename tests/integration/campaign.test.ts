/**
 * End-to-end campaigns: the buggy control build must be detected and the fixed control
 * build must pass, using real PostgreSQL, real migrations and real HTTP applications.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { CampaignRunner, type CampaignResult } from '@rollprobe/core';
import { DockerClient, DockerPostgresBackend, ResourceRegistry, resolveDockerBinary } from '@rollprobe/postgres';

const workspace = process.cwd();
const outRoot = path.join(workspace, '.rollprobe', 'integration');

beforeAll(async () => {
  const backend = new DockerPostgresBackend(new ResourceRegistry(), new DockerClient(resolveDockerBinary()));
  const capabilities = await backend.capabilities();
  if (!capabilities.engineReachable) {
    throw new Error(
      `Docker engine is not reachable (${capabilities.error ?? 'unknown'}). ` +
        'These campaigns need a running Docker Desktop engine.'
    );
  }
});

async function run(scenario: string, mode: 'buggy' | 'fixed', runId: string): Promise<CampaignResult> {
  const runner = new CampaignRunner();
  return runner.run({
    scenarioPath: path.join(workspace, 'fixtures/cases', scenario),
    oldMode: mode,
    campaignId: 'integration',
    runId,
    workspaceRoot: workspace,
    outputDir: path.join(outRoot, runId),
  });
}

function violated(result: CampaignResult): string[] {
  return result.checks.filter((check) => check.status === 'violated').map((check) => check.invariantId);
}

describe('F01 cross-version idempotency', () => {
  it('detects a duplicate effect with the buggy old build', async () => {
    const result = await run('F01-cross-version-idempotency.yaml', 'buggy', 'f01-buggy');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('VIOLATION');
    expect(violated(result)).toContain('f01-single-effect');
  }, 240_000);

  it('passes with the fixed old build', async () => {
    const result = await run('F01-cross-version-idempotency.yaml', 'fixed', 'f01-fixed');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('BOUNDED_PASS');
    expect(result.coverage.summary.totalExecuted).toBe(result.coverage.summary.totalPlanned);
  }, 240_000);
});

describe('F02 unknown field preservation', () => {
  it('detects dropped metadata keys with the buggy old build', async () => {
    const result = await run('F02-unknown-field-preservation.yaml', 'buggy', 'f02-buggy');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('VIOLATION');
    expect(violated(result)).toContain('f02-promotion-code-preserved');
  }, 240_000);

  it('passes with the fixed old build', async () => {
    const result = await run('F02-unknown-field-preservation.yaml', 'fixed', 'f02-fixed');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('BOUNDED_PASS');
  }, 240_000);
});

describe('F03 unknown enum handling', () => {
  it('detects the misinterpreted status with the buggy old build', async () => {
    const result = await run('F03-unknown-enum-handling.yaml', 'buggy', 'f03-buggy');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('VIOLATION');
    expect(violated(result)).toContain('f03-status-not-misinterpreted');
  }, 240_000);

  it('passes with the fixed old build', async () => {
    const result = await run('F03-unknown-enum-handling.yaml', 'fixed', 'f03-fixed');
    expect(result.status).toBe('BOUNDED_PASS');
  }, 240_000);
});

describe('F04 amount unit mismatch', () => {
  it('detects the double conversion with the buggy old build', async () => {
    const result = await run('F04-amount-unit-mismatch.yaml', 'buggy', 'f04-buggy');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('VIOLATION');
    expect(violated(result)).toContain('f04-total-dollars');
  }, 240_000);

  it('passes with the fixed old build', async () => {
    const result = await run('F04-amount-unit-mismatch.yaml', 'fixed', 'f04-fixed');
    expect(result.status).toBe('BOUNDED_PASS');
  }, 240_000);
});

describe('F05 warm old stale schema cache', () => {
  it('detects the stale projection with the buggy old build', async () => {
    const result = await run('F05-warm-old-stale-schema-cache.yaml', 'buggy', 'f05-buggy');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('VIOLATION');
    expect(violated(result)).toContain('f05-currency-visible');
  }, 240_000);

  it('passes with the fixed old build', async () => {
    const result = await run('F05-warm-old-stale-schema-cache.yaml', 'fixed', 'f05-fixed');
    expect(result.status).toBe('BOUNDED_PASS');
  }, 240_000);
});

describe('F06 incomplete backfill', () => {
  it('detects the NULL currency rows with the buggy old build', async () => {
    const result = await run('F06-incomplete-backfill.yaml', 'buggy', 'f06-buggy');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('VIOLATION');
    expect(violated(result)).toContain('f06-no-null-currency');
  }, 240_000);

  it('passes with the fixed old build', async () => {
    const result = await run('F06-incomplete-backfill.yaml', 'fixed', 'f06-fixed');
    expect(result.status).toBe('BOUNDED_PASS');
  }, 240_000);
});
