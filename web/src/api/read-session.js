const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 100;

// A tab-local read session. Pending reads are shared immediately; successful
// reads may be reused briefly. Rejected and null results never enter memory.
export function createReadSession({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map();

  function prune() {
    const current = now();
    for (const [key, entry] of entries) {
      if (!entry.promise && (!entry.cacheable || current - entry.savedAt >= ttlMs)) entries.delete(key);
    }
    if (entries.size > maxEntries) {
      for (const [key, entry] of entries) {
        if (entry.promise) continue;
        entries.delete(key);
        if (entries.size <= maxEntries) break;
      }
    }
  }

  function getOrStart(key, loader, { force = false, cacheable = (value) => value != null, mapCached = (value) => value } = {}) {
    prune();
    let entry = entries.get(key);
    if (entry?.promise) return entry.operation;
    if (!force && entry?.cacheable && now() - entry.savedAt < ttlMs) {
      return { promise: Promise.resolve(mapCached(entry.value)), subscribe: () => () => {} };
    }

    const listeners = new Set();
    let closed = false;
    const emit = (event) => {
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* UI narration cannot break the read. */ }
      }
    };
    const operation = {
      promise: null,
      subscribe(listener) {
        if (closed || typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    entry = { promise: null, operation, cacheable: false, savedAt: 0, value: null };
    entries.set(key, entry);
    const promise = Promise.resolve().then(() => loader(emit)).then((value) => {
      let keep = false;
      try { keep = Boolean(cacheable(value)); } catch { /* Invalid reads are never cached. */ }
      if (entries.get(key) === entry) {
        if (keep) {
          entry.promise = null;
          entry.cacheable = true;
          entry.savedAt = now();
          entry.value = value;
          prune();
        } else entries.delete(key);
      }
      closed = true;
      listeners.clear();
      return value;
    }, (error) => {
      if (entries.get(key) === entry) entries.delete(key);
      closed = true;
      listeners.clear();
      throw error;
    });
    entry.promise = promise;
    operation.promise = promise;
    return operation;
  }

  return {
    getOrStart,
    // Remove a read even when it is still pending. Its completion callback
    // checks identity before caching, so an invalidated result cannot return
    // later and repopulate the session.
    invalidate(key) { entries.delete(key); },
    clear() { entries.clear(); },
    size() { return entries.size; },
  };
}

export const readSessionDefaults = { DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
