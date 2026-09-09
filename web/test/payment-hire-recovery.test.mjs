import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import { ERC8183, hireSequence, recoverCreatedJob, settleJob, disputeJob, claimRefund } from '../src/lib/erc8183.js';
import { loadHires, saveHire, startHireOnce } from '../src/lib/hire-session.js';

const BUYER = `0x${'1'.repeat(40)}`;
const PROVIDER = `0x${'2'.repeat(40)}`;
const BUDGET = '1000000000000000000';
const NOW = 1800000000;
const CREATE_HASH = `0x${'c'.repeat(64)}`;
const REPRICED_CREATE_HASH = `0x${'d'.repeat(64)}`;
const eventInterface = new ethers.utils.Interface([
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)',
]);

async function withChainMock(run) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const descriptors = [
    [ethers, 'Contract'], [ethers.providers, 'Web3Provider'], [ethers.providers, 'JsonRpcProvider'],
  ].map(([object, key]) => [object, key, Object.getOwnPropertyDescriptor(object, key)]);
  const state = {
    calls: [], simulations: [], reprice: new Set(), fail: null, allowance: ethers.BigNumber.from(0),
    policy: ethers.constants.AddressZero, job: null, receipts: new Map(), loseCreateReceipt: false,
    walletRequests: 0, onWait: () => {},
  };
  const signer = { getAddress: async () => BUYER };
  function transaction(step, apply = () => {}, logs = []) {
    state.calls.push(step);
    const nonce = state.calls.length;
    const base = { from: BUYER, to: ERC8183.kernel, data: `0x${nonce.toString(16).padStart(8, '0')}`,
      value: ethers.BigNumber.from(0), nonce, chainId: 56, hash: step === 'create' ? CREATE_HASH : `0x${step}-original` };
    return { ...base, wait: async () => {
      state.onWait(step);
      if (state.fail === step) throw Object.assign(new Error(`${step} cancelled`), { code: 'TRANSACTION_REPLACED', cancelled: true, reason: 'cancelled' });
      apply();
      if (state.reprice.has(step)) {
        const replacement = { ...base, hash: step === 'create' ? REPRICED_CREATE_HASH : `0x${step}-repriced` };
        const receipt = { status: 1, transactionHash: replacement.hash, logs };
        state.receipts.set(replacement.hash, receipt);
        throw Object.assign(new Error('repriced'), { code: 'TRANSACTION_REPLACED', cancelled: false, reason: 'repriced', replacement,
          receipt });
      }
      const receipt = { status: 1, transactionHash: base.hash, logs };
      state.receipts.set(base.hash, receipt);
      if (step === 'create' && state.loseCreateReceipt) throw new Error('RPC disconnected after creation');
      return receipt;
    } };
  }
  const simulate = Object.fromEntries(['createJob', 'registerJob', 'setBudget', 'fund', 'settle', 'dispute', 'claimRefund']
    .map((method) => [method, async () => { state.simulations.push(method); }]));
  const contracts = {
    [ERC8183.uToken]: {
      balanceOf: async () => ethers.BigNumber.from(BUDGET).mul(100), allowance: async () => state.allowance,
      approve: async (_spender, amount) => transaction('approve', () => { state.allowance = amount; }),
    },
    [ERC8183.kernel]: {
      callStatic: simulate, interface: eventInterface, jobs: async () => state.job,
      createJob: async (provider, evaluator, expiredAt, description, hook) => {
        const job = { id: ethers.BigNumber.from(42), client: BUYER, provider, evaluator, expiredAt, description, hook,
          budget: ethers.BigNumber.from(0), status: 0 };
        const log = eventInterface.encodeEventLog(eventInterface.getEvent('JobCreated'), [42, BUYER, provider, evaluator, expiredAt, hook]);
        return transaction('create', () => { state.job = job; }, [{ ...log, address: ERC8183.kernel }]);
      },
      setBudget: async (_id, budget) => transaction('budget', () => { state.job.budget = budget; }),
      fund: async () => transaction('fund', () => { state.job.status = 1; }),
      claimRefund: async () => transaction('refund'),
    },
    [ERC8183.router]: {
      callStatic: simulate, jobPolicy: async () => state.policy,
      registerJob: async (_id, policy) => transaction('register', () => { state.policy = policy; }),
      settle: async () => transaction('settle'),
    },
    [ERC8183.policy]: { callStatic: simulate, dispute: async () => transaction('dispute') },
  };
  Object.defineProperty(ethers, 'Contract', { configurable: true, value: function Contract(address) {
    assert.ok(contracts[address], `Unexpected contract ${address}`);
    return contracts[address];
  } });
  Object.defineProperty(ethers.providers, 'Web3Provider', { configurable: true, value: class {
    async send(method) { state.walletRequests += 1; assert.equal(method, 'eth_requestAccounts'); return [BUYER]; }
    async getNetwork() { return { chainId: 56 }; }
    getSigner() { return signer; }
  } });
  Object.defineProperty(ethers.providers, 'JsonRpcProvider', { configurable: true, value: class {
    async getBlock(tag) { assert.equal(tag, 'latest'); return { timestamp: NOW }; }
    async getTransactionReceipt(hash) { return state.receipts.get(hash) ?? null; }
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { ethereum: {} } });
  try { await run(state); }
  finally {
    for (const [object, key, descriptor] of descriptors) Object.defineProperty(object, key, descriptor);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
}

const hire = (options = {}) => hireSequence({ providerTba: PROVIDER, description: 'A test job', budgetWei: BUDGET, ...options });

test('every sped-up escrow step succeeds and records the replacement funding receipt once', async () => {
  await withChainMock(async (state) => {
    state.reprice = new Set(['approve', 'create', 'register', 'budget', 'fund']);
    const steps = {};
    let saved = '[]';
    const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
    let earlyJob;
    const lock = { current: false };
    const pending = startHireOnce(lock, () => hire({
      onCreated: (created) => { earlyJob = created; saveHire({ ...created, pending: true }, storage); },
      onDone: (step, result) => { steps[step] = result; },
    }));
    assert.equal(startHireOnce(lock, () => hire()), null);
    const funded = await pending;
    saveHire({ jobId: funded.jobId, fundTx: funded.txHash, pending: false }, storage);
    assert.equal(funded.txHash, '0xfund-repriced');
    assert.equal(earlyJob.createTx, REPRICED_CREATE_HASH);
    assert.equal(steps.fund.tx, '0xfund-repriced');
    assert.deepEqual(state.calls, ['approve', 'create', 'register', 'budget', 'fund']);
    assert.equal(loadHires(storage).length, 1);
    assert.equal(loadHires(storage)[0].createTx, REPRICED_CREATE_HASH);
    assert.equal(loadHires(storage)[0].fundTx, '0xfund-repriced');
    assert.equal(loadHires(storage)[0].pending, false);
    assert.equal(lock.current, false);
  });
});

test('a created job survives a later cancellation and resumes without another create or budget transaction', async () => {
  await withChainMock(async (state) => {
    state.fail = 'fund';
    let saved = '[]';
    const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
    await assert.rejects(hire({ onCreated: (created) => { saveHire({ ...created, pending: true }, storage); } }), /fund cancelled/);
    const earlyJob = loadHires(storage)[0];
    assert.equal(earlyJob.jobId, '42');
    assert.equal(earlyJob.pending, true);
    assert.equal(state.job.status, 0);
    state.fail = null;
    state.reprice.add('fund');
    const steps = {};
    const result = await hire({ resumeJobId: earlyJob.jobId, onDone: (key, value) => { steps[key] = value; } });
    assert.equal(result.txHash, '0xfund-repriced');
    assert.equal(state.calls.filter((step) => step === 'create').length, 1);
    assert.equal(state.calls.filter((step) => step === 'budget').length, 1);
    assert.equal(state.calls.filter((step) => step === 'register').length, 1);
    assert.equal(steps.register.skipped, 'dispute policy already registered');
    assert.equal(steps.budget.skipped, 'budget already set');
  });
});

test('retrying a funded job performs no new writes, even when the original funding receipt was missed', async () => {
  await withChainMock(async (state) => {
    const result = await hire();
    const before = [...state.calls];
    const resumed = await hire({ resumeJobId: result.jobId });
    assert.equal(resumed.alreadyFunded, true);
    assert.equal(resumed.txHash, null);
    assert.deepEqual(state.calls, before);
  });
});

test('saved-job mismatches and expiry never proceed to another signature', async () => {
  await withChainMock(async (state) => {
    state.fail = 'fund';
    await assert.rejects(hire());
    state.fail = null;
    const originalJob = { ...state.job };
    const before = [...state.calls];
    for (const patch of [
      { id: ethers.BigNumber.from(99) }, { client: PROVIDER }, { provider: BUYER }, { evaluator: BUYER },
      { hook: BUYER }, { description: 'changed request' }, { budget: ethers.BigNumber.from(BUDGET).mul(2) },
      { expiredAt: NOW - 1 }, { status: 5 },
    ]) {
      state.job = { ...originalJob, ...patch };
      await assert.rejects(hire({ resumeJobId: '42' }));
      assert.deepEqual(state.calls, before);
    }
    state.job = originalJob;
    state.policy = BUYER;
    state.allowance = ethers.BigNumber.from(0);
    await assert.rejects(hire({ resumeJobId: '42' }), /different dispute policy/);
    assert.deepEqual(state.calls, before);
  });
});

test('settle, dispute, and refund return successful repriced receipts too', async () => {
  await withChainMock(async (state) => {
    state.reprice = new Set(['settle', 'dispute', 'refund']);
    for (const [action, fn] of [['settle', settleJob], ['dispute', disputeJob], ['refund', claimRefund]]) {
      const receipt = await fn('42');
      assert.equal(receipt.transactionHash, `0x${action}-repriced`);
    }
    assert.deepEqual(state.calls, ['settle', 'dispute', 'refund']);
  });
});

test('creation hash persists before waiting; a lost receipt recovers read-only after reload without another create', async () => {
  await withChainMock(async (state) => {
    state.loseCreateReceipt = true;
    let value = '[]';
    const storage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
    state.onWait = (step) => {
      if (step === 'create') {
        assert.equal(loadHires(storage)[0].createRequestTx, CREATE_HASH);
        assert.equal(loadHires(storage)[0].creationPending, true);
      }
    };
    await assert.rejects(hire({ onCreateSubmitted: (submitted) => {
      saveHire({ ...submitted, jobId: null, provider: PROVIDER, description: 'A test job', budgetWei: BUDGET, creationPending: true }, storage);
    } }), /RPC disconnected/);
    const restored = loadHires(storage)[0];
    assert.equal(restored.jobId, null);
    assert.equal(state.job.id.toString(), '42');
    const callsBeforeRead = [...state.calls];
    const walletsBeforeRead = state.walletRequests;
    const recovered = await recoverCreatedJob(restored);
    assert.equal(recovered.jobId, '42');
    assert.deepEqual(state.calls, callsBeforeRead, 'receipt recovery does not submit or sign');
    assert.equal(state.walletRequests, walletsBeforeRead, 'receipt recovery does not access a wallet');
    saveHire({ ...restored, ...recovered, creationPending: false, pending: true }, storage);
    assert.equal(loadHires(storage).length, 1, 'confirmed job replaces its pending checkpoint');
    assert.equal(loadHires(storage)[0].jobId, '42');
    const completed = await hire({ resumeJobId: recovered.jobId });
    assert.equal(completed.jobId, '42');
    assert.equal(state.calls.filter((step) => step === 'create').length, 1);
  });
});

test('pending or replaced-unknown creation receipts retain the checkpoint and never create another job', async () => {
  await withChainMock(async (state) => {
    const checkpoint = { createRequestTx: CREATE_HASH, buyer: BUYER, provider: PROVIDER, creationPending: true };
    await assert.rejects(recoverCreatedJob(checkpoint), /pending, unavailable, or was replaced/);
    assert.equal(checkpoint.creationPending, true);
    assert.deepEqual(state.calls, []);
    assert.equal(state.walletRequests, 0);
    state.receipts.set(CREATE_HASH, { status: 0, transactionHash: CREATE_HASH, logs: [] });
    await assert.rejects(recoverCreatedJob(checkpoint), (error) => error.code === 'CREATION_REVERTED');
    assert.deepEqual(state.calls, []);
  });
});
