import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegistryHandlers, registryParams } from '../src/registry.js';

const response = () => ({ statusCode: 200, headers: {}, body: null,
  status(value) { this.statusCode = value; return this; },
  set(name, value) { this.headers[name] = value; return this; },
  json(value) { this.body = value; return this; },
});

test('browser query boundaries fix BSC identity, pagination and allowed orderings', () => {
  assert.deepEqual(registryParams({ page: '2', limit: '25', search: ' grid ', sortBy: 'total_score' }), {
    chainId: 56, page: 2, limit: 25, search: 'grid', sortBy: 'total_score', sortOrder: 'desc',
  });
  assert.deepEqual(registryParams({ q: ' liquidity ', page: '2' }, true), { chainId: 56, page: 2, limit: 25, q: 'liquidity' });
});

test('invalid, duplicated or caller-controlled upstream parameters never spend a registry read', async () => {
  let calls = 0;
  const readers = { getAgentPage: async () => { calls++; }, searchAgentPage: async () => { calls++; } };
  const handlers = createRegistryHandlers(readers);
  for (const query of [{ chainId: '1' }, { page: '0' }, { page: String(Number.MAX_SAFE_INTEGER), limit: '2' },
    { page: '4503599627370496', limit: '2' }, { limit: '101' }, { page: ['1', '2'] },
    { sortBy: 'https://attacker.test' }, { url: 'https://attacker.test' }, { search: 'a'.repeat(201) }, { sortOrder: 'sideways' }]) {
    const res = response(); await handlers.list({ query }, res); assert.equal(res.statusCode, 400);
  }
  const res = response(); await handlers.search({ query: { q: ' ' } }, res); assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test('browsing and semantic search can reach the full inventory beyond page 1000', async () => {
  const queries = [];
  const getPage = async (params) => {
    queries.push(params);
    return { data: [{ chain_id: 56, token_id: '320953' }], meta: { pagination: {
      page: params.page, limit: params.limit, total: 320953, hasMore: false,
    } } };
  };
  const handlers = createRegistryHandlers({ getAgentPage: getPage, searchAgentPage: getPage });
  for (const page of ['1001', '12839']) {
    const res = response();
    await handlers.list({ query: { page, limit: '25' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.pagination.page, Number(page));
  }
  const res = response();
  await handlers.search({ query: { page: '1001', q: 'yield' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queries.map((query) => query.page), [1001, 12839, 1001]);
});

test('empty results retain their valid page and explicit source', async () => {
  const page = { data: [], meta: { pagination: { page: 1, limit: 25, total: 0, hasMore: false } } };
  const handlers = createRegistryHandlers({ getAgentPage: async () => page });
  const res = response(); await handlers.list({ query: {} }, res);
  assert.deepEqual(res.body, { ...page, source: '8004scan' });
});

test('upstream failures and malformed responses cannot become successful empty results', async () => {
  for (const [error, expected, status] of [
    [Object.assign(new Error('private upstream data'), { status: 500 }), 'registry-unavailable', 502],
    [Object.assign(new Error('invalid upstream input'), { status: 400 }), 'registry-unavailable', 502],
    [Object.assign(new Error('unexpected contract'), { code: 'registry-invalid-response' }), 'registry-invalid-response', 502],
    [Object.assign(new Error('deadline'), { name: 'TimeoutError' }), 'registry-unavailable', 502],
  ]) {
    const handlers = createRegistryHandlers({ getAgentPage: async () => { throw error; } });
    const res = response(); await handlers.list({ query: {} }, res);
    assert.equal(res.statusCode, status); assert.equal(res.body.error, expected);
    assert.equal(res.body.source, '8004scan'); assert.equal(res.body.data, undefined);
    assert.ok(!JSON.stringify(res.body).includes(error.message));
    assert.equal(res.body.upstreamStatus, error.status ?? null);
  }
});

test('throttle response carries the validated retry interval', async () => {
  const handlers = createRegistryHandlers({ getAgentPage: async () => { throw { status: 429, retryAfterSeconds: 17 }; } });
  const res = response(); await handlers.list({ query: {} }, res);
  assert.equal(res.statusCode, 503); assert.equal(res.headers['retry-after'], '17');
  assert.equal(res.body.error, 'registry-throttled');
});

test('stats never substitutes the visible page count for the registry inventory', async () => {
  const stats = { total_agents: 20, chain_stats: [{ chain_id: 56, total_agents: 15 }] };
  const handlers = createRegistryHandlers({ getRegistryStats: async () => stats });
  const res = response(); await handlers.stats({ query: {} }, res);
  assert.deepEqual(res.body, { data: stats, source: '8004scan' });
  const invalid = response(); await handlers.stats({ query: { search: 'grid' } }, invalid);
  assert.equal(invalid.statusCode, 400);
});
