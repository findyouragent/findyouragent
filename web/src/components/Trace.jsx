import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/* A trace shell names the current operation and keeps resolved steps visible. */

// Nine dots, lit in a diagonal sweep from the middle-left.
const DOT_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const col = i % 3;
  return (col + Math.abs(row - 1)) * 90;
});

export function PixelDots() {
  return (
    <span className="pixel-dots" aria-hidden="true">
      {DOT_DELAYS.map((delay, i) => (
        <span key={i} className="pixel-dot" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

/*
  One row. `state` is what has actually happened to this step:

    done     it resolved — the mark says it came back, not that it passed
    running  in flight right now
    pending  not started; only knowable when the steps are known in advance
    failed   it threw, and the trace stops here
*/
export function TraceRow({ state = 'done', children, detail }) {
  return (
    <div className={`trace-row is-${state}`}>
      {state === 'running' ? (
        <span className="trace-spinner" aria-hidden="true" />
      ) : (
        <span className={`trace-mark ${state === 'pending' ? 'is-pending' : ''} ${state === 'failed' ? 'is-failed' : ''}`} aria-hidden="true" />
      )}
      {children}
      {detail ? <span className="trace-detail">{detail}</span> : null}
    </div>
  );
}

export default function TraceShell({ running, label, children }) {
  // While it runs the trace is open, because it is the thing to look at. Once
  // the result is there the result is the thing to look at, so it folds — but
  // it stays, and one click brings back how the result was reached.
  const [manualOpen, setManualOpen] = useState(null);
  const open = manualOpen === null ? running : manualOpen;

  return (
    <div className="trace">
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setManualOpen(!open)}
      >
        {running ? <PixelDots /> : null}
        <span className="trace-title">{label}</span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className={`trace-chevron ${open ? 'is-open' : ''}`}
        />
      </button>

      <div className={`trace-body ${open ? 'is-open' : ''}`}>
        <div className="trace-inner">
          <div className="trace-rail" role="log" aria-live="polite">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
