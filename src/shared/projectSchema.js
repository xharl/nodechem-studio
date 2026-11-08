/**
 * Project file schema for NodeChem Studio.
 *
 * Pure module: no DOM, no filesystem, no Electron. Used by the main process
 * before a project is rendered, and by the renderer when it saves.
 *
 * Contract:
 *   - `schemaVersion: 2` is the current on-disk format: a project carries
 *     `flows[]` (one graph each) and `datasets[]` (record sets an `input` block
 *     iterates). A v1 project (single `nodes`/`edges` graph) migrates by
 *     wrapping that graph in a flow called `main`; its plans, task ids and run
 *     folders are byte-identical.
 *   - A project written before versioning (no `schemaVersion`, or 0) is
 *     treated as v0.1 and migrated by filling documented defaults.
 *   - A project from a newer build is rejected, never guessed at.
 *   - Validation collects every error with a JSON path; it does not throw.
 *   - The normalized project is canonical: the same input always yields the
 *     same key order, so a save/reopen round-trip is byte-stable.
 */

export const SCHEMA_VERSION = 2;

import { isElementSymbol } from './elements.js';
import {
  DEFAULT_FLOW_ID,
  GRAPH_ID_RE,
  RECORD_ID_RE,
  attachGraphAliases,
  edgesOfFlow,
  enabledRecords,
  flowsOf,
  isPlainObject as isPlainObjectValue,
  nodesOfFlow,
} from './flows.js';
import { MODERN_ROUTE_PRESET, COMPOSITE_JOB_TYPES, COUNTERPOISE_MAX_FRAGMENTS, clearCompositeConflicts, defaultDispersionFor, isCompositeJobType } from './routePresets.js';
import { ENGINE_IDS } from './engines/index.js';
import { XTB_METHODS, XTB_OPT_LEVELS, XTB_SOLVATION_MODELS } from './engines/xtb.js';
import {
  CONFORMER_ENERGY_UNITS,
  CONFORMER_GENERATORS,
  CONFORMER_METHODS,
  DEFAULT_CONFORMER_SETTINGS,
} from './conformers.js';
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
  errorsReported: 100,
  warningsReported: 200,
});

export const NODE_TYPES = Object.freeze([
  'input', 'calc', 'conformers', 'condition', 'loop', 'merge', 'output', 'note',
]);

/** States a project file may carry. Queue states are reserved for GN-003. */
export const NODE_STATES = Object.freeze([
  'ready', 'running', 'passed', 'review', 'blocked', 'failed', 'skipped', 'cancelled', 'interrupted',
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
]);
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
export const DATASET_FORMATS = Object.freeze(['sdf', 'xyz', 'csv', 'json']);
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
  conformers: 'Conformers',
  condition: 'If',
  loop: 'Loop',
  merge: 'Merge',
  output: 'Output',
  note: 'Note',
};

const TYPE_LABELS = {
  input: 'Dataset input',
  calc: 'Calculation',
  conformers: 'Conformer ensemble',
  condition: 'Condition',
  loop: 'Retry loop',
  merge: 'Join branches',
  output: 'Project output',
  note: 'Note',
};

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'name', 'molecule', 'defaults', 'runner', 'datasets', 'flows', 'reports', 'activeFlowId', 'nodes', 'edges']);
const NODE_COMMON_KEYS = new Set(['id', 'type', 'kind', 'title', 'state', 'x', 'y']);
const NODE_TYPE_KEYS = {
  input: new Set(['input']),
  calc: new Set(['settings', 'output', 'checkpointFrom']),
  conformers: new Set(['settings', 'output']),
  condition: new Set(['condition']),
  loop: new Set(['loop']),
  merge: new Set(['merge']),
  output: new Set(['output']),
  note: new Set(['note']),
};
const SETTINGS_KEYS = new Set([
  'jobType', 'method', 'basis', 'memory', 'memoryUnit', 'nproc', 'checkpoint', 'charge',
  'multiplicity', 'dispersion', 'scf', 'grid', 'population', 'verbosity', 'solvation',
  'solvationModel', 'solvent', 'customKeywords', 'ircDirection', 'optConvergence',
  'forceConstants', 'gates', 'disabledChecks', 'tdStates', 'tdTriplets', 'ladder', 'stableOpt', 'raman', 'vcd', 'tdRoot', 'orbitals', 'spinSweep', 'referenceNodeId',
  'counterpoise', 'counterpoiseChargeStates',
  // Issue #93: coordinate constraints and the extra QST2/QST3 structures.
  'constraints', 'qst',
  'xtbMethod', 'xtbOptLevel', 'xtbThreads', 'engine',
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
function normalizeBonds(c, raw, legacy, atomCount) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error('molecule.bonds', 'must be an array of {a, b, order} entries.');
    return [];
  }
  if (raw.length > LIMITS.atoms * 8) {
    c.error('molecule.bonds', 'contains more bonds than this atom count can have.');
    return [];
  }
  const bonds = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const path = `molecule.bonds[${index}]`;
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
    orbitals: readBoolean(c, source.orbitals, `${path}.orbitals`, { legacy, fallback: false, optional: true }),
    // Which excited state an accompanying Opt follows (#75). 0 = not stated.
    tdRoot: readOptionalInteger(c, source.tdRoot, `${path}.tdRoot`, { fallback: 0, min: 0, max: 200 }),
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
  const kindFallback = type === 'calc' ? kindForJob(settingsRaw.jobType || 'Opt') : TYPE_KINDS[type];
  const common = {
    id,
    type,
    kind: readString(c, raw.kind, `${path}.kind`, { legacy, fallback: kindFallback, max: 32 }) || kindFallback,
    title: readString(c, raw.title, `${path}.title`, { legacy, fallback: TYPE_LABELS[type], max: 120, required: true }) || TYPE_LABELS[type],
    state: readEnum(c, raw.state, NODE_STATES, `${path}.state`, { legacy, fallback: 'ready' }),
    x: readNumber(c, raw.x, `${path}.x`, { legacy, fallback: 0, min: -100000, max: 100000 }),
    y: readNumber(c, raw.y, `${path}.y`, { legacy, fallback: 0, min: -100000, max: 100000 }),
  };

  if (type === 'calc') {
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
    warnUnknown(c, source, new Set(['datasetId', 'recordFilter']), `${path}.input`);
    const datasetId = readString(c, source.datasetId, `${path}.input.datasetId`, { legacy, fallback: '', max: 64, required: true });
    if (datasetId && !GRAPH_ID_RE.test(datasetId)) {
      c.error(`${path}.input.datasetId`, 'must be a dataset id: letters, digits, dot, underscore or dash.');
    }
    const filterRaw = isPlainObject(source.recordFilter) ? source.recordFilter : {};
    return {
      ...common,
      input: {
        datasetId,
        recordFilter: {
          field: readString(c, filterRaw.field, `${path}.input.recordFilter.field`, { legacy, fallback: '', max: 64 }),
          equals: readString(c, filterRaw.equals, `${path}.input.recordFilter.equals`, { legacy, fallback: '', max: 200 }),
        },
      },
    };
  }

  if (type === 'conformers') {
    return {
      ...common,
      settings: normalizeConformerSettings(c, raw.settings, `${path}.settings`, legacy),
      output: normalizeConformerOutput(c, raw.output, `${path}.output`, legacy),
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
  warnUnknown(c, raw, new Set(['id', 'label', 'charge', 'multiplicity', 'coords', 'enabled', 'source']), path);
  const id = readString(c, raw.id, `${path}.id`, { legacy, fallback: '', max: 64, required: true });
  if (!id || !RECORD_ID_RE.test(id)) {
    c.error(`${path}.id`, 'must be a record id: letters, digits, dot, underscore or dash, starting with a letter or digit.');
    return null;
  }
  const coords = normalizeCoords(c, raw.coords, legacy, `${path}.coords`);
  if (coords.length === 0) {
    c.error(`${path}.coords`, 'must contain at least one atom: a record without a geometry cannot run.');
  }
  return {
    id,
    label: readString(c, raw.label, `${path}.label`, { legacy, fallback: id, max: 200 }) || id,
    charge: readInteger(c, raw.charge, `${path}.charge`, { legacy, fallback: 0, min: -10, max: 10 }),
    multiplicity: readInteger(c, raw.multiplicity, `${path}.multiplicity`, { legacy, fallback: 1, min: 1, max: 10 }),
    coords,
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
  warnUnknown(c, source, new Set(['maxParallel']), 'runner');
  return {
    // RFC 0001: 1 keeps the sequential drain every existing project has.
    maxParallel: readOptionalInteger(c, source.maxParallel, 'runner.maxParallel', {
      fallback: 1, min: 1, max: LIMITS.maxParallel,
    }),
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
    if (node.type === 'calc' && node.checkpointFrom) {
      const source = byId.get(node.checkpointFrom);
      if (!source) {
        c.error(`${nodePath}.checkpointFrom`, `references unknown node "${node.checkpointFrom}".`);
        node.checkpointFrom = null;
      } else if (source.type !== 'calc') {
        c.error(`${nodePath}.checkpointFrom`, `must reference a calculation node, not a ${source.type} node.`);
        node.checkpointFrom = null;
      }
    }
    if (node.type === 'loop' && node.loop.target) {
      const target = byId.get(node.loop.target);
      if (!target) {
        c.error(`${nodePath}.loop.target`, `references unknown node "${node.loop.target}".`);
        node.loop.target = '';
      } else if (target.type !== 'calc') {
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
      }
    }
    if (node.type !== 'calc') return;
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
function evaluateProjectValidity(c, { nodes, molecule, defaults }) {
  const findingsReport = [];
  const blocking = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node, index) => {
    if (node.type !== 'calc') return;
    const source = node.checkpointFrom ? byId.get(node.checkpointFrom) || null : null;
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

  // v0 fills defaults; v1 is wrapped in a flow. Neither rewrites a task id, a
  // run folder or a bundle name, so an existing project plans identically.
  const migrated = schemaVersion < SCHEMA_VERSION;
  const legacy = schemaVersion === 0;
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
