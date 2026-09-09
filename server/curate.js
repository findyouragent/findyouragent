#!/usr/bin/env node
/**
 * Curation scout.
 *
 * Finds real candidates for the curated pin list: for each category it pulls
 * agents from the registry, runs them through our own verification service,
 * and reports which ones actually answer. Pinning is an editorial claim that
 * an agent does what its category says, so it has to be earned by evidence
 * rather than by a name that happens to contain the right keyword.
 *
 *   node curate.js                 # all categories
 *   node curate.js grid yield      # only these
 *   LIMIT=12 node curate.js grid   # widen the candidate pool per category
 *
 * Output is a ranked report plus a paste-ready block for web/src/data/curated.js.
 */

const VERIFY_BASE = (process.env.VERIFY_BASE || 'http://localhost:8787').replace(/\/$/, '');
const LIMIT = Number(process.env.LIMIT || 8);
const PACE_MS = Number(process.env.PACE_MS || 2500);

// The four categories the hackathon scores, plus the general buckets the site
// browses by. Search terms are what the registry actually matches on.
const CATEGORIES = {
  rebalancing: ['rebalance', 'liquidity position'],
  grid: ['grid'],
  yield: ['yield', 'apy'],
  health: ['liquidation', 'health factor'],
  trading: ['trading agent'],
  research: ['research', 'monitor'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON: caller handles */
  }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

function readFailure(label, { status, body, retryAfter }) {
  const code = ['registry-throttled', 'registry-unavailable', 'registry-invalid-response'].includes(body?.error)
    ? `, ${body.error}` : '';
  const retry = retryAfter && /^(?:\d+|[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT)$/.test(retryAfter)
    ? ` Retry-After: ${retryAfter}; respect it before rerunning.` : '';
  return new Error(`${label} failed (HTTP ${status}${code}); no complete shortlist can be produced.${retry} No automatic retry.`);
}

// Exercise the same authenticated server adapter as the marketplace. A failed
// read is never an empty candidate set, and a 429 is never retried here.
async function searchRegistry(term) {
  const query = new URLSearchParams({ chainId: '56', page: '1', search: term,
    limit: String(LIMIT), sortBy: 'total_score', sortOrder: 'desc' });
  const result = await getJson(`${VERIFY_BASE}/api/registry/agents?${query}`);
  if (result.status !== 200) throw readFailure(`Registry search for "${term}"`, result);
  const body = result.body;
  const rows = body?.data;
  const pagination = body?.meta?.pagination;
  if (body?.source !== '8004scan' || !Array.isArray(rows)
    || rows.some((agent) => String(agent?.chain_id) !== '56' || !/^\d+$/.test(String(agent?.token_id)))
    || pagination?.page !== 1 || pagination?.limit !== LIMIT
    || !Number.isSafeInteger(pagination?.total) || pagination.total < 0
    || rows.length !== Math.min(LIMIT, pagination.total)
    || pagination?.hasMore !== (rows.length < pagination.total)) {
    throw new Error(`Registry search for "${term}" returned invalid BSC rows, provenance or pagination; no complete shortlist can be produced.`);
  }
  return rows;
}

async function verify(agent) {
  const result = await getJson(`${VERIFY_BASE}/api/verify/56/${agent.token_id}`);
  if (result.status !== 200) throw readFailure(`Verification for #${agent.token_id}`, result);
  const { body } = result;
  if (typeof body?.tier !== 'string' || !body.tier) {
    throw new Error(`Verification for #${agent.token_id} returned no verdict; no complete shortlist can be produced.`);
  }
  return body;
}

function scoreOf(verdict) {
  // Rank by what a visitor actually cares about: does it answer, and is there
  // independent proof it is used.
  let score = 0;
  if (verdict.tier === 'verified_live') score += 100;
  else if (verdict.tier === 'active') score += 40;
  if (verdict.endpointProven) score += 30;
  score += (verdict.proofs?.length ?? 0) * 15;
  const skills = verdict.evidence?.endpoint?.skillsCount ?? 0;
  score += Math.min(skills, 10);
  return score;
}

async function main() {
  if (!Number.isSafeInteger(LIMIT) || LIMIT < 1 || LIMIT > 100) throw new Error('LIMIT must be an integer from 1 to 100.');
  if (!Number.isFinite(PACE_MS) || PACE_MS < 0) throw new Error('PACE_MS must be a nonnegative number.');
  const wanted = process.argv.slice(2).filter((a) => CATEGORIES[a]);
  const categories = wanted.length ? wanted : Object.keys(CATEGORIES);

  console.log(`\ncuration scout · verify service ${VERIFY_BASE}`);
  console.log(`categories: ${categories.join(', ')} · up to ${LIMIT} candidates each\n`);

  const results = {};

  for (const category of categories) {
    const seen = new Map();
    for (const term of CATEGORIES[category]) {
      for (const agent of await searchRegistry(term)) {
        if (!seen.has(agent.token_id)) seen.set(agent.token_id, agent);
      }
      await sleep(PACE_MS);
    }

    const candidates = [...seen.values()].slice(0, LIMIT);
    console.log(`${category}: ${candidates.length} candidate(s) from the registry`);

    const verdicts = [];
    for (const agent of candidates) {
      const verdict = await verify(agent);
      await sleep(PACE_MS);
      const endpoint = verdict.evidence?.endpoint;
      const detail = endpoint?.reachable
        ? `endpoint ${endpoint.status} in ${endpoint.latencyMs}ms, ${endpoint.skillsCount ?? 0} skills`
        : `endpoint ${endpoint?.reason ?? 'none'}`;
      const mark = verdict.tier === 'verified_live' ? '**' : verdict.tier === 'active' ? ' *' : '  ';
      console.log(`  ${mark}  #${agent.token_id} ${String(agent.name).slice(0, 28).padEnd(28)} ${verdict.tier.padEnd(14)} ${detail}`);
      verdicts.push({ agent, verdict, rank: scoreOf(verdict) });
    }

    results[category] = verdicts.sort((a, b) => b.rank - a.rank);
    console.log('');
  }

  // Only agents that proved an endpoint are worth pinning. A pin is an
  // editorial claim, and claiming a nameplate is what this whole project
  // exists to argue against.
  console.log('\npin-worthy (endpoint proven):\n');
  const pinnable = {};
  for (const [category, list] of Object.entries(results)) {
    const worthy = list.filter((r) => r.verdict.endpointProven);
    pinnable[category] = worthy;
    if (worthy.length === 0) {
      console.log(`  ${category}: none yet. Leave unpinned rather than pinning a nameplate.`);
      continue;
    }
    for (const { agent, verdict } of worthy) {
      console.log(`  ${category}: #${agent.token_id} ${agent.name} (${verdict.tier})`);
    }
  }

  console.log('\n--- paste into web/src/data/curated.js ---\n');
  console.log('export const CURATED = {');
  for (const category of Object.keys(CATEGORIES)) {
    const worthy = pinnable[category] ?? [];
    if (worthy.length === 0) {
      console.log(`  ${category}: [],`);
      continue;
    }
    console.log(`  ${category}: [`);
    for (const { agent, verdict } of worthy) {
      const skills = verdict.evidence?.endpoint?.skillsCount ?? 0;
      const note = `${verdict.tier}, endpoint answers${skills ? `, ${skills} skills` : ''}`;
      console.log(`    { chainId: 56, tokenId: '${agent.token_id}', note: '${String(agent.name).replace(/'/g, '')}: ${note}' },`);
    }
    console.log('  ],');
  }
  console.log('};');
}

main().catch((err) => {
  console.error('curation scout failed:', err.message || err);
  process.exit(1);
});
