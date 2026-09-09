import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Node converts overflowing timer delays to 1ms, which would turn a mistyped
// sweep interval into a busy worker and a rate-window cleanup into a hot loop.
const MAX_TIMER_MS = 2 ** 31 - 1;
const INTEGER_LIMITS = {
  PORT: 65535,
  VERDICT_TTL: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
  VERIFY_RATE_MAX: Number.MAX_SAFE_INTEGER,
  TRY_RATE_MAX: Number.MAX_SAFE_INTEGER,
  ACTIVITY_RATE_MAX: Number.MAX_SAFE_INTEGER,
  RATE_WINDOW_MS: MAX_TIMER_MS,
  SWEEP_INTERVAL_MS: MAX_TIMER_MS,
  SWEEP_PAGE_CYCLE: Math.floor(Number.MAX_SAFE_INTEGER / 100),
  SWEEP_BASELINE_SAMPLE: Number.MAX_SAFE_INTEGER,
  SWEEP_PAGE_SIZE: 100,
};

const ALLOWED_ORIGIN_ERROR = 'ALLOWED_ORIGIN must explicitly be * or a comma-separated list of canonical HTTP(S) origins without paths';

/**
 * Parse the CORS origin setting without retaining or reporting supplied values.
 * Whitespace around comma-separated members is formatting; whitespace inside a
 * member remains invalid because the browser Origin header is exact.
 */
export function parseAllowedOrigins(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0-\u001f\u007f]/.test(value)) {
    return { ok: false, error: ALLOWED_ORIGIN_ERROR };
  }
  const members = value.split(',').map((member) => member.trim());
  if (members.length === 1 && members[0] === '*') {
    return { ok: true, wildcard: true, origins: [] };
  }
  if (!members.length || members.some((member) => !member || member === '*')) {
    return { ok: false, error: ALLOWED_ORIGIN_ERROR };
  }

  const origins = [];
  for (const member of members) {
    let url;
    try {
      url = new URL(member);
    } catch {
      return { ok: false, error: ALLOWED_ORIGIN_ERROR };
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== member) {
      return { ok: false, error: ALLOWED_ORIGIN_ERROR };
    }
    origins.push(member);
  }
  return { ok: true, wildcard: false, origins };
}

/** Pure validation: no file access, network calls, credentials, or value dumps. */
export function productionConfigErrors(env) {
  const errors = [];
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production');

  const dataDir = env.DATA_DIR;
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir !== dataDir.trim()
      || /[\0\r\n]/.test(dataDir) || !path.isAbsolute(dataDir)) {
    errors.push('DATA_DIR must be an absolute path to persistent storage');
  }

  // CORS is intentionally public when the operator explicitly selects '*'.
  // Fixed values must match the Origin header form, including no trailing '/'.
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGIN);
  if (!allowedOrigins.ok) errors.push(allowedOrigins.error);

  for (const [name, max] of Object.entries(INTEGER_LIMITS)) {
    const value = env[name];
    if (value === undefined) continue; // Keep the established development defaults.
    const parsed = Number(value);
    if (typeof value !== 'string' || !/^\d+$/.test(value)
        || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      errors.push(`${name} must be a decimal integer between 1 and ${max}`);
    }
  }

  if (env.SWEEP_ENABLED !== undefined && !['true', 'false'].includes(env.SWEEP_ENABLED)) {
    errors.push('SWEEP_ENABLED must be true or false');
  }
  return errors;
}

export function assertProductionConfig(env) {
  const errors = productionConfigErrors(env);
  if (!errors.length) return;
  const error = new Error(`Production configuration is invalid:\n${errors.map((message) => `- ${message}`).join('\n')}`);
  error.code = 'PRODUCTION_CONFIG';
  throw error;
}

// The CLI validates only already-injected variables. It deliberately does not
// load local dotenv files, open a data directory, or contact a provider.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertProductionConfig(process.env);
    console.log('Production configuration syntax is valid. Persistent volume, access, and upstream readiness require deployment checks.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
