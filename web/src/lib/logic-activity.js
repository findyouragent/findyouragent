const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8.64e15;

/**
 * Classify the numeric uint256-seconds metric returned by the logic contract.
 * Zero means the contract has no timestamp, not that the wallet never acted.
 * Do not coerce missing values or strings into a recorded timestamp.
 */
export function logicActivityTimestamp(lastActive, { nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(lastActive) || lastActive < 0) return { status: 'unavailable' };
  if (lastActive === 0) return { status: 'none' };

  const milliseconds = lastActive * 1000;
  if (!Number.isFinite(nowMs) || milliseconds > MAX_DATE_MS || milliseconds > nowMs + FUTURE_TOLERANCE_MS) {
    return { status: 'unavailable' };
  }

  return { status: 'recorded', milliseconds, iso: new Date(milliseconds).toISOString() };
}
