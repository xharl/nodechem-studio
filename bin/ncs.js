#!/usr/bin/env node
/**
 * `ncs` — the headless entry point.
 *
 * It does not reimplement anything: validation is `validateProject`, the tasks
 * come from `buildWorkflowTasks` (the same function the Run workflow button
 * calls), and execution goes through the same `RunManager`/`QueueManager` the
 * Electron main process uses. What the CLI writes under `--out` is the folder
 * layout the app writes under its user-data directory.
 *
 * Exit codes:
 *   0  success
 *   2  the project does not validate, or a task cannot be built
 *   3  a run finished but its gates failed (queue reached needs-review)
 *   4  a run or the queue failed outright
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowTasks } from '../src/shared/workflowTasks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

const EXIT = Object.freeze({ ok: 0, usage: 1, invalid: 2, gate: 3, engine: 4 });
const TERMINAL = new Set(['completed', 'failed', 'needs-review', 'blocked', 'cancelled']);

const USAGE = `ncs — headless NodeChem Studio

  ncs validate <project.ncs> [--json]
  ncs build-input <project.ncs> --node <id> [--out <file>]
  ncs run <project.ncs> --out <dir> [--dry-run] [--executable <path>]
      [--timeout <seconds>] [--json]

Exit codes: 0 success, 2 invalid project, 3 gate failure, 4 engine failure.
`;

function fail(message, code = EXIT.usage) {
  process.stderr.write(`ncs: ${message}\n`);
  if (code === EXIT.usage) process.stderr.write(`\n${USAGE}`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(item);
    }
  }
  return { command, positional, flags };
}

async function readProject(file) {
  const raw = await fs.readFile(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`, EXIT.invalid);
  }
  const result = validateProject(parsed);
  return { file, raw, result };
}

function validityJson(file, result) {
  return {
    ok: result.ok,
    file,
    schemaVersion: result.schemaVersion,
    migrated: result.migrated,
    errors: result.errors,
    warnings: result.warnings,
    validity: result.validity,
  };
}

async function commandValidate({ positional, flags }) {
  const [file] = positional;
  if (!file) fail('validate needs a project file.');
  const { result } = await readProject(file);
  const payload = validityJson(file, result);
  if (flags.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(result.ok ? `${file}: valid\n` : `${file}: invalid\n`);
    for (const issue of result.errors) process.stdout.write(`  ${issue.path || '<root>'}: ${issue.message}\n`);
  }
  process.exit(result.ok ? EXIT.ok : EXIT.invalid);
}

async function commandBuildInput({ positional, flags }) {
  const [file] = positional;
  if (!file) fail('build-input needs a project file.');
  if (!flags.node) fail('build-input needs --node <id>.');
  const { result } = await readProject(file);
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(validityJson(file, result), null, 2)}\n`);
    process.exit(EXIT.invalid);
  }
  const node = result.project.nodes.find((entry) => entry.id === flags.node);
  if (!node) fail(`no node "${flags.node}" in ${file}.`, EXIT.invalid);
  let built;
  try {
    const { buildRunInput } = await import('../src/shared/workflowTasks.js');
    built = buildRunInput(result.project, node);
  } catch (error) {
    fail(error.message, EXIT.invalid);
  }
  if (flags.out) {
    await fs.writeFile(path.resolve(String(flags.out)), built.inputText, 'utf8');
    process.stdout.write(`${path.resolve(String(flags.out))}\n`);
  } else {
    process.stdout.write(built.inputText);
  }
  process.exit(EXIT.ok);
}

async function readRunRecord(runDir) {
  if (!runDir) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function commandRun({ positional, flags }) {
  const [file] = positional;
  if (!file) fail('run needs a project file.');
  const outDir = path.resolve(String(flags.out || './ncs-runs'));
  const { result } = await readProject(file);
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(validityJson(file, result), null, 2)}\n`);
    process.exit(EXIT.invalid);
  }

  let tasks;
  try {
    tasks = buildWorkflowTasks(result.project);
  } catch (error) {
    fail(error.message, EXIT.invalid);
  }

  const runsRoot = path.join(outDir, 'runs');
  const queuesRoot = path.join(outDir, 'queues');
  await fs.mkdir(runsRoot, { recursive: true });
  await fs.mkdir(queuesRoot, { recursive: true });

  const events = [];
  const runManager = new RunManager({
    runsRoot,
    emit: (event) => events.push(event),
    appInfo: { version: 'cli', commit: null },
  });
  const queueManager = new QueueManager({
    queuesRoot,
    runManager,
    emit: (event) => events.push(event),
  });
  await queueManager.init();

  const started = await queueManager.start({
    projectName: result.project.name || path.basename(file),
    tasks,
    edges: result.project.edges,
    options: {
      dryRun: Boolean(flags['dry-run']),
      executable: flags.executable ? String(flags.executable) : '',
      scratchDir: '',
    },
  }).catch((error) => fail(`queue did not start: ${error.message}`, EXIT.engine));

  const queueId = started?.id;
  if (!queueId) fail('the queue started without an id.', EXIT.engine);

  const timeoutSeconds = Number(flags.timeout || 3600);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let queue = await queueManager.get(queueId);
  while (queue && !TERMINAL.has(String(queue.status)) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
    queue = await queueManager.get(queueId);
  }
  if (!queue || !TERMINAL.has(String(queue.status))) {
    runManager.cancelAll?.();
    fail(`the queue did not finish within ${timeoutSeconds}s (status: ${queue?.status || 'unknown'}).`, EXIT.engine);
  }

  const summary = {
    queueId,
    status: queue.status,
    outDir,
    runs: await Promise.all((queue.tasks || []).map(async (task) => {
      const record = await readRunRecord(task.runDir);
      return {
        nodeId: task.nodeId,
        runId: task.runId || null,
        status: task.status,
        gates: record?.gates?.overall || null,
        termination: record?.parsed?.termination || null,
        error: record?.error || null,
        runDir: task.runDir || null,
      };
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  // A run whose gates failed did compute something; a run that errored did
  // not. The two exit codes must not be confused: 3 means "the result exists
  // but does not meet the requested criteria", 4 means "nothing usable".
  const gateFailed = summary.runs.filter((run) => run.gates === 'fail' || run.status === 'needs-review');
  const engineFailed = summary.runs.filter((run) => !gateFailed.includes(run)
    && (run.error || run.status === 'failed' || run.status === 'cancelled'));
  if (engineFailed.length > 0) process.exit(EXIT.engine);
  if (gateFailed.length > 0 || queue.status === 'needs-review') process.exit(EXIT.gate);
  process.exit(EXIT.ok);
}

const { command, positional, flags } = parseArgs(process.argv.slice(2));
if (!command || command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(USAGE);
  process.exit(command ? EXIT.ok : EXIT.usage);
}
const handlers = {
  validate: commandValidate,
  'build-input': commandBuildInput,
  run: commandRun,
};
const handler = handlers[command];
if (!handler) fail(`unknown command "${command}".`);
await handler({ positional, flags });
