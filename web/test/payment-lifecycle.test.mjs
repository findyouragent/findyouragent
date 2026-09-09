import assert from 'node:assert/strict';
import test from 'node:test';
import {
  newPaymentChallengeId,
  paymentChallengeState,
  paymentHistoryUpdater,
  paymentResponseOutcome,
  runPaymentAttempt,
} from '../src/lib/payment-lifecycle.js';
import { recallTryHistory, rememberTryHistory } from '../src/lib/try-session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function source(agentKey, challengeId) {
  rememberTryHistory(agentKey, [{
    question: 'fixture task', kind: 'payment', paymentChallengeId: challengeId,
    options: [{ scheme: 'exact' }],
  }]);
}

test('a second click cannot open another signer while the first wallet prompt is in flight', async () => {
  const agentKey = 'lifecycle:double-click';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const wallet = deferred();
  let signerCalls = 0;
  let submitCalls = 0;
  const first = runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { signerCalls += 1; const payment = await wallet.promise; markSigned(); return payment; },
    submit: async () => { submitCalls += 1; return { status: 200 }; },
  });
  assert.equal(paymentChallengeState(challengeId).state, 'prompting');
  const second = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async () => { signerCalls += 1; return 'must-not-sign'; },
    submit: async () => { submitCalls += 1; },
  });
  assert.equal(second.kind, 'blocked');
  assert.equal(signerCalls, 1);
  wallet.resolve('fake-payment-header');
  assert.equal((await first).kind, 'response');
  assert.equal(submitCalls, 1);
});

test('wallet cancellation and other pre-sign errors release the challenge for an explicit retry', async () => {
  const agentKey = 'lifecycle:cancel';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const cancelled = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async () => { const error = new Error('user rejected'); error.code = 4001; throw error; },
    submit: async () => assert.fail('cancelled authorization must not be submitted'),
  });
  assert.equal(cancelled.kind, 'sign-error');
  assert.equal(paymentChallengeState(challengeId).state, 'available');
  assert.equal(recallTryHistory(agentKey)[0].paymentChallenge, undefined);

  const retried = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); return 'fake-payment-header'; },
    submit: async () => ({ status: 200 }),
  });
  assert.equal(retried.kind, 'response');
});

test('delayed prompting React state cannot resurrect a lock after cancellation and remount', async () => {
  const agentKey = 'lifecycle:cancel-queued-react';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const queued = [];
  const isCurrent = () => true;
  const cancelled = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async () => { throw new Error('wallet cancelled before signature'); },
    submit: async () => assert.fail('cancelled authorization must not be submitted'),
    onStateChange: (state) => queued.push(paymentHistoryUpdater(agentKey, challengeId, state, isCurrent)),
  });
  assert.equal(cancelled.kind, 'sign-error');
  assert.equal(queued.length, 2);
  assert.equal(paymentChallengeState(challengeId).state, 'available');

  // React applies both callbacks after release. The first used to restore a
  // prompting ledger entry, while the available snapshot could not clear it.
  let reactState = recallTryHistory(agentKey);
  reactState = queued[0](reactState);
  assert.equal(paymentChallengeState(challengeId).state, 'available');
  assert.equal(recallTryHistory(agentKey)[0].paymentChallenge, undefined);
  reactState = queued[1](reactState);
  assert.equal(paymentChallengeState(challengeId).state, 'available');
  assert.equal(reactState[0].paymentChallenge, undefined);
  assert.equal(recallTryHistory(agentKey)[0].paymentChallenge, undefined);
});

test('a queued updater after an agent switch cannot write new-agent state into old-agent history', async () => {
  const agentKey = 'lifecycle:old-agent';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const wallet = deferred();
  const queued = [];
  let current = true;
  const attempt = runPaymentAttempt({
    agentKey, challengeId,
    sign: async () => wallet.promise,
    submit: async () => assert.fail('cancelled authorization must not be submitted'),
    onStateChange: (state) => {
      if (current) queued.push(paymentHistoryUpdater(agentKey, challengeId, state, () => current));
    },
  });
  assert.equal(queued.length, 1);
  current = false;
  wallet.reject(new Error('wallet cancelled after navigation'));
  assert.equal((await attempt).kind, 'sign-error');

  const newAgentState = [{ question: 'different agent', paymentChallengeId: 'different-id' }];
  assert.equal(queued[0](newAgentState), newAgentState);
  assert.deepEqual(recallTryHistory(agentKey), [{
    question: 'fixture task', kind: 'payment', paymentChallengeId: challengeId,
    options: [{ scheme: 'exact' }],
  }]);
  assert.equal(paymentChallengeState(challengeId).state, 'available');
});

test('an error after the wallet has produced a signature cannot reopen the challenge', async () => {
  const agentKey = 'lifecycle:post-sign-error';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const attempt = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); throw new Error('encoding failed after signing'); },
    submit: async () => assert.fail('an unencoded payment cannot be submitted'),
  });
  assert.equal(attempt.kind, 'post-sign-error');
  assert.deepEqual(paymentChallengeState(challengeId), { state: 'consumed', outcome: 'signed-not-submitted' });
  assert.equal((await runPaymentAttempt({ agentKey, challengeId, sign: async () => 'again', submit: async () => ({}) })).kind, 'blocked');
});

test('response loss after submission leaves an explicit unknown outcome and never signs again', async () => {
  const agentKey = 'lifecycle:response-loss';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const attempt = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); return 'fake-payment-header'; },
    submit: async () => { throw new TypeError('connection lost'); },
  });
  assert.equal(attempt.kind, 'submit-error');
  assert.deepEqual(paymentChallengeState(challengeId), { state: 'consumed', outcome: 'submitted-unknown' });
  const stored = JSON.stringify(recallTryHistory(agentKey));
  assert.doesNotMatch(stored, /fake-payment-header|signature|authorization/i);
});

test('a returned incomplete relay result also preserves the unknown payment outcome', async () => {
  const agentKey = 'lifecycle:incomplete-result';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const attempt = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); return 'fake-payment-header'; },
    submit: async () => ({ error: 'relay-timeout', observation: { outcome: 'unknown', captureComplete: false } }),
    responseOutcome: paymentResponseOutcome,
  });
  assert.equal(attempt.kind, 'response');
  assert.deepEqual(paymentChallengeState(challengeId), { state: 'consumed', outcome: 'submitted-unknown' });
});

test('a complete response consumes the challenge without treating it as settlement proof', async () => {
  const agentKey = 'lifecycle:success';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const attempt = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); return 'fake-payment-header'; },
    submit: async () => ({ status: 200, body: { result: { message: 'done' } } }),
  });
  assert.equal(attempt.kind, 'response');
  assert.deepEqual(paymentChallengeState(challengeId), { state: 'consumed', outcome: 'response-received' });
  assert.equal(recallTryHistory(agentKey)[0].paymentChallenge.outcome, 'response-received');
});

test('navigation after signing retires the original session challenge before suppressing submission', async () => {
  const agentKey = 'lifecycle:navigate';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  let current = true;
  let submitCalls = 0;
  const attempt = await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { current = false; markSigned(); return 'fake-payment-header'; },
    submit: async () => { submitCalls += 1; },
    isCurrent: () => current,
  });
  assert.equal(attempt.kind, 'retired');
  assert.equal(submitCalls, 0);
  assert.deepEqual(recallTryHistory(agentKey)[0].paymentChallenge, { state: 'consumed', outcome: 'signed-not-submitted' });
  assert.equal(paymentChallengeState(challengeId).state, 'consumed');
});

test('a stale component completion cannot reopen or overwrite the original challenge', async () => {
  const agentKey = 'lifecycle:stale-completion';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  const provider = deferred();
  const submitted = deferred();
  let current = true;
  const attemptPromise = runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); return 'fake-payment-header'; },
    submit: async () => { submitted.resolve(); return provider.promise; },
    isCurrent: () => current,
    onStateChange: () => { /* a real component ignores this after navigation */ },
  });
  await submitted.promise;
  assert.deepEqual(paymentChallengeState(challengeId), { state: 'consumed', outcome: 'submitted-unknown' });
  current = false;
  provider.resolve({ status: 200 });
  assert.equal((await attemptPromise).kind, 'response');
  assert.equal(paymentChallengeState(challengeId).state, 'consumed');
  assert.equal((await runPaymentAttempt({ agentKey, challengeId, sign: async () => 'again', submit: async () => ({}) })).kind, 'blocked');
});

test('stale snapshots and bounded history eviction cannot reactivate a visible consumed challenge', async () => {
  const agentKey = 'lifecycle:retention';
  const challengeId = newPaymentChallengeId();
  source(agentKey, challengeId);
  await runPaymentAttempt({
    agentKey, challengeId,
    sign: async (markSigned) => { markSigned(); return 'fake-payment-header'; },
    submit: async () => ({ status: 200 }),
  });
  rememberTryHistory(agentKey, [{
    question: 'stale render', kind: 'payment', paymentChallengeId: challengeId,
    paymentChallenge: { state: 'prompting', outcome: null },
  }]);
  assert.deepEqual(recallTryHistory(agentKey)[0].paymentChallenge, { state: 'consumed', outcome: 'response-received' });
  for (let i = 0; i < 21; i += 1) rememberTryHistory(`lifecycle:evict:${i}`, [{ question: String(i) }]);
  assert.equal(paymentChallengeState(challengeId).state, 'consumed');
  assert.equal((await runPaymentAttempt({ agentKey, challengeId, sign: async () => 'again', submit: async () => ({}) })).kind, 'blocked');
});

test('an identical retry 402 keeps its original id while a new explicit task gets a new id', () => {
  const original = newPaymentChallengeId();
  const inheritedByRetry = original;
  const explicitNewTask = newPaymentChallengeId();
  assert.equal(inheritedByRetry, original);
  assert.notEqual(explicitNewTask, original);
});
