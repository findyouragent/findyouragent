import { useState } from 'react';
import { ChevronDown, ChevronRight, ArrowDown } from 'lucide-react';
import { narrate } from '../lib/narrate.js';
import { jumpToEvidence } from '../lib/jump-to-evidence.js';
import TermText from './TermText.jsx';
import { useI18n } from '../i18n/index.jsx';

/**
 * The verdict in sentences, above the evidence table that proves it.
 *
 * The text is composed in narrate.js from machine fields only. Nothing the
 * agent wrote reaches the prose, which is why it is safe to render as the
 * page's most prominent element. Echoed identifiers (the missing-skills list)
 * render as a mono data sub-line instead: prose is this site's voice, mono is
 * their material, and keeping the registers apart is part of the defence.
 *
 * Each sentence carries a jump control to the evidence block it restates,
 * which makes the footer's claim mechanically checkable instead of asserted.
 * The jump itself lives in lib/jump-to-evidence.js, shared with the plain
 * answers above, which now do the same thing.
 */

/* Tone controls wording upstream; the summary presents the resulting prose. */

// The echoed-identifier list, collapsed by default. The finding's strength
// lives in the visible prose sentence itself; the names are the
// engineer's detail, and the most alien-looking element on the page for a
// normal reader. Hiding them can neither soften nor sharpen the verdict.
function DataDisclosure({ data }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="narrative-datawrap">
      <button type="button" className="narrative-disclose" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={11} strokeWidth={2} aria-hidden="true" />}
        {open ? t('hide') : t("show what's missing")}
      </button>
      {open && <p className="narrative-data mono">{data}</p>}
    </div>
  );
}

export default function NarrativeSummary({ verdict, tokenId }) {
  const { t } = useI18n();
  const { headline, lines, coach } = narrate(verdict, tokenId);
  if (!lines.length) return null;

  return (
    <section className="narrative" aria-label={t('summary')}>
      <h3 className="micro-label">{t('what we found, in detail')}</h3>
      <p className="narrative-headline"><TermText text={headline} /></p>
      {lines.map((line, i) => (
        // Lines are generated in a fixed order from a fixed set of branches,
        // so the index is stable across renders of the same verdict.
        <div key={i} className="narrative-line">
          <p className="narrative-text">
            <TermText text={line.text} />
            {line.ev && (
              <button
                type="button"
                className="narrative-jump"
                title={t('show the evidence row this sentence restates')}
                aria-label={t('show the evidence row this sentence restates')}
                onClick={() => jumpToEvidence(line.ev)}
              >
                <ArrowDown size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </p>
          {line.data && <DataDisclosure data={line.data} />}
        </div>
      ))}
      {/*
        The coach is a separate speech act, outside the findings: it does not
        restate an evidence row, it restates the tier expression itself, so it
        sits apart and the footer's promise stays literally true.
      */}
      {coach && (
        <div className="narrative-coach">
          <span className="micro-label">{t(coach.label)}</span>
          <p className="narrative-text"><TermText text={coach.text} /></p>
        </div>
      )}
      {/*
        The legend that stood here explained the two marks and, necessarily, a
        third state: "unmarked lines claim neither". Three states of a symbol
        the reader had to learn, to grade sentences that already grade
        themselves. With the marks gone the legend has nothing to define, and
        the promise it was attached to is the part worth keeping.
      */}
      <p className="narrative-note">
        {t('Composed from the checks below, not written by a model. Each sentence links to the row it restates.')}
      </p>
    </section>
  );
}
