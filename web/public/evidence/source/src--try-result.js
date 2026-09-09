// Version the meaning of a recorded observation independently of reputation
// scoring. Older `ok` flags did not inspect MCP isError and cannot be reused.
export const TRY_RESULT_VERSION = 1;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

function hasMcpContent(result) {
  if (object(result.structuredContent) && Object.keys(result.structuredContent).length > 0) return true;
  return Array.isArray(result.content) && result.content.some((part) => {
    if (!object(part)) return false;
    if (part.type === 'text') return text(part.text);
    if (part.type === 'image' || part.type === 'audio') return text(part.data);
    if (part.type === 'resource_link') return text(part.uri);
    if (part.type === 'resource') return text(part.resource?.text) || text(part.resource?.blob);
    return false;
  });
}

function hasA2aParts(parts) {
  return Array.isArray(parts) && parts.some((part) => {
    if (!object(part)) return false;
    const kind = part.kind ?? part.type;
    if (kind === 'text') return text(part.text);
    if (kind === 'data') return object(part.data) && Object.keys(part.data).length > 0;
    if (kind === 'file') return text(part.file?.bytes) || text(part.file?.uri);
    return false;
  });
}

/**
 * Classify what one response proves, without interpreting the agent's prose.
 * A response or even an A2A completed task does not prove the buyer's task
 * passed: only a separate, explicit task evaluator can make that assessment.
 * All clocks and ids are supplied by the caller, keeping this function pure.
 */
export function classifyTryResult({
  protocol, httpStatus = null, body, runId = null, endpoint = null,
  startedAt = null, finishedAt = null, latencyMs = null, captureComplete = false,
  phase = null,
}) {
  const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  const observation = {
    version: TRY_RESULT_VERSION,
    runId, protocol, endpoint, phase,
    startedAt, finishedAt, checkedAt: finishedAt,
    latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,
    captureComplete: captureComplete === true,
    transport: { status, ok: status !== null && status >= 200 && status < 300, received: status !== null },
    outcome: 'unknown',
    reason: 'unrecognized-response',
    task: { status: 'not_evaluated' },
    providerTaskId: protocol === 'a2a' && (body?.result?.kind === 'task' || object(body?.result?.status))
      && text(body?.result?.id) ? body.result.id : null,
  };
  const result = (outcome, reason) => ({ ...observation, outcome, reason });

  if (status === 402) return result('payment_required', 'upstream-payment-required');
  if (status !== null && !observation.transport.ok) return result('error', 'upstream-http-error');
  if (body?.error !== undefined && body?.error !== null) return result('error', 'rpc-or-relay-error');
  if (status === null) return result('error', 'no-upstream-response');
  if (!object(body?.result)) {
    return status === 202 ? result('pending', 'upstream-accepted') : result('unknown', 'missing-protocol-result');
  }

  const payload = body.result;
  if (protocol === 'mcp') {
    if (payload.isError === true) return result('error', 'mcp-tool-error');
    if (payload.isError !== undefined && typeof payload.isError !== 'boolean') {
      return result('unknown', 'invalid-mcp-error-flag');
    }
    if (status === 202) return result('pending', 'upstream-accepted');
    return hasMcpContent(payload)
      ? result('response_received', 'mcp-content-received')
      : result('unknown', 'empty-mcp-result');
  }

  if (protocol === 'a2a') {
    const state = typeof payload.status?.state === 'string' ? payload.status.state.toLowerCase() : null;
    if (['failed', 'rejected', 'canceled', 'cancelled'].includes(state)) return result('error', `a2a-${state}`);
    if (['submitted', 'working', 'input-required', 'auth-required'].includes(state)) return result('pending', `a2a-${state}`);
    if (status === 202) return result('pending', 'upstream-accepted');
    const hasOutput = hasA2aParts(payload.parts)
      || (Array.isArray(payload.artifacts) && payload.artifacts.some((artifact) => hasA2aParts(artifact?.parts)));
    if (state === 'completed') {
      return hasOutput ? result('deliverable_received', 'a2a-completed-with-output')
        : result('unknown', 'a2a-completed-without-output');
    }
    // A status message can say "queued" or "done" without being output.
    // Unknown task states and partial artifacts must not be shown as completed.
    if (state || payload.kind === 'task' || Array.isArray(payload.artifacts)) return result('unknown', 'a2a-task-state-unknown');
    if (hasA2aParts(payload.parts)) return result('response_received', 'a2a-message-received');
    return result('unknown', 'empty-a2a-result');
  }
  return observation;
}

// Auto-examples are only eligible after a check using the current classifier.
// This intentionally excludes old persisted `ok:true` records until rechecked.
export function isCurrentTryExample(example) {
  return example?.ok === true
    && example.observation?.version === TRY_RESULT_VERSION
    && example.observation?.outcome === 'response_received'
    && example.observation?.protocol === 'mcp';
}
