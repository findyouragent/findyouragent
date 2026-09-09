#!/usr/bin/env node
/**
 * End-to-end smoke check for findyouragent.
 *
 * Verifies the full user path: the registry answers, the
 * verification service reaches it, an agent's endpoint is probed for real, and
 * the try/hire surfaces are wired. Each check reports what it PROVED, not just
 * that a request returned 200, because a green tick on an empty response is
 * exactly the failure mode this is meant to catch.
 *
 *   node smoke.js                        # against localhost:8787
 *   VERIFY_BASE=https://… node smoke.js  # against a deployment
 *   node smoke.js --release              # also require a reviewed task result
 * Exit 0: all required checks passed; 1: failures; 2: required evidence missing.
 */

import { isDeepStrictEqual } from 'node:util';
import { classifyTryResult, TRY_RESULT_VERSION } from './src/try-result.js';
import { resolveTaskPreset, assessTaskResult } from './src/task-presets.js';
import { validateRegistryStats } from './src/sources/registry-contract.js';

const VERIFY_BASE = (process.env.VERIFY_BASE || 'http://localhost:8787').replace(/\/$/, '');
const RELEASE = process.argv.includes('--release');
const SEARCH_TASK = process.env.SAMPLE_SEARCH || 'liquidity';

// A known live agent to exercise the full path against. Override with
// SAMPLE_AGENT=<chainId>/<tokenId>. Defaults to a third-party BSC agent with a
// live MCP endpoint, so the try relay has something real to reach. The sample
// must be an unaffiliated endpoint so the check covers an external provider.
// The relay check below asks the agent which protocol it speaks rather
// than assuming this one, so changing the sample does not break it.
const SAMPLE_ID = process.env.SAMPLE_AGENT || '56/45650';
const [SAMPLE_CHAIN, SAMPLE_TOKEN] = SAMPLE_ID.split('/');
const SAMPLE_AGENT = { chainId: SAMPLE_CHAIN, tokenId: SAMPLE_TOKEN };

let passed = 0;
let failed = 0;
const notes = [];
const incomplete = [];

function ok(label, detail) {
  passed += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail) {
  failed += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function note(text) {
  notes.push(text);
  console.log(`  NOTE  ${text}`);
}

function missing(label, detail) {
  incomplete.push(label);
  console.log(`  INCOMPLETE  ${label} — ${detail}`);
}

function assertSearch(body) {
  if (!Array.isArray(body?.agents) || !body.agents.length || body.count !== body.agents.length) {
    throw new Error('no consistent, nonempty capability search results');
  }
  if (body.agents.some((agent) => !/^\d+$/.test(String(agent?.chain_id))
    || !/^\d+$/.test(String(agent?.token_id)) || typeof agent?.matchedTool !== 'string' || !agent.matchedTool.trim())) {
    throw new Error('search results lack registry identity or matched capability evidence');
  }
}

function assertBscRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('no BSC agent rows returned');
  if (rows.some((agent) => String(agent?.chain_id) !== '56' || !/^\d+$/.test(String(agent?.token_id)))) {
    throw new Error('registry rows do not identify numeric BSC agents');
  }
}

function assertRegistryPage(body, { page = 1, limit }) {
  if (body?.source !== '8004scan') throw new Error('registry response lacks 8004scan provenance');
  assertBscRows(body.data);
  const pagination = body.meta?.pagination;
  const offset = (page - 1) * limit;
  if (pagination?.page !== page || pagination?.limit !== limit
    || !Number.isSafeInteger(pagination?.total) || pagination.total < offset + body.data.length
    || body.data.length !== Math.min(limit, Math.max(0, pagination.total - offset))
    || typeof pagination?.hasMore !== 'boolean'
    || pagination.hasMore !== (offset + limit < pagination.total)) {
    throw new Error('registry pagination is missing or inconsistent with the requested page');
  }
  return pagination.total;
}

function registryUrl({ page = 1, limit, search, sortBy, sortOrder } = {}) {
  const query = new URLSearchParams({ chainId: '56', page: String(page), limit: String(limit) });
  for (const [name, value] of Object.entries({ search, sortBy, sortOrder })) {
    if (value !== undefined) query.set(name, value);
  }
  return `${VERIFY_BASE}/api/registry/agents?${query}`;
}

function diagnosticValue(value) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  return String(value).slice(0, 4096)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted URL]')
    .replace(/(?:\/\/|www\.)[^\s<>"']+/gi, '[redacted URL]')
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, '[redacted authorization]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[redacted authorization]')
    .replace(/\b(?:api[_ -]?key|x-api-key|password|passwd|secret|(?:access[_ -]?|refresh[_ -]?)?token|signature|credentials?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted credential]')
    .replace(/[^\s<>"']+@[^\s<>"']+/g, '[redacted credential]')
    .replace(/\s+/g, ' ').trim().slice(0, 180);
}

function interfaceDiagnostic(body) {
  const fields = {
    error: body?.error?.message ?? body?.error,
    code: body?.code ?? body?.error?.code,
    source: body?.source, phase: body?.phase, upstreamStatus: body?.upstreamStatus,
    retryable: body?.retryable, detail: body?.detail,
  };
  const summary = Object.entries(fields).map(([name, value]) => [name, diagnosticValue(value)])
    .filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join('; ');
  return summary.slice(0, 600) || 'no structured error details';
}

function assertCanonicalObservation(reply, independent, task) {
  const observed = reply.observation;
  if (!observed || observed.version !== TRY_RESULT_VERSION) {
    throw new Error('Relay observation is missing or uses an unsupported version.');
  }
  if (typeof observed.runId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(observed.runId)
    || reply.kind !== independent.protocol || observed.protocol !== independent.protocol
    || typeof reply.endpoint !== 'string' || !reply.endpoint.trim() || observed.endpoint !== reply.endpoint
    || reply.phase !== (independent.protocol === 'mcp' ? 'tools/call' : 'message/send')
    || observed.phase !== reply.phase) {
    throw new Error('Relay observation identity does not match the completed request.');
  }
  const started = typeof observed.startedAt === 'string' ? Date.parse(observed.startedAt) : NaN;
  const finished = typeof observed.finishedAt === 'string' ? Date.parse(observed.finishedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started
    || new Date(started).toISOString() !== observed.startedAt || new Date(finished).toISOString() !== observed.finishedAt
    || observed.checkedAt !== observed.finishedAt
    || !Number.isFinite(observed.latencyMs) || observed.latencyMs < 0) {
    throw new Error('Relay observation has invalid or inconsistent timestamps.');
  }
  if (observed.captureComplete !== true) throw new Error('Relay observation does not confirm full capture.');
  if (observed.outcome !== independent.outcome || observed.reason !== independent.reason
    || !isDeepStrictEqual(observed.transport, independent.transport)) {
    throw new Error('Relay observation classification disagrees with the captured response.');
  }
  if (!isDeepStrictEqual(observed.task, task)) {
    throw new Error('Relay observation task assessment disagrees with the independent checks.');
  }
}

async function getJson(url, init, timeoutMs = 30_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...init });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave null: the caller decides whether that is fatal */
  }
  const rateHeaders = Object.fromEntries([...res.headers].filter(([name]) =>
    name === 'retry-after' || /^(?:x-)?ratelimit(?:-|$)/i.test(name)));
  return { status: res.status, body, text, rateHeaders };
}

// Only explicit registry outages are incomplete. An ambiguous gateway error or
// malformed registry response must fail. Never retry a throttled read here;
// leave recovery timing to the service and report its current rate headers.
const registryUnavailable = ({ status, body }) => status === 429
  || ([502, 503, 504].includes(status) && body?.source === '8004scan'
    && ['registry-unavailable', 'registry-throttled'].includes(body?.error));

function unavailable({ status, body, rateHeaders = {} }) {
  const headers = Object.entries(rateHeaders).map(([name, value]) => `${name}=${diagnosticValue(value)}`).join(', ');
  return `${status === 429 ? 'request throttled' : body.error} (HTTP ${status}); required evidence is incomplete. No automatic retry. `
    + (headers ? `Current rate/retry headers: ${headers}. Respect Retry-After before rerunning.`
      : 'No rate-limit or retry headers were returned; check upstream availability before rerunning.');
}

async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    fail(label, String(err.message || err));
  }
}

async function main() {
  if (!/^56\/\d+$/.test(SAMPLE_ID)) throw new Error('SAMPLE_AGENT must identify a BSC agent as 56/<numeric tokenId>.');
  console.log(`\nfindyouragent smoke check\n  verify service: ${VERIFY_BASE}\n`);

  console.log('registry (8004scan through the FYA adapter):');
  let registryThrottled = false;

  await check('registry reachable', async () => {
    const result = await getJson(registryUrl({ limit: 3 }));
    const { status, body } = result;
    if (registryUnavailable(result)) {
      registryThrottled = true;
      missing('registry reachable', unavailable(result));
      return;
    }
    if (status === 404) throw new Error('FYA registry routes are missing (HTTP 404). Update or restart the backend configured in the frontend.');
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const total = assertRegistryPage(body, { limit: 3 });
    if (!Number.isFinite(total) || total < 1000) throw new Error(`implausible agent count: ${total}`);
    ok('registry reachable', `${body.data.length} rows, ${total.toLocaleString()} BSC agents indexed`);
  });

  await check('registry statistics', async () => {
    const result = await getJson(`${VERIFY_BASE}/api/registry/stats`);
    if (registryUnavailable(result)) {
      missing('registry statistics', unavailable(result));
      return;
    }
    if (result.status === 404) throw new Error('FYA registry statistics route is missing (HTTP 404). Update or restart the configured backend.');
    if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
    if (result.body?.source !== '8004scan') throw new Error('registry statistics lack 8004scan provenance');
    const stats = validateRegistryStats(result.body.data);
    const bsc = stats.chain_stats.find((chain) => chain.chain_id === 56);
    if (!bsc) throw new Error('registry statistics omit the requested BSC inventory');
    ok('registry statistics', `${bsc.total_agents.toLocaleString()} BSC agents indexed`);
  });

  await check('each configured category returns search results', async () => {
    if (registryThrottled) {
      missing('registry category search', 'registry read unavailable; further registry queries skipped');
      return;
    }
    // These are TEXT matches on name and description, not proof of capability:
    // searching "rebalance" on BSC returns trading agents whose blurb says
    // "Liquidity Bloom". Do not quote these numbers as category inventory.
    // Real placement is decided per agent from declared skills (categorize.js).
    const terms = ['grid', 'rebalance', 'yield', 'liquidation'];
    const counts = [];
    for (const term of terms) {
      const result = await getJson(registryUrl({ search: term, limit: 1 }));
      const { status, body } = result;
      if (registryUnavailable(result)) {
        registryThrottled = true;
        missing('registry category search', `stopped at "${term}": ${unavailable(result)}`);
        return;
      }
      if (status !== 200) throw new Error(`HTTP ${status} for category search`);
      const total = assertRegistryPage(body, { limit: 1 });
      if (total === 0) throw new Error(`no search results at all for "${term}"`);
      counts.push(`${term}:${total}`);
      await new Promise((r) => setTimeout(r, 1200));
    }
    ok('each configured category returns search results', `${counts.join(' ')} (text matches, not verified capability)`);
  });

  console.log('\nverification service:');
  await check('service healthy', async () => {
    const { status, body } = await getJson(`${VERIFY_BASE}/health`);
    if (status !== 200 || !body?.ok) throw new Error(`HTTP ${status}`);
    ok('service healthy', `formula v${body.formulaVersion}, sweep queued ${body.sweep?.queued ?? 0}`);
  });

  await check('verdict carries evidence', async () => {
    const result = await getJson(`${VERIFY_BASE}/api/verify/${SAMPLE_AGENT.chainId}/${SAMPLE_AGENT.tokenId}`);
    const { status, body } = result;
    if (registryUnavailable(result)) {
      registryThrottled = true;
      missing('verdict carries evidence', unavailable(result));
      return;
    }
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (!body?.tier) throw new Error('no tier in verdict');
    const ev = body.evidence || {};
    // A verdict with no evidence object is the failure this project exists to
    // prevent: a score nobody can check.
    for (const key of ['endpoint', 'wallet', 'bazaar', 'registry']) {
      if (!(key in ev)) throw new Error(`evidence missing "${key}"`);
    }
    ok('verdict carries evidence', `${body.name || 'agent'} = ${body.tier}, ${body.proofs?.length ?? 0} proof(s)`);

    if (ev.endpoint?.reachable || ev.mcp?.reachable) {
      const endpoint = ev.endpoint?.reachable ? ev.endpoint : ev.mcp;
      ok('agent endpoint answered during verification', `${ev.endpoint?.reachable ? 'A2A' : 'MCP'} in ${endpoint.latencyMs ?? 'unknown'}ms`);
    } else {
      missing('sample endpoint observation', ev.endpoint?.reason || 'Neither A2A nor MCP answered during verification.');
    }
    if (ev.wallet?.agentsOwned > 1) {
      note(`agent wallet owns ${ev.wallet.agentsOwned} agents, so wallet activity is discounted (shared-wallet rule).`);
    }
  });

  await check('nameplate is not overclaimed', async () => {
    // A mass-minted registration with no endpoint must not earn a live tier.
    if (registryThrottled) {
      missing('nameplate check', 'registry read unavailable; further registry queries skipped');
      return;
    }
    const listResult = await getJson(registryUrl({ limit: 5, sortBy: 'created_at', sortOrder: 'desc' }));
    const { status: listStatus, body: list } = listResult;
    if (registryUnavailable(listResult)) {
      missing('nameplate check', unavailable(listResult));
      return;
    }
    if (listStatus !== 200) throw new Error(`HTTP ${listStatus} for nameplate list`);
    assertRegistryPage(list, { limit: 5 });
    const candidate = (list?.data ?? []).find((a) => (a.supported_protocols ?? []).length === 0)
      || (list?.data ?? [])[0];
    if (!candidate) throw new Error('no candidate agent');
    const result = await getJson(`${VERIFY_BASE}/api/verify/56/${candidate.token_id}`);
    const { status, body } = result;
    if (registryUnavailable(result)) {
      missing('nameplate check', unavailable(result));
      return;
    }
    // A verdict that never arrived proves nothing. Asserting only "it is not
    // verified_live" would pass on an error response, which is the exact
    // false-green this file exists to catch.
    if (status !== 200 || !body?.tier) throw new Error(`no verdict returned (HTTP ${status}: ${body?.detail || body?.error || 'empty'})`);
    if (body.tier === 'verified_live' && !body.endpointProven) {
      throw new Error('tier claims live without a proven endpoint');
    }
    ok('nameplate is not overclaimed', `#${candidate.token_id} = ${body.tier}`);
  });

  await check('history accumulates', async () => {
    const { status, body } = await getJson(`${VERIFY_BASE}/api/history/${SAMPLE_AGENT.chainId}/${SAMPLE_AGENT.tokenId}`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (!Array.isArray(body?.checks) || !body.checks.length) throw new Error('no stored checks for the sample agent');
    ok('history accumulates', `${body.checks.length} check(s) on record`);
  });

  await check('summary counts real checks', async () => {
    const { status, body } = await getJson(`${VERIFY_BASE}/api/summary`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    if (!Number.isSafeInteger(body?.checksRun) || body.checksRun <= 0
      || !Number.isSafeInteger(body?.uniqueChecked) || body.uniqueChecked <= 0) throw new Error('no positive, valid check counts');
    ok('summary counts real checks', `${body.checksRun} run, ${body.uniqueChecked} unique, live=${body.tiers?.verified_live ?? 0}`);
  });

  await check('capability search returns usable agents', async () => {
    const { status, body } = await getJson(`${VERIFY_BASE}/api/search?q=${encodeURIComponent(SEARCH_TASK)}`);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    assertSearch(body);
    ok('capability search returns usable agents', `${body.count} stored matches for "${SEARCH_TASK}"`);
  });

  await check('marketplace MCP search returns usable agents', async () => {
    const { status, body } = await getJson(`${VERIFY_BASE}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_agents', arguments: { task: SEARCH_TASK, limit: 3 } } }),
    });
    const observed = classifyTryResult({ protocol: 'mcp', httpStatus: status, body });
    if (observed.outcome !== 'response_received') throw new Error(`MCP search returned ${observed.outcome}: ${observed.reason}`);
    const part = body.result.content?.find((entry) => entry.type === 'text');
    const result = JSON.parse(part?.text ?? 'null');
    assertSearch(result);
    ok('marketplace MCP search returns usable agents', `${result.count} stored matches`);
  });

  console.log('\naction layer:');
  await check('agent metadata resolves', async () => {
    const result = await getJson(`${VERIFY_BASE}/api/agent-meta/${SAMPLE_AGENT.chainId}/${SAMPLE_AGENT.tokenId}`);
    const { status, body } = result;
    if (registryUnavailable(result)) {
      missing('agent metadata resolves', unavailable(result));
      return;
    }
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const services = body?.meta?.services;
    if (!Array.isArray(services)) throw new Error('no services array in metadata');
    const names = services.map((s) => s.name).join(', ');
    ok('agent metadata resolves', `services: ${names}`);
    if (!services.some((s) => String(s.name).toLowerCase() === 'erc8183')) {
      note('sample agent advertises no erc8183 service, so the hire panel stays hidden for it.');
    }
  });

  await check('try relay reaches the agent', async () => {
    /*
      Ask the agent which protocol it speaks before speaking one at it.

      The relay carries both kinds and the panel in the app already branches on
      this, but here the prose `message` was hardcoded — an A2A body. The
      default sample is an MCP agent, so the relay refused it with "agent has no
      valid A2A endpoint" and the smoke run reported a FAIL for the relay being
      RIGHT. The failing half was the question, not the answer.

      For MCP the call is a read-only tool that takes no arguments: enough to
      prove the relay reaches the agent and gets a JSON-RPC answer back, without
      asking a stranger's agent to do work on our behalf.
    */
    // Allow the service's 30s interface budget and 90s whole-Try budget to
    // finish and return their own diagnostics. Each request is sent once.
    const iface = await getJson(`${VERIFY_BASE}/api/try/${SAMPLE_AGENT.chainId}/${SAMPLE_AGENT.tokenId}/interface`, undefined, 35_000);
    if (iface.status !== 200) throw new Error(`interface HTTP ${iface.status}: ${interfaceDiagnostic(iface.body)}`);

    let payload;
    let preset = null;
    if (RELEASE) {
      const advertised = iface.body?.taskPresets?.find((entry) => entry.available === true);
      preset = advertised && resolveTaskPreset({ ...SAMPLE_AGENT, presetId: advertised.id, tools: iface.body.tools });
      if (!preset || iface.body.kind !== 'mcp') {
        missing('reviewed task result', 'No compatible reviewed read-only task for this sample. Choose a supported SAMPLE_AGENT.');
        return;
      }
      payload = { presetId: preset.id };
    } else if (iface.body?.kind === 'mcp') {
      const tools = Array.isArray(iface.body.tools) ? iface.body.tools : [];
      const free = tools.find((t) => t.readOnly && Object.keys(t.inputSchema?.properties ?? {}).length === 0);
      if (!free) {
        missing('try relay result', `No read-only argument-free tool among ${tools.length} tools; relay not exercised.`);
        return;
      }
      payload = { tool: free.name, arguments: {} };
    } else if (iface.body?.kind === 'a2a') {
      payload = { message: 'smoke check: what can you do?' };
    } else {
      missing('try relay result', `No try interface (kind: ${iface.body?.kind ?? 'none'}).`);
      return;
    }

    const { status, body } = await getJson(`${VERIFY_BASE}/api/try/${SAMPLE_AGENT.chainId}/${SAMPLE_AGENT.tokenId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, 95_000);
    if (status !== 200 && status !== 402) throw new Error(`HTTP ${status}`);
    if (status === 402) {
      missing('try relay result', 'Payment requested; no payment was made and no task output was obtained.');
      return;
    }
    if (body?.error) throw new Error(`relay failed: ${body.error}`);
    const observed = classifyTryResult({ protocol: iface.body.kind, httpStatus: body?.upstreamStatus ?? body?.status,
      body: body?.body, captureComplete: body?.captureComplete, phase: body?.phase });
    if (['payment_required', 'pending'].includes(observed.outcome)) {
      missing('try relay result', `${observed.outcome}; no terminal task output was obtained.`);
      return;
    }
    if (!['response_received', 'deliverable_received'].includes(observed.outcome)) {
      throw new Error(`upstream ${observed.outcome}: ${observed.reason}`);
    }
    if (body.captureComplete !== true) throw new Error('The full task response was not captured.');
    let task = observed.task;
    if (preset) {
      task = assessTaskResult(preset, observed, body.body);
      if (task.status !== 'passed') throw new Error(`reviewed task checks ${task.status}`);
      const returned = body.taskPreset;
      if (returned?.id !== preset.id || returned?.version !== preset.version || returned?.tool !== preset.tool
        || !isDeepStrictEqual(returned?.args, preset.args)) throw new Error('Relay returned different preset inputs.');
    }
    assertCanonicalObservation(body, observed, task);
    if (preset) {
      ok('reviewed task result', `${preset.title}; requested scope and fields passed, market truth not independently verified`);
    }
    ok('try relay returns terminal output', `${iface.body.kind.toUpperCase()} via ${body.endpoint}`);
  });

  await check('bad input is rejected', async () => {
    const { status } = await getJson(`${VERIFY_BASE}/api/verify/56/notanumber`);
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
    ok('bad input is rejected', '400 on a non-numeric tokenId');
  });

  console.log(`\n${passed} passed, ${failed} failed, ${incomplete.length} incomplete${notes.length ? `, ${notes.length} note(s)` : ''}`);
  if (notes.length) {
    console.log('\nnotes are expected states, not failures:');
    notes.forEach((n) => console.log(`  · ${n}`));
  }
  console.log(failed ? 'Smoke checks failed.' : incomplete.length
    ? 'Smoke checks incomplete; missing evidence must be resolved before release.'
    : 'Smoke checks passed. This does not verify wallet execution or complete category coverage.');
  process.exit(failed > 0 ? 1 : incomplete.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error('smoke check crashed:', err);
  process.exit(1);
});
