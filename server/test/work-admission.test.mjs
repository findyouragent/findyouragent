import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  admittedHandler, createSseSender, createWorkAdmission, WorkCapacityError,
} from '../src/work-admission.js';
import { withDeadline } from '../src/request-deadline.js';
import { createRegistryClient } from '../src/sources/scan8004.js';
import { createVerifier } from '../src/verify/run.js';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('admission is no-queue, reentrant, and releases permits after errors', async () => {
  const admission = createWorkAdmission({ maxActive: 2 });
  const first = deferred();
  const second = deferred();
  const one = admission.run(async () => {
    assert.equal(await admission.run(async () => 'nested'), 'nested');
    return first.promise;
  });
  const two = admission.run(() => second.promise);
  await turn();
  assert.deepEqual(admission.stats(), { active: 2, maxActive: 2, queued: 0 });
  await assert.rejects(admission.run(async () => 'excess'), WorkCapacityError);
  first.resolve('one');
  second.resolve('two');
  assert.deepEqual(await Promise.all([one, two]), ['one', 'two']);
  assert.equal(admission.stats().active, 0);

  await assert.rejects(admission.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(admission.stats().active, 0);
  assert.equal(await admission.run(async () => 'recovered'), 'recovered');
});

test('a timed-out uncooperative child retains capacity and may finish nested work', async () => {
  const admission = createWorkAdmission({ maxActive: 1 });
  const continueChild = deferred();
  const finishChild = deferred();
  const nested = deferred();

  const outer = admission.run(async () => {
    await assert.rejects(
      withDeadline(10, async () => {
        await continueChild.promise;
        nested.resolve(await admission.run(async () => 'nested-after-timeout'));
        return finishChild.promise;
      }, undefined, admission),
      (error) => error?.name === 'TimeoutError',
    );
    return 'timed out';
  });
  assert.equal(await outer, 'timed out');
  assert.equal(admission.stats().active, 1);
  await assert.rejects(admission.run(async () => 'too early'), WorkCapacityError);

  continueChild.resolve();
  assert.equal(await nested.promise, 'nested-after-timeout');
  assert.equal(admission.stats().active, 1);
  finishChild.resolve('late completion');
  await turn();
  assert.equal(admission.stats().active, 0);
  assert.equal(await admission.run(async () => 'available'), 'available');
});

test('a disconnected response does not release pending handler work and SSE stops writing', async () => {
  const admission = createWorkAdmission({ maxActive: 1 });
  const work = deferred();
  const response = new EventEmitter();
  response.headersSent = false;
  response.writableEnded = false;
  response.destroyed = false;
  response.frames = [];
  response.write = (frame) => { response.frames.push(frame); };
  const send = createSseSender(response);
  assert.equal(send({ step: 'start' }), true);

  const request = admittedHandler(() => work.promise, admission)({}, response, (error) => { throw error; });
  await turn();
  assert.equal(admission.stats().active, 1);
  response.destroyed = true;
  response.emit('close');
  assert.equal(send({ step: 'late' }), false);
  assert.equal(response.frames.length, 1);
  assert.equal(admission.stats().active, 1);
  await assert.rejects(admission.run(async () => 'too early'), WorkCapacityError);
  work.resolve('done');
  assert.equal(await request, 'done');
  assert.equal(admission.stats().active, 0);
});

test('a detached callback from a settled workflow must acquire fresh capacity', async () => {
  const admission = createWorkAdmission({ maxActive: 1 });
  const callbackStarted = deferred();
  const letCallbackRun = deferred();
  const callbackResult = deferred();
  await admission.run(async () => {
    setImmediate(async () => {
      callbackStarted.resolve();
      await letCallbackRun.promise;
      try {
        callbackResult.resolve(await admission.run(async () => 'incorrectly reused'));
      } catch (error) {
        callbackResult.resolve(error);
      }
    });
  });
  await callbackStarted.promise;

  const blocker = deferred();
  const held = admission.run(() => blocker.promise);
  await turn();
  assert.equal(admission.stats().active, 1);
  letCallbackRun.resolve();
  assert.ok((await callbackResult.promise) instanceof WorkCapacityError);
  blocker.resolve('released');
  await held;
  assert.equal(admission.stats().active, 0);
});

test('registry client bounds distinct in-flight reads before another fetch starts', async () => {
  const admission = createWorkAdmission({ maxActive: 2 });
  const pending = [];
  let calls = 0;
  const fetchImpl = (url) => {
    calls += 1;
    const wait = deferred();
    const tokenId = new URL(url).pathname.split('/').at(-1);
    pending.push(() => wait.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ chain_id: 56, token_id: tokenId }),
    }));
    return wait.promise;
  };
  const registry = createRegistryClient({
    baseUrl: 'https://registry.test', apiKey: '', fetchImpl, admission, maxInFlight: 2,
  });
  const first = registry.getAgentDetail(56, '1');
  const second = registry.getAgentDetail(56, '2');
  await turn();
  assert.equal(calls, 2);
  await assert.rejects(registry.getAgentDetail(56, '3'), WorkCapacityError);
  assert.equal(calls, 2);
  pending.forEach((release) => release());
  assert.deepEqual((await Promise.all([first, second])).map((row) => row.token_id), ['1', '2']);
  assert.equal(admission.stats().active, 0);
});

test('registry reads refuse redirects and stop streaming bodies at the byte cap', async () => {
  const admission = createWorkAdmission({ maxActive: 1 });
  let cancelled = false;
  const cleanup = deferred();
  let requestOptions;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"chain'));
      controller.enqueue(new TextEncoder().encode('_id":56}'));
    },
    cancel() { cancelled = true; return cleanup.promise; },
  });
  const registry = createRegistryClient({
    baseUrl: 'https://registry.test',
    apiKey: 'redacted-test-value',
    admission,
    maxBodyBytes: 8,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(body, { status: 200 });
    },
  });

  const request = registry.getAgentDetail(56, '1');
  await turn();
  assert.equal(cancelled, true);
  assert.equal(admission.stats().active, 1);
  await assert.rejects(admission.run(async () => 'too early'), WorkCapacityError);
  cleanup.resolve();
  await assert.rejects(request, (error) => (
    error.code === 'registry-invalid-response' && /exceeds 8 bytes/.test(error.message)
  ));
  assert.equal(requestOptions.redirect, 'error');
  assert.equal(admission.stats().active, 0);
});

test('registry deadline cancels a stalled response stream before capacity recovers', async () => {
  const admission = createWorkAdmission({ maxActive: 1 });
  let cancelled = false;
  const registry = createRegistryClient({
    baseUrl: 'https://registry.test',
    apiKey: '',
    admission,
    detailTimeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel() { cancelled = true; },
    })),
  });

  await assert.rejects(registry.getAgentDetail(56, '1'), (error) => error.name === 'TimeoutError');
  await turn();
  assert.equal(cancelled, true);
  assert.equal(admission.stats().active, 0);
});

test('verification coalesces one agent and fans real events to both observers', async () => {
  const admission = createWorkAdmission({ maxActive: 1 });
  const detail = deferred();
  const values = new Map();
  const cache = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  let detailReads = 0;
  let records = 0;
  const verify = createVerifier({
    verdictCache: cache,
    accountCache: cache,
    store: { record: () => { records += 1; } },
    readAgentDetail: async () => { detailReads += 1; return detail.promise; },
    readAgentMetadata: async () => ({ status: 'available', meta: {} }),
    admission,
    maxWaitersPerAgent: 2,
  });
  const eventsOne = [];
  const eventsTwo = [];
  const first = verify('56', '7', (event) => eventsOne.push(event.step));
  const second = verify('56', '7', (event) => eventsTwo.push(event.step));
  await assert.rejects(verify('56', '7'), WorkCapacityError);
  await turn();
  assert.equal(detailReads, 1);
  assert.equal(admission.stats().active, 1);
  detail.resolve({ chain_id: 56, token_id: '7', services: {} });
  const [one, two] = await Promise.all([first, second]);
  assert.strictEqual(one, two);
  assert.equal(records, 1);
  assert.ok(eventsOne.includes('registry'));
  assert.ok(eventsTwo.includes('registry'));
  assert.equal(admission.stats().active, 0);
});
