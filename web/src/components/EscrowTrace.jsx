import TraceShell, { TraceRow } from './Trace.jsx';
import { useI18n } from '../i18n/index.jsx';

/*
  The escrow hire, narrated as it happens.

  This replaces a stepper that named all five stages in a row and tinted the
  current one gold. The stages were right; what it could not say was which of
  them had actually landed, which had cost a signature, and what proof each
  one left behind — so the moment the sequence finished, the only record was
  a single "job #N funded" line.

  It differs from the verification trace in one way that matters. A check's
  probes are not known in advance, so it can only report what has already come
  back. These five ARE known in advance, and each remaining one may cost a
  wallet confirmation — so the steps ahead are drawn too, dimmed. When a dialog
  is about to open over the page for the fourth time, how many are left is the
  thing a buyer wants to know.
*/

function Detail({ meta }) {
  const { t } = useI18n();
  if (!meta) return null;
  // An approval that was already in place is the reason the panel promises
  // "up to 5" rather than 5. Saying so is more useful than a silent skip.
  if (meta.skipped) return <>{meta.skipped} · {t('no signature needed')}</>;
  if (meta.tx) {
    return (
      <a href={`https://bscscan.com/tx/${meta.tx}`} target="_blank" rel="noreferrer">
        {meta.tx.slice(0, 10)}…
      </a>
    );
  }
  return null;
}

export default function EscrowTrace({ steps, current, results, elapsedMs, failed }) {
  const { t } = useI18n();
  const doneKeys = steps.filter((s) => results[s.key]);
  if (!current && !doneKeys.length) return null;

  const running = Boolean(current);
  const currentIndex = steps.findIndex((s) => s.key === current);
  // Counted from the transactions that actually happened, not from the number
  // of steps: an account with a standing allowance signs four times, not five.
  const signatures = doneKeys.filter((s) => results[s.key].tx).length;
  const seconds = elapsedMs != null ? (elapsedMs / 1000).toFixed(1) : null;

  let label;
  if (running) {
    label = t('opening escrow · step {current} of {total}', { current: currentIndex + 1, total: steps.length });
  } else if (failed) {
    label = t('escrow stopped at {step}', { step: t(steps.find((s) => s.key === failed)?.label ?? failed) });
  } else {
    label = t('escrow opened in {seconds}s · {count} wallet confirmations', { seconds: seconds ?? '—', count: signatures });
  }

  return (
    <TraceShell running={running} label={label}>
      {steps.map((s) => {
        let state = 'pending';
        if (results[s.key]) state = 'done';
        else if (s.key === failed) state = 'failed';
        else if (s.key === current) state = 'running';
        // Once the sequence has stopped, steps it never reached are not
        // "pending" — nothing is coming. They are dropped rather than left
        // hanging as though the wallet were still going to ask.
        else if (!running) return null;

        return (
          <TraceRow key={s.key} state={state} detail={<Detail meta={results[s.key]} />}>
            <span className="trace-text">
              {t(s.label)}
              {state === 'running' ? t(' · confirm in your wallet') : ''}
            </span>
          </TraceRow>
        );
      })}
    </TraceShell>
  );
}
