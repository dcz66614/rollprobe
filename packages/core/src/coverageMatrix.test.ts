import { describe, expect, it } from 'vitest';
import type { CheckResult, Invariant } from '@rollprobe/protocol';
import { buildCoverage, determine, exitCodeFor } from './coverageMatrix.js';

function invariant(id: string, overrides: Partial<Invariant> = {}): Invariant {
  return {
    id,
    title: `invariant ${id}`,
    authority: 'authoritative',
    requirement: 'required',
    phase: 'app_rollback',
    type: 'sql_scalar',
    actor: 'none',
    sql: 'SELECT 1',
    ...overrides,
  } as Invariant;
}

function check(id: string, status: CheckResult['status'], overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    invariantId: id,
    title: `invariant ${id}`,
    authority: 'authoritative',
    requirement: 'required',
    status,
    evidenceRefs: [],
    ...overrides,
  };
}

describe('coverage matrix', () => {
  it('uses the planned invariant list as the denominator', () => {
    const invariants = [invariant('a'), invariant('b'), invariant('c')];
    const coverage = buildCoverage(invariants, [check('a', 'satisfied')]);

    expect(coverage.summary.totalPlanned).toBe(3);
    expect(coverage.summary.totalExecuted).toBe(1);
    expect(coverage.summary.totalSkipped).toBe(2);
    expect(coverage.entries.find((e) => e.invariantId === 'b')?.status).toBe('not_executed');
    expect(coverage.summary.passRate).toBeCloseTo(1 / 3);
  });

  it('does not inflate the pass rate when nothing ran', () => {
    const coverage = buildCoverage([invariant('a'), invariant('b')], []);
    expect(coverage.summary.passRate).toBe(0);
    expect(coverage.summary.totalSatisfied).toBe(0);
  });
});

describe('final determination', () => {
  it('reports VIOLATION when an authoritative required check fails', () => {
    const invariants = [invariant('a'), invariant('b')];
    const checks = [check('a', 'satisfied'), check('b', 'violated')];
    const result = determine({ checks, coverage: buildCoverage(invariants, checks) });
    expect(result.status).toBe('VIOLATION');
    expect(result.violations).toEqual(['b']);
  });

  it('reports INCONCLUSIVE when a required check is inconclusive', () => {
    const invariants = [invariant('a')];
    const checks = [check('a', 'inconclusive')];
    const result = determine({ checks, coverage: buildCoverage(invariants, checks) });
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('reports INCONCLUSIVE when a required invariant never executed', () => {
    const invariants = [invariant('a'), invariant('b')];
    const checks = [check('a', 'satisfied')];
    const result = determine({ checks, coverage: buildCoverage(invariants, checks) });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.reasoning.join(' ')).toContain('never executed');
  });

  it('reports INCONCLUSIVE on infrastructure failure even with green checks', () => {
    const invariants = [invariant('a')];
    const checks = [check('a', 'satisfied')];
    const result = determine({
      checks,
      coverage: buildCoverage(invariants, checks),
      infrastructureFailure: 'docker unreachable',
    });
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('only reports BOUNDED_PASS when every required invariant ran and passed', () => {
    const invariants = [invariant('a'), invariant('b', { requirement: 'diagnostic' })];
    const checks = [check('a', 'satisfied'), check('b', 'violated', { requirement: 'diagnostic' })];
    const result = determine({ checks, coverage: buildCoverage(invariants, checks) });
    expect(result.status).toBe('BOUNDED_PASS');
    expect(result.reasoning.join(' ')).toContain('diagnostic');
  });

  it('maps determinations to process exit codes', () => {
    expect(exitCodeFor('BOUNDED_PASS')).toBe(0);
    expect(exitCodeFor('VIOLATION')).toBe(1);
    expect(exitCodeFor('INCONCLUSIVE')).toBe(2);
  });
});
