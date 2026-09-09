import { buildTools, agentCard, openapi, handleMcp } from '../src/machine.js';
import { FORMULA_VERSION } from '../src/verify/score.js';
import { classifyTryResult } from '../src/try-result.js';
import { getTaskPresets, assessTaskResult } from '../src/task-presets.js';
import { registryParams } from '../src/registry.js';

/**
 * The machine-facing surfaces have to pass the test this site applies to
 * everyone else.
 *
 * The load-bearing one is declared-vs-served: the agent card publishes a skill
 * list, and if that list ever names something `tools/list` does not serve, this
 * service is the exact registration it marks other agents down for. The card is
 * generated from the tool table so the drift is impossible by construction —
 * this pins that, because "impossible by construction" is a claim that survives
 * exactly until someone hand-edits the card.
 *
 * The second is that no tool reaches the registry. An MCP tool is called by
 * software in a loop; one registry read inside one would let any caller drain
 * the shared registry budget that visitors and the sweep both live on. The
 * store stub below throws on anything but the five read methods, so a future
 * tool that reaches further fails here rather than in production.
 *
 *   node test/machine.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error(`  FAIL  ${message}`);
};

// A store that answers the five read methods and throws on everything else,
// so a tool that grows a new dependency is caught here.
const stubStore = new Proxy({
  searchCorpusStats: () => ({ records: 1, agents: 1, servedNames: 1, servedNameCharacters: 17 }),
  searchServed: (q, limit) => (q.includes('venus')
    ? [{ chain_id: 56, token_id: '43129', name: 'Venus', tier: 'verified_live', matchedTool: 'get_venus_balance' }].slice(0, limit)
    : []),
  latestFor: (keys) => (keys.includes('56:43129') ? { '56:43129': { tier: 'verified_live', formulaVersion: FORMULA_VERSION } } : {}),
  historyFor: () => [{ ts: '2026-09-01T00:00:00Z' }],
  uptimeFor: () => ({ days: [{ d: '2026-09-01', c: 'o', n: 3, ok: 3 }], summary: { checkedDays: 1 } }),
  summary: () => ({ uniqueChecked: 1007, tiers: { verified_live: 6 } }),
  coverage: () => ({ yield: { agents: 10 } }),
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    throw new Error(`a tool reached store.${String(prop)} — tools must read stored records only`);
  },
});

const tools = buildTools(stubStore);
const call = (name, args) => JSON.parse(handleMcp({ id: 1, method: 'tools/call', params: { name, arguments: args } }, tools).result.content[0].text);

console.log('declared vs served');
{
  const declared = agentCard('https://x.test', tools).skills.map((s) => s.id).sort();
  const served = handleMcp({ id: 1, method: 'tools/list' }, tools).result.tools.map((t) => t.name).sort();
  ok(declared.length > 0, 'the card declares at least one skill');
  ok(JSON.stringify(declared) === JSON.stringify(served),
    `the card declares exactly what tools/list serves (declared ${declared}, served ${served})`);
}

console.log('the card claims no transport it does not answer');
{
  const card = agentCard('https://x.test', tools);
  ok(!card.services?.a2a && !card.preferredTransport,
    'no A2A service is declared: this server does not answer message/send');
  ok(card.services?.mcp?.endpoint === 'https://x.test/mcp', 'the MCP endpoint is the host that was actually reached');
  ok(card.formulaVersion === FORMULA_VERSION, 'the card carries the formula version in force');
}

console.log('tools read stored records only');
{
  // The proxy throws on any store method outside the four reads, so simply
  // running every tool is the assertion.
  let reached = null;
  try {
    for (const tool of tools) tool.run(tool.name === 'search_agents' ? { task: 'venus' } : { key: '56:43129' });
  } catch (err) { reached = String(err.message); }
  ok(reached === null, `no tool reached beyond the store's read methods (${reached ?? 'clean'})`);
}

console.log('unknown is unknown');
{
  const missing = call('get_verdict', { key: '56:999999999' });
  ok(missing.verdict === null, 'an agent we never checked returns null, not a tier');
  ok(/never checked/.test(missing.note) && /not a finding about the agent/.test(missing.note),
    'and says the gap is ours, not a claim about the agent');

  const found = call('get_verdict', { key: '56:43129' });
  ok(found.verdict.tier === 'verified_live', 'a held verdict comes back with its tier');
  ok(found.page.includes('56/43129'), 'every result carries the page a person can be sent to');
}

console.log('search results are usable without reassembly');
{
  const hit = call('search_agents', { task: 'check my venus health factor' }).agents[0];
  ok(hit.key === '56:43129', 'each row carries the key get_verdict takes back');
  ok(hit.matchedTool === 'get_venus_balance', 'and the tool name the match was made on');
  const none = call('search_agents', { task: 'grid trading' });
  ok(none.count === 0 && Array.isArray(none.agents), 'no match returns an empty list, never an error');
}

console.log('bad input is a tool error, not a transport error');
{
  const res = handleMcp({ id: 1, method: 'tools/call', params: { name: 'get_verdict', arguments: { key: 'nope' } } }, tools);
  ok(res.result?.isError === true, 'a malformed key answers isError so the caller can see why');
  ok(!res.error, 'and is not reported as a JSON-RPC failure: the call reached us and we answered');
}

console.log('protocol');
{
  ok(handleMcp({ id: 1, method: 'notifications/initialized' }, tools) === null,
    'a notification produces no response body');
  ok(handleMcp({ id: 1, method: 'initialize', params: {} }, tools).result.protocolVersion === '2025-06-18',
    'initialize answers the protocol revision our own client speaks');
  ok(handleMcp({ id: 1, method: 'tools/call', params: { name: 'nope' } }, tools).error?.code === -32602,
    'an unknown tool is an invalid-params error');
  ok(handleMcp({ id: 1, method: 'sideways' }, tools).error?.code === -32601,
    'an unknown method is method-not-found');
}

console.log('openapi');
{
  const doc = openapi('https://x.test', tools);
  const ops = Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([m, op]) => ({ path, m, op })));
  ok(doc.openapi.startsWith('3.'), 'declares an OpenAPI version');
  ok(ops.every(({ op }) => op.operationId && op.responses && Object.keys(op.responses).length),
    'every operation has an operationId and at least one response');
  const ids = ops.map(({ op }) => op.operationId);
  ok(new Set(ids).size === ids.length, 'operationIds are unique');
  ok(doc.paths['/api/verify/{chainId}/{tokenId}'].get.responses[503],
    'the throttle response is documented: a caller must not read 503 as a broken agent');
  ok(doc.info.description.includes('never `0`'), 'the null-is-not-zero rule is stated where a caller will read it');
}

// Test-only walker for the vocabulary used by our typed schemas. These checks
// use classifier/preset outputs, not remote provider claims or live requests.
function conforms(value, shape, doc) {
  if (shape.$ref) {
    const target = shape.$ref.split('/').slice(1).reduce((node, part) => node?.[part], doc);
    if (!target || !conforms(value, target, doc)) return false;
  }
  if (shape.oneOf && shape.oneOf.filter((part) => conforms(value, part, doc)).length !== 1) return false;
  if (shape.anyOf && !shape.anyOf.some((part) => conforms(value, part, doc))) return false;
  if (Object.hasOwn(shape, 'const') && value !== shape.const) return false;
  if (shape.enum && !shape.enum.includes(value)) return false;
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (shape.type && ![shape.type].flat().some((type) => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value) : type === 'object' ? isObject
      : type === 'integer' ? Number.isInteger(value) : typeof value === type)) return false;
  if (typeof value === 'number' && ((shape.minimum !== undefined && value < shape.minimum)
    || (shape.maximum !== undefined && value > shape.maximum))) return false;
  if (typeof value === 'string' && ((shape.minLength !== undefined && value.length < shape.minLength)
    || (shape.maxLength !== undefined && value.length > shape.maxLength)
    || (shape.pattern && !new RegExp(shape.pattern).test(value)))) return false;
  if (isObject) {
    if (shape.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (shape.properties?.[key]) {
        if (!conforms(item, shape.properties[key], doc)) return false;
      } else if (shape.additionalProperties === false) return false;
    }
  }
  return !Array.isArray(value) || !shape.items || value.every((item) => conforms(item, shape.items, doc));
}

console.log('typed task contracts match classifier outputs');
{
  const doc = openapi('https://x.test', tools);
  const schemas = doc.components.schemas;
  const typed = (value, name) => conforms(value, schemas[name], doc);
  const tryOp = doc.paths['/api/try/{chainId}/{tokenId}'].post;
  ok(tryOp.requestBody.required && tryOp.requestBody.content['application/json'].schema.$ref.endsWith('/TryRequest'), 'Try input is a linked typed request');
  for (const status of [200, 402]) {
    ok(tryOp.responses[status].content['application/json'].schema.$ref.endsWith('/TryResponse'), `${status} documents the full relay envelope`);
  }
  ok(tryOp.description.includes('HTTP 200 includes handled failures'), 'handled error HTTP semantics are explicit');
  ok(tryOp.description.includes('A2A messages have no equivalent read-only enforcement'), 'arbitrary A2A messages are not promised read-only');
  ok(typed({ presetId: 'beefy-bsc-vaults' }, 'TryRequest'), 'reviewed task request needs no caller tool/arguments');
  ok(typed({ message: 'Describe your capabilities.', payment: 'signed-payload' }, 'TryRequest'), 'A2A payment is a string');
  ok(!typed({ message: 'Describe your capabilities.', payment: {} }, 'TryRequest'), 'payment object mismatch is rejected by the contract');
  ok(!typed({}, 'TryRequest') && !typed({ presetId: '' }, 'TryRequest'), 'missing intent is not advertised as valid');
  const cases = [
    ['MCP content', 'mcp', 200, { result: { content: [{ type: 'text', text: 'read output' }] } }],
    ['MCP error over HTTP200', 'mcp', 200, { result: { isError: true, content: [{ type: 'text', text: 'failed' }] } }],
    ['pending without payload', 'mcp', 202, null],
    ['payment challenge', 'a2a', 402, { accepts: [] }],
    ['upstream failure', 'mcp', 503, { error: 'unavailable' }],
    ['no upstream response', 'mcp', null, { error: 'registry unavailable' }],
    ['unknown result', 'mcp', 200, { result: {} }],
    ['A2A completed output', 'a2a', 200, { result: { kind: 'task', id: 'provider-task', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'output' }] }] } }],
  ];
  for (const [label, protocol, httpStatus, body] of cases) {
    const observation = classifyTryResult({ protocol, httpStatus, body, captureComplete: body !== null });
    ok(typed(observation, 'TryObservation'), `classifier output conforms: ${label}`);
    ok(typed({ status: httpStatus ?? 502, body, observation }, 'TryResponse'), `relay response conforms: ${label}`);
  }
  const observation = classifyTryResult({ protocol: 'mcp', httpStatus: 200, body: { result: {} } });
  ok(!typed({ ...observation, outcome: 'success' }, 'TryObservation'), 'generic success is outside the classifier contract');
  ok(!typed({ ...observation, captureComplete: 'true' }, 'TryObservation'), 'capture completeness remains boolean');
  const incomplete = { ...observation }; delete incomplete.task;
  ok(!typed(incomplete, 'TryObservation'), 'task assessment cannot be omitted');
  const liveTool = { name: 'getVaultsWithChains', readOnly: true,
    inputSchema: { type: 'object', properties: { chainNames: { type: 'array', items: { type: 'string' } } }, required: ['chainNames'] } };
  const identity = { chainId: 56, tokenId: '45422' };
  const [preset] = getTaskPresets({ ...identity, tools: [liveTool] });
  const [unavailable] = getTaskPresets({ ...identity, tools: [] });
  ok(typed(preset, 'TaskPreset') && typed(unavailable, 'TaskPreset') && unavailable.available === false, 'available and unavailable discovered presets conform');
  const body = { result: { structuredContent: { project: 'beefy', operation: preset.tool,
    data: [{ chain: 'bsc', vaults: [{ id: 'test-vault', name: 'Synthetic test vault', chain: 'bsc', token: 'WBNB', tvl: 0, apy: 0 }] }] } } };
  for (const [outcome, expected] of [['response_received', 'passed'], ['error', 'failed'], ['pending', 'pending']]) {
    const assessment = assessTaskResult(preset, { outcome }, body);
    ok(assessment.status === expected && typed(assessment, 'TaskAssessment'), `${expected} assessment conforms`);
  }
  ok(!typed({ status: 'passed' }, 'TaskAssessment'), 'passing requires preset version, criteria version and checks');
  const rangeIncomplete = { ...assessTaskResult(preset, { outcome: 'response_received' }, body), status: 'incomplete',
    corroboration: { status: 'incomplete', checkedAt: '2026-09-08T21:05:00.000Z', checks: [], limitation: 'Synthetic RPC unavailable.' } };
  ok(typed(rangeIncomplete, 'TaskAssessment'), 'incomplete corroboration is part of the task wire contract');
  ok(!typed({ ...rangeIncomplete, corroboration: { ...rangeIncomplete.corroboration, status: 'confirmed' } }, 'TaskAssessment'), 'invented corroboration status is rejected');
  ok(!typed({ status: 'not_evaluated', presetId: preset.id }, 'TaskAssessment'), 'unevaluated task cannot masquerade as reviewed');
  const interfaceBody = { kind: 'mcp', endpoint: 'https://agent.test/mcp', server: {},
    discovery: { attempts: 1, recovered: false }, tools: [{ ...liveTool, title: null, description: null }], writeToolCount: 0, taskPresets: [preset] };
  ok(typed(interfaceBody, 'TryInterface') && typed({ kind: 'a2a' }, 'TryInterface'), 'both interface shapes conform');
  ok(!typed({ ...interfaceBody, taskPresets: undefined }, 'TryInterface'), 'MCP requires typed task discovery');
  const page = doc.paths['/api/registry/agents'].get.parameters.find((p) => p.name === 'page');
  const params = registryParams({ page: '1001', limit: '25' });
  ok(conforms(params.page, page.schema, doc), 'schema accepts supported pages beyond the former cutoff');
  ok(page.description.includes('safe-integer'), 'combined page/limit offset constraint is documented');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
