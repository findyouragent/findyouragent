import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FIXTURE, readReferencePosition } from './showcase-crosscheck.mjs';
import { GRID_COST_TOOL, readGridCostCheck, validateGridCostInputs } from './src/grid-cost-check.js';

// Local first-party reference example. This is not a registry entry, an
// independent provider, or the BORT Position Keeper execution-track agent.
export const RPC_URL = 'https://bsc-dataseed.bnbchain.org';
export const TOOL = Object.freeze({
  name: 'get_reference_position',
  description: 'Read public PancakeSwap BSC position #7337249 at one block. First-party BORT reference example; no wallet or transaction.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
});
// The shared showcase fixture also names the external HeyAnon comparison
// agent. That registry token and preset are not this local example's identity.
export const POSITION_FIXTURE = Object.freeze({
  chainId: FIXTURE.chainId, positionId: FIXTURE.positionId, manager: FIXTURE.manager,
});
export const DISCLOSURE = Object.freeze({
  operator: 'Find Your Agent', relationship: 'first-party',
  registryStatus: 'unregistered-local-example', paidDelivery: false,
  executionTrackEvidence: false, fixture: POSITION_FIXTURE,
});
const PROTOCOL = '2025-06-18';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value) => value === undefined || (object(value) && Object.keys(value).length === 0);
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error('Public RPC did not return a successful response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error('Public RPC response exceeded the size limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function readBortPosition({ fetchImpl = fetch } = {}) {
  const startedAt = new Date().toISOString();
  const overall = AbortSignal.timeout(60000);
  let id = 0;
  const chain = await readReferencePosition(async (_name, method, params) => {
    if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method)) throw new Error('Unsupported reference read');
    const requestId = ++id;
    const response = await fetchImpl(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.any([overall, AbortSignal.timeout(12000)]),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
    const body = await boundedJson(response);
    if (body.jsonrpc !== '2.0' || body.id !== requestId || body.error || body.result == null) throw new Error('Public RPC returned an invalid or failed read');
    return body.result;
  });
  if (chain.chainId !== 56 || !chain.position || chain.block?.hashStable !== true
    || !Number.isInteger(chain.decimals0) || !Number.isInteger(chain.decimals1)) {
    throw new Error('A complete, stable BSC reference read was unavailable');
  }
  return {
    ...DISCLOSURE, operation: TOOL.name, startedAt, finishedAt: new Date().toISOString(),
    source: { kind: 'public-chain-rpc', endpoint: RPC_URL }, ...chain,
    limitations: [
      'A public RPC observation, not a light-client or provider-signed proof.',
      'Latest block was stable during this read; finality is not established.',
      'tokensOwed values are contract fields, not a calculation of all pending fees.',
      'No current asset amounts, valuation, swap, rebalance or paid hire is performed.',
    ],
  };
}

export async function handleMessage(message, read = readBortPosition, gridRead = readGridCostCheck) {
  const hasId = object(message) && Object.hasOwn(message, 'id');
  const validId = typeof message?.id === 'string' || Number.isSafeInteger(message?.id);
  if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
    || (hasId && !validId) || (message.params !== undefined && !object(message.params))) {
    return error(null, -32600, 'Invalid JSON-RPC request');
  }
  if (!hasId) {
    return message.method === 'notifications/initialized' && empty(message.params)
      ? null : error(null, -32600, 'Unsupported notification');
  }
  const { id, method, params } = message;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    if (typeof params?.protocolVersion !== 'string' || !object(params.capabilities)
      || typeof params.clientInfo?.name !== 'string' || typeof params.clientInfo?.version !== 'string') {
      return error(id, -32602, 'Initialization requires protocolVersion, capabilities and clientInfo');
    }
    return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'bort-local-analysis-reference', version: '0.2.0' },
      instructions: 'First-party BORT/FYA local public-read fixture. Not independently operated, registered, paid, or execution-track evidence.' });
  }
  if (method === 'ping' || method === 'tools/list') {
    if (!empty(params)) return error(id, -32602, 'This method accepts no parameters');
    return ok(method === 'ping' ? {} : { tools: [TOOL, GRID_COST_TOOL] });
  }
  if (method !== 'tools/call') return error(id, -32601, 'Method not found');
  if (!object(params) || Object.keys(params).some((key) => !['name', 'arguments'].includes(key))) {
    return error(id, -32602, 'Only the supported read-only tools are available');
  }
  const reader = params.name === TOOL.name ? read : params.name === GRID_COST_TOOL.name ? gridRead : null;
  if (!reader) return error(id, -32602, 'Unknown or unsupported tool');
  let argumentsValue = params.arguments;
  if (params.name === TOOL.name) {
    if (!empty(argumentsValue)) return error(id, -32602, 'Only get_reference_position with empty arguments is available');
    argumentsValue = {};
  } else {
    try { argumentsValue = validateGridCostInputs(argumentsValue); }
    catch { return error(id, -32602, 'check_grid_costs requires exactly the supported decimal-string arguments'); }
  }
  try {
    const value = params.name === TOOL.name ? await reader() : await reader(argumentsValue);
    return ok({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
  } catch {
    // Do not expose transport internals, environment or upstream response text.
    return ok({ isError: true, content: [{ type: 'text', text: 'Public BSC read unavailable or incomplete. No successful result was recorded.' }] });
  }
}

export function createReferenceServer({ read = readBortPosition, gridRead = readGridCostCheck } = {}) {
  let active = 0;
  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(body == null ? undefined : JSON.stringify(body));
    };
    const port = server.address()?.port;
    // Origin-bearing browser requests are intentionally unsupported. This
    // standalone CLI example has no browser client or credentialed endpoint.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host) || request.headers.origin !== undefined) {
      return reply(403, { error: 'Only local non-browser clients are supported' });
    }
    if (request.url === '/health' && request.method === 'GET') return reply(200, { status: 'ready', ...DISCLOSURE });
    if (request.url !== '/mcp') return reply(404, { error: 'Not found' });
    if (request.method !== 'POST') return reply(405, { error: 'POST required; SSE is not offered' });
    if (request.headers['mcp-protocol-version'] && request.headers['mcp-protocol-version'] !== PROTOCOL) return reply(400, { error: 'Unsupported protocol version' });
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return reply(415, { error: 'JSON required' });
    if (!(request.headers.accept ?? '').includes('application/json') || !(request.headers.accept ?? '').includes('text/event-stream')) return reply(406, { error: 'Accept application/json and text/event-stream' });
    if (active >= 2) return reply(429, { error: 'Reference reader busy' });
    active++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) { reply(413, { error: 'Request too large' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(400, error(null, -32700, 'Invalid JSON')); }
      const result = await handleMessage(body, read, gridRead);
      reply(result === null ? 202 : 200, result);
    } catch { if (!response.headersSent) reply(500, { error: 'Request could not complete' }); }
    finally { active--; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = process.argv[2] ?? '8792';
  if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) throw new Error('Port must be 1024–65535');
  const server = createReferenceServer();
  server.listen(Number(raw), '127.0.0.1', () => {
    console.log(`BORT first-party reference example: http://127.0.0.1:${raw}/mcp (unregistered, read-only)`);
  });
}
