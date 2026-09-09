import { SCAN_BASE, VERIFY_BASE, CHAIN_ID, PAGE_SIZE } from '../config.js';
import { fetchRegistryDetail } from './registry-detail.js';
import { fetchRegistryPage, fetchRegistrySearch, fetchRegistryStats } from './registry.js';
import { fetchTryInterface, fetchTryTask } from '../lib/try-session.js';
import { verificationError } from '../lib/verification-error.js';
import { createReadSession } from './read-session.js';
import { hasAgentMetadata } from '../lib/agent-metadata.js';

const reads = createReadSession();
const VERIFICATION_TIMEOUT_MS = 30_000;
const META_TIMEOUT_MS = 30_000;

function datedVerdictFor(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.error
    || !['registered', 'active', 'verified_live'].includes(value.tier)) return false;
  const checkedAt = value.computedAt ?? value.checkedAt;
  if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) return false;
  return !(typeof value.agentId === 'string' && /^\d+:\d+$/.test(value.agentId) && value.agentId !== key);
}

async function readJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(url, { signal: controller.signal }).then(async (res) => ({ res, body: await res.json() })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('read timed out')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function listAgents({ page = 1, search = '', sortBy = 'created_at' } = {}) {
  return fetchRegistryPage({ serviceBase: VERIFY_BASE, chainId: CHAIN_ID, page, limit: PAGE_SIZE, search, sortBy });
}

// The backend owns the registry credentials and upstream response contract.
// Semantic search falls back to keyword search within one browser deadline.
export async function searchAgents({ query, semanticQuery, page = 1 } = {}) {
  return fetchRegistrySearch({ serviceBase: VERIFY_BASE, chainId: CHAIN_ID, query, semanticQuery, page, limit: PAGE_SIZE });
}

export async function getRegistryStats() {
  return fetchRegistryStats({ serviceBase: VERIFY_BASE });
}

export async function getAgentDetail(chainId, tokenId) {
  const key = `agent:${chainId}:${tokenId}`;
  return reads.getOrStart(key, () => fetchRegistryDetail({ serviceBase: VERIFY_BASE, scanBase: SCAN_BASE, chainId, tokenId }), {
    cacheable: (value) => value && typeof value === 'object',
  }).promise;
}

export async function getVerdict(chainId, tokenId) {
  return startVerification(chainId, tokenId, { stream: false }).promise;
}

// Verdicts already on record for these agents. Never triggers a check, so a
// page can render the sweep's existing work instantly instead of asking the
// visitor to click every row.
export async function getKnownVerdicts(agents) {
  if (!VERIFY_BASE || agents.length === 0) return {};
  try {
    const keys = agents.map((a) => `${a.chain_id}:${a.token_id}`);
    const res = await fetch(`${VERIFY_BASE}/api/verdicts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    if (!res.ok) return {};
    const body = await res.json();
    return body.verdicts ?? {};
  } catch {
    return {};
  }
}

export async function getAgentMeta(chainId, tokenId, { force = false, refresh = false } = {}) {
  if (!VERIFY_BASE) return null;
  const ordinaryKey = `meta:${chainId}:${tokenId}`;
  // A deliberate refresh must not attach to an older ordinary read that was
  // already in flight with a potentially stale server-cache response.
  const isRefresh = force || refresh;
  const key = `${ordinaryKey}${isRefresh ? ':refresh' : ''}`;
  if (isRefresh) reads.invalidate(ordinaryKey);
  return reads.getOrStart(key, async () => {
    if (isRefresh) reads.invalidate(ordinaryKey);
    try {
      const query = isRefresh ? '?refresh=1' : '';
      const { res, body } = await readJsonWithTimeout(`${VERIFY_BASE}/api/agent-meta/${chainId}/${tokenId}${query}`, META_TIMEOUT_MS);
      if (!res.ok) return null;
      return hasAgentMetadata(body) ? body : null;
    } catch {
      return null;
    } finally {
      if (isRefresh) reads.invalidate(ordinaryKey);
    }
  }, { force: isRefresh, cacheable: (value) => hasAgentMetadata(value) }).promise;
}

// Returns both the raw check list and the per-day calendar. One request, since
// the two are two views of the same records and the route already computed both.
// The empty shape is returned on every failure path so callers never branch on
// null: an unreachable verify service should render as no history, not as an
// error about history.
const NO_HISTORY = { checks: [], uptime: { days: [], summary: null } };

export async function getCheckHistory(chainId, tokenId) {
  if (!VERIFY_BASE) return NO_HISTORY;
  try {
    const res = await fetch(`${VERIFY_BASE}/api/history/${chainId}/${tokenId}`);
    if (!res.ok) return NO_HISTORY;
    const body = await res.json();
    return { checks: body.checks ?? [], uptime: body.uptime ?? NO_HISTORY.uptime };
  } catch {
    return NO_HISTORY;
  }
}

/**
 * Agents whose live endpoint actually SERVED a capability matching the query.
 *
 * Our own checks, not the registry's text — so a hit is evidence, and each row
 * names the tool it matched. Costs no registry budget. Returns [] rather than
 * throwing: a search must still show registry results if this half is down.
 */
export async function searchByCapability(query) {
  if (!VERIFY_BASE || !query?.trim()) return [];
  try {
    const res = await fetch(`${VERIFY_BASE}/api/search?q=${encodeURIComponent(query.trim())}`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.agents) ? body.agents : [];
  } catch {
    return [];
  }
}

/**
 * Verification with live narration. Opens the SSE variant of /api/verify and
 * calls onEvent for each probe frame as it lands; resolves with the final
 * verdict. A proxy that strips streaming can fall back to the JSON route.
 * Identity failures and explicit SSE errors retain their typed cause without
 * triggering another check. Identity-file failures differ from throttling.
 */
async function readVerification(chainId, tokenId, stream, emit) {
  if (!VERIFY_BASE) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);
  try {
    const suffix = stream ? '?stream=1' : '';
    let res;
    try {
      res = await fetch(`${VERIFY_BASE}/api/verify/${chainId}/${tokenId}${suffix}`, { signal: controller.signal });
    } catch (error) {
      if (!stream) throw error;
      // The stream and JSON fallback belong to this one shared operation.
      res = await fetch(`${VERIFY_BASE}/api/verify/${chainId}/${tokenId}`, { signal: controller.signal });
    }
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 503 || res.status === 429) {
      const body = await res.json().catch(() => ({}));
      throw verificationError(body, { status: res.status });
    }
    if (!res.ok || !type.includes('text/event-stream') || !res.body) {
      if (res.ok && type.includes('application/json')) return await res.json();
      if (stream) {
        const fallback = await fetch(`${VERIFY_BASE}/api/verify/${chainId}/${tokenId}`, { signal: controller.signal });
        if (!fallback.ok) {
          const body = await fallback.json().catch(() => ({}));
          throw verificationError(body, { status: fallback.status });
        }
        return await fallback.json();
      }
      const body = await res.json().catch(() => ({}));
      throw verificationError(body, { status: res.status });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let verdict = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        let evt;
        try { evt = JSON.parse(data.slice(6)); } catch { continue; }
        if (evt?.step === 'error') {
          await reader.cancel().catch(() => {});
          throw verificationError(evt);
        }
        if (evt?.step === 'verdict') verdict = evt.verdict;
        else emit(evt);
      }
    }
    if (verdict) return verdict;
    const fallback = await fetch(`${VERIFY_BASE}/api/verify/${chainId}/${tokenId}`, { signal: controller.signal });
    if (!fallback.ok) {
      const body = await fallback.json().catch(() => ({}));
      throw verificationError(body, { status: fallback.status });
    }
    return await fallback.json();
  } finally {
    clearTimeout(timer);
  }
}

function startVerification(chainId, tokenId, { stream = false, onEvent } = {}) {
  if (!VERIFY_BASE) return { promise: Promise.resolve(null), subscribe: () => () => {} };
  const key = `verification:${chainId}:${tokenId}`;
  const operation = reads.getOrStart(key, (emit) => readVerification(chainId, tokenId, stream, emit), {
    mapCached: (value) => value && typeof value === 'object' ? { ...value, cached: true } : value,
    cacheable: (value) => datedVerdictFor(`${chainId}:${tokenId}`, value),
  });
  if (onEvent) operation.subscribe(onEvent);
  return operation;
}

export function verifyStreamed(chainId, tokenId, onEvent) {
  return startVerification(chainId, tokenId, { stream: true, onEvent }).promise;
}

// On-demand on-chain activity feed. A failure returns an explicit unavailable
// gate rather than throwing, so a network hiccup renders as "we could not
// reach the feed", never as "the agent has no activity".
const NO_ACTIVITY = {
  attribution: { gate: 'unavailable', wallet: null },
  coverage: { fromBlock: null, toBlock: null, intervals: 0, scannedThroughTs: null },
  events: [], classLabels: {}, sources: {},
};

export async function getActivity(chainId, tokenId) {
  if (!VERIFY_BASE) return NO_ACTIVITY;
  try {
    const res = await fetch(`${VERIFY_BASE}/api/activity/${chainId}/${tokenId}`);
    if (!res.ok) return NO_ACTIVITY;
    return await res.json();
  } catch {
    return NO_ACTIVITY;
  }
}

/*
  What one wallet did on the ERC-8183 escrow, from our census of the kernel.

  Every failure mode collapses to the SAME shape with `available: false`, which
  the record line renders as "no census on this deployment" — never as an agent
  with no jobs. A service that is off, throttled or unreachable is a fact about
  us, and rule 1 of the honesty page is that it must not be printed as a
  measurement of them.
*/
const NO_CENSUS = { available: false, found: false, record: null, range: null };

export async function getEscrowRecord(address) {
  if (!VERIFY_BASE || !/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) return NO_CENSUS;
  try {
    const res = await fetch(`${VERIFY_BASE}/api/escrow/${address}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NO_CENSUS;
    const body = await res.json();
    return body && typeof body === 'object' ? body : NO_CENSUS;
  } catch {
    return NO_CENSUS;
  }
}

export async function tryAgentCall(chainId, tokenId, message, payment) {
  if (!VERIFY_BASE) throw new Error('verification service not configured');
  return fetchTryTask({ serviceBase: VERIFY_BASE, chainId, tokenId, request: payment ? { message, payment } : { message } });
}

// The agents we hold a current verdict for, best first, straight from the
// verification service's own records. Costs no registry request, so opening the
// site does not spend the shared budget before a visitor clicks anything.
export async function getCheckedAgents(limit = 50) {
  if (!VERIFY_BASE) return [];
  try {
    const res = await fetch(`${VERIFY_BASE}/api/checked?limit=${limit}`);
    if (!res.ok) return [];
    return (await res.json())?.agents ?? [];
  } catch {
    return [];
  }
}

// How this agent can be tried: a free-text A2A message, or a named MCP tool.
// Asked rather than assumed, because most agents doing real work on this
// registry speak MCP and take typed arguments, not prose.
export async function getTryInterface(chainId, tokenId) {
  if (!VERIFY_BASE) return null;
  return fetchTryInterface({ serviceBase: VERIFY_BASE, chainId, tokenId });
}

export async function callAgentTool(chainId, tokenId, tool, args) {
  if (!VERIFY_BASE) throw new Error('verification service not configured');
  return fetchTryTask({ serviceBase: VERIFY_BASE, chainId, tokenId, request: { tool, arguments: args } });
}

export async function runAgentTask(chainId, tokenId, presetId) {
  if (!VERIFY_BASE) throw new Error('verification service not configured');
  return fetchTryTask({ serviceBase: VERIFY_BASE, chainId, tokenId, request: { presetId } });
}

export async function getVerifySummary() {
  if (!VERIFY_BASE) return null;
  try {
    const res = await fetch(`${VERIFY_BASE}/api/summary`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
