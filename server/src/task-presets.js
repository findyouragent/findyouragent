// Reviewed public tasks, distinct from the generic interface probes. A passing
// check establishes this output's shape and scope, not independent market truth.
import { assessRangeFacts } from './range-assessment.js';

export const RANGE_ASSESSMENT_ID = 'pancake-bsc-range-assessment';
const PANCAKE_RANGE_ASSESSMENT = Object.freeze({
  id: RANGE_ASSESSMENT_ID,
  version: 1,
  title: 'Review a Pancake LP position',
  description: 'Ask this agent whether public position #7337249 is in range, then check its position and pool facts against BSC at the reported block. Analysis only; no position change.',
  inputSummary: 'BSC · PancakeSwap V3 · public USDT/WBNB position #7337249 · zero edge tolerance',
  actionLabel: 'Assess public position',
  tool: 'analyse',
  args: { tokenId: '7337249', chainId: 56, driftToleranceBps: 0 },
  chainId: 56,
  tokenId: '338475',
  inputKind: 'public-fixture',
  limitation: 'FYA checks the reported position, pool state and range membership through a separate public RPC at the provider block. This does not verify strategy quality, gas costs, profitability, approvals or ownership by you. No rebalance, payment or ongoing monitoring is performed.',
});
const BSC_VAULTS = Object.freeze({
  id: 'beefy-bsc-vaults',
  version: 1,
  title: 'Discover BSC vaults',
  description: 'Get vault names, assets and reported yield data from Beefy. Read-only research; no deposit or allocation.',
  tool: 'getVaultsWithChains',
  args: { chainNames: ['bsc'] },
  chainId: 56,
  tokenId: '45422',
  inputKind: 'public-fixture',
  limitation: 'Checks confirm the requested chain and required fields. They do not independently verify market data, returns or safety.',
});

const VENUS_ACCOUNT = Object.freeze({
  id: 'venus-bsc-account-liquidity',
  version: 1,
  title: 'Check a public Venus account',
  description: 'Read the reported borrow limit and shortfall for a public Venus CORE account on BSC. A point-in-time observation; no monitoring or repayment.',
  inputSummary: 'BSC · Venus CORE · Agripinaa Venus Guardian public account 0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173',
  actionLabel: 'Read public account',
  tool: 'getAccountLiquidity',
  args: { chainNames: ['bsc'], pool: 'CORE', userAddress: '0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173' },
  chainId: 56,
  tokenId: '43129',
  inputKind: 'public-fixture',
  limitation: 'Checks confirm BSC, Venus CORE and decimal-shaped reported values. The provider does not echo the account in its usual reply; this record preserves the request, not independent account attribution. Units and field semantics are unconfirmed. This is not a health factor, safety judgment or ongoing protection.',
});

const PANCAKE_POSITION = Object.freeze({
  id: 'pancake-bsc-lp-position',
  version: 1,
  title: 'Inspect a public Pancake position',
  description: 'Read assets, reported amounts and price range for Agripinaa Ranger\'s public PancakeSwap V3 position #7337249. No liquidity change or rebalance.',
  inputSummary: 'BSC · PancakeSwap V3 · public USDT/WBNB position #7337249',
  actionLabel: 'Read public position',
  tool: 'getLpPosition',
  args: { lpPositions: [{ chainName: 'bsc', positionId: '7337249' }] },
  chainId: 56,
  tokenId: '45650',
  inputKind: 'public-fixture',
  limitation: 'Checks confirm the requested position, protocol, asset pair and decimal-shaped reported fields. They do not independently verify current amounts, prices, ownership or returns. The historical position was created outside FYA; this task only reads it.',
});

const PANCAKE_RANGE_PREVIEW = Object.freeze({
  id: 'pancake-bsc-range-preview',
  version: 1,
  title: 'Preview a Pancake LP range',
  description: 'Preview a PancakeSwap V3 range 5% below and above the provider reference price. Analysis only; no position change.',
  inputSummary: 'BSC · PancakeSwap V3 · USDT/WBNB · 0.05% pool fee',
  actionLabel: 'Preview range',
  tool: 'getPredefinedPriceRanges',
  args: { chainName: 'bsc', token0: '0x55d398326f99059ff775485246999027b3197955', token1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', fee: 500, shortcut: 'wide' },
  chainId: 56,
  tokenId: '45650',
  inputKind: 'public-fixture',
  limitation: 'Consistency checks confirm the requested operation, reported pair label and approximate 5% range ratio. They do not independently confirm the requested chain, fee, pool identity, current price, tick alignment or an executable or profitable range; no position is changed.',
});

const PRESETS = [BSC_VAULTS, VENUS_ACCOUNT, PANCAKE_POSITION, PANCAKE_RANGE_PREVIEW, PANCAKE_RANGE_ASSESSMENT];

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const permitsLength = (schema, minKey, maxKey, length) => [minKey, maxKey].every((key) =>
  !has(schema, key) || (Number.isInteger(schema[key]) && schema[key] >= 0))
  && (schema[minKey] === undefined || schema[minKey] <= length)
  && (schema[maxKey] === undefined || schema[maxKey] >= length);

function compatible(tool) {
  if (!tool || tool.readOnly !== true) return false;
  const schema = tool.inputSchema;
  const names = schema?.properties?.chainNames;
  const items = names?.items;
  if (![schema, schema?.properties, names, items].every(record)) return false;
  if (schema?.type !== 'object' || names?.type !== 'array' || items?.type !== 'string') return false;
  // Deliberately narrow: changing the schema cannot silently change the task.
  const unsupported = ['oneOf', 'anyOf', 'allOf', 'not', '$ref', '$dynamicRef', 'if', 'then', 'else',
    'dependentSchemas', 'dependentRequired', 'dependencies', 'contains', 'prefixItems', 'patternProperties', 'propertyNames'];
  if ([schema, names, items].some((s) => unsupported.some((key) => has(s, key)))) return false;
  // Whole-object/array alternatives need a separate reviewed fixture.
  if ([schema, names].some((s) => has(s, 'enum') || has(s, 'const'))) return false;
  if (has(schema, 'required') && (!Array.isArray(schema.required) || schema.required.some((key) => key !== 'chainNames'))) return false;
  if (!permitsLength(schema, 'minProperties', 'maxProperties', 1)
      || !permitsLength(names, 'minItems', 'maxItems', 1)) return false;
  if (has(items, 'enum') && (!Array.isArray(items.enum) || !items.enum.includes('bsc'))) return false;
  if (items.const !== undefined && items.const !== 'bsc') return false;
  if (!permitsLength(items, 'minLength', 'maxLength', 3) || has(items, 'format')) return false;
  if (has(items, 'pattern')) {
    if (typeof items.pattern !== 'string') return false;
    try { if (!new RegExp(items.pattern).test('bsc')) return false; } catch { return false; }
  }
  return true;
}

// Only the schema vocabulary needed by these two reviewed fixtures is accepted.
// Unknown constraints need review; this is deliberately not a general validator.
function acceptsFixture(schema, value, rangeAssessment = false) {
  if (!record(schema)) return false;
  if (!['object', 'array', 'string', 'number', ...(rangeAssessment ? ['integer'] : [])].includes(schema.type)) return false;
  const annotations = ['title', 'description', 'default', 'examples', '$comment'];
  const allowed = {
    object: ['type', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
    array: ['type', 'items', 'minItems', 'maxItems', 'uniqueItems'],
    string: ['type', 'enum', 'const', 'minLength', 'maxLength', ...(rangeAssessment ? ['pattern'] : [])],
    number: ['type', 'enum', 'const'],
    integer: ['type', 'enum', 'const', 'minimum', 'maximum'],
  }[schema.type];
  if (Object.keys(schema).some((key) => !allowed.includes(key) && !annotations.includes(key))) return false;
  if (schema.type === 'object') {
    if (!record(value) || !record(schema.properties)) return false;
    const keys = Object.keys(value);
    if (has(schema, 'required') && (!Array.isArray(schema.required)
      || schema.required.some((key) => typeof key !== 'string' || !has(value, key)))) return false;
    if (has(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') return false;
    if (!permitsLength(schema, 'minProperties', 'maxProperties', keys.length)) return false;
    return keys.every((key) => has(schema.properties, key) && acceptsFixture(schema.properties[key], value[key], rangeAssessment));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || !permitsLength(schema, 'minItems', 'maxItems', value.length)) return false;
    if (has(schema, 'uniqueItems') && typeof schema.uniqueItems !== 'boolean') return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    return value.every((item) => acceptsFixture(schema.items, item, rangeAssessment));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || !permitsLength(schema, 'minLength', 'maxLength', value.length)) return false;
    // Only this reviewed numeric-ID pattern is supported; no arbitrary
    // provider regex runs in the request path.
    if (has(schema, 'pattern') && (schema.pattern !== '^(0|[1-9][0-9]*)$' || !/^(0|[1-9][0-9]*)$/.test(value))) return false;
    if (has(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.includes(value))) return false;
    return !has(schema, 'const') || schema.const === value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (schema.type === 'integer' && (!Number.isSafeInteger(value)
    || ['minimum', 'maximum'].some((key) => has(schema, key) && !Number.isSafeInteger(schema[key]))
    || (has(schema, 'minimum') && value < schema.minimum)
    || (has(schema, 'maximum') && value > schema.maximum))) return false;
  if (has(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.includes(value))) return false;
  return !has(schema, 'const') || schema.const === value;
}

function availablePreset(preset, tools) {
  const tool = Array.isArray(tools) ? tools.find((candidate) => candidate?.name === preset.tool) : null;
  return preset.id === BSC_VAULTS.id ? compatible(tool)
    : tool?.readOnly === true && acceptsFixture(tool.inputSchema, preset.args, preset.id === RANGE_ASSESSMENT_ID);
}

export function getTaskPresets({ chainId, tokenId, tools }) {
  return PRESETS.filter((preset) => Number(chainId) === preset.chainId && String(tokenId) === preset.tokenId)
    .map((preset) => {
      const available = availablePreset(preset, tools);
      return {
        ...structuredClone(preset),
        available,
        unavailableReason: available ? null : 'This task is unavailable because the live tool or its input requirements changed. You can inspect the other tools below.',
      };
    });
}

export function resolveTaskPreset({ chainId, tokenId, presetId, tools }) {
  return getTaskPresets({ chainId, tokenId, tools }).find((preset) => preset.id === presetId && preset.available) ?? null;
}

export function taskPayload(body) {
  if (body?.result?.structuredContent != null) return body.result.structuredContent;
  for (const part of Array.isArray(body?.result?.content) ? body.result.content : []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { return JSON.parse(part.text); } catch { /* prose is still inspectable */ }
  }
  return null;
}

const decimal = (value) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
const integer = (value) => typeof value === 'string' && /^\d+$/.test(value);
const addressEquals = (value, expected) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
function positiveDecimalParts(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const numerator = BigInt(`${whole}${fraction}`);
  return numerator > 0n ? { numerator, scale: fraction.length } : null;
}
function rangeRatioMatches(partsLower, partsUpper) {
  const scale = Math.max(partsLower.scale, partsUpper.scale);
  const lower = partsLower.numerator * 10n ** BigInt(scale - partsLower.scale);
  const upper = partsUpper.numerator * 10n ** BigInt(scale - partsUpper.scale);
  const difference = upper * 19n - lower * 21n;
  const absolute = difference < 0n ? -difference : difference;
  // Each boundary may round by one unit at its own displayed precision.
  // Also cap relative error at 1 ppm: coarse values such as 1 and 2 cannot
  // pass merely because their last-digit uncertainty is large.
  const rounding = 19n * 10n ** BigInt(scale - partsUpper.scale)
    + 21n * 10n ** BigInt(scale - partsLower.scale);
  return absolute <= rounding && absolute * 1000000n <= lower * 21n;
}
const echoedAccountMatches = (value, expected) => record(value)
  && ['userAddress', 'account', 'accountAddress', 'walletAddress', 'wallet', 'address']
    .every((key) => !has(value, key) || addressEquals(value[key], expected));

function venusChecks(preset, payload, taskMatches) {
  const groups = payload?.data;
  const scoped = Array.isArray(groups) && groups.length === 1;
  return [
    { id: 'task', label: 'Reply identifies the requested Venus account lookup', passed: taskMatches('venus') },
    { id: 'scope', label: 'One BSC CORE result; any account echo matches the request', passed: scoped
      && groups.every((group) => group?.chain === 'bsc' && group?.pool === 'CORE'
        && echoedAccountMatches(group, preset.args.userAddress))
      && echoedAccountMatches(payload, preset.args.userAddress) },
    { id: 'metrics', label: 'Borrow limit and shortfall are nonnegative decimal strings', passed: scoped
      && groups.every((group) => decimal(group?.borrowLimit) && decimal(group?.shortfall)) },
  ];
}

function positionChecks(preset, payload, taskMatches) {
  const positions = payload?.data?.positions;
  const scoped = Array.isArray(positions) && positions.length === 1;
  const fields = ['amount0', 'amount1', 'pendingFee0', 'pendingFee1', 'currentPrice', 'lowerPrice', 'upperPrice'];
  const pairMatches = (p) => typeof p?.token0?.symbol === 'string' && p.token0.symbol.toLowerCase() === 'usdt'
    && addressEquals(p?.token0?.address, '0x55d398326f99059ff775485246999027b3197955')
    && typeof p?.token1?.symbol === 'string' && p.token1.symbol.toLowerCase() === 'wbnb'
    && addressEquals(p?.token1?.address, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
  return [
    { id: 'task', label: 'Reply identifies the requested concentrated-liquidity lookup', passed: taskMatches('v3pools') },
    { id: 'scope', label: 'One BSC Pancake position matches #7337249', passed: scoped && positions.every((p) =>
      p?.chainName === 'bsc' && p?.protocol === 'Pancake' && p?.positionId === preset.args.lpPositions[0].positionId) },
    { id: 'assets', label: 'The reported USDT/WBNB assets and 0.05% fee match the public fixture', passed: scoped
      && positions.every((p) => pairMatches(p) && p?.fee === '0.05%') },
    { id: 'metrics', label: 'Liquidity, amounts, fees and prices preserve nonnegative decimal precision', passed: scoped
      && positions.every((p) => integer(p?.liquidity) && fields.every((field) => decimal(p?.[field]))) },
  ];
}

function rangePreviewChecks(preset, payload, taskMatches) {
  const data = payload?.data;
  const lower = positiveDecimalParts(data?.lowerPrice);
  const upper = positiveDecimalParts(data?.upperPrice);
  return [
    { id: 'task', label: 'Reply identifies the requested range preview', passed: taskMatches('v3pools') },
    { id: 'pool', label: 'The reply reports the requested WBNB/USDT pair label', passed: typeof data?.pool === 'string' && data.pool.toLowerCase() === 'wbnb/usdt' },
    { id: 'bounds', label: 'The reply contains positive ordered decimal bounds', passed: Boolean(lower && upper && upper.numerator * 10n ** BigInt(Math.max(0, lower.scale - upper.scale))
      > lower.numerator * 10n ** BigInt(Math.max(0, upper.scale - lower.scale))) },
    { id: 'ratio', label: 'Bounds form a 5% band on each side of their implied midpoint', passed: Boolean(lower && upper && rangeRatioMatches(lower, upper)) },
  ];
}

export function assessTaskResult(preset, observation, body) {
  const base = { presetId: preset.id, presetVersion: preset.version, criteriaVersion: 1, checks: [] };
  if (observation.outcome === 'pending') return { ...base, status: 'pending' };
  if (observation.outcome !== 'response_received') return { ...base, status: 'failed' };
  const payload = taskPayload(body);
  const rawState = record(payload?.status) ? payload.status.state : payload?.status;
  const businessState = typeof rawState === 'string' ? rawState.toLowerCase()
    : payload?.status == null ? '' : 'invalid';
  if (['pending', 'working', 'submitted', 'accepted'].includes(businessState)) return { ...base, status: 'pending' };
  if (preset.id === RANGE_ASSESSMENT_ID) {
    if (body?.error != null || body?.result?.isError != null && body.result.isError !== false
      || payload?.success !== undefined && payload.success !== true || payload?.error != null || payload?.isError === true
      || !['', 'success', 'succeeded', 'ok', 'complete', 'completed'].includes(businessState)) {
      return { ...base, status: 'failed', checks: [{ id: 'response', label: 'Provider returned a successful task response', passed: false }], limitation: preset.limitation };
    }
    const checks = assessRangeFacts(payload, preset.args);
    return { ...base, status: checks.every((check) => check.passed) ? 'incomplete' : 'failed', checks, limitation: preset.limitation };
  }
  const taskMatches = (project) => payload?.project === project && payload?.operation === preset.tool
    && (payload?.success === undefined || payload?.success === true)
    && payload?.error == null && payload?.isError !== true
    && ['', 'success', 'succeeded', 'ok', 'complete', 'completed'].includes(businessState);
  if (preset.id !== BSC_VAULTS.id) {
    const checks = preset.id === VENUS_ACCOUNT.id ? venusChecks(preset, payload, taskMatches)
      : preset.id === PANCAKE_POSITION.id ? positionChecks(preset, payload, taskMatches)
        : preset.id === PANCAKE_RANGE_PREVIEW.id ? rangePreviewChecks(preset, payload, taskMatches)
        : [{ id: 'task', label: 'A reviewed task is required', passed: false }];
    return { ...base, status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks, limitation: preset.limitation };
  }
  const groups = payload?.data;
  const vaults = Array.isArray(groups) ? groups.flatMap((group) => Array.isArray(group?.vaults) ? group.vaults : []) : [];
  const present = (value) => typeof value === 'string' && value.trim().length > 0;
  const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const checks = [
    { id: 'task', label: 'Reply identifies the requested Beefy vault lookup', passed: payload?.project === 'beefy'
      && payload?.operation === preset.tool && (payload?.success === undefined || payload?.success === true)
      && payload?.error == null && payload?.isError !== true
      && ['', 'success', 'succeeded', 'ok', 'complete', 'completed'].includes(businessState) },
    { id: 'chain', label: 'All returned groups and vaults identify BSC', passed: Array.isArray(groups) && groups.length > 0 && groups.every((g) => g?.chain === 'bsc' && Array.isArray(g.vaults)) && vaults.every((v) => v?.chain === 'bsc') },
    { id: 'vaults', label: 'At least one vault has an identifier, name and asset', passed: vaults.length > 0 && vaults.every((v) => present(v?.id) && present(v?.name) && present(v?.token)) },
    { id: 'metrics', label: 'Every vault includes numeric reported TVL and APY', passed: vaults.length > 0 && vaults.every((v) => numeric(v?.tvl) && numeric(v?.apy)) },
  ];
  return { ...base, status: checks.every((c) => c.passed) ? 'passed' : 'failed', checks, limitation: preset.limitation };
}
