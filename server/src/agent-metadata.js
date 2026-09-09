const METADATA_UNAVAILABLE = {
  error: 'metadata-unavailable',
  source: 'agent-metadata',
  retryable: true,
  detail: 'Agent metadata could not be retrieved.',
};

const validMeta = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Build the browser-facing metadata handler. A null/array metadata result is
 * an upstream retrieval failure, not a successful empty metadata document.
 */
export function createAgentMetadataHandler({
  cache,
  getAgentDetail,
  getAgentMetadata,
  mediaFromRegistration,
  mediaFromMeta,
  bap578FromCard,
  registryFailure,
}) {
  // The same agent can have several browser consumers. Share a fresh read,
  // including its media lookup, instead of multiplying RPC/IPFS requests.
  const inFlight = new Map();
  async function load(chainId, tokenId, key) {
    const detail = await getAgentDetail(chainId, tokenId);
    if (!detail?.contract_address) return { status: 404, body: { error: 'agent not found' } };
    const result = await getAgentMetadata(detail.contract_address, tokenId);
    if (!validMeta(result?.meta)) return { status: 502, body: METADATA_UNAVAILABLE };

    // Registration media is self-authored; token media is only decoration
    // from the claimed BAP-578 token and must not affect registry evidence.
    let media = null;
    try {
      media = await mediaFromRegistration(result.meta);
    } catch {
      media = null;
    }
    const bap = media ? null : bap578FromCard(result.meta);
    if (bap) {
      try {
        const token = await getAgentMetadata(bap.collection, bap.tokenId);
        media = mediaFromMeta(token.meta);
      } catch {
        media = null;
      }
    }
    const payload = { ...result, media };
    cache.set(key, payload);
    return { status: 200, body: payload };
  }

  return async function agentMetadata(req, res) {
    res.set('Cache-Control', 'no-store');
    const { chainId, tokenId } = req.params;
    if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
      return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
    }
    const key = `meta:${chainId}:${tokenId}`;
    // A failed explicit refresh must not restore an old hire menu on the
    // next request. Only a successfully retrieved document repopulates it.
    if (req.query?.refresh === '1') cache.delete(key);
    let pending = inFlight.get(key);
    if (!pending) {
      const cached = cache.get(key);
      if (cached && validMeta(cached.meta)) return res.json(cached);
      if (inFlight.size >= 256) return res.status(502).json(METADATA_UNAVAILABLE);
      pending = load(chainId, tokenId, key);
      inFlight.set(key, pending);
    }
    try {
      const result = await pending;
      return res.status(result.status).json(result.body);
    } catch (err) {
      if (err?.source === '8004scan') return registryFailure(res, err);
      return res.status(502).json(METADATA_UNAVAILABLE);
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  };
}
