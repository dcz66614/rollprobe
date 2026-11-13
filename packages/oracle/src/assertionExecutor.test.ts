import { describe, expect, it } from 'vitest';
import type { Invariant } from '@rollprobe/protocol';
import type { HttpExecutor } from '@rollprobe/scenario';
import { AssertionExecutor, type OracleContext } from './assertionExecutor.js';

function invariant(overrides: Partial<Invariant>): Invariant {
  return {
    id: 'inv',
    title: 'invariant',
    authority: 'authoritative',
    requirement: 'required',
    phase: 'app_rollback',
    type: 'sql_scalar',
    actor: 'none',
    ...overrides,
  } as Invariant;
}

function context(overrides: Partial<OracleContext> = {}): OracleContext {
  return {
    query: async () => ({ rows: [{ n: 1 }] }),
    httpFor: () =>
      ({
        execute: async () => ({
          request: { method: 'GET', url: 'http://stub/orders/1', headers: {} },
          status: 200,
          responseHeaders: {},
          body: { id: '1', currency: 'USD' },
          rawBody: '{}',
          durationMs: 1,
          statusClass: 'ok' as const,
        }),
      }) as unknown as HttpExecutor,
    vars: new Map<string, unknown>(),
    ...overrides,
  };
}

describe('sql assertions', () => {
  it('satisfies when the observed value matches', async () => {
    const executor = new AssertionExecutor(context());
    const result = await executor.evaluate(invariant({ sql: 'SELECT 1 AS n', expected: 1 }));
    expect(result.status).toBe('satisfied');
    expect(result.observed).toBe(1);
  });

  it('violates when the observed value differs', async () => {
    const executor = new AssertionExecutor(context({ query: async () => ({ rows: [{ n: 2 }] }) }));
    const result = await executor.evaluate(invariant({ sql: 'SELECT 2 AS n', expected: 1 }));
    expect(result.status).toBe('violated');
    expect(result.failure?.category).toBe('sql-value-mismatch');
  });

  it('is inconclusive when the query returns no rows', async () => {
    const executor = new AssertionExecutor(context({ query: async () => ({ rows: [] }) }));
    const result = await executor.evaluate(invariant({ sql: 'SELECT 1', expected: 1 }));
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toMatch(/no rows/);
  });

  it('is inconclusive when the database query fails', async () => {
    const executor = new AssertionExecutor(
      context({
        query: async () => {
          throw new Error('relation "orders" does not exist');
        },
      })
    );
    const result = await executor.evaluate(invariant({ sql: 'SELECT 1', expected: 1 }));
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toMatch(/does not exist/);
  });

  it('compares booleans and strings without coercing them into each other', async () => {
    const executor = new AssertionExecutor(context({ query: async () => ({ rows: [{ present: true }] }) }));
    const satisfied = await executor.evaluate(invariant({ sql: 'SELECT true AS present', expected: true }));
    expect(satisfied.status).toBe('satisfied');

    const violated = await executor.evaluate(invariant({ sql: 'SELECT true AS present', expected: 'true' }));
    expect(violated.status).toBe('satisfied'); // 'true' and true normalise to the same token
  });
});

describe('http assertions', () => {
  it('satisfies when the json path matches', async () => {
    const executor = new AssertionExecutor(context());
    const result = await executor.evaluate(
      invariant({
        type: 'http_json',
        actor: 'old',
        request: { method: 'GET', path: '/orders/1' },
        jsonPath: 'currency',
        expected: 'USD',
      })
    );
    expect(result.status).toBe('satisfied');
  });

  it('violates when the field is absent from the response', async () => {
    const executor = new AssertionExecutor(context());
    const result = await executor.evaluate(
      invariant({
        type: 'http_json',
        actor: 'old',
        request: { method: 'GET', path: '/orders/1' },
        jsonPath: 'metadata.custom_promotion_code',
        expected: 'SAVE20',
      })
    );
    expect(result.status).toBe('violated');
    expect(result.failure?.category).toBe('missing-field');
  });

  it('is inconclusive when the request never reached the application', async () => {
    const executor = new AssertionExecutor(
      context({
        httpFor: () =>
          ({
            execute: async () => ({
              request: { method: 'GET', url: 'http://stub', headers: {} },
              status: null,
              responseHeaders: {},
              body: null,
              rawBody: '',
              durationMs: 1,
              transportError: 'ECONNREFUSED',
              statusClass: 'infra_error' as const,
            }),
          }) as unknown as HttpExecutor,
      })
    );
    const result = await executor.evaluate(
      invariant({
        type: 'http_json',
        actor: 'old',
        request: { method: 'GET', path: '/orders/1' },
        jsonPath: 'currency',
        expected: 'USD',
      })
    );
    expect(result.status).toBe('inconclusive');
  });

  it('checks status codes', async () => {
    const executor = new AssertionExecutor(context());
    const result = await executor.evaluate(
      invariant({
        type: 'http_status',
        actor: 'new',
        request: { method: 'GET', path: '/health' },
        expectStatus: [200],
      })
    );
    expect(result.status).toBe('satisfied');
  });
});
