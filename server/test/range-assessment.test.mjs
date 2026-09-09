import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  RANGE_FIXTURE,
  assessRangeFacts,
  corroborateRangeFacts,
} from '../src/range-assessment.js';

const fixture = {
  skill: 'analyse', chainId: 56, observedAt: '2026-09-08T16:25:24.000Z', blockNumber: '120717906',
  subject: { tokenId: '7337249', pool: RANGE_FIXTURE.pool, pair: 'USDT/WBNB' },
  decision: {
    action: 'hold', inRange: true, proposed: null,
    current: { tickLower: -66690, tickUpper: -65710, widthTicks: 980 },
    drift: { currentTick: -66263, driftToleranceBps: 0 },
  },
  facts: {
    position: {
      token0: { address: RANGE_FIXTURE.token0, symbol: 'USDT' },
      token1: { address: RANGE_FIXTURE.token1, symbol: 'WBNB' },
      fee: 500, tickSpacing: 10, tickLower: -66690, tickUpper: -65710,
      liquidity: '2461321976867509016', pool: RANGE_FIXTURE.pool,
    },
    pool: { sqrtPriceX96: '2884612816534375943279289999', tick: -66263 },
  },
};
const now = Date.parse('2026-09-08T16:25:26.000Z');
const block = { number: '0x' + BigInt(fixture.blockNumber).toString(16), hash: `0x${'a'.repeat(64)}`, timestamp: '0x' + BigInt(now / 1000 - 2).toString(16) };
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const addressWord = (value) => `0x${word(BigInt(value))}`;
const positionAbi = () => `0x${[0, 0, RANGE_FIXTURE.token0, RANGE_FIXTURE.token1, 500, -66690, -65710, fixture.facts.position.liquidity, 0, 0, 0, 0].map(word).join('')}`;
const slotAbi = () => `0x${[2884612816534375943279289999n, -66263, 0, 0, 0, 300, 1].map(word).join('')}`;
const spacingAbi = () => `0x${word(10)}`;

function response(body, status = 200) { return new Response(body, { status, headers: { 'content-type': 'application/json' } }); }

function mockRpc(overrides = {}) {
  const calls = [];
  let blockReads = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://rpc.test.example/bsc');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined);
    const request = JSON.parse(options.body); calls.push(request);
    if (overrides.throw) throw new Error('network down');
    if (overrides.delay) await new Promise((resolve) => setTimeout(resolve, overrides.delay));
    let result;
    if (request.method === 'eth_chainId') result = overrides.chain ?? '0x38';
    else if (request.method === 'eth_getBlockByNumber') {
      const tag = request.params[0];
      if (tag === 'latest') result = { ...block, ...(overrides.latest ?? {}) };
      else {
        result = { ...block, ...(overrides.exact ?? {}) };
        blockReads += 1;
        if (overrides.reorg && blockReads > 1) result.hash = `0x${'b'.repeat(64)}`;
      }
    } else if (request.method === 'eth_call') {
      const [call, tag] = request.params;
      assert.equal(tag, block.number);
      if (call.to.toLowerCase() === RANGE_FIXTURE.manager && call.data === `0x99fbab88${BigInt(RANGE_FIXTURE.positionId).toString(16).padStart(64, '0')}`) result = overrides.position ?? positionAbi();
      else if (call.to.toLowerCase() === RANGE_FIXTURE.factory) result = overrides.factory ?? addressWord(RANGE_FIXTURE.pool);
      else if (call.to.toLowerCase() === RANGE_FIXTURE.pool && call.data === '0x3850c7bd') result = overrides.slot ?? slotAbi();
      else if (call.to.toLowerCase() === RANGE_FIXTURE.pool && call.data === '0xd0c93a7c') result = overrides.spacing ?? spacingAbi();
      else throw new Error(`unexpected call ${call.to}:${call.data}`);
    } else throw new Error(`unexpected method ${request.method}`);
    if (overrides.rpcError) return response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'upstream unavailable' } }));
    return response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), overrides.status ?? 200);
  };
  return { fetchImpl, calls };
}

test('assessRangeFacts accepts synthetic facts in the reviewed provider shape', () => {
  const checks = assessRangeFacts(fixture, { positionId: RANGE_FIXTURE.positionId, chainId: 56, driftToleranceBps: 0 });
  assert.ok(checks.length >= 10);
  assert.ok(checks.every((check) => check.passed));
});

test('membership is lower-inclusive and upper-exclusive', () => {
  const lower = structuredClone(fixture);
  lower.facts.pool.tick = lower.facts.position.tickLower;
  lower.decision.drift.currentTick = lower.facts.pool.tick;
  lower.decision.inRange = true;
  lower.decision.action = 'hold'; lower.decision.proposed = null;
  assert.equal(assessRangeFacts(lower).find((check) => check.id === 'membership').passed, true);
  const upper = structuredClone(fixture);
  upper.facts.pool.tick = upper.facts.position.tickUpper;
  upper.decision.drift.currentTick = upper.facts.pool.tick;
  upper.decision.inRange = false;
  upper.decision.action = 'rebalance'; upper.decision.proposed = {};
  assert.equal(assessRangeFacts(upper).find((check) => check.id === 'membership').passed, true);
  assert.equal(assessRangeFacts(upper).every((check) => check.passed), true);
});

test('a correctly reported out-of-range position passes, but HOLD out of range fails', () => {
  const outside = structuredClone(fixture);
  outside.facts.pool.tick = outside.facts.position.tickUpper;
  outside.decision.drift.currentTick = outside.facts.pool.tick;
  outside.decision.inRange = false;
  outside.decision.action = 'rebalance';
  assert.equal(assessRangeFacts(outside).every((check) => check.passed), true);
  outside.decision.action = 'hold';
  assert.equal(assessRangeFacts(outside).every((check) => check.passed), false);
});

test('caller token identity is fixed and hostile tokenId arguments cannot retarget the read', () => {
  assert.equal(assessRangeFacts(fixture, { tokenId: '1' }).every((check) => check.passed), false);
});

test('provider identity, ticks and liquidity mismatches fail closed', () => {
  for (const mutate of [
    (p) => { p.subject.pool = '0x0000000000000000000000000000000000000001'; },
    (p) => { p.facts.position.tickUpper += 10; },
    (p) => { p.facts.position.liquidity = '01'; },
    (p) => { p.decision.drift.driftToleranceBps = 1; },
    (p) => { p.facts.pool.price = Infinity; },
  ]) {
    const changed = structuredClone(fixture); mutate(changed);
    assert.equal(assessRangeFacts(changed).some((check) => !check.passed), true);
  }
});

test('valid exact-block RPC corroboration returns evidence and stable same-block proof', async () => {
  const rpc = mockRpc();
  const result = await corroborateRangeFacts(fixture, { fetchImpl: rpc.fetchImpl, now: () => now, rpcUrl: 'https://rpc.test.example/bsc' });
  assert.equal(result.status, 'passed');
  assert.equal(result.block.number, fixture.blockNumber);
  assert.equal(result.block.hash, block.hash);
  assert.equal(result.source.origin, 'https://rpc.test.example');
  assert.equal(result.evidence.length, 8);
  for (const entry of result.evidence) assert.equal(entry.sha256, createHash('sha256').update(entry.responseText).digest('hex'));
  for (const call of rpc.calls.filter((call) => call.method === 'eth_call')) assert.equal(call.params[1], block.number);
});

test('on-chain mismatch, malformed ABI and chain mismatch cannot pass', async () => {
  const wrongPool = await corroborateRangeFacts(fixture, { fetchImpl: mockRpc({ factory: addressWord('0x1') }).fetchImpl, now: () => now, rpcUrl: 'https://rpc.test.example/bsc' });
  assert.equal(wrongPool.status, 'failed');
  const badAbi = await corroborateRangeFacts(fixture, { fetchImpl: mockRpc({ position: '0x00' }).fetchImpl, now: () => now, rpcUrl: 'https://rpc.test.example/bsc' });
  assert.equal(badAbi.status, 'incomplete');
  const wrongChain = await corroborateRangeFacts(fixture, { fetchImpl: mockRpc({ chain: '0x1' }).fetchImpl, now: () => now, rpcUrl: 'https://rpc.test.example/bsc' });
  assert.equal(wrongChain.status, 'failed');
});

test('stale/future blocks, reorgs and RPC failures remain incomplete with evidence', async () => {
  for (const options of [
    { exact: { timestamp: '0x' + BigInt(now / 1000 - 301).toString(16) } },
    { exact: { timestamp: '0x' + BigInt(now / 1000 + 31).toString(16) } },
    { reorg: true }, { rpcError: true }, { throw: true }, { status: 503 },
  ]) {
    const rpc = mockRpc(options);
    const result = await corroborateRangeFacts(fixture, { fetchImpl: rpc.fetchImpl, now: () => now, rpcUrl: 'https://rpc.test.example/bsc' });
    assert.equal(result.status, 'incomplete', JSON.stringify(options));
    assert.ok(result.evidence.length >= 1);
  }
});

test('caller abort cancels the in-flight transport and remains incomplete', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, options) => await new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new Error('aborted'));
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const pending = corroborateRangeFacts(fixture, { fetchImpl, signal: controller.signal, now: () => now, rpcUrl: 'https://rpc.test.example/bsc' });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'incomplete');
  assert.ok(result.evidence.length >= 1);
});
