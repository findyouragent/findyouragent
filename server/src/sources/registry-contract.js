const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const SORTS = new Set(['created_at', 'stars', 'name', 'token_id', 'total_score', 'quality_score', 'popularity_score',
  'activity_score', 'validation_score', 'wallet_score', 'freshness_score', 'metadata_completeness_score',
  'total_feedbacks', 'average_score', 'total_validations']);

export function registryContractError(message) {
  return Object.assign(new Error(`8004scan invalid response: ${message}`), { source: '8004scan', code: 'registry-invalid-response', malformed: true });
}

function badInput(message) {
  throw Object.assign(new Error(`Invalid registry request: ${message}`), { status: 400 });
}

export function registryIdentity(chainId, tokenId) {
  const chain = String(chainId);
  const token = String(tokenId);
  if (!/^[1-9]\d*$/.test(chain) || !integer(Number(chain), 1)) badInput('chain ID must be a positive integer');
  if (!/^(0|[1-9]\d{0,77})$/.test(token)
    || (typeof tokenId === 'number' && !integer(tokenId)) || BigInt(token) > (1n << 256n) - 1n) badInput('token ID must be an exact unsigned integer');
  return { chainId: Number(chain), tokenId: token };
}

export function validateRegistryAgent(agent, { chainId, tokenId, ownerAddress } = {}) {
  if (!object(agent) || !integer(agent.chain_id, 1) || typeof agent.token_id !== 'string'
    || !/^(0|[1-9]\d{0,77})$/.test(agent.token_id)
    || BigInt(agent.token_id) > (1n << 256n) - 1n) throw registryContractError('missing numeric agent identity');
  if (chainId !== undefined && agent.chain_id !== Number(chainId)) throw registryContractError('wrong chain');
  if (tokenId !== undefined && agent.token_id !== String(tokenId)) throw registryContractError('wrong token ID');
  if (ownerAddress !== undefined && (typeof agent.owner_address !== 'string'
    || agent.owner_address.toLowerCase() !== ownerAddress.toLowerCase())) throw registryContractError('wrong owner');
  for (const field of ['name', 'description', 'image_url', 'agent_wallet', 'owner_address', 'contract_address']) {
    if (agent[field] != null && typeof agent[field] !== 'string') throw registryContractError(`invalid ${field}`);
  }
  if (agent.supported_protocols != null && (!Array.isArray(agent.supported_protocols)
    || agent.supported_protocols.some((protocol) => typeof protocol !== 'string'))) throw registryContractError('invalid protocols');
  if (agent.total_score != null && (typeof agent.total_score !== 'number' || !Number.isFinite(agent.total_score))) throw registryContractError('invalid registry score');
  if (agent.total_feedbacks != null && !integer(agent.total_feedbacks)) throw registryContractError('invalid feedback count');
  if (agent.services != null && !object(agent.services)) throw registryContractError('invalid services');
  // Preserve endpoint, wallet and registration metadata verbatim; missing
  // fields are not invented from other addresses or registration claims.
  return agent;
}

function supplied(params, camel, snake) {
  if (params[camel] !== undefined && params[snake] !== undefined && String(params[camel]) !== String(params[snake])) badInput(`conflicting ${camel}`);
  return params[camel] ?? params[snake];
}

export function registryPageRequest(params = {}, { semantic = false } = {}) {
  if (!object(params)) badInput('parameters must be an object');
  const allowed = new Set(['page', 'limit', 'chainId', 'chain_id', 'sortBy', 'sort_by', 'sortOrder', 'sort_order',
    'search', 'q', 'query', 'ownerAddress', 'owner_address', 'isActive', 'is_active', 'isRegistered', 'is_registered']);
  for (const field of Object.keys(params)) if (!allowed.has(field)) badInput(`unsupported parameter ${field}`);
  const number = (value, fallback) => value === undefined ? fallback : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const page = number(params.page, 1);
  const limit = number(params.limit, 25);
  if (!integer(page, 1) || !integer(limit, 1) || limit > 100
    || !integer((page - 1) * limit) || !integer(page * limit)) badInput('invalid page or limit');
  const offset = (page - 1) * limit;
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const requestedChain = supplied(params, 'chainId', 'chain_id');
  let chainId;
  if (requestedChain !== undefined) {
    chainId = registryIdentity(requestedChain, '0').chainId;
    query.set('chain_id', String(chainId));
  }
  const isActive = supplied(params, 'isActive', 'is_active') ?? 'any';
  if (!['true', 'false', 'any'].includes(String(isActive))) badInput('invalid active filter');
  query.set('is_active', String(isActive));
  let ownerAddress;
  if (semantic) {
    const text = supplied(params, 'query', 'q');
    if (typeof text !== 'string' || !text.trim() || text.length > 500) badInput('semantic query must contain 1–500 characters');
    query.set('q', text.trim());
    for (const field of ['search', 'ownerAddress', 'owner_address', 'isRegistered', 'is_registered', 'sortBy', 'sort_by', 'sortOrder', 'sort_order']) {
      if (params[field] !== undefined) badInput(`${field} is not supported for semantic search`);
    }
  } else {
    if (params.q !== undefined || params.query !== undefined) badInput('use search for keyword listing');
    const sortBy = supplied(params, 'sortBy', 'sort_by') ?? 'created_at';
    const sortOrder = supplied(params, 'sortOrder', 'sort_order') ?? 'desc';
    if (!SORTS.has(sortBy) || !['asc', 'desc'].includes(sortOrder)) badInput('unsupported sorting');
    query.set('sort_by', sortBy);
    query.set('sort_order', sortOrder);
    if (params.search !== undefined && params.search !== '') {
      if (typeof params.search !== 'string' || !params.search.trim() || params.search.length > 200) badInput('search must contain 1–200 characters');
      query.set('search', params.search.trim());
    }
    const registered = supplied(params, 'isRegistered', 'is_registered') ?? 'any';
    if (!['true', 'false', 'any'].includes(String(registered))) badInput('invalid registered filter');
    query.set('is_registered', String(registered));
    ownerAddress = supplied(params, 'ownerAddress', 'owner_address');
    if (ownerAddress !== undefined) {
      if (typeof ownerAddress !== 'string' || !/^0x[\da-fA-F]{40}$/.test(ownerAddress)) badInput('owner must be an EVM address');
      ownerAddress = ownerAddress.toLowerCase();
      query.set('owner_address', ownerAddress);
    }
  }
  query.sort();
  return { page, limit, offset, chainId, ownerAddress, path: `${semantic ? '/agents/search/semantic' : '/agents'}?${query}` };
}

export function normalizeRegistryPage(body, request) {
  if (!object(body) || !Array.isArray(body.items) || !integer(body.total) || !integer(body.limit, 1)
    || !integer(body.offset) || body.limit !== request.limit || body.offset !== request.offset) throw registryContractError('invalid or mismatched pagination');
  const expectedLength = Math.min(body.limit, Math.max(0, body.total - body.offset));
  if (body.items.length !== expectedLength) throw registryContractError('inconsistent page length and total');
  const seen = new Set();
  const rows = body.items.map((agent) => {
    validateRegistryAgent(agent, request);
    const identity = `${agent.chain_id}:${agent.token_id}`;
    if (seen.has(identity)) throw registryContractError('duplicate agent identity');
    seen.add(identity);
    return agent;
  });
  return { data: rows, meta: { pagination: {
    page: request.page, limit: request.limit, total: body.total, hasMore: body.offset + rows.length < body.total,
  } } };
}

export function validateRegistryStats(body) {
  if (!object(body) || !integer(body.total_agents) || !Array.isArray(body.chain_stats)) throw registryContractError('invalid global stats');
  const seen = new Set();
  for (const chain of body.chain_stats) {
    if (!object(chain) || !integer(chain.chain_id, 1) || !integer(chain.total_agents) || seen.has(chain.chain_id)) throw registryContractError('invalid chain stats');
    seen.add(chain.chain_id);
  }
  return body;
}
