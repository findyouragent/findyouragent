import assert from 'node:assert/strict';
import { runCacheKey, makeRunRecord, runState } from '../src/lib/try-record.js';

const context = { chainId: 56, tokenId: '45422', request: { protocol: 'mcp', tool: 'getVaultsWithChains', arguments: { chainNames: ['bsc'] } }, startedAt: '2026-09-07T21:00:00.000Z', finishedAt: '2026-09-07T21:00:02.000Z' };
const observation = { version: 1, runId: 'run-one', startedAt: context.startedAt, finishedAt: context.finishedAt, outcome: 'response_received', captureComplete: true, task: { status: 'passed' } };
const body = { result: { structuredContent: { data: Array.from({ length: 40 }, (_, i) => ({ id: i })) } } };
const paymentReceipt = { provider: 'example', reference: 'receipt-123', status: 'paid' };
const result = {
  status: 200,
  body,
  observation,
  endpoint: 'https://example.org/mcp',
  headers: { Authorization: 'not-exported' },
  paymentReceipt,
  payment: 'not-exported',
  authorization: 'not-exported',
  paymentSignature: 'not-exported',
};
const record = makeRunRecord(result, context);
assert.equal(runState(record), 'passed');
assert.deepEqual(record.response.paymentReceipt, paymentReceipt, 'Provider payment receipt is preserved in the export record');
assert.deepEqual(JSON.parse(JSON.stringify(record)).response.paymentReceipt, paymentReceipt, 'Provider payment receipt survives JSON serialization');
const incomplete = makeRunRecord({ ...result, observation: { ...observation, task: { status: 'incomplete', corroboration: { status: 'incomplete', evidence: [{ responseText: 'rpc unavailable' }] } } } }, context);
assert.equal(runState(incomplete), 'incomplete');
assert.deepEqual(incomplete.response.body, body, 'Incomplete corroboration retains original provider response');
assert.equal(incomplete.observation.task.corroboration.evidence[0].responseText, 'rpc unavailable');
assert.deepEqual(JSON.parse(JSON.stringify(record)).response.body, body);
assert.equal(record.response.body.result.structuredContent.data.length, 40);
assert.equal(record.observation.finishedAt, context.finishedAt);
assert.equal(JSON.stringify(record).includes('not-exported'), false);
assert.equal(JSON.stringify(record).includes('paymentSignature'), false);
assert.equal(JSON.stringify(record).includes('Authorization'), false);
assert.equal(makeRunRecord({ ...result, paymentReceipt: undefined }, context).response.paymentReceipt, null, 'Missing payment receipt is explicit null');
const receiptOnly = makeRunRecord({ status: 200, body, paymentReceipt }, context);
assert.equal(runState(receiptOnly), 'unknown', 'A receipt alone does not classify or pass a run');
assert.equal(runState(makeRunRecord({ ...result, observation: { ...observation, outcome: 'pending', task: { status: 'pending' } } }, context)), 'pending');
assert.equal(runState(makeRunRecord({ status: 200, body: { result: { isError: true, content: [{ type: 'text', text: 'failed' }] } } }, context)), 'error');
assert.equal(runState(makeRunRecord({ status: 200, body }, context)), 'unknown');
assert.equal(runState(makeRunRecord({ status: 402 }, context)), 'payment');
assert.equal(makeRunRecord({ ...result, observation: { ...observation, captureComplete: false } }, context).response.captureComplete, false);
assert.deepEqual(makeRunRecord({ ...result, taskPreset: { id: 'p', version: 1, tool: 'actual', args: { actual: true } } }, context).request.arguments, { actual: true });
const a = runCacheKey(56, 1, { tool: 'x', args: { b: 2, a: 1 }, version: 1 });
assert.equal(a, runCacheKey('56', '1', { version: 1, args: { a: 1, b: 2 }, tool: 'x' }));
assert.notEqual(a, runCacheKey(56, 1, { tool: 'x', args: { b: 3, a: 1 }, version: 1 }));
assert.notEqual(a, runCacheKey(56, 1, { tool: 'x', args: { b: 2, a: 1 }, version: 2 }));
console.log('try records: full payload, provenance, error fallback, pending and cache identity passed');
