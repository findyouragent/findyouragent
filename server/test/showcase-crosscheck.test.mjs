import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FIXTURE, positionsCall, decodePosition, providerPosition, comparePosition, verdict, readReferencePosition, replayCrosscheck } from '../showcase-crosscheck.mjs';

const historical = JSON.parse(await fs.readFile(new URL('../../web/public/evidence/records/pancake-bsc-lp-position.json', import.meta.url), 'utf8'));
const p = providerPosition(historical);
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const lower = Math.round(Math.log(Number(p.lowerPrice)) / Math.log(1.0001));
const upper = Math.round(Math.log(Number(p.upperPrice)) / Math.log(1.0001));
const values = [0, 0, p.token0.address, p.token1.address, 500, lower, upper, p.liquidity, 0, 0, 0, 0];
const abi = `0x${values.map(word).join('')}`;
const chain = { chainId: 56, block: { number: '0x123', numberDecimal: '291', hashStable: true }, position: decodePosition(abi), decimals0: 18, decimals1: 18 };

test('ABI positions selector and uint256 token encoding match the reviewed call', () => {
  assert.equal(positionsCall(), `0x99fbab88${BigInt(FIXTURE.positionId).toString(16).padStart(64, '0')}`);
  for (const bad of ['-1', '7.2', '0x12', '1e6', (2n ** 256n).toString()]) assert.throws(() => positionsCall(bad));
});

test('decoding preserves bigint liquidity and signed ticks; malformed ABI cannot pass', () => {
  assert.equal(chain.position.liquidity, p.liquidity);
  assert.ok(chain.position.tickLower < 0);
  assert.equal(chain.position.tickLower, lower);
  assert.equal(chain.position.tickUpper, upper);
  assert.throws(() => decodePosition('0x'));
  assert.throws(() => decodePosition(`${abi}00`));
  const unsignedNegative = [...values]; unsignedNegative[5] = BigInt.asUintN(24, BigInt(lower));
  assert.throws(() => decodePosition(`0x${unsignedNegative.map(word).join('')}`), /sign extension/);
  const excessLiquidity = [...values]; excessLiquidity[7] = 2n ** 128n;
  assert.throws(() => decodePosition(`0x${excessLiquidity.map(word).join('')}`), /uint128/);
});

test('agreement remains qualified and never claims same-block dynamic validation', () => {
  const checks = comparePosition(historical, chain);
  assert.equal(verdict(checks), 'corroborated-with-limits');
  assert.equal(checks.find((c) => c.id === 'same-block').status, 'unknown');
  assert.equal(checks.find((c) => c.id === 'dynamic-values').status, 'unknown');
  assert.equal(checks.find((c) => c.id === 'liquidity').critical, false);
});

test('wrong identity, address, fee, or range is a critical mismatch', () => {
  for (const change of [
    (p) => { p.positionId = '1'; },
    (p) => { p.token0.address = '0x0000000000000000000000000000000000000001'; },
    (p) => { p.fee = '0.3%'; },
    (p) => { p.upperPrice = '0.99'; },
  ]) {
    const changed = structuredClone(historical);
    change(changed.response.body.result.structuredContent.data.positions[0]);
    assert.equal(verdict(comparePosition(changed, chain)), 'failed');
  }
});

test('later liquidity differences and unavailable data are not falsely marked failed or passed', () => {
  const changedChain = structuredClone(chain); changedChain.position.liquidity = '0';
  const checks = comparePosition(historical, changedChain);
  assert.equal(checks.find((c) => c.id === 'liquidity').status, 'unknown');
  assert.equal(verdict(checks), 'corroborated-with-limits');
  assert.equal(verdict(comparePosition(historical, {})), 'incomplete');
  assert.equal(verdict(comparePosition(null, chain)), 'incomplete');
  const noDecimals = structuredClone(chain); delete noDecimals.decimals1;
  assert.equal(verdict(comparePosition(historical, noDecimals)), 'incomplete');
});

test('reference reader pins every contract call to one block and confirms its hash', async () => {
  const calls = [];
  const block = { number: '0x123', hash: `0x${'a'.repeat(64)}`, timestamp: '0x65000000' };
  const result = await readReferencePosition(async (name, method, params) => {
    calls.push({ name, method, params });
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return block;
    if (params[0].data === positionsCall()) return abi;
    if (params[0].data === '0x313ce567') return `0x${word(18)}`;
    throw new Error('Unexpected method');
  });
  assert.equal(result.block.hashStable, true);
  assert.equal(result.decimals0, 18);
  assert.equal(result.decimals1, 18);
  for (const call of calls.filter((c) => c.method === 'eth_call')) assert.equal(call.params[1], block.number);
  assert.deepEqual(calls.at(-1).params, [block.number, false]);
  assert.ok(calls.every((c) => ['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(c.method)));
});

test('wrong chain stops reads; changed block hash is explicit', async () => {
  let calls = 0;
  assert.deepEqual(await readReferencePosition(async () => { calls++; return '0x1'; }), { chainId: 1 });
  assert.equal(calls, 1);
  let blocks = 0;
  const result = await readReferencePosition(async (name, method, params) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBlockByNumber') return { number: '0x123', hash: `0x${(++blocks === 1 ? 'a' : 'b').repeat(64)}`, timestamp: '0x65000000' };
    return params[0].data === positionsCall() ? abi : `0x${word(18)}`;
  });
  assert.equal(result.block.hashStable, false);
});

test('offline replay checks file integrity and refuses a changed verdict', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fya-crosscheck-test-'));
  const data = Buffer.from('null\n');
  const report = { recordType: 'fya-public-position-crosscheck', verdict: 'incomplete', checks: comparePosition(null, {}),
    files: [{ path: 'selected-provider-record.json', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] };
  try {
    await fs.writeFile(path.join(folder, 'selected-provider-record.json'), data);
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report));
    assert.equal((await replayCrosscheck(folder)).replayMatches, true);
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify({ ...report, verdict: 'corroborated-with-limits' }));
    await assert.rejects(replayCrosscheck(folder), /verdict differs/);
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report));
    await fs.writeFile(path.join(folder, 'selected-provider-record.json'), '{}\n');
    await assert.rejects(replayCrosscheck(folder), /Hash mismatch/);
    report.files[0].path = '../outside.json';
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report));
    await assert.rejects(replayCrosscheck(folder), /Unsafe evidence path/);
  } finally {
    await fs.unlink(path.join(folder, 'selected-provider-record.json'));
    await fs.unlink(path.join(folder, 'report.json'));
    await fs.rmdir(folder);
  }
});
