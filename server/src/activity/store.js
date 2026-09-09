import fs from 'node:fs';
import {
  createBoundedJsonl, PersistenceError, positiveInteger, replayJsonl,
} from '../persistence/bounded-jsonl.js';

const PER_WALLET_CAP = 500;
const MIB = 1024 * 1024;

/**
 * Bounded activity storage. Retain the newest 500 unique transactions per
 * wallet and every merged coverage interval. Once global identity/row bounds
 * are reached, new durable state is rejected visibly; existing wallets and
 * coverage are never silently evicted.
 */
export function createActivityStore(filePath, {
  maxFileBytes: maxFileBytesOption,
  compactAtBytes: compactAtBytesOption,
  maxReplayBytes: maxReplayBytesOption,
  maxWallets: maxWalletsOption,
  maxTransactions: maxTransactionsOption,
  maxCoverageIntervals: maxCoverageOption,
  persistenceFs = fs,
} = {}) {
  const maxFileBytes = positiveInteger(maxFileBytesOption ?? process.env.FYA_ACTIVITY_MAX_BYTES,
    256 * MIB, 'FYA_ACTIVITY_MAX_BYTES');
  const compactAtBytes = positiveInteger(compactAtBytesOption ?? process.env.FYA_ACTIVITY_COMPACT_BYTES,
    Math.min(192 * MIB, maxFileBytes), 'FYA_ACTIVITY_COMPACT_BYTES');
  const maxReplayBytes = positiveInteger(maxReplayBytesOption ?? process.env.FYA_ACTIVITY_REPLAY_BYTES,
    maxFileBytes, 'FYA_ACTIVITY_REPLAY_BYTES');
  const maxWallets = positiveInteger(maxWalletsOption ?? process.env.FYA_ACTIVITY_MAX_WALLETS,
    25_000, 'FYA_ACTIVITY_MAX_WALLETS');
  const maxTransactions = positiveInteger(maxTransactionsOption ?? process.env.FYA_ACTIVITY_MAX_TRANSACTIONS,
    250_000, 'FYA_ACTIVITY_MAX_TRANSACTIONS');
  const maxCoverageIntervals = positiveInteger(maxCoverageOption ?? process.env.FYA_ACTIVITY_MAX_COVERAGE_INTERVALS,
    250_000, 'FYA_ACTIVITY_MAX_COVERAGE_INTERVALS');
  if (compactAtBytes > maxFileBytes) {
    throw new PersistenceError('FYA_ACTIVITY_COMPACT_BYTES cannot exceed FYA_ACTIVITY_MAX_BYTES', {
      code: 'PERSISTENCE_CONFIG',
    });
  }
  if (maxReplayBytes < maxFileBytes) {
    throw new PersistenceError('FYA_ACTIVITY_REPLAY_BYTES cannot be smaller than FYA_ACTIVITY_MAX_BYTES', {
      code: 'PERSISTENCE_CONFIG',
    });
  }

  const txByWallet = new Map();
  const coverageByWallet = new Map();
  const knownWallets = new Set();
  let transactionCount = 0;
  let coverageCount = 0;

  const replay = replayJsonl(filePath, {
    maxBytes: maxReplayBytes,
    maxLineBytes: 64 * 1024,
    fsImpl: persistenceFs,
    onRecord: (row) => {
      if (row?.t === 'tx') applyTx(row);
      else if (row?.t === 'cov') applyCoverage(row.wallet, row.fromBlock, row.toBlock);
      else throw new PersistenceError(`Unsupported activity persistence row type: ${String(row?.t)}`, {
        code: 'PERSISTENCE_SCHEMA',
      });
    },
  });
  if (walletCount() > maxWallets || transactionCount > maxTransactions || coverageCount > maxCoverageIntervals) {
    throw new PersistenceError('Retained activity state exceeds configured identity/row limits', {
      code: 'PERSISTENCE_CAPACITY',
    });
  }

  const persistence = createBoundedJsonl(filePath, {
    maxBytes: maxFileBytes, compactAtBytes, maxLineBytes: 64 * 1024, fsImpl: persistenceFs,
  });

  function walletCount() {
    return knownWallets.size;
  }

  function assertWalletCapacity(wallet) {
    if (txByWallet.has(wallet) || coverageByWallet.has(wallet) || walletCount() < maxWallets) return;
    throw new PersistenceError(`Activity wallet limit (${maxWallets}) reached`, { code: 'PERSISTENCE_CAPACITY' });
  }

  function applyTx(row, { enforceLimits = true } = {}) {
    if (!row?.wallet || !row.id) throw new Error('invalid transaction activity row');
    if (enforceLimits) assertWalletCapacity(row.wallet);
    knownWallets.add(row.wallet);
    let records = txByWallet.get(row.wallet);
    if (!records) { records = new Map(); txByWallet.set(row.wallet, records); }
    const held = records.get(row.id);
    const heldBlock = Number(held?.block ?? 0);
    const nextBlock = Number(row.block ?? 0);
    if (held) {
      if (nextBlock < heldBlock) return false;
      if (nextBlock === heldBlock && String(row.ts ?? '') < String(held.ts ?? '')) return false;
      if (JSON.stringify(held) === JSON.stringify(row)) return false;
    }
    if (!held) transactionCount += 1;
    records.set(row.id, row);
    if (records.size > PER_WALLET_CAP) {
      const oldest = [...records.entries()].sort((a, b) => compareTransactions(a[1], b[1]));
      const remove = records.size - PER_WALLET_CAP;
      for (let index = 0; index < remove; index += 1) records.delete(oldest[index][0]);
      transactionCount -= remove;
    }
    if (enforceLimits && transactionCount > maxTransactions) {
      throw new PersistenceError(`Activity transaction limit (${maxTransactions}) reached`, {
        code: 'PERSISTENCE_CAPACITY',
      });
    }
    return true;
  }

  function applyCoverage(wallet, from, to, { enforceLimits = true } = {}) {
    if (!wallet || !Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new Error('invalid coverage activity row');
    }
    if (enforceLimits) assertWalletCapacity(wallet);
    knownWallets.add(wallet);
    const previous = coverageByWallet.get(wallet) ?? [];
    const merged = mergeIntervals([...previous, [from, to]]);
    if (sameIntervals(previous, merged)) return false;
    coverageCount += merged.length - previous.length;
    if (enforceLimits && coverageCount > maxCoverageIntervals) {
      throw new PersistenceError(`Activity coverage limit (${maxCoverageIntervals}) reached`, {
        code: 'PERSISTENCE_CAPACITY',
      });
    }
    coverageByWallet.set(wallet, merged);
    return true;
  }

  function* checkpointRows() {
    for (const wallet of [...coverageByWallet.keys()].sort()) {
      for (const [fromBlock, toBlock] of coverageByWallet.get(wallet)) {
        yield { t: 'cov', wallet, fromBlock, toBlock, ts: '' };
      }
    }
    for (const wallet of [...txByWallet.keys()].sort()) {
      for (const row of [...txByWallet.get(wallet).values()].sort(compareTransactions)) yield row;
    }
  }

  function recordTransfers(rows) {
    if (!Array.isArray(rows)) throw new TypeError('transfer rows must be an array');
    const touched = new Map();
    const priorCount = transactionCount;
    const accepted = [];
    try {
      for (const row of rows) {
        if (!touched.has(row?.wallet)) {
          touched.set(row?.wallet, txByWallet.has(row?.wallet) ? new Map(txByWallet.get(row.wallet)) : undefined);
        }
        if (applyTx(row)) accepted.push(row);
      }
      if (!accepted.length) return { written: 0, compacted: false };
      return persistence.append(accepted, checkpointRows);
    } catch (error) {
      transactionCount = priorCount;
      for (const [wallet, prior] of touched) restoreMapValue(txByWallet, wallet, prior);
      for (const wallet of touched.keys()) {
        if (!txByWallet.has(wallet) && !coverageByWallet.has(wallet)) knownWallets.delete(wallet);
      }
      throw error;
    }
  }

  function recordCoverage(wallet, fromBlock, toBlock, ts) {
    const prior = coverageByWallet.has(wallet) ? coverageByWallet.get(wallet).map((entry) => [...entry]) : undefined;
    const priorCount = coverageCount;
    try {
      if (!applyCoverage(wallet, fromBlock, toBlock)) return { written: 0, compacted: false };
      return persistence.append([{ t: 'cov', wallet, fromBlock, toBlock, ts }], checkpointRows);
    } catch (error) {
      coverageCount = priorCount;
      restoreMapValue(coverageByWallet, wallet, prior);
      if (!txByWallet.has(wallet) && !coverageByWallet.has(wallet)) knownWallets.delete(wallet);
      throw error;
    }
  }

  return {
    recordTransfers, recordCoverage,
    activityFor(wallet, limit = 100) {
      const records = txByWallet.get(wallet);
      const events = records ? [...records.values()] : [];
      events.sort((a, b) => compareTransactions(b, a));
      return { events: events.slice(0, limit), coverage: coverageByWallet.get(wallet) ?? [] };
    },
    storageStatus: () => ({
      ...persistence.status(), malformedRows: replay.malformed, degraded: replay.malformed > 0,
      wallets: walletCount(), transactionCount, coverageCount,
      maxWallets, maxTransactions, maxCoverageIntervals,
    }),
  };
}

function compareTransactions(a, b) {
  return (Number(a?.block ?? 0) - Number(b?.block ?? 0))
    || String(a?.ts ?? '').localeCompare(String(b?.ts ?? ''))
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function mergeIntervals(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of intervals) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function sameIntervals(a, b) {
  return a.length === b.length && a.every((entry, index) => entry[0] === b[index][0] && entry[1] === b[index][1]);
}

function restoreMapValue(map, key, value) {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}
