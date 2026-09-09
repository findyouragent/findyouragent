import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverMcpTools, callMcpTool } from '../src/mcp.js';
import { withDeadline } from '../src/request-deadline.js';
import { tryInterface, tryAgent } from '../src/try.js';
import { getAgentDetail } from '../src/sources/scan8004.js';

const endpoint = 'https://8.8.8.8/mcp'; // fetch is replaced throughout: no network/DNS.
const init = (session = 's1') => ({ result: { serverInfo: { name: 'Fixture' } }, session });
const listed = { result: { tools: [{ name: 'getHealth', inputSchema: { type: 'object', properties: {} } }] } };
let passed = 0;
async function test(name, run) {
  const original = globalThis.fetch;
  const calls = [];
  const replyWith = (fn) => {
    globalThis.fetch = async (url, options) => {
      const request = { url: String(url), method: options.body ? JSON.parse(options.body).method : 'GET', options };
      calls.push(request);
      const reply = await fn(request, calls.length);
      if (reply instanceof Error) throw reply;
      assert.ok(reply, 'No additional network request is allowed');
      return new Response(reply.raw ?? JSON.stringify({ jsonrpc: '2.0', result: reply.result, error: reply.error }), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...(reply.session ? { 'mcp-session-id': reply.session } : {}) },
      });
    };
  };
  try { await run(replyWith, calls); passed += 1; }
  catch (err) { console.error(`FAIL ${name}: ${err.stack}`); process.exitCode = 1; }
  finally { globalThis.fetch = original; }
}

await test('discovery retries one 502 handshake with a fresh session', async (respond, calls) => {
  const replies = [{ status: 502 }, init('recovered'), listed];
  respond((_req, n) => replies[n - 1]);
  const out = await discoverMcpTools(endpoint);
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(out.listed.tools[0].name, 'getHealth');
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'initialize', 'tools/list']);
  assert.equal(calls[2].options.headers['mcp-session-id'], 'recovered');
});

await test('a tools/list blip creates a new session and never executes a tool', async (respond, calls) => {
  const replies = [init('old'), { status: 503 }, init('new'), listed];
  respond((_req, n) => replies[n - 1]);
  const out = await discoverMcpTools(endpoint);
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(calls[3].options.headers['mcp-session-id'], 'new');
  assert.equal(calls.filter((c) => c.method === 'tools/call').length, 0);
});

await test('persistent discovery gateway errors retain source phase and status', async (respond, calls) => {
  respond(() => ({ status: 504 }));
  const out = await discoverMcpTools(endpoint);
  assert.equal(out.ok, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(out.failure, { source: 'agent', phase: 'initialize', code: 'mcp-http-error', upstreamStatus: 504, retryable: true });
});

await test('rate limits and permanent errors are never automatically retried', async (respond, calls) => {
  for (const status of [400, 401, 403, 404, 429]) {
    const before = calls.length;
    respond(() => ({ status }));
    const out = await discoverMcpTools(endpoint);
    assert.equal(out.ok, false);
    assert.equal(out.failure.upstreamStatus, status);
    assert.equal(out.failure.retryable, false);
    assert.equal(calls.length, before + 1);
  }
});

await test('RPC refusal and malformed successful bodies remain failures', async (respond, calls) => {
  for (const reply of [{ error: { code: -1, message: 'refused' }, result: {} }, { raw: '<html>gateway</html>' }, { result: [] }]) {
    const before = calls.length;
    respond(() => reply);
    const out = await discoverMcpTools(endpoint);
    assert.equal(out.ok, false);
    assert.equal(out.failure.retryable, false);
    assert.equal(calls.length, before + 1);
  }
  const before = calls.length;
  respond((_req, n) => n === before + 1 ? init() : { result: {} });
  const out = await discoverMcpTools(endpoint);
  assert.equal(out.failure.phase, 'tools/list');
  assert.equal(out.failure.code, 'mcp-invalid-response');
});

await test('one transport recovery is allowed only for discovery', async (respond, calls) => {
  respond((_req, n) => n === 1 ? new TypeError('fetch failed') : n === 2 ? init() : listed);
  const out = await discoverMcpTools(endpoint);
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(calls.length, 3);
});

await test('blocked endpoints are refused without any fetch', async (respond, calls) => {
  respond(() => { throw new Error('No fetch allowed'); });
  const out = await discoverMcpTools('http://127.0.0.1/private');
  assert.equal(out.ok, false);
  assert.equal(out.failure.code, 'mcp-blocked-endpoint');
  assert.equal(out.attempts, 1);
  assert.equal(calls.length, 0);
});

await test('discovery shares one deadline across handshake and list', async (respond, calls) => {
  respond(async ({ method, options }) => {
    if (method === 'initialize') return init();
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const out = await discoverMcpTools(endpoint, { timeoutMs: 25 });
  assert.equal(out.ok, false);
  assert.equal(out.failure.code, 'mcp-discovery-timeout');
  assert.equal(out.failure.phase, 'tools/list');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
});

await test('expired discovery cannot continue after a late ignored abort', async (respond, calls) => {
  let finish;
  respond(() => new Promise((resolve) => { finish = resolve; }));
  const out = await discoverMcpTools(endpoint, { timeoutMs: 25 });
  assert.equal(out.ok, false);
  finish(init());
  await delay(5);
  assert.equal(calls.length, 1, 'No late tools/list is sent');
});

await test('tool gateway error is returned after exactly one execution', async (respond, calls) => {
  respond(({ method }) => method === 'initialize' ? init() : { status: 502, raw: '<html>unavailable</html>' });
  const out = await callMcpTool(endpoint, { name: 'getHealth', args: {} });
  assert.equal(out.status, 502);
  assert.equal(out.upstreamStatus, 502);
  assert.equal(out.captureComplete, false);
  assert.equal(calls.filter((c) => c.method === 'tools/call').length, 1);
});

await test('timed-out execution is never replayed', async (respond, calls) => {
  respond(async ({ method, options }) => {
    if (method === 'initialize') return init();
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  await assert.rejects(callMcpTool(endpoint, { name: 'getHealth', args: {}, timeoutMs: 25 }), { name: 'TimeoutError' });
  assert.equal(calls.filter((c) => c.method === 'tools/call').length, 1);
});

await test('parent deadline bounds nested work and already-aborted work never starts', async () => {
  let nestedSignal;
  await assert.rejects(withDeadline(20, (parent) => withDeadline(2000, (signal) => {
    nestedSignal = signal;
    return new Promise(() => {});
  }, parent)), { name: 'TimeoutError' });
  assert.equal(nestedSignal.aborted, true);
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(withDeadline(2000, () => { started = true; }, controller.signal), { name: 'AbortError' });
  assert.equal(started, false);
});

await test('interface attributes registry failure without calling the provider', async (respond, calls) => {
  respond(() => ({ status: 404 }));
  const out = await tryInterface({ chainId: 56, tokenId: '999001' });
  assert.equal(out.status, 502);
  assert.equal(out.body.source, 'registry');
  assert.equal(out.body.phase, 'agent-detail');
  assert.equal(out.body.upstreamStatus, 404);
  assert.equal(calls.length, 1);
});

await test('Try keeps its registry context separate from a coalesced detail rejection', async (respond, calls) => {
  respond(() => ({ status: 404 }));
  const detail = getAgentDetail(56, '999011').catch(error => error);
  const [error, iface] = await Promise.all([detail, tryInterface({ chainId: 56, tokenId: '999011' })]);
  assert.equal(calls.length, 1);
  assert.equal(error.source, '8004scan');
  assert.equal(error.phase, undefined);
  assert.equal(error.status, 404);
  assert.equal(iface.body.source, 'registry');
  assert.equal(iface.body.phase, 'agent-detail');
  assert.equal(iface.body.retryable, false);
});

await test('registry timeout can be retried explicitly and never invokes a provider', async (respond, calls) => {
  respond(() => new DOMException('Fixture registry timeout', 'TimeoutError'));
  const iface = await tryInterface({ chainId: 56, tokenId: '999012' });
  assert.equal(iface.body.code, 'request-timeout');
  assert.equal(iface.body.source, 'registry');
  assert.equal(iface.body.retryable, true);
  const task = await tryAgent({ chainId: 56, tokenId: '999013', tool: 'getHealth', args: {} });
  assert.equal(task.retryable, true);
  assert.equal(task.phase, 'agent-detail');
  assert.equal(task.endpoint, null);
  assert.equal(task.captureComplete, false);
  assert.ok(calls.every(call => call.method === 'GET'));
});

await test('a malformed registry identity cannot become a retryable transient error', async (respond, calls) => {
  respond(() => ({ raw: JSON.stringify({ chain_id: 1, token_id: '999014' }) }));
  const iface = await tryInterface({ chainId: 56, tokenId: '999014' });
  assert.equal(iface.body.code, 'registry-invalid-response');
  assert.equal(iface.body.retryable, false);
  assert.equal(calls.length, 1);
});

await test('a returned registry HTTP500 is distinct from a local timeout and allows a later retry', async (respond, calls) => {
  respond(() => ({ status: 500 }));
  const iface = await tryInterface({ chainId: 56, tokenId: '999016' });
  assert.equal(iface.body.code, 'registry-unavailable');
  assert.equal(iface.body.upstreamStatus, 500);
  assert.equal(iface.body.retryable, true);
  assert.equal(calls.length, 3, 'only the bounded registry transport attempts run');
  assert.ok(calls.every(call => call.method === 'GET'));
});

await test('preset discovery outage is not called schema drift and cannot execute', async (respond, calls) => {
  respond(({ method }) => method === 'GET'
    ? { raw: JSON.stringify({ chain_id: 56, token_id: '45422', services: { mcp: { endpoint } } }) }
    : { status: 502 });
  const out = await tryAgent({ chainId: 56, tokenId: '45422', presetId: 'beefy-bsc-vaults' });
  assert.equal(out.status, 502);
  assert.equal(out.source, 'agent');
  assert.equal(out.phase, 'initialize');
  assert.equal(out.observation.captureComplete, false);
  assert.equal(out.observation.task.status, 'not_evaluated');
  assert.ok(!out.body.error.includes('changed'));
  assert.equal(calls.filter((c) => c.method === 'tools/call').length, 0);
});

await test('A2A card failure is identified before any message is sent', async (respond, calls) => {
  respond(({ url }) => url.startsWith('https://api.8004scan.io/api/v1/agents/')
    ? { raw: JSON.stringify({ chain_id: 56, token_id: '999002', services: { a2a: { endpoint: 'https://8.8.8.8/card' } } }) }
    : new TypeError('fetch failed'));
  const out = await tryAgent({ chainId: 56, tokenId: '999002', message: 'Fixture' });
  assert.equal(out.source, 'agent');
  assert.equal(out.phase, 'agent-card');
  assert.equal(out.endpoint, 'https://8.8.8.8/card');
  assert.match(out.body.error, /No message was sent/);
  assert.equal(calls.filter((c) => c.method === 'message/send').length, 0);
});

await test('lost A2A response keeps completion unknown and never replays the message', async (respond, calls) => {
  respond(({ url, method }) => url.startsWith('https://api.8004scan.io/api/v1/agents/')
    ? { raw: JSON.stringify({ chain_id: 56, token_id: '999003', services: { a2a: { endpoint: 'https://8.8.8.8/card' } } }) }
    : method === 'GET' ? { raw: JSON.stringify({ url: 'https://8.8.8.8/rpc' }) }
      : new TypeError('fetch failed after provider received request'));
  const out = await tryAgent({ chainId: 56, tokenId: '999003', message: 'Fixture' });
  assert.equal(out.phase, 'message/send');
  assert.equal(out.source, 'agent');
  assert.equal(out.endpoint, 'https://8.8.8.8/rpc');
  assert.equal(out.observation.captureComplete, false);
  assert.match(out.body.error, /Completion is unknown/);
  assert.equal(out.retryable, false);
  assert.equal(calls.filter((c) => c.method === 'message/send').length, 1);
});

await test('lost MCP response stays nonretryable and does not replay tools/call', async (respond, calls) => {
  respond(({ url, method }) => url.startsWith('https://api.8004scan.io/api/v1/agents/')
    ? { raw: JSON.stringify({ chain_id: 56, token_id: '999015', services: { mcp: { endpoint } } }) }
    : method === 'initialize' ? init() : new DOMException('Lost tool response', 'TimeoutError'));
  const out = await tryAgent({ chainId: 56, tokenId: '999015', tool: 'getHealth', args: {} });
  assert.equal(out.source, 'agent');
  assert.equal(out.phase, 'agent-call');
  assert.equal(out.retryable, false);
  assert.equal(out.captureComplete, false);
  assert.match(out.body.error, /Completion is unknown/);
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 1);
});

console.log(`${passed} MCP discovery/deadline checks passed with network disabled`);
