export const INTERFACE_TIMEOUT_MS = 35_000;
export const TASK_TIMEOUT_MS = 95_000;

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const shortMessage = (value) => typeof value === 'string' ? value.slice(0, 500) : null;

// The deadline includes both headers and the body. Abort alone cannot bound
// a stalled body reader (or a fetch implementation that ignores its signal).
async function requestJson(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let response = null;
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      (async () => {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
        const raw = await response.text();
        let body = null;
        try { body = JSON.parse(raw); } catch { /* relay/proxy HTML is not an agent result */ }
        return { response, raw, body };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('deadline exceeded'));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    return { response, error, timedOut, body: null, raw: null };
  } finally {
    clearTimeout(timer);
  }
}

function validInterface(body) {
  if (!isObject(body) || !['mcp', 'a2a', 'none'].includes(body.kind)) return false;
  if (body.kind === 'mcp' && (!Array.isArray(body.tools)
    || body.tools.some((tool) => !isObject(tool) || typeof tool.name !== 'string' || !tool.name))) return false;
  if (body.taskPresets !== undefined && (!Array.isArray(body.taskPresets)
    || body.taskPresets.some((preset) => !isObject(preset) || typeof preset.id !== 'string' || typeof preset.title !== 'string'))) return false;
  if (body.example !== undefined && body.example !== null
    && (!isObject(body.example) || typeof body.example.tool !== 'string')) return false;
  return true;
}

export async function fetchTryInterface({ serviceBase, chainId, tokenId, fetchImpl = globalThis.fetch, timeoutMs = INTERFACE_TIMEOUT_MS }) {
  const reply = await requestJson(`${serviceBase}/api/try/${chainId}/${tokenId}/interface`, {}, fetchImpl, timeoutMs);
  const httpStatus = reply.response?.status ?? null;
  let error;
  if (reply.timedOut) error = 'Reading available tools took too long. Retry available tools when the connection is ready.';
  else if (reply.error) error = 'Could not reach the service to read available tools. Check your connection and retry.';
  else if (!reply.response.ok) {
    error = `Could not read available tools (HTTP ${httpStatus}). ${shortMessage(reply.body?.detail) || shortMessage(reply.body?.error) || 'The service is temporarily unavailable.'}`;
  } else if (!validInterface(reply.body)) error = 'The service returned an unreadable list of available tools. Retry available tools.';
  else if (reply.body.error) error = shortMessage(reply.body.detail) || shortMessage(reply.body.error) || 'The service could not read available tools. Retry available tools.';
  return error ? { kind: 'none', error, httpStatus } : { ...reply.body, httpStatus };
}

function incompleteObservation({ startedAt, httpStatus, protocol, reason, unknown = false }) {
  const finishedAt = new Date().toISOString();
  return {
    version: 0, runId: globalThis.crypto.randomUUID(), protocol, phase: 'relay',
    startedAt, finishedAt, checkedAt: finishedAt,
    latencyMs: new Date(finishedAt) - new Date(startedAt),
    outcome: unknown ? 'unknown' : 'error', reason, captureComplete: false,
    // This is the HTTP status observed from FYA's relay, not an inferred
    // upstream status or evidence that the provider completed the task.
    transport: { status: httpStatus, ok: httpStatus >= 200 && httpStatus < 300, received: httpStatus !== null },
    task: { status: 'not_evaluated' },
  };
}

export async function fetchTryTask({ serviceBase, chainId, tokenId, request, fetchImpl = globalThis.fetch, timeoutMs = TASK_TIMEOUT_MS }) {
  const startedAt = new Date().toISOString();
  const reply = await requestJson(`${serviceBase}/api/try/${chainId}/${tokenId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }, fetchImpl, timeoutMs);
  const httpStatus = reply.response?.status ?? null;
  const protocol = request.message !== undefined ? 'a2a' : 'mcp';
  let detail;
  let reason;
  if (reply.timedOut) {
    reason = 'relay-timeout';
    detail = 'The request timed out. Completion is unknown; the provider may still be working. No automatic retry was made.';
  } else if (reply.error) {
    reason = 'relay-connection-lost';
    detail = 'The connection ended before a complete task response arrived. Completion is unknown. No automatic retry was made.';
  } else if (!isObject(reply.body) || !('body' in reply.body || 'error' in reply.body || isObject(reply.body.observation))) {
    reason = 'relay-invalid-response';
    detail = `The task service returned an unreadable response (HTTP ${httpStatus}). Completion is unknown. No automatic retry was made.`;
  }
  if (detail) return {
    httpStatus, error: reason, detail,
    body: { error: { message: detail }, ...(reply.raw ? { raw: reply.raw.slice(0, 4000) } : {}) },
    observation: incompleteObservation({ startedAt, httpStatus, protocol, reason, unknown: Boolean(reply.error) }),
  };
  return {
    ...reply.body,
    httpStatus,
    observation: reply.body.observation ?? incompleteObservation({
      startedAt, httpStatus, protocol, reason: 'server-observation-unavailable',
      unknown: reply.response.ok && !(reply.body.status >= 400) && !reply.body.error
        && !reply.body.body?.error && reply.body.body?.result?.isError !== true,
    }),
  };
}

const MAX_SESSION_AGENTS = 20;
const MAX_AGENT_EXCHANGES = 20;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const histories = new Map();
const paymentChallenges = new Map();
const paymentListeners = new Set();
let paymentRevision = 0;
const encoder = new TextEncoder();

function publishPaymentChange() {
  paymentRevision += 1;
  for (const listener of paymentListeners) {
    try { listener(); } catch { /* a view listener cannot interrupt payment state */ }
  }
}

export function subscribePaymentChallenges(listener) {
  paymentListeners.add(listener);
  return () => paymentListeners.delete(listener);
}

export function paymentChallengeRevision() {
  return paymentRevision;
}

function rememberedPaymentState(entry) {
  const state = entry?.paymentChallenge?.state;
  // `prompting` is transient live-ledger state. Persisting it lets a delayed
  // React updater resurrect a lock after wallet cancellation released it.
  return state === 'consumed' ? entry.paymentChallenge : null;
}

function copyPaymentState(state) {
  return state ? { ...state } : { state: 'available', outcome: null };
}

function durablePaymentState(challengeId, remembered) {
  const current = paymentChallenges.get(challengeId);
  // A stale React/session snapshot may lag the wallet callback. It can never
  // downgrade a consumed challenge to prompting.
  return current?.state === 'consumed' ? current : remembered;
}

function rewriteHistoryPayment(agentKey, challengeId, paymentChallenge) {
  const history = histories.get(agentKey);
  if (!history) return;
  history.entries = history.entries.map((entry) => {
    if (entry.paymentChallengeId !== challengeId) return entry;
    if (paymentChallenge) return { ...entry, paymentChallenge };
    const { paymentChallenge: _removed, ...rest } = entry;
    return rest;
  });
  history.bytes = history.entries.reduce((sum, entry) => {
    try { return sum + encoder.encode(JSON.stringify(entry)).byteLength; } catch { return sum; }
  }, 0);
}

// Payment state lives for this browser tab's JavaScript session, independently
// of a mounted component. Only lifecycle labels are retained: never the signed
// payment header, authorization, signature, or wallet address.
export function paymentChallengeState(challengeId) {
  return copyPaymentState(paymentChallenges.get(challengeId));
}

export function lockPaymentChallenge(challengeId) {
  if (!challengeId || paymentChallenges.has(challengeId)) return false;
  paymentChallenges.set(challengeId, { state: 'prompting', outcome: null });
  publishPaymentChange();
  return true;
}

export function releasePaymentChallenge(agentKey, challengeId) {
  if (paymentChallenges.get(challengeId)?.state !== 'prompting') return false;
  paymentChallenges.delete(challengeId);
  rewriteHistoryPayment(agentKey, challengeId, null);
  publishPaymentChange();
  return true;
}

export function consumePaymentChallenge(agentKey, challengeId, outcome) {
  const current = paymentChallenges.get(challengeId);
  if (!challengeId || (current && current.state !== 'prompting' && current.state !== 'consumed')) return null;
  const next = { state: 'consumed', outcome };
  paymentChallenges.set(challengeId, next);

  // Update the retained snapshot synchronously. React state may be discarded
  // by navigation in the same tick that a wallet returns a signature.
  rewriteHistoryPayment(agentKey, challengeId, next);
  publishPaymentChange();
  return copyPaymentState(next);
}

// Keep complete records only, with an explicit memory bound. Nothing goes to
// persistent browser storage; downloads remain the durable copy.
export function rememberTryHistory(agentKey, exchanges) {
  const entries = [];
  let bytes = 0;
  for (const sourceEntry of exchanges.slice(-MAX_AGENT_EXCHANGES).reverse()) {
    let entry = sourceEntry;
    const remembered = rememberedPaymentState(entry);
    if (entry?.paymentChallengeId) {
      const current = paymentChallenges.get(entry.paymentChallengeId);
      if (current?.state === 'consumed' || remembered) {
        const durable = durablePaymentState(entry.paymentChallengeId, remembered);
        paymentChallenges.set(entry.paymentChallengeId, copyPaymentState(durable));
        if (durable !== remembered) entry = { ...entry, paymentChallenge: copyPaymentState(durable) };
      } else if (entry.paymentChallenge) {
        // Keep transient UI state in React only. The session snapshot follows
        // the authoritative ledger and cannot restore prompting after release.
        const { paymentChallenge: _transient, ...rest } = entry;
        entry = rest;
      }
    }
    let size;
    try { size = encoder.encode(JSON.stringify(entry)).byteLength; } catch { continue; }
    if (bytes + size > MAX_SESSION_BYTES) continue;
    entries.unshift(entry);
    bytes += size;
  }
  histories.delete(agentKey);
  if (entries.length) histories.set(agentKey, { entries, bytes });
  let total = [...histories.values()].reduce((sum, history) => sum + history.bytes, 0);
  while (histories.size > MAX_SESSION_AGENTS || total > MAX_SESSION_BYTES) {
    const oldest = histories.keys().next().value;
    total -= histories.get(oldest).bytes;
    histories.delete(oldest);
  }
}

export function recallTryHistory(agentKey) {
  const history = histories.get(agentKey);
  if (!history) return [];
  const entries = history.entries.map((sourceEntry) => {
    let entry = sourceEntry;
    const state = rememberedPaymentState(entry);
    if (entry?.paymentChallengeId && state) {
      paymentChallenges.set(entry.paymentChallengeId, copyPaymentState(durablePaymentState(entry.paymentChallengeId, state)));
    } else if (entry?.paymentChallenge?.state === 'prompting') {
      const { paymentChallenge: _transient, ...rest } = entry;
      entry = rest;
    }
    return entry;
  });
  history.entries = entries;
  return entries.slice();
}
