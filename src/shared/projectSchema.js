/**
 * Project file schema for Gaussian Node Studio.
 *
 * Pure module: no DOM, no filesystem, no Electron. Used by the main process
 * before a project is rendered, and by the renderer when it saves.
 *
 * Contract:
 *   - `schemaVersion: 1` is the current on-disk format.
 *   - A project written before versioning (no `schemaVersion`, or 0) is
 *     treated as v0.1 and migrated into v1 by filling documented defaults.
 *   - A project from a newer build is rejected, never guessed at.
 *   - Validation collects every error with a JSON path; it does not throw.
 *   - The normalized project is canonical: the same input always yields the
 *     same key order, so a save/reopen round-trip is byte-stable.
 */

export const SCHEMA_VERSION = 1;

import { isElementSymbol } from './elements.js';

/** Hard cap before JSON parsing; project files are small text documents. */
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;

export const LIMITS = Object.freeze({
  nodes: 2000,
  edges: 4000,
  fragments: 64,
  atoms: 1000,
  errorsReported: 100,
  warningsReported: 200,
});

export const NODE_TYPES = Object.freeze([
  'calc', 'condition', 'loop', 'merge', 'output', 'note',
]);

/** States a project file may carry. Queue states are reserved for GN-003. */
export const NODE_STATES = Object.freeze([
  'ready', 'running', 'passed', 'review', 'blocked', 'failed', 'skipped', 'cancelled', 'interrupted',
]);

export const EDGE_TYPES = Object.freeze(['dependency', 'checkpoint', 'branch', 'loop']);
export const BRANCHES = Object.freeze(['true', 'false']);
export const JOB_TYPES = Object.freeze(['Opt', 'Opt Freq', 'Opt=TS', 'Freq', 'IRC', 'SP', 'Scan']);
export const IRC_DIRECTIONS = Object.freeze(['forward', 'reverse', 'both']);
export const DISPERSIONS = Object.freeze(['', 'GD3BJ', 'GD3']);
export const SCF_OPTIONS = Object.freeze(['', 'Tight', 'VeryTight']);
export const GRID_OPTIONS = Object.freeze(['', 'Fine', 'UltraFine']);
export const POPULATION_OPTIONS = Object.freeze(['', 'NBO', 'Hirshfeld', 'MK']);
export const VERBOSITY_OPTIONS = Object.freeze(['', 'Normal', 'Verbose']);
export const SOLVATION_MODELS = Object.freeze(['PCM', 'SMD', 'CPCM']);
export const MEMORY_UNITS = Object.freeze(['MB', 'GB', 'MW']);
export const CONDITION_UNKNOWN = Object.freeze(['block-both', 'treat-false', 'treat-true']);
export const LOOP_MODES = Object.freeze(['retry', 'for-each']);
export const MERGE_POLICIES = Object.freeze(['all', 'any']);
export const GEOMETRY_SOURCES = Object.freeze(['demo', 'imported', 'manual']);
export const GEOMETRY_FORMATS = Object.freeze(['', 'xyz', 'mol', 'sdf', 'gjf', 'com']);

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECKPOINT = /^[A-Za-z0-9._-]{1,124}\.chk$/i;
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,124}\.(out|log)$/i;
const BUNDLE_NAME = /^[^<>:"/\\|?*\u0000-\u001f]{1,120}\.zip$/i;
const PORT = /^[A-Za-z0-9_-]{1,24}$/;
const NUMERIC = /^\d+(\.\d+)?$/;

const JOB_KINDS = {
  Opt: 'Opt',
  'Opt Freq': 'O+F',
  'Opt=TS': 'TS',
  Freq: 'Freq',
  IRC: 'IRC',
  SP: 'SP',
  Scan: 'Scan',
};

const TYPE_KINDS = {
  condition: 'If',
  loop: 'Loop',
  merge: 'Merge',
  output: 'Output',
  note: 'Note',
};

const TYPE_LABELS = {
  calc: 'Calculation',
  condition: 'Condition',
  loop: 'Retry loop',
  merge: 'Join branches',
  output: 'Project output',
  note: 'Note',
};

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'name', 'molecule', 'defaults', 'nodes', 'edges']);
const NODE_COMMON_KEYS = new Set(['id', 'type', 'kind', 'title', 'state', 'x', 'y']);
const NODE_TYPE_KEYS = {
  calc: new Set(['settings', 'output', 'checkpointFrom']),
  condition: new Set(['condition']),
  loop: new Set(['loop']),
  merge: new Set(['merge']),
  output: new Set(['output']),
  note: new Set(['note']),
};
const SETTINGS_KEYS = new Set([
  'jobType', 'method', 'basis', 'memory', 'memoryUnit', 'nproc', 'checkpoint', 'charge',
  'multiplicity', 'dispersion', 'scf', 'grid', 'population', 'verbosity', 'solvation',
  'solvationModel', 'solvent', 'customKeywords', 'ircDirection', 'gates',
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
  const base = {
    jobType: 'Opt',
    method: 'B3LYP',
    basis: '6-31G(d)',
    memory: '4',
    memoryUnit: 'GB',
    nproc: '4',
    checkpoint: '',
    charge: 0,
    multiplicity: 1,
    dispersion: '',
    scf: '',
    grid: '',
    population: '',
    verbosity: '',
    solvation: false,
    solvationModel: 'PCM',
    solvent: 'Water',
    customKeywords: '',
    ircDirection: 'forward',
    gates: defaultGates(),
  };
  return {
    ...base,
    ...overrides,
    gates: defaultGates({ ...base.gates, ...(overrides.gates || {}) }),
  };
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
    c.warn(keyPath, 'is not part of schema version 1 and will be dropped on save.');
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

function readBoolean(c, value, path, { legacy = false, fallback = false } = {}) {
  if (value === undefined || value === null) {
    if (!legacy) c.error(path, 'is required.');
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

/* ── Sections ─────────────────────────────────────────────── */

function normalizeCoords(c, raw, legacy) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.error('molecule.coords', 'must be an array of atoms.');
    return [];
  }
  if (raw.length > LIMITS.atoms) {
    c.error('molecule.coords', `must contain at most ${LIMITS.atoms} atoms.`);
    return [];
  }
  const atoms = [];
  raw.forEach((atom, index) => {
    const path = `molecule.coords[${index}]`;
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
    atoms.push({
      element,
      x: readNumber(c, atom.x, `${path}.x`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      y: readNumber(c, atom.y, `${path}.y`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
      z: readNumber(c, atom.z, `${path}.z`, { legacy, fallback: 0, min: -1e6, max: 1e6 }),
    });
  });
  return atoms;
}

function normalizeGeometry(c, raw, legacy, coords) {
  const source = requiredObject(c, raw, 'molecule.geometry', legacy, {});
  warnUnknown(c, source, new Set(['source', 'file', 'format']), 'molecule.geometry');
  const kind = readEnum(c, source.source, GEOMETRY_SOURCES, 'molecule.geometry.source', { legacy, fallback: 'demo' });
  const file = readString(c, source.file, 'molecule.geometry.file', { legacy, fallback: '', max: 260 });
  const format = readEnum(c, source.format, GEOMETRY_FORMATS, 'molecule.geometry.format', { legacy, fallback: '' });
  if ((kind === 'imported' || kind === 'manual') && coords.length === 0) {
    c.error('molecule.coords', `at least one atom is required when the geometry source is "${kind}".`);
  }
  return { source: kind, file, format };
}

function normalizeMolecule(c, raw, legacy) {
  const source = requiredObject(c, raw, 'molecule', legacy, {});
  warnUnknown(c, source, new Set(['smiles', 'charge', 'multiplicity', 'fragments', 'coords', 'geometry']), 'molecule');
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
  return {
    smiles: readString(c, source.smiles, 'molecule.smiles', { legacy, fallback: '', max: 1000 }),
    charge: readInteger(c, source.charge, 'molecule.charge', { legacy, fallback: 0, min: -10, max: 10 }),
    multiplicity: readInteger(c, source.multiplicity, 'molecule.multiplicity', { legacy, fallback: 1, min: 1, max: 10 }),
    fragments,
    coords,
    geometry: normalizeGeometry(c, source.geometry, legacy, coords),
  };
}

function normalizeDefaults(c, raw, legacy) {
  const source = requiredObject(c, raw, 'defaults', legacy, {});
  warnUnknown(c, source, new Set(['method', 'basis', 'memory', 'memoryUnit', 'nproc']), 'defaults');
  return {
    method: readString(c, source.method, 'defaults.method', { legacy, fallback: 'B3LYP', max: 64, required: true }) || 'B3LYP',
    basis: readString(c, source.basis, 'defaults.basis', { legacy, fallback: '6-31G(d)', max: 64, required: true }) || '6-31G(d)',
    memory: readMemory(c, source.memory, 'defaults.memory', { legacy, fallback: '4' }),
    memoryUnit: readEnum(c, source.memoryUnit, MEMORY_UNITS, 'defaults.memoryUnit', { legacy, fallback: 'GB' }),
    nproc: readInteger(c, source.nproc, 'defaults.nproc', { legacy, fallback: 4, min: 1, max: 1024 }),
  };
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

function normalizeSettings(c, raw, path, legacy) {
  const source = requiredObject(c, raw, path, legacy, {});
  warnUnknown(c, source, SETTINGS_KEYS, path);
  const checkpoint = readString(c, source.checkpoint, `${path}.checkpoint`, { legacy, fallback: '', max: 128 });
  if (checkpoint && !CHECKPOINT.test(checkpoint)) {
    c.error(`${path}.checkpoint`, 'must be a safe file name ending in .chk.');
  }
  return {
    jobType: readEnum(c, source.jobType, JOB_TYPES, `${path}.jobType`, { legacy, fallback: 'Opt', required: true }) || 'Opt',
    method: readString(c, source.method, `${path}.method`, { legacy, fallback: 'B3LYP', max: 64, required: true }) || 'B3LYP',
    basis: readString(c, source.basis, `${path}.basis`, { legacy, fallback: '6-31G(d)', max: 64, required: true }) || '6-31G(d)',
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
    solvation: readBoolean(c, source.solvation, `${path}.solvation`, { legacy, fallback: false }),
    solvationModel: readEnum(c, source.solvationModel, SOLVATION_MODELS, `${path}.solvationModel`, { legacy, fallback: 'PCM' }),
    solvent: readString(c, source.solvent, `${path}.solvent`, { legacy, fallback: 'Water', max: 40 }) || 'Water',
    customKeywords: readString(c, source.customKeywords, `${path}.customKeywords`, { legacy, fallback: '', max: 500 }),
    ircDirection: readEnum(c, source.ircDirection, IRC_DIRECTIONS, `${path}.ircDirection`, { legacy, fallback: 'forward' }),
    gates: normalizeGates(c, source.gates, `${path}.gates`, legacy),
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

function normalizeNode(c, raw, index, legacy) {
  const path = `nodes[${index}]`;
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
      settings: normalizeSettings(c, raw.settings, `${path}.settings`, legacy),
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
    warnUnknown(c, source, new Set(['bundle', 'manifest', 'notes']), `${path}.output`);
    const bundle = readString(c, source.bundle, `${path}.output.bundle`, { legacy, fallback: 'project.zip', max: 120 }) || 'project.zip';
    if (!BUNDLE_NAME.test(bundle)) {
      c.error(`${path}.output.bundle`, 'must be a .zip file name without path separators.');
    }
    return {
      ...common,
      output: {
        bundle,
        manifest: readBoolean(c, source.manifest, `${path}.output.manifest`, { legacy, fallback: true }),
        notes: readString(c, source.notes, `${path}.output.notes`, { legacy, fallback: '', max: 2000 }),
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

function normalizeEdges(c, raw, nodeIds, legacy) {
  if (!Array.isArray(raw)) {
    c.error('edges', 'must be an array.');
    return [];
  }
  if (raw.length > LIMITS.edges) {
    c.error('edges', `must contain at most ${LIMITS.edges} connections.`);
    return [];
  }
  const seen = new Set();
  const edges = [];
  raw.forEach((edge, index) => {
    const path = `edges[${index}]`;
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

/* ── Public API ───────────────────────────────────────────── */

export function validateProject(raw) {
  const c = createCollector();
  if (!isPlainObject(raw)) {
    c.error('', 'Project must be a JSON object.');
    return { ok: false, errors: c.errors, warnings: c.warnings, project: null, migrated: false, schemaVersion: 0 };
  }

  warnUnknown(c, raw, TOP_LEVEL_KEYS, '');

  const rawVersion = raw.schemaVersion;
  let migrated = false;
  let schemaVersion = SCHEMA_VERSION;
  if (rawVersion === undefined || rawVersion === null || rawVersion === 0) {
    migrated = true;
    schemaVersion = 0;
  } else if (!Number.isInteger(rawVersion) || rawVersion < 0) {
    c.error('schemaVersion', 'must be a positive integer.');
  } else if (rawVersion > SCHEMA_VERSION) {
    c.error('schemaVersion',
      `project uses schema version ${rawVersion}, but this build supports up to ${SCHEMA_VERSION}. Update Gaussian Node Studio to open it.`);
  }

  const legacy = migrated;

  if (!Array.isArray(raw.nodes)) {
    c.error('nodes', 'must be an array of nodes.');
  } else if (raw.nodes.length > LIMITS.nodes) {
    c.error('nodes', `must contain at most ${LIMITS.nodes} nodes.`);
  }

  const nodeIds = new Set();
  const nodes = [];
  const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes.slice(0, LIMITS.nodes) : [];
  nodesRaw.forEach((nodeRaw, index) => {
    const node = normalizeNode(c, nodeRaw, index, legacy);
    if (!node) return;
    if (nodeIds.has(node.id)) {
      c.error(`nodes[${index}].id`, `duplicate node id "${node.id}".`);
      return;
    }
    nodeIds.add(node.id);
    nodes.push(node);
  });

  const edges = normalizeEdges(c, raw.edges, nodeIds, legacy);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node, index) => {
    if (node.type === 'calc' && node.checkpointFrom) {
      const source = byId.get(node.checkpointFrom);
      if (!source) {
        c.error(`nodes[${index}].checkpointFrom`, `references unknown node "${node.checkpointFrom}".`);
        node.checkpointFrom = null;
      } else if (source.type !== 'calc') {
        c.error(`nodes[${index}].checkpointFrom`, `must reference a calculation node, not a ${source.type} node.`);
        node.checkpointFrom = null;
      }
    }
    if (node.type === 'loop' && node.loop.target) {
      const target = byId.get(node.loop.target);
      if (!target) {
        c.error(`nodes[${index}].loop.target`, `references unknown node "${node.loop.target}".`);
        node.loop.target = '';
      } else if (target.type !== 'calc') {
        c.error(`nodes[${index}].loop.target`, `must target a calculation node, not a ${target.type} node.`);
        node.loop.target = '';
      }
    }
  });

  const project = {
    schemaVersion: SCHEMA_VERSION,
    name: readString(c, raw.name, 'name', { legacy, fallback: 'Untitled project', max: 200 }) || 'Untitled project',
    molecule: normalizeMolecule(c, raw.molecule, legacy),
    defaults: normalizeDefaults(c, raw.defaults, legacy),
    nodes,
    edges,
  };

  return {
    ok: c.ok,
    errors: c.errors,
    warnings: c.warnings,
    project: c.ok ? project : null,
    migrated,
    schemaVersion,
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

/** Canonical serialization: validate, normalize, then pretty-print. */
export function stringifyProject(raw) {
  const result = validateProject(raw);
  if (!result.ok) return { ...result, text: null };
  return { ...result, text: `${JSON.stringify(result.project, null, 2)}\n` };
}

function failure(path, message) {
  return {
    ok: false,
    errors: [{ path, message }],
    warnings: [],
    project: null,
    migrated: false,
    schemaVersion: 0,
  };
}

/** One-line summary for dialogs and toasts. */
export function summarizeErrors(errors, limit = 3) {
  if (!Array.isArray(errors) || errors.length === 0) return 'Unknown validation error.';
  const shown = errors.slice(0, limit).map((error) => (error.path ? `${error.path}: ${error.message}` : error.message));
  const extra = errors.length - shown.length;
  return `${shown.join(' · ')}${extra > 0 ? ` · +${extra} more` : ''}`;
}
