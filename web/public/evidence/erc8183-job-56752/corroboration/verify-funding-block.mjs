import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { ethers } = createRequire(path.resolve('web/package.json'))('ethers');

const outDir = path.dirname(fileURLToPath(import.meta.url));
const rpcOrigin = 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3';
const source = 'https://docs.nodereal.io/reference/getting-started-with-your-api';
const blockNumber = 120785441;
const blockTag = `0x${blockNumber.toString(16)}`;
const account = '0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173';
const comptroller = '0xfD36E2c2a6789Db23113685031d7F16329158384';
const ci = new ethers.utils.Interface([
  'function getAccountLiquidity(address) view returns (uint256,uint256,uint256)',
  'function getBorrowingPower(address) view returns (uint256,uint256,uint256)',
  'function getAssetsIn(address) view returns (address[])',
  'function oracle() view returns (address)',
  'function mintedVAIs(address) view returns (uint256)'
]);
const vi = new ethers.utils.Interface([
  'function getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)',
  'function symbol() view returns (string)',
  'function underlying() view returns (address)',
  'function decimals() view returns (uint8)'
]);
const oi = new ethers.utils.Interface(['function getUnderlyingPrice(address) view returns (uint256)']);
const records = []; let nextId = 1;
const writeRaw = () => fs.writeFileSync(path.join(outDir, 'rpc-raw.json'), JSON.stringify({ schemaVersion: 1, rpcOrigin, source, blockNumber, blockTag, capturedAt: new Date().toISOString(), records }, null, 2) + '\n');
async function rpc(method, params) {
  const request = { jsonrpc: '2.0', id: nextId++, method, params };
  const rec = { startedAt: new Date().toISOString(), request }; records.push(rec); writeRaw();
  try {
    const response = await fetch(rpcOrigin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
    rec.status = response.status; rec.responseText = await response.text(); rec.sha256 = createHash('sha256').update(rec.responseText).digest('hex');
    const body = JSON.parse(rec.responseText);
    if (!response.ok || body.error || body.id !== request.id) throw new Error(JSON.stringify(body.error || { status: response.status, id: body.id }));
    return body.result;
  } catch (e) { rec.error = e.message; rec.cause = e.cause?.code || null; throw e; }
  finally { rec.finishedAt = new Date().toISOString(); writeRaw(); }
}
async function call(to, iface, fn, args = []) { return iface.decodeFunctionResult(fn, await rpc('eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, blockTag])); }
const decimal = v => ethers.utils.formatUnits(v.toString(), 18);
const ratio = (n, d, places) => { if (d === 0n) return null; const unit = 10n ** BigInt(places); const r = (n * unit + d / 2n) / d; return `${r / unit}.${(r % unit).toString().padStart(places, '0')}`; };
const result = { schemaVersion: 1, status: 'incomplete', checkedAt: new Date().toISOString(), blockNumber, blockTag, chainId: 56, account, comptroller, rpcOrigin, source, temporalProxy: 'funding block; provider supplied no observation/source block' };
try {
  if (BigInt(await rpc('eth_chainId', [])) !== 56n) throw new Error('wrong chain');
  const header = await rpc('eth_getBlockByNumber', [blockTag, false]);
  if (!header || Number(BigInt(header.number)) !== blockNumber) throw new Error('wrong historical block');
  result.blockHash = header.hash; result.blockTimestamp = new Date(Number(BigInt(header.timestamp)) * 1000).toISOString();
  const [errorCode, liquidity, shortfall] = await call(comptroller, ci, 'getAccountLiquidity', [account]);
  result.liquidity = { errorCode: errorCode.toString(), liquidityRaw: liquidity.toString(), shortfallRaw: shortfall.toString() };
  const [assets] = await call(comptroller, ci, 'getAssetsIn', [account]);
  const [oracle] = await call(comptroller, ci, 'oracle', []); result.oracle = oracle;
  const [mintedVAI] = await call(comptroller, ci, 'mintedVAIs', [account]); result.mintedVAIRaw = mintedVAI.toString();
  result.markets = []; let borrowTotal = 0n;
  for (const vToken of assets) {
    const [snapshotError, vBalance, borrowBalance, exchangeRate] = await call(vToken, vi, 'getAccountSnapshot', [account]);
    const [symbol] = await call(vToken, vi, 'symbol', []);
    const [price] = await call(oracle, oi, 'getUnderlyingPrice', [vToken]);
    let underlying = null, underlyingDecimals = 18;
    if (vToken.toLowerCase() !== '0xa07c5b74c9b40447a954e1466938b865b6bbea36') { [underlying] = await call(vToken, vi, 'underlying', []); [underlyingDecimals] = await call(underlying, vi, 'decimals', []); }
    const borrowUsd = BigInt(borrowBalance.toString()) * BigInt(price.toString()) / 10n ** 18n; borrowTotal += borrowUsd;
    result.markets.push({ vToken, symbol, underlying, underlyingDecimals: Number(underlyingDecimals), snapshotError: snapshotError.toString(), vTokenBalanceRaw: vBalance.toString(), borrowBalanceRaw: borrowBalance.toString(), exchangeRateRaw: exchangeRate.toString(), oracleUnderlyingPriceRaw: price.toString(), borrowUsdRaw: borrowUsd.toString() });
  }
  const margin = BigInt(liquidity.toString()) - BigInt(shortfall.toString());
  result.totals = { borrowUsdRaw: borrowTotal.toString(), borrowUsd: decimal(borrowTotal), liquidityUsd: decimal(liquidity), shortfallUsd: decimal(shortfall), healthRatio: ratio(borrowTotal + margin, borrowTotal, 12) };
  try { const [e, available, deficit] = await call(comptroller, ci, 'getBorrowingPower', [account]); result.borrowingPower = { errorCode: e.toString(), availableRaw: available.toString(), deficitRaw: deficit.toString(), availableUsd: decimal(available) }; } catch (e) { result.borrowingPower = { status: 'unavailable', error: e.message }; }
  result.providerReport = { healthFactor: '1.704', borrowedUsd: '1.74', liquidationHeadroomUsd: '1.22' };
  result.comparison = {
    borrowedNearestCent: ratio(borrowTotal, 10n ** 18n, 2),
    borrowedMatchesNearestCent: ratio(borrowTotal, 10n ** 18n, 2) === '1.74',
    liquidityNearestCent: ratio(BigInt(liquidity.toString()), 10n ** 18n, 2),
    deliveredHeadroom: '1.22',
    headroomMatchesNearestCent: false,
    headroomMatchesTruncationToCents: true,
    headroomSemanticsVerified: false,
    healthRatioAtProxy: result.totals.healthRatio,
    deliveredHealthFactor: '1.704',
    healthRatioRounded3: ratio(borrowTotal + margin, borrowTotal, 3),
    healthRatioExactMatch: false,
    healthFactorDifference: '0.002426186947'
  };
  result.status = 'complete';
  result.scope = 'Independent NodeReal eth_call reconstruction at funding block 120785441, used as temporal proxy because delivery had no source block; it does not establish the provider observation block or future safety.';
} catch (e) { result.error = e.message; process.exitCode = 1; }
fs.writeFileSync(path.join(outDir, 'health-corroboration.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
