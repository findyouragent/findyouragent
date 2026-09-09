import { useI18n, translate } from '../i18n/index.jsx';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { getAgentDetail, getVerdict, getKnownVerdicts, getAgentMeta, searchAgents } from '../api/client.js';
import { TIER_META, VERIFY_BASE } from '../config.js';
import { timeAgo } from '../utils/format.js';
import { formatU, minPriceU } from '../lib/erc8183.js';
import {
  comparisonColumn, comparisonName, comparisonCheckedAt, reconcileComparison, applySavedComparison,
  loadComparison, loadSavedComparison, unavailableComparisonParts,
} from '../lib/compare-evidence.js';
import FlowButton from '../components/ui/flow-button.jsx';
import { downloadComparison } from '../lib/comparison-export.js';
import { logicActivityTimestamp } from '../lib/logic-activity.js';

/**
 * Up to three agents side by side, from our own checks.
 *
 * Every cell is exactly as strong as the field behind it. An unknown renders
 * as "not checked" or "not known", never as a blank or a zero: in a comparison
 * table a blank cell reads as "worse", and we would be publishing a verdict we
 * never reached. Nothing here is computed fresh; it is the same verdict the
 * agent page shows, laid out so the differences are visible at once.
 */

const NOT_CHECKED = { text: 'not checked', tone: 'unknown' };

function cellAnswered(v) {
  const ev = v?.evidence;
  if (!ev) return NOT_CHECKED;
  const e = ev.endpoint; const m = ev.mcp;
  if (e?.reachable) return { text: translate("yes · a2a · {value1}ms", { value1: e.latencyMs }), tone: 'ok' };
  if (m?.reachable) return { text: translate("yes · mcp · {value1}ms", { value1: m.latencyMs }), tone: 'ok' };
  if (v.endpointProven === true) {
    const protocol = ['a2a', 'mcp'].includes(v.endpointKind) ? ` · ${v.endpointKind}` : '';
    const latency = Number.isFinite(e?.latencyMs) ? ` · ${e.latencyMs}ms` : '';
    return { text: translate("yes{value1}{value2}", { value1: protocol, value2: latency }), tone: 'ok' };
  }
  if (e?.declared === false && m?.declared === false) return { text: translate("no address published"), tone: 'bad' };
  if ((e?.declared === true && e.reachable === false) || (m?.declared === true && m.reachable === false)) return { text: translate("no reply"), tone: 'bad' };
  return NOT_CHECKED;
}

function cellServes(v) {
  const c = v?.capability;
  if (!c) return v?.endpointProven ? { text: translate("nothing declared to compare"), tone: 'unknown' } : NOT_CHECKED;
  if (c.missing?.length) return { text: translate("{value1} of {value2} declared", { value1: c.matched ?? 0, value2: c.declared }), tone: 'gap' };
  return { text: translate("all {value1} declared", { value1: c.declared }), tone: 'ok' };
}

function cellOwnWallet(v) {
  const w = v?.evidence?.wallet;
  if (!w?.checked) return NOT_CHECKED;
  return w.isOwnWallet ? { text: translate("proved via ERC-6551"), tone: 'ok' } : { text: translate("registrant's address"), tone: 'unknown' };
}

function cellToken(v) {
  const b = v?.bap578;
  if (!b) return { text: translate("none claimed"), tone: 'unknown' };
  if (b.unsupported) return { text: translate("claimed · not the standard"), tone: 'bad' };
  if (b.ownershipVerified === true) {
    const t = b.metrics?.reported ? translate(" · {value1} trades recorded by logic contract", { value1: b.metrics.totalTrades }) : '';
    return { text: translate("attributed{value1}", { value1: t }), tone: 'ok' };
  }
  if (b.ownershipVerified === false) return { text: translate("claimed · not attributed"), tone: 'bad' };
  return { text: translate("claimed · not checked"), tone: 'unknown' };
}

function cellLastActed(v) {
  const m = v?.bap578?.metrics;
  if (!v?.bap578) return { text: '—', tone: 'unknown' };
  const timestamp = logicActivityTimestamp(m?.reported ? m.lastActive : undefined);
  if (timestamp.status === 'none') return { text: translate("No timestamp recorded"), tone: 'unknown' };
  if (timestamp.status !== 'recorded') return { text: translate("Timestamp unavailable"), tone: 'unknown' };
  const relative = timeAgo(timestamp.iso);
  return { text: relative === '—' ? timestamp.iso : relative, title: timestamp.iso, tone: 'ok' };
}

function cellFeedbacks(v) {
  const n = v?.evidence?.registry?.feedbackCount;
  if (n == null) return { text: translate("not known"), tone: 'unknown' };
  return { text: String(n), tone: n > 0 ? 'ok' : 'unknown' };
}

function cellHire(v, service) {
  if (v?.hireable === true || service) {
    const cheapest = minPriceU(service?.offerings);
    const from = cheapest ? translate(" · from {value1}", { value1: formatU(cheapest) }) : '';
    return { text: translate("escrow menu published{value1}", { value1: from }), tone: 'ok' };
  }
  if (v?.hireable === false) return { text: translate("no hire menu"), tone: 'unknown' };
  return NOT_CHECKED;
}

function Cell({ value }) {
  const { t, locale } = useI18n();
  const v = value ?? NOT_CHECKED;
  return <span className={`cmp-cell cmp-${v.tone}`} title={v.title}>{t(v.text)}</span>;
}

// Names are the main entry point; IDs remain available for a known registry
// listing. Adding a result changes only the comparison, never calls its tools.
function AddAgent({ keys, onChange, backHref }) {
  const { t, locale } = useI18n();
  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  if (keys.length >= 3) return null;
  const id = value.trim();
  const valid = /^\d+$/.test(id) && !keys.includes(`56:${id}`);
  return (
    <div className="compare-picker">
      <form className="compare-search" onSubmit={async (event) => {
        event.preventDefault();
        if (!query.trim() || loading) return;
        const id = ++request.current;
        setLoading(true);
        setError(null);
        setResults(null);
        let timeout;
        try {
          const result = await Promise.race([
            searchAgents({ query: query.trim(), page: 1 }),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Registry search timed out')), 12_000); }),
          ]);
          if (id === request.current) setResults(result.agents ?? []);
        } catch {
          if (id === request.current) setError('Search could not load. Try again or select agents from the list.');
        } finally {
          clearTimeout(timeout);
          if (id === request.current) setLoading(false);
        }
      }}>
        <label htmlFor="compare-agent-name">{t("Add an agent by name")}</label>
        <div className="compare-search-controls">
          <input id="compare-agent-name" value={query} placeholder={t("Search agent names")}
            onChange={(event) => { request.current += 1; setQuery(event.target.value); setLoading(false); setResults(null); setError(null); }} />
          <button type="submit" className="row-act row-act-btn" disabled={!query.trim() || loading}>{loading ? translate("Searching…") : translate("Search")}</button>
          <a href={backHref}>{t("Browse agents")}</a>
        </div>
      </form>
      {error && <p className="compare-search-message" role="alert">{t(error)}</p>}
      {results && <div className="compare-search-results">
        <p className="compare-search-message" role="status">{results.length
          ? translate("Registry name and description matches. Select a result to compare its checks.")
          : translate("No agents found. Try another name or browse the agent list.")}</p>
        {results.length > 0 && <ul>{results.slice(0, 8).map((agent) => {
          const key = `${agent.chain_id}:${agent.token_id}`;
          const present = keys.includes(key);
          return <li key={key}>
            <span><strong>{agent.name || translate("agent #{value1}", { value1: agent.token_id })}</strong><small className="mono">#{agent.token_id}</small></span>
            <button type="button" className="row-act row-act-btn" disabled={present}
              aria-label={present ? translate("{value1} already selected", { value1: agent.name || key }) : translate("Add {value1} to comparison", { value1: agent.name || key })}
              onClick={() => { onChange([...keys, key]); setResults(null); setQuery(''); }}>
              {present ? translate("Selected") : translate("Add")}
            </button>
          </li>;
        })}</ul>}
      </div>}
      <details className="compare-advanced">
        <summary>{t("Add by registry token ID")}</summary>
        <form
          className="compare-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onChange([...keys, `56:${id}`]);
            setValue('');
          }}
        >
          <input
            className="mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("8004 token id, e.g. 153649")}
            aria-label={t("8004 token id to add")}
            inputMode="numeric"
          />
          <button type="submit" className="row-act row-act-btn" disabled={!valid}>{t("add")}</button>
        </form>
      </details>
    </div>
  );
}

export default function Compare({ keys, backHref = '#', onKeysChange, onAgentsLoaded }) {
  const { t, locale } = useI18n();
  const [cols, setCols] = useState(() => keys.map(comparisonColumn));
  const activeKeys = useRef(new Set(keys));
  activeKeys.current = new Set(keys);
  const requests = useRef(new Map());
  const retryLocks = useRef(new Map());
  const requestId = useRef(0);
  const mounted = useRef(true);
  const api = { getAgentDetail, getVerdict, getKnownVerdicts, getAgentMeta };

  const patchColumn = (key, update) => {
    if (!mounted.current || !activeKeys.current.has(key)) return;
    setCols((previous) => previous.map((column) => column.key === key ? update(column) : column));
  };

  function loadColumn(key, parts) {
    const id = ++requestId.current;
    requests.current.set(key, id);
    return loadComparison({ key, api, parts, onPatch: (update) => {
      if (requests.current.get(key) === id) patchColumn(key, update);
    } });
  }

  function retryColumn(column) {
    const parts = unavailableComparisonParts(column);
    if (!parts.length || retryLocks.current.has(column.key) || column.agentLoading || column.verdictLoading || column.metaLoading) return;
    const id = ++requestId.current;
    requests.current.set(column.key, id);
    retryLocks.current.set(column.key, id);
    patchColumn(column.key, (current) => ({ ...current, retrying: true }));
    Promise.all([
      loadSavedComparison([column.key], api, (key, saved) => {
        if (requests.current.get(key) === id) patchColumn(key, (current) => applySavedComparison(current, saved));
      }),
      loadComparison({ key: column.key, api, parts, onPatch: (update) => {
        if (requests.current.get(column.key) === id) patchColumn(column.key, update);
      } }),
    ]).finally(() => {
      if (retryLocks.current.get(column.key) === id) retryLocks.current.delete(column.key);
      if (requests.current.get(column.key) === id) patchColumn(column.key, (current) => ({ ...current, retrying: false }));
    });
  }

  function setKeys(next) {
    onKeysChange?.(next);
    window.location.hash = next.length ? `#/compare/${next.join(',')}` : backHref;
  }

  useEffect(() => {
    const named = cols.filter((col) => col.agent?.name || col.verdict?.name).map((col) => ({ key: col.key, name: comparisonName(col) }));
    if (named.length) onAgentsLoaded?.(named);
  }, [cols, onAgentsLoaded]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requests.current.clear(); retryLocks.current.clear(); };
  }, []);

  useEffect(() => {
    setCols((previous) => reconcileComparison(keys, previous));
    for (const key of requests.current.keys()) if (!activeKeys.current.has(key)) {
      requests.current.delete(key);
      retryLocks.current.delete(key);
    }
    const added = keys.filter((key) => !requests.current.has(key));
    const parts = VERIFY_BASE ? ['agent', 'verdict', 'meta'] : ['agent'];
    added.forEach((key) => loadColumn(key, parts));
    const savedRequests = new Map(added.map((key) => [key, requests.current.get(key)]));
    if (VERIFY_BASE && added.length) loadSavedComparison(added, api, (key, saved) => {
      if (requests.current.get(key) === savedRequests.get(key)) patchColumn(key, (current) => applySavedComparison(current, saved));
    });
  // Keyed on the joined list so a new array with the same agents does not
  // re-run three verifications.
  }, [keys.join(',')]);

  const rows = [
    [translate("verdict"), (c) => {
      if (c.verdictLoading && !c.verdict) return { text: translate("checking…"), tone: 'unknown' };
      if (!c.verdict) return { text: c.verdictError?.throttled ? translate("throttled · retry later") : translate("could not run"), tone: 'unknown' };
      const t = TIER_META[c.verdict.tier];
      return { text: t?.label ?? c.verdict.tier, tone: c.verdict.tier === 'verified_live' ? 'ok' : 'unknown' };
    }],
    [translate("evidence source"), (c) => {
      if (!c.verdict) return { text: c.verdictLoading ? translate("reading checks…") : translate("no check available"), tone: 'unknown' };
      if (c.verdictError) return { text: translate("saved evidence · fresh check unavailable"), tone: 'unknown' };
      if (c.verdictLoading) return { text: translate("saved evidence · checking for an update…"), tone: 'unknown' };
      return { text: c.verdictSource === 'saved' ? translate("saved evidence") : translate("latest returned check"), tone: 'unknown' };
    }],
    [translate("answered when called"), (c) => cellAnswered(c.verdict)],
    [translate("declared tools listed"), (c) => cellServes(c.verdict)],
    [translate("wallet provably its own"), (c) => cellOwnWallet(c.verdict)],
    [translate("on-chain agent token"), (c) => cellToken(c.verdict)],
    [translate("Last activity recorded by logic contract"), (c) => cellLastActed(c.verdict)],
    [translate("registry feedbacks"), (c) => cellFeedbacks(c.verdict)],
    [translate("accepts x402"), (c) => (c.agent ? { text: c.agent.x402_supported ? translate("yes") : translate("no"), tone: c.agent.x402_supported ? 'ok' : 'unknown' } : NOT_CHECKED)],
    [translate("hire"), (c) => cellHire(c.verdict, c.service)],
    [translate("checked"), (c) => {
      const checkedAt = comparisonCheckedAt(c.verdict);
      return checkedAt ? { text: `${new Date(checkedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`, title: checkedAt, tone: 'unknown' } : NOT_CHECKED;
    }],
  ];

  function downloadTable() {
    downloadComparison({
      locale,
      columns: cols.map((column) => ({
        key: column.key,
        name: comparisonName(column),
        checkedAt: comparisonCheckedAt(column.verdict),
        evidenceSource: column.verdictSource,
        loadingParts: ['agent', 'verdict', 'meta'].filter((part) => column[`${part}Loading`]),
        unavailableParts: unavailableComparisonParts(column),
      })),
      rows: rows.map(([label, valueFor]) => ({
        label: t(label),
        values: cols.map((column) => {
          const value = valueFor(column) ?? NOT_CHECKED;
          return { text: t(value.text), ...(value.title ? { title: value.title } : {}) };
        }),
      })),
    });
  }

  return (
    <div className="compare">
      <a className="back-link" href={backHref}><ArrowLeft size={12} strokeWidth={2} aria-hidden="true" /> {t("all agents")}</a>
      <h1 className="micro-label">{t("compare ·")} {cols.length} {t("agents")}</h1>
      <p className="compare-sub">
        {t("Side by side, from the same checks each agent page shows. A cell that reads \"not checked\" is a check we could not run, not a mark against the agent. Tool availability and a published hire menu do not establish a completed task.")}
      </p>
      <div className="compare-manage">
        <a href={backHref}>{t("Choose agents from the list")}</a>
        <button type="button" onClick={() => setKeys([])}>{t("Clear comparison")}</button>
      </div>
      <AddAgent keys={keys} onChange={setKeys} backHref={backHref} />
      <div className="compare-table-actions">
        <FlowButton variant="neutral" type="button" onClick={downloadTable} disabled={cols.length === 0}>{t('Download comparison')}</FlowButton>
      </div>
      <div className="compare-grid" style={{ gridTemplateColumns: `150px repeat(${cols.length}, minmax(160px, 1fr))` }} role="table" aria-label={t("Agent verification evidence comparison")} tabIndex={0}>
        <div className="compare-row compare-head" role="row">
          <span className="micro-label" role="columnheader">{t("agent")}</span>
          {cols.map((c) => (
            <div key={c.key} className="compare-agent" role="columnheader">
              <a href={`#/agent/${c.key.replace(':', '/')}`} className="compare-name">
                {comparisonName(c)}
              </a>
              <span className="mono compare-id">
                #{c.key.split(':')[1]}
                <button
                  type="button"
                  className="compare-remove"
                  onClick={() => setKeys(keys.filter((k) => k !== c.key))}
                  aria-label={translate("remove {value1} from comparison", { value1: comparisonName(c) })}
                  title={t("remove")}
                >
                  <X size={12} strokeWidth={2} aria-hidden="true" />
                </button>
              </span>
              {!c.agent?.name && c.verdict?.name && <span className="compare-search-message">{t("Name from saved check")}</span>}
              {['agentError', 'verdictError', 'metaError'].map((field) => c[field] && (
                <span key={field} className="compare-search-message" role="status">{t(c[field].message)}</span>
              ))}
            </div>
          ))}
        </div>
        {rows.map(([label, fn]) => (
          <div key={label} className="compare-row" role="row">
            <span className="micro-label" role="rowheader">{t(label)}</span>
            {cols.map((c) => (
              <div key={c.key} role="cell"><Cell value={fn(c)} /></div>
            ))}
          </div>
        ))}
        <div className="compare-row compare-actions" role="row">
          <span className="micro-label" role="rowheader"></span>
          {cols.map((c) => {
            const [chainId, tokenId] = c.key.split(':');
            const hireable = c.verdict?.hireable === true || Boolean(c.service);
            return (
              <div key={c.key} role="cell" className="compare-btns">
                {c.verdict?.endpointProven && <a className="row-act row-act-try" href={`#/agent/${chainId}/${tokenId}/try`}>{t("try")}</a>}
                {hireable
                  ? <FlowButton variant="gold" className="flow-sm" href={`#/agent/${chainId}/${tokenId}/hire`}>{t("hire")}</FlowButton>
                  : <a className="row-act" href={`#/agent/${chainId}/${tokenId}`}>{t("open")}</a>}
                {(unavailableComparisonParts(c).length > 0 || c.retrying) && (
                  <button type="button" className="row-act row-act-btn"
                    disabled={c.retrying || c.agentLoading || c.verdictLoading || c.metaLoading}
                    aria-label={translate("Retry unavailable data for {value1}", { value1: comparisonName(c) })}
                    onClick={() => retryColumn(c)}>
                    {c.retrying ? translate("Retrying…") : translate("Retry unavailable data")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
