import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLogger, stableStringify, stripUndefined, verifyEventChain } from './eventLogger.js';
import { createBundle, verifyBundleDir, verifyBundleZip } from './bundle.js';
import { createZip, readZip } from './zip.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rollprobe-evidence-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('event logger', () => {
  it('appends without destroying previous events', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r1', gitSha: 'abc' });
    await logger.start();
    await logger.log('run_started', { step: 1 });
    await logger.log('operation_executed', { step: 2 });
    await logger.log('run_completed', { step: 3 });

    const content = await readFile(logger.file, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);

    const report = await logger.verify();
    expect(report.ok).toBe(true);
    expect(report.lines).toBe(3);
  });

  it('assigns monotonic sequence numbers and links hashes', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r1' });
    await logger.start();
    const first = await logger.log('run_started', {});
    const second = await logger.log('run_completed', {});

    expect(second.sequenceNumber).toBe(first.sequenceNumber + 1);
    expect(second.prevHash).toBe(first.hash);
  });

  it('resumes the sequence after a restart', async () => {
    const first = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r1' });
    await first.start();
    await first.log('run_started', {});
    await first.log('operation_executed', {});

    const second = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r1' });
    await second.start();
    const event = await second.log('run_completed', {});

    expect(event.sequenceNumber).toBe(3);
    expect((await second.verify()).ok).toBe(true);
  });

  it('rotates the log instead of mixing two different runs', async () => {
    const first = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'run-a' });
    await first.start();
    await first.log('run_started', { which: 'a' });

    const second = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'run-b' });
    await second.start();
    await second.log('run_started', { which: 'b' });

    const current = await readFile(second.file, 'utf8');
    expect(current.trim().split('\n')).toHaveLength(1);
    expect(current).toContain('"which":"b"');
    expect(existsSync(path.join(dir, 'events.run-a.ndjson'))).toBe(true);
  });

  it('detects tampering with a historical line', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r1' });
    await logger.start();
    await logger.log('run_started', { value: 'original' });
    await logger.log('run_completed', {});

    const original = await readFile(logger.file, 'utf8');
    const tampered = original.replace('"original"', '"forged"');
    await writeFile(logger.file, tampered, 'utf8');

    const report = await logger.verify();
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/does not recompute/);
  });

  it('detects a truncated trailing line', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r1' });
    await logger.start();
    await logger.log('run_started', {});
    const original = await readFile(logger.file, 'utf8');
    await writeFile(logger.file, `${original}{"half":`, 'utf8');

    const report = await logger.verify();
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/trailing partial line/);
  });
});

describe('hash chain reproducibility', () => {
  it('never writes a key whose value is undefined', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r-optional' });
    await logger.start();
    await logger.log('observation_made', {
      status: 'ok',
      transportError: undefined,
      nested: { present: 1, missing: undefined },
      list: [1, undefined, 3],
    });

    const content = await readFile(logger.file, 'utf8');
    expect(content).not.toContain('undefined');
    // undefined inside an array must become null, exactly like JSON.stringify
    expect(content).toContain('"list":[1,null,3]');
    expect((await logger.verify()).ok).toBe(true);
  });

  it('recomputes every event hash from the bytes on disk', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r-recompute' });
    await logger.start();
    await logger.log('run_started', { optional: undefined, value: 1 });
    await logger.log('observation_made', { transportError: undefined, httpStatus: 201 });
    await logger.log('run_completed', { status: 'VIOLATION' });

    const content = await readFile(logger.file, 'utf8');
    const chain = verifyEventChain(content);
    expect(chain.ok).toBe(true);
    expect(chain.lines).toBe(3);
    expect(chain.lastHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises undefined the same way JSON.stringify does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableStringify({ list: [1, undefined, 3] })).toBe('{"list":[1,null,3]}');
    expect(stripUndefined({ a: undefined, b: { c: undefined, d: 2 } })).toEqual({ b: { d: 2 } });
  });

  it('detects a tampered event even when the bundle manifest is rebuilt to match', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r-tamper' });
    await logger.start();
    await logger.log('run_started', { value: 'original' });
    await logger.log('run_completed', { status: 'VIOLATION' });
    const content = await readFile(logger.file, 'utf8');

    // Rebuild a bundle from modified events, so every file hash and size is consistent again.
    const tampered = content.replace('"value":"original"', '"value":"forged"');
    expect(tampered).not.toBe(content);

    const rebuilt = await createBundle({
      outputDir: path.join(dir, 'bundle-tampered'),
      campaignId: 'c1',
      runId: 'r-tamper',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'VIOLATION',
      summary: { totalEvents: 2, totalChecks: 0, violations: 1, inconclusive: 0, satisfied: 0 },
      files: [{ name: 'events.ndjson', type: 'events', content: tampered }],
    });

    const verification = await verifyBundleZip(rebuilt.zipPath);
    expect(verification.ok).toBe(false);
    expect(verification.chainOk).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/hash chain is not reproducible/);
  });

  it('detects a deleted event through the sequence and previous-hash links', async () => {
    const logger = new EventLogger({ outputDir: dir, campaignId: 'c1', runId: 'r-delete' });
    await logger.start();
    await logger.log('run_started', {});
    await logger.log('observation_made', {});
    await logger.log('run_completed', {});
    const lines = (await readFile(logger.file, 'utf8')).split('\n').filter((line) => line.trim());
    const withGap = `${lines[0]}\n${lines[2]}\n`;

    const rebuilt = await createBundle({
      outputDir: path.join(dir, 'bundle-gap'),
      campaignId: 'c1',
      runId: 'r-delete',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'VIOLATION',
      summary: { totalEvents: 2, totalChecks: 0, violations: 1, inconclusive: 0, satisfied: 0 },
      files: [{ name: 'events.ndjson', type: 'events', content: withGap }],
    });

    const verification = await verifyBundleZip(rebuilt.zipPath);
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/sequence gap/);
  });
});

describe('zip writer/reader', () => {
  it('round-trips text and binary entries', () => {
    const payload = Buffer.from('hello rollprobe');
    const archive = createZip([
      { name: 'a.txt', data: Buffer.from('alpha') },
      { name: 'nested/b.bin', data: payload },
    ]);

    const entries = readZip(archive);
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'nested/b.bin']);
    expect(entries.find((e) => e.name === 'nested/b.bin')?.data.equals(payload)).toBe(true);
  });

  it('rejects a corrupted archive', () => {
    expect(() => readZip(Buffer.from('definitely not a zip'))).toThrow(/end of central directory/);
  });
});

describe('evidence bundle', () => {
  it('refuses to verify a bundle that carries no event log', async () => {
    const bundle = await createBundle({
      outputDir: path.join(dir, 'bundle-no-events'),
      campaignId: 'c1',
      runId: 'r0',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'BOUNDED_PASS',
      summary: { totalEvents: 0, totalChecks: 1, violations: 0, inconclusive: 0, satisfied: 1 },
      files: [{ name: 'checks.json', type: 'checks', content: '[]\n' }],
    });

    const verification = await verifyBundleZip(bundle.zipPath);
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/no event log/);
  });

  it('measures the event count from the archived log instead of trusting the caller', async () => {
    const logger = new EventLogger({ outputDir: path.join(dir, 'src-events2'), campaignId: 'c1', runId: 'r2' });
    await logger.start();
    await logger.log('run_started', { step: 1 });
    await logger.log('observation_made', { step: 2 });
    await logger.log('run_completed', { step: 3 });
    const events = await readFile(logger.file, 'utf8');
    const bundle = await createBundle({
      outputDir: path.join(dir, 'bundle-events'),
      campaignId: 'c1',
      runId: 'r1',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'VIOLATION',
      summary: { totalEvents: 0, totalChecks: 1, violations: 1, inconclusive: 0, satisfied: 0 },
      files: [{ name: 'events.ndjson', type: 'events', content: events }],
    });

    expect(bundle.manifest.summary.totalEvents).toBe(3);
    const verification = await verifyBundleZip(bundle.zipPath);
    expect(verification.ok).toBe(true);
    expect(verification.eventLines).toBe(3);
  });

  it('creates a bundle whose hashes verify', async () => {
    const logger = new EventLogger({ outputDir: path.join(dir, 'src-events'), campaignId: 'c1', runId: 'r1' });
    await logger.start();
    await logger.log('run_started', { step: 1 });

    const bundle = await createBundle({
      outputDir: path.join(dir, 'bundle'),
      campaignId: 'c1',
      runId: 'r1',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'VIOLATION',
      summary: { totalEvents: 3, totalChecks: 2, violations: 1, inconclusive: 0, satisfied: 1 },
      files: [
        { name: 'events.ndjson', type: 'events', content: await readFile(logger.file, 'utf8') },
        { name: 'checks.json', type: 'checks', content: '[]\n' },
      ],
    });

    expect(bundle.manifest.files).toHaveLength(2);
    expect((await verifyBundleZip(bundle.zipPath)).ok).toBe(true);
    expect((await verifyBundleDir(bundle.dir)).ok).toBe(true);
  });

  it('fails verification when a bundled file is altered', async () => {
    const bundle = await createBundle({
      outputDir: path.join(dir, 'bundle2'),
      campaignId: 'c1',
      runId: 'r2',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'BOUNDED_PASS',
      summary: { totalEvents: 1, totalChecks: 1, violations: 0, inconclusive: 0, satisfied: 1 },
      files: [{ name: 'checks.json', type: 'checks', content: '[]\n' }],
    });

    await writeFile(path.join(bundle.dir, 'checks.json'), '[{"tampered":true}]\n', 'utf8');
    const verification = await verifyBundleDir(bundle.dir);
    expect(verification.ok).toBe(false);
    expect(verification.mismatched.map((m) => m.path)).toContain('checks.json');
  });

  it('reports missing files instead of passing', async () => {
    const bundle = await createBundle({
      outputDir: path.join(dir, 'bundle3'),
      campaignId: 'c1',
      runId: 'r3',
      gitSha: 'deadbeef',
      scenarioId: 's1',
      scenarioSha256: 'a'.repeat(64),
      determination: 'INCONCLUSIVE',
      summary: { totalEvents: 0, totalChecks: 0, violations: 0, inconclusive: 0, satisfied: 0 },
      files: [{ name: 'run.json', type: 'run', content: '{}\n' }],
    });

    await rm(path.join(bundle.dir, 'run.json'));
    const verification = await verifyBundleDir(bundle.dir);
    expect(verification.ok).toBe(false);
    expect(verification.missing).toContain('run.json');
  });
});
