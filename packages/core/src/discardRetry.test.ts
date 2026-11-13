import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscardProxy } from '@rollprobe/oracle';
import { executeDiscardRetry } from './discardRetry.js';

let newApp: Server;
let oldApp: Server;
let newUrl: string;
let oldUrl: string;
let newRequests: number;
let oldRequests: number;

function listen(handler: (res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(res));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

beforeEach(async () => {
  newRequests = 0;
  oldRequests = 0;
  const created = await listen((res) => {
    newRequests += 1;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'order-from-new' }));
  });
  newApp = created.server;
  newUrl = created.url;

  const older = await listen((res) => {
    oldRequests += 1;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'order-from-old' }));
  });
  oldApp = older.server;
  oldUrl = older.url;
});

afterEach(async () => {
  await new Promise<void>((resolve) => newApp.close(() => resolve()));
  await new Promise<void>((resolve) => oldApp.close(() => resolve()));
});

function deps(effectCount: number) {
  return {
    startProxy: async () =>
      new DiscardProxy({ query: async () => ({ rows: [{ n: effectCount }] }) }).start(),
    targetUrl: (version: 'old' | 'new') => (version === 'new' ? newUrl : oldUrl),
  };
}

const spec = {
  target: 'new' as const,
  retryTarget: 'old' as const,
  logicalOperationId: 'logical-1',
  idempotencyKey: 'key-1',
  request: { method: 'POST', path: '/orders', json: { customer_id: 'c1', amount_cents: 100 } },
  effectSql: "SELECT count(*)::int AS n FROM orders WHERE external_ref = 'key-1'",
  effectExpectedMin: 1,
};

describe('discard-retry ordering', () => {
  it('retries only after the committed effect is proven', async () => {
    const outcome = await executeDiscardRetry(spec, deps(1));

    expect(outcome.status).toBe('ok');
    expect(outcome.retried).toBe(true);
    expect(outcome.failClosed).toBe(false);
    expect(newRequests).toBe(1);
    expect(oldRequests).toBe(1);
  });

  it('fails closed and never sends the retry when the effect cannot be proven', async () => {
    const outcome = await executeDiscardRetry(spec, deps(0));

    expect(outcome.status).toBe('failed');
    expect(outcome.failClosed).toBe(true);
    expect(outcome.retried).toBe(false);
    // The first request reached the upstream, the second must never leave the harness.
    expect(newRequests).toBe(1);
    expect(oldRequests).toBe(0);
    expect(String(outcome.detail.stage)).toBe('effect-confirmation');
  });

  it('reports the failure as a discard-stage problem when the client actually got a response', async () => {
    const outcome = await executeDiscardRetry(spec, {
      startProxy: async () =>
        ({
          url: newUrl,
          port: 0,
          records: [],
          close: async () => undefined,
        }) as unknown as Awaited<ReturnType<typeof deps>['startProxy']>,
      targetUrl: (version: 'old' | 'new') => (version === 'new' ? newUrl : oldUrl),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.failClosed).toBe(true);
    expect(outcome.retried).toBe(false);
    expect(String(outcome.detail.stage)).toBe('discard');
    expect(oldRequests).toBe(0);
  });
});
