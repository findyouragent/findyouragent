// Preloaded only by smoke.test.mjs. Every request is handled here; no network.
import assert from 'node:assert/strict';
import { getTaskPresets, assessTaskResult } from '../../src/task-presets.js';
import { classifyTryResult } from '../../src/try-result.js';
const scenario = process.env.SMOKE_FIXTURE;
const timers = globalThis.setTimeout;
globalThis.setTimeout = (fn, _delay, ...args) => timers(fn, 0, ...args);
const timeoutSignal = AbortSignal.timeout.bind(AbortSignal);
const timeoutBudgets = new WeakMap();
AbortSignal.timeout = (milliseconds) => {
  const signal = timeoutSignal(milliseconds);
  timeoutBudgets.set(signal, milliseconds);
  return signal;
};
let interfaceCalls = 0;
let taskCalls = 0;
const registryCalls = new Set();
const curating = process.argv[1]?.endsWith('curate.js');
const tools = [
  { name: 'getSupportedChains', readOnly: true, inputSchema: { type: 'object', properties: {} } },
  { name: 'getVaultsWithChains', readOnly: true, inputSchema: { type: 'object', properties: { chainNames: { type: 'array', items: { type: 'string' } } }, required: ['chainNames'] } },
];
const preset = getTaskPresets({ chainId: 56, tokenId: '45422', tools })[0];
const search = { count: 1, agents: [{ chain_id: 56, token_id: '45422', matchedTool: 'getVaultsWithChains' }] };
const success = { jsonrpc: '2.0', id: 1, result: { structuredContent: { project: 'beefy', operation: 'getVaultsWithChains', data: [{ chain: 'bsc', vaults: [{ id: 'fixture', name: 'Fixture', token: 'TEST', chain: 'bsc', tvl: 100, apy: 0.01 }] }] } } };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const expectedTimeout = url.pathname.endsWith('/interface') ? 35000
    : url.pathname.startsWith('/api/try/') ? 95000 : 30000;
  assert.equal(timeoutBudgets.get(init.signal), expectedTimeout, 'Smoke request must allow the server operation budget');
  assert.equal(url.origin, 'http://smoke.test', 'Smoke and curation must use the configured FYA service, never a separate registry reader');
  if (url.pathname === '/api/registry/agents') {
    if (scenario === 'registry-routes-missing') return new Response('<html>Cannot GET /api/registry/agents</html>', { status: 404 });
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(registryCalls.has(url.href), false, 'Registry reads must not be automatically retried');
    if (['registry-unavailable', 'registry-throttled', 'registry-throttled-direct'].includes(scenario)) {
      assert.equal(registryCalls.size, 0, 'Stop subsequent registry queries after an unavailable or throttled read');
    }
    registryCalls.add(url.href);
    assert.equal(url.searchParams.get('chainId'), '56', 'The FYA adapter requires camelCase chainId');
    assert.equal(url.searchParams.get('page'), '1', 'Request an explicit page through the FYA adapter');
    assert.ok([...url.searchParams.keys()].every((key) => ['chainId', 'page', 'limit', 'search', 'sortBy', 'sortOrder'].includes(key)), 'Unexpected FYA registry parameter');
    const limit = url.searchParams.get('limit');
    assert.ok((curating ? ['2'] : ['1', '3', '5']).includes(limit));
    if (curating || limit === '5') {
      assert.equal(url.searchParams.get('sortBy'), curating ? 'total_score' : 'created_at');
      assert.equal(url.searchParams.get('sortOrder'), 'desc');
    } else {
      assert.equal(url.searchParams.has('sortBy'), false);
      assert.equal(url.searchParams.has('sortOrder'), false);
    }
    if (curating) assert.equal(url.searchParams.get('search'), 'grid');
    else if (limit === '1') assert.ok(['grid', 'rebalance', 'yield', 'liquidation'].includes(url.searchParams.get('search')));
    else assert.equal(url.searchParams.has('search'), false);
    if (scenario === 'registry-unavailable') return response({ source: '8004scan', error: 'registry-unavailable' }, 502);
    if (['registry-throttled', 'registry-throttled-direct'].includes(scenario)) return response(
      scenario === 'registry-throttled' ? { source: '8004scan', error: 'registry-throttled' } : { error: 'rate-limited' },
      scenario === 'registry-throttled' ? 503 : 429,
      { 'x-ratelimit-limit': '42', 'x-ratelimit-remaining': '0', 'retry-after': '13' });
    if (scenario === 'registry-ambiguous-gateway') return response({ error: 'registry-unavailable' }, 502);
    if (scenario === 'registry-wrong-source') return response({ source: 'other', error: 'registry-unavailable' }, 503);
    if (scenario === 'registry-unexpected-error') return response({ source: '8004scan', error: 'unexpected-error' }, 504);
    if (scenario === 'registry-invalid-response') return response({ source: '8004scan', error: 'registry-invalid-response' }, 502);
    if (scenario === 'registry-internal-error') return response({ source: '8004scan', error: 'registry-unavailable' }, 500);
    if (scenario === 'registry-non-json') return new Response('<html>bad gateway</html>', { status: 502 });
    const wrongChain = (scenario === 'registry-wrong-chain' && limit === '3')
      || (scenario === 'registry-wrong-chain' && curating)
      || (scenario === 'category-wrong-chain' && limit === '1')
      || (scenario === 'nameplate-wrong-chain' && limit === '5');
    const data = Array.from({ length: Number(limit) }, (_, index) => ({ chain_id: wrongChain ? 1 : 56,
      token_id: scenario === 'registry-bad-token' ? 'invalid' : String(123 + index), name: 'Fixture Agent', supported_protocols: [] }));
    const pagination = { page: 1, limit: Number(limit), total: 10000, hasMore: true };
    if (scenario === 'registry-page-mismatch') pagination.page = 2;
    if (scenario === 'registry-limit-mismatch') pagination.limit = Number(limit) + 1;
    if (scenario === 'registry-invalid-total') pagination.total = '10000';
    if (scenario === 'registry-has-more') pagination.hasMore = false;
    if (scenario === 'registry-short-page') data.pop();
    if (scenario === 'registry-empty') { data.length = 0; pagination.total = 0; pagination.hasMore = false; }
    return response({ ...(scenario === 'registry-no-source' ? {} : { source: '8004scan' }), data,
      meta: scenario === 'registry-no-pagination' ? {} : { pagination } });
  }
  if (url.pathname === '/api/registry/stats') {
    if (scenario === 'registry-routes-missing') return new Response('<html>Cannot GET /api/registry/stats</html>', { status: 404 });
    if (scenario === 'registry-stats-unavailable') return response({ source: '8004scan', error: 'registry-unavailable' }, 502);
    if (scenario === 'registry-stats-ambiguous') return response({ error: 'upstream' }, 502);
    if (scenario === 'registry-stats-wrong-source') return response({ source: 'other', data: { total_agents: 10000, chain_stats: [{ chain_id: 56, total_agents: 10000 }] } });
    return response({ source: '8004scan', data: {
      total_agents: 10000,
      chain_stats: [{ chain_id: scenario === 'registry-stats-missing-bsc' ? 1 : 56,
        total_agents: scenario === 'registry-stats-invalid-count' ? -1 : 10000 }],
    } });
  }
  if (url.pathname === '/health') return response({ ok: true, formulaVersion: 'fixture', sweep: { queued: 0 } });
  if (url.pathname.endsWith('/notanumber')) return response({ error: 'bad input' }, 400);
  if (url.pathname.startsWith('/api/verify/')) {
    assert.ok(/^\/api\/verify\/56\/(?:45422|123|124)$/.test(url.pathname), 'Smoke must verify the requested BSC identity');
    if (scenario === 'registry-unavailable') return response({ source: '8004scan', error: 'registry-throttled' }, 503);
    if (scenario === 'verification-unavailable') return response({ source: '8004scan', error: 'registry-unavailable' }, 502);
    if (scenario === 'verification-ambiguous') return response({ error: 'verification-failed' }, 502);
    return response({ tier: 'active', endpointProven: true, evidence: { endpoint: { declared: false }, mcp: { reachable: true, latencyMs: 10 }, wallet: {}, bazaar: {}, registry: {} } });
  }
  if (url.pathname.startsWith('/api/history/')) return response({ checks: scenario === 'empty-history' ? [] : [{ ts: '2026-09-08T00:00:00Z' }] });
  if (url.pathname === '/api/summary') return response({ checksRun: scenario === 'zero-checks' ? 0 : 3, uniqueChecked: 2, tiers: { verified_live: 0 } });
  if (url.pathname === '/api/search') return response(scenario === 'empty-search' ? { count: 0, agents: [] } : search);
  if (url.pathname === '/mcp') return response({ jsonrpc: '2.0', id: 1, result: { isError: scenario === 'own-mcp-error', content: [{ type: 'text', text: JSON.stringify(search) }] } });
  if (url.pathname.startsWith('/api/agent-meta/')) return response({ meta: { services: [{ name: 'MCP' }] } });
  if (url.pathname.endsWith('/interface')) {
    assert.equal(++interfaceCalls, 1, 'Smoke must not automatically retry interface discovery');
    if (scenario === 'interface-error') return response({ error: 'mcp-discovery-failed', code: 'UPSTREAM_TIMEOUT',
      source: 'agent', phase: 'initialize', upstreamStatus: 504, retryable: true,
      detail: 'Timed out at https://fixture-user:fixture-password@private-provider.test/mcp?key=fixture-url-secret Authorization: Bearer fixture-bearer-secret api_key=fixture-api-secret\n' + 'x'.repeat(1000) + 'fixture-tail-secret' }, 502);
    if (scenario === 'interface-error-legacy') return response({ error: { code: -32603, message: 'Legacy discovery rejected' },
      detail: 'tools/list failed at //legacy-provider.test/mcp?token=fixture-query-secret password="fixture-password-secret"' }, 502);
    if (scenario === 'interface-error-unstructured') return new Response('<html>fixture-raw-secret</html>', { status: 502 });
    return response({ kind: 'mcp', tools, taskPresets: scenario === 'no-preset' ? [] : [preset] });
  }
  if (url.pathname.startsWith('/api/try/')) {
    assert.equal(++taskCalls, 1, 'Smoke must submit the agent task exactly once');
    const request = JSON.parse(init.body);
    if (request.payment || request.signature || request.message) throw new Error('Test requested an unexpected wallet or A2A action');
    if (scenario === 'payment') return response({ status: 402, body: { accepts: [] } }, 402);
    const body = structuredClone(success);
    if (scenario === 'mcp-error') body.result.isError = true;
    if (scenario === 'rpc-error') { delete body.result; body.error = { code: -32603, message: 'fixture error' }; }
    if (scenario === 'wrong-chain') body.result.structuredContent.data[0].chain = 'ethereum';
    if (scenario === 'empty-reply') body.result = {};
    const returned = { id: preset.id, version: preset.version, tool: preset.tool, args: preset.args };
    if (scenario === 'wrong-inputs') returned.args = { chainNames: ['ethereum'] };
    const status = scenario === 'pending' ? 202 : 200;
    const endpoint = 'https://provider.test/mcp';
    const captureComplete = scenario !== 'partial-capture';
    const observation = classifyTryResult({ protocol: 'mcp', httpStatus: status, body,
      phase: 'tools/call', endpoint, captureComplete,
      runId: '706e0ed8-2f54-4d2e-805d-552481481b32',
      // Deliberately old: record consistency does not depend on wall-clock freshness.
      startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z', latencyMs: 1000 });
    if (request.presetId) observation.task = assessTaskResult(preset, observation, body);
    if (scenario === 'old-observation') observation.version = 0;
    if (scenario === 'observation-id') observation.runId = '';
    if (scenario === 'observation-endpoint') observation.endpoint = 'https://other-provider.test/mcp';
    if (scenario === 'observation-time') observation.finishedAt = '2019-12-31T23:59:59.000Z';
    if (scenario === 'observation-capture') observation.captureComplete = false;
    if (scenario === 'observation-outcome') observation.outcome = 'pending';
    if (scenario === 'observation-transport') observation.transport.status = 201;
    if (scenario === 'observation-task') observation.task = { status: 'not_evaluated' };
    if (scenario === 'observation-checks') observation.task.checks[0].passed = false;
    if (scenario === 'observation-criteria') observation.task.criteriaVersion = 0;
    return response({ status, upstreamStatus: status, endpoint, body, kind: 'mcp', phase: 'tools/call', captureComplete,
      ...(scenario === 'missing-observation' ? {} : { observation }),
      ...(request.presetId ? { taskPreset: returned } : {}) });
  }
  throw new Error(`Unexpected smoke path ${url.pathname}`);
};
