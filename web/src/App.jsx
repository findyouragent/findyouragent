import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ViewTabs from './components/ViewTabs.jsx';
import TopoBackground from './components/TopoBackground.jsx';
import { ArrowRight, ExternalLink, X } from 'lucide-react';
import {
  listAgents, searchAgents, getAgentDetail, getRegistryStats, getVerifySummary, getKnownVerdicts,
  getCheckedAgents, searchByCapability,
} from './api/client.js';
import { CATEGORIES, JUDGED_CATEGORIES, TABS, VERIFY_BASE, formatCount } from './config.js';
import { CURATED } from './data/curated.js';
import TopBar from './components/TopBar.jsx';
import BrandMark from './components/BrandMark.jsx';
import StatStrip from './components/StatStrip.jsx';
import AgentTable from './components/AgentTable.jsx';
import FlowButton from './components/ui/flow-button.jsx';
import AgentDetail from './pages/AgentDetail.jsx';
import Methodology from './pages/Methodology.jsx';
import Compare from './pages/Compare.jsx';
import { recoverRegistryRows, registryFailureMessage, bscCountFromStats, bscCountFromList, newestRegistryCount } from './lib/browse-recovery.js';
import './styles/task-browse.css';
import './styles/registry-recovery.css';
import './styles/mobile-search.css';
import { useI18n } from './i18n/index.jsx';

const COMPARE_STORAGE = 'fya:compare-selection:v1';

function boundedRequest(request, label, waitMs = 12_000) {
  let timeout;
  return Promise.race([
    request,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} did not respond. Try again shortly.`)), waitMs); }),
  ]).finally(() => clearTimeout(timeout));
}

function readComparison(initial) {
  let saved = [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(COMPARE_STORAGE) ?? '[]');
    if (Array.isArray(parsed)) saved = parsed.filter((item) => /^\d+:\d+$/.test(item?.key)
      && typeof item.name === 'string').slice(0, 3);
  } catch { /* Selection still works when browser storage is unavailable. */ }
  const keys = initial.page === 'compare' ? initial.keys : [...new Set(saved.map((item) => item.key))];
  return keys.map((key) => saved.find((item) => item.key === key)
    ?? { key, name: `agent #${key.split(':')[1]}` });
}

/* The two ways the BSC count fails. Only the first is worth trying again:
   a service that cannot serve statistics cannot serve them thirty seconds
   later either. */
const COUNT_FAILED = 'The BSC registry count could not load.';
const COUNT_UNSUPPORTED = 'This FYA service does not support registry statistics yet.';

function TaskEntry({ categoryKey, summary }) {
  const { t } = useI18n();
  return (
    <section className="task-entry" aria-labelledby="task-entry-title">
      <div className="task-entry-head">
        <h2 id="task-entry-title">{t('What do you need an agent for?')}</h2>
        <a href={homeHash({})} aria-current={categoryKey === 'all' ? 'page' : undefined}>{t('All categories')}</a>
      </div>
      <nav className="task-entry-links" aria-label={t('Choose a task category')}>
        {CATEGORIES.filter((item) => JUDGED_CATEGORIES.includes(item.key)).map((item) => {
          const served = summary?.coverage?.[item.key]?.served;
          const count = formatCount(served);
          return (
            <a key={item.key} href={homeHash({ categoryKey: item.key })}
              aria-current={categoryKey === item.key ? 'page' : undefined}>
              <span className="task-entry-name">{t(item.label)}<ArrowRight size={14} aria-hidden="true" /></span>
              <span className="task-entry-count">{count === null
                ? t('Availability not checked')
                : served === 0 ? t('No matching capabilities found in our checks')
                  : t(served === 1 ? '{count} endpoint lists related capabilities' : '{count} endpoints list related capabilities', { count })}</span>
            </a>
          );
        })}
      </nav>
      <p className="task-entry-note">{t('Listed capabilities may offer advice or data. These counts do not establish completed trades, allocation or ongoing monitoring.')}</p>
    </section>
  );
}

function ComparisonSelection({ selected, onRemove, onClear }) {
  const { t } = useI18n();
  return (
    <section className={`comparison-selection${selected.length > 0 ? ' has-selection' : ''}`} aria-label={t('Agents selected for comparison')}>
      <div className="comparison-selection-heading">
        <span id="comparison-selection-help" role="status">{selected.length === 0
          ? t('Select up to 3 agents to compare their evidence.')
          : t(selected.length === 1 ? '{count} of 3 selected · choose one more to compare' : '{count} of 3 selected', { count: selected.length })}</span>
        {selected.length > 0 && <button className="comparison-clear" type="button" onClick={onClear}>
          <X size={14} aria-hidden="true" />{t('Clear selection')}
        </button>}
      </div>
      {selected.length > 0 && (
        <div className="comparison-selection-body">
          <ul>
            {selected.map((item) => <li key={item.key}>
              <span className="comparison-agent-label">
                <span className="comparison-agent-name">{item.name}</span>
                <small className="mono">#{item.key.split(':')[1]}</small>
              </span>
              <button className="comparison-agent-remove" type="button" onClick={() => onRemove(item.key)} aria-label={t('Remove {name} from comparison', { name: item.name })}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>)}
          </ul>
          {selected.length >= 2 && <FlowButton variant="neutral" className="comparison-open flow-block" href={`#/compare/${selected.map((item) => item.key).join(',')}`}>
            {t('Compare {count} agents', { count: selected.length })}
          </FlowButton>}
        </div>
      )}
    </section>
  );
}

/**
 * Encode browsing state for shareable URLs and back/forward navigation.
 * Omit defaults so the initial view remains '#'.
 */
export function homeHash({ tabKey, categoryKey, query, page }) {
  const params = new URLSearchParams();
  if (tabKey && tabKey !== 'verified') params.set('tab', tabKey);
  if (categoryKey && categoryKey !== 'all') params.set('cat', categoryKey);
  if (query?.trim()) params.set('q', query.trim());
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `#/?${qs}` : '#';
}

function parseHash() {
  if (window.location.hash === '#/methodology') return { page: 'methodology' };
  // Up to three agents side by side: #/compare/56:1,56:2,56:3
  const cmp = window.location.hash.match(/^#\/compare\/([\d:,]+)$/);
  if (cmp) {
    const keys = [...new Set(cmp[1].split(',').filter((k) => /^\d+:\d+$/.test(k)))].slice(0, 3);
    if (keys.length >= 1) return { page: 'compare', keys };
  }
  // An optional trailing /try or /hire opens that panel on arrival, so a row's
  // action link lands the visitor on the thing they clicked, not on a page.
  const match = window.location.hash.match(/^#\/agent\/(\d+)\/(\d+)(?:\/(try|hire))?$/);
  if (match) return { page: 'agent', chainId: match[1], tokenId: match[2], action: match[3] ?? null };

  const home = window.location.hash.match(/^#\/?\?(.+)$/);
  if (home) {
    const p = new URLSearchParams(home[1]);
    return {
      page: 'home',
      tab: p.get('tab'),
      cat: p.get('cat'),
      q: p.get('q') ?? '',
      pageNum: Math.max(1, Number(p.get('page')) || 1),
    };
  }
  return { page: 'home' };
}

async function fetchCuratedRows(categoryKey) {
  const pins = CURATED[categoryKey] ?? [];
  const rows = await Promise.allSettled(pins.map((p) => getAgentDetail(p.chainId, p.tokenId)));
  return rows
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => ({ ...r.value, curated: true }));
}

// Reveal footer blocks with an observer and CSS transitions. Reduced-motion
// preferences and browsers without an observer show the content immediately.
function useReveal() {
  const ref = useRef(null);
  // Decided once at mount: when the entrance cannot or should not run we
  // never observe at all and the footer simply renders. Otherwise `shown`
  // tracks visibility for the session rather than latching on first sight.
  const skipEntrance = useRef(
    typeof window === 'undefined'
      || !('IntersectionObserver' in window)
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current;
  const [shown, setShown] = useState(skipEntrance);

  useEffect(() => {
    if (skipEntrance || !ref.current) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { setShown(true); continue; }
          // Re-arm below the viewport, including when loaded rows push the
          // footer down. Scrolling above it does not replay the entrance.
          if (e.boundingClientRect.top > 0) setShown(false);
        }
      },
      { rootMargin: '0px 0px -64px 0px' },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [skipEntrance]);

  return [ref, shown];
}

function FooterLink({ href, children, external = false }) {
  if (!external) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children} <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
    </a>
  );
}

function SiteFooter({ version }) {
  const { t } = useI18n();
  const [footerRef, shown] = useReveal();
  return (
    <footer ref={footerRef} className={shown ? 'is-in' : ''}>
      <div className="footer-top">
        <div className="footer-identity" data-reveal="1">
          <div className="footer-brand">
            <BrandMark />
            <span className="brand-name">findyouragent</span>
          </div>
          <p className="footer-tagline">
            {t('Find, check, and hire agents on BNB Chain from evidence their endpoints actually produced, not from what they say about themselves.')}
          </p>
        </div>

        <nav className="footer-nav" data-reveal="2" aria-label={t('browse')}>
          <span className="micro-label">{t('browse')}</span>
          <FooterLink href="#">{t('all agents')}</FooterLink>
          <FooterLink href="#/?tab=top">{t('top ranked')}</FooterLink>
          <FooterLink href="#/?tab=new">{t('newest')}</FooterLink>
        </nav>

        {/* Category links use the same labels and filters as the browse view. */}
        <nav className="footer-nav" data-reveal="3" aria-label={t('categories')}>
          <span className="micro-label">{t('categories')}</span>
          {CATEGORIES.filter((c) => c.key !== 'all').slice(0, 4).map((c) => (
            <FooterLink key={c.key} href={homeHash({ categoryKey: c.key })}>{t(c.label)}</FooterLink>
          ))}
        </nav>

        <nav className="footer-nav" data-reveal="4" aria-label={t('verification')}>
          <span className="micro-label">{t('verification')}</span>
          <FooterLink href="#/methodology">{t('how it works')}</FooterLink>
          {/* Publish the server's formula version only after it is known. */}
          {version && <FooterLink href="#/methodology">{t('liveness formula v{version}', { version })}</FooterLink>}
          <FooterLink href="https://8004scan.io/agents" external>{t('8004scan registry')}</FooterLink>
          <FooterLink href="https://bscscan.com" external>BscScan</FooterLink>
        </nav>
      </div>

    </footer>
  );
}

export default function App() {
  const { t, locale } = useI18n();
  // Whatever the opening URL describes, so a shared link lands on that view.
  const initial = useRef(parseHash()).current;
  const [selected, setSelected] = useState(() => readComparison(initial));
  const [agents, setAgents] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(initial.pageNum ?? 1);
  const [search, setSearch] = useState(initial.q ?? '');
  const [query, setQuery] = useState(initial.q ?? '');
  const [tabKey, setTabKey] = useState(initial.tab ?? 'verified');
  const [categoryKey, setCategoryKey] = useState(initial.cat ?? 'all');
  // Count search hits from listed capabilities separately from registry text matches.
  const [capabilityHits, setCapabilityHits] = useState(0);
  const [verifiedCount, setVerifiedCount] = useState(0);
  const [registryTail, setRegistryTail] = useState(null);
  const [verdicts, setVerdicts] = useState({});
  const [registryObservation, setRegistryObservation] = useState(null);
  const [registryStatus, setRegistryStatus] = useState('loading');
  const [registryError, setRegistryError] = useState(null);
  const [statsRetry, setStatsRetry] = useState(0);
  const statsBusy = useRef(false);
  const [browseRetry, setBrowseRetry] = useState(0);
  const [browseBusy, setBrowseBusy] = useState(false);
  const browseRequest = useRef({ key: null, busy: false });
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => {
      const next = parseHash();
      setRoute(next);
      if (next.page === 'compare') {
        setSelected((prev) => next.keys.map((key) => prev.find((item) => item.key === key)
          ?? { key, name: `agent #${key.split(':')[1]}` }));
      }
      // Restore what the URL describes, so the browser's own back and forward
      // buttons return the visitor to the view they left, not to a reset page.
      if (next.page === 'home') {
        setTabKey(next.tab ?? 'verified');
        setCategoryKey(next.cat ?? 'all');
        setQuery(next.q ?? '');
        setSearch(next.q ?? '');
        setPage(next.pageNum ?? 1);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    try { window.sessionStorage.setItem(COMPARE_STORAGE, JSON.stringify(selected)); } catch { /* Optional persistence. */ }
  }, [selected]);

  const toggleComparison = useCallback((agent) => {
    const key = `${agent.chain_id}:${agent.token_id}`;
    setSelected((prev) => {
      if (prev.some((item) => item.key === key)) return prev.filter((item) => item.key !== key);
      if (prev.length >= 3) return prev;
      return [...prev, { key, name: agent.name || `agent #${agent.token_id}` }];
    });
  }, []);

  const changeComparisonKeys = useCallback((keys) => {
    setSelected((prev) => keys.map((key) => prev.find((item) => item.key === key)
      ?? { key, name: `agent #${key.split(':')[1]}` }));
  }, []);

  const nameComparisonAgents = useCallback((named) => {
    setSelected((prev) => {
      const next = prev.map((item) => named.find((agent) => agent.key === item.key) ?? item);
      return next.some((item, i) => item.name !== prev[i].name) ? next : prev;
    });
  }, []);

  // Keep the URL in step with the controls, without adding a history entry per
  // keystroke or filter click (replaceState fires no hashchange, so this cannot
  // loop with the listener above).
  const backHref = homeHash({ tabKey, categoryKey, query, page });
  useEffect(() => {
    if (route.page !== 'home') return;
    const target = backHref === '#' ? '' : backHref;
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target || window.location.pathname + window.location.search);
    }
  }, [route.page, backHref]);

  const tab = useMemo(() => TABS.find((t) => t.key === tabKey) ?? TABS[0], [tabKey]);

  const category = useMemo(() => CATEGORIES.find((c) => c.key === categoryKey) ?? CATEGORIES[0], [categoryKey]);

  useEffect(() => {
    if (route.page !== 'home') return;
    let cancelled = false;
    const key = JSON.stringify([page, query, tab.key, category.key]);
    const sameView = browseRequest.current.key === key;
    const keepRows = sameView && agents.length > 0;
    browseRequest.current = { key, busy: true };
    setBrowseBusy(true);
    setLoading(!keepRows);
    if (!sameView) {
      setError(null);
      setAgents([]);
      setPagination(null);
      setRegistryTail(null);
      setVerifiedCount(0);
      setCapabilityHits(0);
    }

    function enrichVerdicts(rows) {
      boundedRequest(getKnownVerdicts(rows), 'Saved verdicts').then((known) => {
        if (!cancelled) setVerdicts((prev) => ({ ...known, ...prev }));
      }).catch(() => {});
    }

    function showSaved(rows, kind) {
      if (cancelled || keepRows) return;
      setAgents(rows);
      setVerifiedCount(kind === 'checked' ? rows.length : 0);
      setCapabilityHits(kind === 'capability' ? rows.length : 0);
      setRegistryTail('loading');
      setPagination(null);
      setLoading(false);
      enrichVerdicts(rows);
    }

    async function load() {
      if (query.trim()) {
        // Listed-capability matches lead on page one. Subsequent pages contain
        // registry matches only; each source remains identified in the result.
        return recoverRegistryRows({
          registry: searchAgents({ query, page }),
          saved: page === 1 ? boundedRequest(searchByCapability(query), 'Saved capabilities') : [],
          kind: 'capability', onSaved: (rows) => showSaved(rows, 'capability'),
        });
      }
      if (category.searchTerm) {
        return recoverRegistryRows({
          registry: searchAgents({ query: category.searchTerm, semanticQuery: category.semanticQuery, page }),
          saved: page === 1 ? boundedRequest(fetchCuratedRows(category.key), 'Reviewed agents', 16_000) : [],
          kind: 'curated', onSaved: (rows) => showSaved(rows, 'curated'),
        });
      }
      // Stored verdicts lead on page one, followed by deduplicated registry rows.
      // Subsequent pages continue the registry, with any stored verdicts attached.
      if (tab.fromStore) {
        // The checked list belongs to FYA. A slow registry must not hide it
        // while we wait for the newest registrations to fill out the page.
        return recoverRegistryRows({
          registry: listAgents({ page, sortBy: 'created_at' }),
          saved: page === 1 ? boundedRequest(getCheckedAgents(50), 'The checked agent list') : [],
          kind: 'checked', onSaved: (rows) => showSaved(rows, 'checked'),
        });
      }
      return listAgents({ page, sortBy: tab.sortBy });
    }

    boundedRequest(load(), 'The agent list', 27_000)
      .then((result) => {
        if (cancelled) return;
        setAgents(result.agents);
        setPagination(result.pagination);
        setCapabilityHits(result.capabilityHits ?? 0);
        setVerifiedCount(result.verifiedCount ?? 0);
        setRegistryTail(result.registryFailure ? 'unavailable' : 'ready');
        setError(result.registryFailure ?? null);
        setRegistryObservation((previous) => newestRegistryCount(previous, bscCountFromList(result)));
        setLoading(false);
        // Show what the sweep already proved, immediately. Verdicts checked in
        // this session win, since they are fresher than anything on record.
        enrichVerdicts(result.agents);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(registryFailureMessage(err));
        setRegistryTail('unavailable');
        setPagination(null);
      })
      .finally(() => {
        if (cancelled) return;
        browseRequest.current.busy = false;
        setBrowseBusy(false);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      browseRequest.current.busy = false;
    };
  }, [page, query, tab, category, route.page, browseRetry]);

  const retryBrowse = useCallback(() => {
    if (browseRequest.current.busy) return;
    browseRequest.current.busy = true;
    setBrowseBusy(true);
    setBrowseRetry((value) => value + 1);
  }, []);

  useEffect(() => {
    if (route.page !== 'home' && route.page !== 'methodology') return;
    let cancelled = false;
    statsBusy.current = true;
    setRegistryStatus('loading');
    getRegistryStats().then((stats) => {
      if (cancelled) return;
      const observed = bscCountFromStats(stats);
      if (!observed) throw new Error('The registry response did not include a BSC count.');
      setRegistryObservation((previous) => newestRegistryCount(previous, observed));
      setRegistryStatus('ready');
      setRegistryError(null);
    }).catch((error) => {
      if (cancelled) return;
      setRegistryStatus('unavailable');
      setRegistryError(error?.code === 'registry-service-outdated'
        ? COUNT_UNSUPPORTED
        : COUNT_FAILED);
    }).finally(() => { if (!cancelled) statsBusy.current = false; });
    return () => { cancelled = true; statsBusy.current = false; };
  }, [route.page, statsRetry]);

  /*
    A failed count retries itself, on the same 30s beat the summary beside it
    has always used.

    There was a "Retry count" button here instead. The registry flakes — 502s
    from upstream are routine — and the button meant the one figure on this
    strip that never refreshed itself was also the only one that asked the
    reader to repair it, standing next to three that had loaded and a table
    that had not been blocked by anything. Pressing it did what waiting does.

    Only the transient failure is retried. A service too old to serve
    statistics will still be too old in thirty seconds, and polling it forever
    would be a spinner pretending to be progress.
  */
  useEffect(() => {
    if (registryStatus !== 'unavailable' || registryError !== COUNT_FAILED) return;
    const timer = setTimeout(() => setStatsRetry((value) => value + 1), 30_000);
    return () => clearTimeout(timer);
  }, [registryStatus, registryError]);

  useEffect(() => {
    getVerifySummary().then(setSummary).catch(() => {});
    const interval = setInterval(() => {
      getVerifySummary().then(setSummary).catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const onSearchChange = useCallback((value) => {
    setSearch(value);
    if (!value) {
      setQuery('');
      setPage(1);
    }
  }, []);

  const onSearchSubmit = useCallback(() => {
    // Searching from an agent page returns home carrying the query, rather than
    // clearing the hash and losing the rest of the visitor's filters.
    setPage(1);
    setQuery(search);
    const next = homeHash({ tabKey, categoryKey, query: search, page: 1 });
    if (window.location.hash !== (next === '#' ? '' : next)) window.location.hash = next;
  }, [search, tabKey, categoryKey]);

  const onVerdict = useCallback((key, verdict) => {
    setVerdicts((prev) => ({ ...prev, [key]: verdict }));
    getVerifySummary().then(setSummary).catch(() => {});
  }, []);

  const bscTotal = registryObservation?.total ?? null;
  const isSearchActive = Boolean(query.trim());

  if (route.page === 'agent' || route.page === 'methodology' || route.page === 'compare') {
    return (
      <div className="app">
        <TopoBackground />
        <TopBar search={search} onSearchChange={onSearchChange} onSearchSubmit={onSearchSubmit} page={route.page} />
        <main>
          {route.page === 'agent' && (
            <AgentDetail
              key={`${route.chainId}:${route.tokenId}`}
              chainId={route.chainId}
              tokenId={route.tokenId}
              initialAction={route.action}
              backHref={backHref}
            />
          )}
          {route.page === 'methodology' && (
            <Methodology
              summary={summary}
              registryTotal={bscTotal}
              // Picking a category from the coverage table is a request to go
              // and see those agents, so it leaves the methodology for the
              // browse. The hashchange listener above syncs the state.
              onSelectCategory={(key) => { window.location.hash = homeHash({ categoryKey: key }); }}
            />
          )}
          {route.page === 'compare' && <Compare keys={route.keys} backHref={backHref}
            onKeysChange={changeComparisonKeys} onAgentsLoaded={nameComparisonAgents} />}
        </main>
        <SiteFooter version={summary?.formulaVersion} />
      </div>
    );
  }

  return (
    <div className={`app${isSearchActive ? ' is-searching' : ''}`}>
      <TopoBackground />
      <TopBar search={search} onSearchChange={onSearchChange} onSearchSubmit={onSearchSubmit} page={route.page} />
      <main>
        {isSearchActive && <div className="search-results-heading">
          <h1>{t('Search results')}</h1>
          <a href={homeHash({ tabKey, categoryKey })}><X size={14} aria-hidden="true" />{t('Clear search')}</a>
        </div>}
        <section className="explorer-band">
          {/* Accessible page heading; the visible strip carries the registry summary. */}
          <h1 className="sr-only">{t('ai agent explorer · bnb chain')}</h1>
          <StatStrip registryTotal={bscTotal} registryObservation={registryObservation}
            registryStatus={registryStatus} registryError={registryError} summary={summary} />
        </section>

        <TaskEntry categoryKey={categoryKey} summary={summary} />

        {/* VITE_VERIFY_API is compiled in; an unconfigured build cannot load API data. */}
        {!VERIFY_BASE && (
          <div className="config-warning">
            <strong>{t('The API is not configured on this build.')}</strong> {t('Registry browsing and agent checks require the API.')} <a href="/docs">{t('Documentation')}</a> {t('is still available. Set')} <span className="mono">VITE_VERIFY_API</span>
            {' '}{t('to the service URL and rebuild.')}
          </div>
        )}

        <div className="controls">
          <ViewTabs
            key={isSearchActive ? 'search' : 'browse'}
            tabs={TABS}
            activeKey={tabKey}
            onSelect={(key) => { setTabKey(key); setPage(1); }}
          />
        </div>

        <ComparisonSelection selected={selected}
          onRemove={(key) => setSelected((prev) => prev.filter((item) => item.key !== key))}
          onClear={() => setSelected([])} />

        {error && <div className={`registry-recovery${agents.length ? '' : ' is-empty'}`} role="alert">
          <p>{locale === 'zh-CN' && t(error) === error ? t('Registry browsing is unavailable. Please try again.') : t(error)}</p>
          {locale === 'zh-CN' && t(error) === error && <details><summary>{t('Original error details')}</summary><p>{error}</p></details>}
          <a href="/docs/limits">{t('Access and retry limits')}</a>
          <button type="button" className="registry-retry" onClick={retryBrowse} disabled={browseBusy}>
            {t(browseBusy ? 'Retrying registry…' : 'Retry registry')}
          </button>
        </div>}
        {/* Identify the boundary between saved checks and registry listings. */}
        {verifiedCount > 0 && !loading && (
          <p className="tab-note">
            {registryTail === 'ready'
              ? t('The first {count} are agents we hold a current verdict for. Below them the registry continues, newest first. Rows with no verdict yet have a check button.', { count: verifiedCount })
              : <>{t('{count} agents from FYA’s saved checks.', { count: verifiedCount })}{registryTail === 'loading' ? ` ${t('The newest registry registrations are still loading.')}` : ''}</>}
          </p>
        )}
        <div className="browse-results">
          <div className="search-results-context">
            {/* Identify search matches from capabilities listed by an endpoint. */}
            {capabilityHits > 0 && !loading && (
              <p className="tab-note">
                {t('The first {rows} served a capability matching "{query}" when we called {subject}, and each names the tool that matched. Anything below them matched a name or description instead — text the agent wrote about itself.', {
                  rows: capabilityHits === 1 ? t('row') : t('{count} rows', { count: capabilityHits }), query: query.trim(), subject: capabilityHits === 1 ? 'it' : 'them',
                })}
              </p>
            )}
            {/* Distinguish registry text matches when no saved capability matches the query. */}
            {query.trim() && capabilityHits === 0 && !loading && agents.length > 0 && (
              <p className="tab-note">
                {t('No agent we have checked served a capability matching "{query}" when we called it. These rows matched the registry’s names and descriptions only. An agent absent here may simply never have been checked — absence is not evidence.', { query: query.trim() })}
              </p>
            )}
            {category.searchTerm && !query.trim() && !loading && (
              <p className="tab-note">
                {t('The registry can only search names and descriptions, so this list starts as a text match. The sort above does not apply to it. Run a check on a row to see whether the agent actually declares a skill that does this work.')}
              </p>
            )}
          </div>
          {(!error || agents.length > 0) && <AgentTable
            agents={agents}
            verdicts={verdicts}
            onVerdict={onVerdict}
            loading={loading}
            category={isSearchActive ? 'all' : categoryKey}
            coverage={isSearchActive ? null : summary?.coverage?.[categoryKey] ?? null}
            categoryLabel={isSearchActive ? '' : category.label}
            selectedKeys={selected.map((item) => item.key)}
            onToggleSelection={toggleComparison}
          />}
        </div>

        <nav className="pager" aria-label={t('pagination')}>
          <button disabled={page <= 1 || loading || browseBusy} onClick={() => setPage((p) => p - 1)}>
            {t('previous')}
          </button>
          <span className="pager-page mono">{t('page {page}', { page })}</span>
          <button disabled={loading || browseBusy || !(pagination?.hasMore ?? false)} onClick={() => setPage((p) => p + 1)}>
            {t('next')}
          </button>
        </nav>
      </main>
      <SiteFooter version={summary?.formulaVersion} />
    </div>
  );
}
