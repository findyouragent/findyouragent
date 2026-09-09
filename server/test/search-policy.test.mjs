import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTools, handleMcp, openapi } from '../src/machine.js';
import { createStore, queryTokens } from '../src/store.js';
import {
  SEARCH_LIMITS, SearchPolicyError, createSearchControl, createSearchRouteHandler,
  estimateSearchWork, validateSearchQuery,
} from '../src/search-policy.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name.toLowerCase()] = String(value); return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function mcpSearch(tools, task, ip = 'mcp-client') {
  return handleMcp({
    id: 1,
    method: 'tools/call',
    params: { name: 'search_agents', arguments: task },
  }, tools, { ip });
}

test('query validation counts Unicode code points and distinct store tokens', () => {
  const unicode = validateSearchQuery('😀'.repeat(SEARCH_LIMITS.maxCharacters), { tokenize: queryTokens });
  assert.equal(unicode.characters, SEARCH_LIMITS.maxCharacters);
  assert.deepEqual(unicode.tokens, []);

  assert.throws(
    () => validateSearchQuery('😀'.repeat(SEARCH_LIMITS.maxCharacters + 1), { tokenize: queryTokens }),
    (error) => error instanceof SearchPolicyError && error.code === 'search-query-too-long',
  );
  assert.throws(
    () => validateSearchQuery(' '.repeat(SEARCH_LIMITS.maxCharacters + 1), { tokenize: queryTokens }),
    (error) => error.code === 'search-query-too-long',
  );
  assert.throws(
    () => validateSearchQuery(' \t\n ', { tokenize: queryTokens }),
    (error) => error.code === 'search-query-required',
  );

  const repeated = validateSearchQuery('venus '.repeat(60), { tokenize: queryTokens });
  assert.deepEqual(repeated.tokens, ['venus']);
  const distinct = Array.from({ length: SEARCH_LIMITS.maxUniqueTokens + 1 }, (_, i) => `term${i}`).join(' ');
  assert.throws(
    () => validateSearchQuery(distinct, { tokenize: queryTokens }),
    (error) => error.code === 'search-query-too-many-terms',
  );
});

test('control expires fixed windows and keeps the client map bounded', () => {
  let clock = 10_000;
  const control = createSearchControl({
    now: () => clock,
    windowMs: 1_000,
    perIpRequests: 2,
    globalWorkUnits: 100,
    maxClientBuckets: 2,
  });
  control.consume({ ip: 'a', workUnits: 1 });
  control.consume({ ip: 'a', workUnits: 1 });
  assert.throws(() => control.consume({ ip: 'a', workUnits: 1 }), (error) => (
    error.code === 'search-rate-limited' && error.retryAfterSeconds === 1
  ));

  control.consume({ ip: 'b', workUnits: 1 });
  control.consume({ ip: 'c', workUnits: 1 });
  assert.equal(control.stats().clientBuckets, 2);
  assert.equal(control.stats().overflowCount, 1);
  assert.throws(
    () => control.consume({ ip: 'a', workUnits: 1 }),
    (error) => error.code === 'search-rate-limited',
    'filling the bounded map cannot evict and reopen an already limited client',
  );

  clock += 1_000;
  assert.doesNotThrow(() => control.consume({ ip: 'a', workUnits: 1 }));
  assert.ok(control.stats().clientBuckets <= 2);
});

test('a full-weight query is denied before scanning when shared capacity is smaller', () => {
  const control = createSearchControl({ perIpRequests: 100, globalWorkUnits: 4_500_000 });
  let scans = 0;
  const store = {
    searchCorpusStats: () => ({ records: 1_000, agents: 1_000, servedNames: 100_000, servedNameCharacters: 3_000_000 }),
    searchServed() { scans += 1; return []; },
  };
  const route = createSearchRouteHandler({ store, searchControl: control, tokenize: queryTokens });
  const fullWeight = Array.from({ length: SEARCH_LIMITS.maxUniqueTokens }, (_, i) => `bounded${i}`).join(' ');
  const denied = response();
  route({ query: { q: fullWeight }, ip: 'client-a' }, denied);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.body.error, 'search-capacity-limited');
  assert.equal(scans, 0);

  const accepted = response();
  route({ query: { q: 'venus' }, ip: 'client-b' }, accepted);
  assert.equal(accepted.statusCode, 200, 'a rejection does not increment or reset the global counter');
  assert.equal(scans, 1);
});

test('process work budget survives distributed client and protocol changes', () => {
  const control = createSearchControl({ perIpRequests: 100, globalWorkUnits: 2_220, maxClientBuckets: 1 });
  const calls = [];
  const store = {
    searchCorpusStats: () => ({ records: 10, agents: 10, servedNames: 100, servedNameCharacters: 1_000 }),
    searchServed(query) { calls.push(query); return []; },
  };
  const route = createSearchRouteHandler({ store, searchControl: control, tokenize: queryTokens });
  const tools = buildTools(store, { searchControl: control });

  const rest = response();
  route({ query: { q: 'venus' }, ip: 'rest-client' }, rest);
  assert.equal(rest.statusCode, 200);
  assert.equal(rest.headers['x-search-work-remaining'], '1110');

  const mcp = mcpSearch(tools, { task: 'lending' }, 'mcp-client');
  assert.equal(mcp.result.isError, false);
  const denied = mcpSearch(tools, { task: 'trading' }, 'rotated-client');
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error, 'search-capacity-limited');
  assert.equal(calls.length, 2, 'denied work never reaches the synchronous store scan');
});

test('REST and MCP reject aliases, overlong text, and excess terms with stable shapes', () => {
  const control = createSearchControl({ perIpRequests: 100, globalWorkUnits: 100_000 });
  let scans = 0;
  const store = {
    searchCorpusStats: () => ({ records: 10, agents: 10, servedNames: 100, servedNameCharacters: 1_000 }),
    searchServed() { scans += 1; return []; },
  };
  const route = createSearchRouteHandler({ store, searchControl: control, tokenize: queryTokens });
  const tools = buildTools(store, { searchControl: control });

  const alias = response();
  route({ query: { task: 'venus' }, ip: 'rest' }, alias);
  assert.equal(alias.statusCode, 400);
  assert.equal(alias.body.error, 'search-query-required');
  assert.equal(alias.body.limits.maxCharacters, SEARCH_LIMITS.maxCharacters);

  const tooLong = response();
  route({ query: { q: 'x'.repeat(SEARCH_LIMITS.maxCharacters + 1) }, ip: 'rest' }, tooLong);
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.body.error, 'search-query-too-long');

  const whitespace = response();
  route({ query: { q: '\u2003\n\t' }, ip: 'rest' }, whitespace);
  assert.equal(whitespace.statusCode, 400);
  assert.equal(whitespace.body.error, 'search-query-required');

  const unicode = response();
  route({ query: { q: '😀'.repeat(SEARCH_LIMITS.maxCharacters + 1) }, ip: 'rest' }, unicode);
  assert.equal(unicode.statusCode, 400);
  assert.equal(unicode.body.error, 'search-query-too-long');

  const terms = Array.from({ length: SEARCH_LIMITS.maxUniqueTokens + 1 }, (_, i) => `word${i}`).join(' ');
  const restTerms = response();
  route({ query: { q: terms }, ip: 'rest' }, restTerms);
  assert.equal(restTerms.statusCode, 400);
  assert.equal(restTerms.body.error, 'search-query-too-many-terms');

  const mcpAlias = mcpSearch(tools, { q: 'venus' });
  assert.equal(mcpAlias.result.isError, true);
  assert.equal(mcpAlias.result.structuredContent.error, 'search-query-required');
  const mcpTerms = mcpSearch(tools, { task: terms });
  assert.equal(mcpTerms.result.isError, true);
  assert.equal(mcpTerms.result.structuredContent.error, 'search-query-too-many-terms');
  const mcpWhitespace = mcpSearch(tools, { task: '\u2003\n\t' });
  assert.equal(mcpWhitespace.result.structuredContent.error, 'search-query-required');
  const mcpUnicode = mcpSearch(tools, { task: '😀'.repeat(SEARCH_LIMITS.maxCharacters + 1) });
  assert.equal(mcpUnicode.result.structuredContent.error, 'search-query-too-long');

  const repeated = 'venus '.repeat(60);
  const restRepeated = response();
  route({ query: { q: repeated }, ip: 'rest' }, restRepeated);
  assert.equal(restRepeated.statusCode, 200);
  assert.equal(mcpSearch(tools, { task: repeated }).result.isError, false);
  assert.equal(scans, 2, 'repeated terms count once and valid REST/MCP searches reach the store');
});

test('the store itself preserves empty-query compatibility but rejects over-cap direct calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-search-policy-'));
  try {
    const store = createStore(path.join(dir, 'verdicts.jsonl'), { seedFile: null });
    assert.deepEqual(store.searchServed(''), []);
    assert.deepEqual(store.searchServed(), []);
    assert.deepEqual(store.searchServed(null), []);
    assert.throws(
      () => store.searchServed('x'.repeat(SEARCH_LIMITS.maxCharacters + 1)),
      (error) => error.code === 'search-query-too-long',
    );
    const terms = Array.from({ length: SEARCH_LIMITS.maxUniqueTokens + 1 }, (_, i) => `direct${i}`).join(' ');
    assert.throws(
      () => store.searchServed(terms),
      (error) => error.code === 'search-query-too-many-terms',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schemas advertise the same query limits enforced at runtime', () => {
  const tools = buildTools({
    searchCorpusStats: () => ({ records: 0, agents: 0, servedNames: 0, servedNameCharacters: 0 }),
    searchServed: () => [],
  });
  const task = tools.find((tool) => tool.name === 'search_agents').inputSchema.properties.task;
  const q = openapi('https://fixture.invalid', tools).paths['/api/search'].get.parameters[0].schema;
  assert.equal(task.maxLength, SEARCH_LIMITS.maxCharacters);
  assert.equal(q.maxLength, SEARCH_LIMITS.maxCharacters);
  assert.equal(task.minLength, 1);
  assert.equal(q.minLength, 1);
});

test('corpus-weighted estimate rejects broad work before any comparison loop', () => {
  const tokens = Array.from({ length: 16 }, (_, i) => `token${i}`);
  assert.deepEqual(estimateSearchWork(tokens, {
    records: 1_000, servedNames: 120_000, servedNameCharacters: 3_797_160,
  }), {
    workUnits: 5_718_160,
    comparisons: 1_920_000,
    records: 1_000,
    servedNames: 120_000,
    servedNameCharacters: 3_797_160,
    terms: 16,
  });
  assert.throws(
    () => estimateSearchWork(tokens, {
      records: 1_000, servedNames: 130_000, servedNameCharacters: 4_500_000,
    }, { field: 'task' }),
    (error) => error.code === 'search-query-too-broad' && /use at most 11/.test(error.message),
  );

  assert.equal(estimateSearchWork(['venus'], {
    records: 50_000, servedNames: 0, servedNameCharacters: 0,
  }).workUnits, 50_000, 'records with no served names still cost one visit each');
  assert.throws(
    () => estimateSearchWork(['venus'], {
      records: 1, servedNames: 1, servedNameCharacters: SEARCH_LIMITS.maxWorkUnitsPerQuery,
    }),
    (error) => error.code === 'search-query-too-broad' && /corpus is currently too large/.test(error.message),
  );
});

test('REST and MCP expose the same helpful dynamic-corpus rejection', () => {
  let scans = 0;
  const store = {
    searchCorpusStats: () => ({
      records: 1,
      agents: 1,
      servedNames: 1,
      servedNameCharacters: SEARCH_LIMITS.maxWorkUnitsPerQuery,
    }),
    searchServed() { scans += 1; return []; },
  };
  const control = createSearchControl();
  const route = createSearchRouteHandler({ store, searchControl: control, tokenize: queryTokens });
  const tools = buildTools(store, { searchControl: control });

  const rest = response();
  route({ query: { q: 'venus' }, ip: 'rest' }, rest);
  assert.equal(rest.statusCode, 400);
  assert.equal(rest.body.error, 'search-query-too-broad');
  assert.equal(rest.body.limits.maxWorkUnitsPerQuery, SEARCH_LIMITS.maxWorkUnitsPerQuery);

  const mcp = mcpSearch(tools, { task: 'venus' });
  assert.equal(mcp.result.isError, true);
  assert.equal(mcp.result.structuredContent.error, 'search-query-too-broad');
  assert.match(mcp.result.structuredContent.detail, /corpus is currently too large/);
  assert.equal(scans, 0);
});
