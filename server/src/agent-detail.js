import { getAgentDetail } from './sources/scan8004.js';
import { registryFailure } from './registry.js';

// A fixed registry lookup, using the same keyed cache and in-flight request as
// verification and Try. No caller-controlled host or URL is accepted.
export function createAgentDetailHandler(readDetail = getAgentDetail) {
  return async (req, res) => {
    const { chainId, tokenId } = req.params;
    if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
      return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
    }
    try {
      const detail = await readDetail(chainId, tokenId);
      if (detail == null) return res.status(404).json({ error: 'agent-not-found', source: '8004scan' });
      if (typeof detail !== 'object' || Array.isArray(detail)
        || String(detail.chain_id) !== chainId || String(detail.token_id) !== tokenId) {
        return registryFailure(res, { code: 'registry-invalid-response' });
      }
      return res.json({ data: detail, source: '8004scan' });
    } catch (err) {
      if (err?.status === 404) return res.status(404).json({ error: 'agent-not-found', source: '8004scan' });
      return registryFailure(res, err);
    }
  };
}
