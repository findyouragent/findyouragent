import { config } from '../config.js';

/**
 * BAP-578, BNB Chain's Non-Fungible Agent standard.
 *
 * An ERC-8004 registration says an identity exists. A BAP-578 token says the
 * agent is a programmable NFT with a logic contract behind it, and on some
 * implementations it records its own work on-chain. That is a different and
 * stronger kind of fact than anything a card can assert, so agents that have it
 * are worth showing differently.
 *
 * Detection is by INTERFACE, never by address. There are at least twelve
 * BAP-578 collections on BSC and hardcoding one would make this a vendor check
 * wearing a standard's name. Two of the largest are behind proxies, so the
 * implementation has to be resolved before its bytecode means anything: read
 * the proxy directly and every one of them looks non-compliant.
 */

// EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// Function selectors, first 4 bytes of keccak256 of each signature.
const SELECTORS = {
  getState: '44c9af28', // getState(uint256)
  fundAgent: 'ef03c6db', // fundAgent(uint256)
  setLogicAddress: '4590ae21', // setLogicAddress(uint256,address)
  executeAction: 'd137e242', // executeAction(uint256,string,bytes)
};

const GET_STATE = `0x${SELECTORS.getState}`;
// getMetrics(uint256) on the LOGIC contract, not the collection.
const GET_METRICS = '0x9a8e4495';
// getActivePositions(uint256) — implemented ONLY by the position-tracking
// (Hunter-class) logic; Trading, CTO and Deployer lack it and revert. Its
// presence is the structural tell that this logic's getMetrics returns a REAL
// lifetimePnL and activePositions rather than the hardcoded int256(0)/0 the
// other versions return. Detected by calling it (proxy-transparent, key-free),
// not by a logic-address allowlist that would go stale on the next deployment.
const GET_ACTIVE_POSITIONS = '0x8908471a';

let rpcId = 9000;

/**
 * An RPC failure that is OURS, not theirs.
 *
 * A public BSC node throttling us and a contract reverting arrive at the same
 * catch block, and everything downstream publishes a sentence about somebody
 * else's contract. Being rate limited must never be rendered as "this logic
 * version does not report metrics": that is a claim about a third party's code,
 * sourced from our own quota.
 */
function transportError(message) {
  const err = new Error(message);
  err.transport = true;
  return err;
}

// -32005 is the usual "limit exceeded"; nodes are inconsistent enough about it
// that the message is worth matching too.
const THROTTLED = /rate.?limit|too many|limit exceeded|capacity|429|timeout|try again/i;

async function rpc(method, params) {
  let res;
  try {
    res = await fetch(config.bscRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    });
  } catch (err) {
    // DNS, connection reset, or our own abort timer. Nothing was learned about
    // the contract at all.
    throw transportError(`bsc rpc unreachable (${err?.name || err?.message || 'network'})`);
  }
  if (!res.ok) throw transportError(`bsc rpc http ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw transportError('bsc rpc returned a non-JSON body');
  }
  if (body.error) {
    const message = String(body.error.message ?? 'rpc error');
    if (body.error.code === -32005 || THROTTLED.test(message)) throw transportError(message);
    // A genuine node-level answer: reverted, bad params, no such method. This
    // one IS evidence about the contract.
    throw new Error(message);
  }
  return body.result;
}

const pad = (v) => String(v).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const toBigInt = (w) => BigInt(`0x${w}`);
const toAddress = (w) => `0x${w.slice(24)}`;

/**
 * On-chain registrars that hold the AUTHORITATIVE mapping from a BAP-578 token
 * to the ERC-8004 registration it was minted alongside.
 *
 * This is the only forgery-proof link between the two identities. On BSC, BORT
 * ERC-8004 registrations and BAP-578 tokens use separate custodial owners, so
 * `ownerOf` cannot distinguish a real pairing from a claim. Only the registrar's
 * own record, written atomically at mint, can. The attacker cannot change what
 * MintGate stored for a token they do not control.
 *
 * Keyed by BAP-578 collection so other collections' registrars are a data
 * addition, and absent here means "no authoritative link, do not attribute".
 */
const BAP_REGISTRARS = {
  // BORT BAP-578 collection -> MintGate.bap578To8004(uint256) => agent8004Id
  '0x15b15df2ffff6653c21c11b93fb8a7718ce854ce': {
    registrar: '0x97e8f3B4BFfC1982B2791B21609c3B2542c5eB50',
    selector: '0x97eaea47', // bap578To8004(uint256)
  },
};

// key -> boolean. The mapping is set once at mint and never changes, so a hit
// is permanent; a miss (RPC failure) is not cached, so a transient outage
// hides a legit agent's metrics for one check rather than forever.
const ownershipCache = new Map();

/**
 * Is a card-claimed BAP-578 token REALLY this ERC-8004 agent's, by on-chain
 * record rather than by the card's say-so?
 *
 * The card names its own BAP-578 token, and everything read off that token
 * (balance, trades, PnL, its 3D skin) is then published as this agent's. Both
 * the token id and the "proof" url are authored by the party being assessed,
 * so the old subject check was circular: an agent could claim a well-known
 * agent's token and wear its history and skin. This asks the registrar that
 * minted the pair, which the attacker does not control.
 *
 * TRI-STATE, and the distinction is the whole point:
 *   true   the registrar's record ties this token to this agent.
 *   false  the registrar's record ties it to SOMEONE ELSE, or to nobody. This
 *          is a finding about the claim, and may be published as one.
 *   null   we could not ask. Our RPC was throttled, unreachable, or this
 *          collection has no registrar we know how to query.
 *
 * Collapsing null into false is how a verifier publishes an accusation sourced
 * from its own quota: "no on-chain record ties that token to this agent" is a
 * claim about a third party's chain state, and a 429 from a public node is not
 * evidence for it. Every other chain reader in this file already keeps that
 * line (`getAgentMetrics` returns `unavailable`, `getTransferables` sets
 * `checked:false`, `detectBap578` treats a failure as unknown); this one is
 * held to the same rule.
 *
 * @returns {Promise<boolean|null>}
 */
export async function verifyBapOwnership({ collection, bapTokenId, agentId }) {
  if (!collection || bapTokenId == null || agentId == null) return null;
  const reg = BAP_REGISTRARS[String(collection).toLowerCase()];
  // No registrar for this collection: not the agent's fault and not a finding.
  // We simply have no way to check, which is `null`, never `false`.
  if (!reg) return null;

  let want;
  let tokenHex;
  try {
    want = BigInt(agentId);
    tokenHex = pad(BigInt(bapTokenId).toString(16));
  } catch {
    return null; // unparseable ids: we could not form the question
  }
  const key = `${reg.registrar}:${tokenHex}`;
  if (ownershipCache.has(key)) return ownershipCache.get(key) === want.toString();

  try {
    const raw = await rpc('eth_call', [{ to: reg.registrar, data: reg.selector + tokenHex }, 'latest']);
    if (!raw || raw.length < 66) return null; // malformed answer: not an answer
    const mapped = toBigInt(word(raw, 0));
    // A token with no registration maps to 0. That IS a real answer from the
    // registrar and a genuine finding: nothing on chain claims this token.
    if (mapped === 0n) return false;
    // Only a real reading is cached, and only permanently because the mapping
    // is written once at mint and never changes.
    ownershipCache.set(key, mapped.toString());
    return mapped === want;
  } catch (err) {
    // Our transport, not their contract: unknown, and never cached.
    if (err?.transport) return null;
    // A revert is the chain answering. The registrar has no such mapping.
    return false;
  }
}

// Two's-complement signed read: lifetimePnL is an int256 and a loss read as an
// unsigned value would render as an astronomically large profit.
function toSigned(w) {
  const v = toBigInt(w);
  const MAX = 1n << 255n;
  return v >= MAX ? v - (1n << 256n) : v;
}

/**
 * The BAP-578 token an agent's card points at, if any.
 *
 * ERC-8004 and BAP-578 are different registrations with different token ids.
 * The link between them lives in the agent's own card as a `bap578` service
 * entry, so this reads the claim rather than guessing that the 8004 id doubles
 * as a BAP-578 id. It does not.
 */
export function bap578FromCard(card) {
  const services = Array.isArray(card?.services) ? card.services : [];
  const entry = services.find((s) => String(s?.name).toLowerCase() === 'bap578');
  const m = String(entry?.endpoint ?? '').match(/^eip155:(\d+):(0x[0-9a-fA-F]{40})\/(\d+)$/);
  if (!m) return null;
  return { chainId: Number(m[1]), collection: m[2], tokenId: m[3] };
}

const detectionCache = new Map();

/**
 * Does this collection implement BAP-578?
 *
 * Resolves an EIP-1967 proxy to its implementation first. Cached per address:
 * the answer is a property of deployed bytecode, and a collection is asked
 * about once per agent otherwise.
 */
export async function detectBap578(collection) {
  if (!collection) return null;
  const key = collection.toLowerCase();
  if (detectionCache.has(key)) return detectionCache.get(key);

  let result;
  try {
    let target = collection;
    let code = await rpc('eth_getCode', [collection, 'latest']);
    let viaProxy = null;

    const slot = await rpc('eth_getStorageAt', [collection, IMPL_SLOT, 'latest']).catch(() => null);
    if (slot && /[1-9a-f]/.test(slot.slice(2))) {
      viaProxy = `0x${slot.slice(-40)}`;
      target = viaProxy;
      code = await rpc('eth_getCode', [viaProxy, 'latest']);
    }

    const found = Object.entries(SELECTORS)
      .filter(([, sel]) => typeof code === 'string' && code.includes(sel))
      .map(([name]) => name);

    result = {
      // getState is the load-bearing one: it is what exposes the agent's logic
      // contract and status. A collection with only fundAgent is not something
      // we can read an agent out of.
      isBap578: found.includes('getState'),
      interfaces: found,
      implementation: viaProxy,
      collection,
    };
  } catch {
    // Unknown, not "no". A throttled RPC must never publish as a missing standard.
    result = null;
  }

  // Cache only a real reading. Caching the null cached the OUTAGE: one throttled
  // response at boot erased the BAP-578 section for every agent on that
  // collection for the life of the process, and the comment above promised the
  // opposite of what the code did.
  if (result) detectionCache.set(key, result);
  return result;
}

/**
 * The agent's on-chain state: which logic contract runs it, who owns it, and
 * whether it is live. Available on every BAP-578 collection that implements
 * getState, regardless of vendor.
 */
export async function getAgentState(collection, tokenId) {
  try {
    const raw = await rpc('eth_call', [{ to: collection, data: GET_STATE + pad(BigInt(tokenId).toString(16)) }, 'latest']);
    if (!raw || raw.length < 2 + 64 * 5) return null;
    return {
      balance: toBigInt(word(raw, 0)).toString(),
      status: Number(toBigInt(word(raw, 1))),
      owner: toAddress(word(raw, 2)),
      logicAddress: toAddress(word(raw, 3)),
      lastActionAt: Number(toBigInt(word(raw, 4))),
    };
  } catch {
    return null;
  }
}

// ERC-6551 registry and the account implementations agents are deployed under.
// Mirrors verify/wallet.js: an account derived from the token is owned by
// whoever owns the token, so its contents move with a sale by construction.
const ERC6551_REGISTRY = '0x000000006551c19487814612e58FE06813775758';
const ACCOUNT_SELECTOR = '0x8a54c52f';
const SALT_ZERO = '0x'.padEnd(66, '0');
const IMPLEMENTATIONS = [
  '0x55266d75D1a14E4572138116aF39863Ed6596E7F',
  '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC',
  '0x2D25602551487C3f3354dD80D76D54383A243358',
];

/**
 * What a buyer actually receives with the token, and what they do not.
 *
 * Buying an agent is not buying a service. The split is structural rather than
 * a matter of any one project's policy, and it is the same everywhere:
 *
 *   on-chain, keyed by the TOKEN ID  moves with the token by construction. The
 *                                    collection's own balance field, and any
 *                                    ERC-6551 account derived from the token.
 *   off-chain, keyed by anything else  does not move, and cannot be verified
 *                                    from here. An agent's brain (model
 *                                    credentials, prompt, triggers) and any
 *                                    operator-side permissions usually live in
 *                                    a database keyed by the previous owner.
 *
 * So a buyer can inherit an agent's funds and its recorded history while
 * receiving something that does not run until they reconfigure it. No listing
 * anywhere says this, which is why it is worth publishing.
 */
export async function getTransferables({ collection, tokenId, state }) {
  const out = {
    // Reported by the collection itself via getState. Some implementations
    // custody funds elsewhere and leave this at zero, so it is a floor and
    // never a total.
    reportedBalanceWei: state?.balance ?? null,
    // Did the search for a token-bound account actually complete?
    //
    // Without this, `tba: null` means two irreconcilable things: we looked and
    // there is no deployed account, or the node throttled us and we never
    // looked. Only the first is publishable, and it is the one a reader assumes.
    checked: false,
    tba: null,
    tbaBalanceWei: null,
    activePositions: null,
  };

  let reachable = true;
  try {
    const tokenIdHex = pad(BigInt(tokenId).toString(16));
    for (const implementation of IMPLEMENTATIONS) {
      const data = ACCOUNT_SELECTOR
        + pad(implementation)
        + SALT_ZERO.slice(2)
        + pad((56).toString(16))
        + pad(collection)
        + tokenIdHex;
      let result;
      try {
        result = await rpc('eth_call', [{ to: ERC6551_REGISTRY, data }, 'latest']);
      } catch (err) {
        // A transport failure ends the search: the remaining implementations
        // would fail the same way, and reporting "none" after one 429 is the
        // false negative this flag exists to prevent.
        if (err?.transport) { reachable = false; break; }
        continue;
      }
      if (!result || result.length < 66) continue;
      const derived = `0x${result.slice(-40)}`;
      let code = '0x';
      try {
        code = await rpc('eth_getCode', [derived, 'latest']);
      } catch (err) {
        if (err?.transport) { reachable = false; break; }
      }
      // Only report an account that has actually been deployed. A derived
      // address with no bytecode is a prediction, not an asset.
      if (code && code !== '0x') {
        // The account is real whether or not its balance read succeeds, so a
        // failed balance leaves a null number beside a confirmed address.
        const bal = await rpc('eth_getBalance', [derived, 'latest']).catch(() => null);
        out.tba = derived;
        out.tbaBalanceWei = bal ? BigInt(bal).toString() : null;
        break;
      }
    }
  } catch {
    reachable = false;
  }

  out.checked = reachable;
  return out;
}

/**
 * Whether this logic version records real positions and realized P&L on-chain,
 * or hardcodes them. Only the Hunter-class logic implements
 * getActivePositions(uint256); Trading, CTO and Deployer revert on it. So a
 * successful call means getMetrics' lifetimePnLWei and activePositions are
 * genuine readings — a 0 is a true break-even / flat book — while a revert
 * means they are placeholders and this agent's P&L lives off-chain.
 *
 * Tri-state on purpose: null when we could not ask, so a throttled node never
 * downgrades a Hunter agent to "reports no P&L". Detected by calling the
 * function, which is proxy-transparent and survives new logic deployments,
 * rather than by a logic-address allowlist that would silently go stale.
 *
 * @returns {Promise<boolean|null>}
 */
async function logicReportsRealMetrics(logicAddress, tokenId) {
  if (!logicAddress || /^0x0{40}$/i.test(logicAddress)) return false;
  let data;
  try {
    data = GET_ACTIVE_POSITIONS + pad(BigInt(tokenId).toString(16));
  } catch {
    // Could not even form the call (a non-numeric tokenId). That is our
    // inability to ask, not a fact about the contract, so it is null under this
    // file's tri-state discipline — never a false "does not track positions".
    return null;
  }
  try {
    const raw = await rpc('eth_call', [{ to: logicAddress, data }, 'latest']);
    // Implemented → returns an ABI dynamic array, at minimum its 32-byte offset
    // word. Not implemented → the node reverts, handled in catch.
    return typeof raw === 'string' && raw.length >= 2 + 64;
  } catch (err) {
    // transport = our quota, not their contract: we do not know. A genuine
    // revert = the function is absent = this logic does not track positions.
    return err?.transport ? null : false;
  }
}

/**
 * Work the agent has recorded on-chain, read from its LOGIC contract.
 *
 * Not every logic version implements this. Measured across the BORT collection,
 * 8 of 9 sampled reverted. That distinction is the whole point: a revert means
 * this logic version does not report, and zero means it reports nothing done.
 * Rendering both as "0 actions" would accuse an agent of idleness on the
 * strength of a missing function.
 *
 * @returns {Promise<{reported: true, ...counts} | {reported: false, reason: string}>}
 */
export async function getAgentMetrics(logicAddress, tokenId) {
  if (!logicAddress || /^0x0{40}$/i.test(logicAddress)) {
    return { reported: false, reason: 'this agent has no logic contract set' };
  }
  try {
    const raw = await rpc('eth_call', [{ to: logicAddress, data: GET_METRICS + pad(BigInt(tokenId).toString(16)) }, 'latest']);
    if (!raw || raw.length < 2 + 64 * 7) {
      return { reported: false, reason: 'this logic version does not report metrics' };
    }
    return {
      reported: true,
      totalActions: Number(toBigInt(word(raw, 0))),
      successfulActions: Number(toBigInt(word(raw, 1))),
      totalTrades: Number(toBigInt(word(raw, 2))),
      lifetimePnLWei: toSigned(word(raw, 3)).toString(),
      totalInteractions: Number(toBigInt(word(raw, 4))),
      lastActive: Number(toBigInt(word(raw, 5))),
      activePositions: Number(toBigInt(word(raw, 6))),
      // Whether lifetimePnLWei and activePositions above are genuine readings
      // (Hunter-class logic) or hardcoded placeholders (Trading/CTO/Deployer).
      // null = we could not determine it. Lets the UI say "P&L is off-chain for
      // this logic version" instead of hiding a 0 it cannot interpret.
      reportsRealMetrics: await logicReportsRealMetrics(logicAddress, tokenId),
    };
  } catch (err) {
    // Our quota, not their contract. Saying "does not report metrics" here
    // would publish a permanent-sounding claim about someone else's code on the
    // strength of a 429 we caused.
    if (err?.transport) {
      return { reported: false, unavailable: true, reason: 'could not reach the chain to read metrics' };
    }
    // The call reverted. On this collection that means the logic version
    // predates getMetrics, which is a fact about the contract and not about
    // whether the agent has done anything.
    return { reported: false, reason: 'this logic version does not report metrics' };
  }
}
