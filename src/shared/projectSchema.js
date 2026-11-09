/**
 * Project file schema for NodeChem Studio.
 *
 * Pure module: no DOM, no filesystem, no Electron. Used by the main process
 * before a project is rendered, and by the renderer when it saves.
 *
 * Contract:
 *   - `schemaVersion: 3` is the current on-disk format: ADR 0001's six data
 *     stages (`input`, `prepare`, `generate`, `calculate`, `analyse`,
 *     `output`) plus the control and annotation axes. A project carries
 *     `flows[]` (one graph each) and `datasets[]` (record sets an `input` block
 *     iterates).
 *   - Version 3 is a breaking vocabulary change with no compatibility layer
 *     (ADR 0001): a project written by an earlier build is refused by version,
 *     never guessed at or half-read.
 *   - A project from a newer build is rejected, never guessed at.
 *   - Validation collects every error with a JSON path; it does not throw.
 *   - The normalized project is canonical: the same input always yields the
 *     same key order, so a save/reopen round-trip is byte-stable.
 */

export const SCHEMA_VERSION = 3;

import { isElementSymbol } from './elements.js';
import {
  DEFAULT_FLOW_ID,
  DERIVATIVE_MAX_EDITS,
  DERIVATIVE_OPS,
  GRAPH_ID_RE,
  RECORD_ID_RE,
  attachGraphAliases,
  edgesOfFlow,
  enabledRecords,
  flowsOf,
  isPlainObject as isPlainObjectValue,
  nodesOfFlow,
  recordsForInput,
} from './flows.js';
import { MODERN_ROUTE_PRESET, COMPOSITE_JOB_TYPES, COUNTERPOISE_MAX_FRAGMENTS, clearCompositeConflicts, defaultDispersionFor, isCompositeJobType } from './routePresets.js';
import { COMPLEX_MAX_MEMBERS, COMPLEX_PLACEMENT_MODES } from './complex.js';
import { ENGINE_IDS } from './engines/index.js';
import { XTB_METHODS, XTB_OPT_LEVELS, XTB_SOLVATION_MODELS } from './engines/xtb.js';
import {
  CONFORMER_ENERGY_UNITS,
  CONFORMER_GENERATORS,
  CONFORMER_GROUP_MAX,
  CONFORMER_METHODS,
  DEFAULT_CONFORMER_SETTINGS,
  isConformerGroupId,
} from './conformers.js';
import {
  OBABEL_DEFAULT_FF,
  OBABEL_DEFAULT_NCONF,
  OBABEL_FORCE_FIELDS,
  OBABEL_MAX_NCONF,
  OBABEL_MIN_NCONF,
} from './obabelConformers.js';
import {
  DEFAULT_OPT_CONVERGENCE,
  DEFAULT_TS_FORCE_CONSTANTS,
  OPT_CONVERGENCE_IDS,
  TS_FORCE_CONSTANT_IDS,
  checkTsForceConstants,
  freqGeometryWarnings,
  hasOptKeyword,
  optConvergenceWarnings,
} from './tsForceConstants.js';
import {
  CONSTRAINT_KINDS,
  MAX_CONSTRAINTS,
  MAX_QST_STRUCTURES,
  constraintAtomCount,
  constraintFindings,
  constraintSignature,
  qstFindings,
} from './constraints.js';
import {
  CHECK_STATUS,
  VALIDITY_CHECKS,
  VALIDITY_CHECK_IDS,
  runValidityChecks,
  summarizeValidity,
} from './validityChecks.js';
import {
  COMPUTE_EXPRESSION_MAX,
  COMPUTE_FIELD_KEYS,
  COMPUTE_INPUTS_MAX,
  ComputeError,
  computeInputsOf,
  identifiersOf,
  parseExpression,
} from './compute.js';
import {
  DP4_COMPUTE_MODE,
  dp4DefinitionForFile,
  validateDp4Definition,
} from './dp4Workflow.js';

const XTB_METHOD_IDS = XTB_METHODS.map((method) => method.id);

/** Hard cap before JSON parsing; project files are small text documents. */
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;

export const LIMITS = Object.freeze({
  nodes: 2000,
  edges: 4000,
  fragments: 64,
  atoms: 1000,
  // RFC 0001: a dataset may hold a family, but not an unbounded one, and the
  // plan it expands into is capped too (records × blocks).
  records: 2000,
  flows: 32,
  planTasks: 5000,
  maxParallel: 64,
  // Issue 177: one day. A wall-clock limit longer than this is not a limit a
  // person can reason about, and the field is here to catch a hang.
  timeoutSeconds: 86400,
  errorsReported: 100,
  warningsReported: 200,
});

export const NODE_TYPES = Object.freeze([
  'input', 'calculate', 'generate', 'condition', 'loop', 'merge', 'output', 'analyse', 'note',
]);

/** States a project file may carry. Queue states are reserved for GN-003. */
export const NODE_STATES = Object.freeze([
  'ready', 'running', 'passed', 'review', 'blocked', 'failed', 'skipped', 'cancelled', 'interrupted',
  // Issue 177: a block stopped by its wall-clock limit. Its own state, because
  // `review` asks a person to look at an output and this block has none.
  'timed out',
]);

/**
 * RFC 0001: `barrier` orders one block after another across the whole record
 * set ("finish the step"), while `dependency` is a per-record hand-off.
 */
export const EDGE_TYPES = Object.freeze(['dependency', 'checkpoint', 'branch', 'loop', 'barrier']);
export const BRANCHES = Object.freeze(['true', 'false']);
export const JOB_TYPES = Object.freeze([
  'Opt', 'Opt Freq', 'Opt=TS', 'Freq', 'IRC', 'SP', 'Scan', 'NMR',
  // Issue #93: STQN transition-state searches read two (QST2) or three (QST3)
  // molecule specifications from one input, so they are job types, not a
  // keyword a free-text field could add.
  'Opt=QST2', 'Opt=QST3',
  // Issue #77: composite methods are job types, not method strings. Each takes
  // no separate method/basis pair and expands to its documented Gaussian links.
  ...COMPOSITE_JOB_TYPES,
  // Issue 181: Psi4's TD-DFT is an *engine* job type, not a Gaussian keyword —
  // it is written as `set tdscf_states N` + `energy('td-<method>')`, never as a
  // route line. It belongs in this enum all the same, because this is the list
  // the validator reads: without it a project containing a TD-DFT block could
  // be run but never saved. `test/jobTypeEnum.test.js` holds the two lists
  // together so an engine job type cannot be added without landing here.
  'TD-DFT',
]);
/**
 * Issue 174: core correlation. `auto` writes no `freeze_core` line at all, so a
 * project that never chose keeps emitting exactly the input it did before.
 */
export const FREEZE_CORE_CHOICES = Object.freeze(['auto', 'true', 'false']);
export const IRC_DIRECTIONS = Object.freeze(['forward', 'reverse', 'both']);
export const DISPERSIONS = Object.freeze(['', 'GD3BJ', 'GD3', 'D4']);
export const SCF_OPTIONS = Object.freeze(['', 'Tight', 'VeryTight']);
export const GRID_OPTIONS = Object.freeze(['', 'Fine', 'UltraFine']);
export const POPULATION_OPTIONS = Object.freeze(['', 'NBO', 'Hirshfeld', 'MK']);
export const TD_TRIPLETS_MODES = Object.freeze(['', 'triplets', 'both']);
export const NMR_NUCLEI = Object.freeze(['1H', '13C', '15N', '19F', '31P', '29Si']);
export const VERBOSITY_OPTIONS = Object.freeze(['', 'Normal', 'Verbose']);
export const SOLVATION_MODELS = Object.freeze(['PCM', 'SMD', 'CPCM']);
export const MEMORY_UNITS = Object.freeze(['MB', 'GB', 'MW']);
export const CONDITION_UNKNOWN = Object.freeze(['block-both', 'treat-false', 'treat-true']);
export const LOOP_MODES = Object.freeze(['retry', 'for-each']);
export const MERGE_POLICIES = Object.freeze(['all', 'any']);
export const GEOMETRY_SOURCES = Object.freeze(['demo', 'imported', 'manual']);
/** Issue #93: where an extra QST2/QST3 structure was copied from. */
export const QST_SOURCES = Object.freeze(['copy', 'block', 'file']);
export const GEOMETRY_FORMATS = Object.freeze(['', 'xyz', 'mol', 'sdf', 'mol2', 'pdb', 'pdbqt', 'cjson', 'gjf', 'com', 'log', 'cdxml']);
// What the coordinates are, when the file says so. A CDXML drawing is 2D: its
// bond lengths are page units and every atom sits at z = 0, so the claim has to
// survive a save rather than only the session that imported it.
export const GEOMETRY_DIMENSIONS = Object.freeze(['', '2d', '3d']);

/** RFC 0001: what an output block writes. HTML is the report format; no PDF. */
export const OUTPUT_KINDS = Object.freeze(['html', 'csv', 'json', 'zip']);
/** `records` = one artifact for the whole dataset, `record` = one per record. */
export const OUTPUT_INCLUDES = Object.freeze(['records', 'record']);
export const DATASET_FORMATS = Object.freeze(['sdf', 'xyz', 'csv', 'json', 'cdxml']);
export const DATASET_SOURCES = Object.freeze(['file', 'inline']);

const OUTPUT_EXTENSIONS = Object.freeze({ html: '.html', csv: '.csv', json: '.json', zip: '.zip' });
const DEFAULT_OUTPUT_PATHS = Object.freeze({
  html: 'reports/report.html',
  csv: 'reports/dataset.csv',
  json: 'reports/dataset.json',
  zip: 'project.zip',
});

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECKPOINT = /^[A-Za-z0-9._-]{1,124}\.chk$/i;
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,124}\.(out|log)$/i;
const BUNDLE_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,120}\.zip$/i;
/** RFC 0001: a project-relative artifact path, no traversal, no absolute root. */
const ARTIFACT_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const PORT = /^[A-Za-z0-9_-]{1,24}$/;
const NUMERIC = /^\d+(\.\d+)?$/;
/** Issue #129: the digest of an imported file, as `sha256File()` writes it. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const JOB_KINDS = {
  Opt: 'Opt',
  'Opt Freq': 'O+F',
  'Opt=TS': 'TS',
  'Opt=QST2': 'TS',
  'Opt=QST3': 'TS',
  Freq: 'Freq',
  IRC: 'IRC',
  SP: 'SP',
  Scan: 'Scan',
  ...Object.fromEntries(COMPOSITE_JOB_TYPES.map((jobType) => [jobType, 'Composite'])),
};

const TYPE_KINDS = {
  input: 'Input',
  generate: 'Generate',
  condition: 'If',
  loop: 'Loop',
  merge: 'Merge',
  output: 'Output',
  analyse: 'Analyse',
  note: 'Note',
};

const TYPE_LABELS = {
  input: 'Dataset input',
  calculate: 'Calculate',
  generate: 'Generate',
  condition: 'Condition',
  loop: 'Retry loop',
  merge: 'Join branches',
  output: 'Project output',
  analyse: 'Analyse',
  note: 'Note',
};

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'name', 'molecule', 'defaults', 'runner', 'datasets', 'flows', 'reports', 'activeFlowId', 'nodes', 'edges']);
const NODE_COMMON_KEYS = new Set(['id', 'type', 'kind', 'title', 'state', 'x', 'y']);
const NODE_TYPE_KEYS = {
  input: new Set(['input']),
  calculate: new Set(['settings', 'output', 'checkpointFrom']),
  generate: new Set(['settings', 'output']),
  condition: new Set(['condition']),
  loop: new Set(['loop']),
  merge: new Set(['merge']),
  output: new Set(['output']),
  analyse: new Set(['analyse']),
  note: new Set(['note']),
};
const SETTINGS_KEYS = new Set([
  'jobType', 'method', 'basis', 'memory', 'memoryUnit', 'nproc', 'checkpoint', 'charge',
  'multiplicity', 'dispersion', 'scf', 'grid', 'population', 'verbosity', 'solvation',
  'solvationModel', 'solvent', 'customKeywords', 'ircDirection', 'optConvergence',
  'forceConstants', 'gates', 'disabledChecks', 'tdStates', 'tdTriplets', 'ladder', 'stableOpt', 'raman', 'vcd', 'tdRoot', 'orbitals', 'spinSweep', 'referenceNodeId',
  // Issue #146: the vertical-emission block and the two-job NTO chain.
  'emission', 'nto', 'ntoTransition',
  'counterpoise', 'counterpoiseChargeStates',
  // Issue #93: coordinate constraints and the extra QST2/QST3 structures.
  'constraints', 'qst',
  'xtbMethod', 'xtbOptLevel', 'xtbThreads', 'engine',
  // Issue 174: the core-correlation choice. Not in the defaults, so an existing
  // project is unchanged; listed here so an explicit value is not read as a typo.
  'freezeCore',
  // Issue 177: a per-block wall-clock limit. Also not in the defaults: a project
  // that never set one must serialise exactly as it did before.
  'timeoutSeconds',
  // Issue 173: the opt-in that makes a Psi4 TD block record transition-dipole
  // vectors. Not in the defaults, so an existing project is unchanged; listed
  // here so an explicit value is not read as a typo.
  'recordTransitionDipoles',
  'nmrSpinSpin',
]);
const GATE_KEYS = new Set(['termination', 'scf', 'imaginary', 'minMagnitude', 'thermo', 'finalEnergy']);

export function defaultGates(overrides = {}) {
  return {
    termination: true,
    scf: true,
    imaginary: null,
    minMagnitude: 50,
    thermo: false,
    finalEnergy: false,
    ...overrides,
  };
}

export function defaultSettings(overrides = {}) {
  // A composite job type owns its own method and basis, so the factory must not
  // plant the B3LYP/def2-SVP placeholder that would then conflict with it.
  const composite = isCompositeJobType(overrides.jobType);
  const base = {
    jobType: 'Opt',
    method: composite ? '' : MODERN_ROUTE_PRESET.method,
    basis: composite ? '' : MODERN_ROUTE_PRESET.basis,
    memory: '4',
    memoryUnit: 'GB',
    nproc: '4',
    checkpoint: '',
    charge: 0,
    multiplicity: 1,
    dispersion: composite ? '' : defaultDispersionFor(MODERN_ROUTE_PRESET.method),
    scf: '',
    grid: '',
    population: '',
    verbosity: '',
    solvation: false,
    solvationModel: 'PCM',
    solvent: 'Water',
    customKeywords: '',
    ircDirection: 'forward',
    tdStates: 0,
    tdTriplets: '',
    xtbMethod: 'gfn2',
    xtbOptLevel: 'normal',
    xtbThreads: '',
    optConvergence: DEFAULT_OPT_CONVERGENCE,
    forceConstants: DEFAULT_TS_FORCE_CONSTANTS,
    gates: defaultGates(),
    // A method ladder is opt-in; `null` means "this block is a normal block".
    ladder: null,
    stableOpt: false,
    raman: false,
    vcd: false,
    orbitals: false,
    tdRoot: 0,
    // Issue #146: a vertical-emission block is an SP TD=(NStates=n,Root=1) at
    // the geometry it receives; an NTO block is the second job of the two-job
    // chain, and `ntoTransition` on the TD block selects the density stored in
    // its checkpoint. All three are off by default so existing projects are
    // byte-identical.
    emission: false,
    nto: false,
    ntoTransition: 0,
    // A spin-state sweep enumerates multiplicities for the same system.
    spinSweep: null,
    // The block whose free energy is the reactant of this path, if declared.
    referenceNodeId: '',
    // Empty means the project default engine.
    engine: '',
    // Issue #77: 0 means "not a counterpoise job"; N is the fragment count.
    counterpoise: 0,
    counterpoiseChargeStates: [],
    // Issue #93: no constraints and no QST on a block that never asked for
    // them, so every existing project plans and writes byte-identical input.
    constraints: [],
    qst: null,
    // Issue #25: validity checks are on by default; a node opts out by id.
    disabledChecks: [],
  };
  const settings = clearCompositeConflicts({
    ...base,
    ...overrides,
    gates: defaultGates({ ...base.gates, ...(overrides.gates || {}) }),
  });
  // An explicit dispersion override wins; otherwise follow the resolved method
  // so a functional with built-in dispersion is not double-corrected.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'dispersion')) {
    // Psi4 takes dispersion through the functional name (ωB97X-D, B97-D) and
    // its builder refuses any EmpiricalDispersion field, so a default block
    // must not plant one — otherwise the factory output its own UI creates
    // could never be built into input.
    settings.dispersion = composite || settings.engine === 'psi4'
      ? ''
      : defaultDispersionFor(settings.method);
  }
  return settings;
}

export function kindForJob(jobType) {
  return JOB_KINDS[jobType] || 'SP';
}

/* ── Collector ────────────────────────────────────────────── */

function createCollector() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(path, message) {
      if (errors.length < LIMITS.errorsReported) errors.push({ path, message });
    },
    warn(path, message) {
      if (warnings.length < LIMITS.warningsReported) warnings.push({ path, message });
    },
    get ok() {
      return errors.length === 0;
    },
  };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function oneLine(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function warnUnknown(c, source, allowed, path) {
  if (!isPlainObject(source)) return;
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) continue;
    const keyPath = path ? `${path}.${key}` : key;
    c.warn(keyPath, 'is not part of this schema version and will be dropped on save.');
  }
}

function requiredObject(c, value, path, legacy, fallback) {
  if (value === undefined) {
    if (!legacy) c.error(path, 'is required.');
    return fallback;
  }
  if (!isPlainObject(value)) {
    c.error(path, 'must be an object.');
    return fallback;
  }
  return value;
}

function readId(c, value, path) {
  if (typeof value !== 'string' || !NODE_ID.test(value)) {
    c.error(path, 'must be 1-64 characters of letters, digits, dot, underscore or dash, starting with a letter or digit.');
    return '';
  }
  return value;
}

function readString(c, value, path, { legacy = false, fallback = '', max = 120, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required && !legacy) c.error(path, 'is required.');
    return fallback;
  }
  if (typeof value !== 'string') {
    c.error(path, 'must be a string.');
    return fallback;
  }
  return oneLine(value, max);
}

function readEnum(c, value, allowed, path, { legacy = false, fallback = '', required = false } = {}) {
  if (value === undefined || value === null) {
    if (required && !legacy) c.error(path, 'is required.');
    return fallback;
  }
  if (!allowed.includes(value)) {
    const options = allowed.filter((item) => item !== '').join(', ') || 'an empty string';
    c.error(path, `must be one of: ${options}.`);
    return fallback;
  }
  return value;
}

/**
 * Issue #102: the solvation allow-list belongs to the engine. Gaussian and ORCA
 * projects keep the historical `PCM`/`SMD`/`CPCM` list; an xTB block accepts the
 * models `buildXtbInput()` can actually emit, `ALPB` and `GBSA`.
 *
 * A Gaussian model on an xTB block is tolerated only while `solvation` is off.
 * Every block created by `defaultSettings()` carries `solvationModel: 'PCM'`, and
 * the renderer only rewrites it when solvation is switched on, so a stored `PCM`
 * on a solvation-off xTB block is an inert placeholder, not a request. Keeping
 * it readable is what lets projects saved before this fix open at all; asking
 * for solvation then requires naming a model xTB implements.
 */
function readSolvationModel(c, value, path, { engine = 'gaussian', solvation = false, legacy = false } = {}) {
  if (engine !== 'xtb') {
    return readEnum(c, value, SOLVATION_MODELS, path, { legacy, fallback: 'PCM' });
  }
  // Absent means "not chosen"; the xTB builder already defaults that to ALPB.
  if (value === undefined || value === null) return XTB_SOLVATION_MODELS[0];
  // Empty is the inspector's "choose a model" state, and solvation-off blocks
  // save it unchanged.
  if (value === '') return '';
  if (XTB_SOLVATION_MODELS.includes(value)) return value;
  if (!solvation && SOLVATION_MODELS.includes(value)) return value;
  const label = SOLVATION_MODELS.includes(value)
    ? 'is a Gaussian-only solvation model'
    : 'is not an xTB solvation model';
  c.error(path,
    `"${oneLine(value)}" ${label} and cannot be used on an xTB block; xTB accepts ${XTB_SOLVATION_MODELS.join(' or ')}.`);
  return XTB_SOLVATION_MODELS[0];
}

function readInteger(c, value, path, { legacy = false, fallback = 0, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!legacy) c.error(path, 'is required.');
    return fallback;
  }
  const number = typeof value === 'string' && NUMERIC.test(value.trim()) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    c.error(path, `must be an integer between ${min} and ${max}.`);
    return fallback;
  }
  return number;
}

/**
 * Optional integer: absent means "not set" rather than an error, so a project
 * written before the field existed still opens cleanly.
 */
function readOptionalInteger(c, value, path, { fallback = 0, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  return readInteger(c, value, path, { legacy: true, fallback, min, max });
}

function readNumber(c, value, path, { legacy = false, fallback = 0, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!legacy) c.error(path, 'is required.');
    return fallback;
  }
  const number = typeof value === 'string' && NUMERIC.test(value.trim()) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
    c.error(path, `must be a finite number between ${min} and ${max}.`);
    return fallback;
  }
  return number;
}

function readBoolean(c, value, path, { legacy = false, fallback = false, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (!legacy && !optional) c.error(path, 'is required.');
    return fallback;
  }
  if (typeof value !== 'boolean') {
    c.error(path, 'must be true or false.');
    return fallback;
  }
  return value;
}

/** Memory is stored as a string because the unit is a separate field. */
function readMemory(c, value, path, { legacy = false, fallback = '4' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!legacy) c.error(path, 'is required.');
    return fallback;
  }
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !NUMERIC.test(text.trim())) {
    c.error(path, 'must be a number between 1 and 1048576.');
    return fallback;
  }
  const number = Number(text);
  if (number < 1 || number > 1048576) {
    c.error(path, 'must be a number between 1 and 1048576.');
    return fallback;
  }
  return String(number);
}

/** Optional OMP_NUM_THREADS override: blank means "inherit the environment". */
function readXtbThreads(c, value, path, { legacy = false, fallback = '' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  return readInteger(c, value, path, { legacy, fallback, min: 1, max: 256 });
}

/* ── Sections ─────────────────────────────────────────────── */

/**
 * Issue #129: the provenance of an imported ensemble. `program`, `version` and
 * `method` are what the user says produced the file; `sourceSha256` is the
 * digest of the bytes this app actually read, recorded by the queue. All four
 * are bounded strings, and an empty program means "not recorded" — never
 * "computed here".
 */
function normalizeConformerOrigin(c, raw, path, legacy) {
  const empty = { program: '', version: '', method: '', sourceSha256: '' };
  if (raw === undefined || raw === null) return empty;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be an object with program, version, method and sourceSha256.');
    return empty;
  }
  warnUnknown(c, raw, new Set(['program', 'version', 'method', 'sourceSha256']), path);
  const sourceSha256 = readString(c, raw.sourceSha256, `${path}.sourceSha256`, { legacy, fallback: '', max: 64 });
  if (sourceSha256 && !SHA256_HEX.test(sourceSha256)) {
    c.error(`${path}.sourceSha256`, 'must be a lowercase SHA-256 hex digest (64 characters).');
  }
  return {
    program: readString(c, raw.program, `${path}.program`, { legacy, fallback: '', max: 40 }),
    version: readString(c, raw.version, `${path}.version`, { legacy, fallback: '', max: 40 }),
    method: readString(c, raw.method, `${path}.method`, { legacy, fallback: '', max: 60 }),
    sourceSha256: SHA256_HEX.test(sourceSha256) ? sourceSha256 : '',
  };
}

/**
 * Issue #132: the study a conformer block belongs to. Empty is a valid answer
 * ("no group") and is what every file written before the field existed means;
 * anything that is not a plain bounded token is refused by name rather than
 * trimmed, because trimming `two words` to `two` would claim a different study.
 */
function readConformerGroup(c, value, path) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !isConformerGroupId(value)) {
    c.error(path, `must be a plain group id of 1-${CONFORMER_GROUP_MAX} characters `
      + '(letters, digits, ".", "_" or "-"), or empty for no group.');
    return '';
  }
  return value;
}

/**
 * Settings for a conformer block. Deliberately separate from the calculation
 * settings: CREST has no route, basis or SCF, and a shared key space would let
 * a route value leak into a conformer search.
 */
function normalizeConformerSettings(c, raw, path, legacy) {
  const provided = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(provided)) {
    c.error(path, 'must be an object.');
    return { ...DEFAULT_CONFORMER_SETTINGS, origin: { ...DEFAULT_CONFORMER_SETTINGS.origin }, charge: 0, multiplicity: 1 };
  }
  warnUnknown(c, provided, new Set([
    'generator', 'method', 'energyWindowKcal', 'rmsdThreshold', 'maxConformers',
    'temperature', 'spreadThresholdKcal', 'selectedConformerId', 'importPath',
    'fanOut', 'charge', 'multiplicity', 'energyUnit', 'energyMethod', 'origin',
    // Issue #132: a study id shared by blocks that belong together.
    'group',
    // Issue 144: the in-app UFF route's own two knobs. Optional; a block that
    // stays on CREST or import never states them.
    'torsionStepDegrees', 'maxTrials',
    // The Open Babel route's knobs: how many conformers the genetic algorithm
    // is asked for, and which force field it uses.
    'nconf', 'ff',
  ]), path);
  // A conformer block is new in this schema, so a file that names one setting
  // and omits the rest is complete enough: the documented defaults fill in.
  const source = { ...DEFAULT_CONFORMER_SETTINGS, charge: 0, multiplicity: 1, ...provided };
  const generator = readEnum(c, source.generator, CONFORMER_GENERATORS, `${path}.generator`, {
    legacy, fallback: DEFAULT_CONFORMER_SETTINGS.generator,
  });
  const importPath = readString(c, source.importPath, `${path}.importPath`, { legacy, fallback: '', max: 260 });
  if (generator === 'import' && !importPath) {
    c.warn(`${path}.importPath`, 'is empty; an imported ensemble needs a multi-XYZ file before this block can run.');
  }
  const selected = readString(c, source.selectedConformerId, `${path}.selectedConformerId`, { legacy, fallback: '', max: 24 });
  if (selected && !/^c\d+$/.test(selected)) {
    c.error(`${path}.selectedConformerId`, 'must be a conformer id such as "c1", or empty for automatic selection.');
  }
  const energyUnit = readEnum(c, source.energyUnit, CONFORMER_ENERGY_UNITS, `${path}.energyUnit`, {
    legacy, fallback: DEFAULT_CONFORMER_SETTINGS.energyUnit,
  });
  if (generator === 'crest' && energyUnit === 'kcal/mol') {
    c.warn(`${path}.energyUnit`, 'only applies to an imported ensemble; a CREST search writes Hartree energies.');
  }
  // Issue 144: the UFF route always records kcal/mol force-field energies, so a
  // block that declares Hartree for it is describing a different route.
  if (generator === 'uff' && provided.energyUnit !== undefined && energyUnit !== 'kcal/mol') {
    c.warn(`${path}.energyUnit`, 'does not apply to the in-app UFF route: it always records kcal/mol force-field energies.');
  }
  return {
    generator,
    method: readEnum(c, source.method, CONFORMER_METHODS, `${path}.method`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.method,
    }),
    energyWindowKcal: readNumber(c, source.energyWindowKcal, `${path}.energyWindowKcal`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.energyWindowKcal, min: 0, max: 100,
    }),
    rmsdThreshold: readNumber(c, source.rmsdThreshold, `${path}.rmsdThreshold`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.rmsdThreshold, min: 0.01, max: 10,
    }),
    maxConformers: readInteger(c, source.maxConformers, `${path}.maxConformers`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.maxConformers, min: 1, max: 200,
    }),
    temperature: readNumber(c, source.temperature, `${path}.temperature`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.temperature, min: 1, max: 1000,
    }),
    spreadThresholdKcal: readNumber(c, source.spreadThresholdKcal, `${path}.spreadThresholdKcal`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal, min: 0, max: 50,
    }),
    selectedConformerId: selected,
    importPath,
    fanOut: readBoolean(c, source.fanOut, `${path}.fanOut`, {
      legacy, fallback: DEFAULT_CONFORMER_SETTINGS.fanOut,
    }),
    charge: readInteger(c, source.charge, `${path}.charge`, { legacy, fallback: 0, min: -10, max: 10 }),
    multiplicity: readInteger(c, source.multiplicity, `${path}.multiplicity`, { legacy, fallback: 1, min: 1, max: 10 }),
    // Issue #130: the unit and method of the imported file's energies. A file
    // that says nothing is Hartree, which is what every pre-#130 file meant.
    energyUnit,
    energyMethod: readString(c, source.energyMethod, `${path}.energyMethod`, { legacy, fallback: '', max: 40 }),
    // Issue #129: what the user declares produced the file. The hash is not
    // part of the declaration — the queue records the digest of the bytes read.
    origin: normalizeConformerOrigin(c, source.origin, `${path}.origin`, legacy),
    // Issue #132: the study this block belongs to, or '' for "stands alone".
    group: readConformerGroup(c, source.group, `${path}.group`),
    // Issue 144: the UFF route's own settings. Only present when the file
    // states them, so a project that never chose the route serialises exactly
    // as it did before (the defaults live in uffConformers.js: 120° and 200).
    ...(provided.torsionStepDegrees === undefined ? {} : {
      torsionStepDegrees: readNumber(c, provided.torsionStepDegrees, `${path}.torsionStepDegrees`, {
        legacy, fallback: 120, min: 15, max: 360,
      }),
    }),
    ...(provided.maxTrials === undefined ? {} : {
      maxTrials: readInteger(c, provided.maxTrials, `${path}.maxTrials`, {
        legacy, fallback: 200, min: 1, max: 2000,
      }),
    }),
    // The Open Babel route: only present when stated, so existing projects
    // serialise byte-for-byte as before.
    ...(provided.nconf === undefined ? {} : {
      nconf: readInteger(c, provided.nconf, `${path}.nconf`, {
        legacy, fallback: OBABEL_DEFAULT_NCONF, min: OBABEL_MIN_NCONF, max: OBABEL_MAX_NCONF,
      }),
    }),
    ...(provided.ff === undefined ? {} : {
      ff: readEnum(c, provided.ff, OBABEL_FORCE_FIELDS, `${path}.ff`, {
        legacy, fallback: OBABEL_DEFAULT_FF,
      }),
    }),
  };
}

function normalizeConformerAtoms(c, raw, path, legacy) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > LIMITS.atoms) {
    c.error(path, `must contain at most ${LIMITS.atoms} atoms.`);
    return [];
  }
  const atoms = [];
  raw.forEach((atom, index) => {
    const atomPath = `${path}[${index}]`;
    if (!isPlainObject(atom)) {
      c.error(atomPath, 'must be an object with element, x, y and z.');
      return;
    }
    const element = readString(c, atom.element, `${atomPath}.element`, { legacy, fallback: '', max: 3, required: true });
    if (!element) return;
    if (!isElementSymbol(element)) {
      c.error(`${atomPath}.element`, `unknown element symbol "${element}".`);
      return;
    }
    atoms.push({
      element,
      x: readNumber(c, atom.x, `${atomPath}.x`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      y: readNumber(c, atom.y, `${atomPath}.y`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      z: readNumber(c, atom.z, `${atomPath}.z`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
    });
  });
  return atoms;
}

/**
 * Issue 144: the search record an in-app UFF ensemble carries — grid, dedupe
 * threshold, trial count and what the result is not. Absent for every other
 * generator, and absent from a file written before the route existed, so
 * nothing gains an empty `search: null` key on the way through.
 */
function normalizeConformerSearch(c, raw, path) {
  if (!isPlainObject(raw)) return null;
  const rotors = Array.isArray(raw.rotors)
    ? raw.rotors.slice(0, 40).map((rotor) => {
      const bond = Array.isArray(rotor?.bond) ? rotor.bond.slice(0, 2).map(Number) : [];
      const torsion = Array.isArray(rotor?.torsion) ? rotor.torsion.slice(0, 4).map(Number) : [];
      if (bond.length !== 2 || torsion.length !== 4) return null;
      if (![...bond, ...torsion].every((value) => Number.isInteger(value) && value > 0)) return null;
      return { bond, torsion };
    }).filter(Boolean)
    : [];
  return {
    method: readString(c, raw.method, `${path}.method`, { legacy: true, fallback: '', max: 80 }),
    engine: readString(c, raw.engine, `${path}.engine`, { legacy: true, fallback: '', max: 20 }),
    torsionStepDegrees: readNumber(c, raw.torsionStepDegrees, `${path}.torsionStepDegrees`, {
      legacy: true, fallback: 0, min: 0, max: 360,
    }),
    rmsdThreshold: readNumber(c, raw.rmsdThreshold, `${path}.rmsdThreshold`, {
      legacy: true, fallback: 0, min: 0, max: 10,
    }),
    trials: readInteger(c, raw.trials, `${path}.trials`, { legacy: true, fallback: 0, min: 0, max: 100000 }),
    trialsPlanned: readInteger(c, raw.trialsPlanned, `${path}.trialsPlanned`, { legacy: true, fallback: 0, min: 0, max: 10000000 }),
    unique: readInteger(c, raw.unique, `${path}.unique`, { legacy: true, fallback: 0, min: 0, max: 100000 }),
    deduplicated: readInteger(c, raw.deduplicated, `${path}.deduplicated`, { legacy: true, fallback: 0, min: 0, max: 100000 }),
    rotatableBonds: readInteger(c, raw.rotatableBonds, `${path}.rotatableBonds`, { legacy: true, fallback: 0, min: 0, max: 1000 }),
    relaxMaxIterations: readInteger(c, raw.relaxMaxIterations, `${path}.relaxMaxIterations`, { legacy: true, fallback: 0, min: 0, max: 100000 }),
    truncated: Boolean(raw.truncated),
    randomized: Boolean(raw.randomized),
    electrostatics: Boolean(raw.electrostatics),
    ringSampling: Boolean(raw.ringSampling),
    comparableWithQuantumChemistry: Boolean(raw.comparableWithQuantumChemistry),
    bondSource: readString(c, raw.bondSource, `${path}.bondSource`, { legacy: true, fallback: '', max: 12 }),
    seed: raw.seed === null || raw.seed === undefined ? null : readInteger(c, raw.seed, `${path}.seed`, { legacy: true, fallback: 0, min: 0, max: 1e9 }),
    energyKind: readString(c, raw.energyKind, `${path}.energyKind`, { legacy: true, fallback: '', max: 80 }),
    note: readString(c, raw.note, `${path}.note`, { legacy: true, fallback: '', max: 400 }),
    accuracyNote: readString(c, raw.accuracyNote, `${path}.accuracyNote`, { legacy: true, fallback: '', max: 400 }),
    rotors,
    // Bonds the search refused to turn, and why. Kept so a reopened project can
    // still say which ring, amide or terminal bond was left alone.
    excluded: Array.isArray(raw.excluded)
      ? raw.excluded.slice(0, 40).map((entry) => ({
        bond: Array.isArray(entry?.bond) ? entry.bond.slice(0, 2).map(Number) : [],
        elements: Array.isArray(entry?.elements) ? entry.elements.slice(0, 2).map((element) => String(element ?? '').slice(0, 3)) : [],
        reason: readString(c, entry?.reason, `${path}.excluded.reason`, { legacy: true, fallback: '', max: 12 }),
      }))
      : [],
  };
}

/**
 * The ensemble summary a conformer block carries between runs. It is validated
 * like any other project data: ids are bounded, member rows are capped, and the
 * selected geometry is the only coordinates kept (one geometry, not N).
 */
function normalizeConformerOutput(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be null or a conformer ensemble summary.');
    return null;
  }
  // Read once: a member that does not name its own unit inherits the
  // ensemble's, and the ensemble's default is the historical Hartree.
  const ensembleUnit = readEnum(c, raw.energyUnit, CONFORMER_ENERGY_UNITS, `${path}.energyUnit`, {
    legacy: true, fallback: 'hartree',
  });
  const members = Array.isArray(raw.members)
    ? raw.members.slice(0, 200).map((member, index) => {
      if (!isPlainObject(member)) return null;
      const memberPath = `${path}.members[${index}]`;
      const energyUnit = readEnum(c, member.energyUnit, CONFORMER_ENERGY_UNITS, `${memberPath}.energyUnit`, {
        legacy: true, fallback: ensembleUnit,
      });
      return {
        id: readString(c, member.id, `${memberPath}.id`, { legacy: true, fallback: '', max: 24 }),
        rank: readInteger(c, member.rank, `${memberPath}.rank`, { legacy: true, fallback: index + 1, min: 1, max: 1000 }),
        // Issue #130: the absolute energy keeps the unit that produced it. A
        // kcal/mol member has no Hartree energy, so `energyEh` stays null
        // instead of holding a converted number that looks like an SCF total.
        energyEh: member.energyEh === null ? null : readNumber(c, member.energyEh, `${memberPath}.energyEh`, { legacy: true, fallback: 0, min: -1e6, max: 1e6 }),
        energyKcal: member.energyKcal === undefined || member.energyKcal === null
          ? null
          : readNumber(c, member.energyKcal, `${memberPath}.energyKcal`, { legacy: true, fallback: 0, min: -1e6, max: 1e6 }),
        energyUnit,
        energyMethod: readString(c, member.energyMethod, `${memberPath}.energyMethod`, { legacy: true, fallback: '', max: 40 }),
        relativeKcal: readNumber(c, member.relativeKcal, `${memberPath}.relativeKcal`, { legacy: true, fallback: 0, min: -1e6, max: 1e6 }),
        // A mixed ensemble has no population to report: null is stored, not 0.
        population: member.population === null ? null : readNumber(c, member.population, `${memberPath}.population`, { legacy: true, fallback: 0, min: 0, max: 1 }),
        rmsdToLowest: readNumber(c, member.rmsdToLowest, `${memberPath}.rmsdToLowest`, { legacy: true, fallback: 0, min: 0, max: 100 }),
        protomer: readString(c, member.protomer, `${memberPath}.protomer`, { legacy: true, fallback: '', max: 40 }),
        kept: Boolean(member.kept),
        dropped: ['energy', 'rmsd', 'count'].includes(member.dropped) ? member.dropped : null,
        atoms: member.kept ? normalizeConformerAtoms(c, member.atoms, `${memberPath}.atoms`, legacy) : [],
      };
    }).filter(Boolean)
    : [];
  const selectedRaw = isPlainObject(raw.selected) ? raw.selected : null;
  const selected = selectedRaw ? {
    id: readString(c, selectedRaw.id, `${path}.selected.id`, { legacy: true, fallback: '', max: 24 }),
    energyEh: selectedRaw.energyEh === null ? null : readNumber(c, selectedRaw.energyEh, `${path}.selected.energyEh`, { legacy: true, fallback: 0, min: -1e6, max: 1e6 }),
    energyKcal: selectedRaw.energyKcal === undefined || selectedRaw.energyKcal === null
      ? null
      : readNumber(c, selectedRaw.energyKcal, `${path}.selected.energyKcal`, { legacy: true, fallback: 0, min: -1e6, max: 1e6 }),
    energyUnit: readEnum(c, selectedRaw.energyUnit, CONFORMER_ENERGY_UNITS, `${path}.selected.energyUnit`, {
      legacy: true, fallback: ensembleUnit,
    }),
    energyMethod: readString(c, selectedRaw.energyMethod, `${path}.selected.energyMethod`, { legacy: true, fallback: '', max: 40 }),
    relativeKcal: readNumber(c, selectedRaw.relativeKcal, `${path}.selected.relativeKcal`, { legacy: true, fallback: 0, min: -1e6, max: 1e6 }),
    population: selectedRaw.population === null ? null : readNumber(c, selectedRaw.population, `${path}.selected.population`, { legacy: true, fallback: 0, min: 0, max: 1 }),
    protomer: readString(c, selectedRaw.protomer, `${path}.selected.protomer`, { legacy: true, fallback: '', max: 40 }),
    atoms: normalizeConformerAtoms(c, selectedRaw.atoms, `${path}.selected.atoms`, legacy),
  } : null;
  // Issue 144: present only on an in-app UFF ensemble, so a CREST or imported
  // summary keeps exactly the keys it had.
  const search = normalizeConformerSearch(c, raw.search, `${path}.search`);
  return {
    generator: readString(c, raw.generator, `${path}.generator`, { legacy: true, fallback: '', max: 24 }),
    method: readString(c, raw.method, `${path}.method`, { legacy: true, fallback: '', max: 24 }),
    // Issue #130: what the ensemble's absolute energies are, and what produced
    // them. `mixedEnergies` means the members disagree and nothing was averaged.
    energyUnit: ensembleUnit,
    energyMethod: readString(c, raw.energyMethod, `${path}.energyMethod`, { legacy: true, fallback: '', max: 40 }),
    mixedEnergies: Boolean(raw.mixedEnergies),
    // Issue #129: where the ensemble came from. Empty fields mean "not
    // recorded", which is not the same claim as "computed here".
    origin: normalizeConformerOrigin(c, raw.origin, `${path}.origin`, true),
    // Issue #132: the study id the summary was written with, copied from the
    // block. A legacy summary has none, which reads as "no group".
    group: readConformerGroup(c, raw.group, `${path}.group`),
    ...(search ? { search } : {}),
    count: readInteger(c, raw.count, `${path}.count`, { legacy: true, fallback: members.filter((member) => member.kept).length, min: 0, max: 200 }),
    total: readInteger(c, raw.total, `${path}.total`, { legacy: true, fallback: members.length, min: 0, max: 5000 }),
    spreadKcal: raw.spreadKcal === null || raw.spreadKcal === undefined
      ? null
      : readNumber(c, raw.spreadKcal, `${path}.spreadKcal`, { legacy: true, fallback: 0, min: 0, max: 1e5 }),
    generatedAt: readString(c, raw.generatedAt, `${path}.generatedAt`, { legacy: true, fallback: '', max: 40 }),
    selectedId: readString(c, raw.selectedId, `${path}.selectedId`, { legacy: true, fallback: '', max: 24 }),
    requiresSelection: Boolean(raw.requiresSelection),
    autoSelected: Boolean(raw.autoSelected),
    protomers: Array.isArray(raw.protomers) ? raw.protomers.slice(0, 20).map((item) => String(item).slice(0, 40)) : [],
    pruned: {
      energy: readInteger(c, raw.pruned?.energy, `${path}.pruned.energy`, { legacy: true, fallback: 0, min: 0, max: 5000 }),
      rmsd: readInteger(c, raw.pruned?.rmsd, `${path}.pruned.rmsd`, { legacy: true, fallback: 0, min: 0, max: 5000 }),
      count: readInteger(c, raw.pruned?.count, `${path}.pruned.count`, { legacy: true, fallback: 0, min: 0, max: 5000 }),
    },
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.slice(0, 20).map((warning) => ({
        id: readString(c, warning?.id, `${path}.warnings.id`, { legacy: true, fallback: '', max: 40 }),
        status: readString(c, warning?.status, `${path}.warnings.status`, { legacy: true, fallback: 'warn', max: 12 }),
        message: readString(c, warning?.message, `${path}.warnings.message`, { legacy: true, fallback: '', max: 400 }),
      }))
      : [],
    members,
    selected,
  };
}

function normalizeCoords(c, raw, legacy, basePath = 'molecule.coords') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error(basePath, 'must be an array of atoms.');
    return [];
  }
  if (raw.length > LIMITS.atoms) {
    c.error(basePath, `must contain at most ${LIMITS.atoms} atoms.`);
    return [];
  }
  const atoms = [];
  raw.forEach((atom, index) => {
    const path = `${basePath}[${index}]`;
    if (!isPlainObject(atom)) {
      c.error(path, 'must be an object with element, x, y and z.');
      return;
    }
    const element = readString(c, atom.element, `${path}.element`, { legacy, fallback: '', max: 3, required: true });
    if (!element) return;
    if (!isElementSymbol(element)) {
      c.error(`${path}.element`, `unknown element symbol "${element}".`);
      return;
    }
    const hasFragment = atom.fragment !== undefined && atom.fragment !== null && atom.fragment !== '';
    const fragment = hasFragment
      ? readOptionalInteger(c, atom.fragment, `${path}.fragment`, { fallback: 0, min: 1, max: LIMITS.fragments })
      : 0;
    atoms.push({
      element,
      x: readNumber(c, atom.x, `${path}.x`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      y: readNumber(c, atom.y, `${path}.y`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      z: readNumber(c, atom.z, `${path}.z`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      // Counterpoise fragment label (#77). Absent means "not labelled", which
      // keeps every pre-#77 atom object byte-identical.
      ...(fragment > 0 ? { fragment } : {}),
    });
  });
  return atoms;
}

function normalizeGeometry(c, raw, legacy, coords) {
  const source = requiredObject(c, raw, 'molecule.geometry', legacy, {});
  warnUnknown(c, source, new Set(['source', 'file', 'format', 'dimension']), 'molecule.geometry');
  const kind = readEnum(c, source.source, GEOMETRY_SOURCES, 'molecule.geometry.source', { legacy, fallback: 'demo' });
  const file = readString(c, source.file, 'molecule.geometry.file', { legacy, fallback: '', max: 260 });
  const format = readEnum(c, source.format, GEOMETRY_FORMATS, 'molecule.geometry.format', { legacy, fallback: '' });
  const dimension = readEnum(c, source.dimension, GEOMETRY_DIMENSIONS, 'molecule.geometry.dimension', { legacy, fallback: '' });
  if ((kind === 'imported' || kind === 'manual') && coords.length === 0) {
    c.error('molecule.coords', `at least one atom is required when the geometry source is "${kind}".`);
  }
  return { source: kind, file, format, ...(dimension ? { dimension } : {}) };
}

function normalizeMolecule(c, raw, legacy) {
  const source = requiredObject(c, raw, 'molecule', legacy, {});
  warnUnknown(c, source, new Set(['smiles', 'charge', 'multiplicity', 'fragments', 'coords', 'bonds', 'geometry']), 'molecule');
  const fragmentsRaw = source.fragments;
  let fragments = [];
  if (fragmentsRaw === undefined) {
    if (!legacy) c.error('molecule.fragments', 'is required.');
  } else if (!Array.isArray(fragmentsRaw)) {
    c.error('molecule.fragments', 'must be an array of fragment strings.');
  } else if (fragmentsRaw.length > LIMITS.fragments) {
    c.error('molecule.fragments', `must contain at most ${LIMITS.fragments} fragments.`);
  } else {
    fragments = fragmentsRaw.map((fragment, index) => {
      if (typeof fragment !== 'string' || fragment.trim() === '') {
        c.error(`molecule.fragments[${index}]`, 'must be a non-empty string.');
        return '';
      }
      return oneLine(fragment, 400);
    });
  }
  const coords = normalizeCoords(c, source.coords, legacy);
  const bonds = normalizeBonds(c, source.bonds, legacy, coords.length);
  return {
    smiles: readString(c, source.smiles, 'molecule.smiles', { legacy, fallback: '', max: 1000 }),
    charge: readInteger(c, source.charge, 'molecule.charge', { legacy, fallback: 0, min: -10, max: 10 }),
    multiplicity: readInteger(c, source.multiplicity, 'molecule.multiplicity', { legacy, fallback: 1, min: 1, max: 10 }),
    fragments,
    coords,
    // Optional: only a file that stated its topology carries bonds. An absent
    // list means "not stated", so the viewer keeps perceiving them by distance.
    ...(bonds.length ? { bonds } : {}),
    geometry: normalizeGeometry(c, source.geometry, legacy, coords),
  };
}

/**
 * Topology stated by the source file. Kept optional and validated against the
 * atom count, so a corrupt bond index is an error rather than a line to
 * nowhere.
 */
function normalizeBonds(c, raw, legacy, atomCount, basePath = 'molecule.bonds') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error(basePath, 'must be an array of {a, b, order} entries.');
    return [];
  }
  if (raw.length > LIMITS.atoms * 8) {
    c.error(basePath, 'contains more bonds than this atom count can have.');
    return [];
  }
  const bonds = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const path = `${basePath}[${index}]`;
    if (!entry || typeof entry !== 'object') {
      c.error(path, 'must be an object with a, b and order.');
      return;
    }
    const a = Number(entry.a);
    const b = Number(entry.b);
    const order = Number(entry.order ?? 1);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a > atomCount || b > atomCount || a === b) {
      c.error(path, `refers to atoms ${entry.a} and ${entry.b}; the structure has ${atomCount}.`);
      return;
    }
    if (![1, 1.5, 2, 3].includes(order)) {
      c.error(path, 'order must be 1, 2, 3 or 1.5 (aromatic).');
      return;
    }
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (seen.has(key)) return;
    seen.add(key);
    bonds.push({ a: Math.min(a, b), b: Math.max(a, b), order });
  });
  return bonds;
}

function normalizeDefaults(c, raw, legacy) {
  const source = requiredObject(c, raw, 'defaults', legacy, {});
  warnUnknown(c, source, new Set(['engine', 'method', 'basis', 'memory', 'memoryUnit', 'nproc']), 'defaults');
  return {
    engine: readEnum(c, source.engine, ENGINE_IDS, 'defaults.engine', { legacy, fallback: 'gaussian' }) || 'gaussian',
    method: readString(c, source.method, 'defaults.method', { legacy, fallback: MODERN_ROUTE_PRESET.method, max: 64, required: true }) || MODERN_ROUTE_PRESET.method,
    basis: readString(c, source.basis, 'defaults.basis', { legacy, fallback: MODERN_ROUTE_PRESET.basis, max: 64, required: true }) || MODERN_ROUTE_PRESET.basis,
    memory: readMemory(c, source.memory, 'defaults.memory', { legacy, fallback: '4' }),
    memoryUnit: readEnum(c, source.memoryUnit, MEMORY_UNITS, 'defaults.memoryUnit', { legacy, fallback: 'GB' }),
    nproc: readInteger(c, source.nproc, 'defaults.nproc', { legacy, fallback: 4, min: 1, max: 1024 }),
  };
}

/**
 * The project-wide engine as seen by node validation, before `defaults` itself
 * is normalized. It only selects the engine-specific solvation allow-list
 * (#102); an absent or invalid value behaves as Gaussian here and is reported
 * by `normalizeDefaults` where the error belongs.
 */
function projectEngineOf(rawDefaults) {
  const engine = isPlainObject(rawDefaults) ? rawDefaults.engine : undefined;
  return ENGINE_IDS.includes(engine) ? engine : 'gaussian';
}

/**
 * A method ladder: the same system at two to four levels of theory, gated on
 * how far the final energies spread. Kept in the project file so the ladder is
 * a property of the block, not of one particular run.
 */
function normalizeLadder(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be null or an object with enabled, toleranceKcal and rungs.');
    return null;
  }
  warnUnknown(c, raw, new Set(['enabled', 'toleranceKcal', 'rungs']), path);
  const enabled = readBoolean(c, raw.enabled, `${path}.enabled`, { legacy, fallback: false });
  const toleranceKcal = readNumber(c, raw.toleranceKcal, `${path}.toleranceKcal`, {
    legacy, fallback: 3, min: 0, max: 100000,
  });
  const rawRungs = Array.isArray(raw.rungs) ? raw.rungs : [];
  if (enabled && (rawRungs.length < 2 || rawRungs.length > 4)) {
    c.error(`${path}.rungs`, 'a method ladder needs between 2 and 4 rungs.');
  }
  const rungs = rawRungs.slice(0, 4).map((rung, index) => {
    const entryPath = `${path}.rungs[${index}]`;
    if (!isPlainObject(rung)) {
      c.error(entryPath, 'must be an object with method and optionally basis, dispersion and label.');
      return { label: `Rung ${index + 1}`, method: '', basis: '', dispersion: '' };
    }
    warnUnknown(c, rung, new Set(['label', 'method', 'basis', 'dispersion']), entryPath);
    const method = readString(c, rung.method, `${entryPath}.method`, { legacy, fallback: '', max: 40 }) || '';
    if (enabled && !method) c.error(`${entryPath}.method`, 'is required for an enabled rung.');
    return {
      label: readString(c, rung.label, `${entryPath}.label`, { legacy, fallback: `Rung ${index + 1}`, max: 40 }) || `Rung ${index + 1}`,
      method,
      basis: readString(c, rung.basis, `${entryPath}.basis`, { legacy, fallback: '', max: 40 }) || '',
      dispersion: readString(c, rung.dispersion, `${entryPath}.dispersion`, { legacy, fallback: '', max: 40 }) || '',
    };
  });
  return { enabled, toleranceKcal, rungs };
}

/**
 * A spin-state sweep: enumerate multiplicities of the same system at the same
 * level of theory. Multiplicity is a property of the electronic state, so the
 * block cannot keep one value and sweep it — the plan expands into one task per
 * multiplicity.
 */
function normalizeSpinSweep(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be null or an object with enabled and multiplicities.');
    return null;
  }
  warnUnknown(c, raw, new Set(['enabled', 'multiplicities']), path);
  const enabled = readBoolean(c, raw.enabled, `${path}.enabled`, { legacy, fallback: false });
  const rawMultiplicities = Array.isArray(raw.multiplicities) ? raw.multiplicities : [];
  const multiplicities = [];
  rawMultiplicities.slice(0, 6).forEach((value, index) => {
    const entryPath = `${path}.multiplicities[${index}]`;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
      c.error(entryPath, 'must be an integer multiplicity between 1 and 12.');
      return;
    }
    if (!multiplicities.includes(parsed)) multiplicities.push(parsed);
  });
  if (enabled && multiplicities.length < 2) {
    c.error(`${path}.multiplicities`, 'a spin-state sweep needs at least two distinct multiplicities.');
  }
  return { enabled, multiplicities };
}

function normalizeGates(c, raw, path, legacy) {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, GATE_KEYS, path);
  const imaginary = source.imaginary === undefined || source.imaginary === null
    ? null
    : readInteger(c, source.imaginary, `${path}.imaginary`, { legacy, fallback: null, min: 0, max: 10 });
  const minMagnitude = source.minMagnitude === undefined || source.minMagnitude === null
    ? null
    : readNumber(c, source.minMagnitude, `${path}.minMagnitude`, { legacy, fallback: null, min: 0, max: 100000 });
  return {
    termination: readBoolean(c, source.termination, `${path}.termination`, { legacy, fallback: true }),
    scf: readBoolean(c, source.scf, `${path}.scf`, { legacy, fallback: true }),
    imaginary,
    minMagnitude,
    thermo: readBoolean(c, source.thermo, `${path}.thermo`, { legacy, fallback: false }),
    finalEnergy: readBoolean(c, source.finalEnergy, `${path}.finalEnergy`, { legacy, fallback: false }),
  };
}

/**
 * Issue #25: a node may switch off individual validity checks by id. Unknown
 * ids are dropped with a warning so a typo cannot silently disable nothing,
 * and the canonical save stays stable.
 */
function normalizeDisabledChecks(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error(path, 'must be an array of validity-check ids.');
    return [];
  }
  const disabled = [];
  raw.forEach((value, index) => {
    if (typeof value !== 'string') {
      c.error(`${path}[${index}]`, 'must be a validity-check id.');
      return;
    }
    if (!VALIDITY_CHECK_IDS.includes(value)) {
      c.warn(`${path}[${index}]`, `is not a known validity check and will be dropped on save (known: ${VALIDITY_CHECK_IDS.join(', ')}).`);
      return;
    }
    if (!disabled.includes(value)) disabled.push(value);
  });
  return disabled;
}

function normalizeCounterpoiseChargeStates(c, raw, path) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error(path, 'must be an array of { charge, multiplicity } entries.');
    return [];
  }
  if (raw.length > COUNTERPOISE_MAX_FRAGMENTS) {
    c.error(path, `must contain at most ${COUNTERPOISE_MAX_FRAGMENTS} fragment charge states.`);
    return [];
  }
  const states = [];
  raw.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      c.error(entryPath, 'must be an object with charge and multiplicity.');
      return;
    }
    states.push({
      charge: readInteger(c, entry.charge, `${entryPath}.charge`, { fallback: 0, min: -10, max: 10 }),
      multiplicity: readInteger(c, entry.multiplicity, `${entryPath}.multiplicity`, { fallback: 1, min: 1, max: 10 }),
    });
  });
  return states;
}

/**
 * Issue #93: constraints are stored as `{ kind, atoms, value }`.
 *
 * The structure is checked here (kind, atom arity, duplicates, value shape) so
 * a corrupt file cannot be opened into a run; whether the indices exist in the
 * geometry, and whether the set leaves anything to optimise, needs the
 * molecule and is checked in `validateFlow` and again in the input builder.
 */
function normalizeConstraints(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error(path, 'must be an array of { kind, atoms, value } constraint objects.');
    return [];
  }
  if (raw.length > MAX_CONSTRAINTS) {
    c.error(path, `must contain at most ${MAX_CONSTRAINTS} constraints.`);
    return [];
  }
  const constraints = [];
  raw.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      c.error(entryPath, 'must be an object with kind, atoms and value.');
      return;
    }
    warnUnknown(c, entry, new Set(['kind', 'atoms', 'value', 'mode', 'steps', 'size']), entryPath);
    const kind = readEnum(c, entry.kind, CONSTRAINT_KINDS, `${entryPath}.kind`, { legacy, fallback: '', required: true });
    if (!kind) return;
    const expected = constraintAtomCount(kind);
    const atomsRaw = Array.isArray(entry.atoms) ? entry.atoms : null;
    if (!atomsRaw || atomsRaw.length !== expected) {
      const unit = expected === 1 ? 'atom index' : 'atom indices';
      c.error(`${entryPath}.atoms`,
        `a ${kind} constraint needs exactly ${expected} ${unit} (1-based, as written in the geometry).`);
      return;
    }
    const atoms = atomsRaw.map((value, atomIndex) => readInteger(c, value, `${entryPath}.atoms[${atomIndex}]`, {
      legacy, fallback: 1, min: 1, max: LIMITS.atoms,
    }));
    const value = entry.value === undefined || entry.value === null || entry.value === ''
      ? null
      : readNumber(c, entry.value, `${entryPath}.value`, { legacy, fallback: null, min: -3600, max: 3600 });
    if (kind === 'freeze' && value !== null) {
      c.error(`${entryPath}.value`, 'a frozen atom takes no value; freeze a bond, angle or dihedral to hold a number.');
      return;
    }
    // A constraint is either frozen (the default) or scanned: `B 1 2 S 10 0.05`.
    // A scan needs a step count and a step size, and both belong in the file so
    // the CLI writes exactly what the window writes.
    const mode = entry.mode === undefined || entry.mode === null || entry.mode === ''
      ? 'freeze'
      : readEnum(c, entry.mode, ['freeze', 'scan'], `${entryPath}.mode`, { legacy, fallback: 'freeze' });
    if (mode === 'scan' && kind === 'freeze') {
      c.error(`${entryPath}.mode`, 'freezing an atom cannot be scanned; scan a bond, angle or dihedral.');
      return;
    }
    let steps = null;
    let size = null;
    if (mode === 'scan') {
      steps = readInteger(c, entry.steps, `${entryPath}.steps`, { legacy, fallback: 10, min: 1, max: 1000 });
      size = readNumber(c, entry.size, `${entryPath}.size`, { legacy, fallback: 0.05, min: -3600, max: 3600 });
      if (!steps || size === null || size === 0) {
        c.error(entryPath, 'a scan constraint needs a positive step count and a non-zero step size.');
        return;
      }
    }
    const constraint = { kind, atoms, value, mode, ...(mode === 'scan' ? { steps, size } : {}) };
    const duplicateOf = constraints.findIndex((existing) => constraintSignature(existing) === constraintSignature(constraint));
    if (duplicateOf !== -1) {
      c.error(entryPath, `repeats the constraint at ${path}[${duplicateOf}]; remove one of the two.`);
      return;
    }
    constraints.push(constraint);
  });
  return constraints;
}

/**
 * Issue #93: the extra QST2/QST3 structures. Each one is a complete molecule
 * specification, and it travels *in the file*: the builder is pure and the CLI
 * must emit exactly what the app emits, so the coordinates are stored on the
 * block and `source`/`nodeId`/`path` record where they were copied from.
 */
function normalizeQst(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be null or an object with structures.');
    return null;
  }
  warnUnknown(c, raw, new Set(['structures']), path);
  const rawStructures = Array.isArray(raw.structures) ? raw.structures : [];
  if (rawStructures.length > MAX_QST_STRUCTURES) {
    c.error(`${path}.structures`, `must contain at most ${MAX_QST_STRUCTURES} structures.`);
  }
  const structures = rawStructures.slice(0, MAX_QST_STRUCTURES).map((structure, index) => {
    const entryPath = `${path}.structures[${index}]`;
    if (!isPlainObject(structure)) {
      c.error(entryPath, 'must be an object with label, source, atoms and optionally nodeId and path.');
      return { label: `Structure ${index + 2}`, source: 'copy', nodeId: '', path: '', atoms: [] };
    }
    warnUnknown(c, structure, new Set(['label', 'source', 'nodeId', 'path', 'atoms']), entryPath);
    return {
      label: readString(c, structure.label, `${entryPath}.label`, { legacy, fallback: '', max: 60 }) || '',
      source: readEnum(c, structure.source, QST_SOURCES, `${entryPath}.source`, { legacy, fallback: 'copy' }),
      nodeId: readString(c, structure.nodeId, `${entryPath}.nodeId`, { legacy, fallback: '', max: 64 }) || '',
      path: readString(c, structure.path, `${entryPath}.path`, { legacy, fallback: '', max: 260 }) || '',
      atoms: normalizeCoords(c, structure.atoms, legacy, `${entryPath}.atoms`),
    };
  });
  return { structures };
}

function normalizeSettings(c, raw, path, legacy, projectEngine = 'gaussian') {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, SETTINGS_KEYS, path);
  const checkpoint = readString(c, source.checkpoint, `${path}.checkpoint`, { legacy, fallback: '', max: 128 });
  if (checkpoint && !CHECKPOINT.test(checkpoint)) {
    c.error(`${path}.checkpoint`, 'must be a safe file name ending in .chk.');
  }
  const customKeywords = readString(c, source.customKeywords, `${path}.customKeywords`, { legacy, fallback: '', max: 500 });
  if (/^Opt\b/.test(String(source.jobType ?? 'Opt')) && hasOptKeyword(customKeywords)) {
    c.warn(`${path}.customKeywords`,
      'adds an Opt keyword, but the job type and force constants already emit one. Remove it, or the input builder will refuse to compose the route.');
  }
  const jobType = readEnum(c, source.jobType, JOB_TYPES, `${path}.jobType`, { legacy, fallback: 'Opt', required: true }) || 'Opt';
  // Per-block engine override; empty means "inherit the project default". The
  // resolved engine decides which solvation models are meaningful (#102).
  const engine = source.engine === undefined || source.engine === null || source.engine === ''
    ? ''
    : (readEnum(c, source.engine, ENGINE_IDS, `${path}.engine`, { legacy, fallback: 'gaussian' }) || 'gaussian');
  const resolvedEngine = engine || projectEngine;
  const solvation = readBoolean(c, source.solvation, `${path}.solvation`, { legacy, fallback: false });
  // A composite method has no method/basis of its own; absent fields stay
  // empty (not applicable), while an explicit value is preserved so the
  // builder and the validity check can refuse the conflict.
  const compositeJob = isCompositeJobType(jobType);
  const counterpoise = readOptionalInteger(c, source.counterpoise, `${path}.counterpoise`, {
    fallback: 0, min: 0, max: COUNTERPOISE_MAX_FRAGMENTS,
  });
  if (counterpoise === 1) {
    c.error(`${path}.counterpoise`, 'must be 0 (off) or at least 2 fragments.');
  }
  // Issue 177: the block's own wall-clock limit, in seconds. Null means "no
  // opinion"; the project's runner setting (or the built-in default) applies.
  // Kept out of the returned object when absent so the file is unchanged.
  const timeoutSeconds = source.timeoutSeconds === undefined || source.timeoutSeconds === null || source.timeoutSeconds === ''
    ? null
    : readOptionalInteger(c, source.timeoutSeconds, `${path}.timeoutSeconds`, {
      fallback: null, min: 1, max: LIMITS.timeoutSeconds,
    });
  // Issue 174: the core-correlation choice. `auto` (or absent) means "write
  // nothing", which is why the builder treats null as no opinion; an explicit
  // value must survive a save or the block quietly runs all-electron.
  const freezeCore = source.freezeCore === undefined || source.freezeCore === null || source.freezeCore === ''
    ? null
    : readEnum(c, source.freezeCore, FREEZE_CORE_CHOICES, `${path}.freezeCore`, { legacy, fallback: '' }) || null;
  // Issue 173: record the transition-dipole vector. Without it a coupling cannot
  // be computed — the direction is not recoverable from the oscillator strength.
  // Absent means off, and no key is written.
  const recordTransitionDipoles = source.recordTransitionDipoles === undefined || source.recordTransitionDipoles === null
    ? null
    : readBoolean(c, source.recordTransitionDipoles, `${path}.recordTransitionDipoles`, { legacy: true, optional: true, fallback: false });
  return {
    // Per-block engine override. Empty means "use the project default", which is
    // what every .ncs written before this setting existed says.
    engine,
    jobType,
    method: readString(c, source.method, `${path}.method`, {
      legacy, fallback: compositeJob ? '' : MODERN_ROUTE_PRESET.method, max: 64, required: !compositeJob,
    }) || (compositeJob ? '' : MODERN_ROUTE_PRESET.method),
    basis: readString(c, source.basis, `${path}.basis`, {
      legacy, fallback: compositeJob ? '' : MODERN_ROUTE_PRESET.basis, max: 64, required: !compositeJob,
    }) || (compositeJob ? '' : MODERN_ROUTE_PRESET.basis),
    memory: readMemory(c, source.memory, `${path}.memory`, { legacy, fallback: '4' }),
    memoryUnit: readEnum(c, source.memoryUnit, MEMORY_UNITS, `${path}.memoryUnit`, { legacy, fallback: 'GB' }),
    nproc: readInteger(c, source.nproc, `${path}.nproc`, { legacy, fallback: 4, min: 1, max: 1024 }),
    checkpoint,
    charge: readInteger(c, source.charge, `${path}.charge`, { legacy, fallback: 0, min: -10, max: 10 }),
    multiplicity: readInteger(c, source.multiplicity, `${path}.multiplicity`, { legacy, fallback: 1, min: 1, max: 10 }),
    dispersion: readEnum(c, source.dispersion, DISPERSIONS, `${path}.dispersion`, { legacy, fallback: '' }),
    scf: readEnum(c, source.scf, SCF_OPTIONS, `${path}.scf`, { legacy, fallback: '' }),
    grid: readEnum(c, source.grid, GRID_OPTIONS, `${path}.grid`, { legacy, fallback: '' }),
    population: readEnum(c, source.population, POPULATION_OPTIONS, `${path}.population`, { legacy, fallback: '' }),
    verbosity: readEnum(c, source.verbosity, VERBOSITY_OPTIONS, `${path}.verbosity`, { legacy, fallback: '' }),
    solvation,
    solvationModel: readSolvationModel(c, source.solvationModel, `${path}.solvationModel`, {
      engine: resolvedEngine, solvation, legacy,
    }),
    solvent: readString(c, source.solvent, `${path}.solvent`, { legacy, fallback: 'Water', max: 40 }) || 'Water',
    customKeywords,
    ircDirection: readEnum(c, source.ircDirection, IRC_DIRECTIONS, `${path}.ircDirection`, { legacy, fallback: 'forward' }),
    // TD-DFT: 0 states means "not an excited-state job"; the builder clamps the
    // upper bound and refuses job types Gaussian cannot combine with TD.
    tdStates: readOptionalInteger(c, source.tdStates, `${path}.tdStates`, { fallback: 0, min: 0, max: 200 }),
    tdTriplets: readEnum(c, source.tdTriplets, TD_TRIPLETS_MODES, `${path}.tdTriplets`, { legacy, fallback: '' }),
    xtbMethod: readEnum(c, source.xtbMethod, XTB_METHOD_IDS, `${path}.xtbMethod`, { legacy, fallback: 'gfn2' }),
    xtbOptLevel: readEnum(c, source.xtbOptLevel, XTB_OPT_LEVELS, `${path}.xtbOptLevel`, { legacy, fallback: 'normal' }),
    xtbThreads: readXtbThreads(c, source.xtbThreads, `${path}.xtbThreads`, { legacy, fallback: '' }),
    optConvergence: readEnum(c, source.optConvergence, OPT_CONVERGENCE_IDS, `${path}.optConvergence`, { legacy, fallback: DEFAULT_OPT_CONVERGENCE }),
    forceConstants: readEnum(c, source.forceConstants, TS_FORCE_CONSTANT_IDS, `${path}.forceConstants`, { legacy, fallback: DEFAULT_TS_FORCE_CONSTANTS }),
    // A wavefunction stability optimisation (`Stable=Opt`) is opt-in.
    stableOpt: readBoolean(c, source.stableOpt, `${path}.stableOpt`, { legacy, fallback: false, optional: true }),
    // Raman activities (#76): a flag on the frequency keyword, off by default so
    // an existing project keeps emitting exactly the route it did before.
    raman: readBoolean(c, source.raman, `${path}.raman`, { legacy, fallback: false, optional: true }),

    vcd: readBoolean(c, source.vcd, `${path}.vcd`, { legacy, fallback: false, optional: true }),
    // Issue 147: ask Gaussian for the spin-spin coupling tables on an NMR job.
    // Optional, so an NMR block that never set it writes exactly `NMR` and the
    // card's "the route did not ask for couplings" stays true.
    ...(source.nmrSpinSpin === undefined || source.nmrSpinSpin === null
      ? {}
      : { nmrSpinSpin: readBoolean(c, source.nmrSpinSpin, `${path}.nmrSpinSpin`, { legacy: true, optional: true, fallback: false }) }),
    orbitals: readBoolean(c, source.orbitals, `${path}.orbitals`, { legacy, fallback: false, optional: true }),
    // Which excited state an accompanying Opt follows (#75). 0 = not stated.
    tdRoot: readOptionalInteger(c, source.tdRoot, `${path}.tdRoot`, { fallback: 0, min: 0, max: 200 }),
    // Issue #146: vertical-emission and NTO blocks. A block that was never one
    // reads exactly as before: false / false / 0.
    emission: readBoolean(c, source.emission, `${path}.emission`, { legacy, fallback: false, optional: true }),
    nto: readBoolean(c, source.nto, `${path}.nto`, { legacy, fallback: false, optional: true }),
    ntoTransition: readOptionalInteger(c, source.ntoTransition, `${path}.ntoTransition`, { fallback: 0, min: 0, max: 200 }),
    spinSweep: normalizeSpinSweep(c, source.spinSweep, `${path}.spinSweep`, legacy),
    // Issue #77: Counterpoise=N with per-fragment charge/spin pairs when the
    // fragments are not all at the complex's charge state.
    counterpoise,
    counterpoiseChargeStates: normalizeCounterpoiseChargeStates(c, source.counterpoiseChargeStates, `${path}.counterpoiseChargeStates`),
    // Issue #93: frozen coordinates and the extra QST2/QST3 structures.
    constraints: normalizeConstraints(c, source.constraints, `${path}.constraints`, legacy),
    qst: normalizeQst(c, source.qst, `${path}.qst`, legacy),
    // The block whose free energy is the reactant in a ΔG‡ for this path. It
    // is declared, never inferred from the graph.
    referenceNodeId: readString(c, source.referenceNodeId, `${path}.referenceNodeId`, { legacy, fallback: '', max: 64 }) || '',
    gates: normalizeGates(c, source.gates, `${path}.gates`, legacy),
    ladder: normalizeLadder(c, source.ladder, `${path}.ladder`, legacy),
    disabledChecks: normalizeDisabledChecks(c, source.disabledChecks, `${path}.disabledChecks`, legacy),
    // Issue 177: only when the block declared one. A block that never did keeps
    // no key, so a project from before this setting is byte-identical.
    ...(timeoutSeconds !== null ? { timeoutSeconds } : {}),
    // Being a `SETTINGS_KEYS` member only silences the unknown-key warning — the
    // value still has to be READ here or it is silently dropped on save, and the
    // block runs without the setting the user made. Both of these shipped in that
    // state (issue 174's core-correlation choice and issue 173's dipole opt-in),
    // which is the same defect as issue 181 in a different list. Absent by
    // default, so a project that never set them serialises exactly as before.
    ...(freezeCore !== null ? { freezeCore } : {}),
    ...(recordTransitionDipoles !== null ? { recordTransitionDipoles } : {}),
  };
}

function normalizeOutputRef(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be null or an object with file and size.');
    return null;
  }
  const file = readString(c, raw.file, `${path}.file`, { legacy, fallback: '', max: 128, required: true });
  if (file && !OUTPUT_NAME.test(file)) {
    c.error(`${path}.file`, 'must be a safe .out or .log basename.');
  }
  return {
    file,
    size: readString(c, raw.size, `${path}.size`, { legacy, fallback: '', max: 32 }),
  };
}

/**
 * Issue 169: the linkage rule of a series block.
 *
 * Shape only — donor/acceptor are 1-based atom indices, the bond length is a
 * number, `leaving` is a list of 1-based indices. Whether those atoms exist and
 * whether the linkage can be built is checked against the unit record in
 * `validateFlow`, because it needs the geometry. Both bounds here are
 * deliberately wider than the scientific ones (0.5–4 Å, at most 24 members) so
 * the refusal the user sees is the one that explains the chemistry instead of a
 * generic range message.
 */
function normalizeSeriesLinkage(c, raw, path, legacy) {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, new Set(['donor', 'acceptor', 'bondLengthAngstrom', 'leaving']), path);
  const leavingRaw = Array.isArray(source.leaving) ? source.leaving : [];
  if (source.leaving !== undefined && source.leaving !== null && !Array.isArray(source.leaving)) {
    c.error(`${path}.leaving`, 'must be an array of atom indices.');
  }
  if (leavingRaw.length > 32) {
    c.error(`${path}.leaving`, 'must list at most 32 leaving atoms.');
  }
  const leaving = [];
  for (const [index, value] of leavingRaw.slice(0, 32).entries()) {
    const atom = readInteger(c, value, `${path}.leaving[${index}]`, { legacy, fallback: 1, min: 1, max: LIMITS.atoms });
    if (!leaving.includes(atom)) leaving.push(atom);
  }
  return {
    // Required, not defaulted: a linkage is a claim about specific atoms and a
    // specific bond, and a guess here would produce a plausible geometry that
    // nobody asked for.
    donor: readInteger(c, source.donor, `${path}.donor`, { min: 1, max: LIMITS.atoms }),
    acceptor: readInteger(c, source.acceptor, `${path}.acceptor`, { min: 1, max: LIMITS.atoms }),
    bondLengthAngstrom: readNumber(c, source.bondLengthAngstrom, `${path}.bondLengthAngstrom`, {
      min: 0.1, max: 10,
    }),
    leaving,
  };
}

/**
 * Issue 169: a series definition on an `input` block — which record is the
 * repeat unit, the range of n, and the linkage that joins copy i to copy i+1.
 * `null` means "this is a normal dataset block", which is what every project
 * written before the field existed says.
 */
function normalizeSeries(c, raw, path, legacy) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be null or an object with from, to and linkage.');
    return null;
  }
  warnUnknown(c, raw, new Set(['from', 'to', 'linkage']), path);
  // The range is part of the definition, so both ends are required: defaulting
  // either would silently change how many molecules the block claims to make.
  const from = readInteger(c, raw.from, `${path}.from`, { min: 1, max: 1000 });
  const to = readInteger(c, raw.to, `${path}.to`, { min: 1, max: 1000 });
  if (Number.isInteger(from) && Number.isInteger(to) && to < from) {
    c.error(path, `is empty: n runs from ${from} to ${to}.`);
  }
  return {
    from,
    to,
    linkage: normalizeSeriesLinkage(c, raw.linkage, `${path}.linkage`, legacy),
  };
}

/**
 * Issue 189: one graph edit of a derivative block.
 *
 * Shape only, deliberately. Which elements an op needs, whether an index is in
 * range for this structure, whether a valence is free — all of that is checked
 * against the parent record by `applyEdits()` in `derivative.js`, and its
 * message is what the user sees. Restating the rules here would be a second
 * copy that drifts; the bounds below are wide on purpose, so a refusal explains
 * the chemistry instead of a generic range message.
 */
function normalizeDerivativeEdit(c, raw, path, legacy) {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, new Set(['op', 'atom', 'element', 'mass', 'charge', 'multiplicity']), path);
  const op = readEnum(c, source.op, DERIVATIVE_OPS, `${path}.op`, { legacy, fallback: '', required: true });
  if (!op) return null;
  const atom = readInteger(c, source.atom, `${path}.atom`, {
    legacy, fallback: 0, min: 1, max: LIMITS.atoms,
  });
  const element = readString(c, source.element, `${path}.element`, { legacy, fallback: '', max: 3 });
  const optional = (value, label, min, max) => {
    if (value === undefined || value === null || value === '') return null;
    return readInteger(c, value, `${path}.${label}`, { legacy, fallback: null, min, max });
  };
  const mass = optional(source.mass, 'mass', 1, 400);
  const charge = optional(source.charge, 'charge', -10, 10);
  const multiplicity = optional(source.multiplicity, 'multiplicity', 1, 10);
  return {
    op,
    atom,
    ...(element ? { element } : {}),
    ...(mass === null ? {} : { mass }),
    ...(charge === null ? {} : { charge }),
    ...(multiplicity === null ? {} : { multiplicity }),
  };
}

/**
 * Issue 189: the edit list of a derivative block. `[]` means "this is a normal
 * dataset block", which is what every project written before the field existed
 * says — so the key stays absent from a project that never asked for it.
 */
function normalizeDerivativeEdits(c, raw, path, legacy, kind) {
  if (raw === undefined || raw === null) {
    if (kind === 'derivative') {
      c.error(path, 'is required when the block kind is "derivative".');
    }
    return [];
  }
  if (!Array.isArray(raw)) {
    c.error(path, 'must be an array of { op, atom, … } edits.');
    return [];
  }
  if (raw.length === 0) {
    c.error(path, 'must contain at least one edit; an empty list has no structure to build.');
    return [];
  }
  if (raw.length > DERIVATIVE_MAX_EDITS) {
    c.error(path, `must contain at most ${DERIVATIVE_MAX_EDITS} edits.`);
    return [];
  }
  const edits = [];
  raw.slice(0, DERIVATIVE_MAX_EDITS).forEach((entry, index) => {
    const edit = normalizeDerivativeEdit(c, entry, `${path}[${index}]`, legacy);
    if (edit) edits.push(edit);
  });
  return edits;
}

/**
 * Issue 188: one member of a complex block — which dataset and record it comes
 * from, and the charge/multiplicity that member contributes.
 *
 * Shape only. Whether the record exists, carries coordinates and can be placed
 * is checked against the records themselves by `expandComplex()`, whose message
 * is what the user sees.
 */
function normalizeComplexMember(c, raw, path, legacy) {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, new Set(['datasetId', 'recordId', 'charge', 'multiplicity']), path);
  const datasetId = readString(c, source.datasetId, `${path}.datasetId`, { legacy, fallback: '', max: 64 });
  if (datasetId && !GRAPH_ID_RE.test(datasetId)) {
    c.error(`${path}.datasetId`, 'must be a dataset id: letters, digits, dot, underscore or dash.');
  }
  const recordId = readString(c, source.recordId, `${path}.recordId`, { legacy, fallback: '', max: 64 });
  if (!recordId) {
    c.error(`${path}.recordId`, 'is required; a complex member names the record it places.');
  } else if (!RECORD_ID_RE.test(recordId)) {
    c.error(`${path}.recordId`, 'must be a record id: letters, digits, dot, underscore or dash.');
  }
  const optional = (value, label, min, max) => {
    if (value === undefined || value === null || value === '') return null;
    return readInteger(c, value, `${path}.${label}`, { legacy, fallback: null, min, max });
  };
  const charge = optional(source.charge, 'charge', -10, 10);
  const multiplicity = optional(source.multiplicity, 'multiplicity', 1, 10);
  return {
    ...(datasetId ? { datasetId } : {}),
    recordId,
    ...(charge === null ? {} : { charge }),
    ...(multiplicity === null ? {} : { multiplicity }),
  };
}

/**
 * Issue 188: how a complex places its members — the mode and its parameters.
 *
 * Shape only. A zero axis and a separation the chemistry forbids are refused by
 * `expandComplex()`, which can name the members those numbers belong to.
 */
function normalizeComplexPlacement(c, raw, path, legacy) {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, new Set(['mode', 'axis', 'distanceAngstrom', 'angleDegrees']), path);
  const mode = readEnum(c, source.mode, COMPLEX_PLACEMENT_MODES, `${path}.mode`, { legacy, fallback: 'as-drawn' });
  let axis = null;
  if (Array.isArray(source.axis)) {
    if (source.axis.length !== 3) {
      c.error(`${path}.axis`, 'must be three numbers, such as [1, 0, 0].');
    } else {
      axis = source.axis.map((value, index) => readNumber(c, value, `${path}.axis[${index}]`, {
        legacy, fallback: 0, min: -1000, max: 1000,
      }));
    }
  } else if (source.axis !== undefined && source.axis !== null) {
    c.error(`${path}.axis`, 'must be three numbers, such as [1, 0, 0].');
  } else if (mode === 'axis') {
    c.error(`${path}.axis`, 'is required when the placement mode is "axis".');
  }
  const needsDistance = mode === 'axis' || mode === 'principal';
  let distanceAngstrom = null;
  if (source.distanceAngstrom === undefined || source.distanceAngstrom === null || source.distanceAngstrom === '') {
    if (needsDistance) c.error(`${path}.distanceAngstrom`, `is required when the placement mode is "${mode}".`);
  } else {
    distanceAngstrom = readNumber(c, source.distanceAngstrom, `${path}.distanceAngstrom`, {
      legacy, fallback: null, min: 0.1, max: 100,
    });
  }
  const angleDegrees = mode === 'axis'
    ? readNumber(c, source.angleDegrees, `${path}.angleDegrees`, { legacy, fallback: 0, min: -360, max: 360 })
    : null;
  return {
    mode,
    ...(axis ? { axis } : {}),
    ...(distanceAngstrom === null ? {} : { distanceAngstrom }),
    ...(angleDegrees === null ? {} : { angleDegrees }),
  };
}

/**
 * Issue 188: the definition of a complex block. `null` means "this is a normal
 * dataset block", which is what every project written before the field existed
 * says — so the key stays absent from a project that never asked for it.
 */
function normalizeComplex(c, raw, path, legacy, kind) {
  if (raw === undefined || raw === null) {
    if (kind === 'complex') {
      c.error(path, 'is required when the block kind is "complex".');
    }
    return null;
  }
  if (!isPlainObject(raw)) {
    c.error(path, 'must be an object with members and placement.');
    return null;
  }
  warnUnknown(c, raw, new Set(['members', 'placement', 'homodimer']), path);
  const membersRaw = raw.members;
  if (!Array.isArray(membersRaw)) {
    c.error(`${path}.members`, 'must be an array of { recordId, … } members.');
    return null;
  }
  if (membersRaw.length < 2) {
    c.error(`${path}.members`, 'must contain at least two members; one record on its own is a plain dataset block.');
  }
  if (membersRaw.length > COMPLEX_MAX_MEMBERS) {
    c.error(`${path}.members`, `must contain at most ${COMPLEX_MAX_MEMBERS} members.`);
  }
  const members = membersRaw.slice(0, COMPLEX_MAX_MEMBERS)
    .map((entry, index) => normalizeComplexMember(c, entry, `${path}.members[${index}]`, legacy));
  const placement = normalizeComplexPlacement(c, raw.placement, `${path}.placement`, legacy);
  const homodimer = raw.homodimer === undefined || raw.homodimer === null
    ? false
    : readBoolean(c, raw.homodimer, `${path}.homodimer`, { legacy, fallback: false });
  return {
    members,
    placement,
    ...(homodimer ? { homodimer: true } : {}),
  };
}

function normalizeNode(c, raw, index, legacy, projectEngine = 'gaussian', basePath = 'nodes') {
  const path = `${basePath}[${index}]`;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be an object.');
    return null;
  }
  const type = readEnum(c, raw.type, NODE_TYPES, `${path}.type`, { legacy, fallback: '', required: true });
  if (!type) return null;
  const id = readId(c, raw.id, `${path}.id`);
  if (!id) return null;

  warnUnknown(c, raw, new Set([...NODE_COMMON_KEYS, ...NODE_TYPE_KEYS[type]]), path);

  const settingsRaw = isPlainObject(raw.settings) ? raw.settings : {};
  const kindFallback = type === 'calculate' ? kindForJob(settingsRaw.jobType || 'Opt') : TYPE_KINDS[type];
  const common = {
    id,
    type,
    kind: readString(c, raw.kind, `${path}.kind`, { legacy, fallback: kindFallback, max: 32 }) || kindFallback,
    title: readString(c, raw.title, `${path}.title`, { legacy, fallback: TYPE_LABELS[type], max: 120, required: true }) || TYPE_LABELS[type],
    state: readEnum(c, raw.state, NODE_STATES, `${path}.state`, { legacy, fallback: 'ready' }),
    x: readNumber(c, raw.x, `${path}.x`, { legacy, fallback: 0, min: -100000, max: 100000 }),
    y: readNumber(c, raw.y, `${path}.y`, { legacy, fallback: 0, min: -100000, max: 100000 }),
  };

  if (type === 'calculate') {
    const checkpointFromRaw = raw.checkpointFrom;
    const checkpointFrom = checkpointFromRaw === undefined || checkpointFromRaw === null || checkpointFromRaw === ''
      ? null
      : readId(c, checkpointFromRaw, `${path}.checkpointFrom`) || null;
    return {
      ...common,
      settings: normalizeSettings(c, raw.settings, `${path}.settings`, legacy, projectEngine),
      output: normalizeOutputRef(c, raw.output, `${path}.output`, legacy),
      checkpointFrom,
    };
  }

  if (type === 'condition') {
    const source = requiredObject(c, raw.condition, `${path}.condition`, legacy, {});
    warnUnknown(c, source, new Set(['expression', 'unknown', 'notes']), `${path}.condition`);
    const expression = readString(c, source.expression, `${path}.condition.expression`, { legacy, fallback: '', max: 4000 });
    if (!expression) c.warn(`${path}.condition.expression`, 'is empty; the condition cannot be evaluated.');
    return {
      ...common,
      condition: {
        expression,
        unknown: readEnum(c, source.unknown, CONDITION_UNKNOWN, `${path}.condition.unknown`, { legacy, fallback: 'block-both' }),
        notes: readString(c, source.notes, `${path}.condition.notes`, { legacy, fallback: '', max: 2000 }),
      },
    };
  }

  if (type === 'loop') {
    const source = requiredObject(c, raw.loop, `${path}.loop`, legacy, {});
    warnUnknown(c, source, new Set(['maxAttempts', 'mode', 'target', 'until']), `${path}.loop`);
    const targetRaw = source.target;
    const target = targetRaw === undefined || targetRaw === null || targetRaw === ''
      ? ''
      : readId(c, targetRaw, `${path}.loop.target`);
    return {
      ...common,
      loop: {
        maxAttempts: readInteger(c, source.maxAttempts, `${path}.loop.maxAttempts`, { legacy, fallback: 3, min: 1, max: 99 }),
        mode: readEnum(c, source.mode, LOOP_MODES, `${path}.loop.mode`, { legacy, fallback: 'retry' }),
        target,
        until: readString(c, source.until, `${path}.loop.until`, { legacy, fallback: 'condition is false', max: 200 }) || 'condition is false',
      },
    };
  }

  if (type === 'merge') {
    const source = requiredObject(c, raw.merge, `${path}.merge`, legacy, {});
    warnUnknown(c, source, new Set(['policy', 'notes']), `${path}.merge`);
    return {
      ...common,
      merge: {
        policy: readEnum(c, source.policy, MERGE_POLICIES, `${path}.merge.policy`, { legacy, fallback: 'all' }),
        notes: readString(c, source.notes, `${path}.merge.notes`, { legacy, fallback: '', max: 2000 }),
      },
    };
  }

  if (type === 'output') {
    const source = requiredObject(c, raw.output, `${path}.output`, legacy, {});
    warnUnknown(c, source, new Set(['kind', 'path', 'include', 'bundle', 'manifest', 'notes']), `${path}.output`);
    const kind = readEnum(c, source.kind, OUTPUT_KINDS, `${path}.output.kind`, { legacy, fallback: 'zip' });
    const bundleName = readString(c, source.bundle, `${path}.output.bundle`, { legacy, fallback: 'project.zip', max: 120 }) || 'project.zip';
    if (!BUNDLE_NAME.test(bundleName)) {
      c.error(`${path}.output.bundle`, 'must be a .zip file name without path separators.');
    }
    // RFC 0001: `path` is the artifact this block writes; a v1 file has no path
    // and keeps meaning "the zip named by `bundle`".
    const fallbackPath = kind === 'zip' ? bundleName : DEFAULT_OUTPUT_PATHS[kind];
    const artifactPath = readString(c, source.path, `${path}.output.path`, { legacy, fallback: fallbackPath, max: 160 }) || fallbackPath;
    if (!ARTIFACT_PATH.test(artifactPath) || artifactPath.split('/').includes('..')) {
      c.error(`${path}.output.path`, 'must be a relative path inside the output folder, without "..".');
    } else if (!artifactPath.toLowerCase().endsWith(OUTPUT_EXTENSIONS[kind])) {
      c.error(`${path}.output.path`, `must end in ${OUTPUT_EXTENSIONS[kind]} for a ${kind} output.`);
    }
    return {
      ...common,
      output: {
        kind,
        path: artifactPath,
        include: readEnum(c, source.include, OUTPUT_INCLUDES, `${path}.output.include`, { legacy, fallback: 'records' }),
        bundle: bundleName,
        manifest: readBoolean(c, source.manifest, `${path}.output.manifest`, { legacy, fallback: true }),
        notes: readString(c, source.notes, `${path}.output.notes`, { legacy, fallback: '', max: 2000 }),
      },
    };
  }

  if (type === 'input') {
    const source = requiredObject(c, raw.input, `${path}.input`, legacy, {});
    warnUnknown(c, source, new Set(['datasetId', 'recordFilter', 'recordId', 'series', 'edits', 'complex']), `${path}.input`);
    const datasetId = readString(c, source.datasetId, `${path}.input.datasetId`, { legacy, fallback: '', max: 64, required: true });
    if (datasetId && !GRAPH_ID_RE.test(datasetId)) {
      c.error(`${path}.input.datasetId`, 'must be a dataset id: letters, digits, dot, underscore or dash.');
    }
    const filterRaw = isPlainObject(source.recordFilter) ? source.recordFilter : {};
    // Issue 169: the repeat unit, when the block is a series. One record id, not
    // an array: a chain has one unit, and letting two records share the role
    // would make the member list depend on dataset order.
    const recordId = readString(c, source.recordId, `${path}.input.recordId`, { legacy, fallback: '', max: 64 });
    if (recordId && !RECORD_ID_RE.test(recordId)) {
      c.error(`${path}.input.recordId`, 'must be a record id: letters, digits, dot, underscore or dash.');
    }
    const series = normalizeSeries(c, source.series, `${path}.input.series`, legacy);
    if (!series && common.kind === 'series') {
      c.error(`${path}.input.series`, 'is required when the block kind is "series".');
    }
    // Issue 189: the same field names the parent record of a derivative block;
    // without one the block fans out over every enabled record.
    const edits = normalizeDerivativeEdits(c, source.edits, `${path}.input.edits`, legacy, common.kind);
    // Issue 188: a complex block combines several records into one system. Its
    // members name their own records, so `recordId` (one parent) does not apply.
    const complex = normalizeComplex(c, source.complex, `${path}.input.complex`, legacy, common.kind);
    const definitions = [series, edits.length ? edits : null, complex].filter(Boolean).length;
    if (series && edits.length) {
      c.error(`${path}.input`, 'cannot carry both a series definition and an edit list; a block is one kind of structure block.');
    } else if (definitions > 1) {
      c.error(`${path}.input`, 'cannot carry more than one of a series definition, an edit list and a complex'
        + ' definition; a block is one kind of structure block.');
    }
    return {
      ...common,
      // A block that carries a series definition *is* a series block, and one
      // that carries an edit list *is* a derivative block; the kind is stored so
      // a renderer can branch on one key instead of two.
      ...(series ? { kind: 'series' } : edits.length ? { kind: 'derivative' } : complex ? { kind: 'complex' } : {}),
      input: {
        datasetId,
        recordFilter: {
          field: readString(c, filterRaw.field, `${path}.input.recordFilter.field`, { legacy, fallback: '', max: 64 }),
          equals: readString(c, filterRaw.equals, `${path}.input.recordFilter.equals`, { legacy, fallback: '', max: 200 }),
        },
        // All four are absent-by-default: a project that never asked for a
        // series, a derivative or a complex saves exactly the bytes it did before.
        ...(recordId ? { recordId } : {}),
        ...(series ? { series } : {}),
        ...(edits.length ? { edits } : {}),
        ...(complex ? { complex } : {}),
      },
    };
  }

  if (type === 'generate') {
    return {
      ...common,
      settings: normalizeConformerSettings(c, raw.settings, `${path}.settings`, legacy),
      output: normalizeConformerOutput(c, raw.output, `${path}.output`, legacy),
    };
  }

  if (type === 'analyse') {
    // Issue 175: an analyse block is arithmetic over other blocks' results. Its
    // expression is parsed at save time, so a project that cannot be evaluated
    // is refused here rather than at the end of a queue.
    //
    // Issue 165: the same block carries DP4+ probabilities when `mode` is
    // `dp4`. Absent `mode` is the expression block byte for byte, so every
    // project written before this existed saves exactly as it did.
    const source = requiredObject(c, raw.analyse, `${path}.analyse`, legacy, {});
    warnUnknown(c, source, new Set(['mode', 'expression', 'inputs', 'notes', 'dp4']), `${path}.analyse`);
    const mode = source.mode === 'dp4' ? DP4_COMPUTE_MODE : 'expression';
    if (source.mode !== undefined && source.mode !== 'dp4' && source.mode !== 'expression') {
      c.error(`${path}.analyse.mode`, 'must be "expression" (the default) or "dp4".');
    }
    if (mode === 'dp4') {
      const checked = validateDp4Definition(source.dp4);
      for (const problem of checked.errors) {
        c.error(`${path}.analyse.dp4${problem.path ? `.${problem.path}` : ''}`, problem.message);
      }
      if (Array.isArray(source.inputs) && source.inputs.length) {
        c.error(`${path}.analyse.inputs`, 'a DP4+ block reads whole run records, not fields; wire the blocks whose candidates it compares and leave the input list empty.');
      }
      if (String(source.expression ?? '').trim()) {
        c.warn(`${path}.analyse.expression`, 'is not saved or evaluated by a DP4+ block: DP4+ reads candidate run records, not an expression.');
      }
      return {
        ...common,
        analyse: {
          mode: 'dp4',
          dp4: dp4DefinitionForFile(source.dp4),
        },
      };
    }
    const expression = readString(c, source.expression, `${path}.analyse.expression`,
      { legacy, fallback: '', max: COMPUTE_EXPRESSION_MAX });
    const rawInputs = Array.isArray(source.inputs) ? source.inputs : [];
    if (rawInputs.length > COMPUTE_INPUTS_MAX) {
      c.error(`${path}.analyse.inputs`, `must contain at most ${COMPUTE_INPUTS_MAX} inputs.`);
    }
    const inputs = rawInputs.slice(0, COMPUTE_INPUTS_MAX).map((entry, position) => {
      const inputPath = `${path}.analyse.inputs[${position}]`;
      const input = isPlainObject(entry) ? entry : {};
      if (!isPlainObject(entry)) c.error(inputPath, 'must be an object.');
      warnUnknown(c, input, new Set(['name', 'field', 'source', 'scope']), inputPath);
      const field = readString(c, input.field, `${inputPath}.field`, { legacy, fallback: '', max: 64 });
      if (field && !COMPUTE_FIELD_KEYS.includes(field)) {
        c.error(`${inputPath}.field`, `must be one of ${COMPUTE_FIELD_KEYS.join(', ')}.`);
      }
      const sourceId = readString(c, input.source, `${inputPath}.source`, { legacy, fallback: '', max: 64 });
      if (sourceId && !GRAPH_ID_RE.test(sourceId)) {
        c.error(`${inputPath}.source`, 'must be a block id: letters, digits, dot, underscore or dash.');
      }
      return {
        name: readString(c, input.name, `${inputPath}.name`, { legacy, fallback: '', max: 64, required: true }),
        field,
        source: sourceId,
        // Absent means "this record": the default a single-value protocol wants.
        ...(input.scope === 'records' ? { scope: 'records' } : {}),
      };
    });
    try {
      const declared = computeInputsOf({ expression, inputs });
      if (expression) {
        const names = identifiersOf(parseExpression(expression));
        const known = new Set(declared.map((input) => input.name));
        for (const name of names) {
          if (!known.has(name)) {
            c.error(`${path}.analyse.expression`, `uses "${name}", which is not a declared input.`);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof ComputeError)) throw error;
      c.error(`${path}.analyse.expression`, error.message);
    }
    if (!expression) {
      c.warn(`${path}.analyse.expression`, 'is empty; the block cannot be evaluated.');
    }
    return {
      ...common,
      analyse: {
        expression,
        inputs,
      },
    };
  }

  const noteSource = requiredObject(c, raw.note, `${path}.note`, legacy, {});
  warnUnknown(c, noteSource, new Set(['text']), `${path}.note`);
  return {
    ...common,
    note: {
      text: readString(c, noteSource.text, `${path}.note.text`, { legacy, fallback: '', max: 8000 }),
    },
  };
}

function normalizeEdges(c, raw, nodeIds, legacy, basePath = 'edges') {
  if (!Array.isArray(raw)) {
    c.error(basePath, 'must be an array.');
    return [];
  }
  if (raw.length > LIMITS.edges) {
    c.error(basePath, `must contain at most ${LIMITS.edges} connections.`);
    return [];
  }
  const seen = new Set();
  const edges = [];
  raw.forEach((edge, index) => {
    const path = `${basePath}[${index}]`;
    if (!isPlainObject(edge)) {
      c.error(path, 'must be an object.');
      return;
    }
    warnUnknown(c, edge, new Set(['from', 'to', 'type', 'branch', 'fromPort', 'toPort']), path);
    const from = readId(c, edge.from, `${path}.from`);
    const to = readId(c, edge.to, `${path}.to`);
    const type = readEnum(c, edge.type, EDGE_TYPES, `${path}.type`, { legacy, fallback: 'dependency' });
    if (!from || !to) return;
    if (!nodeIds.has(from)) c.error(`${path}.from`, `references unknown node "${from}".`);
    if (!nodeIds.has(to)) c.error(`${path}.to`, `references unknown node "${to}".`);
    if (from === to) c.error(path, 'must not connect a node to itself.');

    let branch;
    if (type === 'branch') {
      // Structural, not defaultable: a branch edge is meaningless without its branch.
      if (!BRANCHES.includes(edge.branch)) {
        c.error(`${path}.branch`, 'must be "true" or "false" on a branch connection.');
        return;
      }
      branch = edge.branch;
    } else if (edge.branch !== undefined) {
      c.warn(`${path}.branch`, 'is only used by branch connections; ignored.');
    }

    const identity = `${from}->${to}:${type}${branch ? `:${branch}` : ''}`;
    if (seen.has(identity)) {
      c.error(path, `duplicates the ${type} connection ${from} -> ${to}.`);
      return;
    }
    seen.add(identity);

    const normalized = { from, to, type };
    if (branch) normalized.branch = branch;
    for (const key of ['fromPort', 'toPort']) {
      const value = edge[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !PORT.test(value)) {
        c.error(`${path}.${key}`, 'must be a short port name.');
        continue;
      }
      normalized[key] = value;
    }
    edges.push(normalized);
  });
  return edges;
}

/* ── Flows, datasets, runner, reports (RFC 0001) ─────────── */

function normalizeGraphNodes(c, raw, legacy, projectEngine, basePath) {
  if (!Array.isArray(raw)) {
    c.error(basePath, 'must be an array of nodes.');
    return [];
  }
  if (raw.length > LIMITS.nodes) {
    c.error(basePath, `must contain at most ${LIMITS.nodes} nodes.`);
  }
  const ids = new Set();
  const nodes = [];
  raw.slice(0, LIMITS.nodes).forEach((nodeRaw, index) => {
    const node = normalizeNode(c, nodeRaw, index, legacy, projectEngine, basePath);
    if (!node) return;
    if (ids.has(node.id)) {
      c.error(`${basePath}[${index}].id`, `duplicate node id "${node.id}".`);
      return;
    }
    ids.add(node.id);
    nodes.push(node);
  });
  return nodes;
}

function normalizeFlow(c, raw, index, legacy, projectEngine) {
  const path = `flows[${index}]`;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be an object.');
    return null;
  }
  warnUnknown(c, raw, new Set(['id', 'title', 'nodes', 'edges']), path);
  const id = readString(c, raw.id, `${path}.id`, { legacy, fallback: '', max: 64, required: true });
  if (id && !GRAPH_ID_RE.test(id)) {
    c.error(`${path}.id`, 'must be a flow id: letters, digits, dot, underscore or dash, starting with a letter or digit.');
  }
  const nodes = normalizeGraphNodes(c, raw.nodes, legacy, projectEngine, `${path}.nodes`);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = normalizeEdges(c, raw.edges, nodeIds, legacy, `${path}.edges`);
  return {
    id: id || `flow${index + 1}`,
    title: readString(c, raw.title, `${path}.title`, { legacy, fallback: 'Workflow', max: 120 }) || 'Workflow',
    nodes,
    edges,
  };
}

function normalizeDatasetRecord(c, raw, datasetPath, index, legacy) {
  const path = `${datasetPath}.records[${index}]`;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be an object.');
    return null;
  }
  warnUnknown(c, raw, new Set(['id', 'label', 'charge', 'multiplicity', 'coords', 'bonds', 'enabled', 'source', 'geometry', 'drawingConfirmed']), path);
  const id = readString(c, raw.id, `${path}.id`, { legacy, fallback: '', max: 64, required: true });
  if (!id || !RECORD_ID_RE.test(id)) {
    c.error(`${path}.id`, 'must be a record id: letters, digits, dot, underscore or dash, starting with a letter or digit.');
    return null;
  }
  const coords = normalizeCoords(c, raw.coords, legacy, `${path}.coords`);
  if (coords.length === 0) {
    c.error(`${path}.coords`, 'must contain at least one atom: a record without a geometry cannot run.');
  }
  // Issue 189: a record may state its topology. Absent means "never stated",
  // which is what every record written before this key says — and the derivative
  // block refuses a parent without it rather than perceiving bonds from
  // distances, because a valence check built on a guess is not a check.
  const bonds = normalizeBonds(c, raw.bonds, legacy, coords.length, `${path}.bonds`);
  // Issue 139: a record imported from a CDXML drawing says its coordinates are
  // a depiction, not a geometry. A record that states no dimension — every SDF,
  // XYZ, CSV and JSON record — is written exactly as before.
  const geometryRaw = isPlainObject(raw.geometry) ? raw.geometry : null;
  if (raw.geometry !== undefined && raw.geometry !== null && !geometryRaw) {
    c.error(`${path}.geometry`, 'must be an object with a dimension.');
  }
  let dimension = '';
  if (geometryRaw) {
    warnUnknown(c, geometryRaw, new Set(['dimension']), `${path}.geometry`);
    dimension = readEnum(c, geometryRaw.dimension, GEOMETRY_DIMENSIONS, `${path}.geometry.dimension`, { legacy, fallback: '' });
  }
  // Issue 139: the user's answer to the run gate. Only a drawing record's
  // confirmation has any effect (the gate reads it there), and only the
  // confirmation is stored — false is the default, so an untouched record stays
  // byte-identical.
  const drawingConfirmed = readBoolean(c, raw.drawingConfirmed, `${path}.drawingConfirmed`, { legacy, fallback: false, optional: true }) === true;
  return {
    id,
    label: readString(c, raw.label, `${path}.label`, { legacy, fallback: id, max: 200 }) || id,
    charge: readInteger(c, raw.charge, `${path}.charge`, { legacy, fallback: 0, min: -10, max: 10 }),
    multiplicity: readInteger(c, raw.multiplicity, `${path}.multiplicity`, { legacy, fallback: 1, min: 1, max: 10 }),
    coords,
    ...(bonds.length ? { bonds } : {}),
    ...(dimension ? { geometry: { dimension } } : {}),
    ...(drawingConfirmed ? { drawingConfirmed: true } : {}),
    enabled: readBoolean(c, raw.enabled, `${path}.enabled`, { legacy, fallback: true, optional: true }),
  };
}

function normalizeDataset(c, raw, index, legacy) {
  const path = `datasets[${index}]`;
  if (!isPlainObject(raw)) {
    c.error(path, 'must be an object.');
    return null;
  }
  warnUnknown(c, raw, new Set(['id', 'title', 'source', 'fields', 'records', 'notes']), path);
  const id = readString(c, raw.id, `${path}.id`, { legacy, fallback: '', max: 64, required: true });
  if (!id || !GRAPH_ID_RE.test(id)) {
    c.error(`${path}.id`, 'must be a dataset id: letters, digits, dot, underscore or dash, starting with a letter or digit.');
    return null;
  }
  const source = isPlainObject(raw.source) ? raw.source : {};
  warnUnknown(c, source, new Set(['kind', 'path', 'format']), `${path}.source`);
  const kind = readEnum(c, source.kind, DATASET_SOURCES, `${path}.source.kind`, { legacy, fallback: 'file' });
  const sourcePath = readString(c, source.path, `${path}.source.path`, { legacy, fallback: '', max: 300 });
  if (kind === 'file') {
    if (!sourcePath) c.error(`${path}.source.path`, 'is required for a file dataset.');
    else if (!ARTIFACT_PATH.test(sourcePath) || sourcePath.split('/').includes('..')) {
      c.error(`${path}.source.path`, 'must be a relative path, without "..".');
    }
  }
  const fields = isPlainObject(raw.fields) ? raw.fields : {};
  warnUnknown(c, fields, new Set(['label', 'charge', 'multiplicity']), `${path}.fields`);

  const recordsRaw = raw.records;
  const records = [];
  if (recordsRaw !== undefined && recordsRaw !== null) {
    if (!Array.isArray(recordsRaw)) {
      c.error(`${path}.records`, 'must be an array of records.');
    } else if (recordsRaw.length > LIMITS.records) {
      c.error(`${path}.records`, `must contain at most ${LIMITS.records} records.`);
    } else {
      const seen = new Set();
      recordsRaw.slice(0, LIMITS.records).forEach((recordRaw, recordIndex) => {
        const record = normalizeDatasetRecord(c, recordRaw, path, recordIndex, legacy);
        if (!record) return;
        if (seen.has(record.id)) {
          c.error(`${path}.records[${recordIndex}].id`, `duplicate record id "${record.id}".`);
          return;
        }
        seen.add(record.id);
        records.push(record);
      });
    }
  }
  if (kind === 'inline' && records.length === 0) {
    c.error(`${path}.records`, 'must contain at least one record for an inline dataset.');
  }
  return {
    id,
    title: readString(c, raw.title, `${path}.title`, { legacy, fallback: id, max: 160 }) || id,
    source: {
      kind,
      path: kind === 'file' ? sourcePath : '',
      format: readEnum(c, source.format, DATASET_FORMATS, `${path}.source.format`, { legacy, fallback: 'sdf' }),
    },
    fields: {
      label: readString(c, fields.label, `${path}.fields.label`, { legacy, fallback: '', max: 64 }),
      charge: readString(c, fields.charge, `${path}.fields.charge`, { legacy, fallback: '', max: 64 }),
      multiplicity: readString(c, fields.multiplicity, `${path}.fields.multiplicity`, { legacy, fallback: '', max: 64 }),
    },
    records,
    notes: readString(c, raw.notes, `${path}.notes`, { legacy, fallback: '', max: 2000 }),
  };
}

function normalizeDatasets(c, raw, legacy, ids) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error('datasets', 'must be an array.');
    return [];
  }
  if (raw.length > 64) c.error('datasets', 'must contain at most 64 datasets.');
  const datasets = [];
  raw.slice(0, 64).forEach((datasetRaw, index) => {
    const dataset = normalizeDataset(c, datasetRaw, index, legacy);
    if (!dataset) return;
    if (ids.has(dataset.id)) {
      c.error(`datasets[${index}].id`, `duplicate dataset id "${dataset.id}".`);
      return;
    }
    ids.add(dataset.id);
    datasets.push(dataset);
  });
  return datasets;
}

function normalizeRunner(c, raw, legacy) {
  const source = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(source)) {
    c.error('runner', 'must be an object.');
    return { maxParallel: 1 };
  }
  warnUnknown(c, source, new Set(['maxParallel', 'timeoutSeconds']), 'runner');
  // Issue 177: the project's wall-clock limit for one queued task. Absent means
  // the built-in default (3600 s) applies at enforcement time; it is never
  // written back into the file, so an old project serialises unchanged.
  const timeoutSeconds = source.timeoutSeconds === undefined || source.timeoutSeconds === null || source.timeoutSeconds === ''
    ? null
    : readOptionalInteger(c, source.timeoutSeconds, 'runner.timeoutSeconds', {
      fallback: null, min: 1, max: LIMITS.timeoutSeconds,
    });
  return {
    // RFC 0001: 1 keeps the sequential drain every existing project has.
    maxParallel: readOptionalInteger(c, source.maxParallel, 'runner.maxParallel', {
      fallback: 1, min: 1, max: LIMITS.maxParallel,
    }),
    ...(timeoutSeconds !== null ? { timeoutSeconds } : {}),
  };
}

function normalizeReports(c, raw, legacy, flows) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error('reports', 'must be an array.');
    return [];
  }
  if (raw.length > 16) c.error('reports', 'must contain at most 16 combined reports.');
  const ids = new Set();
  const reports = [];
  raw.slice(0, 16).forEach((reportRaw, index) => {
    const path = `reports[${index}]`;
    if (!isPlainObject(reportRaw)) {
      c.error(path, 'must be an object.');
      return;
    }
    warnUnknown(c, reportRaw, new Set(['id', 'title', 'kind', 'flows', 'path']), path);
    const id = readString(c, reportRaw.id, `${path}.id`, { legacy, fallback: '', max: 64, required: true });
    if (!id || !GRAPH_ID_RE.test(id)) {
      c.error(`${path}.id`, 'must be a report id: letters, digits, dot, underscore or dash.');
      return;
    }
    if (ids.has(id)) {
      c.error(`${path}.id`, `duplicate report id "${id}".`);
      return;
    }
    ids.add(id);
    const flowIds = Array.isArray(reportRaw.flows) ? reportRaw.flows : [];
    const resolved = [];
    flowIds.forEach((flowId, flowIndex) => {
      if (typeof flowId !== 'string' || !flows.some((flow) => flow.id === flowId)) {
        c.error(`${path}.flows[${flowIndex}]`, `references unknown flow "${String(flowId)}".`);
        return;
      }
      resolved.push(flowId);
    });
    if (resolved.length === 0) c.error(`${path}.flows`, 'must name at least one flow.');
    const artifactPath = readString(c, reportRaw.path, `${path}.path`, { legacy, fallback: 'reports/index.html', max: 160 }) || 'reports/index.html';
    if (!ARTIFACT_PATH.test(artifactPath) || artifactPath.split('/').includes('..')) {
      c.error(`${path}.path`, 'must be a relative path inside the output folder, without "..".');
    } else if (!artifactPath.toLowerCase().endsWith('.html')) {
      c.error(`${path}.path`, 'must end in .html.');
    }
    reports.push({
      id,
      title: readString(c, reportRaw.title, `${path}.title`, { legacy, fallback: id, max: 160 }) || id,
      kind: 'html',
      flows: resolved,
      path: artifactPath,
    });
  });
  return reports;
}

/**
 * Per-flow integrity: references stay inside the flow, an input block names a
 * dataset that exists and has a runnable record, and a barrier joins real work.
 */
function validateFlow(c, flow, index, datasets, legacy, { molecule = null, projectEngine = 'gaussian' } = {}) {
  const path = `flows[${index}]`;
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));

  flow.nodes.forEach((node, nodeIndex) => {
    const nodePath = `${path}.nodes[${nodeIndex}]`;
    if (node.type === 'calculate' && node.checkpointFrom) {
      const source = byId.get(node.checkpointFrom);
      if (!source) {
        c.error(`${nodePath}.checkpointFrom`, `references unknown node "${node.checkpointFrom}".`);
        node.checkpointFrom = null;
      } else if (source.type !== 'calculate') {
        c.error(`${nodePath}.checkpointFrom`, `must reference a calculation node, not a ${source.type} node.`);
        node.checkpointFrom = null;
      }
    }
    if (node.type === 'loop' && node.loop.target) {
      const target = byId.get(node.loop.target);
      if (!target) {
        c.error(`${nodePath}.loop.target`, `references unknown node "${node.loop.target}".`);
        node.loop.target = '';
      } else if (target.type !== 'calculate') {
        c.error(`${nodePath}.loop.target`, `must target a calculation node, not a ${target.type} node.`);
        node.loop.target = '';
      }
    }
    if (node.type === 'input') {
      const dataset = datasets.find((entry) => entry.id === node.input.datasetId) || null;
      if (!dataset) {
        c.error(`${nodePath}.input.datasetId`, `references unknown dataset "${node.input.datasetId}".`);
      } else if (enabledRecords(dataset).length === 0) {
        c.error(`${nodePath}.input`, `dataset "${dataset.id}" has no enabled record; import or enable at least one.`);
      } else if (node.input.series || node.input.edits || node.input.complex) {
        // Issue 169: a series is expanded here, at validation time, exactly as
        // the plan will expand it — so an unusable linkage is refused by name
        // when the project is opened, not after the first input file is written.
        // Issue 189: the same guard for a derivative — every refusal comes from
        // the edit engine itself, so a missing bond, a valence overrun or an
        // unknown isotope is named when the project opens.
        // Issue 188: the same guard for a complex — a member with no geometry, a
        // clash or a separation below the contact floor is named here too.
        try {
          recordsForInput(node, dataset, { datasets });
        } catch (error) {
          const key = node.input.complex ? 'complex' : node.input.edits ? 'edits' : 'series';
          c.error(`${nodePath}.input.${key}`, error.message);
        }
      }
    }
    if (node.type !== 'calculate') return;
    const checkpointEdge = flow.edges.find((edge) => edge.to === node.id && edge.type === 'checkpoint');
    const upstream = checkpointEdge ? byId.get(checkpointEdge.from) || null : null;
    const { errors, warnings } = checkTsForceConstants({ settings: node.settings, upstream });
    errors.forEach((message) => c.error(`${nodePath}.settings.forceConstants`, message));
    warnings.forEach((message) => c.warn(`${nodePath}.settings.forceConstants`, message));
    optConvergenceWarnings(node.settings)
      .forEach((message) => c.warn(`${nodePath}.settings.grid`, message));
    freqGeometryWarnings({ settings: node.settings, upstream })
      .forEach((message) => c.warn(`${nodePath}.settings.jobType`, message));

    // Issue #93: constraints and QST structures are checked against the
    // geometry the project holds (a dataset record's coordinates replace it at
    // plan time, and the builder repeats the check against the written ones).
    const atoms = Array.isArray(molecule?.coords) ? molecule.coords : null;
    const engine = node.settings.engine || projectEngine;
    const constraintReport = constraintFindings({
      constraints: node.settings.constraints,
      atoms,
      jobType: node.settings.jobType,
      forceConstants: node.settings.forceConstants,
      engine,
    });
    constraintReport.errors.forEach((entry) => {
      const at = entry.index === null ? '' : `[${entry.index}]`;
      c.error(`${nodePath}.settings.constraints${at}`, entry.message);
    });
    constraintReport.warnings.forEach((message) => c.warn(`${nodePath}.settings.constraints`, message));

    const qstReport = qstFindings({
      qst: node.settings.qst,
      atoms,
      jobType: node.settings.jobType,
    });
    qstReport.errors.forEach((entry) => {
      const at = entry.index === null ? '' : `.structures[${entry.index}]`;
      c.error(`${nodePath}.settings.qst${at}`, entry.message);
    });
  });

  flow.edges.forEach((edge, edgeIndex) => {
    if (edge.type !== 'barrier') return;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from?.type === 'note' || to?.type === 'note') {
      c.error(`${path}.edges[${edgeIndex}]`, 'a barrier must join work, not a note.');
    }
  });
}

/* ── Public API ───────────────────────────────────────────── */

/**
 * Issue #25: run the pre-flight validity checks over a normalised project.
 *
 * Findings are reported in `validity`; warnings (and non-blocking failures) go
 * into the ordinary warning list. Blocking failures are *not* added to the
 * schema errors on purpose: a project file must stay openable and saveable so
 * the user can fix a geometry or a charge, and only a run (or an input export)
 * is meaningless. The renderer's Validate action and the input builder enforce
 * `validity.blocking`.
 */
function evaluateProjectValidity(c, { nodes, molecule, defaults, edges = [] }) {
  const findingsReport = [];
  const blocking = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node, index) => {
    if (node.type !== 'calculate') return;
    // The hand-off may be declared on the node (`checkpointFrom`) or by a
    // `checkpoint` edge; the excited-state check must see both, or a Pop=NTO
    // block fed by an edge would look unconnected (#146).
    const checkpointEdge = edges.find((edge) => edge.to === node.id && edge.type === 'checkpoint');
    const edgeSource = checkpointEdge ? byId.get(checkpointEdge.from) || null : null;
    const source = node.checkpointFrom ? byId.get(node.checkpointFrom) || edgeSource : edgeSource;
    const upstream = source ? {
      id: source.id,
      title: source.title,
      settings: source.settings,
      state: source.state,
      output: source.output,
      // The project file does not carry parsed output; a run record supplies
      // it when the queue evaluates the downstream job.
      parsed: null,
    } : null;

    const result = runValidityChecks({
      settings: node.settings,
      molecule,
      parsed: null,
      upstream,
    }, { phase: 'pre', engine: defaults.engine });

    for (const finding of result.findings) {
      const entry = { ...finding, nodeId: node.id };
      findingsReport.push(entry);
      const meta = VALIDITY_CHECKS.find((check) => check.id === finding.id);
      if (finding.status === CHECK_STATUS.FAIL && meta?.blocking) {
        blocking.push(entry);
      } else if (finding.status === CHECK_STATUS.WARNING
        || (finding.status === CHECK_STATUS.FAIL && !meta?.blocking)) {
        c.warn(`nodes[${index}].validity.${finding.id}`, finding.message);
      }
    }
  });

  return { overall: summarizeValidity(findingsReport).overall, findings: findingsReport, blocking };
}

export function validateProject(raw) {
  const c = createCollector();
  if (!isPlainObject(raw)) {
    c.error('', 'Project must be a JSON object.');
    return {
      ok: false,
      errors: c.errors,
      warnings: c.warnings,
      project: null,
      migrated: false,
      schemaVersion: 0,
      validity: { overall: 'unknown', findings: [], blocking: [] },
    };
  }

  warnUnknown(c, raw, TOP_LEVEL_KEYS, '');

  const rawVersion = raw.schemaVersion;
  let schemaVersion = SCHEMA_VERSION;
  if (rawVersion === undefined || rawVersion === null || rawVersion === 0) {
    schemaVersion = 0;
  } else if (!Number.isInteger(rawVersion) || rawVersion < 0) {
    c.error('schemaVersion', 'must be a positive integer.');
  } else if (rawVersion > SCHEMA_VERSION) {
    c.error('schemaVersion',
      `project uses schema version ${rawVersion}, but this build supports up to ${SCHEMA_VERSION}. Update NodeChem Studio to open it.`);
  } else {
    schemaVersion = rawVersion;
  }

  // ADR 0001 made schemaVersion 3 a breaking vocabulary change: the old block
  // types (`calc`, `conformers`, `compute`) no longer exist in this build, so
  // an older file is refused by version instead of being half-read into a
  // graph the validator would report as a list of unknown types.
  if (schemaVersion < SCHEMA_VERSION) {
    c.error('schemaVersion',
      `project uses schema version ${schemaVersion === 0 ? '0.1' : schemaVersion}; this build reads version ${SCHEMA_VERSION} only. `
      + 'ADR 0001 replaced the block vocabulary in version 3 with no compatibility layer; rebuild the project in NodeChem Studio.');
    return {
      ok: false,
      errors: c.errors,
      warnings: c.warnings,
      project: null,
      migrated: false,
      schemaVersion,
      validity: { overall: 'unknown', findings: [], blocking: [] },
    };
  }

  // Nothing older than this build's schema reaches the validators below.
  const migrated = false;
  const legacy = false;
  const projectEngine = projectEngineOf(raw.defaults);

  const datasetIds = new Set();
  const datasets = normalizeDatasets(c, raw.datasets, legacy, datasetIds);
  // Normalised once, before the flows: the per-block constraint and QST checks
  // need the geometry the flow runs on.
  const molecule = normalizeMolecule(c, raw.molecule, legacy);

  const flows = [];
  const rawFlows = Array.isArray(raw.flows) && raw.flows.length > 0 ? raw.flows : null;
  if (rawFlows) {
    if (rawFlows.length > LIMITS.flows) {
      c.error('flows', `must contain at most ${LIMITS.flows} flows.`);
    }
    // A caller may hand back the in-memory shape, where `nodes`/`edges` are the
    // active flow's graph (renderer state, history snapshot). Those arrays are
    // authoritative for that flow; the file itself never carries both.
    const activeRawId = typeof raw.activeFlowId === 'string' && raw.activeFlowId ? raw.activeFlowId : rawFlows[0].id;
    const withActiveGraph = (flowRaw) => {
      if (!isPlainObject(flowRaw) || flowRaw.id !== activeRawId || !Array.isArray(raw.nodes)) return flowRaw;
      return { ...flowRaw, nodes: raw.nodes, ...(Array.isArray(raw.edges) ? { edges: raw.edges } : {}) };
    };
    rawFlows.slice(0, LIMITS.flows).map(withActiveGraph).forEach((flowRaw, index) => {
      const flow = normalizeFlow(c, flowRaw, index, legacy, projectEngine);
      if (!flow) return;
      if (flows.some((entry) => entry.id === flow.id)) {
        c.error(`flows[${index}].id`, `duplicate flow id "${flow.id}".`);
        return;
      }
      flows.push(flow);
    });
    if (flows.length === 0) c.error('flows', 'must contain at least one flow.');
  } else {
    const nodes = normalizeGraphNodes(c, raw.nodes, legacy, projectEngine, 'nodes');
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = normalizeEdges(c, raw.edges, nodeIds, legacy);
    flows.push({ id: DEFAULT_FLOW_ID, title: 'Workflow', nodes, edges });
  }

  flows.forEach((flow, index) => validateFlow(c, flow, index, datasets, legacy, {
    molecule,
    projectEngine: projectEngineOf(raw.defaults),
  }));

  let activeFlowId = readString(c, raw.activeFlowId, 'activeFlowId', {
    legacy, fallback: flows[0]?.id || DEFAULT_FLOW_ID, max: 64,
  }) || flows[0]?.id || DEFAULT_FLOW_ID;
  if (!flows.some((flow) => flow.id === activeFlowId)) activeFlowId = flows[0]?.id || DEFAULT_FLOW_ID;

  const project = {
    schemaVersion: SCHEMA_VERSION,
    name: readString(c, raw.name, 'name', { legacy, fallback: 'Untitled project', max: 200 }) || 'Untitled project',
    molecule,
    defaults: normalizeDefaults(c, raw.defaults, legacy),
    runner: normalizeRunner(c, raw.runner, legacy),
    datasets,
    flows,
    reports: normalizeReports(c, raw.reports, legacy, flows),
    activeFlowId,
  };
  // `project.nodes` / `project.edges` are enumerable aliases of the active
  // flow, so every existing reader (renderer, planner, tests) sees the graph it
  // always saw; `stringifyProject` drops the aliases from the file.
  attachGraphAliases(project);

  const validity = evaluateProjectValidity(c, {
    nodes: project.nodes,
    molecule: project.molecule,
    defaults: project.defaults,
    edges: project.edges,
  });

  return {
    ok: c.ok,
    errors: c.errors,
    warnings: c.warnings,
    project: c.ok ? project : null,
    migrated,
    schemaVersion,
    validity,
  };
}

/**
 * Parse project text and validate it. Returns the same shape as
 * `validateProject`, with JSON/UTF-8/size failures reported as errors.
 */
export function parseProjectText(text) {
  if (typeof text !== 'string') {
    return failure('', 'Project file must be UTF-8 text.');
  }
  const source = text.replace(/^\uFEFF/, '');
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > MAX_PROJECT_BYTES) {
    return failure('', `Project file is ${(bytes / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_PROJECT_BYTES / (1024 * 1024)} MB.`);
  }
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return failure('', `Invalid JSON: ${error.message}`);
  }
  return validateProject(data);
}

/**
 * The file view of a normalized project.
 *
 * `nodes`/`edges` are in-memory aliases of the active flow (RFC 0001); writing
 * them too would duplicate the graph and let the two copies drift. A v2 file
 * carries `flows[]` only.
 */
export function projectFileView(project) {
  if (!isPlainObject(project)) return project;
  const { nodes, edges, ...rest } = project;
  return rest;
}

/** Canonical serialization: validate, normalize, then pretty-print. */
export function stringifyProject(raw) {
  const result = validateProject(raw);
  if (!result.ok) return { ...result, text: null };
  return { ...result, text: `${JSON.stringify(projectFileView(result.project), null, 2)}\n` };
}

function failure(path, message) {
  return {
    ok: false,
    errors: [{ path, message }],
    warnings: [],
    project: null,
    migrated: false,
    schemaVersion: 0,
    validity: { overall: 'unknown', findings: [], blocking: [] },
  };
}

/** One-line summary for dialogs and toasts. */
export function summarizeErrors(errors, limit = 3) {
  if (!Array.isArray(errors) || errors.length === 0) return 'Unknown validation error.';
  const shown = errors.slice(0, limit).map((error) => (error.path ? `${error.path}: ${error.message}` : error.message));
  const extra = errors.length - shown.length;
  return `${shown.join(' · ')}${extra > 0 ? ` · +${extra} more` : ''}`;
}
