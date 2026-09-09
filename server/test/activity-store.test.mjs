import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityStore } from '../src/activity/store.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fya-act-')), 'activity.jsonl');
}
const tx = (id, block, over = {}) => ({ t: 'tx', wallet: '0xwallet', id, block, ts: new Date(block * 1000).toISOString(), ...over });

test('activityFor returns rows newest-block first', () => {
  const s = createActivityStore(tmpFile());
  s.recordTransfers([tx('a', 10), tx('b', 30), tx('c', 20)]);
  const { events } = s.activityFor('0xwallet');
  assert.deepStrictEqual(events.map((e) => e.id), ['b', 'c', 'a']);
});

test('same id dedupes, newest block wins', () => {
  const s = createActivityStore(tmpFile());
  s.recordTransfers([tx('a', 10, { amount: '1' })]);
  s.recordTransfers([tx('a', 12, { amount: '2' })]); // same id, later block
  const { events } = s.activityFor('0xwallet');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].amount, '2');
});

test('a stale re-read of the same id does NOT overwrite the newer row', () => {
  const s = createActivityStore(tmpFile());
  s.recordTransfers([tx('a', 12, { amount: '2' })]);
  s.recordTransfers([tx('a', 10, { amount: '1' })]); // older block arrives late
  assert.strictEqual(s.activityFor('0xwallet').events[0].amount, '2');
});

test('coverage intervals merge (adjacent/overlapping collapse to one)', () => {
  const s = createActivityStore(tmpFile());
  s.recordCoverage('0xwallet', 100, 200, 't1');
  s.recordCoverage('0xwallet', 201, 300, 't2'); // adjacent
  s.recordCoverage('0xwallet', 150, 180, 't3'); // inside
  const { coverage } = s.activityFor('0xwallet');
  assert.deepStrictEqual(coverage, [[100, 300]]);
});

test('a gap between intervals stays two intervals (never fabricated as covered)', () => {
  const s = createActivityStore(tmpFile());
  s.recordCoverage('0xwallet', 100, 200, 't1');
  s.recordCoverage('0xwallet', 400, 500, 't2');
  assert.deepStrictEqual(s.activityFor('0xwallet').coverage, [[100, 200], [400, 500]]);
});

test('replay from disk reconstructs the same state, order-independent', () => {
  const file = tmpFile();
  const s1 = createActivityStore(file);
  s1.recordTransfers([tx('a', 10), tx('b', 30)]);
  s1.recordTransfers([tx('a', 12, { amount: 'new' })]);
  s1.recordCoverage('0xwallet', 100, 200, 't1');
  const s2 = createActivityStore(file); // fresh replay of the same file
  const { events, coverage } = s2.activityFor('0xwallet');
  // newest block first: b is at 30, a updated to 12.
  assert.deepStrictEqual(events.map((e) => e.id), ['b', 'a']);
  assert.strictEqual(events.find((e) => e.id === 'a').amount, 'new');
  assert.deepStrictEqual(coverage, [[100, 200]]);
});

test('a corrupt line does not break replay of the rest', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `${JSON.stringify(tx('a', 10))}\n{ not json\n${JSON.stringify(tx('b', 20))}\n`);
  const s = createActivityStore(file);
  assert.deepStrictEqual(s.activityFor('0xwallet').events.map((e) => e.id), ['b', 'a']);
  assert.strictEqual(s.storageStatus().malformedRows, 1, 'degraded replay is visible to operators');
});

test('duplicate transfers and covered intervals do not grow the durable log', () => {
  const file = tmpFile();
  const s = createActivityStore(file);
  const row = tx('same', 10);
  s.recordTransfers([row]);
  s.recordCoverage('0xwallet', 100, 200, 't1');
  const size = fs.statSync(file).size;
  assert.strictEqual(s.recordTransfers([row]).written, 0);
  assert.strictEqual(s.recordCoverage('0xwallet', 120, 180, 't2').written, 0);
  assert.strictEqual(fs.statSync(file).size, size);
});

test('runtime compaction preserves deduped transfers and coverage after restart', () => {
  const file = tmpFile();
  const options = { maxFileBytes: 128 * 1024, compactAtBytes: 1 };
  const s = createActivityStore(file, options);
  assert.strictEqual(s.recordTransfers([tx('a', 10), tx('b', 30)]).compacted, true);
  assert.strictEqual(s.recordTransfers([tx('a', 12, { amount: 'new' })]).compacted, false,
    'post-compaction growth watermark prevents rewrite-on-every-write');
  s.recordCoverage('0xwallet', 100, 200, 't1');
  s.recordCoverage('0xwallet', 201, 300, 't2');
  const expected = s.activityFor('0xwallet');
  assert.deepStrictEqual(createActivityStore(file, options).activityFor('0xwallet'), expected);
});

test('transaction capacity rejects a whole batch and retains prior durable state', () => {
  const file = tmpFile();
  const s = createActivityStore(file, { maxTransactions: 2, maxFileBytes: 128 * 1024 });
  s.recordTransfers([tx('a', 10), tx('b', 20)]);
  const bytes = fs.readFileSync(file);
  assert.throws(() => s.recordTransfers([tx('c', 30)]), /transaction limit/);
  assert.deepStrictEqual(s.activityFor('0xwallet').events.map((event) => event.id), ['b', 'a']);
  assert.deepStrictEqual(fs.readFileSync(file), bytes);
});

test('append failure restores activity memory and original file bytes', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `${JSON.stringify(tx('a', 10))}\n`);
  const bytes = fs.readFileSync(file);
  let failOnce = true;
  const failingFs = Object.create(fs);
  failingFs.fsyncSync = (fd) => {
    if (failOnce) { failOnce = false; throw new Error('fixture fsync failure'); }
    return fs.fsyncSync(fd);
  };
  const s = createActivityStore(file, {
    maxFileBytes: 128 * 1024, compactAtBytes: 120 * 1024, persistenceFs: failingFs,
  });
  assert.throws(() => s.recordTransfers([tx('b', 20)]), /Cannot append durable data/);
  assert.deepStrictEqual(s.activityFor('0xwallet').events.map((event) => event.id), ['a']);
  assert.deepStrictEqual(fs.readFileSync(file), bytes);
});

test('failed atomic replacement keeps the known-good bloated log', () => {
  const file = tmpFile();
  const duplicate = `${JSON.stringify(tx('a', 10, { pad: 'x'.repeat(180) }))}\n`;
  fs.writeFileSync(file, duplicate.repeat(30));
  const bytes = fs.readFileSync(file);
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { throw new Error('fixture rename failure'); };
  const s = createActivityStore(file, {
    maxFileBytes: 8 * 1024, compactAtBytes: 1024, persistenceFs: failingFs,
  });
  assert.throws(() => s.recordTransfers([tx('b', 20)]), /Cannot atomically replace/);
  assert.deepStrictEqual(fs.readFileSync(file), bytes, 'the destination was never truncated or replaced');
  assert.deepStrictEqual(s.activityFor('0xwallet').events.map((event) => event.id), ['a']);
});

test('hard byte ceiling rejects retained state before exposing it in memory', () => {
  const file = tmpFile();
  const s = createActivityStore(file, { maxFileBytes: 512, compactAtBytes: 1 });
  assert.throws(() => s.recordTransfers([tx('huge', 10, { pad: 'x'.repeat(700) })]), /Retained state cannot fit/);
  assert.deepStrictEqual(s.activityFor('0xwallet').events, []);
  assert.equal(fs.existsSync(file), false);
});

test('oversized boot logs fail instead of replaying a misleading prefix', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `${JSON.stringify(tx('a', 10))}\n`.repeat(20));
  assert.throws(() => createActivityStore(file, { maxFileBytes: 512 }), /refusing a partial replay/);
});

test('boot enforces row counts incrementally and refuses a replay ceiling below its own file ceiling', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `${JSON.stringify(tx('a', 10))}\n${JSON.stringify(tx('b', 20))}\n`);
  assert.throws(() => createActivityStore(file, { maxTransactions: 1, maxFileBytes: 128 * 1024 }),
    /transaction limit/);
  assert.throws(() => createActivityStore(file, { maxFileBytes: 128 * 1024, maxReplayBytes: 64 * 1024 }),
    /cannot be smaller/);
});

console.log(`${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
