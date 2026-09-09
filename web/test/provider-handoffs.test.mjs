import assert from 'node:assert/strict';
import { providerHandoff } from '../src/data/provider-handoffs.js';

const grid = { chain_id: 56, token_id: '269703', owner_address: '0xd6db7ade6ed34d1cf0836d7a1aac5ba3b860c82a', agent_wallet: '0xd6db7ade6ed34d1cf0836d7a1aac5ba3b860c82a', raw_metadata: { offchain_uri: 'https://agripinaa.vercel.app/manifests/grid.json' } };
assert.equal(providerHandoff(grid).setupUrl, 'https://agripinaa.vercel.app/agent/56/269703/activate');
for (const change of [{ chain_id: 1 }, { token_id: '269704' }, { owner_address: '0xwrong' }, { agent_wallet: '0xwrong' }, { raw_metadata: {} }, { raw_metadata: { offchain_uri: 'https://example.com/grid.json' } }]) {
  assert.equal(providerHandoff({ ...grid, ...change }), null, JSON.stringify(change));
}
assert.equal(providerHandoff(null), null);
assert.ok(providerHandoff({ ...grid, owner_address: grid.owner_address.toUpperCase(), agent_wallet: grid.agent_wallet.toUpperCase() }));
const ranger = { chain_id: 56, token_id: '269706', owner_address: '0x79827ef1fadea3b30a8e77fdbaf17944298a3bb6', agent_wallet: '0x79827ef1fadea3b30a8e77fdbaf17944298a3bb6', raw_metadata: { offchain_uri: 'https://agripinaa.vercel.app/manifests/lp-range.json' } };
assert.equal(providerHandoff(ranger).relatedTask.href, '#/agent/56/45650/try');
assert.ok(providerHandoff(grid).limitation.includes('not independently confirmed'));
console.log('provider-handoffs: identity binding and evidence scope checks passed');
