/**
 * Evidence bundle: a directory plus a ZIP archive containing everything needed to
 * re-check a run offline, with SHA-256 hashes for every file and a hash of the manifest
 * itself. Verification reads the archive through our own ZIP reader, so it does not trust
 * the code path that produced it.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createZip, readZip } from './zip.js';
import { verifyEventChain } from './eventLogger.js';
import { ROLLPROBE_VERSION } from '@rollprobe/protocol';
import type { BundleManifest, BundleVerification, FileRecord } from './types.js';

export const BUNDLE_FORMAT_VERSION = 'rollprobe-evidence-1';

export interface BundleFileInput {
  name: string;
  type: FileRecord['type'];
  content: string | Buffer;
}

export interface BundleInput {
  outputDir: string;
  campaignId: string;
  runId: string;
  gitSha: string;
  scenarioId: string;
  scenarioSha256: string;
  determination: string;
  summary: BundleManifest['summary'];
  files: BundleFileInput[];
}

export interface BundleOutput {
  dir: string;
  zipPath: string;
  manifest: BundleManifest;
  manifestSha256: string;
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

export async function createBundle(input: BundleInput): Promise<BundleOutput> {
  await mkdir(input.outputDir, { recursive: true });

  const files: FileRecord[] = [];
  const payloads: Array<{ name: string; data: Buffer }> = [];

  for (const file of input.files) {
    const data = toBuffer(file.content);
    const normalized = file.name.replace(/\\/g, '/');
    const target = path.join(input.outputDir, normalized);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    files.push({ path: normalized, size: data.length, sha256: sha256(data), type: file.type });
    payloads.push({ name: normalized, data });
  }

  const eventFile = payloads.find((entry) => entry.name.endsWith('.ndjson'));
  const eventLines = eventFile
    ? eventFile.data.toString('utf8').split('\n').filter((line) => line.trim().length > 0).length
    : 0;

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    rollprobeVersion: ROLLPROBE_VERSION,
    createdAt: new Date().toISOString(),
    gitSha: input.gitSha,
    campaignId: input.campaignId,
    runId: input.runId,
    scenarioId: input.scenarioId,
    scenarioSha256: input.scenarioSha256,
    determination: input.determination,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    // The event count is measured from the archived log, never taken on trust.
    summary: { ...input.summary, totalEvents: eventLines },
  };

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha = sha256(manifestJson);

  await writeFile(path.join(input.outputDir, 'manifest.json'), manifestJson, 'utf8');
  await writeFile(path.join(input.outputDir, 'manifest.sha256'), `${manifestSha}\n`, 'utf8');

  payloads.push({ name: 'manifest.json', data: Buffer.from(manifestJson, 'utf8') });

  const zipPath = `${input.outputDir}.zip`;
  await writeFile(zipPath, createZip(payloads));

  return { dir: input.outputDir, zipPath, manifest, manifestSha256: manifestSha };
}

function verifyFileRecords(
  records: FileRecord[],
  lookup: (name: string) => Buffer | undefined
): BundleVerification {
  const result: BundleVerification = { ok: true, checkedFiles: 0, missing: [], mismatched: [], errors: [] };

  for (const record of records) {
    const data = lookup(record.path);
    if (!data) {
      result.missing.push(record.path);
      result.ok = false;
      continue;
    }
    const actual = sha256(data);
    if (actual !== record.sha256) {
      result.mismatched.push({ path: record.path, expected: record.sha256, actual });
      result.ok = false;
    }
    result.checkedFiles++;
  }

  return result;
}

export async function verifyBundleZip(zipPath: string): Promise<BundleVerification> {
  const result: BundleVerification = { ok: true, checkedFiles: 0, missing: [], mismatched: [], errors: [] };

  let entries;
  try {
    entries = readZip(await readFile(zipPath));
  } catch (error) {
    return { ...result, ok: false, errors: [`cannot read archive: ${(error as Error).message}`] };
  }

  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifestData = byName.get('manifest.json');
  if (!manifestData) {
    return { ...result, ok: false, errors: ['archive has no manifest.json'] };
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(manifestData.toString('utf8')) as BundleManifest;
  } catch (error) {
    return { ...result, ok: false, errors: [`manifest.json is not valid JSON: ${(error as Error).message}`] };
  }

  if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
    result.errors.push(`unexpected bundle format version: ${manifest.formatVersion}`);
    result.ok = false;
  }

  const fileCheck = verifyFileRecords(manifest.files, (name) => byName.get(name));
  result.missing.push(...fileCheck.missing);
  result.mismatched.push(...fileCheck.mismatched);
  result.checkedFiles += fileCheck.checkedFiles;
  if (!fileCheck.ok) result.ok = false;

  const eventCheck = verifyEventLog(manifest, (name) => byName.get(name));
  result.eventLines = eventCheck.lines;
  result.chainOk = eventCheck.chainOk;
  if (!eventCheck.ok) {
    result.ok = false;
    result.errors.push(eventCheck.error);
  }

  return result;
}

export async function verifyBundleDir(dir: string): Promise<BundleVerification> {
  const result: BundleVerification = { ok: true, checkedFiles: 0, missing: [], mismatched: [], errors: [] };
  const manifestPath = path.join(dir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return { ...result, ok: false, errors: ['manifest.json is missing'] };
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BundleManifest;
  } catch (error) {
    return { ...result, ok: false, errors: [`manifest.json is not valid JSON: ${(error as Error).message}`] };
  }

  const lookup = (name: string): Buffer | undefined => {
    const full = path.join(dir, name);
    if (!existsSync(full)) return undefined;
    return readFileSync(full);
  };

  const fileCheck = verifyFileRecords(manifest.files, lookup);
  result.missing.push(...fileCheck.missing);
  result.mismatched.push(...fileCheck.mismatched);
  result.checkedFiles += fileCheck.checkedFiles;
  if (!fileCheck.ok) result.ok = false;

  const eventCheck = verifyEventLog(manifest, lookup);
  result.eventLines = eventCheck.lines;
  result.chainOk = eventCheck.chainOk;
  if (!eventCheck.ok) {
    result.ok = false;
    result.errors.push(eventCheck.error);
  }

  return result;
}

/**
 * A bundle whose hashes are all correct but which contains no event log is not evidence.
 * This was a real defect: the log was written as `<runId>.ndjson` while the bundler looked
 * for `events.ndjson`, so archives verified cleanly while carrying zero events.
 */
function verifyEventLog(
  manifest: BundleManifest,
  lookup: (name: string) => Buffer | undefined
): { ok: boolean; lines: number; chainOk: boolean; error: string } {
  const entry = manifest.files.find((file) => file.type === 'events' && file.path.endsWith('.ndjson'));
  if (!entry) {
    return { ok: false, lines: 0, chainOk: false, error: 'bundle contains no event log (no file of type "events")' };
  }
  const data = lookup(entry.path);
  if (!data) {
    return { ok: false, lines: 0, chainOk: false, error: `event log ${entry.path} is missing from the archive` };
  }

  const content = data.toString('utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0).length;
  if (lines === 0) {
    return { ok: false, lines: 0, chainOk: false, error: `event log ${entry.path} is empty` };
  }
  if (manifest.summary.totalEvents !== lines) {
    return {
      ok: false,
      lines,
      chainOk: false,
      error: `manifest declares ${manifest.summary.totalEvents} events but the log has ${lines}`,
    };
  }

  // The decisive check: every event hash and every previous-hash link must recompute.
  const chain = verifyEventChain(content);
  if (!chain.ok) {
    return {
      ok: false,
      lines,
      chainOk: false,
      error: `event hash chain is not reproducible: ${chain.reason} (sequence ${chain.brokenAt})`,
    };
  }

  return { ok: true, lines, chainOk: true, error: '' };
}
