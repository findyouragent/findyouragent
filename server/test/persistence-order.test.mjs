import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistVerdict } from '../src/verify/run.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

test('a failed verdict persistence write never seeds the success cache', () => {
  let cached = false;
  const failure = Object.assign(new Error('disk budget exhausted'), { code: 'PERSISTENCE_CAPACITY' });
  assert.throws(() => persistVerdict(
    { record() { throw failure; } },
    { set() { cached = true; } },
    '56:1',
    { computedAt: '2026-09-08T00:00:00Z' },
  ), (error) => error === failure);
  assert.equal(cached, false);
});

test('the cache is populated only after the durable store accepts a verdict', () => {
  const order = [];
  persistVerdict(
    { record() { order.push('persist'); } },
    { set() { order.push('cache'); } },
    '56:1',
    { computedAt: '2026-09-08T00:00:00Z' },
  );
  assert.deepEqual(order, ['persist', 'cache']);
});

test('a close error after fsync does not roll durable state back in memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-close-'));
  const file = path.join(root, 'verdicts.jsonl');
  let failOnce = true;
  const closingFs = Object.create(fs);
  closingFs.closeSync = (fd) => {
    fs.closeSync(fd);
    if (failOnce) { failOnce = false; throw new Error('fixture postcommit close failure'); }
  };
  const store = createStore(file, {
    seedFile: null, maxFileBytes: 128 * 1024, compactAtBytes: 120 * 1024, persistenceFs: closingFs,
  });
  const verdict = {
    computedAt: '2026-09-08T00:00:00.000Z', tier: 'active', formulaVersion: 'test',
    endpointProven: true, evidence: { endpoint: { reachable: true, declared: true } },
  };
  assert.doesNotThrow(() => store.record('56:1', verdict));
  assert.equal(store.lastCheck('56:1').ts, verdict.computedAt);
  assert.match(store.storageStatus().lastCleanupError, /postcommit close failure/);
  assert.equal(createStore(file, { seedFile: null }).lastCheck('56:1').ts, verdict.computedAt);
  fs.rmSync(root, { recursive: true, force: true });
});
