import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadSession } from '../src/api/read-session.js';

test('shares an in-flight read and fans out only future events', async () => {
  let calls = 0;
  let emit;
  const session = createReadSession();
  const first = session.getOrStart('56:1', (send) => new Promise((resolve) => {
    emit = send;
    calls += 1;
    setTimeout(() => resolve({ checkedAt: '2026-09-08T00:00:00Z' }), 5);
  }));
  const before = [];
  first.subscribe((event) => before.push(event));
  await Promise.resolve();
  emit({ step: 'probe' });
  const second = session.getOrStart('56:1', () => { throw new Error('duplicate'); });
  const after = [];
  second.subscribe((event) => after.push(event));
  emit({ step: 'verdict' });
  assert.deepEqual(before, [{ step: 'probe' }, { step: 'verdict' }]);
  assert.deepEqual(after, [{ step: 'verdict' }]);
  assert.equal(await first.promise, await second.promise);
  assert.equal(calls, 1);
});

test('reuses successful values briefly, then expires them and enforces a cache bound', async () => {
  let clock = 0;
  let calls = 0;
  const session = createReadSession({ now: () => clock, ttlMs: 30, maxEntries: 2 });
  const read = (key) => session.getOrStart(key, async () => ({ key, n: ++calls })).promise;
  assert.deepEqual(await read('a'), { key: 'a', n: 1 });
  assert.deepEqual(await read('a'), { key: 'a', n: 1 });
  clock = 31;
  assert.deepEqual(await read('a'), { key: 'a', n: 2 });
  await read('b'); await read('c');
  assert.ok(session.size() <= 2);
});

test('does not cache failures or null values, allowing recovery', async () => {
  let failures = 0;
  const session = createReadSession();
  const fail = () => session.getOrStart('fail', async () => {
    failures += 1;
    throw new Error('temporary');
  }).promise;
  await assert.rejects(fail(), /temporary/);
  await assert.rejects(fail(), /temporary/);
  assert.equal(failures, 2);
  let nulls = 0;
  const nullable = () => session.getOrStart('null', async () => { nulls += 1; return null; }).promise;
  assert.equal(await nullable(), null);
  assert.equal(await nullable(), null);
  assert.equal(nulls, 2);
});

test('keeps identities isolated and marks cached values without changing timestamps', async () => {
  const session = createReadSession();
  const value = { agentId: '56:1', checkedAt: '2026-09-08T01:02:03Z' };
  assert.deepEqual(await session.getOrStart('56:1', () => value).promise, value);
  assert.deepEqual(await session.getOrStart('56:1', () => ({ agentId: 'wrong' }), {
    mapCached: (cached) => ({ ...cached, cached: true }),
  }).promise, { ...value, cached: true });
  assert.deepEqual(await session.getOrStart('56:2', () => ({ agentId: '56:2' })).promise, { agentId: '56:2' });
});

test('a listener throwing cannot stop other listeners or the read', async () => {
  const session = createReadSession();
  const operation = session.getOrStart('safe', (emit) => {
    emit({ step: 'probe' });
    return { ok: true };
  });
  const received = [];
  operation.subscribe(() => { throw new Error('render failed'); });
  operation.subscribe((event) => received.push(event));
  assert.deepEqual(await operation.promise, { ok: true });
  assert.deepEqual(received, [{ step: 'probe' }]);
});

test('invalidating a pending read prevents its late result from being cached', async () => {
  let resolveOld;
  let calls = 0;
  const session = createReadSession();
  const old = session.getOrStart('meta', () => new Promise((resolve) => {
    calls += 1;
    resolveOld = resolve;
  })).promise;
  await Promise.resolve();
  session.invalidate('meta');
  assert.deepEqual(await session.getOrStart('meta', () => ({ value: 'new' })).promise, { value: 'new' });
  resolveOld({ value: 'old' });
  assert.deepEqual(await old, { value: 'old' });
  assert.deepEqual(await session.getOrStart('meta', () => ({ value: 'unexpected' })).promise, { value: 'new' });
  assert.equal(calls, 1);
});
