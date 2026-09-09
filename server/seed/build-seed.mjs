/**
 * Build the committed store seed from a verdict snapshot.
 *
 *   node seed/build-seed.mjs
 *
 * The seed exists so a fresh host does not boot telling its first visitor that
 * nothing has ever been checked. It is a BOOTSTRAP, not an archive: everything
 * dropped here is recomputed the moment an agent is checked again.
 *
 * The seed policy is deliberately small and stable:
 *
 *   Keep only rows produced by the current formula.
 *   Remove transient fields that contain contract addresses.
 *   Include every row with evidence, then deterministic key-ordered rows
 *   without evidence up to the byte budget.
 *
 * The background sweep refreshes this bootstrap data after startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMULA_VERSION } from '../src/verify/score.js';
import { readLatestVerdicts } from '../src/persistence/verdict-records.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultStorePath = path.join(here, '..', 'data', 'verdicts.jsonl');
const defaultSeedPath = path.join(here, 'verdicts.seed.jsonl');

// Reads legacy raw rows, compacted checkpoint envelopes, and any raw tail
// appended after the checkpoint. Invalid checkpoint schemas fail closed;
// malformed legacy/torn JSON lines retain the tool's historical skip behavior.

// Evidence, in the three shapes a stored row can carry it: a live verdict, an
// endpoint that answered, or a list of capabilities the endpoint actually
// served. servedNames is the one the search matches on, so a seed without it
// is a seed the search cannot read.
const carriesEvidence = (r) =>
  r.tier === 'verified_live'
  || r.endpointProven === true
  || (Array.isArray(r.servedNames) && r.servedNames.length > 0);

// eslint-disable-next-line no-unused-vars
const strip = ({ bap578, tryExample, ...rest }) => rest;
const byKey = (a, b) => a.key.localeCompare(b.key, 'en', { numeric: true });

export const BUDGET_BYTES = 1024 * 1024;
const lineBytes = (row) => Buffer.byteLength(`${JSON.stringify(row)}\n`, 'utf8');

export function selectSeedRows(latest, { budgetBytes = BUDGET_BYTES, formulaVersion = FORMULA_VERSION } = {}) {
  const candidates = [...latest.values()].filter((r) => r.formulaVersion === formulaVersion);
  const evidence = candidates.filter(carriesEvidence).map(strip).sort(byKey);
  let spent = evidence.reduce((total, row) => total + lineBytes(row), 0);
  if (spent > budgetBytes) throw new Error(`Evidence rows exceed the ${budgetBytes}-byte seed budget.`);

  const filler = [];
  for (const row of candidates.filter((r) => !carriesEvidence(r)).sort(byKey)) {
    const stripped = strip(row);
    const cost = lineBytes(stripped);
    if (spent + cost > budgetBytes) break;
    filler.push(stripped);
    spent += cost;
  }
  return { candidates, rows: [...evidence, ...filler].sort(byKey) };
}

export function buildSeed(sourcePath = defaultStorePath, outputPath = defaultSeedPath) {
  const { latest } = readLatestVerdicts(sourcePath);
  const { candidates, rows } = selectSeedRows(latest);

  // Build and validate the complete seed in memory before replacing the committed snapshot.
  const blob = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const addresses = blob.match(/0x[a-fA-F0-9]{40}/g) ?? [];
  if (addresses.length) {
    throw new Error(`Refusing to write: ${addresses.length} contract address(es) in the seed (${[...new Set(addresses)].join(', ')}).`);
  }
  const bytes = Buffer.byteLength(blob, 'utf8');
  if (bytes > BUDGET_BYTES) throw new Error(`Refusing to write ${bytes} bytes: seed budget is ${BUDGET_BYTES}.`);
  fs.writeFileSync(outputPath, blob);
  return { latest, candidates, rows, blob, bytes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultStorePath;
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : defaultSeedPath;
  const { latest, candidates, rows, bytes } = buildSeed(sourcePath, outputPath);

  const tiers = {};
  let searchable = 0;
  for (const r of rows) {
    tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
    if (Array.isArray(r.servedNames) && r.servedNames.length) searchable += 1;
  }

  console.log(`seeded ${rows.length} agents at formula v${FORMULA_VERSION}`);
  console.log(`  dropped ${latest.size - candidates.length} superseded, ${candidates.length - rows.length} carrying no evidence`);
  console.log(`tiers: ${JSON.stringify(tiers)}`);
  console.log(`searchable rows (servedNames present): ${searchable}${searchable ? '' : '  <- the search will answer nothing until the sweep runs'}`);
  console.log(`size: ${(bytes / 1024).toFixed(1)}KB`);
  console.log('addresses: 0 (checked before writing)');
}
