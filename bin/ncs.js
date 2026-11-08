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
 *   5  the queue is partial (some records failed) or a merge conflicted
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { diffProjects, mergeProjects } from '../src/shared/projectMerge.js';
import { flowById } from '../src/shared/flows.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { buildWorkflowReport, buildCombinedReportHtml, workflowReportHtml } from '../src/shared/workflowReport.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseStructureRecords } from '../src/shared/structureImport.js';
import { convertParsed, convertStructure } from '../src/shared/converters/index.js';
import { cacheFromCube, cacheFromParsed, cacheInfo, writeCache } from '../src/shared/cache.js';
import { parseCube } from '../src/shared/cubeFile.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

const EXIT = Object.freeze({ ok: 0, usage: 1, invalid: 2, gate: 3, engine: 4, conflict: 5, partial: 5 });
const TERMINAL = new Set(['completed', 'failed', 'needs-review', 'partial', 'blocked', 'cancelled']);

const USAGE = `ncs — headless NodeChem Studio

  ncs validate <project.ncs> [--json]
  ncs build-input <project.ncs> --node <id> [--out <file>]
  ncs run <project.ncs> --out <dir> [--dry-run] [--flow <id>] [--record <id>]
      [--max-parallel N] [--executable <path>] [--crest <path>]
      [--timeout <seconds>] [--json]
  ncs report <out-dir> [--flow <id>] [--out <file>]
  ncs diff <a.ncs> <b.ncs> [--json]
  ncs merge <base.ncs> <ours.ncs> <theirs.ncs> --out <file> [--json]
  ncs convert <input> --format <extxyz|xyz|sdf|jcamp> [--spectrum ir|raman|uv]
      [--out <file>] [--json]
  ncs cache <run.log|field.cube> --out <file.ncsr> [--precision f64|f32] [--json]
  ncs cache <file.ncsr> --inspect [--json]

Exit codes: 0 success, 2 invalid project, 3 gate failure, 4 engine failure,
5 partial queue (some records failed) or merge conflict.
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

  let plan;
  try {
    // RFC 0001: `--flow` selects a flow; without it the project's active flow
    // runs, exactly as the app's Run button does.
    if (flags.flow !== undefined && typeof flags.flow !== 'string') {
      fail('--flow needs a flow id.', EXIT.usage);
    }
    if (flags.record !== undefined && typeof flags.record !== 'string') {
      fail('--record needs a record id.', EXIT.usage);
    }
    if (flags['max-parallel'] !== undefined && typeof flags['max-parallel'] !== 'string') {
      fail('--max-parallel needs a positive integer.', EXIT.usage);
    }
    const requestedFlow = typeof flags.flow === 'string' ? String(flags.flow) : null;
    if (requestedFlow && !flowById(result.project, requestedFlow)) {
      fail(`no flow "${requestedFlow}" in ${file}.`, EXIT.invalid);
    }
    plan = buildWorkflowPlan(result.project, { flowId: requestedFlow || result.project.activeFlowId || null });
  } catch (error) {
    fail(error.message, EXIT.invalid);
  }
  let { tasks, edges: plannedEdges } = plan;

  // RFC 0001: one record's subgraph plus the control blocks that collect it.
  // Control blocks have no `recordId`, so they are kept; edges to dropped tasks
  // are dropped with them.
  if (typeof flags.record === 'string') {
    const recordId = String(flags.record);
    if (!plan.tasks.some((task) => task.recordId === recordId)) {
      fail(`no record "${recordId}" in flow "${plan.flowId}".`, EXIT.invalid);
    }
    const kept = new Set(plan.tasks
      .filter((task) => !task.recordId || task.recordId === recordId)
      .map((task) => task.nodeId));
    tasks = plan.tasks.filter((task) => kept.has(task.nodeId));
    plannedEdges = plan.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  }

  // RFC 0001: the project's runner.maxParallel is the default; the flag wins.
  // The queue clamps the value to its own limit.
  const projectParallel = Number(result.project.runner?.maxParallel);
  let maxParallel = Number.isFinite(projectParallel) && projectParallel >= 1
    ? Math.trunc(projectParallel) : 1;
  if (flags['max-parallel'] !== undefined) {
    const requested = Number(flags['max-parallel']);
    if (!Number.isInteger(requested) || requested < 1) {
      fail('--max-parallel needs a positive integer.', EXIT.usage);
    }
    maxParallel = requested;
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
    // `--out` is the folder the user named: output blocks write `reports/…`
    // and `manifest.json` beside `queues/`, not inside the queue folder.
    artifactsRoot: outDir,
  });
  await queueManager.init();

  const started = await queueManager.start({
    projectName: result.project.name || path.basename(file),
    // The queue names the flow it ran, so `ncs report` can title each section
    // after the tab it came from instead of repeating the project name.
    flowId: plan.flowId || null,
    flowTitle: flowById(result.project, plan.flowId)?.title || null,
    tasks,
    edges: plannedEdges,
    options: {
      dryRun: Boolean(flags['dry-run']),
      executable: flags.executable ? String(flags.executable) : '',
      // A workflow with a CREST block needs the binary the same way a
      // calculation block needs its engine; the queue fails by name otherwise.
      crestExecutable: flags.crest ? String(flags.crest) : '',
      scratchDir: '',
      maxParallel,
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
    ladders: queue.ladders || {},
    spins: queue.spins || {},
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

  // A partial queue is its own outcome (RFC 0001): some records finished, some
  // did not. It must win over the engine/gate codes so CI can tell "3 of 200
  // failed" from "nothing ran" (4) and from "results exist but need review" (3).
  const gateFailed = summary.runs.filter((run) => run.gates === 'fail' || run.status === 'needs-review');
  const engineFailed = summary.runs.filter((run) => !gateFailed.includes(run)
    && (run.error || run.status === 'failed' || run.status === 'cancelled'));
  if (queue.status === 'partial') process.exit(EXIT.partial);
  if (engineFailed.length > 0) process.exit(EXIT.engine);
  if (gateFailed.length > 0 || queue.status === 'needs-review') process.exit(EXIT.gate);
  process.exit(EXIT.ok);
}

/** A queue's flow, read from its tasks (the queue record predates `flowId`). */
function queueFlowId(queue) {
  const task = (Array.isArray(queue?.tasks) ? queue.tasks : []).find((entry) => entry?.flowId);
  return task?.flowId || queue?.flowId || 'main';
}

/** Dataset record metadata from a stored queue, for report labels. */
function queueRecordInfo(queue) {
  const info = new Map();
  for (const task of Array.isArray(queue?.tasks) ? queue.tasks : []) {
    if (!task.recordId || info.has(task.recordId)) continue;
    info.set(task.recordId, {
      id: task.recordId,
      label: task.record?.label || task.recordId,
      charge: Number.isInteger(task.record?.charge) ? task.record.charge : null,
      multiplicity: Number.isInteger(task.record?.multiplicity) ? task.record.multiplicity : null,
    });
  }
  return [...info.values()];
}

/** Read every `run.json` a queue points at, keyed by run id and node id. */
async function queueRunRecords(queue) {
  const records = {};
  for (const task of Array.isArray(queue?.tasks) ? queue.tasks : []) {
    if (!task.runDir) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const record = JSON.parse(await fs.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
      if (task.runId) records[task.runId] = record;
      if (task.nodeId && !records[task.nodeId]) records[task.nodeId] = record;
    } catch {
      // A run folder without run.json is reported as a failure, not guessed.
    }
  }
  return records;
}

/**
 * `ncs report` — rebuild the HTML report from the last queue on disk.
 *
 * With one flow, the output is the same self-contained document an output block
 * writes. With several flows in the folder (or without `--flow`), the newest
 * queue per flow is combined into one report with an index that names failed
 * and partial records; `--flow` restricts it to one flow.
 */
async function commandReport({ positional, flags }) {
  const [outArg] = positional;
  if (!outArg) fail('report needs an output directory.');
  const outDir = path.resolve(outArg);
  const queuesDir = path.join(outDir, 'queues');
  let entries;
  try {
    entries = await fs.readdir(queuesDir, { withFileTypes: true });
  } catch {
    fail(`${outDir} has no queues folder; run a workflow first.`, EXIT.invalid);
  }

  const queues = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const queue = JSON.parse(await fs.readFile(path.join(queuesDir, entry.name, 'queue.json'), 'utf8'));
      if (queue?.id) queues.push(queue);
    } catch {
      // An unreadable queue is skipped; a later one may still be reportable.
    }
  }
  if (queues.length === 0) fail(`no readable queue.json under ${queuesDir}.`, EXIT.invalid);

  // Newest first, then one per flow: the report describes the latest run of
  // each flow, not an arbitrary mix of attempts.
  queues.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  const wantedFlow = typeof flags.flow === 'string' ? String(flags.flow) : null;
  const selected = new Map();
  for (const queue of queues) {
    const flowId = queueFlowId(queue);
    if (wantedFlow && flowId !== wantedFlow) continue;
    if (!selected.has(flowId)) selected.set(flowId, queue);
  }
  if (selected.size === 0) fail(`no queue for flow "${wantedFlow}" under ${outDir}.`, EXIT.invalid);

  const generatedAt = new Date().toISOString();
  const models = [];
  for (const [flowId, queue] of selected) {
    models.push(buildWorkflowReport({ ...queue, flowId }, await queueRunRecords(queue), {
      generatedAt,
      appVersion: 'cli',
      recordInfo: queueRecordInfo(queue),
    }));
  }

  const html = models.length === 1
    ? workflowReportHtml(models[0])
    : buildCombinedReportHtml(models, {
      title: `Project report — ${models[0].queue.projectName || path.basename(outDir)}`,
      generatedAt,
    });
  const outFile = path.resolve(String(flags.out || path.join(outDir, 'reports', 'index.html')));
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, 'utf8');
  process.stdout.write(`${outFile}\n`);
  process.exit(EXIT.ok);
}

async function commandDiff({ positional, flags }) {
  const [a, b] = positional;
  if (!a || !b) fail('diff needs two project files.');
  const left = await readProject(a);
  const right = await readProject(b);
  if (!left.result.ok || !right.result.ok) {
    process.stderr.write(`${JSON.stringify({ a: validityJson(a, left.result), b: validityJson(b, right.result) }, null, 2)}\n`);
    process.exit(EXIT.invalid);
  }
  const diff = diffProjects(left.result.project, right.result.project);
  if (flags.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    process.exit(EXIT.ok);
  }
  if (diff.empty) {
    process.stdout.write(`${a} and ${b} are structurally identical.\n`);
    process.exit(EXIT.ok);
  }
  for (const id of diff.nodes.added) process.stdout.write(`+ node ${id}\n`);
  for (const id of diff.nodes.removed) process.stdout.write(`- node ${id}\n`);
  for (const entry of diff.nodes.changed) {
    for (const field of entry.fields) process.stdout.write(`~ ${entry.id}.${field.field}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}\n`);
  }
  for (const key of diff.edges.added) process.stdout.write(`+ edge ${key}\n`);
  for (const key of diff.edges.removed) process.stdout.write(`- edge ${key}\n`);
  for (const entry of diff.meta) process.stdout.write(`~ ${entry.field}\n`);
  process.exit(EXIT.ok);
}

async function commandMerge({ positional, flags }) {
  const [baseFile, oursFile, theirsFile] = positional;
  if (!baseFile || !oursFile || !theirsFile) fail('merge needs <base> <ours> <theirs>.');
  const base = await readProject(baseFile);
  const ours = await readProject(oursFile);
  const theirs = await readProject(theirsFile);
  if (!base.result.ok || !ours.result.ok || !theirs.result.ok) {
    process.stderr.write(`${JSON.stringify({ base: validityJson(baseFile, base.result), ours: validityJson(oursFile, ours.result), theirs: validityJson(theirsFile, theirs.result) }, null, 2)}\n`);
    process.exit(EXIT.invalid);
  }
  const merged = mergeProjects(base.result.project, ours.result.project, theirs.result.project);
  if (!merged.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, conflicts: merged.conflicts }, null, 2)}\n`);
    process.stderr.write(`ncs: ${merged.conflicts.length} conflict(s); nothing was written.\n`);
    process.exit(EXIT.conflict);
  }
  // Serialise through the same writer the app uses, so a merged file is byte
  // shaped like a saved one rather than a raw JSON dump.
  const serialized = stringifyProject(merged.project);
  if (!serialized.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, errors: serialized.errors || [] }, null, 2)}\n`);
    process.exit(EXIT.invalid);
  }
  const out = path.resolve(String(flags.out || oursFile));
  await fs.writeFile(out, serialized.text, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, out, diff: diffProjects(ours.result.project, serialized.project) }, null, 2)}\n`);
  process.exit(EXIT.ok);
}

/**
 * `ncs convert` — turn a finished log, a structure file or a saved project into
 * a format other software reads. The engine-specific parsing stops at the door:
 * every branch produces atoms, frames or spectra, and the converters never ask
 * which program produced them.
 */
async function commandConvert({ positional, flags }) {
  const [input] = positional;
  if (!input) fail('convert needs an input file.');
  const formatId = String(flags.format || '').trim();
  if (!formatId) fail('convert needs --format <extxyz|xyz|sdf|jcamp>.');
  const file = path.resolve(input);

  try {
    const text = await fs.readFile(file, 'utf8');
    const extension = path.extname(file).toLowerCase();
    let converted;
    if (extension === '.ncs') {
      const parsed = JSON.parse(text);
      const coords = parsed?.molecule?.coords;
      if (!Array.isArray(coords) || coords.length === 0) fail('this project has no molecule to export.');
      converted = convertStructure({ atoms: coords, bonds: parsed?.molecule?.bonds }, formatId, {
        title: parsed?.name || path.basename(file, extension),
      });
    } else if (extension === '.log' || extension === '.out') {
      const parsed = parseGaussianOutput(text);
      converted = convertParsed(parsed, formatId, {
        spectrum: String(flags.spectrum || 'ir'),
        title: path.basename(file, extension),
      });
    } else {
      const { records } = parseStructureRecords(text, { filename: path.basename(file) });
      const first = records[0];
      if (!first) fail('the structure file contained no records.');
      converted = convertStructure({ atoms: first.atoms, bonds: first.bonds }, formatId, { title: first.name });
    }

    const out = flags.out ? path.resolve(String(flags.out)) : `${file.slice(0, file.length - extension.length)}.${converted.extension}`;
    await fs.writeFile(out, converted.text, 'utf8');
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true, format: converted.format, out, mediaType: converted.mediaType, bytes: Buffer.byteLength(converted.text), notes: converted.notes,
      }, null, 2)}\n`);
    } else {
      for (const note of converted.notes || []) process.stdout.write(`note: ${note}\n`);
      process.stdout.write(`${converted.format} written to ${out} (${Buffer.byteLength(converted.text)} bytes)\n`);
    }
    process.exit(EXIT.ok);
  } catch (error) {
    process.stderr.write(`ncs: ${error.message}\n`);
    process.exit(EXIT.invalid);
  }
}


/**
 * `ncs cache` — write a parsed run or a volumetric field as typed arrays, or
 * inspect an existing cache. The cache is what a viewer should read: the cost
 * of opening a trajectory stops depending on how many characters the log has.
 */
async function commandCache({ positional, flags }) {
  const [input] = positional;
  if (!input) fail('cache needs an input file.');
  const file = path.resolve(input);
  let buffer;
  try {
    buffer = await fs.readFile(file);
  } catch (error) {
    fail(`cannot read ${input}: ${error.message}`, EXIT.invalid);
  }

  if (path.extname(file).toLowerCase() === '.ncsr') {
    const info = cacheInfo(buffer);
    if (flags.json || !process.stdout.isTTY) {
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      process.exit(EXIT.ok);
    }
    process.stdout.write(`cache version ${info.version}, written ${info.createdAt || 'unknown'}\n`);
    for (const [key, value] of Object.entries(info.meta || {})) {
      if (typeof value === 'object' && value !== null) continue;
      process.stdout.write(`  ${key}: ${value}\n`);
    }
    for (const section of info.sections) process.stdout.write(`  section ${section.name} (${section.dtype}, ${section.length})\n`);
    process.exit(EXIT.ok);
  }

  const text = buffer.toString('utf8');
  const extension = path.extname(file).toLowerCase();
  let cache;
  try {
    if (extension === '.cube') {
      cache = cacheFromCube(parseCube(text), { precision: String(flags.precision || 'f64') });
    } else {
      cache = cacheFromParsed(parseGaussianOutput(text));
    }
  } catch (error) {
    process.stderr.write(`ncs: ${error.message}\n`);
    process.exit(EXIT.invalid);
  }
  const bytes = writeCache(cache);
  const out = flags.out ? path.resolve(String(flags.out)) : `${file.slice(0, file.length - extension.length)}.ncsr`;
  await fs.writeFile(out, bytes);
  const payload = {
    ok: true,
    out,
    kind: cache.meta.kind,
    bytes: bytes.length,
    sourceBytes: buffer.length,
    ratio: buffer.length > 0 ? Number((bytes.length / buffer.length).toFixed(3)) : null,
    sections: cache.sections.map((section) => section.name),
  };
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`cache written to ${out}: ${bytes.length} bytes from ${buffer.length} (ratio ${payload.ratio})\n`);
  }
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
  report: commandReport,
  diff: commandDiff,
  merge: commandMerge,
  convert: commandConvert,
  cache: commandCache,
};
const handler = handlers[command];
if (!handler) fail(`unknown command "${command}".`);
await handler({ positional, flags });
