#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.js';
import { FORMULA_VERSION } from './src/verify/score.js';
import { validateVerdictCheckpoint } from './src/persistence/verdict-records.js';

const DATA_FILES = ['verdicts.jsonl', 'activity.jsonl', 'escrow-census.json'];

function inspectFile(name, bytes) {
  const text = bytes.toString('utf8');
  if (name.endsWith('.jsonl')) {
    const records = text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`${name}: incomplete or invalid JSON at record ${index + 1}. Retry after the current write finishes.`); }
    });
    if (records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
      throw new Error(`${name}: expected JSON objects.`);
    }
    if (name === 'verdicts.jsonl' && records.some((record) => !validVerdictRecord(record))) {
      throw new Error('verdicts.jsonl: invalid identity, observation field, or checkpoint state.');
    }
    if (name === 'activity.jsonl' && records.some((record) => !validActivityRecord(record))) {
      throw new Error('activity.jsonl: invalid or unsupported transaction/coverage record.');
    }
    return { records: records.length, ...(name === 'verdicts.jsonl'
      ? { distinctAgents: new Set(records.map((record) => record.key)).size } : {}) };
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${name}: incomplete or invalid JSON.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: expected a JSON object.`);
  return {};
}

function validVerdictRecord(record) {
  if (!/^\d+:\d+$/.test(record?.key ?? '') || !validObservationField(record.ts)) return false;
  if (record.t !== 'verdict-state-v1') return record.t === undefined;
  try { validateVerdictCheckpoint(record); return true; } catch { return false; }
}

function validObservationField(value) {
  return value === undefined || value === null || typeof value === 'string' || typeof value === 'number';
}

function validActivityRecord(record) {
  if (record?.t === 'tx') {
    return typeof record.wallet === 'string' && Boolean(record.wallet)
      && typeof record.id === 'string' && Boolean(record.id)
      && Number.isFinite(Number(record.block ?? 0));
  }
  if (record?.t === 'cov') {
    return typeof record.wallet === 'string' && Boolean(record.wallet)
      && Number.isFinite(record.fromBlock) && Number.isFinite(record.toBlock)
      && record.fromBlock <= record.toBlock;
  }
  return false;
}

// Snapshot only service data, never configuration or credentials. The source
// remains live; each captured file must contain complete, valid JSON records.
export function exportData({ from, to, now = new Date(), seedPath } = {}) {
  if (!from || !to) throw new Error('Both source data directory and new export directory are required.');
  const source = path.resolve(from);
  const destination = path.resolve(to);
  if (fs.existsSync(destination)) throw new Error('Export directory already exists. Choose a new directory; exports are never overwritten.');
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('Source data directory does not exist.');
  const snapshots = DATA_FILES.flatMap((name) => {
    const file = path.join(source, name);
    if (!fs.existsSync(file)) return [];
    const bytes = fs.readFileSync(file);
    return [{ name, bytes, details: inspectFile(name, bytes) }];
  });
  if (!snapshots.some((file) => file.name === 'verdicts.jsonl')) throw new Error('Source has no verdicts.jsonl history to migrate.');
  // Validate all files before creating the destination. Exclusive writes also
  // prevent a second export from replacing a snapshot created concurrently.
  fs.mkdirSync(destination);
  for (const { name, bytes } of snapshots) fs.writeFileSync(path.join(destination, name), bytes, { flag: 'wx' });
  const store = createStore(path.join(destination, 'verdicts.jsonl'), seedPath === undefined ? undefined : { seedFile: seedPath });
  if (store.storageStatus().malformedRows) throw new Error('verdicts.jsonl: degraded replay; refusing to export incomplete checkpoint state.');
  const summary = store.summary();
  const manifest = {
    format: 'findyouragent-data-export-v1', exportedAt: now.toISOString(), formulaVersion: FORMULA_VERSION,
    consistency: 'Each file is a validated snapshot. Files may have different capture times while the source service is running.',
    files: snapshots.map(({ name, bytes, details }) => ({ name, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), ...details })),
    missingFiles: DATA_FILES.filter((name) => !snapshots.some((file) => file.name === name)),
    expectedSummaryWithBundledSeed: summary,
  };
  fs.writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { destination, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!['--from', '--to'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i].slice(2)]) {
        throw new Error('Usage: npm run data:export -- --to "new-export-directory" [--from "source-data-directory"]');
      }
      options[args[i].slice(2)] = args[i + 1];
    }
    options.from ??= process.env.DATA_DIR || fileURLToPath(new URL('./data', import.meta.url));
    const { destination, manifest } = exportData(options);
    console.log(`Data snapshot exported to ${destination}`);
    for (const file of manifest.files) console.log(`  ${file.name}: ${file.bytes} bytes${file.records !== undefined ? `, ${file.records} records` : ''}`);
    console.log('SHA-256 hashes and expected restored summary are in manifest.json. No deployment was performed.');
  } catch (error) { console.error(`Data export failed: ${error.message}`); process.exitCode = 1; }
}
