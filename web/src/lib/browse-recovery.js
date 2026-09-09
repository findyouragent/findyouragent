const identity = (row) => `${Number(row.chain_id)}:${BigInt(row.token_id)}`;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function registryFailureMessage(error, savedKind = null) {
  const message = error?.code === 'registry-service-outdated'
    ? 'This FYA service does not support registry browsing yet.'
    : String(error?.message || 'Registry browsing is unavailable. Please try again.');
  const saved = {
    checked: 'FYA’s saved checked agents remain available below. Newest registrations and pagination could not load.',
    capability: 'Matching capabilities from FYA’s saved checks remain available below. Registry matches and pagination could not load.',
    curated: 'Reviewed agents remain available below. Registry matches and pagination could not load.',
  }[savedKind];
  return saved ? `${message} ${saved}` : message;
}

// Settle independent saved evidence even if the registry fails immediately.
// Publish it before waiting for the optional registry tail.
export async function recoverRegistryRows({ registry, saved, kind, onSaved = () => {} }) {
  const received = Promise.resolve(registry).then((value) => ({ value }), (failure) => ({ failure }));
  const rows = await Promise.resolve(saved).catch(() => []);
  if (rows.length) onSaved(rows);
  const result = await received;
  if (result.failure && !rows.length) throw result.failure;
  const listed = result.value ?? { agents: [], pagination: null };
  const byKey = new Map(listed.agents.map((row) => [identity(row), row]));
  const leading = rows.map((row) => {
    const registryRow = byKey.get(identity(row));
    return kind === 'capability' && registryRow
      ? { ...registryRow, ...row, name: row.name ?? registryRow.name }
      : row;
  });
  const seen = new Set(leading.map(identity));
  return {
    ...listed,
    agents: [...leading, ...listed.agents.filter((row) => !seen.has(identity(row)))],
    verifiedCount: kind === 'checked' ? leading.length : 0,
    capabilityHits: kind === 'capability' ? leading.length : 0,
    registryFailure: result.failure ? registryFailureMessage(result.failure, kind) : null,
  };
}

export function bscCountFromStats(stats, retrievedAt = new Date().toISOString()) {
  const chain = stats?.chain_stats?.find((row) => Number(row.chain_id) === 56);
  return count(chain?.total_agents)
    ? { total: chain.total_agents, source: 'statistics', retrievedAt }
    : null;
}

// This metadata is issued by fetchRegistryPage only AFTER list validation, and
// only for an unfiltered BSC query. Never infer a corpus total from search pages.
export function bscCountFromList(result) {
  const observed = result?.registryCount;
  return observed?.chainId === 56 && observed.source === 'unfiltered-list'
    && count(observed.total) && Number.isFinite(Date.parse(observed.retrievedAt))
    ? { total: observed.total, source: observed.source, retrievedAt: observed.retrievedAt }
    : null;
}

export function newestRegistryCount(current, candidate) {
  if (!candidate) return current;
  return !current || Date.parse(candidate.retrievedAt) >= Date.parse(current.retrievedAt) ? candidate : current;
}
