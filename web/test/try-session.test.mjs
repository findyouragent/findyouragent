import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTERFACE_TIMEOUT_MS, TASK_TIMEOUT_MS, fetchTryInterface, fetchTryTask,
  rememberTryHistory, recallTryHistory,
} from '../src/lib/try-session.js';
import { makeRunRecord, runState } from '../src/lib/try-record.js';

const options = { serviceBase: 'https://fya.invalid', chainId: 56, tokenId: '45422' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('interface lookup reports an HTML 502 and recovers only when explicitly requested', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1
      ? new Response('<html>Bad gateway</html>', { status: 502 })
      : json({ kind: 'mcp', tools: [{ name: 'readVaults', inputSchema: { type: 'object' } }] });
  };
  const failed = await fetchTryInterface({ ...options, fetchImpl });
  assert.equal(failed.kind, 'none');
  assert.equal(failed.httpStatus, 502);
  assert.match(failed.error, /HTTP 502/);
  assert.equal(requests.length, 1);
  const recovered = await fetchTryInterface({ ...options, fetchImpl });
  assert.equal(recovered.kind, 'mcp');
  assert.equal(recovered.tools[0].name, 'readVaults');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url, init }) => url.endsWith('/interface') && !init.method && !init.body));
});

test('malformed HTTP 200 interfaces become an error, never a null loading sentinel', async () => {
  for (const body of [null, [], {}, { kind: 'mcp' }, { kind: 'mcp', tools: [null] }, { kind: 'mcp', tools: [{ name: {} }] }, { kind: 'wrong' }]) {
    const result = await fetchTryInterface({ ...options, fetchImpl: async () => json(body) });
    assert.equal(result.kind, 'none');
    assert.equal(result.httpStatus, 200);
    assert.match(result.error, /unreadable/);
  }
  const html = await fetchTryInterface({ ...options, fetchImpl: async () => new Response('<html>proxy</html>') });
  assert.match(html.error, /unreadable/);
});

test('valid empty interfaces and server errors are distinguished', async () => {
  assert.deepEqual(await fetchTryInterface({ ...options, fetchImpl: async () => json({ kind: 'none' }) }), { kind: 'none', httpStatus: 200 });
  const failed = await fetchTryInterface({ ...options, fetchImpl: async () => json({ error: 'tools_unavailable', detail: 'The provider did not answer.' }, 504) });
  assert.match(failed.error, /HTTP 504.*provider did not answer/);
});

test('interface deadline covers stalled headers and a stalled body without retrying', async () => {
  assert.equal(INTERFACE_TIMEOUT_MS, 35_000);
  for (const headersArrive of [false, true]) {
    let calls = 0;
    let signal;
    const result = await fetchTryInterface({ ...options, timeoutMs: 5, fetchImpl: async (_url, init) => {
      calls += 1;
      signal = init.signal;
      if (!headersArrive) return new Promise(() => {});
      return { ok: true, status: 200, text: () => new Promise(() => {}) };
    } });
    assert.match(result.error, /too long/);
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(result.httpStatus, headersArrive ? 200 : null);
  }
});

test('task HTML 502 preserves relay status and the incomplete capture in a downloadable record', async () => {
  let calls = 0;
  const result = await fetchTryTask({ ...options, request: { presetId: 'beefy-bsc-vaults' }, fetchImpl: async (_url, init) => {
    calls += 1;
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { presetId: 'beefy-bsc-vaults' });
    return new Response('<html>Bad gateway</html>', { status: 502 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.httpStatus, 502);
  assert.equal(result.observation.transport.status, 502);
  assert.equal(result.observation.phase, 'relay');
  assert.equal(result.observation.captureComplete, false);
  assert.match(result.detail, /HTTP 502.*Completion is unknown.*No automatic retry/);
  assert.equal(result.body.raw, '<html>Bad gateway</html>');
  const record = makeRunRecord(result, { ...options, request: { presetId: 'beefy-bsc-vaults' } });
  assert.equal(record.response.captureComplete, false);
  assert.equal(record.observation.transport.status, 502);
  assert.equal(runState(record), 'error');
});

test('task deadline aborts once and states unknown completion for messages and tools', async () => {
  assert.equal(TASK_TIMEOUT_MS, 95_000);
  for (const request of [{ message: 'fixture only' }, { tool: 'read', arguments: {} }]) {
    let calls = 0;
    let signal;
    const result = await fetchTryTask({ ...options, request, timeoutMs: 5, fetchImpl: async (_url, init) => {
      calls += 1;
      signal = init.signal;
      return { ok: true, status: 200, text: () => new Promise(() => {}) };
    } });
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(result.error, 'relay-timeout');
    assert.match(result.detail, /Completion is unknown.*No automatic retry/);
    assert.equal(result.observation.outcome, 'unknown');
    assert.equal(result.observation.captureComplete, false);
    assert.equal(result.observation.transport.status, 200);
    assert.equal(result.observation.protocol, request.message ? 'a2a' : 'mcp');
  }
});

test('network loss has an explicit incomplete result and does not infer an HTTP status', async () => {
  const result = await fetchTryTask({ ...options, request: { message: 'fixture only' }, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(result.httpStatus, null);
  assert.equal(result.observation.transport.received, false);
  assert.equal(result.observation.captureComplete, false);
  assert.match(result.detail, /Completion is unknown/);
});

test('canonical server observations and payment challenges survive defensive parsing', async () => {
  const observation = { version: 1, runId: 'server-run', outcome: 'payment_required', captureComplete: true, transport: { status: 402 }, task: { status: 'not_evaluated' } };
  const envelope = { status: 402, body: { accepts: [{ scheme: 'fixture' }] }, observation };
  const result = await fetchTryTask({ ...options, request: { message: 'fixture only' }, fetchImpl: async () => json(envelope) });
  assert.deepEqual(result.observation, observation);
  assert.deepEqual(result.body, envelope.body);
  assert.equal(result.status, 402);
  assert.equal(result.httpStatus, 200);
});

test('legacy JSON errors retain HTTP status and never claim a complete provider capture', async () => {
  const result = await fetchTryTask({ ...options, request: { tool: 'read', arguments: {} }, fetchImpl: async () => json({ error: 'provider unavailable' }, 502) });
  assert.equal(result.error, 'provider unavailable');
  assert.equal(result.httpStatus, 502);
  assert.equal(result.observation.transport.status, 502);
  assert.equal(result.observation.outcome, 'error');
  assert.equal(result.observation.captureComplete, false);
});

test('completed histories survive reopen and remain isolated by agent', () => {
  const entry = { question: 'Read vaults', record: { runId: 'one', response: { body: { full: ['provider', 'result'] }, captureComplete: true } } };
  rememberTryHistory('history:one', [entry]);
  rememberTryHistory('history:two', [{ question: 'Different agent' }]);
  assert.deepEqual(recallTryHistory('history:one'), [entry]);
  const copy = recallTryHistory('history:one');
  copy.push({ question: 'not in store' });
  assert.equal(recallTryHistory('history:one').length, 1);
  assert.equal(recallTryHistory('history:two')[0].question, 'Different agent');
});

test('history caps result count, agent count and bytes without truncating retained records', () => {
  rememberTryHistory('history:many', Array.from({ length: 25 }, (_, i) => ({ question: String(i) })));
  const recent = recallTryHistory('history:many');
  assert.equal(recent.length, 20);
  assert.equal(recent[0].question, '5');
  for (let i = 0; i < 21; i += 1) rememberTryHistory(`evict:${i}`, [{ question: String(i) }]);
  assert.deepEqual(recallTryHistory('evict:0'), []);
  assert.equal(recallTryHistory('evict:20')[0].question, '20');
  rememberTryHistory('oversized', [{ question: 'x'.repeat(4 * 1024 * 1024) }]);
  assert.deepEqual(recallTryHistory('oversized'), []);
});
