// Rollprobe Protocol v1 - Core type definitions
// Every module in the workspace consumes these types; they are the frozen contract
// between the scenario loader, the executor, the oracle and the evidence layer.

/** Single source of truth for the project version. */
export const ROLLPROBE_VERSION = '1.0.0';

export type VersionId = 'old' | 'new';

export type Phase = 'baseline' | 'expanded' | 'mixed' | 'app_rollback';

export type ObservationStatus =
  | 'ok'
  | 'sut_error'
  | 'expected_transport_fault'
  | 'infra_error'
  | 'timeout'
  | 'unsupported';

export type CheckStatus = 'satisfied' | 'violated' | 'inconclusive' | 'skipped';

export type Authority = 'authoritative' | 'hypothesis';

export type Requirement = 'required' | 'diagnostic';

export interface FailureSignature {
  invariantId: string;
  category: string;
  logicalOperationId?: string;
  detail?: string;
}

export interface Observation {
  id: string;
  operationId: string;
  phase: Phase;
  actor: VersionId | 'none';
  timestamp: string;
  sequenceNumber: number;
  status: ObservationStatus;
  durationMs: number;
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
    transportError?: string;
  };
  data: Record<string, unknown>;
}

export interface CheckResult {
  invariantId: string;
  title: string;
  phase?: Phase;
  authority: Authority;
  requirement: Requirement;
  status: CheckStatus;
  evidenceRefs: string[];
  observed?: unknown;
  expected?: unknown;
  failure?: FailureSignature;
  reason?: string;
}

/** A single planned invariant. Used as the denominator of the planned coverage matrix. */
export interface PlannedInvariant {
  id: string;
  title: string;
  scenarioId: string;
  authority: Authority;
  requirement: Requirement;
}

export interface CoverageEntry {
  invariantId: string;
  title: string;
  scenarioId: string;
  authority: Authority;
  requirement: Requirement;
  executed: boolean;
  status: CheckStatus | 'not_executed';
  evidenceRefs: string[];
}

export interface CoverageSummary {
  totalPlanned: number;
  totalExecuted: number;
  totalSkipped: number;
  totalViolations: number;
  totalInconclusive: number;
  totalSatisfied: number;
  requiredPlanned: number;
  requiredExecuted: number;
  passRate: number;
  defectRate: number;
}

export interface CoverageMatrix {
  entries: CoverageEntry[];
  summary: CoverageSummary;
}

export type Determination = 'VIOLATION' | 'BOUNDED_PASS' | 'INCONCLUSIVE';

export interface FinalDetermination {
  status: Determination;
  reasoning: string[];
  coverage: CoverageSummary;
  violations: string[];
  inconclusive: string[];
}

export interface RunMetadata {
  campaignId: string;
  runId: string;
  gitSha: string;
  startedAt: string;
  scenarioId: string;
  scenarioPath: string;
  scenarioSha256: string;
  oldMode: 'buggy' | 'fixed';
  nodeVersion: string;
  platform: string;
}
