/**
 * Response discard proxy.
 *
 * This is the component that has to be honest, because the whole point of F01 is a client
 * that never learns whether its write succeeded. The strict order is:
 *
 *   1. forward the request to the real upstream build
 *   2. consume the *complete* upstream response
 *   3. prove on an independent connection that the business effect is committed
 *   4. record the full evidence
 *   5. only then destroy the downstream socket, without writing a single byte
 *
 * If step 3 cannot prove the effect, the proxy returns an explicit error instead of
 * pretending a transport fault happened.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EventLogger } from '@rollprobe/evidence';

export interface DiscardProxyOptions {
  /** Independent read-only connection used to prove the committed effect. */
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  logger?: EventLogger;
  timeoutMs?: number;
}

export interface DiscardRecord {
  at: string;
  logicalOperationId: string;
  idempotencyKey: string;
  upstreamUrl: string;
  upstreamStatus: number;
  upstreamBody: unknown;
  effectSql: string;
  effectCount: number;
  discarded: boolean;
  reason?: string;
}

export interface DiscardProxyHandle {
  url: string;
  port: number;
  records: DiscardRecord[];
  close: () => Promise<void>;
}

interface ProxyRequestHeaders {
  upstream: string;
  effectSql: string;
  effectExpectedMin: number;
  logicalOperationId: string;
  idempotencyKey: string;
}

export class DiscardProxy {
  private server: Server | null = null;
  private records: DiscardRecord[] = [];

  constructor(private readonly options: DiscardProxyOptions) {}

  async start(): Promise<DiscardProxyHandle> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      records: this.records,
      close: () => this.stop(),
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    const record: DiscardRecord = {
      at: new Date().toISOString(),
      logicalOperationId: '',
      idempotencyKey: '',
      upstreamUrl: '',
      upstreamStatus: 0,
      upstreamBody: null,
      effectSql: '',
      effectCount: 0,
      discarded: false,
    };

    try {
      const headers = this.readHeaders(req);
      record.logicalOperationId = headers.logicalOperationId;
      record.idempotencyKey = headers.idempotencyKey;
      record.effectSql = headers.effectSql;
      record.upstreamUrl = headers.upstream;

      const body = await readRequestBody(req);
      const upstreamUrl = new URL(req.url ?? '/', headers.upstream).toString();
      record.upstreamUrl = upstreamUrl;

      // 1 + 2: forward and consume the complete response.
      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method ?? 'POST',
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          ...(headers.idempotencyKey ? { 'idempotency-key': headers.idempotencyKey } : {}),
        },
        body: body.length > 0 ? body : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      const raw = await upstreamResponse.text();
      record.upstreamStatus = upstreamResponse.status;
      try {
        record.upstreamBody = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        record.upstreamBody = raw;
      }

      // 3: prove the effect on an independent connection.
      // Parameters are only bound when the SQL actually declares placeholders.
      const params = /\$\d/.test(headers.effectSql)
        ? [headers.idempotencyKey, headers.logicalOperationId]
        : [];
      const effect = await this.options.query(headers.effectSql, params);
      const count = Number(effect.rows[0]?.n ?? 0);
      record.effectCount = count;

      if (count < headers.effectExpectedMin) {
        record.reason = `effect not committed: expected >= ${headers.effectExpectedMin} rows, observed ${count}`;
        this.records.push(record);
        await this.log(record);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'discard aborted: upstream effect could not be confirmed',
            effectCount: count,
          })
        );
        return;
      }

      // 4: record before breaking the connection.
      record.discarded = true;
      this.records.push(record);
      await this.log(record);

      // 5: destroy the downstream socket with no response bytes at all.
      res.socket?.destroy();
    } catch (error) {
      record.reason = `proxy failure: ${(error as Error).message}`;
      this.records.push(record);
      await this.log(record);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: record.reason }));
      } else {
        res.socket?.destroy();
      }
    }
  }

  private readHeaders(req: import('node:http').IncomingMessage): ProxyRequestHeaders {
    const upstream = String(req.headers['x-rollprobe-upstream'] ?? '');
    const effectSql = String(req.headers['x-rollprobe-effect-sql'] ?? '');
    if (!upstream) throw new Error('missing x-rollprobe-upstream header');
    if (!effectSql) throw new Error('missing x-rollprobe-effect-sql header');
    return {
      upstream,
      effectSql,
      effectExpectedMin: Number(req.headers['x-rollprobe-effect-min'] ?? 1),
      logicalOperationId: String(req.headers['x-rollprobe-logical-op'] ?? ''),
      idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
    };
  }

  private async log(record: DiscardRecord): Promise<void> {
    if (!this.options.logger) return;
    await this.options.logger.log('discard_event', {
      logicalOperationId: record.logicalOperationId,
      idempotencyKey: record.idempotencyKey,
      upstreamUrl: record.upstreamUrl,
      upstreamStatus: record.upstreamStatus,
      upstreamBody: record.upstreamBody,
      effectSql: record.effectSql,
      effectCount: record.effectCount,
      discarded: record.discarded,
      reason: record.reason,
    });
  }
}

async function readRequestBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
