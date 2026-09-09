/**
 * Send the reader to the evidence row a sentence restates.
 *
 * Extracted from NarrativeSummary because the plain answers now do the same
 * thing, and two copies of this would drift the first time either is touched —
 * the open-before-scroll ordering below is exactly the kind of detail that
 * survives in one copy and quietly rots in the other.
 *
 * A function with scrollIntoView, deliberately not an href: the app's hash
 * router sends any unknown fragment to the home page, so a fragment link here
 * would navigate the reader away from the agent they are reading about.
 */
export function jumpToEvidence(evKey) {
  const el = document.getElementById(`ev-${evKey}`);
  if (!el) return;
  // Evidence sections are collapsed by default; ask the target to open before
  // scrolling so the reader lands on the row, not on a closed header.
  //
  // The target section owns its focus flash; this helper only opens and scrolls.
  el.dispatchEvent(new window.Event('ev-open'));
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  // Move focus so the landing is announced, without a second scroll.
  el.focus?.({ preventScroll: true });
}

export default jumpToEvidence;
