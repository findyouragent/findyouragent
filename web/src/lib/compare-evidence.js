import { findErc8183Service } from './erc8183.js';
import { hasAgentMetadata } from './agent-metadata.js';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const dateMs = (value) => typeof value === 'string' ? Date.parse(value) : NaN;

export function comparisonCheckedAt(verdict) {
  if (Number.isFinite(dateMs(verdict?.computedAt))) return verdict.computedAt;
  return Number.isFinite(dateMs(verdict?.checkedAt)) ? verdict.checkedAt : null;
}

export function comparisonColumn(key) {
  return {
    key, agent: null, verdict: null, service: null, verdictSource: null,
    agentLoading: false, verdictLoading: false, metaLoading: false,
    agentError: null, verdictError: null, metaError: null, retrying: false,
  };
}

export function reconcileComparison(keys, previous) {
  return keys.map((key) => previous.find((column) => column.key === key) ?? comparisonColumn(key));
}

export function comparisonName(column) {
  return (typeof column.agent?.name === 'string' && column.agent.name)
    || (typeof column.verdict?.name === 'string' && column.verdict.name)
    || `agent #${column.key.split(':')[1]}`;
}

function validVerdict(key, verdict) {
  if (!object(verdict) || verdict.error || !['registered', 'active', 'verified_live'].includes(verdict.tier)
    || !comparisonCheckedAt(verdict)) return false;
  // The saved endpoint is keyed by the requested identity. Also reject an
  // explicitly conflicting identity if an API version echoes one in the body.
  if (typeof verdict.agentId === 'string' && /^\d+:\d+$/.test(verdict.agentId) && verdict.agentId !== key) return false;
  return true;
}

export function applySavedComparison(column, saved) {
  if (!validVerdict(column.key, saved)) return column;
  if (column.verdict && dateMs(comparisonCheckedAt(column.verdict)) >= dateMs(comparisonCheckedAt(saved))) return column;
  return { ...column, verdict: saved, verdictSource: 'saved' };
}

function successfulVerdict(column, verdict) {
  // A slower cache read must not replace a newer check already displayed.
  const older = column.verdict && dateMs(comparisonCheckedAt(column.verdict)) > dateMs(comparisonCheckedAt(verdict));
  return {
    ...column,
    ...(older ? {} : { verdict, verdictSource: verdict.cached || verdict.fromStore ? 'saved' : 'check' }),
    verdictLoading: false, verdictError: null,
  };
}

async function bounded(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The read took too long.')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function loadSavedComparison(keys, api, onSaved, timeoutMs = 8000) {
  try {
    const agents = keys.map((key) => {
      const [chain_id, token_id] = key.split(':');
      return { chain_id, token_id };
    });
    const known = await bounded(() => api.getKnownVerdicts(agents), timeoutMs);
    for (const key of keys) if (validVerdict(key, known?.[key])) onSaved(key, known[key]);
  } catch {
    // Missing stored data never creates a negative finding about the agent.
  }
}

export function unavailableComparisonParts(column) {
  return ['agent', 'verdict', 'meta'].filter((part) => Boolean(column[`${part}Error`]) && !column[`${part}Loading`]);
}

// Every update is a function of the current column. Parallel saved/check
// reads and manual recovery can add evidence, without erasing another result.
export async function loadComparison({ key, api, parts = ['agent', 'verdict', 'meta'], onPatch, timeoutMs = 30_000 }) {
  const [chainId, tokenId] = key.split(':');
  onPatch((column) => ({
    ...column,
    ...Object.fromEntries(parts.flatMap((part) => [[`${part}Loading`, true], [`${part}Error`, null]])),
  }));
  await Promise.all(parts.map(async (part) => {
    try {
      if (part === 'agent') {
        const agent = await bounded(() => api.getAgentDetail(chainId, tokenId), timeoutMs);
        if (!object(agent) || String(agent.chain_id) !== chainId || String(agent.token_id) !== tokenId) {
          throw new Error('The registry did not return the requested agent.');
        }
        onPatch((column) => ({ ...column, agent, agentLoading: false, agentError: null }));
      } else if (part === 'verdict') {
        const verdict = await bounded(() => api.getVerdict(chainId, tokenId), timeoutMs);
        if (!validVerdict(key, verdict)) throw new Error('The check did not return a dated verdict for this agent.');
        onPatch((column) => successfulVerdict(column, verdict));
      } else if (part === 'meta') {
        const data = await bounded(() => api.getAgentMeta(chainId, tokenId), timeoutMs);
        if (!hasAgentMetadata(data)) throw new Error('The hire menu could not be read.');
        onPatch((column) => ({ ...column, service: findErc8183Service(data.meta), metaLoading: false, metaError: null }));
      }
    } catch (error) {
      const message = part === 'agent'
        ? error?.notFound ? 'The registry reports this entry was not found.' : 'Registry details are unavailable.'
        : part === 'verdict'
          ? error?.throttled ? 'Fresh checks are temporarily throttled.' : 'A fresh check is unavailable.'
          : 'The hire menu is unavailable.';
      onPatch((column) => ({
        ...column, [`${part}Loading`]: false,
        [`${part}Error`]: { message, notFound: Boolean(error?.notFound), throttled: Boolean(error?.throttled) },
      }));
    }
  }));
}
