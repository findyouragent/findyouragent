import { createHash } from 'node:crypto';
import { config } from './config.js';

// This module deliberately contains only read-only checks for one public,
// reproducible Pancake v3 position.  None of the addresses below can be
// supplied by a provider response or by a caller of corroborateRangeFacts.
export const RANGE_FIXTURE = Object.freeze({
  operation: 'analyse',
  chainId: 56,
  positionId: '7337249',
  manager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
  pool: '0x36696169c63e42cd08ce11f5deebbcebae652050',
  factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  token0: '0x55d398326f99059ff775485246999027b3197955',
  token1: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  fee: 500,
  tickLower: -66690,
  tickUpper: -65710,
  driftToleranceBps: 0,
});

export const RANGE_RPC_URL = config.bscRpcUrl;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CHILD_DEADLINE_MS = 14_500;
const MAX_TICK = 887272;
const WORD = 64;
const POSITIONS_SELECTOR = '0x99fbab88';
const GET_POOL_SELECTOR = '0x1698ee82';
const SLOT0_SELECTOR = '0x3850c7bd';
const TICK_SPACING_SELECTOR = '0xd0c93a7c';

const ids = Object.freeze([
  'operation', 'chain', 'position', 'token0', 'token1', 'fee', 'ticks',
  'liquidity', 'drift-tolerance', 'membership', 'decision',
]);

const labels = Object.freeze({
  operation: 'Analyse operation', chain: 'BSC chain identity',
  position: 'Position identity', token0: 'Token0 contract address',
  token1: 'Token1 contract address', fee: 'Pool fee tier',
  ticks: 'Position tick bounds', liquidity: 'Position liquidity',
  'drift-tolerance': 'Zero drift tolerance', membership: 'Current tick membership',
  decision: 'Provider range decision',
});

function check(id, passed) { return { id, label: labels[id], passed: Boolean(passed) }; }
function failedChecks() { return ids.map((id) => check(id, false)); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
    && a.toLowerCase() === b.toLowerCase();
}
function exactString(value, expected) { return typeof value === 'string' && value === expected; }
function finiteTree(value, seen = new Set()) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.values(value).every((item) => finiteTree(item, seen));
}
function canonicalUintString(value, bits) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try { return BigInt(value) < (1n << BigInt(bits)); } catch { return false; }
}

function unwrapStructured(payload) {
  if (isObject(payload?.result?.structuredContent)) return payload.result.structuredContent;
  if (isObject(payload?.body?.result?.structuredContent)) return payload.body.result.structuredContent;
  return payload;
}

function operationIsAnalyse(p) {
  // Hallmark's structuredContent calls this field `skill`; accept an explicit
  // operation alias only when it is present and exact, so a changed operation
  // can never be silently ignored.
  return p.skill === RANGE_FIXTURE.operation
    && (!Object.prototype.hasOwnProperty.call(p, 'operation') || p.operation === RANGE_FIXTURE.operation);
}

function providerFacts(payload) {
  const p = unwrapStructured(payload);
  if (!isObject(p) || !isObject(p.subject) || !isObject(p.facts)
    || !isObject(p.facts.position) || !isObject(p.facts.pool)
    || !isObject(p.decision) || !isObject(p.decision.current)
    || !isObject(p.decision.drift)) return null;
  if (p.success === false || p.isError === true || (p.error != null)
    || (Object.prototype.hasOwnProperty.call(p, 'status')
      && !['passed', 'success', 'ok', 'complete', 'completed'].includes(p.status))) return null;
  const pos = p.facts.position;
  const pool = p.facts.pool;
  const current = p.decision.current;
  const drift = p.decision.drift;
  const token0 = pos.token0;
  const token1 = pos.token1;
  if (!isObject(token0) || !isObject(token1) || !finiteTree(p)) return null;
  // Every numeric fact used by the checks is intentionally strict.  This also
  // rejects NaN/Infinity injected into otherwise plausible provider objects.
  const ints = [p.chainId, pos.fee, pos.tickSpacing, pos.tickLower, pos.tickUpper,
    current.tickLower, current.tickUpper, current.widthTicks, drift.currentTick, pool.tick];
  if (ints.some((v) => !Number.isInteger(v)) || !Number.isInteger(RANGE_FIXTURE.driftToleranceBps)
    || p.decision.inRange !== true && p.decision.inRange !== false) return null;
  if (!canonicalUintString(pos.liquidity, 128) || !canonicalUintString(pool.sqrtPriceX96, 160)
    || BigInt(pool.sqrtPriceX96) <= 0n || typeof p.subject.tokenId !== 'string' || p.subject.tokenId.length === 0) return null;
  if (typeof p.observedAt !== 'string' || typeof p.blockNumber !== 'string') return null;
  return { p, pos, pool, current, drift, token0, token1 };
}

export function assessRangeFacts(payload, args = {}) {
  try {
    const f = providerFacts(payload);
    if (!f) return failedChecks();
    const { p, pos, pool, current, drift, token0, token1 } = f;
    const expected = { ...RANGE_FIXTURE, ...(isObject(args) ? args : {}) };
    // Callers may customize labels/metadata, but identity and numerical
    // expectations remain fixed unless an exact fixture value is explicitly
    // supplied.  No caller-provided address is ever used for RPC reads.
    const operation = expected.operation ?? RANGE_FIXTURE.operation;
    const chainId = expected.chainId ?? RANGE_FIXTURE.chainId;
    const positionId = expected.positionId ?? expected.tokenId ?? RANGE_FIXTURE.positionId;
    const requestedTokenId = isObject(args) && Object.prototype.hasOwnProperty.call(args, 'tokenId') ? args.tokenId : positionId;
    const token0Expected = expected.token0 ?? RANGE_FIXTURE.token0;
    const token1Expected = expected.token1 ?? RANGE_FIXTURE.token1;
    const feeExpected = expected.fee ?? RANGE_FIXTURE.fee;
    const lowerExpected = expected.tickLower ?? RANGE_FIXTURE.tickLower;
    const upperExpected = expected.tickUpper ?? RANGE_FIXTURE.tickUpper;
    const toleranceExpected = expected.driftToleranceBps ?? RANGE_FIXTURE.driftToleranceBps;
    const membership = pos.tickLower <= pool.tick && pool.tick < pos.tickUpper;
    const decisionMembership = p.decision.inRange === membership;
    const action = p.decision.action;
    const actionConsistent = action === 'hold'
      ? p.decision.inRange === true && p.decision.proposed === null
      : action === 'rebalance'
        ? p.decision.inRange === false
        : false;
    const versionConsistent = p.subject.tokenId === pos.tokenId || pos.tokenId === undefined;
    const poolConsistent = sameAddress(p.subject.pool, RANGE_FIXTURE.pool)
      && sameAddress(pos.pool, RANGE_FIXTURE.pool);
    const currentConsistent = current.tickLower === pos.tickLower && current.tickUpper === pos.tickUpper
      && drift.currentTick === pool.tick;
    const checks = [
      check('operation', operationIsAnalyse(p) && operation === RANGE_FIXTURE.operation),
      check('chain', p.chainId === chainId && p.chainId === RANGE_FIXTURE.chainId),
      check('position', requestedTokenId === RANGE_FIXTURE.positionId && p.subject.tokenId === positionId && p.subject.tokenId === RANGE_FIXTURE.positionId
        && versionConsistent && poolConsistent),
      check('token0', sameAddress(token0.address, token0Expected) && sameAddress(token0.address, RANGE_FIXTURE.token0)),
      check('token1', sameAddress(token1.address, token1Expected) && sameAddress(token1.address, RANGE_FIXTURE.token1)),
      check('fee', pos.fee === feeExpected && pos.fee === RANGE_FIXTURE.fee),
      check('ticks', pos.tickLower === lowerExpected && pos.tickLower === RANGE_FIXTURE.tickLower
        && pos.tickUpper === upperExpected && pos.tickUpper === RANGE_FIXTURE.tickUpper && pos.tickSpacing === 10
        && currentConsistent && pos.tickLower < pos.tickUpper
        && pos.tickLower >= -MAX_TICK && pos.tickUpper <= MAX_TICK),
      check('liquidity', canonicalUintString(pos.liquidity, 128)),
      check('drift-tolerance', p.decision.drift.driftToleranceBps === toleranceExpected
        && p.decision.drift.driftToleranceBps === RANGE_FIXTURE.driftToleranceBps),
      check('membership', decisionMembership),
      check('decision', decisionMembership && actionConsistent),
    ];
    // Inconsistent duplicate provider versions are a global failure.  Keep a
    // false result in every check so consumers cannot mistake partial matches
    // for a trusted fact set.
    if (!currentConsistent || !versionConsistent || !poolConsistent || !decisionMembership || !actionConsistent) return failedChecks();
    return checks;
  } catch {
    return failedChecks();
  }
}

function words(raw, count) {
  if (typeof raw !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${WORD * count}}$`).test(raw)) throw new Error('malformed ABI response');
  return raw.slice(2).match(new RegExp(`.{${WORD}}`, 'g')).map((v) => BigInt(`0x${v}`));
}
function uint(word, bits) {
  const max = 1n << BigInt(bits);
  if (word < 0n || word >= max) throw new Error('ABI integer out of bounds');
  return word;
}
function signed(word, bits) {
  const result = BigInt.asIntN(bits, word);
  if (BigInt.asUintN(256, result) !== word) throw new Error('ABI signed integer sign extension');
  return Number(result);
}
function addressWord(word) { return `0x${uint(word, 160).toString(16).padStart(40, '0')}`; }
function abiWord(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('invalid hex word');
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}
function uintHex(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error('invalid hex integer');
  return BigInt(value);
}
function blockNumberHex(decimal) {
  if (!/^\d+$/.test(decimal) || (decimal.length > 1 && decimal[0] === '0')) throw new Error('invalid provider block number');
  const value = BigInt(decimal);
  if (value > 0xffffffffffffffffn) throw new Error('provider block number is too large');
  return `0x${value.toString(16)}`;
}
function header(raw) {
  if (!isObject(raw) || typeof raw.number !== 'string' || typeof raw.hash !== 'string' || typeof raw.timestamp !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(raw.hash)) throw new Error('malformed block header');
  const number = uintHex(raw.number); const timestamp = uintHex(raw.timestamp);
  if (number > 0xffffffffffffffffn || timestamp > 0xffffffffffffffffn) throw new Error('block header out of bounds');
  return { number: number.toString(), hash: raw.hash.toLowerCase(), timestamp: timestamp.toString() };
}
function positionCall() { return `${POSITIONS_SELECTOR}${BigInt(RANGE_FIXTURE.positionId).toString(16).padStart(64, '0')}`; }
function addressArg(address) { return BigInt(address).toString(16).padStart(64, '0'); }
function factoryCall() {
  return `${GET_POOL_SELECTOR}${addressArg(RANGE_FIXTURE.token0)}${addressArg(RANGE_FIXTURE.token1)}${BigInt(RANGE_FIXTURE.fee).toString(16).padStart(64, '0')}`;
}
function decodePosition(raw) {
  const w = words(raw, 12);
  return {
    token0: addressWord(w[2]), token1: addressWord(w[3]), fee: Number(uint(w[4], 24)),
    tickLower: signed(w[5], 24), tickUpper: signed(w[6], 24), liquidity: uint(w[7], 128).toString(),
  };
}
function decodeSlot0(raw) {
  const w = words(raw, 7);
  uint(w[0], 160); const tick = signed(w[1], 24); uint(w[2], 16); uint(w[3], 16); uint(w[4], 16); uint(w[5], 32); uint(w[6], 1);
  return { sqrtPriceX96: w[0].toString(), tick };
}
function decodeTickSpacing(raw) { return signed(words(raw, 1)[0], 24); }

function withDeadline(parentSignal) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort('deadline'), CHILD_DEADLINE_MS);
  const abort = () => controller.abort(parentSignal?.reason ?? 'aborted');
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, clear() { clearTimeout(timer); timer = null; parentSignal?.removeEventListener?.('abort', abort); } };
}

async function responseTextCapped(response, signal) {
  if (!response?.body?.getReader) throw new Error('non-stream response');
  {
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    const cancelOnAbort = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancelOnAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new Error('aborted');
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        const remaining = MAX_RESPONSE_BYTES - total;
        if (remaining <= 0) { await reader.cancel(); break; }
        chunks.push(bytes.slice(0, remaining)); total += Math.min(remaining, bytes.byteLength);
        if (bytes.byteLength > remaining) { await reader.cancel(); break; }
      }
    } finally { signal.removeEventListener('abort', cancelOnAbort); reader.releaseLock?.(); }
    return Buffer.concat(chunks).toString('utf8');
  }
}

export async function corroborateRangeFacts(payload, { signal, fetchImpl = fetch, now = Date.now, rpcUrl = config.bscRpcUrl } = {}) {
  const checkedAt = (() => { try { return new Date(now()).toISOString(); } catch { return new Date(0).toISOString(); } })();
  let origin = null; try { const url = new URL(rpcUrl); if (!url.protocol.startsWith('http') || url.username || url.password) throw new Error('invalid RPC'); origin = url.origin; } catch { /* surfaced as incomplete */ }
  const result = { status: 'incomplete', checkedAt, source: { kind: 'public-chain-rpc', origin }, block: null,
    checks: [], facts: {}, evidence: [], limitation: 'Read-only corroboration of public range facts. It does not certify cost, profitability, wallet ownership, approvals, or executable provider preconditions.' };
  const assessed = assessRangeFacts(payload);
  const f = providerFacts(payload);
  if (!f) { result.checks = failedChecks().map(({ id, label }) => ({ id, label, status: 'failed' })); result.status = 'failed'; return result; }
  result.checks = assessed.map(({ id, label, passed }) => ({ id, label, status: passed ? 'passed' : 'failed' }));
  if (!assessed.every((c) => c.passed)) { result.status = 'failed'; return result; }
  if (!origin) { result.checks.push({ id: 'rpc-origin', label: 'RPC origin', status: 'incomplete' }); return result; }
  const deadline = withDeadline(signal);
  let rpcId = 0;
  const request = async (method, params) => {
    const id = ++rpcId; const req = { jsonrpc: '2.0', id, method, params };
    const evidence = { request: { method, params }, responseText: '', sha256: null, status: null };
    try {
      if (deadline.signal.aborted) throw new Error('aborted');
      const response = await fetchImpl(rpcUrl, { method: 'POST', redirect: 'error', signal: deadline.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(req) });
      evidence.status = Number.isFinite(response?.status) ? response.status : null;
      evidence.responseText = await responseTextCapped(response, deadline.signal);
      evidence.sha256 = createHash('sha256').update(evidence.responseText).digest('hex');
      result.evidence.push(evidence);
      if (evidence.status != null && (evidence.status < 200 || evidence.status >= 300)) throw new Error('http failure');
      if (evidence.responseText.length >= MAX_RESPONSE_BYTES) throw new Error('response too large');
      const parsed = JSON.parse(evidence.responseText);
      if (parsed?.jsonrpc !== '2.0' || parsed.id !== id || parsed.error || !Object.prototype.hasOwnProperty.call(parsed, 'result')) throw new Error('invalid RPC response');
      return parsed.result;
    } catch (error) {
      if (!result.evidence.includes(evidence)) {
        const safeText = evidence.responseText || '';
        evidence.responseText = safeText.slice(0, MAX_RESPONSE_BYTES);
        evidence.sha256 = createHash('sha256').update(evidence.responseText).digest('hex');
        result.evidence.push(evidence);
      }
      throw new Error(deadline.signal.aborted ? 'rpc-timeout' : 'rpc-failure');
    }
  };
  try {
    const chainHex = await request('eth_chainId', []);
    const chainId = uintHex(chainHex); result.facts.chainId = chainId.toString();
    result.checks.push({ id: 'rpc-chain', label: 'RPC chain identity', status: chainId === 56n ? 'passed' : 'failed' });
    if (chainId !== 56n) { result.status = 'failed'; return result; }
    const latest = header(await request('eth_getBlockByNumber', ['latest', false]));
    const providerBlockHex = blockNumberHex(f.p.blockNumber);
    const exact = header(await request('eth_getBlockByNumber', [providerBlockHex, false]));
    if (exact.number !== f.p.blockNumber) throw new Error('provider block number mismatch');
    result.block = exact;
    const nowMs = Number(now());
    const latestMs = Number(BigInt(latest.timestamp) * 1000n);
    const blockMs = Number(BigInt(exact.timestamp) * 1000n);
    const latestFresh = Number.isFinite(nowMs) && Number.isFinite(latestMs)
      && nowMs - latestMs <= 300_000 && latestMs - nowMs <= 30_000;
    const latestOrdered = BigInt(latest.number) >= BigInt(exact.number)
      && BigInt(exact.timestamp) <= BigInt(latest.timestamp);
    result.checks.push({ id: 'latest-header', label: 'Latest header is fresh and orders the provider block', status: latestFresh && latestOrdered ? 'passed' : 'incomplete' });
    if (!latestFresh || !latestOrdered) {
      result.checks.push({ id: 'freshness', label: 'Provider block freshness', status: 'incomplete' });
      return result;
    }
    if (!Number.isFinite(nowMs) || !Number.isFinite(blockMs) || nowMs - blockMs > 300_000 || blockMs - nowMs > 30_000) {
      result.checks.push({ id: 'freshness', label: 'Provider block freshness', status: 'incomplete' });
      return result;
    }
    result.checks.push({ id: 'freshness', label: 'Provider block freshness', status: 'passed' });
    if (latest.number === exact.number && latest.hash !== exact.hash) {
      result.checks.push({ id: 'latest-hash', label: 'Latest header agrees at provider height', status: 'incomplete' });
      return result;
    }
    const blockTag = providerBlockHex;
    const onPosition = decodePosition(await request('eth_call', [{ to: RANGE_FIXTURE.manager, data: positionCall() }, blockTag]));
    const mappedPool = addressWord(words(await request('eth_call', [{ to: RANGE_FIXTURE.factory, data: factoryCall() }, blockTag]), 1)[0]);
    const slot0 = decodeSlot0(await request('eth_call', [{ to: RANGE_FIXTURE.pool, data: SLOT0_SELECTOR }, blockTag]));
    const spacing = decodeTickSpacing(await request('eth_call', [{ to: RANGE_FIXTURE.pool, data: TICK_SPACING_SELECTOR }, blockTag]));
    result.facts.position = onPosition; result.facts.pool = { ...slot0, tickSpacing: spacing, mappedPool };
    const comparisons = [
      ['onchain-position', 'Position fields match provider facts', sameAddress(onPosition.token0, f.token0.address) && sameAddress(onPosition.token1, f.token1.address)
        && onPosition.fee === f.pos.fee && onPosition.tickLower === f.pos.tickLower && onPosition.tickUpper === f.pos.tickUpper && onPosition.liquidity === f.pos.liquidity],
      ['onchain-pool', 'Factory maps canonical pool', sameAddress(mappedPool, RANGE_FIXTURE.pool) && sameAddress(mappedPool, f.pos.pool)],
      ['onchain-state', 'Pool state matches provider facts', slot0.sqrtPriceX96 === f.pool.sqrtPriceX96 && slot0.tick === f.pool.tick && spacing === f.pos.tickSpacing],
      ['onchain-membership', 'Same-block range membership', f.pos.tickLower <= slot0.tick && slot0.tick < f.pos.tickUpper && f.p.decision.inRange === (f.pos.tickLower <= slot0.tick && slot0.tick < f.pos.tickUpper)],
    ];
    result.checks.push(...comparisons.map(([id, label, passed]) => ({ id, label, status: passed ? 'passed' : 'failed' })));
    const confirmation = header(await request('eth_getBlockByNumber', [providerBlockHex, false]));
    const stable = confirmation.hash === exact.hash;
    result.checks.push({ id: 'same-block', label: 'Reference block hash remained stable', status: stable ? 'passed' : 'incomplete' });
    if (!stable) { result.status = 'incomplete'; return result; }
    result.status = result.checks.every((c) => c.status === 'passed') ? 'passed' : 'failed';
    return result;
  } catch (error) {
    result.checks.push({ id: 'rpc-read', label: 'Bounded public RPC reads', status: 'incomplete' });
    result.status = 'incomplete';
    return result;
  } finally { deadline.clear(); }
}
