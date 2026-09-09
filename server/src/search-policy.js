/**
 * Bounds for the synchronous, stored-evidence capability search.
 *
 * Work units account for record visits, served-name characters, and name-term
 * comparisons. Both entry points share a process budget based on the current
 * corpus, in addition to per-address request limits.
 */
export const SEARCH_LIMITS = Object.freeze({
  maxCharacters: 500,
  maxUniqueTokens: 16,
  maxWorkUnitsPerQuery: 6_000_000,
  windowMs: 60_000,
  perIpRequests: 30,
  globalWorkUnits: 90_000_000,
  maxClientBuckets: 2048,
});

export class SearchPolicyError extends Error {
  constructor(code, detail, { status = 400, retryAfterSeconds = null } = {}) {
    super(detail);
    this.name = 'SearchPolicyError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function searchErrorBody(error) {
  return {
    error: error.code,
    detail: error.message,
    limits: {
      maxCharacters: SEARCH_LIMITS.maxCharacters,
      maxUniqueTokens: SEARCH_LIMITS.maxUniqueTokens,
      maxWorkUnitsPerQuery: SEARCH_LIMITS.maxWorkUnitsPerQuery,
    },
    ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

function codePointLength(value, stopAfter) {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > stopAfter) break;
  }
  return length;
}

/** Validate with the exact tokenizer used by the store, without importing it. */
export function validateSearchQuery(value, { field = 'query', tokenize, allowEmpty = false } = {}) {
  if (allowEmpty && (value === undefined || value === null)) {
    return { query: '', tokens: [], characters: 0 };
  }
  if (typeof value !== 'string') {
    throw new SearchPolicyError(
      'search-query-required',
      `${field} must be one non-empty string`,
    );
  }

  const characters = codePointLength(value, SEARCH_LIMITS.maxCharacters);
  if (characters > SEARCH_LIMITS.maxCharacters) {
    throw new SearchPolicyError(
      'search-query-too-long',
      `${field} must be at most ${SEARCH_LIMITS.maxCharacters} characters`,
    );
  }
  if (!value.trim()) {
    if (allowEmpty) return { query: value, tokens: [], characters };
    throw new SearchPolicyError(
      'search-query-required',
      `${field} must contain a searchable description`,
    );
  }
  if (typeof tokenize !== 'function') throw new TypeError('search tokenizer is required');

  // Defensively deduplicate even if a future tokenizer stops doing so. The
  // bound concerns distinct scans; repeating one word cannot buy more work.
  const tokens = [...new Set(tokenize(value).map(String))];
  if (tokens.length > SEARCH_LIMITS.maxUniqueTokens) {
    throw new SearchPolicyError(
      'search-query-too-many-terms',
      `${field} may contain at most ${SEARCH_LIMITS.maxUniqueTokens} distinct searchable terms; use a more focused description`,
    );
  }

  return { query: value, tokens, characters };
}

/** Estimate record visits, name normalization, and nested term comparisons. */
export function estimateSearchWork(tokens, corpus, { field = 'query' } = {}) {
  const stats = {
    records: corpus?.records,
    servedNames: corpus?.servedNames,
    servedNameCharacters: corpus?.servedNameCharacters,
  };
  for (const [name, value] of Object.entries(stats)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  const { records, servedNames, servedNameCharacters } = stats;
  const comparisons = servedNames * tokens.length;
  if (!Number.isSafeInteger(comparisons)) throw new TypeError('search comparison estimate overflowed');
  // The store returns immediately when tokenization yields nothing.
  const workUnits = tokens.length ? records + servedNameCharacters + comparisons : 0;
  if (!Number.isSafeInteger(workUnits)) throw new TypeError('search work estimate overflowed');
  if (workUnits > SEARCH_LIMITS.maxWorkUnitsPerQuery) {
    const fixedWork = records + servedNameCharacters;
    const affordableTerms = servedNames && fixedWork <= SEARCH_LIMITS.maxWorkUnitsPerQuery
      ? Math.floor((SEARCH_LIMITS.maxWorkUnitsPerQuery - fixedWork) / servedNames)
      : SEARCH_LIMITS.maxUniqueTokens;
    const guidance = fixedWork > SEARCH_LIMITS.maxWorkUnitsPerQuery
      ? 'the stored corpus is currently too large for this scan-based search path'
      : affordableTerms > 0
      ? `use at most ${affordableTerms} distinct searchable term${affordableTerms === 1 ? '' : 's'}`
      : 'the stored corpus is currently too large for this search path';
    throw new SearchPolicyError(
      'search-query-too-broad',
      `${field} would compare too many capability names for the current corpus; ${guidance}`,
    );
  }
  return { workUnits, comparisons, ...stats, terms: tokens.length };
}

function retryAfter(bucket, now, windowMs) {
  return Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000));
}

function currentBucket(bucket, now, windowMs) {
  return !bucket || now - bucket.start >= windowMs
    ? { start: now, count: 0 }
    : bucket;
}

/**
 * Per-address request cap plus a process-wide weighted-work cap.
 *
 * New addresses beyond maxClientBuckets share one overflow bucket. This keeps
 * memory bounded without letting address rotation evict active limits.
 */
export function createSearchControl(options = {}) {
  const limits = { ...SEARCH_LIMITS, ...options };
  const now = options.now ?? Date.now;
  for (const name of ['windowMs', 'perIpRequests', 'globalWorkUnits', 'maxClientBuckets']) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const clients = new Map();
  let overflow = null;
  let process = null;

  function pruneExpired(at) {
    for (const [key, bucket] of clients) {
      if (at - bucket.start >= limits.windowMs) clients.delete(key);
    }
  }

  function consume({ ip = 'unknown', workUnits = 0 } = {}) {
    const at = now();
    const key = typeof ip === 'string' && ip ? ip : 'unknown';
    if (!clients.has(key) && clients.size >= limits.maxClientBuckets) pruneExpired(at);

    const overflowed = !clients.has(key) && clients.size >= limits.maxClientBuckets;
    const heldClient = overflowed ? overflow : clients.get(key);
    const client = currentBucket(heldClient, at, limits.windowMs);
    const global = currentBucket(process, at, limits.windowMs);
    if (!Number.isSafeInteger(workUnits) || workUnits < 0
      || workUnits > SEARCH_LIMITS.maxWorkUnitsPerQuery) {
      throw new TypeError('workUnits must be within the per-query search bound');
    }

    if (client.count >= limits.perIpRequests) {
      throw new SearchPolicyError(
        'search-rate-limited',
        `Too many capability searches from this address; the limit is ${limits.perIpRequests} per ${Math.round(limits.windowMs / 1000)} seconds`,
        { status: 429, retryAfterSeconds: retryAfter(client, at, limits.windowMs) },
      );
    }
    if (global.count + workUnits > limits.globalWorkUnits) {
      throw new SearchPolicyError(
        'search-capacity-limited',
        'Capability search is at its shared work limit; try again shortly',
        { status: 429, retryAfterSeconds: retryAfter(global, at, limits.windowMs) },
      );
    }

    client.count += 1;
    global.count += workUnits;
    process = global;
    if (overflowed) overflow = client;
    else clients.set(key, client);

    return {
      requestLimit: limits.perIpRequests,
      requestRemaining: Math.max(0, limits.perIpRequests - client.count),
      workLimit: limits.globalWorkUnits,
      workRemaining: Math.max(0, limits.globalWorkUnits - global.count),
    };
  }

  function stats() {
    return {
      clientBuckets: clients.size,
      overflowCount: overflow?.count ?? 0,
      processWorkUnits: process?.count ?? 0,
    };
  }

  return { consume, stats };
}

/** Express-compatible handler kept injectable for focused, offline tests. */
export function createSearchRouteHandler({ store, searchControl = createSearchControl(), tokenize, limit = 25 }) {
  return function searchRoute(req, res) {
    try {
      const checked = validateSearchQuery(req.query?.q, { field: 'q', tokenize });
      const corpus = store.searchCorpusStats();
      const work = estimateSearchWork(checked.tokens, corpus, { field: 'q' });
      const budget = searchControl.consume({
        ip: req.ip || req.socket?.remoteAddress || 'unknown',
        workUnits: work.workUnits,
      });
      res.set('x-search-rate-limit', String(budget.requestLimit));
      res.set('x-search-rate-remaining', String(budget.requestRemaining));
      res.set('x-search-work-limit', String(budget.workLimit));
      res.set('x-search-work-remaining', String(budget.workRemaining));
      const agents = store.searchServed(checked.query, limit);
      return res.json({ q: checked.query, agents, count: agents.length });
    } catch (error) {
      if (!(error instanceof SearchPolicyError)) throw error;
      if (error.retryAfterSeconds) res.set('retry-after', String(error.retryAfterSeconds));
      return res.status(error.status).json(searchErrorBody(error));
    }
  };
}
