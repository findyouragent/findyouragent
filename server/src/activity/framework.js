import * as nodereal from '../net/nodereal.js';

/**
 * Framework-event detection: the owner-INDEPENDENT half of origin attribution.
 *
 * A transaction carrying a tokenId-indexed event from one of the platform's own
 * framework contracts went through the agent framework — a path an agent OWNER
 * cannot forge. setLogicAddress lets an owner point their agent at a malicious
 * logic contract, but that address is NOT in the set below, so its look-alike
 * events are never counted (the emitter-in-set check is the hard invariant). A
 * self-reported number the same owner controls (getMetrics) is the opposite:
 * this is why the classifier trusts framework EVENTS and not the counters.
 *
 * A stale or incomplete set only UNDER-classifies — a real framework tx falls
 * back to an unestablished-origin transfer — which is the safe direction: it can
 * never manufacture a framework claim the chain does not support.
 *
 * Verified live: token 11100's real trades emit SwapExecuted (0x0b371df4) and
 * ActionHandled (0x55539cff) from the Trading-V8 logic below, tokenId indexed as
 * topic1. Addresses are the BORT platform's deploy records; RE-VERIFY before
 * trusting a new collection, and note the vault/guard/deployer entries are
 * upgradeable proxies (their event emitter is the proxy address, listed here).
 */
const FRAMEWORK = new Set([
  // Logic contracts — ActionHandled / SwapExecuted / TradingActionRequested.
  '0xcf6e6ac0832b0f54e2c5d697f9bbc0f2dbbec559', // Trading V8
  '0x4f09b2d20eb9d6bf156481ec783103a89413bbcd', // Trading V7
  '0x3b83135fe76eb4468bdfaca7bea3bd4ff1441658', // Hunter V8
  '0xde28b00ea0582a85722edb90a9e9102c4324fcf0', // Hunter V7
  '0x3791626ef2698cfd105f899d8ac8f635b2b2e746', // CTO V8
  '0xa1456e98389db9418bdc59baaeafcfc611a6017a', // CTO V7
  '0x7db409b75ec5635c65458b2e7949d721ffa46ac6', // Deployer V8
  '0xa1f4d7cf8f3820b2a0b1f3d2075a8379ca131d97', // Trading V6 (legacy)
  '0x933f288e3213a0a05f28a4a6ec5790129bdae6d7', // Trading V5 (legacy)
  '0x61b3f08579237da6247de20af1f5a4e5a95d9c52', // Trading V5 (legacy)
  '0xbf9e07f7ea47e40d7845534b8840a4b7225d1c67', // CTO (legacy)
  // Custody / execution / commerce forwarders.
  '0x0ec7a7d90a92eb1c86d9a082ff5b75518acf4102', // VaultManager (Pulled/Settled)
  '0x3abff77418315d235a38f05ab4c4f2a439efbbcf', // PolicyGuard (Swapped)
  '0x0fa3f984f7999d31c28055260637d1bcea34919a', // VPMv2 (ActionForwarded)
  '0x77d181f40aa4c8e9903bdb35df27521ffff22662', // SubmitForwarder (Submitted)
  '0xbc4ed58a7ea5f3cb65d01ca40d21bcdfb54e18ed', // HireForwarder (Hired)
]);

// LOAD-BEARING PRECONDITION. These shared platform contracts key their per-agent
// state by BARE tokenId, and scanFramework filters by tokenId (topic1) alone —
// so attribution is sound ONLY while tokenIds are globally unique across every
// collection these contracts serve. Today that holds: a single BORT collection
// is registrar-mapped (bap578.js BAP_REGISTRARS) and its tokenIds are minted
// globally unique, and the /api/activity gate already requires that registrar's
// ownershipVerified === true. This constant makes the precondition ENFORCED, not
// merely assumed: framework attribution runs only for this collection. Onboarding
// a second collection that shares these contracts must FIRST bind attribution to
// the collection, or agent (collectionA, N) would render (collectionB, N)'s
// framework events. Confirmed per-emitter that each listed (address, topic0) is
// owner-unreachable (handleAction onlyAuthorized; forwarders onlyOperator;
// VaultManager registeredExecutor is platform-onlyOwner) — that gating, not mere
// address membership, is what earns the owner-excluded label; re-assert it before
// adding any contract here.
export const FRAMEWORK_COLLECTION = '0x15b15df2ffff6653c21c11b93fb8a7718ce854ce';

// topic0 → the kind of framework activity it marks. tokenId is topic1 on every
// one of these, which is what lets a single getLogs filter by agent.
const TOPICS = {
  '0x55539cffa1b4552acb547c2b6aee26c7f11377de1befd8b70ad8de7d45e1a224': 'action', // ActionHandled
  '0x0b371df4ab0d5dbf2f444cefda53ccd927a9a052a0e138f97ff69996f9cd8f0d': 'trade', // SwapExecuted
  '0xd754453a9597594b191b0cc73bb4a4d6f14eaa3b5017676d94ff23cdbb612a34': 'trade', // TradingActionRequested
  '0x030d3989504407daa3a8406b7c5c1e31c813de6c55fa773bd5703d84e7b3c524': 'trade', // PolicyGuard Swapped
  '0x08e0aaf37628c1336e98ea26780e544d481e2920bd290f8f5e399c4289aebebe': 'custody', // VaultManager Pulled
  '0xbfed4c9aef0cc82058a0d9ecf93fff780a20d63bb650b7fcde95bf639097b402': 'custody', // VaultManager Settled
  '0xb132ceff9c8d4be97ef347e383160e24857ef62a7641185ddad5fe6b15f985e1': 'job', // Submitted
  '0xc3923ff883aad252bd29db8a61d2b394c302dd28b78f915150445a83f2cbae07': 'job', // Hired
};
// VPMv2 ActionForwarded: present means the framework call was TRIGGERED through
// the owner-facing permission system (the owner, or an operator the owner
// granted), not the pure runtime path — so we must not claim owner-exclusion.
const ACTION_FORWARDED = '0x194c8409c821695d4d9e98e34b23bf9bf051178f9212b3014358950157989606';
const ALL_TOPICS = [...Object.keys(TOPICS), ACTION_FORWARDED];

function padTokenId(n) {
  return `0x${BigInt(n).toString(16).padStart(64, '0')}`;
}

/**
 * Framework events for one agent's BAP tokenId over [fromBlock, toBlock],
 * stepping within the getLogs window cap. Returns:
 *   { byTx: Map<txHash, {kinds:Set, hasForwarded:bool, emitters:Set, block}>,
 *     status: 'ok' | 'throttled' | 'error' }
 * A transport failure sets status and returns what was gathered — never a
 * silent empty that would relabel a framework tx as an ordinary transfer.
 */
export async function scanFramework(bapTokenId, fromBlock, toBlock) {
  const byTx = new Map();
  let status = 'ok';
  try {
    // Inside the try: a malformed tokenId is a caught failure, not a thrown
    // break of this function's documented never-throws contract.
    const topic1 = padTokenId(bapTokenId);
    for (let cursor = fromBlock; cursor <= toBlock; cursor = cursor + nodereal.MAX_LOG_WINDOW + 1) {
      const end = Math.min(cursor + nodereal.MAX_LOG_WINDOW, toBlock);
      const logs = await nodereal.getLogs({
        address: [...FRAMEWORK],
        topics: [ALL_TOPICS, topic1],
        fromBlock: cursor,
        toBlock: end,
      });
      for (const log of logs) {
        const emitter = (log.address || '').toLowerCase();
        // Hard invariant: only a real platform contract counts. A look-alike
        // event from any other address (a malicious owner-set logic) is ignored.
        if (!FRAMEWORK.has(emitter)) continue;
        const hash = log.transactionHash;
        let e = byTx.get(hash);
        if (!e) {
          const blk = parseInt(log.blockNumber, 16);
          e = { kinds: new Set(), hasForwarded: false, emitters: new Set(), block: Number.isFinite(blk) ? blk : 0 };
          byTx.set(hash, e);
        }
        const t0 = (log.topics?.[0] || '').toLowerCase();
        if (t0 === ACTION_FORWARDED) e.hasForwarded = true;
        else if (TOPICS[t0]) e.kinds.add(TOPICS[t0]);
        e.emitters.add(emitter);
      }
    }
  } catch (err) {
    status = err?.transport ? 'throttled' : 'error';
  }
  return { byTx, status };
}
