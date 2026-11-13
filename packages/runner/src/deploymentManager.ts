/**
 * Real application deployment lifecycle.
 *
 * Each control version is a separate OS process running `fixtures/orders-app/server.mjs`
 * with its own DATABASE_URL and its own ephemeral port. Nothing here is simulated:
 *  - the port comes from the kernel (PORT=0) and is read back from the process announcement
 *  - readiness is a real HTTP GET /health with a bounded retry loop
 *  - stdout/stderr are captured to per-process log files
 *  - stopping a version really terminates the process and waits for the exit
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentError } from '@rollprobe/postgres';

export type AppVersion = 'old' | 'new';
export type AppMode = 'buggy' | 'fixed';

export interface AppSpec {
  version: AppVersion;
  mode: AppMode;
  scriptPath: string;
  databaseUrl: string;
  logDir: string;
  extraEnv?: Record<string, string>;
}

export interface AppHandle {
  version: AppVersion;
  mode: AppMode;
  port: number;
  pid: number;
  baseUrl: string;
  logFile: string;
  startedAt: string;
  exitCode: number | null;
}

interface RunningApp extends AppHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  recentOutput: string[];
}

export class DeploymentManager {
  private apps = new Map<AppVersion, RunningApp>();
  private trafficTarget: AppVersion = 'old';

  get activeVersion(): AppVersion {
    return this.trafficTarget;
  }

  isRunning(version: AppVersion): boolean {
    const app = this.apps.get(version);
    return Boolean(app && app.exitCode === null);
  }

  handle(version: AppVersion): AppHandle | undefined {
    const app = this.apps.get(version);
    if (!app) return undefined;
    const { child: _child, recentOutput: _recent, ...handle } = app;
    return handle;
  }

  baseUrl(version: AppVersion): string {
    const app = this.apps.get(version);
    if (!app) throw new EnvironmentError(`application '${version}' is not running`);
    return app.baseUrl;
  }

  /**
   * Starting a process can fail transiently (database still warming up, a slow first
   * connection). Retry once before declaring the deployment broken.
   */
  async startWithRetry(spec: AppSpec, attempts = 2, timeoutMs = 60_000): Promise<AppHandle> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.start(spec, timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await delay(2_000);
      }
    }
    throw lastError;
  }

  async start(spec: AppSpec, timeoutMs = 60_000): Promise<AppHandle> {
    if (this.apps.has(spec.version)) {
      throw new EnvironmentError(`application '${spec.version}' is already running`);
    }
    await mkdir(spec.logDir, { recursive: true });
    const logFile = path.join(spec.logDir, `${spec.version}-${spec.mode}.log`);
    const logStream = createWriteStream(logFile, { flags: 'a' });

    const child = spawn(process.execPath, [spec.scriptPath], {
      env: {
        ...process.env,
        APP_VERSION: spec.version,
        APP_MODE: spec.mode,
        PORT: '0',
        DATABASE_URL: spec.databaseUrl,
        ...spec.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const recentOutput: string[] = [];
    let announcedPort: number | null = null;

    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString();
      logStream.write(`[${stream}] ${text}`);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        recentOutput.push(line);
        if (recentOutput.length > 200) recentOutput.shift();
        try {
          const parsed = JSON.parse(line) as { event?: string; port?: number };
          if (parsed.event === 'listening' && typeof parsed.port === 'number') {
            announcedPort = parsed.port;
          }
        } catch {
          /* non-JSON log line */
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));

    const exitPromise = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });

    const deadline = Date.now() + timeoutMs;
    let port: number | null = null;
    while (Date.now() < deadline) {
      if (announcedPort) {
        port = announcedPort;
        break;
      }
      const exited = await Promise.race([exitPromise.then((code) => code), delay(100).then(() => null)]);
      if (exited !== null) {
        logStream.end();
        throw new EnvironmentError(
          `application '${spec.version}' exited during startup with code ${exited}: ${recentOutput.slice(-5).join(' | ')}`,
          `See ${logFile}`
        );
      }
    }

    if (!port) {
      child.kill();
      logStream.end();
      throw new EnvironmentError(
        `application '${spec.version}' did not announce a listening port within ${timeoutMs}ms`,
        `See ${logFile}`
      );
    }

    const handle: RunningApp = {
      version: spec.version,
      mode: spec.mode,
      port,
      pid: child.pid ?? -1,
      baseUrl: `http://127.0.0.1:${port}`,
      logFile,
      startedAt: new Date().toISOString(),
      exitCode: null,
      child,
      recentOutput,
    };

    child.on('exit', (code) => {
      handle.exitCode = code ?? -1;
      logStream.end();
    });

    this.apps.set(spec.version, handle);

    const ready = await this.waitForHealthy(handle, timeoutMs);
    if (!ready) {
      await this.stop(spec.version);
      throw new EnvironmentError(
        `application '${spec.version}' never became healthy: ${handle.recentOutput.slice(-5).join(' | ')}`,
        `See ${logFile}`
      );
    }

    if (spec.version === 'old' && !this.apps.has('new')) {
      this.trafficTarget = 'old';
    }

    return this.handle(spec.version)!;
  }

  private async waitForHealthy(app: RunningApp, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) return false;
      try {
        const response = await fetch(`${app.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
        if (response.ok) {
          await response.text();
          return true;
        }
      } catch {
        /* not up yet */
      }
      await delay(250);
    }
    return false;
  }

  async healthCheck(version: AppVersion): Promise<boolean> {
    const app = this.apps.get(version);
    if (!app || app.exitCode !== null) return false;
    try {
      const response = await fetch(`${app.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      await response.text();
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Moves the traffic target. The previous version keeps running (that is the point). */
  switchTraffic(target: AppVersion): void {
    if (!this.isRunning(target)) {
      throw new EnvironmentError(`cannot route traffic to '${target}': it is not running`);
    }
    this.trafficTarget = target;
  }

  async stop(version: AppVersion, timeoutMs = 10_000): Promise<void> {
    const app = this.apps.get(version);
    if (!app) return;

    if (app.exitCode === null) {
      const exited = new Promise<void>((resolve) => app.child.once('exit', () => resolve()));
      app.child.kill('SIGTERM');
      const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
      if (timedOut) {
        app.child.kill('SIGKILL');
        await Promise.race([exited, delay(3_000)]);
      }
    }

    this.apps.delete(version);
    if (this.trafficTarget === version && this.apps.size > 0) {
      this.trafficTarget = this.apps.keys().next().value as AppVersion;
    }
  }

  async stopAll(): Promise<void> {
    for (const version of [...this.apps.keys()]) {
      await this.stop(version);
    }
  }

  describe(): Array<Record<string, unknown>> {
    return [...this.apps.values()].map((app) => ({
      version: app.version,
      mode: app.mode,
      port: app.port,
      pid: app.pid,
      baseUrl: app.baseUrl,
      startedAt: app.startedAt,
      exitCode: app.exitCode,
      logFile: app.logFile,
    }));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
