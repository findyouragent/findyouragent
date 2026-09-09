import { config } from './config.js';
import { normalizeCapability } from './verify/categorize.js';
import { safeFetch } from './net/safe-fetch.js';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeadline } from './request-deadline.js';

/**
 * A small MCP client, shared by verification and by Try.
 *
 * Both need to speak the same protocol to the same servers, and letting them
 * drift would mean the tools we verify an agent serves are not the tools we
 * offer to call.
 */

/**
 * Read one MCP JSON-RPC response. Streamable-HTTP servers may answer with
 * either application/json or a text/event-stream frame carrying the same
 * payload, so both shapes have to be understood or half of them read as dead.
 */
export function readMcpBody(res, text) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        // keep scanning: a stream can carry comments and partial frames
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function mcpRpc(url, body, { sessionId, timeoutMs, signal } = {}) {
  signal?.throwIfAborted();
  // safeFetch applies the SSRF guard (resolve + no redirect-to-private) and
  // reads the response under a hard byte cap: an MCP server is an
  // attacker-controlled host, and readMcpBody's old res.text() had no bound.
  const { res, text } = await safeFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': config.userAgent,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    signal: signal ?? AbortSignal.timeout(timeoutMs ?? config.probeTimeoutMs),
  }, { maxBytes: 512 * 1024, requireHttps: true });
  signal?.throwIfAborted();
  return { res, payload: readMcpBody(res, text) };
}

export function initializeParams() {
  return {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'findyouragent', version: '0.5' },
  };
}

/**
 * Whether a tool is safe to invoke from a public "try it" button.
 *
 * These servers publish no `annotations.readOnlyHint`, so there is no
 * machine-readable answer and the list genuinely mixes reads with writes:
 * Venus serves `getBorrowBalance` next to `borrow`, `repay` and `mintToken`.
 *
 * So this is default-CLOSED and decided by name. A tool is offered only if it
 * opens with a verb that reads. Anything unrecognised is refused, which will
 * occasionally hide a harmless tool. That is the correct direction to be wrong
 * in: the cost of hiding a read is a missing demo, and the cost of exposing a
 * write is a stranger's button doing something on someone's behalf.
 */
const READ_VERBS = new Set([
  'get', 'list', 'read', 'fetch', 'check', 'describe', 'query', 'find', 'search',
  'status', 'view', 'show', 'lookup', 'estimate', 'preview', 'quote', 'simulate',
  'analyze', 'analyse', 'monitor', 'is', 'has', 'can',
]);

// State-changing verbs. A write verb as a NOUN MODIFIER is harmless
// (`getBorrowBalance` reads a borrow balance), so the presence of one is not
// itself disqualifying. What is disqualifying is a SECOND, connected action:
// `getOrCreateAssociatedTokenAccount` is get-OR-create, and the old check saw
// only the leading `get`. The tell is a write verb joined by a connective.
const WRITE_VERBS = new Set([
  'create', 'execute', 'send', 'transfer', 'approve', 'swap', 'mint', 'burn',
  'repay', 'withdraw', 'deposit', 'stake', 'unstake', 'claim', 'redeem',
  'set', 'write', 'deploy', 'sign', 'buy', 'sell', 'cancel', 'revoke', 'delete',
  'remove', 'update', 'grant', 'enable', 'disable', 'pay', 'settle', 'bridge',
  'wrap', 'unwrap', 'register', 'submit', 'patch', 'fund', 'liquidate',
  'place', 'initialize', 'upgrade', 'migrate', 'rebalance', 'harvest', 'vote',
]);

// Words that join two actions into one tool name. A write verb right after one
// of these is a real second operation, not a noun.
const CONNECTIVE = new Set(['or', 'and', 'then', 'plus']);

export function isReadOnlyTool(name) {
  // Reuses the one normalizer rather than repeating its logic. Written a second
  // time here, it lowercased before splitting on camelCase and so found no word
  // boundaries at all: every tool including `getBorrowBalance` was classified
  // as a write, and Try offered nothing. Two copies of a rule is two chances to
  // get it wrong, and this is the copy that decides what a stranger can invoke.
  const segments = normalizeCapability(name).split('_').filter(Boolean);
  if (!segments.length) return false;
  // Must open with a read verb (default-closed on an unrecognised opener), AND
  // carry no write verb introduced by a connective (the compound-action bypass,
  // e.g. get_or_create_..., check_then_execute, fetch_and_settle).
  if (!READ_VERBS.has(segments[0])) return false;
  for (let i = 1; i < segments.length; i += 1) {
    if (WRITE_VERBS.has(segments[i]) && CONNECTIVE.has(segments[i - 1])) return false;
  }
  return true;
}

/**
 * Open a session and list what the server will actually do.
 * Returns null when the endpoint cannot be reached or refuses.
 */
const TRANSIENT_DISCOVERY_STATUSES = new Set([502, 503, 504]);

function discoveryFailure(phase, code, upstreamStatus = null, retryable = false) {
  return { source: 'agent', phase, code, upstreamStatus, retryable };
}

function rpcDiscoveryFailure(reply, phase) {
  if (!reply.res.ok) return discoveryFailure(phase, 'mcp-http-error', reply.res.status, TRANSIENT_DISCOVERY_STATUSES.has(reply.res.status));
  if (reply.payload?.error) return discoveryFailure(phase, 'mcp-rpc-error', reply.res.status);
  if (!reply.payload?.result || typeof reply.payload.result !== 'object' || Array.isArray(reply.payload.result)) {
    return discoveryFailure(phase, 'mcp-invalid-response', reply.res.status);
  }
  if (phase === 'tools/list' && !Array.isArray(reply.payload.result.tools)) {
    return discoveryFailure(phase, 'mcp-invalid-response', reply.res.status);
  }
  return null;
}

// Discovery is repeatable; tool execution is not. Retry one transient discovery
// response with a fresh session, within the SAME deadline. Never retry a 429,
// RPC refusal, malformed payload, timeout or blocked destination.
export async function discoverMcpTools(url, { timeoutMs = config.probeTimeoutMs, signal: parentSignal } = {}) {
  let phase = 'initialize';
  let attempts = 0;
  try {
    return await withDeadline(timeoutMs, async (signal) => {
      for (attempts = 1; attempts <= 2; attempts += 1) {
        let failure;
        try {
          phase = 'initialize';
          const init = await mcpRpc(url, { method: 'initialize', params: initializeParams() }, { signal });
          failure = rpcDiscoveryFailure(init, phase);
          if (!failure) {
            const sessionId = init.res.headers.get('mcp-session-id') || undefined;
            phase = 'tools/list';
            const list = await mcpRpc(url, { method: 'tools/list', params: {} }, { sessionId, signal });
            failure = rpcDiscoveryFailure(list, phase);
            if (!failure) return { ok: true, attempts, listed: {
              sessionId, server: init.payload.result.serverInfo ?? {},
              protocolVersion: init.payload.result.protocolVersion ?? null,
              tools: list.payload.result.tools.map((t) => ({
                name: String(t?.name ?? ''), title: t?.title ?? null,
                description: typeof t?.description === 'string' ? t.description.slice(0, 400) : null,
                inputSchema: t?.inputSchema ?? null, readOnly: isReadOnlyTool(t?.name),
              })).filter((t) => t.name),
            } };
          }
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          const blocked = String(err?.message).startsWith('ssrf-guard:');
          failure = discoveryFailure(phase, blocked ? 'mcp-blocked-endpoint' : 'mcp-network-error', null, !blocked && err instanceof TypeError);
        }
        if (!failure.retryable || attempts === 2) return { ok: false, attempts, failure };
        await delay(250, undefined, { signal });
      }
    }, parentSignal);
  } catch (err) {
    return { ok: false, attempts, failure: discoveryFailure(phase,
      err?.name === 'TimeoutError' ? 'mcp-discovery-timeout' : 'mcp-discovery-aborted') };
  }
}

export async function listMcpTools(url, options) {
  const result = await discoverMcpTools(url, options);
  return result.ok ? result.listed : null;
}

/**
 * Invoke one tool. The caller is responsible for having checked `readOnly`.
 */
export async function callMcpTool(url, { name, args, timeoutMs = config.probeTimeoutMs, signal: parentSignal }) {
  return withDeadline(timeoutMs, async (signal) => {
    // A fresh session per call: these are stateless one-shot invocations and
    // holding sessions open across requests would leak them on every abandon.
    const init = await mcpRpc(url, { method: 'initialize', params: initializeParams() }, { signal });
    if (!init.res.ok || init.payload?.error || !init.payload?.result) {
      return { status: 502, upstreamStatus: init.res.status, phase: 'initialize', captureComplete: false,
        body: { error: 'agent MCP server refused the handshake' } };
    }
    const sessionId = init.res.headers.get('mcp-session-id') || undefined;

    const call = await mcpRpc(
      url,
      { method: 'tools/call', params: { name, arguments: args ?? {} } },
      { sessionId, signal },
    );
    if (!call.payload) {
      if (call.res.status === 202) {
        return { status: 202, upstreamStatus: 202, phase: 'tools/call', captureComplete: false, body: null };
      }
      return { status: 502, upstreamStatus: call.res.status, phase: 'tools/call', captureComplete: false,
        body: { error: 'agent returned a response that could not be parsed' } };
    }
    return { status: call.res.status, upstreamStatus: call.res.status, phase: 'tools/call',
      captureComplete: true, body: call.payload };
  }, parentSignal);
}
