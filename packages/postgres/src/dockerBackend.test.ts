import { describe, expect, it } from 'vitest';
import { DockerPostgresBackend } from './dockerBackend.js';
import type { DockerClient } from './docker.js';
import { ResourceRegistry } from './types.js';

interface Call {
  args: string[];
}

/**
 * A Docker client double that lets a specific command fail, so the rollback path can be
 * exercised without needing the engine to actually break.
 */
function fakeDocker(options: { failOn: (args: string[]) => boolean }): { client: DockerClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    binary: 'docker',
    log: [],
    async run(args: string[], runOptions: { allowFailure?: boolean } = {}) {
      calls.push({ args });
      if (args[0] === 'info') return { stdout: '29.9.3', stderr: '', exitCode: 0 };
      if (options.failOn(args)) {
        const result = { stdout: '', stderr: `injected failure: docker ${args.join(' ')}`, exitCode: 1 };
        if (!runOptions.allowFailure) {
          const error = new Error(result.stderr);
          throw error;
        }
        return result;
      }
      if (args[0] === 'inspect') return { stdout: 'a'.repeat(64), stderr: '', exitCode: 0 };
      if (args[0] === 'port') return { stdout: '127.0.0.1:54321', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async version() {
      return { client: '29.9.3', server: '29.9.3' };
    },
    async engineReachable() {
      return true;
    },
    async imagePresent() {
      return true;
    },
    async pull() {
      return undefined;
    },
  } as unknown as DockerClient;

  return { client, calls };
}

describe('provisioning rollback', () => {
  it('removes the network when volume creation fails', async () => {
    const registry = new ResourceRegistry();
    const { client, calls } = fakeDocker({ failOn: (args) => args[0] === 'volume' && args[1] === 'create' });
    const backend = new DockerPostgresBackend(registry, client);

    await expect(backend.create({ runId: 'rollback1' })).rejects.toThrow(/injected failure/);

    const removed = calls.filter((call) => call.args[0] === 'network' && call.args[1] === 'rm');
    expect(removed).toHaveLength(1);
    expect(registry.list()).toHaveLength(0);
  });

  it('removes the container, volume and network when the container fails to start', async () => {
    const registry = new ResourceRegistry();
    const { client, calls } = fakeDocker({ failOn: (args) => args[0] === 'run' });
    const backend = new DockerPostgresBackend(registry, client);

    await expect(backend.create({ runId: 'rollback2' })).rejects.toThrow(/injected failure/);

    expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(true);
    expect(calls.some((call) => call.args[0] === 'network' && call.args[1] === 'rm')).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it('reports a clear environment error when the engine never answers', async () => {
    const registry = new ResourceRegistry();
    const client = {
      binary: 'docker',
      log: [],
      async run() {
        return { stdout: '', stderr: 'cannot find the file specified', exitCode: 1 };
      },
      async version() {
        return { client: 'unknown', server: null };
      },
      async engineReachable() {
        return false;
      },
      async imagePresent() {
        return false;
      },
      async pull() {
        return undefined;
      },
    } as unknown as DockerClient;

    const backend = new DockerPostgresBackend(registry, client);
    await expect(backend.create({ runId: 'rollback3', engineWaitTimeoutMs: 300 })).rejects.toThrow(/not reachable/);
    expect(registry.list()).toHaveLength(0);
  });
});
