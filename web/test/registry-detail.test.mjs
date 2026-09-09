import assert from 'node:assert/strict';
import { fetchRegistryDetail } from '../src/api/registry-detail.js';

const opts = { serviceBase: 'https://fya.example', scanBase: 'https://api.scan.example/api/v1', chainId: 56, tokenId: '45422', timeoutMs: 50 };
const agent = { chain_id: 56, token_id: '45422', name: 'Beefy' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let passed = 0;
async function test(name, run) {
  try { await run(); passed++; }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

await test('service uses data wrapper, matching identity and no browser credentials', async () => {
  const calls = [];
  const found = await fetchRegistryDetail({ ...opts, fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ data: agent }); } });
  assert.deepEqual(found, agent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://fya.example/api/agents/56/45422');
  assert.deepEqual(calls[0].init.headers, { accept: 'application/json' });
  assert.equal(calls[0].init.credentials, 'omit');
});

await test('typed service failure is preserved without an unauthenticated direct fallback', async () => {
  const urls = [];
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async (url, init) => {
    urls.push(url);
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.credentials, 'omit');
    return response({ error: 'registry-unavailable', source: '8004scan', upstreamStatus: 500, retryable: true }, 503);
  } }), error => error.status === 503 && error.code === 'registry-unavailable' && error.source === '8004scan'
    && error.upstreamStatus === 500 && error.retryable === true);
  assert.deepEqual(urls, ['https://fya.example/api/agents/56/45422']);
});

await test('direct-only official lookup accepts raw response and rejects legacy wrapper', async () => {
  assert.deepEqual(await fetchRegistryDetail({ ...opts, serviceBase: '', fetchImpl: async () => response(agent) }), agent);
  await assert.rejects(fetchRegistryDetail({ ...opts, serviceBase: '', fetchImpl: async () => response({ data: agent }) }), /requested agent/);
});

await test('explicit missing agent does not trigger a second registry request', async () => {
  let calls = 0;
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async () => { calls++; return response({ error: 'agent-not-found' }, 404); } }), error => error.notFound === true);
  assert.equal(calls, 1);
  await assert.rejects(fetchRegistryDetail({ ...opts, serviceBase: '', fetchImpl: async () => response({ detail: 'Missing' }, 404) }), error => error.notFound === true);
});

await test('old unsupported service route can fall back without labelling agent missing', async () => {
  assert.deepEqual(await fetchRegistryDetail({ ...opts, fetchImpl: async url => url.includes('fya.example')
    ? response({ error: 'route-not-found' }, 404) : response(agent) }), agent);
});

await test('HTML502 preserves service status and never bypasses the configured backend', async () => {
  let calls = 0;
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async () => {
    calls++; return new Response('<html>proxy error</html>', { status: 502 });
  } }), error => error.status === 502);
  assert.equal(calls, 1);
  await assert.rejects(fetchRegistryDetail({ ...opts, scanBase: '', fetchImpl: async () => new Response('<html>proxy error</html>', { status: 502 }) }), /502/);
});

await test('malformed successful body is not accepted as an agent', async () => {
  for (const body of [null, [], { success: false }, { error: 'failed' }, { data: null }]) {
    await assert.rejects(fetchRegistryDetail({ ...opts, scanBase: '', fetchImpl: async () => response(body) }), /unreadable|requested agent/);
  }
  await assert.rejects(fetchRegistryDetail({ ...opts, serviceBase: '', fetchImpl: async () => new Response('<html>okay?</html>') }), /unreadable/);
});

await test('wrong chain or token is rejected from both sources', async () => {
  for (const changed of [{ ...agent, token_id: '999' }, { ...agent, chain_id: 1 }]) {
    await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async url => response(url.includes('fya.example') ? { data: changed } : changed) }), /requested agent/);
  }
});

await test('deadline includes stalled response body and aborts each attempt', async () => {
  const signals = [];
  await assert.rejects(fetchRegistryDetail({ ...opts, timeoutMs: 5, fetchImpl: async (_url, init) => {
    signals.push(init.signal);
    return { ok: true, status: 200, text: () => new Promise(() => {}) };
  } }), /too long/);
  assert.equal(signals.length, 1);
  assert.ok(signals.every(signal => signal.aborted));
});

await test('throttle retains Retry-After seconds and typed detail without fallback', async () => {
  let calls = 0;
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'registry-throttled', detail: '8004scan is temporarily throttling lookups.' }), {
      status: 503, headers: { 'retry-after': '17', 'content-type': 'application/json' },
    });
  } }), error => error.code === 'registry-throttled' && error.retryAfter === '17'
    && error.retryAfterMs === 17000 && error.message === '8004scan is temporarily throttling lookups.');
  assert.equal(calls, 1);
});

await test('Retry-After HTTP-date is retained', async () => {
  const retryAfter = new Date(Date.now() + 60_000).toUTCString();
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async () => new Response('{}', {
    status: 429, headers: { 'retry-after': retryAfter },
  }) }), error => error.retryAfter === retryAfter && error.retryAfterMs > 58_000 && error.retryAfterMs <= 60_000);
});

await test('browser network failure names the FYA API and does not leak a bare fetch failure', async () => {
  let calls = 0;
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async () => { calls++; throw new TypeError('Failed to fetch'); } }),
    error => error.code === 'registry-network-error' && /FYA API/.test(error.message) && !/Failed to fetch/.test(error.message));
  assert.equal(calls, 1);
});

await test('ambiguous404 cannot bypass a configured backend', async () => {
  let calls = 0;
  await assert.rejects(fetchRegistryDetail({ ...opts, fetchImpl: async () => { calls++; return response({ detail: 'Missing' }, 404); } }),
    error => error.status === 404 && !error.notFound);
  assert.equal(calls, 1);
});

await test('invalid identity or missing configuration never fetches', async () => {
  const fetchImpl = () => { throw new Error('must not fetch'); };
  await assert.rejects(fetchRegistryDetail({ ...opts, tokenId: '../secret', fetchImpl }), /Invalid agent/);
  await assert.rejects(fetchRegistryDetail({ ...opts, serviceBase: '', scanBase: '', fetchImpl }), /not configured/);
});

console.log(`registry detail: ${passed} passed`);
