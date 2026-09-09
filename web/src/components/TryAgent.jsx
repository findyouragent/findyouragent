import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { CornerDownRight } from 'lucide-react';
import { tryAgentCall, getTryInterface, callAgentTool, runAgentTask } from '../api/client.js';
import { VERIFY_BASE } from '../config.js';
import { payChallenge, canPay, formatAmount, paymentProblem } from '../lib/x402.js';
import FlowButton from './ui/flow-button.jsx';
import Select from './ui/select.jsx';
import { makeRunRecord, runCacheKey, runState, runLabel, downloadRun } from '../lib/try-record.js';
import { paymentChallengeRevision, recallTryHistory, rememberTryHistory, subscribePaymentChallenges } from '../lib/try-session.js';
import { newPaymentChallengeId, paymentChallengeState, paymentHistoryUpdater, paymentResponseOutcome, runPaymentAttempt } from '../lib/payment-lifecycle.js';
import '../styles/try-results.css';
import PositionTaskResult from './PositionTaskResult.jsx';
import RangeAssessmentResult from './RangeAssessmentResult.jsx';
import { useI18n, uiMessage } from '../i18n/index.jsx';

/*
 * Structured replies rendered for people, not terminals. Many MCP tools answer
 * with a JSON string; printing it raw is machine output pasted at a human. This
 * lays the SAME data out — an array of flat records becomes a small table, a
 * flat object becomes key→value rows — and falls back to pretty-printed JSON
 * for anything deeper. Layout only, never interpretation: every value shown is
 * verbatim from the agent.
 */
const REPLY_MAX_ROWS = 12;

function flatRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
}

function unwrapEnvelope(parsed) {
  // Common tool envelope: {project, operation, data} — the payload is `data`.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.data !== undefined
    && Object.keys(parsed).every((k) => ['project', 'operation', 'data', 'success', 'status'].includes(k))) {
    return parsed.data;
  }
  return parsed;
}

// A key like "what_this_is" or "payTo" is the agent's field name; shown as
// words rather than as source. Values are never touched.
function fieldLabel(key) {
  return String(key).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

const REPLY_MAX_DEPTH = 5;

/*
 * One value, rendered for a person: scalars as text, a list of flat records as
 * a table, a flat object as label/value rows, and anything nested as labelled
 * sections indented under their key. Recursion is depth- and size-capped, and
 * past the cap it falls back to indented JSON rather than truncating silently.
 * Layout only — every value is verbatim from the agent.
 */
function ReplyValue({ value, depth = 0 }) {
  const { t } = useI18n();
  if (value === null || value === undefined) return <span className="reply-null">{t('not set')}</span>;
  if (typeof value !== 'object') {
    const text = String(value);
    return <span className={text.length > 120 ? 'reply-long' : undefined}>{text}</span>;
  }
  if (depth >= REPLY_MAX_DEPTH) {
    const pretty = JSON.stringify(value, null, 2);
    return <pre className="reply-json">{pretty.length > 1500 ? `${pretty.slice(0, 1500)}…` : pretty}</pre>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="reply-null">{t('none')}</span>;
    // Scalars: one line.
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return <span className="mono">{value.slice(0, 40).map(String).join(' · ')}{value.length > 40 ? ' …' : ''}</span>;
    }
    // Uniform flat records: a table.
    if (value.every(flatRecord)) {
      const keys = [...new Set(value.flatMap((r) => Object.keys(r)))].slice(0, 6);
      const rows = value.slice(0, REPLY_MAX_ROWS);
      return (
        <div className="reply-structured">
          <table className="reply-table mono">
            <thead>
              <tr>{keys.map((k) => <th key={k}>{fieldLabel(k)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{keys.map((k) => <td key={k}>{r[k] === undefined ? '' : String(r[k])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {value.length > rows.length && <div className="reply-more mono">{t('+{count} more', { count: value.length - rows.length })}</div>}
        </div>
      );
    }
    // Mixed or nested: each entry as its own block.
    const items = value.slice(0, REPLY_MAX_ROWS);
    return (
      <div className="reply-list">
        {items.map((v, i) => (
          <div key={i} className="reply-item"><ReplyValue value={v} depth={depth + 1} /></div>
        ))}
        {value.length > items.length && <div className="reply-more mono">{t('+{count} more', { count: value.length - items.length })}</div>}
      </div>
    );
  }

  const entries = Object.entries(value).slice(0, 24);
  return (
    <div className={depth > 0 ? 'reply-nested' : undefined}>
      {entries.map(([k, v]) => {
        const scalar = v === null || typeof v !== 'object';
        return (
          <div key={k} className={scalar ? 'reply-kv' : 'reply-block'}>
            <span className="micro-label">{fieldLabel(k)}</span>
            <ReplyValue value={v} depth={depth + 1} />
          </div>
        );
      })}
      {Object.keys(value).length > entries.length && (
        <div className="reply-more mono">{t('+{count} more fields', { count: Object.keys(value).length - entries.length })}</div>
      )}
    </div>
  );
}

export function ToolReply({ text }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Prose stays prose.
    return <div className="exchange-a">{text}</div>;
  }
  return (
    <div className="exchange-a reply-structured">
      <ReplyValue value={unwrapEnvelope(parsed)} />
    </div>
  );
}

// An MCP tool result: content parts carrying text, or structured output.
function extractToolText(body) {
  const content = body?.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n');
    if (text) return text;
  }
  if (body?.result?.structuredContent) return JSON.stringify(body.result.structuredContent, null, 2);
  if (body?.error?.message) return body.error.message;
  const raw = JSON.stringify(body, null, 2) ?? 'No response body was captured.';
  return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
}

// Best-effort text extraction from an A2A message/send result: a Message with
// parts, a Task with artifacts, or a status message. Falls back to raw JSON.
function extractText(body) {
  const result = body?.result;
  const fromParts = (parts) =>
    Array.isArray(parts)
      ? parts.filter((p) => (p?.kind === 'text' || p?.type === 'text') && p.text).map((p) => p.text).join('\n')
      : '';
  if (result) {
    const direct = fromParts(result.parts);
    if (direct) return direct;
    if (Array.isArray(result.artifacts)) {
      const art = result.artifacts.map((a) => fromParts(a?.parts)).filter(Boolean).join('\n');
      if (art) return art;
    }
    const status = fromParts(result.status?.message?.parts);
    if (status) return status;
  }
  if (body?.error?.message) return body.error.message;
  // A reply the server could not parse arrives as {raw}: show what came back,
  // not a JSON wrapper around it.
  if (typeof body?.raw === 'string') return body.raw;
  const raw = JSON.stringify(body, null, 2) ?? 'No response body was captured.';
  return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
}

// One auto-run per agent per page session, held as a PROMISE of the finished
// exchange entry: a remount (StrictMode double-mount included) reuses the
// in-flight or settled result instead of spending another call against a third
// party's server — or worse, dropping the reply and showing nothing.
const autoRuns = new Map();

function errorText(result) {
  const value = result.body?.error?.message ?? result.body?.error ?? result.detail ?? result.error;
  return typeof value === 'string' ? value : value ? JSON.stringify(value) : extractToolText(result.body);
}

async function runRead(chainId, tokenId, request, title, questionLabel = null) {
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = request.presetId
      ? await runAgentTask(chainId, tokenId, request.presetId)
      : await callAgentTool(chainId, tokenId, request.tool, request.arguments);
  } catch (err) {
    result = { error: String(err.message || err) };
  }
  const record = makeRunRecord(result, { chainId, tokenId, request, startedAt, finishedAt: new Date().toISOString() });
  const state = runState(record);
  const failed = state === 'error' || Boolean(result.error);
  const text = failed ? errorText(result) : extractToolText(result.body);
  return { question: title, ...(questionLabel ? { questionLabel } : {}), kind: failed ? 'error' : 'reply', text, ...(result.error ? { uiText: uiMessage(text) } : {}), record, request };
}

function VaultResult({ record }) {
  const { t } = useI18n();
  const body = record.response.body;
  let data = body?.result?.structuredContent;
  if (!data) {
    try { data = JSON.parse(extractToolText(body)); } catch { return null; }
  }
  const vaults = data?.data?.flatMap?.((group) => Array.isArray(group?.vaults) ? group.vaults : []) ?? [];
  if (!vaults.length) return null;
  return <div className="task-vault-result">
    <p>{t('{count} BSC vaults returned by the provider.', { count: vaults.length })}</p>
    <p className="try-sub">{t('APY and TVL below are the provider’s raw values. Their units have not been verified for this adapter. This list is not a recommendation or a complete inventory.')}</p>
    <div className="task-vault-scroll" role="region" aria-label={t('Returned BSC vaults')} tabIndex={0}>
      <table className="task-vault-table">
        <thead><tr><th>{t('Vault / asset')}</th><th>{t('APY · raw')}</th><th>{t('TVL · raw')}</th></tr></thead>
        <tbody>{vaults.map((vault, index) => <tr key={`${vault.id}-${index}`}>
          <td><strong>{vault.name}</strong><span>{typeof vault.platform === 'string' ? `${vault.platform} · ` : ''}{vault.token}</span><span className="mono">{vault.id}</span></td>
          <td className="mono" data-label="APY · raw">{String(vault.apy)}</td><td className="mono" data-label="TVL · raw">{String(vault.tvl)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function paymentOptions(body) {
  const accepts = body?.accepts ?? body?.paymentRequirements ?? null;
  return Array.isArray(accepts) ? accepts : accepts ? [accepts] : [];
}

function resultToEntry(result) {
  if (result.status === 402 || result.httpStatus === 402) {
    return {
      kind: 'payment',
      options: paymentOptions(result.body),
      version: result.body?.x402Version ?? 1,
      reason: result.body?.error ?? null,
    };
  }
  if (result.error) {
    const text = result.detail || result.error;
    return { kind: 'error', text, uiText: uiMessage(text) };
  }
  if (result.body?.error && !result.body?.result) {
    return { kind: 'error', text: result.body.error.message ?? String(result.body.error) };
  }
  return { kind: 'reply', text: extractText(result.body), receipt: result.paymentReceipt ?? null };
}

function paymentStateFor(exchange) {
  return exchange.paymentChallengeId
    ? paymentChallengeState(exchange.paymentChallengeId)
    : { state: 'available', outcome: null };
}

function paymentStatusText(exchange) {
  const payment = paymentStateFor(exchange);
  if (payment.state === 'prompting') return 'Wallet confirmation is open. Cancel it to make this challenge available again.';
  if (payment.state !== 'consumed') return null;
  if (payment.outcome === 'signed-not-submitted') {
    return 'Authorization created, but this page did not submit it. This challenge is retired; no settlement is claimed.';
  }
  if (payment.outcome === 'submitted-unknown') {
    return 'Authorization created and submitted. Payment outcome is unknown. This challenge is retired and will not be submitted again.';
  }
  return 'A response was received after the authorization was submitted. This challenge is retired. The response alone does not prove settlement.';
}

/*
  A tool's arguments, drawn from the schema the agent already publishes.

  The schema carries names, types, enums and descriptions — so the fields it
  describes are drawn as fields, and the JSON is assembled from them.
*/
function fieldKind(schema) {
  if (Array.isArray(schema?.enum) && schema.enum.length) return 'enum';
  const type = Array.isArray(schema?.type) ? schema.type.find((t) => t !== 'null') : schema?.type;
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'object' || type === 'array') return 'json';
  return 'string';
}

// null when the schema describes no properties: we know nothing about the
// shape, so we say so with a raw box rather than inventing fields.
function argFields(inputSchema) {
  const props = inputSchema?.properties;
  if (!props || typeof props !== 'object') return null;
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return Object.entries(props)
    .filter(([name]) => typeof name === 'string' && name)
    .map(([name, schema]) => ({
      name,
      required: required.has(name),
      kind: fieldKind(schema),
      choices: Array.isArray(schema?.enum) ? schema.enum.map(String) : null,
      hint: typeof schema?.description === 'string' ? schema.description.slice(0, 200) : null,
    }))
    // What the call cannot go without comes first.
    .sort((a, b) => Number(b.required) - Number(a.required));
}

function isBlank(field, value) {
  if (field.kind === 'boolean') return value === undefined || value === '';
  return value === undefined || value === null || String(value).trim() === '';
}

// Typed values back into the JSON the tool expects. Errors name the field that
// is wrong, never "Arguments must be valid JSON" about a document the visitor
// never wrote.
function buildArgs(fields, values) {
  const out = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (f.kind === 'boolean') {
      if (raw === 'true') out[f.name] = true;
      else if (raw === 'false') out[f.name] = false;
      continue;
    }
    if (isBlank(f, raw)) continue;
    if (f.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw uiMessage('{field} must be a number.', { field: f.name });
      out[f.name] = n;
      continue;
    }
    if (f.kind === 'json') {
      try { out[f.name] = JSON.parse(String(raw)); }
      catch { throw uiMessage('{field} must be valid JSON.', { field: f.name }); }
      continue;
    }
    out[f.name] = String(raw);
  }
  return out;
}

export default function TryAgent({ chainId, tokenId, reachable }) {
  const { t, locale } = useI18n();
  useSyncExternalStore(subscribePaymentChallenges, paymentChallengeRevision, paymentChallengeRevision);
  const agentKey = `${chainId}:${tokenId}`;
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [paying, setPaying] = useState(false);
  const [exchanges, setExchanges] = useState(() => recallTryHistory(`${chainId}:${tokenId}`));
  const [loadedInterface, setLoadedInterface] = useState(null);
  // A render with new agent props must never expose the previous agent's
  // interface, even before the reset effect has run.
  const iface = loadedInterface?.agentKey === agentKey ? loadedInterface.value : null;
  const [interfaceState, setInterfaceState] = useState('loading');
  const [interfaceError, setInterfaceError] = useState(null);
  const [interfaceAttempt, setInterfaceAttempt] = useState(0);
  const [tool, setTool] = useState('');
  const [argText, setArgText] = useState('');
  const [argValues, setArgValues] = useState({});
  const [rawArgs, setRawArgs] = useState(false);
  const [argError, setArgError] = useState(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const activeAgent = useRef('');
  const allowAutoSample = useRef(true);
  activeAgent.current = agentKey;

  useEffect(() => {
    setLoadedInterface(null);
    setExchanges(recallTryHistory(`${chainId}:${tokenId}`));
    setTool('');
    setSending(false);
    setPaying(false);
    busy.current = false;
    allowAutoSample.current = true;
    return () => { generation.current += 1; };
  }, [chainId, tokenId, reachable]);

  useEffect(() => {
    let live = true;
    const requestedAgentKey = `${chainId}:${tokenId}`;
    if (!VERIFY_BASE || !reachable) return undefined;
    setInterfaceState('loading');
    setInterfaceError(null);
    getTryInterface(chainId, tokenId)
      .then((result) => {
        if (!live || activeAgent.current !== requestedAgentKey) return;
        if (!result || result.error) {
          setLoadedInterface(null);
          setInterfaceError(result?.error || 'The service returned an unreadable list of available tools. Retry available tools.');
          setInterfaceState('error');
          return;
        }
        setLoadedInterface({ agentKey: requestedAgentKey, value: result });
        setInterfaceState('ready');
      })
      .catch(() => {
        if (!live || activeAgent.current !== requestedAgentKey) return;
        setLoadedInterface(null);
        setInterfaceError('Could not reach the service to read available tools. Check your connection and retry.');
        setInterfaceState('error');
      });
    return () => { live = false; };
  }, [chainId, tokenId, reachable, interfaceAttempt]);

  function appendExchange(entry) {
    setExchanges((prev) => {
      const next = entry.record?.runId && prev.some((old) => old.record?.runId === entry.record.runId)
        ? prev : [...prev, entry];
      rememberTryHistory(`${chainId}:${tokenId}`, next);
      return next;
    });
  }

  function retryInterface() {
    if (interfaceState === 'loading') return;
    // Recover only the tool listing. A successful retry must not silently
    // resubmit a task or run a fresh sample against the provider.
    allowAutoSample.current = false;
    setInterfaceState('loading');
    setInterfaceAttempt((attempt) => attempt + 1);
  }

  // Zero-input first question. The visitor clicked "try" — that is the
  // consent — and the example ran successfully on the last real check, so the
  // first thing they see is the agent genuinely answering, no JSON, no wallet.
  useEffect(() => {
    const ex = iface?.example;
    if (!allowAutoSample.current || !ex || iface.kind !== 'mcp' || iface.taskPresets?.length) return undefined;
    const request = { protocol: 'mcp', tool: ex.tool, arguments: ex.args, exampleVersion: ex.observation?.version, endpoint: iface.endpoint };
    const key = runCacheKey(chainId, tokenId, request);
    let live = true;
    let pending = autoRuns.get(key);
    if (!pending) {
      pending = runRead(chainId, tokenId, request, `${ex.tool}() · sample input`, uiMessage('{tool}() · sample input', { tool: ex.tool }));
      autoRuns.set(key, pending);
    }
    busy.current = true;
    setSending(true);
    pending.then((entry) => {
      if (!live || activeAgent.current !== agentKey) return;
      // Never duplicated across remounts: the sample speaks once.
      appendExchange(entry);
      busy.current = false;
      setSending(false);
    });
    return () => { live = false; };
  }, [iface, chainId, tokenId]);

  if (!VERIFY_BASE || !reachable) return null;

  const taskPresets = iface?.taskPresets ?? [];
  const taskPreset = taskPresets[0] ?? null;
  const selected = iface?.tools?.find((t) => t.name === tool) ?? null;
  const fields = selected ? argFields(selected.inputSchema) : null;
  const asFields = Boolean(fields) && !rawArgs;
  // Named, so the run button can say what it is still waiting for instead of
  // spending a shared rate-limit budget on a call that cannot succeed.
  const missing = asFields
    ? fields.filter((f) => f.required && isBlank(f, argValues[f.name])).map((f) => f.name)
    : [];

  function resetArgs() {
    setArgValues({});
    setArgText('');
    setRawArgs(false);
    setArgError(null);
  }

  async function executeRead(request, title) {
    if (!iface || activeAgent.current !== agentKey || busy.current) return;
    busy.current = true;
    setSending(true);
    const key = `${chainId}:${tokenId}`;
    const currentGeneration = generation.current;
    const entry = await runRead(chainId, tokenId, request, title);
    if (activeAgent.current !== key || generation.current !== currentGeneration) return;
    appendExchange(entry);
    busy.current = false;
    setSending(false);
  }

  async function runTool(event) {
    event.preventDefault();
    if (iface?.kind !== 'mcp' || !tool || busy.current) return;
    let args;
    try {
      args = asFields ? buildArgs(fields, argValues) : (argText.trim() ? JSON.parse(argText) : {});
    } catch (err) {
      // Beside the field, not in the transcript: nothing was sent, so nothing
      // belongs in the record of what the agent answered.
      setArgError(err instanceof SyntaxError ? 'Arguments must be valid JSON.' : err?.type === 'fya-ui-message' ? err : String(err.message || err));
      return;
    }
    setArgError(null);
    await executeRead({ protocol: 'mcp', tool, arguments: args }, `${tool}()`);
  }

  async function send(event) {
    event.preventDefault();
    const text = message.trim();
    if (iface?.kind !== 'a2a' || activeAgent.current !== agentKey || !text || busy.current) return;
    busy.current = true;
    setSending(true);
    const currentGeneration = generation.current;
    const startedAt = new Date().toISOString();
    try {
      const result = await tryAgentCall(chainId, tokenId, text);
      if (activeAgent.current !== agentKey || generation.current !== currentGeneration) return;
      const record = makeRunRecord(result, { chainId, tokenId, request: { protocol: 'a2a', message: text }, startedAt, finishedAt: new Date().toISOString() });
      const entry = resultToEntry(result);
      if (runState(record) === 'error') entry.kind = 'error';
      if (entry.kind === 'payment') entry.paymentChallengeId = newPaymentChallengeId();
      appendExchange({ question: text, ...entry, record });
      setMessage('');
    } catch (err) {
      if (activeAgent.current !== agentKey || generation.current !== currentGeneration) return;
      appendExchange({ question: text, kind: 'error', text: String(err.message || err) });
    } finally {
      if (activeAgent.current === agentKey && generation.current === currentGeneration) { busy.current = false; setSending(false); }
    }
  }

  async function payAndRetry(exchange) {
    if (iface?.kind !== 'a2a' || activeAgent.current !== agentKey || busy.current
      || paymentStateFor(exchange).state !== 'available') return;
    busy.current = true;
    setSending(true);
    const accept = exchange.options?.[0];
    setPaying(true);
    const currentGeneration = generation.current;
    const challengeId = exchange.paymentChallengeId;
    const isCurrent = () => activeAgent.current === agentKey && generation.current === currentGeneration;
    const updatePaymentState = (paymentChallenge) => {
      if (!isCurrent()) return;
      setExchanges(paymentHistoryUpdater(agentKey, challengeId, paymentChallenge, isCurrent));
    };
    const startedAt = new Date().toISOString();
    const attempt = await runPaymentAttempt({
      agentKey,
      challengeId,
      sign: (markSigned) => payChallenge(accept, exchange.version, { onSigned: markSigned }),
      submit: (payment) => tryAgentCall(chainId, tokenId, exchange.question, payment),
      isCurrent,
      responseOutcome: paymentResponseOutcome,
      onStateChange: updatePaymentState,
    });
    try {
      if (!isCurrent() || attempt.kind === 'blocked' || attempt.kind === 'retired') return;
      if (attempt.kind === 'sign-error') {
        const err = attempt.error;
        const text = String(err?.message || err);
        const uiText = err?.code === 4001
          ? uiMessage('Payment signature rejected in wallet. You can try this challenge again.')
          : uiMessage('Payment could not be signed: {message}', { message: text });
        appendExchange({ question: exchange.question, questionLabel: uiMessage('{question} · payment not signed', { question: exchange.question }), kind: 'error', text, uiText });
        return;
      }
      if (attempt.kind === 'post-sign-error' || attempt.kind === 'submit-error') {
        appendExchange({
          question: exchange.question,
          questionLabel: uiMessage('{question} · authorization created', { question: exchange.question }),
          kind: 'error',
          text: String(attempt.error?.message || attempt.error),
          uiText: attempt.kind === 'submit-error'
            ? uiMessage('The signed request may have reached the relay or provider, but no complete response was received. Payment outcome is unknown; this challenge cannot be signed again.')
            : uiMessage('The wallet created an authorization, but the request could not be prepared or submitted. This challenge is retired. {message}', { message: String(attempt.error?.message || attempt.error) }),
        });
        return;
      }
      const result = attempt.result;
      const record = makeRunRecord(result, { chainId, tokenId, request: { protocol: 'a2a', message: exchange.question, paymentSubmitted: true }, startedAt, finishedAt: new Date().toISOString() });
      const entry = resultToEntry(result);
      if (runState(record) === 'error') entry.kind = 'error';
      if (entry.kind === 'payment') {
        entry.paymentChallengeId = challengeId;
        entry.paymentChallenge = paymentChallengeState(challengeId);
      }
      appendExchange({ question: exchange.question, questionLabel: uiMessage('{question} · authorization submitted', { question: exchange.question }), ...entry, record });
    } finally {
      if (isCurrent()) { busy.current = false; setPaying(false); setSending(false); }
    }
  }

  return (
    <section className="try-panel">
      <h2 className="micro-label">{t('try this agent')}</h2>
      <p className="try-sub">
        {iface?.kind === 'mcp'
          ? t('Run a read-only task on this agent and inspect what it returns.')
          : t('Send a message to this agent and inspect its response and completion status.')}
      </p>
      {locale === 'zh-CN' && <p className="try-sub">{t('Provider responses remain in their original language. Chinese capability depends on the provider.')}</p>}

      {interfaceState === 'loading' && <p className="try-sub" role="status">{t('Reading the agent’s available tools…')}</p>}
      {interfaceError && <p className="try-sub exchange-err" role="alert">{t(interfaceError)}</p>}
      {interfaceState === 'ready' && iface?.kind === 'none' && <p className="try-sub">{t('This agent did not expose a runnable tool or message interface.')}</p>}
      {(interfaceError || (interfaceState === 'ready' && iface?.kind === 'none')) && <div className="try-run-row">
        <FlowButton variant="neutral" type="button" disabled={interfaceState === 'loading'} onClick={retryInterface}>
          {interfaceState === 'loading' ? t('Reading available tools…') : t('Retry available tools')}
        </FlowButton>
      </div>}
      {taskPresets.map(taskPreset => <div className="task-preset" key={taskPreset.id}>
        <h3>{t(taskPreset.title)}</h3>
        <p className="try-sub">{t(taskPreset.description)}</p>
        <div className="task-preset-input"><span>{t('Network: BSC')}</span><span>{t('Input:')} {taskPreset.inputSummary ? t(taskPreset.inputSummary) : t('public vault catalogue')}</span><span>{t('No wallet or payment submitted')}</span></div>
        <FlowButton variant="neutral" type="button" disabled={sending || !taskPreset.available} onClick={() => executeRead({ protocol: 'mcp', presetId: taskPreset.id, presetVersion: taskPreset.version, tool: taskPreset.tool, arguments: taskPreset.args, inputKind: 'public-fixture' }, taskPreset.title)}>
          {sending ? t('Waiting for the agent…') : t(taskPreset.actionLabel || taskPreset.title)}
        </FlowButton>
        {!taskPreset.available && <p className="try-sub">{taskPreset.unavailableReason}</p>}
      </div>)}

      {/* The controls live at the top, console-style: pick, run, and the
          answers accumulate below — the auto-run sample included. */}
      {iface && iface.kind !== 'none' && <details className="try-advanced" open={taskPreset ? undefined : true}>
      <summary id="try-interface-heading">
        {iface.kind === 'a2a'
          ? t('Send a message')
          : taskPreset ? t('Other read-only tools') : t('Choose a read-only tool')}
      </summary>
      {iface?.kind === 'mcp' ? (
        <form className="try-form try-form-tool" onSubmit={runTool}>
          <Select
            value={tool}
            onChange={(v) => { setTool(v); resetArgs(); }}
            disabled={sending}
            label={t('tool')}
            mono
            options={[
              { value: '', label: t('pick a tool…') },
              ...iface.tools.map((t) => ({ value: t.name, label: t.name })),
            ]}
          />
          {selected?.description && <p className="try-sub try-tool-desc">{selected.description}</p>}
          {selected && asFields && fields.length > 0 && (
            <div className="arg-grid">
              {fields.map((f) => (
                <label key={f.name} className="arg-field">
                  <span className="arg-label mono">
                    {f.name}
                    <span className={f.required ? 'arg-req' : 'arg-opt'}>{f.required ? t('required') : t('optional')}</span>
                  </span>
                  {f.kind === 'enum' ? (
                    <Select
                      value={argValues[f.name] ?? ''}
                      onChange={(v) => setArgValues((prev) => ({ ...prev, [f.name]: v }))}
                      disabled={sending}
                      label={f.name}
                      mono
                      options={[
                        { value: '', label: f.required ? t('pick one…') : t('leave unset') },
                        ...f.choices.map((c) => ({ value: c, label: c })),
                      ]}
                    />
                  ) : f.kind === 'boolean' ? (
                    <Select
                      value={argValues[f.name] ?? ''}
                      onChange={(v) => setArgValues((prev) => ({ ...prev, [f.name]: v }))}
                      disabled={sending}
                      label={f.name}
                      mono
                      options={[
                        { value: '', label: t('leave unset') },
                        { value: 'true', label: 'true' },
                        { value: 'false', label: 'false' },
                      ]}
                    />
                  ) : f.kind === 'json' ? (
                    <textarea
                      value={argValues[f.name] ?? ''}
                      onChange={(e) => setArgValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                      spellCheck={false}
                      rows={2}
                      disabled={sending}
                    />
                  ) : (
                    <input
                      value={argValues[f.name] ?? ''}
                      onChange={(e) => setArgValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                      spellCheck={false}
                      inputMode={f.kind === 'number' ? 'decimal' : undefined}
                      disabled={sending}
                    />
                  )}
                  {f.hint && <span className="arg-hint">{f.hint}</span>}
                </label>
              ))}
            </div>
          )}
          {selected && asFields && fields.length === 0 && (
            <p className="try-sub">{t('This tool takes no arguments.')}</p>
          )}
          {selected && !asFields && (
            <textarea
              value={argText}
              onChange={(e) => setArgText(e.target.value)}
              spellCheck={false}
              rows={Math.min(8, 2 + (fields?.length ?? selected.inputSchema?.required?.length ?? 1))}
              disabled={sending}
              placeholder="{ }"
              aria-label={t('tool arguments as JSON')}
            />
          )}
          {/* The schema named no properties, so the key list is all we honestly
              have to offer someone filling the box by hand. */}
          {selected && !fields && selected.inputSchema?.required?.length > 0 && (
            <p className="try-sub mono">{t('required:')} {selected.inputSchema.required.join(', ')}</p>
          )}
          {argError && <p className="try-sub arg-error">{t(argError)}</p>}
          <div className="try-run-row">
            <FlowButton variant="neutral" type="submit" disabled={sending || !tool || missing.length > 0}>
              {sending ? t('waiting for agent…') : t('run')}
            </FlowButton>
            {selected && fields?.length > 0 && (
              <button
                type="button"
                className="arg-mode"
                onClick={() => {
                  if (rawArgs) { setRawArgs(false); setArgError(null); return; }
                  // Carry what is already typed across the switch, so changing
                  // your mind never silently empties the form.
                  let seed = '';
                  try {
                    const built = buildArgs(fields, argValues);
                    seed = Object.keys(built).length ? JSON.stringify(built, null, 2) : '';
                  } catch { seed = ''; }
                  setArgText(seed);
                  setRawArgs(true);
                  setArgError(null);
                }}
              >
                {rawArgs ? t('back to fields') : t('edit as JSON')}
              </button>
            )}
          </div>
          {missing.length > 0 && (
            <p className="try-sub">{t('Needs {fields} before it can run.', { fields: missing.join(t(' and ')) })}</p>
          )}
          {/*
            Stated, not silently enforced. This agent serves tools that move
            funds or change position state, and hiding their existence would
            misrepresent what it does while showing them as runnable would let a
            stranger's click act on someone's behalf. The server refuses them
            too: the filter here is convenience, that one is the control.
          */}
          {iface.writeToolCount > 0 && (
            <p className="try-sub">
              {t('{count} further tools on this agent change state and are not runnable from here. Try calls reads only.', { count: iface.writeToolCount })}
            </p>
          )}
        </form>
      ) : iface?.kind === 'a2a' ? (
        <form className="try-form" onSubmit={send}>
          <input
            aria-labelledby="try-interface-heading"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('ask the agent something it claims to do')}
            maxLength={4000}
            disabled={sending}
          />
          <FlowButton variant="neutral" type="submit" disabled={sending || !message.trim()}>
            {sending ? t('waiting for agent…') : t('send')}
          </FlowButton>
        </form>
      ) : null}
      </details>}

      {sending && exchanges.length === 0 && (
        <p className="try-sub mono">{t('asking it now…')}</p>
      )}

      {exchanges.length > 0 && <p className="try-sub">{t('Download results you want to keep. Recent results stay available as you browse in this tab, within session limits.')}</p>}

      {exchanges.slice().reverse().map((ex, i) => (
        <div key={i} className="exchange">
          {ex.record && <div className="run-heading" data-state={runState(ex.record)} role="status">
            <strong>{t(runLabel(ex.record))}{i > 0 ? t(' · previous observation') : ''}</strong>
            <time dateTime={ex.record.observation.finishedAt}>{new Date(ex.record.observation.finishedAt).toLocaleString(locale)} · {ex.record.observation.latencyMs ?? t('unknown')} ms</time>
          </div>}
          <div className="exchange-q mono"><CornerDownRight size={11} strokeWidth={2} aria-hidden="true" /> {ex.questionLabel ? t(ex.questionLabel) : ex.question}</div>
          {ex.record && <div className="run-actions">
            <FlowButton variant="neutral" className="flow-sm" type="button" onClick={() => downloadRun(ex.record)}>{t('Download result')}</FlowButton>
            {ex.request && <FlowButton variant="neutral" className="flow-sm" type="button" disabled={!iface || sending || runState(ex.record) === 'pending'} onClick={() => executeRead(ex.request, ex.question)}>{t('Run again')}</FlowButton>}
          </div>}
          {ex.kind === 'reply' && (
            <>
              {ex.record?.request.presetId === 'pancake-bsc-range-assessment'
                ? <RangeAssessmentResult record={ex.record} />
                : ex.record?.request.presetId === 'beefy-bsc-vaults' && runState(ex.record) === 'passed'
                ? <VaultResult record={ex.record} />
                : ['venus-bsc-account-liquidity', 'pancake-bsc-lp-position', 'pancake-bsc-range-preview'].includes(ex.record?.request.presetId) && runState(ex.record) === 'passed'
                  ? <PositionTaskResult record={ex.record} /> : <ToolReply text={ex.text} />}
              {ex.receipt?.txHash && (
                <div className="receipt mono">
                  {t('provider reported payment transaction:')}{' '}
                  <a href={`https://bscscan.com/tx/${ex.receipt.txHash}`} target="_blank" rel="noreferrer">
                    {ex.receipt.txHash.slice(0, 10)}…
                  </a>
                </div>
              )}
            </>
          )}
          {ex.kind === 'error' && <div className="exchange-a exchange-err">{ex.uiText ? t(ex.uiText) : ex.text}</div>}
          {ex.record && <>
            {runState(ex.record) === 'pending' && <p className="try-sub">{t('The provider has not returned a completed result. This page does not poll or resubmit it automatically.')}</p>}
            {runState(ex.record) === 'payment' && ex.request && <p className="try-sub">{t('This read-only task stopped at the payment request. No payment was submitted.')}</p>}
            {ex.record.observation.task?.checks?.length > 0 && <ul className="run-checks">
              {ex.record.observation.task.checks.map((check) => <li key={check.id}><strong>{check.passed ? t('Passed') : t('Failed')}</strong>{check.label}</li>)}
            </ul>}
            {ex.record.observation.task?.limitation && <p className="try-sub">{ex.record.observation.task.limitation}</p>}
            {!ex.record.response.captureComplete && <p className="try-sub">{t('The full upstream response was not captured. The download records this limitation.')}</p>}
            <details className="run-details"><summary>{t('Request and observation details')}</summary><pre>{JSON.stringify({ request: ex.record.request, observation: ex.record.observation }, null, 2)}</pre></details>
          </>}
          {/*
            A 402 is the agent answering. It was drawn as a callout — a tinted
            slab, then a coloured rail — sitting on top of the exchange rather
            than in it, which is the shape a page reaches for when it has not
            decided what the thing IS. It is a reply whose content is a price,
            so it is built out of the reply's own parts: the answer line, the
            stamp that reports the terms of an answer, and the action it earns.
          */}
          {ex.kind === 'payment' && (
            <>
              <div className="exchange-a">{t('This agent charges per call — it answered HTTP 402.')}</div>
              {ex.reason && <p className="try-sub">{ex.reason}</p>}
              {ex.options.map((opt, j) => {
                // Everything past the amount is the terms of the offer, in the
                // same dot-and-interpuncts line a live answer uses to report
                // its own terms. Amber, not green: it answered, but not yet
                // with the thing that was asked for.
                const terms = [
                  opt.network,
                  opt.payTo && t('to {address}', { address: `${String(opt.payTo).slice(0, 8)}…` }),
                  opt.asset && t('token {address}', { address: `${String(opt.asset).slice(0, 10)}…` }),
                  !paymentProblem(opt, ex.version) && t('gasless: signature only, seller settles'),
                ].filter(Boolean).join(' · ');
                return (
                  <div key={j} className="try-stamp mono">
                    <span className="dot dot-stale" aria-hidden="true" />
                    <span>
                      {formatAmount(opt) && <span className="payment-amount">{formatAmount(opt)}</span>}
                      {formatAmount(opt) && terms ? ' · ' : ''}
                      {terms}
                    </span>
                  </div>
                );
              })}
              <div className="payment-act">
                <FlowButton
                  variant="gold"
                  className="flow-sm"
                  disabled={iface?.kind !== 'a2a' || !canPay(ex.options?.[0], ex.version) || paying || sending || paymentStateFor(ex).state !== 'available'}
                  onClick={() => payAndRetry(ex)}
                  title={
                    paymentStateFor(ex).state === 'consumed'
                      ? t('This payment challenge already created an authorization and is retired.')
                      : canPay(ex.options?.[0], ex.version)
                      ? t('Sign the payment in your wallet and rerun the question')
                      : t(paymentProblem(ex.options?.[0], ex.version) ?? 'Connect a browser wallet to pay.')
                  }
                >
                  {paymentStateFor(ex).state === 'consumed'
                    ? t('authorization retired')
                    : paymentStateFor(ex).state === 'prompting' || paying
                      ? t('confirm in wallet…')
                      : paymentProblem(ex.options?.[0], ex.version)
                        ? t('payment unavailable')
                        : t('pay {amount} and retry', { amount: formatAmount(ex.options?.[0]) })}
                </FlowButton>
                {!canPay(ex.options?.[0], ex.version) && (
                  <span className="try-sub">{t(paymentProblem(ex.options?.[0], ex.version) ?? 'Connect a browser wallet to pay.')}</span>
                )}
              </div>
              {paymentStatusText(ex) && <p className="try-sub" role="status">{t(paymentStatusText(ex))}</p>}
            </>
          )}
        </div>
      ))}

    </section>
  );
}
