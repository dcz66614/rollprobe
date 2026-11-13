/**
 * Causal reduction.
 *
 * Shrinking is done by re-executing the campaign, never by reasoning about the scenario on
 * paper. A candidate subset only counts as reproducing if a fresh run (new database, new
 * processes) produces the same violation signature.
 *
 * The result distinguishes:
 *   - "reduced": we found a smaller scenario that still reproduces
 *   - "1-minimal": every remaining operation was individually removed and the failure
 *     disappeared, so no single further removal keeps the bug alive
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  ScenarioSchema,
  loadScenario,
  type ParsedScenario,
  type Scenario,
  type ScenarioOperation,
} from '@rollprobe/protocol';
import { CampaignRunner, type CampaignResult, type OldMode } from '@rollprobe/core';

export interface ShrinkOptions {
  scenarioPath: string;
  oldMode: OldMode;
  workspaceRoot: string;
  outputDir: string;
  /** Invariants that must still be violated for a candidate to count as reproducing. */
  targetInvariants: string[];
  /** Hard cap on how many campaigns may be executed. */
  maxRuns?: number;
  campaignId?: string;
}

export interface ShrinkStep {
  index: number;
  candidateOperations: string[];
  removed: string[];
  status: CampaignResult['status'];
  violated: string[];
  reproduced: boolean;
  durationMs: number;
  error?: string;
}

export interface ShrinkResult {
  scenarioId: string;
  oldMode: OldMode;
  originalOperations: string[];
  reducedOperations: string[];
  removedOperations: string[];
  reproduced: boolean;
  oneMinimal: boolean;
  runs: ShrinkStep[];
  signature: {
    status: CampaignResult['status'];
    violated: string[];
  };
  artifactPath: string;
}

export class Shrinker {
  private runCounter = 0;
  /** Observed value per targeted invariant, captured from the original run. */
  private targetObserved = new Map<string, string>();

  constructor(private readonly options: ShrinkOptions) {}

  async shrink(): Promise<ShrinkResult> {
    const parsed = await loadScenario(this.options.scenarioPath);
    const original = parsed.scenario.operations.map((op) => op.id);

    const baseline = await this.execute(parsed, parsed.scenario.operations, 'baseline');
    for (const check of baseline.checks) {
      if (check.status === 'violated') {
        this.targetObserved.set(check.invariantId, JSON.stringify(check.observed ?? null));
      }
    }
    if (!this.reproduces(baseline)) {
      const artifactPath = await this.persist(parsed.scenario.id, {
        scenarioId: parsed.scenario.id,
        oldMode: this.options.oldMode,
        originalOperations: original,
        reducedOperations: original,
        removedOperations: [],
        reproduced: false,
        oneMinimal: false,
        runs: [this.toStep(0, parsed.scenario.operations, [], baseline)],
        signature: { status: baseline.status, violated: violatedOf(baseline) },
        artifactPath: '',
      });
      return {
        scenarioId: parsed.scenario.id,
        oldMode: this.options.oldMode,
        originalOperations: original,
        reducedOperations: original,
        removedOperations: [],
        reproduced: false,
        oneMinimal: false,
        runs: [this.toStep(0, parsed.scenario.operations, [], baseline)],
        signature: { status: baseline.status, violated: violatedOf(baseline) },
        artifactPath,
      };
    }

    let current = parsed.scenario.operations;
    let granularity = 2;
    const runs: ShrinkStep[] = [this.toStep(0, current, [], baseline)];

    // Classic ddmin over the operation sequence.
    while (current.length >= 2) {
      const chunkSize = Math.max(1, Math.ceil(current.length / granularity));
      let reducedInThisRound = false;

      for (let start = 0; start < current.length; start += chunkSize) {
        if (this.runCounter >= (this.options.maxRuns ?? 40)) break;
        const candidate = current.filter((_, idx) => idx < start || idx >= start + chunkSize);
        if (!this.keepsRequired(current, candidate)) continue;
        if (!this.isRunnable(parsed.scenario, candidate)) continue;

        const result = await this.execute(parsed, candidate, `ddmin-${this.runCounter}`);
        const step = this.toStep(runs.length, candidate, idsOf(current).filter((id) => !idsOf(candidate).includes(id)), result);
        runs.push(step);

        if (step.reproduced) {
          current = candidate;
          granularity = Math.max(2, granularity - 1);
          reducedInThisRound = true;
          break;
        }
      }

      if (!reducedInThisRound) {
        if (granularity >= current.length) break;
        granularity = Math.min(current.length, granularity * 2);
      }
    }

    // Prove 1-minimality by removing each remaining operation individually.
    let oneMinimal = true;
    for (const op of [...current]) {
      if (this.runCounter >= (this.options.maxRuns ?? 40)) {
        oneMinimal = false;
        break;
      }
      const candidate = current.filter((item) => item.id !== op.id);
      if (!this.keepsRequired(current, candidate)) continue;
      if (!this.isRunnable(parsed.scenario, candidate)) continue;

      const result = await this.execute(parsed, candidate, `minimal-${this.runCounter}`);
      const step = this.toStep(runs.length, candidate, [op.id], result);
      runs.push(step);
      if (step.reproduced) {
        // Removing it kept the bug alive, so the sequence was not minimal after all.
        current = candidate;
        oneMinimal = false;
        break;
      }
    }

    const removed = original.filter((id) => !idsOf(current).includes(id));
    const payload: ShrinkResult = {
      scenarioId: parsed.scenario.id,
      oldMode: this.options.oldMode,
      originalOperations: original,
      reducedOperations: idsOf(current),
      removedOperations: removed,
      reproduced: true,
      oneMinimal,
      runs,
      signature: { status: baseline.status, violated: violatedOf(baseline) },
      artifactPath: '',
    };
    payload.artifactPath = await this.persist(parsed.scenario.id, payload);
    return payload;
  }

  /**
   * A candidate reproduces the failure only when the same invariants are violated *with the
   * same observed values*. Without the value check a scenario asserting `count == 1` would
   * "reproduce" on an empty database, where the count is 0 for an entirely different reason.
   */
  private reproduces(result: CampaignResult): boolean {
    if (result.status !== 'VIOLATION') return false;
    return this.options.targetInvariants.every((id) => {
      const check = result.checks.find((item) => item.invariantId === id);
      if (!check || check.status !== 'violated') return false;
      const expected = this.targetObserved.get(id);
      if (expected === undefined) return true; // baseline itself: no reference yet
      return JSON.stringify(check.observed ?? null) === expected;
    });
  }

  private async execute(
    parsed: ParsedScenario,
    operations: ScenarioOperation[],
    label: string
  ): Promise<CampaignResult> {
    this.runCounter += 1;
    const scenario: Scenario = { ...parsed.scenario, operations };
    const parsedCandidate = ScenarioSchema.parse(scenario);

    const dir = path.join(this.options.outputDir, `shrink-${String(this.runCounter).padStart(2, '0')}-${label}`);
    await mkdir(dir, { recursive: true });
    const candidatePath = path.join(dir, 'scenario.yaml');
    await writeFile(candidatePath, yaml.dump(parsedCandidate), 'utf8');

    const runner = new CampaignRunner();
    return runner.run({
      scenarioPath: candidatePath,
      oldMode: this.options.oldMode,
      campaignId: this.options.campaignId ?? 'shrink',
      runId: `r${String(this.runCounter).padStart(2, '0')}`,
      workspaceRoot: this.options.workspaceRoot,
      outputDir: dir,
    });
  }

  /** Operations with `removable: false` are setup that the scenario depends on. */
  private keepsRequired(current: ScenarioOperation[], candidate: ScenarioOperation[]): boolean {
    const kept = new Set(candidate.map((op) => op.id));
    return current.every((op) => op.removable !== false || kept.has(op.id));
  }

  /**
   * A candidate must still be structurally valid: captures that later operations reference
   * cannot disappear, and phases must stay monotonic (the protocol parser enforces this).
   */
  private isRunnable(scenario: Scenario, operations: ScenarioOperation[]): boolean {
    const available = new Set<string>();
    for (const op of operations) {
      if (op.kind === 'http' || op.kind === 'discard_retry') {
        for (const name of Object.keys(op.capture)) available.add(name);
      }
      const referenced = collectReferences(op);
      for (const ref of referenced) {
        if (!available.has(ref)) return false;
      }
    }
    return operations.length > 0;
  }

  private toStep(
    index: number,
    candidate: ScenarioOperation[],
    removed: string[],
    result: CampaignResult
  ): ShrinkStep {
    return {
      index,
      candidateOperations: idsOf(candidate),
      removed,
      status: result.status,
      violated: violatedOf(result),
      reproduced: this.reproduces(result),
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private async persist(scenarioId: string, payload: ShrinkResult): Promise<string> {
    const target = path.join(this.options.outputDir, 'shrink.json');
    await mkdir(this.options.outputDir, { recursive: true });
    await writeFile(target, `${JSON.stringify({ ...payload, scenarioId }, null, 2)}\n`, 'utf8');
    return target;
  }
}

function idsOf(operations: ScenarioOperation[]): string[] {
  return operations.map((op) => op.id);
}

function violatedOf(result: CampaignResult): string[] {
  return result.checks.filter((check) => check.status === 'violated').map((check) => check.invariantId);
}

function collectReferences(operation: ScenarioOperation): string[] {
  const refs: string[] = [];
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{([A-Za-z0-9_]+)\}/g)) refs.push(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(scan);
    }
  };
  scan(operation);
  return refs;
}
