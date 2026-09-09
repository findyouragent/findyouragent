import { LOOPBACK_API, resolveApiBase } from '../api-base.js';
import { localeNumber } from './i18n/core.js';

export const SCAN_BASE = 'https://api.8004scan.io/api/v1';

// Explorer URLs use chain slugs; registry API requests use numeric chain IDs.
const CHAIN_SLUG = {
  1: 'ethereum',
  56: 'bsc',
  8453: 'base',
  42220: 'celo',
};

export function scanAgentUrl(chainId, tokenId) {
  const slug = CHAIN_SLUG[Number(chainId)];
  // Unknown chains link to the explorer index.
  return slug ? `https://8004scan.io/agents/${slug}/${tokenId}` : 'https://8004scan.io/agents';
}
// The app, docs and machine-readable files share the same production URL guard.
export const VERIFY_BASE = resolveApiBase(import.meta.env.VITE_VERIFY_API, import.meta.env.PROD);

// Local API links work for development but are not public integration URLs.
export const VERIFY_IS_LOCAL = LOOPBACK_API.test(VERIFY_BASE);

// Show the path alone for local or unconfigured builds; otherwise include the API base.
export function apiLabel(path) {
  return VERIFY_IS_LOCAL || !VERIFY_BASE ? path : `${VERIFY_BASE}${path}`;
}

export const CHAIN_ID = 56;
export const PAGE_SIZE = 25;

// The default tab leads with stored FYA verdicts. Other tabs use registry sorting.
export const TABS = [
  { key: 'verified', label: 'verified first', fromStore: true },
  { key: 'top', label: 'top ranked', sortBy: 'total_score' },
  { key: 'all', label: 'all', sortBy: 'created_at' },
  { key: 'new', label: 'newest', sortBy: 'created_at' },
];

// Localized display counts; renderers choose how to display the null unknown state.
export function formatCount(n) {
  return typeof n === 'number' && Number.isFinite(n) ? localeNumber(n) : null;
}

// Keep category keys aligned with server categorization and stored coverage.
export const JUDGED_CATEGORIES = ['rebalancing', 'grid', 'yield', 'health'];

// Shared category labels for the picker, footer and coverage tables.
export const CATEGORY_LABELS = {
  rebalancing: 'rebalancing',
  grid: 'grid trading',
  yield: 'yield optimisation',
  health: 'health factor monitoring',
};

// Coverage columns are successive subsets; both grids derive their columns here.
export const COVERAGE_COLUMNS = [
  { key: 'agents', label: 'placed', hint: 'agents we hold a current verdict for that place in this category' },
  { key: 'endpointProven', label: 'answered', hint: 'their declared endpoint responded when we probed it' },
  { key: 'served', label: 'serves it', hint: 'the endpoint listed a matching capability at check time; task execution was not assessed' },
  { key: 'verifiedLive', label: 'verified live', hint: 'answered at check time, with a qualifying supporting signal; matching capability records may share a publisher' },
];

// Primary categories precede general ones. Registry search uses semantic matches
// with keyword fallback and curated entries above them. Labels are shared.
export const CATEGORIES = [
  { key: 'all', label: 'all categories', searchTerm: null, semanticQuery: null },
  { key: 'rebalancing', label: CATEGORY_LABELS.rebalancing, searchTerm: 'rebalance', semanticQuery: 'manages LP ranges and resets liquidity positions automatically' },
  { key: 'grid', label: CATEGORY_LABELS.grid, searchTerm: 'grid', semanticQuery: 'places and manages automated grid trading orders' },
  { key: 'yield', label: CATEGORY_LABELS.yield, searchTerm: 'yield', semanticQuery: 'routes liquidity to the highest available APR yield' },
  { key: 'health', label: CATEGORY_LABELS.health, searchTerm: 'liquidation', semanticQuery: 'protects lending positions from liquidation health factor monitoring' },
  { key: 'trading', label: 'trading', searchTerm: 'trading', semanticQuery: 'trades tokens with signals and market analysis' },
  { key: 'research', label: 'research', searchTerm: 'research', semanticQuery: 'research data analysis monitoring agent' },
];

export const TIER_META = {
  verified_live: { label: 'live', dot: 'dot-live' },
  active: { label: 'active', dot: 'dot-stale' },
  registered: { label: 'registered', dot: 'dot-unproven' },
};
