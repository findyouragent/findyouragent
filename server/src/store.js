import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FORMULA_VERSION } from './verify/score.js';
import { JUDGED_CATEGORIES, normalizeCapability, hasFragment } from './verify/categorize.js';
import { estimateSearchWork, validateSearchQuery } from './search-policy.js';
import {
  createBoundedJsonl, PersistenceError, positiveInteger, replayJsonl,
} from './persistence/bounded-jsonl.js';
import {
  VERDICT_STATE_ROW, validateVerdictCheckpoint, verdictFromStoredRow,
  rejectMalformedVerdictCheckpoint,
} from './persistence/verdict-records.js';

const HISTORY_CAP = 50;
const UPTIME_DAY_CAP = 90;
const MIB = 1024 * 1024;
export const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

export function isCheckDue(check, { now = Date.now(), maxAgeMs = RECHECK_AFTER_MS } = {}) {
  if (!check || check.formulaVersion !== FORMULA_VERSION) return true;
  const checkedAt = new Date(check.ts).getTime();
  return !Number.isFinite(checkedAt) || now - checkedAt >= maxAgeMs;
}

// Exclude filler and generic request verbs from capability searches. Keep
// category terms such as close, supply, and monitor; stopwords.test.mjs guards
// against removing vocabulary used by the categorizer.
export const STOPWORDS = new Set([
  // glue
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'than', 'then',
  'there', 'here', 'they', 'them', 'their', 'its', 'our', 'your', 'you', 'are',
  'was', 'were', 'has', 'have', 'had', 'been', 'being', 'but', 'not', 'out',
  'off', 'per', 'via', 'own', 'one', 'all', 'any', 'some', 'more', 'most',
  'less', 'over', 'under', 'just', 'only', 'also', 'like', 'very', 'much',
  'many', 'now', 'today', 'still', 'back', 'down', 'upon', 'onto', 'when',
  'what', 'which', 'whether', 'who', 'whom', 'whose', 'why', 'how', 'about',
  'would', 'should', 'could', 'will', 'can', 'may', 'might', 'must', 'does',
  'doing', 'did', 'done', 'near', 'each', 'both', 'other', 'same', 'such',
  'new', 'best', 'good', 'right', 'able', 'sure', 'kind', 'type', 'way',
  'thing', 'something', 'anything', 'please', 'thanks',
  // the verbs a request opens with, none of which name work
  'get', 'find', 'show', 'tell', 'list', 'see', 'look', 'help', 'make', 'run',
  'use', 'give', 'let', 'want', 'need', 'check', 'looking', 'searching',
  // Generic agent nouns do not narrow capability searches.
  'agent', 'agents', 'bot', 'bots',
]);

/** Shared query tokenization for search and MCP explanations. */
export function queryTokens(query) {
  return [...new Set(String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

export const RANK = {
  NOT_DECLARED: 0,
  NO_ROUND_TRIP: 1,
  ANSWERED_NOTHING: 2,
  ANSWERED: 3,
};

// Their server produced an answer, even an unhelpful one. A 404 or a bad url is
// a reply; a timeout is silence.
const SPOKE_REASONS = new Set(['http-error', 'invalid-url', 'not-json']);

// Use recorded probe facts so scoring changes cannot rewrite historical outcomes.
export function rankCheck(check) {
  const probe = check?.probe;
  if (!probe) {
    // Written before probe facts were stored. We did not keep WHY those checks
    // failed, so they may not be published as failures: answered, or unknown.
    return check?.endpointProven ? RANK.ANSWERED : RANK.NO_ROUND_TRIP;
  }
  if (probe.spoke && check.endpointProven) return RANK.ANSWERED;
  if (probe.spoke) return RANK.ANSWERED_NOTHING;
  if (probe.declared) return RANK.NO_ROUND_TRIP;
  return RANK.NOT_DECLARED;
}

// One character per day, so the calendar has a definition a reader can check.
export const DAY_CHAR = {
  [RANK.ANSWERED]: 'o',
  [RANK.ANSWERED_NOTHING]: 'x',
  [RANK.NO_ROUND_TRIP]: '?',
  [RANK.NOT_DECLARED]: '-',
};

// Bounded JSONL store. Raw checks append between atomic checkpoints; each
// checkpoint preserves all-time totals plus the product's 50-check/90-day
// retained views, so compaction and restart do not change published state.
export function createStore(filePath, {
  seedFile = fileURLToPath(new URL('../seed/verdicts.seed.jsonl', import.meta.url)),
  maxFileBytes: maxFileBytesOption,
  compactAtBytes: compactAtBytesOption,
  maxReplayBytes: maxReplayBytesOption,
  maxAgents: maxAgentsOption,
  persistenceFs = fs,
} = {}) {
  const maxFileBytes = positiveInteger(
    maxFileBytesOption ?? process.env.FYA_VERDICT_MAX_BYTES, 192 * MIB, 'FYA_VERDICT_MAX_BYTES',
  );
  const compactAtBytes = positiveInteger(
    compactAtBytesOption ?? process.env.FYA_VERDICT_COMPACT_BYTES,
    Math.min(128 * MIB, maxFileBytes), 'FYA_VERDICT_COMPACT_BYTES',
  );
  const maxReplayBytes = positiveInteger(
    maxReplayBytesOption ?? process.env.FYA_VERDICT_REPLAY_BYTES,
    maxFileBytes, 'FYA_VERDICT_REPLAY_BYTES',
  );
  const maxAgents = positiveInteger(
    maxAgentsOption ?? process.env.FYA_VERDICT_MAX_AGENTS, 50_000, 'FYA_VERDICT_MAX_AGENTS',
  );
  if (compactAtBytes > maxFileBytes) {
    throw new PersistenceError('FYA_VERDICT_COMPACT_BYTES cannot exceed FYA_VERDICT_MAX_BYTES', {
      code: 'PERSISTENCE_CONFIG',
    });
  }
  if (maxReplayBytes < maxFileBytes) {
    throw new PersistenceError('FYA_VERDICT_REPLAY_BYTES cannot be smaller than FYA_VERDICT_MAX_BYTES', {
      code: 'PERSISTENCE_CONFIG',
    });
  }

  const seed = makeVerdictState();
  const live = makeVerdictState();
  const combined = makeVerdictState();
  const { latest, history, uptime } = combined;
  let checksRun = 0;
  let malformedRows = 0;
  let searchableRecords = 0;
  let searchableAgents = 0;
  let searchableNames = 0;
  let searchableNameCharacters = 0;
  const replayKeys = new Set();
  const seedOverlaps = new Set();

  function claimReplayKey(key) {
    if (replayKeys.has(key)) return;
    if (replayKeys.size >= maxAgents) {
      throw new PersistenceError(`Verdict replay exceeds the configured ${maxAgents}-agent limit`, {
        code: 'PERSISTENCE_CAPACITY',
      });
    }
    replayKeys.add(key);
  }

  function replayStoredRow(state, row, { excludeSeed = false } = {}) {
    if (row?.t === VERDICT_STATE_ROW) {
      validateVerdictCheckpoint(row);
      claimReplayKey(row.key);
      if (excludeSeed) {
        for (const check of row.history) {
          if (seed.seen.has(checkId(check))) seedOverlaps.add(checkId(check));
        }
      }
      restoreVerdictState(state, row);
      return;
    }
    const check = verdictFromStoredRow(row);
    claimReplayKey(check.key);
    if (!excludeSeed || !seed.seen.has(checkId(check))) applyCheck(state, check);
  }

  // Seed checks and live checks are tracked separately. A checkpoint therefore
  // never bakes bundled seed rows into the live file and double-counts them on
  // the next boot. Legacy live rows overlapping the seed are ignored exactly as
  // before, using their stable (key, timestamp) identity.
  if (seedFile) {
    const result = replayJsonl(seedFile, {
      maxBytes: maxReplayBytes, maxLineBytes: 4 * MIB, fsImpl: persistenceFs,
      onRecord: (row) => replayStoredRow(seed, row),
      onMalformed: rejectMalformedVerdictCheckpoint,
    });
    malformedRows += result.malformed;
  }
  const liveReplay = replayJsonl(filePath, {
    maxBytes: maxReplayBytes, maxLineBytes: 4 * MIB, fsImpl: persistenceFs,
    onRecord: (row) => replayStoredRow(live, row, { excludeSeed: true }),
    onMalformed: rejectMalformedVerdictCheckpoint,
  });
  malformedRows += liveReplay.malformed;
  rebuildCombined();
  if (latest.size > maxAgents) {
    throw new PersistenceError(
      `Retained verdict state has ${latest.size} agents, above its configured ${maxAgents}-agent limit`,
      { code: 'PERSISTENCE_CAPACITY' },
    );
  }

  const persistence = createBoundedJsonl(filePath, {
    maxBytes: maxFileBytes,
    compactAtBytes,
    maxLineBytes: 4 * MIB,
    fsImpl: persistenceFs,
  });

  function rebuildCombined(key) {
    const priorCheck = key === undefined ? null : combined.latest.get(key);
    const priorSearchable = searchableContribution(priorCheck);
    const keys = key === undefined ? new Set([...seed.latest.keys(), ...live.latest.keys()]) : [key];
    if (key === undefined) {
      combined.latest.clear();
      combined.history.clear();
      combined.uptime.clear();
    }
    for (const currentKey of keys) combineVerdictKey(combined, seed, live, currentKey, seedOverlaps);
    combined.totalChecks = seed.totalChecks + live.totalChecks - seedOverlaps.size;
    checksRun = combined.totalChecks;
    if (key === undefined) {
      searchableRecords = combined.latest.size;
      searchableAgents = 0;
      searchableNames = 0;
      searchableNameCharacters = 0;
      for (const check of combined.latest.values()) addSearchable(searchableContribution(check), 1);
    } else {
      const nextCheck = combined.latest.get(key);
      searchableRecords += Number(Boolean(nextCheck)) - Number(Boolean(priorCheck));
      addSearchable(priorSearchable, -1);
      addSearchable(searchableContribution(nextCheck), 1);
    }
  }

  function addSearchable(contribution, direction) {
    if (!contribution) return;
    searchableAgents += direction;
    searchableNames += direction * contribution.names;
    searchableNameCharacters += direction * contribution.characters;
  }

  function searchCorpusStats() {
    return {
      records: searchableRecords,
      agents: searchableAgents,
      servedNames: searchableNames,
      servedNameCharacters: searchableNameCharacters,
    };
  }

  function* checkpointRows() {
    for (const key of [...live.latest.keys()].sort()) {
      yield {
        t: VERDICT_STATE_ROW,
        key,
        // Kept at the top level for export validation and human inspection.
        ts: live.latest.get(key)?.ts,
        checksRun: live.checksByKey.get(key) ?? live.history.get(key)?.length ?? 0,
        latest: live.latest.get(key),
        history: live.history.get(key) ?? [],
        uptime: [...(live.uptime.get(key) ?? new Map()).entries()],
      };
    }
  }

  function record(key, verdict) {
    const check = {
      key,
      ts: verdict.computedAt,
      tier: verdict.tier,
      formulaVersion: verdict.formulaVersion,
      endpointProven: verdict.endpointProven,
      // Persist latency from the protocol that proved the endpoint.
      latencyMs: (verdict.endpointKind === 'mcp'
        ? verdict.evidence?.mcp?.latencyMs
        : verdict.evidence?.endpoint?.latencyMs) ?? null,
      // Raw probe facts, kept so the uptime calendar can classify a day without
      // consulting the formula. Whether the agent DECLARED anything callable,
      // and whether its server actually spoke: a 404 or a malformed body is a
      // reply, a timeout is silence, and the two must never be coloured alike.
      probe: {
        declared: Boolean(verdict.evidence?.endpoint?.declared || verdict.evidence?.mcp?.declared),
        spoke: Boolean(verdict.evidence?.endpoint?.reachable || verdict.evidence?.mcp?.reachable)
          || SPOKE_REASONS.has(verdict.evidence?.endpoint?.reason)
          || SPOKE_REASONS.has(verdict.evidence?.mcp?.reason),
        reason: (verdict.evidence?.mcp?.declared
          ? verdict.evidence.mcp.reason
          : verdict.evidence?.endpoint?.reason) ?? null,
      },
      proofs: (verdict.proofs ?? []).map((p) => p.signal),
      // Category placements are part of the verdict a visitor sees on a row,
      // so they have to survive a restart with the rest of it.
      categories: verdict.categories ?? [],
      // Which protocol answered, and whether the agent served everything its
      // registry metadata advertises. This is the strongest claim the site
      // makes, so it has to survive a restart too: recomputing it means
      // re-probing, and re-probing every row is what the store exists to avoid.
      endpointKind: verdict.endpointKind ?? null,
      capability: verdict.capability ?? null,
      // Card-to-agent identity evidence participates in the top-tier decision.
      subject: verdict.subject ?? null,
      // BAP-578 presence and its recorded work. Compact on purpose: the store is
      // replayed into memory on every boot, so it keeps what a row renders and
      // leaves the rest to a live check.
      // ownershipVerified travels with the row. Without it a replayed record
      // is a token id and a trade count with nothing saying whether they were
      // ever shown to belong to this agent, and the numbers would read as
      // established the moment they are loaded back.
      bap578: verdict.bap578
        ? {
          collection: verdict.bap578.collection,
          tokenId: verdict.bap578.tokenId,
          ownershipVerified: verdict.bap578.ownershipVerified ?? null,
          logicAddress: verdict.bap578.state?.logicAddress ?? null,
          totalActions: verdict.bap578.metrics?.reported ? verdict.bap578.metrics.totalActions : null,
          totalTrades: verdict.bap578.metrics?.reported ? verdict.bap578.metrics.totalTrades : null,
        }
        : null,
      name: verdict.name ?? null,
      // A poster image the registration itself names, byte-verified as an
      // image at check time. What lets the browse table show real avatars
      // without a request per row.
      avatarUrl: verdict.avatarUrl ?? null,
      // Whether its identity file publishes an ERC-8183 hire menu, so a browse
      // row can offer hire only where it is real. null = card unreadable.
      hireable: verdict.hireable ?? null,
      // What the cheapest published offering costs (wei string), so a row can
      // show a price. null when the menu names none — never rendered as free.
      minPriceU: verdict.minPriceU ?? null,
      // The capability names the endpoint actually served, so search can match
      // what an agent demonstrably does. Absent = not rechecked since this
      // field shipped, which is unknown, not "serves nothing".
      servedNames: verdict.servedNames ?? null,
      erc8183Endpoint: verdict.erc8183Endpoint ?? null,
      // The validated zero-input Try example (tool, args, ok, checkedAt). The
      // panel auto-runs ONLY what succeeded on the last real check.
      tryExample: verdict.evidence?.mcp?.tryExample ?? null,
    };
    if (!/^\d+:\d+$/.test(key)) {
      throw new PersistenceError('A verdict requires a numeric chain:token key', {
        code: 'PERSISTENCE_RECORD_INVALID',
      });
    }
    if (!combined.latest.has(key) && combined.latest.size >= maxAgents) {
      throw new PersistenceError(
        `Verdict identity limit (${maxAgents}) reached; refusing to evict an existing agent`,
        { code: 'PERSISTENCE_CAPACITY' },
      );
    }
    const id = checkId(check);
    if (seed.seen.has(id) || live.seen.has(id)) return { duplicate: true, compacted: false };

    const prior = snapshotVerdictKey(live, key);
    applyCheck(live, check);
    rebuildCombined(key);
    try {
      const result = persistence.append([check], checkpointRows);
      return { duplicate: false, compacted: result.compacted };
    } catch (error) {
      restoreVerdictKey(live, key, prior);
      live.seen.delete(id);
      rebuildCombined(key);
      throw error;
    }
  }

  /** Return stored verdicts for list rows without new network checks. */
  function latestFor(keys) {
    const out = {};
    for (const key of keys) {
      const check = latest.get(key);
      if (!check) continue;
      // Use the verdict row shape with partial evidence and its original timestamp.
      out[key] = {
        tier: check.tier,
        formulaVersion: check.formulaVersion,
        endpointProven: check.endpointProven,
        proofs: (check.proofs ?? []).map((signal) => ({ signal })),
        categories: check.categories ?? [],
        endpointKind: check.endpointKind ?? null,
        capability: check.capability ?? null,
        subject: check.subject ?? null,
        bap578: check.bap578 ?? null,
        name: check.name ?? null,
        avatarUrl: check.avatarUrl ?? null,
        hireable: check.hireable ?? null,
        minPriceU: check.minPriceU ?? null,
        servedNames: check.servedNames ?? null,
        erc8183Endpoint: check.erc8183Endpoint ?? null,
        tryExample: check.tryExample ?? null,
        evidence: { endpoint: { latencyMs: check.latencyMs } },
        checkedAt: check.ts,
        fromStore: true,
      };
    }
    return out;
  }

  function lastCheckedAt(key) {
    return latest.get(key)?.ts ?? null;
  }

  function historyFor(key, limit = 20) {
    return (history.get(key) ?? []).slice(-limit).reverse();
  }

  function liveAgents(limit = 100) {
    const rows = [];
    for (const check of latest.values()) {
      // Obsolete formulas require rechecking before participating in this list.
      if (check.tier === 'verified_live' && check.formulaVersion === FORMULA_VERSION) rows.push(check);
    }
    rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return rows.slice(0, limit);
  }

  /** Count current-formula verdicts separately from those awaiting migration. */
  function summary() {
    const tiers = { verified_live: 0, active: 0, registered: 0 };
    let awaitingRecheck = 0;
    for (const check of latest.values()) {
      if (check.formulaVersion !== FORMULA_VERSION) {
        awaitingRecheck += 1;
        continue;
      }
      if (check.tier in tiers) tiers[check.tier] += 1;
    }
    return {
      checksRun,
      uniqueChecked: latest.size,
      tiers,
      // How many stored agents have not yet been re-checked under the current
      // formula. Shown rather than hidden: it is the difference between "we
      // checked 200 agents" and "200 verdicts are current".
      awaitingRecheck,
    };
  }

  // The most recent stored check, whole. The sweeper needs the formula version
  // off it: a verdict computed by a superseded formula is not a current
  // verdict, however recently it was written.
  function lastCheck(key) {
    return latest.get(key) ?? null;
  }

  /** Shared row shape for store-backed listings and capability search. */
  function rowFromCheck(check) {
    const [chainId, tokenId] = check.key.split(':');
    return {
      chain_id: Number(chainId),
      token_id: tokenId,
      name: check.name,
      avatarUrl: check.avatarUrl ?? null,
      hireable: check.hireable ?? null,
      minPriceU: check.minPriceU ?? null,
      servedNames: check.servedNames ?? null,
      erc8183Endpoint: check.erc8183Endpoint ?? null,
      tier: check.tier,
      endpointProven: check.endpointProven,
      endpointKind: check.endpointKind ?? null,
      capability: check.capability ?? null,
      categories: check.categories ?? [],
      proofs: (check.proofs ?? []).map((signal) => ({ signal })),
      latencyMs: check.latencyMs ?? null,
      checkedAt: check.ts,
      formulaVersion: check.formulaVersion,
    };
  }

  /**
   * Search the capability names observed in endpoint responses. Missing
   * servedNames excludes a check from this search; it is not an empty menu.
   */
  function searchServed(query, limit = 25) {
    const { tokens } = validateSearchQuery(query, {
      field: 'query', tokenize: queryTokens, allowEmpty: true,
    });
    if (!tokens.length) return [];
    estimateSearchWork(tokens, searchCorpusStats(), { field: 'query' });

    // Match with the categorizer's normalization and word boundaries so search
    // and category placement recognize the same capabilities.
    const candidates = [];
    const tokensBySignature = new Map();
    for (const check of latest.values()) {
      const served = Array.isArray(check.servedNames) ? check.servedNames : null;
      if (!served?.length) continue;
      const matched = new Map();
      for (const raw of served) {
        const label = normalizeCapability(raw);
        if (!label) continue;
        for (const token of tokens) {
          if (!hasFragment(label, token)) continue;
          // Exact tool-name matches lead; otherwise prefer matches that account
          // for a larger fraction of the name.
          const strength = label === token ? 2 : 1 + (token.length / label.length);
          const held = matched.get(token);
          if (!held || strength > held.strength) matched.set(token, { tool: String(raw), strength });
        }
      }
      if (!matched.size) continue;
      const signature = served.map(String).sort().join('|');
      candidates.push({ check, signature, matched });
      tokensBySignature.set(signature, new Set(matched.keys()));
    }
    if (!candidates.length) return [];

    // Count term frequency by distinct capability sets so duplicate agent
    // fleets do not dominate relevance. These weights only order results.
    const spread = new Map();
    for (const present of tokensBySignature.values()) {
      for (const token of present) spread.set(token, (spread.get(token) ?? 0) + 1);
    }

    // Rank by the strongest capability match, then evidence tier, then match
    // breadth. Names and registry marketing copy belong to registry search.
    for (const candidate of candidates) {
      let breadth = 0;
      let best = null;
      let bestWeight = -1;
      for (const [token, hit] of candidate.matched) {
        const weight = hit.strength / (1 + (spread.get(token) ?? 0));
        breadth += weight;
        // Cite the rarest thing it matched: the word that actually narrowed the
        // field, not whichever tool happened to be listed first.
        if (weight > bestWeight) { bestWeight = weight; best = hit.tool; }
      }
      candidate.score = bestWeight;
      candidate.breadth = breadth;
      candidate.matchedTool = best;
      // Verdicts persist ISO strings; subtracting those yields NaN and leaves
      // fleet selection dependent on insertion order. Unknown dates trail all
      // valid dates, including legacy numeric timestamps.
      const ts = candidate.check.ts;
      const time = (typeof ts === 'string' || typeof ts === 'number')
        ? new Date(ts).getTime() : NaN;
      candidate.checkTime = Number.isFinite(time) ? time : -Infinity;
    }

    const TIER_ORDER = { verified_live: 0, active: 1, registered: 2 };
    candidates.sort((a, b) => (b.score - a.score)
      || ((TIER_ORDER[a.check.tier] ?? 9) - (TIER_ORDER[b.check.tier] ?? 9))
      || (Number(Boolean(b.check.endpointProven)) - Number(Boolean(a.check.endpointProven)))
      || (b.breadth - a.breadth)
      || (a.checkTime === b.checkTime ? 0 : a.checkTime > b.checkTime ? -1 : 1)
      || a.check.key.localeCompare(b.check.key));

    // Collapse identical tool lists while retaining their duplicate count.
    const bySignature = new Map();
    for (const candidate of candidates) {
      const held = bySignature.get(candidate.signature);
      if (held) { held.sameToolList += 1; continue; }
      bySignature.set(candidate.signature, { ...candidate, sameToolList: 0 });
    }

    return [...bySignature.values()].slice(0, limit).map((hit) => ({
      ...rowFromCheck(hit.check),
      matchedTool: hit.matchedTool,
      matchedTerms: [...hit.matched.keys()],
      sameToolList: hit.sameToolList,
    }));
  }

  function checkedAgents(limit = 50) {
    // Evidence-tier ordering is separate from the uptime outcome scale.
    const TIER_ORDER = { verified_live: 0, active: 1, registered: 2 };
    const rows = [];
    for (const check of latest.values()) {
      if (check.formulaVersion !== FORMULA_VERSION) continue;
      if (check.tier === 'registered' && !check.endpointProven) continue;
      rows.push(check);
    }
    rows.sort((a, b) => {
      const tier = (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9);
      if (tier !== 0) return tier;
      const proven = Number(Boolean(b.endpointProven)) - Number(Boolean(a.endpointProven));
      if (proven !== 0) return proven;
      const proofs = (b.proofs?.length ?? 0) - (a.proofs?.length ?? 0);
      if (proofs !== 0) return proofs;
      return (b.categories?.length ?? 0) - (a.categories?.length ?? 0);
    });
    // Everything a row needs, from what we already hold. No registry call.
    return rows.slice(0, limit).map(rowFromCheck);
  }

  /** Include every core category, including zero coverage, using current-formula checks. */
  function coverage() {
    const out = {};
    for (const category of JUDGED_CATEGORIES) {
      out[category] = { agents: 0, served: 0, declared: 0, endpointProven: 0, verifiedLive: 0 };
    }
    for (const check of latest.values()) {
      if (check.formulaVersion !== FORMULA_VERSION) continue;
      for (const placement of check.categories ?? []) {
        const row = (out[placement.category] ??= {
          agents: 0, served: 0, declared: 0, endpointProven: 0, verifiedLive: 0,
        });
        row.agents += 1;
        if (placement.basis === 'served') row.served += 1;
        else if (placement.basis === 'declared') row.declared += 1;
        if (check.endpointProven) row.endpointProven += 1;
        if (check.tier === 'verified_live') row.verifiedLive += 1;
      }
    }
    return out;
  }

  /** UTC calendar, oldest day first. Unchecked days have no entry. */
  function uptimeFor(key) {
    const days = uptime.get(key);
    if (!days) return { days: [], summary: null };
    const rows = [...days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([d, v]) => ({ d, c: DAY_CHAR[v.best] ?? '-', n: v.n, ok: v.ok, ms: v.ms }));

    const answered = rows.filter((r) => r.c === 'o').length;
    const unreachable = rows.filter((r) => r.c === '?').length;
    const servedNothing = rows.filter((r) => r.c === 'x').length;
    return {
      days: rows,
      // The denominator travels with the number, always. The sample is not
      // controlled: cache hits suppress a check, backoff drops ticks, and a
      // human opening the page adds one. A bare percentage over four days is
      // not something a reader could re-derive.
      summary: {
        checkedDays: rows.length,
        answered,
        unreachable,
        servedNothing,
        firstDay: rows[0]?.d ?? null,
        lastDay: rows[rows.length - 1]?.d ?? null,
      },
    };
  }

  /** Keys whose stored verdict predates the current formula. */
  function staleKeys() {
    const out = [];
    for (const [key, check] of latest) {
      if (check.formulaVersion !== FORMULA_VERSION) out.push(key);
    }
    return out;
  }

  // Read a fresh snapshot on each scheduler refresh so checks can age into the
  // queue during a long-running process. Exclusions cover queued/running retries;
  // backlog totals still include them until a new check is recorded.
  function dueRechecks({ now = Date.now(), maxAgeMs = RECHECK_AFTER_MS, limit = 100, exclude = new Set() } = {}) {
    const candidates = [];
    let due = 0;
    let oldest = null;
    const checkTime = (check) => {
      const ts = new Date(check.ts).getTime();
      return Number.isFinite(ts) ? ts : -Infinity;
    };
    for (const [key, check] of latest) {
      if (!/^\d+:\d+$/.test(key) || !isCheckDue(check, { now, maxAgeMs })) continue;
      due += 1;
      const time = checkTime(check);
      if (!oldest || time < oldest.time) oldest = { time };
      if (!exclude.has(key) && limit > 0) candidates.push({ key, time });
    }
    candidates.sort((a, b) => (a.time === b.time ? a.key.localeCompare(b.key) : a.time < b.time ? -1 : 1));
    return {
      keys: candidates.slice(0, Math.max(0, limit)).map(({ key }) => key),
      due,
      oldestCheckedAt: oldest && Number.isFinite(oldest.time) ? new Date(oldest.time).toISOString() : null,
    };
  }

  return {
    record, lastCheckedAt, lastCheck, staleKeys, dueRechecks, historyFor, uptimeFor, liveAgents, checkedAgents,
    searchServed, searchCorpusStats, summary, coverage, latestFor,
    storageStatus: () => ({ ...persistence.status(), malformedRows, degraded: malformedRows > 0, maxAgents }),
  };
}

function searchableContribution(check) {
  if (!Array.isArray(check?.servedNames) || !check.servedNames.length) return null;
  return {
    names: check.servedNames.length,
    characters: check.servedNames.reduce((sum, name) => sum + String(name).length, 0),
  };
}

function makeVerdictState() {
  return {
    latest: new Map(), history: new Map(), uptime: new Map(), checksByKey: new Map(),
    seen: new Set(), totalChecks: 0,
  };
}

function checkId(check) {
  return `${check?.key}|${check?.ts}`;
}

function applyCheck(state, check) {
  if (!check || typeof check !== 'object' || !/^\d+:\d+$/.test(check.key ?? '')) {
    throw new Error('invalid verdict row');
  }
  const id = checkId(check);
  if (state.seen.has(id)) return false;
  state.seen.add(id);
  state.totalChecks += 1;
  state.checksByKey.set(check.key, (state.checksByKey.get(check.key) ?? 0) + 1);
  const held = state.latest.get(check.key);
  if (!held || compareChecks(held, check) <= 0) state.latest.set(check.key, check);
  const list = [...(state.history.get(check.key) ?? []), check]
    .sort(compareChecks)
    .slice(-HISTORY_CAP);
  state.history.set(check.key, list);
  rollUpState(state, check);
  return true;
}

function rollUpState(state, check) {
  const days = state.uptime.get(check.key) ?? new Map();
  if (!rollUpDayMap(days, check)) return;
  state.uptime.set(check.key, days);
}

function rollUpDayMap(days, check) {
  if (typeof check?.ts !== 'string') return false;
  const instant = new Date(check.ts);
  if (!Number.isFinite(instant.getTime())) return false;
  const day = instant.toISOString().slice(0, 10);
  const prev = days.get(day) ?? { n: 0, ok: 0, best: 0, ms: null };
  const rank = rankCheck(check);
  const answered = rank === RANK.ANSWERED;
  const latency = answered && typeof check.latencyMs === 'number' ? check.latencyMs : null;
  days.set(day, {
    n: prev.n + 1,
    ok: prev.ok + (answered ? 1 : 0),
    best: Math.max(prev.best, rank),
    ms: latency != null ? Math.min(prev.ms ?? latency, latency) : prev.ms,
  });
  pruneDays(days);
  return true;
}

function restoreVerdictState(state, row) {
  validateVerdictCheckpoint(row);
  const key = row.key;
  const previousCount = state.checksByKey.get(key) ?? 0;
  state.totalChecks -= previousCount;
  state.checksByKey.set(key, row.checksRun);
  state.totalChecks += row.checksRun;
  state.latest.set(key, row.latest);
  const retained = [...row.history].sort(compareChecks).slice(-HISTORY_CAP);
  if (!retained.some((check) => checkId(check) === checkId(row.latest))) retained.push(row.latest);
  retained.sort(compareChecks);
  state.history.set(key, retained.slice(-HISTORY_CAP));
  for (const check of retained) state.seen.add(checkId(check));
  const days = new Map();
  for (const entry of row.uptime) {
    if (!Array.isArray(entry) || !/^\d{4}-\d{2}-\d{2}$/.test(entry[0] ?? '')) continue;
    const value = entry[1];
    if (!value || !Number.isFinite(value.n) || !Number.isFinite(value.ok) || !Number.isFinite(value.best)) continue;
    days.set(entry[0], { n: value.n, ok: value.ok, best: value.best, ms: value.ms ?? null });
  }
  pruneDays(days);
  state.uptime.set(key, days);
}

function combineVerdictKey(target, seed, live, key, seedOverlaps) {
  const candidates = [seed.latest.get(key), live.latest.get(key)].filter(Boolean);
  if (!candidates.length) {
    target.latest.delete(key);
    target.history.delete(key);
    target.uptime.delete(key);
    target.checksByKey.delete(key);
    return;
  }
  candidates.sort(compareChecks);
  target.latest.set(key, candidates[candidates.length - 1]);
  const deduped = new Map();
  for (const check of [...(seed.history.get(key) ?? []), ...(live.history.get(key) ?? [])]) {
    deduped.set(checkId(check), check);
  }
  target.history.set(key, [...deduped.values()].sort(compareChecks).slice(-HISTORY_CAP));
  const days = new Map();
  const overlapCount = (seed.history.get(key) ?? []).filter((check) => seedOverlaps.has(checkId(check))).length;
  const uptimeSources = [live.uptime.get(key)];
  if (!overlapCount) uptimeSources.push(seed.uptime.get(key));
  for (const source of uptimeSources) {
    for (const [day, value] of source ?? []) {
      const prev = days.get(day) ?? { n: 0, ok: 0, best: 0, ms: null };
      days.set(day, {
        n: prev.n + value.n,
        ok: prev.ok + value.ok,
        best: Math.max(prev.best, value.best),
        ms: value.ms != null ? Math.min(prev.ms ?? value.ms, value.ms) : prev.ms,
      });
    }
  }
  if (overlapCount) {
    for (const check of seed.history.get(key) ?? []) {
      if (!seedOverlaps.has(checkId(check))) rollUpDayMap(days, check);
    }
  }
  pruneDays(days);
  target.uptime.set(key, days);
  target.checksByKey.set(key,
    (seed.checksByKey.get(key) ?? 0) + (live.checksByKey.get(key) ?? 0) - overlapCount);
}

function compareChecks(a, b) {
  const aTime = checkInstant(a);
  const bTime = checkInstant(b);
  if (aTime !== null && bTime !== null) {
    return (aTime - bTime) || String(a?.ts ?? '').localeCompare(String(b?.ts ?? ''));
  }
  if (aTime !== null) return 1;
  if (bTime !== null) return -1;
  return String(a?.ts ?? '').localeCompare(String(b?.ts ?? ''));
}

function checkInstant(check) {
  if (typeof check?.ts !== 'string' && typeof check?.ts !== 'number') return null;
  const time = new Date(check.ts).getTime();
  return Number.isFinite(time) ? time : null;
}

function pruneDays(days) {
  while (days.size > UPTIME_DAY_CAP) {
    const oldest = [...days.keys()].sort()[0];
    days.delete(oldest);
  }
}

function snapshotVerdictKey(state, key) {
  return {
    latest: state.latest.get(key),
    history: state.history.has(key) ? [...state.history.get(key)] : undefined,
    uptime: state.uptime.has(key) ? new Map(state.uptime.get(key)) : undefined,
    checks: state.checksByKey.get(key),
    totalChecks: state.totalChecks,
  };
}

function restoreVerdictKey(state, key, snapshot) {
  restoreMapValue(state.latest, key, snapshot.latest);
  restoreMapValue(state.history, key, snapshot.history);
  restoreMapValue(state.uptime, key, snapshot.uptime);
  restoreMapValue(state.checksByKey, key, snapshot.checks);
  state.totalChecks = snapshot.totalChecks;
}

function restoreMapValue(map, key, value) {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}
