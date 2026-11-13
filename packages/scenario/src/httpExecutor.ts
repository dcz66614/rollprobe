/**
 * HTTP execution against a running control version.
 *
 * Every call returns a full record of what was sent and what came back, including the
 * transport error when there is no response at all. The oracle never has to guess whether
 * a failure was a business violation or a broken connection.
 */

import type { ObservationStatus } from '@rollprobe/protocol';

export interface HttpRequestSpec {
  method: string;
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
}

export interface HttpExecutionResult {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  status: number | null;
  responseHeaders: Record<string, string>;
  body: unknown;
  rawBody: string;
  durationMs: number;
  transportError?: string;
  statusClass: ObservationStatus;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export class HttpExecutor {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 20_000
  ) {}

  async execute(spec: HttpRequestSpec, options: ExecuteOptions = {}): Promise<HttpExecutionResult> {
    const url = new URL(spec.path, this.baseUrl).toString();
    const headers: Record<string, string> = { ...(spec.headers ?? {}), ...(options.extraHeaders ?? {}) };
    const started = Date.now();

    const init: { method: string; headers: Record<string, string>; signal: AbortSignal; body?: string } = {
      method: spec.method,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    };
    if (spec.json !== undefined) {
      init.body = JSON.stringify(spec.json);
      headers['content-type'] ??= 'application/json';
    }

    try {
      const response = await fetch(url, init);
      const rawBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let body: unknown = rawBody;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      } catch {
        body = rawBody;
      }

      return {
        request: { method: spec.method, url, headers, body: spec.json },
        status: response.status,
        responseHeaders,
        body,
        rawBody,
        durationMs: Date.now() - started,
        statusClass: response.status >= 500 ? 'sut_error' : 'ok',
      };
    } catch (error) {
      const err = error as Error & { cause?: { code?: string } };
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      return {
        request: { method: spec.method, url, headers, body: spec.json },
        status: null,
        responseHeaders: {},
        body: null,
        rawBody: '',
        durationMs: Date.now() - started,
        transportError: err.cause?.code ? `${err.cause.code}: ${err.message}` : err.message,
        statusClass: isTimeout ? 'timeout' : 'infra_error',
      };
    }
  }
}

/** Reads `body.a.b` / `header.x` style capture expressions. */
export function readPath(source: { body: unknown; headers: Record<string, string> }, expression: string): unknown {
  const [scope, ...rest] = expression.split('.');
  if (scope === 'header') {
    return source.headers[rest.join('.').toLowerCase()];
  }
  if (scope !== 'body') return undefined;
  let current: unknown = source.body;
  for (const key of rest) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Same traversal, but for invariant checks against a parsed JSON body. */
export function readJsonPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const key of path.split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Replaces `{name}` placeholders in strings, recursively through plain objects. */
export function interpolate<T>(value: T, vars: Map<string, unknown>): T {
  if (typeof value === 'string') {
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
      if (!vars.has(name)) return match;
      return String(vars.get(name));
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, vars)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(item, vars);
    }
    return out as unknown as T;
  }
  return value;
}
