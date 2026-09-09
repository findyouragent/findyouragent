import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const harness = fileURLToPath(new URL('../advantage.js', import.meta.url));
const definition = {
  id: 'example', title: 'Example journal lookup', category: 'trading',
  successCriteria: 'Return the recorded transaction and its source.',
  definedAt: '2026-09-08T00:00:00.000Z',
};

function generate(tasks) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'fya-report-test-'));
  try {
    const source = JSON.stringify(tasks, null, 2);
    const taskFile = path.join(directory, 'tasks.json');
    fs.writeFileSync(taskFile, source);
    const run = spawnSync(process.execPath, [harness, 'report'], {
      env: { ...process.env, ADVANTAGE_DIR: directory }, encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(taskFile, 'utf8'), source, 'report generation must not invent or mutate evidence');
    return fs.readFileSync(path.join(directory, 'REPORT.md'), 'utf8');
  } finally {
    const relative = path.relative(tempRoot, fs.realpathSync(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a zero-pair report states missing evidence without claiming completed trials', () => {
  const report = generate({ example: definition });
  assert.match(report, /Harness task IDs with both outputs recorded: \*\*0\*\*/);
  assert.match(report, /With numeric human quality assessments: \*\*0\*\*/);
  assert.match(report, /No task ID yet has both output entries/);
  assert.match(report, /missing agent run and manual run/);
  assert.doesNotMatch(report, /n=1|was run once|Where a task needs an address|Venus|0x7Fabc4/);
});

test('one-sided evidence remains unpaired and does not imply a manual trial', () => {
  const report = generate({ example: { ...definition,
    agentRun: { via: 'mcp-tool', agent: '56/123', minutes: 1, outputFile: 'outputs/agent.txt' },
  } });
  assert.match(report, /Harness task IDs with both outputs recorded: \*\*0\*\*/);
  assert.match(report, /Example journal lookup: missing manual run/);
  assert.match(report, /No task ID yet has both output entries/);
  assert.doesNotMatch(report, /n=1|was run once/);
});

test('paired records distinguish captured outputs, assessments and unknown attempt counts', () => {
  const report = generate({ example: { ...definition,
    agentRun: { via: 'erc8183-hire', jobId: 'example-job', minutes: 1, outputFile: 'outputs/agent.txt' },
    manualRun: { minutes: 3, outputFile: 'outputs/manual.txt' },
  } });
  assert.match(report, /Harness task IDs with both outputs recorded: \*\*1\*\*/);
  assert.match(report, /With numeric human quality assessments: \*\*0\*\*/);
  assert.match(report, /One retained output per side/);
  assert.match(report, /does not track attempt counts/);
  assert.match(report, /not independently verified by this harness/);
  assert.doesNotMatch(report, /n=1|was run once|No task ID yet has both output entries/);
});
