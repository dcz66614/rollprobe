import { describe, expect, it } from 'vitest';
import { assertScenarioConsistency, parseScenario } from './scenario.js';

const valid = `
id: test-scenario
title: A test scenario
faultFamily: unit
baseMigration: fixtures/orders/migrations/001-base-schema.sql
expandMigration: fixtures/orders/migrations/002-expand-{mode}.sql
operations:
  - id: create
    kind: http
    phase: baseline
    actor: old
    request:
      method: POST
      path: /orders
      json:
        customer_id: c1
        amount_cents: 100
    expectStatus: [201]
    capture:
      orderId: body.id
  - id: read
    kind: http
    phase: app_rollback
    actor: old
    request:
      method: GET
      path: /orders/{orderId}
invariants:
  - id: exists
    title: the order exists
    type: sql_scalar
    sql: SELECT count(*) FROM orders WHERE id = '{orderId}'
    expected: 1
`;

describe('scenario parsing', () => {
  it('parses a valid scenario and applies defaults', () => {
    const parsed = parseScenario(valid);
    expect(parsed.scenario.operations).toHaveLength(2);
    expect(parsed.scenario.invariants[0].authority).toBe('authoritative');
    expect(parsed.scenario.invariants[0].requirement).toBe('required');
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects YAML that is not a mapping', () => {
    expect(() => parseScenario('- just\n- a list\n')).toThrow(/must be a YAML mapping/);
  });

  it('rejects a scenario with no invariants', () => {
    const broken = valid.replace(/invariants:[\s\S]*$/, 'invariants: []\n');
    expect(() => parseScenario(broken)).toThrow(/failed validation/);
  });

  it('rejects phases that move backwards', () => {
    const backwards = valid.replace('phase: app_rollback', 'phase: baseline');
    // baseline -> baseline is fine, so make the second one earlier than the first.
    const reordered = backwards.replace('phase: baseline\n    actor: old\n    request:\n      method: POST', 'phase: expanded\n    actor: old\n    request:\n      method: POST');
    expect(() => parseScenario(reordered)).toThrow(/inconsistent/);
  });

  it('rejects an unsupported capture expression', () => {
    const broken = valid.replace('orderId: body.id', 'orderId: response.body.id');
    expect(() => parseScenario(broken)).toThrow(/unsupported expression/);
  });

  it('rejects duplicate invariant ids', () => {
    const duplicated = valid.replace(
      "  - id: exists\n    title: the order exists\n    type: sql_scalar\n    sql: SELECT count(*) FROM orders WHERE id = '{orderId}'\n    expected: 1",
      "  - id: exists\n    title: the order exists\n    type: sql_scalar\n    sql: SELECT 1\n    expected: 1\n  - id: exists\n    title: duplicate\n    type: sql_scalar\n    sql: SELECT 1\n    expected: 1"
    );
    expect(() => parseScenario(duplicated)).toThrow(/duplicate invariant id/);
  });

  it('requires sql for sql_scalar invariants', () => {
    const broken = valid.replace(/ {4}sql: SELECT count\(\*\) FROM orders WHERE id = '\{orderId\}'\n/, '');
    expect(() => assertScenarioConsistency).toBeDefined();
    expect(() => parseScenario(broken)).toThrow(/requires 'sql'/);
  });
});
