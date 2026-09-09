import assert from 'node:assert/strict';
import test from 'node:test';
import { registryIdentity, registryPageRequest, validateRegistryAgent, normalizeRegistryPage, validateRegistryStats } from '../src/sources/registry-contract.js';

const row = (token = '1', chain = 56) => ({ chain_id: chain, token_id: token, name: 'Fixture', supported_protocols: ['MCP'], total_score: 2.5 });
const invalid = (fn) => assert.throws(fn, (error) => error.code === 'registry-invalid-response' && error.source === '8004scan' && error.malformed);

test('page conversion uses documented offset and snake_case with explicit full indexed scope', () => {
  const request = registryPageRequest({ chainId: 56, page: 3, limit: 2, search: 'yield & lending', sortBy: 'total_score', sortOrder: 'asc' });
  const query = new URL(request.path, 'https://fixture.invalid').searchParams;
  assert.equal(request.offset, 4);
  assert.equal(query.get('offset'), '4');
  assert.equal(query.get('chain_id'), '56');
  assert.equal(query.get('sort_by'), 'total_score');
  assert.equal(query.get('sort_order'), 'asc');
  assert.equal(query.get('search'), 'yield & lending');
  assert.equal(query.get('is_active'), 'any');
  assert.equal(query.get('is_registered'), 'any');
  assert.equal(query.has('page'), false);
  assert.equal(query.has('chainId'), false);
});

test('internal request validation rejects ignored/ambiguous params and inexact identities', () => {
  for (const params of [{ page: 0 }, { page: 1.5 }, { limit: 101 }, { offset: 1 }, { sortBy: 'unrecognized' }, { chainId: 56, chain_id: 1 }, { search: 'x'.repeat(201) }, { ownerAddress: 'bad' }]) {
    assert.throws(() => registryPageRequest(params), (error) => error.status === 400 && !error.source);
  }
  for (const [chain, token] of [['56/path', '1'], [56, '../1'], [56, Number.MAX_SAFE_INTEGER + 1], [56, '0x1'], [56, '9'.repeat(79)]]) {
    assert.throws(() => registryIdentity(chain, token), (error) => error.status === 400);
  }
  assert.deepEqual(registryIdentity('56', '123456789012345678901234567890'), { chainId: 56, tokenId: '123456789012345678901234567890' });
});

test('official raw detail preserves services, wallets and raw metadata; legacy envelope is rejected', () => {
  const detail = { ...row('123'), services: { mcp: { endpoint: 'https://agent.invalid/mcp', tools: ['read'] } },
    owner_address: 'owner', agent_wallet: 'separate wallet', raw_metadata: { offchain_uri: 'ipfs://original', offchain_content: { skills: [{ id: 'read' }] } } };
  assert.equal(validateRegistryAgent(detail, { chainId: 56, tokenId: '123' }), detail);
  assert.equal(detail.agent_wallet, 'separate wallet');
  invalid(() => validateRegistryAgent({ data: detail }, { chainId: 56, tokenId: '123' }));
  invalid(() => validateRegistryAgent(detail, { chainId: 1, tokenId: '123' }));
  invalid(() => validateRegistryAgent(detail, { chainId: 56, tokenId: '999' }));
});

test('large inventory pages keep exact offsets and identify the final partial page', () => {
  const request = registryPageRequest({ chainId: 56, page: 12839, limit: 25 });
  assert.equal(new URL(`https://registry.test${request.path}`).searchParams.get('offset'), '320950');
  const page = normalizeRegistryPage({ items: [row('1'), row('2'), row('3')], total: 320953, limit: 25, offset: 320950 }, request);
  assert.deepEqual(page.meta.pagination, { page: 12839, limit: 25, total: 320953, hasMore: false });
  assert.throws(() => registryPageRequest({ page: 4503599627370496, limit: 2 }), /invalid page or limit/);
});

test('pagination and hasMore match the requested page, including valid empty final pages', () => {
  const first = registryPageRequest({ chainId: 56, page: 1, limit: 2 });
  assert.deepEqual(normalizeRegistryPage({ items: [row('1'), row('2')], total: 3, limit: 2, offset: 0 }, first).meta.pagination,
    { page: 1, limit: 2, total: 3, hasMore: true });
  const last = registryPageRequest({ chainId: 56, page: 2, limit: 2 });
  assert.deepEqual(normalizeRegistryPage({ items: [row('3')], total: 3, limit: 2, offset: 2 }, last).meta.pagination,
    { page: 2, limit: 2, total: 3, hasMore: false });
  const beyond = registryPageRequest({ chainId: 56, page: 3, limit: 2 });
  assert.deepEqual(normalizeRegistryPage({ items: [], total: 3, limit: 2, offset: 4 }, beyond).data, []);
  assert.deepEqual(normalizeRegistryPage({ items: [], total: 0, limit: 2, offset: 0 }, first).meta.pagination,
    { page: 1, limit: 2, total: 0, hasMore: false });
});

test('wrong page, wrong limit, mixed chains, duplicates and false empty responses fail closed', () => {
  const request = registryPageRequest({ chainId: 56, limit: 2 });
  const valid = { items: [row('1'), row('2')], total: 3, limit: 2, offset: 0 };
  for (const body of [
    null, { data: valid.items }, { ...valid, offset: 2 }, { ...valid, limit: 3 },
    { ...valid, total: '3' }, { ...valid, items: [] }, { ...valid, items: [row('1'), row('2', 1)] },
    { ...valid, items: [row('1'), row('1')] }, { ...valid, items: [row('1'), { ...row('2'), total_score: '2.5' }] },
  ]) invalid(() => normalizeRegistryPage(body, request));
});

test('semantic search uses the verified flat response and its own supported query scope', () => {
  const request = registryPageRequest({ q: 'lending health', chainId: 56, page: 2, limit: 1 }, { semantic: true });
  const url = new URL(request.path, 'https://fixture.invalid');
  assert.equal(url.pathname, '/agents/search/semantic');
  assert.equal(url.searchParams.get('q'), 'lending health');
  assert.equal(url.searchParams.get('offset'), '1');
  assert.equal(url.searchParams.has('is_registered'), false);
  const hit = { ...row(), similarity_score: 0.85, services: { mcp: { endpoint: 'https://fixture.invalid/mcp' } } };
  assert.equal(normalizeRegistryPage({ items: [hit], total: 2, limit: 1, offset: 1 }, request).data[0], hit);
  assert.throws(() => registryPageRequest({ q: 'lending', sortBy: 'total_score' }, { semantic: true }), (error) => error.status === 400);
});

test('global stats preserve actual chain totals and reject legacy or malformed count data', () => {
  const stats = { total_agents: 30, chain_stats: [{ chain_id: 56, total_agents: 20 }, { chain_id: 1, total_agents: 10 }], other: 'preserved' };
  assert.equal(validateRegistryStats(stats), stats);
  for (const value of [{ data: stats }, { ...stats, total_agents: '30' }, { ...stats, chain_stats: [{ chain_id: 56, total_agents: -1 }] },
    { ...stats, chain_stats: [{ chain_id: 56, total_agents: 1 }, { chain_id: 56, total_agents: 2 }] }]) invalid(() => validateRegistryStats(value));
});
