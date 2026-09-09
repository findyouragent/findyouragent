import { assertProductionConfig } from './production-config.js';

// Validate during module loading, before index.js can initialize either store.
// Local development keeps its existing defaults and source-relative data path.
if (process.env.NODE_ENV === 'production') assertProductionConfig(process.env);

export const config = {
  port: Number(process.env.PORT || 8787),
  scan8004Base: 'https://api.8004scan.io/api/v1',
  scan8004Key: process.env.SCAN8004_API_KEY || '',
  bazaarBase: 'https://www.binance.com/bapi/ramp/v1/public/ramp/b402',
  bscRpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
  verdictTtlMs: Number(process.env.VERDICT_TTL || 600) * 1000,
  sweepEnabled: process.env.SWEEP_ENABLED !== 'false',
  // Pacing defaults to 3s with a registry key and 30s without one.
  // SWEEP_INTERVAL_MS overrides this; upstream quota headers remain authoritative.
  sweepIntervalMs: Number(
    process.env.SWEEP_INTERVAL_MS || (process.env.SCAN8004_API_KEY ? 3000 : 30000),
  ),

  // Discovery cycles through this many pages using validated BSC pagination.
  // Known-agent rechecks use a separate queue; discovery depth does not limit them.
  sweepPageCycle: Number(
    process.env.SWEEP_PAGE_CYCLE || (process.env.SCAN8004_API_KEY ? 1000 : 40),
  ),

  // Sample one in N discovery records without a declared callable protocol.
  // Callable records remain prioritized; this is not a uniform registry sample.
  sweepBaselineSample: Number(process.env.SWEEP_BASELINE_SAMPLE || 25),
  sweepPageSize: Number(
    process.env.SWEEP_PAGE_SIZE || (process.env.SCAN8004_API_KEY ? 100 : 25),
  ),
  probeTimeoutMs: 6000,
  userAgent: 'findyouragent-verify/0.1',

  // Use persistent storage to retain checks beyond the bundled startup seed.
  dataDir: process.env.DATA_DIR || null,

  // Default CORS is public; deployments may set one allowed site origin.
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',

  // Per-IP bounds for verification reads and calls to third-party agent servers.
  verifyRateMax: Number(process.env.VERIFY_RATE_MAX || 20),
  tryRateMax: Number(process.env.TRY_RATE_MAX || 10),
  // Activity uses the operator's RPC allowance and has its own request bound.
  activityRateMax: Number(process.env.ACTIVITY_RATE_MAX || 15),
  rateWindowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
};
