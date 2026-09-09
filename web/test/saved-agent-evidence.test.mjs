import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSavedAgentEvidence, retainSavedEvidence, startDetailRecovery } from '../src/lib/saved-agent-evidence.js';

const key = '56:43129';
const opts = { serviceBase: 'https://fya.example', chainId: 56, tokenId: '43129', timeoutMs: 40 };
const checkedAt = '2026-09-08T00:00:00.000Z';
const row = { name: 'Venus', tier: 'verified_live', endpointProven: true, checkedAt, servedNames: ['getAccountLiquidity'] };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('saved reads stay on FYA and keep only dated observations for the exact key', async () => {
  const calls = [];
  const result = await fetchSavedAgentEvidence({ ...opts, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return response(url.endsWith('/verdicts') ? { verdicts: { [key]: { ...row, endpoint: 'https://do-not-enable.example', hireable: true } } }
      : { checks: [{ ...row, key, ts: checkedAt }, { ...row, key: '56:999', ts: checkedAt }] });
  } });
  assert.equal(result.key, key);
  assert.equal(result.latest.name, 'Venus');
  assert.equal(result.latest.checkedAt, checkedAt);
  assert.equal(result.checks.length, 1);
  assert.equal(result.unavailable, false);
  assert.equal(result.partial, false);
  assert.equal(Object.hasOwn(result.latest, 'endpoint'), false);
  assert.equal(Object.hasOwn(result.latest, 'hireable'), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), { keys: [key] });
  assert.ok(calls.every(call => call.url.startsWith('https://fya.example/api/') && call.init.credentials === 'omit'));
});

test('history can independently recover a record when latest-verdict read fails', async () => {
  const result = await fetchSavedAgentEvidence({ ...opts, fetchImpl: async url => url.endsWith('/verdicts')
    ? response({}, 503) : response({ checks: [{ ...row, key, ts: checkedAt }] }) });
  assert.equal(result.latest.name, 'Venus');
  assert.equal(result.partial, true);
  assert.equal(result.unavailable, false);
});

test('wrong keys and undated or invalid-date records do not become saved evidence', async () => {
  const result = await fetchSavedAgentEvidence({ ...opts, fetchImpl: async url => response(url.endsWith('/verdicts')
    ? { verdicts: { '56:999': row, [key]: { ...row, key: '56:999' } } }
    : { checks: [{ ...row, key: '56:999', ts: checkedAt }, { ...row, key }, { ...row, key, ts: 'not-a-date' }] }) });
  assert.equal(result.latest, null);
  assert.deepEqual(result.checks, []);
});

test('body stalls expire independently and are distinct from a successful empty history', async () => {
  const signals = [];
  const result = await fetchSavedAgentEvidence({ ...opts, timeoutMs: 5, fetchImpl: async (_url, init) => {
    signals.push(init.signal); return { ok: true, json: () => new Promise(() => {}) };
  } });
  assert.equal(result.unavailable, true);
  assert.ok(signals.every(signal => signal.aborted));
  const empty = await fetchSavedAgentEvidence({ ...opts, fetchImpl: async url => response(url.endsWith('/verdicts') ? { verdicts: {} } : { checks: [] }) });
  assert.equal(empty.unavailable, false);
  assert.equal(empty.latest, null);
});

test('registry retry retains a dated same-agent record if its refresh is unavailable', () => {
  const previous = { key, latest: row, checks: [], unavailable: false };
  assert.deepEqual(retainSavedEvidence(previous, { key, unavailable: true }), { ...previous, partial: true });
  const nextAgent = { key: '56:999', latest: null, unavailable: true };
  assert.equal(retainSavedEvidence(previous, nextAgent), nextAgent);
});

test('saved token evidence retains its observation time and never imports current action authority', async () => {
  const bap578 = { collection: '0x' + '1'.repeat(40), tokenId: '11169', ownershipVerified: true,
    totalTrades: 5, transferable: { checked: true, tba: '0x' + '2'.repeat(40) } };
  const result = await fetchSavedAgentEvidence({ ...opts, fetchImpl: async url => response(url.endsWith('/verdicts')
    ? { verdicts: { [key]: { ...row, bap578 } } } : { checks: [] }) });
  assert.equal(result.latest.checkedAt, checkedAt);
  assert.deepEqual(result.latest.bap578, { collection: bap578.collection, tokenId: '11169', ownershipVerified: true, totalTrades: 5 });
  assert.equal(Object.hasOwn(result.latest.bap578, 'transferable'), false);
  const later = { ...result, latest: { ...result.latest, checkedAt: '2026-09-08T01:00:00Z' } };
  assert.equal(retainSavedEvidence(later, result), later, 'a slow older response cannot rewind the saved date');
});

test('saved evidence settles while registry request remains pending', async () => {
  const pending = deferred();
  const events = [];
  const session = startDetailRecovery({ loadDetail: () => pending.promise, loadSaved: async () => row,
    onDetail: value => events.push(['detail', value]), onError: error => events.push(['error', error.message]),
    onSaved: value => events.push(['saved', value]), onSettled: () => events.push(['settled']) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['saved', row]]);
  pending.reject(new Error('registry outage'));
  await session.done;
  assert.deepEqual(events.slice(1), [['error', 'registry outage'], ['settled']]);
});

test('navigation or newer retry cancels late success, error, history and settling callbacks', async () => {
  for (const rejects of [false, true]) {
    const detail = deferred(), saved = deferred();
    const events = [];
    const session = startDetailRecovery({ loadDetail: () => detail.promise, loadSaved: () => saved.promise,
      onDetail: () => events.push('old detail'), onError: () => events.push('old error'),
      onSaved: () => events.push('old saved'), onSettled: () => events.push('old settled') });
    session.cancel();
    const current = startDetailRecovery({ loadDetail: async () => 'new agent', loadSaved: async () => 'new saved',
      onDetail: value => events.push(value), onError: () => events.push('new error'),
      onSaved: value => events.push(value), onSettled: () => events.push('new settled') });
    rejects ? detail.reject(new Error('late old error')) : detail.resolve('old agent');
    saved.resolve('old saved');
    await Promise.all([session.done, current.done]);
    assert.ok(events.includes('new agent') && events.includes('new saved'));
    assert.ok(events.every(event => !event.startsWith('old')));
  }
});
