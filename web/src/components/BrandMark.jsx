import { MARK_PATH } from '../lib/mark.js';

/*
  The mark, inline rather than an <img src="/mark.svg">.

  It sits 18px tall beside the wordmark, where its own request would arrive
  after the text it belongs to and shift the row. Inline it also takes its two
  fills from the palette: --text-hi and --brand. --brand rather than --live on
  purpose — see the note in tokens.css.
*/
export default function BrandMark({ size = 18 }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <path d={MARK_PATH} fill="var(--text-hi)" />
      <path d={MARK_PATH} fill="var(--brand)" transform="rotate(180 50 50)" />
    </svg>
  );
}
