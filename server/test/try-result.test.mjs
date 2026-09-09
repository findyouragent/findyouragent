import assert from 'node:assert/strict';
import { classifyTryResult, isCurrentTryExample, TRY_RESULT_VERSION } from '../src/try-result.js';
import { callMcpTool } from '../src/mcp.js';
import { probeMcp } from '../src/verify/probe.js';
import { tryAgent, tryInterface } from '../src/try.js';

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack}`);
    process.exitCode = 1;
  }
};
const content = { content: [{ type: 'text', text: '{"health":1.4}' }] };
const classify = (body, extra = {}) => classifyTryResult({ protocol: 'mcp', httpStatus: 200, body, ...extra });
const a2a = (result, extra = {}) => classify({ result }, { protocol: 'a2a', ...extra });

await test('HTTP success cannot hide MCP isError or a JSON-RPC error', () => {
  assert.equal(classify({ result: { ...content, isError: true } }).outcome, 'error');
  assert.equal(classify({ error: { code: -32603, message: 'failed' }, result: content }).outcome, 'error');
});

await test('upstream HTTP failure wins over plausible content', () => {
  const out = classify({ result: content }, { httpStatus: 503 });
  assert.equal(out.outcome, 'error');
  assert.deepEqual(out.transport, { status: 503, ok: false, received: true });
});

await test('payment challenge is an explicit unpaid state', () => {
  const out = classify({ error: 'payment required', accepts: [{}] }, { httpStatus: 402 });
  assert.equal(out.outcome, 'payment_required');
  assert.equal(out.task.status, 'not_evaluated');
});

await test('empty and malformed results are unknown, never successful responses', () => {
  for (const body of [null, {}, { result: {} }, { result: [] }, { result: { content: [] } },
    { result: { content: [{}] } }, { result: { content: [{ type: 'text', text: ' ' }] } },
    { result: { structuredContent: {} } }, { result: { ...content, isError: 'false' } }]) {
    assert.equal(classify(body).outcome, 'unknown', JSON.stringify(body));
  }
});

await test('content is a response, not proof the buyer task passed', () => {
  for (const result of [content, { structuredContent: { data: [] } },
    { content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] }]) {
    const out = classify({ result });
    assert.equal(out.outcome, 'response_received');
    assert.equal(out.task.status, 'not_evaluated');
  }
});

await test('no upstream response does not invent an HTTP status', () => {
  const out = classify({ error: 'timed out' }, { httpStatus: null });
  assert.equal(out.outcome, 'error');
  assert.deepEqual(out.transport, { status: null, ok: false, received: false });
});

await test('HTTP acceptance and A2A nonterminal states remain pending with partial output', () => {
  assert.equal(classify(null, { httpStatus: 202 }).outcome, 'pending');
  for (const state of ['submitted', 'working', 'input-required', 'auth-required']) {
    const out = a2a({ kind: 'task', status: { state }, artifacts: [{ parts: [{ kind: 'text', text: 'partial' }] }] });
    assert.equal(out.outcome, 'pending');
    assert.equal(out.task.status, 'not_evaluated');
  }
});

await test('failed, rejected and canceled A2A tasks remain errors with artifacts', () => {
  for (const state of ['failed', 'rejected', 'canceled', 'cancelled']) {
    assert.equal(a2a({ status: { state }, artifacts: [{ parts: [{ kind: 'text', text: 'partial' }] }] }).outcome, 'error');
  }
});

await test('A2A completion requires actual output and still does not assert task quality', () => {
  assert.equal(a2a({ status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'done' }] } } }).outcome, 'unknown');
  assert.equal(a2a({ status: { state: 'completed' }, artifacts: [{ parts: [] }] }).outcome, 'unknown');
  const out = a2a({ status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'data', data: { health: 1.4 } }] }] });
  assert.equal(out.outcome, 'deliverable_received');
  assert.equal(out.task.status, 'not_evaluated');
});

await test('direct A2A reply and unknown-state task are distinct from completion', () => {
  assert.equal(a2a({ kind: 'message', parts: [{ kind: 'text', text: 'Hello' }] }).outcome, 'response_received');
  assert.equal(a2a({ kind: 'task', status: { state: 'unknown' }, artifacts: [{ parts: [{ kind: 'text', text: 'Hello' }] }] }).outcome, 'unknown');
});

await test('A2A provider task ids survive pending observations without confusing message ids', () => {
  assert.equal(a2a({ kind: 'task', id: 'provider-job-42', status: { state: 'working' } }).providerTaskId, 'provider-job-42');
  assert.equal(a2a({ id: 'provider-job-42', status: { state: 'completed' } }).providerTaskId, 'provider-job-42');
  assert.equal(a2a({ kind: 'message', id: 'message-42', parts: [{ kind: 'text', text: 'hi' }] }).providerTaskId, null);
});

await test('observation preserves supplied clocks and capture limit without manufacturing freshness', () => {
  const input = { runId: 'run-1', startedAt: '2026-09-08T00:00:00.000Z', finishedAt: '2026-09-08T00:00:01.000Z',
    latencyMs: 1000, endpoint: 'https://agent.example/mcp', captureComplete: true };
  const out = classify({ result: content }, input);
  assert.equal(out.checkedAt, input.finishedAt);
  for (const [key, value] of Object.entries(input)) assert.equal(out[key], value);
  assert.equal(classify({ result: content }).checkedAt, null);
  assert.equal(classify({ result: content }).captureComplete, false);
});

await test('legacy ok flags and current error records cannot become auto-examples', () => {
  assert.equal(isCurrentTryExample({ ok: true }), false);
  assert.equal(isCurrentTryExample({ ok: true, observation: { version: TRY_RESULT_VERSION, protocol: 'mcp', outcome: 'error' } }), false);
  assert.equal(isCurrentTryExample({ ok: true, observation: classify({ result: content }) }), true);
});

async function withReplies(replies, fn) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    const next = replies[calls++];
    assert.ok(next, 'unexpected additional request; tests never call the network');
    next.inspect?.(url, options);
    return new Response(next.raw ?? JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  try { await fn(() => calls); } finally { globalThis.fetch = originalFetch; }
}
const initialized = { body: { jsonrpc: '2.0', result: { serverInfo: { name: 'fixture' } } } };
const publicUrl = new URL('https://8.8.8.8/mcp'); // fetch is fully replaced above; no network or DNS.

await test('MCP relay preserves actual non-200 upstream status', async () => {
  await withReplies([initialized, { status: 201, body: { jsonrpc: '2.0', result: content } }], async () => {
    const out = await callMcpTool(publicUrl, { name: 'getHealth', args: {} });
    assert.equal(out.status, 201);
    assert.equal(out.upstreamStatus, 201);
    assert.equal(out.captureComplete, true);
  });
});

await test('an empty MCP 202 response remains accepted and pending', async () => {
  await withReplies([initialized, { status: 202, raw: '' }], async () => {
    const out = await callMcpTool(publicUrl, { name: 'getHealth', args: {} });
    assert.equal(out.status, 202);
    assert.equal(classify(out.body, { httpStatus: out.upstreamStatus }).outcome, 'pending');
  });
});

await test('MCP handshake JSON-RPC error is refused even if it also includes a result', async () => {
  await withReplies([{ body: { result: {}, error: { code: -1, message: 'refused' } } }], async (calls) => {
    const out = await callMcpTool(publicUrl, { name: 'getHealth', args: {} });
    assert.equal(out.status, 502);
    assert.equal(out.upstreamStatus, 200);
    assert.equal(out.phase, 'initialize');
    assert.equal(calls(), 1);
  });
});

await test('verification never stores an MCP error as a successful auto-example', async () => {
  await withReplies([initialized,
    { body: { result: { tools: [{ name: 'getHealth', inputSchema: {} }] } } },
    { body: { result: { ...content, isError: true } } }], async () => {
    const out = await probeMcp(String(publicUrl));
    assert.equal(out.servesTools, true, 'tool service evidence remains separate');
    assert.equal(out.tryExample.ok, false);
    assert.equal(out.tryExample.observation.outcome, 'error');
    assert.equal(out.tryExample.observation.task.status, 'not_evaluated');
    assert.ok(Date.parse(out.tryExample.checkedAt));
  });
});

const vaultTool = { name: 'getVaultsWithChains', inputSchema: { type: 'object', required: ['chainNames'],
  properties: { chainNames: { type: 'array', items: { type: 'string' } } } } };
const vaultPayload = { project: 'beefy', operation: 'getVaultsWithChains', data: [
  { chain: 'bsc', vaults: [{ id: 'fixture-vault', name: 'Fixture vault', chain: 'bsc', token: 'BNB', tvl: 0, apy: 0 }] },
] };

await test('named task uses its reviewed fixture and records criteria separately from transport', async () => {
  await withReplies([
    { body: { chain_id: 56, token_id: '45422', services: { mcp: { endpoint: String(publicUrl) } } } },
    initialized, { body: { result: { tools: [vaultTool] } } },
    initialized, { body: { result: { tools: [vaultTool] } } },
    initialized, { body: { result: { structuredContent: vaultPayload } }, inspect: (_url, options) => {
      const sent = JSON.parse(options.body);
      assert.equal(sent.method, 'tools/call');
      assert.deepEqual(sent.params, { name: 'getVaultsWithChains', arguments: { chainNames: ['bsc'] } });
      assert.equal(options.headers['X-PAYMENT'], undefined);
    } },
  ], async () => {
    const iface = await tryInterface({ chainId: 56, tokenId: '45422' });
    assert.equal(iface.body.taskPresets[0].available, true);
    const out = await tryAgent({ chainId: 56, tokenId: '45422', presetId: 'beefy-bsc-vaults',
      tool: 'swapTokens', args: { amount: 999 }, payment: 'must-not-be-forwarded' });
    assert.equal(out.observation.outcome, 'response_received');
    assert.equal(out.observation.protocol, 'mcp');
    assert.equal(out.observation.task.status, 'passed');
    assert.equal(out.observation.task.checks.length, 4);
    assert.equal(out.observation.captureComplete, true);
    assert.ok(Date.parse(out.observation.startedAt) <= Date.parse(out.observation.finishedAt));
    assert.ok(out.observation.runId);
    assert.deepEqual(out.body.result.structuredContent, vaultPayload);
    assert.deepEqual(out.taskPreset.args, { chainNames: ['bsc'] });
    assert.equal(out._taskPreset, undefined, 'internal evaluator definition is not exposed');
  });
});

await test('a changed live task schema refuses execution before tools/call', async () => {
  await withReplies([initialized, { body: { result: { tools: [{ ...vaultTool,
    inputSchema: { ...vaultTool.inputSchema, required: ['chainNames', 'secret'] } }] } } }], async (calls) => {
    const out = await tryAgent({ chainId: 56, tokenId: '45422', presetId: 'beefy-bsc-vaults' });
    assert.equal(out.status, 409);
    assert.equal(out.observation.outcome, 'error');
    assert.equal(out.observation.task.status, 'not_evaluated');
    assert.equal(calls(), 2, 'only initialize and tools/list were invoked');
  });
});

console.log(`${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
