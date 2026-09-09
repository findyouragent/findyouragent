import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELIVERABLE_MAX_BYTES,
  DELIVERABLE_MAX_TEXT,
  fetchDeliverable,
} from '../src/lib/erc8183.js';

const JOB = {
  deliverable: `0x${'11'.repeat(32)}`,
  provider: `0x${'22'.repeat(20)}`,
  jobId: '42',
};

const manifest = (patch = {}) => ({
  provider: JOB.provider,
  jobId: JOB.jobId,
  deliverable: 'done',
  ...patch,
});

function response(value, { contentLength, status = 200, chunks = null, cancellation = null } = {}) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const parts = chunks ?? [bytes];
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= parts.length) return controller.close();
      controller.enqueue(parts[index++]);
    },
    cancel() {
      if (cancellation) cancellation.count += 1;
    },
  });
  const headers = { 'content-type': 'application/json' };
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return new Response(stream, { status, headers });
}

test('accepts a valid manifest with missing or lying content-length', async () => {
  for (const contentLength of [undefined, 1]) {
    const result = await fetchDeliverable(JOB, {
      fetchImpl: async () => response(manifest(), { contentLength }),
    });
    assert.deepEqual(result, {
      cid: result.cid,
      valid: true,
      text: 'done',
    });
  }
});

test('accepts safe numeric job ids and copies many small chunks into bounded storage', async () => {
  const value = manifest({ jobId: 42 });
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const chunks = Array.from({ length: encoded.length }, (_, index) => encoded.slice(index, index + 1));
  const result = await fetchDeliverable(JOB, {
    fetchImpl: async () => response(value, { chunks }),
  });
  assert.equal(result.valid, true);
  assert.equal(result.text, 'done');
});

test('falls back after malformed data and preserves mismatch as an integrity failure', async () => {
  let calls = 0;
  const recovered = await fetchDeliverable(JOB, {
    fetchImpl: async () => (++calls === 1 ? response('{broken') : response(manifest())),
  });
  assert.equal(recovered.valid, true);
  assert.equal(recovered.text, 'done');
  assert.equal(calls, 2);

  calls = 0;
  const mismatch = await fetchDeliverable(JOB, {
    fetchImpl: async () => { calls += 1; return response(manifest({ jobId: '43' })); },
  });
  assert.deepEqual(mismatch, { cid: mismatch.cid, valid: false, text: null });
  assert.equal(calls, 1);
});

test('rejects declared and streamed oversized bodies before JSON parsing', async () => {
  const tooLargeDeclared = await fetchDeliverable(JOB, {
    fetchImpl: async () => response(manifest(), { contentLength: DELIVERABLE_MAX_BYTES + 1 }),
  });
  assert.equal(tooLargeDeclared.valid, null);

  const large = JSON.stringify(manifest({ deliverable: 'x'.repeat(DELIVERABLE_MAX_BYTES) }));
  const tooLargeStream = await fetchDeliverable(JOB, {
    fetchImpl: async () => response(large, { contentLength: 1 }),
  });
  assert.equal(tooLargeStream.valid, null);
});

test('cancels unread bodies on declared oversize and non-ok gateway responses', async () => {
  let calls = 0;
  const tooLargeBody = { count: 0 };
  const recovered = await fetchDeliverable(JOB, {
    fetchImpl: async () => (++calls === 1
      ? response(manifest(), { contentLength: DELIVERABLE_MAX_BYTES + 1, cancellation: tooLargeBody })
      : response(manifest())),
  });
  assert.equal(recovered.valid, true);
  assert.equal(tooLargeBody.count, 1);

  calls = 0;
  const failedBody = { count: 0 };
  const recoveredAfterStatus = await fetchDeliverable(JOB, {
    fetchImpl: async () => (++calls === 1
      ? response('', { status: 502, cancellation: failedBody })
      : response(manifest())),
  });
  assert.equal(recoveredAfterStatus.valid, true);
  assert.equal(failedBody.count, 1);
});

test('does not render an oversized deliverable field and keeps malformed shape unavailable', async () => {
  const tooLargeText = await fetchDeliverable(JOB, {
    fetchImpl: async () => response(manifest({ deliverable: 'x'.repeat(DELIVERABLE_MAX_TEXT + 1) })),
  });
  assert.equal(tooLargeText.valid, null);

  const wrongShape = await fetchDeliverable(JOB, {
    fetchImpl: async () => response(manifest({ deliverable: { html: '<script>' } })),
  });
  assert.equal(wrongShape.valid, null);
});

test('caller abort stops gateway fallback and returns an unavailable result', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchDeliverable(JOB, {
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        signal.aborted ? reject(new Error('aborted')) : resolve();
      });
      return response(manifest());
    },
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.valid, null);
  assert.equal(calls, 1);
});

test('deadline aborts an unresponsive gateway and bounds total work', async () => {
  let calls = 0;
  const started = Date.now();
  const result = await fetchDeliverable(JOB, {
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  assert.equal(result.valid, null);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 500, 'deadline should not leave a hanging read');
});
