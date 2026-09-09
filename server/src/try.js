import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { safeUrl, fillEndpointTemplate } from './verify/probe.js';
import { safeFetch } from './net/safe-fetch.js';
import { getAgentDetail } from './sources/scan8004.js';
import { discoverMcpTools, callMcpTool, isReadOnlyTool } from './mcp.js';
import { withDeadline } from './request-deadline.js';
import { classifyTryResult } from './try-result.js';
import { getTaskPresets, resolveTaskPreset, assessTaskResult, taskPayload, RANGE_ASSESSMENT_ID } from './task-presets.js';
import { corroborateRangeFacts } from './range-assessment.js';

const MESSAGE_MAX = 4000;
const RESPONSE_MAX = 200 * 1024;
const TRY_TIMEOUT_MS = 90_000;
const INTERFACE_TIMEOUT_MS = 30_000;
const ARGS_MAX = 8 * 1024;

async function resolveAgent(chainId, tokenId, signal) {
  try {
    const detail = await getAgentDetail(chainId, tokenId);
    signal.throwIfAborted();
    return detail;
  } catch (err) {
    // The registry coalesces simultaneous reads, including their rejected
    // Error object. Give this caller its own context without changing errors
    // still being used by verification, detail or the sweep.
    const failure = new Error('The agent registry lookup failed.', { cause: err });
    failure.name = err?.name || 'Error';
    for (const field of ['status', 'code', 'rateLimited', 'retryAfterSeconds', 'malformed']) {
      if (err?.[field] !== undefined) failure[field] = err[field];
    }
    failure.source = 'registry';
    failure.phase = 'agent-detail';
    throw failure;
  }
}

function failureDetails(error, fallbackSource = 'agent', fallbackPhase = 'request') {
  const timeout = error?.name === 'TimeoutError';
  const source = error?.source ?? fallbackSource;
  const phase = error?.phase ?? fallbackPhase;
  const invalid = error?.malformed || error?.code === 'registry-invalid-response';
  const beforeInvocation = source === 'registry'
    || ['agent-detail', 'agent-card', 'discovery', 'initialize', 'tools/list'].includes(phase);
  const transient = timeout || error?.name === 'TypeError' || Boolean(error?.rateLimited)
    || [500, 502, 503, 504, 522, 524].includes(error?.status);
  return {
    source, phase,
    code: timeout ? 'request-timeout' : error?.rateLimited ? 'registry-throttled'
      : invalid ? 'registry-invalid-response' : `${source}-unavailable`,
    upstreamStatus: Number.isInteger(error?.status) ? error.status : null,
    // This describes whether a later explicit retry is safe; it never causes
    // an automatic retry. Lost execution responses remain completion-unknown.
    retryable: Boolean(beforeInvocation && transient && !invalid),
    ...(Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds > 0
      ? { retryAfterSeconds: Math.min(error.retryAfterSeconds, 86400) } : {}),
  };
}

function failureMessage(failure) {
  if (failure.source === 'registry') return 'The agent registry could not supply this agent’s current endpoint. Try again shortly.';
  if (failure.phase === 'agent-card') return 'The agent card could not be read. No message was sent to the agent.';
  if (failure.code.includes('timeout')) return 'The agent request timed out. Completion is unknown; no task was automatically resubmitted.';
  if (failure.code === 'mcp-rpc-error') return 'The agent refused its tool-discovery request.';
  if (failure.code === 'mcp-invalid-response') return 'The agent returned an unreadable tool-discovery response.';
  if (failure.code === 'mcp-blocked-endpoint') return 'The declared agent endpoint could not be reached through the public endpoint checks.';
  if (['request', 'agent-call', 'message/send'].includes(failure.phase)) return 'The agent request did not return a captured response. Completion is unknown; no task was automatically resubmitted.';
  return 'The agent could not supply its available tools. Try again shortly.';
}

function failedInterface(failure, attempts) {
  return { status: failure.code === 'registry-throttled' ? 503 : 502,
    body: { kind: 'none', error: failureMessage(failure), ...failure, ...(attempts ? { attempts } : {}) } };
}

function failedTask(failure, endpoint = null) {
  return { status: failure.code === 'registry-throttled' ? 503 : 502, ...failure, endpoint, captureComplete: false,
    body: { error: failureMessage(failure), code: failure.code } };
}

/**
 * A reply that is not JSON is rarely a transport problem: it is what the
 * address actually serves. Naming that is a finding about the registration —
 * and it beats dumping a web page's source at the reader.
 *
 * The page title is quoted because it identifies WHAT is being served, which is
 * usually the giveaway (a product site, a login page, a parked domain). It is
 * authored by the party being assessed, so it is stripped of control characters
 * and capped; React escapes it on render, so it is never markup.
 */
export function explainNonJsonReply(status, raw) {
  const text = String(raw ?? '');
  if (status === 404 || status === 405) {
    return {
      error:
        'The agent card declares a service URL that rejects A2A message/send. The endpoint exists but the card is misconfigured: that is a finding, not a transport failure.',
    };
  }
  if (/^\s*(<!doctype html|<html[\s>])/i.test(text)) {
    const found = text.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] ?? '';
    const title = [...found].filter((c) => c >= ' ' && c !== String.fromCharCode(127)).join('').trim().slice(0, 80);
    return {
      error: `The address this agent publishes serves a web page${title ? ` titled "${title}"` : ''}, not an agent interface. A browser gets a website here; anything speaking A2A gets nothing it can use. That is a finding about the registration, not a transport failure.`,
    };
  }
  return { raw: text.slice(0, 2000) };
}

/**
 * What this agent can be tried with.
 *
 * A2A agents take a free-text message. MCP agents do not: they expose named
 * operations with typed arguments, so the honest interface is the real tool
 * list, read live from the server rather than from the registry's copy of it.
 *
 * Only read-only tools are offered. See `isReadOnlyTool` for why that decision
 * is made by name and why it is default-closed.
 */
export async function tryInterface({ chainId, tokenId }) {
  let source = 'registry';
  try {
    return await withDeadline(INTERFACE_TIMEOUT_MS, async (signal) => {
      const detail = await resolveAgent(chainId, tokenId, signal);
      source = 'agent';
      const mcpUrl = safeUrl(detail?.services?.mcp?.endpoint || '', { requireHttps: true });
      if (mcpUrl) {
        const discovery = await discoverMcpTools(mcpUrl, { timeoutMs: INTERFACE_TIMEOUT_MS, signal });
        if (!discovery.ok) return failedInterface(discovery.failure, discovery.attempts);
        const listed = discovery.listed;
        return {
          status: 200,
          body: {
            kind: 'mcp',
            endpoint: String(mcpUrl),
            server: listed.server,
            discovery: { attempts: discovery.attempts, recovered: discovery.attempts > 1 },
            // Both halves are returned. Hiding the write tools would misrepresent
            // what the agent does; showing them as callable would be worse.
            tools: listed.tools.filter((t) => t.readOnly),
            writeToolCount: listed.tools.filter((t) => !t.readOnly).length,
            taskPresets: getTaskPresets({ chainId, tokenId, tools: listed.tools }),
          },
        };
      }

      if (safeUrl(fillEndpointTemplate(detail?.services?.a2a?.endpoint || '', tokenId), { requireHttps: true })) {
        return { status: 200, body: { kind: 'a2a' } };
      }
      return { status: 409, body: { error: 'agent declares no callable endpoint' } };
    });
  } catch (err) {
    return failedInterface(failureDetails(err, source, source === 'registry' ? 'agent-detail' : 'discovery'));
  }
}

// Relay a single A2A message/send to an agent's declared endpoint. Browsers
// cannot call arbitrary agent hosts (CORS), so this proxies exactly one shape
// of request and nothing else. The server never signs or holds funds: an
// X-PAYMENT header produced by the user's wallet passes through untouched.
export async function tryAgent(request) {
  const started = Date.now();
  const runId = randomUUID();
  const protocol = request.presetId !== undefined || (typeof request.tool === 'string' && request.tool) ? 'mcp' : 'a2a';
  let result;
  try {
    // Reserve time for the reviewed task's separate RPC check while retaining
    // a provider response even if that later check cannot complete.
    const providerBudget = request.presetId === RANGE_ASSESSMENT_ID ? TRY_TIMEOUT_MS - 15000 : TRY_TIMEOUT_MS;
    result = await withDeadline(providerBudget, (signal) => tryAgentRequest({ ...request, signal }));
  } catch (err) {
    result = failedTask(failureDetails(err));
  }
  const finished = Date.now();
  const { _taskPreset, ...response } = result;
  const observation = classifyTryResult({
    protocol: result.kind ?? protocol, runId, body: result.body, httpStatus: result.upstreamStatus,
    endpoint: result.endpoint ?? null, phase: result.phase ?? null,
    startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
    latencyMs: finished - started, captureComplete: result.captureComplete,
  });
  if (_taskPreset) observation.task = assessTaskResult(_taskPreset, observation, result.body);
  if (_taskPreset?.id === RANGE_ASSESSMENT_ID && observation.task.status === 'incomplete') {
    let corroboration;
    try {
      corroboration = await withDeadline(15000, (signal) => corroborateRangeFacts(taskPayload(result.body), { signal }));
    } catch {
      corroboration = { status: 'incomplete', checkedAt: new Date().toISOString(), checks: [],
        limitation: 'The separate BSC fact check could not complete. The original provider response remains available; it has not been confirmed against chain state.' };
    }
    observation.task.corroboration = corroboration;
    observation.task.status = corroboration.status === 'passed' ? 'passed'
      : corroboration.status === 'failed' ? 'failed' : 'incomplete';
  }
  return { ...response, observation };
}

async function tryAgentRequest({ chainId, tokenId, message, payment, tool, args, presetId, signal }) {
  const detail = await resolveAgent(chainId, tokenId, signal);
  let taskPreset = null;
  if (presetId !== undefined) {
    if (typeof presetId !== 'string' || !presetId) return { status: 400, body: { error: 'presetId must be a non-empty string' } };
    const endpoint = safeUrl(detail?.services?.mcp?.endpoint || '', { requireHttps: true });
    if (!endpoint) return { status: 409, body: { error: 'this task requires an available MCP endpoint' } };
    const discovery = await discoverMcpTools(endpoint, { timeoutMs: INTERFACE_TIMEOUT_MS, signal });
    if (!discovery.ok) return failedTask(discovery.failure, String(endpoint));
    taskPreset = resolveTaskPreset({ chainId, tokenId, presetId, tools: discovery.listed.tools });
    if (!taskPreset) return { status: 409, body: { error: 'this task is unavailable because its live tool or input requirements changed' } };
    // Presets own their fixture. Caller-supplied tools or args cannot silently
    // turn a named read-only task into a different operation.
    tool = taskPreset.tool;
    args = structuredClone(taskPreset.args);
  }

  // MCP agents are invoked by naming a tool, not by sending prose. Most agents
  // doing real work on this registry are MCP-only, so without this branch the
  // Try panel was dead for every agent this site pins.
  if (typeof tool === 'string' && tool) {
    const mcpUrl = safeUrl(detail?.services?.mcp?.endpoint || '', { requireHttps: true });
    if (!mcpUrl) return { status: 409, body: { error: 'agent has no valid MCP endpoint' } };

    // Enforced here, not only in the UI. The list endpoint already filters
    // writes out, but a client can post any name it likes and this is the only
    // place that actually stops it.
    if (!isReadOnlyTool(tool)) {
      return {
        status: 403,
        body: {
          error: `"${tool}" is not a read-only tool, so it cannot be run from here. Try invokes reads only: this agent's other tools change state, and a public button must not do that on someone's behalf.`,
        },
      };
    }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return { status: 400, body: { error: 'arguments must be a JSON object' } };
    }
    if (args && JSON.stringify(args).length > ARGS_MAX) {
      return { status: 400, body: { error: `arguments too large (max ${ARGS_MAX} bytes)` } };
    }

    let result;
    try {
      result = await callMcpTool(mcpUrl, { name: tool, args, timeoutMs: TRY_TIMEOUT_MS, signal });
    } catch (err) {
      result = failedTask(failureDetails(err, 'agent', 'agent-call'), String(mcpUrl));
    }
    return {
      ...result, endpoint: String(mcpUrl), kind: 'mcp',
      ...(taskPreset ? {
        _taskPreset: taskPreset,
        taskPreset: { id: taskPreset.id, version: taskPreset.version, title: taskPreset.title,
          tool: taskPreset.tool, args: taskPreset.args },
      } : {}),
    };
  }

  if (typeof message !== 'string' || !message.trim()) {
    return { status: 400, body: { error: 'message required' } };
  }
  if (message.length > MESSAGE_MAX) {
    return { status: 400, body: { error: `message too long (max ${MESSAGE_MAX} chars)` } };
  }

  // Same templated-endpoint substitution the prober does: fetched literally,
  // a `{agentId}` pattern 404s and Try reports the agent unreachable when we
  // simply never addressed it.
  const cardUrl = safeUrl(fillEndpointTemplate(detail?.services?.a2a?.endpoint || '', tokenId), { requireHttps: true });
  if (!cardUrl) return { status: 409, body: { error: 'agent has no valid A2A endpoint' } };

  let cardRes; let cardText;
  try {
    ({ res: cardRes, text: cardText } = await safeFetch(cardUrl, {
      headers: { accept: 'application/json', 'user-agent': config.userAgent },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.probeTimeoutMs)]),
    }, { maxBytes: RESPONSE_MAX, requireHttps: true }));
  } catch (err) {
    return failedTask(failureDetails(err, 'agent', 'agent-card'), String(cardUrl));
  }
  if (!cardRes.ok) return { status: 502, upstreamStatus: cardRes.status, endpoint: String(cardUrl), phase: 'agent-card',
    body: { error: `agent card fetch failed (${cardRes.status})` } };
  let card;
  try {
    card = JSON.parse(cardText);
  } catch {
    return { status: 502, upstreamStatus: cardRes.status, endpoint: String(cardUrl), phase: 'agent-card',
      body: { error: 'agent card is not JSON' } };
  }

  // A2A 0.3: prefer the JSONRPC entry in additionalInterfaces; many cards set
  // the top-level url to the bare origin.
  const iface = Array.isArray(card?.additionalInterfaces)
    ? card.additionalInterfaces.find((i) => i?.transport === 'JSONRPC' && i?.url)
    : null;
  const rpcUrl = safeUrl(iface?.url || '', { requireHttps: true })
    || safeUrl(card?.url || '', { requireHttps: true }) || new URL('/', cardUrl);
  const headers = { 'content-type': 'application/json', 'user-agent': config.userAgent };
  if (typeof payment === 'string' && payment.length > 0 && payment.length < 8192) {
    headers['X-PAYMENT'] = payment;
  }

  const rpcBody = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        kind: 'message',
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: message }],
      },
    },
  };

  let res; let raw;
  try {
    ({ res, text: raw } = await safeFetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcBody),
      signal,
    }, { maxBytes: RESPONSE_MAX, requireHttps: true }));
  } catch (err) {
    return failedTask(failureDetails(err, 'agent', 'message/send'), String(rpcUrl));
  }
  // Settlement receipt: browsers can't read this header cross-origin from most
  // agents (Expose-Headers is rarely set), but a server relay can.
  let paymentReceipt = null;
  const receiptHeader = res.headers.get('x-payment-response');
  if (receiptHeader) {
    try {
      paymentReceipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8'));
    } catch {
      paymentReceipt = null;
    }
  }

  let body;
  let captureComplete = true;
  try {
    body = JSON.parse(raw);
  } catch {
    body = explainNonJsonReply(res.status, raw);
    captureComplete = false;
  }
  return { status: res.status, upstreamStatus: res.status, body, endpoint: String(rpcUrl),
    kind: 'a2a', phase: 'message/send', captureComplete, paymentReceipt };
}
