#!/usr/bin/env node
/**
 * Agent Advantage harness.
 *
 * Records agent and human outputs for the same predefined task and builds a report.
 * Success criteria precede collection; human baselines are supplied, never generated.
 * Original outputs are retained so quality assessments can be checked against them.
 *
 *   node advantage.js define t1 --title "..." --category security --success "..."
 *   node advantage.js agent  t1 --via try --agent 56/45650 --prompt "..."
 *   node advantage.js agent  t1 --via hire --job 56620 --minutes 4 --cost 1 --output-file reply.txt
 *   node advantage.js agent  t1 --via paid-try --agent 56/45650 --tx 0x... --minutes 1 --cost 0.25 --output-file reply.txt
 *   node advantage.js manual t1 --minutes 25 --cost 0 --output-file notes.txt
 *   node advantage.js report
 *
 * `try` measures a relay call. `hire` and `paid-try` retain supplied output,
 * receipt references and human-reported time; they do not verify wallet flows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAdvantageResult, importAdvantageResult, formatAgentCost, hasQualityAssessment } from './src/advantage-result.js';

const ROOT = process.env.ADVANTAGE_DIR ? path.resolve(process.env.ADVANTAGE_DIR) : fileURLToPath(new URL('../advantage/', import.meta.url));
const OUTPUTS = path.join(ROOT, 'outputs');
const TASKS_FILE = path.join(ROOT, 'tasks.json');
const VERIFY_BASE = (process.env.VERIFY_BASE || 'http://localhost:8787').replace(/\/$/, '');

const CATEGORIES = ['trading', 'security', 'stock', 'research', 'other'];

function loadTasks() {
  if (!fs.existsSync(TASKS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTasks(tasks) {
  fs.mkdirSync(OUTPUTS, { recursive: true });
  fs.writeFileSync(TASKS_FILE, `${JSON.stringify(tasks, null, 2)}\n`);
}

function writeOutput(taskId, side, text, extension = 'txt') {
  fs.mkdirSync(OUTPUTS, { recursive: true });
  const file = path.join(OUTPUTS, `${taskId}-${side}.${extension}`);
  fs.writeFileSync(file, text ?? '');
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function measurement(name, required = false) {
  const value = arg(name);
  if (value === null && !required) return null;
  if (value === null || !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) {
    die(`--${name} must be a finite nonnegative measurement${required ? '' : ' or omitted when unknown'}.`);
  }
  return Number(value);
}

function fmtMinutes(minutes) {
  if (minutes == null) return 'not recorded';
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${Number(minutes.toFixed(1))} min`;
}

function assertUniqueObservation(tasks, taskId, observation) {
  const runId = typeof observation?.runId === 'string' ? observation.runId.trim() : '';
  if (!runId) return; // Legacy and human-reported flows may have no canonical run id.
  const duplicate = Object.entries(tasks).find(([id, task]) => id !== taskId
    && typeof task.agentRun?.observation?.runId === 'string'
    && task.agentRun.observation.runId.trim() === runId);
  if (duplicate) {
    throw new Error(`Observation ${runId} is already recorded for ${duplicate[0]}; one original run cannot count as distinct task evidence.`);
  }
}

// ── define ────────────────────────────────────────────────────────────────
function define(taskId) {
  const title = arg('title');
  const success = arg('success');
  if (!title || !success) {
    die('define needs --title and --success.\nSuccess criteria are written BEFORE running either side, so the comparison cannot be rationalised afterwards.');
  }
  const tasks = loadTasks();
  const existing = tasks[taskId];
  const category = arg('category', existing?.category ?? 'other');
  if (!CATEGORIES.includes(category)) die(`--category must be one of: ${CATEGORIES.join(', ')}`);
  const prior = existing ? { title: existing.title, category: existing.category, successCriteria: existing.successCriteria } : null;
  const next = { title, category, successCriteria: success };
  const changedFields = prior ? Object.keys(next).filter((key) => prior[key] !== next[key]) : [];
  const changed = changedFields.length > 0;

  // Recorded runs freeze the definition. An explicit override records a revision
  // and invalidates its quality assessment.
  if (existing && (existing.agentRun || existing.manualRun)) {
    if (changed && process.argv.indexOf('--force') === -1) {
      die([
        `${taskId} already has a recorded run, so its task definition is frozen.`,
        '',
        ...changedFields.map((key) => `  ${key}: ${JSON.stringify(prior[key])} → ${JSON.stringify(next[key])}`),
        '',
        'Deciding what counts as success after seeing the results is how a comparison',
        'gets talked into the conclusion its author wanted. Pass --force if the wording',
        'genuinely needs fixing: the change will be recorded and shown in the report.',
      ].join('\n'));
    }
  }

  const revisions = [...(existing?.revisions ?? [])];
  const now = new Date().toISOString();
  if (changed) {
    revisions.push({
      from: existing.successCriteria,
      to: success,
      prior,
      next,
      fields: changedFields,
      afterRun: Boolean(existing.agentRun || existing.manualRun),
      at: now,
    });
  }

  tasks[taskId] = {
    ...(existing ?? {}),
    id: taskId,
    title,
    category,
    successCriteria: success,
    definedAt: existing?.definedAt ?? now,
    ...(revisions.length ? { revisions } : {}),
  };
  if (changed) delete tasks[taskId].quality;
  saveTasks(tasks);
  console.log(`\ndefined ${taskId}: ${title}`);
  console.log(`  category: ${category}`);
  console.log(`  success:  ${success}\n`);
}

// ── agent side ────────────────────────────────────────────────────────────
async function runAgent(taskId) {
  const tasks = loadTasks();
  const task = tasks[taskId];
  if (!task) die(`define ${taskId} first, so success criteria exist before the run.`);

  const via = arg('via', 'try');
  const prompt = arg('prompt');
  if (!['try', 'hire', 'paid-try', 'result-file'].includes(via)) die('Unknown --via route. Use try, hire, paid-try or result-file.');

  if (via === 'result-file') {
    const inputFile = arg('input-file');
    if (!inputFile || !fs.existsSync(inputFile)) die('result-file needs --input-file <FYA Download result JSON>.');
    const raw = fs.readFileSync(inputFile, 'utf8');
    let imported;
    try {
      const criteriaDates = [task.definedAt, ...(task.revisions ?? []).map((revision) => revision.at)];
      if (criteriaDates.some((date) => !Number.isFinite(Date.parse(date)))) throw new Error('Task definition history has invalid timestamps.');
      const criteriaDefinedAt = new Date(Math.max(...criteriaDates.map(Date.parse))).toISOString();
      imported = importAdvantageResult(JSON.parse(raw), { definedAt: criteriaDefinedAt });
      assertUniqueObservation(tasks, taskId, imported.observation);
    }
    catch (err) { die(`Nothing recorded: ${err.message}`); }
    const { request, observation } = imported;
    delete task.quality; // Replacing an output invalidates its previous assessment.
    task.agentRun = {
      via: 'mcp-result-file', sourceType: imported.sourceType, readOnly: true,
      agent: `${imported.agent.chainId}/${imported.agent.tokenId}`, request,
      tool: request.tool, args: request.arguments,
      observation, taskSuccess: imported.taskSuccess,
      minutes: imported.elapsedMs / 60000, elapsedMs: imported.elapsedMs,
      costU: null, costStatus: 'not_recorded', paid: false, paymentTx: null,
      endpoint: imported.agent.endpointUsed ?? observation.endpoint,
      outputFile: writeOutput(taskId, 'agent', imported.output),
      evidenceFile: writeOutput(taskId, 'agent-result', raw, 'json'),
      observedAt: observation.finishedAt, recordedAt: new Date().toISOString(),
      limitation: imported.limitation,
    };
    saveTasks(tasks);
    console.log(`\nImported the original observation for ${taskId}; no agent was rerun. Task quality remains unassessed.\n`);
    return;
  }

  if (via === 'hire') {
    // An escrow hire is an on-chain flow signed in a wallet, so the harness
    // records its result rather than performing it.
    const jobId = arg('job');
    const minutes = measurement('minutes', true);
    const cost = measurement('cost');
    const outputFile = arg('output-file');
    if (!jobId || !outputFile) {
      die('hire runs need --job <jobId> --minutes <n> --output-file <path> (and --cost in $U).');
    }
    if (!fs.existsSync(outputFile)) die(`output file not found: ${outputFile}`);
    const text = fs.readFileSync(outputFile, 'utf8');
    if (!text.trim()) die('the saved reply is empty, so there is no run to record.');
    delete task.quality; // Replacing an output invalidates its previous assessment.
    task.agentRun = {
      via: 'erc8183-hire',
      sourceType: 'human-reported-wallet-flow', taskSuccess: 'not_assessed',
      jobId,
      minutes: Number(minutes),
      costU: cost,
      outputFile: writeOutput(taskId, 'agent', text),
      recordedAt: new Date().toISOString(),
    };
    saveTasks(tasks);
    console.log(`\nrecorded escrow hire for ${taskId}: job ${jobId}, ${fmtMinutes(Number(minutes))}\n`);
    return;
  }

  if (via === 'paid-try') {
    // An x402 pay-per-call made from the marketplace's try panel. The payment
    // is signed in the person's wallet and the reply lands in their browser, so
    // as with a hire the harness records the run rather than making it. The
    // settlement transaction is the receipt that proves the call was paid.
    const agentRef = arg('agent');
    const paymentTx = arg('tx');
    const minutes = measurement('minutes', true);
    const cost = measurement('cost');
    const outputFile = arg('output-file');
    if (!agentRef || !/^\d+\/\d+$/.test(agentRef)) die('--agent must be <chainId>/<tokenId>, e.g. 56/45650');
    if (!paymentTx || !/^0x[0-9a-fA-F]{64}$/.test(paymentTx)) die('paid-try runs need --tx <settlement transaction hash> (the X-PAYMENT-RESPONSE txHash).');
    if (!outputFile) {
      die('paid-try runs need --minutes <n> --output-file <path> (and --cost in $U).');
    }
    if (!fs.existsSync(outputFile)) die(`output file not found: ${outputFile}`);
    const text = fs.readFileSync(outputFile, 'utf8');
    if (!text.trim()) die('the saved reply is empty, so there is no run to record.');
    delete task.quality; // Replacing an output invalidates its previous assessment.
    task.agentRun = {
      via: 'x402-paid-call',
      sourceType: 'human-reported-wallet-flow', taskSuccess: 'not_assessed',
      agent: agentRef,
      paid: true,
      paymentTx,
      minutes: Number(minutes),
      costU: cost,
      outputFile: writeOutput(taskId, 'agent', text),
      recordedAt: new Date().toISOString(),
    };
    saveTasks(tasks);
    console.log(`\nrecorded paid call for ${taskId}: agent ${agentRef}, settled in ${paymentTx}, ${fmtMinutes(Number(minutes))}\n`);
    return;
  }

  // Two ways to invoke an agent, because the registry has two kinds. A2A takes
  // prose; MCP takes a named tool with typed arguments. Most agents on BSC
  // doing real work are MCP, so a harness that only spoke A2A could not measure
  // them at all.
  const toolName = arg('tool');
  const presetId = arg('preset');
  if ([prompt, toolName, presetId].filter(Boolean).length > 1) die('Choose exactly one of --prompt, --tool or --preset.');
  if (!prompt && !toolName && !presetId) {
    die([
      'agent runs need one of:',
      '  --preset <id>                                                (reviewed fixed-input task)',
      '  --prompt "the task, exactly as you would give it to a person"   (A2A agents)',
      '  --tool <name> [--args \'{"json":"object"}\']                      (MCP agents)',
    ].join('\n'));
  }
  const agentRef = arg('agent');
  if (!agentRef || !/^\d+\/\d+$/.test(agentRef)) die('--agent must be <chainId>/<tokenId>, e.g. 56/45650');
  const [chainId, tokenId] = agentRef.split('/');

  let toolArgs = {};
  if (toolName) {
    try {
      toolArgs = JSON.parse(arg('args', '{}'));
    } catch (err) {
      die(`--args must be valid JSON: ${err.message}`);
    }
  }

  console.log(`\nrunning ${taskId} through the marketplace: agent ${agentRef}`);
  const started = Date.now();
  let result;
  try {
    const res = await fetch(`${VERIFY_BASE}/api/try/${chainId}/${tokenId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(presetId ? { presetId } : toolName ? { tool: toolName, arguments: toolArgs } : { message: prompt }),
      signal: AbortSignal.timeout(120_000),
    });
    result = { status: res.status, body: await res.json() };
  } catch (err) {
    die(`the call failed: ${err.message}. Nothing recorded, since a failed call is not a measurement.`);
  }
  const elapsedMs = Date.now() - started;

  const relay = result.body;
  if (result.status < 200 || result.status >= 300 || relay?.error) {
    die(`Nothing recorded: marketplace HTTP ${result.status}${relay?.error ? ` (${relay.error})` : ''}.`);
  }
  const preset = relay.taskPreset;
  if (presetId && (!preset || preset.id !== presetId)) die('Nothing recorded: the relay did not confirm the requested preset and its actual inputs.');
  const request = preset ? { protocol: 'mcp', tool: preset.tool, arguments: preset.args,
    presetId: preset.id, presetVersion: preset.version, inputKind: 'public-fixture' }
    : toolName ? { protocol: 'mcp', tool: toolName, arguments: toolArgs } : { protocol: 'a2a', message: prompt };
  const original = relay.observation;
  let evidence;
  try {
    evidence = inspectAdvantageResult({
      agent: { chainId: Number(chainId), tokenId }, request, body: relay.body,
      httpStatus: relay.upstreamStatus ?? relay.status,
      endpoint: relay.endpoint, runId: original?.runId,
      phase: original?.phase ?? relay.phase,
      startedAt: original?.startedAt ?? new Date(started).toISOString(),
      finishedAt: original?.finishedAt ?? new Date(started + elapsedMs).toISOString(),
      latencyMs: original?.latencyMs ?? elapsedMs,
      captureComplete: relay.captureComplete === true,
    });
    assertUniqueObservation(tasks, taskId, evidence.observation);
  } catch (err) { die(`Nothing recorded: ${err.message}`); }
  // A captured response is eligible for assessment, not proof of task success.
  // The harness sends no payment authorization; lack of a receipt is not a price.
  const paymentTx = relay.paymentReceipt?.txHash;
  const paid = typeof paymentTx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(paymentTx);
  delete task.quality; // Replacing an output invalidates its previous assessment.
  task.agentRun = {
    via: request.protocol === 'mcp' ? 'mcp-tool' : 'a2a-message',
    sourceType: 'measured-relay-call', readOnly: request.protocol === 'mcp',
    agent: agentRef, request,
    ...(request.protocol === 'mcp' ? { tool: request.tool, args: request.arguments } : { prompt }),
    minutes: elapsedMs / 60000, elapsedMs,
    observation: evidence.observation, taskSuccess: evidence.taskSuccess,
    paid, costU: null, costStatus: 'not_recorded', paymentTx: paid ? paymentTx : null,
    endpoint: relay.endpoint ?? null,
    outputFile: writeOutput(taskId, 'agent', evidence.output),
    evidenceFile: writeOutput(taskId, 'agent-result', JSON.stringify({ request, response: relay }, null, 2), 'json'),
    observedAt: evidence.observation.finishedAt, recordedAt: new Date().toISOString(),
  };
  saveTasks(tasks);
  console.log(`  took ${fmtMinutes(task.agentRun.minutes)} (${elapsedMs}ms)`);
  console.log(`  output saved to advantage/${task.agentRun.outputFile}`);
  console.log(`  cost: ${formatAgentCost(task.agentRun)}`);
  console.log('  response captured; task quality requires a separate human assessment.\n');
}

// ── manual side ───────────────────────────────────────────────────────────
function recordManual(taskId) {
  const tasks = loadTasks();
  const task = tasks[taskId];
  if (!task) die(`define ${taskId} first.`);

  const minutes = measurement('minutes', true);
  const cost = measurement('cost');
  const outputFile = arg('output-file');
  const notes = arg('notes', '');

  if (!outputFile) {
    die([
      'manual runs need --minutes <n> --output-file <path>.',
      '',
      'Do the task by hand, keep what you produced, and report the real elapsed time.',
      'This tool will not generate the manual side. A comparison against an invented',
      'baseline is worse than no comparison at all.',
    ].join('\n'));
  }
  if (!fs.existsSync(outputFile)) die(`output file not found: ${outputFile}`);
  const output = fs.readFileSync(outputFile, 'utf8');
  if (!output.trim()) die('The manual output is empty; do the task and save its actual output before recording it.');

  delete task.quality;
  task.manualRun = {
    minutes: Number(minutes),
    costUsd: cost,
    notes,
    outputFile: writeOutput(taskId, 'manual', output),
    recordedAt: new Date().toISOString(),
  };
  saveTasks(tasks);
  console.log(`\nrecorded manual run for ${taskId}: ${fmtMinutes(Number(minutes))}\n`);
}

// ── quality ───────────────────────────────────────────────────────────────
function score(taskId) {
  const tasks = loadTasks();
  const task = tasks[taskId];
  if (!task) die(`no task ${taskId}`);
  const agentScore = arg('agent-score');
  const manualScore = arg('manual-score');
  const rationale = arg('why', '');
  if (!task.agentRun || !task.manualRun) die('Record both actual outputs before scoring quality.');
  if (![agentScore, manualScore].every((value) => value !== null && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 5) || !rationale.trim()) {
    die('score needs --agent-score and --manual-score (1-5, assessed against the success criteria you wrote in define), plus --why.');
  }
  task.quality = {
    agent: Number(agentScore),
    manual: Number(manualScore),
    rationale,
    scoredAt: new Date().toISOString(),
  };
  saveTasks(tasks);
  console.log(`\nscored ${taskId}: agent ${agentScore}/5, manual ${manualScore}/5\n`);
}

// ── report ────────────────────────────────────────────────────────────────
function report() {
  const tasks = Object.values(loadTasks());
  if (tasks.length === 0) die('no tasks recorded yet.');

  const complete = tasks.filter((t) => t.agentRun && t.manualRun);
  const assessed = complete.filter(hasQualityAssessment);
  const lines = [];

  lines.push('# Agent Advantage Report');
  lines.push('');
  lines.push('Counts below track agent/manual entries under the same task ID in this harness. Retained observational examples are reviewed separately; these bookkeeping counts do not establish comparison quality. The 1–5 quality scale is this harness\'s workflow.');
  lines.push('');
  if (complete.length > 0) {
    lines.push('Each paired task below has a captured or human-reported agent output and a human-reported manual output. The route identifies a relay observation versus a wallet hire. A response is not proof that the task succeeded; separate human quality assessments evaluate both outputs against the criteria.');
  } else {
    lines.push('No task ID yet has both output entries in this harness. Retained recordings, replies and user reports can still support observational comparisons.');
  }
  lines.push('');

  const highStakes = complete.filter((t) => ['trading', 'security', 'stock'].includes(t.category));
  const assessedHighStakes = assessed.filter((t) => ['trading', 'security', 'stock'].includes(t.category));
  lines.push(`Harness task IDs with both outputs recorded: **${complete.length}**. With numeric human quality assessments: **${assessed.length}**. Paired task IDs from trading, stock or security: **${highStakes.length}**.`);
  lines.push('');

  if (complete.length < 3) {
    lines.push(`> Harness incomplete: ${3 - complete.length} more task(s) need both sides recorded under the same task ID.`);
    lines.push('');
  }
  if (assessed.length < 3) {
    lines.push(`> Harness incomplete: ${3 - assessed.length} more distinct paired task(s) need numeric human quality assessments. Protocol completion and preset checks do not supply those scores.`);
    lines.push('');
  }
  if (assessedHighStakes.length === 0) {
    lines.push('> Harness incomplete: at least one paired task with a human quality assessment must come from trading, stock or security.');
    lines.push('');
  }

  lines.push('| Task | Category | With agent | By hand | Time saved | Quality (agent / hand) |');
  lines.push('|---|---|---|---|---|---|');
  for (const task of complete) {
    const saved = task.manualRun.minutes - task.agentRun.minutes;
    const pct = task.manualRun.minutes > 0 ? Math.round((saved / task.manualRun.minutes) * 100) : 0;
    const quality = task.quality ? `${task.quality.agent} / ${task.quality.manual}` : 'not scored';
    lines.push(`| ${task.title} | ${task.category} | ${fmtMinutes(task.agentRun.minutes)} | ${fmtMinutes(task.manualRun.minutes)} | ${fmtMinutes(saved)} (${pct}%) | ${quality} |`);
  }
  lines.push('');

  for (const task of complete) {
    lines.push(`## ${task.title}`);
    lines.push('');
    lines.push(`**Category:** ${task.category}  `);
    lines.push(`**Current success criteria:** ${task.successCriteria}`);
    lines.push('');
    lines.push('**Agent output through findyouragent**');
    lines.push('');
    const ROUTE = {
      'mcp-tool': 'read-only MCP tool call over the marketplace relay (not an escrow hire)',
      'mcp-result-file': 'imported read-only MCP observation downloaded from FYA (not an escrow hire)',
      'a2a-message': 'A2A message over the marketplace relay',
      'erc8183-hire': 'ERC-8183 escrow job (signed in a wallet, recorded here)',
      'x402-paid-call': 'x402 pay-per-call from the marketplace try panel (paid in a wallet, recorded here)',
    };
    lines.push(`- Route: ${ROUTE[task.agentRun.via] ?? task.agentRun.via}`);
    if (task.agentRun.agent) lines.push(`- Agent: \`${task.agentRun.agent}\``);
    if (task.agentRun.tool) {
      lines.push(`- Tool: \`${task.agentRun.tool}(${JSON.stringify(task.agentRun.args ?? {})})\``);
    }
    if (task.agentRun.jobId) lines.push(`- Escrow job: \`${task.agentRun.jobId}\``);
    lines.push(`- Time: ${fmtMinutes(task.agentRun.minutes)}`);
    lines.push(`- Cost: ${formatAgentCost(task.agentRun)}`);
    lines.push(`- Observation: ${task.agentRun.observation?.outcome ?? 'human-reported or legacy capture'}; preset checks: ${task.agentRun.observation?.task?.status ?? 'not evaluated'}. Human task quality is separate.`);
    if (task.agentRun.observedAt) lines.push(`- Originally observed: ${task.agentRun.observedAt}`);
    if (task.agentRun.evidenceFile) lines.push(`- Captured request and response: [evidence](${task.agentRun.evidenceFile})`);
    if (task.agentRun.paymentTx) lines.push(`- Settlement: \`${task.agentRun.paymentTx}\``);
    lines.push(`- Output: [\`${task.agentRun.outputFile}\`](${task.agentRun.outputFile})`);
    lines.push('');
    lines.push('**By hand**');
    lines.push('');
    lines.push(`- Time: ${fmtMinutes(task.manualRun.minutes)}`);
    lines.push(`- Cost: ${task.manualRun.costUsd == null ? 'not recorded' : `$${task.manualRun.costUsd} (reported)`}`);
    if (task.manualRun.notes) lines.push(`- How: ${task.manualRun.notes}`);
    lines.push(`- Output: [\`${task.manualRun.outputFile}\`](${task.manualRun.outputFile})`);
    lines.push('');
    if (task.quality?.rationale) {
      lines.push(`**Quality:** agent ${task.quality.agent}/5, by hand ${task.quality.manual}/5. ${task.quality.rationale}`);
      lines.push('');
    }
  }

  const pending = tasks.filter((t) => !t.agentRun || !t.manualRun);
  if (pending.length > 0) {
    lines.push('## Unpaired harness entries');
    lines.push('');
    for (const task of pending) {
      const missing = [!task.agentRun && 'agent run', !task.manualRun && 'manual run'].filter(Boolean).join(' and ');
      lines.push(`- ${task.title}: missing ${missing} entry under this task ID`);
    }
    lines.push('');
  }

  lines.push(complete.length > 0 ? '## How these records are collected' : '## Collection method');
  lines.push('');
  lines.push('- **Task definitions are recorded first.** Title, category and success criteria are frozen once a run is recorded. A later change requires an explicit override, is listed in the revision history and invalidates the previous quality scores. Result-file imports must postdate the latest definition revision.');
  lines.push('- **Relay calls are measured; wallet flows are recorded.** The harness reclassifies raw HTTP and protocol results. Errors, pending tasks, progress-only messages, incomplete captures and unsupported outputs are refused. A terminal response still requires human task-quality assessment. Wallet hires and paid calls are recorded from a person\'s supplied output and receipt references, not independently verified by this harness. A local result-file import preserves its original time and request, does not rerun the agent, and does not prove file authenticity.');
  lines.push('- **The manual side is reported, not measured.** A human does the work and states the time. This tool will not generate that half.');
  lines.push('- **Recorded outputs are retained verbatim** in `outputs/` and linked from each paired task.');
  lines.push('');
  lines.push('## Disclosure');
  lines.push('');
  lines.push('- **Provider affiliation must be disclosed per task.** Providers must be identified from actual evidence; this harness does not infer operator independence from names or registry IDs.');
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  lines.push('- **Timing boundaries differ.** Direct agent time is the marketplace API round trip; imported results use the original server observation duration; wallet and manual time are human-reported. Agent duration excludes selection and prompt preparation. The difference is not a controlled end-to-end time-saving measurement.');
  lines.push('- **Manual measurements and quality scores are self-reported**, unblinded, with no independent grader. Assessments should be read alongside the original outputs and criteria.');
  lines.push(complete.length > 0
    ? '- **One retained output per side for each paired task.** The harness does not track attempt counts or repeated trials, so these records cannot establish how many attempts were made, variance or reliability.'
    : '- **No task ID has both output entries in this harness.** These entries alone do not establish a controlled time-saving result or reliability estimate; retained observational evidence is reviewed separately.');
  lines.push('- **The harness signs nothing.** It sends no payment authorization. No attached payment receipt means cost is unrecorded, not zero. Wallet receipt references and amounts are human-reported unless separately verified.');
  lines.push('');

  const revised = tasks.filter((t) => t.revisions?.length);
  if (revised.length > 0) {
    lines.push('### Definition revisions');
    lines.push('');
    for (const task of revised) {
      for (const rev of task.revisions) {
        const fields = ['title', 'category', 'successCriteria'];
        const changes = rev.prior && rev.next
          ? fields.filter((key) => rev.prior[key] !== rev.next[key])
            .map((key) => `${key}: ${JSON.stringify(rev.prior[key])} → ${JSON.stringify(rev.next[key])}`).join('; ')
          : `successCriteria: ${JSON.stringify(rev.from)} → ${JSON.stringify(rev.to)}`;
        lines.push(`- **${task.title}** (${rev.afterRun ? 'after a run was recorded' : 'before any run'}, ${rev.at}): ${changes}`);
      }
    }
    lines.push('');
  }

  fs.mkdirSync(ROOT, { recursive: true });
  const file = path.join(ROOT, 'REPORT.md');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`\nwrote ${file}`);
  console.log(`  ${complete.length} task(s) paired, ${assessed.length} assessed, ${highStakes.length} high stakes\n`);
}

const [, , command, taskId] = process.argv;
const commands = {
  define: () => define(taskId),
  agent: () => runAgent(taskId),
  manual: () => recordManual(taskId),
  score: () => score(taskId),
  report,
};

if (!commands[command]) {
  console.log('\nusage: node advantage.js <define|agent|manual|score|report> [taskId] [options]\n');
  process.exit(1);
}
if (command !== 'report' && (!taskId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId))) die('Use a task id containing only letters, digits, underscores and hyphens, e.g. t1.');
await commands[command]();
