const DEFAULT_TIMEOUT_MS = 25_000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => (typeof value === 'string' && /^\d+$/.test(value))
  || (Number.isSafeInteger(value) && value >= 0);

function serviceUrl(serviceBase, route, params) {
  if (typeof serviceBase !== 'string' || !serviceBase.trim()) {
    throw new Error('The registry service is not configured. Set the FYA API address to browse the registry.');
  }
  return `${serviceBase.replace(/\/+$/, '')}${route}${params ? `?${params}` : ''}`;
}

function pageInput({ chainId, page = 1, limit = 25 }) {
  if (!identifier(chainId) || Number(chainId) <= 0 || !Number.isSafeInteger(Number(chainId))) {
    throw new Error('Invalid registry chain identifier.');
  }
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1
    || limit > 100 || !Number.isSafeInteger((page - 1) * limit)
    || !Number.isSafeInteger(page * limit)) throw new Error('Invalid registry page or limit.');
  return { chainId: Number(chainId), page, limit };
}

function deadlineError() {
  return new Error('The registry service is taking too long to respond. Please try again.');
}

async function readJson(url, fetchImpl, timeoutMs) {
  if (!(timeoutMs > 0)) throw deadlineError();
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/json' }, credentials: 'omit', signal: controller.signal,
        });
        // Reading the body remains inside the deadline. A response that sends
        // headers and then stalls must not leave browsing spinning forever.
        const raw = await response.text();
        if (!response.ok) {
          if (response.status === 404) throw Object.assign(new Error('This FYA service does not support registry browsing yet.'), {
            code: 'registry-service-outdated', status: 404,
          });
          let failure;
          try { failure = JSON.parse(raw); } catch { /* Keep untyped proxy failures unattributed. */ }
          const upstream = failure?.source === '8004scan'
            && ['registry-unavailable', 'registry-throttled', 'registry-invalid-response'].includes(failure?.error);
          const message = upstream
            ? failure.error === 'registry-throttled'
              ? '8004scan registry reads are temporarily throttled. Please try again shortly.'
              : 'FYA could not read the current listing from 8004scan. Please try again.'
            : `Registry browsing is unavailable (HTTP ${response.status}). Please try again.`;
          throw Object.assign(new Error(message), {
            status: response.status, code: failure?.error ?? null,
            source: upstream ? '8004scan' : null,
            upstreamStatus: upstream ? failure.upstreamStatus ?? null : null,
            retryable: upstream ? failure.retryable ?? null : null,
          });
        }
        let body;
        try { body = JSON.parse(raw); } catch { throw new Error('The registry service returned an unreadable response. Please try again.'); }
        if (!object(body) || body.success === false || body.error != null) {
          throw new Error('The registry service did not return a usable response. Please try again.');
        }
        if (body.source !== undefined && body.source !== '8004scan') {
          throw new Error('The registry service returned an unexpected data source. Please try again.');
        }
        return body;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(deadlineError()); }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof TypeError) throw Object.assign(new Error('Your browser could not reach the FYA API. Please check the connection and try again.'), {
      code: 'registry-network-error', cause: error,
    });
    throw error;
  } finally { clearTimeout(timer); }
}

function rowsFrom(body, chainId) {
  if (!Array.isArray(body.data)) throw new Error('The registry service returned an invalid agent list. Please try again.');
  const identities = new Set();
  for (const agent of body.data) {
    if (!object(agent) || !identifier(agent.chain_id) || Number(agent.chain_id) !== chainId || !identifier(agent.token_id)) {
      throw new Error('The registry service returned an agent outside the requested chain or without a valid identity. Please try again.');
    }
    const key = `${Number(agent.chain_id)}:${BigInt(agent.token_id)}`;
    if (identities.has(key)) throw new Error('The registry service returned duplicate agent identities. Please try again.');
    identities.add(key);
  }
  // Preserve the exact row. Missing services are unknown, never a manufactured
  // empty service list or a claim that the agent has no callable interface.
  return body.data;
}

function paginationFrom(body, rows, input) {
  if (rows.length > input.limit) throw new Error('The registry service returned more agents than requested. Please try again.');
  const pagination = body.meta?.pagination;
  if (pagination === undefined || pagination === null) {
    throw new Error('The registry service did not return pagination. Please try again.');
  }
  const { page, limit, total, hasMore } = pagination;
  const offset = (input.page - 1) * input.limit;
  if (!object(pagination) || page !== input.page || limit !== input.limit || !count(total)
    || typeof hasMore !== 'boolean' || rows.length !== Math.min(limit, Math.max(0, total - offset))
    || hasMore !== (offset + rows.length < total)) {
    throw new Error('The registry service returned inconsistent pagination. Please try again.');
  }
  return pagination;
}

export async function fetchRegistryPage({ serviceBase, chainId, page = 1, limit = 25,
  sortBy = 'created_at', search = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const input = pageInput({ chainId, page, limit });
  if (typeof search !== 'string' || typeof sortBy !== 'string' || !sortBy.trim()) throw new Error('Invalid registry search or sort.');
  const params = new URLSearchParams({ chainId: String(input.chainId), page: String(page), limit: String(limit), sortBy, sortOrder: 'desc' });
  if (search.trim()) params.set('search', search.trim());
  const body = await readJson(serviceUrl(serviceBase, '/api/registry/agents', params), fetchImpl, timeoutMs);
  const agents = rowsFrom(body, input.chainId);
  const pagination = paginationFrom(body, agents, input);
  return {
    agents, pagination,
    ...(input.chainId === 56 && !search.trim() ? {
      registryCount: { chainId: 56, total: pagination.total, source: 'unfiltered-list', retrievedAt: new Date().toISOString() },
    } : {}),
  };
}

export async function fetchRegistrySearch({ serviceBase, chainId, page = 1, limit = 25,
  query = '', semanticQuery = '', sortBy = 'created_at', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const input = pageInput({ chainId, page, limit });
  if (typeof query !== 'string' || typeof semanticQuery !== 'string') throw new Error('Invalid registry search.');
  // Fail configuration before considering a fallback. Listing/search stay on
  // FYA's backend so API credentials never need to be sent by the browser.
  const semanticUrl = serviceUrl(serviceBase, '/api/registry/search');
  const deadline = Date.now() + timeoutMs;
  const term = semanticQuery.trim() || query.trim();
  if (term) {
    const params = new URLSearchParams({ q: term, chainId: String(input.chainId), page: String(page), limit: String(limit) });
    try {
      const body = await readJson(`${semanticUrl}?${params}`, fetchImpl, deadline - Date.now());
      const agents = rowsFrom(body, input.chainId);
      const pagination = paginationFrom(body, agents, input);
      if (agents.length) return { agents, pagination, mode: 'semantic' };
    } catch (error) {
      if (error?.code === 'registry-service-outdated') throw error;
      // A failed or malformed semantic response is not an empty registry.
      // One keyword lookup may still answer, within the same overall deadline.
    }
  }
  const result = await fetchRegistryPage({ serviceBase, ...input, sortBy,
    search: query.trim() || semanticQuery.trim(), fetchImpl, timeoutMs: deadline - Date.now() });
  return { ...result, mode: 'keyword' };
}

export async function fetchRegistryStats({ serviceBase, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const body = await readJson(serviceUrl(serviceBase, '/api/registry/stats'), fetchImpl, timeoutMs);
  const data = body.data;
  if (!object(data) || !Array.isArray(data.chain_stats)) throw new Error('The registry service returned invalid chain statistics. Please try again.');
  const seen = new Set();
  for (const chain of data.chain_stats) {
    if (!object(chain) || !identifier(chain.chain_id) || Number(chain.chain_id) <= 0
      || !Number.isSafeInteger(Number(chain.chain_id)) || !count(chain.total_agents)
      || seen.has(Number(chain.chain_id))) throw new Error('The registry service returned invalid chain statistics. Please try again.');
    seen.add(Number(chain.chain_id));
  }
  if (data.total_agents !== undefined && !count(data.total_agents)) throw new Error('The registry service returned an invalid agent count. Please try again.');
  return data;
}
