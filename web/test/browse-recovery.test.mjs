import assert from 'node:assert/strict';
import { recoverRegistryRows, registryFailureMessage, bscCountFromStats, bscCountFromList, newestRegistryCount } from '../src/lib/browse-recovery.js';

const row = (id, extra = {}) => ({ chain_id: 56, token_id: String(id), name: `Agent ${id}`, ...extra });
const registry = (agents) => ({ agents, pagination: { page: 1, limit: 25, total: agents.length, hasMore: false } });
let passed = 0;
async function test(name, run) {
  try { await run(); passed++; }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

await test('checked, capability and curated evidence survives an immediate registry outage', async () => {
  for (const kind of ['checked', 'capability', 'curated']) {
    const saved = [row(1)];
    let published;
    const result = await recoverRegistryRows({ registry: Promise.reject(new Error('Registry unavailable.')),
      saved: Promise.resolve(saved), kind, onSaved: (rows) => { published = rows; } });
    assert.deepEqual(result.agents, saved);
    assert.deepEqual(published, saved);
    assert.equal(result.pagination, null);
    assert.ok(result.registryFailure.includes('remain available below'));
    assert.equal(result.verifiedCount, kind === 'checked' ? 1 : 0);
    assert.equal(result.capabilityHits, kind === 'capability' ? 1 : 0);
  }
});

await test('saved evidence publishes before a slow registry finishes', async () => {
  let finishRegistry;
  let published = false;
  let complete = false;
  const pending = recoverRegistryRows({ registry: new Promise((resolve) => { finishRegistry = resolve; }),
    saved: [row(1)], kind: 'curated', onSaved: () => { published = true; } }).then((result) => { complete = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, true);
  assert.equal(complete, false);
  finishRegistry(registry([row(2)]));
  assert.deepEqual((await pending).agents.map((agent) => agent.token_id), ['1', '2']);
});

await test('failed saved source does not suppress registry results, while two failures never become empty success', async () => {
  const result = await recoverRegistryRows({ registry: registry([row(2)]), saved: Promise.reject(new Error('saved unavailable')), kind: 'checked' });
  assert.deepEqual(result.agents, [row(2)]);
  assert.equal(result.registryFailure, null);
  await assert.rejects(recoverRegistryRows({ registry: Promise.reject(new Error('registry unavailable')),
    saved: Promise.reject(new Error('saved unavailable')), kind: 'curated' }), /registry unavailable/);
});

await test('merging preserves capability evidence and canonical identity without duplicate rows', async () => {
  const result = await recoverRegistryRows({ registry: registry([row(1, { image_url: 'poster.png' }), row(2)]),
    saved: [row('01', { matchedTool: 'vaults', name: 'Measured vault' })], kind: 'capability' });
  assert.equal(result.agents.length, 2);
  assert.equal(result.agents[0].matchedTool, 'vaults');
  assert.equal(result.agents[0].image_url, 'poster.png');
  assert.equal(result.agents[0].name, 'Measured vault');
});

await test('an outdated service is never called an upstream outage', async () => {
  const message = registryFailureMessage({ code: 'registry-service-outdated' }, 'checked');
  assert.match(message, /^This FYA service does not support registry browsing yet/);
  assert.doesNotMatch(message, /upstream|8004scan.*unavailable/);
});

await test('statistics normalize numeric chain strings and preserve a genuine zero', async () => {
  const at = '2026-09-08T09:00:00.000Z';
  assert.deepEqual(bscCountFromStats({ chain_stats: [{ chain_id: '56', total_agents: 0 }] }, at),
    { total: 0, source: 'statistics', retrievedAt: at });
  for (const stats of [{}, { chain_stats: [] }, { chain_stats: [{ chain_id: 1, total_agents: 99 }] },
    { chain_stats: [{ chain_id: 56, total_agents: '3' }] }, { chain_stats: [{ chain_id: 56, total_agents: -1 }] }]) {
    assert.equal(bscCountFromStats(stats), null);
  }
});

await test('search pagination cannot replace the BSC total; only marked unfiltered BSC reads can', async () => {
  assert.equal(bscCountFromList(registry([row(1)])), null);
  const retrievedAt = '2026-09-08T09:00:00.000Z';
  const marker = { chainId: 56, total: 0, source: 'unfiltered-list', retrievedAt };
  assert.deepEqual(bscCountFromList({ registryCount: marker }), { total: 0, source: 'unfiltered-list', retrievedAt });
  for (const altered of [{ chainId: 1 }, { source: 'semantic' }, { total: -1 }, { total: '5' }, { retrievedAt: 'unknown' }]) {
    assert.equal(bscCountFromList({ registryCount: { ...marker, ...altered } }), null);
  }
});

await test('a later failed or older response cannot erase a previously retrieved count', async () => {
  const current = { total: 300000, source: 'unfiltered-list', retrievedAt: '2026-09-08T09:00:00.000Z' };
  assert.equal(newestRegistryCount(current, null), current);
  assert.equal(newestRegistryCount(current, { ...current, total: 299999, retrievedAt: '2026-09-08T08:59:00.000Z' }), current);
  const later = { ...current, total: 300001, retrievedAt: '2026-09-08T09:01:00.000Z' };
  assert.equal(newestRegistryCount(current, later), later);
});

console.log(`browse recovery: ${passed} passed`);
