const MAX_ENTRIES = 5000;
export const METADATA_CACHE_LIMITS = Object.freeze({
  ttlMs: 60_000,
  maxEntries: 128,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 256 * 1024,
});

export function createCache(ttlMs, {
  maxEntries = MAX_ENTRIES,
  maxBytes = Infinity,
  maxEntryBytes = maxBytes,
  sizeOf = () => 0,
  now = Date.now,
  sweepIntervalMs = Math.min(ttlMs, 30_000),
} = {}) {
  if (!(ttlMs > 0) || !Number.isInteger(maxEntries) || maxEntries < 1
    || !(maxBytes > 0) || !(maxEntryBytes > 0) || !(sweepIntervalMs > 0)) {
    throw new TypeError('Invalid cache limits');
  }
  const map = new Map();
  let bytes = 0;
  let timer;

  function remove(key) {
    const entry = map.get(key);
    if (!entry) return false;
    bytes -= entry.bytes;
    map.delete(key);
    if (!map.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    return true;
  }

  function prune() {
    const time = now();
    for (const [key, entry] of map) {
      if (time >= entry.expires) remove(key);
    }
  }

  function get(key) {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (now() >= hit.expires) {
      remove(key);
      return undefined;
    }
    return hit.value;
  }

  function set(key, value) {
    prune();
    remove(key);
    let weight;
    try { weight = sizeOf(value, key); } catch { return false; }
    if (!Number.isFinite(weight) || weight < 0 || weight > maxEntryBytes || weight > maxBytes) return false;
    while (map.size >= maxEntries || bytes + weight > maxBytes) {
      remove(map.keys().next().value);
    }
    map.set(key, { value, expires: now() + ttlMs, bytes: weight });
    bytes += weight;
    if (!timer) {
      // Release expired payloads even when nobody asks for the same key again.
      timer = setInterval(prune, sweepIntervalMs);
      timer.unref?.();
    }
    return true;
  }

  function close() {
    clearInterval(timer);
    timer = undefined;
    map.clear();
    bytes = 0;
  }

  return { get, set, delete: remove, prune, close, stats: () => ({ entries: map.size, bytes }) };
}

export function createMetadataCache() {
  const { ttlMs, ...limits } = METADATA_CACHE_LIMITS;
  return createCache(ttlMs, {
    ...limits,
    // This budgets serialized UTF-8 bytes, not exact V8 heap usage. The entry
    // count and per-entry limits also bound object overhead. Values are JSON
    // payloads and callers must not mutate them after insertion.
    sizeOf: (value, key) => Buffer.byteLength(JSON.stringify(value), 'utf8') + Buffer.byteLength(String(key), 'utf8'),
  });
}
