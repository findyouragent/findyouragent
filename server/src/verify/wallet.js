import { config } from '../config.js';

/**
 * Which wallet actually belongs to an agent.
 *
 * The registry records the address that REGISTERED an agent, which for any
 * platform that mints on its users' behalf is the platform itself. Judging an
 * agent by that address measures the wrong thing twice over: its activity is not the agent's, and
 * the shared-wallet discount then punishes the agent for its minter's habits.
 *
 * Most agents also DECLARE a wallet in their own card. That claim cannot be
 * taken at face value, or an agent could name a busy exchange wallet and
 * inherit its history. But when the agent is an NFT, ERC-6551 gives a wallet
 * address that is DERIVED from the token itself: registry.account(impl, salt,
 * chainId, collection, tokenId) is deterministic, so a claim can be checked
 * rather than trusted. If the declared wallet is exactly the address the
 * agent's own token derives to, it is the agent's, provably.
 *
 * Anything else stays "claimed" and earns nothing.
 */

const ERC6551_REGISTRY = '0x000000006551c19487814612e58FE06813775758';
const SALT_ZERO = '0x'.padEnd(66, '0');

// account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
const ACCOUNT_SELECTOR = '0x8a54c52f';

// Known ERC-6551 account implementations. A claim is verified if ANY of these
// derives the declared address, which keeps this honest across projects
// instead of hardcoding one platform's setup.
const IMPLEMENTATIONS = [
  '0x55266d75D1a14E4572138116aF39863Ed6596E7F', // tokenbound AccountProxy
  '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC', // tokenbound AccountV3
  '0x2D25602551487C3f3354dD80D76D54383A243358', // tokenbound v0.3.1
];

let rpcId = 5000;

function pad(hexNoPrefix) {
  return hexNoPrefix.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

async function ethCall(to, data) {
  const res = await fetch(config.bscRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(config.probeTimeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** Parse a CAIP-10 / CAIP-19 style value into its chain id, address and token id. */
export function parseCaip(value) {
  const raw = String(value ?? '');
  const m = raw.match(/^eip155:(\d+):(0x[0-9a-fA-F]{40})(?:\/(\d+))?$/);
  if (!m) return null;
  return { chainId: Number(m[1]), address: m[2].toLowerCase(), tokenId: m[3] ?? null };
}

/**
 * Read an agent's own wallet claim and the token it says it is.
 * @param {object} card  the agent's metadata card
 */
export function walletClaimFromCard(card) {
  const services = Array.isArray(card?.services) ? card.services : [];
  const wallet = parseCaip(services.find((s) => String(s?.name) === 'agentWallet')?.endpoint);
  const token = parseCaip(services.find((s) => String(s?.name) === 'bap578')?.endpoint);
  if (!wallet) return null;
  return { wallet: wallet.address, collection: token?.address ?? null, tokenId: token?.tokenId ?? null };
}

/**
 * Does the card that ANSWERED actually describe this agent?
 *
 * A reachable endpoint proves something is serving. It does not prove the thing
 * serving is the agent you asked about. A shared fleet endpoint returns a valid,
 * healthy card describing the service as a whole, and every agent pointing at it
 * inherits that card's apparent liveness and its skill list.
 *
 * That matters most exactly where it is least obvious: scope the comparison to
 * the endpoint's own declared capabilities and a fleet card matches itself
 * perfectly, scoring full coverage for an agent it never mentions. Subject
 * identity is what separates "this url works" from "this url is this agent".
 *
 * Two accepted proofs, cheapest first:
 *   path     the url the card was fetched from, or the url it advertises,
 *            addresses this token specifically
 *   wallet   the card names an agentWallet that derives from this token via
 *            ERC-6551 (one chain read, only when the path check is unavailable)
 *
 * @returns {Promise<{ verified: boolean, how: string }>}
 */
export async function verifyCardSubject({ endpoint, tokenId, attributedBapTokenId = null }) {
  if (!endpoint?.hasAgentCard) return { verified: false, how: 'no card was served' };

  // An agent has more than one id. Its ERC-8004 registration and its BAP-578
  // token are different numbers on different contracts, and a per-agent card is
  // usually addressed by the BAP-578 one.
  //
  // BOTH accepted ids must be ones the party being assessed cannot choose to
  // suit the url. The ERC-8004 route id is the identity being verified. The
  // BAP-578 id is admitted ONLY when it has been confirmed on-chain to be this
  // agent's (`attributedBapTokenId`, from the registrar mapping): the previous
  // version took it straight from the card, so an agent could put a foreign
  // token's id in its own url and have that url "prove" the claim. Circular,
  // and the exact impersonation the hard bar exists to stop.
  const ids = new Set([String(tokenId)]);
  if (attributedBapTokenId != null) ids.add(String(attributedBapTokenId));

  // A bare token id can collide with a port or a version, so require it to sit
  // in a path segment rather than matching it anywhere in the string.
  const addressesToken = (value) => {
    if (typeof value !== 'string' || !value) return false;
    try {
      return new URL(value).pathname.split('/').filter(Boolean).some((seg) => ids.has(seg));
    } catch {
      return false;
    }
  };

  if (addressesToken(endpoint.probedUrl)) {
    return { verified: true, how: 'the card was served from a url addressing this agent' };
  }
  if (addressesToken(endpoint.cardUrl)) {
    return { verified: true, how: 'the card advertises a url addressing this agent' };
  }

  // The wallet-derivation proof was removed with the same defect: an ERC-6551
  // account is DETERMINISTIC from (collection, tokenId), so anyone can compute
  // and declare the token-bound account of a token they do not own. Matching it
  // proved arithmetic, not ownership. On-chain attribution now carries that
  // weight, upstream, where it cannot be faked.
  return { verified: false, how: 'the served card could not be shown to be this agent\'s own' };
}

/**
 * Prove (or fail to prove) that a declared wallet is the agent's own, by
 * deriving the ERC-6551 account for its token and comparing.
 *
 * @returns {Promise<{verified: boolean, wallet: string, how: string}>}
 */
export async function verifyWalletClaim(claim) {
  if (!claim?.wallet) return { verified: false, wallet: null, how: 'no wallet declared' };
  if (!claim.collection || claim.tokenId == null) {
    return { verified: false, wallet: claim.wallet, how: 'declared, but the card does not say which token it belongs to' };
  }

  const tokenIdHex = pad(BigInt(claim.tokenId).toString(16));
  for (const implementation of IMPLEMENTATIONS) {
    try {
      const data = ACCOUNT_SELECTOR
        + pad(implementation)
        + SALT_ZERO.slice(2)
        + pad((56).toString(16))
        + pad(claim.collection)
        + tokenIdHex;
      const result = await ethCall(ERC6551_REGISTRY, data);
      if (!result || result.length < 66) continue;
      const derived = `0x${result.slice(-40)}`.toLowerCase();
      if (derived === claim.wallet.toLowerCase()) {
        return { verified: true, wallet: claim.wallet, how: 'derived from the agent token via ERC-6551' };
      }
    } catch {
      // try the next implementation
    }
  }
  return { verified: false, wallet: claim.wallet, how: 'declared, but it is not this token\'s ERC-6551 account' };
}
