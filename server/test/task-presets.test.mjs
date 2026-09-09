import assert from 'node:assert/strict';
import { getTaskPresets, resolveTaskPreset, assessTaskResult } from '../src/task-presets.js';

const tool = { name: 'getVaultsWithChains', readOnly: true, inputSchema: { type: 'object', properties: { chainNames: { type: 'array', items: { type: 'string', enum: ['bsc', 'ethereum'] } } }, required: ['chainNames'] } };
const request = { chainId: 56, tokenId: '45422', presetId: 'beefy-bsc-vaults', tools: [tool] };
const preset = resolveTaskPreset(request);
assert.deepEqual(preset.args, { chainNames: ['bsc'] });
assert.equal(resolveTaskPreset({ ...request, tokenId: '1' }), null);
assert.equal(resolveTaskPreset({ ...request, tools: [] }), null);
assert.equal(getTaskPresets({ ...request, tools: [] })[0].available, false);
const changed = structuredClone(tool);
changed.inputSchema.required.push('wallet');
assert.equal(resolveTaskPreset({ ...request, tools: [changed] }), null);
changed.inputSchema.required = ['chainNames'];
changed.inputSchema.properties.chainNames.items.enum = ['ethereum'];
assert.equal(resolveTaskPreset({ ...request, tools: [changed] }), null);
assert.equal(resolveTaskPreset({ ...request, tools: [{ ...tool, readOnly: false }] }), null);
for (const tools of [null, {}, [null], ['bad tool']]) {
  assert.equal(resolveTaskPreset({ ...request, tools }), null);
}
for (const alter of [
  (s) => { s.required = 'chainNames'; },
  (s) => { s.required = {}; },
  (s) => { s.required = null; },
  (s) => { s.minProperties = 2; },
  (s) => { s.properties.chainNames.minItems = '1'; },
  (s) => { s.properties.chainNames.contains = { const: 'ethereum' }; },
  (s) => { s.properties.chainNames.items.enum = 'bsc'; },
  (s) => { s.properties.chainNames.items.pattern = {}; },
  (s) => { s.properties.chainNames.items.maxLength = 2; },
  (s) => { s.properties.chainNames.items.oneOf = null; },
]) {
  const malformed = structuredClone(tool); alter(malformed.inputSchema);
  assert.equal(resolveTaskPreset({ ...request, tools: [malformed] }), null);
}

const payload = { project: 'beefy', operation: preset.tool, data: [{ chain: 'bsc', vaults: [{ id: 'vault', name: 'Vault', chain: 'bsc', token: 'WBNB', tvl: 0, apy: 0 }] }] };
const body = { result: { structuredContent: payload } };
const received = { outcome: 'response_received' };
assert.equal(assessTaskResult(preset, received, body).status, 'passed');
assert.equal(assessTaskResult(preset, { outcome: 'error' }, body).status, 'failed');
assert.equal(assessTaskResult(preset, { outcome: 'pending' }, body).status, 'pending');
assert.equal(assessTaskResult(preset, received, { result: { structuredContent: { ...payload, status: 'working' } } }).status, 'pending');
assert.equal(assessTaskResult(preset, received, { result: { structuredContent: { ...payload, success: false } } }).status, 'failed');
assert.equal(assessTaskResult(preset, received, { result: { structuredContent: null } }).status, 'failed');
assert.equal(assessTaskResult(preset, received, { result: { content: [{ type: 'text', text: 'supports BSC' }] } }).status, 'failed');
for (const content of [null, {}, 12, 'a string', [null], [{ type: 'text', text: '{}' }]]) {
  assert.equal(assessTaskResult(preset, received, { result: { content } }).status, 'failed');
}
for (const flags of [{ success: 'false' }, { status: {} }, { status: { toString: 'not callable' } },
  { status: { state: {} } }, { status: 'rejected' }, { error: 'upstream failure' }, { isError: true }]) {
  assert.equal(assessTaskResult(preset, received, { result: { structuredContent: { ...payload, ...flags } } }).status, 'failed');
}
for (const change of [
  (p) => { p.data[0].chain = 'ethereum'; },
  (p) => { p.data[0].vaults[0].chain = 'ethereum'; },
  (p) => { p.data[0].vaults = []; },
  (p) => { delete p.data[0].vaults[0].token; },
  (p) => { p.data[0].vaults[0].apy = null; },
  (p) => { p.data = {}; },
  (p) => { p.data = [null]; },
  (p) => { p.data[0].vaults = {}; },
  (p) => { p.data[0].vaults = [null]; },
]) {
  const bad = structuredClone(payload); change(bad);
  assert.equal(assessTaskResult(preset, received, { result: { structuredContent: bad } }).status, 'failed');
}
assert.equal(assessTaskResult(preset, received, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }).status, 'passed');
const venusTool = {
  name: 'getAccountLiquidity', readOnly: true,
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      chainNames: { type: 'array', items: { type: 'string', enum: ['bsc', 'ethereum', 'base'] } },
      pool: { type: 'string', enum: ['CORE', 'DEFI'] },
      userAddress: { type: 'string' },
    },
    required: ['chainNames', 'pool', 'userAddress'],
  },
};
const lpTool = {
  name: 'getLpPosition', readOnly: true,
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      lpPositions: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: { chainName: { type: 'string', enum: ['bsc', 'ethereum'] }, positionId: { type: 'string' } },
          required: ['chainName', 'positionId'],
        },
      },
    },
    required: ['lpPositions'],
  },
};
const venusRequest = { chainId: 56, tokenId: '43129', presetId: 'venus-bsc-account-liquidity', tools: [venusTool] };
const lpRequest = { chainId: 56, tokenId: '45650', presetId: 'pancake-bsc-lp-position', tools: [lpTool] };
const rangeTool = {
  name: 'getPredefinedPriceRanges', readOnly: true,
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      chainName: { type: 'string', enum: ['bsc', 'ethereum'] },
      token0: { type: 'string' }, token1: { type: 'string' },
      fee: { type: 'number' }, shortcut: { type: 'string', enum: ['risky', 'wide', 'safe'] },
    },
    required: ['chainName', 'token0', 'token1', 'fee', 'shortcut'],
  },
};
const rangeRequest = { chainId: 56, tokenId: '45650', presetId: 'pancake-bsc-range-preview', tools: [rangeTool] };
const venusPreset = resolveTaskPreset(venusRequest);
const lpPreset = resolveTaskPreset(lpRequest);
const rangePreset = resolveTaskPreset(rangeRequest);
assert.deepEqual(venusPreset.args, { chainNames: ['bsc'], pool: 'CORE', userAddress: '0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173' });
assert.deepEqual(lpPreset.args, { lpPositions: [{ chainName: 'bsc', positionId: '7337249' }] });
assert.deepEqual(rangePreset.args, {
  chainName: 'bsc', token0: '0x55d398326f99059ff775485246999027b3197955',
  token1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', fee: 500, shortcut: 'wide',
});
assert.equal(resolveTaskPreset({ ...rangeRequest, chainId: 97 }), null);
assert.equal(resolveTaskPreset({ ...rangeRequest, tokenId: '1' }), null);
assert.equal(resolveTaskPreset({ ...rangeRequest, tools: [{ ...rangeTool, readOnly: false }] }), null);
for (const mutate of [
  (s) => { s.properties.fee.minimum = 500; },
  (s) => { s.properties.fee.type = 'integer'; },
  (s) => { s.properties.fee.enum = [501]; },
  (s) => { s.properties.fee.const = NaN; },
  (s) => { s.properties.shortcut.enum = ['safe']; },
  (s) => { s.properties.chainName.enum = ['ethereum']; },
  (s) => { s.additionalProperties = { type: 'string' }; },
]) {
  const changedTool = structuredClone(rangeTool); mutate(changedTool.inputSchema);
  assert.equal(resolveTaskPreset({ ...rangeRequest, tools: [changedTool] }), null);
}
for (const current of [venusRequest, lpRequest]) {
  assert.equal(resolveTaskPreset({ ...current, chainId: 1 }), null);
  assert.equal(resolveTaskPreset({ ...current, presetId: 'beefy-bsc-vaults' }), null);
  assert.equal(resolveTaskPreset({ ...current, tools: [{ ...current.tools[0], readOnly: false }] }), null);
  assert.equal(getTaskPresets({ ...current, tools: [] })[0].available, false);
  const copy = resolveTaskPreset(current); copy.args.changed = true;
  assert.equal(Object.hasOwn(resolveTaskPreset(current).args, 'changed'), false);
}
for (const [current, mutate] of [
  [venusRequest, (s) => { s.required.push('signature'); }],
  [venusRequest, (s) => { s.properties.pool.enum = ['DEFI']; }],
  [venusRequest, (s) => { s.properties.chainNames.items.const = 'ethereum'; }],
  [venusRequest, (s) => { s.properties.userAddress.const = '0x0000000000000000000000000000000000000000'; }],
  [venusRequest, (s) => { s.properties.userAddress.maxLength = 20; }],
  [venusRequest, (s) => { s.dependentRequired = { pool: ['wallet'] }; }],
  [venusRequest, (s) => { s.properties.userAddress.pattern = '^0x'; }],
  [venusRequest, (s) => { s.properties.userAddress.type = ['string', 'null']; }],
  [venusRequest, (s) => { s.properties.userAddress.type = 'constructor'; }],
  [venusRequest, (s) => { s.additionalProperties = { type: 'string' }; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.required.push('protocol'); }],
  [lpRequest, (s) => { delete s.properties.lpPositions.items.properties.positionId; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.properties.positionId.type = 'number'; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.properties.chainName.enum = ['ethereum']; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.properties.positionId.const = '1'; }],
  [lpRequest, (s) => { s.properties.lpPositions.minItems = 2; }],
  [lpRequest, (s) => { s.properties.lpPositions.maxItems = 0; }],
  [lpRequest, (s) => { s.properties.lpPositions.uniqueItems = 'true'; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.required = 'positionId'; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.anyOf = []; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.properties.positionId.format = 'uint256'; }],
  [lpRequest, (s) => { s.properties.lpPositions.items.properties.positionId.enum = '7337249'; }],
]) {
  const changedTool = structuredClone(current.tools[0]); mutate(changedTool.inputSchema);
  assert.equal(resolveTaskPreset({ ...current, tools: [changedTool] }), null);
}

// Synthetic outputs use the reviewed fixed identities without copying market values.
const venusPayload = { project: 'venus', operation: 'getAccountLiquidity', data: [{ chain: 'bsc', pool: 'CORE', borrowLimit: '0.00', shortfall: '0.000000000000000001' }] };
const lpPayload = {
  project: 'v3pools', operation: 'getLpPosition', data: { positions: [{
    chainName: 'bsc', protocol: 'Pancake', positionId: '7337249',
    token0: { symbol: 'usdt', address: '0x55d398326f99059ff775485246999027b3197955' },
    token1: { symbol: 'wbnb', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
    fee: '0.05%', liquidity: '9007199254740993123456', amount0: '1.000000000000000001', amount1: '0',
    pendingFee0: '0.000000000000000001', pendingFee1: '0', currentPrice: '0.002', lowerPrice: '0.001', upperPrice: '0.003',
  }] },
};
const rangePayload = {
  project: 'v3pools', operation: 'getPredefinedPriceRanges',
  data: { pool: 'WbNb/UsDt', lowerPrice: '0.001258461632980362', upperPrice: '0.001390931278557242' },
};
const assess = (p, value) => assessTaskResult(p, received, { result: { structuredContent: value } });
for (const [current, value] of [[venusPreset, venusPayload], [lpPreset, lpPayload], [rangePreset, rangePayload]]) {
  assert.equal(assess(current, value).status, 'passed');
  assert.equal(assessTaskResult(current, received, { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }).status, 'passed');
  assert.equal(assessTaskResult(current, { outcome: 'pending' }, { result: { structuredContent: value } }).status, 'pending');
  assert.equal(assess(current, { ...value, status: { state: 'working' } }).status, 'pending');
  for (const flags of [{ success: false }, { success: 'true' }, { error: {} }, { isError: true }, { status: 'failed' }, { project: 'other' }, { operation: 'other' }]) {
    assert.equal(assess(current, { ...value, ...flags }).status, 'failed');
  }
  for (const value of [null, [], 'text', 42, {}]) assert.equal(assess(current, value).status, 'failed');
}
assert.equal(assess(rangePreset, rangePayload).status, 'passed');
assert.equal(assess(rangePreset, { ...rangePayload, data: { ...rangePayload.data, lowerPrice: '1', upperPrice: '2' } }).status, 'failed');
assert.equal(assess(rangePreset, { ...rangePayload, data: { ...rangePayload.data, lowerPrice: '1.9', upperPrice: '2.1' } }).status, 'passed');
assert.equal(assess(rangePreset, { ...rangePayload, data: { ...rangePayload.data, lowerPrice: rangePayload.data.lowerPrice + '000' } }).status, 'passed');
assert.equal(assess(rangePreset, { ...rangePayload, data: { ...rangePayload.data, lowerPrice: '0.' + '0'.repeat(100) + '1' } }).status, 'failed');
for (const mutate of [
  (p) => { p.operation = 'other'; },
  (p) => { p.data.pool = 'usdt/wbnb'; },
  (p) => { p.data.lowerPrice = '0.002'; },
  (p) => { p.data.lowerPrice = '0'; },
  (p) => { p.data.lowerPrice = '1e-3'; },
  (p) => { p.data.upperPrice = '0.001'; },
  (p) => { p.data.upperPrice = '0.0014'; },
]) {
  const bad = structuredClone(rangePayload); mutate(bad);
  assert.equal(assess(rangePreset, bad).status, 'failed');
}
assert.equal(assessTaskResult(rangePreset, { outcome: 'pending' }, { result: { structuredContent: rangePayload } }).status, 'pending');
assert.equal(assessTaskResult(rangePreset, received, { result: { structuredContent: { ...rangePayload, status: 'working' } } }).status, 'pending');
assert.equal(assessTaskResult(rangePreset, { outcome: 'error' }, { result: { structuredContent: rangePayload } }).status, 'failed');
for (const mutate of [
  (p) => { p.data = []; },
  (p) => { p.data = {}; },
  (p) => { p.data = [null]; },
  (p) => { p.data.push(structuredClone(p.data[0])); },
  (p) => { p.data[0].chain = 'ethereum'; },
  (p) => { p.data[0].pool = 'DEFI'; },
  (p) => { p.data[0].userAddress = '0x0000000000000000000000000000000000000000'; },
  (p) => { p.account = '0x0000000000000000000000000000000000000000'; },
  (p) => { p.data[0].accountAddress = null; },
  (p) => { p.data[0].wallet = {}; },
  (p) => { p.address = '0x0000000000000000000000000000000000000000'; },
  (p) => { delete p.data[0].borrowLimit; },
]) {
  const bad = structuredClone(venusPayload); mutate(bad);
  assert.equal(assess(venusPreset, bad).status, 'failed');
}
const echoed = structuredClone(venusPayload);
echoed.userAddress = venusPreset.args.userAddress.toLowerCase();
echoed.data[0].account = venusPreset.args.userAddress;
assert.equal(assess(venusPreset, echoed).status, 'passed');
for (const mutate of [
  (p) => { p.data.positions = []; },
  (p) => { p.data.positions = [null]; },
  (p) => { p.data.positions.push(structuredClone(p.data.positions[0])); },
  (p) => { p.data.positions[0].chainName = 'ethereum'; },
  (p) => { p.data.positions[0].protocol = 'Uniswap'; },
  (p) => { p.data.positions[0].positionId = '1'; },
  (p) => { p.data.positions[0].positionId = 7337249; },
  (p) => { p.data.positions[0].token0.address = '0x0000000000000000000000000000000000000000'; },
  (p) => { p.data.positions[0].token0.symbol = { toLowerCase: 'bad' }; },
  (p) => { p.data.positions[0].fee = '0.3%'; },
  (p) => { p.data.positions[0].liquidity = '1.5'; },
  (p) => { delete p.data.positions[0].lowerPrice; },
]) {
  const bad = structuredClone(lpPayload); mutate(bad);
  assert.equal(assess(lpPreset, bad).status, 'failed');
}
for (const badValue of [null, '', ' ', '-1', 'NaN', 'Infinity', '1e3', '1,000', '0x10', {}, 1, NaN, Infinity]) {
  for (const field of ['borrowLimit', 'shortfall']) {
    const bad = structuredClone(venusPayload); bad.data[0][field] = badValue;
    assert.equal(assess(venusPreset, bad).status, 'failed');
  }
  for (const field of ['liquidity', 'amount0', 'amount1', 'pendingFee0', 'pendingFee1', 'currentPrice', 'lowerPrice', 'upperPrice']) {
    const bad = structuredClone(lpPayload); bad.data.positions[0][field] = badValue;
    assert.equal(assess(lpPreset, bad).status, 'failed');
  }
}
const originalPayload = JSON.stringify(lpPayload);
assess(lpPreset, lpPayload);
assert.equal(JSON.stringify(lpPayload), originalPayload, 'assessment must preserve decimal strings and payload precision');
assert.equal(assess({ ...lpPreset, id: 'unreviewed' }, lpPayload).status, 'failed');
console.log('task presets: three bindings, nested schema drift, exact scopes, decimal precision, pending, zero values and malformed outputs passed');
