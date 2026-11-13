/**
 * Real Docker-backed PostgreSQL 17 provisioning.
 *
 * Contract:
 *  - a unique isolated network, volume and container per campaign run
 *  - readiness is proven by an actual SQL round-trip, never by sleeping
 *  - the reported version comes from the server, not from a constant
 *  - if the engine is unreachable this throws EnvironmentError; it never fakes success
 *  - cleanup touches only the resources recorded in the registry for this run
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { DockerClient } from './docker.js';
import {
  EnvironmentError,
  ResourceRegistry,
  type DatabaseCapabilities,
  type DatabaseInstance,
} from './types.js';

const POSTGRES_IMAGE = 'postgres:17';

export interface CreateOptions {
  runId: string;
  postgresMajor?: number;
  readinessTimeoutMs?: number;
  /** How long to wait for a briefly unreachable engine before giving up. */
  engineWaitTimeoutMs?: number;
}

export interface DestroyReport {
  success: boolean;
  cleaned: string[];
  errors: string[];
}

export class DockerPostgresBackend {
  private instances = new Map<string, DatabaseInstance>();

  constructor(
    private readonly registry: ResourceRegistry,
    private readonly docker: DockerClient = new DockerClient()
  ) {}

  async capabilities(): Promise<DatabaseCapabilities> {
    const { server } = await this.docker.version();
    const reachable = await this.docker.engineReachable();
    return {
      supportsDocker: true,
      dockerVersion: server ?? undefined,
      engineReachable: reachable,
      ...(reachable ? {} : { error: 'Docker engine is not reachable (is Docker Desktop running?)' }),
    };
  }

  getInstance(id: string): DatabaseInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * The engine can be briefly unreachable while Docker Desktop is (re)starting. Wait for it
   * with a bounded backoff instead of failing a whole campaign on the first probe.
   */
  private async waitForEngine(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = '';
    while (Date.now() < deadline) {
      const info = await this.docker.run(['info', '--format', '{{.ServerVersion}}'], {
        allowFailure: true,
        timeoutMs: 10_000,
      });
      if (info.exitCode === 0 && info.stdout.length > 0) return;
      lastDetail = info.stderr || info.stdout || 'no detail';
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new EnvironmentError(
      `Docker engine is not reachable after ${timeoutMs}ms: ${lastDetail}`,
      'Start Docker Desktop (or restart it if it exited) and re-run. `rollprobe doctor` reports the same probe.'
    );
  }

  async create(options: CreateOptions): Promise<DatabaseInstance> {
    const runId = options.runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    if (!runId) throw new EnvironmentError('runId must contain alphanumeric characters');

    await this.waitForEngine(options.engineWaitTimeoutMs ?? 30_000);

    if (!(await this.docker.imagePresent(POSTGRES_IMAGE))) {
      await this.docker.pull(POSTGRES_IMAGE);
    }

    const instanceId = `rp-pg-${runId}`;
    const networkName = `rp-net-${runId}`;
    const volumeName = `rp-vol-${runId}`;
    const labels = ['--label', `rollprobe.run=${runId}`, '--label', 'rollprobe.managed=true'];

    const password = randomBytes(9).toString('hex');
    const adminUser = 'rp_admin';
    const adminPassword = password;
    const appUser = 'app';
    const appPassword = `app_${randomBytes(6).toString('hex')}`;
    const observerUser = 'observer';
    const observerPassword = `obs_${randomBytes(6).toString('hex')}`;

    // 1. Network + volume first, so a partially created run is always traceable and can be
    //    rolled back if a later step fails.
    await this.docker.run(['network', 'create', ...labels, networkName]);
    this.registry.register('network', networkName, { runId });

    try {
      await this.docker.run(['volume', 'create', ...labels, volumeName]);
      this.registry.register('volume', volumeName, { runId });
    } catch (error) {
      // The network exists at this point; the volume does not.
      await this.rollback(instanceId, networkName, volumeName, false, false, true);
      throw error;
    }

    // 2. Container with an ephemeral host port bound to loopback only.
    try {
      await this.docker.run([
      'run', '-d',
      '--name', instanceId,
      ...labels,
      '--network', networkName,
      '-e', `POSTGRES_USER=${adminUser}`,
      '-e', `POSTGRES_PASSWORD=${adminPassword}`,
      '-e', 'POSTGRES_DB=rollprobe',
      '-p', '127.0.0.1::5432',
      '-v', `${volumeName}:/var/lib/postgresql/data`,
      '--health-cmd', 'pg_isready -U rp_admin -d rollprobe',
      '--health-interval', '1s',
      '--health-timeout', '3s',
      '--health-retries', '30',
        POSTGRES_IMAGE,
      ]);
      this.registry.register('container', instanceId, { runId });
    } catch (error) {
      await this.rollback(instanceId, networkName, volumeName, false, true, true);
      throw error;
    }

    let containerId: string;
    let port: number;
    try {
      const inspect = await this.docker.run(['inspect', '--format', '{{.Id}}', instanceId]);
      containerId = inspect.stdout;
      if (!/^[0-9a-f]{64}$/.test(containerId)) {
        throw new EnvironmentError(`Engine returned an unexpected container id: ${containerId}`);
      }

      const portOutput = await this.docker.run(['port', instanceId, '5432/tcp']);
      const match = /:(\d+)\s*$/.exec(portOutput.stdout);
      if (!match) {
        throw new EnvironmentError(`Could not resolve published port for ${instanceId}: ${portOutput.stdout}`);
      }
      port = Number(match[1]);
    } catch (error) {
      await this.rollback(instanceId, networkName, volumeName, true, true, true);
      throw error;
    }

    const instance: DatabaseInstance = {
      id: instanceId,
      containerName: instanceId,
      containerId,
      networkName,
      volumeName,
      host: '127.0.0.1',
      port,
      database: 'rollprobe',
      appUser,
      appPassword,
      observerUser,
      observerPassword,
      adminUser,
      adminPassword,
      createdAt: new Date().toISOString(),
      postgresVersion: '',
      postgresMajor: 0,
    };

    // 3. Readiness: real SQL round-trip with backoff.
    try {
      await this.waitForReady(instance, options.readinessTimeoutMs ?? 120_000);
    } catch (error) {
      await this.rollback(instanceId, networkName, volumeName, true, true, true);
      throw error;
    }

    // 4. Version proof from the server itself.
    const version = await this.queryAdmin<{ version: string; num: string }>(
      instance,
      `SELECT version() AS version, current_setting('server_version_num') AS num`
    );
    instance.postgresVersion = version.rows[0]?.version ?? 'unknown';
    instance.postgresMajor = Math.floor(Number(version.rows[0]?.num ?? '0') / 10000);
    if (instance.postgresMajor !== 17) {
      await this.rollback(instanceId, networkName, volumeName, true, true, true);
      throw new EnvironmentError(
        `Expected PostgreSQL 17 but the container reports major version ${instance.postgresMajor}`
      );
    }

    try {
      await this.bootstrapRoles(instance);
    } catch (error) {
      await this.rollback(instanceId, networkName, volumeName, true, true, true);
      throw error;
    }

    this.instances.set(instance.id, instance);
    return instance;
  }

  private async waitForReady(instance: DatabaseInstance, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      const client = new pg.Client({
        host: instance.host,
        port: instance.port,
        database: instance.database,
        user: instance.adminUser,
        password: instance.adminPassword,
        connectionTimeoutMillis: 3_000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return;
      } catch (error) {
        lastError = (error as Error).message;
        await client.end().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new EnvironmentError(
      `PostgreSQL container ${instance.containerName} did not become ready within ${timeoutMs}ms: ${lastError}`
    );
  }

  private async bootstrapRoles(instance: DatabaseInstance): Promise<void> {
    const sql = `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${instance.appUser}') THEN
          CREATE ROLE ${instance.appUser} LOGIN PASSWORD '${instance.appPassword}';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${instance.observerUser}') THEN
          CREATE ROLE ${instance.observerUser} LOGIN PASSWORD '${instance.observerPassword}';
        END IF;
      END
      $$;
      GRANT CONNECT ON DATABASE rollprobe TO ${instance.appUser}, ${instance.observerUser};
      GRANT USAGE ON SCHEMA public TO ${instance.appUser}, ${instance.observerUser};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${instance.adminUser} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${instance.appUser};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${instance.adminUser} IN SCHEMA public
        GRANT SELECT ON TABLES TO ${instance.observerUser};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${instance.adminUser} IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${instance.appUser}, ${instance.observerUser};
    `;
    await this.queryAdmin(instance, sql);
  }

  /** Grants table privileges for objects that already exist (used after migrations). */
  async refreshGrants(instance: DatabaseInstance): Promise<void> {
    await this.queryAdmin(
      instance,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${instance.appUser};
       GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${instance.observerUser};
       GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${instance.appUser}, ${instance.observerUser};`
    );
  }

  async queryAdmin<T extends pg.QueryResultRow = pg.QueryResultRow>(
    instance: DatabaseInstance,
    sql: string,
    params: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    return this.withClient(instance, 'admin', (client) => client.query<T>(sql, params as never[]));
  }

  async queryAs<T extends pg.QueryResultRow = pg.QueryResultRow>(
    instance: DatabaseInstance,
    role: 'app' | 'observer',
    sql: string,
    params: unknown[] = []
  ): Promise<pg.QueryResult<T>> {
    return this.withClient(instance, role, (client) => client.query<T>(sql, params as never[]));
  }

  private async withClient<T>(
    instance: DatabaseInstance,
    role: 'admin' | 'app' | 'observer',
    fn: (client: pg.Client) => Promise<T>
  ): Promise<T> {
    const user = role === 'admin' ? instance.adminUser : role === 'app' ? instance.appUser : instance.observerUser;
    const password =
      role === 'admin' ? instance.adminPassword : role === 'app' ? instance.appPassword : instance.observerPassword;
    const client = new pg.Client({
      host: instance.host,
      port: instance.port,
      database: instance.database,
      user,
      password,
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  connectionString(instance: DatabaseInstance, role: 'admin' | 'app' | 'observer' = 'app'): string {
    const user = role === 'admin' ? instance.adminUser : role === 'app' ? instance.appUser : instance.observerUser;
    const password =
      role === 'admin' ? instance.adminPassword : role === 'app' ? instance.appPassword : instance.observerPassword;
    return `postgresql://${user}:${password}@${instance.host}:${instance.port}/${instance.database}`;
  }

  /** Proves the container is still alive and reports what it actually is. */
  async inspect(instanceId: string): Promise<{ running: boolean; containerId: string; version: string; tables: number }> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new EnvironmentError(`Unknown database instance ${instanceId}`);
    const state = await this.docker.run(['inspect', '--format', '{{.State.Running}}', instance.containerName], {
      allowFailure: true,
    });
    const version = await this.queryAdmin<{ version: string }>(instance, 'SELECT version() AS version');
    const tables = await this.queryAdmin<{ count: string }>(
      instance,
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'`
    );
    return {
      running: state.stdout === 'true',
      containerId: instance.containerId,
      version: version.rows[0]?.version ?? 'unknown',
      tables: Number(tables.rows[0]?.count ?? '0'),
    };
  }

  /** Best-effort rollback of a partially provisioned run. Never touches unregistered names. */
  private async rollback(
    containerName: string,
    networkName: string,
    volumeName: string,
    containerCreated: boolean,
    volumeCreated: boolean,
    networkCreated: boolean
  ): Promise<void> {
    if (containerCreated) {
      await this.docker.run(['rm', '-f', containerName], { allowFailure: true });
      this.registry.remove('container', containerName);
    }
    if (volumeCreated) {
      await this.docker.run(['volume', 'rm', '-f', volumeName], { allowFailure: true });
      this.registry.remove('volume', volumeName);
    }
    if (networkCreated) {
      await this.docker.run(['network', 'rm', networkName], { allowFailure: true });
      this.registry.remove('network', networkName);
    }
  }

  /**
   * Stops and removes the container, then the volume and network, but only for resources
   * this run registered. Nothing is pruned globally.
   */
  async destroy(instanceId: string): Promise<DestroyReport> {
    const instance = this.instances.get(instanceId);
    const cleaned: string[] = [];
    const errors: string[] = [];

    if (!instance) {
      return { success: false, cleaned, errors: [`Unknown database instance ${instanceId}`] };
    }

    const removeContainer = await this.docker.run(['rm', '-f', instance.containerName], { allowFailure: true });
    if (removeContainer.exitCode === 0) {
      cleaned.push(`container:${instance.containerName}`);
      this.registry.remove('container', instance.containerName);
    } else if (!/No such container/i.test(removeContainer.stderr)) {
      errors.push(`container ${instance.containerName}: ${removeContainer.stderr}`);
    }

    const removeVolume = await this.docker.run(['volume', 'rm', '-f', instance.volumeName], { allowFailure: true });
    if (removeVolume.exitCode === 0) {
      cleaned.push(`volume:${instance.volumeName}`);
      this.registry.remove('volume', instance.volumeName);
    } else if (!/no such volume/i.test(removeVolume.stderr)) {
      errors.push(`volume ${instance.volumeName}: ${removeVolume.stderr}`);
    }

    const removeNetwork = await this.docker.run(['network', 'rm', instance.networkName], { allowFailure: true });
    if (removeNetwork.exitCode === 0) {
      cleaned.push(`network:${instance.networkName}`);
      this.registry.remove('network', instance.networkName);
    } else if (!/no such network/i.test(removeNetwork.stderr)) {
      errors.push(`network ${instance.networkName}: ${removeNetwork.stderr}`);
    }

    this.instances.delete(instanceId);
    return { success: errors.length === 0, cleaned, errors };
  }
}
