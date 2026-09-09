import { useSlidingMarks, SlidingMarks } from './SlidingMarks.jsx';
import { useI18n } from '../i18n/index.jsx';

/*
  The view selector. Motion and measuring come from useSlidingMarks, which the
  header nav shares; what stays here is the tablist semantics.

  Deliberately controlled. The component this grew from keeps the active index
  in its own state, initialised to 0, and never reads the `activeTab` prop it
  accepts; a parent that owns the selection — as this one does, because the tab
  lives in the URL — would silently disagree with it after the first click.
*/
export default function ViewTabs({ tabs, activeKey, onSelect }) {
  const { t, locale } = useI18n();
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.key === activeKey));
  const { refs, hovered, setHovered, bar, pill } = useSlidingMarks(activeIndex, `${activeKey}:${locale}`);

  return (
    <div className="tabs" role="tablist" aria-label={t('views')} onMouseLeave={() => setHovered(null)}>
      <SlidingMarks bar={bar} pill={pill} hovered={hovered} />
      {tabs.map((tab, i) => (
        <button
          key={tab.key}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="tab"
          aria-selected={activeKey === tab.key}
          className={`tab ${activeKey === tab.key ? 'tab-active' : ''}`}
          onMouseEnter={() => setHovered(i)}
          // Keyboard focus moves the pill too, so the row behaves the same
          // whether it is being pointed at or tabbed through.
          onFocus={() => setHovered(i)}
          onBlur={() => setHovered(null)}
          onClick={() => onSelect(tab.key)}
        >
          {t(tab.label)}
        </button>
      ))}
    </div>
  );
}
