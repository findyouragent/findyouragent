import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectAdvantageResult, importAdvantageResult, formatAgentCost, hasQualityAssessment } from '../src/advantage-result.js';
import { classifyTryResult } from '../src/try-result.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n${err.stack}`); process.exitCode = 1; }
}
const startedAt = '2026-09-08T00:00:00.000Z';
const finishedAt = '2026-09-08T00:00:01.000Z';
const definedAt = '2026-09-07T23:00:00.000Z';
const textResult = { result: { content: [{ type: 'text', text: 'A useful response' }] } };
const inspect = (body, extra = {}) => inspectAdvantageResult({ agent: { chainId: 56, tokenId: '45422' },
  request: { protocol: 'mcp', tool: 'read', arguments: {} }, body,
  httpStatus: 200, startedAt, finishedAt, latencyMs: 1000, captureComplete: true, ...extra });
function receipt(body = textResult, request = { protocol: 'mcp', tool: 'read', arguments: {} }) {
  const observation = classifyTryResult({ protocol: 'mcp', httpStatus: 200, body,
    startedAt, finishedAt, latencyMs: 1000, runId: 'test-run', captureComplete: true });
  return { schemaVersion: 1, recordType: 'fya-observed-agent-result', runId: observation.runId,
    agent: { chainId: 56, tokenId: '45422', endpointUsed: 'https://example.org/mcp' },
    request, observation, response: { body, captureComplete: true } };
}

test('MCP error and upstream failure cannot become benchmark output despite readable text', () => {
  assert.throws(() => inspect({ result: { ...textResult.result, isError: true } }), /mcp-tool-error/);
  assert.throws(() => inspect(textResult, { httpStatus: 503 }), /upstream-http-error/);
  assert.throws(() => inspect(textResult, { httpStatus: 402 }), /payment_required/);
});
test('A2A working/accepted artifacts and completed status messages are not completed work', () => {
  const parts = [{ kind: 'text', text: 'still working' }];
  for (const state of ['submitted', 'working', 'input-required', 'auth-required']) {
    assert.throws(() => inspect({ result: { kind: 'task', status: { state, message: { parts } }, artifacts: [{ parts }] } },
      { request: { protocol: 'a2a', message: 'task' } }), /pending/);
  }
  assert.throws(() => inspect({ result: { status: { state: 'completed', message: { parts } } } },
    { request: { protocol: 'a2a', message: 'task' } }), /without-output/);
  assert.throws(() => inspect(textResult, { httpStatus: 202 }), /pending/);
});
test('A2A terminal artifact is captured while human task success remains unassessed', () => {
  const evidence = inspect({ result: { kind: 'task', status: { state: 'completed' }, artifacts: [
    { parts: [{ kind: 'text', text: 'delivered answer' }] }] } }, { request: { protocol: 'a2a', message: 'task' } });
  assert.equal(evidence.observation.outcome, 'deliverable_received');
  assert.equal(evidence.output, 'delivered answer');
  assert.equal(evidence.taskSuccess, 'not_assessed');
});
test('Generic MCP response is not a successful task or a zero-priced call', () => {
  const evidence = inspect(textResult);
  assert.equal(evidence.observation.task.status, 'not_evaluated');
  assert.equal(evidence.taskSuccess, 'not_assessed');
  assert.equal(evidence.costU, null);
  assert.match(formatAgentCost({}), /not recorded/);
  assert.match(formatAgentCost({ paid: true }), /amount not recorded/);
  assert.equal(formatAgentCost({ costU: 0 }), '0 $U (reported)');
});

test('Empty structured content preserves the actual MCP text answer', () => {
  const evidence = inspect({ result: { structuredContent: {}, content: [{ type: 'text', text: 'The actual useful answer' }] } });
  assert.equal(evidence.output, 'The actual useful answer');
  assert.throws(() => inspect({ result: { structuredContent: {}, content: [] } }), /unknown/);
});
test('Incomplete captures and progress-only or empty responses are rejected', () => {
  assert.throws(() => inspect(textResult, { captureComplete: false }), /complete response/);
  assert.throws(() => inspect({ result: {} }), /unknown/);
});
test('Receipt import preserves actual input and original observation time', () => {
  const original = receipt(textResult, { protocol: 'mcp', tool: 'read', arguments: { address: 'actual-input' } });
  const imported = importAdvantageResult(original, { definedAt });
  assert.deepEqual(imported.request, original.request);
  assert.equal(imported.observation.startedAt, startedAt);
  assert.equal(imported.observation.finishedAt, finishedAt);
  assert.equal(imported.elapsedMs, 1000);
  assert.equal(imported.sourceType, 'local-result-file');
  assert.equal(imported.costU, null);
});
test('Forged passed label cannot hide MCP error in imported raw output', () => {
  const original = receipt({ result: { ...textResult.result, isError: true } });
  original.observation.outcome = 'response_received';
  original.observation.task = { status: 'passed' };
  assert.throws(() => importAdvantageResult(original, { definedAt }), /mcp-tool-error/);
});
test('Import requires definition before original run, consistent identity and full capture', () => {
  assert.throws(() => importAdvantageResult(receipt(), { definedAt: finishedAt }), /defined before/);
  for (const change of [
    (r) => { r.response.captureComplete = false; },
    (r) => { r.runId = 'different'; },
    (r) => { r.request.protocol = 'a2a'; },
    (r) => { r.observation.version = 0; },
    (r) => { r.observation.latencyMs = 1; },
    (r) => { r.observation.endpoint = 'https://different.example/mcp'; },
  ]) { const original = receipt(); change(original); assert.throws(() => importAdvantageResult(original, { definedAt })); }
});
const presetRequest = { protocol: 'mcp', presetId: 'beefy-bsc-vaults', presetVersion: 1,
  tool: 'getVaultsWithChains', arguments: { chainNames: ['bsc'] } };
const vaultBody = { result: { structuredContent: { project: 'beefy', operation: 'getVaultsWithChains',
  data: [{ chain: 'bsc', vaults: [{ chain: 'bsc', id: 'vault-1', name: 'Example', token: 'USDT', tvl: 100, apy: 0.1 }] }] } } };
test('Preset import recomputes checks and retains the distinction from human quality', () => {
  const original = receipt(vaultBody, presetRequest);
  const imported = importAdvantageResult(original, { definedAt });
  assert.equal(imported.observation.task.status, 'passed');
  assert.equal(imported.taskSuccess, 'not_assessed');
  const wrong = structuredClone(original);
  wrong.response.body.result.structuredContent.data[0].chain = 'ethereum';
  wrong.observation.task = { status: 'passed' };
  assert.throws(() => importAdvantageResult(wrong, { definedAt }), /checks are failed/);
});
test('Preset identity, args and version must match the fixed fixture', () => {
  for (const change of [
    (r) => { r.request.arguments.chainNames = ['ethereum']; },
    (r) => { r.request.presetVersion = 2; },
    (r) => { r.agent.tokenId = '123'; },
    (r) => { r.request.tool = 'different'; },
  ]) { const original = receipt(vaultBody, structuredClone(presetRequest)); change(original);
    assert.throws(() => importAdvantageResult(original, { definedAt }), /fixture/); }
});
test('Human quality assessment requires two bounded scores and written reasoning', () => {
  assert.equal(hasQualityAssessment({}), false);
  assert.equal(hasQualityAssessment({ quality: { agent: 5, manual: 4, rationale: '' } }), false);
  assert.equal(hasQualityAssessment({ quality: { agent: 6, manual: 4, rationale: 'why' } }), false);
  assert.equal(hasQualityAssessment({ quality: { agent: 5, manual: 4, rationale: 'Matched the predeclared criteria.' } }), true);
});
test('CLI imports no fake payment, keeps report incomplete, and refuses errors without mutation', () => {
  // Every CLI write is redirected to this disposable directory. Never touch
  // the actual advantage tasks, human outputs, or published report in tests.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-advantage-test-'));
  try {
    const tasksFile = path.join(root, 'tasks.json');
    const input = path.join(root, 'download.json');
    fs.writeFileSync(tasksFile, JSON.stringify({ t1: { id: 't1', title: 'Example task', category: 'research',
      successCriteria: 'Provide the requested useful output', definedAt } }));
    fs.writeFileSync(input, JSON.stringify(receipt()));
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../advantage.js', import.meta.url)), ...args],
      { env: { ...process.env, ADVANTAGE_DIR: root }, encoding: 'utf8' });
    let run = cli('agent', 't1', '--via', 'result-file', '--input-file', input);
    assert.equal(run.status, 0, run.stderr);
    const task = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).t1;
    assert.equal(task.agentRun.observedAt, finishedAt);
    assert.equal(task.agentRun.costU, null);
    assert.equal(task.agentRun.via, 'mcp-result-file');
    run = cli('report');
    assert.equal(run.status, 0, run.stderr);
    const report = fs.readFileSync(path.join(root, 'REPORT.md'), 'utf8');
    assert.match(report, /both outputs recorded: \*\*0\*\*/);
    assert.match(report, /incomplete/);
    const before = fs.readFileSync(tasksFile, 'utf8');
    fs.writeFileSync(input, JSON.stringify(receipt({ result: { ...textResult.result, isError: true } })));
    run = cli('agent', 't1', '--via', 'result-file', '--input-file', input);
    assert.notEqual(run.status, 0);
    assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI relay path sends only preset ID and rejects HTTP-200 MCP errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-advantage-relay-test-'));
  try {
    const tasksFile = path.join(root, 'tasks.json');
    const mockFile = path.join(root, 'mock-fetch.mjs');
    const tasks = { t1: { id: 't1', title: 'Fixture test only', category: 'research',
      successCriteria: 'Test fixture', definedAt } };
    const cli = () => spawnSync(process.execPath, ['--import', pathToFileURL(mockFile).href,
      fileURLToPath(new URL('../advantage.js', import.meta.url)), 'agent', 't1', '--via', 'try',
      '--agent', '56/45422', '--preset', 'beefy-bsc-vaults'],
    { env: { ...process.env, ADVANTAGE_DIR: root }, encoding: 'utf8' });
    const mock = (body) => fs.writeFileSync(mockFile, `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.ok(url.endsWith('/api/try/56/45422'));
        assert.deepEqual(JSON.parse(options.body), { presetId: 'beefy-bsc-vaults' });
        return { status: 200, json: async () => (${JSON.stringify({
          status: 200, upstreamStatus: 200, captureComplete: true, body,
          taskPreset: { id: presetRequest.presetId, version: 1, tool: presetRequest.tool, args: presetRequest.arguments },
        })}) };
      };
    `);
    fs.writeFileSync(tasksFile, JSON.stringify(tasks));
    mock({ result: { ...vaultBody.result, isError: true } });
    let run = cli();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /mcp-tool-error/);
    assert.deepEqual(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), tasks);
    mock(vaultBody);
    run = cli();
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).t1.agentRun;
    assert.deepEqual(result.args, { chainNames: ['bsc'] });
    assert.equal(result.observation.task.status, 'passed');
    assert.equal(result.taskSuccess, 'not_assessed');
    assert.equal(result.costU, null);
    assert.ok(fs.existsSync(path.join(root, result.evidenceFile)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Every definition field is frozen after a run and forced changes invalidate quality', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-definition-test-'));
  try {
    const tasksFile = path.join(root, 'tasks.json');
    const original = { id: 't1', title: 'Original title', category: 'research', successCriteria: 'Original criteria',
      definedAt, quality: { agent: 5, manual: 4, rationale: 'Original assessment' },
      agentRun: { via: 'mcp-tool', minutes: 1, outputFile: 'agent.txt' },
      manualRun: { minutes: 2, outputFile: 'manual.txt' } };
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../advantage.js', import.meta.url)), ...args],
      { env: { ...process.env, ADVANTAGE_DIR: root }, encoding: 'utf8' });
    fs.writeFileSync(tasksFile, JSON.stringify({ t1: original }));
    let run = cli('define', 't1', '--title', original.title, '--success', original.successCriteria);
    assert.equal(run.status, 0, run.stderr);
    const unchanged = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).t1;
    assert.equal(unchanged.category, 'research', 'omitting category preserves an existing definition');
    assert.deepEqual(unchanged.quality, original.quality, 'no-op definition keeps its quality assessment');
    assert.equal(unchanged.revisions, undefined);

    for (const [field, value] of [['title', 'Revised title'], ['category', 'security'], ['successCriteria', 'Revised criteria']]) {
      fs.writeFileSync(tasksFile, JSON.stringify({ t1: original }));
      const next = { ...original, [field]: value };
      const args = ['define', 't1', '--title', next.title, '--category', next.category, '--success', next.successCriteria];
      const before = fs.readFileSync(tasksFile, 'utf8');
      run = cli(...args);
      assert.notEqual(run.status, 0, `${field} must be frozen after a run`);
      assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
      run = cli(...args, '--force');
      assert.equal(run.status, 0, run.stderr);
      const revised = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).t1;
      assert.equal(revised.quality, undefined, `${field} revision invalidates old scores`);
      assert.equal(revised.definedAt, original.definedAt);
      assert.equal(revised.revisions.length, 1);
      const rev = revised.revisions[0];
      assert.deepEqual(rev.fields, [field]);
      assert.equal(rev.prior[field], original[field]);
      assert.equal(rev.next[field], value);
      assert.equal(rev.from, original.successCriteria);
      assert.equal(rev.to, next.successCriteria);
      assert.equal(rev.afterRun, true);
      assert.ok(Number.isFinite(Date.parse(rev.at)));
      run = cli('report');
      assert.equal(run.status, 0, run.stderr);
      const report = fs.readFileSync(path.join(root, 'REPORT.md'), 'utf8');
      assert.match(report, /With numeric human quality assessments: \*\*0\*\*/);
      assert.match(report, /Definition revisions/);
      assert.ok(report.includes(`${field}: ${JSON.stringify(original[field])} → ${JSON.stringify(value)}`));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pre-run title, category and criteria revisions reject captures from the older definition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-definition-import-test-'));
  try {
    const tasksFile = path.join(root, 'tasks.json');
    const input = path.join(root, 'old-capture.json');
    const now = Date.now();
    const original = { id: 't1', title: 'Original title', category: 'research', successCriteria: 'Original criteria',
      definedAt: new Date(now - 120000).toISOString() };
    const capture = receipt();
    capture.observation.startedAt = new Date(now - 60000).toISOString();
    capture.observation.finishedAt = new Date(now - 59000).toISOString();
    fs.writeFileSync(input, JSON.stringify(capture));
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../advantage.js', import.meta.url)), ...args],
      { env: { ...process.env, ADVANTAGE_DIR: root }, encoding: 'utf8' });
    for (const [field, value] of [['title', 'Revised title'], ['category', 'security'], ['successCriteria', 'Revised criteria']]) {
      fs.writeFileSync(tasksFile, JSON.stringify({ t1: original }));
      const next = { ...original, [field]: value };
      let run = cli('define', 't1', '--title', next.title, '--category', next.category, '--success', next.successCriteria);
      assert.equal(run.status, 0, run.stderr);
      const before = fs.readFileSync(tasksFile, 'utf8');
      const rev = JSON.parse(before).t1.revisions[0];
      assert.equal(rev.afterRun, false);
      assert.deepEqual(rev.fields, [field]);
      run = cli('agent', 't1', '--via', 'result-file', '--input-file', input);
      assert.notEqual(run.status, 0, `${field} revision must move the import cutoff`);
      assert.match(run.stderr, /defined before/);
      assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(root, 'outputs', 't1-agent.txt')), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('The same original observation cannot be counted under distinct task IDs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fya-duplicate-observation-test-'));
  try {
    const tasksFile = path.join(root, 'tasks.json');
    const input = path.join(root, 'download.json');
    const definition = { title: 'Synthetic test task', category: 'research', successCriteria: 'Synthetic criteria', definedAt };
    fs.writeFileSync(tasksFile, JSON.stringify({ t1: { ...definition, id: 't1' }, t2: { ...definition, id: 't2' } }));
    fs.writeFileSync(input, JSON.stringify(receipt()));
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../advantage.js', import.meta.url)), ...args],
      { env: { ...process.env, ADVANTAGE_DIR: root }, encoding: 'utf8' });
    let run = cli('agent', 't1', '--via', 'result-file', '--input-file', input);
    assert.equal(run.status, 0, run.stderr);
    run = cli('agent', 't1', '--via', 'result-file', '--input-file', input);
    assert.equal(run.status, 0, 'reimport into the same task does not duplicate task evidence');
    const before = fs.readFileSync(tasksFile, 'utf8');
    run = cli('agent', 't2', '--via', 'result-file', '--input-file', input);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /already recorded for t1/);
    assert.equal(fs.readFileSync(tasksFile, 'utf8'), before, 'duplicate rejection must precede task mutation');
    assert.equal(fs.existsSync(path.join(root, 'outputs', 't2-agent.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'outputs', 't2-agent-result.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`${passed} advantage result integrity tests passed`);
