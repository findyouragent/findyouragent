import TraceShell, { TraceRow } from './Trace.jsx';
import { useI18n } from '../i18n/index.jsx';

/* Shows verification steps while running and after completion. */
export default function CheckTrace({ lines, running, elapsedMs }) {
  const { t } = useI18n();
  if (!running && !lines.length) return null;

  const seconds = elapsedMs != null ? (elapsedMs / 1000).toFixed(1) : null;
  const label = running
    ? t('checking this agent, live')
    : t('checked in {seconds}s · {count} {probes}', {
      seconds: seconds ?? '—',
      count: lines.length,
      probes: t(lines.length === 1 ? 'probe' : 'probes'),
    });

  return (
    <TraceShell running={running} label={label}>
      {lines.map((line, i) => (
        <TraceRow key={i}>
          <span className="trace-text mono">{line}</span>
        </TraceRow>
      ))}
      {/* One row for the probe currently in flight. The stream only sends a
          frame when a call RESOLVES, so its name is not known yet — claiming
          one would be inventing it. */}
      {running && (
        <TraceRow state="running">
          <span className="trace-text trace-waiting">{t('waiting on the next probe…')}</span>
        </TraceRow>
      )}
    </TraceShell>
  );
}
