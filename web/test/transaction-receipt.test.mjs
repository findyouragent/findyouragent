import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSuccessfulReceipt } from '../src/lib/transaction-receipt.js';

const intent = { from: '0xBuyer', to: '0xKernel', data: '0x1234', value: '0', nonce: 7, chainId: 56 };
const mined = { status: 1, transactionHash: '0xReplacement' };
function replacementError(patch = {}) {
  return Object.assign(new Error('transaction replaced'), { code: 'TRANSACTION_REPLACED', cancelled: false, reason: 'repriced',
    replacement: { ...intent, hash: mined.transactionHash }, receipt: mined, ...patch });
}
const rejected = (error) => ({ ...intent, wait: async () => { throw error; } });

test('normal and repriced successful receipts resolve with the mined hash', async () => {
  assert.equal(await waitForSuccessfulReceipt({ wait: async () => mined }), mined);
  assert.equal(await waitForSuccessfulReceipt(Promise.resolve(rejected(replacementError()))), mined);
});

test('cancellations, different intent, failed receipts, and unrelated errors remain failures', async () => {
  const errors = [
    new Error('RPC disconnected'), replacementError({ cancelled: true }), replacementError({ reason: 'cancelled' }),
    replacementError({ reason: 'replaced' }), replacementError({ receipt: { ...mined, status: 0 } }),
    replacementError({ receipt: { ...mined, status: undefined } }),
    replacementError({ receipt: { ...mined, transactionHash: '0xOther' } }), replacementError({ replacement: null }),
    ...Object.entries({ from: '0xOther', to: '0xOther', data: '0x5678', value: '1', nonce: 8, chainId: 1 })
      .map(([key, value]) => replacementError({ replacement: { ...intent, hash: mined.transactionHash, [key]: value } })),
  ];
  for (const error of errors) await assert.rejects(waitForSuccessfulReceipt(rejected(error)), (caught) => caught === error);
  await assert.rejects(waitForSuccessfulReceipt({ wait: async () => ({ status: 0 }) }), /did not complete/);
});
