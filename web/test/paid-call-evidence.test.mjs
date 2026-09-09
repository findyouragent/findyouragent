import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ethers from 'ethers';
const { Interface, id, getAddress } = ethers.utils || ethers;
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public/evidence/paid-call-2026-09-09');
const load = async (name) => JSON.parse(await readFile(resolve(root, name), 'utf8'));
const verify = async (name) => {
  const bytes = await readFile(resolve(root, name));
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};

function validate(record, quote, payment, raw, result) {
  assert.equal(record.observation.endpoint, 'https://api.bortagent.xyz/api/a2a/11168');
  assert.equal(record.observation.transport.status, 200);
  assert.equal(record.observation.latencyMs, 9397);
  assert.equal(quote.response.body.accepts[0].amount, '100000000000000000');
  assert.equal(quote.response.body.accepts[0].payTo.toLowerCase(), payment.payTo.toLowerCase());
  assert.equal(quote.response.body.accepts[0].asset.toLowerCase(), payment.token.toLowerCase());
  assert.equal(payment.receipt.status, '0x1');
  assert.equal(payment.receipt.to.toLowerCase(), payment.token.toLowerCase());
  assert.equal(payment.calldata.to.toLowerCase(), payment.payTo.toLowerCase());
  assert.equal(payment.calldata.valueRaw, payment.expectedAmountRaw);
  const transfer = payment.tokenTransferLogs.find((log) => log.to.toLowerCase() === payment.payTo.toLowerCase());
  assert.ok(transfer);
  assert.equal(transfer.address.toLowerCase(), payment.token.toLowerCase());
  assert.equal(transfer.amountRaw, payment.expectedAmountRaw);
  assert.equal(payment.block.timestamp, payment.checks.requestWindow.blockTimestamp);
  const started = Date.parse(payment.checks.requestWindow.startedAt);
  const finished = Date.parse(payment.checks.requestWindow.finishedAt);
  const blockTime = Date.parse(payment.block.timestamp);
  assert.ok(blockTime >= started && blockTime <= finished);
  assert.equal(result.request.paymentSubmitted, true);
  const tx = JSON.parse(raw.records.find((r) => r.request.method === 'eth_getTransactionByHash').responseText).result;
  const receipt = JSON.parse(raw.records.find((r) => r.request.method === 'eth_getTransactionReceipt').responseText).result;
  const block = JSON.parse(raw.records.find((r) => r.request.method === 'eth_getBlockByNumber').responseText).result;
  assert.equal(JSON.parse(raw.records[0].responseText).result, '0x38');
  assert.equal(tx.hash.toLowerCase(), payment.txHash.toLowerCase());
  assert.equal(tx.to.toLowerCase(), payment.token.toLowerCase());
  assert.equal(receipt.status, '0x1');
  assert.equal(receipt.transactionHash.toLowerCase(), payment.txHash.toLowerCase());
  assert.equal(Number.parseInt(receipt.blockNumber, 16), payment.block.number);
  assert.equal(Number.parseInt(block.timestamp, 16), payment.block.timestampUnix);
  const iface = new Interface(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)']);
  const decoded = iface.decodeFunctionData('transferWithAuthorization', tx.input);
  assert.equal(decoded.to.toLowerCase(), payment.calldata.to.toLowerCase());
  assert.equal(decoded.value.toString(), payment.calldata.valueRaw);
  assert.equal(tx.input.slice(0, 10), '0xcf092995');
  const transferLog = receipt.logs.find((log) => log.topics[0] === id('Transfer(address,address,uint256)'));
  const authLog = receipt.logs.find((log) => log.topics[0] === id('AuthorizationUsed(address,bytes32)'));
  assert.ok(transferLog && authLog);
  assert.equal(transferLog.address.toLowerCase(), payment.token.toLowerCase());
  assert.equal(authLog.address.toLowerCase(), payment.token.toLowerCase());
  assert.equal(getAddress(`0x${transferLog.topics[1].slice(-40)}`), getAddress(decoded.from));
  assert.equal(getAddress(`0x${transferLog.topics[2].slice(-40)}`), getAddress(decoded.to));
  assert.equal(BigInt(transferLog.data).toString(), decoded.value.toString());
  assert.equal(getAddress(`0x${authLog.topics[1].slice(-40)}`), getAddress(decoded.from));
  assert.equal(authLog.topics[2].toLowerCase(), decoded.nonce.toLowerCase());
  const requestStarted = Date.parse(record.observation.startedAt);
  const requestFinished = Date.parse(record.observation.finishedAt);
  const rawBlockTime = Number.parseInt(block.timestamp, 16) * 1000;
  assert.ok(rawBlockTime >= requestStarted && rawBlockTime <= requestFinished);
}

test('published paid-call artifacts retain source bytes and manifest hashes', async () => {
  const manifest = await load('index.json');
  assert.equal(manifest.recordType, 'fya-paid-call-evidence');
  assert.equal(manifest.sameTeamProvider, true);
  assert.equal(manifest.healthCorrectness, 'corroborated-at-settlement-block');
  assert.equal(manifest.healthVerification.providerObservationBlockKnown, false);
  assert.equal(manifest.healthVerification.originalTaskStatus, 'not_evaluated');
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.href, /^\/evidence\/paid-call-2026-09-09\//);
    assert.equal(artifact.href.includes('..'), false);
    const actual = await verify(artifact.href.replace('/evidence/paid-call-2026-09-09/', ''));
    assert.deepEqual(actual, { bytes: artifact.bytes, sha256: artifact.sha256 }, artifact.href);
  }
  const health = await load('health-at-settlement/health-corroboration.json');
  assert.equal(health.status, 'incomplete');
  assert.match(health.error, /missing trie node/);
});

test('paid response, quote, raw receipt and logs prove the matching settlement', async () => {
  const result = await load('paid-result.json');
  const quote = await load('payment-challenge.json');
  const payment = await load('onchain/payment-verification.json');
  const raw = await load('onchain/rpc-raw.json');
  validate(result, quote, payment, raw, result);
});

test('tampered amount, recipient, or result status fails validation', async () => {
  const result = await load('paid-result.json');
  const quote = await load('payment-challenge.json');
  const payment = await load('onchain/payment-verification.json');
  const raw = await load('onchain/rpc-raw.json');
  for (const [mutatePayment, mutateResult] of [
    [(p) => { p.calldata.valueRaw = '1'; }, () => {}],
    [(p) => { p.payTo = '0x0000000000000000000000000000000000000001'; }, () => {}],
    [() => {}, (r) => { r.observation.transport.status = 402; }]
  ]) {
    const copy = structuredClone(payment);
    const response = structuredClone(result);
    mutatePayment(copy); mutateResult(response);
    assert.throws(() => validate(response, quote, copy, raw, response));
  }
});
