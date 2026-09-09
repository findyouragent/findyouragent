import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { replayJsonl } from '../src/persistence/bounded-jsonl.js';
import { readLatestVerdicts, VERDICT_STATE_ROW } from '../src/persistence/verdict-records.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'rows.jsonl');
}

const check = (ts, over = {}) => ({ key: '56:1', ts, tier: 'active', formulaVersion: 'test', ...over });
const checkpoint = (latest, over = {}) => ({
  t: VERDICT_STATE_ROW,
  key: latest.key,
  ts: latest.ts,
  checksRun: 1,
  latest,
  history: [latest],
  uptime: [],
  ...over,
});

test('stream replay preserves UTF-8 characters split across one-byte chunks', (t) => {
  const file = fixture(t);
  const expected = { name: 'İstanbul’da çalışan 机器人 🚀' };
  fs.writeFileSync(file, `${JSON.stringify(expected)}\n`);
  const rows = [];
  replayJsonl(file, { maxBytes: 4096, maxLineBytes: 1024, chunkBytes: 1, onRecord: (row) => rows.push(row) });
  assert.deepEqual(rows, [expected]);
});

test('checkpoint reader preserves latest evidence across raw/checkpoint/tail mixtures', (t) => {
  const file = fixture(t);
  const compacted = check('2026-09-02T00:00:00.000Z', { name: 'compacted', endpointProven: true });
  const tail = check('2026-09-03T00:00:00.000Z', { name: 'tail', endpointProven: true, servedNames: ['swap'] });
  fs.writeFileSync(file, [
    JSON.stringify(check('2026-09-01T00:00:00.000Z', { name: 'raw' })),
    JSON.stringify(checkpoint(compacted)),
    '{ torn legacy json',
    JSON.stringify(tail),
  ].join('\n') + '\n');
  const result = readLatestVerdicts(file, { chunkBytes: 3 });
  assert.equal(result.malformed, 1);
  assert.deepEqual(result.latest.get('56:1'), tail);
});

test('invalid or unsupported checkpoint rows fail closed instead of becoming malformed JSON', (t) => {
  const file = fixture(t);
  const latest = check('2026-09-02T00:00:00.000Z');
  fs.writeFileSync(file, `${JSON.stringify(checkpoint(latest, { history: [] }))}\n`);
  assert.throws(() => readLatestVerdicts(file), /latest verdict is absent/);
  fs.writeFileSync(file, `${JSON.stringify({ t: 'verdict-state-v2', key: '56:1' })}\n`);
  assert.throws(() => readLatestVerdicts(file), /Unsupported verdict persistence row type/);
  fs.writeFileSync(file, '{"t":"verdict-state-v1","key":"56:1",broken}\n');
  assert.throws(() => readLatestVerdicts(file), /Malformed versioned verdict checkpoint JSON/);
});

test('replay rejects an oversized row before accumulating the rest of the file', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, `${JSON.stringify({ text: 'x'.repeat(200) })}\n${JSON.stringify({ ok: true })}\n`);
  assert.throws(() => replayJsonl(file, {
    maxBytes: 4096, maxLineBytes: 64, chunkBytes: 7, onRecord() {},
  }), /replay row ceiling/);
});

test('valid timestamps outrank unknown dates while unknown observations remain readable', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, [
    JSON.stringify(check('2026-09-02T00:00:00.000Z', { name: 'valid' })),
    JSON.stringify(check('zzzz-not-a-date', { name: 'unknown' })),
  ].join('\n') + '\n');
  assert.equal(readLatestVerdicts(file).latest.get('56:1').name, 'valid');
});
