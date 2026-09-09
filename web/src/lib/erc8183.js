import { ethers } from 'ethers';
import { waitForSuccessfulReceipt } from './transaction-receipt.js';

// ERC-8183 agentic-commerce (APEX) on BSC. The kernel is a BNB/APEX-owned UUPS
// proxy; addresses and the call order below follow the only verified EOA buyer
// reference in production use. Order is load-bearing:
//   approve $U -> createJob -> registerJob(policy) -> setBudget -> fund
export const ERC8183 = {
  chainId: 56,
  kernel: '0xEa4DAa3100A767e86FDed867729ae7446476EBA6',
  router: '0x51895229E12F9876011789B04f8698af06cCD6DA',
  policy: '0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5',
  uToken: '0xcE24439F2D9C6a2289F741120FE202248B666666',
  rpc: 'https://bsc-dataseed1.binance.org',
  minBudgetWei: '1000000000000000000', // providers skip jobs below 1 $U
  expiryDays: 12, // must exceed disputeWindow(7d) + provider margins, else the job is never worked
  descriptionMax: 1000, // provider runtimes cap the description they read
};

export const JOB_STATUS = ['open', 'funded', 'submitted', 'completed', 'rejected', 'expired'];

// Deliverables are provider-authored bytes fetched from a public gateway. Keep
// the bound below the browser's point where a single job can pressure the tab,
// while leaving ample room for the small JSON manifests used by existing jobs.
export const DELIVERABLE_MAX_BYTES = 256 * 1024;
export const DELIVERABLE_MAX_TEXT = 64 * 1024;
export const DELIVERABLE_TIMEOUT_MS = 10_000;

const COMMERCE_ABI = [
  'function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)',
  'function setBudget(uint256 jobId, uint256 amount, bytes optParams)',
  'function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)',
  'function jobs(uint256) view returns (uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook, uint256 slot9, bytes32 deliverable)',
  'function claimRefund(uint256 jobId)',
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)',
];

const ROUTER_ABI = [
  'function registerJob(uint256 jobId, address policy)',
  'function settle(uint256 jobId, bytes evidence)',
  'function jobPolicy(uint256 jobId) view returns (address)',
];

const POLICY_ABI = [
  'function disputeWindow() view returns (uint64)',
  'function submittedAt(uint256) view returns (uint64)',
  'function disputed(uint256) view returns (bool)',
  'function dispute(uint256 jobId)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

export function parseCaip(value) {
  const parts = String(value ?? '').split(':');
  if (parts.length === 3 && ethers.utils.isAddress(parts[2])) {
    return { chainId: Number(parts[1]), address: ethers.utils.getAddress(parts[2]) };
  }
  return null;
}

export function findErc8183Service(meta) {
  const services = meta?.services;
  if (!Array.isArray(services)) return null;
  const entry = services.find((s) => String(s?.name ?? '').toLowerCase() === 'erc8183');
  if (!entry) return null;
  const provider = parseCaip(entry.endpoint);
  if (!provider || provider.chainId !== ERC8183.chainId) return null;
  return {
    provider: provider.address,
    offerings: Array.isArray(entry.offerings) ? entry.offerings : [],
  };
}

/*
  $U carries 18 decimals, so every price in a registry offering is wei. The raw
  integer is not a price a person can read — it reached the comparison table as
  "from 1000000000000000000 U" — so formatting lives here, next to the token it
  belongs to, rather than being retyped per page.
*/
export function formatU(wei) {
  try {
    return `${ethers.utils.formatUnits(wei, 18)} $U`;
  } catch {
    return '—';
  }
}

// Registry prices are exact decimal uint256 strings, never floating-point,
// hexadecimal, signed, or exponent notation. Keep this boundary shared by
// quoting and the signing sequence so an unreadable quote cannot become a
// different amount at checkout.
export function parseUBaseUnits(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,78}$/.test(value)) return null;
  const amount = ethers.BigNumber.from(value);
  return amount.gt(ethers.constants.MaxUint256) ? null : amount.toString();
}

export function offeringPriceU(offering) {
  if (offering?.priceU == null) return { status: 'negotiated', amount: null };
  const amount = parseUBaseUnits(offering.priceU);
  if (amount === null) return { status: 'invalid', amount: null };
  return amount === '0'
    ? { status: 'negotiated', amount: null }
    : { status: 'fixed', amount };
}

/*
  The cheapest priced offering, as wei. Compared as BigNumber and not Number:
  these are 18-digit integers, and 1e18 has already lost precision by the time
  it is a float, so Math.min over them is not reliably the minimum.
*/
export function minPriceU(offerings) {
  let min = null;
  for (const o of Array.isArray(offerings) ? offerings : []) {
    const { amount } = offeringPriceU(o);
    if (amount === null) continue;
    const bn = ethers.BigNumber.from(amount);
    if (min === null || bn.lt(min)) min = bn;
  }
  return min === null ? null : min.toString();
}

export function explainTxError(err) {
  if (err?.code === 4001 || err?.code === 'ACTION_REJECTED') return 'Transaction rejected in wallet.';
  if (err?.code === 'TRANSACTION_REPLACED') return err.reason === 'cancelled'
    ? 'Transaction cancelled in wallet. No further steps were submitted.'
    : 'The wallet replaced this transaction with a different or unsuccessful transaction. Check its receipt before continuing.';
  if (err?.code === 'INSUFFICIENT_FUNDS') return 'Not enough BNB for gas.';
  const reason = err?.reason || err?.error?.message || err?.data?.message || err?.message || String(err);
  return reason.length > 220 ? `${reason.slice(0, 220)}…` : reason;
}

async function getSigner() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found. Install MetaMask to hire agents.');
  const provider = new ethers.providers.Web3Provider(eth, 'any');
  await provider.send('eth_requestAccounts', []);
  const network = await provider.getNetwork();
  if (network.chainId !== ERC8183.chainId) {
    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: '0x38' }]);
    } catch (err) {
      if (err?.code === 4902) {
        await provider.send('wallet_addEthereumChain', [
          {
            chainId: '0x38',
            chainName: 'BNB Smart Chain',
            nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
            rpcUrls: [ERC8183.rpc],
            blockExplorerUrls: ['https://bscscan.com'],
          },
        ]);
      } else {
        throw err;
      }
    }
    return getSigner();
  }
  return provider.getSigner();
}

function readProvider() {
  return new ethers.providers.JsonRpcProvider(ERC8183.rpc);
}

function createdJobFromReceipt(receipt, contractInterface, buyer, providerTba) {
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== ERC8183.kernel.toLowerCase()) continue;
    try {
      const parsed = contractInterface.parseLog(log);
      if (parsed.name === 'JobCreated' && parsed.args.client.toLowerCase() === buyer.toLowerCase()
        && parsed.args.provider.toLowerCase() === providerTba.toLowerCase()) {
        return { jobId: parsed.args.jobId.toString(), buyer, expiredAt: Number(parsed.args.expiredAt) };
      }
    } catch { /* not a matching JobCreated event */ }
  }
  throw new Error('The transaction is confirmed but its job could not be identified. Check BscScan before creating another job.');
}

// Reconcile a persisted broadcast hash using reads only. Funding remains a
// separate, explicit confirmation through hireSequence({ resumeJobId }).
export async function recoverCreatedJob({ createRequestTx, buyer, provider: providerTba }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(createRequestTx ?? '')
    || !ethers.utils.isAddress(buyer) || !ethers.utils.isAddress(providerTba)) {
    throw new Error('The saved creation details are invalid. Check the transaction in BscScan.');
  }
  const receipt = await readProvider().getTransactionReceipt(createRequestTx);
  if (!receipt) throw new Error('The creation transaction is still pending, unavailable, or was replaced in your wallet. Check BscScan and retry this receipt check before creating another job.');
  if (receipt.status === 0) throw Object.assign(new Error('The creation transaction reverted. No job was created; you can review a new job.'), { code: 'CREATION_REVERTED' });
  if (receipt.status !== 1) throw new Error('The creation transaction is not confirmed yet. Check BscScan and retry this receipt check.');
  const created = createdJobFromReceipt(receipt, new ethers.utils.Interface(COMMERCE_ABI), buyer, providerTba);
  return { ...created, createRequestTx, createTx: receipt.transactionHash };
}

/*
  The full buyer sequence. Every write is callStatic-simulated first so reverts
  surface with readable reasons instead of opaque wallet errors.

  `onStep(key)` fires when a step begins; `onDone(key, meta)` when it has
  actually landed, with the transaction that proves it. The two are separate
  because the page needs both: what you are being asked to sign right now, and
  what is already settled behind you.

  meta.tx is the mined hash, absent when the step required no transaction —
  which is the honest reason the panel says "up to 5 wallet confirmations"
  rather than 5. An account that has already approved $U signs four times.
*/
export async function hireSequence({ providerTba, description, budgetWei, resumeJobId = null, fundTx = null, onCreateSubmitted = () => {}, onCreated = () => {}, onStep = () => {}, onDone = () => {} }) {
  const exactBudget = parseUBaseUnits(budgetWei);
  if (exactBudget === null) throw new Error('Invalid escrow budget: expected an exact decimal amount in base units.');
  const budget = ethers.BigNumber.from(exactBudget);
  if (budget.lt(ERC8183.minBudgetWei)) throw new Error('Escrow budget must be at least 1 $U.');
  if (resumeJobId !== null && (!/^[1-9][0-9]*$/.test(String(resumeJobId)) || parseUBaseUnits(String(resumeJobId)) === null)) {
    throw new Error('Invalid saved job number.');
  }
  const text = description.slice(0, ERC8183.descriptionMax);
  const signer = await getSigner();
  const buyer = await signer.getAddress();

  const u = new ethers.Contract(ERC8183.uToken, ERC20_ABI, signer);
  const kernel = new ethers.Contract(ERC8183.kernel, COMMERCE_ABI, signer);
  const router = new ethers.Contract(ERC8183.router, ROUTER_ABI, signer);

  let jobId = resumeJobId === null ? null : String(resumeJobId);
  let expiredAt;
  let existingJob = null;
  let registeredPolicy = ethers.constants.AddressZero;
  if (jobId !== null) {
    existingJob = await kernel.jobs(jobId);
    if (existingJob.id.toString() !== jobId || existingJob.client.toLowerCase() !== buyer.toLowerCase()
      || existingJob.provider.toLowerCase() !== providerTba.toLowerCase()
      || existingJob.evaluator.toLowerCase() !== ERC8183.router.toLowerCase()
      || existingJob.hook.toLowerCase() !== ERC8183.router.toLowerCase()
      || existingJob.description !== text) {
      throw new Error('The saved job does not match this wallet, provider, or request.');
    }
    expiredAt = Number(existingJob.expiredAt);
    if (existingJob.status !== 0) {
      if ([1, 2, 3].includes(existingJob.status) && existingJob.budget.eq(budget)) {
        return { jobId, buyer, expiredAt, txHash: fundTx, alreadyFunded: true };
      }
      throw new Error('This saved job is no longer open for funding.');
    }
    const latest = await readProvider().getBlock('latest');
    if (expiredAt <= latest.timestamp) throw new Error('This saved job has expired and cannot be funded.');
    if (!existingJob.budget.isZero() && !existingJob.budget.eq(budget)) throw new Error('The saved job has a different on-chain budget.');
    registeredPolicy = await router.jobPolicy(jobId);
    if (registeredPolicy.toLowerCase() !== ERC8183.policy.toLowerCase() && registeredPolicy !== ethers.constants.AddressZero) {
      throw new Error('The saved job has a different dispute policy.');
    }
  }

  const balance = await u.balanceOf(buyer);
  if (balance.lt(budget)) {
    throw new Error(`Not enough $U: balance ${ethers.utils.formatUnits(balance, 18)}, needed ${ethers.utils.formatUnits(budget, 18)}.`);
  }

  onStep('approve');
  const allowance = await u.allowance(buyer, ERC8183.kernel);
  if (allowance.lt(budget)) {
    const approveReceipt = await waitForSuccessfulReceipt(u.approve(ERC8183.kernel, budget));
    onDone('approve', { tx: approveReceipt.transactionHash });
  } else {
    onDone('approve', { skipped: 'allowance already set' });
  }

  if (jobId === null) {
    onStep('create');
    const latest = await readProvider().getBlock('latest');
    expiredAt = latest.timestamp + ERC8183.expiryDays * 86400;
    await kernel.callStatic.createJob(providerTba, ERC8183.router, expiredAt, text, ERC8183.router);
    const createTransaction = await kernel.createJob(providerTba, ERC8183.router, expiredAt, text, ERC8183.router);
    onCreateSubmitted({ buyer, expiredAt, createRequestTx: createTransaction.hash, createTx: createTransaction.hash });
    const createReceipt = await waitForSuccessfulReceipt(createTransaction);
    const created = createdJobFromReceipt(createReceipt, kernel.interface, buyer, providerTba);
    jobId = created.jobId;
    onCreated({ ...created, createRequestTx: createTransaction.hash, createTx: createReceipt.transactionHash });
    onDone('create', { tx: createReceipt.transactionHash });
  } else {
    onDone('create', { skipped: `resuming job #${jobId}` });
  }

  onStep('register');
  if (registeredPolicy.toLowerCase() === ERC8183.policy.toLowerCase()) {
    onDone('register', { skipped: 'dispute policy already registered' });
  } else {
    await router.callStatic.registerJob(jobId, ERC8183.policy);
    const registerReceipt = await waitForSuccessfulReceipt(router.registerJob(jobId, ERC8183.policy));
    onDone('register', { tx: registerReceipt.transactionHash });
  }

  onStep('budget');
  if (existingJob?.budget.eq(budget)) {
    onDone('budget', { skipped: 'budget already set' });
  } else {
    await kernel.callStatic.setBudget(jobId, budget, '0x');
    const budgetReceipt = await waitForSuccessfulReceipt(kernel.setBudget(jobId, budget, '0x'));
    onDone('budget', { tx: budgetReceipt.transactionHash });
  }

  onStep('fund');
  await kernel.callStatic.fund(jobId, budget, '0x');
  const fundReceipt = await waitForSuccessfulReceipt(kernel.fund(jobId, budget, '0x'));
  onDone('fund', { tx: fundReceipt.transactionHash });

  return { jobId, buyer, expiredAt, txHash: fundReceipt.transactionHash };
}

export async function readJob(jobId) {
  const provider = readProvider();
  const kernel = new ethers.Contract(ERC8183.kernel, COMMERCE_ABI, provider);
  const policy = new ethers.Contract(ERC8183.policy, POLICY_ABI, provider);
  const job = await kernel.jobs(jobId);
  const [windowSec, submittedAt, disputed] = await Promise.all([
    policy.disputeWindow(),
    policy.submittedAt(jobId),
    policy.disputed(jobId),
  ]);
  const submitted = Number(submittedAt);
  return {
    jobId: String(jobId),
    client: job.client,
    provider: job.provider,
    description: job.description,
    budgetWei: job.budget.toString(),
    expiredAt: Number(job.expiredAt),
    status: JOB_STATUS[job.status] ?? String(job.status),
    statusCode: job.status,
    deliverable: job.deliverable,
    submittedAt: submitted || null,
    settleAt: submitted ? submitted + Number(windowSec) : null,
    disputed,
  };
}

export async function settleJob(jobId) {
  const signer = await getSigner();
  const router = new ethers.Contract(ERC8183.router, ROUTER_ABI, signer);
  await router.callStatic.settle(jobId, '0x');
  return waitForSuccessfulReceipt(router.settle(jobId, '0x'));
}

export async function disputeJob(jobId) {
  const signer = await getSigner();
  const policy = new ethers.Contract(ERC8183.policy, POLICY_ABI, signer);
  await policy.callStatic.dispute(jobId);
  return waitForSuccessfulReceipt(policy.dispute(jobId));
}

export async function claimRefund(jobId) {
  const signer = await getSigner();
  const kernel = new ethers.Contract(ERC8183.kernel, COMMERCE_ABI, signer);
  await kernel.callStatic.claimRefund(jobId);
  return waitForSuccessfulReceipt(kernel.claimRefund(jobId));
}

// The on-chain deliverable is the raw sha256 digest of a CIDv0:
// CIDv0 = base58btc(0x12 0x20 || digest). Reconstruct, fetch, and verify the
// manifest actually belongs to this job and provider before trusting it.
export function deliverableToCid(bytes32) {
  if (!bytes32 || bytes32 === ethers.constants.HashZero) return null;
  const digest = ethers.utils.arrayify(bytes32);
  if (digest.length !== 32) return null;
  return ethers.utils.base58.encode(ethers.utils.concat([new Uint8Array([0x12, 0x20]), digest]));
}

function deliverableResult(cid, valid, text = null, reason = null) {
  return { cid, valid, text, ...(reason ? { reason } : {}) };
}

function readContentLength(response) {
  const value = response?.headers?.get?.('content-length');
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

function abortError(reason = 'deliverable read aborted') {
  return Object.assign(new Error(reason), { code: 'DELIVERABLE_ABORTED' });
}

function cancelResponseBody(response) {
  try {
    const reader = response?.body?.getReader?.();
    if (!reader) return;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
    try { reader.releaseLock(); } catch { /* already released by the stream */ }
  } catch { /* a broken response body is already unusable */ }
}

async function readBoundedJson(response, { signal, maxBytes = DELIVERABLE_MAX_BYTES, abortPromise }) {
  const declared = readContentLength(response);
  if (declared !== null && declared > maxBytes) {
    cancelResponseBody(response);
    throw Object.assign(new Error('deliverable response exceeds the browser limit'), { code: 'DELIVERABLE_TOO_LARGE' });
  }
  const reader = response?.body?.getReader?.();
  if (!reader) throw Object.assign(new Error('deliverable response has no readable body'), { code: 'DELIVERABLE_UNREADABLE' });
  let done = false;
  try {
    // Copy each view into owned storage immediately. Keeping response chunks in
    // an array can pin a much larger underlying ArrayBuffer than the view.
    const bytes = new Uint8Array(maxBytes);
    let total = 0;
    for (;;) {
      // Race each read against the caller's deadline or abort signal so a
      // pending body reader cannot outlive the request.
      const part = await Promise.race([reader.read(), abortPromise]);
      if (part.done) {
        done = true;
        break;
      }
      const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value ?? []);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw Object.assign(new Error('deliverable response exceeds the browser limit'), { code: 'DELIVERABLE_TOO_LARGE' });
      }
      bytes.set(chunk, total - chunk.byteLength);
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total)));
  } finally {
    // Do not await cancellation: an uncooperative reader must not defeat the
    // deadline. releaseLock makes the response eligible for collection.
    if (!done) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* cancellation is best effort */ }
    }
    try { reader.releaseLock(); } catch { /* already released by the stream */ }
    if (signal?.aborted) throw abortError();
  }
}

async function fetchDeliverableOnce(url, { signal, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  let removeCallerAbort = () => {};
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    rejectAbort(abortError(reason === 'timeout' ? 'deliverable read timed out' : undefined));
  };
  if (signal) {
    if (signal.aborted) abort();
    else {
      const onAbort = () => abort();
      signal.addEventListener('abort', onAbort, { once: true });
      removeCallerAbort = () => signal.removeEventListener('abort', onAbort);
    }
  }
  timer = setTimeout(() => abort('timeout'), timeoutMs);
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { signal: controller.signal })),
      abortPromise,
    ]);
    if (!response?.ok) {
      cancelResponseBody(response);
      return { kind: 'unavailable' };
    }
    const manifest = await readBoundedJson(response, { signal: controller.signal, abortPromise });
    const manifestJobId = typeof manifest?.jobId === 'string' && /^\d+$/.test(manifest.jobId)
      ? (() => { try { return BigInt(manifest.jobId).toString(); } catch { return null; } })()
      : Number.isSafeInteger(manifest?.jobId) && manifest.jobId >= 0 ? String(manifest.jobId) : null;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof manifest.provider !== 'string' || manifestJobId === null
      || typeof manifest.deliverable !== 'string') return { kind: 'unavailable', reason: 'invalid-manifest' };
    manifest.jobId = manifestJobId;
    if (manifest.deliverable.length > DELIVERABLE_MAX_TEXT) {
      return { kind: 'unavailable', reason: 'deliverable-text-too-large' };
    }
    return { kind: 'manifest', manifest };
  } finally {
    clearTimeout(timer);
    removeCallerAbort();
    controller.abort();
  }
}

export async function fetchDeliverable(job, { fetchImpl = globalThis.fetch, signal, timeoutMs = DELIVERABLE_TIMEOUT_MS } = {}) {
  const cid = deliverableToCid(job.deliverable);
  if (!cid) return null;
  for (const gateway of ['https://ipfs.io/ipfs/', 'https://cloudflare-ipfs.com/ipfs/']) {
    if (signal?.aborted) break;
    try {
      const outcome = await fetchDeliverableOnce(`${gateway}${cid}`, { fetchImpl, signal, timeoutMs });
      if (outcome.kind !== 'manifest') continue;
      const providerOk = outcome.manifest.provider.toLowerCase() === String(job.provider ?? '').toLowerCase();
      const jobId = typeof job.jobId === 'string' && /^\d+$/.test(job.jobId)
        ? (() => { try { return BigInt(job.jobId).toString(); } catch { return null; } })()
        : Number.isSafeInteger(job.jobId) && job.jobId >= 0 ? String(job.jobId) : null;
      const jobOk = jobId !== null && outcome.manifest.jobId === jobId;
      if (!providerOk || !jobOk) return deliverableResult(cid, false);
      return deliverableResult(cid, true, outcome.manifest.deliverable);
    } catch {
      if (signal?.aborted) break;
      /* try next gateway */
    }
  }
  return deliverableResult(cid, null, null, 'unavailable');
}
