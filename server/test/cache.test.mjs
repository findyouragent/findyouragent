import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCache, createMetadataCache, METADATA_CACHE_LIMITS } from '../src/cache.js';

test('metadata cache bounds retained bytes under distinct maximum-size records', () => {
  const cache = createMetadataCache();
  try {
    for (let i = 0; i < 5000; i++) cache.set(`meta:56:${i}`, { meta: { description: 'x'.repeat(200 * 1024) } });
    assert.ok(cache.stats().bytes <= METADATA_CACHE_LIMITS.maxBytes);
    assert.ok(cache.stats().entries <= 41);
    assert.equal(cache.get('meta:56:0'), undefined);
    assert.ok(cache.get('meta:56:4999'));
  } finally { cache.close(); }
});

test('metadata count limit bounds many small records; oversized and cyclic values are not retained', () => {
  const cache = createMetadataCache();
  try {
    for (let i = 0; i < 1000; i++) cache.set(String(i), { meta: {} });
    assert.equal(cache.stats().entries, METADATA_CACHE_LIMITS.maxEntries);
    assert.equal(cache.set('oversized', { meta: { text: '😀'.repeat(70_000) } }), false);
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(cache.set('cyclic', cyclic), false);
    assert.equal(cache.get('oversized'), undefined);
    assert.equal(cache.stats().entries, METADATA_CACHE_LIMITS.maxEntries);
  } finally { cache.close(); }
});

test('replacement, eviction, and deletion maintain the retained byte budget', () => {
  const cache = createCache(1000, { maxEntries: 2, maxBytes: 10, sizeOf: value => value.length });
  try {
    cache.set('a', '1234'); cache.set('b', '5678');
    cache.set('b', 'xx');
    assert.equal(cache.get('a'), '1234');
    assert.deepEqual(cache.stats(), { entries: 2, bytes: 6 });
    cache.set('c', '1234567');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.delete('b'), true);
    assert.equal(cache.delete('b'), false);
    assert.deepEqual(cache.stats(), { entries: 1, bytes: 7 });
    assert.equal(cache.set('c', 'x'.repeat(11)), false);
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  } finally { cache.close(); }
});

test('expired entries release their budget before another key is admitted', () => {
  let time = 0;
  const cache = createCache(10, { maxEntries: 2, maxBytes: 4, sizeOf: value => value.length, now: () => time });
  try {
    cache.set('a', '1234');
    time = 10;
    cache.set('b', 'abcd');
    assert.equal(cache.get('a'), undefined);
    assert.deepEqual(cache.stats(), { entries: 1, bytes: 4 });
    time = 20;
    assert.equal(cache.get('b'), undefined);
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  } finally { cache.close(); }
});

test('idle expiry releases values without a cache read or write', async () => {
  const cache = createCache(10, { sizeOf: value => value.length, sweepIntervalMs: 5 });
  try {
    cache.set('idle', 'payload');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  } finally { cache.close(); }
});
