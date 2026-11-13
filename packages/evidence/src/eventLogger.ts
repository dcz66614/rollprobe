/**
 * Append-only, hash-chained NDJSON event log.
 *
 * Design rules (these were the defects in the previous implementation):
 *  - history is never rewritten; every write is an O_APPEND to the same file
 *  - sequence numbers are monotonic and survive a restart (resumed from the last line)
 *  - each line stores the hash of the previous line, so truncation/editing is detectable
 *  - a partially written trailing line is reported, never silently dropped
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { CampaignEvent, EventType, LogIntegrityReport } from './types.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface LoggerOptions {
  outputDir: string;
  campaignId: string;
  runId: string;
  gitSha?: string;
  scenarioId?: string;
  /** fsync after every append. Slower but durable across a hard kill. */
  durable?: boolean;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Mirrors JSON semantics exactly, which is what makes the stored line re-hashable:
 *  - object keys whose value is `undefined` are omitted (JSON.stringify drops them)
 *  - `undefined` inside an array becomes `null` (JSON.stringify does the same)
 * The previous version emitted `"key":undefined`, which could never be reproduced from the
 * file because the file never contained that key.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

/** Recursively drops `undefined` so the written JSON is byte-identical to what was hashed. */
export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : stripUndefined(item)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = stripUndefined(item);
    }
    return out;
  }
  return value;
}

export interface EventChainReport {
  ok: boolean;
  lines: number;
  lastHash: string | null;
  brokenAt: number | null;
  reason: string | null;
}

/**
 * Recomputes the whole chain from raw NDJSON text. This is the check that a file-level
 * SHA-256 cannot replace: the file hash only proves the bytes are unchanged, not that the
 * bytes are a faithful record of what the writer hashed.
 */
export function verifyEventChain(content: string): EventChainReport {
  const report: EventChainReport = { ok: true, lines: 0, lastHash: null, brokenAt: null, reason: null };
  const rawLines = content.split('\n');
  const trailing = rawLines.pop();

  if (trailing && trailing.trim().length > 0) {
    report.ok = false;
    report.reason = 'trailing partial line (the writer was interrupted mid-append)';
    report.brokenAt = rawLines.filter((line) => line.trim().length > 0).length + 1;
  }

  let prev = GENESIS_HASH;
  let expectedSequence = 1;

  for (const line of rawLines) {
    if (!line.trim()) continue;
    report.lines += 1;

    let parsed: CampaignEvent;
    try {
      parsed = JSON.parse(line) as CampaignEvent;
    } catch {
      report.ok = false;
      report.reason ??= `line ${report.lines} is not valid JSON`;
      report.brokenAt ??= expectedSequence;
      break;
    }

    const { hash, ...rest } = parsed;
    if (parsed.sequenceNumber !== expectedSequence) {
      report.ok = false;
      report.reason ??= `sequence gap: expected ${expectedSequence}, found ${parsed.sequenceNumber}`;
      report.brokenAt ??= expectedSequence;
      break;
    }
    if (parsed.prevHash !== prev) {
      report.ok = false;
      report.reason ??= `previous-hash link broken at sequence ${parsed.sequenceNumber}`;
      report.brokenAt ??= parsed.sequenceNumber;
      break;
    }
    if (sha256(stableStringify(rest)) !== hash) {
      report.ok = false;
      report.reason ??= `content hash does not recompute at sequence ${parsed.sequenceNumber}`;
      report.brokenAt ??= parsed.sequenceNumber;
      break;
    }

    prev = hash;
    expectedSequence += 1;
    report.lastHash = hash;
  }

  return report;
}

export class EventLogger {
  /** Canonical file name: every consumer (bundler, verifier, report) looks for this. */
  static readonly FILE_NAME = 'events.ndjson';
  readonly file: string;
  private sequenceNumber = 0;
  private lastHash = GENESIS_HASH;
  private ready = false;

  constructor(private readonly options: LoggerOptions) {
    this.file = path.join(options.outputDir, EventLogger.FILE_NAME);
  }

  /**
   * Creates the directory, then either resumes an existing log or rotates it away.
   *
   * Resuming is only valid for the *same* run. If the file on disk belongs to a different
   * campaign or run, appending to it would mix two runs into one chain and make the older
   * events indistinguishable from the current ones, so the old file is rotated aside and a
   * fresh chain starts.
   */
  async start(): Promise<void> {
    await mkdir(this.options.outputDir, { recursive: true });

    if (existsSync(this.file)) {
      const owner = await this.readOwner();
      const sameRun = owner?.runId === this.options.runId && owner?.campaignId === this.options.campaignId;

      if (!sameRun) {
        const suffix = owner?.runId ?? 'previous';
        const rotated = path.join(this.options.outputDir, `events.${suffix}.ndjson`);
        const target = existsSync(rotated) ? `${rotated}.${Date.now()}` : rotated;
        await rename(this.file, target);
      } else {
        const report = await this.verify();
        this.sequenceNumber = report.lines;
        this.lastHash = report.lastHash ?? GENESIS_HASH;
        if (!report.ok) {
          // Record the damage instead of pretending the log is clean.
          await this.append('interrupted', {
            interruptReason: `log integrity problem detected on resume: ${report.reason}`,
            firstBrokenSequence: report.firstBrokenSequence,
          });
        }
      }
    }

    this.ready = true;
  }

  /** Reads the campaign/run that owns the file on disk. */
  private async readOwner(): Promise<{ campaignId?: string; runId?: string } | null> {
    try {
      const content = await readFile(this.file, 'utf8');
      const first = content.split('\n').find((line) => line.trim().length > 0);
      if (!first) return null;
      return JSON.parse(first) as { campaignId?: string; runId?: string };
    } catch {
      return null;
    }
  }

  get sequence(): number {
    return this.sequenceNumber;
  }

  async log(eventType: EventType, data: Record<string, unknown> = {}, extra: { phase?: string } = {}): Promise<CampaignEvent> {
    if (!this.ready) await this.start();
    return this.append(eventType, data, extra);
  }

  private async append(eventType: EventType, data: Record<string, unknown>, extra: { phase?: string } = {}): Promise<CampaignEvent> {
    const event: Omit<CampaignEvent, 'hash'> = {
      eventId: randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      sequenceNumber: ++this.sequenceNumber,
      campaignId: this.options.campaignId,
      runId: this.options.runId,
      gitSha: this.options.gitSha ?? '',
      schemaVersion: 'v1',
      ...(this.options.scenarioId ? { scenarioId: this.options.scenarioId } : {}),
      ...(extra.phase ? { phase: extra.phase } : {}),
      data,
      prevHash: this.lastHash,
    };

    // Strip undefined first: the hash must be computed over the same document that is written.
    const payload = stripUndefined(event) as Omit<CampaignEvent, 'hash'>;
    const hash = sha256(stableStringify(payload));
    const record: CampaignEvent = { ...payload, hash };

    await appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    if (this.options.durable) await this.fsync();

    this.lastHash = hash;
    return record;
  }

  private async fsync(): Promise<void> {
    const { open } = await import('node:fs/promises');
    const handle = await open(this.file, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readEvents(): Promise<CampaignEvent[]> {
    if (!existsSync(this.file)) return [];
    const content = await readFile(this.file, 'utf8');
    const events: CampaignEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as CampaignEvent);
      } catch {
        break;
      }
    }
    return events;
  }

  /** Recomputes the whole hash chain and reports the first inconsistency. */
  async verify(): Promise<LogIntegrityReport> {
    if (!existsSync(this.file)) {
      return {
        file: this.file,
        lines: 0,
        validLines: 0,
        firstBrokenSequence: null,
        reason: 'log file does not exist',
        lastHash: null,
        ok: false,
      };
    }

    const chain = verifyEventChain(await readFile(this.file, 'utf8'));
    return {
      file: this.file,
      lines: chain.lines,
      validLines: chain.ok ? chain.lines : 0,
      firstBrokenSequence: chain.brokenAt,
      reason: chain.reason,
      lastHash: chain.lastHash,
      ok: chain.ok,
    };
  }

  /** Counts lines without validating them; used for cheap progress output. */
  async lineCount(): Promise<number> {
    if (!existsSync(this.file)) return 0;
    return new Promise((resolve, reject) => {
      let count = 0;
      const stream = createReadStream(this.file);
      stream.on('data', (chunk) => {
        for (const byte of chunk as Buffer) if (byte === 0x0a) count++;
      });
      stream.on('end', () => resolve(count));
      stream.on('error', reject);
    });
  }
}
