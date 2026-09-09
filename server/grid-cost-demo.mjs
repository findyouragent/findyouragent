import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createReferenceServer } from './bort-reference-agent.mjs';
import { readGridCostCheck } from './src/grid-cost-check.js';

// Local demonstration: no payment, wallet, provider activation or trade.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, 'output', `first-party-grid-${stamp}`);
await fs.mkdir(directory, { recursive: true });
let trace = [];
const server = createReferenceServer({ gridRead: args => readGridCostCheck(args, { onObservation: entry => trace.push(entry) }) });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
const save = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const hashes = [], runs = [];
async function call(id, method, params) {
  const request = { jsonrpc: '2.0', id, method, params };
  const startedAt = new Date().toISOString();
  await save(`${id}.request.json`, request);
  const reply = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(50000) });
  const bytes = Buffer.from(await reply.arrayBuffer());
  await fs.writeFile(path.join(directory, `${id}.response.json`), bytes, { flag: 'wx' });
  hashes.push({ file: `${id}.response.json`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  return { startedAt, finishedAt: new Date().toISOString(), httpStatus: reply.status, body: JSON.parse(bytes.toString('utf8')) };
}
try {
  const init = await call('initialize', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fya-grid-demo', version: '1.0.0' } });
  if (init.body.error) throw new Error('MCP initialization failed');
  const listed = await call('tools', 'tools/list', {});
  if (!listed.body.result?.tools.some(t => t.name === 'check_grid_costs')) throw new Error('Grid tool unavailable');
  const base = { cycleNotionalUsd: '100', slippageBpsPerSwap: '0' };
  const scenarios = [
    { id: 'step-above-fees', inputs: { ...base, stepPct: '0.5', gasUsdPerCycle: '0' }, expected: ['ABOVE_MODELED_COSTS', '0.399525125'] },
    { id: 'step-below-fees', inputs: { ...base, stepPct: '0.05', gasUsdPerCycle: '0' }, expected: ['BELOW_MODELED_COSTS', '-0.0500249875'] },
    { id: 'gas-reverses-result', inputs: { ...base, stepPct: '0.5', gasUsdPerCycle: '0.4' }, expected: ['BELOW_MODELED_COSTS', '-0.000474875'] },
  ];
  for (const s of scenarios) {
    trace = [];
    let run;
    try {
      const result = await call(s.id, 'tools/call', { name: 'check_grid_costs', arguments: s.inputs });
      const value = result.body.result?.structuredContent;
      let textMatches = false;
      try { textMatches = JSON.stringify(JSON.parse(result.body.result?.content?.[0]?.text)) === JSON.stringify(value); } catch {}
      const passed = result.httpStatus === 200 && result.body.result?.isError === false && textMatches
        && value?.decision === s.expected[0] && value?.modeledNetUsd === s.expected[1] && value?.scope === 'analysis-only'
        && value?.relationship === 'first-party' && value?.block?.hashStable === true;
      run = { scenario: s.id, inputs: s.inputs, expected: s.expected, status: passed ? 'passed' : 'failed-or-unavailable',
        ...result, checks: { exactKnownCashflow: value?.modeledNetUsd === s.expected[1], textMatches, sourceBlock: value?.block ?? null } };
    } catch (error) {
      run = { scenario: s.id, inputs: s.inputs, status: 'unavailable', error: error.name };
    }
    await save(`${s.id}.rpc-observations.json`, trace);
    await save(`${s.id}.record.json`, run);
    runs.push(run);
    console.log(`${s.id}: ${run.status}`);
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const summary = { createdAt: new Date().toISOString(), operator: 'Find Your Agent', scope: 'analysis-only', registryStatus: 'unregistered-local-example',
  passed: runs.filter(r => r.status === 'passed').length, scenarios: runs.length, inputsAreHypothetical: true,
  chainReadsAreLive: true, paidCalls: 0, trades: 0, sourceHashes: hashes,
  limitation: 'Real RPC reads establish observed pool identity and fee. Scenario prices, notional, gas and slippage are assumptions. Passing the cost model is not actual profit or completed execution.' };
await save('summary.json', summary);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FYA grid-cost check</title><style>body{margin:0;background:#1d1f21;color:#dcdde0;font:16px/1.6 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:40px 24px}h1{font-size:34px;line-height:1.2}a{color:#f2ce32;text-underline-offset:3px}article{background:#272a2f;border:1px solid #3b4046;border-radius:8px;padding:24px;margin:24px 0}small{color:#aab2bd}.note{border-left:3px solid #f2ce32;padding:12px 20px;background:#272a2f}dl{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px}dd{margin:0;overflow-wrap:anywhere}pre{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}@media(max-width:600px){main{padding:24px 16px}article{padding:16px}dl{display:block}dt{font-weight:650;margin-top:12px}}@media print{body{background:white;color:#111}article,.note{background:white}article{break-inside:avoid}}</style><main><small>LOCAL PROTOTYPE · FIRST-PARTY · ANALYSIS ONLY</small><h1>FYA grid-cost check</h1><p>${summary.passed} of ${runs.length} live-read scenarios passed their known cashflow checks.</p><p class="note">This is a cost calculation for a hypothetical completed buy/sell cycle. No orders were placed and no money was sent. The pool fee and identity came from BSC; the price step and costs below are explicit assumptions.</p>${runs.map(r => { const v = r.body?.result?.structuredContent; return `<article><h2>${esc(r.scenario.replaceAll('-', ' '))}</h2><p><strong>${esc(r.status)}</strong>${v ? ' · '+esc(v.decision.replaceAll('_',' ').toLowerCase()) : ''}</p><dl><dt>Assumed starting notional</dt><dd>$${esc(r.inputs.cycleNotionalUsd)}</dd><dt>Assumed price step</dt><dd>${esc(r.inputs.stepPct)}%</dd><dt>Assumed slippage per swap</dt><dd>${esc(r.inputs.slippageBpsPerSwap)} bps</dd><dt>Assumed gas per cycle</dt><dd>$${esc(r.inputs.gasUsdPerCycle)}</dd>${v ? `<dt>Pool fee per swap</dt><dd>${esc(v.feePctPerSwap)}%</dd><dt>Modeled net per cycle</dt><dd>$${esc(v.modeledNetUsd)}</dd><dt>Modeled break-even step</dt><dd>${esc(v.modeledBreakEvenStepPct)}%</dd><dt>Observed BSC block</dt><dd>${esc(v.block.number)} · ${esc(v.block.timestamp)}</dd>` : ''}</dl><p><a href="${r.scenario}.record.json" download>Download result</a> · <a href="${r.scenario}.rpc-observations.json" download>Download original RPC reads</a></p>${v ? `<details><summary>Assumptions and limits</summary><ul>${[...v.assumptions, ...v.excludedCosts, ...v.limitations].map(s => `<li>${esc(s)}</li>`).join('')}</ul><pre>${esc(v.formula)}</pre></details>` : '<p>Read failed or was incomplete. No successful calculation is claimed.</p>'}</article>`; }).join('')}<p>Code uses the documented <a href="https://developer.pancakeswap.finance/contracts/v3/addresses">PancakeSwap factory</a> and <a href="https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-core/contracts/interfaces/pool/IPancakeV3PoolImmutables.sol">pool fee interface</a>. It verifies the fixed pool through the factory and repeats the source block-hash check.</p><p>This prototype is not registered or connected to the public marketplace.</p><p><a href="summary.json">Run summary and response hashes</a></p></main></html>`;
await fs.writeFile(path.join(directory, 'index.html'), html, { flag: 'wx' });
console.log(JSON.stringify({ output: directory, passed: summary.passed, total: summary.scenarios }));
if (summary.passed !== 3) process.exitCode = 1;
