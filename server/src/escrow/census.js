/*
  Reader for the ERC-8183 escrow census that `escrow-census.mjs` writes.

  The snapshot is a file, not a live chain read, and that shapes the whole
  contract of this module: every answer carries the id range it was true for.
  Three states a caller must be able to tell apart, because collapsing any two
  of them would put a claim on an agent page that the chain never made:

    unavailable  no census has been collected on this deployment
    absent       the range was read and this address is not in it
    present      the address worked jobs, here they are

  "Absent" is not zero jobs. It is zero jobs IN THIS RANGE, and the range
  travels with it so a reader can see how much of the escrow that covers.
*/
import fs from 'node:fs';

export function createEscrowCensus(filePath) {
  let cached = null;
  let cachedMtimeMs = 0;

  /*
    Re-read when the file changes, so a fresh census lands without a restart —
    the collector runs for a quarter of an hour and this service is not
    restarted for it. A stat per lookup is cheap next to the request it serves.
  */
  function load() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cached = null;
      cachedMtimeMs = 0;
      return null;
    }
    if (cached && stat.mtimeMs === cachedMtimeMs) return cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed.providers !== 'object') return null;
      cached = parsed;
      cachedMtimeMs = stat.mtimeMs;
      return cached;
    } catch {
      // A half-written checkpoint parses as nothing. Serving the previous good
      // snapshot is right; serving an empty one would read as "no jobs".
      return cached;
    }
  }

  function range(snapshot) {
    return {
      topId: snapshot.topId ?? null,
      floorId: snapshot.floorId ?? null,
      jobs: snapshot.jobsRead ?? 0,
      asOf: snapshot.asOf ?? null,
      kernel: snapshot.kernel ?? null,
      // Whole history, or a window of the newest jobs? The reader is owed the
      // difference: "6 of all 56,720 jobs" and "6 of the newest 800" are
      // different sentences about the same six jobs.
      whole: (snapshot.floorId ?? 0) <= 1,
      // Ids the chain would not answer for. Any at all and every count below
      // is a floor rather than a total, and the page must say so.
      unread: Array.isArray(snapshot.idsUnread) ? snapshot.idsUnread.length : 0,
    };
  }

  return {
    available() {
      return load() !== null;
    },

    range() {
      const snapshot = load();
      return snapshot ? range(snapshot) : null;
    },

    /** One provider address, or `absent` with the range that was searched. */
    lookup(address) {
      const snapshot = load();
      if (!snapshot) return { available: false, found: false, record: null, range: null };
      const row = snapshot.providers[String(address).toLowerCase()] ?? null;
      if (!row) return { available: true, found: false, record: null, range: range(snapshot) };
      return {
        available: true,
        found: true,
        record: {
          jobs: row.jobs ?? 0,
          released: row.released ?? 0,
          rejected: row.rejected ?? 0,
          expired: row.expired ?? 0,
          inflight: row.inflight ?? 0,
          lapsed: row.lapsed ?? 0,
          // Wei, as a decimal string. Formatting belongs next to the token on
          // the client; a float here would lose the last digits of 18-decimal
          // amounts before anyone could read them.
          earnedWei: String(row.earned ?? '0'),
          lastJobId: row.lastJobId ?? null,
        },
        range: range(snapshot),
      };
    },

    /** Providers with at least one released job, best first. */
    top(limit = 20) {
      const snapshot = load();
      if (!snapshot) return { available: false, rows: [], range: null };
      const rows = Object.entries(snapshot.providers)
        .filter(([, r]) => (r.released ?? 0) > 0)
        .sort((a, b) => (b[1].released ?? 0) - (a[1].released ?? 0))
        .slice(0, Math.max(1, Math.min(100, limit)))
        .map(([address, r]) => ({
          address,
          jobs: r.jobs ?? 0,
          released: r.released ?? 0,
          earnedWei: String(r.earned ?? '0'),
        }));
      return { available: true, rows, range: range(snapshot), providers: Object.keys(snapshot.providers).length };
    },
  };
}
