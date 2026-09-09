import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { calculateGridCosts, readGridCostCheck, validateGridCostInputs, GRID_POOL, GRID_RPC_URL } from '../src/grid-cost-check.js';

const base = { stepPct: '0.5', cycleNotionalUsd: '100', slippageBpsPerSwap: '0', gasUsdPerCycle: '0' };
const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

test('two filled swaps reproduce hand-calculated cashflows without additive fee approximation', () => {
  // Buy at $500: 100 * .9995 / 500 = .1999 base.
  // Sell at $502.50: .1999 * 502.5 * .9995 = 100.399525125 quote.
  const result = calculateGridCosts(base, 500);
  assert.equal(result.modeledQuoteReturnedBeforeGasUsd, '100.399525125');
  assert.equal(result.modeledNetUsd, '0.399525125');
  assert.equal(result.decision, 'ABOVE_MODELED_COSTS');
  assert.equal(result.feePctPerSwap, '0.05');
  assert.ok(Number(result.feeOnlyBreakEvenStepPct) > 0.100075);
  assert.ok(Number(result.feeOnlyBreakEvenStepPct) < 0.100076);
  const insufficient = calculateGridCosts({ ...base, stepPct: '0.05' }, 500);
  assert.equal(insufficient.modeledNetUsd, '-0.0500249875');
  assert.equal(insufficient.decision, 'BELOW_MODELED_COSTS');
  // Additive 2f would accept 0.10005%; compounded fees correctly reject it.
  assert.equal(calculateGridCosts({ ...base, stepPct: '0.10005' }, 500).decision, 'BELOW_MODELED_COSTS');
  assert.equal(calculateGridCosts({ ...base, stepPct: '0.100076' }, 500).decision, 'ABOVE_MODELED_COSTS');
});

test('cost assumptions apply to both swaps; gas alone can reverse the result', () => {
  // No pool fee, 1% slippage twice: 100 * 1.03 * .99 * .99 - 100 - .5 = .4503.
  const slip = calculateGridCosts({ ...base, stepPct: '3', slippageBpsPerSwap: '100', gasUsdPerCycle: '0.5' }, 0);
  assert.equal(slip.modeledNetUsd, '0.4503');
  const gas = calculateGridCosts({ ...base, gasUsdPerCycle: '0.4' }, 500);
  assert.equal(gas.modeledNetUsd, '-0.000474875');
  assert.equal(gas.decision, 'BELOW_MODELED_COSTS');
  const flat = calculateGridCosts({ ...base, stepPct: '0' }, 0);
  assert.equal(flat.decision, 'AT_MODELED_BREAK_EVEN');
  assert.equal(flat.modeledNetUsd, '0');
});

test('explicit decimal cost inputs reject ambiguous values, hidden defaults and destinations', () => {
  for (const bad of [undefined, null, [], {}, { ...base, rpc: GRID_RPC_URL }, { ...base, pool: GRID_POOL.address },
    { ...base, stepPct: 0.5 }, { ...base, stepPct: '-1' }, { ...base, stepPct: '1e-3' },
    { ...base, stepPct: '01' }, { ...base, stepPct: '.5' }, { ...base, stepPct: '0.0000001' },
    { ...base, stepPct: '100.000001' }, { ...base, cycleNotionalUsd: '0' },
    { ...base, cycleNotionalUsd: '1000001' }, { ...base, slippageBpsPerSwap: '1000.000001' },
    { ...base, gasUsdPerCycle: '1000001' }, { ...base, gasUsdPerCycle: undefined }]) {
    assert.throws(() => validateGridCostInputs(bad));
  }
  assert.deepEqual(validateGridCostInputs(base), base);
  assert.equal(calculateGridCosts({ ...base, cycleNotionalUsd: '0.000001' }, 500).decision, 'ABOVE_MODELED_COSTS');
  for (const fee of [-1, 0.5, 1000000, NaN]) assert.throws(() => calculateGridCosts(base, fee));
});

function mockRpc(overrides = {}) {
  const now = Date.parse('2026-09-08T16:00:00Z');
  const block = { number: '0x123', hash: '0x' + 'a'.repeat(64), timestamp: '0x' + BigInt(now / 1000 - 2).toString(16) };
  const calls = [], observations = []; let blockReads = 0;
  return { now: () => now, calls, observations, onObservation: v => observations.push(v), fetchImpl: async (url, options) => {
    const r = JSON.parse(options.body); calls.push(r);
    assert.equal(url, GRID_RPC_URL); assert.equal(options.redirect, 'error');
    assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(r.method));
    let result;
    if (r.method === 'eth_chainId') result = overrides.chain ?? '0x38';
    else if (r.method === 'eth_getBlockByNumber') {
      result = { ...block, ...(overrides.block ?? {}) };
      if (++blockReads > 1 && overrides.reorg) result.hash = '0x' + 'b'.repeat(64);
    } else {
      assert.equal(r.params[1], block.number);
      const { to, data } = r.params[0];
      if (to === GRID_POOL.factory) {
        assert.equal(data, '0x1698ee82' + [GRID_POOL.token0, GRID_POOL.token1, 500].map(v => word(v).slice(2)).join(''));
        result = word(overrides.factoryPool ?? GRID_POOL.address);
      } else {
        assert.equal(to, GRID_POOL.address);
        result = ({ '0xddca3f43': word(overrides.fee ?? 500), '0x0dfe1681': word(overrides.token0 ?? GRID_POOL.token0), '0xd21220a7': word(GRID_POOL.token1) })[data];
        assert.ok(result);
      }
    }
    return new Response(overrides.raw ?? JSON.stringify({ jsonrpc: '2.0', id: overrides.wrongId ? -1 : r.id,
      ...(overrides.rpcError ? { error: { code: -32000, message: 'missing trie node' } } : { result }) }), { status: overrides.status ?? 200 });
  } };
}

test('live-reader contract captures exact responses and verifies one recent stable pool block', async () => {
  const rpc = mockRpc();
  const output = await readGridCostCheck(base, rpc);
  assert.equal(rpc.calls.length, 7);
  assert.equal(output.evidence.length, 7);
  assert.equal(output.block.hashStable, true);
  assert.equal(output.relationship, 'first-party');
  assert.equal(output.registryStatus, 'unregistered-local-example');
  assert.equal(output.scope, 'analysis-only');
  assert.equal(output.paidDelivery, false);
  assert.deepEqual(output.transactions, []);
  assert.equal(output.modeledNetUsd, '0.399525125');
  for (const entry of output.evidence) assert.equal(entry.sha256, createHash('sha256').update(entry.responseText).digest('hex'));
});

test('bad inputs cannot trigger RPC; wrong chain, pool, factory, block and broken reads fail closed', async () => {
  const invalid = mockRpc();
  await assert.rejects(readGridCostCheck({ ...base, rpc: 'https://example.com' }, invalid));
  assert.equal(invalid.calls.length, 0);
  for (const mutation of [{ chain: '0x1' }, { fee: 100 }, { token0: 1 }, { factoryPool: 1 },
    { reorg: true }, { block: { hash: '0x01' } }, { block: { timestamp: '0x65000000' } },
    { block: { timestamp: '0xffffffff' } }, { wrongId: true }, { rpcError: true },
    { raw: '<html>failure</html>' }, { status: 503 }, { raw: 'a'.repeat(65537) }]) {
    await assert.rejects(readGridCostCheck(base, mockRpc(mutation)), JSON.stringify(mutation).slice(0, 100));
  }
  const failure = mockRpc({ rpcError: true });
  await assert.rejects(readGridCostCheck(base, failure));
  assert.ok(failure.observations[0].responseText.includes('missing trie node'));
});

test('a failed pool read waits for other bounded observations before ending the scenario', async () => {
  const mock = mockRpc(), original = mock.fetchImpl;
  mock.fetchImpl = async (url, options) => {
    const r = JSON.parse(options.body);
    if (r.method === 'eth_call' && r.params[0].data === '0xddca3f43') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'missing trie node' } }));
    }
    if (r.method === 'eth_call') await new Promise(resolve => setTimeout(resolve, 20));
    return original(url, options);
  };
  await assert.rejects(readGridCostCheck(base, mock));
  assert.equal(mock.observations.filter(x => x.request.method === 'eth_call').length, 3);
});
