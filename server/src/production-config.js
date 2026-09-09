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
  // A fixed value must match the Origin header form, including no trailing '/'.
  const origin = env.ALLOWED_ORIGIN;
  if (origin !== '*') {
    let valid = false;
    try {
      const url = new URL(origin);
      valid = typeof origin === 'string' && ['http:', 'https:'].includes(url.protocol)
        && url.origin === origin;
    } catch { /* Report only the variable name, never a supplied URL. */ }
    if (!valid) errors.push('ALLOWED_ORIGIN must explicitly be * or one canonical HTTP(S) origin without a path');
  }

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
