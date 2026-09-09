import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStore, isCheckDue, RECHECK_AFTER_MS } from '../src/store.js';
import { createSweeper } from '../src/sweep.js';
import { FORMULA_VERSION } from '../src/verify/score.js';

const START = Date.UTC(2026, 8, 8, 12);
const DAY = RECHECK_AFTER_MS;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-sweep-'));
let sequence = 0;
// The exit hook runs after append callbacks finish; no production store is used.
process.once('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const row = (tokenId, age = 2 * DAY, over = {}) => ({
  key: `56:${tokenId}`, ts: new Date(START - age).toISOString(),
  formulaVersion: FORMULA_VERSION, tier: 'registered', ...over,
});
const discovery = (tokenId, protocol = 'MCP') => ({ chain_id: 56, token_id: String(tokenId), supported_protocols: [protocol] });

function fixture(rows = [], options = {}) {
  const { verify: verifyImpl, ...sweepOptions } = options;
  let clock = START;
  const file = path.join(fixtureRoot, `${sequence++}.jsonl`);
  fs.writeFileSync(file, rows.map((value) => JSON.stringify(value)).join('\n') + '\n');
  const store = createStore(file, { seedFile: null });
  const calls = [];
  const record = (chainId, tokenId) => store.record(`${chainId}:${tokenId}`, {
    computedAt: new Date(clock).toISOString(), formulaVersion: FORMULA_VERSION, tier: 'registered',
  });
  const verifier = async (chainId, tokenId) => {
    calls.push(`${chainId}:${tokenId}`);
    if (verifyImpl) await verifyImpl(chainId, tokenId, calls);
    record(chainId, tokenId);
    return { cached: false };
  };
  const sweeper = createSweeper({
    verifier, store, intervalMs: 10, recheckRefreshMs: 100, retryBaseMs: 20,
    now: () => clock, random: () => 0, fetchAgents: async () => [], rateLimited: () => false, log: () => {},
    ...sweepOptions,
  });
  return { store, calls, sweeper, record, advance: (ms) => { clock += ms; }, tick: () => sweeper.tick() };
}

test('freshness expires at 24 hours and obsolete or undated checks are immediately due', () => {
  assert.equal(isCheckDue(row(1, DAY - 1), { now: START }), false);
  assert.equal(isCheckDue(row(1, DAY), { now: START }), true);
  assert.equal(isCheckDue(row(1, 0, { formulaVersion: 'obsolete' }), { now: START }), true);
  assert.equal(isCheckDue(row(1, 0, { ts: 'invalid' }), { now: START }), true);
});

test('store returns oldest due keys with bounded results and complete backlog totals', () => {
  const f = fixture([row(1, DAY * 3), row(2, DAY * 2), row(3, 0, { formulaVersion: 'obsolete' }), row(4, 0)]);
  assert.deepEqual(f.store.dueRechecks({ now: START, limit: 1, exclude: new Set(['56:1']) }), {
    keys: ['56:2'], due: 3, oldestCheckedAt: new Date(START - DAY * 3).toISOString(),
  });
  assert.deepEqual(f.store.dueRechecks({ now: START, limit: 0 }).keys, []);
  assert.equal(f.store.dueRechecks({ now: START + DAY }).due, 4);
});

test('known agents outside discovery pages and obsolete formulas are rechecked', async () => {
  const pages = [];
  const f = fixture([row(900000), row(900001, 0, { formulaVersion: 'obsolete' }), row(900002, 0)], {
    fetchAgents: async ({ page }) => { pages.push(page); return []; },
  });
  await f.tick();
  f.advance(10);
  await f.tick();
  await flush();
  assert.deepEqual(f.calls, ['56:900000', '56:900001']);
  assert.deepEqual(pages, [1]);
  assert.equal(f.store.lastCheck('56:900001').formulaVersion, FORMULA_VERSION);
});

test('a check that ages while the process runs enters the next refresh', async () => {
  const f = fixture([row(1, DAY - 1000)]);
  await f.tick();
  assert.equal(f.calls.length, 0);
  f.advance(1000);
  await f.tick();
  assert.deepEqual(f.calls, ['56:1']);
});

test('recheck batches and store scans remain bounded between refreshes', async () => {
  const f = fixture(Array.from({ length: 6 }, (_, i) => row(i + 1)), { recheckBatchSize: 2 });
  const original = f.store.dueRechecks;
  let scans = 0;
  f.store.dueRechecks = (...args) => { scans += 1; return original(...args); };
  await f.tick();
  assert.equal(f.sweeper.stats().recheckQueued, 1);
  assert.equal(f.sweeper.stats().recheckDue, 6);
  f.advance(10); await f.tick();
  f.advance(10); await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(scans, 1);
  f.advance(80); await f.tick();
  assert.equal(f.calls.length, 3);
  assert.equal(scans, 2);
});

test('discovery and concurrent ticks cannot duplicate queued or active rechecks', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = fixture([row(1)], {
    verify: async (_chainId, tokenId) => { if (tokenId === '1') await gate; },
    fetchAgents: async () => [discovery(1), discovery(1), discovery(2), discovery(2)],
  });
  const first = f.tick();
  await flush();
  await Promise.all([f.tick(), f.tick()]);
  assert.deepEqual(f.calls, ['56:1']);
  f.advance(10);
  await Promise.all([f.tick(), f.tick()]);
  assert.deepEqual(f.calls, ['56:1', '56:2']);
  finish();
  await first;
  assert.equal(f.sweeper.stats().activeChecks, 0);
  assert.equal(f.sweeper.stats().queued, 0);
});

test('interactive refreshes remove queued work without another verification', async () => {
  const f = fixture([row(1), row(2)]);
  await f.tick();
  f.record(56, '2');
  f.advance(10);
  await f.tick();
  assert.deepEqual(f.calls, ['56:1']);
  assert.equal(f.sweeper.stats().queued, 0);
});

test('transient failures retry after a delay without being duplicated by discovery', async () => {
  const f = fixture([row(1)], {
    fetchAgents: async () => [discovery(1)],
    verify: async (_chainId, _tokenId, calls) => { if (calls.length === 1) throw new Error('transient'); },
  });
  await f.tick(); await flush();
  assert.equal(f.sweeper.stats().retrying, 1);
  f.advance(10); await f.tick();
  assert.equal(f.calls.length, 1);
  f.advance(10); await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.sweeper.stats().retrying, 0);
  assert.equal(f.sweeper.stats().errored, 1);
  assert.equal(f.sweeper.stats().swept, 1);
});

test('retry delays honor Retry-After and exponential backoff has a ceiling', async () => {
  const f = fixture([row(1)], {
    retryMaxMs: 40,
    verify: async (_chainId, _tokenId, calls) => {
      if (calls.length === 1) throw Object.assign(new Error('busy'), { retryAfterSeconds: 0.1 });
      if (calls.length <= 3) throw new Error('transient');
    },
  });
  await f.tick();
  f.advance(99); await f.tick(); assert.equal(f.calls.length, 1);
  f.advance(1); await f.tick(); assert.equal(f.calls.length, 2);
  f.advance(39); await f.tick(); assert.equal(f.calls.length, 2);
  f.advance(1); await f.tick(); assert.equal(f.calls.length, 3);
  f.advance(40); await f.tick(); assert.equal(f.calls.length, 4);
  assert.equal(f.sweeper.stats().retrying, 0);
});

test('large recheck backlogs, failed retries, and callable discovery leave each other time', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => row(i + 1)), {
    baselineSample: 1,
    verify: async (_chainId, tokenId) => { if (tokenId === '1') throw new Error('offline'); },
    fetchAgents: async () => [...Array.from({ length: 10 }, (_, i) => discovery(1000 + i)), discovery(2000, 'Web')],
  });
  for (let i = 0; i < 16; i += 1) { await f.tick(); await flush(); f.advance(10); }
  assert.ok(f.calls.filter((key) => key === '56:1').length >= 2, 'failed checks get retries');
  assert.ok(f.calls.includes('56:10'), 'oldest-first rechecks keep progressing');
  assert.ok(f.calls.includes('56:1000'), 'discovery keeps progressing');
  assert.ok(f.calls.includes('56:2000'), 'baseline discovery keeps progressing');
});

test('shared rate limits pause discovery and checks, while backlog remains observable', async () => {
  let limited = true;
  let pages = 0;
  const f = fixture([row(1)], {
    rateLimited: () => limited,
    fetchAgents: async () => { pages += 1; return []; },
  });
  await f.tick(); await flush();
  assert.equal(pages, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sweeper.stats().recheckDue, 1);
  limited = false;
  await f.tick(); await flush();
  assert.equal(pages, 1);
  assert.equal(f.calls.length, 1);
});

test('page failures are counted separately and advance the discovery cursor', async () => {
  const pages = [];
  const f = fixture([row(1)], {
    fetchAgents: async ({ page }) => { pages.push(page); if (page === 1) throw new Error('registry unavailable'); return []; },
  });
  await f.tick(); await flush();
  assert.equal(f.sweeper.stats().pageErrors, 1);
  assert.equal(f.sweeper.stats().errored, 0);
  assert.equal(f.sweeper.stats().swept, 1);
  f.advance(5000); await f.tick(); await flush();
  assert.deepEqual(pages, [1, 2]);
});

test('slow checks respect the worker concurrency limit', async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = fixture([row(1), row(2)], {
    maxConcurrent: 1,
    verify: async (_chainId, tokenId) => { if (tokenId === '1') await gate; },
  });
  const first = f.tick();
  f.advance(10); await f.tick();
  assert.deepEqual(f.calls, ['56:1']);
  finish(); await first;
  await f.tick();
  assert.deepEqual(f.calls, ['56:1', '56:2']);
});

test('definitive registry 400/404 errors cool down without a verdict or discovery duplicates', async () => {
  for (const status of [400, 404]) {
    const original = row(1);
    const f = fixture([original, row(2)], {
      terminalCooldownMs: 1000,
      fetchAgents: async () => [discovery(1)],
      verify: async (_chainId, tokenId) => {
        if (tokenId === '1') throw Object.assign(new Error('registry rejected identity'), { source: '8004scan', status });
      },
    });
    await f.tick(); await flush();
    assert.equal(f.sweeper.stats().retrying, 0);
    assert.equal(f.sweeper.stats().coolingDown, 1);
    assert.equal(f.sweeper.stats().terminalErrors, 1);
    f.advance(10); await f.tick();
    assert.deepEqual(f.calls, ['56:1', '56:2']);
    f.advance(90); await f.tick();
    assert.equal(f.calls.length, 2, 'refresh must not immediately requeue a cooled-down key');
    f.advance(899); await f.tick();
    assert.equal(f.calls.length, 2);
    f.advance(101); await f.tick();
    assert.deepEqual(f.calls, ['56:1', '56:2', '56:1']);
    assert.deepEqual(f.store.lastCheck('56:1'), original, 'absence never becomes a synthetic verdict');
    assert.equal(f.sweeper.stats().retrying, 0);
  }
});

test('ambiguous, credential, and throttling failures retain transient retries', async () => {
  const errors = [
    { status: 400 }, { status: 404 }, { source: 'endpoint', status: 404 },
    { source: '8004scan', status: 401 }, { source: '8004scan', status: 403 },
    { source: '8004scan', status: 429 }, { source: '8004scan', status: 503 },
    { source: '8004scan', status: 400, malformed: true },
    { source: '8004scan', code: 'registry-invalid-response', malformed: true },
  ];
  for (const fields of errors) {
    const f = fixture([row(1)], { verify: async () => { throw Object.assign(new Error('unavailable'), fields); } });
    await f.tick();
    assert.equal(f.sweeper.stats().retrying, 1, JSON.stringify(fields));
    assert.equal(f.sweeper.stats().coolingDown, 0);
    assert.equal(f.sweeper.stats().terminalErrors, 0);
    f.advance(20); await f.tick();
    assert.equal(f.calls.length, 2);
  }
});

test('a broad outage bounds retry jobs while deferred stored checks remain eligible later', async () => {
  let unavailable = true;
  const f = fixture([row(1), row(2), row(3)], {
    maxRetryEntries: 1,
    verify: async () => { if (unavailable) throw new Error('network unavailable'); },
  });
  await f.tick();
  f.advance(10); await f.tick();
  f.advance(10); await f.tick();
  assert.equal(f.sweeper.stats().retrying, 1);
  assert.equal(f.sweeper.stats().coolingDown, 2);
  assert.equal(f.sweeper.stats().deferredRetries, 2);
  unavailable = false;
  f.advance(80); await f.tick();
  f.advance(10); await f.tick();
  f.advance(10); await f.tick();
  assert.equal(f.sweeper.stats().retrying, 0);
  assert.equal(f.sweeper.stats().coolingDown, 0);
  assert.equal(f.sweeper.stats().swept, 3);
});
