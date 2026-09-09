import { useState } from 'react';
import WeaveSpinner from './ui/weave-spinner.jsx';
import { ExternalLink } from 'lucide-react';
import { X402Badge } from './TokenMark.jsx';
import { verifyStreamed } from '../api/client.js';
import { VERIFY_BASE, TIER_META, scanAgentUrl } from '../config.js';
import { timeAgo } from '../utils/format.js';
import { imageUrl, alternateGateway, avatarGradient } from '../lib/media.js';
import { translate, useI18n } from '../i18n/index.jsx';

// The compact narration for a table cell: what is being checked right now.
const STEP_LABEL = {
  registry: 'registry…',
  card: 'identity file…',
  a2a: 'calling endpoint…',
  mcp: 'asking its tools…',
  wallet: 'reading wallet…',
  bazaar: 'settlements…',
  bap578: 'token check…',
};

// The cheapest published price, for the row's hire action. null when the menu
// names none: the label stays bare rather than implying free work. Deliberately
// NOT applied to "try" — an agent may answer 402 on a call, so "try · free"
// would be a promise we cannot make.
function priceLabel(minPriceU) {
  const raw = String(minPriceU ?? '');
  if (!/^\d{1,40}$/.test(raw)) return null;
  const value = Number(raw) / 1e18;
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${value < 0.0001 ? '<0.0001' : String(Number(value.toFixed(4)))} $U`;
}

/* The portrait carries endpoint status; details remain in its accessible label. */
function livenessTitle(verdict) {
  if (!verdict) return translate('Not checked yet');
  if (verdict.error || !verdict.tier) return translate('The check could not complete');
  const latency = verdict.evidence?.endpoint?.latencyMs;
  const proofCount = verdict.proofs?.length ?? 0;
  const age = verdict.fromStore && verdict.checkedAt ? translate(' · checked {when}', { when: timeAgo(verdict.checkedAt) }) : '';
  return translate('formula v{version}', { version: verdict.formulaVersion })
    + (verdict.endpointProven
      ? translate(' · endpoint answered{latency}', { latency: latency ? translate(' in {latency}ms', { latency }) : '' })
      : translate(' · endpoint unproven'))
    + (proofCount ? ` · ${verdict.proofs.map((p) => translate(p.signal)).join(', ')}` : translate(' · no activity proofs'))
    + age;
}

function LivenessDot({ verdict, checking, step }) {
  const { t } = useI18n();
  if (checking) {
    return (
      <span className="live-dot dot-checking" title={t(step ?? 'checking')}>
        <span className="sr-only">{t('checking: {step}', { step: t(step ?? 'in progress') })}</span>
      </span>
    );
  }
  if (!verdict) {
    return (
      <span className="live-dot dot-unchecked" title={t('Not checked yet')}>
        <span className="sr-only">{t('not checked yet')}</span>
      </span>
    );
  }
  if (verdict.error || !verdict.tier) {
    return (
      <span className="live-dot dot-unproven" title={t('The check could not complete')}>
        <span className="sr-only">{t('check failed')}</span>
      </span>
    );
  }
  const meta = TIER_META[verdict.tier] ?? { label: verdict.tier, dot: 'dot-unproven' };
  return (
    <span className={`live-dot ${meta.dot}`} title={livenessTitle(verdict)}>
      <span className="sr-only">{t(meta.label)}</span>
    </span>
  );
}

function AgentRow({ agent, verdict, onVerdict, category, selected, selectionFull, onToggleSelection }) {
  const { t } = useI18n();
  // The status dot and check action share one in-flight state.
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState(null);

  async function runCheck() {
    if (checking || verdict) return;
    setChecking(true);
    try {
      onVerdict(await verifyStreamed(agent.chain_id, agent.token_id, (evt) => {
        setStep(STEP_LABEL[evt.step] ?? null);
      }));
    } catch {
      onVerdict({ tier: null, error: true });
    } finally {
      setChecking(false);
      setStep(null);
    }
  }


  // Why this agent appears under the category being browsed.
  //
  // "Name match only" is a claim ABOUT the agent: that it publishes nothing
  // performing this work. We may only make it when we actually hold the agent's
  // capability list. Falling back to it whenever a match is absent turned every
  // unchecked agent, every failed probe, and every verdict stored before
  // capabilities were recorded into a fabricated negative. Missing data renders
  // as missing.
  let categoryBasis = null;
  if (category && category !== 'all' && verdict?.tier) {
    const match = (verdict.categories ?? []).find((c) => c.category === category);
    if (match) {
      categoryBasis = match;
    } else if (Array.isArray(verdict.categories) && verdict.endpointProven) {
      // We asked the agent what it can do and this was not in the answer.
      categoryBasis = { basis: 'text' };
    }
  }

  // Declared against served, as one fraction. "serves all 22" and "18/28" are
  // the same measurement, and printing one as a sentence and the other as a
  // ratio made a column nobody could read down. Both are n/N now: the eye
  // scans the numerators and finds every shortfall without any colour at all.

  const cap = verdict?.capability ?? null;
  const capDeclared = cap?.declared ?? 0;
  const capServed = cap ? (cap.missing?.length ? (cap.matched ?? 0) : capDeclared) : 0;

  const avatarSrc = agent.image_url
    || imageUrl(agent.avatarUrl)
    || imageUrl(verdict?.avatarUrl)
    || null;
  const initial = (agent.name || '?').trim().charAt(0).toUpperCase();

  const BASIS_LABEL = { served: t('tool listed'), declared: t('declares it'), text: t('name match only') };
  const BASIS_TITLE = {
    served: t('This agent\'s endpoint listed "{evidence}" when checked. A tool listing does not establish successful execution.', { evidence: categoryBasis?.evidence }),
    declared: t('This agent\'s registry metadata lists "{evidence}", a published claim that it does this work.', { evidence: categoryBasis?.evidence }),
    text: t('Only the name or description matched this category. The agent publishes no capability that performs it.'),
  };

  return (
    <div className={`trow${selected ? ' is-selected' : ''}`} role="row">
      {onToggleSelection && <div className="tcell tcell-select" role="cell">
        <label className="row-select" title={t(selectionFull && !selected ? 'Remove a selected agent to choose another' : 'Select for comparison')}>
          <input type="checkbox" checked={selected} disabled={selectionFull && !selected}
            onChange={() => onToggleSelection(agent)}
            aria-label={t('Select {agent} for comparison', { agent: agent.name || t('agent #{id}', { id: agent.token_id }) })}
            aria-describedby="comparison-selection-help" />
        </label>
      </div>}
      <div className="tcell tcell-agent" role="cell">
        <span className="avatar-wrap" style={{ backgroundImage: avatarGradient(String(agent.token_id)) }}>
        {/*
          Poster preference: the registry index's image first, then the poster
          our own check byte-verified from the registration metadata. Both are
          plain lazy <img>s: the table never loads a model, models live on the
          detail page (a hundred rows of WebGL is a hundred rows of dead
          contexts past the browser's cap).
        */}
        {avatarSrc ? (
          <img
            src={avatarSrc}
            alt=""
            loading="lazy"
            onError={(e) => {
              // A real image on a flaky gateway is not a missing image: try
              // the next public gateway for the same CID before falling back.
              const next = alternateGateway(e.currentTarget.src);
              if (next) { e.currentTarget.src = next; return; }
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling.style.display = 'grid';
            }}
          />
        ) : null}
        <span className="avatar-fallback" style={{ display: avatarSrc ? 'none' : 'grid' }}>
          {initial}
        </span>
        <LivenessDot verdict={verdict} checking={checking} step={step} />
        </span>
        {/* Stack the identifier under the name for compact row layout. */}
        <span className="agent-identity">
          <a
            className="agent-name"
            href={`#/agent/${agent.chain_id}/${agent.token_id}`}
            title={agent.description || agent.name}
          >
            {agent.name || t('agent #{id}', { id: agent.token_id })}
          </a>
          <span className="agent-token mono">#{agent.token_id}</span>
        </span>
      </div>
      <div className="tcell tcell-proto" role="cell" data-label={t('protocols')}>
        {agent.curated && <span className="proto proto-curated mono">{t('curated')}</span>}
        {/* Show the capability name returned by the agent's endpoint. */}
        {agent.matchedTool && (
          <span
            className="proto proto-matched mono"
            title={t('This agent\'s live endpoint listed "{tool}" when we last called it. That is why it is in these results — not its name, and not its description.', { tool: agent.matchedTool })}
          >
            {t('listed {tool}', { tool: agent.matchedTool })}
          </span>
        )}
        {/* Surface identical tool lists so shared endpoints remain visible. */}
        {agent.sameToolList > 0 && (
          <span
            className="proto proto-fleet mono"
            title={t('{count} other checked agents answered with exactly this list of tools. Identical capability sets are one operator far more often than they are {total} independent choices, so they are counted here instead of filling the results.', { count: agent.sameToolList, total: agent.sameToolList + 1 })}
          >
            {t('+{count} identical', { count: agent.sameToolList })}
          </span>
        )}
        {categoryBasis && (
          <span
            className={`proto mono ${categoryBasis.basis === 'text' ? 'proto-text' : 'proto-declared'}`}
            title={BASIS_TITLE[categoryBasis.basis]}
          >
            {BASIS_LABEL[categoryBasis.basis]}
          </span>
        )}
        {/*
          Declared against served. The registry publishes what an agent says it
          offers; this is what its endpoint actually listed when asked. Nowhere
          else are the two put side by side, and the gap is common: agents on
          this registry carry a perfect health score while serving a third fewer
          tools than they advertise.
        */}
        {cap && (
          <span
            className={`cap mono ${capServed < capDeclared ? 'cap-short' : 'cap-full'}`}
            title={
              cap.missing?.length
                ? t('Advertises {declared} {capabilities} in its registry metadata. {served} of them were actually served when asked. Missing: {missing}', {
                  declared: capDeclared, capabilities: t(cap.noun ?? 'capabilities'), served: capServed, missing: cap.missing.join(', '),
                })
                : t('Served all {declared} {capabilities} its registry metadata advertises.', {
                  declared: capDeclared, capabilities: t(cap.noun ?? 'capabilities'),
                })
            }
          >
            {/* matched, never the served-set size: the two differ whenever an
                endpoint serves things it never declared. */}
            <span className="cap-num">{capServed}</span>
            <span className="cap-den">/{capDeclared}</span>
            <span className="cap-noun">{t(cap.noun ?? 'capabilities')}</span>
          </span>
        )}
        {(agent.supported_protocols ?? []).map((p) => (
          <span key={p} className="proto mono">
            {p}
          </span>
        ))}
        {agent.x402_supported && <X402Badge />}
      </div>
      <div className="tcell tcell-num mono" role="cell" data-label={t('feedbacks')}>
        {/* Absent is not zero. Store-served rows carry no feedback count, and
            printing 0 published "no feedback" about every agent on the page. */}
        {agent.total_feedbacks ?? <span className="nodata">—</span>}
      </div>
      <div className="tcell tcell-num mono" role="cell" data-label={t('score')}>
        {agent.total_score ? agent.total_score.toFixed(1) : <span className="nodata">—</span>}
      </div>
      <div className="tcell tcell-num mono" role="cell" data-label={t('updated')}>
        {timeAgo(agent.updated_at || agent.created_at)}
      </div>
      <div className="tcell tcell-actions" role="cell">
        {/* The probe is an action, so it belongs with the actions. */}
        {!verdict && (
          <button
            type="button"
            className="check-btn"
            onClick={runCheck}
            disabled={!VERIFY_BASE || checking}
            title={t(VERIFY_BASE ? 'Probe the agent endpoint and activity signals now' : 'Verification service not configured')}
          >
            {checking ? t(step ?? 'checking') : t('check')}
          </button>
        )}
        <a
          className="row-link"
          href={scanAgentUrl(agent.chain_id, agent.token_id)}
          target="_blank"
          rel="noreferrer"
        >
          {t('registry')} <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
        </a>
        {/*
          Honest per-row actions. "try" only when a verdict proved the endpoint
          answers; "hire" only when its identity file publishes an ERC-8183
          menu (the verdict carries `hireable`, read from the card). Each link
          lands on the agent page with that panel already open. Unverified rows
          get "open" — an action that leads to "not hireable" is a dead end
          dressed as a button.
        */}
        {/* One primary action per row: hire if it can be hired, else try if
            it answers, else open. Each lands on the agent page, so "open" is
            never needed beside the other two. */}
        {verdict?.hireable === true ? (
          <>
            <a
              className="row-act row-hire"
              href={`#/agent/${agent.chain_id}/${agent.token_id}/hire`}
              title={priceLabel(verdict.minPriceU)
                ? t('Escrow-backed hire via ERC-8183, from {price}', { price: priceLabel(verdict.minPriceU) })
                : t('Escrow-backed hire via ERC-8183')}
            >
              {t('hire')}
            </a>
            {priceLabel(verdict.minPriceU) ? (
              <span className="row-price mono">{priceLabel(verdict.minPriceU)}</span>
            ) : null}
          </>
        ) : verdict?.endpointProven ? (
          <a className="row-act row-act-try" href={`#/agent/${agent.chain_id}/${agent.token_id}/try`} title={t('Send it a real request, read-only')}>
            {t('try')}
          </a>
        ) : (
          <a className="row-act" href={`#/agent/${agent.chain_id}/${agent.token_id}`} title={t('Open the verification evidence')}>
            {t('open')}
          </a>
        )}
      </div>
    </div>
  );
}

export default function AgentTable({
  agents, verdicts, onVerdict, loading, category, coverage = null, categoryLabel = 'this category',
  selectedKeys = [], onToggleSelection,
}) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="table-status is-loading">
        <WeaveSpinner size={120} />
        {t('reading the registry')}
      </div>
    );
  }
  if (agents.length === 0) {
    /*
      An empty category is a MAIN path here, not an edge case: for several of
      the judged categories the honest answer is that nothing on this registry
      serves the work. A bare "no results" reads as a broken page; the same zero
      with its denominators is the finding this site exists to publish. Only
      rendered when we actually hold coverage for the category — otherwise the
      plain sentence, because an unknown must never be dressed as a measurement.
    */
    if (coverage?.agents > 0) {
      return (
        <div className="table-status table-empty">
          <p>
            {t('We hold current verdicts for {count} {agents} that place in {category}. {answered} answered when we probed the endpoint they publish.', {
              count: coverage.agents,
              agents: t(coverage.agents === 1 ? 'agent' : 'agents'),
              category: t(categoryLabel),
              answered: coverage.endpointProven,
            })}
          </p>
          <p>
            {coverage.served === 0
              ? t('None served a capability that performs this work. That is the finding, not a gap in this page.')
              : t('{count} served a capability that performs this work, but none of them match the other filters set here.', { count: coverage.served })}
          </p>
        </div>
      );
    }
    return <div className="table-status">{t('No agents match here. Try another tab, category, or search.')}</div>;
  }
  return (
    <div className={`agent-table${onToggleSelection ? ' has-selection' : ''}`} role="table" aria-label={t('agents')}>
      <div className="trow thead" role="row">
        {onToggleSelection && <span className="tcell tcell-select" role="columnheader"><span className="sr-only">{t('select for comparison')}</span></span>}
        <span className="tcell tcell-agent micro-label" role="columnheader">{t('agent')}</span>
        <span className="tcell tcell-proto micro-label" role="columnheader">{t('protocols')}</span>
        <span className="tcell tcell-num micro-label" role="columnheader">{t('feedbacks')}</span>
        <span className="tcell tcell-num micro-label" role="columnheader">{t('score')}</span>
        <span className="tcell tcell-num micro-label" role="columnheader">{t('updated')}</span>
        <span className="tcell tcell-actions micro-label" role="columnheader"></span>
      </div>
      {agents.map((agent) => {
        const key = `${agent.chain_id}:${agent.token_id}`;
        return (
          <AgentRow
            key={agent.agent_id ?? key}
            agent={agent}
            verdict={verdicts[key]}
            onVerdict={(v) => onVerdict(key, v)}
            category={category}
            selected={selectedKeys.includes(key)}
            selectionFull={selectedKeys.length >= 3}
            onToggleSelection={onToggleSelection}
          />
        );
      })}
    </div>
  );
}
