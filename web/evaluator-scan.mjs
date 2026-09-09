import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// A bounded GET-only inspection of explicit evaluator surfaces. It never opens
// a browser, follows provider links, executes page content or submits a task.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACTS = 256;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_SUPPLEMENTS = 8;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const baseUrl = (input) => {
  const url = new URL(input);
  requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'Use an explicit HTTP(S) base URL without credentials, query or fragment.');
  return url.href.replace(/\/+$/, '');
};
const prose = (html) => html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<head\b[\s\S]*?<\/head>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const hasLink = (html, target) => [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].some(([, href]) => {
  try { return new URL(href, 'https://reader.invalid').pathname.replace(/\/$/, '') === target; } catch { return false; }
});
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const evidencePath = (href) => typeof href === 'string' && /^\/evidence\/[a-zA-Z0-9/_.-]+$/.test(href)
  && !href.includes('..') && !href.includes('//');
const validAsset = (asset) => evidencePath(asset?.href) && /^[a-f0-9]{64}$/.test(asset.sha256)
  && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.bytes <= MAX_BYTES;
const hasLocalEvidenceLink = (html, target, site) => [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].some(([, href]) => {
  try { const url = new URL(href, `${site}/`); return url.origin === new URL(site).origin && url.pathname === target && !url.search && !url.username && !url.password; }
  catch { return false; }
});
const inBatches = async (items, action) => {
  for (let offset = 0; offset < items.length; offset += 8) await Promise.all(items.slice(offset, offset + 8).map(action));
};

export async function scanEvaluator({ site, api, fetchImpl = fetch, timeoutMs = 12_000 }) {
  site = baseUrl(site); api = baseUrl(api);
  requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'timeoutMs must be 1–30000.');
  const report = { schemaVersion: 1, kind: 'fya-evaluator-surface-scan', startedAt: new Date().toISOString(), site, api,
    scope: 'Ordinary HTTP GETs of the explicitly supplied site/API and evidence assets. No JavaScript execution, provider requests, wallet connection, payment or task submission.',
    qualification: 'Developer-operated surface inspection. Passing means the checked explanation, artifacts and API contract are accessible; it does not establish live release reliability, provider correctness, independent judging or completed delivery.',
    liveReleaseVerified: false, providerTaskExecuted: false, paidHireVerified: false, checks: [] };
  const check = async (id, url, action) => {
    const started = Date.now();
    try { const detail = await action(); report.checks.push({ id, status: 'passed', url, detail, elapsedMs: Date.now() - started }); return detail; }
    catch (error) { report.checks.push({ id, status: 'failed', url, detail: String(error.message).slice(0, 500), elapsedMs: Date.now() - started }); return null; }
  };
  const get = async (url) => {
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`GET exceeded ${timeoutMs} ms`)); }, timeoutMs); });
    const request = async () => {
      const initial = new URL(url); let current = initial; let response;
      for (let redirects = 0; ; redirects += 1) {
        controller.signal.throwIfAborted();
        response = await fetchImpl(current.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { accept: 'application/json,text/html,text/plain,application/xml' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        requireThat(redirects < 3, 'GET exceeded the three-redirect limit');
        const location = response.headers.get('location');
        requireThat(location, 'Redirect has no Location header');
        const next = new URL(location, current);
        requireThat(next.origin === initial.origin && next.protocol === initial.protocol && !next.username && !next.password,
          'Cross-origin, credentialed or protocol-changing redirect refused');
        requireThat(initial.pathname.startsWith('/evidence/') ? evidencePath(next.pathname) && !next.search
          : next.pathname.replace(/\/+$/, '') === initial.pathname.replace(/\/+$/, '') || /^\/(?:docs|evidence)(?:\/|$)/.test(next.pathname),
          'Redirect leaves the inspected static/API surface');
        next.hash = ''; current = next;
      }
      requireThat(response.ok, `GET returned HTTP ${response.status}`);
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) { length += chunk.length; requireThat(length <= MAX_BYTES, 'Response exceeded 2 MiB'); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks);
      return { bytes, text: bytes.toString('utf8'), type: response.headers.get('content-type') ?? '', canonicalUrl: current.href };
    };
    try { return await Promise.race([request(), deadline]); } finally { clearTimeout(timer); controller.abort(); }
  };
  const documents = new Map();
  const specs = [['home', '/', 'html'], ['evaluate', '/docs/about', 'html'], ['evidence', '/docs/evidence', 'html'],
    ['manifest', '/evidence/index.json', 'json'], ['llms', '/llms.txt', 'text'], ['robots', '/robots.txt', 'text'], ['sitemap', '/sitemap.xml', 'xml'],
    ['openapi', '/openapi.json', 'json', api], ['health', '/health', 'json', api]];
  await Promise.all(specs.map(([id, pathname, kind, origin = site]) => check(`fetch:${id}`, `${origin}${pathname}`, async () => {
    const document = await get(`${origin}${pathname}`);
    if (kind === 'html') {
      requireThat(/text\/html/i.test(document.type), 'Expected HTML content type');
      requireThat(/<h1\b/i.test(document.text) && prose(document.text).split(/\s+/).length >= (id === 'home' ? 25 : 80), 'No substantial HTML explanation without JavaScript');
      requireThat(!/\{\{(?:API|EVIDENCE_\w+)\}\}/.test(document.text), 'Unresolved documentation template');
    } else if (kind === 'json') document.json = JSON.parse(document.text);
    else requireThat(!/<(?:!doctype|html)\b/i.test(document.text), 'Expected a machine file, received an HTML fallback');
    documents.set(id, document);
    return `${document.bytes.length} bytes; ${kind === 'html' ? 'readable without JavaScript' : 'fetched'}; canonical URL: ${document.canonicalUrl}`;
  })));
  const inspect = (id, dependencies, action) => {
    if (dependencies.some((key) => !documents.has(key))) { report.checks.push({ id, status: 'skipped', detail: 'A required document could not be fetched or parsed.' }); return Promise.resolve(); }
    return check(id, null, action);
  };
  await inspect('discovery-links', ['home', 'evaluate', 'evidence', 'llms', 'robots', 'sitemap'], () => {
    for (const target of ['/docs/about', '/docs/evidence']) {
      requireThat(hasLink(documents.get('home').text, target), `Homepage does not link to ${target}`);
      requireThat(documents.get('llms').text.includes(target), `llms.txt omits ${target}`);
      requireThat(documents.get('sitemap').text.includes(`${target}</loc>`), `Sitemap omits ${target}`);
    }
    for (const id of ['evaluate', 'evidence']) requireThat(hasLink(documents.get(id).text, '/evidence/index.json'), `${id} does not link to the evidence index`);
    requireThat(/(?:^|\n)Allow:\s*\/\s*(?:\r?\n|$)/i.test(documents.get('robots').text), 'robots.txt does not explicitly allow ordinary crawling');
    requireThat(!/(?:^|\n)Disallow:\s*\/(?:\s*$|\s*\r?\n|docs|evidence)/i.test(documents.get('robots').text), 'robots.txt blocks a required review surface');
    requireThat(documents.get('llms').text.includes(`${api}/openapi.json`), 'llms.txt does not name the explicitly supplied API');
    return 'Homepage, evaluator pages and machine discovery files expose the review path and configured API.';
  });
  await inspect('typed-try-contract', ['openapi'], () => {
    const spec = documents.get('openapi').json; const schemas = spec.components?.schemas;
    requireThat(/^3\./.test(spec.openapi ?? ''), 'OpenAPI 3 document required');
    const operation = spec.paths?.['/api/try/{chainId}/{tokenId}']?.post;
    requireThat(operation?.requestBody?.content?.['application/json']?.schema?.$ref === '#/components/schemas/TryRequest', 'Try request is not linked to a typed schema');
    requireThat(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref === '#/components/schemas/TryResponse', 'Try response is not linked to a typed schema');
    requireThat(schemas?.TryRequest?.properties?.presetId?.type === 'string' && schemas?.TryResponse?.properties?.observation?.$ref === '#/components/schemas/TryObservation', 'Preset/observation contract is missing');
    const observation = schemas?.TryObservation?.properties;
    requireThat(observation?.runId && observation.startedAt && observation.finishedAt && observation.captureComplete?.type === 'boolean' && observation.task?.$ref,
      'Observation does not describe identity, times, completeness and separate task assessment');
    for (const outcome of ['unknown', 'error', 'pending', 'payment_required', 'response_received']) requireThat(observation.outcome?.enum?.includes(outcome), `Missing outcome ${outcome}`);
    requireThat(spec.paths?.['/api/try/{chainId}/{tokenId}/interface']?.get && spec.paths?.['/api/registry/agents']?.get, 'Discovery routes missing');
    return 'Typed preset, interface, result and non-success outcomes are discoverable; no operation was executed.';
  });
  await inspect('api-process-liveness', ['health'], () => {
    requireThat(documents.get('health').json?.ok === true, 'Health route did not report ok:true');
    return 'FYA process answered. Registry and provider availability were not checked.';
  });
  await inspect('evidence-manifest', ['manifest'], async () => {
    const manifest = documents.get('manifest').json;
    requireThat(manifest.schemaVersion === 1 && Array.isArray(manifest.records) && manifest.records.length > 0, 'Missing versioned evidence records');
    requireThat(manifest.qualification?.paidHireEvidence === false && manifest.qualification?.deployedReleaseEvidence === false && manifest.qualification?.independentBenchmarkEvidence === false, 'Historical QA qualifications are absent');
    requireThat(Array.isArray(manifest.sources) && Array.isArray(manifest.implementationSources) && manifest.reliability, 'Manifest artifact groups are incomplete');
    const supplements = manifest.supplements ?? [];
    requireThat(Array.isArray(supplements) && supplements.length <= MAX_SUPPLEMENTS
      && supplements.every((entry) => /^[a-z0-9-]+$/.test(entry?.id ?? ''))
      && new Set(supplements.map((entry) => entry.id)).size === supplements.length, 'Invalid, duplicate or oversized supplement list');
    const paidCall = manifest.paidCall;
    if (paidCall !== undefined) requireThat(validAsset(paidCall), 'Invalid paid-call archive descriptor');
    const artifacts = [...manifest.records.map((record) => record.rawCapture), ...manifest.sources, ...manifest.implementationSources, manifest.reliability, ...supplements,
      ...(paidCall ? [paidCall] : [])];
    const registered = new Set(['/evidence/index.json']); let declaredBytes = 0;
    const register = (assets) => {
      requireThat(Array.isArray(assets) && assets.every(validAsset), 'Invalid local artifact link, hash or size');
      requireThat(registered.size - 1 + assets.length <= MAX_ARTIFACTS
        && new Set(assets.map((asset) => asset.href)).size === assets.length
        && assets.every((asset) => !registered.has(asset.href)), 'Artifact set is oversized or contains duplicate links');
      const bytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
      requireThat(declaredBytes + bytes <= MAX_EVIDENCE_BYTES, 'Declared evidence exceeds the total 32 MiB limit');
      declaredBytes += bytes; for (const asset of assets) registered.add(asset.href);
    };
    register(artifacts);
    const supplementDocuments = new Map(); const smokePaths = new Set(); const smokeDocuments = new Map();
    const paidCallDocuments = new Map();
    const inspectArtifact = (asset) => check(`artifact:${asset.href}`, `${site}${asset.href}`, async () => {
      const response = await get(`${site}${asset.href}`);
      requireThat(response.bytes.length === asset.bytes && sha256(response.bytes) === asset.sha256, 'Artifact bytes or SHA-256 differ from the manifest');
      const entry = manifest.records.find((record) => record.rawCapture.href === asset.href);
      if (entry) {
        const record = JSON.parse(response.text);
        requireThat(record.runId === entry.observation?.runId && record.observation?.runId === record.runId && record.agent?.chainId === entry.provider?.chainId && record.agent?.tokenId === entry.provider?.tokenId,
          'Capture identity disagrees with the index');
        requireThat(isDeepStrictEqual(record.request, entry.request) && isDeepStrictEqual(record.observation, entry.observation), 'Capture inputs or original observation disagree with the index');
        requireThat(entry.provenance?.captureRevision === null && entry.provenance?.originalBytesPreserved === true, 'Missing original-capture provenance');
        if (documents.has('evidence')) requireThat(hasLink(documents.get('evidence').text, asset.href), 'Readable evidence page does not link to this capture');
      }
      if (supplements.some((supplement) => supplement.href === asset.href)) supplementDocuments.set(asset.href, JSON.parse(response.text));
      if (smokePaths.has(asset.href)) smokeDocuments.set(asset.href, JSON.parse(response.text));
      if (paidCall?.href === asset.href) paidCallDocuments.set(asset.href, JSON.parse(response.text));
      return `SHA-256 matched; ${response.bytes.length} bytes${entry ? '; original identity, inputs and observation agree' : ''}; canonical URL: ${response.canonicalUrl}`;
    });
    await inBatches(artifacts, inspectArtifact);
    if (paidCall) {
      const archive = paidCallDocuments.get(paidCall.href);
      const valid = await check('paid-call-archive', `${site}${paidCall.href}`, async () => {
        requireThat(archive?.schemaVersion === 1 && archive.recordType === 'fya-paid-call-evidence',
          'Paid-call archive has an unsupported schema or record type');
        requireThat(Array.isArray(archive.artifacts) && archive.artifacts.length > 0, 'Paid-call archive has no artifacts');
        requireThat(archive.artifacts.every(validAsset), 'Paid-call archive contains an invalid artifact descriptor');
        register(archive.artifacts);
        return `${archive.artifacts.length} paid-call artifacts declared; archive readability and integrity are checked without inferring payment success.`;
      });
      if (valid) {
        await inBatches(archive.artifacts, (asset) => check(`paid-call-artifact:${asset.href}`, `${site}${asset.href}`, async () => {
          const response = await get(`${site}${asset.href}`);
          requireThat(response.bytes.length === asset.bytes && sha256(response.bytes) === asset.sha256,
            'Paid-call artifact bytes or SHA-256 differ from the manifest');
          return `SHA-256 matched; ${response.bytes.length} bytes; canonical URL: ${response.canonicalUrl}`;
        }));
        await check('paid-call-readable', `${site}/docs/evidence`, () => {
          requireThat(documents.has('evidence'), 'Readable evidence page is unavailable');
          requireThat(hasLocalEvidenceLink(documents.get('evidence').text, paidCall.href, site),
            'Readable evidence page does not link to the paid-call archive index');
          return 'Static evidence page links to the paid-call archive index; payment or hire success is not inferred.';
        });
      }
    }
    for (const entry of supplements) {
      const supplement = supplementDocuments.get(entry.href);
      if (!supplement) {
        report.checks.push({ id: `supplement:${entry.id}`, status: 'skipped', url: `${site}${entry.href}`, detail: 'Supplement index could not be fetched, parsed or verified.' });
        continue;
      }
      const valid = await check(`supplement:${entry.id}`, `${site}${entry.href}`, async () => {
        requireThat(supplement.schemaVersion === 1 && supplement.recordType === 'fya-predeployment-evidence-supplement'
          && supplement.id === entry.id && supplement.observedDate === entry.observedDate
          && /^\d{4}-\d{2}-\d{2}$/.test(supplement.observedDate ?? '') && supplement.environment === entry.environment
          && supplement.environment === 'local-development', 'Supplement identity, version or observation scope disagrees with the index');
        const qualification = supplement.qualification;
        requireThat(qualification?.fyaAuthored === true && qualification.publicDeploymentEvidence === false
          && qualification.paidHireEvidence === false && qualification.unfamiliarUserEvidence === false
          && qualification.independentBeneficialOwnershipAudit === false, 'Supplement qualifications are incomplete');
        requireThat(supplement.supplements === undefined, 'Nested supplement recursion is unsupported');
        requireThat(Array.isArray(supplement.files) && supplement.files.length > 0 && supplement.files.every(validAsset), 'Supplement files are missing or invalid');
        const files = new Map(supplement.files.map((asset) => [asset.href, asset]));
        const reports = supplement.reports;
        requireThat(reports && reports.providerReview && reports.protocolCrosscheck, 'Supplement reports are incomplete');
        for (const report of [...Object.values(reports), ...(supplement.apiSmoke === undefined ? [] : [supplement.apiSmoke])]) {
          const asset = files.get(report?.href);
          requireThat(validAsset(report) && asset && report.sha256 === asset.sha256 && report.bytes === asset.bytes,
            'Supplement report is unhashed or disagrees with its file descriptor');
        }
        if (supplement.apiSmoke) smokePaths.add(supplement.apiSmoke.href);
        requireThat(Array.isArray(supplement.findings) && supplement.findings.length > 0
          && supplement.findings.every((finding) => /^[a-z0-9-]+$/.test(finding?.id ?? ''))
          && new Set(supplement.findings.map((finding) => finding.id)).size === supplement.findings.length, 'Supplement findings are missing or duplicated');
        const reportPaths = new Set(Object.values(reports).map((report) => report.href));
        for (const finding of supplement.findings) {
          for (const href of [finding.rawHref, finding.reportHref, ...(finding.requestHref === undefined ? [] : [finding.requestHref])]) {
            requireThat(evidencePath(href) && files.has(href), 'Supplement finding refers to a missing or unsafe artifact');
          }
          requireThat(reportPaths.has(finding.reportHref), 'Supplement finding has no declared report');
        }
        register(supplement.files);
        return `${supplement.files.length} declared files; findings and reports reference hashed artifacts; local-review qualifications retained.`;
      });
      if (!valid) continue;
      await inBatches(supplement.files, inspectArtifact);
      if (supplement.apiSmoke) await check(`supplement-smoke:${entry.id}`, `${site}${supplement.apiSmoke.href}`, () => {
        const smoke = smokeDocuments.get(supplement.apiSmoke.href);
        requireThat(smoke?.schemaVersion === 1 && smoke.recordType === 'fya-local-api-smoke-observation'
          && smoke.environment === 'local-development' && smoke.deployedReleaseEvidence === false
          && smoke.releaseMode === false && smoke.startedAt === null && smoke.finishedAt === null,
        'Dated local smoke report is unavailable or misrepresents its release/time scope');
        for (const key of ['observedDate', 'status', 'counts', 'releaseMode', 'startedAt', 'finishedAt']) {
          requireThat(isDeepStrictEqual(smoke[key], supplement.apiSmoke[key]), 'Smoke report disagrees with its supplement descriptor');
        }
        const log = supplement.files.find((asset) => asset.href === smoke.sourceLog?.href);
        requireThat(validAsset(smoke.sourceLog) && log && log.bytes === smoke.sourceLog.bytes && log.sha256 === smoke.sourceLog.sha256,
          'Smoke source log is missing, unsafe or disagrees with its file descriptor');
        requireThat(Array.isArray(smoke.checks) && smoke.checks.length > 0
          && smoke.checks.every((item) => ['pass', 'fail', 'incomplete'].includes(item.status)), 'Smoke checks are missing or invalid');
        for (const [count, status] of [['passed', 'pass'], ['failed', 'fail'], ['incomplete', 'incomplete']]) {
          requireThat(Number.isSafeInteger(smoke.counts?.[count]) && smoke.counts[count] === smoke.checks.filter((item) => item.status === status).length,
            'Smoke outcome counts disagree with its recorded checks');
        }
        requireThat(smoke.status === (smoke.counts.failed > 0 ? 'failed' : smoke.counts.incomplete > 0 ? 'incomplete' : 'passed'), 'Smoke status disagrees with its recorded checks');
        return 'Dated local smoke counts, unknown exact times and source-log digest agree; no current release success is inferred.';
      });
      await check(`supplement-readable:${entry.id}`, `${site}/docs/evidence`, () => {
        requireThat(documents.has('evidence'), 'Readable evidence page is unavailable');
        const html = documents.get('evidence').text;
        const links = [entry.href, ...Object.values(supplement.reports).map((report) => report.href),
          ...supplement.findings.flatMap((finding) => [finding.rawHref, ...(finding.requestHref ? [finding.requestHref] : [])]),
          ...(supplement.apiSmoke ? [supplement.apiSmoke.href, smokeDocuments.get(supplement.apiSmoke.href)?.sourceLog?.href] : [])];
        for (const href of links) requireThat(hasLocalEvidenceLink(html, href, site), `Readable supplement entry does not link locally to ${href}`);
        return 'Static evidence page links to the supplement index, reports and each finding’s original result/input.';
      });
    }
    return `${registered.size - 1} manifest and supplement artifacts declared; each attempted fetch is reported separately.`;
  });
  report.finishedAt = new Date().toISOString();
  report.counts = Object.fromEntries(['passed', 'failed', 'skipped'].map((status) => [status, report.checks.filter((c) => c.status === status).length]));
  report.evaluatorSurfaceReady = report.counts.failed === 0 && report.counts.skipped === 0;
  report.conclusion = report.evaluatorSurfaceReady ? 'Checked evaluator surfaces are readable and internally consistent. Live release readiness remains a separate gate.' : 'Evaluator surface checks did not pass. Read the failed and skipped checks; no live release success is inferred.';
  return report;
}

export async function runCli(args, { fetchImpl = fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  let out;
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      requireThat(['--site', '--api', '--out'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Usage: node evaluator-scan.mjs --site URL --api URL --out FILE');
      options[args[i]] = args[i + 1];
    }
    requireThat(options['--site'] && options['--api'] && options['--out'], 'Explicit --site, --api and --out are required; no target is inferred.');
    out = path.resolve(options['--out']);
    const report = await scanEvaluator({ site: options['--site'], api: options['--api'], fetchImpl });
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    stdout.write(`${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.skipped} skipped. Report: ${out}\n${report.conclusion}\n`);
    return report.evaluatorSurfaceReady ? 0 : 1;
  } catch (error) { stderr.write(`${error.message}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
