import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RANK, rankCheck, DAY_CHAR, createStore } from '../src/store.js';

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

// A calendar square is drawn once and never re-checked, so the meaning of an
// old square must not move when the scoring formula changes. These tests pin
// the mapping to the RAW probe facts. If a change to score.js breaks one of
// them, the change was about to rewrite history that is already published.

test('a server that answered and proved the endpoint is ANSWERED', () => {
  assert.strictEqual(
    rankCheck({ probe: { declared: true, spoke: true }, endpointProven: true }),
    RANK.ANSWERED,
  );
});

test('a server that spoke but proved nothing is the agent\'s own failure', () => {
  assert.strictEqual(
    rankCheck({ probe: { declared: true, spoke: true }, endpointProven: false }),
    RANK.ANSWERED_NOTHING,
  );
});

// The one that matters most. A timeout cannot be told apart from our own
// network from a single vantage point, so it may never rank as their failure.
test('silence from a declared endpoint is unknown, not failure', () => {
  const rank = rankCheck({ probe: { declared: true, spoke: false }, endpointProven: false });
  assert.strictEqual(rank, RANK.NO_ROUND_TRIP);
  assert.notStrictEqual(rank, RANK.ANSWERED_NOTHING);
});

test('declaring nothing is its own state, not a failure', () => {
  assert.strictEqual(
    rankCheck({ probe: { declared: false, spoke: false }, endpointProven: false }),
    RANK.NOT_DECLARED,
  );
});

// Compatibility invariant: rows without probe facts collapse to unknown rather
// than being recast as failures.
test('a legacy row without probe facts never ranks as failure', () => {
  assert.strictEqual(rankCheck({ endpointProven: true }), RANK.ANSWERED);
  assert.strictEqual(rankCheck({ endpointProven: false }), RANK.NO_ROUND_TRIP);
  assert.strictEqual(rankCheck({}), RANK.NO_ROUND_TRIP);
  assert.strictEqual(rankCheck(null), RANK.NO_ROUND_TRIP);
});

test('exactly one rank is rendered as a failure character', () => {
  const chars = Object.values(DAY_CHAR);
  assert.strictEqual(new Set(chars).size, chars.length, 'each rank needs its own character');
  assert.strictEqual(DAY_CHAR[RANK.ANSWERED_NOTHING], 'x');
  // The renderer colours only 'x' red. If another rank ever maps to it, three
  // states collapse into one accusation.
  assert.strictEqual(chars.filter((c) => c === 'x').length, 1);
});

// best-of-day, and the counts are sums, so replaying the log in any order lands
// in the same place. Boot replays every row from disk, so this is what makes
// the calendar stable across restarts.
test('ranks order so that best-of-day favours evidence over absence', () => {
  assert.ok(RANK.ANSWERED > RANK.ANSWERED_NOTHING);
  assert.ok(RANK.ANSWERED_NOTHING > RANK.NO_ROUND_TRIP);
  assert.ok(RANK.NO_ROUND_TRIP > RANK.NOT_DECLARED);
});

function tempVerdicts() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fya-verdict-retention-')), 'verdicts.jsonl');
}

function verdict(computedAt, over = {}) {
  return {
    computedAt, tier: 'active', formulaVersion: 'test', endpointProven: true,
    evidence: { endpoint: { reachable: true, declared: true, latencyMs: 12 } },
    proofs: [], categories: [], ...over,
  };
}

test('runtime compaction preserves total checks, latest, 50-history and 90-day uptime after restart', () => {
  const file = tempVerdicts();
  const options = { seedFile: null, maxFileBytes: 256 * 1024, compactAtBytes: 1 };
  const store = createStore(file, options);
  let compactions = 0;
  for (let day = 0; day < 120; day += 1) {
    const result = store.record('56:1', verdict(new Date(Date.UTC(2026, 0, day + 1)).toISOString()));
    compactions += Number(result.compacted);
  }
  assert.ok(compactions >= 1);
  const before = {
    summary: store.summary(), history: store.historyFor('56:1', 100), uptime: store.uptimeFor('56:1'),
    latest: store.latestFor(['56:1']),
  };
  const restarted = createStore(file, options);
  assert.deepStrictEqual(restarted.summary(), before.summary);
  assert.deepStrictEqual(restarted.historyFor('56:1', 100), before.history);
  assert.deepStrictEqual(restarted.uptimeFor('56:1'), before.uptime);
  assert.deepStrictEqual(restarted.latestFor(['56:1']), before.latest);
  assert.strictEqual(before.summary.checksRun, 120);
  assert.strictEqual(before.history.length, 50);
  assert.strictEqual(before.uptime.days.length, 90);
});

test('seed overlap is excluded from live checkpoints and remains idempotent on restart', () => {
  const file = tempVerdicts();
  const seedFile = `${file}.seed`;
  const a = { key: '56:1', ts: '2026-09-01T00:00:00.000Z', tier: 'active', formulaVersion: 'test', endpointProven: true };
  const b = { ...a, key: '56:2', ts: '2026-09-02T00:00:00.000Z' };
  fs.writeFileSync(seedFile, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
  fs.writeFileSync(file, `${JSON.stringify(a)}\n${JSON.stringify({ ...a, ts: '2026-09-03T00:00:00.000Z' })}\n`);
  const options = { seedFile, compactAtBytes: 1, maxFileBytes: 128 * 1024 };
  const store = createStore(file, options);
  store.record('56:1', verdict('2026-09-04T00:00:00.000Z'));
  assert.strictEqual(store.summary().checksRun, 4);
  const restarted = createStore(file, options);
  assert.strictEqual(restarted.summary().checksRun, 4);
  assert.strictEqual(restarted.historyFor('56:1', 100).length, 3);
});

test('failed durable append rolls memory and file length back', () => {
  const file = tempVerdicts();
  const old = { key: '56:1', ts: '2026-09-01T00:00:00.000Z', tier: 'active', formulaVersion: 'test' };
  fs.writeFileSync(file, `${JSON.stringify(old)}\n`);
  const bytes = fs.readFileSync(file);
  let failOnce = true;
  const failingFs = Object.create(fs);
  failingFs.fsyncSync = (fd) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' }); }
    return fs.fsyncSync(fd);
  };
  const store = createStore(file, {
    seedFile: null, maxFileBytes: 128 * 1024, compactAtBytes: 120 * 1024, persistenceFs: failingFs,
  });
  assert.throws(() => store.record('56:1', verdict('2026-09-02T00:00:00.000Z')), /Cannot append durable data/);
  assert.strictEqual(store.lastCheck('56:1').ts, old.ts);
  assert.deepStrictEqual(fs.readFileSync(file), bytes);
});

test('large retained checkpoints advance the watermark instead of compacting every write', () => {
  const file = tempVerdicts();
  const store = createStore(file, { seedFile: null, compactAtBytes: 1, maxFileBytes: 128 * 1024 });
  assert.strictEqual(store.record('56:1', verdict('2026-09-01T00:00:00.000Z')).compacted, true);
  assert.strictEqual(store.record('56:1', verdict('2026-09-02T00:00:00.000Z')).compacted, false);
  assert.ok(store.storageStatus().nextCompactAt > store.storageStatus().fileBytes);
});

test('new verdict identities backpressure without evicting known agents', () => {
  const file = tempVerdicts();
  const store = createStore(file, { seedFile: null, maxAgents: 1, maxFileBytes: 128 * 1024 });
  store.record('56:1', verdict('2026-09-01T00:00:00.000Z'));
  assert.throws(() => store.record('56:2', verdict('2026-09-02T00:00:00.000Z')), /identity limit/);
  assert.strictEqual(store.summary().uniqueChecked, 1);
  assert.ok(store.lastCheck('56:1'));
});

test('cached search corpus metrics follow latest evidence, not out-of-order history', () => {
  const file = tempVerdicts();
  const store = createStore(file, { seedFile: null, maxFileBytes: 128 * 1024 });
  store.record('56:1', verdict('2026-09-02T00:00:00.000Z', { servedNames: ['one', 'three'] }));
  assert.deepStrictEqual(store.searchCorpusStats(), {
    records: 1, agents: 1, servedNames: 2, servedNameCharacters: 8,
  });
  store.record('56:1', verdict('2026-09-01T00:00:00.000Z', { servedNames: Array(20).fill('older') }));
  assert.deepStrictEqual(store.searchCorpusStats(), {
    records: 1, agents: 1, servedNames: 2, servedNameCharacters: 8,
  });
  assert.deepStrictEqual(createStore(file, { seedFile: null, maxFileBytes: 128 * 1024 }).searchCorpusStats(),
    store.searchCorpusStats());
});

test('a refreshed seed containing checkpoint latest does not duplicate totals or uptime', () => {
  const file = tempVerdicts();
  const options = { seedFile: null, compactAtBytes: 1, maxFileBytes: 128 * 1024 };
  const first = createStore(file, options);
  first.record('56:1', verdict('2026-09-01T00:00:00.000Z'));
  const latest = first.lastCheck('56:1');
  const expected = { summary: first.summary(), uptime: first.uptimeFor('56:1'), history: first.historyFor('56:1') };
  const seedFile = `${file}.refreshed-seed`;
  fs.writeFileSync(seedFile, `${JSON.stringify(latest)}\n`);
  const restarted = createStore(file, { ...options, seedFile });
  assert.deepStrictEqual(restarted.summary(), expected.summary);
  assert.deepStrictEqual(restarted.uptimeFor('56:1'), expected.uptime);
  assert.deepStrictEqual(restarted.historyFor('56:1'), expected.history);
});

test('invalid timestamps stay in history but never outrank valid latest or enter uptime', () => {
  const file = tempVerdicts();
  const store = createStore(file, { seedFile: null, maxFileBytes: 128 * 1024 });
  store.record('56:1', verdict('2026-09-02T00:00:00.000Z', { name: 'valid' }));
  store.record('56:1', verdict('9999-99-99T00:00:00Z', { name: 'unknown' }));
  assert.equal(store.lastCheck('56:1').name, 'valid');
  assert.equal(store.historyFor('56:1').length, 2);
  assert.deepStrictEqual(store.uptimeFor('56:1').days.map((day) => day.d), ['2026-09-02']);
});

test('replay identity and self-replay configuration limits fail before partial state is returned', () => {
  const file = tempVerdicts();
  const rows = [
    { key: '56:1', ts: '2026-09-01T00:00:00Z' },
    { key: '56:2', ts: '2026-09-02T00:00:00Z' },
  ];
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join('\n')}\n`);
  assert.throws(() => createStore(file, { seedFile: null, maxAgents: 1, maxFileBytes: 128 * 1024 }),
    /replay exceeds/);
  assert.throws(() => createStore(file, {
    seedFile: null, maxFileBytes: 128 * 1024, maxReplayBytes: 64 * 1024,
  }), /cannot be smaller/);
});

console.log(`${passed} passed, ${process.exitCode ? 'some' : 0} failed`);
