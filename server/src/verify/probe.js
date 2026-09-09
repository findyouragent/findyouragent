import { config } from '../config.js';
import { normalizeCapability } from './categorize.js';
import { mcpRpc, initializeParams } from '../mcp.js';
import { deriveTryExample } from '../try-example.js';
import { safeUrl, safeFetch } from '../net/safe-fetch.js';
import { randomUUID } from 'node:crypto';
import { classifyTryResult } from '../try-result.js';

// safeUrl is re-exported so the many callers that import it from here keep
// working; the guard itself now lives in net/safe-fetch.js and covers the
// literal-IP, IPv6, DNS-to-private and redirect bypasses the old regex missed.
export { safeUrl };

/**
 * Probe an agent's declared MCP endpoint.
 *
 * Most of the agents doing the work this site cares about publish MCP rather
 * than A2A, and reading only `services.a2a` made them invisible: never probed,
 * never categorized, never able to earn the top tier.
 *
 * What comes back is stronger evidence than an A2A card. `tools/list` is the
 * set of things the server will ACTUALLY do right now, which can be compared
 * against the tool list the agent's own metadata advertises. That comparison is
 * the one claim on this site that no registry publishes.
 */
/**
 * One retry, and only on a timeout.
 *
 * A verdict is written to disk and served for a day. Measured against the live
 * HeyAnon servers the MCP handshake takes ~500ms, yet a single 6s timeout
 * downgraded Venus from `verified_live` to `registered` and that stood until the
 * next recheck: a public false negative caused by one bad round trip.
 *
 * Only timeouts are retried. An HTTP error or a refusal is an answer, and
 * asking a second time would be pestering a server that already replied.
 */
async function retryOnTimeout(attempt) {
  const first = await attempt();
  if (first?.reason !== 'timeout') return first;
  return attempt();
}

export async function probeMcp(rawUrl) {
  return retryOnTimeout(() => probeMcpOnce(rawUrl));
}

async function probeMcpOnce(rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return { declared: Boolean(rawUrl), reachable: false, reason: rawUrl ? 'invalid-url' : 'no-endpoint' };

  const started = Date.now();
  try {
    const init = await mcpRpc(url, { method: 'initialize', params: initializeParams() });
    if (!init.res.ok) {
      return { declared: true, reachable: false, status: init.res.status, latencyMs: Date.now() - started, reason: 'http-error' };
    }
    if (init.payload?.error || !init.payload?.result) {
      return { declared: true, reachable: true, status: init.res.status, latencyMs: Date.now() - started, servesTools: false, reason: 'initialize-rejected' };
    }

    // Servers that keep session state hand back an id the next call must carry.
    const sessionId = init.res.headers.get('mcp-session-id') || undefined;
    const server = init.payload.result.serverInfo || {};

    const list = await mcpRpc(url, { method: 'tools/list', params: {} }, { sessionId });
    const latencyMs = Date.now() - started;
    if (!list.res.ok || list.payload?.error || !list.payload?.result) {
      return {
        declared: true, reachable: true, status: list.res.status, latencyMs, servesTools: false,
        serverName: server.name ?? null, reason: 'tools-list-rejected',
      };
    }

    const tools = Array.isArray(list.payload.result.tools) ? list.payload.result.tools : [];
    // Normalized, not merely lowercased. Flattening `increaseLiquidity` to
    // `increaseliquidity` here would destroy the word boundaries before
    // anything downstream can use them, which silently broke every capability
    // rule written in terms of whole words.
    const toolIds = tools
      .map((t) => normalizeCapability(t?.name))
      .filter(Boolean)
      .slice(0, 120);

    // Validate the Try panel's zero-input example while the session is open:
    // derive one safe read-only call from the tools' own schemas and RUN it, so
    // the panel only ever auto-runs something that succeeded on the last check.
    // One extra read-only call per probe; a failure here is recorded (ok:false)
    // and never affects the probe verdict itself.
    let tryExample = null;
    const derived = deriveTryExample(tools);
    if (derived) {
      const exampleStarted = Date.now();
      try {
        const call = await mcpRpc(
          url,
          { method: 'tools/call', params: { name: derived.tool, arguments: derived.args } },
          { sessionId },
        );
        const finished = Date.now();
        const observation = classifyTryResult({
          protocol: 'mcp', httpStatus: call.res.status, body: call.payload, runId: randomUUID(), endpoint: String(url),
          phase: 'tools/call', startedAt: new Date(exampleStarted).toISOString(), finishedAt: new Date(finished).toISOString(),
          latencyMs: finished - exampleStarted, captureComplete: call.payload !== null,
        });
        tryExample = {
          ...derived,
          ok: observation.outcome === 'response_received',
          latencyMs: observation.latencyMs,
          checkedAt: observation.checkedAt,
          observation,
        };
      } catch {
        tryExample = { ...derived, ok: false, latencyMs: Date.now() - exampleStarted, checkedAt: new Date().toISOString() };
      }
    }

    return {
      declared: true,
      reachable: true,
      status: list.res.status,
      latencyMs,
      servesTools: toolIds.length > 0,
      serverName: server.name ?? null,
      serverVersion: server.version ?? null,
      protocolVersion: init.payload.result.protocolVersion ?? null,
      toolCount: toolIds.length,
      toolIds,
      tryExample,
    };
  } catch (err) {
    return {
      declared: true,
      reachable: false,
      latencyMs: Date.now() - started,
      reason: err.name === 'TimeoutError' ? 'timeout' : 'unreachable',
    };
  }
}

// Probe the agent's declared A2A endpoint. An agent card that parses and
// declares skills is the difference between "a URL was written down once"
// and "something is serving on the other end".
/**
 * Fill in a templated endpoint.
 *
 * Some platforms register one endpoint pattern for their whole fleet, e.g.
 * `.../a2a/agents/{agentId}/card`. Fetched literally that is a guaranteed 404,
 * which reads as "this agent is unreachable" when the truth is that we never
 * addressed it. Substituting the token id is what actually asks the question.
 *
 * Substitution happens BEFORE safeUrl, so the SSRF guard still applies to the
 * result and a template cannot be used to smuggle a private host through.
 */
export function fillEndpointTemplate(rawUrl, tokenId) {
  if (typeof rawUrl !== 'string' || tokenId == null) return rawUrl;
  return rawUrl.replace(/\{\s*(agentId|tokenId|agent_id|token_id|id)\s*\}/gi, String(tokenId));
}

export async function probeEndpoint(rawUrl, tokenId) {
  return retryOnTimeout(() => probeEndpointOnce(fillEndpointTemplate(rawUrl, tokenId), rawUrl));
}

async function probeEndpointOnce(rawUrl, declaredUrl = rawUrl) {
  const url = safeUrl(rawUrl);
  if (!url) return { declared: Boolean(rawUrl), reachable: false, reason: rawUrl ? 'invalid-url' : 'no-endpoint' };

  const started = Date.now();
  try {
    const { res, text } = await safeFetch(url, {
      headers: { accept: 'application/json', 'user-agent': config.userAgent },
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    }, { maxBytes: 256 * 1024 });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { declared: true, reachable: false, status: res.status, latencyMs, reason: 'http-error' };

    let card = null;
    try {
      card = JSON.parse(text);
    } catch {
      return { declared: true, reachable: true, status: res.status, latencyMs, hasAgentCard: false, reason: 'not-json' };
    }
    const skillList = Array.isArray(card?.skills) ? card.skills : [];
    const skills = skillList.length;
    // A `name` alone is not an agent card. Plenty of registry and listing
    // records carry one, and accepting it would let any JSON blob count as
    // "the endpoint answered with a valid agent card" — including fleets whose
    // own records report themselves offline. Require something only a real A2A
    // card has: a protocol version, a callable url, or actual skills.
    const hasAgentCard = Boolean(
      card && (card.protocolVersion || card.url || card.additionalInterfaces || skills > 0),
    );
    // Keep the declared skill ids, not just the count: what an agent says it
    // can do is the only capability evidence it publishes, and it is what
    // category placement is derived from.
    const skillIds = skillList
      .map((s) => normalizeCapability(s?.id || s?.name))
      .filter(Boolean)
      .slice(0, 60);
    // WHO does this card say it is? A card that answers is not the same as a
    // card that answers FOR THIS AGENT. A shared fleet endpoint returns a
    // perfectly valid card describing the service, and without capturing the
    // subject there is no way to tell that apart from an agent's own card.
    return {
      declared: true,
      reachable: true,
      status: res.status,
      latencyMs,
      hasAgentCard,
      skillsCount: skills,
      skillIds,
      probedUrl: String(url),
      // The pattern as registered, kept when it differed from what we fetched.
      // Otherwise a reader cannot tell we substituted anything.
      declaredUrl: declaredUrl !== rawUrl ? declaredUrl : null,
      // Some platforms answer with their own liveness field instead of a card.
      // "the platform reports this agent UNBOUND" is a far more useful verdict
      // than "not a card", and it comes from the operator rather than from us.
      platformStatus: typeof card?.status === 'string' ? card.status.slice(0, 40)
        : (typeof card?.presence === 'string' ? card.presence.slice(0, 40) : null),
      cardUrl: typeof card?.url === 'string' ? card.url : null,
      // Per-agent cards name their ERC-6551 account; fleet cards do not.
      cardAgentWallet: typeof card?.agentWallet === 'string' ? card.agentWallet : null,
      cardName: typeof card?.name === 'string' ? card.name.slice(0, 120) : null,
    };
  } catch (err) {
    return {
      declared: true,
      reachable: false,
      latencyMs: Date.now() - started,
      reason: err.name === 'TimeoutError' ? 'timeout' : 'unreachable',
    };
  }
}
