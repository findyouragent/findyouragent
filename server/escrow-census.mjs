/*
  The ERC-8183 escrow census: what the kernel says every provider actually did.

  A hire menu is a claim. This reads the other side of it — the jobs that were
  really opened against a provider address, and how each one ended — straight
  from the kernel contract, so a record on an agent page is not our bookkeeping
  and not the marketplace's. Nothing here writes to the chain.

  Why jobId walk and not eth_getLogs: the kernel's jobId is a dense counter
  (every id sampled between 55,921 and 56,720 existed), so ids ARE the index.
  Logs would need archive access and 49,999-block windows for the same facts —
  a public RPC refuses the first and charges for hundreds of the second. An
  eth_call per id needs neither, and the whole history is ~57k of them.

  Usage:
    node escrow-census.mjs                 # whole history
    node escrow-census.mjs --depth 800     # newest 800 jobs only
    node escrow-census.mjs --repair        # re-read only the ids that failed
    node escrow-census.mjs --out other.json
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KERNEL = '0xEa4DAa3100A767e86FDed867729ae7446476EBA6';
// keccak('jobs(uint256)')[0..4). Manual, like registry.js: this service carries
// no ABI library and one selector is not a reason to grow a dependency.
const JOBS_SELECTOR = '0x180aedf3';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// The public endpoints, round-robined. eth_call is cheap and unmetered here;
// what these reject is wide eth_getLogs, which is exactly what we avoid.
const RPCS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org',
];

// Contract order, and the only reason a status string may be shown to a reader.
const STATUS = ['open', 'funded', 'submitted', 'completed', 'rejected', 'expired'];

/*
  The census lands where the service reads it from. In production that is the
  mounted disk (DATA_DIR), because a snapshot written beside the source on an
  ephemeral host is gone at the next deploy — and the service would then answer
  "no census here" for every agent, which is the one wrong answer this whole
  file exists to avoid.
*/
const OUT_DEFAULT = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'escrow-census.json')
  : fileURLToPath(new URL('./data/escrow-census.json', import.meta.url));
const CHECKPOINT_EVERY = 2_000;
const CONCURRENCY = 6;

let rpcId = 90_000;
let cursor = 0;

async function ethCall(data) {
  const url = RPCS[cursor++ % RPCS.length];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'eth_call',
      params: [{ to: KERNEL, data }, 'latest'],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function word(hex, index) {
  return hex.slice(2 + index * 64, 2 + (index + 1) * 64);
}

/*
  jobs(uint256) returns one tuple holding a single dynamic member (description),
  so every field we want sits at a FIXED head word — the string is an offset in
  word 4 and shifts nothing after it:

    0 id · 1 client · 2 provider · 3 evaluator · 4 (string offset)
    5 budget · 6 expiredAt · 7 status · 8 hook · 9 slot9 · 10 deliverable

  Reading by index rather than decoding the tuple keeps this dependency-free.
  It is also why the description, the one field that could be long and hostile,
  is never parsed here at all.
*/
function decodeJob(hex) {
  if (typeof hex !== 'string' || hex.length < 2 + 11 * 64) return null;
  const client = `0x${word(hex, 1).slice(24)}`;
  if (client === ZERO_ADDR) return null; // id never used
  return {
    client,
    provider: `0x${word(hex, 2).slice(24)}`,
    budget: BigInt(`0x${word(hex, 5)}`),
    expiredAt: Number(BigInt(`0x${word(hex, 6)}`)),
    status: Number(BigInt(`0x${word(hex, 7)}`)),
  };
}

/*
  One job, or a thrown error. The distinction that matters for honesty is
  BELOW this function: `null` means the kernel answered and the id is unused,
  a throw means we could not read it. An unread id must never be folded in as
  an absent job, or a throttled scan would quietly shrink somebody's record.
*/
async function readJob(id) {
  const arg = BigInt(id).toString(16).padStart(64, '0');
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return decodeJob(await ethCall(`${JOBS_SELECTOR}${arg}`));
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error('unreadable');
}

async function idExists(id) {
  try {
    return (await readJob(id)) !== null;
  } catch {
    return false;
  }
}

/*
  The highest id the counter has reached. Exponential probe then bisect, which
  costs ~20 calls instead of a guess that would silently truncate the census.
  Monotonic because the kernel mints ids from a counter.
*/
async function findTopId(hint) {
  let lo = hint;
  while (!(await idExists(lo)) && lo > 0) lo = Math.floor(lo / 2);
  let hi = lo || 1;
  let step = 1_000;
  while (await idExists(hi + step)) {
    lo = hi + step;
    hi = lo;
    step *= 4;
  }
  hi += step;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await idExists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function emptyRow() {
  return { jobs: 0, released: 0, rejected: 0, expired: 0, inflight: 0, lapsed: 0, earned: 0n, lastJobId: 0 };
}

function fold(rows, id, job, nowSec) {
  const key = job.provider.toLowerCase();
  const row = rows.get(key) ?? emptyRow();
  const status = STATUS[job.status] ?? String(job.status);
  row.jobs += 1;
  if (status === 'completed') {
    row.released += 1;
    // Released jobs may legitimately carry a zero budget. Earned is the sum of
    // what the escrow actually held, so zero-budget jobs add nothing.
    row.earned += job.budget;
  } else if (status === 'rejected') row.rejected += 1;
  else if (status === 'expired') row.expired += 1;
  // Still open/funded/submitted. Past its own expiry it is not "in flight" in
  // any sense a reader would accept, but the kernel has not been told so; it
  // gets its own bucket rather than inflating either neighbour.
  else if (job.expiredAt > 0 && job.expiredAt < nowSec) row.lapsed += 1;
  else row.inflight += 1;
  if (id > row.lastJobId) row.lastJobId = id;
  rows.set(key, row);
}

function serialize({ rows, topId, floorId, jobsRead, idsUnread, startedAt }) {
  const providers = {};
  for (const [addr, r] of [...rows].sort((a, b) => b[1].released - a[1].released)) {
    providers[addr] = { ...r, earned: r.earned.toString() };
  }
  return {
    version: 1,
    asOf: new Date().toISOString(),
    startedAt,
    kernel: KERNEL,
    // The range this census can speak about. A provider absent from it is
    // absent from THIS RANGE, which is not the same claim as zero jobs, and
    // the reader is given the range so they can tell the two apart.
    topId,
    floorId,
    jobsRead,
    // Ids the chain would not answer for. Non-empty means the census is
    // incomplete and every count in it is a floor, not a total.
    idsUnread,
    providers,
  };
}

/*
  Second pass over the ids the chain would not answer for.

  A throttled read leaves a hole, and a hole is carried in the snapshot as
  `idsUnread` so every count reads as a floor. This pass is how a hole gets
  closed rather than described forever: re-read exactly those ids, fold the
  ones that answer this time, and leave the rest where they are.
*/
async function repair(outPath) {
  const snapshot = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const pending = Array.isArray(snapshot.idsUnread) ? [...snapshot.idsUnread] : [];
  if (!pending.length) {
    process.stdout.write('nothing to repair: no unread ids in the snapshot\n');
    return;
  }
  process.stdout.write(`re-reading ${pending.length} unread job ids…\n`);

  const rows = new Map();
  for (const [addr, r] of Object.entries(snapshot.providers)) {
    rows.set(addr, { ...r, earned: BigInt(r.earned ?? '0') });
  }
  const stillUnread = [];
  const nowSec = Math.floor(Date.now() / 1000);
  let recovered = 0;

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(readJob));
    settled.forEach((outcome, k) => {
      if (outcome.status === 'rejected') {
        stillUnread.push(batch[k]);
        return;
      }
      if (outcome.value === null) return; // answered: the id is simply unused
      recovered += 1;
      fold(rows, batch[k], outcome.value, nowSec);
    });
  }

  const merged = serialize({
    rows,
    topId: snapshot.topId,
    floorId: snapshot.floorId,
    jobsRead: (snapshot.jobsRead ?? 0) + recovered,
    idsUnread: stillUnread,
    startedAt: snapshot.startedAt ?? snapshot.asOf,
  });
  fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 1)}\n`);
  process.stdout.write(`repaired · ${recovered} jobs recovered · ${stillUnread.length} still unread\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const outPath = flag('--out', OUT_DEFAULT);
  if (args.includes('--repair')) return repair(outPath);
  const depth = Number(flag('--depth', '0'));
  const startedAt = new Date().toISOString();

  const topHint = Number(flag('--top', '0')) || 56_720;
  process.stdout.write('locating the head of the job counter…\n');
  const topId = Number(flag('--top', '0')) || (await findTopId(topHint));
  /*
    An unreachable chain makes every existence probe fail, which walks the head
    down to nothing. Refusing to continue is the point: the alternative is
    overwriting a good census with an empty one, and an empty census reads on
    every agent page as an agent with no jobs. A failed collection must stay a
    failed collection.
  */
  if (!Number.isFinite(topId) || topId < 1) {
    throw new Error('could not locate the job counter head — refusing to overwrite the census with an empty one');
  }
  const floorId = depth > 0 ? Math.max(1, topId - depth + 1) : 1;
  process.stdout.write(`census over jobIds ${floorId}..${topId} (${topId - floorId + 1} ids)\n`);

  const rows = new Map();
  const idsUnread = [];
  let jobsRead = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  for (let id = topId; id >= floorId; id -= CONCURRENCY) {
    const batch = [];
    for (let k = 0; k < CONCURRENCY && id - k >= floorId; k++) batch.push(id - k);
    const settled = await Promise.allSettled(batch.map(readJob));
    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        idsUnread.push(batch[i]);
        return;
      }
      if (outcome.value === null) return; // unused id, not a failure
      jobsRead += 1;
      fold(rows, batch[i], outcome.value, nowSec);
    });

    const done = topId - id + CONCURRENCY;
    if (done % CHECKPOINT_EVERY < CONCURRENCY) {
      // Checkpoint carries the floor REACHED so far, never the floor intended:
      // a snapshot must not describe a range it has not actually read.
      fs.writeFileSync(
        outPath,
        `${JSON.stringify(serialize({ rows, topId, floorId: Math.max(floorId, id), jobsRead, idsUnread, startedAt }), null, 1)}\n`,
      );
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `  ${done} ids · ${jobsRead} jobs · ${rows.size} providers · ${rate.toFixed(0)}/s · ${idsUnread.length} unread\n`,
      );
    }
  }

  fs.writeFileSync(outPath, `${JSON.stringify(serialize({ rows, topId, floorId, jobsRead, idsUnread, startedAt }), null, 1)}\n`);
  process.stdout.write(
    `done · ids ${floorId}..${topId} · ${jobsRead} jobs · ${rows.size} providers · ${idsUnread.length} unread · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`census failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
