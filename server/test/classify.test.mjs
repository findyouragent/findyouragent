import assert from 'node:assert';
import { classifyFeed } from '../src/activity/classify.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const U = '0xce24439f2d9c6a2289f741120fe202248b666666';
const WALLET = '0xwallet';
const transfer = (hash, over = {}) => ({ t: 'tx', wallet: WALLET, id: hash, hash, block: 100, direction: 'in', kind: 'transfer', ...over });
const fw = (extra = {}) => ({ kinds: new Set(['trade']), hasForwarded: false, emitters: new Set(['0xcf6e']), block: 100, ...extra });
const scan = (byTx = {}, status = 'ok') => ({ byTx: new Map(Object.entries(byTx)), status });

test('a tx with a framework event is class framework', () => {
  const out = classifyFeed([transfer('0xa')], scan({ '0xa': fw() }), WALLET);
  assert.strictEqual(out.find((e) => e.hash === '0xa').class, 'framework');
});

test('a framework tx with ActionForwarded is framework-triggered (never owner-excluded wording)', () => {
  const out = classifyFeed([transfer('0xa')], scan({ '0xa': fw({ hasForwarded: true }) }), WALLET);
  assert.strictEqual(out[0].class, 'framework-triggered');
});

test('a $U inflow with a completed scan is class payment', () => {
  const out = classifyFeed([transfer('0xa', { direction: 'in', contract: U })], scan({}, 'ok'), WALLET);
  assert.strictEqual(out[0].class, 'payment');
});

test('an ordinary transfer with a completed scan is class transfer', () => {
  const out = classifyFeed([transfer('0xa', { direction: 'out', contract: '0xtoken' })], scan({}, 'ok'), WALLET);
  assert.strictEqual(out[0].class, 'transfer');
});

test('FAIL-CLOSED: with an incomplete scan, a non-framework tx is not-checked, never transfer', () => {
  const out = classifyFeed([transfer('0xa', { direction: 'in', contract: U })], scan({}, 'throttled'), WALLET);
  // even a $U inflow must not be called "payment" if we could not rule out a framework event
  assert.strictEqual(out[0].class, 'not-checked');
});

test('a tx we DID find framework evidence for stays framework even when the scan later failed', () => {
  const out = classifyFeed([transfer('0xa')], scan({ '0xa': fw() }, 'error'), WALLET);
  assert.strictEqual(out[0].class, 'framework');
});

test('framework txs with no transfer leg become their own union rows', () => {
  const out = classifyFeed([], scan({ '0xdeadbeef': fw({ kinds: new Set(['trade']) }) }), WALLET);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].class, 'framework');
  assert.strictEqual(out[0].kind, 'trade');
  assert.strictEqual(out[0].id, 'fw:0xdeadbeef');
  assert.strictEqual(out[0].wallet, WALLET);
});

test('a framework tx that also has a transfer leg is not duplicated', () => {
  const out = classifyFeed([transfer('0xa')], scan({ '0xa': fw() }), WALLET);
  assert.strictEqual(out.filter((e) => e.hash === '0xa').length, 1);
});

test('events come out newest-block first', () => {
  const out = classifyFeed(
    [transfer('0xa', { block: 10 }), transfer('0xb', { block: 30 })],
    scan({ '0xc': fw({ block: 20 }) }),
    WALLET,
  );
  assert.deepStrictEqual(out.map((e) => e.block), [30, 20, 10]);
});

console.log(`${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
