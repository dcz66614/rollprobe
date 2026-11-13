// Rollprobe scenario format v1 (single canonical YAML shape used by every case file).
// The format is intentionally linear: operations execute in file order and the runner
// drives the phase transitions (migration / app start / traffic switch) around them.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { z } from 'zod';

export const PhaseSchema = z.enum(['baseline', 'expanded', 'mixed', 'app_rollback']);
export const ActorSchema = z.enum(['old', 'new', 'none']);

const HeadersSchema = z.record(z.string()).default({});

const RequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  headers: HeadersSchema,
  json: z.unknown().optional(),
});

const OperationBaseSchema = z.object({
  id: z.string().min(1),
  phase: PhaseSchema,
  actor: ActorSchema.default('none'),
  description: z.string().optional(),
  /** Removing this operation is forbidden for the shrinker (load-bearing setup). */
  removable: z.boolean().default(true),
});

const HttpOperationSchema = OperationBaseSchema.extend({
  kind: z.literal('http'),
  request: RequestSchema,
  expectStatus: z.array(z.number().int()).min(1).default([200]),
  capture: z.record(z.string()).default({}),
});

const MigrateOperationSchema = OperationBaseSchema.extend({
  kind: z.literal('migrate'),
  file: z.string().min(1),
});

const SwitchOperationSchema = OperationBaseSchema.extend({
  kind: z.literal('switch'),
  to: z.enum(['old', 'new']),
});

/**
 * Sends a request through the discard proxy: the upstream app receives and commits the
 * request, the proxy verifies the committed effect on an independent connection, then
 * destroys the downstream socket so the client observes a transport fault. The runner
 * then retries the *same logical operation* against `retryTarget`.
 */
const DiscardRetryOperationSchema = OperationBaseSchema.extend({
  kind: z.literal('discard_retry'),
  target: z.enum(['old', 'new']),
  retryTarget: z.enum(['old', 'new']),
  logicalOperationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  request: RequestSchema,
  /** SQL used by the proxy to prove the effect was committed before the discard. */
  effectSql: z.string().min(1),
  effectExpectedMin: z.number().int().min(1).default(1),
  capture: z.record(z.string()).default({}),
});

export const OperationSchema = z.discriminatedUnion('kind', [
  HttpOperationSchema,
  MigrateOperationSchema,
  SwitchOperationSchema,
  DiscardRetryOperationSchema,
]);

const InvariantSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  authority: z.enum(['authoritative', 'hypothesis']).default('authoritative'),
  requirement: z.enum(['required', 'diagnostic']).default('required'),
  /** Phase the invariant belongs to (documentation + coverage reporting). */
  phase: PhaseSchema.default('app_rollback'),
  type: z.enum(['sql_scalar', 'sql_rows', 'http_json', 'http_status']),
  actor: ActorSchema.default('none'),
  sql: z.string().optional(),
  request: RequestSchema.optional(),
  /** Dot path evaluated against the response body, e.g. `metadata.custom_promotion_code`. */
  jsonPath: z.string().optional(),
  expected: z.unknown().optional(),
  expectStatus: z.array(z.number().int()).optional(),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  faultFamily: z.string().min(1),
  description: z.string().default(''),
  /** Base schema applied before the baseline phase. */
  baseMigration: z.string().min(1),
  /** Expand migration applied at the transition into the expanded phase. */
  expandMigration: z.string().min(1),
  operations: z.array(OperationSchema).min(1),
  invariants: z.array(InvariantSchema).min(1),
  buggyBehaviour: z.string().default(''),
  fixedBehaviour: z.string().default(''),
});

export type ScenarioPhase = z.infer<typeof PhaseSchema>;
export type ScenarioActor = z.infer<typeof ActorSchema>;
export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type MigrateOperation = z.infer<typeof MigrateOperationSchema>;
export type SwitchOperation = z.infer<typeof SwitchOperationSchema>;
export type DiscardRetryOperation = z.infer<typeof DiscardRetryOperationSchema>;
export type ScenarioOperation = z.infer<typeof OperationSchema>;
export type Invariant = z.infer<typeof InvariantSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

export class ScenarioValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[]
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
    this.name = 'ScenarioValidationError';
  }
}

export interface ParsedScenario {
  scenario: Scenario;
  sha256: string;
  raw: string;
}

export function parseScenario(raw: string, sourceName = '<inline>'): ParsedScenario {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (error) {
    throw new ScenarioValidationError(
      `Scenario ${sourceName} is not valid YAML: ${(error as Error).message}`,
      [(error as Error).message]
    );
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ScenarioValidationError(`Scenario ${sourceName} must be a YAML mapping`, []);
  }

  const parsed = ScenarioSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new ScenarioValidationError(`Scenario ${sourceName} failed validation`, issues);
  }

  assertScenarioConsistency(parsed.data, sourceName);

  return {
    scenario: parsed.data,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    raw,
  };
}

export async function loadScenario(path: string): Promise<ParsedScenario> {
  const raw = await readFile(path, 'utf8');
  return parseScenario(raw, path);
}

/**
 * Structural checks that zod cannot express: phases must not go backwards, captures must be
 * resolvable, invariant ids must be unique.
 */
export function assertScenarioConsistency(scenario: Scenario, sourceName = '<inline>'): void {
  const phaseOrder: ScenarioPhase[] = ['baseline', 'expanded', 'mixed', 'app_rollback'];
  let lastPhaseIndex = 0;

  const ids = new Set<string>();
  const captured = new Set<string>();
  const problems: string[] = [];

  for (const op of scenario.operations) {
    if (ids.has(op.id)) problems.push(`duplicate operation id: ${op.id}`);
    ids.add(op.id);

    const idx = phaseOrder.indexOf(op.phase);
    if (idx < lastPhaseIndex) {
      problems.push(
        `operation ${op.id} runs phase '${op.phase}' after '${phaseOrder[lastPhaseIndex]}'`
      );
    }
    lastPhaseIndex = Math.max(lastPhaseIndex, idx);

    if (op.kind === 'http' || op.kind === 'discard_retry') {
      for (const [name, expr] of Object.entries(op.capture)) {
        if (!/^(body|header)\.[A-Za-z0-9_.]+$/.test(expr)) {
          problems.push(`operation ${op.id} capture '${name}' has unsupported expression '${expr}'`);
        }
        captured.add(name);
      }
    }
  }

  const invariantIds = new Set<string>();
  for (const inv of scenario.invariants) {
    if (invariantIds.has(inv.id)) problems.push(`duplicate invariant id: ${inv.id}`);
    invariantIds.add(inv.id);
    if ((inv.type === 'sql_scalar' || inv.type === 'sql_rows') && !inv.sql) {
      problems.push(`invariant ${inv.id} of type ${inv.type} requires 'sql'`);
    }
    if (inv.type === 'http_json' && (!inv.request || !inv.jsonPath)) {
      problems.push(`invariant ${inv.id} of type http_json requires 'request' and 'jsonPath'`);
    }
    if (inv.type === 'http_status' && (!inv.request || !inv.expectStatus)) {
      problems.push(`invariant ${inv.id} of type http_status requires 'request' and 'expectStatus'`);
    }
  }

  if (problems.length > 0) {
    throw new ScenarioValidationError(`Scenario ${sourceName} is inconsistent`, problems);
  }
}
