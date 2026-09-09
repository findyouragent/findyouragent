const U_TOKEN = '0xce24439f2d9c6a2289f741120fe202248b666666';

/**
 * Per-transaction origin classes. Each says how a transaction was EXECUTED,
 * never who decided it, and none claims "autonomous" — a signature proves key
 * possession, not actor type.
 */
export const CLASS_LABEL = {
  framework: "Executed through the agent's on-chain framework — a path the owner's wallet cannot directly invoke. Whether a person or a program operated the platform's key is not knowable on-chain.",
  'framework-triggered': 'Run through the agent framework, but triggered via the owner-facing permission system — the owner, or an operator they granted, may have initiated it.',
  payment: "A payment token ($U) arrived in the agent's wallet — this shows a transfer landed, not who sent it or that any service was rendered.",
  transfer: "A transfer on the agent's wallet. How it was initiated is not established on-chain — a person and a program using the same key are indistinguishable.",
  'not-checked': 'We could not read the framework records covering this transaction, so its origin is not established. This describes our check, not the agent.',
};

function frameworkClass(fw) {
  return fw.hasForwarded ? 'framework-triggered' : 'framework';
}

/**
 * Union the stored transfer rows with a framework-event scan and assign each a
 * class. Rules, all owner-independent:
 *   - tx has a framework event (emitter in the platform set) → framework. The
 *     owner cannot forge this; a malicious owner-set logic is not in the set.
 *   - framework scan did NOT complete for the window → any non-framework tx is
 *     'not-checked', never 'transfer': we cannot rule out framework events we
 *     failed to read (fail closed).
 *   - a $U inflow → 'payment' (landed, not "earned").
 *   - anything else → 'transfer' (origin not established).
 * Framework txs that moved no assets through the wallet (vault-custodied trades)
 * are added as their own rows, so the feed is the UNION, not transfers alone.
 */
export function classifyFeed(transferRows, scan, wallet) {
  const scanOk = scan.status === 'ok';
  const seenTx = new Set();
  const out = [];

  for (const r of transferRows) {
    seenTx.add(r.hash);
    const fw = scan.byTx.get(r.hash);
    let cls;
    if (fw) cls = frameworkClass(fw);
    else if (!scanOk) cls = 'not-checked';
    else if (r.direction === 'in' && (r.contract || '').toLowerCase() === U_TOKEN) cls = 'payment';
    else cls = 'transfer';
    out.push({ ...r, class: cls });
  }

  // Framework activity with no transfer leg — the agent's real trades often live
  // here (custody moves through the vault/guard, not the token-bound account).
  for (const [hash, fw] of scan.byTx) {
    if (seenTx.has(hash)) continue;
    const kind = fw.kinds.has('trade') ? 'trade'
      : fw.kinds.has('job') ? 'job'
        : fw.kinds.has('custody') ? 'custody' : 'action';
    out.push({
      t: 'tx',
      wallet,
      id: `fw:${hash}`,
      hash,
      block: fw.block,
      ts: null, // getLogs carries no timestamp; block orders it, a later pass can resolve
      direction: 'self',
      kind,
      asset: null,
      amount: null,
      counterparty: null,
      class: frameworkClass(fw),
    });
  }

  out.sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
  return out;
}
