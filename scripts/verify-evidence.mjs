#!/usr/bin/env node
/**
 * Standalone evidence verifier.
 *
 * Deliberately imports nothing from the project: it re-implements ZIP reading, SHA-256
 * hashing and JSON canonicalisation with Node built-ins only, so its verdict does not depend
 * on the code that produced the bundle.
 *
 * Usage:
 *   node scripts/verify-evidence.mjs <bundle.zip | bundle-directory>
 *
 * Checks:
 *   1. every file listed in manifest.json exists and matches its SHA-256 and size
 *   2. events.ndjson is present, non-empty, and its line count matches the manifest
 *   3. every event's sequence number, previous-hash link and content hash recompute
 *
 * Exit codes: 0 all checks pass, 2 any check fails, 3 usage error.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Canonical JSON: object keys sorted, undefined members dropped, arrays preserved. */
function canonical(value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

function readZip(buffer) {
  const eocd = (() => {
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 0xffff - 22); i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error('not a ZIP archive (no end of central directory)');
  })();

  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function loadBundle(target) {
  if (statSync(target).isDirectory()) {
    const read = (name) => {
      const full = path.join(target, name);
      return existsSync(full) ? readFileSync(full) : undefined;
    };
    return { read, kind: 'directory' };
  }
  const entries = readZip(readFileSync(target));
  return { read: (name) => entries.get(name), kind: 'archive' };
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/verify-evidence.mjs <bundle.zip | bundle-directory>');
    process.exit(3);
  }

  const result = {
    target,
    kind: null,
    manifest: { ok: false, files: 0, missing: [], mismatched: [] },
    events: { ok: false, lines: 0, declared: 0, brokenAt: null, reason: null },
    ok: false,
  };

  try {
    const bundle = loadBundle(target);
    result.kind = bundle.kind;

    const manifestBuffer = bundle.read('manifest.json');
    if (!manifestBuffer) throw new Error('manifest.json is missing');
    const manifest = JSON.parse(manifestBuffer.toString('utf8'));
    result.events.declared = manifest.summary?.totalEvents ?? -1;

    for (const file of manifest.files ?? []) {
      const data = bundle.read(file.path);
      if (!data) {
        result.manifest.missing.push(file.path);
        continue;
      }
      const digest = sha256(data);
      if (digest !== file.sha256 || data.length !== file.size) {
        result.manifest.mismatched.push({ path: file.path, expected: file.sha256, actual: digest });
        continue;
      }
      result.manifest.files += 1;
    }
    result.manifest.ok =
      result.manifest.missing.length === 0 && result.manifest.mismatched.length === 0;

    const eventFile = (manifest.files ?? []).find((file) => file.type === 'events');
    if (!eventFile) throw new Error('manifest lists no file of type "events"');
    const eventBuffer = bundle.read(eventFile.path);
    if (!eventBuffer) throw new Error(`event log ${eventFile.path} is missing`);

    const lines = eventBuffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    result.events.lines = lines.length;

    let previous = '0'.repeat(64);
    let expectedSequence = 1;
    let ok = true;

    for (const line of lines) {
      const event = JSON.parse(line);
      const { hash, ...rest } = event;
      if (event.sequenceNumber !== expectedSequence) {
        ok = false;
        result.events.reason = `sequence gap: expected ${expectedSequence}, found ${event.sequenceNumber}`;
        result.events.brokenAt = expectedSequence;
        break;
      }
      if (event.prevHash !== previous) {
        ok = false;
        result.events.reason = `previous-hash link broken at sequence ${event.sequenceNumber}`;
        result.events.brokenAt = event.sequenceNumber;
        break;
      }
      const recomputed = sha256(JSON.stringify(canonical(rest)));
      if (recomputed !== hash) {
        ok = false;
        result.events.reason = `content hash does not recompute at sequence ${event.sequenceNumber}`;
        result.events.brokenAt = event.sequenceNumber;
        break;
      }
      previous = hash;
      expectedSequence += 1;
    }

    if (ok && result.events.declared !== lines.length) {
      ok = false;
      result.events.reason = `manifest declares ${result.events.declared} events, log has ${lines.length}`;
    }
    result.events.ok = ok;
    result.ok = result.manifest.ok && result.events.ok;
  } catch (error) {
    result.events.reason = result.events.reason ?? String(error.message ?? error);
    result.ok = false;
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

main();
