import assert from 'node:assert/strict';
import test from 'node:test';
import { anchoredMemoryCount, fetchMemoryEvidence, memorySourceHref, provenTokenAccount } from '../src/lib/memory-evidence.js';

const address = '0x' + '1'.repeat(40);
const hash = '0x' + '2'.repeat(64);
const uri = 'ipfs://QmWYREUJm7E81ngPq23kRQuhzgkD9JkLSTnFKdU747VsJt';
const source = { sourceId: '11243', uri, contentHash: hash, active: true };
const record = { key: '56:338630', status: 'anchored', sources: [source], blockNumber: 120000000,
  registryAddress: address, collection: address, bapTokenId: '11169', checkedAt: '2026-09-08T18:00:00Z' };
const options = { serviceBase: 'https://fya.example/', chainId: 56, tokenId: '338630' };
const read = body => fetchMemoryEvidence({ ...options, fetchImpl: async () => ({ ok: true, json: async () => body }) });

test('only a checked TBA attributed to this agent receives the token-controlled label', () => {
  const bap578 = { ownershipVerified: true, transferable: { checked: true, tba: address } };
  assert.equal(provenTokenAccount({ bap578 }), address);
  for (const b of [undefined, {}, { ...bap578, ownershipVerified: false },
    { ...bap578, transferable: { tba: address } },
    { ...bap578, transferable: { checked: true, tba: '0x' + '0'.repeat(40) } },
    { ...bap578, transferable: { checked: true, tba: 'not-an-address' } }]) {
    assert.equal(provenTokenAccount({ bap578: b, agent_wallet: address, owner_address: address }), null);
  }
});

test('memory links allow IPFS and HTTPS without making source content executable', () => {
  assert.equal(memorySourceHref(uri), uri.replace('ipfs://', 'https://ipfs.io/ipfs/'));
  assert.equal(memorySourceHref(uri + '/memory.json'), uri.replace('ipfs://', 'https://ipfs.io/ipfs/') + '/memory.json');
  assert.equal(memorySourceHref('https://example.org/memory.json'), 'https://example.org/memory.json');
  for (const bad of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/secret',
    'http://example.org', 'https://user:pass@example.org', 'https://example.org/\nfoo',
    'https://example.org/\\evil', uri + '/../x', uri + '/%2e%2e/x', uri + '/%GG',
    'ipfs://not-a-cid', null]) assert.equal(memorySourceHref(bad), null, String(bad));
});

test('only active nonzero commitments count as anchored', async () => {
  const inactive = { ...source, active: false };
  const zero = { ...source, contentHash: '0x' + '0'.repeat(64) };
  assert.equal(anchoredMemoryCount([source, inactive, zero]), 1);
  for (const sources of [[], [inactive], [zero]]) {
    assert.equal((await read({ ...record, sources })).status, 'unavailable');
    assert.equal((await read({ ...record, status: 'not-anchored', sources })).status, 'not-anchored');
  }
  assert.equal((await read({ ...record, status: 'not-anchored' })).status, 'unavailable');
});

test('identity mismatches and malformed provenance cannot be displayed as evidence', async () => {
  assert.deepEqual(await read(record), record);
  for (const changed of [{ key: '56:338558' }, { blockNumber: null }, { checkedAt: 'invalid' },
    { registryAddress: 'bad' }, { collection: null }, { bapTokenId: '../11169' },
    { sources: [{ ...source, contentHash: 'truncated' }] }, { status: 'verified' }]) {
    const result = await read({ ...record, ...changed });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.sources, []);
  }
});

test('a failed or stalled request stays unavailable and sends no credentials', async () => {
  let observed;
  const failed = await fetchMemoryEvidence({ ...options, fetchImpl: async (url, init) => {
    observed = { url, init };
    return { ok: false };
  } });
  assert.equal(failed.status, 'unavailable');
  assert.equal(observed.url, 'https://fya.example/api/memory/56/338630');
  assert.equal(observed.init.credentials, 'omit');
  const stalled = await fetchMemoryEvidence({ ...options, timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  assert.equal(stalled.status, 'unavailable');
  assert.deepEqual(stalled.sources, []);
});
