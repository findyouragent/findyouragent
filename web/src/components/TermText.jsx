import { TERMS, TERM_KEYS } from '../lib/terms.js';
import { useI18n } from '../i18n/index.jsx';

/**
 * Renders a string of OUR prose with dictionary terms wrapped in a
 * dotted-underline tooltip.
 *
 * The wrapping is a display concern layered over the composed text, so
 * narrate.js stays a pure string composer. It is safe on exactly one
 * condition, which holds by construction: the strings passed here are this
 * site's own sentences. Agent-authored identifiers never enter prose (they
 * live in mono data lines, which are never term-wrapped), so a term match can
 * only ever hit our own vocabulary.
 *
 * First occurrence per text only: a paragraph where every "skill" is
 * underlined reads like a legal document, and the reader who wanted the
 * definition got it at the first one.
 */

/*
  The measured spans inside our own sentences.

  Every plain answer is composed from fields, so the numbers ARE the evidence
  and the rest is grammar. Emphasising them is therefore structural rather than
  editorial: nothing here decides that one fact outranks another, which is a
  judgement this page refuses to make elsewhere in the very same paragraph.

  Weight, never colour, and never a second underline — the dotted rule already
  means one specific thing ("this word has a definition") and a paragraph with
  two emphasis systems in it has none.

  An identifier is not a measurement: "#45381" is excluded, because a token id
  is a name that happens to be spelled in digits.
*/
const MEASURE = new RegExp(
  [
    String.raw`\d[\d,]*(?:\.\d+)?\s*(?:毫秒|项(?:工具|技能)?|条(?:链上反馈|反馈记录)?|天)`,
    String.raw`\d[\d,]*(?:\.\d+)?\s?ms\b`,
    String.raw`\d[\d,]*\s+of\s+\d[\d,]*\s+[a-z]+`,
    String.raw`\d[\d,]*\s+(?:tools?|skills?|feedbacks?|days?|capabilities|checks?)\b`,
  ].join('|'),
  'g',
);

let tipSeq = 0;

function Term({ term, source, definition }) {
  // Stable enough: ids only need to be unique within the rendered document,
  // and each mount gets its own.
  const [tipId] = [(tipSeq += 1)];
  return (
    <span className="term" tabIndex={0} aria-describedby={`term-tip-${tipId}`}>
      {term}
      <span className="term-tip" role="tooltip" id={`term-tip-${tipId}`}>
        {definition ?? TERMS[source ?? term]}
      </span>
    </span>
  );
}

export default function TermText({ text, measure = false }) {
  const { t } = useI18n();
  if (typeof text !== 'string' || !text) return null;
  const localizedText = t(text);

  // Longest key first (TERM_KEYS is pre-sorted), one wrap per key, and a
  // matched span is consumed so overlapping keys cannot double-wrap:
  // "on-chain feedback" claims its range before "on-chain" is considered.
  const ranges = [];
  const taken = [];
  for (const key of TERM_KEYS) {
    const localizedKey = t(key);
    const matchedKey = localizedText.includes(localizedKey) ? localizedKey : key;
    const at = localizedText.indexOf(matchedKey);
    if (at === -1) continue;
    const end = at + matchedKey.length;
    if (taken.some(([s, e]) => at < e && end > s)) continue;
    taken.push([at, end]);
    ranges.push({ at, end, key, label: matchedKey });
  }
  // Same range list, same overlap guard: a measurement that lands inside a
  // dictionary term is dropped rather than nested, so no span is ever wrapped
  // twice.
  if (measure) {
    MEASURE.lastIndex = 0;
    for (let m = MEASURE.exec(localizedText); m; m = MEASURE.exec(localizedText)) {
      const at = m.index;
      const end = at + m[0].length;
      if (localizedText[at - 1] === '#') continue;
      if (taken.some(([s, e]) => at < e && end > s)) continue;
      taken.push([at, end]);
      ranges.push({ at, end, measured: m[0] });
    }
  }

  if (!ranges.length) return localizedText;
  ranges.sort((a, b) => a.at - b.at);

  const parts = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.at > cursor) parts.push(localizedText.slice(cursor, r.at));
    if (r.measured) {
      parts.push(<strong key={`m-${r.at}`} className="measured">{r.measured}</strong>);
    } else {
      parts.push(<Term key={`${r.key}-${r.at}`} term={r.label} source={r.key} definition={t(TERMS[r.key])} />);
    }
    cursor = r.end;
  }
  if (cursor < localizedText.length) parts.push(localizedText.slice(cursor));
  return parts;
}
