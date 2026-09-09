import assert from 'node:assert/strict';
import { createAgentDetailHandler } from '../src/agent-detail.js';

function response() {
  return { statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}
const req = { params: { chainId: '56', tokenId: '45422' } };
const detail = { chain_id: 56, token_id: '45422', name: 'Public fixture', services: { mcp: { endpoint: 'https://provider.example/mcp' } } };
const out = response();
await createAgentDetailHandler(async (...ids) => { assert.deepEqual(ids, ['56', '45422']); return detail; })(req, out);
assert.equal(out.statusCode, 200);
assert.deepEqual(out.body, { data: detail, source: '8004scan' });

for (const params of [{ chainId: 'https://other.example', tokenId: '1' }, { chainId: '56', tokenId: '../secret' }]) {
  const bad = response();
  await createAgentDetailHandler(() => { throw new Error('lookup must not run'); })({ params }, bad);
  assert.equal(bad.statusCode, 400);
}
for (const value of [null, undefined]) {
  const missing = response();
  await createAgentDetailHandler(async () => value)(req, missing);
  assert.equal(missing.statusCode, 404);
}
for (const value of [[], 'not a registry object', { ...detail, token_id: '999' }, { ...detail, chain_id: 1 }]) {
  const malformed = response();
  await createAgentDetailHandler(async () => value)(req, malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(malformed.body.error, 'registry-invalid-response');
  assert.equal(malformed.body.retryable, false);
}
for (const [err, status, error] of [
  [{ status: 404 }, 404, 'agent-not-found'],
  [{ status: 429 }, 503, 'registry-throttled'],
  [{ rateLimited: true }, 503, 'registry-throttled'],
  [new Error('network failure'), 502, 'registry-unavailable'],
]) {
  const failed = response();
  await createAgentDetailHandler(async () => { throw err; })(req, failed);
  assert.equal(failed.statusCode, status);
  assert.equal(failed.body.error, error);
  if (status === 503) assert.equal(failed.headers['retry-after'], '60');
}
console.log('agent detail: numeric boundary, full public payload, not-found, malformed upstream and retryable errors passed');

const delayed = response();
await createAgentDetailHandler(async () => { throw { status: 429, retryAfterSeconds: 7200 }; })(req, delayed);
assert.equal(delayed.headers['retry-after'], '7200');
const contractFailure = response();
await createAgentDetailHandler(async () => { throw { code: 'registry-invalid-response' }; })(req, contractFailure);
assert.equal(contractFailure.body.error, 'registry-invalid-response');
assert.equal(contractFailure.body.retryable, false);
