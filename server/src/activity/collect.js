import * as nodereal from '../net/nodereal.js';

/**
 * Turn NodeReal nr_getAssetTransfers records into the store's tx-row shape and
 * fetch the newest window for a wallet. Origin CLASSIFICATION (framework /
 * x402 / owner) is a later stage; every row here carries class:'unclassified'
 * so the feed never implies an origin it has not yet computed.
 */

// blockTimeStamp arrives as hex, decimal seconds, or an ISO string depending on
// the record; normalise to ISO, and never let an out-of-range value throw a
// RangeError (it would take down the whole request).
function tsFromRecord(r) {
  const v = r.blockTimeStamp ?? r.blockTimestamp;
  let secs = null;
  if (typeof v === 'number') secs = v;
  else if (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v)) secs = parseInt(v, 16);
  else if (typeof v === 'string' && /^\d+$/.test(v)) secs = Number(v);
  else if (typeof v === 'string') {
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : new Date(d).toISOString();
  }
  if (secs == null || !Number.isFinite(secs)) return null;
  const ms = secs * 1000;
  if (ms <= 0 || ms > Date.now() + 86_400_000) return null; // absurd / future
  try { return new Date(ms).toISOString(); } catch { return null; }
}

// NodeReal's `amount` field is unreliable (often "0x0"); the true magnitude is
// the raw `value` (hex wei/units) scaled by decimals — 18 for BNB, `decimal`
// for ERC-20. Keep valueRaw as the exact integer string so a render can format
// at full precision, and amount as a convenience display number.
function deriveValue(r, isBnb) {
  const decimals = isBnb ? 18 : (Number(r.decimal) || 18);
  if (r.value == null) return { valueRaw: null, decimals, amount: null };
  let raw;
  try { raw = BigInt(r.value); } catch { return { valueRaw: null, decimals, amount: null }; }
  return { valueRaw: raw.toString(), decimals, amount: String(Number(raw) / 10 ** decimals) };
}

// Token symbols on inbound transfers are attacker-controlled — anyone can send
// an arbitrary or offensively-named token to the agent's wallet. React escapes
// on render, so this is not an injection sink, but strip control chars and cap
// the length so a crafted name cannot distort or dominate the row. The origin
// labels already disclaim who sent it.
function capAsset(s) {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean) return null;
  return clean.length > 32 ? `${clean.slice(0, 32)}…` : clean;
}

function normalizeTransfer(wallet, r) {
  const w = wallet.toLowerCase();
  const from = (r.from || '').toLowerCase();
  const to = (r.to || '').toLowerCase();
  const block = typeof r.blockNum === 'string' ? parseInt(r.blockNum, 16) : Number(r.blockNum);
  if (!Number.isFinite(block)) return null;
  const isBnb = r.category === 'external' || r.category === 'internal';
  return {
    t: 'tx',
    wallet: w,
    // NodeReal's per-transfer id is unique; fall back to a composite so dedup
    // still holds if a record ever lacks it.
    id: r.id || `${r.hash}:${r.logIndex ?? r.traceIndex ?? r.category}`,
    hash: r.hash,
    block,
    ts: tsFromRecord(r),
    direction: to === w ? 'in' : from === w ? 'out' : 'other',
    kind: 'transfer',
    category: r.category,
    asset: capAsset(r.asset) || (isBnb ? 'BNB' : null),
    contract: r.contractAddress || null,
    ...deriveValue(r, isBnb),
    counterparty: to === w ? from : to,
    receiptStatus: r.receiptsStatus ?? null,
    // Origin is computed in the classification stage; never asserted here.
    class: 'unclassified',
  };
}

/**
 * Newest transfer window for a wallet, both directions, normalized. Throws on
 * transport/other failure so the caller can classify sources.transfers; never
 * swallows an error into an empty (falsely "no activity") result.
 */
export async function fetchNewestWindow(wallet) {
  const latest = await nodereal.blockNumber();
  // Stay below the head: the transfer indexer lags it, and this also keeps the
  // published tail past reorg finality.
  const toBlock = Math.max(0, latest - nodereal.HEAD_LAG_BLOCKS);
  const fromBlock = Math.max(0, toBlock - nodereal.MAX_TRANSFER_WINDOW);
  const [inc, out] = await Promise.all([
    nodereal.getAssetTransfers({ toAddress: wallet, fromBlock, toBlock }),
    nodereal.getAssetTransfers({ fromAddress: wallet, fromBlock, toBlock }),
  ]);
  const rows = [];
  for (const r of [...inc.transfers, ...out.transfers]) {
    const row = normalizeTransfer(wallet, r);
    if (row) rows.push(row);
  }
  return { rows, fromBlock, toBlock };
}
