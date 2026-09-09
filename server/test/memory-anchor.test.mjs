import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryAnchorHandler, decodeMemorySources, MEMORY_COLLECTION, MEMORY_REGISTRY } from '../src/sources/memory-anchor.js';

const request = { params: { chainId: '56', tokenId: '338630' } };
const checkedAt = '2026-09-08T18:00:00.000Z';
const fixtureBap = { chainId: 56, collection: MEMORY_COLLECTION, tokenId: '11169', ownershipVerified: true };
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const HASH = `0x${'a7'.repeat(32)}`;

// Independently encode the documented Solidity ABI to exercise real dynamic
// array/string layouts, including multiple differently sized tuples.
function stringBytes(value) {
  const bytes = Buffer.from(value, 'utf8');
  return word(bytes.length) + bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
}
function encodeSources(entries) {
  const tuples = entries.map((entry) => {
    const uri = stringBytes(entry.uri ?? 'ipfs://bafy-test-export');
    const description = stringBytes(entry.description ?? 'Living Brain fixture learning root');
    return [word(entry.id ?? 7), word(320), word(entry.type ?? 2), word(1), word(80),
      word(entry.active === false ? 0 : 1), word(1788890300), word(1788890400),
      word(320 + uri.length / 2), (entry.hash ?? HASH).slice(2), uri, description].join('');
  });
  let offset = entries.length * 32;
  const offsets = tuples.map((tuple) => { const result = word(offset); offset += tuple.length / 2; return result; });
  return `0x${word(32)}${word(entries.length)}${offsets.join('')}${tuples.join('')}`;
}
function setWord(raw, index, value) { return raw.slice(0, 2 + index * 64) + word(value) + raw.slice(2 + (index + 1) * 64); }

function response() {
  return { code: 200, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setup({ bap = fixtureBap, mapping = '338630', raw, fail = false } = {}) {
  let last = bap === null ? null : { bap578: bap };
  const calls = [];
  const handler = createMemoryAnchorHandler({
    store: { lastCheck: (key) => { assert.equal(key, '56:338630'); return last; } },
    now: () => Date.parse(checkedAt),
    rpc: async (method, params, options) => {
      calls.push({ method, params });
      assert.ok(options.signal instanceof AbortSignal);
      if (fail) throw new Error('upstream unavailable');
      if (method === 'eth_blockNumber') return '0x730d040';
      assert.equal(method, 'eth_call');
      assert.equal(params[1], '0x730d040', 'every call uses the snapshot block');
      if (params[0].data.startsWith('0x97eaea47')) return `0x${word(mapping)}`;
      assert.equal(params[0].to, MEMORY_REGISTRY);
      return raw;
    },
  });
  return { calls, setLast: (value) => { last = value; },
    run: async (req = request) => { const res = response(); await handler(req, res); return res; },
  };
}

test('malformed and overflowing input is rejected before lookup or RPC', async () => {
  for (const value of ['-1', '1e2', '1.2', '../11169', '0x2b', '01', '9'.repeat(79), (1n << 256n).toString()]) {
    const fixture = setup();
    const out = await fixture.run({ params: { chainId: '56', tokenId: value } });
    assert.equal(out.code, 400);
    assert.equal(fixture.calls.length, 0);
  }
});

test('unsupported chains and collections never select arbitrary contracts', async () => {
  const chain = setup();
  assert.equal((await chain.run({ params: { chainId: '1', tokenId: '338630' } })).body.status, 'unsupported');
  assert.equal(chain.calls.length, 0);
  const collection = setup({ bap: { ...fixtureBap, collection: '0x' + '1'.repeat(40) } });
  const out = (await collection.run()).body;
  assert.equal(out.status, 'unsupported');
  assert.equal(out.registryAddress, null);
  assert.equal(collection.calls.length, 0);
});

test('missing or rejected attribution never becomes absent memory', async () => {
  for (const [bap, status, gate] of [
    [null, 'unavailable', 'no-verdict'],
    [{ ...fixtureBap, ownershipVerified: null }, 'unavailable', 'no-attributed-token'],
    [{ ...fixtureBap, ownershipVerified: false }, 'wrong-identity', 'wrong-identity'],
    [{ ...fixtureBap, chainId: 1 }, 'unavailable', 'malformed-identity'],
  ]) {
    const fixture = setup({ bap });
    const out = (await fixture.run()).body;
    assert.equal(out.status, status);
    assert.equal(out.gate, gate);
    assert.deepEqual(out.sources, []);
    assert.equal(fixture.calls.length, 0);
  }
});

test('MintGate is rechecked at the snapshot block before reading roots', async () => {
  const fixture = setup({ mapping: '999' });
  const out = (await fixture.run()).body;
  assert.equal(out.status, 'wrong-identity');
  assert.equal(out.blockNumber, 120639552);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].params[0].to.toLowerCase(), '0x97e8f3b4bffc1982b2791b21609c3b2542c5eb50');
});

test('transport errors are unavailable and never cached as absence', async () => {
  const fixture = setup({ fail: true });
  const first = (await fixture.run()).body;
  const second = (await fixture.run()).body;
  assert.equal(first.status, 'unavailable');
  assert.equal(second.status, 'unavailable');
  assert.equal(first.gate, 'read-failed');
  assert.equal(first.blockNumber, null);
  assert.equal(fixture.calls.length, 2);
});

test('a complete empty registry read is not-anchored, cached and block-scoped', async () => {
  const fixture = setup({ raw: `0x${word(32)}${word(0)}` });
  const first = (await fixture.run()).body;
  assert.equal(first.status, 'not-anchored');
  assert.equal(first.checkedAt, checkedAt);
  assert.equal(first.blockNumber, 120639552);
  assert.equal(first.collection, MEMORY_COLLECTION);
  assert.equal(first.bapTokenId, '11169');
  assert.equal(first.contentValidation, 'not-performed');
  assert.deepEqual(first.sources, []);
  assert.equal(fixture.calls.length, 3);
  assert.equal((await fixture.run()).body.cached, true);
  assert.equal(fixture.calls.length, 3);
  fixture.setLast({ bap578: { ...fixtureBap, ownershipVerified: false } });
  assert.equal((await fixture.run()).body.status, 'wrong-identity', 'cache cannot bypass a changed attribution gate');
});

test('malformed ABI and oversized source counts cannot masquerade as absence', async () => {
  for (const raw of [undefined, '0x', '0xgg', `0x${word(0)}${word(0)}`, `0x${word(32)}${word(129)}`, `0x${word(32)}${word(0)}${word(0)}`]) {
    assert.throws(() => decodeMemorySources(raw));
    const fixture = setup({ raw });
    assert.equal((await fixture.run()).body.status, 'unavailable');
    assert.equal((await fixture.run()).body.cached, undefined);
    assert.equal(fixture.calls.length, 6);
  }
});

test('current MEMORY roots are returned with fixed-block provenance and no validation claim', async () => {
  const id = (1n << 100n).toString();
  const raw = encodeSources([{ id: 4, type: 0 }, { id, uri: 'ipfs://bafy-memory-snapshot', description: 'Memory root from an existing journal' }]);
  const fixture = setup({ raw });
  const out = (await fixture.run()).body;
  assert.equal(out.status, 'anchored');
  assert.equal(out.gate, 'verified');
  assert.equal(out.registryAddress, MEMORY_REGISTRY);
  assert.equal(out.contentValidation, 'not-performed');
  assert.match(out.note, /have not been validated/);
  assert.deepEqual(out.sources, [{ sourceId: id, uri: 'ipfs://bafy-memory-snapshot',
    contentHash: HASH, description: 'Memory root from an existing journal', active: true,
    updatedAt: 1788890400, anchorTx: null }]);
  assert.equal(fixture.calls.length, 3, 'only block, mapping and source reads; no export fetch or historical scans');
});

test('other source types, inactive sources and zero hashes are not active memory commitments', async () => {
  for (const entries of [[{ type: 0 }], [{ active: false }], [{ hash: `0x${'0'.repeat(64)}` }]]) {
    const out = (await setup({ raw: encodeSources(entries) }).run()).body;
    assert.equal(out.status, 'not-anchored');
    assert.equal(out.contentValidation, 'not-performed');
  }
});

test('tuple bounds, enum and bool words, string overlap, length and encoding are strict', () => {
  const valid = encodeSources([{}]);
  const malformed = [
    valid.slice(0, -64),
    setWord(valid, 2, 0), // points back into the array header
    setWord(valid, 4, 0), // URI points into tuple head
    setWord(valid, 5, 256), // not uint8
    setWord(valid, 8, 2), // not bool
    setWord(valid, 11, 320), // description overlaps URI
    setWord(valid, 13, 16 * 1024 + 1), // excessive URI length
    valid.slice(0, 2 + 14 * 64) + 'ff' + valid.slice(2 + 14 * 64 + 2), // invalid UTF-8
    encodeSources([{ id: 7 }, { id: 7 }]),
  ];
  for (const raw of malformed) assert.throws(() => decodeMemorySources(raw));
});
