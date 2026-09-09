import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyTryResult, TRY_RESULT_VERSION } from '../../server/src/try-result.js';
import { getTaskPresets, assessTaskResult } from '../../server/src/task-presets.js';

// Reclassify published raw output, rather than trusting a success label in the
// manifest. The suite is offline and never calls a provider or connects a wallet.
const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = path.join(root, 'web/public');
const index = JSON.parse(fs.readFileSync(path.join(publicRoot, 'evidence/index.json'), 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readAsset = (asset) => {
  assert.match(asset.href, /^\/evidence\/[a-zA-Z0-9/_.-]+$/);
  assert.equal(asset.href.includes('..'), false, 'published links cannot escape the evidence directory');
  const bytes = fs.readFileSync(path.join(publicRoot, asset.href));
  assert.equal(bytes.length, asset.bytes, `${asset.href}: byte count`);
  assert.equal(sha256(bytes), asset.sha256, `${asset.href}: SHA-256`);
  return bytes;
};

test('range assessment archive preserves downloaded data and RPC response hashes', () => {
  const supplement = JSON.parse(readAsset(index.rangeAssessment));
  const recordAsset = supplement.artifacts.find(asset => asset.href.endsWith('/live-result.json'));
  const record = JSON.parse(readAsset(recordAsset));
  for (const artifact of supplement.artifacts) readAsset(artifact);
  assert.equal(record.request.presetId, 'pancake-bsc-range-assessment');
  assert.deepEqual(record.request.arguments, { tokenId: '7337249', chainId: 56, driftToleranceBps: 0 });
  assert.equal(record.observation.task.status, supplement.outcome.task);
  assert.deepEqual(record.observation.task.corroboration.block, supplement.outcome.block);
  const corroboration = record.observation.task.corroboration;
  assert.equal(corroboration.status, 'passed');
  assert.ok(corroboration.checks.every(check => check.status === 'passed'));
  for (const captured of corroboration.evidence) assert.equal(sha256(captured.responseText), captured.sha256);
  const provider = record.response.body.result.structuredContent;
  assert.equal(provider.blockNumber, corroboration.block.number);
  assert.equal(provider.facts.pool.tick, corroboration.facts.pool.tick);
  assert.equal(provider.facts.position.liquidity, corroboration.facts.position.liquidity);
  assert.equal(supplement.qualification.execution, false);
});
const walk = (value, visit) => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { visit(key, child); walk(child, visit); }
};

function validateRecord(record, entry) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.recordType, 'fya-observed-agent-result');
  assert.equal(record.agent.chainId, 56);
  assert.equal(record.agent.chainId, entry.provider.chainId);
  assert.equal(record.agent.tokenId, entry.provider.tokenId);
  assert.equal(record.agent.endpointUsed, entry.provider.endpointUsed);
  assert.equal(record.observation.endpoint, record.agent.endpointUsed);
  const endpoint = new URL(record.agent.endpointUsed);
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.hostname, 'erc8004.heyanon.ai');
  assert.equal(endpoint.username + endpoint.password + endpoint.search, '');
  assert.equal(record.request.protocol, 'mcp');
  assert.equal(record.observation.protocol, record.request.protocol);
  assert.equal(record.observation.phase, 'tools/call');
  assert.equal(record.observation.version, TRY_RESULT_VERSION);
  assert.match(record.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(record.observation.runId, record.runId);
  const start = Date.parse(record.observation.startedAt);
  const end = Date.parse(record.observation.finishedAt);
  assert.equal(new Date(start).toISOString(), record.observation.startedAt);
  assert.equal(new Date(end).toISOString(), record.observation.finishedAt);
  assert.equal(record.observation.checkedAt, record.observation.finishedAt);
  assert.ok(end >= start);
  assert.equal(record.observation.latencyMs, end - start);
  assert.equal(record.observation.captureComplete, true);
  assert.equal(record.response.captureComplete, true);
  const preset = getTaskPresets({ ...record.agent, tools: [] }).find((p) => p.id === record.request.presetId);
  assert.ok(preset, 'each recorded task must still have a reviewed definition');
  assert.equal(record.request.presetId, entry.id);
  assert.equal(record.request.presetVersion, preset.version);
  assert.equal(record.request.tool, preset.tool);
  assert.equal(record.request.inputKind, 'public-fixture');
  assert.deepEqual(record.request.arguments, preset.args);
  assert.deepEqual(entry.request, record.request);
  assert.deepEqual(entry.observation, record.observation);
  const classified = classifyTryResult({ ...record.observation, httpStatus: record.observation.transport.status, body: record.response.body });
  classified.task = assessTaskResult(preset, classified, record.response.body);
  assert.deepEqual(record.observation, classified, 'canonical observation must match fresh classification and task checks');
  assert.equal(classified.outcome, 'response_received');
  assert.equal(classified.task.status, 'passed');
  assert.ok(classified.task.checks.length > 0 && classified.task.checks.every((check) => check.passed === true));
  assert.equal(entry.provenance.captureRevision, null, 'a missing historical revision must stay unknown');
  assert.equal(entry.provenance.originalBytesPreserved, true);
  assert.equal(entry.reproduce.request.method, 'POST');
  assert.equal(entry.reproduce.request.path, `/api/try/56/${record.agent.tokenId}`);
  assert.deepEqual(entry.reproduce.request.body, { presetId: preset.id });
  assert.ok(entry.limits.includes(preset.limitation));
  assert.ok(entry.limits.includes(record.limitations));
  walk(record, (key) => assert.doesNotMatch(key, /^(?:authorization|cookie|set-cookie|api[-_]?key|private[-_]?key|password|secret|access[-_]?token|payment|paymentReceipt|signature|headers)$/i));
}

test('manifest distinguishes developer QA, paid hires, deployment and independent suppliers', () => {
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.qualification.environment, 'local-development');
  assert.equal(index.qualification.evidenceKind, 'development-integration-qa');
  assert.equal(index.qualification.paidHireEvidence, false);
  assert.equal(index.qualification.deployedReleaseEvidence, false);
  assert.equal(index.qualification.independentBenchmarkEvidence, false);
  assert.match(index.selection, /not an exhaustive run history/);
  assert.match(index.rights, /does not relicense third-party/);
  assert.equal(index.providerGroups.length, 1);
  const groups = new Map(index.providerGroups.map((g) => [g.id, g]));
  assert.equal(new Set(index.records.map((r) => r.id)).size, index.records.length);
  for (const entry of index.records) assert.ok(groups.get(entry.provider.groupId)?.memberIds.includes(`${entry.provider.chainId}:${entry.provider.tokenId}`));
  assert.match(index.providerGroups[0].basis, /not three independent providers/);
});

for (const entry of index.records) {
  test(`${entry.id}: raw bytes, exact identity, inputs, canonical times and output checks agree`, () => {
    validateRecord(JSON.parse(readAsset(entry.rawCapture)), entry);
  });
}

test('altered output cannot keep a passed label even if its metadata and hash are rewritten', () => {
  const entry = index.records.find((r) => r.id === 'pancake-bsc-lp-position');
  for (const alter of [
    (r) => { r.response.body.result.isError = true; },
    (r) => { r.response.body.result.structuredContent.data.positions[0].positionId = '1'; },
    (r) => { r.request.arguments.lpPositions[0].chainName = 'ethereum'; },
    (r) => { r.observation.finishedAt = r.observation.startedAt; },
    (r) => { r.observation.captureComplete = false; },
    (r) => { r.observation.transport = { status: 402, ok: false, received: true }; },
    (r) => { r.observation.endpoint = 'https://another-provider.example/mcp'; },
  ]) {
    const record = JSON.parse(readAsset(entry.rawCapture));
    alter(record);
    const changed = structuredClone(entry);
    changed.observation = structuredClone(record.observation);
    changed.request = structuredClone(record.request);
    assert.throws(() => validateRecord(record, changed));
  }
});

test('later failed release excerpt retains incomplete checks and dated local provenance', () => {
  const release = JSON.parse(readAsset(index.reliability));
  assert.equal(release.recordType, 'fya-development-release-check-excerpt');
  assert.equal(release.status, 'failed');
  assert.equal(index.reliability.status, release.status);
  assert.equal(index.reliability.observedDate, release.observedDate);
  assert.equal(release.environment.kind, 'local-development');
  assert.equal(release.startedAt, null);
  assert.equal(release.finishedAt, null);
  assert.equal(release.captureRevision, null);
  assert.equal(release.paidHireEvidence, false);
  assert.equal(release.deployedReleaseEvidence, false);
  assert.match(release.observedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(release.dateBasis, /did not record exact/);
  assert.match(release.sourceLog.sha256, /^[a-f0-9]{64}$/);
  assert.equal(release.sourceLog.published, false);
  const counts = {
    passed: release.checks.filter((c) => c.status === 'pass').length,
    failed: release.checks.filter((c) => c.status === 'fail').length,
    incomplete: release.checks.filter((c) => c.status === 'incomplete').length,
  };
  assert.deepEqual(release.counts, counts);
  assert.deepEqual(index.reliability.counts, counts);
  assert.ok(counts.failed > 0 && counts.incomplete > 0);
  assert.match(release.conclusion, /Earlier successful task captures do not pass this later release gate/);
});

test('registry owner evidence is scoped to the included raw record', () => {
  const source = index.sources.find((s) => s.href === index.providerGroups[0].observedRegistryOwner.evidenceHref);
  const record = JSON.parse(readAsset(source));
  const claim = index.providerGroups[0].observedRegistryOwner;
  assert.equal(record.chain_id, claim.chainId);
  assert.equal(record.token_id, claim.tokenId);
  assert.equal(record.owner_address, claim.address);
  assert.equal(record.services.mcp.endpoint, index.records.find((r) => r.provider.tokenId === claim.tokenId).provider.endpointUsed);
});

test('implementation snapshots have hashes and still match the corresponding source', () => {
  const normalizeLines = (bytes) => bytes.toString('utf8').replace(/\r\n/g, '\n');
  for (const source of index.implementationSources) {
    assert.equal(source.kind, 'implementation-reference');
    assert.match(source.sourcePath, /^server\/(?:src|test)\/[a-zA-Z0-9/_.-]+$/);
    assert.equal(source.sourcePath.includes('..'), false);
    const published = readAsset(source);
    const current = fs.readFileSync(path.join(root, source.sourcePath));
    assert.equal(sha256(normalizeLines(published)), sha256(normalizeLines(current)), `${source.sourcePath}: refresh the public source snapshot and its digest after implementation changes`);
    assert.match(source.note, /not the recorded revision/);
  }
});

test('raw response files opt out of Git line-ending conversion so public hashes survive checkout', () => {
  const attributes = fs.readFileSync(path.join(publicRoot, 'evidence/.gitattributes'), 'utf8');
  assert.match(attributes, /^\* -text$/m);
});
