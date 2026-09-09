import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { exportData } from '../data-export.mjs';
import { FORMULA_VERSION } from '../src/verify/score.js';
import { createStore } from '../src/store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  return { source, to: path.join(root, 'export') };
}
const check = (token, ts) => ({ key: `56:${token}`, ts, chainId: 56, tokenId: String(token), formulaVersion: FORMULA_VERSION, tier: 'registered' });

test('export preserves history bytes, emits integrity and restored counts, omits credentials', (t) => {
  const { source, to } = fixture(t);
  const bytes = [check(1, '2026-09-06T12:00:00Z'), check(2, '2026-09-07T12:00:00Z'), check(1, '2026-09-08T12:00:00Z')].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(path.join(source, 'verdicts.jsonl'), bytes);
  fs.writeFileSync(path.join(source, 'activity.jsonl'), '{"t":"tx","wallet":"0xwallet","id":"tx:1","block":1}\n');
  fs.writeFileSync(path.join(source, 'escrow-census.json'), '{"fixture":true}');
  fs.writeFileSync(path.join(source, '.env'), 'FAKE_SECRET=must-not-export');
  const { manifest } = exportData({ from: source, to, seedPath: null });
  assert.equal(fs.readFileSync(path.join(to, 'verdicts.jsonl'), 'utf8'), bytes);
  assert.equal(fs.readFileSync(path.join(source, 'verdicts.jsonl'), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(to, '.env')), false);
  assert.equal(manifest.files[0].records, 3);
  assert.equal(manifest.files[0].distinctAgents, 2);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(manifest.missingFiles, []);
  assert.equal(manifest.expectedSummaryWithBundledSeed.uniqueChecked, 2);
  assert.equal(manifest.expectedSummaryWithBundledSeed.checksRun, 3);
});

test('existing exports and incomplete writes are rejected without replacing files', (t) => {
  const { source, to } = fixture(t);
  fs.writeFileSync(path.join(source, 'verdicts.jsonl'), `${JSON.stringify(check(1, '2026-09-08T12:00:00Z'))}\n{"key":`);
  assert.throws(() => exportData({ from: source, to, seedPath: null }), /incomplete or invalid JSON/);
  assert.equal(fs.existsSync(to), false);
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'keep'), 'existing');
  assert.throws(() => exportData({ from: source, to, seedPath: null }), /already exists/);
  assert.equal(fs.readFileSync(path.join(to, 'keep'), 'utf8'), 'existing');
});

test('optional data stays explicitly missing and invalid histories never export', (t) => {
  const { source, to } = fixture(t);
  fs.writeFileSync(path.join(source, 'verdicts.jsonl'), `${JSON.stringify(check(1, '2026-09-08T12:00:00Z'))}\n`);
  const { manifest } = exportData({ from: source, to, seedPath: null });
  assert.deepEqual(manifest.missingFiles, ['activity.jsonl', 'escrow-census.json']);
  fs.writeFileSync(path.join(source, 'verdicts.jsonl'), '{"key":"not-an-identity","ts":"bad"}\n');
  assert.throws(() => exportData({ from: source, to: `${to}-bad`, seedPath: null }), /invalid identity/);
});

test('versioned compacted verdict state exports byte-for-byte and restores its exact summary', (t) => {
  const { source, to } = fixture(t);
  const store = createStore(path.join(source, 'verdicts.jsonl'), {
    seedFile: null, compactAtBytes: 1, maxFileBytes: 128 * 1024,
  });
  for (let day = 1; day <= 55; day += 1) {
    store.record('56:1', {
      computedAt: new Date(Date.UTC(2026, 6, day)).toISOString(), tier: 'registered',
      formulaVersion: FORMULA_VERSION, endpointProven: false, proofs: [], categories: [],
    });
  }
  const bytes = fs.readFileSync(path.join(source, 'verdicts.jsonl'));
  const expected = store.summary();
  const { manifest } = exportData({ from: source, to, seedPath: null });
  assert.deepEqual(fs.readFileSync(path.join(source, 'verdicts.jsonl')), bytes, 'inspection is read-only');
  assert.deepEqual(fs.readFileSync(path.join(to, 'verdicts.jsonl')), bytes);
  assert.deepEqual(manifest.expectedSummaryWithBundledSeed, expected);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('semantically corrupt checkpoints are rejected before an export directory is created', (t) => {
  const { source, to } = fixture(t);
  const broken = { t: 'verdict-state-v1', key: '56:1', ts: '2026-09-08T00:00:00Z', checksRun: 9 };
  fs.writeFileSync(path.join(source, 'verdicts.jsonl'), `${JSON.stringify(broken)}\n`);
  assert.throws(() => exportData({ from: source, to, seedPath: null }), /checkpoint state/);
  assert.equal(fs.existsSync(to), false);
});

test('activity export accepts restorable rows and rejects generic JSON objects', (t) => {
  const { source, to } = fixture(t);
  fs.writeFileSync(path.join(source, 'verdicts.jsonl'), `${JSON.stringify(check(1, '2026-09-08T12:00:00Z'))}\n`);
  fs.writeFileSync(path.join(source, 'activity.jsonl'), '{"fixture":true}\n');
  assert.throws(() => exportData({ from: source, to, seedPath: null }), /invalid or unsupported/);
  assert.equal(fs.existsSync(to), false);
});

test('unknown legacy observation times survive checkpoint export and restore', (t) => {
  const { source, to } = fixture(t);
  const store = createStore(path.join(source, 'verdicts.jsonl'), {
    seedFile: null, compactAtBytes: 1, maxFileBytes: 128 * 1024,
  });
  store.record('56:1', { computedAt: 'not-a-date', tier: 'active', formulaVersion: 'legacy' });
  const expected = store.historyFor('56:1');
  exportData({ from: source, to, seedPath: null });
  const restored = createStore(path.join(to, 'verdicts.jsonl'), { seedFile: null }).historyFor('56:1');
  assert.equal(restored.length, expected.length);
  assert.equal(restored[0].key, expected[0].key);
  assert.equal(restored[0].ts, expected[0].ts);
});
