import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTaskPresets, resolveTaskPreset, assessTaskResult, RANGE_ASSESSMENT_ID } from '../src/task-presets.js';
import { tryAgent } from '../src/try.js';
import { RANGE_FIXTURE } from '../src/range-assessment.js';

const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const abi = (...values) => `0x${values.map(word).join('')}`;
const LIQUIDITY = '2461321976867509016';

const tool = (schema = {
  type: 'object', required: ['tokenId', 'chainId', 'driftToleranceBps'], properties: {
    tokenId: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    chainId: { type: 'integer', minimum: 56, maximum: 56 },
    driftToleranceBps: { type: 'integer', minimum: 0, maximum: 0 },
  },
}) => ({ name: 'analyse', readOnly: true, inputSchema: schema });

const fixture = (overrides = {}) => ({
  agent: 'rebalancer', skill: 'analyse', chainId: 56,
  subject: { tokenId: '7337249', pool: RANGE_FIXTURE.pool, pair: 'USDT/WBNB' },
  observedAt: '2026-09-08T16:25:24.000Z', blockNumber: '120717906',
  decision: {
    action: 'hold', inRange: true, proposed: null,
    current: { tickLower: -66690, tickUpper: -65710, widthTicks: 980 },
    drift: { currentTick: -66263, driftToleranceBps: 0 },
  },
  facts: {
    position: {
      tokenId: '7337249', token0: { address: RANGE_FIXTURE.token0 }, token1: { address: RANGE_FIXTURE.token1 },
      fee: 500, tickSpacing: 10, tickLower: -66690, tickUpper: -65710,
      liquidity: LIQUIDITY, pool: RANGE_FIXTURE.pool,
    },
    pool: { sqrtPriceX96: '2884612816534375943279289999', tick: -66263 },
  },
  ...overrides,
});

const structured = (value, extra = {}) => ({ jsonrpc: '2.0', id: 1, result: { structuredContent: value, ...extra } });
const initialized = { jsonrpc: '2.0', result: { serverInfo: { name: 'fixture' } } };
const registry = { chain_id: 56, token_id: '338475', services: { mcp: { endpoint: 'https://8.8.8.8/mcp' } } };

async function repliesFor({ provider = fixture(), rpc = 'pass', toolSchema = undefined, inspectCall, includeRegistry = true } = {}) {
  const replies = [
    ...(includeRegistry ? [{ body: registry }] : []),
    { body: initialized },
    { body: { result: { tools: [tool(toolSchema)] } } },
    { body: initialized },
    { body: structured(provider), inspect: inspectCall },
  ];
  if (rpc === 'unavailable') return replies;
  const block = { number: `0x${BigInt(120717906).toString(16)}`, hash: `0x${'a'.repeat(64)}`, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
  const pos = abi(0, 0, RANGE_FIXTURE.token0, RANGE_FIXTURE.token1, 500, -66690, -65710, LIQUIDITY, 0, 0, 0, 0);
  for (const result of [
    '0x38', block, block, pos, abi(RANGE_FIXTURE.pool), abi(2884612816534375943279289999n, rpc === 'contradiction' ? -65000 : -66263, 0, 0, 0, 500, 1), abi(10), block,
  ]) replies.push({ body: { jsonrpc: '2.0', id: 1, result } });
  return replies;
}

async function withReplies(replies, fn) {
  const original = globalThis.fetch; let i = 0;
  globalThis.fetch = async (_url, options) => {
    const next = replies[i++];
    assert.ok(next, `unexpected request ${i}`);
    next.inspect?.(_url, options);
    let body = next.body;
    if (body?.jsonrpc === '2.0' && options?.body) body = { ...body, id: JSON.parse(options.body).id };
    return new Response(next.raw ?? JSON.stringify(body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(() => i); } finally { globalThis.fetch = original; }
}

test('range preset is available only for the exact read schema and fixture', () => {
  const available = getTaskPresets({ chainId: 56, tokenId: '338475', tools: [tool()] }).find((p) => p.id === RANGE_ASSESSMENT_ID);
  assert.equal(available.available, true);
  assert.equal(resolveTaskPreset({ chainId: 56, tokenId: '338475', presetId: RANGE_ASSESSMENT_ID, tools: [tool({ type: 'object', properties: { tokenId: { type: 'string' } } })] }), null);
  assert.equal(getTaskPresets({ chainId: 56, tokenId: '338475', tools: [tool({ type: 'object', properties: { tokenId: { type: 'string', pattern: '.*' } } })] }).find((p) => p.id === RANGE_ASSESSMENT_ID).available, false);
});

test('malformed or non-success range payloads never pass', () => {
  for (const body of [null, structured({ ...fixture(), facts: null }), structured(fixture(), { isError: true }), { error: { code: -1 }, result: { structuredContent: fixture() } }]) {
    const result = assessTaskResult({ id: RANGE_ASSESSMENT_ID, version: 1, args: { tokenId: '7337249', chainId: 56, driftToleranceBps: 0 } }, { outcome: 'response_received' }, body);
    assert.notEqual(result.status, 'passed', JSON.stringify(body));
  }
});

test('named range preset ignores caller tool, args and payment and retains provider body when RPC is unavailable', { concurrency: false }, async () => {
  const replies = await repliesFor({ rpc: 'unavailable', inspectCall: (_url, options) => {
    const sent = JSON.parse(options.body);
    assert.equal(sent.params.name, 'analyse');
    assert.deepEqual(sent.params.arguments, { tokenId: '7337249', chainId: 56, driftToleranceBps: 0 });
    assert.equal(options.headers['X-PAYMENT'], undefined);
  } });
  const out = await withReplies(replies, () => tryAgent({ chainId: 56, tokenId: '338475', presetId: RANGE_ASSESSMENT_ID, tool: 'rebalance', args: { steal: true }, payment: 'forbidden' }));
  assert.equal(out.observation.task.status, 'incomplete');
  assert.deepEqual(out.body.result.structuredContent, fixture());
  assert.equal(out.observation.task.corroboration.status, 'incomplete');
});

test('range preset passes only when all bounded RPC facts corroborate', { concurrency: false }, async () => {
  for (const [mode, expected] of [['pass', 'passed'], ['contradiction', 'failed']]) {
    const rr = await repliesFor({ rpc: mode, includeRegistry: false });
    const out = await withReplies(rr, () => tryAgent({ chainId: 56, tokenId: '338475', presetId: RANGE_ASSESSMENT_ID }));
    assert.equal(out.observation.task.status, expected, mode);
    assert.deepEqual(out.body.result.structuredContent, fixture(), 'original provider body retained');
  }
});
