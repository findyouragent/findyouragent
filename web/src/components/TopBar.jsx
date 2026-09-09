import { useEffect, useRef } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import BrandMark from './BrandMark.jsx';
import { useSlidingMarks, SlidingMarks } from './SlidingMarks.jsx';
import { useI18n } from '../i18n/index.jsx';
import Select from './ui/select.jsx';

/*
  The header links carry the same travelling mark as the view tabs, so the two
  rows read as one family of control.

  `docs` is static HTML served outside the app, so it can be hovered but never
  underlined: by the time you are on it this router is not running, and there
  is no route for it to match. The underline means "you are here", and it stays
  honest by only appearing where that is true.
*/
const NAV = [
  { key: 'about', label: 'about', href: '/docs/about' },
  { key: 'methodology', label: 'methodology', href: '#/methodology' },
  { key: 'docs', label: 'docs', href: '/docs' },
];

const LANGUAGES = [
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'zh-CN', label: '简体中文', lang: 'zh-CN' },
];

function TopNav({ page }) {
  const { t, locale } = useI18n();
  const active = NAV.findIndex((n) => n.key === page);
  const { refs, hovered, setHovered, bar, pill } = useSlidingMarks(active < 0 ? null : active, `${page}:${locale}`);

  return (
    <nav className="topnav" aria-label={t('site')} onMouseLeave={() => setHovered(null)}>
      <SlidingMarks bar={bar} pill={pill} hovered={hovered} />
      {NAV.map((n, i) => (
        <a
          key={n.key}
          ref={(el) => { refs.current[i] = el; }}
          className={`tab topnav-link ${active === i ? 'tab-active' : ''}`}
          href={n.href}
          aria-current={active === i ? 'page' : undefined}
          onMouseEnter={() => setHovered(i)}
          onFocus={() => setHovered(i)}
          onBlur={() => setHovered(null)}
        >
          {t(n.label)}
        </a>
      ))}
    </nav>
  );
}

export default function TopBar({ search, onSearchChange, onSearchSubmit, page }) {
  const { t, locale, setLocale } = useI18n();
  const inputRef = useRef(null);

  useEffect(() => {
    function onKey(event) {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.isContentEditable
        || target.closest('input, textarea, select, [role="textbox"], [role="combobox"]'));
      if (event.key === '/' && !event.defaultPrevented && !event.isComposing
        && !event.ctrlKey && !event.metaKey && !event.altKey && !editing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="topbar">
      {/* The wordmark goes home, which every visitor already expects it to.
          Deliberately to a clean "#" rather than the back link's href: the
          arrow on a detail page returns you to the filters you left, and the
          logo starts over. Two different intentions, two destinations. */}
      <a className="brand" href="#" aria-label={t('findyouragent — all agents')}>
        <BrandMark />
        <span className="brand-name">findyouragent</span>
      </a>
      <form
        className="topbar-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSearchSubmit();
          if (window.matchMedia('(max-width: 700px)').matches) {
            inputRef.current?.blur();
            requestAnimationFrame(() => {
              inputRef.current?.closest('header')?.scrollIntoView({ block: 'start', behavior: 'instant' });
            });
          }
        }}
      >
        <Search className="search-icon" size={14} strokeWidth={2} aria-hidden="true" />
        {/* The box no longer searches only names: it also matches the
            capabilities agents actually served when we called them, so it is
            asked as a task. */}
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('search by name, or what you need done')}
          aria-label={t('search agents by name, or by what you need done')}
        />
        <button className="topbar-search-submit" type="submit" aria-label={t('Search')}>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        <kbd aria-hidden="true">/</kbd>
      </form>
      <div className="topbar-right">
        <TopNav page={page} />
        <Select className="language-select" label={t('Language')} value={locale}
          onChange={setLocale} options={LANGUAGES} />
      </div>
    </header>
  );
}
