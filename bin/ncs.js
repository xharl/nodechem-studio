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
 *   1  the command was used incorrectly
 *   2  the project does not validate, a task cannot be built, or a QCSchema
 *      document/payload does not conform (see `ncs qcschema` for its codes)
 *   3  a run finished but its gates failed (queue reached needs-review)
 *   4  a run or the queue failed outright
 *   5  the queue is partial (some records failed) or a merge conflicted
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import { stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { diffProjects, mergeProjects } from '../src/shared/projectMerge.js';
import { flowById } from '../src/shared/flows.js';
import { buildWorkflowPlan, moleculeForNode, settingsForNode } from '../src/shared/workflowTasks.js';
import { buildWorkflowReport, buildCombinedReportHtml, workflowReportHtml } from '../src/shared/workflowReport.js';
import { parseGaussianOutput, geometryToXyz } from '../src/shared/gaussianOutput.js';
import { parseStructureRecords } from '../src/shared/structureImport.js';
import { kineticsSummary } from '../src/shared/kinetics.js';
import { convertFchk, convertParsed, convertStructure } from '../src/shared/converters/index.js';
import {
  QCSchemaError,
  atomicResultFromRun,
  atomsFromRun,
  gaussianInputMolecule,
  moleculeFromRun,
  qcschemaSchemaPath,
  readQcschema,
  stringifyQcschema,
  structureFromQcschema,
} from '../src/shared/qcschema.js';
import { parseFchk } from '../src/shared/fchk.js';
import { EXPORT_ENGINE_IDS, exporterFor, parseSmiles, parseSmilesList, renderInput } from '../src/shared/interop/index.js';
import { cacheFromCube, cacheFromParsed, cacheInfo, writeCache } from '../src/shared/cache.js';
import { parseCube, writeCube } from '../src/shared/cubeFile.js';
import {
  evaluateOrbital,
  fieldOfValues,
  gridFor,
  integrateField,
} from '../src/shared/volume.js';
import { detectWavefunctionFormat } from '../src/shared/wavefunction.js';
import { parseMolden } from '../src/shared/molden.js';
import { parseWfn } from '../src/shared/wfn.js';
import { parseWfx } from '../src/shared/wfx.js';
import { extractSurface } from '../src/shared/marchingCubes.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import {
  RECORD_SCHEMA_VERSION,
  recordSchemaPath,
  recordSchemaVersions,
  validateRecord,
} from '../schemas/record-schema.js';
import {
  ImportedRecordError,
  buildImportedRecord,
  importedBadgeLabel,
  validateImportedRecord,
} from '../src/shared/importedRecord.js';

const EXIT = Object.freeze({ ok: 0, usage: 1, invalid: 2, gate: 3, engine: 4, conflict: 5, partial: 5 });
const TERMINAL = new Set(['completed', 'failed', 'needs-review', 'partial', 'blocked', 'cancelled']);

const USAGE = `ncs — headless NodeChem Studio

  ncs validate <project.ncs> [--json]
  ncs build-input <project.ncs> --node <id> [--out <file>]
  ncs run <project.ncs> --out <dir> [--dry-run] [--flow <id>] [--record <id>]
      [--max-parallel N] [--executable <path>] [--crest <path>]
      [--timeout <seconds>] [--json]
  ncs report <out-dir> [--flow <id>] [--include-imported] [--figures basic|surfaces|none] [--out <file>]
  ncs export <out-dir> [--json] [--schema-version <n>] [--out <file>]
  ncs record import --program <name> --version <version> --method <method>
      --basis <basis> --energy <hartree> (--source <file>|--source-sha256 <hex>)
      --out <out-dir|file.json> [--id <id>] [--title <text>] [--notes <text>]
      [--json]
  ncs diff <a.ncs> <b.ncs> [--json]
  ncs merge <base.ncs> <ours.ncs> <theirs.ncs> --out <file> [--json]
  ncs convert <input> --format <extxyz|xyz|sdf|jcamp|molden> [--spectrum ir|raman|uv]
      [--out <file>] [--json]
  ncs export-input <project.ncs> --node <id> --engine <nwchem|gamess|qchem>
      [--out <file>] [--json]
  ncs smiles <file|string> [--name <label>] [--out <file.json>] [--json]
  ncs qcschema export <run-dir|out-dir> [--run <id>] [--charge <n>]
      [--multiplicity <n>] [--out <file>] [--json]
  ncs qcschema import <file> [--out <file.xyz|file.json>] [--json]
  ncs cache <run.log|field.cube> --out <file.ncsr> [--precision f64|f32] [--json]
  ncs cache <file.ncsr> --inspect [--json]
  ncs cube <run-dir|wavefunction> --orbital homo|lumo|n=<i> --out <file.cube>
      [--units bohr|angstrom] [--grid <angstrom>] [--padding <angstrom>] [--json]

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
      // `--key value` and `--key=value` are both accepted: the second is what
      // people type, and a flag silently read as unset is the worst outcome.
      const body = item.slice(2);
      const equals = body.indexOf('=');
      if (equals > 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
      } else {
        const key = body;
        const next = rest[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          index += 1;
        } else {
          flags[key] = true;
        }
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
    // A relative conformer `importPath` resolves against the project file's
    // folder, so a project that ships beside its ensemble can be moved.
    projectDir: path.dirname(path.resolve(file)),
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
      // Issue 177: the project's per-task wall clock. Absent from the project
      // means the queue applies its own 3600 s default — never "no limit".
      ...(Number(result.project.runner?.timeoutSeconds) > 0
        ? { timeoutSeconds: Number(result.project.runner.timeoutSeconds) }
        : {}),
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

  // A project may declare combined reports (`reports[]`). They are written from
  // the queues this run left behind, so `ncs run` alone produces the document —
  // no second command, and no stale report from an earlier run.
  const declared = await emitDeclaredReports(result.project, outDir)
    .catch((error) => fail(`declared report: ${error.message}`, EXIT.invalid));

  const runRecords = {};
  const runEntries = await Promise.all((queue.tasks || []).map(async (task) => {
    const record = await readRunRecord(task.runDir);
    if (record) {
      runRecords[task.nodeId] = record;
      if (task.runId) runRecords[task.runId] = record;
    }
    return {
      nodeId: task.nodeId,
      runId: task.runId || null,
      status: task.status,
      gates: record?.gates?.overall || null,
      termination: record?.parsed?.termination || null,
      error: record?.error || null,
      runDir: task.runDir || null,
    };
  }));

  // Eyring rates for the reaction paths this queue evaluated, with the unit
  // derived from the reactant block's fragments. Existing summary keys keep
  // their shape; a project with no reaction path has no `kinetics` key.
  const kinetics = kineticsSummary({ project: result.project, queue, runRecords });

  const summary = {
    queueId,
    status: queue.status,
    outDir,
    reports: declared,
    ladders: queue.ladders || {},
    spins: queue.spins || {},
    ...(kinetics.length > 0 ? { kinetics } : {}),
    runs: runEntries,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  // A partial queue is its own outcome (RFC 0001): some records finished, some
  // did not. It must win over the engine/gate codes so CI can tell "3 of 200
  // failed" from "nothing ran" (4) and from "results exist but need review" (3).
  const gateFailed = summary.runs.filter((run) => run.gates === 'fail' || run.status === 'needs-review');
  const engineFailed = summary.runs.filter((run) => !gateFailed.includes(run)
    && (run.error || run.status === 'failed' || run.status === 'cancelled'
      // Issue 177: a task the queue stopped at its wall clock did not produce a
      // result; a script that treated that as success would ship nothing.
      || run.status === 'timed out'));
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
/**
 * The report model of the newest queue of each flow under `outDir`.
 *
 * `flows` narrows the selection to the flows a `reports[]` entry names; a
 * single `flow` does the same for `ncs report --flow`. A flow with no queue is
 * simply absent: the report describes what ran.
 */
async function collectReportModels(outDir, { flow = null, flows = null, includeImported = false, figures = 'basic' } = {}) {
  const queuesDir = path.join(outDir, 'queues');
  let entries;
  try {
    entries = await fs.readdir(queuesDir, { withFileTypes: true });
  } catch {
    // A folder that never ran anything can still hold imported records, so an
    // absent queues/ directory is not the end of the report.
    entries = [];
  }

  const queues = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const queue = JSON.parse(await fs.readFile(path.join(queuesDir, entry.name, 'queue.json'), 'utf8'));
      if (queue?.id) queues.push(queue);
    } catch {
      // An unreadable queue is skipped; a later one may still be reportable.
    }
  }

  // Newest first, then one per flow: the report describes the latest run of
  // each flow, not an arbitrary mix of attempts.
  queues.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  const wanted = flow ? new Set([String(flow)])
    : Array.isArray(flows) && flows.length > 0 ? new Set(flows.map(String)) : null;
  const selected = new Map();
  for (const queue of queues) {
    const flowId = queueFlowId(queue);
    if (wanted && !wanted.has(flowId)) continue;
    if (!selected.has(flowId)) selected.set(flowId, queue);
  }

  const generatedAt = new Date().toISOString();
  const models = [];
  for (const [flowId, queue] of selected) {
    // eslint-disable-next-line no-await-in-loop
    const records = await queueRunRecords(queue);
    // A slice figure needs a volume. With --figures=surfaces the cube files the
    // block read are parsed from the run folder; without one the figure says so.
    // eslint-disable-next-line no-await-in-loop
    const volumes = figures === 'none' ? null : await cubeVolumesFor(queue);
    const surfaces = figures === 'surfaces' ? await surfacesFor(volumes) : null;
    models.push(buildWorkflowReport({ ...queue, flowId }, records, {
      generatedAt,
      appVersion: 'cli',
      recordInfo: queueRecordInfo(queue),
      includeImported,
      figureLevel: figures,
      volumes,
      surfaces,
    }));
  }

  // `ncs record import --out <dir>` writes runs/<id>/run.json, which belongs to
  // no queue: an imported number does not come from a run this app performed, so
  // there is no task to hang it on. It is still reported — silently dropping it
  // because nothing in the folder ran would hide exactly the thing the record
  // exists to say — under its own section, one row per record.
  const referenced = new Set();
  for (const queue of selected.values()) {
    for (const task of Array.isArray(queue.tasks) ? queue.tasks : []) {
      if (task?.runDir) referenced.add(path.resolve(task.runDir));
      if (task?.runId) referenced.add(`id:${task.runId}`);
      if (task?.nodeId) referenced.add(`id:${task.nodeId}`);
    }
  }
  for (const record of await orphanImportedRecords(outDir, referenced)) {
    // eslint-disable-next-line no-await-in-loop
    const model = buildWorkflowReport(
      { id: record.id, flowId: 'imported', name: 'Imported results', createdAt: record.importedAt || null,
        tasks: [{ nodeId: record.id, runId: record.id, runDir: record.runDir, type: 'imported', status: 'completed' }] },
      { [record.id]: record.document },
      { generatedAt, appVersion: 'cli', includeImported },
    );
    if (model) models.push(model);
  }
  return models;
}

/**
 * Isosurfaces for the volumes, when `--figures=surfaces` was asked for.
 *
 * The isovalue is a stated fraction (10 %) of the field's largest absolute value
 * rather than a magic constant, and the two lobes are meshed separately at +iso
 * and −iso so their phases stay apart. A volume too dense to mesh within the cap
 * returns null and the figure says so.
 */
async function surfacesFor(volumes) {
  if (!volumes) return null;
  const out = {};
  for (const [nodeId, volume] of Object.entries(volumes)) {
    if (!volume || !Array.isArray(volume.counts) || volume.axisAligned === false) continue;
    const iso = Math.max(Math.abs(volume.min ?? 0), Math.abs(volume.max ?? 0)) * 0.1;
    if (!(iso > 0)) continue;
    const step = Array.isArray(volume.step) ? volume.step : [volume.step, volume.step, volume.step];
    const field = {
      dims: volume.counts,
      origin: volume.origin,
      step: volume.step,
      axes: [[step[0], 0, 0], [0, step[1], 0], [0, 0, step[2]]],
      values: volume.values,
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      const positive = extractSurface(field, iso, { maxTriangles: 20000 });
      // eslint-disable-next-line no-await-in-loop
      const negative = extractSurface(field, -iso, { maxTriangles: 20000 });
      out[nodeId] = {
        iso,
        meshes: [
          { positions: positive.positions, normals: positive.normals, sign: 1 },
          { positions: negative.positions, normals: negative.normals, sign: -1 },
        ].filter((mesh) => mesh.positions.length > 0),
      };
    } catch {
      // A field that cannot be meshed is reported by the figure, not thrown here.
    }
  }
  return out;
}

/**
 * Parsed cube volumes for the tasks of a queue, keyed by node id.
 *
 * Only a cube file that sits in the task's own run folder is read: the report
 * may not reach outside the folder it is documenting, and a volume from
 * somewhere else would be a figure about a different file.
 */
async function cubeVolumesFor(queue) {
  const volumes = {};
  for (const task of Array.isArray(queue.tasks) ? queue.tasks : []) {
    if (!task?.runDir || !task.nodeId) continue;
    let entries;
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await fs.readdir(task.runDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const cube = entries.find((entry) => entry.isFile() && /\.cube$/i.test(entry.name));
    if (!cube) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fs.readFile(path.join(task.runDir, cube.name), 'utf8');
      const parsedCube = parseCube(text);
      // The figure slices in index space and labels the axes in Å, which is only
      // true when the cube's axes are axis-aligned: a rotated cube is reported
      // rather than drawn as if it were an xy plane.
      const axisAligned = parsedCube.axes.every((vector, index) => vector
        .every((component, componentIndex) => (componentIndex === index ? true : Math.abs(component) < 1e-6)));
      volumes[task.nodeId] = {
        values: parsedCube.values,
        origin: parsedCube.origin,
        step: parsedCube.spacing,
        counts: parsedCube.dims,
        min: parsedCube.stats?.min ?? 0,
        max: parsedCube.stats?.max ?? 0,
        axisAligned,
        source: cube.name,
      };
    } catch {
      // An unreadable cube is not a figure; the report says the slice is absent.
    }
  }
  return volumes;
}

/** Imported records written under `runs/` by `ncs record import`, newest first. */
async function orphanImportedRecords(outDir, referenced = new Set()) {
  const runsDir = path.join(outDir, 'runs');
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const document = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
      if (document?.kind !== 'imported') continue;
      // A record a queue already reads through its task is reported there: it
      // must not appear twice because it also sits under runs/.
      if (referenced.has(path.resolve(runDir)) || referenced.has(`id:${document.id || entry.name}`)) continue;
      found.push({ id: document.id || entry.name, runDir, document, importedAt: document.importedAt || '' });
    } catch {
      // A run folder without a readable run.json is not an imported record.
    }
  }
  found.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)) || a.id.localeCompare(b.id));
  return found.slice(0, 64);
}

/**
 * Write every `reports[]` entry the project declares, after a run. The path is
 * project-relative and must stay inside the output folder, like an output
 * block's; a bad path is a run error, not a silent skip.
 */
async function emitDeclaredReports(project, outDir) {
  const entries = (Array.isArray(project?.reports) ? project.reports : [])
    .filter((entry) => entry && entry.kind === 'html');
  const written = [];
  for (const entry of entries) {
    const relative = String(entry.path || '').trim();
    const segments = relative.split('/');
    if (!relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`Report "${entry.id || relative}" path must be relative and stay inside the output folder.`);
    }
    // eslint-disable-next-line no-await-in-loop
    const models = await collectReportModels(outDir, { flows: entry.flows });
    if (models.length === 0) continue;
    const html = buildCombinedReportHtml(models, {
      title: entry.title || `Project report — ${project.name || ''}`.trim(),
      generatedAt: new Date().toISOString(),
    });
    const target = path.resolve(outDir, relative);
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(path.dirname(target), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(target, html, 'utf8');
    written.push({ id: entry.id || relative, path: relative, bytes: Buffer.byteLength(html) });
  }
  return written;
}

async function commandReport({ positional, flags }) {
  const [outArg] = positional;
  if (!outArg) fail('report needs an output directory.');
  const outDir = path.resolve(outArg);
  const wantedFlow = typeof flags.flow === 'string' ? String(flags.flow) : null;
  // Issue #131: an imported result is listed either way; this flag decides
  // whether its number is also shown in the energy columns, labelled.
  const includeImported = flags['include-imported'] === true || flags['include-imported'] === 'true';
  const figuresFlag = String(flags.figures || 'basic');
  if (!['basic', 'surfaces', 'none'].includes(figuresFlag)) {
    throw new Error(`--figures must be basic, surfaces or none (got "${figuresFlag}")`);
  }
  const models = await collectReportModels(outDir, { flow: wantedFlow, includeImported, figures: figuresFlag });
  if (models.length === 0) {
    fail(wantedFlow
      ? `no queue for flow "${wantedFlow}" under ${outDir}.`
      : `no readable queue.json under ${path.join(outDir, 'queues')}.`, EXIT.invalid);
  }
  const generatedAt = new Date().toISOString();
  const html = models.length === 1
    ? workflowReportHtml(models[0])
    : buildCombinedReportHtml(models, {
      title: `Project report — ${models[0].queue.projectName || path.basename(outDir)}`,
      generatedAt,
    });
  // `--out` is the user's path: unlike an artifact declared inside a project,
  // it is not confined to the output folder — the caller asked for it by name.
  const outFile = path.resolve(String(flags.out || path.join(outDir, 'reports', 'index.html')));
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, 'utf8');
  process.stdout.write(`${outFile}\n`);
  process.exit(EXIT.ok);
}

/**
 * `ncs export` — every run record under an output folder, in one envelope.
 *
 * The records are the `run.json` files themselves, byte for byte, not a
 * reshaped table: the stable contract is the record, and `datasetExport.js`
 * remains the flat-table view. The envelope names the schema version and the
 * absolute path of the schema file, so a script can validate what it received
 * instead of trusting this command. Each record is validated before anything is
 * printed; one non-conforming record refuses the whole export rather than
 * returning a partial list.
 */
async function commandExport({ positional, flags }) {
  const [outArg] = positional;
  if (!outArg) fail('export needs an output directory (the folder `ncs run --out` wrote).');

  const rawVersion = flags['schema-version'];
  if (rawVersion !== undefined && typeof rawVersion !== 'string') {
    fail('--schema-version needs a version number.', EXIT.invalid);
  }
  const requested = rawVersion === undefined ? RECORD_SCHEMA_VERSION : Number(rawVersion);
  const schemaPath = Number.isInteger(requested) ? recordSchemaPath(requested) : null;
  if (!schemaPath) {
    const versions = recordSchemaVersions().join(', ');
    fail(`unsupported run-record schema version "${rawVersion}"; this build ships version ${versions}. The schema for version ${RECORD_SCHEMA_VERSION} is ${recordSchemaPath(RECORD_SCHEMA_VERSION)}.`, EXIT.invalid);
  }

  const outDir = path.resolve(outArg);
  const runsDir = path.join(outDir, 'runs');
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    fail(
      `cannot read ${runsDir}: ${error.code === 'ENOENT' ? 'there is no runs folder (did "ncs run" use --out?)' : error.message}`,
      EXIT.invalid,
    );
  }

  const records = [];
  const failures = [];
  const runIds = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const runId of runIds) {
    const file = path.join(runsDir, runId, 'run.json');
    let record;
    try {
      // eslint-disable-next-line no-await-in-loop
      record = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      failures.push({
        runId,
        file,
        errors: [{
          path: '/',
          message: error.code === 'ENOENT' ? 'the run folder has no run.json' : `run.json is not readable JSON: ${error.message}`,
        }],
      });
      continue;
    }
    const verdict = validateRecord(record, { version: requested });
    if (!verdict.ok) {
      failures.push({ runId, file, errors: verdict.errors });
      continue;
    }
    records.push(record);
  }

  if (failures.length > 0) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: 'record-invalid',
      schemaVersion: requested,
      schema: schemaPath,
      recordCount: records.length,
      failures,
    }, null, 2)}\n`);
    fail(
      `${failures.length} run record(s) do not conform to schema version ${requested} (${schemaPath}); nothing was exported.`,
      EXIT.invalid,
    );
  }

  const envelope = {
    kind: 'nodechem-studio.records',
    schemaVersion: requested,
    schema: schemaPath,
    generatedAt: new Date().toISOString(),
    outDir,
    recordCount: records.length,
    records,
  };
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  // `--out` follows `ncs report`: the file is the deliverable, its path is the
  // one line a shell script needs. Without it the envelope goes to stdout.
  if (flags.out) {
    const target = path.resolve(String(flags.out));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
    process.stdout.write(`${target}\n`);
    process.exit(EXIT.ok);
  }
  process.stdout.write(text);
  process.exit(EXIT.ok);
}

/**
 * `ncs record import` — write a record for a number another program computed.
 *
 * This is not log parsing (a different feature, and a guess about a foreign
 * format). The caller states the provenance: program, version, method, basis,
 * the energy in Hartree, and either the file to hash here or a hash computed on
 * the machine that did the work. The record is validated against the published
 * contract before it reaches disk, and it is written where a run's `run.json`
 * lives so the same readers find it — as a different kind, never as a run.
 *
 * Refusals are machine-readable on stderr and exit 2, like `ncs export`:
 *   { "ok": false, "code": "imported-invalid", "field": "program", "message": … }
 */
function importedRefusal(error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error.code || 'imported-invalid',
    field: error.field ?? null,
    message: error.message,
    errors: Array.isArray(error.errors) ? error.errors : undefined,
  }, null, 2)}\n`);
  process.exit(EXIT.invalid);
}

function slug(value, fallback) {
  const slugged = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slugged || fallback;
}

async function commandRecordImport({ positional, flags }) {
  if (positional.length > 0) {
    fail(`record import takes no positional arguments (got "${positional[0]}"); name the target with --out.`);
  }
  if (typeof flags.out !== 'string') {
    fail('record import needs --out <out-dir|file.json>.');
  }

  const sourceFile = typeof flags.source === 'string' ? path.resolve(flags.source) : null;
  const sourceHash = typeof flags['source-sha256'] === 'string' ? flags['source-sha256'].trim() : null;
  if ((sourceFile === null) === (sourceHash === null)) {
    importedRefusal(new ImportedRecordError(
      'name exactly one source: --source <file> hashes the file here, --source-sha256 <hex> takes a digest computed where the calculation ran.',
      { field: 'sourceSha256' },
    ));
  }

  let sourceSha256 = sourceHash;
  let sourceName = null;
  if (sourceFile !== null) {
    let bytes;
    try {
      bytes = await fs.readFile(sourceFile);
    } catch (error) {
      importedRefusal(new ImportedRecordError(
        `cannot read ${sourceFile}: ${error.code === 'ENOENT' ? 'there is no such file' : error.message}`,
        { field: 'sourceSha256' },
      ));
    }
    sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    sourceName = path.basename(sourceFile);
  }

  const rawEnergy = typeof flags.energy === 'string' ? flags.energy.trim() : null;
  if (rawEnergy === null || rawEnergy === '') {
    fail('record import needs --energy <hartree>.');
  }
  const energy = Number(rawEnergy);
  if (!Number.isFinite(energy)) {
    importedRefusal(new ImportedRecordError(
      `--energy must be a number in Hartree, got ${JSON.stringify(rawEnergy)}. Nothing is converted from another unit.`,
      { field: 'energy' },
    ));
  }

  const idFlag = typeof flags.id === 'string' ? flags.id : null;
  let record;
  try {
    record = buildImportedRecord({
      id: idFlag || `imported-${slug(flags.program, 'program')}-${slug(flags.method, 'method')}`,
      program: flags.program,
      version: flags.version,
      method: flags.method,
      basis: flags.basis,
      energy,
      sourceSha256,
      sourceName,
      title: flags.title,
      notes: flags.notes,
    });
  } catch (error) {
    if (error instanceof ImportedRecordError) importedRefusal(error);
    throw error;
  }

  // The builder and the published schema must agree; the schema is the contract.
  const verdict = validateRecord(record, { version: 2 });
  if (!verdict.ok) {
    importedRefusal(Object.assign(new ImportedRecordError(
      `the record does not conform to schema version 2 (${recordSchemaPath(2)}).`,
      { field: verdict.errors[0]?.path || null },
    ), { errors: verdict.errors }));
  }
  const local = validateImportedRecord(record);
  if (!local.ok) {
    importedRefusal(Object.assign(new ImportedRecordError('the record is missing a required field.', {
      field: local.errors[0]?.path || null,
    }), { errors: local.errors }));
  }

  const out = path.resolve(flags.out);
  const target = path.extname(out).toLowerCase() === '.json'
    ? out
    : path.join(out, 'runs', record.id, 'run.json');
  const existing = await fs.stat(target).then(() => true, () => false);
  if (existing) {
    importedRefusal(Object.assign(new ImportedRecordError(
      `${target} already exists. An imported record is evidence; it is not overwritten by a second import.`,
      { field: 'id', code: 'imported-exists' },
    ), { code: 'imported-exists' }));
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      file: target,
      kind: record.kind,
      badge: importedBadgeLabel(record),
      record,
    }, null, 2)}\n`);
    process.exit(EXIT.ok);
  }
  // Like `ncs report`, the path is the one line a script needs; the label goes
  // to stderr so it is visible to a human without being parsed as a path.
  process.stderr.write(`${importedBadgeLabel(record)}\n`);
  process.stdout.write(`${target}\n`);
  process.exit(EXIT.ok);
}

async function commandRecord({ positional, flags }) {
  const [subcommand, ...rest] = positional;
  if (subcommand === undefined) fail('record needs a subcommand; the only one is import.');
  if (subcommand === 'import') return commandRecordImport({ positional: rest, flags });
  fail(`unknown record subcommand "${subcommand}"; the only one is import.`);
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
  if (!formatId) fail('convert needs --format <extxyz|xyz|sdf|jcamp|molden>.');
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
    } else if (extension === '.fchk' || extension === '.fch') {
      // Molden is the one format that needs the basis and the MO coefficients,
      // and a formatted checkpoint is where they live.
      converted = convertFchk(parseFchk(text), formatId, {
        title: path.basename(file, extension),
      });
    } else if (extension === '.log' || extension === '.out') {
      const parsed = parseGaussianOutput(text);
      converted = convertParsed(parsed, formatId, {
        spectrum: String(flags.spectrum || 'ir'),
        title: path.basename(file, extension),
      });
    } else {
      const { records } = parseStructureRecords(text, { filename: path.basename(file), allowDecks: true });
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
 * `ncs export-input` — the deck one block would be for a program the app does
 * not run.
 *
 * NWChem, GAMESS and Q-Chem are **export only**: nothing here stages the file,
 * builds argv or parses output, because this build cannot run them. What it
 * can do is write the input from the same settings and geometry a Gaussian
 * block uses, or refuse with a named reason. A refusal exits 2 and carries
 * `{ ok: false, code, engine, message }` on stderr, like `ncs qcschema`.
 */
async function commandExportInput({ positional, flags }) {
  const [file] = positional;
  if (!file) fail('export-input needs a project file.');
  if (!flags.node) fail('export-input needs --node <id>.');
  const engineId = String(flags.engine || '').trim().toLowerCase();
  if (!engineId) fail(`export-input needs --engine <${EXPORT_ENGINE_IDS.join('|')}>.`);
  const exporter = exporterFor(engineId);
  if (!exporter) {
    fail(`export-input does not know an engine "${engineId}". Supported: ${EXPORT_ENGINE_IDS.join(', ')}. `
      + 'Gaussian, ORCA, Psi4 and xTB are run by the app; these three are exported.', EXIT.usage);
  }
  const { result } = await readProject(file);
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(validityJson(file, result), null, 2)}\n`);
    process.exit(EXIT.invalid);
  }
  const project = result.project;
  const node = project.nodes.find((entry) => entry.id === flags.node);
  if (!node) fail(`no node "${flags.node}" in ${file}.`, EXIT.invalid);

  // `moleculeForNode` substitutes the demo water molecule when a project has no
  // coordinates. For a Gaussian dry run that is a documented demo; for a deck
  // handed to another program it is a file that computes water. Refused here.
  const coords = project.molecule?.coords;
  if (!Array.isArray(coords) || coords.length === 0) {
    const message = 'This project has no geometry: the block would fall back to the demo water molecule, and a deck '
      + 'full of water is worse than no deck. Import a structure into the project first.';
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'export-no-geometry', engine: exporter.id, message }, null, 2)}\n`);
    process.stderr.write(`ncs: ${message}\n`);
    process.exit(EXIT.invalid);
  }

  const settings = settingsForNode(project, node);
  const molecule = moleculeForNode(project, node);
  const rendered = renderInput({
    engine: exporter.id,
    settings,
    molecule,
    geometry: project.molecule?.geometry ?? null,
    title: node.title,
  });
  if (!rendered.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'export-refused', engine: exporter.id, message: rendered.refused }, null, 2)}\n`);
    process.stderr.write(`ncs: ${rendered.refused}\n`);
    process.exit(EXIT.invalid);
  }

  const out = flags.out ? path.resolve(String(flags.out)) : null;
  if (out) await fs.writeFile(out, rendered.text, 'utf8');
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      engine: rendered.engine,
      out,
      bytes: Buffer.byteLength(rendered.text),
      notes: rendered.notes,
    }, null, 2)}\n`);
  } else {
    if (!out) process.stdout.write(rendered.text);
    for (const note of rendered.notes || []) process.stderr.write(`note: ${note}\n`);
    if (out) process.stdout.write(`${rendered.engine} deck written to ${out} (${Buffer.byteLength(rendered.text)} bytes)\n`);
  }
  process.exit(EXIT.ok);
}

/**
 * `ncs smiles` — read a SMILES string or a `.smi` file as a bond graph.
 *
 * This is the SMILES *import* surface for #148. It prints the graph, its
 * formula, its charge and its multiplicity; it never writes coordinates,
 * because a SMILES string has none to write. `ncs convert` cannot turn it into
 * `.xyz`/`.sdf` for the same reason — an embedder is a separate program.
 */
async function commandSmiles({ positional, flags }) {
  const [input] = positional;
  if (!input) fail('smiles needs a file or a SMILES string.');
  let text = null;
  let filename = '';
  try {
    const resolved = path.resolve(input);
    const stat = await fs.stat(resolved);
    if (stat.isFile()) {
      text = await fs.readFile(resolved, 'utf8');
      filename = path.basename(resolved);
    }
  } catch {
    // Not a path: the argument is the SMILES string itself.
  }

  let records;
  if (text === null) {
    try {
      records = [{ ...parseSmiles(input, { name: String(flags.name || '') }), line: 1 }];
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: 'smiles-invalid', message: error.message }, null, 2)}\n`);
      process.stderr.write(`ncs: ${error.message}\n`);
      process.exit(EXIT.invalid);
    }
  } else {
    try {
      records = parseSmilesList(text, { name: String(flags.name || filename.replace(/\.[^.]+$/, '')) }).records;
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: 'smiles-invalid', message: error.message }, null, 2)}\n`);
      process.stderr.write(`ncs: ${error.message}\n`);
      process.exit(EXIT.invalid);
    }
  }

  const readable = records.filter((record) => !record.error);
  const failed = records.length - readable.length;
  const payload = {
    ok: failed === 0,
    source: filename || '(string)',
    records: records.map((record) => (record.error
      ? { line: record.line, smiles: record.smiles, error: record.error }
      : {
        line: record.line,
        name: record.name,
        smiles: record.smiles,
        formula: record.formula,
        charge: record.charge,
        multiplicity: record.multiplicity,
        electrons: record.electrons,
        atoms: record.atoms,
        bonds: record.bonds,
        warnings: record.warnings,
      })),
    note: 'A SMILES graph has no coordinates. `ncs convert` refuses it for the same reason; '
      + 'generate a 3D structure with an embedder (Open Babel --gen3d, RDKit, crest) and import that.',
  };

  if (flags.out) await fs.writeFile(path.resolve(String(flags.out)), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const record of payload.records) {
      if (record.error) {
        process.stderr.write(`${filename || 'SMILES'}: ${record.error}\n`);
        continue;
      }
      process.stdout.write(`${record.name || `record ${record.line}`}: ${record.formula} · ${record.atoms.length} atoms · `
        + `${record.bonds.length} bonds · charge ${record.charge} · multiplicity ${record.multiplicity}\n`);
      for (const warning of record.warnings || []) process.stdout.write(`  note: ${warning}\n`);
    }
    if (flags.out) process.stdout.write(`${payload.records.length} record(s) written to ${path.resolve(String(flags.out))}\n`);
  }
  process.exit(failed === 0 ? EXIT.ok : EXIT.invalid);
}

/**
 * `ncs qcschema` — QCSchema (MolSSI) in and out.
 *
 * `export` writes one `qcschema_output` AtomicResult from a finished run: a run
 * folder, or an `ncs run --out` folder with `--run` to choose. `import` reads a
 * `qcschema_output` (or a bare `qcschema_input`) into the app vocabulary and can
 * write the structure as XYZ.
 *
 * Refusals are machine-readable: stderr carries
 * `{ "ok": false, "code": "...", "field": "...", "message": "..." }` and the
 * exit code is 2. The codes are `qcschema-refused` (the run cannot supply a
 * field the document needs), `qcschema-invalid` (the document does not conform),
 * `qcschema-unsupported` (not a QCSchema document), `qcschema-no-run` and
 * `qcschema-ambiguous`.
 */
const QCSCHEMA_USAGE = `ncs qcschema export <run-dir|out-dir> [--run <id>] [--charge <n>]
    [--multiplicity <n>] [--out <file>] [--json]
ncs qcschema import <file> [--out <file.xyz|file.json>] [--json]
`;

async function appVersion() {
  try {
    const text = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(text);
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function qcschemaRefuse(error) {
  const payload = {
    ok: false,
    code: error.code || 'qcschema-invalid',
    field: error.field || null,
    message: error.message,
    ...(error.details && typeof error.details === 'object' ? error.details : {}),
  };
  if (Array.isArray(error.errors) && error.errors.length > 0) payload.errors = error.errors;
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`ncs: ${error.message}\n`);
  process.exit(EXIT.invalid);
}

function qcschemaUsage(message) {
  process.stderr.write(`ncs: ${message}\n\n${QCSCHEMA_USAGE}`);
  process.exit(EXIT.usage);
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

async function isFile(candidate) {
  try {
    const stats = await fs.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * The run folder the export reads. A folder with `run.json` is one run; a folder
 * with `runs/` is an `ncs run --out` tree, and then `--run` picks one. Several
 * runs without `--run` are refused rather than guessing which one was meant.
 */
async function resolveQcschemaRun(target, runId = null) {
  const absolute = path.resolve(target);
  if (await isFile(path.join(absolute, 'run.json'))) return absolute;

  const runsDir = path.join(absolute, 'runs');
  let entries = [];
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const withRecord = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    if (await isFile(path.join(runsDir, id, 'run.json'))) withRecord.push(id);
  }

  if (runId) {
    if (!withRecord.includes(runId)) {
      throw new QCSchemaError(`no run "${runId}" with a run.json under ${runsDir}.`, {
        code: 'qcschema-no-run', field: 'run', details: { runs: withRecord },
      });
    }
    return path.join(runsDir, runId);
  }
  if (withRecord.length === 0) {
    throw new QCSchemaError(`no run.json at ${absolute} or under ${runsDir}.`, {
      code: 'qcschema-no-run', field: 'run',
    });
  }
  if (withRecord.length > 1) {
    throw new QCSchemaError(
      `${withRecord.length} runs under ${runsDir}; pass --run <id> to choose one.`,
      { code: 'qcschema-ambiguous', field: 'run', details: { runs: withRecord } },
    );
  }
  return path.join(runsDir, withRecord[0]);
}

/** The molecule the run's own input file states, when the record carries none. */
async function inputMoleculeFor(runDir, record) {
  const name = String(record?.inputName || '');
  if (!SAFE_NAME.test(name)) return null;
  try {
    const text = await fs.readFile(path.join(runDir, name), 'utf8');
    return gaussianInputMolecule(text);
  } catch {
    return null;
  }
}

function integerFlag(value, name) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    qcschemaUsage(`${name} needs an integer.`);
  }
  return Number(value.trim());
}

async function commandQcschemaExport({ positional, flags }) {
  const [target] = positional;
  if (!target) qcschemaUsage('qcschema export needs a run folder or a run output folder.');
  const requestedRun = flags.run === undefined ? null : String(flags.run);
  if (flags.run === true) qcschemaUsage('--run needs a run id.');
  const chargeFlag = integerFlag(flags.charge, '--charge');
  const multiplicityFlag = integerFlag(flags.multiplicity, '--multiplicity');

  let runDir;
  let record;
  try {
    runDir = await resolveQcschemaRun(target, requestedRun);
    record = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
  } catch (error) {
    qcschemaRefuse(error instanceof QCSchemaError ? error
      : new QCSchemaError(`cannot read the run record: ${error.message}`, { code: 'qcschema-invalid', field: 'run.json' }));
  }
  if (record.status === 'running') {
    qcschemaRefuse(new QCSchemaError('the run has not finished; there is no result to export yet.', {
      code: 'qcschema-refused', field: 'status',
    }));
  }

  try {
    const fromInput = await inputMoleculeFor(runDir, record);
    const parsedAtoms = atomsFromRun(record);
    const atoms = parsedAtoms?.atoms ?? fromInput?.atoms ?? null;
    const molecule = moleculeFromRun(record, {
      atoms,
      charge: chargeFlag !== null ? chargeFlag : fromInput?.charge ?? null,
      multiplicity: multiplicityFlag !== null ? multiplicityFlag : fromInput?.multiplicity ?? null,
      name: fromInput?.name || record.title || null,
    });
    const doc = atomicResultFromRun(record, { molecule, version: await appVersion() });

    const out = flags.out
      ? path.resolve(String(flags.out))
      : path.join(runDir, `${path.basename(runDir)}.qcschema.json`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, stringifyQcschema(doc), 'utf8');

    const dryRun = record.dryRun === true;
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        runId: record.id || null,
        out,
        schema: qcschemaSchemaPath('output'),
        schemaName: doc.schema_name,
        schemaVersion: doc.schema_version,
        driver: doc.driver,
        energyHartree: doc.properties.return_energy,
        method: doc.model.method,
        basis: doc.model.basis,
        atomCount: doc.molecule.symbols.length,
        geometrySource: parsedAtoms?.source || (fromInput ? 'input-file' : null),
        dryRun,
      }, null, 2)}\n`);
    } else {
      if (dryRun) {
        process.stderr.write(`note: ${record.id} is a dry run; the document says extras.nodechem.dry_run = true.\n`);
      }
      process.stdout.write(`${out}\n`);
    }
    process.exit(EXIT.ok);
  } catch (error) {
    qcschemaRefuse(error instanceof QCSchemaError ? error
      : new QCSchemaError(error.message, { code: 'qcschema-invalid', field: null }));
  }
}

async function commandQcschemaImport({ positional, flags }) {
  const [input] = positional;
  if (!input) qcschemaUsage('qcschema import needs a file.');
  const file = path.resolve(input);

  let doc;
  try {
    doc = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    qcschemaRefuse(new QCSchemaError(`cannot read ${file}: ${error.message}`, {
      code: 'qcschema-invalid', field: 'document',
    }));
  }

  const verdict = readQcschema(doc);
  if (!verdict.ok) {
    qcschemaRefuse(new QCSchemaError(verdict.message, {
      code: verdict.code, field: verdict.field, errors: verdict.errors || [],
    }));
  }

  try {
    if (flags.out) {
      const target = path.resolve(String(flags.out));
      const extension = path.extname(target).toLowerCase();
      let payload;
      if (extension === '.xyz') {
        const structure = structureFromQcschema(verdict);
        payload = geometryToXyz(structure, { comment: structure.name });
      } else {
        payload = `${JSON.stringify(verdict, null, 2)}\n`;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, payload, 'utf8');
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({
          ok: true, out: target, kind: verdict.kind, schemaName: verdict.schemaName, energyHartree: verdict.energyHartree,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`${target}\n`);
      }
      process.exit(EXIT.ok);
    }

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      process.exit(EXIT.ok);
    }
    const molecule = verdict.molecule;
    process.stdout.write(`${verdict.schemaName} ${verdict.schemaVersion}: ${molecule.name || 'molecule'} `
      + `(${molecule.symbols.join(' ')}, charge ${molecule.charge}, multiplicity ${molecule.multiplicity})\n`);
    if (verdict.energyHartree !== null) process.stdout.write(`  energy: ${verdict.energyHartree} Eh\n`);
    process.stdout.write(`  model: ${verdict.model.method}${verdict.model.basis ? `/${verdict.model.basis}` : ''}`
      + `${verdict.model.dispersion ? ` (${verdict.model.dispersion})` : ''}\n`);
    for (const warning of verdict.warnings) process.stdout.write(`  note: ${warning}\n`);
    process.exit(EXIT.ok);
  } catch (error) {
    qcschemaRefuse(error instanceof QCSchemaError ? error
      : new QCSchemaError(error.message, { code: 'qcschema-invalid', field: null }));
  }
}

async function commandQcschema({ positional, flags }) {
  const [subcommand, ...rest] = positional;
  if (!subcommand) qcschemaUsage('qcschema needs a subcommand: export or import.');
  if (subcommand === 'export') return commandQcschemaExport({ positional: rest, flags });
  if (subcommand === 'import') return commandQcschemaImport({ positional: rest, flags });
  return qcschemaUsage(`unknown qcschema subcommand "${subcommand}"; expected export or import.`);
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

/* ── ncs cube ─────────────────────────────────────────────── */

/**
 * `ncs cube` — evaluate one MO on a grid and write it as a Gaussian cube.
 *
 * The wavefunction is a formatted checkpoint, a Molden file, a WFN or a WFX,
 * given directly or found in a run folder. The orbital is chosen by name
 * (`homo`, `lumo`) or by the 1-based index the file's own order implies, and it
 * is evaluated by the same `volume.js` code the app's viewport uses — there is
 * no second evaluator here.
 *
 * The numbers the command prints are the ones a reader should check the picture
 * against: the grid spacing actually used (the cap may have coarsened it), the
 * orbital energy as the file states it, and ∫|ψ|² over the box, which is not 1
 * and does not claim to be.
 */
class CubeCliError extends Error {}

const WAVEFUNCTION_EXTENSIONS = ['.fchk', '.fch', '.molden', '.wfn', '.wfx'];

function cubeUsage(message) {
  process.stderr.write(`ncs: ${message}\n`);
  process.exit(EXIT.usage);
}

function cubeRefuse(error) {
  process.stderr.write(`ncs: ${error.message}\n`);
  process.exit(EXIT.invalid);
}

async function resolveWavefunctionFile(target) {
  const absolute = path.resolve(target);
  let stats;
  try {
    stats = await fs.stat(absolute);
  } catch (error) {
    throw new CubeCliError(`cannot read ${target}: ${error.message}`);
  }
  if (stats.isFile()) return absolute;
  if (!stats.isDirectory()) {
    throw new CubeCliError(`${target} is neither a file nor a directory.`);
  }

  const candidates = (await fs.readdir(absolute, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && WAVEFUNCTION_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
  if (candidates.length === 0) {
    throw new CubeCliError(
      `${target} holds no wavefunction file (${WAVEFUNCTION_EXTENSIONS.join(', ')}), so there is nothing to evaluate.`,
    );
  }
  if (candidates.length > 1) {
    throw new CubeCliError(
      `${target} holds ${candidates.length} wavefunction files (${candidates.join(', ')}); pass the one you mean directly.`,
    );
  }
  return path.join(absolute, candidates[0]);
}

async function readWavefunctionFile(file) {
  const text = await fs.readFile(file, 'utf8');
  const kind = detectWavefunctionFormat(text);
  if (kind === 'cube') {
    throw new CubeCliError(`${file} is a cube, not a wavefunction: there are no coefficients in it to evaluate.`);
  }
  if (kind === 'fchk') return { kind, parsed: parseFchk(text) };
  if (kind === 'molden') return { kind, parsed: parseMolden(text) };
  if (kind === 'wfn') return { kind, parsed: parseWfn(text) };
  if (kind === 'wfx') return { kind, parsed: parseWfx(text) };
  throw new CubeCliError(
    `${file} is not a wavefunction this build reads (expected a formatted checkpoint, Molden, WFN or WFX file).`,
  );
}

/**
 * The alpha orbitals in file order, 1-based, with the occupation the file
 * states. This is the same table the results surface shows: a restricted
 * checkpoint has no per-orbital occupations, so they are derived from the alpha
 * electron count (2 each when alpha equals beta, 1 each otherwise) — the one
 * derived number in this command, and the reason `homo`/`lumo` mean what they
 * do.
 */
function orbitalTable(parsed) {
  if (Array.isArray(parsed.orbitals) && parsed.orbitals.length > 0) {
    // `Alpha and Beta` is a closed-shell spatial orbital (WFX says so); `Beta`
    // is a separate spin set this command does not write.
    const alphaOnly = parsed.orbitals.filter((orbital) => !orbital?.spin || /alpha/i.test(String(orbital.spin)));
    return alphaOnly.map((orbital, index) => ({
      index: index + 1,
      energyHartree: Number.isFinite(orbital?.energy) ? orbital.energy : null,
      occupation: Number.isFinite(orbital?.occupation) ? orbital.occupation : 0,
      coefficients: orbital?.coefficients ?? [],
    }));
  }
  const functions = Number(parsed.numberOfBasisFunctions);
  if (!Array.isArray(parsed.alphaMOCoefficients) || !Number.isInteger(functions) || functions <= 0) {
    return [];
  }
  const matrix = parsed.alphaMOCoefficients;
  const count = Math.floor(matrix.length / functions);
  const alpha = Number.isInteger(parsed.numberOfAlphaElectrons) ? parsed.numberOfAlphaElectrons : null;
  const beta = Number.isInteger(parsed.numberOfBetaElectrons) ? parsed.numberOfBetaElectrons : null;
  const restricted = alpha !== null && beta !== null && alpha === beta;
  const orbitals = [];
  for (let index = 0; index < count; index += 1) {
    orbitals.push({
      index: index + 1,
      energyHartree: Array.isArray(parsed.orbitalEnergies) && Number.isFinite(parsed.orbitalEnergies[index])
        ? parsed.orbitalEnergies[index]
        : null,
      occupation: alpha === null ? null : (index < alpha ? (restricted ? 2 : 1) : 0),
      coefficients: matrix.slice(index * functions, (index + 1) * functions),
    });
  }
  return orbitals;
}

function selectOrbital(table, request) {
  if (table.length === 0) {
    throw new CubeCliError('the wavefunction carries no alpha MO coefficients, so there is no orbital to evaluate.');
  }
  if (request === 'homo') {
    const chosen = table.filter((orbital) => (orbital.occupation ?? 0) > 0).at(-1);
    if (!chosen) throw new CubeCliError('no orbital has a non-zero occupation, so the file has no HOMO.');
    return { requested: 'homo', orbital: chosen };
  }
  if (request === 'lumo') {
    const chosen = table.find((orbital) => (orbital.occupation ?? 0) === 0);
    if (!chosen) throw new CubeCliError(`every one of the ${table.length} orbitals is occupied, so the file has no LUMO.`);
    return { requested: 'lumo', orbital: chosen };
  }
  const explicit = /^n=(\d+)$/.exec(request);
  if (!explicit) {
    throw new CubeCliError(`--orbital takes homo, lumo or n=<i>; got "${request}".`);
  }
  const wanted = Number(explicit[1]);
  if (wanted < 1 || wanted > table.length) {
    throw new CubeCliError(
      `--orbital n=${wanted} is outside 1–${table.length}: the file has ${table.length} alpha orbitals.`,
    );
  }
  return { requested: `n=${wanted}`, orbital: table[wanted - 1] };
}

function positiveFlag(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    cubeUsage(`${name} needs a positive number of Å.`);
  }
  return Number(value);
}

async function commandCube({ positional, flags }) {
  const [target] = positional;
  if (!target) cubeUsage('cube needs a run folder or a wavefunction file.');
  if (flags.orbital === undefined || flags.orbital === true) cubeUsage('--orbital is required: homo, lumo or n=<i>.');
  if (!flags.out || flags.out === true) cubeUsage('--out is required: the cube file to write.');

  // The units of the header, not of the data: a negative grid count declares Å
  // and a positive one bohr. `angstrom` is what this command has always
  // written, so it stays the default and an existing output file does not
  // change; `--units bohr` is the form cubegen itself writes.
  let units = 'angstrom';
  if (flags.units !== undefined) {
    const requested = typeof flags.units === 'string' ? flags.units.trim().toLowerCase() : '';
    if (requested !== 'angstrom' && requested !== 'bohr') {
      cubeUsage(`--units takes angstrom or bohr, not ${typeof flags.units === 'string' ? `"${flags.units}"` : 'a bare flag'}.`);
    }
    units = requested;
  }

  const spacing = flags.grid === undefined ? 0.2 : positiveFlag(flags.grid, '--grid');
  let padding = 3;
  if (flags.padding !== undefined) {
    if (typeof flags.padding !== 'string' || !Number.isFinite(Number(flags.padding)) || Number(flags.padding) < 0) {
      cubeUsage('--padding needs zero or more Å.');
    }
    padding = Number(flags.padding);
  }

  try {
    const file = await resolveWavefunctionFile(target);
    const { kind, parsed } = await readWavefunctionFile(file);
    if (!Array.isArray(parsed.atoms) || parsed.atoms.length === 0) {
      throw new CubeCliError(`${file} carries no atoms, so there is nowhere to place the basis functions.`);
    }

    const table = orbitalTable(parsed);
    const { requested, orbital } = selectOrbital(table, String(flags.orbital).trim().toLowerCase());
    const grid = gridFor(parsed.atoms, { spacing, padding });
    const values = evaluateOrbital({
      shells: parsed,
      coefficients: orbital.coefficients,
      grid,
      precision: 'f64',
    });

    const label = `MO ${orbital.index} (${requested})`;
    const field = fieldOfValues({
      kind: 'orbital',
      label,
      grid,
      values,
      signed: true,
      unit: 'a.u.',
    });
    const integral = integrateField(field, { square: true });
    const boxAngstrom3 = grid.points * grid.step ** 3;
    const integralNote = '|psi|^2 over the finite grid box; a finite box does not integrate to exactly 1, '
      + 'because the density outside it is not counted.';

    const out = path.resolve(String(flags.out));
    const text = writeCube(field, {
      title: `${label} from ${path.basename(file)}`,
      comment: 'NodeChem Studio orbital cube; values in a.u.; outer loop X, middle loop Y, inner loop Z',
      atoms: parsed.atoms,
      units,
    });
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, text, 'utf8');

    const payload = {
      file,
      orbital: {
        requested,
        index: orbital.index,
        label,
        occupation: orbital.occupation,
      },
      energyEh: orbital.energyHartree,
      ...(orbital.energyHartree === null
        ? { energyNote: `not available: the ${kind} file states no orbital energy for MO ${orbital.index}` }
        : {}),
      grid: {
        spacing: grid.step,
        points: grid.points,
        capped: grid.capped,
        note: grid.note,
      },
      integral: {
        value: integral,
        boxAngstrom3,
        note: integralNote,
      },
      wavefunction: { kind, format: kind, basisFunctions: parsed.numberOfBasisFunctions ?? null },
      units: {
        header: units,
        gridCounts: units === 'angstrom' ? 'negative, which declares Å' : 'positive, which declares bohr',
        note: 'Only the header distances change with this flag; the values are written as evaluated.',
      },
      out,
      bytes: Buffer.byteLength(text),
    };

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(EXIT.ok);
    }
    process.stdout.write(`wavefunction: ${file} (${kind})\n`);
    process.stdout.write(`orbital: ${label}, occupation ${orbital.occupation === null ? 'not available: the file states no occupations' : orbital.occupation.toFixed(3)}\n`);
    process.stdout.write(orbital.energyHartree === null
      ? `energy: ${payload.energyNote}\n`
      : `energy: ${orbital.energyHartree.toFixed(6)} Eh\n`);
    process.stdout.write(`grid: ${grid.step.toFixed(3)} Å, ${grid.counts.join('×')} = ${grid.points} points${grid.capped ? ` (${grid.note})` : ''}\n`);
    process.stdout.write(`integral: ∫|ψ|²dV = ${integral.toFixed(6)} over ${boxAngstrom3.toFixed(3)} Å³ — ${integralNote}\n`);
    process.stdout.write(`units: ${units} header (${payload.units.gridCounts})\n`);
    process.stdout.write(`wrote: ${out} (${payload.bytes} bytes)\n`);
    process.exit(EXIT.ok);
  } catch (error) {
    if (error instanceof CubeCliError) cubeRefuse(error);
    cubeRefuse(new CubeCliError(error.message));
  }
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
  export: commandExport,
  record: commandRecord,
  diff: commandDiff,
  merge: commandMerge,
  convert: commandConvert,
  'export-input': commandExportInput,
  smiles: commandSmiles,
  qcschema: commandQcschema,
  cache: commandCache,
  cube: commandCube,
};
const handler = handlers[command];
if (!handler) fail(`unknown command "${command}".`);
await handler({ positional, flags });
