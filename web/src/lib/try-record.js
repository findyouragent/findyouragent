function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function runCacheKey(chainId, tokenId, request) {
  return JSON.stringify([String(chainId), String(tokenId), stable(request)]);
}

// The server owns classification. A legacy relay may still return readable
// text, but it cannot issue a task-passed claim in the new client.
export function makeRunRecord(result, { chainId, tokenId, request, startedAt, finishedAt }) {
  const preset = result.taskPreset;
  const actualRequest = preset ? { protocol: 'mcp', tool: preset.tool, arguments: preset.args, presetId: preset.id, presetVersion: preset.version, inputKind: 'public-fixture' } : request;
  const status = result.status ?? result.httpStatus;
  const failure = result.error || result.body?.error || result.body?.result?.isError === true || (status >= 400);
  const observation = result.observation ?? {
    version: 0, runId: globalThis.crypto.randomUUID(),
    startedAt, finishedAt, latencyMs: new Date(finishedAt) - new Date(startedAt),
    outcome: status === 402 ? 'payment_required' : failure ? 'error' : 'unknown',
    reason: 'server-observation-unavailable', captureComplete: false,
    transport: { status: null, ok: false, received: false }, task: { status: 'not_evaluated' },
  };
  return {
    schemaVersion: 1,
    recordType: 'fya-observed-agent-result',
    runId: observation.runId,
    agent: { chainId: Number(chainId), tokenId: String(tokenId), endpointUsed: result.endpoint ?? observation.endpoint ?? null },
    request: actualRequest,
    observation,
    response: {
      body: result.body ?? { error: result.detail ?? result.error ?? 'No captured response' },
      captureComplete: observation.captureComplete === true,
      // Provider-reported settlement metadata, not an independent chain check.
      paymentReceipt: result.paymentReceipt ?? null,
    },
    // No request headers, wallet signatures or credentials are copied here.
    limitations: observation.task?.corroboration
      ? 'FYA observed this response. The attached RPC check covers only its named facts at the recorded block; other provider claims remain unverified. This file is not a provider-signed attestation or settlement receipt. Any attached paymentReceipt is provider-reported and requires separate verification.'
      : 'FYA observed this response. Task checks do not independently verify the provider data. This file is not a provider-signed attestation or settlement receipt. Any attached paymentReceipt is provider-reported and requires separate verification.',
  };
}

export function runState(record) {
  const observation = record.observation;
  if (observation.outcome === 'payment_required') return 'payment';
  if (observation.outcome === 'error') return 'error';
  if (observation.outcome === 'pending' || observation.task?.status === 'pending') return 'pending';
  if (observation.task?.status === 'failed') return 'failed';
  if (observation.task?.status === 'incomplete') return 'incomplete';
  if (observation.task?.status === 'passed') return 'passed';
  if (['response_received', 'deliverable_received'].includes(observation.outcome)) return 'reply';
  return 'unknown';
}

export function runLabel(record) {
  return {
    payment: 'Payment required', error: 'Request failed', pending: 'Still pending',
    failed: 'Task checks did not pass', incomplete: 'Task checks incomplete', passed: 'Task checks passed',
    reply: 'Response received', unknown: 'Response not classified',
  }[runState(record)];
}

export function downloadRun(record) {
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `fya-result-${record.agent.chainId}-${record.agent.tokenId}-${record.runId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
