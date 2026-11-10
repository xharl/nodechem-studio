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
import { ComputeError, describeCompute, evaluateCompute } from '../../src/shared/compute.js';
import { dp4Summary, evaluateDp4 } from '../../src/shared/dp4Workflow.js';
import { normalizeValidityContext } from '../../src/shared/validityChecks.js';
import { LIMITS } from '../../src/shared/projectSchema.js';
import { applyGeometryHandoffFor, readUpstreamGeometry } from './geometryHandoff.js';
import { sha256File } from './hashing.js';
import { CrestRunner } from './crestRunner.js';
import { ObabelRunner } from './obabelRunner.js';
import { ScorerRunner } from './scorerRunner.js';
import { TautomerRunner } from './tautomerRunner.js';
import { MultiwfnRunner } from './multiwfnRunner.js';
import { parseFchk } from '../../src/shared/fchk.js';
import { densityMatrix } from '../../src/shared/esp.js';
import { qtaimAnalysis } from '../../src/shared/qtaim.js';
import {
  MULTIWFN_CITATION,
  MULTIWFN_LICENCE,
  compareQtaimToApp,
  multiwfnAnalysis,
  multiwfnMenuScript,
  multiwfnSummary,
  multiwfnVersionRefusal,
  normalizeMultiwfnTask,
  parseMultiwfnOutput,
} from '../../src/shared/multiwfn.js';
import {
  DEFAULT_TAUTOMER_OPTIONS,
  TAUTOMER_PROTOCOL,
  TautomerEnumerationError,
  normalizeTautomerResponse,
  tautomerRequest,
  tautomerSummary,
} from '../../src/shared/tautomers.js';
import {
  ensembleSummary,
  fixtureConformerFrames,
  isConformerGroupId,
  parseMultiXyz,
  rankEnsemble,
  withEnergies,
  xyzText,
} from '../../src/shared/conformers.js';
import {
  OBABEL_SEARCH_LOG,
  normalizeObabelForceField,
  obabelCoverageRefusal,
  obabelForceFieldKeyword,
  obabelSearchFailure,
  obabelSearchSummary,
  obabelVersionRefusal,
} from '../../src/shared/obabelConformers.js';
import { generateUffEnsemble, perceiveBonds, UFF_SEARCH_METHOD } from '../../src/shared/uffConformers.js';
import { optimizeUff } from '../../src/shared/uff.js';
import { prepareSummaryLine } from '../../src/shared/prepare.js';
import { relaxWithForces } from '../../src/shared/mlRelax.js';
import {
  SCORER_SPECS,
  framesForScorerRanking,
  normalizeScorerResult,
  scorerDomainFindings,
  scorerModel,
} from '../../src/shared/scorer.js';

// `~` joins a block id to the conformer member it was expanded for (#80); it
// is not a path separator and is legal inside a file name on every target OS.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
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
  // Issue 177: a task stopped by its wall-clock limit is its own outcome. It is
  // not `failed`: the engine never said no, the queue gave up.
  'timed out',
]);

/**
 * The wall-clock limit a task gets when neither the block nor the project names
 * one (issue 177). Generous on purpose: an hour is longer than any single block
 * this app plans, and the point is to catch a hang, not to police a slow run.
 * It is applied at enforcement time and never written into the project file, so
 * a project saved before this setting existed serialises byte-identically.
 */
const DEFAULT_TIMEOUT_SECONDS = 3600;

/** A usable limit from configuration, or null when none was given. */
function timeoutSecondsFrom(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1) return null;
  return Math.min(seconds, LIMITS.timeoutSeconds);
}

const TASK_TYPES = new Set(['input', 'calculate', 'generate', 'condition', 'loop', 'merge', 'output', 'analyse', 'note']);

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

/** The last non-empty line of a captured stream, or null (issue 177). */
function lastLineOf(text, max = 300) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1].slice(0, max) : null;
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
  // Ask the capability, not a Gaussian assumption: `.gbw`, `.chk`, or xTB's
  // fixed `xtbrestart`. A future engine needs only its `restartArtifact`.
  const artifact = String(engine.capabilities.restartArtifact);
  if (artifact.startsWith('.')) return String(task.checkpointName || `${task.nodeId || 'task'}${artifact}`);
  if (artifact === 'chk') return String(task.checkpointName || `${task.nodeId || 'task'}.chk`);
  return artifact;
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

/**
 * The canonical restart artifact an engine declares. Every registered engine
 * implements `checkpointArtifact`; the capability fallback keeps a future
 * engine working without a queue change.
 */
/**
 * Resolve a companion binary the way a shell would.
 *
 * The run console demanded an explicit path for Open Babel and CREST even when
 * the binary sat on PATH, so the first run on a correctly configured machine
 * failed with "Choose the ... executable" (#233 sibling). An explicit setting
 * still wins; PATH is only the fallback.
 */
async function resolveOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      // eslint-disable-next-line no-await-in-loop
      const stat = await fsp.stat(candidate).catch(() => null);
      if (stat?.isFile()) return candidate;
    }
  }
  return '';
}

const ENGINE_BINARIES = Object.freeze({
  gaussian: ['g16', 'g09'],
  xtb: ['xtb'],
  psi4: ['psi4'],
  orca: ['orca'],
  // PySCF is a Python library; `pyscf-runner` is the stable launcher, and a
  // plain interpreter is the fallback. Preflight then proves the interpreter
  // can import pyscf, so a system python without it fails by name.
  pyscf: ['pyscf-runner', 'python3', 'python'],
});

function canonicalRestartArtifact(engine) {
  if (typeof engine?.checkpointArtifact === 'function') {
    return String(engine.checkpointArtifact({ checkpointName: '', nodeId: 'task' }) || '');
  }
  const artifact = String(engine?.capabilities?.restartArtifact || '');
  if (!artifact) return '';
  if (artifact.startsWith('.')) return `task${artifact}`;
  if (artifact === 'chk') return 'task.chk';
  return artifact;
}

/** What the error tells the user to use: `.gbw`, `.chk`, or `xtbrestart`. */
function checkpointExpectation(engine) {
  const canonical = canonicalRestartArtifact(engine);
  if (!canonical) return 'no restart artifact';
  const dot = canonical.lastIndexOf('.');
  return dot > 0 ? `must match ${canonical.slice(dot)}` : `must be "${canonical}"`;
}

/**
 * Issue #231: validate against the engine's own restart artifact. A `.gbw`
 * name is not an "unsafe checkpoint"; it is ORCA's file, and the old Gaussian
 * pattern refused every ORCA task before it could start.
 */
function isSafeCheckpointName(engine, name) {
  const candidate = String(name);
  if (!SAFE_ARTIFACT.test(candidate)) return false;
  const canonical = canonicalRestartArtifact(engine);
  if (!canonical) return false;
  const dot = canonical.lastIndexOf('.');
  if (dot > 0) return candidate.toLowerCase().endsWith(canonical.slice(dot).toLowerCase());
  return candidate === canonical;
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
  const conf = raw?.generate && typeof raw.generate === 'object' ? raw.generate : {};
  // ADR 0001: a generate block either searches or ranks an imported ensemble.
  // The import route needs no starting geometry: the upstream input owns it.
  const source = conf.source === 'imported' ? 'imported' : 'search';
  const ensembleFrom = source === 'imported' && SAFE_ID.test(String(conf.ensembleFrom || ''))
    ? String(conf.ensembleFrom) : '';
  if (source === 'imported' && !ensembleFrom) {
    throw new Error(`Generate task "${nodeId}" is imported but names no ensemble input.`);
  }
  const inputName = String(raw?.inputName || '');
  const inputText = String(raw?.inputText || '');
  if (source === 'search') {
    if (!/^[A-Za-z0-9._-]+\.xyz$/i.test(inputName)) {
      throw new Error(`Generate task "${nodeId}" must have a safe .xyz input name.`);
    }
    if (!inputText.trim()) throw new Error(`Generate task "${nodeId}" has no starting geometry.`);
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error(`Generate task "${nodeId}" input is larger than 2 MiB.`);
    }
  }
  // Issue 144: two search routes, two sources of geometry. Anything else is
  // treated as CREST, which is the historical default.
  const generator = source === 'imported'
    ? ''
    : (conf.generator === 'uff' ? 'uff' : (conf.generator === 'obabel' ? 'obabel' : (conf.generator === 'rdkit' ? 'rdkit' : 'crest')));
  // Issue #226: what the block enumerates. Only `tautomers` changes the task's
  // shape (no method, a JSON sidecar, a candidate cap); a file that never said
  // stays a conformer search.
  const produces = conf.produces === 'tautomers' ? 'tautomers' : 'conformers';
  // A fanned-out member task (#80) carries one member of an ensemble that is
  // already stored in the project. It does not search, so it needs neither a
  // generator nor an import path — only the member row it stands for.
  const rawMember = conf.member && typeof conf.member === 'object' ? conf.member : null;
  const memberId = rawMember ? String(rawMember.id || '') : '';
  if (rawMember && !/^c\d+$/.test(memberId)) {
    throw new Error(`Generate task "${nodeId}" names an invalid member id.`);
  }
  // A number a payload did not state stays null. `Number(null)` is 0, so a
  // plain isFinite check would turn a tautomer's absent energy into a real 0.
  const nullableNumber = (value) => (value === null || value === undefined || value === ''
    ? null
    : (Number.isFinite(Number(value)) ? Number(value) : null));
  const member = rawMember ? {
    id: memberId,
    rank: Number.isFinite(Number(rawMember.rank)) ? Number(rawMember.rank) : null,
    parentId: oneLine(rawMember.parentId, 64),
    parentTitle: oneLine(rawMember.parentTitle, 120),
    generator: oneLine(rawMember.generator, 24),
    method: oneLine(rawMember.method, 24),
    energyEh: nullableNumber(rawMember.energyEh),
    // Issue #130: a fanned-out member must not lose the unit and method its
    // energy was produced with; the branch's conformers.json repeats them.
    energyKcal: nullableNumber(rawMember.energyKcal),
    energyUnit: rawMember.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree',
    energyMethod: oneLine(rawMember.energyMethod, 40),
    origin: {
      program: oneLine(rawMember.origin?.program, 40),
      version: oneLine(rawMember.origin?.version, 40),
      method: oneLine(rawMember.origin?.method, 60),
      sourceSha256: oneLine(rawMember.origin?.sourceSha256, 64),
    },
    relativeKcal: nullableNumber(rawMember.relativeKcal),
    // A mixed ensemble's members have no population (null), which is not 0%.
    population: nullableNumber(rawMember.population),
    protomer: oneLine(rawMember.protomer, 40),
    // Issue #226: a tautomer branch names the candidate it runs. Absent from a
    // conformer member, so its normalized row keeps its exact key set.
    ...(rawMember.tautomer === undefined && rawMember.smiles === undefined ? {} : {
      tautomer: oneLine(rawMember.tautomer, 16),
      smiles: oneLine(rawMember.smiles, 120),
    }),
    spreadKcal: nullableNumber(rawMember.spreadKcal),
    temperature: nullableNumber(rawMember.temperature),
  } : null;
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
    type: 'generate',
    title: oneLine(raw?.title, 120) || nodeId,
    kind: oneLine(raw?.kind, 32) || 'Generate',
    executable: true,
    engine: null,
    argv: null,
    route: null,
    status: 'pending',
    attempts: 0,
    runId: null,
    runDir: null,
    inputName,
    outputName: source === 'imported'
      ? 'conformers.json'
      : (/^[A-Za-z0-9._-]+\.(xyz|out|log|json)$/i.test(String(raw?.outputName || '')) ? String(raw.outputName) : 'crest.out'),
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
    // Issue 177: a per-block wall-clock limit, or null to inherit the project's.
    timeoutSeconds: timeoutSecondsFrom(raw?.settings?.timeoutSeconds),
    loopAttempts: 0,
    conditionResult: null,
    summary: null,
    history: [],
    gateVerdict: null,
    parsedSummary: null,
    error: null,
    reason: null,
    previousError: null,
    // Issue #226: a tautomer refusal carries a code as well as the message, so
    // "the enumerator returned nothing" is distinguishable from "it crashed".
    refusal: null,
    startedAt: null,
    finishedAt: null,
    ensemble: null,
    ensembleFile: null,
    inputText,
    generate: {
      source,
      generator,
      // Issue #226: only a tautomer task states `produces`; a conformer task
      // keeps exactly the keys it always had.
      ...(produces === 'tautomers' ? { produces } : {}),
      rankBy: typeof conf.rankBy === 'string' ? conf.rankBy : '',
      // Issue #240: the task records the method its generator actually runs.
      // `ff` was the pre-#240 name for Open Babel's force field; it is read
      // here only as a migration source, never written back beside `method`.
      method: produces === 'tautomers' || source === 'imported'
        ? ''
        : (generator === 'crest'
          ? (conf.method === 'gfnff' ? 'gfnff' : 'gfn2')
          : (generator === 'uff'
            ? 'UFF'
            : (obabelForceFieldKeyword(conf.method) || obabelForceFieldKeyword(conf.ff) || 'MMFF94'))),
      energyWindowKcal: number(conf.energyWindowKcal, 10, 0, 100),
      rmsdThreshold: number(conf.rmsdThreshold, 0.5, 0.01, 10),
      maxConformers: Math.round(number(conf.maxConformers, produces === 'tautomers' ? 16 : 20, 1, 200)),
      temperature: number(conf.temperature, 298.15, 1, 1000),
      spreadThresholdKcal: number(conf.spreadThresholdKcal, 2, 0, 50),
      selectedConformerId: /^c\d+$/.test(String(conf.selectedConformerId || '')) ? String(conf.selectedConformerId) : '',
      ...(ensembleFrom ? { ensembleFrom } : {}),
      charge: Math.round(number(conf.charge, 0, -10, 10)),
      multiplicity: Math.round(number(conf.multiplicity, 1, 1, 10)),
      // Issue #132: the study the block belongs to, if any. Bounded here like
      // every other string a hand-written queue payload could carry; an
      // invalid value is dropped rather than guessed at.
      group: isConformerGroupId(String(conf.group ?? '')) ? String(conf.group) : '',
      // Issue #226: the tautomer ruleset, bounded like the rest, and only on a
      // tautomer task.
      ...(produces === 'tautomers'
        ? { tautomerRuleset: conf.tautomerRuleset === 'rdkit-default' ? conf.tautomerRuleset : DEFAULT_TAUTOMER_OPTIONS.ruleset }
        : {}),
      // Issue 144: the UFF route's own settings and the project's bond table.
      // Bounded here like everything else, and absent for CREST/import tasks.
      ...(generator === 'uff' && Number.isFinite(Number(conf.torsionStepDegrees))
        ? { torsionStepDegrees: number(conf.torsionStepDegrees, 120, 15, 360) } : {}),
      ...(generator === 'uff' && Number.isFinite(Number(conf.maxTrials))
        ? { maxTrials: Math.round(number(conf.maxTrials, 200, 1, 2000)) } : {}),
      // The Open Babel route's knobs. Bounded like every other number a
      // hand-written queue payload could carry.
      ...(generator === 'obabel' && Number.isFinite(Number(conf.nconf))
        ? { nconf: Math.round(number(conf.nconf, 20, 1, 1000)) } : {}),
      ...(generator === 'uff' && Array.isArray(conf.bonds)
        ? {
          bonds: conf.bonds.slice(0, LIMITS.atoms * 2).map((bond) => ({
            a: Number(bond?.a),
            b: Number(bond?.b),
            order: [1, 1.5, 2, 3].includes(Number(bond?.order)) ? Number(bond.order) : 1,
          })).filter((bond) => Number.isInteger(bond.a) && Number.isInteger(bond.b)
            && bond.a > 0 && bond.b > 0 && bond.a !== bond.b),
        } : {}),
      argv: Array.isArray(conf.argv) ? conf.argv.map(String).slice(0, 32) : [],
      member,
    },
  };
}

/**
 * ADR 0001 §2.10: the atoms a scorer task carries. Bounded like every other
 * renderer-supplied list; an element is a token, a coordinate is a finite number.
 */
function taskAtomList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, LIMITS.atoms).map((atom) => ({
    element: oneLine(atom?.element, 3),
    x: Number(atom?.x),
    y: Number(atom?.y),
    z: Number(atom?.z),
  })).filter((atom) => /^[A-Z][a-z]?$/.test(atom.element)
    && Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z));
}

/**
 * ADR 0001 §2.9: the trust boundary for a prepare task.
 *
 * One structure in, one out, no engine. The input text is required and bounded
 * like every other task's; the SMILES is bounded and only read by embed3d.
 */
function prepareTaskRecord(raw, nodeId) {
  const prep = raw?.prepare && typeof raw.prepare === 'object' ? raw.prepare : {};
  const kind = prep.kind === 'embed3d' ? 'embed3d' : 'relax';
  const converter = kind === 'embed3d'
    ? 'openbabel'
    : (prep.converter === 'openbabel' || prep.converter === 'aimnet2' ? prep.converter : 'uff');
  const inputName = String(raw?.inputName || '');
  const inputText = String(raw?.inputText || '');
  if (!/^[A-Za-z0-9._-]+\.xyz$/i.test(inputName)) {
    throw new Error(`Prepare task "${nodeId}" must have a safe .xyz input name.`);
  }
  if (!inputText.trim()) throw new Error(`Prepare task "${nodeId}" has no structure to prepare.`);
  if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`Prepare task "${nodeId}" input is larger than 2 MiB.`);
  }
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const smiles = oneLine(prep.smiles, 1000);
  if (kind === 'embed3d' && !smiles) {
    throw new Error(`Prepare task "${nodeId}" is embed3d but names no SMILES.`);
  }
  return {
    nodeId,
    type: 'prepare',
    title: oneLine(raw?.title, 120) || nodeId,
    kind: oneLine(raw?.kind, 32) || 'Prepare',
    executable: true,
    engine: null,
    argv: null,
    route: null,
    status: 'pending',
    attempts: 0,
    runId: null,
    runDir: null,
    inputName,
    outputName: 'prepare.json',
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
    fanOut: null,
    timeoutSeconds: timeoutSecondsFrom(raw?.settings?.timeoutSeconds),
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
    prepared: null,
    prepare: {
      kind,
      converter,
      forceField: prep.forceField === 'MMFF94' || prep.forceField === 'AIMNet2'
        ? prep.forceField : (converter === 'aimnet2' ? 'AIMNet2' : 'UFF'),
      smiles,
      charge: Math.round(number(prep.charge, 0, -10, 10)),
      multiplicity: Math.round(number(prep.multiplicity, 1, 1, 10)),
      ...(Array.isArray(prep.bonds)
        ? {
          bonds: prep.bonds.slice(0, LIMITS.atoms * 2).map((bond) => ({
            a: Number(bond?.a),
            b: Number(bond?.b),
            order: [1, 1.5, 2, 3].includes(Number(bond?.order)) ? Number(bond.order) : 1,
          })).filter((bond) => Number.isInteger(bond.a) && Number.isInteger(bond.b)
            && bond.a > 0 && bond.b > 0 && bond.a !== bond.b),
        }
        : {}),
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
    ? (raw.input.kind === 'ensemble'
      ? {
        kind: 'ensemble',
        path: oneLine(raw.input.path, 500),
        format: raw.input.format === 'xyz' ? 'xyz' : 'xyz',
        energyUnit: raw.input.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree',
        energyMethod: oneLine(raw.input.energyMethod, 40),
        origin: {
          program: oneLine(raw.input.origin?.program, 40),
          version: oneLine(raw.input.origin?.version, 40),
          method: oneLine(raw.input.origin?.method, 60),
        },
        ...(oneLine(raw.input.sourceSha256, 64) ? { sourceSha256: oneLine(raw.input.sourceSha256, 64) } : {}),
      }
      : {
        datasetId: text(raw.input.datasetId) || '',
        datasetTitle: oneLine(raw.input.datasetTitle, 160) || '',
        records: Array.isArray(raw.input.records)
          ? raw.input.records.slice(0, LIMITS.records).map((entry) => ({
            id: text(entry?.id) || '',
            label: oneLine(entry?.label, 200) || text(entry?.id) || '',
          })).filter((entry) => entry.id)
          : [],
      })
    : null;
  return {
    flowId: text(raw?.flowId),
    recordId: text(raw?.recordId),
    record: record && record.id ? record : null,
    input,
  };
}

/**
 * Issue 193: the series derivation a generated member carries.
 *
 * The task is the single source for `run.json`, so this travels from the plan
 * through `queue.json` into the run record. Bounded like every other value a
 * hand-written queue payload could carry; a member without a parent, a number
 * and a count is not a derivation and is dropped rather than half-stored.
 */
function seriesTaskRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parentId = oneLine(raw.parentId, 64);
  const n = Number(raw.n);
  const count = Number(raw.count);
  if (!parentId || !Number.isInteger(n) || !Number.isInteger(count)) return null;
  const linkage = raw.linkage && typeof raw.linkage === 'object' ? raw.linkage : null;
  return {
    parentId,
    parentLabel: oneLine(raw.parentLabel, 200) || '',
    n,
    count,
    of: oneLine(raw.of, 32) || '',
    terminal: oneLine(raw.terminal, 32) || '',
    linkage: linkage
      ? {
        donor: Number.isInteger(Number(linkage.donor)) ? Number(linkage.donor) : null,
        acceptor: Number.isInteger(Number(linkage.acceptor)) ? Number(linkage.acceptor) : null,
        bondLengthAngstrom: Number.isFinite(Number(linkage.bondLengthAngstrom))
          ? Number(linkage.bondLengthAngstrom) : null,
        leaving: Array.isArray(linkage.leaving)
          ? linkage.leaving.map((value) => Number(value)).filter((value) => Number.isInteger(value)).slice(0, 64)
          : [],
      }
      : null,
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

/**
 * Issue 175: the declaration an analyse task carries, sanitised.
 *
 * `taskRecord` is the queue's trust boundary — every field on a task came from
 * the renderer — so an analyse declaration is reduced to the fields the
 * evaluator reads, each bounded, and anything that is not an identifier or a
 * safe block id is dropped rather than evaluated.
 */
function analyseTaskPayload(raw) {
  const declared = (Array.isArray(raw?.declared) ? raw.declared : [])
    .filter((entry) => entry && typeof entry === 'object')
    .slice(0, 24)
    .map((entry) => ({
      name: oneLine(entry.name, 64),
      field: oneLine(entry.field, 64),
      source: SAFE_ID.test(String(entry.source || '')) ? String(entry.source) : '',
      scope: entry.scope === 'records' ? 'records' : 'record',
    }))
    .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) && entry.field);
  const dp4 = raw?.mode === 'dp4' ? dp4TaskDefinition(raw.dp4) : null;
  const multiwfn = raw?.mode === 'multiwfn' ? normalizeMultiwfnTask(raw.multiwfn, { path: 'analyse.multiwfn' }) : null;
  return {
    expression: oneLine(raw?.expression, 2000),
    declared,
    // Issue 165: a DP4+ task carries its definition so the queue can evaluate it
    // from the run.json files it finds; the arithmetic payload is otherwise
    // unchanged, and a task without a mode is still exactly an expression.
    ...(dp4 ? { mode: 'dp4', dp4 } : {}),
    // Issue #270: a Multiwfn task carries the validated analysis, input and
    // parameters. Its menu script is generated from the pinned 3.8 recipe, never
    // read from the task, so a hand-written queue cannot smuggle in a menu.
    ...(multiwfn ? { mode: 'multiwfn', multiwfn } : {}),
    sources: (Array.isArray(raw?.sources) ? raw.sources.map(String) : [])
      .filter((id) => SAFE_ID.test(id)).slice(0, 32),
    ...(raw?.recordId && SAFE_ID.test(String(raw.recordId)) ? { recordId: String(raw.recordId) } : {}),
  };
}

/**
 * Issue 165: the DP4+ definition, reduced to what the evaluator reads.
 *
 * A task's fields come from the renderer, so this is a trust boundary like the
 * arithmetic one: every string is bounded, every number must be finite, and the
 * atom lists are integers. Nothing is defaulted here beyond the nucleus label
 * being trimmed — a definition this function cannot read is refused by
 * `evaluateDp4()` by name rather than repaired into something plausible.
 */
function dp4TaskDefinition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rows = (Array.isArray(raw.experimental) ? raw.experimental : [])
    .slice(0, 400)
    .map((row) => (row && typeof row === 'object' ? {
      nucleus: oneLine(row.nucleus, 8),
      shift: Number.isFinite(Number(row.shift)) ? Number(row.shift) : null,
      ...(row.sp2 === true ? { sp2: true } : {}),
      ...(oneLine(row.exchange, 16) ? { exchange: oneLine(row.exchange, 16) } : {}),
      atoms: (Array.isArray(row.atoms) ? row.atoms : []).slice(0, 64)
        .map(Number).filter((index) => Number.isInteger(index) && index > 0),
    } : null))
    .filter(Boolean);
  const assignments = {};
  if (raw.candidateAssignments && typeof raw.candidateAssignments === 'object') {
    for (const [id, list] of Object.entries(raw.candidateAssignments)) {
      const key = oneLine(id, 64);
      if (!key) continue;
      assignments[key] = (Array.isArray(list) ? list : []).slice(0, 400)
        .map((atoms) => (Array.isArray(atoms) ? atoms : []).slice(0, 64)
          .map(Number).filter((index) => Number.isInteger(index) && index > 0));
    }
  }
  return {
    level: oneLine(raw.level, 120),
    solvation: oneLine(raw.solvation, 16),
    solvent: oneLine(raw.solvent, 40),
    variant: oneLine(raw.variant, 16),
    temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : null,
    experimental: rows,
    ...(Object.keys(assignments).length ? { candidateAssignments: assignments } : {}),
  };
}

function taskRecord(raw, index) {
  const nodeId = String(raw?.nodeId || '');
  if (!SAFE_ID.test(nodeId)) throw new Error(`Task ${index + 1} has an invalid node id.`);
  const executable = Boolean(raw?.executable);
  if (TASK_TYPES.has(raw?.type) && raw.type === 'generate') {
    return { ...conformerTaskRecord(raw, nodeId), ...scopeRecord(raw) };
  }
  if (raw?.type === 'prepare') {
    return { ...prepareTaskRecord(raw, nodeId), ...scopeRecord(raw) };
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
  // xTB keeps its deferred mismatch check: a declared name is only a claim until
  // the upstream runs, and the existing test pins that error. The outgoing
  // artifact (`checkpointName`) is still validated below against the engine.
  const safeHandoff = engine.id === 'xtb'
    ? SAFE_ARTIFACT.test(String(checkpointFrom?.checkpoint || ''))
    : isSafeCheckpointName(engine, checkpointFrom?.checkpoint);
  if (checkpointFrom && !checkpointFrom.geometryOnly && !safeHandoff) {
    throw new Error(`Task "${nodeId}" hands off "${checkpointFrom.checkpoint}", but this engine's restart artifact ${checkpointExpectation(engine)}.`);
  }
  const checkpointName = checkpointArtifactFor(engine, {
    checkpointName: raw?.checkpointName,
    nodeId,
  });
  if (checkpointName && !isSafeCheckpointName(engine, checkpointName)) {
    throw new Error(`Task "${nodeId}" names the restart artifact "${checkpointName}", but this engine's restart artifact ${checkpointExpectation(engine)}.`);
  }
  const type = TASK_TYPES.has(raw?.type) ? raw.type : (executable ? 'calculate' : 'note');
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
  // Issue 175: an analyse block's expression and declared inputs.
  const analyse = type === 'analyse' && raw?.analyse && typeof raw.analyse === 'object'
    ? analyseTaskPayload(raw.analyse) : null;
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
  const rawScorer = raw?.scorer && typeof raw.scorer === 'object' ? raw.scorer : null;
  const scorerSpec = rawScorer ? String(rawScorer.spec || '') : '';
  const scorerAtoms = rawScorer ? taskAtomList(rawScorer.atoms) : [];
  const scorer = rawScorer && SCORER_SPECS.includes(scorerSpec) && scorerAtoms.length > 0
    ? {
      spec: scorerSpec,
      atoms: scorerAtoms,
      charge: Number.isInteger(Number(rawScorer.charge)) ? Math.min(10, Math.max(-10, Number(rawScorer.charge))) : 0,
      multiplicity: Number.isInteger(Number(rawScorer.multiplicity))
        ? Math.min(10, Math.max(1, Number(rawScorer.multiplicity))) : 1,
    }
    : null;
  const rawPrepareFrom = raw?.prepareFrom && typeof raw.prepareFrom === 'object' ? raw.prepareFrom : null;
  const prepareFrom = rawPrepareFrom && SAFE_ID.test(String(rawPrepareFrom.nodeId || ''))
    ? { nodeId: String(rawPrepareFrom.nodeId) } : null;
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
    kind: oneLine(raw?.kind, 32) || 'Calculate',
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
    prepareFrom,
    scorer,
    analyse,
    ladder,
    spin,
    reaction,
    conformer,
    pendingInput,
    fanOut,
    // Issue 177: the block's own wall-clock limit, or null to inherit the
    // project's. Never invented here — an absent value stays absent.
    timeoutSeconds: timeoutSecondsFrom(raw?.settings?.timeoutSeconds),
    // Issue 193: the series derivation, so the run record can say "the 4-mer of
    // that unit" without re-deriving it from a task id or a file name.
    series: seriesTaskRecord(raw?.series),
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
    // Issue #270: the Multiwfn sidecar child currently running, so a queue
    // cancellation can stop it the way it stops an engine.
    this.multiwfnRunner = null;
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
    let executables = options.executables && typeof options.executables === 'object'
      ? Object.fromEntries(Object.entries(options.executables)
        .map(([engine, value]) => [String(engine), String(value || '').trim()])
        .filter(([, value]) => value))
      : null;
    const executableFor = (engineId) => executables?.[String(engineId || '')] || executable;
    const crestExecutable = String(options.crestExecutable || '').trim()
      || await resolveOnPath(process.platform === 'win32' ? ['crest.exe'] : ['crest']);
    const obabelExecutable = String(options.obabelExecutable || '').trim()
      || await resolveOnPath(process.platform === 'win32' ? ['obabel.exe'] : ['obabel']);
    // Issue #270: Multiwfn is a separately installed analysis sidecar. It is
    // never bundled, so a block that asks for it needs a path (or one on PATH).
    const multiwfnExecutable = String(options.multiwfnExecutable || '').trim()
      || await resolveOnPath(process.platform === 'win32'
        ? ['Multiwfn.exe', 'multiwfn.exe'] : ['Multiwfn', 'multiwfn']);
    const scratchDir = String(options.scratchDir || '').trim();
    // RFC 0001: 1 keeps the sequential drain every existing queue had.
    const maxParallel = Math.max(1, Math.min(Number(options.maxParallel) || 1, LIMITS.maxParallel));
    // Issue 177: the project's wall-clock limit for one task. Absent from the
    // start payload means the generous default, never "no limit".
    const timeoutSeconds = timeoutSecondsFrom(options.timeoutSeconds) ?? DEFAULT_TIMEOUT_SECONDS;
    const calcEngines = [...new Set(tasks
      .filter((task) => task.executable && task.type === 'calculate' && !task.scorer)
      .map((task) => String(task.engine || 'gaussian')))];
    const needsCalcEngine = calcEngines.length > 0;
    // A fanned-out member task carries an ensemble that is already stored in the
    // project; no CREST binary is needed to materialise it (#80).
    const needsCrest = tasks.some((task) => task.type === 'generate'
      && task.generate?.generator === 'crest'
      && !task.generate?.member);
    // The Open Babel route is external too, so it needs its own binary; a
    // fanned-out member carries its ensemble already and needs nothing.
    const needsObabel = tasks.some((task) => (task.type === 'generate'
      && task.generate?.generator === 'obabel'
      && !task.generate?.member)
      || (task.type === 'prepare' && task.prepare?.converter === 'openbabel'));
    // Issue #239: Open Babel 3.2.x segfaults in its `--conformer` search. Only
    // a search is affected — `--gen3d` and the relax path run fine on the same
    // binary — so the version refusal is scoped to generate tasks (a prepare
    // converter on 3.2.x is left alone).
    const obabelSearchTasks = tasks.filter((task) => task.type === 'generate'
      && task.generate?.generator === 'obabel'
      && !task.generate?.member);
    const needsObabelSearch = obabelSearchTasks.length > 0;
    // ADR 0001 §2.10: a scorer is optional, but a block that asks for one
    // cannot run without its sidecar.
    const needsScorer = tasks.some((task) => (task.type === 'generate' && task.generate?.rankBy)
      || (task.type === 'calculate' && task.scorer)
      || (task.type === 'prepare' && task.prepare?.converter === 'aimnet2'));
    // Issue #226: tautomer enumeration is always the external sidecar — there
    // is no in-app fallback, and a dry run must not fabricate a tautomer set.
    const tautomerExecutable = String(options.tautomerExecutable || '').trim();
    const tautomerScript = String(options.tautomerScript || '').trim();
    const needsTautomer = tasks.some((task) => task.type === 'generate'
      && task.generate?.produces === 'tautomers'
      && !task.generate?.member);
    // Issue #270: a Multiwfn analyse block spawns the user-installed sidecar.
    // A dry run must not spawn it, exactly as it spawns no engine.
    const needsMultiwfn = tasks.some((task) => task.type === 'analyse'
      && task.analyse?.mode === 'multiwfn');

    // PATH fallback (#233 sibling): an engine that is on PATH should not require
    // the same absolute path in every run. Explicit settings still win.
    if (!dryRun && needsCalcEngine) {
      const resolved = { ...(executables || {}) };
      for (const engineId of calcEngines) {
        if (String(resolved[engineId] || executable || '').trim()) continue;
        // eslint-disable-next-line no-await-in-loop
        const found = await resolveOnPath(ENGINE_BINARIES[engineId] || []);
        if (found) resolved[engineId] = found;
      }
      if (Object.keys(resolved).some((key) => resolved[key] && resolved[key] !== executables?.[key])) {
        executables = resolved;
        options.executables = resolved;
      }
    }


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
      if (needsObabel) {
        if (!obabelExecutable) throw new Error('Choose the Open Babel executable before running an Open Babel search, embed3d or relax (or change the block to CREST, UFF, or a different prepare converter).');
        const stat = await fsp.stat(obabelExecutable).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Open Babel executable not found: ${obabelExecutable}`);
      }
      if (needsObabelSearch) {
        // Issue #239: ask the binary what it is before spawning a search that
        // the known-broken series cannot finish. The refusal is recorded on the
        // affected tasks — not thrown — so a mixed workflow still runs the
        // blocks it can and the report names the version and the way out.
        const version = await ObabelRunner.version(obabelExecutable);
        const refusal = obabelVersionRefusal(version);
        if (refusal) {
          for (const task of obabelSearchTasks) {
            task.status = 'failed';
            task.error = refusal;
            task.refusal = { code: 'obabel-version', version, message: refusal };
            task.finishedAt = new Date().toISOString();
          }
        }
      }
      if (needsScorer) {
        const scorerExecutable = String(options.scorerExecutable || '').trim();
        if (!scorerExecutable) throw new Error('Choose the ML scorer sidecar before running a block with rankBy set.');
        const stat = await fsp.stat(scorerExecutable).catch(() => null);
        if (!stat?.isFile()) throw new Error(`ML scorer sidecar not found: ${scorerExecutable}`);
      }
      if (needsTautomer) {
        if (!tautomerExecutable) {
          throw new Error('Choose the tautomer sidecar before running a tautomer block. Tautomer enumeration needs '
            + 'RDKit (scripts/tautomer-enumerator.py); there is no in-app fallback.');
        }
        const stat = await fsp.stat(tautomerExecutable).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Tautomer sidecar not found: ${tautomerExecutable}`);
        if (tautomerScript) {
          const scriptStat = await fsp.stat(tautomerScript).catch(() => null);
          if (!scriptStat?.isFile()) throw new Error(`Tautomer sidecar script not found: ${tautomerScript}`);
        }
      }
      if (needsMultiwfn) {
        if (!multiwfnExecutable) {
          throw new Error('Choose the Multiwfn executable before running a Multiwfn analysis block. '
            + 'Multiwfn is user-installed and is not bundled with NodeChem Studio.');
        }
        const stat = await fsp.stat(multiwfnExecutable).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Multiwfn executable not found: ${multiwfnExecutable}`);
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
        obabelExecutable: dryRun ? null : obabelExecutable,
        scorerExecutable: dryRun ? null : String(options.scorerExecutable || '').trim(),
        // Issue #270: the user-installed Multiwfn binary travels with the queue,
        // so a replay names the same program and a dry run records none.
        multiwfnExecutable: dryRun ? null : multiwfnExecutable,
        // Issue #226: the tautomer sidecar travels with the queue so a replay
        // names the same program, and a dry run records none because none ran.
        tautomerExecutable: dryRun ? null : tautomerExecutable,
        tautomerScript: dryRun ? null : tautomerScript,
        scratchDir,
        // A relative conformer `importPath` resolves against this folder, so it
        // travels with the queue and a replay resolves it the same way.
        projectDir: options.projectDir || this.projectDir || null,
      },
      maxParallel,
      // Issue 177: the wall-clock limit every task inherits unless its own
      // block overrides it. Persisted with the queue so a replay enforces what
      // the run enforced, and shown on the running row as elapsed-vs-limit.
      timeoutSeconds,
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
      const inputPath = (task.type === 'generate' || task.type === 'prepare')
        ? this.conformerInputPath(id, task.nodeId)
        : this.inputPath(id, task.nodeId);
      // ADR 0001: an imported generate task reads its upstream input's record
      // and has no starting geometry of its own; nothing to stage.
      if (task.inputText !== null && task.inputText !== undefined) {
        await fsp.writeFile(inputPath, task.inputText, 'utf8');
      }
    }
    await this.writeRecordFiles(queue);
    this.queues.set(id, queue);
    await this.persist(queue);
    this.publish(queue, 'queue-started');
    // Issue #239: the refusal is already on the task; say it in the run console
    // too, so a user watching the queue sees the version and the workaround
    // rather than only a red row.
    for (const task of tasks) {
      if (task.refusal?.code !== 'obabel-version') continue;
      this.emit({ type: 'queue-output', queueId: id, nodeId: task.nodeId, text: `Refused: ${task.error}\n` });
    }
    this.drain(queue).catch((error) => this.stall(queue, error));
    return publicQueue(queue);
  }

  /**
   * One gate per method ladder. A group is judged only once every rung has
   * finished; a rung that never ran leaves the verdict `unknown`, never a pass
   * over the rungs that did run.
   */
  async evaluateLadders(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted', 'timed out']);
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
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted', 'timed out']);
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
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted', 'timed out']);
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
    if (task.type === 'generate') return this.runConformers(queue, task);
    if (task.type === 'prepare') return this.runPrepare(queue, task);
    if (task.type === 'calculate' && task.scorer) return this.runScorerPoint(queue, task);
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
    const terminal = new Set(['completed', 'failed', 'needs-review', 'blocked', 'skipped', 'cancelled', 'interrupted', 'timed out']);
    const sources = queue.edges
      .filter((edge) => edge.to === task.nodeId && edge.type !== 'loop')
      .map((edge) => queue.tasks.find((entry) => entry.nodeId === edge.from))
      .filter(Boolean);
    if (sources.length > 0) return sources.every((source) => terminal.has(String(source.status)));
    const runs = queue.tasks.filter((entry) => entry.type === 'calculate' || entry.type === 'generate');
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
    return conformerArgvFor(task.generate.argv, CONFORMER_STAGED_INPUT);
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
    const conf = task.generate;
    const dir = path.join(this.queueDir(queue.id), 'generate', task.nodeId);
    await fsp.mkdir(dir, { recursive: true });

    // Set before the work starts: a stage that fails still leaves artifacts, and
    // a record whose runDir is null hides them.
    task.runDir = dir;
    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    task.timeout = null;
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
      // Issue #226: a tautomer block is a different job — an external
      // enumerator, a candidate set with no energies, and no ranking pass. It
      // writes its own ensemble and returns; nothing below applies to it.
      if (conf.produces === 'tautomers') {
        await this.runTautomerEnumeration(queue, task, conf, dir);
        return;
      }
      let ensembleText = '';
      let energies = [];
      let source = conf.source === 'imported' ? 'imported' : conf.generator;
      let origin = null;
      // Issue 144: what an in-app UFF search did, kept beside the numbers.
      let search = null;
      // Its caveats (perceived bonds, truncated grid, unconverged trials) must
      // travel with the summary, not only into the run log.
      let searchWarnings = [];
      // ADR 0001 §2.10: the scorer, when the block asked for one.
      let scorerProvenance = null;
      const scorerWarnings = [];
      // Issue #130: a CREST search writes Hartree energies; a UFF/Open Babel
      // search writes kcal/mol. ADR 0001 moves the imported file's unit,
      // method and provenance to the input block, which is read below.
      let energyUnit = conf.source === 'imported'
        ? 'hartree'
        : (conf.generator === 'uff' || conf.generator === 'obabel' ? 'kcal/mol' : 'hartree');
      let energyMethod = conf.source === 'imported'
        ? ''
        : (conf.generator === 'uff'
          ? 'UFF'
          : (conf.generator === 'obabel'
            ? (obabelForceFieldKeyword(conf.method) || obabelForceFieldKeyword(conf.ff) || 'MMFF94')
            : ''));
      if (conf.source === 'imported') {
        // ADR 0001: the input block already read, hashed and wrote the file.
        // This block only ranks what that record contains; it never opens the
        // user's path again.
        const inputTask = queue.tasks.find((entry) => entry.nodeId === conf.ensembleFrom);
        if (!inputTask) {
          throw new Error(`The ensemble input "${conf.ensembleFrom}" is not part of this workflow.`);
        }
        if (inputTask.status !== 'completed' || !inputTask.runDir) {
          throw new Error(`The ensemble input "${inputTask.title || conf.ensembleFrom}" has not produced its record.`);
        }
        const sourceDir = inputTask.runDir;
        const record = JSON.parse(await fsp.readFile(path.join(sourceDir, 'ensemble.json'), 'utf8'));
        ensembleText = await fsp.readFile(path.join(sourceDir, 'ensemble.xyz'), 'utf8');
        energies = Array.isArray(record.energies) ? record.energies : [];
        energyUnit = record.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree';
        energyMethod = String(record.energyMethod || '');
        origin = {
          program: String(record.origin?.program || ''),
          version: String(record.origin?.version || ''),
          method: String(record.origin?.method || ''),
          sourceSha256: String(record.origin?.sourceSha256 || record.sourceSha256 || ''),
        };
        source = origin.program || 'imported';
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: `Ranking imported ensemble from input "${inputTask.title || conf.ensembleFrom}"`
            + ` (${energyUnit}${energyMethod ? `, ${energyMethod}` : ''}`
            + `${origin.sourceSha256 ? `, sha256 ${origin.sourceSha256.slice(0, 12)}…` : ''})`,
        });
      } else if (conf.generator === 'uff') {
        // Issue 144: the in-app route. It spawns nothing, so a dry run runs it
        // for real: "dry" here means "no external binary", which is exactly
        // what this route does anyway.
        const inputText = await fsp.readFile(this.conformerInputPath(queue.id, task.nodeId), 'utf8');
        const parsedInput = parseMultiXyz(inputText);
        if (parsedInput.errors.length > 0 || parsedInput.frames.length === 0) {
          throw new Error(`The starting geometry could not be read: ${parsedInput.errors[0]?.message || 'no frames'}`);
        }
        const generated = generateUffEnsemble({
          atoms: parsedInput.frames[0].atoms,
          bonds: Array.isArray(conf.bonds) ? conf.bonds : null,
          torsionStepDegrees: conf.torsionStepDegrees,
          maxTrials: conf.maxTrials,
          rmsdThreshold: conf.rmsdThreshold,
          energyWindowKcal: conf.energyWindowKcal,
          maxConformers: conf.maxConformers,
          temperature: conf.temperature,
          spreadThresholdKcal: conf.spreadThresholdKcal,
          selectedConformerId: conf.selectedConformerId,
        });
        if (generated.error) throw new Error(generated.error);
        ensembleText = generated.ensembleText;
        energies = generated.energies;
        search = generated.search;
        searchWarnings = generated.warnings || [];
        source = 'uff';
        origin = { program: 'NodeChem Studio', version: '', method: 'UFF', sourceSha256: '' };
        // The log says what ran, on what grid, and what these numbers are. It
        // is written into the task folder, so a reader of the artifacts alone
        // is not left guessing whether this was QM or CREST.
        await fsp.writeFile(path.join(dir, task.outputName || 'uff.log'), [
          `${task.title} · in-app conformer search`,
          `Method: ${UFF_SEARCH_METHOD}`,
          `Grid: ${search.torsionStepDegrees}° over ${search.rotatableBonds} rotatable bond(s); `
            + `${search.trials} trial(s) run of ${search.trialsPlanned ?? 'more than reported'} in the full grid`
            + `${search.truncated ? ' (grid truncated)' : ''}`,
          `Dedupe: ${search.deduplicated} trial(s) collapsed at ${search.rmsdThreshold} Å heavy-atom RMSD; `
            + `${search.unique} unique member(s)`,
          `Bonds: ${search.bondSource === 'supplied' ? 'from the project bond table' : 'perceived from geometry, all single (see warnings)'}`,
          'Energies: UFF force-field energies in kcal/mol. Not QM, not comparable with a Hartree value.',
        ].join('\n') + '\n', 'utf8');
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: `In-app UFF search: ${UFF_SEARCH_METHOD}; ${search.torsionStepDegrees}° grid, `
            + `${search.trials} trial(s), ${search.unique} unique at ${search.rmsdThreshold} Å. `
            + 'Force-field structures, not QM; no external binary was run.',
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
        // The fixture's numbers are synthetic Hartree values, not the force-field
        // kcal/mol an Open Babel or UFF block would record.
        energyUnit = 'hartree';
        energyMethod = '';
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: 'Dry run: a labelled three-member fixture, not a conformer search.',
        });
      } else if (conf.generator === 'obabel') {
        // Open Babel is external, like CREST: the app stages one starting
        // geometry, spawns the search, then evaluates one MMFF94 energy per
        // conformer. Nothing is inferred from the binary's absence.
        const inputText = await fsp.readFile(this.conformerInputPath(queue.id, task.nodeId), 'utf8');
        const parsedInput = parseMultiXyz(inputText);
        if (parsedInput.errors.length > 0 || parsedInput.frames.length === 0) {
          throw new Error(`The starting geometry could not be read: ${parsedInput.errors[0]?.message || 'no frames'}`);
        }
        // MMFF94 has no parameters for every element. Refusing by name here is
        // the difference between "this molecule is out of scope" and a silently
        // untyped atom producing a plausible-looking energy. Issue #240: the
        // check belongs to the force field the block selected, so a UFF search
        // is not refused for an element MMFF94 lacks.
        const coverageRefusal = obabelCoverageRefusal(parsedInput.frames[0].atoms, conf.method);
        if (coverageRefusal) throw new Error(coverageRefusal);

        const argv = await this.stageConformerSearchInput(queue, task, dir);
        const runner = new ObabelRunner();
        this.conformersRunner = runner;
        const result = await runner.run({
          executable: queue.options.obabelExecutable,
          argv,
          cwd: dir,
          outputName: task.outputName || OBABEL_SEARCH_LOG,
          // Issue #240: the block's method *is* the force field; one name
          // drives both the record and `--ff`.
          ff: normalizeObabelForceField(conf.method),
          // Issue 177: the same wall-clock limit the calculation tasks get.
          timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
          onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
        }).finally(() => {
          if (this.conformersRunner === runner) this.conformersRunner = null;
        });
        if (result.timedOut) {
          const startedAt = Date.parse(task.startedAt || '') || Date.now();
          const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 100) / 10);
          task.status = 'timed out';
          task.timeout = {
            limitSeconds: this.taskTimeoutSeconds(queue, task),
            elapsedSeconds,
            lastOutput: lastLineOf(result.outputText),
          };
          task.error = `Stopped after ${elapsedSeconds.toFixed(1)} s: the ${task.timeout.limitSeconds} s wall-clock limit was reached; the search output was not used.`;
          task.finishedAt = new Date().toISOString();
          this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Timed out: ${task.error}\n` });
          await this.persist(queue);
          this.publish(queue);
          return;
        }
        if (result.cancelled) throw new Error('Conformer search cancelled by the user.');
        // Issue #239: a signalled child leaves `exitCode === null`, which an
        // exit-code-only test reads as success. Signal first, then the code.
        const failure = obabelSearchFailure(result);
        if (failure) {
          throw new Error(`${failure} See ${task.outputName || OBABEL_SEARCH_LOG} in the queue folder.`);
        }
        if (!result.ensembleText) {
          throw new Error('Open Babel returned no scored conformers; see obabel.log in the queue folder for the reason.');
        }
        ensembleText = result.ensembleText;
        energies = result.energies;
        source = 'obabel';
        origin = {
          program: 'Open Babel',
          version: result.version || '',
          method: obabelForceFieldKeyword(conf.method) || obabelForceFieldKeyword(conf.ff) || 'MMFF94',
          // The digest identifies the starting geometry this search consumed,
          // not the conformers it produced: a re-run from the same input is
          // reproducible, a re-run from a different one is visibly different.
          sourceSha256: await sha256File(path.join(dir, CONFORMER_STAGED_INPUT)).catch(() => ''),
        };
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: obabelSearchSummary({
            version: result.version,
            ff: conf.method,
            nconf: conf.nconf ?? 0,
            log: result.log,
          }),
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
          // Issue 177: the same wall-clock limit the calculation tasks get.
          timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
          onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
        }).finally(() => {
          if (this.conformersRunner === runner) this.conformersRunner = null;
        });
        if (result.timedOut) {
          // A killed search left a partial ensemble; it is not a result.
          const startedAt = Date.parse(task.startedAt || '') || Date.now();
          const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 100) / 10);
          task.status = 'timed out';
          task.timeout = {
            limitSeconds: this.taskTimeoutSeconds(queue, task),
            elapsedSeconds,
            lastOutput: lastLineOf(result.outputText),
          };
          task.error = `Stopped after ${elapsedSeconds.toFixed(1)} s: the ${task.timeout.limitSeconds} s wall-clock limit was reached; the search output was not used.`;
          task.finishedAt = new Date().toISOString();
          this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Timed out: ${task.error}\n` });
          await this.persist(queue);
          this.publish(queue);
          return;
        }
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
      // ADR 0001 §2.10: rank a searched or imported ensemble by a scorer when
      // the block asks for one. Domain guard first, by name; then the sidecar;
      // then the explicit eV conversions, never silently mixed with MMFF94.
      if (conf.rankBy) {
        const domain = scorerDomainFindings({
          spec: conf.rankBy,
          atoms: merged.frames[0]?.atoms || [],
          charge: conf.charge,
          multiplicity: conf.multiplicity,
        });
        if (domain.errors.length > 0) throw new Error(domain.errors.join(' '));
        scorerWarnings.push(...domain.warnings);
        const model = scorerModel(conf.rankBy);
        const framesWithIds = merged.frames.map((frame, index) => ({ ...frame, id: `c${index + 1}` }));
        const raw = await new ScorerRunner().score({
          executable: queue.options.scorerExecutable,
          model: model.id,
          charge: conf.charge,
          multiplicity: conf.multiplicity,
          frames: framesWithIds,
          cwd: dir,
          timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
          onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
        });
        const scored = normalizeScorerResult(raw, {
          spec: conf.rankBy,
          frameIds: framesWithIds.map((frame) => frame.id),
        });
        if (scored.error) throw new Error(scored.error);
        merged.frames = framesForScorerRanking(framesWithIds, scored);
        energyUnit = 'hartree';
        energyMethod = scored.provenance.label;
        origin = {
          program: scored.provenance.label,
          version: scored.provenance.version,
          method: `ML potential · ${scored.provenance.dtype} · ${scored.provenance.device}`,
          sourceSha256: origin?.sourceSha256 || '',
        };
        scorerProvenance = {
          ...scored.provenance,
          charge: conf.charge,
          multiplicity: conf.multiplicity,
        };
      }
      const ranked = rankEnsemble({
        frames: merged.frames,
        energyWindowKcal: conf.energyWindowKcal,
        rmsdThreshold: conf.rmsdThreshold,
        maxConformers: conf.maxConformers,
        temperature: conf.temperature,
        spreadThresholdKcal: conf.spreadThresholdKcal,
        selectedConformerId: conf.selectedConformerId,
        energyUnit,
        energyMethod,
      });
      if (ranked.error) throw new Error(ranked.error);

      // Issue #129: a generated ensemble names what ran here (crest, the
      // in-app UFF search, or the labelled dry-run fixture); an imported one
      // keeps only what was declared.
      const recordedOrigin = origin || {
        program: source,
        version: '',
        method: conf.method || '',
        sourceSha256: '',
      };
      const summary = ensembleSummary(ranked, {
        generator: source,
        // Issue 144: a UFF or Open Babel search has no xTB Hamiltonian. Its
        // force field is recorded in `energyMethod` and `origin.method`; the
        // summary's `method` key stays reserved for the search Hamiltonian, so
        // it is empty on those routes. Issue #240 made the *block's* `method`
        // the force field, but this field is the ensemble's, not the block's.
        method: scorerProvenance
          ? scorerProvenance.label
          : (conf.source === 'imported'
            ? (origin?.method || energyMethod || '')
            : (conf.generator === 'uff' || conf.generator === 'obabel' ? '' : conf.method)),
        origin: recordedOrigin,
        energyUnit,
        energyMethod,
        // Issue #132: the study id travels with the ensemble, so a reader of
        // conformers.json alone can see the block belongs with others.
        group: conf.group,
        // Issue 144: absent for every other route, so their summary is
        // unchanged. Carries the grid, the dedupe threshold and the trials.
        search,
        ...(scorerProvenance ? { scorer: scorerProvenance } : {}),
      });
      if (scorerWarnings.length > 0) {
        summary.warnings = [
          ...summary.warnings,
          ...scorerWarnings.map((message) => ({ id: 'scorer-domain', status: 'warn', message })),
        ];
      }
      if (search && searchWarnings.length > 0) {
        summary.warnings = [
          ...summary.warnings,
          ...searchWarnings.map(({ id, status, message }) => ({ id, status, message })),
        ];
      }
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
   * Issue #226 — enumerate tautomers through the external RDKit sidecar.
   *
   * This is deliberately not a variant of the conformer search:
   *
   *   - the sidecar is required. A dry run refuses instead of writing a
   *     three-member "fixture tautomer set", because a fabricated tautomer is a
   *     fabricated molecule, not a fabricated number;
   *   - zero candidates, a protocol mismatch and a crashed sidecar are all
   *     refusals. The input geometry is never substituted for the set: that
   *     would report "one tautomer" for a structure whose enumeration failed;
   *   - the summary carries no energies and no populations, and the raw
   *     sidecar answer is kept in the task folder as `tautomers.json`.
   */
  async runTautomerEnumeration(queue, task, conf, dir) {
    try {
      const inputPath = this.conformerInputPath(queue.id, task.nodeId);
      const inputText = await fsp.readFile(inputPath, 'utf8');
      const parsedInput = parseMultiXyz(inputText);
      if (parsedInput.errors.length > 0 || parsedInput.frames.length === 0) {
        throw new TautomerEnumerationError(
          'bad-geometry',
          `The starting geometry could not be read: ${parsedInput.errors[0]?.message || 'no frames'}`,
        );
      }
      const atoms = parsedInput.frames[0].atoms;
      if (queue.options.dryRun) {
        throw new TautomerEnumerationError(
          'tautomer-dry-run',
          'A dry run cannot enumerate tautomers: the RDKit sidecar is an external program and a dry run never '
          + 'fabricates molecules. Configure the tautomer sidecar and run for real, or point the block at data '
          + 'that already exists.',
        );
      }
      const executable = String(queue.options.tautomerExecutable || '').trim();
      if (!executable) {
        throw new TautomerEnumerationError(
          'tautomer-sidecar-missing',
          'No tautomer sidecar is configured. Tautomer enumeration needs RDKit (scripts/tautomer-enumerator.py); '
          + 'there is no in-app fallback, so the block refuses instead of guessing.',
        );
      }

      const options = {
        ruleset: conf.tautomerRuleset || DEFAULT_TAUTOMER_OPTIONS.ruleset,
        maxCandidates: conf.maxConformers,
        maxTransforms: DEFAULT_TAUTOMER_OPTIONS.maxTransforms,
        relaxGeometry: true,
        removeSp3Stereo: false,
        removeBondStereo: false,
      };
      const request = tautomerRequest({
        title: task.title,
        charge: conf.charge,
        multiplicity: conf.multiplicity,
        atoms,
        options,
      });
      // The request is part of the run folder: it names every option that
      // decided the set, so the enumeration can be repeated byte for byte.
      await fsp.writeFile(path.join(dir, 'request.json'), JSON.stringify(request, null, 2) + '\n', 'utf8');

      const runner = new TautomerRunner();
      this.conformersRunner = runner;
      const raw = await runner.enumerate({
        executable,
        script: queue.options.tautomerScript || '',
        request,
        cwd: dir,
        timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
        onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
      }).finally(() => {
        if (this.conformersRunner === runner) this.conformersRunner = null;
      });
      // Keep the answer before validating it: a refusal is evidence too.
      const answerName = task.outputName || 'tautomers.json';
      await fsp.writeFile(path.join(dir, answerName), JSON.stringify(raw, null, 2) + '\n', 'utf8');

      const result = normalizeTautomerResponse(raw, { maxCandidates: options.maxCandidates });
      const sourceSha256 = await sha256File(inputPath).catch(() => '');
      const summary = tautomerSummary({
        result,
        group: conf.group,
        selectedId: conf.selectedConformerId,
        sourceSha256,
      });
      summary.generatedAt = new Date().toISOString();
      // One XYZ frame per candidate, in the summary's order. The ensemble file
      // is what a reader opens when they want the geometries without the JSON;
      // the comment labels each frame with its tautomer id.
      const frames = result.candidates.map((candidate) => xyzText(
        candidate.atoms,
        `tautomer=${candidate.label} ${candidate.smiles} · charge ${conf.charge} · multiplicity ${conf.multiplicity}`,
      ));
      await fsp.writeFile(path.join(dir, 'tautomers.xyz'), frames.join(''), 'utf8');
      await writeJsonAtomic(path.join(dir, 'conformers.json'), summary);

      task.status = 'completed';
      task.ensemble = summary;
      task.ensembleFile = 'conformers.json';
      task.runDir = dir;
      task.finishedAt = new Date().toISOString();
      task.refusal = null;
      task.summary = `${summary.count} tautomer candidate${summary.count === 1 ? '' : 's'} enumerated`
        + ` (${summary.origin.program || 'RDKit'} ${summary.origin.version || 'version not reported'}, ${summary.origin.ruleset})`
        + (summary.truncated ? '; candidate cap reached' : '');
      this.emit({
        type: 'queue-output',
        queueId: queue.id,
        nodeId: task.nodeId,
        text: `${summary.count} tautomer candidate(s): ${summary.tautomers.join(', ')}. `
          + 'Distinct molecules, not conformers: no energies and no populations are assigned here; '
          + 'each candidate fans out into its own calculation.',
      });
    } catch (error) {
      task.status = 'failed';
      task.error = oneLine(error?.message || String(error), 400);
      task.finishedAt = new Date().toISOString();
      if (error instanceof TautomerEnumerationError) {
        task.refusal = { code: error.code, message: task.error };
      } else {
        // A crash, a timeout or an unreadable input is a refusal too — the block
        // produced no candidates, and the run record must say so rather than
        // leave `refusal: null` to be read as "fine, nothing to report".
        task.refusal = {
          code: String(error?.code || 'tautomer-failed').slice(0, 40),
          message: task.error,
        };
      }
      this.emit({
        type: 'queue-output',
        queueId: queue.id,
        nodeId: task.nodeId,
        text: `Tautomer enumeration refused: ${task.error}`,
      });
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
    // Issue #226: a tautomer branch is still one member of one ensemble; the
    // task says which kind of set that was.
    const tautomerMember = task.generate?.produces === 'tautomers' || member.produces === 'tautomers';
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
      // Issue #226: a tautomer branch repeats what the member is, so the branch
      // folder does not read as a one-member conformer ensemble.
      ...(tautomerMember ? { produces: 'tautomers' } : {}),
      method: String(member.method || ''),
      ...memberEnergy,
      origin: memberOrigin,
      mixedEnergies: false,
      // Issue #132: the fanned-out branch repeats its parent's study id, so the
      // one-member summary in a branch folder does not lose the relationship.
      group: isConformerGroupId(String(task.generate?.group ?? ''))
        ? String(task.generate.group) : '',
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
        ...(tautomerMember
          ? { tautomer: String(member.tautomer || ''), smiles: String(member.smiles || '') }
          : {}),
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
        ...(tautomerMember
          ? { tautomer: String(member.tautomer || ''), smiles: String(member.smiles || '') }
          : {}),
        atoms,
      },
    };
    if (tautomerMember) {
      summary.tautomers = member.tautomer ? [member.tautomer] : [];
      summary.truncated = false;
    }
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
      ...(tautomerMember
        ? { produces: 'tautomers', tautomer: String(member.tautomer || ''), smiles: String(member.smiles || '') }
        : {}),
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

  /**
   * The dataset a task's record came from (issue 193).
   *
   * A calculation task names the record it runs (`recordId`) but not the
   * dataset: the plan puts the dataset on the input block that produced the
   * record, and lists every record id it handed out. The lookup is by record id
   * over those blocks — a copy of what the plan declared, never a guess from the
   * task id. A record no input block names keeps no datasetId.
   */
  recordDatasetIdFor(queue, task) {
    const recordId = task?.recordId;
    if (!recordId) return null;
    if (task.input?.datasetId) return task.input.datasetId;
    for (const entry of queue.tasks) {
      const input = entry.input;
      if (!input?.datasetId || !Array.isArray(input.records)) continue;
      if (input.records.some((record) => record.id === recordId)) return input.datasetId;
    }
    return null;
  }

  /**
   * The wall-clock limit one task gets (issue 177).
   *
   * Precedence is the block's own value, then the queue's (which the project's
   * runner setting filled in), then the generous default. Never "no limit":
   * an unbounded task is the failure this exists to stop.
   */
  taskTimeoutSeconds(queue, task) {
    return timeoutSecondsFrom(task?.timeoutSeconds)
      ?? timeoutSecondsFrom(queue?.timeoutSeconds)
      ?? DEFAULT_TIMEOUT_SECONDS;
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
    task.timeout = null;
    task.runId = null;
    task.runDir = null;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);

    try {
      let inputText = await fsp.readFile(this.inputPath(queue.id, task.nodeId), 'utf8');
      // ADR 0001 §2.9: a calculate block downstream of prepare runs on the
      // prepared structure, read from the prepare task's own run folder.
      if (task.prepareFrom) {
        const prepareTask = queue.tasks.find((entry) => entry.nodeId === task.prepareFrom.nodeId);
        if (!prepareTask || prepareTask.status !== 'completed' || !prepareTask.runDir) {
          task.status = 'failed';
          task.error = `Prepare source "${prepareTask?.title || task.prepareFrom.nodeId}" has not produced a structure.`;
          task.finishedAt = new Date().toISOString();
          await this.persist(queue);
          this.publish(queue);
          return;
        }
        const preparedText = await fsp.readFile(path.join(prepareTask.runDir, 'prepared.xyz'), 'utf8');
        const prepared = parseMultiXyz(preparedText);
        if (prepared.errors.length > 0 || prepared.frames.length !== 1) {
          task.status = 'failed';
          task.error = `Prepare source "${prepareTask.title || prepareTask.nodeId}" did not write one readable structure.`;
          task.finishedAt = new Date().toISOString();
          await this.persist(queue);
          this.publish(queue);
          return;
        }
        inputText = applyGeometryHandoffFor(task.engine, inputText, prepared.frames[0].atoms);
        task.geometryHandoff = {
          from: prepareTask.nodeId,
          fromEngine: 'prepare',
          toEngine: task.engine,
          atoms: prepared.frames[0].atoms.length,
        };
      }
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
        if (task.engine === 'gaussian' || task.engine === 'pyscf') {
          inputText = applyGeometryHandoffFor(task.engine, inputText, atoms);
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
      // Issue 193: the dataset this record came from, read from the input block
      // that handed the record out. Null when no input block names it.
      const datasetId = this.recordDatasetIdFor(queue, task);
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
        // Issue 177: this task's wall-clock limit — the block's own when it
        // declared one, otherwise the queue's. The run manager stops the
        // process tree and records `timed out` with the limit and elapsed.
        timeoutSeconds: this.taskTimeoutSeconds(queue, task),
        gates: task.gates,
        validity,
        checkpointHandoff,
        // Issue #30: the conformer this run is built on travels into run.json,
        // so a result can never be read as if it came from the imported geometry.
        ...(task.conformer ? { conformer: task.conformer } : {}),
        // Issue 193: which record this task ran, and the series unit it came
        // from. Copied from the task and its input block; a single-structure
        // block sends neither, so its run.json gains neither key.
        ...(task.record ? {
          record: {
            id: task.record.id,
            label: task.record.label || task.record.id,
            ...(datasetId ? { datasetId } : {}),
          },
        } : {}),
        ...(task.series ? { series: task.series } : {}),
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
      const timedOut = record.status === 'timed out';
      task.gateVerdict = record.gates?.overall || null;
      // A timed-out run produced no result, so it carries no condition fields:
      // a downstream condition must block on "no parsed result", not read a
      // wall of `false` as a verdict the engine never gave.
      task.summary = timedOut ? null : conditionFields(record.parsed, record.gates);
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
          // Issue 177: its own state. Folding it into `failed` would report the
          // engine as having refused the calculation, with exit code 143.
          : record.status === 'timed out' ? 'timed out'
            : record.status === 'cancelled' ? 'cancelled' : 'failed';
      task.error = record.error || null;
      // The limit, the elapsed seconds and the last output line travel onto the
      // task so the queue row can say them without re-reading the record.
      task.timeout = record.timeout && typeof record.timeout === 'object'
        ? {
          limitSeconds: Number(record.timeout.limitSeconds) || null,
          elapsedSeconds: Number.isFinite(Number(record.timeout.elapsedSeconds))
            ? Number(record.timeout.elapsedSeconds) : null,
          lastOutput: record.timeout.lastOutput || null,
        }
        : null;
      if (timedOut) {
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: `Timed out: ${task.error}\n`,
        });
      }
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
    const collects = (entry) => entry && (entry.type === 'calculate' || entry.type === 'generate');
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
    // RFC 0001: an input block is a declaration, not work. An ensemble input
    // is the exception ADR 0001 introduces: it materialises the external file
    // once, so the generate block downstream ranks a record instead of a path.
    if (task.type === 'input' && task.input?.kind === 'ensemble') {
      await this.runEnsembleInput(queue, task);
      return;
    }
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
    if (task.type === 'analyse') {
      // Issue 175: arithmetic over the results of the blocks wired into this one.
      await this.runAnalyse(queue, task);
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

  /**
   * ADR 0001 §2.10: a calculate block with a scorer provider.
   *
   * The block stays `calculate`; it does not spawn the engine. One structure is
   * scored, the run record carries the model's provenance and the explicit eV
   * conversions, and no gate is invented — a scorer has no termination record.
   */
  async runScorerPoint(queue, task) {
    const dir = path.join(this.queueDir(queue.id), 'scorer', task.nodeId);
    await fsp.mkdir(dir, { recursive: true });
    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.runDir = dir;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);
    try {
      const domain = scorerDomainFindings({
        spec: task.scorer.spec,
        atoms: task.scorer.atoms,
        charge: task.scorer.charge,
        multiplicity: task.scorer.multiplicity,
      });
      if (domain.errors.length > 0) throw new Error(domain.errors.join(' '));
      const model = scorerModel(task.scorer.spec);
      const raw = await new ScorerRunner().score({
        executable: queue.options.scorerExecutable,
        model: model.id,
        charge: task.scorer.charge,
        multiplicity: task.scorer.multiplicity,
        frames: [{ id: 'point', atoms: task.scorer.atoms }],
        cwd: dir,
        timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
        onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
      });
      const scored = normalizeScorerResult(raw, { spec: task.scorer.spec, frameIds: ['point'] });
      if (scored.error) throw new Error(scored.error);
      const point = scored.results[0];
      const inputName = 'point.xyz';
      const inputText = xyzText(task.scorer.atoms, `${task.title} · scorer`);
      await fsp.writeFile(path.join(dir, inputName), inputText, 'utf8');
      await writeJsonAtomic(path.join(dir, 'scorer.json'), {
        ...scored.provenance,
        energyEv: point.energyEv,
        energyKcal: point.energyKcal,
        energyHartree: point.energyHartree,
      });
      const runId = `scorer-${String(task.nodeId).replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now().toString(36)}`;
      const startedAt = task.startedAt;
      const finishedAt = new Date().toISOString();
      const parsed = {
        finalEnergy: { hartree: point.energyHartree },
        scf: { energyHartree: point.energyHartree },
        energyEv: point.energyEv,
        energyKcal: point.energyKcal,
        energyKind: scored.provenance.energyKind,
        comparableWithQuantumChemistry: false,
      };
      const record = {
        schemaVersion: 1,
        id: runId,
        status: 'completed',
        engine: model.id,
        argv: ['--model', model.id],
        dryRun: false,
        title: task.title,
        inputName,
        outputName: 'scorer.json',
        outputFile: null,
        outputSource: null,
        truncated: false,
        outputBytes: null,
        executable: queue.options.scorerExecutable || null,
        scratchDir: null,
        checkpointHandoff: null,
        inputSha256: await sha256File(path.join(dir, inputName)).catch(() => ''),
        outputSha256: await sha256File(path.join(dir, 'scorer.json')).catch(() => ''),
        provenance: {
          kind: 'scorer',
          jobType: 'SP',
          method: { scorer: model.id, label: model.label, version: scored.provenance.version },
          input: { name: inputName, bytes: Buffer.byteLength(inputText, 'utf8') },
          output: null,
        },
        startedAt,
        finishedAt,
        exitCode: 0,
        parsed,
        gates: null,
        scorer: scored.provenance,
        error: null,
      };
      await writeJsonAtomic(path.join(dir, 'run.json'), record);
      task.runId = runId;
      task.parsedSummary = parsed;
      task.scorerResult = scored.provenance;
      task.gateVerdict = null;
      task.status = 'completed';
      task.finishedAt = finishedAt;
      task.summary = `${model.label} single point · ${point.energyHartree.toFixed(8)} Ha`
        + ` (${point.energyEv.toFixed(4)} eV, ML — not QM)`;
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: task.summary });
    } catch (error) {
      task.status = 'failed';
      task.error = oneLine(error?.message || String(error), 400);
      task.finishedAt = new Date().toISOString();
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Scorer failed: ${task.error}` });
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /**
   * ADR 0001 §2.9: prepare one structure.
   *
   * `embed3d` runs the Open Babel converter; `relax` minimises with the in-app
   * UFF engine or asks Open Babel for an MMFF94 relaxation. Either way the block
   * writes `prepared.xyz` and a `prepare.json` record, and a downstream
   * calculate reads that geometry — never the structure it was planned with.
   */
  async runPrepare(queue, task) {
    const dir = path.join(this.queueDir(queue.id), 'prepare', task.nodeId);
    await fsp.mkdir(dir, { recursive: true });
    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    task.runDir = dir;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);
    try {
      const conf = task.prepare || {};
      const inputText = await fsp.readFile(this.conformerInputPath(queue.id, task.nodeId), 'utf8');
      const parsed = parseMultiXyz(inputText);
      if (parsed.errors.length > 0 || parsed.frames.length !== 1) {
        throw new Error(parsed.errors[0]?.message || 'The prepare input must be one structure.');
      }
      let atoms = parsed.frames[0].atoms;
      let summary;
      if (queue.options.dryRun && conf.converter !== 'uff') {
        // A dry run spawns nothing — the queue records no binaries for it — so a
        // prepare block must not spawn either. It used to call Open Babel anyway
        // and fail with "No Open Babel executable is configured", which made
        // `--dry-run` unusable on exactly the projects it exists to check.
        summary = {
          kind: conf.kind,
          converter: conf.converter,
          forceField: conf.forceField || '',
          energyKcal: null,
          converged: null,
          reason: 'dry-run (converter not run)',
          iterations: 0,
          atomCount: atoms.length,
        };
        this.emit({
          type: 'queue-output',
          queueId: queue.id,
          nodeId: task.nodeId,
          text: 'Dry run: geometry carried forward unchanged; no converter was run.',
        });
      } else if (conf.kind === 'embed3d') {
        const outName = 'prepared.xyz';
        const result = await new ObabelRunner().convert({
          executable: queue.options.obabelExecutable,
          argv: ['-:' + String(conf.smiles || ''), '-O', outName, '--gen3d'],
          cwd: dir,
          outputName: 'obabel.log',
          timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
          onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
        });
        if (result.timedOut || result.cancelled) throw new Error('The Open Babel 3D embedding was stopped.');
        if (Number(result.exitCode) !== 0) throw new Error(`Open Babel exited with code ${result.exitCode}; see obabel.log.`);
        const prepared = parseMultiXyz(await fsp.readFile(path.join(dir, outName), 'utf8'));
        if (prepared.errors.length > 0 || prepared.frames.length !== 1) {
          throw new Error('Open Babel wrote no readable 3D structure.');
        }
        atoms = prepared.frames[0].atoms;
        summary = {
          kind: 'embed3d',
          converter: 'openbabel',
          forceField: 'MMFF94',
          energyKcal: null,
          converged: true,
          reason: 'converter-completed',
          iterations: 0,
          atomCount: atoms.length,
          origin: { program: 'Open Babel', version: result.version || '', method: '--gen3d' },
        };
      } else if (conf.converter === 'aimnet2') {
        // ADR 0001 §2.10: relax one structure with a scorer's forces. The
        // domain guard runs once here, before the first spawn; each evaluation
        // carries the same provenance back.
        const spec = `ml:${String(conf.forceField || 'AIMNet2').toLowerCase() === 'aimnet2' ? 'aimnet2' : String(conf.forceField || '').toLowerCase()}`;
        const domain = scorerDomainFindings({
          spec, atoms, charge: conf.charge, multiplicity: conf.multiplicity,
        });
        if (domain.errors.length > 0) throw new Error(domain.errors.join(' '));
        const relaxed = await relaxWithForces({
          atoms,
          charge: conf.charge,
          multiplicity: conf.multiplicity,
          evaluate: async (trialAtoms) => {
            const raw = await new ScorerRunner().score({
              executable: queue.options.scorerExecutable,
              model: 'aimnet2',
              charge: conf.charge,
              multiplicity: conf.multiplicity,
              frames: [{ id: 'point', atoms: trialAtoms }],
              cwd: dir,
              timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
              onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
            });
            const scored = normalizeScorerResult(raw, { spec, frameIds: ['point'] });
            if (scored.error) throw new Error(scored.error);
            return {
              energyEv: scored.results[0].energyEv,
              forces: scored.results[0].forces,
              provenance: scored.provenance,
            };
          },
          onProgress: ({ iteration }) => this.emit({
            type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `ML relax · step ${iteration}`,
          }),
        });
        if (relaxed.error) throw new Error(relaxed.error);
        atoms = relaxed.atoms;
        summary = {
          kind: 'relax',
          converter: 'aimnet2',
          forceField: 'AIMNet2',
          energyKcal: relaxed.energyKcal,
          converged: relaxed.converged,
          reason: relaxed.reason || '',
          iterations: relaxed.iterations,
          atomCount: atoms.length,
          origin: {
            program: relaxed.provenance?.label || 'AIMNet2',
            version: relaxed.provenance?.version || '',
            method: 'ML potential · forces + L-BFGS',
          },
          ...(relaxed.provenance ? { scorer: relaxed.provenance } : {}),
        };
      } else if (conf.converter === 'openbabel') {
        const outName = 'prepared.xyz';
        // Open Babel reads a file in its own working directory; the staged task
        // input lives under queue/inputs, so it is copied beside the run.
        await fsp.writeFile(path.join(dir, 'input.xyz'), inputText, 'utf8');
        const result = await new ObabelRunner().convert({
          executable: queue.options.obabelExecutable,
          argv: ['input.xyz', '-O', outName, '--minimize', '--ff', conf.forceField === 'UFF' ? 'UFF' : 'MMFF94', '--steps', '500'],
          cwd: dir,
          outputName: 'obabel.log',
          timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
          onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
        });
        if (result.timedOut || result.cancelled) throw new Error('The Open Babel relaxation was stopped.');
        if (Number(result.exitCode) !== 0) throw new Error(`Open Babel exited with code ${result.exitCode}; see obabel.log.`);
        const prepared = parseMultiXyz(await fsp.readFile(path.join(dir, outName), 'utf8'));
        if (prepared.errors.length > 0 || prepared.frames.length !== 1) {
          throw new Error('Open Babel wrote no readable relaxed structure.');
        }
        atoms = prepared.frames[0].atoms;
        summary = {
          kind: 'relax',
          converter: 'openbabel',
          forceField: conf.forceField === 'UFF' ? 'UFF' : 'MMFF94',
          energyKcal: null,
          converged: false,
          reason: 'converter-did-not-report-convergence',
          iterations: 500,
          atomCount: atoms.length,
          origin: { program: 'Open Babel', version: result.version || '', method: '--minimize' },
        };
      } else {
        const bonds = Array.isArray(conf.bonds) && conf.bonds.length > 0 ? conf.bonds : perceiveBonds(atoms);
        const relaxed = optimizeUff({ atoms, bonds }, { maxIterations: 500 });
        atoms = relaxed.atoms;
        summary = {
          kind: 'relax',
          converter: 'uff',
          forceField: 'UFF',
          energyKcal: relaxed.energyKcal,
          converged: relaxed.converged,
          reason: relaxed.reason || '',
          iterations: relaxed.iterations,
          atomCount: atoms.length,
          origin: { program: 'NodeChem Studio', version: '', method: 'UFF' },
        };
      }
      summary.generatedAt = new Date().toISOString();
      await fsp.writeFile(path.join(dir, 'prepared.xyz'), xyzText(atoms, `${task.title} · ${summary.kind}`), 'utf8');
      await writeJsonAtomic(path.join(dir, 'prepare.json'), summary);
      task.status = 'completed';
      task.prepared = summary;
      task.outputName = 'prepared.xyz';
      task.finishedAt = new Date().toISOString();
      task.summary = prepareSummaryLine(summary);
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Prepared structure: ${task.summary}.` });
    } catch (error) {
      task.status = 'failed';
      task.error = oneLine(error?.message || String(error), 400);
      task.finishedAt = new Date().toISOString();
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Prepare failed: ${task.error}` });
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /**
   * ADR 0001: materialise an input(ensemble).
   *
   * The file is read once, hashed, and written to the input's own run folder as
   * `ensemble.xyz` + `ensemble.json` (metadata and the energy list, not a second
   * copy of the atoms). The generate block downstream reads that record; no
   * later block ever touches the original path, so a file edited mid-run cannot
   * change what the graph consumed.
   */
  async runEnsembleInput(queue, task) {
    const dir = path.join(this.queueDir(queue.id), 'ensemble', task.nodeId);
    await fsp.mkdir(dir, { recursive: true });
    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    task.runDir = dir;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);
    try {
      const declaredPath = String(task.input?.path || '');
      if (!declaredPath) throw new Error('The ensemble input names no file.');
      const ensemblePath = this.resolveImportPath(queue, declaredPath);
      const imported = await CrestRunner.readImport(ensemblePath);
      const parsed = parseMultiXyz(imported.ensembleText);
      if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
      const merged = withEnergies(parsed.frames, imported.energies);
      if (merged.error) throw new Error(merged.error);
      // Issue #129: the digest is of the bytes on disk. The input block owns
      // it now, so every downstream record can name the exact artifact.
      const sourceSha256 = await sha256File(ensemblePath).catch(() => '');
      const energyUnit = task.input?.energyUnit === 'kcal/mol' ? 'kcal/mol' : 'hartree';
      const summary = {
        kind: 'ensemble',
        path: ensemblePath,
        format: 'xyz',
        energyUnit,
        energyMethod: String(task.input?.energyMethod || ''),
        origin: {
          program: String(task.input?.origin?.program || ''),
          version: String(task.input?.origin?.version || ''),
          method: String(task.input?.origin?.method || ''),
          sourceSha256,
        },
        ...(sourceSha256 ? { sourceSha256 } : {}),
        frameCount: merged.frames.length,
      };
      await fsp.writeFile(path.join(dir, 'ensemble.xyz'), imported.ensembleText, 'utf8');
      await writeJsonAtomic(path.join(dir, 'ensemble.json'), {
        ...summary,
        // The raw numbers, in the input's declared unit. withEnergies() and
        // rankEnsemble() apply the unit together downstream; converting here
        // would make an MM energy look like a Hartree total.
        energies: merged.frames.map((frame) => frame.energyEh),
      });
      task.status = 'completed';
      task.ensemble = summary;
      task.ensembleFile = 'ensemble.json';
      task.finishedAt = new Date().toISOString();
      task.summary = `ensemble · ${summary.frameCount} frame${summary.frameCount === 1 ? '' : 's'}`
        + (sourceSha256 ? ` · sha256 ${sourceSha256.slice(0, 12)}…` : '');
      this.emit({
        type: 'queue-output',
        queueId: queue.id,
        nodeId: task.nodeId,
        text: `Ensemble input ${path.basename(ensemblePath)}: ${summary.frameCount} frame(s), ${energyUnit}`
          + `${summary.energyMethod ? `, ${summary.energyMethod}` : ''}`
          + (sourceSha256 ? `, sha256 ${sourceSha256.slice(0, 12)}…` : ''),
      });
    } catch (error) {
      task.status = 'failed';
      task.error = oneLine(error?.message || String(error), 400);
      task.finishedAt = new Date().toISOString();
      this.emit({
        type: 'queue-output',
        queueId: queue.id,
        nodeId: task.nodeId,
        text: `Ensemble input failed: ${task.error}`,
      });
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /**
   * One analyse block (issue 175): arithmetic over upstream results.
   *
   * The plan cannot know these numbers — they do not exist until the upstream
   * blocks have run — so the evaluation happens here, from the `run.json` of
   * every block wired into this one, and the same `evaluateCompute()` the plan
   * and the inspector use does the work. Nothing is re-derived here.
   *
   * A missing field is a refusal naming the field and the record, never a zero:
   * the block fails with that sentence. A block whose upstream has produced no
   * result at all is `blocked` (it is waiting, not wrong). A computed value is
   * written to its own `run.json` as `kind: 'derived'` — it carries no `parsed`
   * block, so no report column can present it as an engine result.
   */
  async runAnalyse(queue, task) {
    const analyse = task.analyse && typeof task.analyse === 'object' ? task.analyse : {};
    // Issue #270: a Multiwfn block is an analyse block that spawns the
    // user-installed sidecar, not an expression over fields.
    if (analyse.mode === 'multiwfn') {
      await this.runMultiwfn(queue, task);
      return;
    }
    // Issue 165: a DP4+ block is an analyse block with a definition instead of
    // an expression. It reads whole run records (candidates) rather than named
    // fields, so it has its own reader below but the same record contract.
    if (analyse.mode === 'dp4') {
      await this.runDp4(queue, task);
      return;
    }
    const declared = Array.isArray(analyse.declared) ? analyse.declared : [];
    if (declared.length === 0) {
      this.setTaskOutcome(task, 'failed', 'the analyse block declares no inputs to read');
      await this.persist(queue);
      this.publish(queue);
      this.announce(queue, task);
      return;
    }
    const recordId = task.recordId || null;
    const sources = this.incomingSources(queue, task.nodeId);
    // Group the upstream tasks by block, then read each one's run.json once.
    const byBlock = new Map();
    for (const source of sources) {
      const segments = String(source.nodeId).split('~');
      const blockId = segments[0];
      let run = null;
      if (source.runDir) {
        try {
          run = JSON.parse(await fsp.readFile(path.join(source.runDir, 'run.json'), 'utf8'));
        } catch {
          run = null; // an unreadable upstream record is "no result", not zero
        }
      }
      const rows = byBlock.get(blockId) || [];
      rows.push({ recordId: segments.length > 1 ? segments.slice(1).join('~') : null, run });
      byBlock.set(blockId, rows);
    }
    const resolveSource = (blockId, forRecord) => {
      const rows = (byBlock.get(blockId) || []).filter((row) => row.run);
      if (rows.length === 0) return null;
      const exact = forRecord ? rows.find((row) => row.recordId === forRecord) : null;
      const chosen = exact || rows[0];
      return { run: chosen.run, recordId: chosen.recordId || forRecord || null };
    };
    const allRecords = (blockId) => (byBlock.get(blockId) || []).filter((row) => row.run);

    let evaluation;
    try {
      evaluation = evaluateCompute({ expression: analyse.expression, inputs: declared }, {
        recordId,
        resolveSource,
        allRecords,
      });
    } catch (error) {
      if (!(error instanceof ComputeError)) throw error;
      task.analyse = { ...analyse, status: 'refused', value: null, notes: [error.message], notComputed: error.message };
      this.setTaskOutcome(task, 'failed', oneLine(error.message, 400));
      await this.persist(queue);
      this.publish(queue);
      this.announce(queue, task);
      return;
    }
    task.analyse = { ...analyse, ...evaluation };
    const dir = path.join(this.queueDir(queue.id), 'analyse', String(task.nodeId).replace(/[^A-Za-z0-9._-]/g, '_'));
    try {
      await fsp.mkdir(dir, { recursive: true });
      await writeJsonAtomic(path.join(dir, 'run.json'), {
        schemaVersion: 1,
        kind: 'derived',
        nodeId: task.nodeId,
        title: task.title,
        createdAt: new Date().toISOString(),
        provenance: { kind: 'derived', jobType: 'Analyse', method: {}, basis: null },
        // The whole point of the record: the expression, the numbers it read and
        // the refusal, if there was one. `parsed` stays absent — this is not a
        // calculation result.
        analyse: {
          expression: evaluation.expression,
          inputs: evaluation.inputs,
          value: evaluation.value,
          unit: evaluation.unit,
          functionCalls: evaluation.functionCalls,
          notes: evaluation.notes,
          notComputed: evaluation.notComputed,
          sources: analyse.sources || [],
          ...(recordId ? { recordId } : {}),
        },
      });
      task.runDir = dir;
      task.runId = task.nodeId;
    } catch (error) {
      task.analyse = { ...task.analyse, ...evaluation, notes: [...evaluation.notes, `the derived record could not be written: ${error.message}`] };
    }
    if (evaluation.status === 'computed') {
      this.setTaskOutcome(task, 'completed', oneLine(describeCompute(evaluation), 400));
    } else if (evaluation.status === 'pending') {
      this.setTaskOutcome(task, 'blocked', oneLine(evaluation.notComputed, 400));
    } else {
      this.setTaskOutcome(task, 'failed', oneLine(evaluation.notComputed, 400));
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /**
   * One Multiwfn analyse block (issue #270).
   *
   * The block resolves the wavefunction from an upstream run (or a
   * project-relative path), refuses by name when the file or the density matrix
   * is not there, runs the user-installed Multiwfn in `-silent` batch mode with
   * the pinned 3.8 menu script, normalises the text and writes its own
   * `run.json`. The record carries the Multiwfn version, the exact script and
   * the input SHA-256; a refusal is written down too, never left as `unknown`.
   */
  async runMultiwfn(queue, task) {
    const analyse = task.analyse && typeof task.analyse === 'object' ? task.analyse : {};
    const definition = analyse.multiwfn && typeof analyse.multiwfn === 'object' ? analyse.multiwfn : null;
    const analysis = definition ? multiwfnAnalysis(definition.analysis) : null;
    const dir = path.join(this.queueDir(queue.id), 'analyse', String(task.nodeId).replace(/[^A-Za-z0-9._-]/g, '_'));
    await fsp.mkdir(dir, { recursive: true });
    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    task.runDir = dir;
    task.runId = null;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);

    let script = null;
    let input = null;
    let version = '';
    const startedAt = task.startedAt;
    try {
      if (!definition || !analysis) {
        throw new Error(`"${task.title}" is a Multiwfn block without a supported analysis; `
          + 'save the project so the definition is validated before it is queued.');
      }
      if (queue.options.dryRun) {
        const error = new Error('dry run — Multiwfn was not run; the sidecar is user-installed and a dry run spawns nothing');
        error.code = 'multiwfn-dry-run';
        throw error;
      }
      const executable = String(queue.options.multiwfnExecutable || '').trim();
      if (!executable) {
        const error = new Error('No Multiwfn executable is configured. Multiwfn is user-installed and is not '
          + 'bundled; choose its binary in the run console before queuing this block.');
        error.code = 'multiwfn-binary';
        throw error;
      }
      version = await MultiwfnRunner.version(executable);
      const refusal = multiwfnVersionRefusal(version);
      if (refusal) {
        const error = new Error(refusal);
        error.code = 'multiwfn-version';
        throw error;
      }
      input = await this.resolveMultiwfnInput(queue, task, definition, analysis);
      // The runner's workdir is the task's own folder; stage the wavefunction
      // there so Multiwfn sees a local file and cannot write side files beside
      // the upstream run. The hash is still taken from the source bytes.
      const staged = path.join(dir, input.name);
      if (path.resolve(staged) !== path.resolve(input.path)) {
        await fsp.copyFile(input.path, staged);
      }
      script = multiwfnMenuScript(definition.analysis, definition);
      const runner = new MultiwfnRunner();
      this.multiwfnRunner = runner;
      const raw = await runner.run({
        executable,
        inputName: input.name,
        script,
        cwd: dir,
        // `maxParallel` is how many queue tasks run at once, not how many
        // threads one task may use. Multiwfn's own default is the honest
        // choice; pass a thread count only when the block declares one.
        threads: Number.isInteger(Number(task.settings?.nproc)) ? Number(task.settings.nproc) : null,
        timeoutMs: this.taskTimeoutSeconds(queue, task) * 1000,
        onOutput: ({ text }) => this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text }),
      });
      if (raw.cancelled) {
        const error = new Error('Multiwfn was cancelled by the user.');
        error.code = 'multiwfn-cancelled';
        throw error;
      }
      if (raw.timedOut) {
        const error = new Error(`Multiwfn did not finish within ${this.taskTimeoutSeconds(queue, task)} s and was stopped.`);
        error.code = 'multiwfn-timeout';
        throw error;
      }
      if (Number(raw.exitCode) !== 0) {
        const tail = String(raw.outputText || '').trim().split(/\r?\n/).slice(-3).join(' ');
        const error = new Error(`Multiwfn exited with code ${raw.exitCode}${raw.signal ? ` (signal ${raw.signal})` : ''}`
          + `${tail ? `: ${oneLine(tail, 240)}` : '.'}`);
        error.code = 'multiwfn-exit';
        throw error;
      }
      const result = parseMultiwfnOutput({
        analysis: definition.analysis,
        text: raw.outputText,
        files: raw.files,
        parameters: definition,
      });
      if (!result.ok) {
        const error = new Error(`Multiwfn produced no usable ${analysis.label} result: ${result.reason}`);
        error.code = 'multiwfn-output';
        throw error;
      }
      if (definition.analysis === 'qtaim' && input.format === 'fchk' && input.text) {
        try {
          const parsed = parseFchk(input.text);
          const inApp = qtaimAnalysis({ fchk: parsed, bondPath: false });
          if (inApp.ok) result.comparison = compareQtaimToApp(result, inApp);
        } catch (error) {
          result.comparison = {
            compared: 0,
            matched: 0,
            differences: [],
            withinTolerance: false,
            reason: `the in-app QTAIM comparison could not run: ${error.message}`,
          };
        }
      }
      const summary = multiwfnSummary(result);
      const record = {
        schemaVersion: 1,
        kind: 'multiwfn',
        id: task.nodeId,
        status: 'completed',
        title: task.title,
        createdAt: new Date().toISOString(),
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: Number(raw.exitCode),
        inputSha256: input.sha256,
        provenance: {
          kind: 'multiwfn',
          program: 'Multiwfn',
          version: raw.version || version,
          executable,
          citation: MULTIWFN_CITATION,
          licence: MULTIWFN_LICENCE,
          analysis: definition.analysis,
          parameters: { ...definition },
          menuVersion: script.version,
          menuScript: script.text,
          argv: raw.argv,
          input: {
            name: input.name,
            format: input.format,
            sha256: input.sha256,
            bytes: input.bytes,
            source: input.source,
          },
        },
        multiwfn: result,
        analyse: {
          mode: 'multiwfn',
          analysis: definition.analysis,
          input: definition.input,
          parameters: { ...definition },
          status: 'computed',
          summary,
          citation: MULTIWFN_CITATION,
          notComputed: null,
        },
      };
      await writeJsonAtomic(path.join(dir, 'run.json'), record);
      task.runId = task.nodeId;
      task.analyse = {
        ...analyse,
        mode: 'multiwfn',
        status: 'computed',
        summary,
        citation: MULTIWFN_CITATION,
        provenance: record.provenance,
        multiwfn: result,
        notComputed: null,
      };
      task.summary = oneLine(summary, 400);
      this.setTaskOutcome(task, 'completed', oneLine(summary, 400));
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: summary });
    } catch (error) {
      const message = oneLine(error?.message || String(error), 500) || 'Multiwfn failed without a message.';
      task.analyse = {
        ...analyse,
        mode: 'multiwfn',
        status: error?.code === 'multiwfn-dry-run' ? 'pending' : 'refused',
        summary: `Multiwfn — ${message}`,
        citation: MULTIWFN_CITATION,
        notComputed: message,
        ...(script ? { menuScript: script.text, menuVersion: script.version } : {}),
        ...(input ? { input: { ...definition?.input, resolved: input.name, sha256: input.sha256 } } : {}),
      };
      const record = {
        schemaVersion: 1,
        kind: 'multiwfn',
        id: task.nodeId,
        status: error?.code === 'multiwfn-dry-run' ? 'blocked' : 'failed',
        title: task.title,
        createdAt: new Date().toISOString(),
        startedAt,
        finishedAt: new Date().toISOString(),
        inputSha256: input?.sha256 || null,
        provenance: {
          kind: 'multiwfn',
          program: 'Multiwfn',
          version: version || null,
          executable: queue.options.multiwfnExecutable || null,
          citation: MULTIWFN_CITATION,
          licence: MULTIWFN_LICENCE,
          analysis: definition?.analysis || null,
          parameters: definition ? { ...definition } : null,
          menuVersion: script?.version || null,
          menuScript: script?.text || null,
          input: input
            ? { name: input.name, format: input.format, sha256: input.sha256, bytes: input.bytes, source: input.source }
            : null,
        },
        error: { code: error?.code || 'multiwfn', message },
        analyse: {
          mode: 'multiwfn',
          analysis: definition?.analysis || null,
          input: definition?.input || null,
          parameters: definition ? { ...definition } : null,
          status: error?.code === 'multiwfn-dry-run' ? 'pending' : 'refused',
          summary: `Multiwfn — ${message}`,
          citation: MULTIWFN_CITATION,
          notComputed: message,
        },
      };
      await writeJsonAtomic(path.join(dir, 'run.json'), record).catch(() => {});
      task.error = message;
      this.setTaskOutcome(task, error?.code === 'multiwfn-dry-run' ? 'blocked' : 'failed', message);
      this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, text: `Multiwfn refused: ${message}` });
    } finally {
      this.multiwfnRunner = null;
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /**
   * Resolve the wavefunction a Multiwfn task reads.
   *
   * `input.path` is resolved against the project folder and may not escape it;
   * `input.nodeId`/`input.runId` read an upstream task's run folder. The file
   * format is checked against the analysis before anything is spawned, and a
   * checkpoint without a density block is refused by name here rather than by
   * Multiwfn several steps into the menu.
   */
  async resolveMultiwfnInput(queue, task, definition, analysis) {
    const input = definition.input || {};
    let target = '';
    let source = {};
    if (input.path) {
      const root = queue.options.projectDir ? path.resolve(queue.options.projectDir) : '';
      if (!root) {
        const error = new Error(`Multiwfn input "${input.path}" is project-relative, but this queue was started `
          + 'without a project folder; start it from the project file or give an upstream block instead.');
        error.code = 'multiwfn-input';
        throw error;
      }
      target = resolveArtifactPath(root, input.path);
      source = { kind: 'path', path: input.path };
    } else {
      const sources = this.incomingSources(queue, task.nodeId);
      let chosen = null;
      if (input.runId) {
        chosen = sources.find((entry) => String(entry.runId || '') === String(input.runId))
          || sources.find((entry) => String(entry.nodeId || '') === String(input.runId))
          // A run id names one task in this queue; it need not be wired into
          // the block, because the run id is itself the reference. Prefer the
          // wired source above, then the queue's own task list.
          || (Array.isArray(queue.tasks) ? queue.tasks : []).find((entry) => entry !== task
            && (String(entry.runId || '') === String(input.runId)
              || String(entry.nodeId || '') === String(input.runId)))
          || null;
        if (!chosen) {
          const error = new Error(`Multiwfn input run "${input.runId}" is not a completed run in this queue `
            + `(upstream: ${sources.map((entry) => entry.runId || entry.nodeId).join(', ') || 'none'}).`);
          error.code = 'multiwfn-input';
          throw error;
        }
      } else if (input.nodeId) {
        const exact = task.recordId ? `${input.nodeId}~${task.recordId}` : input.nodeId;
        chosen = sources.find((entry) => entry.nodeId === exact)
          || sources.find((entry) => String(entry.nodeId || '').startsWith(`${input.nodeId}~`))
          || sources.find((entry) => entry.nodeId === input.nodeId)
          || null;
        if (!chosen) {
          const error = new Error(`Multiwfn input block "${input.nodeId}" has no run in this queue; `
            + `wire it in and let it finish (upstream: ${sources.map((entry) => entry.nodeId).join(', ') || 'none'}).`);
          error.code = 'multiwfn-input';
          throw error;
        }
      } else {
        chosen = sources[0] || null;
      }
      if (!chosen) {
        const error = new Error(`"${task.title}" has no upstream run to read a wavefunction from.`);
        error.code = 'multiwfn-input';
        throw error;
      }
      if (chosen.status !== 'completed' || !chosen.runDir) {
        const error = new Error(`Multiwfn input "${chosen.title || chosen.nodeId}" has no completed run folder `
          + `(status: ${chosen.status || 'unknown'}).`);
        error.code = 'multiwfn-input';
        throw error;
      }
      const preferred = analysis.inputs;
      let names = [];
      try {
        names = await fsp.readdir(chosen.runDir);
      } catch {
        names = [];
      }
      const candidates = names
        .filter((name) => preferred.includes((/\.([A-Za-z0-9]+)$/.exec(name) || [])[1]?.toLowerCase()))
        .sort((a, b) => {
          const rank = (name) => preferred.indexOf((/\.([A-Za-z0-9]+)$/.exec(name) || [])[1].toLowerCase());
          return rank(a) - rank(b) || a.localeCompare(b);
        });
      if (candidates.length === 0) {
        const error = new Error(`Multiwfn input: the run folder for "${chosen.title || chosen.nodeId}" carries no `
          + `${preferred.map((format) => `.${format}`).join(', ')} file. ${analysis.label} reads `
          + `${preferred.map((format) => `.${format}`).join(', ')}; attach or generate one before running this block.`);
        error.code = 'multiwfn-input';
        throw error;
      }
      target = path.join(chosen.runDir, candidates[0]);
      source = {
        kind: input.nodeId ? 'node' : 'run',
        nodeId: chosen.nodeId,
        runId: chosen.runId || null,
        runDir: chosen.runDir,
        file: candidates[0],
      };
    }
    const name = path.basename(target);
    const format = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1]?.toLowerCase() || '';
    if (!analysis.inputs.includes(format)) {
      const error = new Error(`Multiwfn ${analysis.label} cannot read "${name}": it reads `
        + `${analysis.inputs.map((entry) => `.${entry}`).join(', ')}.`);
      error.code = 'multiwfn-input';
      throw error;
    }
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      const error = new Error(`Multiwfn input "${name}" was not found or is empty.`);
      error.code = 'multiwfn-input';
      throw error;
    }
    let text = '';
    if (format === 'fchk') {
      text = await fsp.readFile(target, 'utf8');
      let parsed;
      try {
        parsed = parseFchk(text);
      } catch (error) {
        const refusal = new Error(`Multiwfn ${analysis.label} cannot read "${name}" as a formatted checkpoint: ${error.message}`);
        refusal.code = 'multiwfn-input';
        throw refusal;
      }
      const density = densityMatrix(parsed);
      if (!density.ok) {
        const refusal = new Error(`Multiwfn ${analysis.label} needs a density matrix, and "${name}" carries none `
          + `(${density.reason}).`);
        refusal.code = 'multiwfn-input';
        throw refusal;
      }
    }
    return {
      path: target,
      name,
      format,
      bytes: stat.size,
      sha256: await sha256File(target),
      source,
      text,
    };
  }

  /**
   * One DP4+ block (issue 165).
   *
   * The candidates are the run records of the blocks wired into this one: one
   * candidate per dataset record, one conformer per fanned-out member. Nothing
   * is re-derived here — `evaluateDp4()` does the same conversion the plan and
   * the inspector use, and `dp4Probabilities()` computes the probabilities from
   * the committed bank. The record is written as `kind: 'derived'` with the
   * whole DP4+ result under `dp4` (and no `parsed` block), so the card, the
   * report and `ncs export` read one place.
   *
   * A refusal is written down too: a project whose level the bank does not
   * carry, or whose candidate lacks a shielding block, produces a record that
   * names the reason rather than no record at all.
   */
  async runDp4(queue, task) {
    const analyse = task.analyse && typeof task.analyse === 'object' ? task.analyse : {};
    const sources = this.incomingSources(queue, task.nodeId);
    const rows = [];
    for (const source of sources) {
      const segments = String(source.nodeId).split('~');
      let run = null;
      if (source.runDir) {
        try {
          run = JSON.parse(await fsp.readFile(path.join(source.runDir, 'run.json'), 'utf8'));
        } catch {
          run = null; // an unreadable upstream record is "no result", not a zero
        }
      }
      rows.push({
        taskId: String(source.nodeId),
        source: segments[0],
        recordId: segments.length > 1 ? segments[1] : null,
        memberId: segments.length > 2 ? segments.slice(2).join('~') : null,
        run,
      });
    }
    const evaluation = evaluateDp4(analyse.dp4, { rows });
    const summary = dp4Summary(evaluation);
    task.dp4 = evaluation;
    // The task keeps the verdict and the refusal, not a second copy of the
    // table: `dp4` is the result, `analyse` is the block that produced it, and
    // a queue snapshot should not carry 27 nuclei twice.
    task.analyse = {
      ...analyse,
      status: evaluation.status,
      expression: evaluation.expression,
      available: evaluation.available,
      notes: evaluation.notes || [],
      notComputed: evaluation.notComputed,
      value: null,
      unit: null,
      summary,
    };

    const dir = path.join(this.queueDir(queue.id), 'analyse', String(task.nodeId).replace(/[^A-Za-z0-9._-]/g, '_'));
    try {
      await fsp.mkdir(dir, { recursive: true });
      await writeJsonAtomic(path.join(dir, 'run.json'), {
        schemaVersion: 1,
        kind: 'derived',
        nodeId: task.nodeId,
        title: task.title,
        createdAt: new Date().toISOString(),
        provenance: {
          kind: 'derived',
          jobType: 'DP4+',
          method: {
            ...(evaluation.level?.method ? { functional: evaluation.level.method } : {}),
            ...(evaluation.level?.basis ? { basis: evaluation.level.basis } : {}),
            ...(evaluation.level?.solvation ? { solvation: evaluation.level.solvation } : {}),
          },
          basis: evaluation.level?.basis ?? null,
        },
        // The block's own declaration: which mode, which variant, which level,
        // which measured shifts, and the one-line verdict or refusal. A reader
        // of the record can see the experiment without opening the project.
        analyse: {
          mode: 'dp4',
          expression: evaluation.expression,
          inputs: (evaluation.candidates || []).map((candidate) => ({
            recordId: candidate.id,
            field: 'parsed.nmr.atoms',
            value: Array.isArray(candidate.nuclei) ? candidate.nuclei.length : null,
            unit: 'nuclei',
          })),
          value: null,
          unit: null,
          functionCalls: [],
          notes: evaluation.notes || [],
          notComputed: evaluation.notComputed,
          sources: analyse.sources || [],
          ...(task.recordId ? { recordId: task.recordId } : {}),
        },
        // The whole result: probabilities, per-nucleus deviations, the fit each
        // nucleus used, the excluded candidates and the bank's provenance. This
        // is the block the card and the report already render.
        dp4: evaluation,
      });
      task.runDir = dir;
      task.runId = task.nodeId;
    } catch (error) {
      task.analyse = { ...task.analyse, notes: [...(evaluation.notes || []), `the DP4+ record could not be written: ${error.message}`] };
    }
    if (evaluation.status === 'computed') {
      this.setTaskOutcome(task, 'completed', oneLine(summary, 400));
    } else if (evaluation.status === 'pending') {
      this.setTaskOutcome(task, 'blocked', oneLine(summary, 400));
    } else {
      this.setTaskOutcome(task, 'failed', oneLine(summary, 400));
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
      if (!['completed', 'failed', 'needs-review', 'blocked', 'skipped', 'interrupted', 'timed out'].includes(task.status)) continue;
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
      task.timeout = null;
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
      if (task.status === 'running' && task.type === 'generate') {
        this.conformersRunner?.cancel();
      }
      if (task.status === 'running' && task.type === 'analyse' && task.analyse?.mode === 'multiwfn') {
        this.multiwfnRunner?.cancel();
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
