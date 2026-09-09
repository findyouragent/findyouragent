const STORAGE_KEY = 'fya-hires';

function sameHire(left, right) {
  if (left.jobId != null && right.jobId != null && String(left.jobId) === String(right.jobId)) return true;
  const leftTx = left.createRequestTx ?? left.createTx;
  const rightTx = right.createRequestTx ?? right.createTx;
  return typeof leftTx === 'string' && typeof rightTx === 'string' && leftTx.toLowerCase() === rightTx.toLowerCase();
}

export function mergeHires(entry, entries) {
  return [
    { ...entries.find((hire) => sameHire(hire, entry)), ...entry },
    ...entries.filter((hire) => !sameHire(hire, entry)),
  ].slice(0, 50);
}

export function loadHires(storage) {
  try {
    const entries = JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(entries)
      ? entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      : [];
  } catch {
    return [];
  }
}

// Persistence is optional after a confirmed transaction. Failure here must
// never send a buyer back to the confirmation button for an already funded job.
export function saveHire(entry, storage) {
  try {
    const all = loadHires(storage);
    (storage ?? globalThis.localStorage).setItem(
      STORAGE_KEY,
      JSON.stringify(mergeHires(entry, all)),
    );
    return true;
  } catch {
    return false;
  }
}

export function updateHire(jobId, patch, storage) {
  try {
    const all = loadHires(storage).map((hire) => hire.jobId === jobId ? { ...hire, ...patch } : hire);
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

// React state is not an immediate mutex. Acquire the ref before run() can
// request accounts, then retain it through all async steps and their cleanup.
export function startHireOnce(inFlight, run) {
  if (inFlight.current) return null;
  inFlight.current = true;
  try {
    return Promise.resolve(run()).finally(() => { inFlight.current = false; });
  } catch (error) {
    inFlight.current = false;
    throw error;
  }
}
