/**
 * Integration tests that require a real Docker engine and a real PostgreSQL 17 container.
 *
 * These tests are deliberately NOT skipped when the engine is missing: a silent skip is how
 * a project ends up claiming coverage it never had. If Docker is unavailable the suite fails
 * with an explicit message instead.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  DockerClient,
  DockerPostgresBackend,
  MigrationRunner,
  ResourceRegistry,
  resolveDockerBinary,
  type DatabaseInstance,
} from '@rollprobe/postgres';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const workspace = process.cwd();
const docker = new DockerClient(resolveDockerBinary());
const registry = new ResourceRegistry();
const backend = new DockerPostgresBackend(registry, docker);

let instance: DatabaseInstance;
let engineReady = false;

beforeAll(async () => {
  const capabilities = await backend.capabilities();
  engineReady = capabilities.engineReachable;
  if (!engineReady) {
    throw new Error(
      `Docker engine is not reachable (${capabilities.error ?? 'unknown'}). ` +
        'Integration tests need a running Docker Desktop engine; start it and re-run `npm run test:integration`.'
    );
  }
  instance = await backend.create({ runId: `itest${Date.now().toString(36)}` });
}, 180_000);

afterAll(async () => {
  if (instance) await backend.destroy(instance.id);
});

describe('docker postgres backend', () => {
  it('provisions a real PostgreSQL 17 container with a real container id', () => {
    expect(instance.containerId).toMatch(/^[0-9a-f]{64}$/);
    expect(instance.postgresMajor).toBe(17);
    expect(instance.postgresVersion).toContain('PostgreSQL 17');
    expect(instance.port).toBeGreaterThan(1024);
  });

  it('reports a running container through inspect()', async () => {
    const info = await backend.inspect(instance.id);
    expect(info.running).toBe(true);
    expect(info.containerId).toBe(instance.containerId);
  });

  it('applies the base migration and creates the expected schema', async () => {
    const runner = new MigrationRunner(async () => {
      const client = new pg.Client({ connectionString: backend.connectionString(instance, 'admin') });
      await client.connect();
      return client;
    });
    const result = await runner.applyFile(path.join(workspace, 'fixtures/orders/migrations/001-base-schema.sql'));
    expect(result.statements).toBeGreaterThan(0);

    const tables = await backend.queryAdmin<{ tablename: string }>(
      instance,
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(['audit_log', 'inventory', 'orders']));
  });

  it('applies the expand migration and adds the new columns', async () => {
    const runner = new MigrationRunner(async () => {
      const client = new pg.Client({ connectionString: backend.connectionString(instance, 'admin') });
      await client.connect();
      return client;
    });
    await runner.applyFile(path.join(workspace, 'fixtures/orders/migrations/002-expand-fixed.sql'));

    const columns = await backend.queryAdmin<{ column_name: string }>(
      instance,
      `SELECT column_name FROM information_schema.columns WHERE table_name='orders'`
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(['currency', 'external_ref', 'tracking_number', 'metadata']));
  });

  it('enforces the unique external_ref index', async () => {
    await backend.queryAs(instance, 'app', `DELETE FROM orders`);
    await backend.queryAs(
      instance,
      'app',
      `INSERT INTO orders (id, customer_id, amount_cents, status, external_ref) VALUES ('a1','c1',100,'confirmed','key-1')`
    );
    await expect(
      backend.queryAs(
        instance,
        'app',
        `INSERT INTO orders (id, customer_id, amount_cents, status, external_ref) VALUES ('a2','c1',100,'confirmed','key-1')`
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('applies row level security: the tenant policy filters rows', async () => {
    const client = new pg.Client({ connectionString: backend.connectionString(instance, 'app') });
    await client.connect();
    try {
      await client.query(`SET rollprobe.tenant = 'acme'`);
      const visible = await client.query<{ tenant: string }>(`SELECT tenant FROM audit_log`);
      expect(visible.rows.length).toBeGreaterThan(0);
      expect(visible.rows.every((row) => row.tenant === 'acme')).toBe(true);

      // Negative case: a row for another tenant is invisible even though it exists.
      await client.query(`SET rollprobe.tenant = 'globex'`);
      const other = await client.query<{ tenant: string }>(`SELECT tenant FROM audit_log`);
      expect(other.rows.every((row) => row.tenant === 'globex')).toBe(true);

      // Negative case: writing outside the current tenant is rejected by WITH CHECK.
      await client.query(`SET rollprobe.tenant = 'acme'`);
      await expect(
        client.query(`INSERT INTO audit_log (tenant, action) VALUES ('globex', 'smuggled')`)
      ).rejects.toThrow(/row-level security|policy/i);
    } finally {
      await client.end();
    }
  });

  it('refuses to report success when the engine is unreachable', async () => {
    const broken = new DockerPostgresBackend(new ResourceRegistry(), new DockerClient('definitely-not-docker'));
    await expect(broken.create({ runId: 'nope', engineWaitTimeoutMs: 500 })).rejects.toThrow(/not reachable/i);
  });
});

describe('cleanup discipline', () => {
  it('removes only the resources it registered', async () => {
    const extra = await backend.create({ runId: `itest2${Date.now().toString(36)}` });
    const report = await backend.destroy(extra.id);
    expect(report.success).toBe(true);
    expect(report.cleaned).toEqual(
      expect.arrayContaining([
        `container:${extra.containerName}`,
        `volume:${extra.volumeName}`,
        `network:${extra.networkName}`,
      ])
    );

    const remaining = await docker.run(['ps', '-a', '--filter', `name=${extra.containerName}`, '--format', '{{.Names}}'], {
      allowFailure: true,
    });
    expect(remaining.stdout.trim()).toBe('');
  });
});

describe('fixture migrations are valid SQL for PostgreSQL 17', () => {
  it('base schema contains no unsupported CREATE ROLE IF NOT EXISTS syntax', () => {
    const sql = readFileSync(path.join(workspace, 'fixtures/orders/migrations/001-base-schema.sql'), 'utf8');
    expect(sql).not.toMatch(/CREATE\s+ROLE\s+IF\s+NOT\s+EXISTS/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY\s+IF\s+NOT\s+EXISTS/i);
  });
});
