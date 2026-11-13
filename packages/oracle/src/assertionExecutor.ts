/**
 * Business oracle.
 *
 * Rules that the previous implementation broke and this one enforces:
 *  - an authoritative check is only `satisfied` when the expected value was actually
 *    observed; a check that could not run is `inconclusive`, never `satisfied`
 *  - SQL checks run on the independent observer connection, not through the application
 *  - an empty result set means "the data needed for this check does not exist", which is
 *    inconclusive rather than a pass or a violation
 */

import type { CheckResult, Invariant } from '@rollprobe/protocol';
import { interpolate, readJsonPath, type HttpExecutor, type HttpRequestSpec } from '@rollprobe/scenario';

export interface OracleQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface OracleContext {
  /** Independent, read-only connection. Must not be the application's pool. */
  query(sql: string): Promise<OracleQueryResult>;
  httpFor(actor: 'old' | 'new'): HttpExecutor;
  vars: Map<string, unknown>;
}

function normalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) < 1e-9;
  }
  return normalize(actual) === normalize(expected);
}

export class AssertionExecutor {
  constructor(private readonly context: OracleContext) {}

  async evaluate(invariant: Invariant): Promise<CheckResult> {
    const base = {
      invariantId: invariant.id,
      title: invariant.title,
      authority: invariant.authority,
      requirement: invariant.requirement,
      phase: invariant.phase,
    };

    try {
      switch (invariant.type) {
        case 'sql_scalar':
          return await this.sqlScalar(invariant, base);
        case 'sql_rows':
          return await this.sqlRows(invariant, base);
        case 'http_json':
          return await this.httpJson(invariant, base);
        case 'http_status':
          return await this.httpStatus(invariant, base);
        default:
          return {
            ...base,
            status: 'inconclusive',
            evidenceRefs: [],
            reason: `unsupported invariant type: ${String((invariant as { type: string }).type)}`,
          };
      }
    } catch (error) {
      return {
        ...base,
        status: 'inconclusive',
        evidenceRefs: [],
        reason: `check could not run: ${(error as Error).message}`,
      };
    }
  }

  private async sqlScalar(
    invariant: Invariant,
    base: Omit<CheckResult, 'status' | 'evidenceRefs'>
  ): Promise<CheckResult> {
    const sql = interpolate(invariant.sql ?? '', this.context.vars);
    const result = await this.context.query(sql);

    if (result.rows.length === 0) {
      return {
        ...base,
        status: 'inconclusive',
        evidenceRefs: [],
        reason: `query returned no rows, so the invariant cannot be decided: ${sql}`,
      };
    }

    const row = result.rows[0];
    const column = Object.keys(row)[0];
    const actual = row[column];
    const expected = interpolate(invariant.expected, this.context.vars);

    if (actual === undefined) {
      return {
        ...base,
        status: 'inconclusive',
        evidenceRefs: [],
        reason: `query returned no column value for ${column}`,
      };
    }

    const matched = valuesMatch(actual, expected);
    return {
      ...base,
      status: matched ? 'satisfied' : 'violated',
      evidenceRefs: [`sql:${invariant.id}`],
      observed: actual,
      expected,
      reason: matched
        ? `${column} = ${normalize(actual)} as expected`
        : `expected ${column} = ${normalize(expected)} but observed ${normalize(actual)}`,
      ...(matched
        ? {}
        : {
            failure: {
              invariantId: invariant.id,
              category: 'sql-value-mismatch',
              detail: sql,
            },
          }),
    };
  }

  private async sqlRows(
    invariant: Invariant,
    base: Omit<CheckResult, 'status' | 'evidenceRefs'>
  ): Promise<CheckResult> {
    const sql = interpolate(invariant.sql ?? '', this.context.vars);
    const result = await this.context.query(sql);
    const expected = interpolate(invariant.expected, this.context.vars);
    const matched = normalize(result.rows) === normalize(expected);

    return {
      ...base,
      status: matched ? 'satisfied' : 'violated',
      evidenceRefs: [`sql:${invariant.id}`],
      observed: result.rows,
      expected,
      reason: matched ? 'row set matches expectation' : 'row set differs from expectation',
      ...(matched
        ? {}
        : { failure: { invariantId: invariant.id, category: 'sql-rows-mismatch', detail: sql } }),
    };
  }

  private async httpJson(
    invariant: Invariant,
    base: Omit<CheckResult, 'status' | 'evidenceRefs'>
  ): Promise<CheckResult> {
    if (!invariant.request || !invariant.jsonPath) {
      return { ...base, status: 'inconclusive', evidenceRefs: [], reason: 'http_json needs request and jsonPath' };
    }
    const actor = invariant.actor === 'new' ? 'new' : 'old';
    const spec = interpolate(invariant.request, this.context.vars) as HttpRequestSpec;
    const execution = await this.context.httpFor(actor).execute(spec);

    if (execution.status === null) {
      return {
        ...base,
        status: 'inconclusive',
        evidenceRefs: [`http:${invariant.id}`],
        reason: `request to the ${actor} build failed at the transport layer: ${execution.transportError}`,
      };
    }

    const actual = readJsonPath(execution.body, invariant.jsonPath);
    const expected = interpolate(invariant.expected, this.context.vars);

    if (actual === undefined) {
      return {
        ...base,
        status: 'violated',
        evidenceRefs: [`http:${invariant.id}`],
        observed: execution.body,
        expected,
        reason: `the ${actor} build did not return '${invariant.jsonPath}' at all`,
        failure: {
          invariantId: invariant.id,
          category: 'missing-field',
          detail: `HTTP ${execution.status} body: ${execution.rawBody.slice(0, 400)}`,
        },
      };
    }

    const matched = valuesMatch(actual, expected);
    return {
      ...base,
      status: matched ? 'satisfied' : 'violated',
      evidenceRefs: [`http:${invariant.id}`],
      observed: actual,
      expected,
      reason: matched
        ? `${invariant.jsonPath} = ${normalize(actual)} as expected`
        : `expected ${invariant.jsonPath} = ${normalize(expected)} but observed ${normalize(actual)}`,
      ...(matched
        ? {}
        : { failure: { invariantId: invariant.id, category: 'http-value-mismatch' } }),
    };
  }

  private async httpStatus(
    invariant: Invariant,
    base: Omit<CheckResult, 'status' | 'evidenceRefs'>
  ): Promise<CheckResult> {
    if (!invariant.request || !invariant.expectStatus) {
      return { ...base, status: 'inconclusive', evidenceRefs: [], reason: 'http_status needs request and expectStatus' };
    }
    const actor = invariant.actor === 'new' ? 'new' : 'old';
    const spec = interpolate(invariant.request, this.context.vars) as HttpRequestSpec;
    const execution = await this.context.httpFor(actor).execute(spec);

    if (execution.status === null) {
      return {
        ...base,
        status: 'inconclusive',
        evidenceRefs: [`http:${invariant.id}`],
        reason: `transport failure: ${execution.transportError}`,
      };
    }

    const matched = invariant.expectStatus.includes(execution.status);
    return {
      ...base,
      status: matched ? 'satisfied' : 'violated',
      evidenceRefs: [`http:${invariant.id}`],
      observed: execution.status,
      expected: invariant.expectStatus,
      reason: matched
        ? `HTTP ${execution.status} as expected`
        : `expected one of ${invariant.expectStatus.join(', ')} but observed ${execution.status}`,
    };
  }
}
