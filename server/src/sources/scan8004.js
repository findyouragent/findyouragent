import { config } from '../config.js';
import { withDeadline } from '../request-deadline.js';
import { EXTERNAL_WORK_MAX_ACTIVE, externalWorkAdmission, WorkCapacityError } from '../work-admission.js';
import {
  registryContractError, registryIdentity, registryPageRequest,
  validateRegistryAgent, normalizeRegistryPage, validateRegistryStats,
} from './registry-contract.js';

const RETRY_STATUSES = new Set([500, 502, 503, 504, 522, 524]);
const BODY_CANCEL_TIMEOUT_MS = 50;
export const REGISTRY_MAX_BODY_BYTES = 2 * 1024 * 1024;
// Registry lookup latency is separate from the provider probe's 6 s budget.
export const REGISTRY_DETAIL_TIMEOUT_MS = 12_000;

async function readJsonBody(response, signal, maxBytes = REGISTRY_MAX_BODY_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* preserve the contract error */ }
    throw registryContractError(`body exceeds ${maxBytes} bytes`);
  }

  // Injectable transports in deadline tests expose only json(). Production
  // fetch responses always expose a web stream, which is read under the cap.
  if (typeof response.body?.getReader !== 'function') return response.json();

  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(maxBytes);
  let total = 0;
  let cancellation;
  const cancel = (reason) => {
    cancellation ??= Promise.resolve().then(() => reader.cancel(reason)).catch(() => {});
    return cancellation;
  };
  const abort = () => { void cancel(signal.reason); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - total) {
        await cancel(registryContractError(`body exceeds ${maxBytes} bytes`));
        throw registryContractError(`body exceeds ${maxBytes} bytes`);
      }
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(bytes, total);
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) await cancel(signal.reason);
    reader.releaseLock?.();
  }
  const text = bytes.toString('utf8', 0, total);
  try { return JSON.parse(text); }
  catch (error) {
    if (error?.name === 'SyntaxError') throw registryContractError('body is not JSON');
    throw error;
  }
}

// Release failed-response connections before retrying, without letting a
// transport's stalled or rejected cleanup outlive the operation budget.
async function cancelFailedBody(response, signal) {
  if (typeof response.body?.cancel !== 'function') return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, BODY_CANCEL_TIMEOUT_MS);
    signal.addEventListener('abort', finish, { once: true });
    try { Promise.resolve(response.body.cancel()).then(finish, finish); }
    catch { finish(); }
    if (signal.aborted) finish();
  });
}

function cache(ttlMs, maximum) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (Date.now() >= hit.expires) { entries.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      while (entries.size >= maximum) entries.delete(entries.keys().next().value);
      entries.set(key, { value, expires: Date.now() + ttlMs });
    },
  };
}

// Injectable transport and budgets keep tests network-free. Public exports
// below share one instance and therefore one registry rate budget.
export function createRegistryClient({
  baseUrl = config.scan8004Base, apiKey = config.scan8004Key,
  fetchImpl = (...args) => globalThis.fetch(...args),
  detailTimeoutMs = REGISTRY_DETAIL_TIMEOUT_MS, listTimeoutMs = 20_000, searchTimeoutMs = 8000, retryBaseMs = 400,
  accountTimeoutMs = config.probeTimeoutMs,
  detailTtlMs = 300_000, listTtlMs = 30_000, statsTtlMs = 60_000,
  detailCacheEntries = 5000, listCacheEntries = 128,
  admission = externalWorkAdmission,
  maxInFlight = admission.stats?.().maxActive ?? EXTERNAL_WORK_MAX_ACTIVE,
  maxBodyBytes = REGISTRY_MAX_BODY_BYTES,
} = {}) {
  if (!admission || typeof admission.run !== 'function') throw new TypeError('registry admission controller is required');
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new TypeError('maxInFlight must be a positive safe integer');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError('maxBodyBytes must be a positive safe integer');
  const details = cache(detailTtlMs, detailCacheEntries);
  const pages = cache(listTtlMs, listCacheEntries);
  const stats = cache(statsTtlMs, 1);
  const inFlight = new Map();
  let backoffUntil = 0;

  function retryable(error) {
    if (error?.rateLimited || error?.malformed || ['TimeoutError', 'AbortError'].includes(error?.name)) return false;
    return error?.status ? RETRY_STATUSES.has(error.status) : true;
  }

  function rateError() {
    return Object.assign(new Error('8004scan is temporarily rate limited'), {
      status: 429, rateLimited: true, retryAfterSeconds: Math.max(1, Math.ceil((backoffUntil - Date.now()) / 1000)),
    });
  }

  function backoff(response) {
    const retryAfter = response.headers.get('retry-after');
    let ms = /^\d+(?:\.\d+)?$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      ms = reset > 1_000_000_000 ? reset * 1000 - Date.now() : reset * 1000;
    }
    backoffUntil = Math.max(backoffUntil,
      Date.now() + (Number.isFinite(ms) && ms > 0 ? Math.min(ms, 86_400_000) : 15_000));
  }

  async function pause(milliseconds, signal) {
    await new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  }

  async function read(path, validate, timeoutMs) {
    return admission.run(() => withDeadline(timeoutMs, async (signal) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        signal.throwIfAborted();
        try {
          if (Date.now() < backoffUntil) throw rateError();
          const headers = { accept: 'application/json' };
          if (apiKey) headers['X-API-Key'] = apiKey;
          const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
            headers, signal, redirect: 'error',
          });
          signal.throwIfAborted();
          if (response.status === 429 || !response.ok) {
            if (response.status === 429) backoff(response);
            const error = response.status === 429 ? rateError()
              : Object.assign(new Error(`8004scan returned HTTP ${response.status}`), { status: response.status });
            await cancelFailedBody(response, signal);
            throw error;
          }
          let body;
          try { body = await readJsonBody(response, signal, maxBodyBytes); }
          catch (error) {
            signal.throwIfAborted();
            if (error?.name === 'SyntaxError') throw registryContractError('body is not JSON');
            throw error;
          }
          signal.throwIfAborted();
          return validate(body);
        } catch (error) {
          signal.throwIfAborted();
          if (attempt === 3 || !retryable(error)) throw error;
          await pause(retryBaseMs * attempt, signal);
        }
      }
    }, undefined, admission)).catch((error) => { error.source = '8004scan'; throw error; });
  }

  function cachedRead(storage, key, path, validate, timeoutMs) {
    const hit = storage.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= maxInFlight) {
      return Promise.reject(new WorkCapacityError('registry requests', maxInFlight));
    }
    const pending = read(path, validate, timeoutMs).then((value) => { storage.set(key, value); return value; })
      .finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  }

  function getAgentDetail(chainId, tokenId) {
    const identity = registryIdentity(chainId, tokenId);
    const path = `/agents/${identity.chainId}/${identity.tokenId}`;
    return cachedRead(details, `detail:${path}`, path, (body) => validateRegistryAgent(body, identity), detailTimeoutMs);
  }

  function getAgentPage(params = {}) {
    const request = registryPageRequest(params);
    return cachedRead(pages, `page:${request.path}`, request.path, (body) => normalizeRegistryPage(body, request), listTimeoutMs);
  }

  function searchAgentPage(params = {}) {
    const request = registryPageRequest(params, { semantic: true });
    return cachedRead(pages, `page:${request.path}`, request.path, (body) => normalizeRegistryPage(body, request), searchTimeoutMs);
  }

  function getRegistryStats() {
    const path = '/stats/global?is_registered=any';
    return cachedRead(stats, 'stats:global', path, validateRegistryStats, listTimeoutMs);
  }

  async function getAccountAgentCount(address) {
    try {
      const request = registryPageRequest({ ownerAddress: address, limit: 1, isRegistered: 'any', isActive: 'any' });
      // Owner evidence sits on the interactive verification path. Its own
      // operation key keeps a longer list read from extending this deadline.
      const page = await cachedRead(pages, `account:${request.path}`, request.path,
        (body) => normalizeRegistryPage(body, request), accountTimeoutMs);
      return page.meta.pagination.total;
    } catch { return null; }
  }

  return { getAgentDetail, getAgentPage, searchAgentPage, getRegistryStats, getAccountAgentCount,
    listAgents: async (params) => (await getAgentPage(params)).data,
    isRateLimited: () => Date.now() < backoffUntil };
}

const registry = createRegistryClient();
export const getAgentDetail = (...args) => registry.getAgentDetail(...args);
export const getAgentPage = (...args) => registry.getAgentPage(...args);
export const searchAgentPage = (...args) => registry.searchAgentPage(...args);
export const listAgents = (...args) => registry.listAgents(...args);
export const getRegistryStats = (...args) => registry.getRegistryStats(...args);
export const getAccountAgentCount = (...args) => registry.getAccountAgentCount(...args);
export const isRateLimited = () => registry.isRateLimited();
