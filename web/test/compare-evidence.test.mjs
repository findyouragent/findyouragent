import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparisonColumn, comparisonName, comparisonCheckedAt, reconcileComparison,
  applySavedComparison, loadSavedComparison, loadComparison, unavailableComparisonParts,
} from '../src/lib/compare-evidence.js';

const key = '56:123';
const saved = {
  name: 'Saved agent', tier: 'active', endpointProven: true, endpointKind: 'mcp',
  checkedAt: '2026-09-01T12:34:56.789Z', fromStore: true,
  evidence: { endpoint: { latencyMs: 31 } }, hireable: null,
};
const fresh = { ...saved, name: 'Current agent', checkedAt: undefined, fromStore: false, computedAt: '2026-09-08T13:14:15.123Z', cached: false };
const unavailable = async () => { throw new Error('HTTP 502'); };
const api = () => ({ getAgentDetail: unavailable, getVerdict: unavailable, getAgentMeta: async () => null });

test('saved comparison maps exact identities and retains the original partial evidence and time', async () => {
  const seen = [];
  await loadSavedComparison([key, '8453:456'], { getKnownVerdicts: async (agents) => {
    assert.deepEqual(agents, [{ chain_id: '56', token_id: '123' }, { chain_id: '8453', token_id: '456' }]);
    return { [key]: saved, '8453:456': { ...saved, name: 'Other chain' }, '56:999': fresh };
  } }, (agentKey, verdict) => seen.push([agentKey, verdict]));
  assert.equal(seen.length, 2);
  let column = applySavedComparison(comparisonColumn(key), seen[0][1]);
  assert.equal(comparisonName(column), 'Saved agent');
  assert.equal(column.verdictSource, 'saved');
  assert.equal(comparisonCheckedAt(column.verdict), saved.checkedAt);
  assert.equal(column.verdict.computedAt, undefined);
  assert.equal(column.verdict.evidence.endpoint.declared, undefined);
  assert.equal(column.verdict.evidence.endpoint.reachable, undefined);
});

test('transient lookup, check and metadata failures preserve all saved evidence without claiming not found', async () => {
  let column = applySavedComparison(comparisonColumn(key), saved);
  await loadComparison({ key, api: api(), onPatch: (update) => { column = update(column); } });
  assert.equal(column.verdict, saved);
  assert.equal(column.verdictSource, 'saved');
  assert.equal(comparisonCheckedAt(column.verdict), saved.checkedAt);
  assert.equal(comparisonName(column), 'Saved agent');
  assert.equal(column.agentError.notFound, false);
  assert.match(column.agentError.message, /unavailable/);
  assert.equal(column.service, null);
  assert.equal(column.verdict.hireable, null);
  assert.deepEqual(unavailableComparisonParts(column), ['agent', 'verdict', 'meta']);
});

test('independent reads start without waiting for a stalled registry request', async () => {
  let releaseRegistry;
  let column = comparisonColumn(key);
  const calls = [];
  const pending = loadComparison({ key, timeoutMs: 100, api: {
    getAgentDetail: () => { calls.push('agent'); return new Promise((resolve) => { releaseRegistry = resolve; }); },
    getVerdict: async () => { calls.push('verdict'); return fresh; },
    getAgentMeta: async () => { calls.push('meta'); return { meta: null }; },
  }, onPatch: (update) => { column = update(column); } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.sort(), ['agent', 'meta', 'verdict']);
  assert.equal(column.verdict, fresh);
  assert.equal(column.agentLoading, true);
  releaseRegistry({ chain_id: 56, token_id: '123', name: 'Registry name' });
  await pending;
  assert.equal(comparisonName(column), 'Registry name');
  assert.equal(column.agentLoading, false);
});

test('manual recovery retries only failed reads and retains successful detail and menu', async () => {
  const actualAgent = { chain_id: 56, token_id: '123', name: 'Registry name' };
  const actualService = { provider: 'existing validated provider', offerings: [] };
  let column = { ...applySavedComparison(comparisonColumn(key), saved), agent: actualAgent, service: actualService, verdictError: { message: 'A fresh check is unavailable.' } };
  let verdictCalls = 0;
  await loadComparison({ key, parts: unavailableComparisonParts(column), api: {
    getAgentDetail: () => { throw new Error('Successful details must not be reloaded'); },
    getAgentMeta: () => { throw new Error('Successful metadata must not be reloaded'); },
    getVerdict: async () => { verdictCalls += 1; return fresh; },
  }, onPatch: (update) => { column = update(column); } });
  assert.equal(verdictCalls, 1);
  assert.equal(column.agent, actualAgent);
  assert.equal(column.service, actualService);
  assert.equal(column.verdict, fresh);
  assert.equal(column.verdictSource, 'check');
  assert.equal(column.verdictError, null);
});

test('cached verdicts stay saved and a slower older read cannot replace a newer verdict', async () => {
  let column = comparisonColumn(key);
  await loadComparison({ key, parts: ['verdict'], api: { getVerdict: async () => ({ ...fresh, cached: true }) }, onPatch: (update) => { column = update(column); } });
  assert.equal(column.verdictSource, 'saved');
  assert.equal(comparisonCheckedAt(column.verdict), fresh.computedAt);
  const retained = column.verdict;
  column = applySavedComparison(column, saved);
  assert.equal(column.verdict, retained);
  await loadComparison({ key, parts: ['verdict'], api: { getVerdict: async () => saved }, onPatch: (update) => { column = update(column); } });
  assert.equal(column.verdict, retained);
});

test('adding, removing and reordering columns preserves successful values by key', () => {
  const first = applySavedComparison(comparisonColumn(key), saved);
  const second = comparisonColumn('56:456');
  const reordered = reconcileComparison(['56:456', key, '56:789'], [first, second]);
  assert.equal(reordered[0], second);
  assert.equal(reordered[1], first);
  assert.equal(reordered[2].key, '56:789');
  assert.deepEqual(reconcileComparison([key], reordered), [first]);
});

test('metadata failure cannot clear a valid menu or invent one', async () => {
  const service = { provider: 'existing validated provider', offerings: [] };
  for (const previousService of [null, service]) {
    for (const result of [null, { meta: null }, { meta: [] }, { meta: 'invalid' }, { error: 'metadata-unavailable', meta: {} }]) {
      let column = { ...comparisonColumn(key), service: previousService };
      await loadComparison({ key, parts: ['meta'], api: { getAgentMeta: async () => result }, onPatch: (update) => { column = update(column); } });
      assert.equal(column.service, previousService);
      assert.match(column.metaError.message, /unavailable/);
      assert.deepEqual(unavailableComparisonParts(column), ['meta']);
    }
  }
});

test('a retrieved card without services resolves a prior metadata error as no published menu', async () => {
  let column = { ...comparisonColumn(key), metaError: { message: 'The hire menu is unavailable.' } };
  await loadComparison({ key, parts: ['meta'], api: { getAgentMeta: async () => ({ meta: { name: 'Agent without services' } }) },
    onPatch: (update) => { column = update(column); } });
  assert.equal(column.metaError, null);
  assert.equal(column.metaLoading, false);
  assert.equal(column.service, null);
});

test('mismatched and undated results cannot become another agent’s evidence', async () => {
  let column = applySavedComparison(comparisonColumn(key), saved);
  assert.equal(applySavedComparison(column, { ...fresh, agentId: '56:999' }), column);
  assert.equal(applySavedComparison(column, { ...fresh, computedAt: 'invalid' }), column);
  await loadComparison({ key, api: {
    getAgentDetail: async () => ({ chain_id: 56, token_id: '999', name: 'Wrong agent' }),
    getVerdict: async () => ({ ...fresh, agentId: '56:999' }),
    getAgentMeta: async () => ({ error: 'not metadata' }),
  }, onPatch: (update) => { column = update(column); } });
  assert.equal(column.agent, null);
  assert.equal(column.verdict, saved);
  assert.equal(column.service, null);
  assert.deepEqual(unavailableComparisonParts(column), ['agent', 'verdict', 'meta']);
});

test('stalled comparison reads stop showing loading and preserve saved data', async () => {
  let column = applySavedComparison(comparisonColumn(key), saved);
  await loadComparison({ key, parts: ['verdict'], timeoutMs: 5, api: { getVerdict: () => new Promise(() => {}) }, onPatch: (update) => { column = update(column); } });
  assert.equal(column.verdictLoading, false);
  assert.ok(column.verdictError);
  assert.equal(column.verdict, saved);
});
