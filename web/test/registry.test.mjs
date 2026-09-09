import assert from 'node:assert/strict';
import { fetchRegistryPage, fetchRegistrySearch, fetchRegistryStats } from '../src/api/registry.js';

const opts = { serviceBase: 'https://fya.example/', chainId: 56, page: 1, limit: 2, timeoutMs: 100 };
const row = id => ({ chain_id: 56, token_id: String(id), name: `Fixture ${id}` });
const envelope = (data = [row(1), row(2)], pagination = { page: 1, limit: 2, total: 3, hasMore: true }) => ({ source: '8004scan', data, meta: { pagination } });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let passed = 0;
async function test(name, run) {
  try { await run(); passed++; }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

await test('page uses only FYA and preserves raw unknown service fields', async () => {
  const calls = [];
  const body = envelope();
  const found = await fetchRegistryPage({ ...opts, search: ' Pancake & Beefy ', fetchImpl: async (url, init) => { calls.push({ url, init }); return response(body); } });
  assert.deepEqual(found, { agents: body.data, pagination: body.meta.pagination });
  assert.equal(Object.hasOwn(found.agents[0], 'services'), false);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://fya.example');
  assert.equal(url.pathname, '/api/registry/agents');
  assert.deepEqual(Object.fromEntries(url.searchParams), { chainId: '56', page: '1', limit: '2', sortBy: 'created_at', sortOrder: 'desc', search: 'Pancake & Beefy' });
  assert.deepEqual(calls[0].init.headers, { accept: 'application/json' });
  assert.equal(calls[0].init.credentials, 'omit');
});

await test('page two and truly empty list keep exact pagination', async () => {
  const second = envelope([row(3)], { page: 2, limit: 2, total: 3, hasMore: false });
  const result = await fetchRegistryPage({ ...opts, page: 2, fetchImpl: async url => { assert.equal(new URL(url).searchParams.get('page'), '2'); return response(second); } });
  assert.deepEqual(result.agents, second.data);
  assert.deepEqual(result.pagination, second.meta.pagination);
  assert.equal(result.registryCount.total, 3);
  for (const [page, total] of [[1, 0], [4, 3]]) {
    const body = envelope([], { page, limit: 2, total, hasMore: false });
    const empty = await fetchRegistryPage({ ...opts, page, fetchImpl: async () => response(body) });
    assert.deepEqual(empty.agents, []);
    assert.deepEqual(empty.pagination, body.meta.pagination);
    assert.equal(empty.registryCount.total, total);
  }
});

await test('large inventory final pages remain reachable without a page-count cutoff', async () => {
  const pagination = { page: 12839, limit: 25, total: 320953, hasMore: false };
  const body = envelope([row(1), row(2), row(3)], pagination);
  const result = await fetchRegistryPage({ ...opts, page: 12839, limit: 25, fetchImpl: async url => {
    assert.equal(new URL(url).searchParams.get('page'), '12839');
    return response(body);
  } });
  assert.deepEqual(result.pagination, pagination);
  let requests = 0;
  await assert.rejects(() => fetchRegistryPage({ ...opts, page: 4503599627370496, limit: 2,
    fetchImpl: async () => { requests++; return response(body); } }), /Invalid registry page/);
  assert.equal(requests, 0);
});

await test('only validated unfiltered BSC pages expose a corpus count with a retrieval time', async () => {
  const before = Date.now();
  const listed = await fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope()) });
  assert.equal(listed.registryCount.total, 3);
  assert.equal(listed.registryCount.chainId, 56);
  assert.equal(listed.registryCount.source, 'unfiltered-list');
  assert.ok(Date.parse(listed.registryCount.retrievedAt) >= before);
  assert.ok(Date.parse(listed.registryCount.retrievedAt) <= Date.now());
  const searched = await fetchRegistryPage({ ...opts, search: 'vault', fetchImpl: async () => response(envelope()) });
  assert.equal(searched.registryCount, undefined);
  const other = envelope([{ chain_id: 1, token_id: '1' }, { chain_id: 1, token_id: '2' }]);
  assert.equal((await fetchRegistryPage({ ...opts, chainId: 1, fetchImpl: async () => response(other) })).registryCount, undefined);
});

await test('invalid pagination cannot turn a partial or malformed list into a valid page', async () => {
  for (const pagination of [null, {}, { page: 2, limit: 2, total: 3, hasMore: true }, { page: 1, limit: 3, total: 3, hasMore: true }, { page: 1, limit: 2, total: '3', hasMore: true }, { page: 1, limit: 2, total: -1, hasMore: false }, { page: 1, limit: 2, total: 3, hasMore: false }, { page: 1, limit: 2, total: 3, hasMore: 1 }]) {
    await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope(undefined, pagination)) }), /pagination/);
  }
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope([row(1)])) }), /pagination/);
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope([row(1), row(2), row(3)])) }), /more agents/);
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope([])) }), /pagination/);
});

await test('all row identities must match, without dropping rows or losing counts', async () => {
  for (const bad of [null, 'bad', {}, { ...row(2), chain_id: 1 }, { ...row(2), token_id: null }, { ...row(2), token_id: '1e4' }, { ...row(2), token_id: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope([row(1), bad])) }), /identity|requested chain/);
  }
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(envelope([row(1), { ...row(1), token_id: '01' }])) }), /duplicate/);
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response({ ...envelope(), source: 'other-registry' }) }), /data source/);
});

await test('missing rows, failure envelopes and HTML200 are errors instead of fabricated empty results', async () => {
  for (const data of [null, [], {}, { data: null }, { data: {} }, { error: 'database failure' }, { success: false, data: [] }]) {
    await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response(data) }), /registry service/);
  }
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => new Response('<html>unexpected</html>') }), /unreadable/);
});

await test('HTTP failures and unconfigured services never trigger browser listing fallback', async () => {
  let calls = 0;
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async url => { calls++; assert.ok(url.startsWith('https://fya.example/')); return new Response('<html>proxy failed</html>', { status: 502 }); } }), /HTTP 502/);
  assert.equal(calls, 1);
  for (const fetcher of [fetchRegistryPage, fetchRegistrySearch, fetchRegistryStats]) {
    await assert.rejects(fetcher({ ...opts, serviceBase: '', fetchImpl: () => { throw new Error('must not fetch'); } }), /not configured/);
  }
});

await test('typed upstream failure preserves attribution without assigning FYA HTTP status to 8004scan', async () => {
  for (const upstreamStatus of [null, 500]) {
    await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response({
      error: 'registry-unavailable', source: '8004scan', upstreamStatus, retryable: true,
    }, 502) }), error => error.status === 502 && error.source === '8004scan'
      && error.upstreamStatus === upstreamStatus && error.retryable === true
      && error.message.includes('from 8004scan'));
  }
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => {
    throw new TypeError('Failed to fetch');
  } }), error => error.message.includes('FYA API') && !error.message.includes('8004scan') && !error.source);
  await assert.rejects(fetchRegistryPage({ ...opts, fetchImpl: async () => response({ error: 'internal-error', source: '8004scan' }, 500) }),
    error => !error.source && !error.message.includes('8004scan'));
});

await test('missing FYA routes are an incompatible service, with no semantic fallback or upstream accusation', async () => {
  for (const fetcher of [fetchRegistryPage, fetchRegistrySearch, fetchRegistryStats]) {
    let calls = 0;
    await assert.rejects(fetcher({ ...opts, query: 'vault', fetchImpl: async () => {
      calls++;
      return new Response('Cannot GET /api/registry/agents', { status: 404 });
    } }), (error) => error.code === 'registry-service-outdated' && error.status === 404
      && error.message === 'This FYA service does not support registry browsing yet.');
    assert.equal(calls, 1);
  }
});

await test('semantic page two sends page and preserves validated pagination', async () => {
  const body = envelope([row(3)], { page: 2, limit: 2, total: 3, hasMore: false });
  const found = await fetchRegistrySearch({ ...opts, page: 2, query: 'vaults', semanticQuery: 'BSC vault research', fetchImpl: async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/api/registry/search');
    assert.equal(parsed.searchParams.get('page'), '2');
    assert.equal(parsed.searchParams.get('q'), 'BSC vault research');
    return response(body);
  } });
  assert.deepEqual(found, { agents: body.data, pagination: body.meta.pagination, mode: 'semantic' });
});

await test('semantic response requires normalized pagination and respects the requested row limit', async () => {
  for (const malformed of [{ data: [row(1)] }, { data: [row(1), row(2), row(3)] }]) {
    const calls = [];
    const found = await fetchRegistrySearch({ ...opts, query: 'vaults', fetchImpl: async url => {
      calls.push(url);
      return response(url.includes('/search?') ? malformed : envelope());
    } });
    assert.equal(calls.length, 2);
    assert.equal(found.mode, 'keyword');
  }
});

await test('empty, malformed, wrong-chain and failed semantic replies fall back once to keyword', async () => {
  for (const semantic of [() => response(envelope([], { page: 1, limit: 2, total: 0, hasMore: false })), () => response({ data: [row(1)], meta: { pagination: {} } }), () => response({ data: [{ ...row(1), chain_id: 1 }] }), () => new Response('<html>broken</html>', { status: 502 }), () => response({ error: 'not available' }, 503)]) {
    const urls = [];
    const found = await fetchRegistrySearch({ ...opts, query: 'keyword input', semanticQuery: 'semantic input', fetchImpl: async url => {
      urls.push(url);
      return new URL(url).pathname.endsWith('/search') ? semantic() : response(envelope());
    } });
    assert.equal(found.mode, 'keyword');
    assert.equal(urls.length, 2);
    assert.equal(new URL(urls[1]).searchParams.get('search'), 'keyword input');
    assert.ok(urls.every(url => new URL(url).origin === 'https://fya.example'));
  }
});

await test('semantic-only fallback retains query and empty keyword results remain valid', async () => {
  let calls = 0;
  const found = await fetchRegistrySearch({ ...opts, semanticQuery: 'only semantic', fetchImpl: async url => {
    calls++;
    if (url.includes('/search?')) return response({ data: [] });
    assert.equal(new URL(url).searchParams.get('search'), 'only semantic');
    return response(envelope([], { page: 1, limit: 2, total: 0, hasMore: false }));
  } });
  assert.equal(calls, 2);
  assert.deepEqual(found.agents, []);
  assert.equal(found.mode, 'keyword');
});

await test('two failed search reads throw instead of returning no matches', async () => {
  await assert.rejects(fetchRegistrySearch({ ...opts, query: 'vaults', fetchImpl: async () => response({ error: 'unavailable' }, 502) }), /HTTP 502/);
});

await test('empty query loads keyword list without a semantic call', async () => {
  let calls = 0;
  const found = await fetchRegistrySearch({ ...opts, fetchImpl: async url => { calls++; assert.ok(url.includes('/registry/agents?')); return response(envelope()); } });
  assert.equal(calls, 1);
  assert.equal(found.mode, 'keyword');
});

await test('stats preserves real zero and rejects invalid counts or duplicate chains', async () => {
  const data = { total_agents: 3, chain_stats: [{ chain_id: 56, total_agents: 0 }, { chain_id: 1, total_agents: 3 }] };
  assert.deepEqual(await fetchRegistryStats({ ...opts, fetchImpl: async url => { assert.equal(url, 'https://fya.example/api/registry/stats'); return response({ data }); } }), data);
  for (const changed of [{}, { chain_stats: {} }, { chain_stats: [{ chain_id: 56 }] }, { chain_stats: [{ chain_id: 56, total_agents: -1 }] }, { chain_stats: [{ chain_id: 56, total_agents: '3' }] }, { chain_stats: [{ chain_id: 56, total_agents: 1 }, { chain_id: 56, total_agents: 2 }] }, { total_agents: -1, chain_stats: [] }]) {
    await assert.rejects(fetchRegistryStats({ ...opts, fetchImpl: async () => response({ data: changed }) }), /statistics|count/);
  }
});

await test('deadline includes stalled bodies, aborts reads and does not start fallback after expiry', async () => {
  for (const fetcher of [fetchRegistryPage, fetchRegistrySearch, fetchRegistryStats]) {
    const signals = [];
    await assert.rejects(fetcher({ ...opts, query: 'vaults', timeoutMs: 5, fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      return { status: 200, ok: true, text: () => new Promise(() => {}) };
    } }), /too long/);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, true);
  }
});

await test('invalid page and chain input are rejected before any request', async () => {
  for (const changed of [{ chainId: '../1' }, { chainId: -1 }, { page: 0 }, { page: '2' }, { limit: -1 }, { limit: 1.5 }, { page: Number.MAX_SAFE_INTEGER, limit: 10 }]) {
    await assert.rejects(fetchRegistryPage({ ...opts, ...changed, fetchImpl: () => { throw new Error('must not fetch'); } }), /Invalid registry/);
  }
});

console.log(`registry browser API: ${passed} passed`);
