import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { createRegistryClient, REGISTRY_DETAIL_TIMEOUT_MS } from '../src/sources/scan8004.js';
import { createWorkAdmission } from '../src/work-admission.js';

const rawAgent = (token = '1') => ({ chain_id: 56, token_id: token, name: 'Fixture' });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const empty = (url) => {
  const query = new URL(url).searchParams;
  return response({ items: [], total: 0, limit: Number(query.get('limit')), offset: Number(query.get('offset')) });
};
const client = (fetchImpl, options = {}) => {
  const { admission = createWorkAdmission(), ...rest } = options;
  return createRegistryClient({
    baseUrl: 'https://api.8004scan.io/api/v1', apiKey: '', fetchImpl, retryBaseMs: 0,
    ...rest, admission,
  });
};
const failedResponse = (status, cancel, headers = {}) => ({
  ok: false, status, headers: new Headers(headers), body: { cancel },
});

test('a transient HTTP 502 is retried and the official raw page is returned', async () => {
  let calls = 0;
  const registry = client(async (url) => ++calls < 3 ? response({}, 502) : empty(url));
  assert.deepEqual(await registry.listAgents({ chainId: 56, page: 1 }), []);
  assert.equal(calls, 3);
});

test('persistent gateway errors stop after three attempts and preserve vendor attribution', async () => {
  let calls = 0;
  const registry = client(async () => { calls += 1; return response({}, 502); });
  await assert.rejects(registry.listAgents({ page: 2 }), (error) => error.status === 502 && error.source === '8004scan');
  assert.equal(calls, 3);
});

test('404, malformed JSON and legacy envelopes are not retried or converted to empty data', async () => {
  for (const failed of [() => response({}, 404), () => new Response('<html>not JSON</html>'), () => response({ data: [] })]) {
    let calls = 0;
    const registry = client(async () => { calls += 1; return failed(); });
    await assert.rejects(registry.getAgentPage(), (error) => error.source === '8004scan'
      && (error.status === 404 || error.code === 'registry-invalid-response'));
    assert.equal(calls, 1);
  }
});

test('bare transport failure may recover within the same operation', async () => {
  let calls = 0;
  const registry = client(async (url) => { if (++calls === 1) throw new TypeError('Connection reset'); return empty(url); });
  await registry.listAgents({ page: 4 });
  assert.equal(calls, 2);
});

test('explicit transport timeout is never retried', async () => {
  let calls = 0;
  const registry = client(async () => { calls += 1; throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(registry.listAgents(), (error) => error.name === 'TimeoutError' && error.source === '8004scan');
  assert.equal(calls, 1);
});

test('one deadline includes stalled body reads and retry backoff', async () => {
  for (const stallAtBody of [true, false]) {
    let calls = 0;
    let signal;
    const registry = client(async (_url, options) => {
      calls += 1;
      signal = options.signal;
      return stallAtBody ? { ok: true, status: 200, json: () => new Promise(() => {}) } : response({}, 502);
    }, { listTimeoutMs: 8, retryBaseMs: 100 });
    await assert.rejects(registry.getAgentPage(), (error) => error.name === 'TimeoutError' && error.source === '8004scan');
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  }
});

test('semantic search has a separate shorter whole-operation budget', async () => {
  let signal;
  const registry = client(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { searchTimeoutMs: 5 });
  await assert.rejects(registry.searchAgentPage({ q: 'lending', chainId: 56 }), (error) => error.name === 'TimeoutError');
  assert.equal(signal.aborted, true);
});

test('registry detail can complete beyond the provider probe budget within its own 12 s deadline', async (t) => {
  assert.equal(config.probeTimeoutMs, 6000, 'the provider probe budget remains unchanged');
  assert.equal(REGISTRY_DETAIL_TIMEOUT_MS, 12_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let settled = false;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = client(async (_url, options) => {
    signal = options.signal;
    markStarted();
    await new Promise((resolve) => setTimeout(resolve, 10_800));
    return response(rawAgent('1'));
  });
  const pending = registry.getAgentDetail(56, '1').then((value) => { settled = true; return value; });
  await started;
  t.mock.timers.tick(config.probeTimeoutMs);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(signal.aborted, false, 'registry detail does not inherit the shorter provider deadline');
  t.mock.timers.tick(4800);
  assert.deepEqual(await pending, rawAgent('1'));
  assert.equal(signal.aborted, false);
});

test('the default registry detail deadline still covers a stalled response body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = client(async (_url, options) => {
    signal = options.signal;
    markStarted();
    calls += 1;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  const rejected = assert.rejects(registry.getAgentDetail(56, '1'),
    (error) => error.name === 'TimeoutError' && error.source === '8004scan');
  await started;
  t.mock.timers.tick(REGISTRY_DETAIL_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1, 'the whole-operation deadline does not restart for another attempt');
});

test('owner evidence retains its 6 s budget independently of slower agent details', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = client(async (_url, options) => {
    signal = options.signal;
    markStarted();
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  const pending = registry.getAccountAgentCount('0x' + 'aa'.repeat(20));
  await started;
  t.mock.timers.tick(config.probeTimeoutMs - 1);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, null);
  assert.equal(signal.aborted, true);
});

test('429 honors a Retry-After longer than one minute without another fetch', async () => {
  let calls = 0;
  const registry = client(async () => { calls += 1; return response({}, 429, { 'retry-after': '3600' }); });
  await assert.rejects(registry.getAgentPage(), (error) => error.status === 429 && error.rateLimited
    && error.source === '8004scan' && error.retryAfterSeconds >= 3599);
  await assert.rejects(registry.getAgentDetail(56, '9'), (error) => error.rateLimited && error.retryAfterSeconds > 60);
  assert.equal(registry.isRateLimited(), true);
  assert.equal(calls, 1);
});

test('a concurrent shorter 429 never lowers the shared Retry-After deadline', async () => {
  const releases = new Map();
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = client((url) => {
    calls += 1;
    return new Promise((resolve) => {
      releases.set(new URL(url).pathname.split('/').at(-1), resolve);
      if (calls === 2) markStarted();
    });
  });
  const first = assert.rejects(registry.getAgentDetail(56, '1'),
    (error) => error.status === 429 && error.retryAfterSeconds >= 3599);
  const second = assert.rejects(registry.getAgentDetail(56, '2'),
    (error) => error.status === 429 && error.retryAfterSeconds >= 3599);
  await started;
  assert.equal(calls, 2, 'both requests are already in flight before the first 429');
  releases.get('1')(response({}, 429, { 'retry-after': '3600' }));
  await first;
  releases.get('2')(response({}, 429, { 'retry-after': '1' }));
  await second;
  await assert.rejects(registry.getAgentDetail(56, '3'),
    (error) => error.rateLimited && error.retryAfterSeconds >= 3599);
  assert.equal(calls, 2, 'the shorter late response cannot reopen the shared rate budget');
});

test('429, gateway errors and 404 cancel failed bodies before returning or retrying', async () => {
  for (const status of [429, 502, 404]) {
    let calls = 0;
    let cancellations = 0;
    const registry = client(async () => {
      assert.equal(cancellations, calls, 'previous failed body cleanup precedes the next fetch');
      calls += 1;
      return failedResponse(status, () => new Promise((resolve) => {
        setTimeout(() => { cancellations += 1; resolve(); }, 2);
      }));
    });
    await assert.rejects(registry.getAgentDetail(56, '1'),
      (error) => error.status === status && error.source === '8004scan');
    assert.equal(calls, status === 502 ? 3 : 1);
    assert.equal(cancellations, calls);
  }
});

test('rejected or synchronously failed cleanup preserves the original HTTP error and retry policy', async () => {
  for (const status of [429, 503, 404]) {
    for (const synchronous of [false, true]) {
      let cancellations = 0;
      const registry = client(async () => failedResponse(status, () => {
        cancellations += 1;
        if (synchronous) throw new Error('cleanup failed');
        return Promise.reject(new Error('cleanup failed'));
      }));
      await assert.rejects(registry.getAgentDetail(56, '1'),
        (error) => error.status === status && error.source === '8004scan'
          && !error.message.includes('cleanup failed'));
      assert.equal(cancellations, status === 503 ? 3 : 1);
    }
  }
});

test('stalled cleanup cannot prevent a transient gateway failure from recovering', async () => {
  let calls = 0;
  let cancellations = 0;
  const registry = client(async () => {
    calls += 1;
    return calls === 1 ? failedResponse(502, () => { cancellations += 1; return new Promise(() => {}); })
      : response(rawAgent('1'));
  }, { detailTimeoutMs: 1000 });
  const started = Date.now();
  assert.deepEqual(await registry.getAgentDetail(56, '1'), rawAgent('1'));
  assert.equal(cancellations, 1);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 500, 'cleanup has its own short bound within the existing operation budget');
});

test('stalled failed-body cleanup never extends the whole-operation deadline or leaves retries running', async () => {
  let calls = 0;
  let cancellations = 0;
  let signal;
  const registry = client(async (_url, options) => {
    calls += 1;
    signal = options.signal;
    return failedResponse(502, () => { cancellations += 1; return new Promise(() => {}); });
  }, { detailTimeoutMs: 8 });
  const started = Date.now();
  await assert.rejects(registry.getAgentDetail(56, '1'),
    (error) => error.name === 'TimeoutError' && error.source === '8004scan');
  assert.ok(Date.now() - started < 500);
  assert.equal(cancellations, 1);
  assert.equal(signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(calls, 1, 'no retry resumes after the operation deadline');
});

test('bad detail identity is never cached; valid raw detail coalesces and keeps its metadata', async () => {
  let calls = 0;
  let resolve;
  let markStarted;
  const started = new Promise((yes) => { markStarted = yes; });
  const raw = { ...rawAgent('123'), services: { mcp: { endpoint: 'https://provider.invalid/mcp', tools: ['read'] } },
    owner_address: '0x' + '11'.repeat(20), agent_wallet: '0x' + '22'.repeat(20), raw_metadata: { offchain_uri: 'ipfs://fixture', offchain_content: { skills: ['fixture'] } } };
  const registry = client(async () => {
    calls += 1;
    if (calls === 1) return response(rawAgent('999'));
    return new Promise((yes) => {
      resolve = () => yes(response(raw));
      markStarted();
    });
  });
  await assert.rejects(registry.getAgentDetail(56, '123'), /wrong token/);
  const first = registry.getAgentDetail(56, '123');
  const second = registry.getAgentDetail('56', '123');
  assert.equal(first, second);
  await started;
  resolve();
  assert.deepEqual(await first, raw);
  assert.deepEqual(await registry.getAgentDetail(56, '123'), raw);
  assert.equal(calls, 2);
});

test('page cache separates page/filter identities, deduplicates fanout and evicts bounded entries', async () => {
  let calls = 0;
  const registry = client(async (url) => { calls += 1; return empty(url); }, { listCacheEntries: 2 });
  await Promise.all([registry.getAgentPage({ page: 1 }), registry.getAgentPage({ page: 1 })]);
  assert.equal(calls, 1);
  await registry.getAgentPage({ page: 2 });
  await registry.getAgentPage({ page: 1 });
  assert.equal(calls, 2);
  await registry.getAgentPage({ page: 1, search: 'new filter' });
  await registry.getAgentPage({ page: 1 });
  assert.equal(calls, 4);
});

test('expired page cache refreshes; malformed answers never occupy the cache', async () => {
  let calls = 0;
  const registry = client(async (url) => { calls += 1; return calls === 1 ? response({ items: [] }) : empty(url); }, { listTtlMs: 0 });
  await assert.rejects(registry.getAgentPage(), /invalid response/);
  await registry.getAgentPage();
  await registry.getAgentPage();
  assert.equal(calls, 3);
});

test('stats coalesce, use global any-registration scope, and preserve raw chain totals', async () => {
  let calls = 0;
  const stats = { total_agents: 12, chain_stats: [{ chain_id: 56, total_agents: 8 }, { chain_id: 1, total_agents: 4 }] };
  const registry = client(async (url) => { calls += 1; assert.equal(url, 'https://api.8004scan.io/api/v1/stats/global?is_registered=any'); return response(stats); });
  const results = await Promise.all([registry.getRegistryStats(), registry.getRegistryStats()]);
  assert.deepEqual(results, [stats, stats]);
  await registry.getRegistryStats();
  assert.equal(calls, 1);
});

test('owner count keeps all-chain any/any scope and rejects wrong-owner or unavailable replies', async () => {
  const owner = '0x' + 'aa'.repeat(20);
  let calls = 0;
  const registry = client(async (url) => {
    calls += 1;
    const query = new URL(url).searchParams;
    assert.equal(query.get('owner_address'), owner);
    assert.equal(query.get('is_active'), 'any');
    assert.equal(query.get('is_registered'), 'any');
    assert.equal(query.has('chain_id'), false);
    return response({ items: [{ ...rawAgent(), owner_address: calls === 1 ? '0x' + 'bb'.repeat(20) : owner }], total: 7, limit: 1, offset: 0 });
  });
  assert.equal(await registry.getAccountAgentCount(owner), null);
  assert.equal(await registry.getAccountAgentCount(owner), 7);
  assert.equal(calls, 2);
  assert.equal(await registry.getAccountAgentCount(owner), 7);
  assert.equal(calls, 2, 'a validated owner count uses the bounded cache');
  assert.equal(await registry.getAccountAgentCount('../private'), null);
  assert.equal(calls, 2);
  const unavailable = client(async () => response({}, 503));
  assert.equal(await unavailable.getAccountAgentCount(owner), null);
});

test('owner count has the interactive deadline and never caches a fabricated count after a stalled body', async () => {
  const owner = '0x' + 'aa'.repeat(20);
  let calls = 0;
  let signal;
  const registry = client(async (url, options) => {
    calls += 1;
    signal = options.signal;
    return calls === 1 ? { ok: true, status: 200, json: () => new Promise(() => {}) } : empty(url);
  }, { accountTimeoutMs: 5, listTimeoutMs: 1000 });
  const started = Date.now();
  const results = await Promise.all([registry.getAccountAgentCount(owner), registry.getAccountAgentCount(owner)]);
  assert.deepEqual(results, [null, null]);
  assert.equal(calls, 1, 'concurrent owner reads share one operation');
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 500, 'owner evidence does not inherit the longer list budget');
  assert.equal(await registry.getAccountAgentCount(owner), 0, 'only a subsequent valid empty response establishes zero');
  assert.equal(calls, 2, 'a timed-out owner read was not cached');
});
