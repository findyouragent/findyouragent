import assert from 'node:assert';
import { minOfferingPriceU } from '../src/verify/run.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

test('picks the cheapest priced offering', () => {
  assert.strictEqual(
    minOfferingPriceU({ offerings: [{ priceU: '5000000000000000000' }, { priceU: '1000000000000000000' }] }),
    '1000000000000000000',
  );
});

test('compares as integers, not strings ("9" must not beat "10")', () => {
  // String comparison would pick '10...' here because '1' < '9'.
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: '9' }, { priceU: '10' }] }), '9');
});

test('a menu with no priced offering is null, never zero', () => {
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: '0' }, { label: 'negotiable' }] }), null);
  assert.strictEqual(minOfferingPriceU({ offerings: [] }), null);
  assert.strictEqual(minOfferingPriceU(null), null);
});

test('hostile or malformed prices are ignored, not coerced', () => {
  // Prices are authored by the party being assessed.
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: '-1' }, { priceU: '2000' }] }), '2000');
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: '1e18' }, { priceU: '2000' }] }), '2000');
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: '0x10' }, { priceU: '2000' }] }), '2000');
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: ' 5 ' }, { priceU: '2000' }] }), '2000');
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: {} }, { priceU: '2000' }] }), '2000');
  // Absurdly long digit strings are rejected rather than turned into a BigInt.
  assert.strictEqual(minOfferingPriceU({ offerings: [{ priceU: '9'.repeat(60) }, { priceU: '2000' }] }), '2000');
});

test('offerings that is not an array does not throw', () => {
  assert.strictEqual(minOfferingPriceU({ offerings: 'nope' }), null);
});

console.log(`${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
