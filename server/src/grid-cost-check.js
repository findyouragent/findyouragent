import { createHash } from 'node:crypto';

// First-party reference analysis. Fixed pool and RPC; no caller destinations,
// keys, paid providers, order construction or transaction methods are accepted.
export const GRID_POOL = Object.freeze({
  chainId: 56, address: '0x36696169c63e42cd08ce11f5deebbcebae652050',
  factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  token0: '0x55d398326f99059ff775485246999027b3197955',
  token1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  pair: 'USDT/WBNB', feePpm: 500,
});
export const GRID_RPC_URL = 'https://bsc-dataseed.bnbchain.org';
const SCALE = 1000000n;
const DECIMAL_PATTERN = '^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,6})?$';
const fields = ['stepPct', 'cycleNotionalUsd', 'slippageBpsPerSwap', 'gasUsdPerCycle'];
export const GRID_COST_TOOL = Object.freeze({
  name: 'check_grid_costs',
  description: 'Analyze one hypothetical buy-then-sell grid cycle on the fixed BSC USDT/WBNB pool. Reads the pool fee; cost and price-step inputs are assumptions. First-party, analysis-only; no trades.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: fields,
    properties: {
      stepPct: { type: 'string', pattern: DECIMAL_PATTERN, description: 'Assumed sale-price increase versus buy price, percent; 0 to 100.' },
      cycleNotionalUsd: { type: 'string', pattern: DECIMAL_PATTERN, description: 'Hypothetical starting quote notional, USD; greater than 0, at most 1000000. Assumes USDT = 1 USD.' },
      slippageBpsPerSwap: { type: 'string', pattern: DECIMAL_PATTERN, description: 'Assumed adverse output slippage on each of two swaps, bps; 0 to 1000. Zero explicitly excludes this cost.' },
      gasUsdPerCycle: { type: 'string', pattern: DECIMAL_PATTERN, description: 'Assumed total gas for both swaps, USD; 0 to 1000000. Zero explicitly excludes this cost.' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
});

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function units(value) {
  if (typeof value !== 'string' || !new RegExp(DECIMAL_PATTERN).test(value)) throw new Error('Use decimal strings with at most six decimal places');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
export function validateGridCostInputs(input) {
  if (!record(input) || Object.keys(input).length !== fields.length || !fields.every(k => Object.hasOwn(input, k))) throw new Error('Four explicit grid-cost inputs are required');
  const v = Object.fromEntries(fields.map(k => [k, units(input[k])]));
  if (v.stepPct > 100n * SCALE || v.cycleNotionalUsd === 0n || v.cycleNotionalUsd > 1000000n * SCALE
    || v.slippageBpsPerSwap > 1000n * SCALE || v.gasUsdPerCycle > 1000000n * SCALE) throw new Error('Grid-cost input is outside the supported range');
  return { ...input };
}
function decimal(numerator, denominator) {
  const negative = numerator < 0n;
  const scaled = (negative ? -numerator : numerator) * 10n ** 18n / denominator;
  const digits = scaled.toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return `${negative && scaled !== 0n ? '-' : ''}${digits.slice(0, -18)}${fraction ? '.' + fraction : ''}`;
}

// Exact rational arithmetic drives the decision; decimal displays truncate to
// 18 places. The model is two fully filled swaps, not a profitability forecast.
export function calculateGridCosts(input, feePpm) {
  const inputs = validateGridCostInputs(input);
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1000000) throw new Error('Invalid pool fee');
  const v = Object.fromEntries(fields.map(k => [k, units(inputs[k])]));
  const feeN = (1000000n - BigInt(feePpm)) ** 2n, feeD = 1000000n ** 2n;
  const slipD = 10000n * SCALE, slipN = slipD - v.slippageBpsPerSwap;
  const retentionN = feeN * slipN ** 2n, retentionD = feeD * slipD ** 2n;
  const stepD = 100n * SCALE;
  const returnedN = v.cycleNotionalUsd * (stepD + v.stepPct) * retentionN;
  const returnedD = stepD * retentionD;
  const netN = returnedN - (v.cycleNotionalUsd + v.gasUsdPerCycle) * returnedD;
  const netD = returnedD * SCALE;
  const breakN = ((v.cycleNotionalUsd + v.gasUsdPerCycle) * retentionD - v.cycleNotionalUsd * retentionN) * 100n;
  const breakD = v.cycleNotionalUsd * retentionN;
  return {
    inputs, model: 'FYA_TWO_SWAP_COST_V1', scope: 'analysis-only', feePpm,
    feePctPerSwap: decimal(BigInt(feePpm), 10000n),
    decision: netN > 0n ? 'ABOVE_MODELED_COSTS' : netN < 0n ? 'BELOW_MODELED_COSTS' : 'AT_MODELED_BREAK_EVEN',
    modeledNetUsd: decimal(netN, netD), modeledQuoteReturnedBeforeGasUsd: decimal(returnedN, returnedD * SCALE),
    feeOnlyBreakEvenStepPct: decimal((feeD - feeN) * 100n, feeN),
    modeledBreakEvenStepPct: decimal(breakN, breakD),
    exactNetUsd: { numerator: netN.toString(), denominator: netD.toString() },
    formula: 'netUSD = notionalUSD * ((1 + stepPct/100) * (1 - feePpm/1000000)^2 * (1 - slippageBpsPerSwap/10000)^2 - 1) - gasUSDPerCycle',
    assumptions: [
      'One complete quote-to-base buy and base-to-quote sell, with the sale price higher by stepPct.',
      'Both swaps use the same fee tier; assumed adverse output slippage applies separately to each swap.',
      'USDT is modeled as 1 USD; notional, future price step, gas and slippage are user assumptions, not measured values.',
      'No claim that the price reaches a level or that a swap fills. No inventory, volatility, liquidity or execution simulation.',
    ],
    excludedCosts: [
      ...(v.slippageBpsPerSwap === 0n ? ['Slippage is explicitly set to zero.'] : []),
      ...(v.gasUsdPerCycle === 0n ? ['Gas is explicitly set to zero.'] : []),
      'Price impact beyond the supplied slippage assumption, token transfer taxes, failed transactions and adverse inventory moves are not modeled.',
    ],
    precision: 'Exact rational decision; displayed amounts and percentages truncate to 18 decimal places.',
  };
}

const quantity = v => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v);
function blockIdentity(raw, nowMs) {
  if (!record(raw) || !quantity(raw.number) || !quantity(raw.timestamp) || !/^0x[0-9a-f]{64}$/i.test(raw.hash ?? '')) throw new Error('Invalid BSC block');
  const seconds = Number(BigInt(raw.timestamp));
  const age = nowMs / 1000 - seconds;
  if (!Number.isSafeInteger(seconds) || age < -15 || age > 120) throw new Error('BSC block is not recent');
  return { number: BigInt(raw.number).toString(), hexNumber: raw.number, hash: raw.hash.toLowerCase(), timestamp: new Date(seconds * 1000).toISOString() };
}
function abiUint(raw, bits) {
  if (typeof raw !== 'string' || !/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error('Invalid ABI word');
  const n = BigInt(raw);
  if (n >= 2n ** BigInt(bits)) throw new Error('ABI value outside range');
  return n;
}
const abiAddress = raw => `0x${abiUint(raw, 160).toString(16).padStart(40, '0')}`;
const word = v => BigInt(v).toString(16).padStart(64, '0');

export async function readGridCostCheck(input, { fetchImpl = fetch, now = Date.now, onObservation = () => {} } = {}) {
  const inputs = validateGridCostInputs(input);
  const startedAt = new Date(now()).toISOString();
  const overall = AbortSignal.timeout(45000);
  const evidence = []; let id = 0;
  async function rpc(method, params) {
    const request = { jsonrpc: '2.0', id: ++id, method, params };
    const observedAt = new Date(now()).toISOString();
    const reply = await fetchImpl(GRID_RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.any([overall, AbortSignal.timeout(10000)]), body: JSON.stringify(request),
    });
    if (!reply.body) throw new Error('Public RPC response is incomplete');
    const reader = reply.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 65536) throw new Error('Public RPC response exceeded limit');
        chunks.push(Buffer.from(next.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const raw = Buffer.concat(chunks);
    const entry = { observedAt, request, httpStatus: reply.status, responseText: raw.toString('utf8'), sha256: createHash('sha256').update(raw).digest('hex') };
    evidence.push(entry); onObservation(entry);
    if (!reply.ok) throw new Error('Public RPC failed');
    const body = JSON.parse(entry.responseText);
    if (body?.jsonrpc !== '2.0' || body.id !== request.id || body.error || body.result == null) throw new Error('Public RPC read failed validation');
    return body.result;
  }
  const chain = await rpc('eth_chainId', []);
  if (!quantity(chain) || BigInt(chain) !== 56n) throw new Error('Expected BSC mainnet');
  const block = blockIdentity(await rpc('eth_getBlockByNumber', ['latest', false]), now());
  const call = (to, data) => rpc('eth_call', [{ to, data }, block.hexNumber]);
  const poolReads = await Promise.allSettled([
    call(GRID_POOL.address, '0xddca3f43'), call(GRID_POOL.address, '0x0dfe1681'), call(GRID_POOL.address, '0xd21220a7'),
  ]);
  // Finish every bounded read before failing, so evidence callbacks cannot
  // arrive after a caller has started recording its next scenario.
  const failedRead = poolReads.find(result => result.status === 'rejected');
  if (failedRead) throw failedRead.reason;
  const [feeRaw, token0Raw, token1Raw] = poolReads.map(result => result.value);
  const fee = Number(abiUint(feeRaw, 24));
  if (fee !== GRID_POOL.feePpm || abiAddress(token0Raw) !== GRID_POOL.token0 || abiAddress(token1Raw) !== GRID_POOL.token1) throw new Error('Reference pool identity mismatch');
  const registeredPool = abiAddress(await call(GRID_POOL.factory, `0x1698ee82${word(GRID_POOL.token0)}${word(GRID_POOL.token1)}${word(fee)}`));
  if (registeredPool !== GRID_POOL.address) throw new Error('Factory does not identify the reference pool');
  const after = blockIdentity(await rpc('eth_getBlockByNumber', [block.hexNumber, false]), now());
  if (after.number !== block.number || after.hash !== block.hash || after.timestamp !== block.timestamp) throw new Error('BSC block changed during read');
  return {
    version: 1, operation: GRID_COST_TOOL.name, operator: 'Find Your Agent', relationship: 'first-party',
    registryStatus: 'unregistered-local-example', paidDelivery: false, executionTrackEvidence: false, transactions: [],
    startedAt, finishedAt: new Date(now()).toISOString(),
    source: { kind: 'public-chain-rpc', endpoint: GRID_RPC_URL, chainId: 56 },
    pool: { ...GRID_POOL }, block: { ...block, hashStable: true }, ...calculateGridCosts(inputs, fee), evidence,
    limitations: [
      'Analysis only. Above modeled costs does not mean profitable, safe, recommended or executable.',
      'A public RPC observation with a repeated block-hash check, not an independently verified blockchain proof or finalized block.',
      'Pool identity and fee are read from chain. Future prices and the other cost inputs are assumed.',
      'A first-party local reference tool; not independent provider supply, an ERC-8004 listing, a paid hire or execution-track evidence.',
    ],
  };
}
