import assert from 'node:assert/strict';
import test from 'node:test';
import { verificationError } from '../src/lib/verification-error.js';

const detail = 'The agent identity file could not be read. The previous completed check is unchanged.';
const flags = (error) => ({ code: error.code, source: error.source, retryable: error.retryable,
  identityUnavailable: error.identityUnavailable, throttled: error.throttled, message: error.message });

test('JSON 503 and SSE identity failures retain identical typed causes without claiming throttling', () => {
  const json = verificationError({ error: 'identity-unavailable', source: 'agent-identity', retryable: true, detail }, { status: 503 });
  const sse = verificationError({ step: 'error', code: 'identity-unavailable', source: 'agent-identity', retryable: true, throttled: false, message: detail });
  assert.ok(json instanceof Error);
  assert.deepEqual(flags(json), { code: 'identity-unavailable', source: 'agent-identity', retryable: true,
    identityUnavailable: true, throttled: false, message: detail });
  assert.deepEqual(flags(sse), flags(json));
  assert.equal(json.status, 503);
});

test('genuine JSON registry throttling and legacy SSE throttling remain distinguishable', () => {
  const json = verificationError({ error: 'registry-throttled', source: '8004scan', detail: 'Registry budget exhausted.', retryable: true }, { status: 503 });
  assert.equal(json.throttled, true);
  assert.equal(json.identityUnavailable, false);
  assert.equal(json.source, '8004scan');
  assert.equal(json.message, 'Registry budget exhausted.');
  assert.equal(verificationError({ step: 'error', throttled: true, message: 'rate limit' }).throttled, true);
  assert.equal(verificationError({}, { status: 429 }).throttled, true);
});

test('generic 503 failures do not manufacture a throttling or identity diagnosis', () => {
  for (const body of [{}, null, [], 'unavailable', { error: 'registry-unavailable', retryable: false }, { throttled: 'true' }]) {
    const error = verificationError(body, { status: 503 });
    assert.equal(error.throttled, false);
    assert.equal(error.identityUnavailable, false);
    assert.equal(error.message, 'Verification is unavailable (HTTP 503).');
  }
  assert.equal(verificationError({ retryable: false }).retryable, false);
  assert.equal(verificationError({ retryable: 'true' }).retryable, undefined);
});

test('an explicit identity error keeps its diagnosis even when legacy flags conflict', () => {
  const error = verificationError({ code: 'identity-unavailable', throttled: true });
  assert.equal(error.identityUnavailable, true);
  assert.equal(error.throttled, false);
  assert.equal(error.message, detail);
});

test('malformed error fields use plain fallback text and preserve explicit unknown causes', () => {
  const malformed = verificationError({ error: {}, source: false, detail: [], message: {}, code: ' ' });
  assert.equal(malformed.code, undefined);
  assert.equal(malformed.source, undefined);
  assert.equal(malformed.message, 'Verification is unavailable.');
  const explicit = verificationError({ code: 'verification-failed', source: 'verifier', message: 'Probe request failed.', retryable: false });
  assert.equal(explicit.code, 'verification-failed');
  assert.equal(explicit.message, 'Probe request failed.');
  assert.equal(explicit.retryable, false);
  assert.equal(explicit.identityUnavailable, false);
});
