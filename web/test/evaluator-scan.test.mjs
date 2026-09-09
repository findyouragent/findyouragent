import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanEvaluator, runCli } from '../evaluator-scan.mjs';
import { trySchemas } from '../../server/src/try-schema.js';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const site = 'https://site.invalid';
const api = 'https://api.invalid';
const paragraph = 'Find Your Agent lets a reviewer inspect dated provider responses, public task inputs and separate outcome checks. These development observations are not a deployed release, independent benchmark or paid delivery. A live dependency may fail; the original successful record cannot pass a later failed check. ';
const html = (links) => `<html><head><title>FYA</title></head><body><h1>Evaluate Find Your Agent</h1><p>${paragraph.repeat(3)}</p>${links.map((href) => `<a href="${href}">${href}</a>`).join('')}</body></html>`;

async function fixture() {
  const manifest = JSON.parse(await fs.readFile(path.join(publicRoot, 'evidence/index.json'), 'utf8'));
  const paidDir = path.join(publicRoot, 'evidence/paid-call-2026-09-09');
  const paidArchivePath = path.join(paidDir, 'index.json');
  const paidArchiveBytes = await fs.readFile(paidArchivePath);
  const paidArchive = JSON.parse(paidArchiveBytes);
  assert.ok(paidArchive.artifacts.every((asset) => /^\/evidence\/paid-call-2026-09-09\//.test(asset.href)), 'Paid archive hrefs must be absolute public evidence paths');
  const paidArtifactBytesByHref = new Map();
  for (const asset of paidArchive.artifacts) {
    const relative = asset.href.replace('/evidence/paid-call-2026-09-09/', '');
    paidArtifactBytesByHref.set(asset.href, await fs.readFile(path.join(paidDir, relative)));
  }
  manifest.paidCall = { href: '/evidence/paid-call-2026-09-09/index.json', mediaType: 'application/json', bytes: paidArchiveBytes.length,
    sha256: crypto.createHash('sha256').update(paidArchiveBytes).digest('hex') };
  const spec = {
    openapi: '3.1.0', components: { schemas: structuredClone(trySchemas) },
    paths: {
      '/api/try/{chainId}/{tokenId}': { post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/TryRequest' } } } },
        responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/TryResponse' } } } } },
      } },
      '/api/try/{chainId}/{tokenId}/interface': { get: {} }, '/api/registry/agents': { get: {} },
    },
  };
  const responses = new Map();
  const set = (url, body, type = 'application/json', status = 200, headers = {}) => responses.set(url, { body: typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body, type, status, headers });
  const artifacts = [...manifest.records.map((r) => r.rawCapture), ...manifest.sources, ...manifest.implementationSources, manifest.reliability];
  for (const artifact of artifacts) set(`${site}${artifact.href}`, await fs.readFile(path.join(publicRoot, artifact.href)), artifact.mediaType);
  set(site + manifest.paidCall.href, paidArchiveBytes);
  for (const [href, bytes] of paidArtifactBytesByHref) set(site + href, bytes);
  const syntheticAsset = (href, body, mediaType = 'application/json') => {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    set(site + href, bytes, mediaType);
    return { href, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mediaType };
  };
  const logAsset = syntheticAsset('/evidence/test-supplement/smoke.log', '1 passed, 1 failed, 1 incomplete', 'text/plain');
  const smoke = {
    schemaVersion: 1, recordType: 'fya-local-api-smoke-observation', environment: 'local-development',
    observedDate: '2026-09-08', status: 'failed', counts: { passed: 1, failed: 1, incomplete: 1 },
    deployedReleaseEvidence: false, releaseMode: false, startedAt: null, finishedAt: null,
    checks: [{ status: 'pass' }, { status: 'fail' }, { status: 'incomplete' }], sourceLog: { ...logAsset },
  };
  const providerReview = syntheticAsset('/evidence/test-supplement/provider-review.json', { kind: 'synthetic provider review' });
  const protocolCrosscheck = syntheticAsset('/evidence/test-supplement/protocol-crosscheck.json', { kind: 'synthetic protocol cross-check' });
  const rawResult = syntheticAsset('/evidence/test-supplement/result.json', { result: 'synthetic' });
  const request = syntheticAsset('/evidence/test-supplement/request.json', { request: 'synthetic' });
  const smokeAsset = syntheticAsset('/evidence/test-supplement/smoke.json', smoke);
  const supplement = {
    schemaVersion: 1, recordType: 'fya-predeployment-evidence-supplement', id: 'test-supplement',
    observedDate: '2026-09-08', environment: 'local-development',
    qualification: { fyaAuthored: true, publicDeploymentEvidence: false, paidHireEvidence: false,
      unfamiliarUserEvidence: false, independentBeneficialOwnershipAudit: false },
    reports: { providerReview: { ...providerReview }, protocolCrosscheck: { ...protocolCrosscheck } },
    apiSmoke: { ...smokeAsset, observedDate: smoke.observedDate, status: smoke.status, counts: { ...smoke.counts },
      releaseMode: smoke.releaseMode, startedAt: smoke.startedAt, finishedAt: smoke.finishedAt },
    findings: [{ id: 'synthetic-read', reportHref: providerReview.href, rawHref: rawResult.href, requestHref: request.href }],
    files: [providerReview, protocolCrosscheck, rawResult, request, smokeAsset, logAsset].map((asset) => ({ ...asset })),
  };
  const supplementBytes = Buffer.from(JSON.stringify(supplement));
  const supplementEntry = { id: supplement.id, observedDate: supplement.observedDate, environment: supplement.environment,
    href: '/evidence/test-supplement/index.json', mediaType: 'application/json', bytes: supplementBytes.length,
    sha256: crypto.createHash('sha256').update(supplementBytes).digest('hex') };
  manifest.supplements = [supplementEntry];
  set(site + supplementEntry.href, supplementBytes);
  const supplements = [supplement]; const smokeReports = [smoke];
  const evidenceLinks = ['/evidence/index.json', ...artifacts.map((asset) => asset.href),
    manifest.paidCall.href, ...paidArchive.artifacts.map((asset) => asset.href),
    ...(manifest.supplements ?? []).map((entry) => entry.href),
    ...supplements.flatMap((supplement) => [...Object.values(supplement.reports).map((report) => report.href),
      ...supplement.findings.flatMap((finding) => [finding.rawHref, ...(finding.requestHref ? [finding.requestHref] : [])]),
      ...(supplement.apiSmoke ? [supplement.apiSmoke.href] : [])]),
    ...smokeReports.filter(Boolean).map((smoke) => smoke.sourceLog.href)];
  set(site + '/', html(['/docs/about', '/docs/evidence']), 'text/html');
  set(site + '/docs/about', html(['/evidence/index.json', '/docs/evidence']), 'text/html');
  set(site + '/docs/evidence', html(evidenceLinks), 'text/html');
  set(site + '/evidence/index.json', manifest);
  set(site + '/llms.txt', `/docs/about\n/docs/evidence\n${api}/openapi.json`, 'text/plain');
  set(site + '/robots.txt', 'User-agent: *\nAllow: /\nSitemap: https://site.invalid/sitemap.xml\n', 'text/plain');
  set(site + '/sitemap.xml', '<urlset><url><loc>https://site.invalid/docs/about</loc></url><url><loc>https://site.invalid/docs/evidence</loc></url></urlset>', 'application/xml');
  set(api + '/openapi.json', spec);
  set(api + '/health', { ok: true, scope: 'process' });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.authorization, undefined);
    const response = responses.get(url);
    if (!response) return new Response('Fixture URL absent; no network permitted', { status: 404 });
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.type, ...response.headers } });
  };
  const publishSupplement = (index = 0) => {
    const bytes = Buffer.from(JSON.stringify(supplements[index]));
    const entry = manifest.supplements[index];
    entry.bytes = bytes.length;
    entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    set(site + entry.href, bytes);
    set(site + '/evidence/index.json', manifest);
  };
  const publishSmoke = (index = 0) => {
    const bytes = Buffer.from(JSON.stringify(smokeReports[index]));
    const entry = supplements[index].apiSmoke;
    entry.bytes = bytes.length; entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    Object.assign(supplements[index].files.find((asset) => asset.href === entry.href), { bytes: entry.bytes, sha256: entry.sha256 });
    set(site + entry.href, bytes); publishSupplement(index);
  };
  return { manifest, spec, calls, set, fetchImpl, supplements, publishSupplement, evidenceLinks, smokeReports, publishSmoke, paidArchive,
    paidArtifact: paidArchive.artifacts[0], paidArtifactBytesByHref };
}

test('complete HTTP fixtures pass while explicitly excluding provider/release success', async () => {
  const f = await fixture();
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, true, JSON.stringify(result.checks.filter((c) => c.status !== 'passed')));
  assert.equal(result.counts.failed, 0);
  assert.equal(result.liveReleaseVerified, false);
  assert.equal(result.providerTaskExecuted, false);
  assert.equal(result.paidHireVerified, false);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  const expectedArtifacts = f.manifest.records.length + f.manifest.sources.length + f.manifest.implementationSources.length + 1
    + f.supplements.length + f.supplements.reduce((total, supplement) => total + supplement.files.length, 0) + 1;
  assert.equal(result.checks.filter((c) => c.id.startsWith('artifact:')).length, expectedArtifacts);
  assert.equal(result.checks.filter((c) => c.id.startsWith('paid-call-artifact:') && c.status === 'passed').length, f.paidArchive.artifacts.length);
  assert.equal(result.checks.filter((c) => c.id.startsWith('supplement-readable:') && c.status === 'passed').length, f.supplements.length);
  assert.equal(f.calls.length, 9 + expectedArtifacts + f.paidArchive.artifacts.length);
  assert.ok(f.calls.every((c) => c.url.startsWith(site) || ['/openapi.json', '/health'].some((p) => c.url === api + p)));
});

test('paid-call archive verifies declared bytes and digest without changing historical qualifications', async () => {
  const f = await fixture();
  f.set(site + f.paidArtifact.href, Buffer.from('{"tampered":true}'));
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === `paid-call-artifact:${f.paidArtifact.href}`).detail, /SHA-256/);
  assert.equal(result.paidHireVerified, false);
});

test('paid-call archive rejects unsafe child paths before fetching them', async () => {
  const f = await fixture();
  f.paidArchive.artifacts[0].href = 'https://provider.invalid/payment.json';
  const archiveBytes = Buffer.from(JSON.stringify(f.paidArchive));
  f.manifest.paidCall.bytes = archiveBytes.length;
  f.manifest.paidCall.sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  f.set(site + f.manifest.paidCall.href, archiveBytes);
  f.set(site + '/evidence/index.json', f.manifest);
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === 'paid-call-archive').detail, /invalid artifact descriptor/);
  assert.equal(f.calls.some((call) => call.url.startsWith('https://provider.invalid')), false);
});

test('paid-call archive index hash failure prevents child fetches', async () => {
  const f = await fixture();
  const changed = Buffer.from(JSON.stringify({ ...f.paidArchive, tampered: true }));
  f.set(site + f.manifest.paidCall.href, changed);
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === `artifact:${f.manifest.paidCall.href}`).detail, /SHA-256/);
  assert.equal(f.calls.some((call) => f.paidArchive.artifacts.some((asset) => call.url === site + asset.href)), false);
});

test('paid-call archive requires its index on the readable evidence page', async () => {
  const f = await fixture();
  f.set(site + '/docs/evidence', html(f.evidenceLinks.filter((href) => href !== f.manifest.paidCall.href)) , 'text/html');
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === 'paid-call-readable').detail, /does not link/);
});

test('changed artifact remains a reported failure even when other surfaces work', async () => {
  const f = await fixture();
  const asset = f.manifest.records[0].rawCapture;
  f.set(site + asset.href, { falseSuccess: true });
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === `artifact:${asset.href}`).detail, /SHA-256/);
  assert.ok(result.checks.some((c) => c.id === 'api-process-liveness' && c.status === 'passed'));
});

test('same-origin directory redirects preserve GET semantics and report the canonical URL', async () => {
  const f = await fixture();
  f.set(site + '/docs/about', '', 'text/html', 301, { location: '/docs/about/' });
  f.set(site + '/docs/about/', html(['/evidence/index.json', '/docs/evidence']), 'text/html');
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, true);
  assert.match(result.checks.find((c) => c.id === 'fetch:evaluate').detail, /canonical URL: https:\/\/site.invalid\/docs\/about\//);
  assert.equal(f.calls.filter((c) => c.url.startsWith(site + '/docs/about')).length, 2);
});

test('redirects cannot reach a provider, downgraded protocol, credentials or task endpoint', async () => {
  for (const location of ['https://provider.invalid/mcp', 'http://site.invalid/docs/about/', 'https://user:password@site.invalid/docs/about/', '/api/try/56/45650/interface']) {
    const f = await fixture();
    f.set(site + '/docs/about', '', 'text/html', 302, { location });
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.equal(result.evaluatorSurfaceReady, false);
    assert.equal(result.checks.find((c) => c.id === 'fetch:evaluate').status, 'failed');
    assert.equal(f.calls.some((c) => c.url === new URL(location, site).href), false);
  }
});

test('redirect cycles stop after three hops within one request deadline', async () => {
  const f = await fixture();
  f.set(site + '/docs/about', '', 'text/html', 301, { location: '/docs/about/' });
  f.set(site + '/docs/about/', '', 'text/html', 308, { location: '/docs/about' });
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === 'fetch:evaluate').detail, /three-redirect limit/);
  assert.equal(f.calls.filter((c) => c.url.startsWith(site + '/docs/about')).length, 4);
});

test('missing API, JS-only prose and wrong configured API cannot pass', async () => {
  const f = await fixture();
  f.set(api + '/openapi.json', { error: 'unavailable' }, 'application/json', 503);
  f.set(site + '/docs/about', `<html><body><div id="root"></div><script>document.write('${paragraph.repeat(3)}')</script></body></html>`, 'text/html');
  f.set(site + '/llms.txt', '/docs/about /docs/evidence https://wrong.invalid/openapi.json', 'text/plain');
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.equal(result.checks.find((c) => c.id === 'fetch:openapi').status, 'failed');
  assert.equal(result.checks.find((c) => c.id === 'fetch:evaluate').status, 'failed');
  assert.equal(result.checks.find((c) => c.id === 'typed-try-contract').status, 'skipped');
  assert.equal(result.liveReleaseVerified, false);
});

test('typed outcome omissions and discovery contradictions fail clearly', async () => {
  const f = await fixture();
  f.spec.components.schemas.TryObservation.properties.outcome.enum = ['response_received'];
  f.set(api + '/openapi.json', f.spec);
  f.set(site + '/llms.txt', '/docs/about /docs/evidence https://wrong.invalid/openapi.json', 'text/plain');
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.match(result.checks.find((c) => c.id === 'typed-try-contract').detail, /Missing outcome/);
  assert.match(result.checks.find((c) => c.id === 'discovery-links').detail, /explicitly supplied API/);
});

test('manifest cannot cause external requests or silently skip declared artifacts', async () => {
  const f = await fixture();
  f.manifest.sources[0].href = 'https://provider.invalid/private';
  f.set(site + '/evidence/index.json', f.manifest);
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.checks.find((c) => c.id === 'evidence-manifest').status, 'failed');
  assert.equal(f.calls.length, 9);
});

test('a changed supplement artifact fails independently of its valid manifest and other files', async () => {
  const f = await fixture();
  const asset = f.supplements[0].files[0];
  f.set(site + asset.href, 'tampered original response', asset.mediaType);
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.equal(result.checks.find((check) => check.id === `supplement:${f.supplements[0].id}`).status, 'passed');
  assert.match(result.checks.find((check) => check.id === `artifact:${asset.href}`).detail, /SHA-256/);
  assert.equal(result.checks.filter((check) => check.status === 'failed').length, 1);
});

test('supplement indexes and child paths cannot request external, traversal, encoded or query URLs', async () => {
  const unsafePaths = ['https://provider.invalid/mcp', '//provider.invalid/mcp', '/evidence/../api/try/56/2468',
    '/evidence/%2e%2e/private', '/evidence/foo\\bar', '/evidence/file.json?target=provider', '/api/try/56/2468'];
  for (const href of unsafePaths) {
    const f = await fixture();
    f.supplements[0].files[0].href = href;
    f.publishSupplement();
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.equal(result.evaluatorSurfaceReady, false, href);
    assert.equal(result.checks.find((check) => check.id === `supplement:${f.supplements[0].id}`).status, 'failed');
    assert.equal(f.calls.some((call) => call.url === site + href || call.url === href), false);
    assert.equal(f.calls.filter((call) => f.supplements[0].files.some((file) => site + file.href === call.url)).length, 0,
      'Malformed manifest must not launch any child requests');
  }
  const f = await fixture();
  f.manifest.supplements[0].href = 'https://provider.invalid/index.json';
  f.set(site + '/evidence/index.json', f.manifest);
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.checks.find((check) => check.id === 'evidence-manifest').status, 'failed');
  assert.equal(f.calls.length, 9);
});

test('supplement reports, findings, qualifications and complete artifact sets are required', async () => {
  for (const mutate of [
    (supplement) => { delete supplement.reports.protocolCrosscheck; },
    (supplement) => { supplement.reports.providerReview.sha256 = '0'.repeat(64); },
    (supplement) => { supplement.files = []; },
    (supplement) => { supplement.files = supplement.files.filter((file) => file.href !== supplement.findings[0].rawHref); },
    (supplement) => { supplement.files.push(supplement.files[0]); },
    (supplement) => { supplement.findings = []; },
    (supplement) => { delete supplement.qualification.unfamiliarUserEvidence; },
    (supplement) => { supplement.qualification.publicDeploymentEvidence = true; },
    (supplement) => { supplement.supplements = [{ href: '/evidence/recursive/index.json' }]; },
  ]) {
    const f = await fixture();
    mutate(f.supplements[0]); f.publishSupplement();
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.equal(result.evaluatorSurfaceReady, false);
    assert.equal(result.checks.find((check) => check.id === `supplement:${f.supplements[0].id}`).status, 'failed');
  }
});

test('unverified supplement indexes cannot cause child fetches', async () => {
  for (const status of [200, 404]) {
    const f = await fixture();
    f.set(site + f.manifest.supplements[0].href, { files: f.supplements[0].files }, 'application/json', status);
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.equal(result.evaluatorSurfaceReady, false);
    assert.equal(result.checks.find((check) => check.id === `artifact:${f.manifest.supplements[0].href}`).status, 'failed');
    assert.equal(result.checks.find((check) => check.id === `supplement:${f.supplements[0].id}`).status, 'skipped');
    assert.equal(f.calls.some((call) => f.supplements[0].files.some((asset) => site + asset.href === call.url)), false);
  }
});

test('readable supplement links must point to local findings and reports, not matching external paths', async () => {
  const f = await fixture();
  const raw = f.supplements[0].findings[0].rawHref;
  f.set(site + '/docs/evidence', html(f.evidenceLinks.map((href) => href === raw ? `https://provider.invalid${href}` : href)), 'text/html');
  const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((check) => check.id === `supplement-readable:${f.supplements[0].id}`).detail, /does not link locally/);
  assert.equal(f.calls.some((call) => call.url.startsWith('https://provider.invalid')), false);
});

test('dated smoke cannot hide failed checks, invent release scope or refer to an unhashed source log', async () => {
  for (const mutate of [
    (smoke) => { smoke.counts.failed = 0; },
    (smoke) => { smoke.checks = smoke.checks.filter((check) => check.status !== 'fail'); },
    (smoke) => { smoke.deployedReleaseEvidence = true; },
    (smoke) => { smoke.sourceLog.href = 'https://provider.invalid/log'; },
    (smoke) => { smoke.sourceLog.sha256 = '0'.repeat(64); },
  ]) {
    const f = await fixture();
    mutate(f.smokeReports[0]); f.publishSmoke();
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.equal(result.evaluatorSurfaceReady, false);
    assert.equal(result.checks.find((check) => check.id === `supplement-smoke:${f.supplements[0].id}`).status, 'failed');
    assert.equal(f.calls.some((call) => call.url.startsWith('https://provider.invalid')), false);
  }
});

test('supplement artifact redirects stay within evidence paths and retain the existing deadline', async () => {
  for (const location of ['/docs/about', '/api/try/56/2468/interface', '/evidence/redirected.json?provider=true']) {
    const f = await fixture();
    const asset = f.supplements[0].files[0];
    f.set(site + asset.href, '', asset.mediaType, 302, { location });
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.match(result.checks.find((check) => check.id === `artifact:${asset.href}`).detail, /leaves the inspected/);
    assert.equal(result.evaluatorSurfaceReady, false);
  }
});

test('combined evidence bounds reject negative sizes, oversized files and excessive nested totals', async () => {
  for (const bytes of [-1, 2 * 1024 * 1024 + 1]) {
    const f = await fixture();
    f.supplements[0].files[0].bytes = bytes; f.publishSupplement();
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.equal(result.checks.find((check) => check.id === `supplement:${f.supplements[0].id}`).status, 'failed');
  }
  for (const [count, bytes, message] of [[260, 1, /oversized/], [20, 2 * 1024 * 1024, /32 MiB/]]) {
    const f = await fixture();
    for (let index = 0; index < count; index++) f.supplements[0].files.push({ href: `/evidence/extra-${index}.json`, bytes, sha256: '0'.repeat(64) });
    f.publishSupplement();
    const result = await scanEvaluator({ site, api, fetchImpl: f.fetchImpl });
    assert.match(result.checks.find((check) => check.id === `supplement:${f.supplements[0].id}`).detail, message);
    assert.equal(f.calls.some((call) => call.url.includes('/evidence/extra-')), false);
  }
});

test('response-body timeout is bounded and included in the result', async () => {
  const f = await fixture();
  const fetchImpl = (url, options) => url.endsWith('/health') ? new Promise(() => {}) : f.fetchImpl(url, options);
  const started = Date.now();
  const result = await scanEvaluator({ site, api, fetchImpl, timeoutMs: 50 });
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.evaluatorSurfaceReady, false);
  assert.match(result.checks.find((c) => c.id === 'fetch:health').detail, /exceeded 50 ms/);
});

test('CLI requires all explicit targets and writes failed scan results before returning nonzero', async () => {
  const f = await fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fya-evaluator-scan-'));
  const out = path.join(directory, 'scan.json');
  const messages = []; const stream = { write: (value) => messages.push(value) };
  try {
    assert.equal(await runCli(['--site', site], { fetchImpl: f.fetchImpl, stdout: stream, stderr: stream }), 1);
    assert.equal(f.calls.length, 0);
    f.set(api + '/health', { ok: false });
    assert.equal(await runCli(['--site', site, '--api', api, '--out', out], { fetchImpl: f.fetchImpl, stdout: stream, stderr: stream }), 1);
    const report = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.equal(report.evaluatorSurfaceReady, false);
    assert.equal(report.checks.find((c) => c.id === 'api-process-liveness').status, 'failed');
    assert.ok(messages.some((message) => message.includes('failed')));
  } finally { await fs.unlink(out).catch(() => {}); await fs.rmdir(directory); }
});
