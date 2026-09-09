import { formatCount } from '../config.js';
import { useI18n } from '../i18n/index.jsx';

/*
  The strip shows registry size, distinct agents checked, and agents that
  answered or are active. The checked and answered-or-active counts stay
  grouped when the registry total wraps onto its own line.

  Stage two is uniqueChecked and never checksRun. checksRun counts every check
  ever run, re-checks included, so it is not a subset of the registry: putting
  it in the chain would overstate coverage by however many times each agent has
  been probed, while looking like arithmetic. It is not on this line at all.

  Stage three is the union of two tiers and is labelled as one. `active` means
  the endpoint answered with nothing to corroborate it OR there is real activity
  and the endpoint did not answer, so a stage called "answered" would be a plain
  false claim about part of that number.

  Every count is formatted 'en-US' explicitly, by the one formatter in config.
  A bare toLocaleString() takes the viewer's machine locale, so the registry
  total rendered "300.855" on a European locale — a figure that reads as three
  hundred point eight five five on a page whose entire claim is that its numbers
  are checkable.
*/

function Stage({ label, value, title, pending = false }) {
  return (
    <div className="stat" title={title}>
      <span className="micro-label">{label}</span>
      <span className={`stat-value mono${pending ? ' is-pending' : ''}`}>{value ?? '·'}</span>
    </div>
  );
}

export default function StatStrip({ registryTotal, registryObservation = null, registryStatus = 'loading',
  registryError = null, summary }) {
  const { t, locale } = useI18n();
  /*
    Optional chaining the whole way down. This read `summary.tiers.verified_live`
    behind a bare `summary ?` guard, so a service that ever answered without a
    tiers object took the page down instead of degrading to the no-reading mark,
    which is the behaviour every other unknown on this site has.
  */
  const liveCount = summary?.tiers?.verified_live;
  const activeCount = summary?.tiers?.active;
  const aboveRegistered = typeof liveCount === 'number' && typeof activeCount === 'number'
    ? liveCount + activeCount
    : null;

  const hasCount = typeof registryTotal === 'number';
  const retrievedAt = registryObservation?.retrievedAt;
  const countSource = registryObservation?.source === 'unfiltered-list' ? t('an unfiltered registry page') : t('registry statistics');
  const when = retrievedAt ? new Date(retrievedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) : null;

  return (
    <>
    <div className="stat-strip stat-funnel" role="group" aria-label={t('how the registry narrows')}>
      <Stage
        label={t('registered on bsc')}
        value={formatCount(registryTotal) ?? t(registryStatus === 'loading' ? 'loading…' : 'unavailable')}
        pending={!hasCount}
        title={hasCount
          ? t('BSC identities reported by {source}{retrieved}', {
            source: countSource,
            retrieved: when ? t(', retrieved {when} UTC', { when }) : '',
          })
          : t('The BSC registry count has not loaded.')}
      />
      {/* Keep the two evidence counts together when the strip wraps. */}
      <div className="funnel-run">
        <Stage
          label={t('checked')}
          value={formatCount(summary?.uniqueChecked)}
          title={t('distinct agents we hold a verdict for under the current formula')}
        />
        <Stage
          label={t('answered or active')}
          value={formatCount(aboveRegistered)}
          title={t('reached a tier above registered: verified live plus active')}
        />
      </div>
    </div>
    <p className="registry-count-note" role="status">
      <span>{hasCount
        ? <>{t('Count from {source}', { source: countSource })}{when && <>{t(', retrieved ')}<time dateTime={retrievedAt}>{when} UTC</time></>}{t('.')}
          {registryStatus === 'unavailable' && t(' Statistics could not refresh; the last retrieved count is shown.')}
          {registryStatus === 'loading' && t(' Refreshing statistics…')}</>
        : registryStatus === 'loading' ? t('Loading the BSC registry count…')
          : t(registryError || 'The BSC registry count is unavailable.')}</span>
    </p>
    </>
  );
}
