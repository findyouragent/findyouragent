import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { ethers } from 'ethers';
import EscrowTrace from './EscrowTrace.jsx';
import FlowButton from './ui/flow-button.jsx';
import Select from './ui/select.jsx';
import { useI18n, uiMessage } from '../i18n/index.jsx';
import { loadHires, saveHire, mergeHires, updateHire, startHireOnce } from '../lib/hire-session.js';
import {
  ERC8183,
  hireSequence,
  recoverCreatedJob,
  readJob,
  settleJob,
  disputeJob,
  claimRefund,
  fetchDeliverable,
  explainTxError,
  formatU,
  offeringPriceU,
  parseUBaseUnits,
} from '../lib/erc8183.js';

const STEPS = [
  { key: 'approve', label: 'approve $U' },
  { key: 'create', label: 'create job' },
  { key: 'register', label: 'register dispute policy' },
  { key: 'budget', label: 'set budget' },
  { key: 'fund', label: 'fund escrow' },
];

// Which action produced which proof, in buyer language.
const TX_LABEL = { create: 'job created', fund: 'escrow funded', settle: 'payment released', refund: 'refund reclaimed', dispute: 'disputed' };

function JobRow({ hire, onResume, hiring }) {
  const { t } = useI18n();
  const [job, setJob] = useState(null);
  const [deliverable, setDeliverable] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  // The job's proof hashes: seeded from storage, appended as actions confirm.
  const [txs, setTxs] = useState({
    create: hire.createTx ?? null,
    fund: hire.fundTx ?? null, settle: hire.settleTx ?? null, refund: hire.refundTx ?? null, dispute: hire.disputeTx ?? null,
  });

  useEffect(() => {
    setTxs((prev) => ({ ...prev, create: hire.createTx ?? prev.create, fund: hire.fundTx ?? prev.fund }));
  }, [hire.createTx, hire.fundTx]);

  const refresh = useCallback(() => {
    readJob(hire.jobId)
      .then((j) => {
        setJob(j);
        if (j.statusCode >= 2 && j.deliverable !== ethers.constants.HashZero) {
          fetchDeliverable(j).then(setDeliverable);
        }
      })
      .catch(() => setNote('status read failed, retry'));
  }, [hire.jobId, hire.pending]);

  useEffect(refresh, [refresh]);

  async function act(kind, fn) {
    setBusy(kind);
    setNote(null);
    try {
      // Every action returns its mined receipt; the hash IS the proof, so it
      // is kept and rendered rather than dropped.
      const receipt = await fn(hire.jobId);
      const hash = receipt?.transactionHash ?? null;
      if (hash) {
        setTxs((t) => ({ ...t, [kind]: hash }));
        updateHire(hire.jobId, { [`${kind}Tx`]: hash });
      }
      setNote(uiMessage('{action} confirmed', { action: uiMessage(kind) }));
      refresh();
    } catch (err) {
      setNote(explainTxError(err));
    } finally {
      setBusy(null);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const canSettle = job?.settleAt && now >= job.settleAt && job.statusCode === 2;
  const canDispute = job?.settleAt && now < job.settleAt && job.statusCode === 2 && !job.disputed;
  // claimRefund is permissionless and accepts a Submitted job: refunding
  // delivered work is clawback, so this UI only offers it when nothing was
  // delivered by expiry.
  const canRefund = job && now >= job.expiredAt && job.statusCode === 1;

  return (
    <div className="job-row">
      <div className="job-head mono">
        <span>{t('job #{id}', { id: hire.jobId })}</span>
        <span className={`job-status status-${job?.status ?? 'loading'}`}>{t(job?.status ?? 'loading')}</span>
        <span>{formatU(hire.budgetWei)}</span>
        <a href={`https://bscscan.com/address/${ERC8183.kernel}`} target="_blank" rel="noreferrer">
          {t('kernel')} <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
        </a>
        <button className="row-link job-refresh" onClick={refresh}>
          {t('refresh')}
        </button>
      </div>
      <div className="job-desc">{hire.description}</div>
      {/*
        The job's receipt: each life-cycle step that happened, with the BscScan
        transaction that proves it. Delivery is the provider's own transaction,
        which this client did not sign, so it is evidenced by the on-chain
        submission time and the verified deliverable manifest above rather than
        by a hash we would have to guess at.
      */}
      {(txs.create || txs.fund || txs.settle || txs.refund || txs.dispute || job?.submittedAt) && (
        <div className="job-receipt mono">
          {['create', 'fund', 'dispute', 'refund', 'settle'].filter((k) => txs[k]).map((k) => (
            <a key={k} href={`https://bscscan.com/tx/${txs[k]}`} target="_blank" rel="noreferrer">
              {t(TX_LABEL[k])} <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
            </a>
          ))}
          {job?.submittedAt && (
            <span title={t("the provider's own transaction; its work is verified via the deliverable manifest above")}>
              {t('delivered on-chain')} {new Date(job.submittedAt * 1000).toISOString().slice(0, 10)}
            </span>
          )}
        </div>
      )}
      {job?.settleAt && job.statusCode === 2 && (
        <div className="job-note mono">
          {t('delivered · escrow releases in')}{' '}
          {(() => {
            const hoursLeft = Math.max(0, Math.ceil((job.settleAt - now) / 3600));
            return hoursLeft >= 48 ? `${Math.ceil(hoursLeft / 24)}d` : `${hoursLeft}h`;
          })()}
          {job.disputed ? t(' · disputed') : ''}
        </div>
      )}
      {deliverable && (
        <div className={`deliverable ${deliverable.valid === false ? 'exchange-err' : ''}`}>
          {deliverable.valid === true && <pre>{deliverable.text}</pre>}
          {deliverable.valid === false && t('Deliverable manifest failed verification: does not match this job.')}
          {deliverable.valid === null && t('Deliverable committed ({uri}) but not fetchable yet.', { uri: `ipfs://${deliverable.cid}` })}
        </div>
      )}
      <div className="job-actions">
        {hire.pending && job?.statusCode === 0 && now < job.expiredAt && (
          <button type="button" className="hire-btn" disabled={Boolean(busy) || hiring} onClick={() => onResume(hire)}>
            {t('continue funding this job')}
          </button>
        )}
        {canSettle && (
          <button className="hire-btn" disabled={busy} onClick={() => act('settle', settleJob)}>
            {busy === 'settle' ? t('settling…') : t('settle: release payment')}
          </button>
        )}
        {canDispute && (
          <button className="check-btn" disabled={busy} onClick={() => act('dispute', disputeJob)}>
            {busy === 'dispute' ? t('disputing…') : t('dispute deliverable')}
          </button>
        )}
        {canRefund && (
          <button className="check-btn" disabled={busy} onClick={() => act('refund', claimRefund)}>
            {busy === 'refund' ? t('claiming…') : t('reclaim: nothing delivered')}
          </button>
        )}
      </div>
      {note && <div className="job-note">{t(note)}</div>}
    </div>
  );
}

export default function HireAgent({ chainId, tokenId, service, served }) {
  const { t } = useI18n();
  const [customBudget, setCustomBudget] = useState('1');
  const [description, setDescription] = useState('');
  // The reviewed job, frozen. Set on submit and read by the signing sequence,
  // so what gets signed is the text that was on screen when it was approved
  // and not whatever the form holds by the time the wallet answers.
  const [review, setReview] = useState(null);
  const hireInFlight = useRef(false);
  const [step, setStep] = useState(null);
  // What each step actually did, keyed by step: the transaction that proves it,
  // or the reason it needed no signature. Kept after the sequence ends so the
  // record of how the escrow was opened outlives the opening.
  const [stepResults, setStepResults] = useState({});
  const [failedStep, setFailedStep] = useState(null);
  const [escrowMs, setEscrowMs] = useState(null);
  const [error, setError] = useState(null);
  const [storageWarning, setStorageWarning] = useState(null);
  const [done, setDone] = useState(null);
  const [hires, setHires] = useState(() =>
    loadHires().filter((h) => typeof h.provider === 'string' && h.provider.toLowerCase() === service.provider.toLowerCase())
  );
  const unresolvedCreation = hires.find((hire) => hire.creationPending);

  /*
    One job menu, from the two lists this page holds about the same agent.

    They were rendered as separate controls — priced offerings as chips, served
    capabilities as a dropdown — and they overlap: `launch_status` is on both.
    So the panel could show `launch status` chosen in one and `deployer_wallet`
    in the other at the same time, which is not a state a job can be in.

    Merged, the overlap stops being a bug and starts being the finding. Three
    kinds of row come out of it, and the difference between them is exactly
    what this site exists to report:

      priced and served   its menu names a price AND its endpoint listed it
      priced, not served  its menu names a price and its endpoint did not
      served, not priced  it did the work when asked, at no published price
  */
  const servedList = [...new Set((Array.isArray(served) ? served : []).filter((name) => typeof name === 'string' && name))];
  // Whether we hold a served list at all. Without one, nothing here may say
  // "not served" — that is unknown, and unknown is not a negative.
  const knowsServed = servedList.length > 0;
  const servedSet = new Set(servedList);
  const offerings = (Array.isArray(service.offerings) ? service.offerings : [])
    .filter((o) => o && typeof o.id === 'string' && o.id.trim());
  const pricedIds = new Set(offerings.map((o) => o.id));
  const menu = [
    ...offerings.map((o) => {
      const price = offeringPriceU(o);
      return {
        id: o.id,
        label: typeof o.label === 'string' && o.label ? o.label : o.id,
        priceU: price.amount,
        priceInvalid: price.status === 'invalid',
        served: knowsServed ? servedSet.has(o.id) : null,
      };
    }),
    ...servedList
      .filter((name) => !pricedIds.has(name))
      .map((name) => ({ id: name, label: name, priceU: null, served: true })),
  ];

  // Default to a job the agent both prices and demonstrably does; failing that,
  // the first thing it prices; failing that, a custom task.
  const [jobId, setJobId] = useState(
    () => (menu.find((m) => m.priceU && m.served !== false) ?? menu.find((m) => m.priceU) ?? menu.find((m) => !m.priceInvalid) ?? menu[0])?.id ?? ''
  );

  const job = menu.find((m) => m.id === jobId) ?? null;
  const priced = Boolean(job?.priceU);
  let budgetWei = null;
  try {
    if (!job?.priceInvalid) {
      budgetWei = parseUBaseUnits(priced ? job.priceU : ethers.utils.parseUnits(customBudget, 18).toString());
    }
  } catch {
    /* an invalid amount stays invalid; it never falls back to a default */
  }
  const belowFloor = budgetWei !== null && ethers.BigNumber.from(budgetWei).lt(ERC8183.minBudgetWei);

  // The string the kernel stores. A named job leads with its id because that is
  // what the provider's runtime dispatches on; the buyer's words follow it, and
  // are the whole description when no job is named.
  const task = job
    ? [`[${job.id}]`, description.trim()].filter(Boolean).join(' ')
    : description.trim();
  const ready = budgetWei !== null && !job?.priceInvalid && (Boolean(job) || Boolean(description.trim()));

  // Step one: nothing is signed here. The job is composed, then shown back in
  // full for approval, because the next click opens up to five wallet dialogs
  // and writes the description on-chain verbatim.
  function openReview(event) {
    event.preventDefault();
    if (hireInFlight.current || step || unresolvedCreation || belowFloor || !ready) return;
    setError(null);
    setDone(null);
    setStepResults({});
    setFailedStep(null);
    setEscrowMs(null);
    setReview({ task, budgetWei, jobLabel: job?.label ?? uiMessage('custom task') });
  }

  function hire(job) {
    if (!job.resumeJobId && unresolvedCreation) return null;
    return startHireOnce(hireInFlight, async () => {
      setStep('prepare');
      setError(null);
      setStorageWarning(null);
      setDone(null);
      setStepResults({});
      setFailedStep(null);
      setEscrowMs(null);
      const startedAt = Date.now();
      let reached = null;
      let entry = job.resumeJobId
        ? hires.find((hire) => hire.jobId === job.resumeJobId) ?? null
        : null;
      const remember = (patch) => {
        entry = { ...entry, ...patch };
        const saved = saveHire(entry);
        const snapshot = entry;
        setHires((prev) => mergeHires(snapshot, prev));
        if (!saved) setStorageWarning(uiMessage('This browser could not save {item}. Keep its transaction link before leaving this page.', { item: entry.jobId ? uiMessage('job #{id}', { id: entry.jobId }) : uiMessage('the creation transaction') }));
        return saved;
      };
      try {
        const result = await hireSequence({
          providerTba: service.provider,
          description: job.task,
          budgetWei: job.budgetWei,
          resumeJobId: job.resumeJobId ?? null,
          fundTx: entry?.fundTx ?? null,
          onCreateSubmitted: (submitted) => {
            remember({
              ...submitted, jobId: null, chainId, tokenId, provider: service.provider,
              budgetWei: job.budgetWei, description: job.task,
              createdAt: Date.now(), pending: true, creationPending: true,
            });
            setReview((prev) => ({ ...prev, creation: entry }));
          },
          onCreated: (created) => {
            remember({
              ...created, chainId, tokenId, provider: service.provider,
              budgetWei: job.budgetWei, description: job.task,
              createdAt: entry?.createdAt ?? Date.now(), pending: true, creationPending: false,
            });
            setReview((prev) => ({ ...prev, resumeJobId: created.jobId, creation: null }));
          },
          onStep: (key) => {
            reached = key;
            setStep(key);
          },
          onDone: (key, meta) => {
            setStepResults((prev) => ({ ...prev, [key]: meta }));
            if (entry && meta.tx) remember({ [`${key}Tx`]: meta.tx, ...(key === 'fund' ? { pending: false } : {}) });
          },
        });
        setEscrowMs(Date.now() - startedAt);
        const saved = remember({
          jobId: result.jobId,
          chainId,
          tokenId,
          provider: service.provider,
          budgetWei: job.budgetWei,
          description: job.task,
          createdAt: entry?.createdAt ?? Date.now(),
          pending: false,
          // The escrow-funding transaction: the first half of the job's receipt.
          fundTx: result.txHash ?? entry?.fundTx ?? null,
        });
        setDone(result);
        if (!saved) {
          setStorageWarning(uiMessage('Job #{id} is funded, but this browser could not save the job history. Keep the job number and escrow transaction link; this receipt remains available for this session.', { id: result.jobId }));
        }
        setReview(null);
        setDescription('');
      } catch (err) {
        setError(explainTxError(err));
        // The step that was in flight when it threw. Marking it is what turns a
        // dead trace into a report of where the sequence actually stopped.
        setFailedStep(reached);
      } finally {
        setStep(null);
      }
    });
  }

  function resumeHire(hire) {
    if (hireInFlight.current || step) return;
    setError(null);
    setDone(null);
    setStepResults({});
    setFailedStep(null);
    setEscrowMs(null);
    setReview({ task: hire.description, budgetWei: hire.budgetWei, jobLabel: uiMessage('saved job #{id}', { id: hire.jobId }), resumeJobId: hire.jobId });
  }

  function recoverCreation(creation) {
    return startHireOnce(hireInFlight, async () => {
      setStep('recover');
      setError(null);
      try {
        const created = await recoverCreatedJob(creation);
        const entry = { ...creation, ...created, creationPending: false, pending: true };
        const saved = saveHire(entry);
        setHires((prev) => mergeHires(entry, prev));
        if (!saved) setStorageWarning(uiMessage('Job #{id} was recovered, but this browser could not save it. Keep the job number and creation transaction link.', { id: entry.jobId }));
        setStepResults({ create: { tx: created.createTx } });
        setFailedStep(null);
        setReview({ task: entry.description, budgetWei: entry.budgetWei, jobLabel: uiMessage('saved job #{id}', { id: entry.jobId }), resumeJobId: entry.jobId });
      } catch (err) {
        if (err.code === 'CREATION_REVERTED') {
          const entry = { ...creation, creationPending: false, creationFailed: true, pending: false };
          saveHire(entry);
          setHires((prev) => mergeHires(entry, prev));
          setReview(null);
        }
        setError(explainTxError(err));
      } finally {
        setStep(null);
      }
    });
  }

  const running = Boolean(step) || Object.keys(stepResults).length > 0;
  const phase = running ? 'run' : review ? 'review' : 'job';
  const PHASES = ['job', 'review', 'run'];

  return (
    <section className="try-panel">
      <h2 className="micro-label">{t('hire this agent · erc-8183 escrow')}</h2>
      <p className="try-sub">
        {t('Your $U goes into on-chain escrow, the agent delivers, and payment releases after a {days} dispute window. Never delivered by expiry: you reclaim everything.', { days: ERC8183.chainId === 56 ? t('7 day') : '' })}
      </p>

      {/*
        Where you are in a sequence that costs money at the end of it. Gold is
        the accent colour here because this is the flow it represents, so the
        segments carry it: filled behind you, unlit ahead.
      */}
      <div className="hire-steps">
        <div className="hire-steps-head micro-label">
          <span>{t('step {current} of {total}', { current: PHASES.indexOf(phase) + 1, total: PHASES.length })}</span>
          <span className="hire-steps-now">{t(phase)}</span>
        </div>
        <ol className="hire-steps-track">
          {PHASES.map((name, i) => {
            const at = PHASES.indexOf(phase);
            const state = i < at ? 'is-done' : i === at ? 'is-now' : '';
            return (
              <li key={name} className={state} aria-current={i === at ? 'step' : undefined}>
                <span className="hire-step-bar" aria-hidden="true" />
                <span className="hire-step-name micro-label">{t(name)}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <form className="hire-form" onSubmit={openReview}>
        {!review && menu.length > 0 && (
          <label className="hire-job">
            <Select
              value={jobId}
              onChange={setJobId}
              label={t('job')}
              options={[
                ...menu.map((m) => ({
                  value: m.id,
                  label: `${m.label} · ${m.priceInvalid ? t('invalid published price') : m.priceU ? formatU(m.priceU) : t('name your budget')}${
                    m.served === false ? t(' · not served') : ''
                  }`,
                })),
                { value: '', label: t('custom task · name your budget') },
              ]}
            />
            {/* The gap between what an agent charges for and what it proved it
                can do is the finding this whole site is built to surface. It
                does not get softened at the one screen where it costs money. */}
            {job?.served === false && (
              <span className="job-note job-note-warn">
                {t('its hire menu prices this, but its endpoint did not list it when we last called. it may not be able to do the work.')}
              </span>
            )}
            {job?.priceInvalid && (
              <span className="job-note job-note-warn" role="alert">
                {t('This offering has an invalid published price. Choose another job or explicitly compose a custom task.')}
              </span>
            )}
            {job?.served === true && !job.priceU && !job.priceInvalid && (
              <span className="job-note">{t('it served this when we called it, but its menu names no price for it')}</span>
            )}
          </label>
        )}
        {!review && !priced && !job?.priceInvalid && (
          <label className="hire-budget">
            <span className="micro-label">{t('budget in $U')}</span>
            <input value={customBudget} onChange={(e) => setCustomBudget(e.target.value)} inputMode="decimal" />
            {budgetWei === null && <span className="job-note">{t('Enter a valid amount with up to 18 decimal places.')}</span>}
            {belowFloor && <span className="job-note">{t('providers skip jobs under 1 $U; the funds would sit until refund')}</span>}
          </label>
        )}
        {!review && (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={ERC8183.descriptionMax}
            // Keep this field focused on the buyer's own task description.
            placeholder={
              job
                ? t('anything {job} needs to know — optional, stored on-chain verbatim', { job: job.label })
                : t('describe the task. it is stored on-chain verbatim and read by the agent')
            }
            rows={3}
          />
        )}
        {!review && (
          <div className="hire-actions">
            {/* The label no longer mutates into the running step: the trace below
                narrates that, and in more detail than a button caption can. */}
            <FlowButton variant="gold" type="submit" disabled={Boolean(step) || Boolean(unresolvedCreation) || belowFloor || !ready}>
              {t('review')} · {formatU(budgetWei)}
            </FlowButton>
            {unresolvedCreation && <p className="job-note">{t('A previous creation transaction is unresolved. Check its receipt below before opening another job.')}</p>}
          </div>
        )}
        {/*
          Step two. The five wallet dialogs and an on-chain, verbatim, public
          description are all downstream of the next click, so everything that
          click commits to is restated here first — in the same words the job
          rows below will use once it exists.
        */}
        {review && (
          <div className="hire-review">
            <dl className="hire-review-rows">
              <div>
                <dt>{t('job')}</dt>
                <dd>{typeof review.jobLabel === 'string' ? review.jobLabel : t(review.jobLabel)}</dd>
              </div>
              <div>
                <dt>{t('request, on-chain verbatim')}</dt>
                <dd className="hire-review-task">{review.task}</dd>
              </div>
              <div>
                <dt>{t('escrowed now')}</dt>
                <dd className="mono hire-review-amount">{formatU(review.budgetWei)}</dd>
              </div>
              <div>
                <dt>{t('released to')}</dt>
                <dd className="mono">{service.provider}</dd>
              </div>
              <div>
                <dt>{t('if it delivers')}</dt>
                <dd>
                  {t('payment releases after the {days} dispute window, and you can dispute inside it', { days: ERC8183.chainId === 56 ? t('7 day') : '' })}
                </dd>
              </div>
              <div>
                <dt>{t('if it never delivers')}</dt>
                <dd>{t('you reclaim the full amount after {days} days', { days: ERC8183.expiryDays })}</dd>
              </div>
              <div>
                <dt>{t('wallet confirmations')}</dt>
                <dd>
                  {t('up to {count}: {steps}', { count: STEPS.length, steps: STEPS.map((s) => t(s.label)).join(', ') })}
                </dd>
              </div>
            </dl>
            {step === 'recover' ? (
              <p className="job-note" role="status">{t('Checking the saved creation receipt. No transaction is being submitted.')}</p>
            ) : step === 'prepare' ? (
              <p className="job-note" role="status">{t('Preparing your wallet and checking the account. This hire is already in progress.')}</p>
            ) : !step && <p className="job-note">{review.creation
              ? t('The creation transaction was submitted. Check its receipt before continuing; this will not submit another transaction.')
              : review.resumeJobId
              ? t('Job #{id} already exists. Continue to check its on-chain state and finish the remaining funding steps.', { id: review.resumeJobId })
              : Object.keys(stepResults).length > 0 ? t('The sequence stopped. Confirm to check your wallet and continue.') : t('Nothing is signed yet. Confirm below to open the escrow.')}</p>}
            <div className="hire-actions">
              <FlowButton variant="gold" type="button" disabled={Boolean(step)} onClick={() => review.creation ? recoverCreation(review.creation) : hire(review)}>
                {step === 'recover' ? t('checking receipt…') : step === 'prepare' ? t('preparing wallet…') : step ? t('signing…') : review.creation ? t('check creation receipt') : review.resumeJobId ? t('continue job #{id}', { id: review.resumeJobId }) : t('confirm · escrow {amount}', { amount: formatU(review.budgetWei) })}
              </FlowButton>
              <button type="button" className="check-btn" disabled={Boolean(step)} onClick={() => setReview(null)}>
                {review.resumeJobId || review.creation ? t('close saved job') : t('edit the job')}
              </button>
            </div>
          </div>
        )}
        <EscrowTrace
          steps={STEPS}
          current={step === 'prepare' || step === 'recover' ? null : step}
          results={stepResults}
          elapsedMs={escrowMs}
          failed={failedStep}
        />
      </form>

      {error && <div className="exchange-a exchange-err">{t(error)}</div>}
      {done && (
        <div className="receipt mono">
          {t('job #{id} funded', { id: done.jobId })} ·{' '}
          {done.txHash && <a href={`https://bscscan.com/tx/${done.txHash}`} target="_blank" rel="noreferrer">
            {t('escrow tx')} <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>}
          {done.txHash && ' · '}{t('track this job below')}
        </div>
      )}
      {storageWarning && <div className="job-note job-note-warn" role="status">{t(storageWarning)}</div>}

      {hires.length > 0 && (
        <div className="hire-jobs">
          <h3 className="micro-label">{t('your jobs with this agent')}</h3>
          {hires.map((h) => h.jobId ? (
            <JobRow key={h.jobId} hire={h} onResume={resumeHire} hiring={Boolean(step)} />
          ) : h.createRequestTx ? (
            <div className="job-row" key={h.createRequestTx}>
              <div className="job-head mono"><span>{h.creationFailed ? t('creation reverted') : t('creation submitted · receipt unresolved')}</span></div>
              <div className="job-desc">{h.description}</div>
              <div className="job-receipt mono"><a href={`https://bscscan.com/tx/${h.createRequestTx}`} target="_blank" rel="noreferrer">{t('creation transaction')} <ExternalLink size={10} strokeWidth={2} aria-hidden="true" /></a></div>
              {h.creationPending && <div className="job-actions"><button type="button" className="check-btn" disabled={Boolean(step)} onClick={() => recoverCreation(h)}>{t('check creation receipt')}</button></div>}
            </div>
          ) : null)}
        </div>
      )}
    </section>
  );
}
