import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifier } from '../src/verify/run.js';
import { identityObservation } from '../src/verify/identity.js';

const card = { name: 'Identity fixture' };
test('only an observed empty URI establishes absence; unreadable input is an incomplete check', () => {
  assert.deepEqual(identityObservation({ status: 'available', meta: card }), { status: 'available', card });
  assert.deepEqual(identityObservation({ status: 'absent', meta: null }), { status: 'absent', card: null });
  for (const status of ['invalid', 'unsupported']) assert.deepEqual(identityObservation({ status, meta: null }), { status, card: null });
  for (const result of [null, {}, { meta: null }, { meta: [] }, { status: 'available', meta: 42 },
    { status: 'unavailable', meta: card }]) {
    assert.throws(() => identityObservation(result), error => error.code === 'identity-unavailable' && error.retryable);
  }
});

test('identity outages preserve the earlier verdict, date and token, without seeding the verdict cache', async () => {
  const completed = { computedAt: '2026-09-08T12:00:00.000Z', tier: 'active', bap578: { tokenId: '11169', ownershipVerified: true } };
  const events = [];
  let writes = 0, cachedWrites = 0, reads = 0;
  const store = { record() { writes++; }, lastCheck: () => completed };
  const verify = createVerifier({
    store, verdictCache: { get() {}, set() { cachedWrites++; } }, accountCache: { get() {}, set() {} },
    readAgentDetail: async () => ({ contract_address: '0x' + '1'.repeat(40) }),
    readAgentMetadata: async () => {
      reads++;
      if (reads === 1) throw new Error('private provider URL or key');
      return { status: 'unavailable', uri: 'https://identity.example', meta: null };
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(verify('56', '338630', event => events.push(event)), error => {
      assert.equal(error.code, 'identity-unavailable');
      assert.equal(error.source, 'agent-identity');
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
  assert.equal(reads, 2, 'a later user retry reads again instead of receiving a cached incomplete verdict');
  assert.equal(writes, 0);
  assert.equal(cachedWrites, 0);
  assert.equal(store.lastCheck('56:338630'), completed);
  assert.ok(events.filter(event => event.step === 'card').every(event => event.status === 'unavailable' && event.ok === false));
  assert.ok(events.every(event => ['registry', 'card'].includes(event.step)), 'no endpoint/wallet verdict work follows failed identity retrieval');
});
