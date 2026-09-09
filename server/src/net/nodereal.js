import { config } from '../config.js';

/**
 * NodeReal MegaNode enhanced-API client — the data spine for the activity feed.
 *
 * Every call goes to config.bscRpcUrl, the operator's keyed endpoint. No
 * attacker-influenced value ever selects the host, so this shares the
 * SSRF-safe posture of the other chain readers and does NOT need safeFetch
 * (which is reserved for agent-authored URLs). Addresses and block numbers are
 * interpolated only as JSON *values* of the request body, never the URL.
 *
 * The enhanced methods (nr_getAssetTransfers) exist only on a NodeReal
 * endpoint. When the configured RPC is something else, isConfigured() is false
 * and callers must render an "activity feed not enabled on this deployment"
 * state — never an error and never an empty feed that reads as "no activity".
 *
 * Failures are tri-state, matching bap578.js: a throttle or network error is
 * transport (our quota, we do not know), a genuine node error is a fact. A
 * caller must never turn a transport failure into a published claim.
 */

// -32005 is the usual CU/rate limit; messages vary enough to match too.
const THROTTLED = /rate.?limit|too many|limit exceeded|capacity|429|timeout|try again/i;

// Compute-unit cost per method (NodeReal pricing), so a collector can budget
// against the 300 CU/s and 100M CU/month free-tier caps rather than guess.
const CU = {
  nr_getAssetTransfers: 250,
  nr_getTokenHoldings: 300,
  eth_getLogs: 50,
  eth_blockNumber: 5,
  default: 25,
};

// nr_getAssetTransfers scans at most 100k blocks per call (NodeReal cap); a
// wider window is silently truncated (returns without error), so a caller
// reconstructing history MUST step in <=100k windows or it will miss transfers
// and call the gap "no activity". Value is a range delta: fromBlock = toBlock -
// MAX_TRANSFER_WINDOW stays within the cap.
export const MAX_TRANSFER_WINDOW = 100_000;
// eth_getLogs rejects a range of 50000 outright ("exceed maximum block range:
// 50000"), so the largest ACCEPTED range delta is 49_999. Unlike transfers,
// this one errors rather than truncating — still, keep windows within it.
export const MAX_LOG_WINDOW = 49_999;
// The nr_getAssetTransfers indexer lags the chain head, so asking for toBlock =
// head fails "blockNum not reached". Staying this far below the head clears the
// lag AND gives a reorg-finality margin, so a reorged tail is never published.
export const HEAD_LAG_BLOCKS = 64;

let rpcId = 20_000;
let cuSpent = 0;

function transportError(message) {
  const err = new Error(message);
  err.transport = true;
  return err;
}

function hexBlock(b) {
  if (typeof b === 'number') return `0x${Math.max(0, Math.floor(b)).toString(16)}`;
  return b; // already a tag ('latest'/'finalized') or a 0x string
}

/** Whether the configured RPC is a NodeReal endpoint (enhanced methods live). */
export function isConfigured() {
  return /nodereal\.io/i.test(config.bscRpcUrl || '');
}

/** Compute units spent this process — for the collector's budget gate. */
export function cuUsed() {
  return cuSpent;
}

async function call(method, params) {
  cuSpent += CU[method] ?? CU.default;
  let res;
  try {
    res = await fetch(config.bscRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    });
  } catch (err) {
    throw transportError(`nodereal unreachable (${err?.name || err?.message || 'network'})`);
  }
  if (!res.ok) throw transportError(`nodereal http ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw transportError('nodereal returned a non-JSON body');
  }
  if (body.error) {
    const message = String(body.error.message ?? 'rpc error');
    if (body.error.code === -32005 || THROTTLED.test(message)) throw transportError(message);
    throw new Error(message);
  }
  return body.result;
}

export async function blockNumber() {
  return Number(BigInt(await call('eth_blockNumber', [])));
}

/**
 * One nr_getAssetTransfers call, one direction. Categories default to the
 * asset-moving set a feed needs — BNB (external), internal (graduation /
 * contract-moved BNB), and ERC-20. Returns { transfers, pageKey }; a non-null
 * pageKey means the window has more rows to drain before it is fully covered.
 *
 * fromBlock/toBlock accept numbers or 0x strings. Order defaults to newest
 * first so a bounded maxCount returns the most recent rows, not the oldest.
 */
export async function getAssetTransfers({
  fromAddress, toAddress, category = ['external', 'internal', '20'],
  fromBlock, toBlock, maxCount = '0x3e8', pageKey, order = 'desc',
}) {
  const filter = {
    category,
    fromBlock: hexBlock(fromBlock),
    toBlock: hexBlock(toBlock),
    maxCount,
    order,
  };
  if (fromAddress) filter.fromAddress = fromAddress;
  if (toAddress) filter.toAddress = toAddress;
  if (pageKey) filter.pageKey = pageKey;
  const result = await call('nr_getAssetTransfers', [filter]);
  return { transfers: result?.transfers ?? [], pageKey: result?.pageKey ?? null };
}

/** eth_getLogs over a bounded range (caller keeps ranges <= MAX_LOG_WINDOW). */
export async function getLogs({ address, topics, fromBlock, toBlock }) {
  const filter = { fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock) };
  if (address) filter.address = address;
  if (topics) filter.topics = topics;
  return call('eth_getLogs', [filter]);
}
