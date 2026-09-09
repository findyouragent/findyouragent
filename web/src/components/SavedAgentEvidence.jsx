import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { FlowButton } from './ui/flow-button.jsx';
import { useI18n } from '../i18n/index.jsx';
import { TIER_META } from '../config.js';
import '../styles/saved-agent-evidence.css';

export function SavedCheckRecord({ saved }) {
  const { t, locale } = useI18n();
  const record = saved?.latest;
  const date = value => new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-GB', {
    dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC',
  }).format(new Date(value));
  return <section className="saved-agent-record" aria-labelledby="saved-evidence-title" aria-live="polite">
    <h2 id="saved-evidence-title">{t('Saved FYA evidence')}</h2>
    {record ? <>
      <p>{t('These are earlier observations. They do not confirm the agent’s current identity, availability, or ability to deliver a task.')}</p>
      <dl className="saved-evidence-facts">
        <div><dt>{t('Last saved check')}</dt><dd><time dateTime={record.checkedAt}>{date(record.checkedAt)}</time></dd></div>
        <div><dt>{t('Status at that check')}</dt><dd>{t(TIER_META[record.tier]?.label ?? 'unknown')}</dd></div>
        <div><dt>{t('Callable endpoint proved at that check')}</dt><dd>{t(record.endpointProven === true ? 'yes' : record.endpointProven === false ? 'no' : 'unknown')}</dd></div>
        {record.bap578?.ownershipVerified === true && <>
          <div><dt>{t('Token attributed at that check')}</dt><dd>BAP-578 #{record.bap578.tokenId}</dd></div>
          {record.bap578.totalTrades !== null && <div><dt>{t('Logic-contract trades at that check')}</dt><dd>{record.bap578.totalTrades}</dd></div>}
        </>}
        {record.servedNames?.length > 0 && <div><dt>{t('Tools listed at that check')}</dt><dd>{record.servedNames.slice(0, 8).join(', ')}{record.servedNames.length > 8 ? ` (+${record.servedNames.length - 8})` : ''}</dd></div>}
      </dl>
      {saved.checks.length > 1 && <details className="saved-check-history">
        <summary>{t('Saved check history ({count})', { count: saved.checks.length })}</summary>
        <ol>{saved.checks.map((check, index) => <li key={`${check.checkedAt}:${index}`}>
          <time dateTime={check.checkedAt}>{date(check.checkedAt)}</time><span>{t(TIER_META[check.tier]?.label ?? 'unknown')}</span>
        </li>)}</ol>
      </details>}
      {saved.partial && <p className="saved-evidence-note">{t('Some saved evidence could not be refreshed. The dated records above remain available.')}</p>}
    </> : <p>{t(!saved ? 'Loading saved checks independently of the registry…' : saved.unavailable
      ? 'FYA’s saved evidence is also unreachable right now. Please retry when the connection is available.'
      : 'FYA has no dated saved checks available for this agent.')}</p>}
  </section>;
}

export default function SavedAgentEvidence({ chainId, tokenId, error, saved, loading, backHref, onRetry }) {
  const { t } = useI18n();
  const retryUntil = error?.retryAt ?? 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (retryUntil <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [retryUntil]);
  const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000));
  const notFound = error?.notFound;
  const record = notFound ? null : saved?.latest;
  return <div className="detail saved-agent-detail">
    <a className="back-link" href={backHref}><ArrowLeft size={12} aria-hidden="true" /> {t('all agents')}</a>
    <header className="detail-header">
      <h1>{t('Agent #{tokenId}', { tokenId })}</h1>
      <p className="saved-agent-identity">{t('Chain {chainId}', { chainId })}{record?.name ? ` · ${record.name}` : ''}</p>
    </header>
    <section className="saved-agent-notice" aria-live="polite" aria-busy={loading}>
      <h2>{t(notFound ? 'Agent not found in the registry' : loading && !error ? 'Loading current registry details' : 'Current registry details unavailable')}</h2>
      <p>{t(error?.message || (loading ? 'Saved evidence remains available while FYA reads the registry.' : 'The registry lookup did not return a usable record. Please try again.'))}</p>
      {error?.source === '8004scan' && !notFound && <p>
        <a href="/docs/limits">{t('Access and retry limits')}</a>
      </p>}
      {!notFound && <p>{t('Try and hire are unavailable until the current registry details load and the required checks succeed.')}</p>}
      <FlowButton type="button" variant="neutral" className="saved-agent-retry" disabled={loading || retrySeconds > 0} onClick={onRetry}>
        {t(loading ? 'Retrying agent lookup…' : 'Retry agent lookup')}
      </FlowButton>
      {retrySeconds > 0 && <span className="saved-retry-delay">{t('Try again in {seconds} seconds.', { seconds: retrySeconds })}</span>}
    </section>
    {!notFound && <SavedCheckRecord saved={saved} />}
  </div>;
}
