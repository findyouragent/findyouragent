import { classifyTryResult, TRY_RESULT_VERSION } from './try-result.js';
import { assessTaskResult, getTaskPresets } from './task-presets.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// Status messages are progress, never deliverables. Only extract output after
// canonical protocol classification has ruled out errors and pending tasks.
function extractOutput(body, protocol) {
  const result = body?.result;
  const fromParts = (parts) => Array.isArray(parts) ? parts.filter((part) =>
    (part?.kind === 'text' || part?.type === 'text') && typeof part.text === 'string')
    .map((part) => part.text).join('\n') : '';
  if (protocol === 'mcp') {
    if (object(result?.structuredContent) && Object.keys(result.structuredContent).length > 0) {
      return JSON.stringify(result.structuredContent, null, 2);
    }
    return fromParts(result?.content);
  }
  return fromParts(result?.parts) || (Array.isArray(result?.artifacts)
    ? result.artifacts.map((artifact) => fromParts(artifact?.parts)).filter(Boolean).join('\n') : '');
}

function evaluatePreset(request, agent, observation, body) {
  if (!request.presetId) return observation.task;
  // Availability is checked live at invocation. Import checks the historical
  // request against the versioned fixture, without making another agent call.
  const preset = getTaskPresets({ ...agent, tools: [] }).find((entry) =>
    entry.id === request.presetId && entry.version === request.presetVersion);
  if (!preset || request.protocol !== 'mcp' || request.tool !== preset.tool || !same(request.arguments, preset.args)) {
    throw new Error('The preset, version or actual inputs do not match a reviewed task fixture.');
  }
  return assessTaskResult(preset, observation, body);
}

export function inspectAdvantageResult({ agent, request, body, httpStatus, endpoint = null,
  runId = null, startedAt, finishedAt, latencyMs, captureComplete, phase = null }) {
  const observation = classifyTryResult({ protocol: request.protocol, httpStatus, body,
    endpoint, runId, startedAt, finishedAt, latencyMs, captureComplete, phase });
  if (!['response_received', 'deliverable_received'].includes(observation.outcome)) {
    throw new Error(`No terminal output to record: ${observation.outcome} (${observation.reason}).`);
  }
  if (!captureComplete) throw new Error('The complete response was not captured; it cannot be used as benchmark output.');
  observation.task = evaluatePreset(request, agent, observation, body);
  if (['pending', 'failed'].includes(observation.task.status)) {
    throw new Error(`The preset task checks are ${observation.task.status}; this is not completed task evidence.`);
  }
  const output = extractOutput(body, request.protocol);
  if (!output.trim()) throw new Error('No supported text or structured deliverable was captured.');
  return { observation, output, costU: null, costStatus: 'not_recorded', taskSuccess: 'not_assessed' };
}

export function importAdvantageResult(record, { definedAt }) {
  if (record?.schemaVersion !== 1 || record.recordType !== 'fya-observed-agent-result'
      || record.observation?.version !== TRY_RESULT_VERSION) {
    throw new Error('Use a current FYA Download result JSON file.');
  }
  const request = record.request;
  if (request?.protocol !== 'mcp' || !request.tool || !object(request.arguments)) {
    throw new Error('Result-file import supports read-only MCP observations only; wallet hires use the receipt recording route.');
  }
  const agent = record.agent;
  if (!Number.isSafeInteger(agent?.chainId) || agent.chainId <= 0 || !/^\d+$/.test(agent?.tokenId ?? '')) {
    throw new Error('The result has no valid registry agent identity.');
  }
  const source = record.observation;
  const start = Date.parse(source.startedAt);
  const finish = Date.parse(source.finishedAt);
  const definition = Date.parse(definedAt);
  if (![start, finish, definition].every(Number.isFinite) || finish < start || start < definition) {
    throw new Error('The task must be defined before this observation started, with valid original timestamps.');
  }
  if (typeof source.runId !== 'string' || !source.runId.trim() || record.runId !== source.runId
      || !Number.isFinite(source.latencyMs) || source.latencyMs !== finish - start) {
    throw new Error('The original run identity or measured duration is missing.');
  }
  if (agent.endpointUsed && source.endpoint && agent.endpointUsed !== source.endpoint) {
    throw new Error('The result contains conflicting observed endpoints.');
  }
  if (source.protocol !== request.protocol || source.captureComplete !== true || record.response?.captureComplete !== true) {
    throw new Error('The result lacks a consistent complete protocol capture.');
  }
  const result = inspectAdvantageResult({ agent, request, body: record.response.body,
    httpStatus: source.transport?.status, endpoint: agent.endpointUsed ?? source.endpoint,
    runId: source.runId, startedAt: source.startedAt, finishedAt: source.finishedAt,
    latencyMs: source.latencyMs, captureComplete: true, phase: source.phase });
  return { ...result, agent, request, elapsedMs: source.latencyMs,
    sourceType: 'local-result-file', readOnly: true,
    limitation: 'Imported local observation, not a provider-signed attestation or paid-hire receipt.' };
}

export function formatAgentCost(run) {
  if (Number.isFinite(run?.costU) && run.costU >= 0) return `${run.costU} $U (reported)`;
  return run?.paid ? 'payment recorded; amount not recorded' : 'not recorded; no payment receipt attached';
}

export function hasQualityAssessment(task) {
  return [task?.quality?.agent, task?.quality?.manual].every((value) => Number.isInteger(value) && value >= 1 && value <= 5)
    && typeof task.quality.rationale === 'string' && task.quality.rationale.trim().length > 0;
}
