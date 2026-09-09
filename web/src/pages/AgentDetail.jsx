import { useI18n, translate } from '../i18n/index.jsx';
import { useEffect, useRef, useState } from 'react';
import CheckTrace from '../components/CheckTrace.jsx';
import WeaveSpinner from '../components/ui/weave-spinner.jsx';
import { FlowButton } from '../components/ui/flow-button.jsx';
import { ChevronRight, ArrowLeft, ArrowRight } from 'lucide-react';
import { getAgentDetail, getCheckHistory, getAgentMeta, getActivity, getEscrowRecord, verifyStreamed } from '../api/client.js';
import { VERIFY_BASE, TIER_META, scanAgentUrl } from '../config.js';
import { timeAgo } from '../utils/format.js';
import TryAgent from '../components/TryAgent.jsx';
import ProviderHandoff from '../components/ProviderHandoff.jsx';
import HireAgent from '../components/HireAgent.jsx';
import EscrowRecord from '../components/EscrowRecord.jsx';
import { describeRecord, RECORD_KINDS } from '../lib/escrow-record.js';
import NarrativeSummary from '../components/NarrativeSummary.jsx';
import PlainAnswers from '../components/PlainAnswers.jsx';
import AgentModel from '../components/AgentModel.jsx';
import UptimeStrip, { uptimeSummary } from '../components/UptimeStrip.jsx';
import ActivityPanel, { activitySummary } from '../components/ActivityPanel.jsx';
import { X402Badge } from '../components/TokenMark.jsx';
import { bannerWhy, safeIds } from '../lib/narrate.js';
import { imageUrl, alternateGateway, avatarGradient } from '../lib/media.js';
import TermText from '../components/TermText.jsx';
import { findErc8183Service } from '../lib/erc8183.js';
import { hasAgentMetadata } from '../lib/agent-metadata.js';
import SavedAgentEvidence, { SavedCheckRecord } from '../components/SavedAgentEvidence.jsx';
import { fetchSavedAgentEvidence, retainSavedEvidence, startDetailRecovery } from '../lib/saved-agent-evidence.js';
import { logicActivityTimestamp } from '../lib/logic-activity.js';
import { fetchMemoryEvidence, provenTokenAccount } from '../lib/memory-evidence.js';
import MemoryEvidence, { memorySummary } from '../components/MemoryEvidence.jsx';

function short(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
}

// The cheapest priced offering on a hire menu, so the preflight line can say
// what this costs before the first wallet popup. null when the menu names no
// price — omitted from the sentence rather than shown as free.
function cheapestOffering(service) {
  const prices = (service?.offerings ?? [])
    .map((o) => String(o?.priceU ?? ''))
    .filter((p) => /^\d{1,40}$/.test(p) && BigInt(p) > 0n);
  if (!prices.length) return null;
  const min = prices.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
  const value = Number(min) / 1e18;
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${value < 0.0001 ? '<0.0001' : String(Number(value.toFixed(4)))} $U`;
}

function bnb(wei) {
  if (wei == null) return '—';
  const value = Number(wei) / 1e18;
  return `${value < 0.0001 && value > 0 ? '<0.0001' : value.toFixed(4)} BNB`;
}

// The on-chain trade counter is lifetime and cumulative, so a raw "6 trades"
// can describe activity that happened entirely before this site first looked.
// This isolates what changed across the window we ACTUALLY observed: the delta
// from the oldest stored reading that carried a count, to the current one.
// Returns null unless there is an earlier, distinct reading to stand on, so the
// page never claims to have witnessed a change it did not watch. A negative
// delta (a lifetime counter moving backwards) is a data anomaly, not a finding,
// and is suppressed rather than rendered.
function observedTradeChange(checks, currentTrades) {
  if (currentTrades == null || !Array.isArray(checks) || checks.length < 2) return null;
  const newest = checks[0];
  let baseline = null;
  for (let i = checks.length - 1; i >= 0; i -= 1) {
    if (checks[i]?.bap578?.totalTrades != null) {
      baseline = checks[i];
      break;
    }
  }
  if (!baseline || baseline === newest || baseline.bap578.totalTrades == null) return null;
  const delta = currentTrades - baseline.bap578.totalTrades;
  if (delta < 0) return null;
  return { delta, since: baseline.ts };
}

/*
 * One log line per probe frame, in the same honest register as everything
 * else: a line exists only because its real call resolved, an undeclared
 * surface produces no line at all, and a failure is worded as ours or theirs
 * exactly as the evidence rows below would word it.
 */
function describeCheckEvent(evt) {
  const s = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
  switch (evt.step) {
    case 'registry':
      return translate("reading registry entry … ok");
    case 'card':
      return translate("fetching its identity file … {value1}", { value1: evt.ok
        ? (evt.ownWallet ? translate("ok · wallet claim proved") : translate("ok"))
        : translate(evt.status === 'absent' ? 'none published' : evt.status === 'invalid'
          ? 'document is not a valid identity object' : evt.status === 'unsupported'
            ? 'document location unsupported' : 'could not read; presence unknown') });
    case 'a2a':
      if (!evt.declared) return null;
      return evt.reachable
        ? translate("calling a2a endpoint … answered in {value1}ms", { value1: evt.latencyMs })
        : translate("calling a2a endpoint … no reply{value1}", { value1: evt.reason ? ` · ${evt.reason}` : '' });
    case 'mcp':
      if (!evt.declared) return null;
      return evt.reachable
        ? translate("asking its mcp server for tools … {value1}", { value1: evt.servesTools ? translate("{value1} tools served", { value1: evt.toolCount }) : translate("none listed") })
        : translate("asking its mcp server … no reply");
    case 'wallet':
      if (!evt.address) return null;
      return evt.checked
        ? translate("reading wallet {value1} … {value2} txs", { value1: s(evt.address), value2: evt.txCount })
        : translate("reading wallet {value1} … node did not answer", { value1: s(evt.address) });
    case 'bazaar':
      return evt.checked
        ? translate("settlement lookup … {value1}", { value1: evt.listed ? translate("listed{value1}", { value1: evt.calls30d != null ? translate(" · {value1} calls in 30d", { value1: evt.calls30d }) : '' }) : translate("none on record") })
        : translate("settlement lookup … lookup failed");
    case 'bap578':
      return translate("on-chain token check … {value1}", { value1: evt.attributed === true ? translate("token {value1} attributed", { value1: evt.tokenId }) : evt.attributed === false ? translate("not attributed") : translate("could not check") });
    default:
      return null;
  }
}

/*
  The identifiers themselves, not just how many of them there are.

  "22 tools served" was a count with no way to see the 22: a reader opened the
  row the number came from and found the same number again. These are the
  agent's own names for its capabilities, so they are echoed rather than
  described, in mono — their material, our voice kept apart from it — through
  the same safeIds guard the narrative uses, since normalizeCapability on the
  server lowercases and snake_cases but does not restrict the alphabet.

  When the guard drops any, the row says so. A list quietly shorter than the
  count beside it is the kind of silent gap this page exists to not have.
*/
function EchoedIds({ label, ids }) {
  const { t, locale } = useI18n();
  const shown = safeIds(ids);
  if (!shown.length) return null;
  const dropped = (Array.isArray(ids) ? ids.length : 0) - shown.length;
  return (
    <div className="evidence-row">
      <span className="micro-label">{t(label)}</span>
      <span className="evidence-value mono evidence-ids">
        {shown.join(', ')}
        {dropped > 0 && translate(" · {value1} not shown (unexpected characters)", { value1: dropped })}
      </span>
    </div>
  );
}

function EvidenceRow({ label, value, href, ok }) {
  const { t, locale } = useI18n();
  return (
    <div className="evidence-row">
      <span className="micro-label">{t(label)}</span>
      <span className={`evidence-value mono ${ok === true ? 'ev-ok' : ok === false ? 'ev-bad' : ''}`}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </span>
    </div>
  );
}

// One fixed plain sentence per section, keyed by anchor id. Procedure, not
// outcome: "we tried X and recorded what happened" stays true on the branch
// where nothing came back and on the branch where the url never parsed.
const SECTION_SUBTITLES = {
  'ev-a2a': 'We tried the contact address this agent publishes and recorded exactly what happened.',
  'ev-mcp': 'We asked its tool interface what it can do and recorded exactly what happened.',
  'ev-capability': 'What its public listing says it can do, next to what its live server actually offered when we asked.',
  'ev-bap578': 'The on-chain agent token its identity file names: whether that claim checks out, and, when it does, what a buyer would actually receive.',
  'ev-wallet': 'The blockchain account linked to it, and whether that account is provably its own.',
  'ev-b402': 'Whether any real payment to this agent has settled, on a public record that only lists completed payments.',
  'ev-registry': 'What the public directory itself records about this agent: feedback left against its entry, and the directory’s own health check.',
  'ev-probe': 'This agent publishes no address to call, so there was nothing to try.',
  'ev-narrative': 'The verdict in full sentences, composed from the checks, not by a model. Each sentence links to the row it restates.',
};

/*
 * A collapsible evidence section. Collapsed, it is ONE line: the label, an
 * honest summary phrase, a chevron. Nothing is removed from the page; every
 * row is one click down. The narrative's jump control dispatches `ev-open` on
 * the target before scrolling, so a sentence always lands on an open row.
 *
 * The optional id is the anchor that jump scrolls to. tabIndex -1 lets it move
 * focus here programmatically (screen readers announce the landing) without
 * adding the section to the tab order.
 */
function EvidenceSection({ title, children, id, summary, defaultOpen = false }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
/* The evidence row owns its open state and focus flash so jump links work for collapsed rows. */
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef(null);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onOpen = () => {
      setOpen(true);
      clearTimeout(flashTimer.current);
      // Drop it for one frame first, so a second jump to the same row restarts
      // the animation instead of landing on a ring that is already fading.
      setFlash(false);
      window.requestAnimationFrame(() => setFlash(true));
      flashTimer.current = setTimeout(() => setFlash(false), 1700);
    };
    el.addEventListener('ev-open', onOpen);
    return () => {
      el.removeEventListener('ev-open', onOpen);
      clearTimeout(flashTimer.current);
    };
  }, []);
  const tone = summary?.ok === true ? 'ev-ok' : summary?.ok === false ? 'ev-bad' : '';
  return (
    <section ref={ref} className={`evidence-section ${open ? 'is-open' : ''} ${flash ? 'ev-flash' : ''}`} id={id} tabIndex={id ? -1 : undefined}>
      <button type="button" className="ev-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="micro-label" role="heading" aria-level={3}>{t(title)}</span>
        {summary?.text && <span className={`ev-summary ${tone}`}>{t(summary.text)}</span>}
        <span className="ev-chevron" aria-hidden="true"><ChevronRight size={12} strokeWidth={2} /></span>
      </button>
      {open && (
        <div className="ev-body">
          {id && SECTION_SUBTITLES[id] && (
            <p className="evidence-sub"><TermText text={t(SECTION_SUBTITLES[id])} /></p>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

/*
 * The one-line summaries for collapsed sections. Every phrase is exactly as
 * strong as the field it restates, and an unknown reads as unknown ("check
 * failed", "not checked"), never as a zero or a blank.
 */
function sectionSummaries({ verdict, ev, checks, escrow }) {
  const s = {};
  const e = ev?.endpoint;
  if (e?.declared) {
    s.a2a = e.reachable
      ? { text: translate("answered · {value1} · {value2}ms · {value3}", { value1: e.status, value2: e.latencyMs, value3: e.hasAgentCard ? translate("card with {value1} skills", { value1: e.skillsCount ?? 0 }) : translate("no agent card") }), ok: Boolean(e.hasAgentCard) }
      : { text: translate("no reply{value1}", { value1: e.reason ? ` · ${e.reason}` : '' }), ok: false };
  }
  const m = ev?.mcp;
  if (m?.declared) {
    s.mcp = m.reachable
      ? { text: translate("answered · {value1}", { value1: m.servesTools ? translate("{value1} tools served", { value1: m.toolCount }) : translate("no tools listed") }), ok: Boolean(m.servesTools) }
      : { text: translate("no reply{value1}", { value1: m.reason ? ` · ${m.reason}` : '' }), ok: false };
  }
  const c = verdict?.capability;
  if (c) {
    s.capability = c.missing?.length
      ? { text: translate("serves {value1} of {value2} it advertises", { value1: c.matched ?? 0, value2: c.declared }), ok: false }
      : { text: translate("serves all {value1} it advertises", { value1: c.declared }), ok: true };
  }
  const b = verdict?.bap578;
  if (b) {
    if (b.unsupported) s.bap578 = { text: translate("claims a token on a collection that does not implement the standard"), ok: false };
    else if (b.ownershipVerified === true) {
      const mt = b.metrics?.reported ? translate(" · {value1} trades recorded by logic contract", { value1: b.metrics.totalTrades }) : '';
      s.bap578 = { text: translate("token {value1} attributed on-chain{value2}", { value1: b.tokenId, value2: mt }), ok: true };
    } else if (b.ownershipVerified === false) s.bap578 = { text: translate("claims token {value1} · not attributed", { value1: b.tokenId }), ok: false };
    else s.bap578 = { text: translate("claims token {value1} · not checked", { value1: b.tokenId }), ok: undefined };
  }
  const w = ev?.wallet;
  s.wallet = !w?.checked
    ? { text: translate("check failed"), ok: undefined }
    : { text: translate("{value1} · {value2} tx", { value1: w.isOwnWallet ? translate("own wallet, proved") : translate("registrant's address"), value2: w.txCount }), ok: w.isOwnWallet ? true : undefined };
  const z = ev?.bazaar;
  s.b402 = z?.listed
    ? { text: translate("listed{value1}", { value1: z.calls30d != null ? translate(" · {value1} calls in 30d", { value1: z.calls30d }) : '' }), ok: true }
    : z?.checked ? { text: translate("not listed"), ok: undefined } : { text: translate("lookup failed"), ok: undefined };
  const r = ev?.registry;
  s.registry = {
    // Three states, not two: their record can say verified, say unverified, or
    // not have been read at all, and the third was rendering as the second.
    text: `${r?.feedbackCount == null ? translate("feedbacks not known") : translate("{value1} feedbacks", { value1: r.feedbackCount })} · ${
      r?.isEndpointVerified == null
        ? translate("registry endpoint check not read")
        : r.isEndpointVerified ? translate("registry-verified endpoint") : translate("not registry-verified")}`,
    // Both clauses have to be positive. Keyed on the feedback count alone, this
    // painted "1 feedbacks · not registry-verified" green — the ok colour over a
    // clause saying the endpoint is not verified, which is the opposite claim.
    ok: (r?.feedbackCount ?? 0) > 0 && r?.isEndpointVerified ? true : undefined,
  };
  s.history = { text: translate("last {value1} checks kept", { value1: checks.length }), ok: undefined };
  /*
    Read from the same describeRecord the panel below draws, so the closed
    summary and the open body can never disagree.

    No `ok` in any branch. Released jobs are not a pass: the contract releases
    on its own once the dispute window shuts, which the panel says in as many
    words, and a green summary line would score the agent for a timer expiring.
    Absent is not a fail either — it is the range we looked at, not a finding.
  */
  if (escrow?.result) {
    const v = describeRecord(escrow.result);
    if (v.kind === RECORD_KINDS.present) {
      const counts = [translate("{value1} job{value2}", { value1: v.jobs, value2: v.jobs === 1 ? '' : 's' }), ...v.parts];
      s.escrow = { text: counts.join(' · '), ok: undefined };
    } else if (v.kind === RECORD_KINDS.absent) {
      s.escrow = { text: translate("no jobs in the range we read"), ok: undefined };
    } else {
      s.escrow = { text: translate("no census on this deployment"), ok: undefined };
    }
  }
  return s;
}

export default function AgentDetail({ chainId, tokenId, initialAction = null, backHref = '#' }) {
  // Route changes reset the entire evidence/action session before rendering.
  // Old async work is also fenced by the effect cleanup below.
  return <AgentDetailView key={`${chainId}:${tokenId}`} chainId={chainId} tokenId={tokenId} initialAction={initialAction} backHref={backHref} />;
}

function AgentDetailView({ chainId, tokenId, initialAction, backHref }) {
  const { t, locale } = useI18n();
  const [agent, setAgent] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [hireService, setHireService] = useState(null);
  const [metadataState, setMetadataState] = useState('loading');
  // The agent's own record on the ERC-8183 escrow: { result, address, source }.
  // Held next to the hire menu because it is the menu's counterweight — what
  // the kernel says was really opened against the wallet the menu points at.
  const [escrow, setEscrow] = useState(null);
  const [media, setMedia] = useState(null);
  const [checks, setChecks] = useState([]);
  const [uptime, setUptime] = useState(null);
  const [activity, setActivity] = useState(null);
  const [memory, setMemory] = useState(null);
  const [memoryRetry, setMemoryRetry] = useState(0);
  // Why the verdict is missing ('throttled' | 'failed'), and a counter that
  // re-runs only the verification — a transient registry throttle should cost
  // one click, not a full reload that refetches the detail already on screen.
  const [verifyError, setVerifyError] = useState(null);
  const [retryTick, setRetryTick] = useState(0);
  // Live narration of the running check: one line per probe as it resolves.
  const [checkLog, setCheckLog] = useState([]);
  // Real elapsed time of the last check, so the settled label reports a
  // measurement rather than an estimate.
  const [checkMs, setCheckMs] = useState(null);
  // Which action panel is open under the verdict: 'try' | 'hire' | null.
  const [openAction, setOpenAction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [savedEvidence, setSavedEvidence] = useState(null);

  useEffect(() => {
    setLoading(true);
    setAgent(null);
    setVerdict(null);
    setChecks([]);
    // Without this the previous agent's calendar stays on screen while the new
    // one loads, which is a reading attributed to the wrong agent.
    setUptime(null);
    setActivity(null);
    setMemory(null);
    setVerifyError(null);
    // A row's "try"/"hire" link arrives with the panel it asked for already
    // open; the button itself stays disabled until the data proves it can act.
    setOpenAction(initialAction === 'try' || initialAction === 'hire' ? initialAction : null);
    setMedia(null);
    setHireService(null);
    setMetadataState('loading');
    setEscrow(null);
    const session = startDetailRecovery({
      loadDetail: () => getAgentDetail(chainId, tokenId),
      loadSaved: () => fetchSavedAgentEvidence({ serviceBase: VERIFY_BASE, chainId, tokenId }),
      onDetail: data => { setAgent(data); setError(null); },
      onError: err => setError(Object.assign(err, { retryAt: Date.now() + (err.retryAfterMs ?? 0) })),
      onSaved: data => setSavedEvidence(previous => retainSavedEvidence(previous, data)),
      onSettled: () => setLoading(false),
    });
    return () => session.cancel();
  }, [chainId, tokenId, loadAttempt]);

  useEffect(() => {
    if (!agent) return undefined;
    let cancelled = false;
    setMetadataState('loading');
    // A refresh must not leave the previously accepted provider usable while
    // the new registry document is being read.
    setHireService(null);
    getAgentMeta(chainId, tokenId).then(data => {
      if (cancelled) return;
      if (!hasAgentMetadata(data)) {
        setMetadataState('unavailable');
        return;
      }
      setHireService(findErc8183Service(data?.meta));
      setMedia(data?.media ?? null);
      setMetadataState('ready');
    }).catch(() => { if (!cancelled) setMetadataState('unavailable'); });
    return () => { cancelled = true; };
  }, [agent, chainId, tokenId]);

  /*
    The agent's escrow record, looked up once an address to look up exists.

    Which address, and how hard the answer is allowed to push:

    - A published hire menu names a payout wallet. That is the address a buyer
      would send a budget to, so its record is shown whether or not the census
      found anything — "no jobs against the wallet you would be paying" is
      exactly as useful as a list of jobs, and it is the direct counterweight
      to the menu.
    - With no menu, the registration's agent wallet is the only candidate, and
      a line on every one of a quarter-million pages saying nothing was found
      would be noise standing where a finding goes. So that one is rendered
      only when the census DID see it — a positive fact a reader could not
      have got anywhere else.

    Both addresses are self-declared, which is why the line says whose claim it
    is reading. A record proves the address worked; the agent's own card is
    what ties the address to the agent.
  */
  useEffect(() => {
    const menuAddress = hireService?.provider ?? null;
    const walletAddress = agent?.agent_wallet ?? null;
    const address = menuAddress || walletAddress;
    if (!address) return undefined;
    let cancelled = false;
    getEscrowRecord(address)
      .then((result) => {
        if (cancelled) return;
        if (!menuAddress && !result?.found) return; // nothing worth a line
        setEscrow({ result, address, source: menuAddress ? 'menu' : 'wallet' });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hireService?.provider, agent?.agent_wallet]);

  // One path for the first check and each deliberate retry. It starts only
  // after registry identity resolves, and never re-fetches registry detail.
  useEffect(() => {
    if (!agent || !VERIFY_BASE) return undefined;
    let cancelled = false;
    setVerifying(true);
    setVerifyError(previous => previous === 'identity' ? previous : null);
    setCheckLog([]);
    // The clock restarts with the log. Keeping the previous elapsed time would
    // put the first check's duration next to this one's probe count.
    setCheckMs(null);
    const startedAt = Date.now();
    verifyStreamed(chainId, tokenId, (evt) => {
      if (cancelled) return;
      const line = describeCheckEvent(evt);
      if (line) setCheckLog((log) => [...log, evt]);
    })
      .then((v) => {
        if (cancelled) return;
        setCheckMs(Date.now() - startedAt);
        setVerdict(v);
        setVerifyError(null);
        getActivity(chainId, tokenId).then((a) => !cancelled && setActivity(a)).catch(() => {});
        return getCheckHistory(chainId, tokenId).then((h) => {
          if (cancelled) return;
          setChecks(h.checks);
          setUptime(h.uptime);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setCheckMs(Date.now() - startedAt);
        setVerdict({ tier: null, error: true });
        setVerifyError(err?.identityUnavailable ? 'identity' : err?.throttled ? 'throttled' : 'failed');
      })
      .finally(() => !cancelled && setVerifying(false));
    return () => {
      cancelled = true;
    };
  }, [agent, retryTick, chainId, tokenId]);

  useEffect(() => {
    if (verifyError !== 'identity') return undefined;
    let cancelled = false;
    fetchSavedAgentEvidence({ serviceBase: VERIFY_BASE, chainId, tokenId })
      .then(record => { if (!cancelled) setSavedEvidence(previous => retainSavedEvidence(previous, record)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [verifyError, chainId, tokenId]);

  // Supplemental evidence has its own read and retry. It never changes tiers
  // or delays the endpoint check, and old route responses cannot cross agents.
  useEffect(() => {
    const savedToken = verifyError === 'identity' && savedEvidence?.latest?.bap578?.ownershipVerified === true;
    if ((!verdict?.bap578 && !savedToken) || verifying) return undefined;
    let cancelled = false;
    setMemory(null);
    fetchMemoryEvidence({ serviceBase: VERIFY_BASE, chainId, tokenId })
      .then(record => { if (!cancelled) setMemory(record); });
    return () => { cancelled = true; };
  }, [verdict, verifying, chainId, tokenId, memoryRetry, verifyError, savedEvidence?.latest?.bap578]);

  // A slow lookup is still loading, not an outage. Keep saved observations
  // ready in the background, but reveal the recovery view only after failure.
  if (loading && !error) {
    return (
      <div className="table-status is-loading">
        <WeaveSpinner size={120} />
        {t("reading the registry")}
      </div>
    );
  }
  if (error || !agent) {
    return <SavedAgentEvidence chainId={chainId} tokenId={tokenId} error={error} saved={savedEvidence}
      loading={loading} backHref={backHref} onRetry={() => setLoadAttempt(attempt => attempt + 1)} />;
  }

  const endpoint = agent.services?.a2a?.endpoint || null;
  const mcpEndpoint = agent.services?.mcp?.endpoint || null;
  const tier = verdict?.tier ? TIER_META[verdict.tier] : null;
  const ev = verdict?.evidence;
  const initial = (agent.name || '?').trim().charAt(0).toUpperCase();
  const verdictReady = !verifying && verdict && !verdict.error;
  const tryable = Boolean(VERIFY_BASE && verdict?.endpointProven);
  const sums = sectionSummaries({ verdict, ev, checks, escrow });
  const activityGate = activity?.attribution?.gate;
  const showActivity = Boolean(activity) && (activityGate === 'verified' || activityGate === 'no-proved-wallet' || activityGate === 'no-wallet-yet');
  const tokenAccount = provenTokenAccount(verdict);

  const openPanel = (which) => {
    setOpenAction((cur) => (cur === which ? null : which));
    if (openAction !== which) {
      document.querySelector('.detail-actions')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'start',
      });
    }
  };

  return (
    <div className="detail">
      {/* Returns to the list the visitor actually came from — their tab,
          category, filter and page, not a reset first page. */}
      <a className="back-link" href={backHref}>
        <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" /> {t("all agents")}
      </a>
      {/* The header keeps the registered identity visible above the evidence. */}
      <header className="detail-header identity-head">
          {/* Same gradient as the listing row, behind the portrait rather
              than only in place of it, so the agent's colour survives a slow
              or dead gateway here too. */}
          <span
            className="avatar-wrap avatar-wrap-lg"
            style={{ backgroundImage: avatarGradient(tokenId) }}
          >
          {agent.image_url || (media?.kind === 'image' && media.source === 'registration' && imageUrl(media.url)) ? (
            <img
              src={agent.image_url || imageUrl(media.url)}
              alt=""
              onError={(e) => {
                // A real image on a flaky gateway is not a missing image:
                // try the next public gateway for the same CID first.
                const next = alternateGateway(e.currentTarget.src);
                if (next) { e.currentTarget.src = next; return; }
                e.currentTarget.style.display = 'none';
                e.currentTarget.nextElementSibling.style.display = 'grid';
              }}
            />
          ) : null}
          <span
            className="avatar-fallback avatar-lg"
            style={{ display: agent.image_url || (media?.kind === 'image' && media.source === 'registration' && imageUrl(media.url)) ? 'none' : 'grid' }}
          >
            {initial}
          </span>
          </span>
        <div>
          <h1>{agent.name || translate("agent #{value1}", { value1: tokenId })}</h1>
          <span className="agent-token mono">#{tokenId} · BSC</span>
        </div>
      </header>
      <ProviderHandoff agent={agent} />
      <div className="detail-grid">
        <section className="evidence-panel">
          <div className="evidence-head">
            <h2 className="micro-label">{t("verification evidence")}</h2>
            {verdict && !verdict.error && (
              <span className="mono evidence-stamp">
                {t("formula v")}{verdict.formulaVersion} · {timeAgo(verdict.computedAt)}
              </span>
            )}
          </div>

          {/* The verdict banner names the tier and explains its basis. */}
          {verdictReady && tier && (
            <div className={`tier-banner banner-${verdict.tier}`}>
              <span className="micro-label banner-label">{t("verdict")}</span>
              <strong>{t(tier.label)}</strong>
              <span className="banner-why">{t(bannerWhy(verdict))}</span>
            </div>
          )}

          {/* Keep try and hire actions beside the verdict, with clear disabled states. */}
          <div className="detail-actions">
            {/* The label changes with state, so these take children rather
                than the reference's text prop. */}
            <FlowButton
              variant="neutral"
              className={openAction === 'try' ? 'is-active' : ''}
              type="button"
              disabled={!tryable}
              aria-expanded={openAction === 'try'}
              aria-controls="detail-try-panel"
              title={tryable ? translate("Send it a real request, read-only, before you commit anything") : translate("Try needs a verified live endpoint")}
              onClick={() => openPanel('try')}
            >
              {openAction === 'try' ? translate("close preview") : translate("try it · read-only")}
            </FlowButton>
            <FlowButton
              variant="gold"
              className={openAction === 'hire' ? 'is-active' : ''}
              type="button"
              disabled={!hireService}
              aria-expanded={openAction === 'hire'}
              aria-controls="detail-hire-panel"
              title={hireService ? translate("Escrow-backed hire via ERC-8183") : metadataState === 'ready' ? translate("This agent does not advertise ERC-8183 hire services in its registry metadata") : translate("The hire menu has not been read yet.")}
              onClick={() => openPanel('hire')}
            >
              {openAction === 'hire' ? translate("close hire") : translate("hire · escrow")}
            </FlowButton>
            {metadataState === 'unavailable' && (
              <p className="action-why" role="status">
                {translate("The hire menu could not be read.")}
              </p>
            )}
            {!hireService && (metadataState === 'ready' || metadataState === 'loading') && (
              <p className="action-why">
                {metadataState === 'loading'
                  ? translate("reading the latest hire menu…")
                  : verifying
                  ? translate("checking whether this agent can be tried or hired…")
                  : translate(!tryable
                    ? "Nothing to act on yet: no verified live endpoint to try, and no ERC-8183 hire menu published."
                    : "No ERC-8183 hire menu published.")}
              </p>
            )}
            {/*
              What happens to your money, before the first wallet popup rather
              than discovered by living through five of them. Every clause is a
              fact about the escrow this site hires through; the price is
              omitted entirely when the published menu names none.
            */}
            {hireService && (
              <p className="action-why">
                {cheapestOffering(hireService) ? translate("from {value1} · ", { value1: cheapestOffering(hireService) }) : ''}
                {t("your budget locks in escrow on BNB Chain and is released only when you settle · reclaimable in full if nothing is delivered · up to 5 wallet confirmations")}
              </p>
            )}
          </div>

          {/* Keep each action's form next to its trigger, ahead of the evidence. */}
          {openAction === 'try' && (
            <div id="detail-try-panel" className="detail-inline-panel">
              {/* Either protocol answering makes the agent tryable. Gating on the
                  A2A probe alone hid the panel from every MCP-only agent, which
                  is most of the ones this site pins. */}
              <TryAgent chainId={chainId} tokenId={tokenId} reachable={tryable} />
            </div>
          )}
          {openAction === 'hire' && hireService && (
            <div id="detail-hire-panel" className="detail-inline-panel">
              {/* The capability names the last check saw SERVED, so the hire
                  form can offer this agent's real jobs instead of a blank box. */}
              <HireAgent
                chainId={chainId}
                tokenId={tokenId}
                service={hireService}
                served={verdict?.servedNames}
              />
            </div>
          )}

{/* Plain answers lead the technical evidence and link each claim to its supporting row. */}
          {verdictReady && (
            <PlainAnswers
              verdict={verdict}
              tokenId={String(tokenId)}
              hasRegistrationTx={Boolean(agent?.created_tx_hash)}
              // The track-record sentence is the only one here that comes from
              // outside the verdict; it lands after the history call, and the
              // sentence simply does not render until it does.
              uptime={uptime}
            />
          )}

          {/* Below the verdict, not above it. While the check runs there is no
              verdict yet and this is the only thing to look at; once there is
              one, the answer leads and the trace becomes its provenance —
              folded, one click from showing how it was reached.

              Each line lands the moment its real call resolves: the jitter and
              the ordering ARE the evidence it happened now. */}
          <CheckTrace lines={checkLog.map(describeCheckEvent).filter(Boolean)} running={verifying} elapsedMs={checkMs} />

          {!verifying && (!verdict || verdict.error) && (
            <div className="tier-banner">
              <span className="dot dot-unproven" aria-hidden="true" />
              {/* Say WHY, and offer the one-click retry. A throttle is the
                  shared registry budget, not this agent's failing. */}
              {!VERIFY_BASE
                ? translate("verification service not configured")
                : verifyError === 'identity'
                  ? translate("The identity file could not be read. Earlier evidence is preserved; retry to complete a fresh check.")
                : verifyError === 'throttled'
                  ? translate("checks are briefly throttled (shared registry budget) — not a verdict on this agent")
                  : translate("verification could not run just now — not a verdict on this agent")}
              {VERIFY_BASE && (
                <button type="button" className="banner-retry" onClick={() => setRetryTick((t) => t + 1)}>
                  {t("retry")}
                </button>
              )}
            </div>
          )}

          {verifyError === 'identity' && <>
            <SavedCheckRecord saved={savedEvidence} />
            {savedEvidence?.latest?.bap578?.ownershipVerified === true && memory?.status !== 'unsupported' && (
              <EvidenceSection id="ev-memory" title={t("Anchored memory")} summary={memorySummary(memory)}>
                <MemoryEvidence record={memory} onRetry={() => setMemoryRetry(value => value + 1)} />
              </EvidenceSection>
            )}
          </>}

{/* Registry and probe differences are summarized in the evidence rows below. */}

          {ev && (
            <>
              {verdictReady && (
                <EvidenceSection id="ev-narrative" title={t("the full reasoning")} summary={{ text: 'every sentence links to the row it restates' }}>
                  <NarrativeSummary verdict={verdict} tokenId={String(tokenId)} />
                </EvidenceSection>
              )}

              {/*
                Two protocols, reported separately. Showing only the A2A rows
                described an MCP-only agent as having no endpoint and not
                responding, which is the opposite of true for most agents on
                this registry doing real work.
              */}
              {ev.endpoint?.declared && (
                <EvidenceSection id="ev-a2a" title={t("a2a endpoint probe")} summary={sums.a2a}>
                  <EvidenceRow label={t("declared endpoint")} value={endpoint || translate("none")} href={ev.endpoint?.reachable ? endpoint : undefined} ok={ev.endpoint?.declared ?? false} />
                  <EvidenceRow
                    label={t("responds")}
                    value={ev.endpoint?.reachable ? translate("yes · {value1} · {value2}ms", { value1: ev.endpoint.status, value2: ev.endpoint.latencyMs }) : translate("no{value1}", { value1: ev.endpoint?.reason ? ` · ${ev.endpoint.reason}` : '' })}
                    ok={Boolean(ev.endpoint?.reachable)}
                  />
                  <EvidenceRow
                    label={t("agent card")}
                    value={ev.endpoint?.hasAgentCard ? translate("valid · {value1} skills", { value1: ev.endpoint.skillsCount ?? 0 }) : translate("not served")}
                    ok={Boolean(ev.endpoint?.hasAgentCard)}
                  />
                  <EchoedIds label={t("the skills it listed")} ids={ev.endpoint?.skillIds} />
                  {/*
                    A card that answers is not automatically a card about this
                    agent. A shared fleet endpoint serves a perfectly valid one,
                    and without this row every agent pointing at it looks live.
                  */}
                  {verdict.subject && (
                    <EvidenceRow
                      label={t("describes this agent")}
                      value={verdict.subject.verified ? translate("yes · {value1}", { value1: verdict.subject.how }) : translate("no · {value1}", { value1: verdict.subject.how })}
                      ok={verdict.subject.verified}
                    />
                  )}
                </EvidenceSection>
              )}

              {ev.mcp?.declared && (
                <EvidenceSection id="ev-mcp" title={t("mcp endpoint probe")} summary={sums.mcp}>
                  <EvidenceRow
                    label={t("declared endpoint")}
                    value={mcpEndpoint || translate("none")}
                    ok={Boolean(ev.mcp?.declared)}
                  />
                  <EvidenceRow
                    label={t("responds")}
                    value={ev.mcp?.reachable ? translate("yes · {value1} · {value2}ms", { value1: ev.mcp.status, value2: ev.mcp.latencyMs }) : translate("no{value1}", { value1: ev.mcp?.reason ? ` · ${ev.mcp.reason}` : '' })}
                    ok={Boolean(ev.mcp?.reachable)}
                  />
                  <EvidenceRow
                    label={t("serves tools")}
                    value={ev.mcp?.servesTools ? translate("{value1} tools · {value2}", { value1: ev.mcp.toolCount, value2: ev.mcp.serverName ?? translate("unnamed server") }) : translate("none listed")}
                    ok={Boolean(ev.mcp?.servesTools)}
                  />
                  <EchoedIds label={t("the tools it listed")} ids={ev.mcp?.toolIds} />
                </EvidenceSection>
              )}

{/* Compare the registered capability list with what the endpoint served. */}
              {verdict.capability && (
                <EvidenceSection id="ev-capability" title={t("declared vs served")} summary={sums.capability}>
                  <EvidenceRow
                    label={`${verdict.capability.kind === 'mcp' ? translate("mcp tools") : translate("a2a skills")}`}
                    value={
                      verdict.capability.missing?.length
                        ? translate("advertises {value1} {value2}, serves {value3} of them · missing {value4}: {value5}{value6}", { value1: verdict.capability.declared, value2: t(verdict.capability.noun ?? ''), value3: verdict.capability.matched ?? 0, value4: verdict.capability.declared - (verdict.capability.matched ?? 0), value5: verdict.capability.missing.join(', '), value6: (verdict.capability.declared - (verdict.capability.matched ?? 0)) > verdict.capability.missing.length ? translate(", +{value1} more", { value1: verdict.capability.declared - (verdict.capability.matched ?? 0) - verdict.capability.missing.length }) : '' })
                        : translate("serves all {value1} {value2} it advertises", { value1: verdict.capability.declared, value2: t(verdict.capability.noun ?? 'capabilities') })
                    }
                    ok={!verdict.capability.missing?.length}
                  />
                  {/* Report capabilities served by the endpoint but absent from the registry record. */}
                  {verdict.capability.extra?.length > 0 && (
                    <EvidenceRow
                      label={t("serves, never advertised")}
                      value={translate("{value1} · its registry record understates it", { value1: verdict.capability.extra.join(', ') })}
                    />
                  )}
                </EvidenceSection>
              )}

              {!ev.endpoint?.declared && !ev.mcp?.declared && (
                <EvidenceSection id="ev-probe" title={t("endpoint probe")} summary={{ text: 'no address published to call', ok: false }}>
                  <EvidenceRow label={t("declared endpoint")} value={t("none")} ok={false} />
                </EvidenceSection>
              )}

              {/*
                BAP-578 is BNB Chain's Non-Fungible Agent standard. An ERC-8004
                registration says an identity exists; this says there is a logic
                contract behind it, and on some implementations the agent
                records its own work on-chain. Detected by interface, so it
                holds for any BAP-578 collection rather than one vendor's.
              */}
              {verdict.bap578 && (
                <EvidenceSection id="ev-bap578" title={t("bap-578 agent · on-chain")} summary={sums.bap578}>
                  <EvidenceRow
                    label={t("collection")}
                    value={translate("{value1} · token {value2}{value3}", { value1: short(verdict.bap578.collection), value2: verdict.bap578.tokenId, value3: verdict.bap578.ownershipVerified === false ? translate(" (claimed)") : '' })}
                    href={`https://bscscan.com/token/${verdict.bap578.collection}`}
                    ok={!verdict.bap578.unsupported && verdict.bap578.ownershipVerified !== false}
                  />
                  {/*
                    The token id came off the card, and we could not show the
                    card is about this agent. Everything on-chain under that id
                    belongs to whoever owns it, which may not be this agent, so
                    none of it was read. Saying so beats an empty section: the
                    absence is the finding.
                  */}
                  {verdict.bap578.ownershipVerified === false && (
                    <EvidenceRow
                      label={t("not attributed")}
                      value={translate("This agent's card claims token {value1}; {value2}. Its balance, logic contract and trade history are not shown here.", { value1: verdict.bap578.tokenId, value2: verdict.bap578.howToProve || translate("no on-chain record ties that token to this registration") })}
                      ok={false}
                    />
                  )}
                  {/*
                    We could not run the check. Not their failure, so no ok=false
                    marker: the same discipline the uptime calendar keeps when a
                    reply never reached us.
                  */}
                  {verdict.bap578.ownershipVerified == null && !verdict.bap578.unsupported && (
                    <EvidenceRow
                      label={t("not checked")}
                      value={translate("This agent's card claims token {value1}. {value2}, so nothing under it is shown here.", { value1: verdict.bap578.tokenId, value2: verdict.bap578.unattributedReason || translate("We could not check the on-chain record that would tie that token to this registration") })}
                    />
                  )}
                  {verdict.bap578.unsupported ? (
                    <EvidenceRow
                      label={t("standard")}
                      value={t("the card claims a BAP-578 token, but this collection does not implement the interface")}
                      ok={false}
                    />
                  ) : (
                    <EvidenceRow
                      label={t("implements")}
                      value={(verdict.bap578.interfaces || []).join(', ') || translate("none")}
                      ok={(verdict.bap578.interfaces || []).length > 0}
                    />
                  )}
                  {verdict.bap578.state && (
                    <>
                      <EvidenceRow
                        label={t("logic contract")}
                        value={short(verdict.bap578.state.logicAddress)}
                        href={`https://bscscan.com/address/${verdict.bap578.state.logicAddress}`}
                        ok={!/^0x0+$/.test(verdict.bap578.state.logicAddress)}
                      />
                      <EvidenceRow
                        label={t("status")}
                        value={verdict.bap578.state.status === 1 ? translate("active") : translate("status {value1}", { value1: verdict.bap578.state.status })}
                        ok={verdict.bap578.state.status === 1}
                      />
                    </>
                  )}
                  {/*
                    Lifetime counters the agent's logic contract keeps per token.
                    Real and on-chain, but NOT a measure of useful or autonomous
                    work: handleAction increments them on every call it accepts,
                    whether the platform runtime or the owner (through the
                    permission system) triggered it, and simple actions are cheap
                    to run. They are cumulative across every owner the token has
                    had. So a count is evidence activity happened, not that it was
                    valuable or agent-decided; the caveat row explains this limit.
                    Where the
                    logic version does not implement getMetrics we say so: a missing
                    function is not evidence the agent did nothing.
                  */}
                  {/* Explain which on-chain records transfer with the token and which do not. */}
                  {verdict.bap578.transferable && (
                    <>
                      <EvidenceRow
                        label={t("transfers with sale")}
                        value={[
                          translate("the token itself"),
                          verdict.bap578.transferable.tba ? translate("its ERC-6551 wallet and everything in it") : null,
                          Number(verdict.bap578.transferable.activePositions) > 0
                            ? translate("{value1} open position(s)", { value1: verdict.bap578.transferable.activePositions })
                            : null,
                          translate("its recorded on-chain history"),
                        ].filter(Boolean).join(' · ')}
                        ok
                      />
                      {verdict.bap578.transferable.tba && (
                        <EvidenceRow
                          label={t("wallet it carries")}
                          value={`${short(verdict.bap578.transferable.tba)}${
                            verdict.bap578.transferable.tbaBalanceWei != null
                              ? ` · ${(Number(verdict.bap578.transferable.tbaBalanceWei) / 1e18).toFixed(4)} BNB`
                              : ''}`}
                          href={`https://bscscan.com/address/${verdict.bap578.transferable.tba}`}
                        />
                      )}
                      {/*
                        The search for a token-bound wallet did not finish. The
                        row above lists what transfers, and silence here would
                        read as "there is no wallet" when what happened is that
                        we never got to look.
                      */}
                      {!verdict.bap578.transferable.tba && verdict.bap578.transferable.checked === false && (
                        <EvidenceRow
                          label={t("wallet it carries")}
                          value={t("not checked. The chain node did not answer, so we cannot say whether this agent has a token-bound wallet.")}
                        />
                      )}
                      <EvidenceRow
                        label={t("does NOT transfer")}
                        value={t("its model credentials, prompt and personality, its triggers, and any operator-side permissions. These live off-chain against the seller's account, so a buyer receives an agent that does not run until they reconfigure it.")}
                        ok={false}
                      />
                    </>
                  )}
                  {verdict.bap578.metrics && (
                    verdict.bap578.metrics.reported ? (
                      <>
                        <EvidenceRow
                          label={t("Logic-contract activity · lifetime")}
                          value={translate("{value1} actions · {value2} marked success · {value3} trades", { value1: verdict.bap578.metrics.totalActions, value2: verdict.bap578.metrics.successfulActions, value3: verdict.bap578.metrics.totalTrades })}
                        />
                        <EvidenceRow
                          label={t("what this counts")}
                          value={t("These come from the agent's own logic contract, which its owner selects, and rise on every call it accepts — however triggered, cheap ones included. They are lifetime totals that pass to the token's next owner. Evidence that activity happened, not that it was useful, agent-decided, or independently verified by us.")}
                        />
                        {/*
                          What we actually watched. The counters above are lifetime
                          totals that can predate our first check entirely, so the
                          honest thing we can add is the change across the window we
                          observed: "+N since we first read it" when it moved, or an
                          explicit note that it has not moved and the lifetime figure
                          is all from before we started. Renders only when an earlier
                          reading exists to compare against.
                        */}
                        {(() => {
                          const change = observedTradeChange(checks, verdict.bap578.metrics.totalTrades);
                          if (!change) return null;
                          return (
                            <EvidenceRow
                              label={t("since we began checking")}
                              value={change.delta > 0
                                ? translate("+{value1} trade{value2} since our earliest kept check, {value3}. We keep only recent checks, so the lifetime figure above may include even older trades.", { value1: change.delta, value2: change.delta === 1 ? '' : 's', value3: timeAgo(change.since) })
                                : translate("no new trades since our earliest kept check, {value1} — as far back as our retained checks go. The lifetime figure above is from before that.", { value1: timeAgo(change.since) })}
                              ok={change.delta > 0 || undefined}
                            />
                          );
                        })()}
                        {/*
                          Lifetime profit and loss. This figure is whatever the
                          agent's logic contract reports about ITSELF, and the owner
                          chooses that contract (setLogicAddress is onlyAgentOwner),
                          so it is never FYA-verified and must never carry a
                          verification-grade presentation. reportsRealMetrics only
                          tells us the logic VERSION is capable of tracking P&L
                          (Trading/CTO/Deployer hardcode int256(0)) — NOT that the
                          figure is honest: a malicious owner-set logic can implement
                          getActivePositions AND return a fabricated P&L, which is
                          why we removed the "on-chain"/green presentation this
                          branch briefly had. So:
                          - false → this version records no P&L on-chain; say that,
                            never publish its placeholder 0.
                          - true/null → show the figure only as SELF-REPORTED, no
                            green marker, and only at a non-trivial magnitude (which
                            also avoids a misleading "0.0000"). A verified label waits
                            on an owner-independent cross-check that is not yet built.
                        */}
                        {(() => {
                          const m = verdict.bap578.metrics;
                          const pnl = Number(m.lifetimePnLWei) / 1e18;
                          if (m.reportsRealMetrics === false) {
                            return m.totalTrades > 0 ? (
                              <EvidenceRow
                                label={t("lifetime profit and loss")}
                                value={t("this logic version does not record profit and loss on-chain — it is kept off-chain, so there is no on-chain figure to show here.")}
                              />
                            ) : null;
                          }
                          if (!Number.isFinite(pnl) || Math.abs(pnl) < 0.0001) return null;
                          return (
                            <EvidenceRow
                              label={t("lifetime profit/loss · self-reported by the agent")}
                              value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} BNB`}
                            />
                          );
                        })()}
                        {/*
                          We deliberately do NOT render totalInteractions. Every
                          modern logic version (Trading, CTO, Deployer, Hunter V7/V8)
                          returns it as a literal alias of successfulActions, so it
                          is a duplicate; it is an independent value only on the
                          legacy HunterAgentLogic ("chat interactions recorded"),
                          whose meaning we cannot guarantee across every old version.
                          A number we cannot honestly label is not worth a row.
                        */}
                        {/*
                          This timestamp covers only the logic contract's
                          metrics. A zero value says nothing about TBA transfers.
                        */}
                        {(() => {
                          const stamp = logicActivityTimestamp(verdict.bap578.metrics.lastActive);
                          const ago = stamp.status === 'recorded' ? timeAgo(stamp.iso) : null;
                          return (
                            <EvidenceRow
                              label={t("Last activity recorded by logic contract")}
                              value={stamp.status === 'recorded' ? (ago === '—' ? stamp.iso : ago)
                                : t(stamp.status === 'none' ? 'No timestamp recorded' : 'Timestamp unavailable')}
                              ok={stamp.status === 'recorded' || undefined}
                            />
                          );
                        })()}
                        {verdict.bap578.metrics.activePositions > 0 && (
                          <EvidenceRow
                            label={t("open positions")}
                            value={String(verdict.bap578.metrics.activePositions)}
                            ok
                          />
                        )}
                      </>
                    ) : (
                      <EvidenceRow label={t("on-chain activity")} value={verdict.bap578.metrics.reason} />
                    )
                  )}
                </EvidenceSection>
              )}

              <EvidenceSection id="ev-wallet" title={t("agent wallet · bsc")} summary={sums.wallet}>
                <EvidenceRow
                  label={t("address")}
                  value={short(ev.wallet?.address)}
                  href={ev.wallet?.address ? `https://bscscan.com/address/${ev.wallet.address}` : undefined}
                />
                {/* Whose wallet this is decides what its activity proves. An
                    agent's own account is evidence about the agent; the address
                    that registered it usually is not. */}
                <EvidenceRow
                  label={t("belongs to the agent")}
                  value={ev.wallet?.isOwnWallet ? translate("proved via ERC-6551") : (ev.wallet?.walletBasis ?? translate("unknown"))}
                  ok={Boolean(ev.wallet?.isOwnWallet)}
                />
                <EvidenceRow
                  label={t("transactions")}
                  value={ev.wallet?.checked ? String(ev.wallet.txCount) : translate("check failed")}
                  ok={ev.wallet?.checked ? ev.wallet.txCount > 2 : false}
                />
                <EvidenceRow label={t("balance")} value={ev.wallet?.checked ? bnb(ev.wallet.balanceWei) : '—'} />
              </EvidenceSection>

              {/* Escrow records are shown as a titled evidence section. */}
              {escrow?.result && (
                <EvidenceSection id="ev-escrow" title={t("escrow job record")} summary={sums.escrow}>
                  <EscrowRecord result={escrow.result} address={escrow.address} source={escrow.source} />
                </EvidenceSection>
              )}

              <EvidenceSection id="ev-b402" title={t("b402 settlement record")} summary={sums.b402}>
                <EvidenceRow
                  label={t("bazaar listing")}
                  value={ev.bazaar?.listed ? translate("listed · {value1} resource{value2}", { value1: ev.bazaar.resourceCount, value2: ev.bazaar.resourceCount > 1 ? 's' : '' }) : ev.bazaar?.checked ? translate("not listed") : translate("lookup failed")}
                  ok={Boolean(ev.bazaar?.listed)}
                />
                {ev.bazaar?.listed && ev.bazaar.calls30d != null && (
                  <EvidenceRow label={t("calls · 30d")} value={String(ev.bazaar.calls30d)} ok />
                )}
              </EvidenceSection>

              <EvidenceSection id="ev-registry" title={t("registry reputation")} summary={sums.registry}>
                {/* A count we failed to read is not a count of zero. */}
                <EvidenceRow
                  label={t("feedbacks")}
                  value={ev.registry?.feedbackCount == null ? translate("not known") : String(ev.registry.feedbackCount)}
                  ok={(ev.registry?.feedbackCount ?? 0) > 0}
                />
                {/* A reading we never took is not a reading of "no". */}
                <EvidenceRow
                  label={t("endpoint verified by registry")}
                  value={ev.registry?.isEndpointVerified == null ? translate("not known") : ev.registry.isEndpointVerified ? translate("yes") : translate("no")}
                  ok={ev.registry?.isEndpointVerified === true ? true : ev.registry?.isEndpointVerified === false ? false : undefined}
                />
                {/* Preserve the directory's own reason when it provides one. */}
                {ev.registry?.endpointVerificationError && (
                  <EvidenceRow label={t("their checker reported")} value={ev.registry.endpointVerificationError} />
                )}
                {ev.registry?.observedMcp?.checkedAt && (
                  <EvidenceRow
                    label={t("their reading taken")}
                    value={`${timeAgo(ev.registry.observedMcp.checkedAt)}${ev.registry.observedMcp.toolCount != null ? translate(" · {value1} tools", { value1: ev.registry.observedMcp.toolCount }) : ''}`}
                  />
                )}
                <EvidenceRow label={t("health score")} value={ev.registry?.healthScore != null ? String(ev.registry.healthScore) : translate("not scored")} />
              </EvidenceSection>

              {/*
                Day-level first: the raw list is capped at the last 50 CHECKS,
                so for a heavily-viewed agent it can cover a single afternoon
                while the calendar covers every day on record.
              */}
              {uptime?.days?.length > 0 && (
                <EvidenceSection id="ev-uptime" title={t("track record")} summary={uptimeSummary(uptime)}>
                  <UptimeStrip uptime={uptime} bare />
                </EvidenceSection>
              )}

              {/* What the agent actually DID on-chain, with a per-transaction
                  origin the registry cannot show. Its own request, gated and
                  budgeted server-side; appears only once it resolves. */}
              {showActivity && (
                <EvidenceSection id="ev-activity" title={t("on-chain activity")} summary={activitySummary(activity)}>
                  <ActivityPanel activity={activity} bare />
                </EvidenceSection>
              )}

              {verdict.bap578 && memory?.status !== 'unsupported' && (
                <EvidenceSection id="ev-memory" title={t("Anchored memory")} summary={memorySummary(memory)}>
                  <MemoryEvidence record={memory} onRetry={() => setMemoryRetry(value => value + 1)} />
                </EvidenceSection>
              )}

              {checks.length > 1 && (
                <EvidenceSection id="ev-history" title={t("check history")} summary={sums.history}>
                  <div className="check-history">
                    {checks.map((c) => (
                      <div key={c.ts} className="check-line mono">
                        <span className={`dot ${TIER_META[c.tier]?.dot ?? 'dot-unproven'}`} aria-hidden="true" />
                        <span className="check-tier">{t(TIER_META[c.tier]?.label ?? c.tier)}</span>
                        {c.latencyMs != null && <span className="check-latency">{c.latencyMs}ms</span>}
                        <span className="check-ts">{timeAgo(c.ts)}</span>
                      </div>
                    ))}
                  </div>
                </EvidenceSection>
              )}

              <p className="evidence-note">
                {t("Every signal above is independently checkable. The formula is open source and versioned: a verdict is evidence, not opinion.")} <a href="#/methodology">{t("How verification works")} <ArrowRight size={11} strokeWidth={2} aria-hidden="true" /></a>
              </p>
            </>
          )}
        </section>

        <aside className="identity-card">
          <h2 className="micro-label">{t("identity")}</h2>
          {/*
            Two trust classes, two rules. A 'registration' asset is what the
            registrant chose for their own entry, the same class as image_url,
            so it renders ungated. A 'token' asset belongs to the BAP-578
            token the card claims, and shows only when the verdict attributed
            that token to this agent: an unattributed claim rendering another
            token's skin would visually endorse the exact claim the page
            refuses to endorse in text.
          */}
          {media?.kind === '3d'
            && (media.source === 'registration' || verdict?.bap578?.ownershipVerified === true) && (
            <AgentModel media={media} alt={translate("3D model of agent #{value1}", { value1: tokenId })} />
          )}
          {agent.description && agent.description !== agent.name && (
            <p className="identity-desc">{agent.description}</p>
          )}
          <div className="identity-rows">
            <EvidenceRow
              label={t("owner")}
              value={short(agent.owner_address)}
              href={`https://bscscan.com/address/${agent.owner_address}`}
            />
            <EvidenceRow
              label={t("Registry-listed wallet")}
              value={short(agent.agent_wallet)}
              href={agent.agent_wallet ? `https://bscscan.com/address/${agent.agent_wallet}` : undefined}
            />
            {verdict?.bap578?.ownershipVerified === true && (
              <EvidenceRow
                label={t("Token-controlled wallet (TBA)")}
                value={tokenAccount ? short(tokenAccount) : t("Not established by this check")}
                href={tokenAccount ? `https://bscscan.com/address/${tokenAccount}` : undefined}
              />
            )}
            <EvidenceRow
              label={t("registered")}
              value={agent.created_tx_hash ? short(agent.created_tx_hash) : timeAgo(agent.created_at)}
              href={agent.created_tx_hash ? `https://bscscan.com/tx/${agent.created_tx_hash}` : undefined}
            />
            <EvidenceRow
              label={t("registry entry")}
              value={`8004scan #${tokenId}`}
              href={scanAgentUrl(chainId, tokenId)}
            />
          </div>
          <div className="identity-meta">
            {(agent.supported_protocols ?? []).map((p) => (
              <span key={p} className="proto mono">
                {p}
              </span>
            ))}
            {agent.x402_supported && <X402Badge />}
          </div>
          <FlowButton
            variant="gold"
            className="flow-block"
            disabled={!hireService}
            title={
              hireService
                ? translate("Escrow-backed hire via ERC-8183")
                : metadataState !== 'ready'
                  ? translate("The hire menu has not been read yet.")
                  : verdict?.erc8183Endpoint
                  ? translate("This agent negotiates over ERC-8183 from its live endpoint, but publishes no hire menu in its registry metadata, so there is no provider address to open an escrow against from here.")
                  : translate("This agent does not advertise ERC-8183 hire services in its registry metadata")
            }
            onClick={() => openPanel('hire')}
          >
            {/*
              Three states, not two. An agent whose live endpoint serves
              `negotiate` and `notify_funded` speaks the hire protocol and will
              sign a price on request; calling it "not hireable via erc-8183"
              was a false negative about the agents most obviously for sale.

              It still cannot be hired from here, and the button stays disabled:
              the escrow needs a provider address, and that only comes from a
              menu in the registration. So the label states the actual finding —
              the protocol is there, the menu is not — rather than either lying
              about the agent or offering a button that leads nowhere.
            */}
            {hireService
              ? translate("hire this agent")
              : metadataState === 'loading'
                ? translate("reading hire menu…")
                : metadataState === 'unavailable'
                  ? translate("hire menu unavailable")
                  : verdict?.erc8183Endpoint
                ? translate("negotiates · no published menu")
                : translate("not hireable via erc-8183")}
          </FlowButton>
          {/* Start comparison with the current agent. */}
          <a className="row-act compare-from" href={`#/compare/${chainId}:${tokenId}`}>
            {t("compare with another agent")}
          </a>
        </aside>
      </div>
    </div>
  );
}
