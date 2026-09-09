import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createStore } from '../src/store.js';

// Offline only: generated names, a temporary store, no production file or
// network call. Each record uses the verifier's current 120-name upper bound.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-search-bench-'));
const store = createStore(path.join(dir, 'synthetic.jsonl'), {
  seedFile: null,
  maxFileBytes: 64 * 1024 * 1024,
  compactAtBytes: 48 * 1024 * 1024,
  maxAgents: 2_000,
});
const sizes = [100, 500, 1_000];
const query = Array.from({ length: 16 }, (_, i) => `capability${i}`).join(' ');

function percentile(samples, fraction) {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

try {
  let seeded = 0;
  for (const size of sizes) {
    while (seeded < size) {
      seeded += 1;
      const servedNames = Array.from({ length: 120 }, (_, slot) => (
        `capability${slot % 32}_fixture_${seeded}_slot_${slot}`
      ));
      store.record(`56:${1_000_000 + seeded}`, {
        computedAt: Date.now(),
        tier: 'active',
        formulaVersion: 'benchmark-fixture',
        endpointProven: true,
        servedNames,
        name: `Synthetic ${seeded}`,
        categories: [],
        proofs: [],
      });
    }

    store.searchServed(query, 25); // JIT warm-up outside the sample.
    const samples = [];
    for (let run = 0; run < 7; run += 1) {
      const started = performance.now();
      store.searchServed(query, 25);
      samples.push(performance.now() - started);
    }
    console.log(JSON.stringify({
      syntheticAgents: size,
      servedNamesPerAgent: 120,
      distinctQueryTerms: 16,
      runs: samples.length,
      medianMs: Number(percentile(samples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2)),
    }));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
