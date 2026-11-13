/**
 * Thin wrapper around the Docker CLI.
 *
 * We deliberately shell out to `docker` instead of using a daemon SDK: the engine in use
 * on the target host is Docker Desktop's VMM backend, and the CLI is the stable contract
 * for it. Every call is logged so the evidence bundle can show exactly what was executed.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { EnvironmentError } from './types.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandLogEntry {
  args: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const CANDIDATE_PATHS = [
  process.env.ROLLPROBE_DOCKER,
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
].filter((p): p is string => Boolean(p));

export function resolveDockerBinary(): string {
  for (const candidate of CANDIDATE_PATHS) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // Fall back to PATH resolution.
  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

interface ExecFailure {
  message?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

export class DockerClient {
  readonly binary: string;
  readonly log: CommandLogEntry[] = [];

  constructor(binary = resolveDockerBinary()) {
    this.binary = binary;
  }

  async run(args: string[], options: { timeoutMs?: number; allowFailure?: boolean } = {}): Promise<CommandResult> {
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(this.binary, args, {
        timeout: options.timeoutMs ?? 120_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      const result = { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
      this.log.push({ args, exitCode: 0, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr });
      return result;
    } catch (error) {
      const err = error as ExecFailure;
      const result: CommandResult = {
        stdout: (err.stdout ?? '').toString().trim(),
        stderr: (err.stderr ?? err.message ?? '').toString().trim(),
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
      this.log.push({ args, exitCode: result.exitCode, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr });
      if (!options.allowFailure) {
        throw new EnvironmentError(
          `docker ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
          'Check that Docker Desktop is running and that the Linux engine is reachable.'
        );
      }
      return result;
    }
  }

  async version(): Promise<{ client: string; server: string | null }> {
    const client = await this.run(['version', '--format', '{{.Client.Version}}'], { allowFailure: true });
    const server = await this.run(['version', '--format', '{{.Server.Version}}'], { allowFailure: true });
    return {
      client: client.exitCode === 0 ? client.stdout : 'unknown',
      server: server.exitCode === 0 ? server.stdout : null,
    };
  }

  async engineReachable(): Promise<boolean> {
    const info = await this.run(['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeoutMs: 20_000 });
    return info.exitCode === 0 && info.stdout.length > 0;
  }

  async imagePresent(image: string): Promise<boolean> {
    const res = await this.run(['image', 'inspect', image], { allowFailure: true });
    return res.exitCode === 0;
  }

  async pull(image: string): Promise<void> {
    await this.run(['pull', image], { timeoutMs: 600_000 });
  }
}
