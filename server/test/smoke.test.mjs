import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = new URL('./fixtures/smoke-fetch.mjs', import.meta.url).href;
const scenarios = [
  ['good', 0, 'reviewed task result'],
  ['good', 0, 'try relay returns terminal output', false],
  ['invalid-sample-chain', 1, 'SAMPLE_AGENT must identify a BSC agent', true, '1/45422'],
  ['invalid-sample-shape', 1, 'SAMPLE_AGENT must identify a BSC agent', true, '56/45422/extra'],
  ['registry-wrong-chain', 1, 'registry rows do not identify numeric BSC agents'],
  ['category-wrong-chain', 1, 'registry rows do not identify numeric BSC agents'],
  ['nameplate-wrong-chain', 1, 'registry rows do not identify numeric BSC agents'],
  ['registry-bad-token', 1, 'registry rows do not identify numeric BSC agents'],
  ['registry-no-source', 1, 'registry response lacks 8004scan provenance'],
  ['registry-no-pagination', 1, 'registry pagination is missing or inconsistent'],
  ['registry-page-mismatch', 1, 'registry pagination is missing or inconsistent'],
  ['registry-limit-mismatch', 1, 'registry pagination is missing or inconsistent'],
  ['registry-invalid-total', 1, 'registry pagination is missing or inconsistent'],
  ['registry-has-more', 1, 'registry pagination is missing or inconsistent'],
  ['registry-short-page', 1, 'registry pagination is missing or inconsistent'],
  ['registry-empty', 1, 'no BSC agent rows returned'],
  ['registry-ambiguous-gateway', 1, 'HTTP 502'],
  ['registry-wrong-source', 1, 'HTTP 503'],
  ['registry-unexpected-error', 1, 'HTTP 504'],
  ['registry-invalid-response', 1, 'HTTP 502'],
  ['registry-internal-error', 1, 'HTTP 500'],
  ['registry-non-json', 1, 'HTTP 502'],
  ['registry-routes-missing', 1, 'Update or restart the backend configured in the frontend'],
  ['registry-stats-unavailable', 2, 'registry statistics'],
  ['registry-stats-ambiguous', 1, 'HTTP 502'],
  ['registry-stats-wrong-source', 1, 'registry statistics lack 8004scan provenance'],
  ['registry-stats-missing-bsc', 1, 'registry statistics omit the requested BSC inventory'],
  ['registry-stats-invalid-count', 1, 'invalid chain stats'],
  ['verification-ambiguous', 1, 'HTTP 502'],
  ['interface-error', 1, 'interface HTTP 502: error=mcp-discovery-failed; code=UPSTREAM_TIMEOUT'],
  ['interface-error-legacy', 1, 'interface HTTP 502: error=Legacy discovery rejected; code=-32603'],
  ['interface-error-unstructured', 1, 'interface HTTP 502: no structured error details'],
  ['empty-history', 1, 'no stored checks'],
  ['zero-checks', 1, 'no positive, valid check counts'],
  ['empty-search', 1, 'nonempty capability search'],
  ['own-mcp-error', 1, 'mcp-tool-error'],
  ['mcp-error', 1, 'mcp-tool-error'],
  ['rpc-error', 1, 'rpc-or-relay-error'],
  ['empty-reply', 1, 'empty-mcp-result'],
  ['wrong-chain', 1, 'reviewed task checks failed'],
  ['wrong-inputs', 1, 'different preset inputs'],
  ['partial-capture', 1, 'full task response was not captured'],
  ['missing-observation', 1, 'observation is missing'],
  ['missing-observation', 1, 'observation is missing', false],
  ['old-observation', 1, 'unsupported version'],
  ['observation-id', 1, 'observation identity'],
  ['observation-endpoint', 1, 'observation identity'],
  ['observation-time', 1, 'inconsistent timestamps'],
  ['observation-capture', 1, 'observation does not confirm full capture'],
  ['observation-outcome', 1, 'observation classification disagrees'],
  ['observation-transport', 1, 'observation classification disagrees'],
  ['observation-task', 1, 'observation task assessment disagrees'],
  ['observation-checks', 1, 'observation task assessment disagrees'],
  ['observation-criteria', 1, 'observation task assessment disagrees'],
  ['pending', 2, 'pending'],
  ['payment', 2, 'Payment requested'],
  ['registry-unavailable', 2, 'Smoke checks incomplete'],
  ['registry-throttled', 2, 'x-ratelimit-limit=42'],
  ['registry-throttled-direct', 2, 'request throttled'],
  ['no-preset', 2, 'No compatible reviewed read-only task'],
];
for (const [scenario, code, message, release = true, sample = '56/45422'] of scenarios) {
  const result = spawnSync(process.execPath, ['--import', fixture, 'smoke.js', ...(release ? ['--release'] : [])], {
    cwd, encoding: 'utf8', env: { ...process.env, VERIFY_BASE: 'http://smoke.test', SAMPLE_AGENT: sample, SMOKE_FIXTURE: scenario }, timeout: 10000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, code, `${scenario}: ${output}`);
  assert.ok(output.includes(message), `${scenario}: ${output}`);
  if (scenario.startsWith('interface-error')) {
    assert.match(result.stdout, /1 failed, 0 incomplete/, 'Ambiguous discovery failure stays a failure');
    const diagnostic = result.stdout.split('\n').find((line) => line.includes('interface HTTP 502'));
    assert.ok(diagnostic.length < 680, 'Interface error output is bounded');
    assert.ok(!/https?:|provider\.test|fixture-(?:user|password|url-secret|bearer-secret|api-secret|query-secret|tail-secret|raw-secret)/.test(diagnostic), 'Interface diagnostics omit URLs and credentials');
    if (scenario === 'interface-error') {
      assert.match(diagnostic, /source=agent; phase=initialize; upstreamStatus=504; retryable=true/);
      assert.match(diagnostic, /detail=Timed out at \[redacted URL\]/);
    }
  }
  if (scenario.startsWith('registry-throttled')) {
    assert.match(result.stdout, /retry-after=13/);
    assert.match(result.stdout, /x-ratelimit-remaining=0/);
    assert.match(result.stdout, /No automatic retry/);
    assert.ok(!result.stdout.includes('180 req/min'), 'Quota is read from this response, not hardcoded');
  }
}

const curationScenarios = [
  ['good', 0, 'grid: #123 Fixture Agent'],
  ['registry-empty', 0, 'grid: none yet'],
  ['registry-unavailable', 1, 'Registry search for "grid" failed (HTTP 502, registry-unavailable)'],
  ['registry-throttled', 1, 'Retry-After: 13'],
  ['registry-throttled-direct', 1, 'Retry-After: 13'],
  ['registry-non-json', 1, 'Registry search for "grid" failed (HTTP 502)'],
  ['registry-wrong-chain', 1, 'invalid BSC rows, provenance or pagination'],
  ['registry-no-source', 1, 'invalid BSC rows, provenance or pagination'],
  ['registry-no-pagination', 1, 'invalid BSC rows, provenance or pagination'],
  ['registry-has-more', 1, 'invalid BSC rows, provenance or pagination'],
  ['registry-short-page', 1, 'invalid BSC rows, provenance or pagination'],
  ['verification-unavailable', 1, 'Verification for #123 failed (HTTP 502, registry-unavailable)'],
  ['verification-ambiguous', 1, 'Verification for #123 failed (HTTP 502)'],
];
for (const [scenario, code, message] of curationScenarios) {
  const result = spawnSync(process.execPath, ['--import', fixture, 'curate.js', 'grid'], {
    cwd, encoding: 'utf8', env: { ...process.env, VERIFY_BASE: 'http://smoke.test', LIMIT: '2', PACE_MS: '0', SMOKE_FIXTURE: scenario }, timeout: 10000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, code, `curation ${scenario}: ${output}`);
  assert.ok(output.includes(message), `curation ${scenario}: ${output}`);
  if (code !== 0) {
    assert.ok(!/pin-worthy|none yet|export const CURATED/.test(output), 'Failed reads must not produce an empty or partial shortlist');
  }
}
console.log(`${scenarios.length} smoke and ${curationScenarios.length} curation CLI checks passed with network disabled`);
