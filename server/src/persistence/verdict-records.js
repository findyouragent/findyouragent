import { PersistenceError, replayJsonl } from './bounded-jsonl.js';

export const VERDICT_STATE_ROW = 'verdict-state-v1';

export function validateVerdictCheckpoint(row) {
  const fail = (detail) => {
    throw new PersistenceError(`Invalid ${VERDICT_STATE_ROW} checkpoint: ${detail}`, {
      code: 'PERSISTENCE_SCHEMA',
    });
  };
  if (!row || row.t !== VERDICT_STATE_ROW) fail('unsupported version');
  if (!/^\d+:\d+$/.test(row.key ?? '')) fail('invalid key');
  if (!row.latest || row.latest.key !== row.key) fail('latest verdict is missing or belongs to another key');
  if (!Array.isArray(row.history) || row.history.length > 50
    || row.history.some((check) => !check || check.key !== row.key)) fail('invalid retained history');
  if (!row.history.some((check) => `${check.key}|${check.ts}` === `${row.latest.key}|${row.latest.ts}`)) {
    fail('latest verdict is absent from retained history');
  }
  if (!Array.isArray(row.uptime) || row.uptime.length > 90) fail('invalid uptime aggregate');
  for (const entry of row.uptime) {
    const value = entry?.[1];
    if (!Array.isArray(entry) || !isCalendarDay(entry[0])
      || !value || !Number.isSafeInteger(value.n) || value.n < 0
      || !Number.isSafeInteger(value.ok) || value.ok < 0 || value.ok > value.n
      || !Number.isFinite(value.best)) fail('invalid uptime day');
  }
  if (!Number.isSafeInteger(row.checksRun) || row.checksRun < row.history.length || row.checksRun < 1) {
    fail('invalid all-time check count');
  }
  return row;
}

function isCalendarDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}

export function verdictFromStoredRow(row) {
  if (row?.t === VERDICT_STATE_ROW) return validateVerdictCheckpoint(row).latest;
  if (row?.t !== undefined) {
    throw new PersistenceError(`Unsupported verdict persistence row type: ${String(row.t)}`, {
      code: 'PERSISTENCE_SCHEMA',
    });
  }
  if (!row || !/^\d+:\d+$/.test(row.key ?? '')) {
    throw new PersistenceError('Invalid legacy verdict row identity', { code: 'PERSISTENCE_SCHEMA' });
  }
  return row;
}

export function rejectMalformedVerdictCheckpoint(error, line) {
  if (/"t"\s*:\s*"verdict-state/i.test(line)) {
    throw new PersistenceError(`Malformed versioned verdict checkpoint JSON: ${error.message}`, {
      code: 'PERSISTENCE_SCHEMA', cause: error,
    });
  }
}

/** Read the latest verdict from raw rows, checkpoint rows, and appended tails. */
export function readLatestVerdicts(filePath, options = {}) {
  const latest = new Map();
  const replay = replayJsonl(filePath, {
    maxBytes: options.maxBytes ?? 192 * 1024 * 1024,
    maxLineBytes: options.maxLineBytes ?? 4 * 1024 * 1024,
    chunkBytes: options.chunkBytes,
    fsImpl: options.fsImpl,
    onMalformed(error, line) {
      rejectMalformedVerdictCheckpoint(error, line);
      options.onMalformed?.(error, line);
    },
    onRecord(row) {
      const check = verdictFromStoredRow(row);
      const held = latest.get(check.key);
      if (!held || compareObservationTime(held, check) <= 0) latest.set(check.key, check);
    },
  });
  return { latest, ...replay };
}

function compareObservationTime(a, b) {
  const aTime = observationInstant(a);
  const bTime = observationInstant(b);
  if (aTime !== null && bTime !== null) return (aTime - bTime)
    || String(a.ts ?? '').localeCompare(String(b.ts ?? ''));
  if (aTime !== null) return 1;
  if (bTime !== null) return -1;
  return String(a?.ts ?? '').localeCompare(String(b?.ts ?? ''));
}

function observationInstant(check) {
  if (typeof check?.ts !== 'string' && typeof check?.ts !== 'number') return null;
  const time = new Date(check.ts).getTime();
  return Number.isFinite(time) ? time : null;
}
