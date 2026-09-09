import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createReferenceServer, handleMessage, readBortPosition, TOOL, RPC_URL } from '../bort-reference-agent.mjs';
import { GRID_COST_TOOL } from '../src/grid-cost-check.js';
import { positionsCall } from '../showcase-crosscheck.mjs';

const message = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const abi = `0x${[0, 0, 1, 2, 500, -66690, -65710, 2461321976867509016n, 0, 0, 0, 0].map(word).join('')}`;

test('only the two reviewed public analysis tools are discoverable; writes and caller endpoints cannot run', async () => {
  let reads = 0;
  const read = async () => { reads++; return { relationship: 'first-party' }; };
  assert.deepEqual((await handleMessage(message('tools/list'), read)).result.tools, [TOOL, GRID_COST_TOOL]);
  for (const bad of [
    message('eth_sendTransaction', {}), message('tools/call', { name: 'swap', arguments: {} }),
    message('tools/call', { name: TOOL.name, arguments: { rpc: 'http://localhost/' } }),
    message('tools/call', { name: TOOL.name, arguments: { positionId: '1' } }),
    message('tools/call', { name: TOOL.name, arguments: {}, extra: true }),
    { jsonrpc: '2.0', method: 'tools/call', params: { name: TOOL.name } },
  ]) assert.ok((await handleMessage(bad, read)).error);
  assert.equal(reads, 0);
  assert.equal((await handleMessage(message('tools/call', { name: TOOL.name, arguments: {} }), read)).result.structuredContent.relationship, 'first-party');
  assert.equal(reads, 1);
});

test('grid cost forwards exactly validated decimal-string arguments and rejects invalid input before reading', async () => {
  let reads = 0;
  let received;
  const gridRead = async (args) => { reads++; received = args; return { operation: GRID_COST_TOOL.name, ...args }; };
  const args = { stepPct: '1.25', cycleNotionalUsd: '1000', slippageBpsPerSwap: '4', gasUsdPerCycle: '0.18' };
  const result = await handleMessage(message('tools/call', { name: GRID_COST_TOOL.name, arguments: args }), readBortPosition, gridRead);
  assert.equal(result.result.isError, false);
  assert.deepEqual(received, args);
  assert.deepEqual(result.result.structuredContent, { operation: GRID_COST_TOOL.name, ...args });
  for (const bad of [
    undefined,
    {},
    { ...args, extra: '1' },
    { ...args, stepPct: 1.25 },
    { ...args, cycleNotionalUsd: '-1' },
  ]) {
    const before = reads;
    const rejected = await handleMessage(message('tools/call', { name: GRID_COST_TOOL.name, arguments: bad }), readBortPosition, gridRead);
    assert.equal(rejected.error.code, -32602);
    assert.equal(reads, before);
  }
});

test('grid cost upstream failure is a tool error without successful structured content', async () => {
  const result = await handleMessage(
    message('tools/call', { name: GRID_COST_TOOL.name, arguments: { stepPct: '1', cycleNotionalUsd: '100', slippageBpsPerSwap: '2', gasUsdPerCycle: '0.1' } }),
    readBortPosition,
    async () => { throw new Error('secret-grid-internal'); },
  );
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent, undefined);
  assert.ok(!JSON.stringify(result).includes('secret-grid-internal'));
});

test('upstream failure is a tool error, without reflecting private error messages', async () => {
  const result = await handleMessage(message('tools/call', { name: TOOL.name }), async () => { throw new Error('secret-internal'); });
  assert.equal(result.result.isError, true);
  assert.ok(!JSON.stringify(result).includes('secret-internal'));
  assert.equal(result.result.structuredContent, undefined);
});

test('reference output pins calls, identifies first-party scope and rejects wrong chain/reorg', async () => {
  const calls = [];
  let wrong = false; let reorg = false; let blocks = 0;
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    assert.equal(url, RPC_URL); assert.equal(options.redirect, 'error');
    let result;
    if (request.method === 'eth_chainId') result = wrong ? '0x1' : '0x38';
    else if (request.method === 'eth_getBlockByNumber') result = { number: '0x123', hash: `0x${(reorg && ++blocks > 1 ? 'b' : 'a').repeat(64)}`, timestamp: '0x65000000' };
    else {
      assert.equal(request.method, 'eth_call'); assert.equal(request.params[1], '0x123');
      result = request.params[0].data === positionsCall() ? abi : `0x${word(18)}`;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  const result = await readBortPosition({ fetchImpl });
  assert.equal(result.relationship, 'first-party'); assert.equal(result.registryStatus, 'unregistered-local-example');
  assert.deepEqual(Object.keys(result.fixture).sort(), ['chainId', 'manager', 'positionId']);
  assert.equal(result.fixture.positionId, '7337249');
  assert.equal(Object.hasOwn(result.fixture, 'tokenId'), false);
  assert.equal(Object.hasOwn(result.fixture, 'presetId'), false);
  assert.equal(result.block.hashStable, true); assert.equal(result.paidDelivery, false);
  assert.equal(result.position.liquidity, '2461321976867509016');
  wrong = true;
  await assert.rejects(readBortPosition({ fetchImpl }), /complete, stable BSC/);
  wrong = false; reorg = true;
  await assert.rejects(readBortPosition({ fetchImpl }), /complete, stable BSC/);
});

test('transport validates loopback Host, Origin, body bounds and MCP notifications', async (t) => {
  let reads = 0;
  const server = createReferenceServer({ read: async () => { reads++; return {}; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post(message('tools/list'), { Origin: 'https://evil.example' })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end(JSON.stringify(message('tools/list')));
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await post(message('tools/list'), { Accept: 'text/html' })).status, 406);
  assert.equal((await post(message('tools/list'), { 'MCP-Protocol-Version': 'bad' })).status, 400);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await post({ data: 'a'.repeat(9000) })).status, 413);
  assert.equal(reads, 0);
  const result = await (await post(message('tools/call', { name: TOOL.name }))).json();
  assert.equal(result.result.isError, false); assert.equal(reads, 1);
});
