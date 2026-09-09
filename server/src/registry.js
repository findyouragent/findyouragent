import { getAgentPage, searchAgentPage, getRegistryStats } from './sources/scan8004.js';

function badInput(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid-registry-query' });
}

function integer(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw badInput(`${name} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw badInput(`${name} is outside the supported range.`);
  return number;
}

function text(value, maximum, name) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum) throw badInput(`${name} must be text of at most ${maximum} characters.`);
  return value.trim();
}

export function registryParams(query = {}, semantic = false) {
  const allowed = new Set(semantic ? ['chainId', 'page', 'limit', 'q'] : ['chainId', 'page', 'limit', 'search', 'sortBy', 'sortOrder']);
  if (Object.keys(query).some((name) => !allowed.has(name))) throw badInput('Unsupported registry query parameter.');
  if (query.chainId !== undefined && query.chainId !== '56') throw badInput('This marketplace lists BSC agents (chainId 56).');
  const params = { chainId: 56, page: integer(query.page, 1, Number.MAX_SAFE_INTEGER, 'page'), limit: integer(query.limit, 25, 100, 'limit') };
  const offset = (params.page - 1) * params.limit;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + params.limit)) {
    throw badInput('page and limit must produce an exact supported offset.');
  }
  if (semantic) {
    params.q = text(query.q, 500, 'q');
    if (!params.q) throw badInput('q is required.');
  } else {
    params.search = text(query.search, 200, 'search');
    params.sortBy = query.sortBy ?? 'created_at';
    params.sortOrder = query.sortOrder ?? 'desc';
    if (!['created_at', 'total_score'].includes(params.sortBy)) throw badInput('Unsupported registry ordering.');
    if (!['asc', 'desc'].includes(params.sortOrder)) throw badInput('Unsupported registry sort direction.');
  }
  return params;
}

export function registryFailure(res, error) {
  if (error?.code === 'invalid-registry-query') return res.status(400).json({ error: 'invalid-registry-query', detail: error.message });
  const limited = error?.rateLimited || error?.status === 429;
  const invalid = error?.code === 'registry-invalid-response' || error?.name === 'RegistryContractError';
  if (limited) res.set('retry-after', String(Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? Math.min(error.retryAfterSeconds, 86400) : 60));
  return res.status(limited ? 503 : 502).json({
    error: limited ? 'registry-throttled' : invalid ? 'registry-invalid-response' : 'registry-unavailable',
    source: '8004scan', upstreamStatus: Number.isInteger(error?.status) ? error.status : null,
    retryable: !invalid,
  });
}

// Fixed upstream functions only. Callers cannot supply a host, path, API key,
// inventory filter or account address through this browser-facing adapter.
export function createRegistryHandlers(readers = { getAgentPage, searchAgentPage, getRegistryStats }) {
  return {
    list: async (req, res) => {
      try { return res.json({ ...await readers.getAgentPage(registryParams(req.query)), source: '8004scan' }); }
      catch (error) { return registryFailure(res, error); }
    },
    search: async (req, res) => {
      try { return res.json({ ...await readers.searchAgentPage(registryParams(req.query, true)), source: '8004scan' }); }
      catch (error) { return registryFailure(res, error); }
    },
    stats: async (req, res) => {
      try {
        if (Object.keys(req.query ?? {}).length) throw badInput('Statistics do not accept query parameters.');
        return res.json({ data: await readers.getRegistryStats(), source: '8004scan' });
      } catch (error) { return registryFailure(res, error); }
    },
  };
}
