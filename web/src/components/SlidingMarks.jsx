import { useEffect, useRef, useState } from 'react';

/*
  One indicator that slides, rather than a border drawn on whichever item is on.

  Two absolutely-positioned marks share a row: a pill that follows the pointer,
  and the underline that marks where you are. Both are measured from the items
  themselves — offsetLeft and offsetWidth — so the labels stay the source of
  truth and nothing has to be hardcoded when one is renamed.

  Shared by the view tabs and the header nav, which want the same motion but
  not the same semantics: one is a tablist of buttons, the other is a list of
  links to other pages. Only the measuring is common, so only the measuring
  lives here.
*/
export function useSlidingMarks(activeIndex, dep) {
  const refs = useRef([]);
  const [hovered, setHovered] = useState(null);
  const [bar, setBar] = useState(null);
  const [pill, setPill] = useState(null);

  useEffect(() => {
    const measure = () => {
      // activeIndex is null where none of the items is the current page — the
      // header nav on every route but its own. There is nothing to underline
      // then, and underlining the first item would be a claim about where you
      // are that is simply false.
      const el = activeIndex == null ? null : refs.current[activeIndex];
      setBar(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    window.addEventListener('resize', measure);
    // The webfont lands after first paint and every label changes width with
    // it, so a single measurement on mount leaves the underline misplaced
    // until something else forces a re-render.
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    return () => window.removeEventListener('resize', measure);
  }, [activeIndex, dep]);

  useEffect(() => {
    if (hovered === null) return;
    const el = refs.current[hovered];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [hovered]);

  return { refs, hovered, setHovered, bar, pill };
}

// Hidden until the first measurement, so neither mark flashes at x=0.
export function SlidingMarks({ bar, pill, hovered }) {
  return (
    <>
      {pill && (
        <span
          className="tab-pill"
          aria-hidden="true"
          style={{ left: pill.left, width: pill.width, opacity: hovered === null ? 0 : 1 }}
        />
      )}
      {bar && <span className="tab-bar" aria-hidden="true" style={{ left: bar.left, width: bar.width }} />}
    </>
  );
}

export default SlidingMarks;
