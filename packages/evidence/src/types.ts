/**
 * Evidence layer types.
 *
 * The event log is a hash-chained NDJSON stream: every line carries the hash of the
 * previous line, so truncation, reordering or editing is detectable without a database.
 */

export type EventType =
  | 'run_started'
  | 'phase_started'
  | 'environment_created'
  | 'environment_destroyed'
  | 'operation_started'
  | 'operation_executed'
  | 'observation_made'
  | 'discard_event'
  | 'check_completed'
  | 'shrink_started'
  | 'shrink_step'
  | 'replay_started'
  | 'replay_complete'
  | 'interrupted'
  | 'run_completed';

export interface CampaignEvent {
  eventId: string;
  eventType: EventType;
  timestamp: string;
  sequenceNumber: number;
  campaignId: string;
  runId: string;
  gitSha: string;
  schemaVersion: string;
  scenarioId?: string;
  phase?: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface LogIntegrityReport {
  file: string;
  lines: number;
  validLines: number;
  firstBrokenSequence: number | null;
  reason: string | null;
  lastHash: string | null;
  ok: boolean;
}

export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  type: 'events' | 'checks' | 'coverage' | 'scenario' | 'run' | 'environment' | 'shrink' | 'replay' | 'report' | 'manifest';
}

export interface BundleManifest {
  formatVersion: string;
  rollprobeVersion: string;
  createdAt: string;
  gitSha: string;
  campaignId: string;
  runId: string;
  scenarioId: string;
  scenarioSha256: string;
  determination: string;
  files: FileRecord[];
  summary: {
    totalEvents: number;
    totalChecks: number;
    violations: number;
    inconclusive: number;
    satisfied: number;
  };
}

export interface BundleVerification {
  ok: boolean;
  checkedFiles: number;
  missing: string[];
  mismatched: Array<{ path: string; expected: string; actual: string }>;
  errors: string[];
  /** Number of events found in the archived NDJSON log. */
  eventLines?: number;
  /** True only when every event hash and previous-hash link recomputes. */
  chainOk?: boolean;
}
