import type {
  CheckResult,
  CoverageMatrix,
  FinalDetermination,
  Observation,
  Phase,
} from '@rollprobe/protocol';

export type OldMode = 'buggy' | 'fixed';

export interface CampaignOptions {
  /** Absolute path to the scenario YAML. */
  scenarioPath: string;
  oldMode: OldMode;
  campaignId: string;
  runId: string;
  /** Repository root, used to resolve migration and fixture paths. */
  workspaceRoot: string;
  /** Directory where events, logs and result JSON are written. */
  outputDir: string;
  keepDatabase?: boolean;
  gitSha?: string;
}

export interface OperationTrace {
  operationId: string;
  kind: string;
  phase: Phase;
  actor: string;
  status: 'ok' | 'failed';
  durationMs: number;
  detail?: Record<string, unknown>;
}

export interface CampaignResult {
  campaignId: string;
  runId: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioSha256: string;
  oldMode: OldMode;
  gitSha: string;
  status: FinalDetermination['status'];
  determination: FinalDetermination;
  coverage: CoverageMatrix;
  checks: CheckResult[];
  observations: Observation[];
  operations: OperationTrace[];
  environment: {
    database: {
      containerId: string;
      containerName: string;
      host: string;
      port: number;
      postgresVersion: string;
    } | null;
    apps: Array<Record<string, unknown>>;
  };
  resources: {
    created: Array<{ type: string; identifier: string }>;
    cleaned: string[];
  };
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
}
