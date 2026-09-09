import { translate, useI18n } from '../i18n/index.jsx';

/**
 * One square per day we checked this agent.
 *
 * Every design decision here is about not publishing a false negative against
 * a third party, because a calendar square is never re-checked and so a wrong
 * one is permanent.
 *
 *   ONLY `x` IS RED. It is the single state that is the agent's fault: their
 *   server answered and served nothing. `?` (no round trip) cannot be told
 *   apart from our own network, our DNS or our own 6-second timeout from one
 *   vantage point, and `-` (declared nothing) is most of this registry keeping
 *   a promise it never made. Both sit in a neutral family. Colouring them red
 *   would accuse hundreds of agents of an outage we cannot demonstrate.
 *
 *   A DAY WITH NO CHECK HAS NO SQUARE. Not a grey square, no square. Our sweep
 *   is not a schedule: it backs off, it skips cached agents, and a visitor
 *   opening this page adds a check. A gap in the row is a gap in our sampling
 *   and must not be drawn as a reading.
 *
 *   THE DENOMINATOR IS ALWAYS ON SCREEN. "answered on 4 of 4 days we checked"
 *   is honest; "100% uptime" over a sample we chose is not.
 */

const MEANING = {
  o: 'answered',
  x: 'answered, but served nothing',
  '?': 'no reply reached us',
  '-': 'declared nothing callable',
};

const CLASS = {
  o: 'up-ok',
  x: 'up-bad',
  '?': 'up-unknown',
  '-': 'up-none',
};

// One honest phrase for a collapsed header: days answered of days checked,
// never a percentage (a rate implies a schedule we do not keep).
export function uptimeSummary(uptime) {
  const s = uptime?.summary;
  if (!s || !uptime?.days?.length) return { text: translate('no checks kept yet'), ok: undefined };
  return {
    text: translate('answered on {answered} of {checkedDays} {days} we checked{unreachable}', {
      answered: s.answered,
      checkedDays: s.checkedDays,
      days: translate(s.checkedDays === 1 ? 'day' : 'days'),
      unreachable: s.unreachable > 0 ? translate(', no reply on {count}', { count: s.unreachable }) : '',
    }),
    ok: s.answered > 0 ? true : undefined,
  };
}

export default function UptimeStrip({ uptime, bare = false }) {
  const { t } = useI18n();
  const days = uptime?.days ?? [];
  if (!days.length) return null;
  const s = uptime.summary;

  return (
    <section className="uptime" aria-label={t('check history by day')}>
      {/* `bare`: a parent collapsible section owns the header + count line. */}
      {!bare && (
        <div className="uptime-head">
          {/* "track record" rather than "uptime": the same measurements, in
              the word a reader (and the rubric) actually uses. */}
          <span className="uptime-title">{t('track record')}</span>
          <span className="uptime-count">
            {/*
              The count of days we checked, never a percentage. A rate implies a
              schedule we do not keep.
            */}
            {t('answered on {answered} of {checkedDays} {days} we checked{unreachable}', {
              answered: s.answered,
              checkedDays: s.checkedDays,
              days: t(s.checkedDays === 1 ? 'day' : 'days'),
              unreachable: s.unreachable > 0 ? t(', no reply on {count}', { count: s.unreachable }) : '',
            })}
          </span>
        </div>
      )}

      <div className="uptime-row" role="list">
        {days.map((day) => (
          <span
            key={day.d}
            role="listitem"
            className={`uptime-day ${CLASS[day.c] ?? 'up-none'}`}
            // Everything the square encodes, in words, including how many
            // checks that day and the fastest reply. A square with n=1 and one
            // with n=9 look identical and are not the same evidence.
            title={t('{date} · {meaning} · {count} {checks}{answered}{fastest}', {
              date: day.d,
              meaning: t(MEANING[day.c] ?? 'no reading'),
              count: day.n,
              checks: t(day.n === 1 ? 'check' : 'checks'),
              answered: day.ok > 0 && day.ok < day.n ? t(' ({count} answered)', { count: day.ok }) : '',
              fastest: day.ms != null ? t(' · fastest {ms} ms', { ms: day.ms }) : '',
            })}
          >
            <span className="sr-only">{t('{date}: {meaning}', { date: day.d, meaning: t(MEANING[day.c] ?? 'no reading') })}</span>
          </span>
        ))}
      </div>

      {/*
        Only the states this calendar actually contains. A legend that always
        shows a red "served nothing" square puts a failure colour on every
        page, including agents that have answered every day we ever asked.
      */}
      <p className="uptime-legend">
        {['o', 'x', '?', '-'].filter((c) => days.some((d) => d.c === c)).map((c) => (
          <span key={c} className="uptime-legend-item">
            <span className={`uptime-key ${CLASS[c]}`} aria-hidden="true" />
            {t(MEANING[c])}
          </span>
        ))}
      </p>
      <p className="uptime-note">
        {t('Days we did not check are absent rather than blank, so a gap in our own sampling is never drawn as the agent being down. Only "served nothing" is counted against an agent: a missing reply cannot be told apart from our own network from one vantage point.')}
      </p>
    </section>
  );
}
