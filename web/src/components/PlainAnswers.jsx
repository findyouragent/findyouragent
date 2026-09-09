import { ArrowDown } from 'lucide-react';
import { plainAnswers } from '../lib/narrate.js';
import { jumpToEvidence } from '../lib/jump-to-evidence.js';
import TermText from './TermText.jsx';
import { useI18n } from '../i18n/index.jsx';

/**
 * The reader's questions, answered in plain words, above the precise
 * narrative. This is the layer for someone who knows none of the protocol
 * vocabulary: is it real, does it work, does it do what it claims, can I try
 * it, is it safe to pay, who is behind it.
 *
 * Same contract as every composed surface: deterministic, field-gated, no
 * agent text, and every plain phrasing exactly as strong as the field it
 * restates. The composer lives in narrate.js beside the narrative's, so the
 * two layers are held to the same rules in the same file.
 *
 * Every sentence that restates an evidence row carries a jump to it. The
 * narrative below has had this since it was written, and it is the more
 * prominent block that lacked it: a reader met "it replied in 237 ms" here and
 * had to go and find the probe themselves. The claim under this block is that
 * these sentences came from the checks below; a control that lands on the
 * check makes that claim mechanically checkable rather than asserted.
 */
export default function PlainAnswers({ verdict, tokenId, hasRegistrationTx, uptime }) {
  const { t } = useI18n();
  const rows = plainAnswers(verdict, tokenId, { hasRegistrationTx, uptime });
  if (!rows.length) return null;

  return (
    <section className="plain-answers" aria-label={t('plain-language summary')}>
      {rows.map((row) => {
        /*
          The question is the target.

          It is the biggest, most obviously clickable thing in the row, and it
          names what the reader wants the evidence FOR. An 11px arrow at the end
          of a sentence is a hard thing to hit and an easy thing to miss.

          It goes to the row's first anchor: the evidence the answer opens with.
          Sentences below that restate a DIFFERENT row keep their own arrow, so
          the precision is not lost — but the arrows that only repeated the
          label's own destination are gone, which takes most of them off screen.
        */
        const primary = row.ev?.find(Boolean) ?? null;
        return (
        <div key={row.q} className="plain-row">
          {primary ? (
            <button
              type="button"
              className="micro-label plain-q plain-q-jump"
              title={t('show the evidence behind this answer')}
              aria-label={t('show the evidence behind: {question}', { question: t(row.q) })}
              onClick={() => jumpToEvidence(primary)}
            >
              {t(row.q)}
            </button>
          ) : (
            <span className="micro-label plain-q">{t(row.q)}</span>
          )}
          <div className="plain-a">
            {row.a.map((sentence, i) => {
              // Framing sentences restate no row and get no control: a jump
              // that lands nowhere teaches the reader to stop trusting them.
              // Nor does a sentence whose row the label already reaches —
              // that arrow was pointing where the question above it points.
              const ev = row.ev?.[i] ?? null;
              const extra = ev && ev !== primary ? ev : null;
              return (
                <p key={i} className="plain-text">
                  <TermText text={sentence} measure />
                  {extra && (
                    <button
                      type="button"
                      className="plain-jump"
                      title={t('show the evidence row this sentence restates')}
                      aria-label={t('show the evidence row this sentence restates')}
                      onClick={() => jumpToEvidence(extra)}
                    >
                      <ArrowDown size={11} strokeWidth={2} aria-hidden="true" />
                    </button>
                  )}
                </p>
              );
            })}
          </div>
        </div>
        );
      })}
      <p className="plain-note">{t('Answered from the checks below, not by a model.')}</p>
    </section>
  );
}
