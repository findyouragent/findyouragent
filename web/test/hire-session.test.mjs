import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHires, saveHire, updateHire, startHireOnce } from '../src/lib/hire-session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a second confirmation cannot start while wallet preparation is pending', async () => {
  const wallet = deferred();
  const funding = deferred();
  const lock = { current: false };
  let attempts = 0;
  let signedSteps = 0;
  const run = async () => {
    attempts += 1;
    await wallet.promise;
    signedSteps += 1;
    return funding.promise;
  };
  const first = startHireOnce(lock, run);
  assert.equal(lock.current, true);
  assert.equal(signedSteps, 0);
  assert.equal(startHireOnce(lock, run), null);
  wallet.resolve();
  await Promise.resolve();
  assert.equal(signedSteps, 1);
  assert.equal(startHireOnce(lock, run), null);
  funding.resolve({ jobId: '42', txHash: '0xfunded' });
  assert.deepEqual(await first, { jobId: '42', txHash: '0xfunded' });
  assert.equal(attempts, 1);
  assert.equal(lock.current, false);
});

test('a declined preparation releases the lock for a deliberate retry', async () => {
  const wallet = deferred();
  const lock = { current: false };
  const attempt = startHireOnce(lock, () => wallet.promise);
  wallet.reject(new Error('wallet declined'));
  await assert.rejects(attempt, /wallet declined/);
  assert.equal(lock.current, false);
  assert.equal(await startHireOnce(lock, async () => 'retry'), 'retry');
});

test('a synchronous preparation failure also releases the lock', () => {
  const lock = { current: false };
  assert.throws(() => startHireOnce(lock, () => { throw new Error('prepare failed'); }), /prepare failed/);
  assert.equal(lock.current, false);
});

test('storage write failure is nonfatal and does not mutate a funded receipt', () => {
  const receipt = Object.freeze({ jobId: '42', fundTx: '0xfunded', budgetWei: '1000000000000000000' });
  const unavailable = { getItem: () => '[]', setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(saveHire(receipt, unavailable), false);
  assert.deepEqual(receipt, { jobId: '42', fundTx: '0xfunded', budgetWei: '1000000000000000000' });
  assert.equal(updateHire('42', { settleTx: '0xsettled' }, unavailable), false);
});

test('storage access denial and malformed stored data are safe', () => {
  const denied = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
  assert.deepEqual(loadHires(denied), []);
  assert.equal(saveHire({ jobId: '42' }, denied), false);
  for (const raw of ['broken JSON', '{}', 'null', '42', '[null, false, "bad", []]']) {
    assert.deepEqual(loadHires({ getItem: () => raw }), []);
  }
});

test('successful persistence retains the latest 50 hires and appends settlement proof', () => {
  let value = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ jobId: String(i) })));
  const memory = { getItem: () => value, setItem: (key, next) => { assert.equal(key, 'fya-hires'); value = next; } };
  assert.equal(saveHire({ jobId: 'new', fundTx: '0xfund' }, memory), true);
  assert.equal(loadHires(memory).length, 50);
  assert.equal(loadHires(memory)[0].jobId, 'new');
  assert.equal(updateHire('new', { settleTx: '0xsettle' }, memory), true);
  assert.deepEqual(loadHires(memory)[0], { jobId: 'new', fundTx: '0xfund', settleTx: '0xsettle' });
});
