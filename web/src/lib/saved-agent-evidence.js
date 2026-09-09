const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function savedToken(value) {
  if (!object(value) || !/^0x[0-9a-f]{40}$/i.test(value.collection || '')
    || !/^(0|[1-9]\d{0,77})$/.test(String(value.tokenId))) return null;
  const trades = value.metrics?.reported ? value.metrics.totalTrades : value.totalTrades;
  return {
    collection: value.collection, tokenId: String(value.tokenId),
    ownershipVerified: value.ownershipVerified === true,
    totalTrades: Number.isSafeInteger(trades) && trades >= 0 ? trades : null,
  };
}

function savedCheck(value, key, history = false) {
  if (!object(value) || (history ? value.key !== key : value.key != null && value.key !== key)) return null;
  const checkedAt = history ? value.ts : value.checkedAt;
  if (!timestamp(checkedAt)) return null;
  // Keep saved observations only. No endpoint, wallet, hire menu, or task
  // arguments can become an actionable current registry record through this.
  return {
    checkedAt, name: typeof value.name === 'string' ? value.name : null,
    tier: typeof value.tier === 'string' ? value.tier : null,
    endpointProven: typeof value.endpointProven === 'boolean' ? value.endpointProven : null,
    endpointKind: typeof value.endpointKind === 'string' ? value.endpointKind : null,
    servedNames: Array.isArray(value.servedNames) ? value.servedNames.filter(name => typeof name === 'string') : null,
    bap578: savedToken(value.bap578),
    latencyMs: Number.isFinite(history ? value.latencyMs : value.evidence?.endpoint?.latencyMs)
      ? (history ? value.latencyMs : value.evidence.endpoint.latencyMs) : null,
  };
}

async function readSaved(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...init, credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error('Saved evidence is unavailable.');
        const body = await response.json();
        if (!object(body)) throw new Error('Saved evidence is unreadable.');
        return body;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Saved evidence timed out.')); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function fetchSavedAgentEvidence({ serviceBase, chainId, tokenId, fetchImpl = globalThis.fetch, timeoutMs = 6000 }) {
  if (!/^\d+$/.test(String(chainId)) || !/^\d+$/.test(String(tokenId))) throw new Error('Invalid agent identifier.');
  const key = `${chainId}:${tokenId}`;
  if (!serviceBase) return { key, latest: null, checks: [], unavailable: true, partial: false };
  const base = serviceBase.replace(/\/+$/, '');
  const [verdictResult, historyResult] = await Promise.allSettled([
    readSaved(`${base}/api/verdicts`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ keys: [key] }),
    }, fetchImpl, timeoutMs),
    readSaved(`${base}/api/history/${chainId}/${tokenId}`, { headers: { accept: 'application/json' } }, fetchImpl, timeoutMs),
  ]);
  const verdictBody = verdictResult.status === 'fulfilled' ? verdictResult.value : null;
  const historyBody = historyResult.status === 'fulfilled' ? historyResult.value : null;
  const verdictAvailable = object(verdictBody?.verdicts);
  const historyAvailable = Array.isArray(historyBody?.checks);
  const verdict = savedCheck(verdictBody?.verdicts?.[key], key);
  const checks = (historyAvailable ? historyBody.checks : []).map(check => savedCheck(check, key, true)).filter(Boolean)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  const latest = [verdict, checks[0]].filter(Boolean).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0] ?? null;
  return { key, latest, checks, unavailable: !verdictAvailable && !historyAvailable, partial: !verdictAvailable || !historyAvailable };
}

// Registry retry must not erase the saved record when its independent refresh
// fails. A different identity is never allowed to reuse that record.
export function retainSavedEvidence(previous, incoming) {
  if (previous?.key === incoming?.key && previous?.latest && incoming?.latest
    && Date.parse(incoming.latest.checkedAt) < Date.parse(previous.latest.checkedAt)) return previous;
  if (incoming?.unavailable && previous?.key === incoming.key && previous.latest) {
    return { ...previous, partial: true };
  }
  return incoming;
}

// Both requests start independently. Cancellation fences every callback,
// including a late failure after navigation or a newer lookup attempt.
export function startDetailRecovery({ loadDetail, loadSaved, onDetail, onError, onSaved, onSettled }) {
  let cancelled = false;
  const detail = Promise.resolve().then(loadDetail)
    .then(value => { if (!cancelled) onDetail(value); }, error => { if (!cancelled) onError(error); })
    .finally(() => { if (!cancelled) onSettled(); });
  const saved = Promise.resolve().then(loadSaved)
    .then(value => { if (!cancelled) onSaved(value); }, () => {});
  return { done: Promise.all([detail, saved]), cancel() { cancelled = true; } };
}
