import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/*
  A select whose open list is ours.

  The closed control was already drawn from the palette. The list it opens was
  not, and could not be: an <option> popup is rendered by the operating system,
  so on this surface it arrived as a white sheet with a Windows-blue highlight
  row — the same borrowed default the scrollbar, the caret and the selection
  colour are each corrected for at the bottom of the stylesheet. No CSS reaches
  inside it, so the listbox is built rather than styled.

  Everything the native control does is kept, because a picker that loses the
  keyboard is a worse trade than a borrowed palette: arrows and Home/End move
  the highlight, Enter and Space commit, Escape closes without changing the
  value, Tab leaves, and printable keys jump by prefix. Focus never moves off
  the trigger — the highlighted row is named by aria-activedescendant instead —
  so the tab order is the same one the <select> had.
*/
export default function Select({
  value,
  onChange,
  options,
  label,
  disabled = false,
  mono = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  // Which row the keyboard is on. Distinct from the selected value: moving the
  // highlight must not change what the form holds until it is committed.
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const typed = useRef({ query: '', at: 0 });
  const baseId = useId();

  const index = options.findIndex((o) => o.value === value);
  const current = index >= 0 ? options[index] : null;

  useEffect(() => {
    if (open) setActive(index >= 0 ? index : 0);
  }, [open, index]);

  useEffect(() => {
    if (!open) return undefined;
    // pointerdown, not click: a mousedown that lands outside should dismiss
    // before the thing under it reacts.
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // A served-capability list runs to seventeen rows and scrolls. Keeping the
  // highlight in view is what makes the arrow keys usable rather than a way to
  // lose your place.
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function commit(i) {
    const option = options[i];
    setOpen(false);
    if (option && option.value !== value) onChange(option.value);
  }

  function move(delta) {
    if (!options.length) return;
    setOpen(true);
    setActive((cur) => {
      const from = cur >= 0 ? cur : index;
      return Math.min(options.length - 1, Math.max(0, from + delta));
    });
  }

  function onKeyDown(event) {
    const { key } = event;
    if (key === 'ArrowDown') { event.preventDefault(); move(1); return; }
    if (key === 'ArrowUp') { event.preventDefault(); move(-1); return; }
    if (key === 'Home') { event.preventDefault(); setOpen(true); setActive(0); return; }
    if (key === 'End') { event.preventDefault(); setOpen(true); setActive(options.length - 1); return; }
    if (key === 'Escape') { if (open) { event.preventDefault(); setOpen(false); } return; }
    if (key === 'Tab') { setOpen(false); return; }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (open) commit(active);
      else setOpen(true);
      return;
    }
    // Type to jump. Repeating one letter walks that letter's matches, which is
    // what a native select does and the only reason a long list is navigable
    // without a search field.
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const query = now - typed.current.at > 700 ? key : typed.current.query + key;
      typed.current = { query, at: now };
      const lower = query.toLowerCase();
      const from = (active >= 0 ? active : index) + (query.length === 1 ? 1 : 0);
      const order = options.map((_, i) => (from + i) % options.length);
      const hit = order.find((i) => String(options[i].label).toLowerCase().startsWith(lower));
      if (hit !== undefined) { setOpen(true); setActive(hit); }
    }
  }

  return (
    <div ref={rootRef} className={`sel ${mono ? 'sel-mono' : ''} ${className}`}>
      <button
        type="button"
        className="sel-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-controls={`${baseId}-list`}
        aria-activedescendant={open && active >= 0 ? `${baseId}-opt-${active}` : undefined}
      >
        <span className="sel-value" lang={current?.lang}>{current?.label ?? ''}</span>
        <ChevronDown className={`sel-chev ${open ? 'is-open' : ''}`} size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <ul ref={listRef} id={`${baseId}-list`} className="sel-list" role="listbox" aria-label={label}>
          {options.map((option, i) => (
            <li
              key={option.value}
              id={`${baseId}-opt-${i}`}
              role="option"
              lang={option.lang}
              aria-selected={option.value === value}
              data-active={i === active ? 'true' : undefined}
              className={`sel-opt ${i === active ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''}`}
              // mousedown rather than click: the outside-dismiss listener runs
              // on pointerdown, and a click handler would fire after it closed.
              onMouseDown={(e) => { e.preventDefault(); commit(i); }}
              onMouseEnter={() => setActive(i)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
