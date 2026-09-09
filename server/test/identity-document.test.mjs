import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMetadataReader } from '../src/sources/registry.js';

const REGISTRY = '0x' + 'a1'.repeat(20);
const TOKEN = '338558';
const URI = 'https://public-agent.example/identity.json';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
function encodedString(value) {
  const bytes = Buffer.from(value);
  return `0x${word(32)}${word(bytes.length)}${bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0')}`;
}
function document(text = '{"name":"fresh agent"}', status = 200, headers = {}) {
  return { res: { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json', ...headers }) }, text };
}
function fixture({ rpcSteps = [encodedString(URI)], fetchSteps = [document()], ...options } = {}) {
  const calls = { rpc: [], document: [] };
  const next = async (steps, index, args) => {
    const step = steps[Math.min(index, steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(...args) : step;
  };
  const reader = createAgentMetadataReader({
    rpcCall: async (...args) => {
      calls.rpc.push(args);
      assert.ok(args[2].signal instanceof AbortSignal);
      return next(rpcSteps, calls.rpc.length - 1, args);
    },
    fetchDocument: async (...args) => {
      calls.document.push(args);
      assert.ok(args[1].signal instanceof AbortSignal);
      assert.equal(args[2].maxBytes, 200 * 1024 + 1);
      return next(fetchSteps, calls.document.length - 1, args);
    }, ...options,
  });
  return { calls, reader, run: () => reader(REGISTRY, TOKEN) };
}

test('available metadata is a typed object with the original URI and no stale cache', async () => {
  const f = fixture({ fetchSteps: [document('{"name":"first"}'), document('{"name":"changed"}')] });
  assert.deepEqual((await f.run()).meta, { name: 'first' });
  const second = await f.run();
  assert.equal(second.status, 'available');
  assert.equal(second.uri, URI);
  assert.deepEqual(second.meta, { name: 'changed' });
  assert.deepEqual(second.attempts, { rpc: 1, document: 1 });
  assert.equal(f.calls.rpc.length, 2);
  assert.equal(f.calls.document.length, 2);
});

test('only canonical empty tokenURI proves absence', async () => {
  const f = fixture({ rpcSteps: [encodedString('')] });
  const absent = await f.run();
  assert.equal(absent.status, 'absent');
  assert.equal(absent.uri, null);
  assert.equal(absent.meta, null);
  assert.equal(absent.reason, 'empty-token-uri');
  assert.equal(f.calls.document.length, 0);
  const whitespace = await fixture({ rpcSteps: [encodedString('   ')] }).run();
  assert.equal(whitespace.status, 'invalid');
  assert.equal(whitespace.reason, 'empty-uri');
});

test('malformed RPC ABI, invalid UTF-8 and truncation are unavailable, never absent', async () => {
  for (const raw of ['0x', null, '0xgg', `0x${word(0)}${word(0)}`,
    `0x${word(32)}${word(999999)}`, encodedString(URI).slice(0, -64),
    `0x${word(32)}${word(1)}ff${'0'.repeat(62)}`,
    encodedString('') + word(0),
  ]) {
    const f = fixture({ rpcSteps: [raw] });
    const result = await f.run();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'token-uri-unreadable');
    assert.equal(f.calls.document.length, 0);
  }
});

test('transient RPC failure is retried once and can recover in the same check', async () => {
  const f = fixture({ rpcSteps: [new TypeError('fetch failed'), encodedString(URI)] });
  const result = await f.run();
  assert.equal(result.status, 'available');
  assert.deepEqual(result.attempts, { rpc: 2, document: 1 });
  assert.equal(f.calls.rpc[0][1], '0xc87b56dd' + word(TOKEN));
});

test('RPC exhaustion and nonretryable failures stay unavailable without a document request', async () => {
  for (const [error, expectedAttempts] of [
    [new TypeError('fetch failed'), 2],
    [Object.assign(new Error('reverted'), { retryable: false }), 1],
    [Object.assign(new Error('throttled'), { retryAfter: '60' }), 1],
  ]) {
    const f = fixture({ rpcSteps: [error] });
    const result = await f.run();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'rpc-unavailable');
    assert.equal(f.calls.rpc.length, expectedAttempts);
    assert.equal(f.calls.document.length, 0);
  }
});

test('transient HTTPS failures get at most two attempts; 404 and backoff never imply absence', async () => {
  for (const first of [new TypeError('connection reset'), document('', 503)]) {
    const f = fixture({ fetchSteps: [first, document()] });
    assert.equal((await f.run()).status, 'available');
    assert.equal(f.calls.document.length, 2);
    assert.equal(f.calls.document[0][0], f.calls.document[1][0]);
  }
  const failed = fixture({ fetchSteps: [document('', 503)] });
  assert.equal((await failed.run()).status, 'unavailable');
  assert.equal(failed.calls.document.length, 2);
  for (const response of [document('', 404), document('', 429, { 'retry-after': '60' })]) {
    const f = fixture({ fetchSteps: [response] });
    assert.equal((await f.run()).status, 'unavailable');
    assert.equal(f.calls.document.length, 1);
  }
});

test('IPFS uses at most the two existing gateways and can recover malformed gateway output', async () => {
  const f = fixture({ rpcSteps: [encodedString('ipfs://bafy-example/card.json')], fetchSteps: [document('<html>gateway error</html>'), document()] });
  const result = await f.run();
  assert.equal(result.status, 'available');
  assert.equal(result.uri, 'ipfs://bafy-example/card.json');
  assert.deepEqual(f.calls.document.map((args) => args[0]), [
    'https://ipfs.io/ipfs/bafy-example/card.json',
    'https://gateway.pinata.cloud/ipfs/bafy-example/card.json',
  ]);
  const mixed = fixture({ rpcSteps: [encodedString('ipfs://bafy-example/card.json')], fetchSteps: [document('[]'), new TypeError('gateway down')] });
  assert.equal((await mixed.run()).status, 'unavailable');
  assert.equal(mixed.calls.document.length, 2);
});

test('IPFS primary Retry-After permits the independent fallback without repeating the throttled host', async () => {
  const f = fixture({
    rpcSteps: [encodedString('ipfs://bafy-example/card.json')],
    fetchSteps: [document('', 429, { 'retry-after': '60' }), document()],
  });
  const result = await f.run();
  assert.equal(result.status, 'available');
  assert.equal(result.uri, 'ipfs://bafy-example/card.json');
  assert.deepEqual(result.attempts, { rpc: 1, document: 2 });
  assert.deepEqual(f.calls.document.map((args) => new URL(args[0]).hostname), [
    'ipfs.io', 'gateway.pinata.cloud',
  ]);
});

test('complete HTTPS JSON must be an object; bad JSON, null and arrays are invalid', async () => {
  for (const text of ['{', 'null', '[]', '7', '"string"']) {
    const f = fixture({ fetchSteps: [document(text)] });
    const result = await f.run();
    assert.equal(result.status, 'invalid');
    assert.equal(result.meta, null);
    assert.equal(f.calls.document.length, 1);
  }
});

test('both IPFS gateways returning HTML or malformed/nonobject JSON remain unavailable', async () => {
  for (const reply of [
    document('<html>gateway temporarily unavailable</html>', 200, { 'content-type': 'text/html' }),
    document('{'), document('null'), document('[]'),
  ]) {
    const f = fixture({ rpcSteps: [encodedString('ipfs://bafy-example/card.json')], fetchSteps: [reply] });
    const result = await f.run();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.uri, 'ipfs://bafy-example/card.json');
    assert.equal(result.meta, null);
    assert.equal(result.reason, 'document-unavailable');
    assert.equal(f.calls.document.length, 2);
  }
});

test('HTTPS HTML/interstitial output stays unavailable and can recover on the bounded retry', async () => {
  for (const reply of [
    document('<html>gateway temporarily unavailable</html>', 200, { 'content-type': 'text/html' }),
    document('<!doctype html><html>upstream error</html>'), // misleading JSON header
    document('upstream temporarily unavailable', 200, { 'content-type': 'text/plain' }),
  ]) {
    const exhausted = fixture({ fetchSteps: [reply] });
    assert.equal((await exhausted.run()).status, 'unavailable');
    assert.equal(exhausted.calls.document.length, 2);
    const recovered = fixture({ fetchSteps: [reply, document()] });
    assert.equal((await recovered.run()).status, 'available');
    assert.equal(recovered.calls.document.length, 2);
  }
});

test('oversized response prefixes cannot establish invalid full documents', async () => {
  const f = fixture({ fetchSteps: [document('{}' + ' '.repeat(200 * 1024))] });
  const result = await f.run();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'document-too-large');
  assert.equal(f.calls.document.length, 2);
});

test('inline JSON has the same object requirement and strict base64 validation', async () => {
  const inline = (text) => encodedString('data:application/json;base64,' + Buffer.from(text).toString('base64'));
  const good = await fixture({ rpcSteps: [inline('{"name":"inline"}')] }).run();
  assert.equal(good.status, 'available');
  assert.equal(good.uri, 'data:…');
  for (const raw of [inline('null'), inline('[]'), inline('{'), encodedString('data:application/json;base64,@@@')]) {
    assert.equal((await fixture({ rpcSteps: [raw] }).run()).status, 'invalid');
  }
});

test('unsupported schemes and SSRF guards remain blocked before or during fetch', async () => {
  for (const uri of ['file:///etc/passwd', 'https://127.0.0.1/identity', 'ipfs://../private']) {
    const f = fixture({ rpcSteps: [encodedString(uri)] });
    assert.equal((await f.run()).status, 'unsupported');
    assert.equal(f.calls.document.length, 0);
  }
  const f = fixture({ fetchSteps: [new Error('ssrf-guard: host resolves to a blocked address')] });
  assert.equal((await f.run()).status, 'unsupported');
  assert.equal(f.calls.document.length, 1);
});

test('simultaneous same identity reads share only in-flight work; failures do not poison later reads', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = fixture({ rpcSteps: [() => held, encodedString(URI)], fetchSteps: [new TypeError('down'), new TypeError('down'), document()] });
  const first = f.run();
  const concurrent = f.reader(REGISTRY.toUpperCase().replace('0X', '0x'), TOKEN);
  assert.equal(first, concurrent);
  release(encodedString(URI));
  assert.equal((await first).status, 'unavailable');
  assert.equal(f.calls.rpc.length, 1);
  assert.equal((await f.run()).status, 'available');
  assert.equal(f.calls.rpc.length, 2);
});

test('deadline bounds even an injected operation that ignores AbortSignal', async () => {
  const f = fixture({ deadlineMs: 30, documentTimeoutMs: 5000,
    fetchSteps: [() => new Promise(() => {})] });
  const start = performance.now();
  const result = await f.run();
  assert.equal(result.status, 'unavailable');
  assert.ok(performance.now() - start < 300);
  assert.ok(f.calls.document.length <= 2);
  assert.equal(f.calls.document[0][1].signal.aborted, true);
});

test('malformed identities are refused before RPC', async () => {
  const f = fixture();
  for (const [registry, token] of [['bad', TOKEN], [{ toString: () => REGISTRY }, TOKEN], [REGISTRY, '-1'], [REGISTRY, (1n << 256n).toString()]]) {
    assert.equal((await f.reader(registry, token)).status, 'unavailable');
  }
  assert.equal(f.calls.rpc.length, 0);
});
