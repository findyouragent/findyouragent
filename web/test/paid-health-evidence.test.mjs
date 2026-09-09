import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ethers from 'ethers';

const { Interface, getAddress } = ethers.utils || ethers;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public/evidence/paid-call-2026-09-09');
const load = async (name) => JSON.parse(await readFile(resolve(root, name), 'utf8'));
const word = (hex, index) => BigInt(`0x${hex.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
const lower = (value) => String(value).toLowerCase();
const scale = 10n ** 18n;

const comptroller = getAddress('0xfD36E2c2a6789Db23113685031d7F16329158384');
const oracle = getAddress('0x6592b5DE802159F3E74B2486b091D11a8256ab8A');
const account = getAddress('0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173');
const blockTag = '0x732c3b8';
const vBNB = getAddress('0xA07c5b74C9B40447a954e1466938b865b6BBea36');
const vUSDT = getAddress('0xfD5840Cd36d94D7229439859C0112a4185BC0255');
const usdt = getAddress('0x55d398326f99059fF775485246999027B3197955');

const ci = new Interface([
  'function getAccountLiquidity(address) view returns (uint256,uint256,uint256)',
  'function getBorrowingPower(address) view returns (uint256,uint256,uint256)',
  'function getAssetsIn(address) view returns (address[])',
  'function oracle() view returns (address)',
  'function mintedVAIs(address) view returns (uint256)'
]);
const vi = new Interface([
  'function getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)',
  'function symbol() view returns (string)',
  'function underlying() view returns (address)'
]);
const oi = new Interface(['function getUnderlyingPrice(address) view returns (uint256)']);
const ei = new Interface(['function decimals() view returns (uint8)']);
const mi = new Interface(['function markets(address) view returns (bool,uint256,bool,uint256,uint256,uint96,bool)']);
const SIG = {
  liquidity: ci.getSighash('getAccountLiquidity'),
  borrowingPower: ci.getSighash('getBorrowingPower'),
  assets: ci.getSighash('getAssetsIn'),
  oracle: ci.getSighash('oracle'),
  mintedVAI: ci.getSighash('mintedVAIs'),
  snapshot: vi.getSighash('getAccountSnapshot'),
  symbol: vi.getSighash('symbol'),
  underlying: vi.getSighash('underlying'),
  price: oi.getSighash('getUnderlyingPrice'),
  decimals: ei.getSighash('decimals')
};

function recordsFor(raw, method) { return raw.records.filter((record) => record.request.method === method); }
function resultFor(raw, to, selector, dataSuffix = '') {
  const record = raw.records.find((item) => item.request.method === 'eth_call' && lower(item.request.params[0].to) === lower(to) && item.request.params[0].data.startsWith(selector) && item.request.params[0].data.endsWith(dataSuffix.toLowerCase()));
  assert.ok(record, `missing eth_call ${to} ${selector}`);
  const body = JSON.parse(record.responseText);
  assert.equal(body.id, record.request.id);
  assert.equal(record.status, 200);
  assert.equal(record.request.params[1], blockTag);
  return body.result;
}
function assertAddressArgument(raw, to, selector, expected) {
  const record = raw.records.find((item) => item.request.method === 'eth_call' && lower(item.request.params[0].to) === lower(to) && item.request.params[0].data.startsWith(selector));
  assert.ok(record);
  assert.equal(record.request.params[0].data, `${selector}${lower(expected).slice(2).padStart(64, '0')}`);
}
function roundFixed(raw, decimals, places) {
  const value = BigInt(raw);
  const divisor = 10n ** BigInt(decimals - places);
  return ((value + divisor / 2n) / divisor).toString().padStart(places + 1, '0').replace(new RegExp(`(?=.{${places}}$)`), '.');
}
function roundRatio(numerator, denominator, places) {
  const unit = 10n ** BigInt(places);
  const rounded = (numerator * unit * 2n + denominator) / (2n * denominator);
  const text = rounded.toString().padStart(places + 1, '0');
  return `${text.slice(0, -places)}.${text.slice(-places)}`;
}
function verifyHashesAndIds(raw) {
  const ids = raw.records.map((record) => record.request.id);
  assert.equal(new Set(ids).size, ids.length, 'RPC request IDs must be unique');
  for (const record of raw.records) {
    assert.equal(record.sha256, createHash('sha256').update(record.responseText).digest('hex'));
    const body = JSON.parse(record.responseText);
    assert.equal(body.id, record.request.id);
    assert.equal(record.status, 200);
    assert.equal(body.error, undefined);
    assert.ok(['eth_call', 'eth_getBlockByNumber', 'eth_chainId'].includes(record.request.method));
    if (record.request.method === 'eth_call') assert.equal(record.request.params[1], blockTag);
  }
}

async function fixture() {
  const result = await load('paid-result.json');
  const health = await load('health-verification/health-corroboration.json');
  const raw = await load('health-verification/rpc-raw.json');
  const semantics = await load('health-verification/market-semantics.json');
  const payment = await load('onchain/payment-verification.json');
  return { result, health, raw, semantics, payment };
}

function validate({ result, health, raw, semantics, payment }) {
  verifyHashesAndIds(raw);
  verifyHashesAndIds(semantics);

  assert.equal(JSON.parse(raw.records[0].responseText).result, '0x38');
  assert.equal(raw.records.every((record) => record.request.method !== 'eth_sendRawTransaction'), true);
  assert.equal(health.status, 'complete');
  assert.equal(health.chainId, 56);
  assert.equal(health.blockNumber, 120767416);
  assert.equal(health.blockTag, blockTag);
  assert.equal(getAddress(health.account), account);
  assert.equal(getAddress(health.comptroller), comptroller);
  assert.equal(getAddress(health.oracle), oracle);
  assert.equal(health.mintedVAIRaw, '0');
  assert.equal(result.response.body.result.parts[0].text.includes('Observation time: now'), true);
  const text = result.response.body.result.parts[0].text;
  assert.equal(text.match(/Health factor: (\d+\.\d+)/)[1], health.providerReported.healthFactor);
  assert.equal(text.match(/Borrowed value: \$(\d+\.\d+)/)[1], health.providerReported.borrowedUsd);
  assert.equal(text.match(/Remaining borrowing headroom before liquidation: \$(\d+\.\d+)/)[1], health.providerReported.headroomUsd);
  assert.equal(result.observation.task.status, 'not_evaluated');

  const blocks = recordsFor(raw, 'eth_getBlockByNumber');
  assert.ok(blocks.length >= 2);
  const block = JSON.parse(blocks[0].responseText).result;
  for (const record of blocks) {
    const header = JSON.parse(record.responseText).result;
    assert.equal(record.request.params[0], blockTag);
    assert.equal(header.number, blockTag);
    assert.equal(header.hash, payment.block.hash);
    assert.equal(header.timestamp, block.timestamp);
  }
  assert.equal(block.number, blockTag);
  assert.equal(block.hash, health.blockHash);
  assert.equal(new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString(), health.blockTimestamp);
  assert.equal(payment.block.number, health.blockNumber);
  assert.equal(payment.block.hash, health.blockHash);
  assert.equal(payment.block.timestamp, health.blockTimestamp);
  assert.ok(Date.parse(health.blockTimestamp) >= Date.parse(result.observation.startedAt));
  assert.ok(Date.parse(health.blockTimestamp) <= Date.parse(result.observation.finishedAt));
  for (const record of recordsFor(raw, 'eth_call')) assert.equal(record.request.params[1], blockTag);

  const liquidity = ci.decodeFunctionResult('getAccountLiquidity', resultFor(raw, comptroller, SIG.liquidity));
  const borrowingPower = ci.decodeFunctionResult('getBorrowingPower', resultFor(raw, comptroller, SIG.borrowingPower));
  assert.equal(liquidity[0].toString(), '0');
  assert.equal(liquidity[2].toString(), '0');
  assert.equal(borrowingPower[0].toString(), '0');
  for (const selector of [SIG.liquidity, SIG.borrowingPower, SIG.assets, SIG.mintedVAI]) assertAddressArgument(raw, comptroller, selector, account);
  assert.equal(liquidity[0].toString(), health.liquidity.errorCode);
  assert.equal(liquidity[1].toString(), health.liquidity.liquidityRaw);
  assert.equal(liquidity[2].toString(), health.liquidity.shortfallRaw);
  assert.deepEqual(borrowingPower.map((value) => value.toString()), [health.borrowingPower.errorCode, health.borrowingPower.availableRaw, health.borrowingPower.deficitRaw]);
  assert.equal(borrowingPower[1].toString(), liquidity[1].toString());
  assert.equal(borrowingPower[2].toString(), liquidity[2].toString());
  const assets = ci.decodeFunctionResult('getAssetsIn', resultFor(raw, comptroller, SIG.assets))[0].map(getAddress);
  assert.deepEqual(assets, [vBNB, vUSDT]);
  assert.equal(getAddress(ci.decodeFunctionResult('oracle', resultFor(raw, comptroller, SIG.oracle))[0]), oracle);
  assert.equal(ci.decodeFunctionResult('mintedVAIs', resultFor(raw, comptroller, SIG.mintedVAI))[0].toString(), '0');

  const markets = [
    { address: vBNB, snapshot: SIG.snapshot, symbol: SIG.symbol, price: SIG.price, decimals: null, expectedDecimals: 18 },
    { address: vUSDT, snapshot: SIG.snapshot, symbol: SIG.symbol, price: SIG.price, decimals: SIG.decimals, expectedDecimals: 18 }
  ];
  let debtRaw = 0n;
  let weightedCollateralRaw = 0n;
  for (const market of markets) {
    const snapshot = vi.decodeFunctionResult('getAccountSnapshot', resultFor(raw, market.address, market.snapshot));
    assertAddressArgument(raw, market.address, market.snapshot, account);
    assert.equal(snapshot[0].toString(), '0');
    const price = oi.decodeFunctionResult('getUnderlyingPrice', resultFor(raw, oracle, market.price, market.address.slice(2)))[0];
    assert.ok(price.gt(0));
    const borrowUsd = snapshot[2].mul(price).div(ethers.constants.WeiPerEther);
    debtRaw += BigInt(borrowUsd.toString());
    assert.equal(vi.decodeFunctionResult('symbol', resultFor(raw, market.address, market.symbol))[0], market.address === vBNB ? 'vBNB' : 'vUSDT');
    if (market.decimals) {
      assert.equal(vi.decodeFunctionResult('underlying', resultFor(raw, market.address, SIG.underlying))[0], usdt);
      assert.equal(ei.decodeFunctionResult('decimals', resultFor(raw, usdt, market.decimals))[0].toString(), String(market.expectedDecimals));
    }

    const semantic = semantics.markets.find((item) => lower(item.vToken) === lower(market.address));
    assert.ok(semantic);
    const rawMarket = resultFor(semantics, comptroller, mi.getSighash('markets'), market.address.slice(2));
    assert.equal(rawMarket, semantic.raw);
    assert.equal(semantic.wordCount, 7);
    assert.equal(semantic.raw.length, 2 + 64 * 7);
    assert.equal(word(semantic.raw, 0), 1n);
    assert.equal(word(semantic.raw, 1), 800000000000000000n);
    assert.equal(word(semantic.raw, 3), 800000000000000000n);
    assert.equal(semantic.isListed, true);
    assert.equal(semantic.collateralFactorMantissa, '800000000000000000');
    assert.equal(semantic.liquidationThresholdMantissa, '800000000000000000');
    const tokensToDenom = BigInt(snapshot[3].toString()) * BigInt(price.toString()) / scale;
    const marketSupply = tokensToDenom * BigInt(snapshot[1].toString()) / scale;
    weightedCollateralRaw += marketSupply * 800000000000000000n / scale;
  }
  assert.equal(debtRaw.toString(), health.totals.borrowUsdRaw);
  assert.equal(weightedCollateralRaw.toString(), health.totals.impliedAdjustedCollateralUsdRaw);
  assert.equal((weightedCollateralRaw - debtRaw).toString(), health.liquidity.liquidityRaw);
  assert.equal(roundFixed(debtRaw, 18, 2), health.providerReported.borrowedUsd);
  assert.equal(roundFixed(BigInt(health.liquidity.liquidityRaw), 18, 2), health.providerReported.headroomUsd);
  assert.equal(roundRatio(weightedCollateralRaw, debtRaw, 3), health.providerReported.healthFactor);
  assert.equal(health.comparison.debtMatches, true);
  assert.equal(health.comparison.liquidityMatches, true);
  assert.equal(health.comparison.healthMatches, true);
}

test('reconstructs paid Venus health from exact-block raw RPC evidence', async () => {
  validate(await fixture());
});

test('semantic contradictions fail even when response hashes are recomputed', async () => {
  const original = await fixture();
  const find = (raw, selector, target) => raw.records.find(r => r.request.method === 'eth_call' && r.request.params[0].data.startsWith(selector) && (!target || lower(r.request.params[0].to) === lower(target)));
  const rewrite = (record, mutate) => {
    const body = JSON.parse(record.responseText);
    mutate(body);
    record.responseText = JSON.stringify(body);
    record.sha256 = createHash('sha256').update(record.responseText).digest('hex');
  };
  const scenarios = [
    ['historical block', f => rewrite(recordsFor(f.raw, 'eth_getBlockByNumber')[1], b => { b.result.hash = `0x${'0'.repeat(64)}`; })],
    ['oracle price', f => rewrite(find(f.raw, SIG.price), b => { b.result = oi.encodeFunctionResult('getUnderlyingPrice', [1]); })],
    ['borrow snapshot', f => rewrite(find(f.raw, SIG.snapshot, vUSDT), b => { const snap = vi.decodeFunctionResult('getAccountSnapshot', b.result); b.result = vi.encodeFunctionResult('getAccountSnapshot', [0, snap[1], snap[2].mul(2), snap[3]]); })],
    ['VAI debt', f => rewrite(find(f.raw, SIG.mintedVAI), b => { b.result = ci.encodeFunctionResult('mintedVAIs', [1]); })],
    ['account argument', f => { find(f.raw, SIG.liquidity).request.params[0].data = ci.encodeFunctionData('getAccountLiquidity', [usdt]); }],
    ['market threshold', f => rewrite(find(f.semantics, mi.getSighash('markets')), b => { b.result = mi.encodeFunctionResult('markets', [true, scale * 8n / 10n, true, scale * 9n / 10n, scale, 0, true]); })],
    ['provider amount', f => { f.result.response.body.result.parts[0].text = f.result.response.body.result.parts[0].text.replace('$1.74', '$9.74'); }],
  ];
  for (const [name, mutate] of scenarios) {
    const copy = structuredClone(original);
    mutate(copy);
    verifyHashesAndIds(copy.raw);
    verifyHashesAndIds(copy.semantics);
    assert.throws(() => validate(copy), undefined, name);
  }
});
