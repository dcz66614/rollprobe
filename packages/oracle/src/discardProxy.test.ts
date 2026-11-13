import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscardProxy, type DiscardProxyHandle } from './responseDiscardProxy.js';

let upstream: Server;
let upstreamUrl: string;
let received: Array<{ method: string; url: string; body: string; idempotencyKey?: string }>;
let proxy: DiscardProxyHandle | null = null;

beforeEach(async () => {
  received = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        ...(req.headers['idempotency-key']
          ? { idempotencyKey: String(req.headers['idempotency-key']) }
          : {}),
      });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'order-1', status: 'confirmed' }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (proxy) await proxy.close();
  proxy = null;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function startProxy(effectCount: number): Promise<DiscardProxyHandle> {
  const discard = new DiscardProxy({
    query: async () => ({ rows: [{ n: effectCount }] }),
  });
  proxy = await discard.start();
  return proxy;
}

function send(handle: DiscardProxyHandle, key: string) {
  return fetch(`${handle.url}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-rollprobe-upstream': upstreamUrl,
      'x-rollprobe-effect-sql': "SELECT count(*) FROM orders WHERE external_ref = $1",
      'x-rollprobe-effect-min': '1',
      'x-rollprobe-logical-op': 'logical-1',
    },
    body: JSON.stringify({ customer_id: 'c1', amount_cents: 100 }),
  });
}

describe('response discard proxy', () => {
  it('forwards the request upstream before discarding the response', async () => {
    const handle = await startProxy(1);
    await expect(send(handle, 'key-1')).rejects.toThrow();

    expect(received).toHaveLength(1);
    expect(received[0].idempotencyKey).toBe('key-1');
    expect(JSON.parse(received[0].body).customer_id).toBe('c1');
  });

  it('records the discarded response and the confirmed effect', async () => {
    const handle = await startProxy(1);
    await expect(send(handle, 'key-1')).rejects.toThrow();

    expect(handle.records).toHaveLength(1);
    expect(handle.records[0].discarded).toBe(true);
    expect(handle.records[0].upstreamStatus).toBe(201);
    expect(handle.records[0].effectCount).toBe(1);
    expect(handle.records[0].upstreamBody).toMatchObject({ id: 'order-1' });
  });

  it('refuses to fake a discard when the effect is not committed', async () => {
    const handle = await startProxy(0);
    const response = await send(handle, 'key-2');

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/could not be confirmed/);
    expect(handle.records[0].discarded).toBe(false);
  });

  it('rejects a request that does not declare an upstream target', async () => {
    const handle = await startProxy(1);
    const response = await fetch(`${handle.url}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(500);
  });
});
