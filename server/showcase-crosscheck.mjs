import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// A narrow, reproducible read of the public fixture. No signer or transaction
// methods are present. Addresses and the ABI are from Pancake's own docs.
export const FIXTURE = Object.freeze({
  chainId: 56, tokenId: '45650', positionId: '7337249', presetId: 'pancake-bsc-lp-position',
  manager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
});
export const SOURCES = Object.freeze([
  { title: 'PancakeSwap v3 deployment addresses', url: 'https://developer.pancakeswap.finance/contracts/v3/addresses' },
  { title: 'PancakeSwap positions view ABI', url: 'https://developer.pancakeswap.finance/contracts/v3/nonfungiblepositionmanager' },
  { title: 'PancakeSwap TickMath implementation', url: 'https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-core/contracts/libraries/TickMath.sol' },
  { title: 'BNB Chain public RPC endpoints', url: 'https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/' },
]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equalAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const escaped = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function positionsCall(positionId = FIXTURE.positionId) {
  if (!/^\d+$/.test(positionId) || BigInt(positionId) >= 2n ** 256n) throw new Error('Invalid uint256 position ID');
  // keccak256("positions(uint256)")[0:4], independently checked with ethers 5.
  return `0x99fbab88${BigInt(positionId).toString(16).padStart(64, '0')}`;
}

function words(raw, count) {
  if (typeof raw !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${64 * count}}$`).test(raw)) throw new Error(`Expected ${count} ABI words`);
  return raw.slice(2).match(/.{64}/g).map((word) => BigInt(`0x${word}`));
}
function uint(value, bits) {
  if (value >= 2n ** BigInt(bits)) throw new Error(`Invalid uint${bits}`);
  return value;
}
function int24(value) {
  const result = BigInt.asIntN(24, value);
  if (BigInt.asUintN(256, result) !== value) throw new Error('Invalid int24 sign extension');
  return Number(result);
}
function address(value) { return `0x${uint(value, 160).toString(16).padStart(40, '0')}`; }

export function decodePosition(raw) {
  const w = words(raw, 12);
  const decoded = {
    nonce: uint(w[0], 96).toString(), operator: address(w[1]), token0: address(w[2]), token1: address(w[3]),
    fee: Number(uint(w[4], 24)), tickLower: int24(w[5]), tickUpper: int24(w[6]),
    liquidity: uint(w[7], 128).toString(), feeGrowthInside0LastX128: w[8].toString(),
    feeGrowthInside1LastX128: w[9].toString(), tokensOwed0: uint(w[10], 128).toString(), tokensOwed1: uint(w[11], 128).toString(),
  };
  if (decoded.tickLower >= decoded.tickUpper || decoded.tickLower < -887272 || decoded.tickUpper > 887272) throw new Error('Invalid position tick range');
  return decoded;
}

export function providerPosition(record) {
  const body = record?.response?.body ?? record?.body;
  let payload = body?.result?.structuredContent;
  if (payload == null) {
    for (const part of body?.result?.content ?? []) {
      if (part.type !== 'text') continue;
      try { payload = JSON.parse(part.text); break; } catch { /* no structured position */ }
    }
  }
  if (payload?.project !== 'v3pools' || payload?.operation !== 'getLpPosition'
    || payload?.data?.positions?.length !== 1) return null;
  return payload.data.positions[0];
}

export function comparePosition(record, chain) {
  const p = providerPosition(record);
  const checks = [];
  const check = (id, label, status, detail, critical = true) => checks.push({ id, label, status, critical, detail });
  if (!p) {
    check('provider-output', 'Captured provider position', 'unknown', 'No usable position payload was captured.');
    return checks;
  }
  check('fixture', 'Requested BSC Pancake position identity', p.chainName === 'bsc' && p.protocol === 'Pancake'
    && p.positionId === FIXTURE.positionId ? 'passed' : 'failed', `Provider identifies ${p.chainName}/${p.protocol}/#${p.positionId}.`);
  if (!chain?.position || chain.chainId !== 56) {
    check('rpc-position', 'Direct BSC position read', 'unknown', 'No decoded position from a confirmed BSC RPC was available.');
    return checks;
  }
  for (const field of ['token0', 'token1']) check(field, `${field} contract address`, equalAddress(p[field]?.address, chain.position[field]) ? 'passed' : 'failed',
    `Provider: ${p[field]?.address}; contract at block ${chain.block.numberDecimal}: ${chain.position[field]}.`);
  const fee = `${chain.position.fee / 10000}%`;
  check('fee', 'Pool fee tier', p.fee === fee ? 'passed' : 'failed', `Provider: ${p.fee}; contract: ${chain.position.fee} millionths (${fee}).`);
  for (const side of ['lower', 'upper']) {
    const tick = chain.position[side === 'lower' ? 'tickLower' : 'tickUpper'];
    if (!Number.isInteger(chain.decimals0) || !Number.isInteger(chain.decimals1)) {
      check(`${side}-range`, `${side} price from immutable tick`, 'unknown', 'Token decimals could not be read at the reference block.');
      continue;
    }
    const expected = 1.0001 ** tick * 10 ** (chain.decimals0 - chain.decimals1);
    const actual = Number(p[`${side}Price`]);
    const relativeError = Math.abs(actual - expected) / expected;
    check(`${side}-range`, `${side} price from immutable tick`, Number.isFinite(actual) && actual > 0 && relativeError <= 1e-9 ? 'passed' : 'failed',
      `Tick ${tick}; derived token1 per token0 price ${expected}; reported ${p[`${side}Price`]}; relative tolerance 1e-9. Floating-point corroboration, not bit-exact arithmetic.`);
  }
  check('liquidity', 'Liquidity at the later reference block', p.liquidity === chain.position.liquidity ? 'passed' : 'unknown',
    `Provider: ${p.liquidity}; RPC: ${chain.position.liquidity}. Provider source block is absent; a difference may be a later liquidity change.`, false);
  check('same-block', 'Provider and RPC share a block', 'unknown', 'Provider output contains no source block number or hash. Same-block agreement is not established.', false);
  check('dynamic-values', 'Amounts, pending fees and current price', 'unknown', 'Not independently checked: pool state and provider sampling block are not aligned. tokensOwed fields are not a substitute for accrued pending fees.', false);
  return checks;
}

export function verdict(checks) {
  if (checks.some((c) => c.critical && c.status === 'failed')) return 'failed';
  if (!checks.length || checks.some((c) => c.critical && c.status === 'unknown')) return 'incomplete';
  return 'corroborated-with-limits';
}

// The caller supplies only a read-only transport. Signature:
// rpcCall(evidenceName, method, params) -> Promise<JSON-RPC result|null>.
// All ABI logic lives here so a local reference provider can reuse it.
export async function readReferencePosition(rpcCall) {
  const chain = {};
  const chainId = await rpcCall('03-rpc-chain-id', 'eth_chainId', []);
  if (/^0x[\da-f]+$/i.test(chainId ?? '')) chain.chainId = Number(BigInt(chainId));
  if (chain.chainId !== 56) return chain;
  const block = await rpcCall('04-rpc-block', 'eth_getBlockByNumber', ['latest', false]);
  if (!/^0x[\da-f]+$/i.test(block?.number ?? '') || !/^0x[\da-f]{64}$/i.test(block?.hash ?? '') || !/^0x[\da-f]+$/i.test(block?.timestamp ?? '')) return chain;
  chain.block = { number: block.number, numberDecimal: BigInt(block.number).toString(), hash: block.hash, timestamp: block.timestamp,
    timestampUtc: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), tag: 'latest' };
  const result = await rpcCall('05-rpc-position', 'eth_call', [{ to: FIXTURE.manager, data: positionsCall() }, block.number]);
  try { chain.position = decodePosition(result); } catch (error) { chain.decodeError = error.message; }
  if (chain.position) {
    for (const [index, token] of [[0, chain.position.token0], [1, chain.position.token1]]) {
      const result = await rpcCall(`0${6 + index}-rpc-token${index}-decimals`, 'eth_call', [{ to: token, data: '0x313ce567' }, block.number]);
      try { chain[`decimals${index}`] = Number(uint(words(result, 1)[0], 8)); } catch { /* unknown */ }
    }
  }
  // Detect a reorg during the capture; all calls above use the same number.
  const confirmed = await rpcCall('08-rpc-block-confirmation', 'eth_getBlockByNumber', [block.number, false]);
  chain.block.hashStable = confirmed?.hash === block.hash;
  return chain;
}

export async function replayCrosscheck(directory) {
  const output = path.resolve(directory);
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  if (report.recordType !== 'fya-public-position-crosscheck') throw new Error('Unsupported record');
  async function read(name) {
    // Evidence paths are filenames, never executable instructions or paths out.
    if (typeof name !== 'string' || path.basename(name) !== name || /[\\/]/.test(name)) throw new Error('Unsafe evidence path');
    return fs.readFile(path.join(output, name));
  }
  for (const file of report.files ?? []) {
    const bytes = await read(file.path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Hash mismatch: ${file.path}`);
  }
  const available = new Set((report.files ?? []).map((f) => f.path));
  async function recordedRpc(name, method, params) {
    const requestFile = `${name}.request.json`;
    if (!available.has(requestFile)) return null;
    const attempt = JSON.parse((await read(requestFile)).toString('utf8'));
    if (attempt.request?.method !== method || JSON.stringify(attempt.request?.params) !== JSON.stringify(params)) throw new Error(`Recorded RPC request changed: ${name}`);
    if (!attempt.ok || !attempt.response) return null;
    if (!available.has(attempt.response.path)) throw new Error(`Unhashed response: ${name}`);
    const body = JSON.parse((await read(attempt.response.path)).toString('utf8'));
    return body.jsonrpc === '2.0' && body.id === attempt.request.id && !body.error ? body.result : null;
  }
  if (!available.has('selected-provider-record.json')) throw new Error('Unhashed provider record');
  const providerRecord = JSON.parse((await read('selected-provider-record.json')).toString('utf8'));
  const chain = await readReferencePosition(recordedRpc);
  const checks = comparePosition(providerRecord, chain);
  if (chain.chainId != null && chain.chainId !== 56) checks.push({ id: 'chain', label: 'RPC chain identity', status: 'failed', critical: true, detail: `Expected chain 56; received ${chain.chainId}.` });
  if (chain.block && !chain.block.hashStable) checks.push({ id: 'block-stability', label: 'Reference block hash remained stable', status: 'unknown', critical: true, detail: 'Block confirmation missing or hash changed; rerun before trusting the read.' });
  const reconstructedVerdict = verdict(checks);
  if (JSON.stringify(checks) !== JSON.stringify(report.checks) || reconstructedVerdict !== report.verdict) throw new Error('Recorded verdict differs from raw-response replay');
  return { verdict: reconstructedVerdict, verifiedFiles: available.size, replayMatches: true, checks };
}

export function renderReport(report) {
  const rows = report.checks.map((c) => `<tr><th>${escaped(c.label)}</th><td class="${c.status}">${escaped(c.status)}</td><td>${escaped(c.detail)}</td></tr>`).join('');
  const title = report.verdict === 'corroborated-with-limits' ? 'Corroborated, with limits' : report.verdict;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FYA position cross-check</title>
<style>body{max-width:1100px;margin:40px auto;padding:0 24px;background:#171b21;color:#ecedf2;font:16px/1.6 system-ui}a{color:#f4d544}h1{font-size:32px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #49505c;vertical-align:top;overflow-wrap:anywhere}th{width:24%}td:nth-child(2){white-space:nowrap}.passed{color:#7cdfb3}.failed{color:#ff8585}.unknown{color:#f4d544}code{overflow-wrap:anywhere}@media(max-width:650px){h1{font-size:28px}table,tbody,tr,td,th{display:block}th,td{padding:7px;border:0}th{width:auto}tr{border-bottom:1px solid #49505c}}</style>
<h1>Public Pancake position cross-check</h1><p><strong>${escaped(title)}</strong> · ${escaped(report.finishedAt)}</p>
<p>${escaped(report.summary)}</p><p>Fixture #7337249 · BSC · one reviewed read. No wallet, transaction, liquidity change or paid hire.</p>
<p><a href="report.json">Full report and provenance</a> · <a href="selected-provider-record.json">Selected provider record</a></p>
<table><tbody>${rows}</tbody></table><h2>Interpretation</h2><ul>${report.limits.map((s) => `<li>${escaped(s)}</li>`).join('')}</ul>
<h2>Primary references</h2><ul>${SOURCES.map((s) => `<li><a href="${s.url}">${escaped(s.title)}</a></li>`).join('')}</ul>
<p>Reproduce: <code>node server/showcase-crosscheck.mjs --api http://127.0.0.1:8787 --rpc https://bsc-dataseed.bnbchain.org --out output/showcase-new-run</code></p></html>`;
}

export async function runCrosscheck({ api = 'http://127.0.0.1:8787', rpc, out, historical, noProvider = false }) {
  if (!rpc || !out) throw new Error('--rpc and --out are required');
  const rpcUrl = new URL(rpc);
  if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password) throw new Error('RPC must be an HTTPS URL without credentials');
  const output = path.resolve(out);
  // Never overwrite a previous observation, including failed attempts.
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { recursive: false });
  const startedAt = new Date().toISOString();
  let gitHead = null; let gitStatus = null;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    gitStatus = execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* provenance stays explicitly unknown */ }
  const files = [];
  async function save(name, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
    await fs.writeFile(path.join(output, name), bytes);
    const ref = { path: name, bytes: bytes.length, sha256: hash(bytes) };
    files.push(ref); return ref;
  }
  await save('source-showcase-crosscheck.mjs', await fs.readFile(fileURLToPath(import.meta.url)));
  const attempts = [];
  async function capture(name, url, request, timeoutMs = 35000) {
    const attempt = { name, url, method: request ? 'POST' : 'GET', request: request ?? null, startedAt: new Date().toISOString() };
    try {
      const response = await fetch(url, { method: attempt.method, headers: request ? { 'Content-Type': 'application/json' } : {},
        body: request ? JSON.stringify(request) : undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      const bytes = Buffer.from(await response.arrayBuffer());
      attempt.httpStatus = response.status;
      attempt.ok = response.ok;
      attempt.response = await save(`${name}.response.json`, bytes);
      try { attempt.parsed = JSON.parse(bytes.toString('utf8')); } catch { attempt.parseError = 'Response is not JSON'; }
    } catch (error) { attempt.error = { name: error.name, message: error.message, code: error.cause?.code ?? null }; }
    attempt.finishedAt = new Date().toISOString();
    const { parsed, ...saved } = attempt;
    await save(`${name}.request.json`, saved);
    attempts.push(saved);
    return attempt;
  }
  let providerRecord = null; let providerSelection = 'none';
  if (!noProvider) {
    const discovery = await capture('01-fya-interface', `${api.replace(/\/$/, '')}/api/try/56/45650/interface`);
    if (discovery.ok && discovery.parsed?.taskPresets?.some((p) => p.id === FIXTURE.presetId && p.available === true)) {
      const task = await capture('02-fya-task', `${api.replace(/\/$/, '')}/api/try/56/45650`, { presetId: FIXTURE.presetId }, 105000);
      if (task.ok && task.parsed?.captureComplete === true && task.parsed?.observation?.task?.status === 'passed' && providerPosition(task.parsed)) {
        providerRecord = task.parsed; providerSelection = 'fresh-local-fya-read';
      }
    }
  }
  if (!providerRecord && historical) {
    const original = await fs.readFile(historical);
    await save('historical-original.json', original);
    providerRecord = JSON.parse(original.toString('utf8'));
    providerSelection = 'historical-provider-capture';
  }
  await save('selected-provider-record.json', providerRecord);
  let rpcId = 0;
  async function rpcCall(name, method, params) {
    const response = await capture(name, rpc, { jsonrpc: '2.0', id: ++rpcId, method, params });
    if (!response.ok || response.parsed?.error || response.parsed?.id !== rpcId || response.parsed?.jsonrpc !== '2.0') return null;
    return response.parsed?.result ?? null;
  }
  const chain = await readReferencePosition(rpcCall);
  const checks = comparePosition(providerRecord, chain);
  if (chain.chainId != null && chain.chainId !== 56) checks.push({ id: 'chain', label: 'RPC chain identity', status: 'failed', critical: true, detail: `Expected chain 56; received ${chain.chainId}.` });
  if (chain.block && !chain.block.hashStable) checks.push({ id: 'block-stability', label: 'Reference block hash remained stable', status: 'unknown', critical: true, detail: 'Block confirmation missing or hash changed; rerun before trusting the read.' });
  const report = {
    schemaVersion: 1, recordType: 'fya-public-position-crosscheck', startedAt, finishedAt: new Date().toISOString(), fixture: FIXTURE,
    providerSelection, providerObservedAt: providerRecord?.observation?.finishedAt ?? null,
    provenance: { gitHead, dirty: gitStatus == null ? null : Boolean(gitStatus.trim()), gitStatus, captureSourceRevision: gitHead,
      originalProviderCaptureRevision: providerSelection === 'historical-provider-capture' ? null : gitHead,
      note: 'The live local server may contain uncommitted changes. The git revision names the checkout, not a clean deployment.' },
    rpc: { endpoint: rpc, ...chain }, checks, verdict: verdict(checks), attempts, files, sources: SOURCES,
    summary: 'Direct protocol RPC corroboration of a public agent read. This is an FYA-authored cross-check using a separate data path, not an independently operated benchmark or an independent provider.',
    limits: [
      'The agent provider and RPC do not identify the same sampling block. Identity and immutable range can be corroborated; a liquidity match is only agreement with the later reference state.',
      'Amounts, pending fees, current price, returns and safety are not independently established by this report.',
      'The node is a public RPC trust dependency. This is not a cryptographic storage proof or an externally audited benchmark.',
      'A historical fallback remains dated evidence. Failures are retained and are not converted into a fresh successful task.',
      'The provider is HeyAnon-associated. This cross-check does not establish another independently operated agent, a paid hire, a transaction, or BORT partner-track completion.',
    ],
  };
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(output, 'index.html'), renderReport(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--no-provider') options.noProvider = true;
    else if (['--api', '--rpc', '--out', '--historical', '--replay'].includes(flag) && process.argv[i + 1]) options[flag.slice(2)] = process.argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  try {
    const report = options.replay ? await replayCrosscheck(options.replay) : await runCrosscheck(options);
    console.log(JSON.stringify({ verdict: report.verdict, providerSelection: report.providerSelection, replayMatches: report.replayMatches, verifiedFiles: report.verifiedFiles,
      checks: report.checks.map(({ id, status }) => ({ id, status })), output: options.out ?? options.replay }, null, 2));
    process.exitCode = report.verdict === 'failed' ? 1 : report.verdict === 'incomplete' ? 2 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
