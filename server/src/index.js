import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createRateLimiter } from './limit.js';
import { createCache, createMetadataCache } from './cache.js';
import { createStore, queryTokens } from './store.js';
import { createSearchControl, createSearchRouteHandler } from './search-policy.js';
import { createEscrowCensus } from './escrow/census.js';
import { createActivityStore } from './activity/store.js';
import { fetchNewestWindow } from './activity/collect.js';
import { scanFramework, FRAMEWORK_COLLECTION } from './activity/framework.js';
import { classifyFeed, CLASS_LABEL } from './activity/classify.js';
import * as nodereal from './net/nodereal.js';
import { getTransferables } from './sources/bap578.js';
import { createMemoryAnchorHandler } from './sources/memory-anchor.js';
import { createVerifier } from './verify/run.js';
import { IDENTITY_UNAVAILABLE, IDENTITY_UNAVAILABLE_MESSAGE } from './verify/identity.js';
import { createSweeper } from './sweep.js';
import { tryAgent, tryInterface } from './try.js';
import { isCurrentTryExample } from './try-result.js';
import { createAgentDetailHandler } from './agent-detail.js';
import { createRegistryHandlers, registryFailure } from './registry.js';
import { createAgentMetadataHandler } from './agent-metadata.js';
import { mediaFromMeta, mediaFromRegistration } from './sources/registry.js';
import { bap578FromCard } from './sources/bap578.js';
import { mountMachineRoutes } from './machine.js';
import { FORMULA_VERSION } from './verify/score.js';
import { createCorsMiddleware } from './cors.js';
import {
  admittedHandler, capacityResponse, createSseSender, WorkCapacityError,
} from './work-admission.js';

const app = express();
const verdictCache = createCache(config.verdictTtlMs);
const accountCache = createCache(60 * 60 * 1000);
// Service menus can change immediately after a provider republishes metadata.
const metadataCache = createMetadataCache();
// DATA_DIR points at a mounted volume in production. Without it the store lives
// beside the source, which on an ephemeral host is wiped on every deploy.
const storePath = config.dataDir
  ? path.join(config.dataDir, 'verdicts.jsonl')
  : fileURLToPath(new URL('../data/verdicts.jsonl', import.meta.url));
const store = createStore(storePath);
// Per-transaction activity lives in its OWN file so it never bloats the verdict
// store's boot replay or its headline counts.
const activityPath = config.dataDir
  ? path.join(config.dataDir, 'activity.jsonl')
  : fileURLToPath(new URL('../data/activity.jsonl', import.meta.url));
const activityStore = createActivityStore(activityPath);
// The escrow census is a SNAPSHOT this service reads and never writes: it is
// produced out of band by `escrow-census.mjs`, so a deployment without one
// answers "no census here" rather than "this agent has no jobs".
const censusPath = config.dataDir
  ? path.join(config.dataDir, 'escrow-census.json')
  : fileURLToPath(new URL('../data/escrow-census.json', import.meta.url));
const escrowCensus = createEscrowCensus(censusPath);
const activityCache = createCache(5 * 60 * 1000);
const verify = createVerifier({ verdictCache, accountCache, store });
const sweeper = createSweeper({
  verifier: verify,
  store,
  intervalMs: config.sweepIntervalMs,
  pageCycle: config.sweepPageCycle,
  pageSize: config.sweepPageSize,
  baselineSample: config.sweepBaselineSample,
});

// Behind Render/Vercel the client address arrives in x-forwarded-for. Without
// this every request looks like it came from the proxy and the rate limiter
// throttles all visitors as one.
app.set('trust proxy', 1);

app.use(express.json({ limit: '32kb' }));
// mcp-session-id and mcp-protocol-version are sent by MCP clients running in
// a browser. Without them on this list the preflight fails and the endpoint
// is reachable only from a server, which is half the point of serving it.
app.use(createCorsMiddleware(config.allowedOrigin));

const limitVerify = createRateLimiter({
  windowMs: config.rateWindowMs, max: config.verifyRateMax, name: 'verification',
});
const limitTry = createRateLimiter({
  windowMs: config.rateWindowMs, max: config.tryRateMax, name: 'agent call',
});
const limitActivity = createRateLimiter({
  windowMs: config.rateWindowMs, max: config.activityRateMax, name: 'activity',
});
// Shared by REST and MCP so switching protocols cannot bypass the process work
// budget. Search itself is synchronous, so its budget is weighted by terms.
const searchControl = createSearchControl();

app.get('/api/agents/:chainId/:tokenId', limitVerify, admittedHandler(createAgentDetailHandler()));
app.get('/api/memory/:chainId/:tokenId', limitActivity, admittedHandler(createMemoryAnchorHandler({ store })));

const limitRegistry = createRateLimiter({ windowMs: config.rateWindowMs, max: 60, name: 'registry' });
const registry = createRegistryHandlers();
app.get('/api/registry/agents', limitRegistry, admittedHandler(registry.list));
app.get('/api/registry/search', limitRegistry, admittedHandler(registry.search));
app.get('/api/registry/stats', limitRegistry, admittedHandler(registry.stats));

// The on-demand activity feed. Reads the STORED verdict for the gate (never
// 8004scan, so it cannot starve the registry budget) and spends only the
// operator's own NodeReal CU. Every non-served state is an explicit gate with
// its own honest sentence — an outage or a missing wallet must never render as
// "no activity".
function emptyActivity(gate, note, wallet = null) {
  return {
    attribution: { gate, wallet },
    coverage: { fromBlock: null, toBlock: null, intervals: 0, scannedThroughTs: null },
    events: [],
    sources: { transfers: 'unavailable', classification: 'pending' },
    note,
  };
}

app.get('/api/activity/:chainId/:tokenId', limitActivity, admittedHandler(async (req, res) => {
  const { chainId, tokenId } = req.params;
  if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
  }
  if (Number(chainId) !== 56) {
    return res.json(emptyActivity('unsupported-chain', 'We only observe BNB Chain (56).'));
  }
  const key = `${chainId}:${tokenId}`;
  const cached = activityCache.get(key);
  if (cached) return res.json({ ...cached, cached: true });

  const last = store.lastCheck(key);
  if (!last) return res.json(emptyActivity('no-verdict', 'This agent has not been verified yet, so there is no proved wallet to attach activity to.'));
  const bap = last.bap578;
  if (!bap || bap.ownershipVerified !== true) {
    return res.json(emptyActivity('no-proved-wallet', "No on-chain wallet is provably this agent's, so there is nothing a feed could honestly attribute to it."));
  }
  if (!nodereal.isConfigured()) {
    return res.json(emptyActivity('unconfigured', 'The activity feed is not enabled on this deployment.'));
  }

  // Derive the agent's token-bound wallet (deterministic from collection+tokenId).
  let derived;
  try {
    derived = await getTransferables({ collection: bap.collection, tokenId: bap.tokenId, state: null });
  } catch {
    derived = { checked: false, tba: null };
  }
  if (!derived.checked) {
    return res.json(emptyActivity('not-checked', "We could not reach the chain to locate this agent's wallet just now. This describes our check, not the agent."));
  }
  if (!derived.tba) {
    return res.json(emptyActivity('no-wallet-yet', "This agent's token-bound wallet has not been created on-chain yet, so there is nothing to read."));
  }
  const wallet = derived.tba.toLowerCase();

  // Fetch the newest window, fold transfers into the store, and scan the
  // framework contracts over the SAME window for owner-independent origin
  // evidence. A transport failure is a source status, never an empty feed.
  let transfersStatus = 'ok';
  let classification = 'not-run';
  let scanned = { fromBlock: null, toBlock: null };
  let scan = { byTx: new Map(), status: 'error' };
  try {
    const win = await fetchNewestWindow(wallet);
    scanned = { fromBlock: win.fromBlock, toBlock: win.toBlock };
    activityStore.recordTransfers(win.rows);
    activityStore.recordCoverage(wallet, win.fromBlock, win.toBlock, new Date().toISOString());
    // Framework attribution is sound only for the collection these shared
    // platform contracts serve with globally-unique tokenIds. For any other
    // collection, do not attribute framework — an empty-ok scan leaves transfers
    // as "origin not established", never a cross-collection misattribution.
    if ((bap.collection || '').toLowerCase() === FRAMEWORK_COLLECTION) {
      scan = await scanFramework(bap.tokenId, win.fromBlock, win.toBlock);
      classification = scan.status;
    } else {
      scan = { byTx: new Map(), status: 'ok' };
      classification = 'not-applicable';
    }
  } catch (err) {
    transfersStatus = err?.transport ? 'throttled' : 'error';
  }

  const { events: storedRows, coverage } = activityStore.activityFor(wallet, 100);
  const events = classifyFeed(storedRows, scan, wallet);
  const response = {
    key,
    attribution: {
      gate: 'verified',
      wallet,
      walletBasis: "the wallet derived from this agent's token via ERC-6551",
    },
    coverage: {
      fromBlock: scanned.fromBlock,
      toBlock: scanned.toBlock,
      intervals: coverage.length,
      scannedThroughTs: new Date().toISOString(),
    },
    events,
    classLabels: CLASS_LABEL,
    sources: { transfers: transfersStatus, classification },
    cuUsed: nodereal.cuUsed(),
  };
  // Cache only a fully clean read; a throttled/error path must be retryable at
  // once, never frozen behind a 5-minute TTL like the verdict-cache bug taught.
  if (transfersStatus === 'ok' && classification === 'ok') activityCache.set(key, response);
  res.json(response);
}));

app.get('/health', (req, res) => {
  // Process liveness is independent of upstream availability. Deployment
  // acceptance requires smoke:release, which checks the registry and a task.
  res.json({ ok: true, scope: 'process', formulaVersion: FORMULA_VERSION, sweep: sweeper.stats() });
});

// /openapi.json, /.well-known/agent-card.json and the MCP endpoint. This site
// probes agents that speak MCP; serving it is the same standard applied to us.
mountMachineRoutes(app, { store, searchControl });

app.get('/api/summary', (req, res) => {
  res.json({
    ...store.summary(),
    // Bundled into the summary the page already polls rather than given its own
    // request: the coverage panel is always on screen, and on the anonymous
    // registry tier every avoidable round trip is budget taken from a visitor
    // waiting on a verdict.
    coverage: store.coverage(),
    formulaVersion: FORMULA_VERSION,
    sweep: sweeper.stats(),
  });
});

app.get('/api/verify/:chainId/:tokenId', limitVerify, async (req, res) => {
  const { chainId, tokenId } = req.params;
  if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
  }

  // ?stream=1: narrate the check as Server-Sent Events. Each frame is a probe
  // that ACTUALLY resolved (the verifier emits as calls finish, so the jitter
  // and ordering are the proof these are real); the last frame carries the
  // verdict. A cached verdict streams that one frame immediately — never a
  // re-enactment. Anything that can't stream falls back to the JSON path.
  if (req.query.stream === '1') {
    res.set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx-family proxies not to buffer; buffering would flatten the
      // narration into one burst, silently removing progressive check updates.
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    const send = createSseSender(res);
    try {
      const { verdict, cached } = await verify(chainId, tokenId, send);
      send({ step: 'verdict', verdict: { ...verdict, cached } });
    } catch (err) {
      if (err?.code === IDENTITY_UNAVAILABLE) {
        send({ step: 'error', code: IDENTITY_UNAVAILABLE, source: 'agent-identity', retryable: true, throttled: false, message: IDENTITY_UNAVAILABLE_MESSAGE });
        return res.end();
      }
      if (err instanceof WorkCapacityError) {
        send({ step: 'error', code: err.code, retryable: true,
          message: 'The service is at its active external-work limit. Retry shortly; no new work was started.' });
        return res.end();
      }
      const message = String(err.message || err);
      send({ step: 'error', throttled: /429|rate limit/i.test(message), message });
    }
    return res.end();
  }

  try {
    const { verdict, cached } = await verify(chainId, tokenId);
    res.json({ ...verdict, cached });
  } catch (err) {
    if (err instanceof WorkCapacityError) return capacityResponse(res, err);
    if (err?.code === IDENTITY_UNAVAILABLE) {
      return res.status(503).json({ error: IDENTITY_UNAVAILABLE, source: 'agent-identity', retryable: true, detail: IDENTITY_UNAVAILABLE_MESSAGE });
    }
    if (err?.source === '8004scan') return registryFailure(res, err);
    const message = String(err.message || err);
    // Being throttled by the registry is a wait, not a verdict and not a
    // failure. Saying "verification failed" would read as "this agent is
    // broken", which is the opposite of true.
    if (/429|rate limit/i.test(message)) {
      res.set('Retry-After', '15');
      return res.status(503).json({ error: 'registry-throttled', detail: 'The agent registry is rate limiting reads. This is temporary; try again shortly.' });
    }
    res.status(502).json({ error: 'verification-failed', detail: message });
  }
});

/**
 * Search what agents actually SERVE, not what they claim.
 *
 * Reads our own stored checks without a registry call. Shared input, request,
 * and CPU-work bounds protect the process. A hit means the endpoint listed that
 * capability when we asked it, which is why each row carries the matched name.
 */
app.get('/api/search', createSearchRouteHandler({ store, searchControl, tokenize: queryTokens }));

app.get('/api/history/:chainId/:tokenId', (req, res) => {
  const { chainId, tokenId } = req.params;
  if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
  }
  // The uptime calendar rides along on the request AgentDetail already makes.
  const key = `${chainId}:${tokenId}`;
  res.json({ checks: store.historyFor(key), uptime: store.uptimeFor(key) });
});

app.get('/api/live', (req, res) => {
  res.json({ agents: store.liveAgents(100) });
});

// The landing view: agents we hold a current verdict for, best first, rendered
// straight from our own records. No registry call, so opening the site cannot
// spend the shared budget, and the ordering is this site's own judgement
// instead of "whatever was registered most recently".
app.get('/api/checked', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json({ agents: store.checkedAgents(limit) });
});

/*
  What one wallet actually did on the ERC-8183 escrow.

  This is the counterweight to a hire menu: the menu is what an agent says it
  will do, and the kernel is what was really opened against it and how it
  ended. Both sides of the answer are honest states with their own words —
  `available: false` means nobody has collected a census here, `found: false`
  means the range was searched and this address is not in it. Neither is a
  zero, and the client is given the range so it cannot print one.

  Served from a file, so it costs no chain call and no registry budget.
*/
app.get('/api/escrow/:address', (req, res) => {
  const { address } = req.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'address must be a 0x-prefixed 20-byte address' });
  }
  res.json({ address: address.toLowerCase(), ...escrowCensus.lookup(address) });
});

// The census as a whole: who the escrow's working providers are, ours and
// everyone else's. Published because a venue that only shows its own jobs is
// reporting its own weather.
app.get('/api/escrow', (req, res) => {
  res.json(escrowCensus.top(Math.min(100, Math.max(1, Number(req.query.limit) || 20))));
});

// Verdicts already on record for a page of agents. Read-only and instant: it
// never triggers a check, so it cannot be used to drive load against the
// registry, and a visitor sees the sweep's work the moment the page renders.
app.post('/api/verdicts', (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  if (keys.length > 200) return res.status(400).json({ error: 'too many keys (max 200)' });
  const valid = keys.filter((k) => typeof k === 'string' && /^\d+:\d+$/.test(k));
  res.json({ verdicts: store.latestFor(valid) });
});

app.get('/api/agent-meta/:chainId/:tokenId', limitVerify, admittedHandler(createAgentMetadataHandler({
  cache: metadataCache,
  getAgentDetail: async (...args) => (await import('./sources/scan8004.js')).getAgentDetail(...args),
  getAgentMetadata: async (...args) => (await import('./sources/registry.js')).getAgentMetadata(...args),
  mediaFromRegistration,
  mediaFromMeta,
  bap578FromCard,
  registryFailure,
})));

// What this agent can be tried with: a free-text A2A message, or the live
// read-only tool list of an MCP server. The UI cannot know which without
// asking, and the registry's cached copy of the tool list is not good enough
// here because Try has to call whatever the server is serving right now.
app.get('/api/try/:chainId/:tokenId/interface', limitTry, admittedHandler(async (req, res) => {
  const { chainId, tokenId } = req.params;
  if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
  }
  try {
    const result = await tryInterface({ chainId, tokenId });
    // Attach the zero-input example ONLY when the last real check ran it
    // successfully AND the tool is still on the live list — the panel never
    // auto-runs anything unvalidated.
    if (result.status === 200 && result.body?.kind === 'mcp') {
      const ex = store.lastCheck(`${chainId}:${tokenId}`)?.tryExample;
      if (isCurrentTryExample(ex) && ex.observation.endpoint === result.body.endpoint
          && result.body.tools?.some((t) => t.name === ex.tool)) {
        result.body.example = {
          tool: ex.tool, args: ex.args, usesSample: Boolean(ex.usesSample), checkedAt: ex.checkedAt,
          observation: ex.observation,
        };
      }
    }
    res.status(result.status).json(result.body);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError';
    res.status(502).json({ error: timeout ? 'agent-timeout' : 'interface-failed', detail: String(err.message || err) });
  }
}));

app.post('/api/try/:chainId/:tokenId', limitTry, admittedHandler(async (req, res) => {
  const { chainId, tokenId } = req.params;
  if (!/^\d+$/.test(chainId) || !/^\d+$/.test(tokenId)) {
    return res.status(400).json({ error: 'chainId and tokenId must be numeric' });
  }
  try {
    const result = await tryAgent({
      chainId,
      tokenId,
      message: req.body?.message,
      payment: req.body?.payment,
      tool: req.body?.tool,
      args: req.body?.arguments,
      presetId: req.body?.presetId,
    });
    res.status(result.status === 402 ? 402 : 200).json(result);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError';
    res.status(502).json({ error: timeout ? 'agent-timeout' : 'try-failed', detail: String(err.message || err) });
  }
}));

const server = app.listen(config.port, () => {
  console.log(`findyouragent verify service on :${config.port} (formula v${FORMULA_VERSION})`);
  console.log(`  store: ${storePath}`);
  if (config.allowedOrigin === '*') console.log('  cors: open (set ALLOWED_ORIGIN to pin it)');
  if (config.sweepEnabled) sweeper.start();
});

// A rolling deploy sends SIGTERM. The store appends without awaiting, so
// exiting immediately can drop a verdict that was just computed, and stopping
// the sweep first means the shutdown is not racing new work it started itself.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`
${signal}: stopping sweep and draining`);
    sweeper.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
