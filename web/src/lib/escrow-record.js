import { formatU } from './erc8183.js';

/*
  Turning an escrow census answer into words, kept out of the component so the
  rules below are testable rather than inspectable.

  Every rule here exists because the obvious rendering breaks one of this
  project's own: a success percentage with no denominator, a range we did not
  read printed as a zero, or an outage of ours printed as a fact about an
  agent. The component draws what this returns and adds nothing of its own.
*/

const KINDS = { unavailable: 'unavailable', absent: 'absent', present: 'present' };

export function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/*
  How much of the escrow the answer covers. "all 56,720 jobs on the kernel" and
  "the newest 800 jobs" are different claims about the same six jobs, and only
  the census knows which one it earned — so the sentence is built from the
  range it actually reached, never from the range it was asked for.
*/
export function coverageScope(range) {
  if (!range?.jobs) return null;
  const jobs = Number(range.jobs).toLocaleString('en-GB');
  return range.whole ? `all ${jobs} jobs on the kernel` : `the newest ${jobs} jobs`;
}

export function coverageSentence(range) {
  const scope = coverageScope(range);
  if (!scope) return null;
  const read = fmtDate(range.asOf);
  return `${scope}${read ? ` · read ${read}` : ''}`;
}

/*
  The counts, in the order a buyer cares about them, with every zero left out
  rather than printed. A bucket that did not happen is not information; a row
  of zeroes next to one real number is how "no data" gets read as "bad".

  What is deliberately NOT here is a rate. Chain-wide only about a third of
  jobs on this contract reach `completed` — the rest sit open, funded or
  submitted at any moment — so any percentage would score a provider for jobs
  the buyer never funded. The counts carry their own denominator instead.
*/
export function recordParts(record) {
  if (!record) return [];
  const parts = [];
  if (record.released) parts.push(`${record.released} escrow released`);
  if (record.expired) parts.push(`${record.expired} expired`);
  if (record.rejected) parts.push(`${record.rejected} rejected`);
  if (record.inflight) parts.push(`${record.inflight} in flight`);
  // Still open on the contract, but past the expiry its own buyer set. Neither
  // live work nor a resolved job: folding it into either would flatter or
  // punish the provider for something the buyer did not do.
  if (record.lapsed) parts.push(`${record.lapsed} past expiry`);
  return parts;
}

/*
  What was actually released to the wallet, or null when nothing was.

  Null rather than "0.0 $U" because a released job can carry a zero budget —
  10 of the first 61 releases we read did — so a zero here means "this work
  was unpaid", which the absence says without dressing it as an amount.
*/
export function earnedClause(earnedWei) {
  if (earnedWei == null) return null;
  const raw = String(earnedWei);
  if (!/^[0-9]+$/.test(raw) || raw === '0') return null;
  const formatted = formatU(raw);
  return formatted === '—' ? null : formatted;
}

/**
 * The whole answer, as the three states a reader must be able to tell apart.
 * `kind` decides the sentence; nothing outside this function may invent one.
 */
export function describeRecord(result) {
  if (!result || !result.available) {
    return {
      kind: KINDS.unavailable,
      // Ours, and said as ours. A deployment with no census knows nothing
      // about this agent, which is not the same as knowing it has no jobs.
      note: 'No escrow census has been collected on this deployment, so nothing is known here about work done through the escrow contract. That is a gap in ours, not a finding about this agent.',
      coverage: null,
      parts: [],
      earned: null,
    };
  }
  const coverage = coverageSentence(result.range);
  if (!result.found) {
    // Scope without the read date inside the sentence: "in all 56,720 jobs on
    // the kernel, read 8 Sept" is a sentence, "in all 56,720 jobs · read 8
    // Sept." is a caption wearing a full stop.
    const scope = coverageScope(result.range);
    const read = fmtDate(result.range?.asOf);
    return {
      kind: KINDS.absent,
      note: `No jobs against this wallet in ${scope ?? 'the range we scanned'}${read ? `, read ${read}` : ''}. Absent from the range is not the same as never hired — it is the whole of what we looked at.`,
      coverage,
      parts: [],
      earned: null,
    };
  }
  return {
    kind: KINDS.present,
    note: null,
    coverage,
    jobs: result.record?.jobs ?? 0,
    parts: recordParts(result.record),
    earned: earnedClause(result.record?.earnedWei),
    // Non-zero means the census could not read some ids, so every count above
    // is a floor. The page has to say so where the counts are, not in a
    // footnote a reader reaches after quoting them.
    unread: Number(result.range?.unread ?? 0),
  };
}

export const RECORD_KINDS = KINDS;
