import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExecutor, interpolate, readJsonPath, readPath } from './httpExecutor.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/orders/1') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-order-version': 'v7' });
        res.end(JSON.stringify({ id: '1', metadata: { tier: { points: 500 } } }));
        return;
      }
      if (req.url === '/boom') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 500);
        return;
      }
      if (req.url === '/plain') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('not json');
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http executor', () => {
  it('records status, headers and parsed body', async () => {
    const executor = new HttpExecutor(baseUrl);
    const result = await executor.execute({ method: 'GET', path: '/orders/1' });

    expect(result.status).toBe(200);
    expect(result.statusClass).toBe('ok');
    expect((result.body as { id: string }).id).toBe('1');
    expect(result.responseHeaders['x-order-version']).toBe('v7');
  });

  it('classifies a 5xx response as a system-under-test error', async () => {
    const executor = new HttpExecutor(baseUrl);
    const result = await executor.execute({ method: 'GET', path: '/boom' });
    expect(result.status).toBe(500);
    expect(result.statusClass).toBe('sut_error');
  });

  it('returns a transport error instead of throwing when the connection fails', async () => {
    const executor = new HttpExecutor('http://127.0.0.1:1');
    const result = await executor.execute({ method: 'GET', path: '/health' });
    expect(result.status).toBeNull();
    expect(result.transportError).toBeTruthy();
    expect(result.statusClass).toBe('infra_error');
  });

  it('reports a timeout as a timeout, not as a business failure', async () => {
    const executor = new HttpExecutor(baseUrl, 100);
    const result = await executor.execute({ method: 'GET', path: '/slow' });
    expect(result.status).toBeNull();
    expect(result.statusClass).toBe('timeout');
  });

  it('keeps a non-JSON body as text', async () => {
    const executor = new HttpExecutor(baseUrl);
    const result = await executor.execute({ method: 'GET', path: '/plain' });
    expect(result.body).toBe('not json');
    expect(result.rawBody).toBe('not json');
  });
});

describe('path helpers', () => {
  it('reads nested json paths', () => {
    expect(readJsonPath({ metadata: { tier: { points: 500 } } }, 'metadata.tier.points')).toBe(500);
    expect(readJsonPath({ metadata: {} }, 'metadata.tier.points')).toBeUndefined();
  });

  it('reads capture expressions for body and headers', () => {
    const source = { body: { id: 'abc' }, headers: { 'x-version': 'v2' } };
    expect(readPath(source, 'body.id')).toBe('abc');
    expect(readPath(source, 'header.x-version')).toBe('v2');
    expect(readPath(source, 'nonsense.id')).toBeUndefined();
  });

  it('interpolates variables recursively and leaves unknown placeholders alone', () => {
    const vars = new Map<string, unknown>([['orderId', 'o-1']]);
    const result = interpolate(
      { path: '/orders/{orderId}', json: { nested: ['{orderId}', '{missing}'] } },
      vars
    );
    expect(result.path).toBe('/orders/o-1');
    expect(result.json.nested).toEqual(['o-1', '{missing}']);
  });
});
