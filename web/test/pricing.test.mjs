import assert from 'node:assert';
import { formatU, minPriceU, offeringPriceU, parseUBaseUnits, hireSequence } from '../src/lib/erc8183.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

// $U prices arrive from registry metadata as 18-decimal wei strings. The
// comparison table printed one of them raw — "escrow menu published · from
// 1000000000000000000 U" — because it read the field as a plain number. These
// two exist so a price can only reach a reader through the decimals.
test('formatU renders wei as the token amount a person reads', () => {
  assert.strictEqual(formatU('1000000000000000000'), '1.0 $U');
  assert.strictEqual(formatU('2500000000000000000'), '2.5 $U');
});

test('formatU refuses rather than inventing a price it cannot read', () => {
  assert.strictEqual(formatU('not a number'), '—');
  assert.strictEqual(formatU(undefined), '—');
});

test('minPriceU compares as integers, not floats', () => {
  // Two prices one wei apart. Cast to Number they are the same double, so
  // Math.min returns whichever came first; as BigNumbers they differ.
  const offerings = [
    { id: 'b', priceU: '1000000000000000001' },
    { id: 'a', priceU: '1000000000000000000' },
  ];
  assert.strictEqual(minPriceU(offerings), '1000000000000000000');
  assert.strictEqual(Number('1000000000000000001'), Number('1000000000000000000'));
});

test('minPriceU ignores unpriced and unreadable offerings', () => {
  assert.strictEqual(
    minPriceU([{ id: 'free', priceU: '0' }, { id: 'junk', priceU: 'abc' }, { id: 'ok', priceU: '3000000000000000000' }]),
    '3000000000000000000'
  );
  // Nothing quotable: the caller must be able to tell, so it says nothing
  // rather than returning a zero that would print as "from 0.0 $U".
  assert.strictEqual(minPriceU([{ id: 'negotiable', priceU: '0' }]), null);
  assert.strictEqual(minPriceU([]), null);
  assert.strictEqual(minPriceU(undefined), null);
});

test('published prices reject inexact, signed, hex, and out-of-range metadata', () => {
  const malformed = [
    '1e18', '-1', '+1', '0x10', '1.5', ' 1000000000000000000 ', '',
    1000000000000000000, 1, 0, 1n, {}, [], true,
    '115792089237316195423570985008687907853269984665640564039457584007913129639936',
    '9'.repeat(79),
  ];
  for (const priceU of malformed) {
    assert.strictEqual(parseUBaseUnits(priceU), null);
    assert.deepStrictEqual(offeringPriceU({ priceU }), { status: 'invalid', amount: null });
    assert.strictEqual(minPriceU([{ priceU }, { priceU: '2000000000000000000' }]), '2000000000000000000');
  }
  assert.strictEqual(minPriceU({ priceU: '1000000000000000000' }), null);
});

test('valid fixed and negotiated prices remain distinct from invalid prices', () => {
  assert.deepStrictEqual(offeringPriceU({ priceU: '1000000000000000001' }), {
    status: 'fixed', amount: '1000000000000000001',
  });
  for (const priceU of [undefined, null, '0', '000']) {
    assert.deepStrictEqual(offeringPriceU({ priceU }), { status: 'negotiated', amount: null });
  }
  assert.strictEqual(parseUBaseUnits('0001000000000000000000'), '1000000000000000000');
  const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  assert.strictEqual(parseUBaseUnits(max), max);
});

// No wallet exists in this test. Invalid metadata and below-floor budgets
// must be rejected before requesting accounts or constructing any contract.
try {
  let walletReads = 0;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get() { walletReads += 1; throw new Error('Wallet must not be touched'); },
  });
  try {
    for (const budgetWei of ['abc', '1e18', '-1', '0x10', 1e18]) {
      await assert.rejects(hireSequence({ budgetWei }), /Invalid escrow budget/);
    }
    await assert.rejects(hireSequence({ budgetWei: '999999999999999999' }), /at least 1 \$U/);
    assert.strictEqual(walletReads, 0);
    passed += 1;
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
} catch (err) {
  console.error(`FAIL  invalid budgets must fail before wallet preparation\n      ${err.message}`);
  process.exitCode = 1;
}

console.log(`${passed} passed, ${process.exitCode ? 'see failures above' : '0 failed'}`);
