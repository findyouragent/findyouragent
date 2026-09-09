import { CATEGORY_LABELS, COVERAGE_COLUMNS, JUDGED_CATEGORIES, formatCount } from '../config.js';
import { useI18n } from '../i18n/index.jsx';

/** Coverage narrows from checked agents to answered endpoints, served capabilities, and the top tier. */
const FINDINGS = {
  grid: 'A quote can show that an endpoint answers and will commit to a price, but it does not prove that the agent can perform the described work. This category is based on a capability listed by the live endpoint; a quote alone does not establish a served capability.',
};

export default function CoveragePanel({ coverage, awaitingRecheck = 0, onSelectCategory }) {
  const { t } = useI18n();
  if (!coverage) return null;
  /*
    A category the payload does not carry is unknown, not empty. This filled it
    with zeros, which publishes a measurement nobody took — and the moment a new
    column joins COVERAGE_COLUMNS, a server that predates it would have had a
    confident 0 rendered in that column for all four categories.
  */
  const rows = JUDGED_CATEGORIES.map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    stats: coverage[key] ?? null,
  }));

  return (
    <section className="coverage">
      <h2 className="micro-label">{t('what the categories actually hold')}</h2>

      <p className="coverage-sub">
        {t('Counted from stored verdicts, narrowing left to right. An empty row means we found nothing that earns the category, not that we did not look.')}
      </p>
      <div
        className="coverage-grid"
        role="table"
        style={{ '--cov-cols': String(COVERAGE_COLUMNS.length) }}
      >
        <div className="coverage-row coverage-row-head" role="row">
          <span role="columnheader">{t('category')}</span>
          {COVERAGE_COLUMNS.map((c) => (
            <span key={c.key} role="columnheader" title={t(c.hint)}>
              {t(c.label)}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div className="coverage-row" role="row" key={row.key}>
            {/* The cell is the wrapper, not the button. Putting role="cell" on
                the button itself replaced its own role, so a screen reader
                announced a table cell and never said the thing was pressable. */}
            <span role="cell">
              <button
                type="button"
                className="coverage-cat"
                onClick={() => onSelectCategory?.(row.key)}
              >
                {t(row.label)}
              </button>
            </span>
            {COVERAGE_COLUMNS.map((c) => {
              const raw = row.stats?.[c.key];
              const known = typeof raw === 'number' && Number.isFinite(raw);
              return (
                <span
                  key={c.key}
                  role="cell"
                  title={t(c.hint)}
                  className={`mono coverage-num ${known && raw === 0 ? 'coverage-zero' : ''} ${
                    c.key === 'verifiedLive' && known && raw > 0 ? 'coverage-live' : ''
                  }`}
                >
                  {known ? formatCount(raw) : <span className="nodata">—</span>}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      {rows.some((r) => FINDINGS[r.key] && r.stats?.served === 0) && (
        <div className="coverage-findings">
          {rows.filter((r) => FINDINGS[r.key] && r.stats?.served === 0).map((r) => (
            <p key={r.key}>
              <strong className="mono">{t(r.label)}:</strong> {t(FINDINGS[r.key])}
            </p>
          ))}
        </div>
      )}
      {awaitingRecheck > 0 && (
        <p className="coverage-note">
          {t('{count} stored {agents} awaiting recheck under the current formula and {are} not counted above. Verdicts produced by superseded rules are withdrawn until recomputed rather than left to pad these numbers.', {
            count: awaitingRecheck,
            agents: t(awaitingRecheck === 1 ? 'agent is' : 'agents are'),
            are: t(awaitingRecheck === 1 ? 'is' : 'are'),
          })}
        </p>
      )}
    </section>
  );
}
