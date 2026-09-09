import { listAgents, isRateLimited } from './sources/scan8004.js';
import { isCheckDue, RECHECK_AFTER_MS } from './store.js';

function declaresService(agent) {
  return Array.isArray(agent?.supported_protocols)
    && agent.supported_protocols.some((p) => /mcp|a2a/i.test(String(p)));
}

// Stored agents and registry discovery share one paced worker pool. The 24h
// threshold makes a check due; completion depends on backlog and upstream health.
export function createSweeper({
  verifier, store, intervalMs, pageCycle = 40, pageSize = 25, baselineSample = 5, log = console.log,
  now = Date.now, fetchAgents = listAgents, rateLimited = isRateLimited, random = Math.random,
  recheckAfterMs = RECHECK_AFTER_MS, recheckRefreshMs = 60_000, recheckBatchSize = 100,
  retryBaseMs = 60_000, retryMaxMs = 60 * 60_000, maxConcurrent = 8,
  terminalCooldownMs = RECHECK_AFTER_MS, maxRetryEntries = 1000,
}) {
  const callableQueue = [];
  const baselineQueue = [];
  const recheckQueue = [];
  const retries = new Map();
  const cooldowns = new Map();
  // Retain ownership through queued, running, retry, and cooldown states.
  const owned = new Set();
  let pageCursor = 1 + Math.floor(random() * pageCycle);
  let lastPageFetch = -Infinity;
  let lastRecheckRefresh = -Infinity;
  let nextCheckAt = -Infinity;
  let fetchingPage = false;
  let timer = null;
  let activeChecks = 0;
  let turn = 0;
  let discoverySinceBaseline = 0;
  let seen = 0;
  let callable = 0;
  let swept = 0;
  let errored = 0;
  let cachedHits = 0;
  let pageErrors = 0;
  let terminalErrors = 0;
  let deferredRetries = 0;
  let lastError = null;
  let recheckDue = 0;
  let oldestRecheckAt = null;
  let recheckDueAsOf = null;

  const pageFetchEveryMs = intervalMs <= 5000 ? Math.max(intervalMs, 5000) : 5 * 60_000;
  const emptyPageRetryMs = Math.max(intervalMs, 3000);
  const lowWater = Math.max(10, Math.round(pageSize / 4));
  const discoveryPending = () => callableQueue.length + baselineQueue.length;
  const pending = () => discoveryPending() + recheckQueue.length + retries.size;
  const due = (key) => isCheckDue(store.lastCheck(key), { now: now(), maxAgeMs: recheckAfterMs });

  function enqueue(list, target, lane) {
    const key = `${target.chainId}:${target.tokenId}`;
    if (owned.has(key)) return false;
    owned.add(key);
    list.push({ ...target, key, lane, attempts: 0 });
    return true;
  }

  function refreshRechecks() {
    const time = now();
    if (time - lastRecheckRefresh < recheckRefreshMs) return;
    lastRecheckRefresh = time;
    for (const [key, until] of cooldowns) {
      if (time < until) continue;
      cooldowns.delete(key);
      owned.delete(key);
    }
    // One bounded batch per refresh, independent of the registry page cycle.
    const snapshot = store.dueRechecks({
      now: time, maxAgeMs: recheckAfterMs,
      limit: Math.max(0, recheckBatchSize - recheckQueue.length), exclude: owned,
    });
    recheckDue = snapshot.due;
    oldestRecheckAt = snapshot.oldestCheckedAt;
    recheckDueAsOf = new Date(time).toISOString();
    for (const key of snapshot.keys) {
      const [chainId, tokenId] = key.split(':');
      enqueue(recheckQueue, { chainId: Number(chainId), tokenId }, 'recheck');
    }
  }

  function refillDiscovery() {
    if (fetchingPage || discoveryPending() > lowWater || rateLimited()) return;
    if (now() - lastPageFetch < pageFetchEveryMs) return;
    fetchingPage = true;
    lastPageFetch = now();
    const cursor = pageCursor;
    pageCursor = (pageCursor % pageCycle) + 1;
    let added = 0;
    // A failed page advances the cursor. It must not block other discovery.
    Promise.resolve().then(() => fetchAgents({ chainId: 56, page: cursor, limit: pageSize, sortBy: 'total_score' }))
      .then((page) => {
        for (const agent of page ?? []) {
          if (Number(agent.chain_id) !== 56) continue;
          const key = `${agent.chain_id}:${agent.token_id}`;
          if (!due(key) || owned.has(key)) continue;
          seen += 1;
          const target = { chainId: agent.chain_id, tokenId: agent.token_id };
          if (declaresService(agent)) {
            if (enqueue(callableQueue, target, 'discovery')) { callable += 1; added += 1; }
          } else if (seen % baselineSample === 0) {
            if (enqueue(baselineQueue, target, 'discovery')) added += 1;
          }
        }
        if (!added) lastPageFetch = now() - pageFetchEveryMs + emptyPageRetryMs;
      })
      .catch((err) => {
        pageErrors += 1;
        lastError = `page ${cursor}: ${String(err?.message ?? err).slice(0, 160)}`;
      })
      .finally(() => { fetchingPage = false; });
  }

  function takeDiscovery() {
    // Baseline samples retain a share even when callable discovery stays busy.
    if (baselineQueue.length && (discoverySinceBaseline >= 3 || !callableQueue.length)) {
      discoverySinceBaseline = 0;
      return baselineQueue.shift();
    }
    const next = callableQueue.shift();
    if (next) discoverySinceBaseline += 1;
    return next;
  }

  function takeRetry() {
    for (const [key, target] of retries) {
      if (target.retryAt > now()) continue;
      retries.delete(key);
      return target;
    }
    return undefined;
  }

  function takeNext() {
    // Rechecks get half of busy ticks; discovery and retries get a quarter each.
    // Empty lanes yield their share so no capacity is reserved for absent work.
    const lanes = [() => recheckQueue.shift(), () => recheckQueue.shift(), takeDiscovery, takeRetry];
    const preferred = turn++ % lanes.length;
    return lanes[preferred]() ?? recheckQueue.shift() ?? takeDiscovery() ?? takeRetry();
  }

  async function tick() {
    refreshRechecks();
    if (rateLimited()) return;
    refillDiscovery();
    if (activeChecks >= maxConcurrent || now() < nextCheckAt) return;

    let next;
    const queued = pending();
    for (let i = 0; i < queued; i += 1) {
      const candidate = takeNext();
      if (!candidate) return;
      // An interactive check may have refreshed a queued agent in the meantime.
      if (!due(candidate.key)) { owned.delete(candidate.key); continue; }
      next = candidate;
      break;
    }
    if (!next) return;

    nextCheckAt = now() + intervalMs;
    activeChecks += 1;
    let retry = false;
    try {
      const { cached } = await verifier(next.chainId, next.tokenId);
      if (cached) cachedHits += 1;
      else {
        swept += 1;
        if (swept % 25 === 0) log(`sweep: ${swept} agents verified this run`);
      }
    } catch (err) {
      errored += 1;
      lastError = String(err?.message ?? err).slice(0, 200);
      next.attempts += 1;
      // Only a definitive registry identity/request response warrants a long
      // cooldown. Credentials, throttling, transport and endpoint errors do not.
      if (err?.source === '8004scan' && [400, 404].includes(err.status) && !err.rateLimited && !err.malformed) {
        terminalErrors += 1;
        cooldowns.set(next.key, now() + Math.max(intervalMs, terminalCooldownMs));
      } else {
        const backoff = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(next.attempts - 1, 20)));
        const retryAfter = Number(err?.retryAfterSeconds) * 1000;
        next.retryAt = now() + Math.max(intervalMs, backoff, Number.isFinite(retryAfter) ? retryAfter : 0);
        if (retries.size < maxRetryEntries) retries.set(next.key, next);
        else {
          // Bound retained retry jobs during broad outages. After this delay,
          // normal store refresh/discovery may schedule the identity again.
          deferredRetries += 1;
          cooldowns.set(next.key, next.retryAt);
        }
      }
      retry = true;
      if (errored % 25 === 0) log(`sweep: ${errored} checks failed this run, last: ${lastError}`);
    } finally {
      activeChecks -= 1;
      if (!retry) owned.delete(next.key);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      log(`sweep: on, one check every ${Math.round(intervalMs / 1000)}s; rechecks due after 24h, discovery cycles ${pageCycle} pages of ${pageSize}`);
    },
    stop() { clearInterval(timer); timer = null; },
    tick,
    stats: () => {
      const recheckQueued = recheckQueue.length + [...retries.values()].filter((target) => target.lane === 'recheck').length;
      return {
        queued: pending(), awaitingRecheck: recheckQueued,
        swept, considered: seen, callable, cachedHits, errored, pageErrors, lastError,
        recheckDue, recheckQueued, oldestRecheckAt, recheckDueAsOf,
        retrying: retries.size, activeChecks, terminalErrors,
        coolingDown: cooldowns.size, deferredRetries,
      };
    },
  };
}
