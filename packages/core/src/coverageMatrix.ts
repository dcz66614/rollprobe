/**
 * Planned coverage and final determination.
 *
 * The denominator is the set of invariants declared by the scenario, not the set of checks
 * that happened to run. A run that skips half the contract cannot report a high pass rate,
 * and a run where a required check could not be decided can never be BOUNDED_PASS.
 */

import type {
  CheckResult,
  CoverageEntry,
  CoverageMatrix,
  CoverageSummary,
  FinalDetermination,
  Invariant,
} from '@rollprobe/protocol';

export function buildCoverage(invariants: Invariant[], checks: CheckResult[]): CoverageMatrix {
  const byId = new Map(checks.map((check) => [check.invariantId, check]));

  const entries: CoverageEntry[] = invariants.map((invariant) => {
    const check = byId.get(invariant.id);
    return {
      invariantId: invariant.id,
      title: invariant.title,
      scenarioId: '',
      authority: invariant.authority,
      requirement: invariant.requirement,
      executed: Boolean(check),
      status: check ? check.status : 'not_executed',
      evidenceRefs: check?.evidenceRefs ?? [],
    };
  });

  const summary: CoverageSummary = {
    totalPlanned: invariants.length,
    totalExecuted: entries.filter((e) => e.executed).length,
    totalSkipped: entries.filter((e) => !e.executed || e.status === 'skipped').length,
    totalViolations: entries.filter((e) => e.status === 'violated').length,
    totalInconclusive: entries.filter((e) => e.status === 'inconclusive').length,
    totalSatisfied: entries.filter((e) => e.status === 'satisfied').length,
    requiredPlanned: invariants.filter((i) => i.requirement === 'required').length,
    requiredExecuted: entries.filter((e) => e.requirement === 'required' && e.executed).length,
    passRate: 0,
    defectRate: 0,
  };

  summary.passRate = summary.totalPlanned === 0 ? 0 : summary.totalSatisfied / summary.totalPlanned;
  summary.defectRate = summary.totalPlanned === 0 ? 0 : summary.totalViolations / summary.totalPlanned;

  return { entries, summary };
}

export interface DeterminationInput {
  checks: CheckResult[];
  coverage: CoverageMatrix;
  /** True when provisioning, migration, deployment or the harness itself failed. */
  infrastructureFailure?: string | null;
  /** Operations that were planned but never executed. */
  unexecutedOperations?: string[];
}

export function determine(input: DeterminationInput): FinalDetermination {
  const reasoning: string[] = [];
  const violations = input.checks
    .filter((c) => c.status === 'violated' && c.authority === 'authoritative' && c.requirement === 'required')
    .map((c) => c.invariantId);
  const inconclusive = input.checks
    .filter((c) => c.status === 'inconclusive' && c.requirement === 'required')
    .map((c) => c.invariantId);
  const notExecuted = input.coverage.entries
    .filter((e) => !e.executed && e.requirement === 'required')
    .map((e) => e.invariantId);

  if (input.infrastructureFailure) {
    reasoning.push(`infrastructure failure: ${input.infrastructureFailure}`);
    return { status: 'INCONCLUSIVE', reasoning, coverage: input.coverage.summary, violations, inconclusive };
  }

  if (violations.length > 0) {
    reasoning.push(`${violations.length} authoritative required invariant(s) violated: ${violations.join(', ')}`);
    return { status: 'VIOLATION', reasoning, coverage: input.coverage.summary, violations, inconclusive };
  }

  if (notExecuted.length > 0) {
    reasoning.push(`${notExecuted.length} required invariant(s) were never executed: ${notExecuted.join(', ')}`);
    return { status: 'INCONCLUSIVE', reasoning, coverage: input.coverage.summary, violations, inconclusive };
  }

  if (inconclusive.length > 0) {
    reasoning.push(`${inconclusive.length} required invariant(s) could not be decided: ${inconclusive.join(', ')}`);
    return { status: 'INCONCLUSIVE', reasoning, coverage: input.coverage.summary, violations, inconclusive };
  }

  if (input.unexecutedOperations && input.unexecutedOperations.length > 0) {
    reasoning.push(`operations did not run: ${input.unexecutedOperations.join(', ')}`);
    return { status: 'INCONCLUSIVE', reasoning, coverage: input.coverage.summary, violations, inconclusive };
  }

  const diagnosticViolations = input.checks.filter((c) => c.status === 'violated').length;
  reasoning.push(
    `${input.coverage.summary.totalSatisfied}/${input.coverage.summary.totalPlanned} planned invariants satisfied`
  );
  if (diagnosticViolations > 0) {
    reasoning.push(`${diagnosticViolations} diagnostic invariant(s) violated (not blocking)`);
  }
  reasoning.push('every required invariant was executed and satisfied');

  return { status: 'BOUNDED_PASS', reasoning, coverage: input.coverage.summary, violations, inconclusive };
}

export function exitCodeFor(status: FinalDetermination['status']): number {
  switch (status) {
    case 'BOUNDED_PASS':
      return 0;
    case 'VIOLATION':
      return 1;
    default:
      return 2;
  }
}
