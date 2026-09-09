import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentMetadataHandler } from '../src/agent-metadata.js';

function response() {
  return { statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, set(name, value) { this.headers[name] = value; return this; }, json(value) { this.body = value; return this; } };
}
function cache() {
  const values = new Map();
  return { get: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key), values };
}
function make({ metadata, detail = { contract_address: '0xregistry' }, registryError } = {}) {
  const accountCache = cache();
  let metadataCalls = 0;
  const handler = createAgentMetadataHandler({
    cache: accountCache,
    getAgentDetail: async () => detail,
    getAgentMetadata: async () => {
      metadataCalls++;
      if (registryError) throw registryError;
      return typeof metadata === 'function' ? metadata() : metadata;
    },
    mediaFromRegistration: async () => null,
    mediaFromMeta: () => null,
    bap578FromCard: () => null,
    registryFailure: (res, error) => res.status(error.status ?? 502).json({ error: 'registry-preserved', source: '8004scan' }),
  });
  return { handler, accountCache, get metadataCalls() { return metadataCalls; } };
}

for (const value of [null, [], 'bad', 7]) {
  test(`invalid metadata ${String(value)} is a typed failure and is not cached`, async () => {
    const app = make({ metadata: { uri: 'ipfs://fixture', meta: value } });
    const first = response();
    await app.handler({ params: { chainId: '56', tokenId: '45650' } }, first);
    assert.equal(first.statusCode, 502);
    assert.deepEqual(first.body, { error: 'metadata-unavailable', source: 'agent-metadata', retryable: true, detail: 'Agent metadata could not be retrieved.' });
    assert.equal(app.accountCache.values.size, 0);
  });
}

test('invalid cached payload is ignored, then a successful retry is cached', async () => {
  const app = make({ metadata: { uri: 'ipfs://fixture', meta: { name: 'valid' } } });
  app.accountCache.set('meta:56:45650', { uri: 'ipfs://old', meta: null, media: null });
  const res = response();
  await app.handler({ params: { chainId: '56', tokenId: '45650' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.meta.name, 'valid');
  assert.equal(app.metadataCalls, 1);
  assert.equal(app.accountCache.values.get('meta:56:45650'), res.body);
});

test('failure then success is retried and the third request uses the cached success', async () => {
  let metadata = { uri: 'ipfs://fixture', meta: null };
  const app = make({ metadata: () => metadata });
  const req = { params: { chainId: '56', tokenId: '45650' } };
  const failed = response();
  await app.handler(req, failed);
  assert.equal(failed.statusCode, 502);
  assert.equal(app.accountCache.values.size, 0);
  assert.equal(app.metadataCalls, 1);
  metadata = { uri: 'ipfs://fixture', meta: { name: 'valid' } };
  const succeeded = response();
  await app.handler(req, succeeded);
  assert.equal(succeeded.statusCode, 200);
  assert.equal(succeeded.body.meta.name, 'valid');
  assert.equal(app.metadataCalls, 2);
  const cached = response();
  await app.handler(req, cached);
  assert.equal(cached.statusCode, 200);
  assert.deepEqual(cached.body, succeeded.body);
  assert.equal(app.metadataCalls, 2);
});

test('unexpected reader exceptions are redacted into the stable typed failure', async () => {
  const app = make({ registryError: new Error('private RPC credential or URL') });
  const res = response();
  await app.handler({ params: { chainId: '56', tokenId: '45650' } }, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'metadata-unavailable', source: 'agent-metadata', retryable: true, detail: 'Agent metadata could not be retrieved.' });
  assert.ok(!JSON.stringify(res.body).includes('private RPC'));
});

test('valid metadata without services remains successful', async () => {
  const app = make({ metadata: { uri: 'ipfs://fixture', meta: { name: 'no service declaration' } } });
  const res = response();
  await app.handler({ params: { chainId: '56', tokenId: '45650' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.meta, { name: 'no service declaration' });
});

test('typed registry failures pass through unchanged', async () => {
  const app = make({ registryError: Object.assign(new Error('upstream'), { source: '8004scan', status: 503 }) });
  const res = response();
  await app.handler({ params: { chainId: '56', tokenId: '45650' } }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'registry-preserved', source: '8004scan' });
  assert.equal(app.accountCache.values.size, 0);
});

const metadataRequest = { params: { chainId: '56', tokenId: '338558' } };
const refreshRequest = { ...metadataRequest, query: { refresh: '1' } };
const menu = { name: 'erc8183', endpoint: 'eip155:56:0x35573171fEDc3528421A4aaF625d7be56C93f9Ee', offerings: [{ id: 'venus-account-health-report', priceU: '1000000000000000000' }] };

test('refresh discovers a newly published hire menu and replaces it when removed', async () => {
  let metadata = { uri: 'ipfs://before', meta: { services: [] } };
  const app = make({ metadata: () => metadata });
  await app.handler(metadataRequest, response());
  metadata = { uri: 'ipfs://published', meta: { services: [menu] } };
  const cached = response();
  await app.handler(metadataRequest, cached);
  assert.deepEqual(cached.body.meta.services, []);
  assert.equal(app.metadataCalls, 1);
  const refreshed = response();
  await app.handler(refreshRequest, refreshed);
  assert.equal(refreshed.headers['Cache-Control'], 'no-store');
  assert.equal(refreshed.body.uri, 'ipfs://published');
  assert.deepEqual(refreshed.body.meta.services, [menu]);
  const updated = response();
  await app.handler(metadataRequest, updated);
  assert.deepEqual(updated.body, refreshed.body);
  assert.equal(app.metadataCalls, 2);
  metadata = { uri: 'ipfs://removed', meta: { services: [] } };
  const removed = response();
  await app.handler(refreshRequest, removed);
  assert.deepEqual(removed.body.meta.services, []);
  assert.equal(app.metadataCalls, 3);
});

test('failed refresh removes the previous menu and does not become a cached absence', async () => {
  let metadata = { meta: { services: [menu] } };
  const app = make({ metadata: () => metadata });
  await app.handler(metadataRequest, response());
  metadata = { meta: null };
  const refreshed = response();
  await app.handler(refreshRequest, refreshed);
  assert.equal(refreshed.statusCode, 502);
  assert.equal(app.accountCache.values.size, 0);
  const retry = response();
  await app.handler(metadataRequest, retry);
  assert.equal(retry.statusCode, 502);
  assert.equal(app.metadataCalls, 3);
});

for (const warmCache of [false, true]) {
  test(`${warmCache ? 'refresh' : 'cold'} concurrent requests share a read and ordinary requests join it`, async () => {
    let finish;
    const app = make({ metadata: () => new Promise(resolve => { finish = resolve; }) });
    if (warmCache) app.accountCache.set('meta:56:338558', { meta: { services: [] } });
    const first = response(), second = response(), ordinary = response();
    const pending = [
      app.handler(warmCache ? refreshRequest : metadataRequest, first),
      app.handler(refreshRequest, second),
      app.handler(metadataRequest, ordinary),
    ];
    await Promise.resolve();
    assert.equal(app.metadataCalls, 1);
    finish({ meta: { services: [menu] } });
    await Promise.all(pending);
    for (const result of [first, second, ordinary]) {
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body.meta.services, [menu]);
    }
    await app.handler(metadataRequest, response());
    assert.equal(app.metadataCalls, 1);
  });
}

test('a failed shared read releases its slot for a successful retry', async () => {
  const app = make({ metadata: (() => {
    let calls = 0;
    return () => { if (++calls === 1) throw new Error('transient'); return { meta: { services: [menu] } }; };
  })() });
  const first = response(), second = response();
  await Promise.all([app.handler(refreshRequest, first), app.handler(refreshRequest, second)]);
  assert.equal(first.statusCode, 502);
  assert.equal(second.statusCode, 502);
  assert.equal(app.metadataCalls, 1);
  const retry = response();
  await app.handler(refreshRequest, retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(app.metadataCalls, 2);
});
