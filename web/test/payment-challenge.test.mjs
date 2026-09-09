import assert from 'node:assert/strict';
import test from 'node:test';
import { canPay, formatAmount, payChallenge, paymentProblem } from '../src/lib/x402.js';
import { ERC8183 } from '../src/lib/erc8183.js';

const FROM = `0x${'1'.repeat(40)}`;
const TO = `0x${'2'.repeat(40)}`;
const challenge = (patch = {}) => ({ scheme: 'exact', network: 'eip155:56', asset: ERC8183.uToken,
  payTo: TO, maxAmountRequired: '1000000000000000000', ...patch });

test('known $U amounts display exactly, including one base unit and values beyond Number precision', () => {
  for (const [maxAmountRequired, expected] of [
    ['1000000000000000000', '1 $U'], ['1000000000000000001', '1.000000000000000001 $U'],
    ['1', '0.000000000000000001 $U'], ['0001000000000000000000', '1 $U'],
    ['123456789012345678901234567890', '123456789012.34567890123456789 $U'],
    ['115792089237316195423570985008687907853269984665640564039457584007913129639935',
      '115792089237316195423570985008687907853269984665640564039457.584007913129639935 $U'],
  ]) assert.equal(formatAmount(challenge({ maxAmountRequired })), expected);
  assert.equal(formatAmount(challenge({ asset: ERC8183.uToken.toLowerCase(), network: 'bsc' })), '1 $U');
});

test('unknown assets or networks never get labeled or scaled as $U', () => {
  assert.equal(formatAmount(challenge({ asset: TO, maxAmountRequired: '1000000', extra: { decimals: 6, symbol: '$U' } })), null);
  assert.equal(formatAmount(challenge({ network: 'eip155:1' })), null);
  assert.equal(formatAmount(challenge({ network: undefined })), null);
  for (const maxAmountRequired of [1e18, -1, '1e18', '0x10', '1.5', '9'.repeat(79)]) {
    assert.equal(formatAmount(challenge({ maxAmountRequired })), null);
  }
});

test('unsupported challenge terms are rejected before any wallet access', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let walletReads = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, get() { walletReads += 1; throw new Error('wallet touched'); } });
  try {
    const invalid = [
      null, challenge({ network: undefined }), challenge({ network: 'eip155:1' }), challenge({ network: 'malformed:56' }),
      challenge({ asset: TO }), challenge({ payTo: 'someone' }), challenge({ payTo: `0x${'0'.repeat(40)}` }),
      challenge({ scheme: 'upto' }), challenge({ maxAmountRequired: '0' }), challenge({ maxAmountRequired: 1e18 }),
      challenge({ maxAmountRequired: '1e18' }), challenge({ maxAmountRequired: '9'.repeat(79) }),
      challenge({ extra: { name: 'Other token' } }), challenge({ extra: { version: '2' } }), challenge({ amount: '1' }),
    ];
    for (const accept of invalid) {
      assert.equal(canPay(accept), false);
      await assert.rejects(payChallenge(accept));
    }
    assert.equal(canPay(challenge(), 2), false);
    await assert.rejects(payChallenge(challenge(), 2), /version 1/);
    assert.equal(walletReads, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
});

test('v1 exact and eip3009 sign only the configured BSC token domain and exact reviewed amount', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const scheme of ['exact', 'eip3009']) {
      let signed;
      const accept = challenge({ scheme, network: scheme === 'exact' ? 'bsc' : 'eip155:56', maxAmountRequired: '1000000000000000001' });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { ethereum: { request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') { accept.payTo = FROM; accept.maxAmountRequired = '9'; return [FROM]; }
        if (method === 'eth_chainId') return '0x38';
        if (method === 'eth_signTypedData_v4') { signed = JSON.parse(params[1]); return '0xsigned'; }
        throw new Error(`Unexpected wallet request ${method}`);
      } } } });
      assert.equal(canPay(accept), true);
      const payment = JSON.parse(atob(await payChallenge(accept)));
      assert.deepEqual(signed.domain, { name: 'United Stables', version: '1', chainId: 56, verifyingContract: ERC8183.uToken });
      assert.equal(signed.message.to, TO);
      assert.equal(signed.message.value, '1000000000000000001');
      assert.equal(payment.scheme, scheme);
      assert.equal(payment.x402Version, 1);
      assert.equal(payment.payload.authorization.value, '1000000000000000001');
      assert.equal(payment.payload.signature, '0xsigned');
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
});

test('a wallet that remains on another chain after switching cannot sign a payment', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ethereum: { request: async ({ method }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts') return [FROM];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'wallet_switchEthereumChain') return null;
    throw new Error('Unexpected signing request');
  } } } });
  try {
    await assert.rejects(payChallenge(challenge()), /Switch your wallet/);
    assert.equal(requests.includes('eth_signTypedData_v4'), false);
    assert.equal(paymentProblem(challenge({ extra: { name: 'United Stables', version: '1' } })), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
});

test('the signed callback runs immediately after the fake wallet signs, before payload encoding', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const btoaDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'btoa');
  const events = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ethereum: { request: async ({ method }) => {
    if (method === 'eth_requestAccounts') return [FROM];
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_signTypedData_v4') { events.push('wallet-signed'); return '0xfake-signature'; }
    throw new Error(`Unexpected wallet request ${method}`);
  } } } });
  Object.defineProperty(globalThis, 'btoa', { configurable: true, value: () => { events.push('encode'); throw new Error('fixture encoding failure'); } });
  try {
    await assert.rejects(
      payChallenge(challenge(), 1, { onSigned: () => events.push('marked-consumed') }),
      /fixture encoding failure/,
    );
    assert.deepEqual(events, ['wallet-signed', 'marked-consumed', 'encode']);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete globalThis.window;
    if (btoaDescriptor) Object.defineProperty(globalThis, 'btoa', btoaDescriptor);
    else delete globalThis.btoa;
  }
});
