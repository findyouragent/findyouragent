import { ExternalLink } from 'lucide-react';
import { timeAgo } from '../utils/format.js';
import TokenMark from './TokenMark.jsx';
import TermText from './TermText.jsx';
import { translate, useI18n } from '../i18n/index.jsx';

/**
 * The agent's on-chain activity, from GET /api/activity. The load-bearing
 * honesty rules live server-side (the per-class sentences in classLabels, the
 * coverage window, the fail-closed gates); this component only renders them.
 *
 * Two rules it must keep on its own:
 *   - A count is "observed events in the window we scanned", NEVER demand,
 *     revenue, or traction — framework/payment volume is owner-gameable.
 *   - An empty feed is "nothing in the recent window we scanned", never a claim
 *     about the agent's whole history.
 */

function short(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

// Short badge text; the full honest sentence comes from the server (classLabels).
const BADGE = {
  framework: 'framework',
  'framework-triggered': 'framework · owner-triggered',
  payment: 'payment in',
  transfer: 'wallet transfer',
  'not-checked': 'not checked',
};
const BADGE_CLASS = {
  framework: 'act-framework',
  'framework-triggered': 'act-triggered',
  payment: 'act-payment',
  transfer: 'act-transfer',
  'not-checked': 'act-unknown',
};

function whatLabel(e) {
  if (e.kind === 'trade') return translate('trade');
  if (e.kind === 'job') return translate('job');
  if (e.kind === 'custody') return translate('custody move');
  if (e.kind === 'action') return translate('framework action');
  if (e.direction === 'in') return translate('received');
  if (e.direction === 'out') return translate('sent');
  return translate('transfer');
}

function amountLabel(e) {
  if (e.amount == null || e.asset == null) return '';
  const n = Number(e.amount);
  const disp = Number.isFinite(n)
    ? (Math.abs(n) < 0.0001 && n !== 0 ? '<0.0001' : n.toLocaleString(undefined, { maximumFractionDigits: 6 }))
    : e.amount;
  const sign = e.direction === 'in' ? '+' : e.direction === 'out' ? '−' : '';
  return `${sign}${disp} ${e.asset}`;
}

// Gates whose absence is worth explaining to the reader; the rest hide quietly.
const EXPLAIN_GATES = { 'no-proved-wallet': true, 'no-wallet-yet': true };

// One honest phrase for a collapsed header. Never "inactive": an empty window
// is a window, and a gate is a reason, not a reading.
export function activitySummary(activity) {
  if (!activity) return { text: translate('loading'), ok: undefined };
  const gate = activity.attribution?.gate;
  if (gate === 'verified') {
    const n = (activity.events || []).length;
    const partial = activity.sources?.transfers !== 'ok' || !['ok', 'not-applicable'].includes(activity.sources?.classification);
    return { text: translate('{count} {events} in the recent window{partial}', {
      count: n,
      events: translate(n === 1 ? 'event' : 'events'),
      partial: partial ? translate(' · read incomplete') : '',
    }), ok: n > 0 ? true : undefined };
  }
  if (gate === 'no-proved-wallet') return { text: translate('no provably-own wallet to read'), ok: undefined };
  if (gate === 'no-wallet-yet') return { text: translate('wallet not created on-chain yet'), ok: undefined };
  if (gate === 'unsupported-chain') return { text: translate('only BNB Chain is observed'), ok: undefined };
  if (gate === 'unconfigured') return { text: translate('feed not enabled on this deployment'), ok: undefined };
  return { text: translate('could not be read just now'), ok: undefined };
}

// `bare` renders the content without its own section/heading so a parent
// collapsible section can own the header.
export default function ActivityPanel({ activity, bare = false }) {
  const { t, locale } = useI18n();
  if (!activity) return null;
  const gate = activity.attribution?.gate;
  const Wrap = bare
    ? ({ children }) => <div className="activity-bare">{children}</div>
    : ({ children }) => (
      <section className="evidence-section" id="ev-activity" tabIndex={-1}>
        <h3 className="micro-label">{t('on-chain activity')}</h3>
        {children}
      </section>
    );

  if (gate !== 'verified') {
    if (!EXPLAIN_GATES[gate] || !activity.note) return null;
    return (
      <Wrap>
        <p className="evidence-sub"><TermText text={activity.note} /></p>
      </Wrap>
    );
  }

  const { events = [], coverage = {}, classLabels = {}, sources = {} } = activity;
  const wallet = activity.attribution?.wallet;
  const present = [...new Set(events.map((e) => e.class))];

  return (
    <Wrap>
      <p className="evidence-sub">
        <TermText text="Transactions of the wallet this agent's token controls. Each row's origin says how it was executed, proved from the chain, never who decided it." />
      </p>
      <p className="activity-subject mono">
        {short(wallet)} · {t("an address the token controls, not the agent's endpoint")}
      </p>

      <p className="activity-coverage">
        {coverage.fromBlock != null
          ? t('Recent window scanned: blocks {fromBlock}–{toBlock}. {count} {events} observed here — this recent window, not the whole history.', {
            fromBlock: coverage.fromBlock.toLocaleString(locale),
            toBlock: coverage.toBlock.toLocaleString(locale),
            count: events.length,
            events: t(events.length === 1 ? 'event' : 'events'),
          })
          : t('We could not read a scan window just now.')}
        {sources.transfers && sources.transfers !== 'ok' ? t(' Transfer read was incomplete.') : ''}
        {sources.classification && !['ok', 'not-applicable'].includes(sources.classification)
          ? t(' Origin check was incomplete, so some rows read as not checked.') : ''}
      </p>

      {events.length === 0 ? (
        <p className="activity-empty">
          {t("Nothing in the recent window we scanned. That is this window only, not a claim about the agent's whole history.")}
        </p>
      ) : (
        <>
          <div className="activity-feed">
            {events.map((e) => (
              <div key={e.id} className="activity-row">
                <span className="act-when mono">{e.ts ? timeAgo(e.ts) : `block ${e.block}`}</span>
                <span className="act-what">{whatLabel(e)}</span>
                <span className="act-amount mono">
                  {/* Real token mark (web3icons) for the asset that moved;
                      a payment token shows its brand colour, everything else
                      stays mono in the palette. Unknown symbols get no mark. */}
                  <TokenMark symbol={e.asset} variant={e.class === 'payment' ? 'branded' : 'mono'} />
                  {amountLabel(e)}
                </span>
                <span className={`act-badge ${BADGE_CLASS[e.class] || 'act-unknown'}`} title={t(classLabels[e.class] || '')}>
                  {t(BADGE[e.class] || e.class)}
                </span>
                {e.hash && !String(e.hash).startsWith('fw:') && (
                  <a className="act-tx" href={`https://bscscan.com/tx/${e.hash}`} target="_blank" rel="noreferrer" aria-label={t('view transaction')}>
                    <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
                  </a>
                )}
              </div>
            ))}
          </div>
          {/* The full honest sentence for each origin class actually present. */}
          <div className="activity-legend">
            {present.map((cls) => (
              <div key={cls} className="activity-legend-row">
                <span className={`act-badge ${BADGE_CLASS[cls] || 'act-unknown'}`}>{t(BADGE[cls] || cls)}</span>
                <span className="act-legend-text"><TermText text={classLabels[cls] || ''} /></span>
              </div>
            ))}
          </div>
        </>
      )}
    </Wrap>
  );
}
