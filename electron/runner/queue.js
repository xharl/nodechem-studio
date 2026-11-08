import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  blockedPendingTasks,
  finalStatus,
  nextReadyTask,
  topologicalOrder,
} from '../../src/shared/workflowGraph.js';
import { artifactFor } from '../../src/shared/artifactExport.js';
import { conditionFields, evaluateCondition } from '../../src/shared/controlFlow.js';
import { engineFor } from '../../src/shared/engines/index.js';
import { ladderVerdict } from '../../src/shared/methodLadder.js';
import { spinSweepVerdict } from '../../src/shared/spinSweep.js';
import { deltaGDoubleDagger } from '../../src/shared/reactionPath.js';
import { normalizeValidityContext } from '../../src/shared/validityChecks.js';
import { LIMITS } from '../../src/shared/projectSchema.js';
import { applyGeometryHandoff, readUpstreamGeometry } from './geometryHandoff.js';
import { sha256File } from './hashing.js';
import { CrestRunner } from './crestRunner.js';
import {
  ensembleSummary,
  fixtureConformerFrames,
  parseMultiXyz,
  rankEnsemble,
  withEnergies,
  xyzText,
} from '../../src/shared/conformers.js';

// `~` joins a block id to the conformer member it was expanded for (#80); it
// is not a path separator and is legal inside a file name on every target OS.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
const SAFE_CHECKPOINT = /^[A-Za-z0-9._-]{1,124}\.chk$/i;
// xTB's restart artifact is a plain filename (`xtbrestart`); it is not a
// Gaussian checkpoint and must not be forced through the `.chk` pattern.
// The first character is alphanumeric so `.`/`..` can never escape targetDir.
const SAFE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TASKS = LIMITS.planTasks;

// CREST resolves a relative input against its working directory, so the search
// input is staged inside the task folder under this name and argv names only the
// basename (#100). The task folder is where `crest_conformers.xyz`,
// `crest.energies` and `crest.out` have to land.
const CONFORMER_STAGED_INPUT = 'ensemble.xyz';

const TASK_STATUSES = new Set([
  'pending', 'running', 'completed', 'failed', 'needs-review', 'blocked', 'skipped', 'cancelled', 'interrupted',
]);

const TASK_TYPES = new Set(['input', 'calc', 'conformers', 'condition', 'loop', 'merge', 'output', 'note']);

function queueIdFor(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Windows rename errors that a repeat can clear; anything else is a real fault. */
const RENAME_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
/** 10/50/200/500/1000 ms: bounded at ~1.8 s, then a direct write, then a throw. */
const RENAME_RETRY_DELAYS_MS = Object.freeze([10, 50, 200, 500, 1000]);
/**
 * No single filesystem call may hang the write chain. A real-time virus
 * scanner that holds the target open makes `rename` stall rather than fail on
 * Windows; without a bound that turns into a queue that silently stops
 * persisting, which is what a durability test then sees as a timeout with no
 * error attached.
 */
const WRITE_CALL_TIMEOUT_MS = 5000;

function withWriteTimeout(promise, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} did not complete within ${WRITE_CALL_TIMEOUT_MS} ms`);
      error.code = 'ETIMEDOUT';
      error.writeTimeout = true;
      reject(error);
    }, WRITE_CALL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function writeJsonAtomic(filePath, value) {
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(temp, data, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await withWriteTimeout(fsp.rename(temp, filePath), 'rename');
      return;
    } catch (error) {
      lastError = error;
      const retryable = error?.writeTimeout === true || RENAME_RETRY_CODES.has(error?.code);
      if (!retryable) break;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // A direct overwrite is the fallback that works where a rename cannot: it
  // needs no delete of the existing entry, which is the operation Windows
  // refuses while another handle holds the file.
  try {
    await withWriteTimeout(fsp.writeFile(filePath, data, 'utf8'), 'direct write');
    await fsp.rm(temp, { force: true }).catch(() => {});
    return;
  } catch {
    await fsp.rm(temp, { force: true }).catch(() => {});
    const reason = lastError?.code || lastError?.message || 'unknown cause';
    throw new Error(`could not write ${path.basename(filePath)} after `
      + `${RENAME_RETRY_DELAYS_MS.length + 1} rename attempts and a direct write (${reason})`);
  }
}

function oneLine(value, max = 200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/** The hash a manifest entry records; computed here, never in a pure module. */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Resolve an artifact path under a root and refuse anything that escapes it.
 *
 * `path.resolve` lets an absolute entry replace the root — exactly the case the
 * prefix check catches — and a `..` segment climbs out. Both are refused rather
 * than "cleaned": a path that leaves the output folder is a mistake, not a name.
 */
export function resolveArtifactPath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(relative || ''));
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`Artifact path "${relative}" escapes the artifact root "${base}".`);
  }
  return target;
}

/**
 * Point CREST's argv at the staged geometry (#100).
 *
 * `crestArgv()` puts the input operand first; a hand-written argv may name it
 * elsewhere, so replace the first non-flag argument rather than blindly argv[0].
 * An argv with no operand at all gets the staged name prepended. An empty argv
 * is left alone: the runner already refuses that with a clear message.
 */
function conformerArgvFor(argv, inputName) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (args.length === 0) return args;
  const operand = args.findIndex((argument) => !argument.startsWith('-'));
  if (operand === -1) return [inputName, ...args];
  args[operand] = inputName;
  return args;
}

const ROUTE_SETTING_KEYS = [
  'jobType', 'method', 'basis', 'dispersion', 'scf', 'grid', 'optConvergence',
  'solvationModel', 'solvent',
  // xTB's method vocabulary; without these a queued run cannot record the
  // Hamiltonian or optimisation level it actually used (#39).
  'xtbMethod', 'xtbOptLevel',
  // Thread count is xTB's only resource setting; carry it so a queued run does
  // not silently fall back to the default OMP_NUM_THREADS (#41).
  'xtbThreads',
];

/**
 * The file a checkpoint edge transfers for an engine.
 *
 * Gaussian writes the task's own `%Chk` name. xTB always writes its declared
 * restart artifact (`xtbrestart`) in the working directory, whatever `.chk`
 * name the old UI may have put on the edge.
 */
function checkpointArtifactFor(engine, task = {}) {
  if (typeof engine.checkpointArtifact === 'function') {
    return engine.checkpointArtifact({
      checkpointName: String(task.checkpointName || ''),
      nodeId: String(task.nodeId || 'task'),
    });
  }
  // An engine with no restart artifact (Psi4) hands off nothing: the edge
  // carries the parsed geometry, so there is no checkpoint name to invent —
  // and inventing one from a dataset task id (`sp~water`) produced a name the
  // `.chk` validator then refused.
  if (!engine.capabilities?.restartArtifact) return '';
  return String(task.checkpointName || `${task.nodeId || 'task'}.chk`);
}

/**
 * What a downstream task declares it reads. An xTB edge may still carry the
 * pre-#40 UI default `something.chk`; xTB has one restart artifact, so that
 * placeholder resolves to it instead of failing after the upstream has run.
 */
function declaredCheckpointFor(engine, declared) {
  const name = String(declared || '');
  if (engine.id !== 'xtb') return name;
  if (!name || /\.chk$/i.test(name) || name === engine.capabilities.restartArtifact) {
    return engine.capabilities.restartArtifact;
  }
  return name;
}

/**
 * The binary a task must run: its own engine's path when the queue carries a
 * per-engine map, else the single legacy `executable`. A mixed flow (xTB opt
 * feeding a Psi4 single point) needs the former; one-engine callers keep the
 * latter working unchanged.
 */
function queueExecutableFor(queue, task) {
  const map = queue?.options?.executables;
  if (map && typeof map === 'object') {
    const path = String(map[task?.engine] || '').trim();
    if (path) return path;
  }
  return queue?.options?.executable || null;
}

function isSafeCheckpointName(engine, name) {
  return engine.id === 'xtb' ? SAFE_ARTIFACT.test(String(name)) : SAFE_CHECKPOINT.test(String(name));
}

/**
 * Keep only the route fields the provenance manifest needs. The renderer
 * supplies them, so coerce and length-limit them before they are persisted or
 * copied into a run record.
 */
function routeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of ROUTE_SETTING_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    out[key] = oneLine(raw[key], 64);
  }
  if ('solvation' in raw) out.solvation = Boolean(raw.solvation);
  return Object.keys(out).length > 0 ? out : null;
}

function conformerTaskRecord(raw, nodeId) {
  const inputName = String(raw?.inputName || '');
  if (!/^[A-Za-z0-9._-]+\.xyz$/i.test(inputName)) {
    throw new Error(`Conformer task "${nodeId}" must have a safe .xyz input name.`);
  }
  const inputText = String(raw?.inputText || '');
  if (!inputText.trim()) throw new Error(`Conformer task "${nodeId}" has no starting geometry.`);
  if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`Conformer task "${nodeId}" input is larger than 2 MiB.`);
  }
  const conf = raw?.conformers && typeof raw.conformers === 'object' ? raw.conformers : {};
  const generator = conf.generator === 'import' ? 'import' : 'crest';
  const importPath = oneLine(conf.importPath, 500);
  // A fanned-out member task (#80) carries one member of an ensemble that is
  // already stored in the project. It does not search, so it needs neither a
  // generator nor an import path — only the member row it stands for.
  const rawMember = conf.member && typeof conf.member === 'object' ? conf.member : null;
  const memberId = rawMember ? String(rawMember.id || '') : '';
  if (rawMember && !/^c\d+$/.test(memberId)) {
    throw new Error(`Conformer task "${nodeId}" names an invalid member id.`);
  }
  const member = rawMember ? {
    id: memberId,
    rank: Number.isFinite(Number(rawMember.rank)) ? Number(rawMember.rank) : null,
    parentId: oneLine(rawMember.parentId, 64),
    parentTitle: oneLine(rawMember.parentTitle, 120),
    generator: oneLine(rawMember.generator, 24),
    method: oneLine(rawMember.method, 24),
    energyEh: Number.isFinite(Number(rawMember.energyEh)) ? Number(rawMember.energyEh) : null,
    // Issue #130: a fanned-out member must not lose the unit and method its
    // energy was produced with; the branch's conformers.json repeats them.
    energyKcal: Number.isFinite(Number(rawMember.energyKcal)) ? Number(rawMember.energyKcal) : null,
    energyUnit: rawMember.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree',
    energyMethod: oneLine(rawMember.energyMethod, 40),
    origin: {
      program: oneLine(rawMember.origin?.program, 40),
      version: oneLine(rawMember.origin?.version, 40),
      method: oneLine(rawMember.origin?.method, 60),
      sourceSha256: oneLine(rawMember.origin?.sourceSha256, 64),
    },
    relativeKcal: Number.isFinite(Number(rawMember.relativeKcal)) ? Number(rawMember.relativeKcal) : null,
    // A mixed ensemble's members have no population (null), which is not 0%.
    population: rawMember.population === null || rawMember.population === undefined
      ? null
      : (Number.isFinite(Number(rawMember.population)) ? Number(rawMember.population) : null),
    protomer: oneLine(rawMember.protomer, 40),
    spreadKcal: Number.isFinite(Number(rawMember.spreadKcal)) ? Number(rawMember.spreadKcal) : null,
    temperature: Number.isFinite(Number(rawMember.temperature)) ? Number(rawMember.temperature) : null,
  } : null;
  if (generator === 'import' && !importPath && !member) {
    throw new Error(`Conformer task "${nodeId}" has no ensemble file to import.`);
  }
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const rawFanOut = raw?.fanOut && typeof raw.fanOut === 'object' ? raw.fanOut : null;
  const fanOut = rawFanOut && SAFE_ID.test(String(rawFanOut.conformerId || ''))
    ? {
      conformerId: String(rawFanOut.conformerId),
      memberId: /^c\d+$/.test(String(rawFanOut.memberId || '')) ? String(rawFanOut.memberId) : null,
      count: Number.isInteger(Number(rawFanOut.count)) ? Number(rawFanOut.count) : null,
      spreadKcal: Number.isFinite(Number(rawFanOut.spreadKcal)) ? Number(rawFanOut.spreadKcal) : null,
    }
    : null;
  return {
    nodeId,
    type: 'conformers',
    title: oneLine(raw?.title, 120) || nodeId,
    kind: oneLine(raw?.kind, 32) || 'Conformers',
    executable: true,
    engine: null,
    argv: null,
    route: null,
    status: 'pending',
    attempts: 0,
    runId: null,
    runDir: null,
    inputName,
    outputName: /^[A-Za-z0-9._-]+\.xyz$/i.test(String(raw?.outputName || '')) ? String(raw.outputName) : 'crest.out',
    settings: null,
    gates: {},
    validity: null,
    checkpointName: '',
    checkpointFrom: null,
    condition: null,
    loop: null,
    merge: null,
    ladder: null,
    spin: null,
    reaction: null,
    conformer: null,
    fanOut,
    loopAttempts: 0,
    conditionResult: null,
    summary: null,
    history: [],
    gateVerdict: null,
    parsedSummary: null,
    error: null,
    reason: null,
    previousError: null,
    startedAt: null,
    finishedAt: null,
    ensemble: null,
    ensembleFile: null,
    inputText,
    conformers: {
      generator,
      method: conf.method === 'gfnff' ? 'gfnff' : 'gfn2',
      energyWindowKcal: number(conf.energyWindowKcal, 10, 0, 100),
      rmsdThreshold: number(conf.rmsdThreshold, 0.5, 0.01, 10),
      maxConformers: Math.round(number(conf.maxConformers, 20, 1, 200)),
      temperature: number(conf.temperature, 298.15, 1, 1000),
      spreadThresholdKcal: number(conf.spreadThresholdKcal, 2, 0, 50),
      selectedConformerId: /^c\d+$/.test(String(conf.selectedConformerId || '')) ? String(conf.selectedConformerId) : '',
      importPath,
      // Issues #129/#130: declared provenance and unit of the imported file.
      // Bounded here so a hand-written queue payload cannot smuggle in an
      // unbounded string, and never inferred from the generator.
      energyUnit: conf.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree',
      energyMethod: oneLine(conf.energyMethod, 40),
      origin: {
        program: oneLine(conf.origin?.program, 40),
        version: oneLine(conf.origin?.version, 40),
        method: oneLine(conf.origin?.method, 60),
        sourceSha256: oneLine(conf.origin?.sourceSha256, 64),
      },
      charge: Math.round(number(conf.charge, 0, -10, 10)),
      multiplicity: Math.round(number(conf.multiplicity, 1, 1, 10)),
      argv: Array.isArray(conf.argv) ? conf.argv.map(String).slice(0, 32) : [],
      member,
    },
  };
}

/**
 * RFC 0001: the flow and record a task belongs to, plus the dataset payload an
 * input block carries. Kept in one place so the conformer path cannot forget it.
 */
function scopeRecord(raw) {
  const text = (value) => (typeof value === 'string' && value ? oneLine(value, 64) : null);
  const record = raw?.record && typeof raw.record === 'object'
    ? {
      id: text(raw.record.id) || '',
      label: oneLine(raw.record.label, 200) || text(raw.record.id) || '',
      charge: Number.isInteger(Number(raw.record.charge)) ? Number(raw.record.charge) : null,
      multiplicity: Number.isInteger(Number(raw.record.multiplicity)) ? Number(raw.record.multiplicity) : null,
    }
    : null;
  const input = raw?.input && typeof raw.input === 'object'
    ? {
      datasetId: text(raw.input.datasetId) || '',
      datasetTitle: oneLine(raw.input.datasetTitle, 160) || '',
      records: Array.isArray(raw.input.records)
        ? raw.input.records.slice(0, LIMITS.records).map((entry) => ({
          id: text(entry?.id) || '',
          label: oneLine(entry?.label, 200) || text(entry?.id) || '',
        })).filter((entry) => entry.id)
        : [],
    }
    : null;
  return {
    flowId: text(raw?.flowId),
    recordId: text(raw?.recordId),
    record: record && record.id ? record : null,
    input,
  };
}

const OUTPUT_KIND_SET = new Set(['html', 'csv', 'json', 'zip']);
const OUTPUT_PATH_SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** The artifact an output block writes (RFC 0001). Paths are project-relative. */
function outputRecord(raw) {
  const kind = OUTPUT_KIND_SET.has(raw?.kind) ? raw.kind : 'zip';
  const requested = typeof raw?.path === 'string' ? raw.path : '';
  // An explicit path is a commitment: refuse one that could leave the output
  // folder instead of silently writing somewhere else under a fallback name.
  const segments = requested.split('/');
  if (requested && (!OUTPUT_PATH_SAFE.test(requested)
    || segments.some((segment) => segment === '..' || segment === '.'))) {
    throw new Error(`Output block path "${requested}" must be relative and stay inside the output folder.`);
  }
  const artifactPath = requested
    || (kind === 'zip' ? 'project.zip' : `reports/report.${kind}`);
  return {
    kind,
    path: artifactPath,
    include: raw?.include === 'record' ? 'record' : 'records',
    bundle: oneLine(raw?.bundle, 120) || 'project.zip',
    manifest: raw?.manifest !== false,
    notes: oneLine(raw?.notes, 2000),
  };
}

function taskRecord(raw, index) {
  const nodeId = String(raw?.nodeId || '');
  if (!SAFE_ID.test(nodeId)) throw new Error(`Task ${index + 1} has an invalid node id.`);
  const executable = Boolean(raw?.executable);
  if (TASK_TYPES.has(raw?.type) && raw.type === 'conformers') {
    return { ...conformerTaskRecord(raw, nodeId), ...scopeRecord(raw) };
  }
  const engineId = String(raw?.engine || 'gaussian');
  const engine = engineFor(engineId);
  const argv = Array.isArray(raw?.argv) ? raw.argv.map(String) : null;
  const inputName = String(raw?.inputName || '');
  const outputName = String(raw?.outputName || '');
  const inputText = String(raw?.inputText || '');
  if (executable) {
    if (!engine.acceptsInputName(inputName)) {
      throw new Error(`Task "${nodeId}" must have a safe ${engine.capabilities.inputExtension} input name for ${engine.label}.`);
    }
    if (!engine.acceptsOutputName(outputName)) throw new Error(`Task "${nodeId}" must have a safe .out or .log output name.`);
    if (!inputText.trim()) throw new Error(`Task "${nodeId}" has no ${engine.label} input.`);
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Task "${nodeId}" input is larger than 2 MiB.`);
  }
  let checkpointFrom = null;
  if (raw?.checkpointFrom && SAFE_ID.test(String(raw.checkpointFrom.nodeId))) {
    // A cross-engine edge hands over a parsed geometry, not a file: there is no
    // checkpoint name to validate.
    const geometryOnly = raw.checkpointFrom.geometryOnly === true;
    checkpointFrom = {
      nodeId: String(raw.checkpointFrom.nodeId),
      checkpoint: geometryOnly ? '' : declaredCheckpointFor(engine, raw.checkpointFrom.checkpoint),
      ...(geometryOnly ? { geometryOnly: true } : {}),
    };
  }
  if (checkpointFrom && !checkpointFrom.geometryOnly && !isSafeCheckpointName(engine, checkpointFrom.checkpoint)) {
    throw new Error(`Task "${nodeId}" hands off a checkpoint with an unsafe name.`);
  }
  const checkpointName = checkpointArtifactFor(engine, {
    checkpointName: raw?.checkpointName,
    nodeId,
  });
  if (checkpointName && !isSafeCheckpointName(engine, checkpointName)) {
    throw new Error(`Task "${nodeId}" has an unsafe checkpoint name.`);
  }
  const type = TASK_TYPES.has(raw?.type) ? raw.type : (executable ? 'calc' : 'note');
  const condition = type === 'condition'
    ? {
      expression: oneLine(raw?.condition?.expression, 4000),
      unknown: ['block-both', 'treat-false', 'treat-true'].includes(raw?.condition?.unknown)
        ? raw.condition.unknown : 'block-both',
    }
    : null;
  const loopTarget = String(raw?.loop?.target || '');
  const loop = type === 'loop'
    ? {
      maxAttempts: Number.isInteger(Number(raw?.loop?.maxAttempts))
        ? Math.min(99, Math.max(1, Number(raw.loop.maxAttempts))) : 3,
      mode: oneLine(raw?.loop?.mode, 32) || 'retry',
      target: SAFE_ID.test(loopTarget) ? loopTarget : '',
    }
    : null;
  const merge = type === 'merge'
    ? { policy: ['all', 'any'].includes(raw?.merge?.policy) ? raw.merge.policy : 'all' }
    : null;
  const rawReaction = raw?.reaction && typeof raw.reaction === 'object' ? raw.reaction : null;
  const reaction = rawReaction
    ? {
      transitionStateNodeId: String(rawReaction.transitionStateNodeId || '') || null,
      reactantNodeId: String(rawReaction.reactantNodeId || '') || null,
    }
    : null;
  const rawSpin = raw?.spin && typeof raw.spin === 'object' ? raw.spin : null;
  const spinId = rawSpin ? String(rawSpin.id || '') : '';
  const spin = rawSpin && SAFE_ID.test(spinId)
    ? {
      id: spinId,
      index: Number.isInteger(Number(rawSpin.index)) ? Number(rawSpin.index) : 0,
      multiplicity: Number.isInteger(Number(rawSpin.multiplicity)) ? Number(rawSpin.multiplicity) : null,
      count: Number.isInteger(Number(rawSpin.count)) ? Number(rawSpin.count) : null,
    }
    : null;
  const rawConformer = raw?.conformer && typeof raw.conformer === 'object' ? raw.conformer : null;
  const conformer = rawConformer && /^c\d+$/.test(String(rawConformer.id || ''))
    ? {
      nodeId: oneLine(rawConformer.nodeId, 64) || null,
      title: oneLine(rawConformer.title, 120),
      generator: oneLine(rawConformer.generator, 24),
      id: String(rawConformer.id),
      relativeKcal: Number.isFinite(Number(rawConformer.relativeKcal)) ? Number(rawConformer.relativeKcal) : null,
      population: Number.isFinite(Number(rawConformer.population)) ? Number(rawConformer.population) : null,
      protomer: oneLine(rawConformer.protomer, 40),
      spreadKcal: Number.isFinite(Number(rawConformer.spreadKcal)) ? Number(rawConformer.spreadKcal) : null,
    }
    : null;
  // Issue #101: the planner deferred this calculation because its conformer
  // ensemble did not exist when the workflow was queued. Carry the reason so the
  // scheduler can fail the task with it instead of building an input from the
  // project geometry (the silent substitution the conformer stage exists to stop).
  const rawPending = raw?.pendingInput && typeof raw.pendingInput === 'object' ? raw.pendingInput : null;
  const pendingInput = rawPending
    ? {
      reason: oneLine(rawPending.reason, 400),
      conformerId: oneLine(rawPending.conformerId, 64) || null,
      conformerTitle: oneLine(rawPending.conformerTitle, 120) || null,
    }
    : null;
  const rawLadder = raw?.ladder && typeof raw.ladder === 'object' ? raw.ladder : null;
  const ladderId = rawLadder ? String(rawLadder.id || '') : '';
  const ladder = rawLadder && SAFE_ID.test(ladderId)
    ? {
      id: ladderId,
      index: Number.isInteger(Number(rawLadder.index)) ? Number(rawLadder.index) : 0,
      label: oneLine(rawLadder.label, 40) || `Rung ${Number(rawLadder.index) + 1}`,
      count: Number.isInteger(Number(rawLadder.count)) ? Number(rawLadder.count) : null,
      toleranceKcal: Number.isFinite(Number(rawLadder.toleranceKcal)) ? Number(rawLadder.toleranceKcal) : 3,
    }
    : null;
  const rawFanOut = raw?.fanOut && typeof raw.fanOut === 'object' ? raw.fanOut : null;
  const fanOut = rawFanOut && SAFE_ID.test(String(rawFanOut.conformerId || ''))
    ? {
      conformerId: String(rawFanOut.conformerId),
      memberId: /^c\d+$/.test(String(rawFanOut.memberId || '')) ? String(rawFanOut.memberId) : null,
      count: Number.isInteger(Number(rawFanOut.count)) ? Number(rawFanOut.count) : null,
      spreadKcal: Number.isFinite(Number(rawFanOut.spreadKcal)) ? Number(rawFanOut.spreadKcal) : null,
    }
    : null;
  return {
    nodeId,
    type,
    title: oneLine(raw?.title, 120) || nodeId,
    kind: oneLine(raw?.kind, 32) || 'Calc',
    executable,
    engine: engine.id,
    argv,
    route: oneLine(raw?.route, 2000) || null,
    status: 'pending',
    attempts: 0,
    runId: null,
    runDir: null,
    inputName,
    outputName,
    settings: routeSettings(raw?.settings),
    gates: raw?.gates && typeof raw.gates === 'object' ? raw.gates : {},
    // Issue #25: a bounded, serializable validity context travels with the
    // task so the run record can report scientific checks next to the gates.
    validity: normalizeValidityContext(raw?.validity),
    checkpointName,
    checkpointFrom,
    condition,
    loop,
    merge,
    ladder,
    spin,
    reaction,
    conformer,
    pendingInput,
    fanOut,
    loopAttempts: 0,
    conditionResult: null,
    summary: null,
    history: [],
    gateVerdict: null,
    parsedSummary: null,
    error: null,
    reason: null,
    previousError: null,
    startedAt: null,
    finishedAt: null,
    inputText,
    ...scopeRecord(raw),
    ...(raw?.output && typeof raw.output === 'object' ? { output: outputRecord(raw.output) } : {}),
  };
}

function publicTask(task) {
  // The validity context can carry the whole molecule; the queue panel does
  // not need it, so keep it out of every published queue event.
  const { inputText, validity, ...rest } = task;
  return rest;
}

/**
 * The disk projection keeps the validity context: a resumed task must be able
 * to evaluate the same checks as the task that was interrupted. Only the
 * input text is omitted because it already lives in `inputs/<node>.gjf`.
 */
function storedTask(task) {
  const { inputText, ...rest } = task;
  return rest;
}

function publicQueue(queue) {
  return { ...queue, tasks: queue.tasks.map(publicTask) };
}

export class QueueManager {
  constructor({ queuesRoot, runManager, emit, artifactsRoot = null, projectDir = '' }) {
    this.queuesRoot = queuesRoot;
    this.runManager = runManager;
    // A relative `importPath` in a conformer block is resolved against this,
    // so a project that ships beside its ensemble file can be moved to another
    // machine. Absolute paths keep working exactly as written.
    this.projectDir = typeof projectDir === 'string' && projectDir.trim()
      ? path.resolve(projectDir)
      : '';
    // RFC 0001: the CLI points this at the folder the user named (`--out`), so
    // `reports/…` and `manifest.json` land beside `queues/`. The desktop app
    // omits it and keeps artifacts inside the queue folder.
    this.artifactsRoot = typeof artifactsRoot === 'string' && artifactsRoot.trim()
      ? path.resolve(artifactsRoot)
      : null;
    this.emitExternal = emit || (() => {});
    this.queues = new Map();
    this.loops = new Set();
    this.writeChains = new Map();
    this.pendingRuns = new Map();
    this.finishedRuns = new Map();
    this.starting = false;
    this.unsubscribe = this.runManager.onEvent((event) => this.handleRunEvent(event));
  }

  emit(event) {
    this.emitExternal(event);
  }

  publish(queue, eventType = 'queue') {
    this.emit({ type: eventType, queueId: queue.id, queue: publicQueue(queue) });
  }

  handleRunEvent(event) {
    if (event.type === 'done') {
      const resolve = this.pendingRuns.get(event.runId);
      if (resolve) {
        this.pendingRuns.delete(event.runId);
        resolve(event.record);
      } else {
        this.finishedRuns.set(event.runId, event.record);
        if (this.finishedRuns.size > 50) {
          this.finishedRuns.delete(this.finishedRuns.keys().next().value);
        }
      }
      return;
    }
    if (event.type === 'output') {
      for (const queue of this.queues.values()) {
        const task = queue.tasks.find((item) => item.runId === event.runId);
        if (task) {
          this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, runId: event.runId, text: event.text });
          return;
        }
      }
    }
  }

  waitForRun(runId) {
    if (this.finishedRuns.has(runId)) {
      const record = this.finishedRuns.get(runId);
      this.finishedRuns.delete(runId);
      return Promise.resolve(record);
    }
    return new Promise((resolve) => this.pendingRuns.set(runId, resolve));
  }

  queueDir(queueId) {
    return path.join(this.queuesRoot, queueId);
  }

  inputPath(queueId, nodeId) {
    return path.join(this.queueDir(queueId), 'inputs', `${nodeId}.gjf`);
  }

  conformerInputPath(queueId, nodeId) {
    return path.join(this.queueDir(queueId), 'inputs', `${nodeId}.xyz`);
  }

  /**
   * An imported ensemble path: absolute stays as written, relative resolves
   * against the project directory. Without this a project that imports an
   * ensemble is pinned to the machine that wrote the absolute path, even when
   * the file sits next to the `.ncs`.
   */
  resolveImportPath(queue, importPath) {
    const raw = String(importPath || '');
    if (!raw || path.isAbsolute(raw)) return raw;
    const base = queue?.options?.projectDir || this.projectDir;
    return base ? path.resolve(base, raw) : raw;
  }

  async persist(queue) {
    queue.updatedAt = new Date().toISOString();
    const snapshot = { ...queue, tasks: queue.tasks.map(storedTask) };
    // Serialize writes per queue so a slow rename cannot be overtaken by a
    // newer snapshot from the run event handler.
    const previous = this.writeChains.get(queue.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(
      () => writeJsonAtomic(path.join(this.queueDir(queue.id), 'queue.json'), snapshot),
    );
    this.writeChains.set(queue.id, next);
    await next;
  }

  /* ── Lifecycle ─────────────────────────────────────────── */

  async init() {
    await fsp.mkdir(this.queuesRoot, { recursive: true });
    const entries = await fsp.readdir(this.queuesRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.queuesRoot, entry.name, 'queue.json');
      let record;
      try {
        record = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        continue; // An unreadable queue must not stop the app.
      }
      if (!record?.id || !Array.isArray(record.tasks)) continue;
      record.tasks = record.tasks.filter((task) => TASK_STATUSES.has(task.status));
      this.queues.set(record.id, record);
      if (record.status === 'running') {
        // The app exited mid-run: never pretend the process completed.
        for (const task of record.tasks) {
          if (task.status === 'running') {
            task.status = 'interrupted';
            task.error = 'The app exited while this task was running. Resume to run it again.';
            task.finishedAt = new Date().toISOString();
          }
        }
        record.status = 'paused';
        record.currentTaskId = null;
        record.reason = 'interrupted';
        await this.persist(record);
      }
    }
  }

  /**
   * Only one queue may be active at a time. A paused or needs-review queue is
   * still unfinished: starting a second queue would run two engine processes
   * side by side and make the queue panel disagree with the queue on disk.
   */
  activeQueueExcept(queueId = null) {
    for (const queue of this.queues.values()) {
      if (queue.id === queueId) continue;
      if (['running', 'paused', 'needs-review'].includes(queue.status)) return queue;
    }
    return null;
  }

  async start(payload = {}) {
    if (this.starting) throw new Error('A workflow queue is already starting.');
    const active = this.activeQueueExcept();
    if (active) {
      throw new Error(`Workflow queue "${active.projectName}" is still ${active.status}. Finish or cancel it before starting another.`);
    }
    this.starting = true;
    try {
      return await this.startUnlocked(payload);
    } finally {
      this.starting = false;
    }
  }

  async startUnlocked(payload = {}) {
    const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    if (rawTasks.length === 0) throw new Error('A queued workflow needs at least one task.');
    if (rawTasks.length > MAX_TASKS) throw new Error(`A queued workflow is limited to ${MAX_TASKS} tasks.`);
    const tasks = rawTasks.map(taskRecord);
    const ids = new Set();
    for (const task of tasks) {
      if (ids.has(task.nodeId)) throw new Error(`Duplicate task id "${task.nodeId}".`);
      ids.add(task.nodeId);
    }
    for (const task of tasks) {
      if (task.checkpointFrom && !ids.has(task.checkpointFrom.nodeId)) {
        throw new Error(`Task "${task.nodeId}" hands off from an unknown task "${task.checkpointFrom.nodeId}".`);
      }
      if (task.checkpointFrom?.nodeId === task.nodeId) {
        throw new Error(`Task "${task.nodeId}" cannot hand off from itself.`);
      }
    }

    const edges = (Array.isArray(payload.edges) ? payload.edges : []).map((edge) => ({
      from: String(edge.from || ''),
      to: String(edge.to || ''),
      type: String(edge.type || 'dependency'),
      ...(edge.branch ? { branch: String(edge.branch) } : {}),
    }));
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        throw new Error(`Connection ${edge.from} -> ${edge.to} references an unknown task.`);
      }
    }

    const { cycle } = topologicalOrder(tasks, edges);
    if (cycle) {
      throw new Error(`The workflow has a dependency cycle: ${cycle.join(' → ')}.`);
    }

    const options = payload.options || {};
    // A queue started from the desktop app knows the project's path, not its
    // folder; resolving it here keeps a relative `importPath` working in the
    // GUI exactly as it does under `ncs run --out`.
    if (!options.projectDir && options.projectFile) {
      options.projectDir = path.dirname(path.resolve(String(options.projectFile)));
    }
    const dryRun = Boolean(options.dryRun);
    const executable = String(options.executable || '').trim();
    // Per-engine executables (#98): one project can mix engines, and each task
    // must launch its own binary. The map is keyed by engine id; the single
    // `executable` stays as the fallback for callers that only know one engine.
    const executables = options.executables && typeof options.executables === 'object'
      ? Object.fromEntries(Object.entries(options.executables)
        .map(([engine, value]) => [String(engine), String(value || '').trim()])
        .filter(([, value]) => value))
      : null;
    const executableFor = (engineId) => executables?.[String(engineId || '')] || executable;
    const crestExecutable = String(options.crestExecutable || '').trim();
    const scratchDir = String(options.scratchDir || '').trim();
    // RFC 0001: 1 keeps the sequential drain every existing queue had.
    const maxParallel = Math.max(1, Math.min(Number(options.maxParallel) || 1, LIMITS.maxParallel));
    const calcEngines = [...new Set(tasks
      .filter((task) => task.executable && task.type === 'calc')
      .map((task) => String(task.engine || 'gaussian')))];
    const needsCalcEngine = calcEngines.length > 0;
    // A fanned-out member task carries an ensemble that is already stored in the
    // project; no CREST binary is needed to materialise it (#80).
    const needsCrest = tasks.some((task) => task.type === 'conformers'
      && task.conformers?.generator === 'crest'
      && !task.conformers?.member);
    if (!dryRun) {
      for (const engineId of calcEngines) {
        const path = executableFor(engineId);
        if (!path) {
          throw new Error(`Choose the ${engineFor(engineId).label} executable before running the workflow.`);
        }
        const stat = await fsp.stat(path).catch(() => null);
        if (!stat?.isFile()) throw new Error(`${engineFor(engineId).label} executable not found: ${path}`);
      }
      if (needsCrest) {
        if (!crestExecutable) throw new Error('Choose the CREST executable before running a conformer search (or set the block to import an ensemble).');
        const stat = await fsp.stat(crestExecutable).catch(() => null);
        if (!stat?.isFile()) throw new Error(`CREST executable not found: ${crestExecutable}`);
      }
    }

    const id = queueIdFor();
    const queue = {
      id,
      projectName: oneLine(payload.projectName, 200) || 'Untitled workflow',
      // RFC 0001: the flow this queue ran. Without it an archived queue cannot
      // say which tab it belonged to once the project has several.
      flowId: oneLine(payload.flowId || options.flowId, 64) || null,
      flowTitle: oneLine(payload.flowTitle || options.flowTitle, 200) || null,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      currentTaskId: null,
      reason: null,
      options: {
        dryRun,
        executable: dryRun ? null : executable,
        // Per-engine paths travel with the queue so a relaunch or a replay can
        // still tell which binary each task ran.
        executables: dryRun ? null : executables,
        crestExecutable: dryRun ? null : crestExecutable,
        scratchDir,
        // A relative conformer `importPath` resolves against this folder, so it
        // travels with the queue and a replay resolves it the same way.
        projectDir: options.projectDir || this.projectDir || null,
      },
      maxParallel,
      edges,
      tasks,
      // Method ladders: one verdict per ladder group, evaluated when every rung
      // of that group has finished.
      ladders: {},
      // Spin-state sweeps: the table and the ground state, per swept block.
      spins: {},
      // ΔG‡ for a reaction path, when both blocks it names have free energies.
      reactions: {},
    };

    await fsp.mkdir(path.join(this.queueDir(id), 'inputs'), { recursive: true });
    for (const task of tasks) {
      if (!task.executable) continue;
      const inputPath = task.type === 'conformers'
        ? this.conformerInputPath(id, task.nodeId)
        : this.inputPath(id, task.nodeId);
      await fsp.writeFile(inputPath, task.inputText, 'utf8');
    }
    await this.writeRecordFiles(queue);
    this.queues.set(id, queue);
    await this.persist(queue);
    this.publish(queue, 'queue-started');
    this.drain(queue).catch((error) => this.stall(queue, error));
    return publicQueue(queue);
  }

  /**
   * One gate per method ladder. A group is judged only once every rung has
   * finished; a rung that never ran leaves the verdict `unknown`, never a pass
   * over the rungs that did run.
   */
  async evaluateLadders(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted']);
    const groups = new Map();
    for (const task of queue.tasks) {
      if (!task.ladder?.id) continue;
      if (!groups.has(task.ladder.id)) groups.set(task.ladder.id, []);
      groups.get(task.ladder.id).push(task);
    }
    let changed = false;
    for (const [id, group] of groups) {
      if (!group.every((task) => finished.has(String(task.status)))) continue;
      const entries = [...group]
        .sort((a, b) => (a.ladder.index || 0) - (b.ladder.index || 0))
        .map((task) => ({
          id: task.nodeId,
          label: task.ladder.label,
          energyHartree: Number.isFinite(task.parsedSummary?.energyHartree) ? task.parsedSummary.energyHartree : null,
        }));
      const verdict = ladderVerdict(entries, {
        toleranceKcal: group[0].ladder.toleranceKcal,
        expected: group[0].ladder.count ?? group.length,
      });
      queue.ladders = queue.ladders || {};
      queue.ladders[id] = { ...verdict, evaluatedAt: new Date().toISOString() };
      changed = true;
      if (verdict.status === 'fail') {
        const reason = `Method ladder "${id}" spread ${verdict.spreadKcal.toFixed(2)} kcal/mol exceeds the ${verdict.toleranceKcal} kcal/mol tolerance.`;
        for (const task of group) {
          if (task.status === 'completed') {
            task.status = 'needs-review';
            task.reason = reason;
            task.finishedAt = task.finishedAt || new Date().toISOString();
          }
        }
      }
    }
    return changed;
  }

  /**
   * One table per spin-state sweep, once every state has finished. The ground
   * state is the lowest computed state; a state that did not run is named
   * rather than assumed to be higher.
   */
  async evaluateSpins(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted']);
    const groups = new Map();
    for (const task of queue.tasks) {
      if (!task.spin?.id) continue;
      if (!groups.has(task.spin.id)) groups.set(task.spin.id, []);
      groups.get(task.spin.id).push(task);
    }
    let changed = false;
    for (const [id, group] of groups) {
      if (!group.every((task) => finished.has(String(task.status)))) continue;
      const entries = [...group]
        .sort((a, b) => (a.spin.multiplicity || 0) - (b.spin.multiplicity || 0))
        .map((task) => ({
          nodeId: task.nodeId,
          multiplicity: task.spin.multiplicity,
          energyHartree: Number.isFinite(task.parsedSummary?.energyHartree) ? task.parsedSummary.energyHartree : null,
          spinSquared: Number.isFinite(task.parsedSummary?.spinSquared) ? task.parsedSummary.spinSquared : null,
          spinSquaredSource: task.parsedSummary?.spinSquaredSource || null,
        }));
      queue.spins = queue.spins || {};
      queue.spins[id] = {
        ...spinSweepVerdict(entries, { expected: group[0].spin.count ?? group.length }),
        evaluatedAt: new Date().toISOString(),
      };
      changed = true;
    }
    return changed;
  }

  /**
   * ΔG‡ for each reaction path that declared its transition state and reactant.
   * Both free energies come from the runs themselves; when either is missing the
   * entry says which one, and no number is written.
   */
  async evaluateReactions(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted']);
    const byNodeId = new Map(queue.tasks.map((task) => [task.nodeId, task]));
    let changed = false;
    for (const task of queue.tasks) {
      if (!task.reaction || !finished.has(String(task.status))) continue;
      const tsTask = byNodeId.get(task.reaction.transitionStateNodeId);
      const reactantTask = byNodeId.get(task.reaction.reactantNodeId);
      if (!tsTask || (reactantTask && !finished.has(String(reactantTask.status)))) continue;
      const verdict = deltaGDoubleDagger({
        transitionState: { thermochemistry: { freeEnergyHartree: tsTask.parsedSummary?.freeEnergyHartree ?? null } },
        reactant: reactantTask
          ? { thermochemistry: { freeEnergyHartree: reactantTask.parsedSummary?.freeEnergyHartree ?? null } }
          : null,
      });
      queue.reactions = queue.reactions || {};
      // Where the path ends, checked against the block declared as the reactant.
      // An IRC summary cannot show that an endpoint is a minimum, but it can show
      // whether the endpoint sits at the energy of the block that is supposed to
      // be there — and that is the part a gate can decide.
      const endpoints = task.parsedSummary?.irc || null;
      let endpointCheck = {
        status: 'unknown',
        detail: 'This output carries no IRC path with two endpoints.',
      };
      if (endpoints && reactantTask) {
        const reactantEnergy = reactantTask.parsedSummary?.energyHartree ?? null;
        const candidates = [
          { end: 'first', energy: endpoints.firstEnergyHartree },
          { end: 'last', energy: endpoints.lastEnergyHartree },
        ].filter((entry) => Number.isFinite(entry.energy) && Number.isFinite(reactantEnergy));
        if (candidates.length === 0) {
          endpointCheck = { status: 'unknown', detail: 'The path or the reactant block has no final energy to compare.' };
        } else {
          const best = candidates
            .map((entry) => ({ ...entry, deltaKcal: Math.abs(entry.energy - reactantEnergy) * 627.5094740631 }))
            .sort((a, b) => a.deltaKcal - b.deltaKcal)[0];
          endpointCheck = {
            status: best.deltaKcal <= 2 ? 'pass' : 'fail',
            end: best.end,
            deltaKcal: best.deltaKcal,
            toleranceKcal: 2,
            detail: `The ${best.end} end of the path is ${best.deltaKcal.toFixed(2)} kcal/mol from the declared reactant `
              + `(tolerance ${2} kcal/mol).`,
          };
        }
      } else if (!reactantTask) {
        endpointCheck = {
          status: 'unknown',
          detail: 'No reactant block is declared, so the path ends were not checked against one.',
        };
      }
      queue.reactions[task.nodeId] = {
        ...verdict,
        endpointCheck,
        transitionStateNodeId: task.reaction.transitionStateNodeId,
        reactantNodeId: task.reaction.reactantNodeId,
        evaluatedAt: new Date().toISOString(),
      };
      changed = true;
    }
    return changed;
  }

  /**
   * One queued task, whatever its kind.
   *
   * Issue #101: a calculation planned before its conformer block produced an
   * ensemble carries `pendingInput` and no input text; it fails with the
   * planner's reason instead of running on the project geometry.
   */
  async executeTask(queue, task) {
    if (task.pendingInput) {
      task.status = 'failed';
      task.error = task.pendingInput.reason
        || `"${task.title}" has no selected conformer. Run the ensemble and choose a member before running it.`;
      task.finishedAt = new Date().toISOString();
      await this.persist(queue);
      this.publish(queue);
      return;
    }
    if (task.type === 'conformers') return this.runConformers(queue, task);
    return this.runTask(queue, task);
  }

  /** Last-resort handler: a task that throws outside its own error handling. */
  async failTask(queue, task, error) {
    if (!task) return;
    if (task.status === 'running' || task.status === 'pending') task.status = 'failed';
    task.error = oneLine(error?.message || String(error), 400) || 'The task failed without a message.';
    task.finishedAt = new Date().toISOString();
    await this.persist(queue);
    this.publish(queue);
  }

  /**
   * One small file per dataset record, beside the queue snapshot.
   *
   * A run knows its record from `run.json`; these files make the queue folder
   * self-describing even when the project that planned it is not at hand, which
   * is what a shared or archived run needs.
   */
  async writeRecordFiles(queue) {
    const records = new Map();
    for (const task of queue.tasks) {
      if (!task.recordId || records.has(task.recordId)) continue;
      records.set(task.recordId, {
        id: task.recordId,
        label: task.record?.label || task.recordId,
        charge: Number.isInteger(task.record?.charge) ? task.record.charge : null,
        multiplicity: Number.isInteger(task.record?.multiplicity) ? task.record.multiplicity : null,
        source: task.record?.source || null,
      });
    }
    if (records.size === 0) return;
    const dir = path.join(this.queueDir(queue.id), 'records');
    await fsp.mkdir(dir, { recursive: true });
    for (const record of records.values()) {
      await writeJsonAtomic(path.join(dir, `${record.id}.json`), record);
    }
  }

  /**
   * An output block waits for every upstream task to settle — any terminal
   * status, not only success — or, when it is wired to nothing, for every
   * calculation in its flow. That is what lets a partial family still produce
   * a report naming the records that failed.
   */
  outputReady(queue, task) {
    const terminal = new Set(['completed', 'failed', 'needs-review', 'blocked', 'skipped', 'cancelled', 'interrupted']);
    const sources = queue.edges
      .filter((edge) => edge.to === task.nodeId && edge.type !== 'loop')
      .map((edge) => queue.tasks.find((entry) => entry.nodeId === edge.from))
      .filter(Boolean);
    if (sources.length > 0) return sources.every((source) => terminal.has(String(source.status)));
    const runs = queue.tasks.filter((entry) => entry.type === 'calc' || entry.type === 'conformers');
    return runs.every((entry) => terminal.has(String(entry.status)));
  }

  /**
   * Run the queue.
   *
   * RFC 0001: up to `queue.maxParallel` executable tasks are in flight at once.
   * The default is 1, which is exactly the sequential drain every earlier build
   * had; a barrier is enforced by the plan's edges, not by this loop, so a
   * parallel queue cannot run a stage before its fence is satisfied.
   * Control-flow nodes stay inline: they are decisions over already-finished
   * tasks, not work.
   */
  async drain(queue) {
    if (this.loops.has(queue.id)) return;
    this.loops.add(queue.id);
    const degree = Math.max(1, Math.min(Number(queue.maxParallel) || 1, LIMITS.maxParallel));
    const inFlight = new Map();
    try {
      while (queue.status === 'running') {
        // An output block is exempt from the ordinary block cascade: a failed
        // record must still be reported, not silently remove the artifact.
        const blocked = blockedPendingTasks(queue.tasks, queue.edges)
          .filter((item) => queue.tasks.find((entry) => entry.nodeId === item.nodeId)?.type !== 'output');
        for (const item of blocked) {
          const task = queue.tasks.find((entry) => entry.nodeId === item.nodeId);
          if (task && task.status === 'pending') {
            task.status = 'blocked';
            task.reason = item.reason;
            task.finishedAt = new Date().toISOString();
          }
        }
        if (blocked.length > 0) {
          await this.persist(queue);
          this.publish(queue);
        }

        let started = 0;
        let progressed = false;
        while (queue.status === 'running') {
          // Hold an output block until its whole upstream has settled, even
          // when it has no ordering edge to wait on.
          const skip = new Set(inFlight.keys());
          for (const entry of queue.tasks) {
            if (entry.type === 'output' && entry.status === 'pending' && !this.outputReady(queue, entry)) {
              skip.add(entry.nodeId);
            }
          }
          let task = nextReadyTask(queue.tasks, queue.edges, skip);
          if (!task) {
            // A collector whose upstream failed is ready by the queue's own
            // rule even though `nextReadyTask` cannot see it as satisfied.
            const collector = queue.tasks.find((entry) => entry.type === 'output'
              && entry.status === 'pending' && !skip.has(entry.nodeId) && this.outputReady(queue, entry));
            if (collector) {
              await this.runControl(queue, collector);
              progressed = true;
              continue;
            }
            break;
          }
          // Issue #101: a pending-input block is not a control node; it fails
          // with the planner's reason before anything is spawned.
          if (task.pendingInput) {
            await this.executeTask(queue, task);
            progressed = true;
            continue;
          }
          if (!task.executable) {
            await this.runControl(queue, task);
            progressed = true;
            continue;
          }
          if (inFlight.size >= degree) break;
          started += 1;
          progressed = true;
          const running = this.executeTask(queue, task)
            .catch((error) => this.failTask(queue, task, error))
            .finally(() => inFlight.delete(task.nodeId));
          inFlight.set(task.nodeId, running);
        }

        // Nothing running and nothing startable: either the queue is done, or a
        // control node has just made some branches unreachable. That second case
        // must be marked blocked before the verdict is computed, or a routed
        // graph ends with pending tasks and no reason.
        if (inFlight.size === 0) {
          if (started === 0 && !progressed) {
            const late = blockedPendingTasks(queue.tasks, queue.edges)
              .filter((item) => queue.tasks.find((entry) => entry.nodeId === item.nodeId)?.type !== 'output');
            for (const item of late) {
              const task = queue.tasks.find((entry) => entry.nodeId === item.nodeId);
              if (task && task.status === 'pending') {
                task.status = 'blocked';
                task.reason = item.reason;
                task.finishedAt = new Date().toISOString();
              }
            }
            if (late.length > 0) {
              await this.persist(queue);
              this.publish(queue);
              continue;
            }
            break;
          }
          if (started === 0) continue;
        }
        if (inFlight.size > 0) await Promise.race(inFlight.values());

        const spinChanged = await this.evaluateSpins(queue);
        const reactionChanged = await this.evaluateReactions(queue);
        if (await this.evaluateLadders(queue) || spinChanged || reactionChanged) {
          await this.persist(queue);
          this.publish(queue);
        }
      }
      // A pause or a cancellation leaves work behind; let it settle before the
      // final status is computed, so a task cannot flip the verdict afterwards.
      await Promise.all([...inFlight.values()]);

      if (queue.status !== 'running') return;
      const status = finalStatus(queue.tasks);
      if (status) {
        queue.status = status;
        queue.finishedAt = new Date().toISOString();
        queue.currentTaskId = null;
        // Emit before persisting: a poller that sees the finished status must
        // already have been told the queue is done, otherwise the two views
        // disagree for a moment and a listener can miss the last event.
        this.publish(queue, 'queue-done');
        await this.persist(queue);
      } else if (!nextReadyTask(queue.tasks, queue.edges)) {
        this.stall(queue, new Error('The scheduler could not find a runnable task.'));
      }
    } finally {
      this.loops.delete(queue.id);
    }
  }

  /**
   * Copy the starting geometry into the folder CREST runs in and return the
   * argv that names it (#100).
   *
   * The queue keeps its own copy under `inputs/`, but CREST resolves a relative
   * argument against its working directory — the task folder, where its ensemble
   * and log must land. Handing it `inputs/<node>.xyz` fails even though the file
   * exists, so the geometry is staged as `ensemble.xyz` beside those artifacts
   * and the argument is reduced to the basename, keeping the run folder
   * self-contained. The 2 MiB bound is re-checked here because this copy is what
   * the external program actually reads.
   */
  async stageConformerSearchInput(queue, task, dir) {
    const source = this.conformerInputPath(queue.id, task.nodeId);
    let inputText;
    try {
      inputText = await fsp.readFile(source, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`The starting geometry for "${task.nodeId}" is missing from the queue folder; start the queue again.`);
      }
      throw error;
    }
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error(`The starting geometry for "${task.nodeId}" is larger than 2 MiB; a conformer search input is limited to 2 MiB.`);
    }
    await fsp.writeFile(path.join(dir, CONFORMER_STAGED_INPUT), inputText, 'utf8');
    return conformerArgvFor(task.conformers.argv, CONFORMER_STAGED_INPUT);
  }

  /**
   * Run one conformer search and rank what it produced.
   *
   * Deliberately outside `runTask`: CREST has no route, gates or termination
   * record, so it is not an engine. The artifacts land beside the queue, the
   * summary is stored on the task, and the renderer copies the summary into the
   * block's output so the project can build downstream inputs offline.
   */
  async runConformers(queue, task) {
    const conf = task.conformers;
    const dir = path.join(this.queueDir(queue.id), 'conformers', task.nodeId);
    await fsp.mkdir(dir, { recursive: true });

    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);

    try {
      // Issue #80: a fanned-out member is not a search. The ensemble is already
      // in the project, so this task only materialises its member.
      if (conf.member) {
        await this.carryConformerMember(queue, task, dir, conf.member);
        return;
      }
      let ensembleText = '';
      let energies = [];
      let source = conf.generator;
      let origin = null;
      // Issue #130: a CREST search writes Hartree energies; only an imported
      // file can carry another unit, and only if the block says so.
      const energyUnit = conf.generator === 'import'
        ? (conf.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree')
        : 'hartree';
      const energyMethod = conf.generator === 'import' ? conf.energyMethod : '';

      if (conf.generator === 'import') {
        // Reading an ensemble is a file operation, not an engine call, so a dry
        // run must use the real ensemble. It used to drop straight to the
        // three-member fixture and then fail downstream on "no selected
        // conformer": the dry run hid the data it exists to check.
        const importPath = this.resolveImportPath(queue, conf.importPath);
        const imported = await CrestRunner.readImport(importPath);
        ensembleText = imported.ensembleText;
        energies = imported.energies;
        // Issue #129: the hash is of the bytes on disk, not of the parsed
        // numbers, so a re-export that changes the file changes the digest.
        const sourceSha256 = await sha256File(importPath).catch(() => '');
        origin = {
          program: conf.origin?.program || '',
          version: conf.origin?.version || '',
          method: conf.origin?.method || '',
          sourceSha256,
        };
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          // The origin is printed once, next to the file it describes: a reader
          // of the log then knows what the numbers are before seeing them.
          text: `Imported ensemble ${imported.ensemblePath} (${energyUnit}${energyMethod ? `, ${energyMethod}` : ''}${sourceSha256 ? `, sha256 ${sourceSha256.slice(0, 12)}…` : ''})`
            + (origin.program ? ` from ${origin.program}${origin.version ? ` ${origin.version}` : ''}` : '; origin not recorded'),
        });
      } else if (queue.options.dryRun) {
        const inputText = await fsp.readFile(this.conformerInputPath(queue.id, task.nodeId), 'utf8');
        const parsedInput = parseMultiXyz(inputText);
        if (parsedInput.errors.length > 0 || parsedInput.frames.length === 0) {
          throw new Error(`The starting geometry could not be read: ${parsedInput.errors[0]?.message || 'no frames'}`);
        }
        const fixture = fixtureConformerFrames(parsedInput.frames[0].atoms);
        ensembleText = fixture.text;
        energies = fixture.energies;
        source = 'fixture';
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: 'Dry run: a labelled three-member fixture, not a conformer search.',
        });
      } else {
        const argv = await this.stageConformerSearchInput(queue, task, dir);
        const runner = new CrestRunner();
        this.conformersRunner = runner;
        const result = await runner.run({
          executable: queue.options.crestExecutable,
          argv,
          cwd: dir,
          outputName: task.outputName,
          onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
        }).finally(() => {
          if (this.conformersRunner === runner) this.conformersRunner = null;
        });
        if (result.cancelled) throw new Error('Conformer search cancelled by the user.');
        if (Number(result.exitCode) !== 0) {
          throw new Error(`CREST exited with code ${result.exitCode}; see ${task.outputName} in the queue folder.`);
        }
        ensembleText = result.ensembleText;
        energies = result.energies;
      }

      await fsp.writeFile(path.join(dir, 'ensemble.xyz'), ensembleText, 'utf8');
      const parsed = parseMultiXyz(ensembleText);
      if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
      const merged = withEnergies(parsed.frames, energies);
      if (merged.error) throw new Error(merged.error);
      const ranked = rankEnsemble({
        frames: merged.frames,
        energyWindowKcal: conf.energyWindowKcal,
        rmsdThreshold: conf.rmsdThreshold,
        maxConformers: conf.maxConformers,
        temperature: conf.temperature,
        spreadThresholdKcal: conf.spreadThresholdKcal,
        selectedConformerId: conf.selectedConformerId,
        energyUnit,
        energyMethod: conf.generator === 'import' ? energyMethod : '',
      });
      if (ranked.error) throw new Error(ranked.error);

      // Issue #129: a generated ensemble names what ran here (crest, or the
      // labelled dry-run fixture); an imported one keeps only what was declared.
      const recordedOrigin = origin || {
        program: source,
        version: '',
        method: conf.method || '',
        sourceSha256: '',
      };
      const summary = ensembleSummary(ranked, {
        generator: source,
        method: conf.method,
        origin: recordedOrigin,
        energyUnit,
        energyMethod,
      });
      summary.generatedAt = new Date().toISOString();
      const summaryPath = path.join(dir, 'conformers.json');
      await writeJsonAtomic(summaryPath, summary);

      task.status = 'completed';
      task.ensemble = summary;
      task.ensembleFile = 'conformers.json';
      task.runDir = dir;
      task.finishedAt = new Date().toISOString();
      task.summary = `${summary.count} of ${summary.total} conformers retained`
        + (summary.spreadKcal !== null ? `, spread ${summary.spreadKcal.toFixed(2)} kcal/mol` : '')
        + (summary.requiresSelection ? '; protomers need an explicit choice' : '');
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Ensemble ${task.summary}.` });
    } catch (error) {
      task.status = 'failed';
      task.error = oneLine(error?.message || String(error), 400);
      task.finishedAt = new Date().toISOString();
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Conformer search failed: ${task.error}` });
    }
    await this.persist(queue);
    this.publish(queue);
  }

  /**
   * Materialise one fanned-out member (#80).
   *
   * No search is repeated: the stored geometry and its ranking row are written
   * into the member's own folder so every branch has an artifact and a run
   * record, and `run.json` for the branch's calculation names the member.
   */
  async carryConformerMember(queue, task, dir, member) {
    const inputText = await fsp.readFile(this.conformerInputPath(queue.id, task.nodeId), 'utf8');
    const parsed = parseMultiXyz(inputText);
    if (parsed.errors.length > 0 || parsed.frames.length !== 1) {
      throw new Error(`The fanned-out member geometry could not be read: ${
        parsed.errors[0]?.message || `${parsed.frames.length} frames in the input`}.`);
    }
    const atoms = parsed.frames[0].atoms;
    await fsp.writeFile(path.join(dir, 'member.xyz'), xyzText(atoms, `${member.parentTitle || member.parentId} · ${member.id} · fanned out`), 'utf8');
    // Issues #129/#130: the member's own record repeats the ensemble's origin
    // and the unit its energy is in, so a branch folder read on its own does
    // not have to guess either.
    const memberEnergy = {
      energyUnit: member.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree',
      energyMethod: String(member.energyMethod || ''),
    };
    const memberOrigin = {
      program: String(member.origin?.program || ''),
      version: String(member.origin?.version || ''),
      method: String(member.origin?.method || ''),
      sourceSha256: String(member.origin?.sourceSha256 || ''),
    };
    const summary = {
      generator: String(member.generator || ''),
      method: String(member.method || ''),
      ...memberEnergy,
      origin: memberOrigin,
      mixedEnergies: false,
      count: 1,
      total: 1,
      spreadKcal: Number.isFinite(member.spreadKcal) ? member.spreadKcal : null,
      generatedAt: new Date().toISOString(),
      selectedId: member.id,
      requiresSelection: false,
      autoSelected: false,
      protomers: member.protomer ? [member.protomer] : [],
      pruned: { energy: 0, rmsd: 0, count: 0 },
      warnings: [],
      fanOut: {
        parentId: member.parentId,
        parentTitle: member.parentTitle,
        memberId: member.id,
        rank: member.rank,
        relativeKcal: member.relativeKcal,
        population: member.population,
        temperature: member.temperature,
      },
      members: [{
        id: member.id,
        rank: Number.isInteger(member.rank) ? member.rank : 1,
        energyEh: memberEnergy.energyUnit === 'hartree' ? (member.energyEh ?? null) : null,
        energyKcal: memberEnergy.energyUnit === 'kcal/mol' ? (member.energyKcal ?? null) : null,
        ...memberEnergy,
        relativeKcal: member.relativeKcal,
        population: member.population,
        rmsdToLowest: 0,
        protomer: member.protomer,
        kept: true,
        dropped: null,
        atoms,
      }],
      selected: {
        id: member.id,
        energyEh: memberEnergy.energyUnit === 'hartree' ? (member.energyEh ?? null) : null,
        energyKcal: memberEnergy.energyUnit === 'kcal/mol' ? (member.energyKcal ?? null) : null,
        ...memberEnergy,
        relativeKcal: member.relativeKcal,
        population: member.population,
        protomer: member.protomer,
        atoms,
      },
    };
    await writeJsonAtomic(path.join(dir, 'conformers.json'), summary);
    task.status = 'completed';
    task.ensemble = summary;
    task.ensembleFile = 'conformers.json';
    task.runDir = dir;
    task.finishedAt = new Date().toISOString();
    task.summary = `member ${member.id} of ${member.parentTitle || member.parentId} carried forward from the stored ensemble`;
    task.conformer = {
      nodeId: member.parentId,
      title: member.parentTitle,
      generator: member.generator,
      id: member.id,
      relativeKcal: member.relativeKcal,
      population: member.population,
      protomer: member.protomer,
      spreadKcal: member.spreadKcal,
    };
    this.emit({
      type: 'queue-output',
      queueId: queue.id,
      nodeId: task.nodeId,
      text: `Fanned-out member ${member.id}: geometry carried forward, no search re-run.`,
    });
    await this.persist(queue);
    this.publish(queue);
  }

  async runTask(queue, task) {
    let checkpointHandoff = null;
    if (task.checkpointFrom && !task.checkpointFrom.geometryOnly) {
      const upstream = queue.tasks.find((entry) => entry.nodeId === task.checkpointFrom.nodeId);
      const upstreamEngine = upstream ? engineFor(upstream.engine || 'gaussian') : null;
      const upstreamCheckpoint = upstream && upstreamEngine ? checkpointArtifactFor(upstreamEngine, upstream) : '';
      // Old queues and old UI payloads can still carry a `.chk` placeholder on
      // an xTB edge; resolve it the same way taskRecord does before comparing.
      const declaredCheckpoint = declaredCheckpointFor(
        engineFor(task.engine || 'gaussian'),
        task.checkpointFrom.checkpoint,
      );
      const problem = !upstream
        ? `Checkpoint source "${task.checkpointFrom.nodeId}" is not part of this workflow.`
        : upstream.status !== 'completed'
          ? `Checkpoint source "${upstream.title}" did not complete (${upstream.status}).`
          : !upstream.runDir
            ? `Checkpoint source "${upstream.title}" has no run folder.`
            : upstreamCheckpoint !== declaredCheckpoint
              ? `Checkpoint mismatch: "${upstream.title}" writes ${upstreamCheckpoint} but this task reads ${declaredCheckpoint}.`
              : null;
      if (problem) {
        task.status = 'failed';
        task.error = problem;
        task.finishedAt = new Date().toISOString();
        await this.persist(queue);
        this.publish(queue);
        return;
      }
      checkpointHandoff = {
        sourceRunDir: upstream.runDir,
        checkpoint: upstreamCheckpoint,
        sourceRunId: upstream.runId,
      };
    }

    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    task.runId = null;
    task.runDir = null;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);

    try {
      let inputText = await fsp.readFile(this.inputPath(queue.id, task.nodeId), 'utf8');
      const upstreamTask = task.checkpointFrom
        ? queue.tasks.find((entry) => entry.nodeId === task.checkpointFrom.nodeId) || null
        : null;
      // Cross-engine hand-off: an xTB block leaves no Gaussian checkpoint, so the
      // downstream Gaussian block takes the *parsed* final geometry of the run
      // that finished instead of the geometry it was planned with.
      const upstreamEngineId = upstreamTask ? String(upstreamTask.engine || 'gaussian') : null;
      if (upstreamTask && upstreamTask.runDir && upstreamEngineId !== task.engine) {
        const atoms = await readUpstreamGeometry(upstreamTask.runDir);
        if (!atoms) {
          task.status = 'failed';
          task.error = `"${upstreamTask.title}" finished but its run record carries no parsed final geometry to hand over.`;
          task.finishedAt = new Date().toISOString();
          await this.persist(queue);
          this.publish(queue);
          return;
        }
        if (task.engine === 'gaussian') {
          inputText = applyGeometryHandoff(inputText, atoms);
        }
        task.geometryHandoff = {
          from: upstreamTask.nodeId,
          fromEngine: upstreamEngineId,
          toEngine: task.engine,
          atoms: atoms.length,
        };
      }
      // Issue #25: give the run the upstream optimisation evidence it needs to
      // decide whether a downstream frequency may call its geometry a minimum.
      const validity = {
        ...(task.validity || {}),
        upstream: upstreamTask ? {
          id: upstreamTask.nodeId,
          title: upstreamTask.title,
          state: upstreamTask.status,
          output: upstreamTask.outputName || null,
          settings: upstreamTask.validity?.settings || null,
          parsed: upstreamTask.parsedSummary || null,
        } : null,
      };
      const response = await this.runManager.start({
        title: task.title,
        engine: task.engine,
        argv: task.argv,
        route: task.route || null,
        inputText,
        inputName: task.inputName,
        outputName: task.outputName,
        settings: task.settings,
        executable: queueExecutableFor(queue, task),
        scratchDir: queue.options.scratchDir,
        dryRun: queue.options.dryRun,
        gates: task.gates,
        validity,
        checkpointHandoff,
        // Issue #30: the conformer this run is built on travels into run.json,
        // so a result can never be read as if it came from the imported geometry.
        ...(task.conformer ? { conformer: task.conformer } : {}),
      });
      task.runId = response.runId;
      task.runDir = response.runDir;
      await this.persist(queue);
      this.publish(queue);
      if (queue.status === 'cancelled') {
        // Cancelled while the run manager was still starting this task.
        await this.runManager.cancel(response.runId).catch(() => {});
      }

      const record = await this.waitForRun(response.runId);
      task.gateVerdict = record.gates?.overall || null;
      task.summary = conditionFields(record.parsed, record.gates);
      // Keep only the records a downstream validity check needs; the full
      // parsed output stays in the run folder.
      task.parsedSummary = record.parsed ? {
        complete: record.parsed.complete !== false,
        status: record.parsed.status || null,
        optimization: { completed: record.parsed.optimization?.completed === true },
        // The one number every rung of a method ladder has in common.
        energyHartree: Number.isFinite(record.parsed.finalEnergy?.hartree) ? record.parsed.finalEnergy.hartree : null,
        // ⟨S²⟩ of the converged wavefunction, with the source recorded so a
        // value read from the annihilation line is not mistaken for a raw one.
        spinSquared: Number.isFinite(record.parsed.spinSquared?.value) ? record.parsed.spinSquared.value : null,
        spinSquaredSource: record.parsed.spinSquared?.source || null,
        freeEnergyHartree: Number.isFinite(record.parsed.thermochemistry?.freeEnergyHartree)
          ? record.parsed.thermochemistry.freeEnergyHartree : null,
        // The ends of an IRC path, so a reaction check can compare them with the
        // blocks that are supposed to be the reactant and the product.
        irc: Array.isArray(record.parsed.reactionPath?.points) && record.parsed.reactionPath.points.length > 1
          ? {
            firstEnergyHartree: record.parsed.reactionPath.points[0].energyHartree ?? null,
            lastEnergyHartree: record.parsed.reactionPath.points[record.parsed.reactionPath.points.length - 1].energyHartree ?? null,
            points: record.parsed.reactionPath.points.length,
          }
          : null,
      } : null;
      task.status = record.status === 'completed' ? 'completed'
        : record.status === 'needs-review' ? 'needs-review'
          : record.status === 'cancelled' ? 'cancelled' : 'failed';
      task.error = record.error || null;
      if (task.status === 'needs-review' && !task.error) {
        task.error = 'One or more gates did not pass; review the run output before continuing.';
      }
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      if (error?.runId && error?.runDir) {
        task.runId = error.runId;
        task.runDir = error.runDir;
      }
    } finally {
      task.finishedAt = new Date().toISOString();
      queue.currentTaskId = null;
      await this.persist(queue);
      this.publish(queue);
    }
  }

  /* ── Control-flow nodes ───────────────────────────────── */

  incomingSources(queue, nodeId, edgeType = null) {
    return queue.edges
      .filter((edge) => edge.to === nodeId && edge.type !== 'loop' && (!edgeType || edge.type === edgeType))
      .map((edge) => queue.tasks.find((task) => task.nodeId === edge.from))
      .filter(Boolean);
  }

  upstreamSummary(queue, task) {
    const sources = this.incomingSources(queue, task.nodeId).filter((source) => source.summary);
    if (sources.length === 0) return null;
    sources.sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
    return sources[sources.length - 1].summary;
  }

  setTaskOutcome(task, status, reason) {
    task.status = status;
    task.reason = reason;
    task.finishedAt = status === 'pending' ? null : new Date().toISOString();
  }

  announce(queue, task) {
    this.emit({
      type: 'queue-output',
      queueId: queue.id,
      nodeId: task.nodeId,
      text: `${task.status}${task.reason ? ` — ${task.reason}` : ''}`,
    });
  }

  /**
   * Where an output block writes. A queue without an explicit root keeps its
   * artifacts inside the queue folder, so a desktop run remains one directory.
   */
  artifactsRootFor(queue) {
    return this.artifactsRoot || path.resolve(path.join(this.queueDir(queue.id), 'artifacts'));
  }

  /**
   * The executable tasks an output block collects: its ancestors in the plan,
   * in plan order. An output block wired to nothing still reports the runs of
   * its own flow — an empty artifact would hide the family that actually ran.
   */
  artifactEntries(queue, task) {
    const collects = (entry) => entry && (entry.type === 'calc' || entry.type === 'conformers');
    const seen = new Set();
    const stack = queue.edges
      .filter((edge) => edge.to === task.nodeId && edge.type !== 'loop')
      .map((edge) => edge.from);
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of queue.edges) {
        if (edge.to === id && edge.type !== 'loop') stack.push(edge.from);
      }
    }
    const entries = queue.tasks.filter((entry) => seen.has(entry.nodeId) && collects(entry));
    if (entries.length > 0) return entries;
    return queue.tasks.filter((entry) => collects(entry)
      && (!entry.flowId || !task.flowId || entry.flowId === task.flowId));
  }

  /** Dataset record metadata from the queue snapshot, in plan order. */
  recordInfoFor(queue) {
    const info = new Map();
    for (const task of queue.tasks) {
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

  /**
   * The `run.json` for every task that got as far as a run folder. A failed
   * block without one is simply absent: the report names the failure and does
   * not invent a result.
   */
  async readRunRecords(entries) {
    const records = {};
    for (const task of entries) {
      if (!task.runDir) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const record = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
        if (task.runId) records[task.runId] = record;
        if (task.nodeId && !records[task.nodeId]) records[task.nodeId] = record;
      } catch {
        // Missing or unreadable: leave it out rather than fail the whole artifact.
      }
    }
    return records;
  }

  /**
   * Bundle contents for a `zip` output: the queue snapshot, the record files
   * and each finished run's run.json/input/output. Hashes are computed here and
   * written as `SHA256SUMS` plus a small `manifest.json` inside the archive.
   */
  async bundleFiles(queue, entries, recordId = null) {
    const files = [];
    const add = async (name, filePath) => {
      try {
        files.push({ name, bytes: await fsp.readFile(filePath) });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    };

    await add('queue.json', path.join(this.queueDir(queue.id), 'queue.json'));
    const recordsDir = path.join(this.queueDir(queue.id), 'records');
    const recordFiles = await fsp.readdir(recordsDir).catch(() => []);
    for (const fileName of recordFiles.sort()) {
      if (!fileName.endsWith('.json')) continue;
      if (recordId && fileName !== `${recordId}.json`) continue;
      // eslint-disable-next-line no-await-in-loop
      await add(`records/${fileName}`, path.join(recordsDir, fileName));
    }

    for (const task of entries) {
      if (!task.runDir) continue;
      const base = `flows/${task.flowId || 'main'}/records/${task.recordId || 'record'}/runs/${task.runId || task.nodeId}`;
      const names = new Set(['run.json']);
      if (task.inputName) names.add(task.inputName);
      if (task.outputName) names.add(task.outputName);
      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        await add(`${base}/${name}`, path.join(task.runDir, name));
      }
    }

    const manifest = {
      kind: 'nodechem-studio.artifact-bundle',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      queueId: queue.id,
      flowId: (queue.tasks.find((task) => task.flowId) || {}).flowId || null,
      files: files.map((file) => ({
        name: file.name,
        bytes: file.bytes.length,
        sha256: sha256Hex(file.bytes),
      })),
    };
    files.push({
      name: 'SHA256SUMS',
      bytes: manifest.files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n',
    });
    files.push({ name: 'manifest.json', bytes: `${JSON.stringify(manifest, null, 2)}\n` });
    return files;
  }

  /**
   * Append one entry to `<artifactsRoot>/manifest.json`. The manifest is a JSON
   * array so a reader can verify each artifact without trusting the app; the
   * write is atomic, like every queue snapshot.
   */
  async appendArtifactEntry(root, entry) {
    const file = path.join(root, 'manifest.json');
    let manifest = [];
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Array.isArray(parsed)) manifest = parsed;
      else if (parsed && Array.isArray(parsed.artifacts)) manifest = parsed.artifacts;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    manifest.push(entry);
    await fsp.mkdir(root, { recursive: true });
    await writeJsonAtomic(file, manifest);
    return manifest;
  }

  /** Build, write and manifest one artifact. Returns the manifest entry. */
  async writeOutputArtifact(queue, task, output, {
    entries, records, recordInfo, recordId = null, include = 'records',
  }) {
    const root = this.artifactsRootFor(queue);
    const generatedAt = new Date().toISOString();
    const files = output.kind === 'zip'
      ? await this.bundleFiles(queue, entries, recordId)
      : null;
    const artifact = artifactFor({ ...output, include }, {
      queue,
      records,
      entries,
      recordId,
      recordInfo,
      files,
      generatedAt,
      appVersion: this.runManager?.appInfo?.version || null,
      flowId: task.flowId || null,
    });
    const target = resolveArtifactPath(root, artifact.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, artifact.bytes);
    const entry = {
      path: artifact.path,
      sha256: sha256Hex(artifact.bytes),
      bytes: artifact.bytes.length,
      kind: output.kind,
      flowId: task.flowId || null,
      generatedAt,
      queueId: queue.id,
    };
    await this.appendArtifactEntry(root, entry);
    return entry;
  }

  /**
   * An output block is a collector, not a stage: it runs once every upstream
   * task is terminal — including a failed record — and reports what exists.
   * Blocking it on a failed record would leave a partial family with no report,
   * which is the opposite of the continue-and-report policy.
   */
  async runOutput(queue, task) {
    const output = task.output && typeof task.output === 'object' ? task.output : {};
    const include = output.include === 'record' ? 'record' : 'records';
    const entries = this.artifactEntries(queue, task);
    const records = await this.readRunRecords(entries);
    const recordInfo = this.recordInfoFor(queue);
    const written = [];
    try {
      if (include === 'record') {
        const groups = new Map();
        for (const entry of entries) {
          if (!entry.recordId) continue;
          if (!groups.has(entry.recordId)) groups.set(entry.recordId, []);
          groups.get(entry.recordId).push(entry);
        }
        // A record whose blocks were all blocked still gets a named, empty
        // artifact rather than disappearing from the set.
        for (const info of recordInfo) {
          if (!groups.has(info.id)) groups.set(info.id, []);
        }
        if (groups.size === 0) {
          written.push(await this.writeOutputArtifact(queue, task, output, {
            entries, records, recordInfo, recordId: null, include,
          }));
        } else {
          for (const [recordId, group] of groups) {
            // eslint-disable-next-line no-await-in-loop
            written.push(await this.writeOutputArtifact(queue, task, output, {
              entries: group, records, recordInfo, recordId, include,
            }));
          }
        }
      } else {
        written.push(await this.writeOutputArtifact(queue, task, output, {
          entries, records, recordInfo, include,
        }));
      }
      const detail = written.length === 1
        ? `${written[0].path} · ${written[0].bytes} bytes · sha256 ${written[0].sha256.slice(0, 16)}…`
        : `${written.length} artifacts: ${written.slice(0, 3).map((entry) => entry.path).join(', ')}`
          + `${written.length > 3 ? ` and ${written.length - 3} more` : ''}`;
      this.setTaskOutcome(task, 'completed', oneLine(`wrote ${detail}`, 400));
    } catch (error) {
      // The OS message is the useful one (ENOSPC, EACCES); keep it verbatim.
      this.setTaskOutcome(task, 'failed', oneLine(error?.message || String(error), 400));
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  async runControl(queue, task) {
    // RFC 0001: an input block is a declaration, not work. It completes at once
    // and records how many records the flow is iterating over; its geometry and
    // chemistry already travelled with every downstream task.
    if (task.type === 'input') {
      const count = Array.isArray(task.input?.records) ? task.input.records.length : 0;
      this.setTaskOutcome(task, 'completed',
        `dataset "${task.input?.datasetId || ''}" · ${count} record${count === 1 ? '' : 's'}`);
      await this.persist(queue);
      this.publish(queue);
      this.announce(queue, task);
      return;
    }
    if (task.type === 'condition') {
      await this.runCondition(queue, task);
      return;
    }
    if (task.type === 'loop') {
      await this.runLoop(queue, task);
      return;
    }
    if (task.type === 'note') {
      this.setTaskOutcome(task, 'skipped', 'notes are not executed');
    } else if (task.type === 'merge') {
      const inputs = this.incomingSources(queue, task.nodeId).length;
      const policy = task.merge?.policy || 'all';
      this.setTaskOutcome(task, 'completed', `merged ${inputs} input(s), policy ${policy} (readiness waits for all)`);
    } else if (task.type === 'output') {
      // RFC 0001: an output block writes a real artifact (csv/json/html/zip)
      // under the artifact root and records its SHA-256 in the manifest.
      await this.runOutput(queue, task);
      return;
    } else {
      this.setTaskOutcome(task, 'blocked', 'this control block has no runtime');
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  async runCondition(queue, task) {
    const summary = this.upstreamSummary(queue, task);
    if (!summary) {
      this.setTaskOutcome(task, 'blocked', 'no upstream parsed result to evaluate');
    } else {
      const result = evaluateCondition(task.condition?.expression, summary, {
        unknownPolicy: task.condition?.unknown || 'block-both',
      });
      task.conditionResult = result.value;
      task.reason = result.reason;
      if (result.value === null) {
        this.setTaskOutcome(task, 'blocked', result.reason);
      } else {
        this.setTaskOutcome(task, 'completed', `${result.value ? 'true' : 'false'} — ${result.reason}`);
        const taken = result.value ? 'true' : 'false';
        for (const edge of queue.edges.filter((item) => item.from === task.nodeId && item.type === 'branch')) {
          if (edge.branch !== taken) {
            this.skipSubtree(queue, edge.to, `branch ${edge.branch} not taken (${task.title})`);
          }
        }
      }
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  async runLoop(queue, task) {
    const target = task.loop?.target;
    const maxAttempts = task.loop?.maxAttempts || 3;
    if (!target) {
      this.setTaskOutcome(task, 'blocked', 'loop has no retry target');
    } else {
      task.conditionResult = null;
      if (task.loopAttempts >= maxAttempts) {
        this.setTaskOutcome(task, 'failed', `loop exhausted after ${maxAttempts} attempt(s)`);
      } else {
        task.loopAttempts += 1;
        const reset = this.resetSubtree(queue, target, task.nodeId);
        task.status = 'pending';
        task.finishedAt = null;
        task.runId = null;
        task.runDir = null;
        task.reason = `retry ${task.loopAttempts}/${maxAttempts}: reset ${reset.length} task(s) from ${target}`;
      }
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /** Mark a non-taken branch and everything downstream of it as skipped. */
  skipSubtree(queue, rootId, reason) {
    const seen = new Set();
    const stack = [rootId];
    const skipped = [];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const task = queue.tasks.find((entry) => entry.nodeId === id);
      if (!task) continue;
      if (['pending', 'blocked', 'interrupted'].includes(task.status)) {
        task.status = 'skipped';
        task.reason = reason;
        task.finishedAt = new Date().toISOString();
        skipped.push(id);
      }
      for (const edge of queue.edges) {
        if (edge.from === id && edge.type !== 'loop') stack.push(edge.to);
      }
    }
    return skipped;
  }

  /** Re-open a task and everything downstream so a loop retry recomputes it. */
  resetSubtree(queue, rootId, exceptId) {
    const seen = new Set();
    const stack = [rootId];
    const reset = [];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id) || id === exceptId) continue;
      seen.add(id);
      const task = queue.tasks.find((entry) => entry.nodeId === id);
      if (!task) continue;
      for (const edge of queue.edges) {
        if (edge.from === id && edge.type !== 'loop') stack.push(edge.to);
      }
      if (!['completed', 'failed', 'needs-review', 'blocked', 'skipped', 'interrupted'].includes(task.status)) continue;
      task.history = [
        ...(task.history || []),
        { runId: task.runId, status: task.status, gateVerdict: task.gateVerdict, finishedAt: task.finishedAt },
      ].slice(-20);
      task.status = 'pending';
      task.runId = null;
      task.runDir = null;
      task.gateVerdict = null;
      task.summary = null;
      task.conditionResult = null;
      task.error = null;
      task.reason = null;
      task.startedAt = null;
      task.finishedAt = null;
      reset.push(id);
    }
    return reset;
  }

  stall(queue, error) {
    queue.status = 'needs-review';
    queue.reason = error instanceof Error ? error.message : String(error);
    this.publish(queue, 'queue-done');
    this.persist(queue).catch(() => {});
  }

  /* ── Control ───────────────────────────────────────────── */

  async pause(queueId) {
    const queue = this.queues.get(queueId);
    if (!queue || queue.status !== 'running') return { paused: false };
    queue.status = 'paused';
    queue.reason = 'paused by the user; the running task is allowed to finish';
    await this.persist(queue);
    this.publish(queue);
    return { paused: true };
  }

  async resume(queueId) {
    const queue = this.queues.get(queueId);
    if (!queue) throw new Error('Unknown workflow queue.');
    if (this.starting) throw new Error('A workflow queue is already starting.');
    const active = this.activeQueueExcept(queueId);
    if (active) {
      throw new Error(`Workflow queue "${active.projectName}" is still ${active.status}. Finish or cancel it before resuming another.`);
    }
    if (!['paused', 'needs-review'].includes(queue.status)) return { resumed: false };
    for (const task of queue.tasks) {
      if (task.status === 'interrupted') {
        task.previousError = task.error;
        task.status = 'pending';
        task.error = null;
        task.finishedAt = null;
      }
    }
    queue.status = 'running';
    queue.reason = null;
    queue.finishedAt = null;
    await this.persist(queue);
    this.publish(queue);
    this.drain(queue).catch((error) => this.stall(queue, error));
    return { resumed: true };
  }

  async cancel(queueId) {
    const queue = this.queues.get(queueId);
    if (!queue) throw new Error('Unknown workflow queue.');
    queue.status = 'cancelled';
    queue.reason = 'cancelled by the user';
    for (const task of queue.tasks) {
      if (task.status === 'pending' || task.status === 'blocked') {
        task.status = 'cancelled';
        task.finishedAt = new Date().toISOString();
      }
      if (task.status === 'running' && task.runId) {
        await this.runManager.cancel(task.runId).catch(() => {});
      }
      if (task.status === 'running' && task.type === 'conformers') {
        this.conformersRunner?.cancel();
      }
    }
    queue.currentTaskId = null;
    await this.persist(queue);
    this.publish(queue, 'queue-done');
    return { cancelled: true };
  }

  async list() {
    return [...this.queues.values()]
      .map(publicQueue)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async get(queueId) {
    const queue = this.queues.get(queueId);
    return queue ? publicQueue(queue) : null;
  }

  /**
   * Wait for every queued `queue.json` write to land.
   *
   * The writes are chained, not awaited at the call site: a run event fires
   * `persist()` and moves on. A caller that is about to delete the directory —
   * a test teardown, or the app removing a scratch tree — must not race a
   * rename that is still in flight, which is exactly what produced the Windows
   * `EBUSY` flakes.
   */
  async flush() {
    const pending = [...this.writeChains.values()];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  dispose() {
    this.unsubscribe?.();
  }
}
