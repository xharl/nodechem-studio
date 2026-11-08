/**
 * Built-in workflow templates for new projects.
 *
 * WHY: a blank canvas asks a first-time user to know Gaussian route keywords
 * before they can draw a single block, and hand-drawing "Opt then Freq"
 * duplicates the gate defaults in every project. These three recipes are a
 * small, tested set of starting points. They are generated from
 * `defaultSettings()` / `defaultGates()` rather than spelled out field by
 * field, so a schema default change reaches every template instead of
 * drifting away from it.
 *
 * `templateProject()` is deterministic: the same id always produces a
 * deep-equal project. That is what lets the repository ship the same recipes
 * as example `.ncs` files and assert in the test suite that the checked-in
 * files still match the code that generated them.
 *
 * Pure module: no DOM, no filesystem, no Electron.
 */

import {
  SCHEMA_VERSION,
  defaultGates,
  defaultSettings,
  kindForJob,
} from './projectSchema.js';

/** Canvas geometry used by the renderer: each node card is 216 x 112 px. */
const COLUMN_X = 40;
const ROW_Y = 60;
const ROW_GAP = 180;
const NOTE_X = 330;

const BLANK_NAME = 'Untitled project';
const UNTITLED_FALLBACK = 'Untitled project';

function oneLine(value, max = 200) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * A fresh demo molecule. No Cartesian geometry is attached, so the app falls
 * back to its clearly labelled demo water until the user imports a structure;
 * a template must never pretend a molecule was supplied.
 */
function defaultMolecule() {
  return {
    smiles: '',
    charge: 0,
    multiplicity: 1,
    fragments: [],
    coords: [],
    geometry: { source: 'demo', file: '', format: '' },
  };
}

/** Project defaults are a subset of a block's settings; derive them once. */
function projectDefaults() {
  const settings = defaultSettings();
  return {
    engine: 'gaussian',
    method: settings.method,
    basis: settings.basis,
    memory: settings.memory,
    memoryUnit: settings.memoryUnit,
    // The schema stores cores as an integer, while defaultSettings() keeps the
    // editable form as a string. Normalize here so a template is already in
    // canonical form and equals its own save/reopen round-trip.
    nproc: Number(settings.nproc),
  };
}

function calcNode(id, title, x, y, settingsOverrides = {}, checkpointFrom = null) {
  const settings = defaultSettings(settingsOverrides);
  settings.nproc = Number(settings.nproc);
  return {
    id,
    type: 'calc',
    kind: kindForJob(settings.jobType),
    title,
    state: 'ready',
    x,
    y,
    settings,
    output: null,
    checkpointFrom,
  };
}

function noteNode(id, title, x, y, text) {
  return {
    id,
    type: 'note',
    kind: 'Note',
    title,
    state: 'ready',
    x,
    y,
    note: { text: oneLine(text, 8000) },
  };
}

function projectObject(name, nodes, edges) {
  const clean = oneLine(name, 200) || UNTITLED_FALLBACK;
  // Schema v2 (RFC 0001): the graph lives in a flow. `nodes`/`edges` are the
  // in-memory aliases the renderer reads; the file view drops them.
  return {
    schemaVersion: SCHEMA_VERSION,
    name: clean,
    molecule: defaultMolecule(),
    defaults: projectDefaults(),
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{ id: 'main', title: 'Workflow', nodes, edges }],
    reports: [],
    activeFlowId: 'main',
    nodes,
    edges,
  };
}

/** A vertical dependency edge, drawn bottom-to-top like the seeded project. */
function chainEdge(from, to, type = 'dependency') {
  return { from, to, type, fromPort: 'bottom', toPort: 'top' };
}

/* ── Recipes ──────────────────────────────────────────────── */

/**
 * Reactant optimization -> reactant frequency. The frequency block requires
 * zero imaginary modes, which is the only way to call the optimized geometry
 * a minimum rather than a saddle.
 */
function buildOptFreq(name) {
  const nodes = [
    calcNode('of-opt', 'Reactant optimization', COLUMN_X, ROW_Y, {
      checkpoint: 'reactant_opt.chk',
      gates: defaultGates({ finalEnergy: true }),
    }),
    calcNode('of-freq', 'Reactant frequency', COLUMN_X, ROW_Y + ROW_GAP, {
      jobType: 'Freq',
      gates: defaultGates({ imaginary: 0, finalEnergy: true }),
    }, 'of-opt'),
  ];
  // A checkpoint edge, not a dependency edge: without it the frequency block
  // recomputes the *input* geometry, both gates still pass, and a user reading
  // two green gates concludes they have a minimum when they have a frequency
  // job on a non-stationary structure.
  return projectObject(name, nodes, [chainEdge('of-opt', 'of-freq', 'checkpoint')]);
}

/**
 * Reactant optimization -> TS guess optimization -> TS frequency.
 *
 * The TS block uses Opt=TS with CalcFC. The renderer derives the
 * "Optimization completed" gate from the Opt job type, so that requirement is
 * already part of this block's gate set. Tight convergence and the implied
 * UltraFine grid follow the app's own pre-frequency guidance.
 *
 * The checkpoint edge (and checkpointFrom) is what lets the frequency block
 * read the saddle geometry and Hessian from the TS optimization.
 */
function buildTsSearch(name) {
  const tsY = ROW_Y + ROW_GAP;
  const freqY = ROW_Y + (ROW_GAP * 2);
  const nodes = [
    calcNode('ts-react-opt', 'Reactant optimization', COLUMN_X, ROW_Y, {
      checkpoint: 'reactant_opt.chk',
      gates: defaultGates({ finalEnergy: true }),
    }),
    calcNode('ts-opt', 'TS guess optimization', COLUMN_X, tsY, {
      jobType: 'Opt=TS',
      forceConstants: 'CalcFC',
      optConvergence: 'Tight',
      checkpoint: 'ts_opt.chk',
      gates: defaultGates(),
    }),
    calcNode('ts-freq', 'TS frequency', COLUMN_X, freqY, {
      jobType: 'Freq',
      checkpoint: 'ts_freq.chk',
      gates: defaultGates({ imaginary: 1, minMagnitude: 50 }),
    }, 'ts-opt'),
    noteNode(
      'ts-route-note',
      'Route note',
      NOTE_X,
      ROW_Y,
      'Opt=TS with CalcFC computes the Hessian at the starting geometry (NoEigenTest is implied); '
      + 'the frequency block then verifies exactly one imaginary mode at or above 50 cm^-1. '
      + 'Opt=Tight before a frequency job keeps the geometry tightly converged.',
    ),
  ];
  return projectObject(name, nodes, [
    chainEdge('ts-react-opt', 'ts-opt'),
    chainEdge('ts-opt', 'ts-freq', 'checkpoint'),
  ]);
}

/**
 * A single point calculation with NBO population analysis. It makes no
 * geometry or stationary-point claim, so no imaginary-mode gate is set.
 */
function buildSinglePoint(name) {
  const nodes = [
    calcNode('sp-energy', 'Single-point energy', COLUMN_X, ROW_Y, {
      jobType: 'SP',
      population: 'NBO',
      checkpoint: 'sp_energy.chk',
      gates: defaultGates({ finalEnergy: true }),
    }),
  ];
  return projectObject(name, nodes, []);
}

/**
 * Emission from the first excited state (#75).
 *
 * `Opt` carrying a TD keyword relaxes the state the root names; the second
 * block then runs a TD calculation at that minimum. What the second block
 * reports is the **vertical emission** energy from the S1 minimum, not an
 * adiabatic 0-0 energy: the two differ by the difference in zero-point energy
 * between the ground and excited surfaces, which this workflow never computes.
 * The note block says so on the canvas, and the results panel labels the
 * energy the same way.
 */
function buildEmission(name) {
  const emitY = ROW_Y + ROW_GAP;
  const nodes = [
    calcNode('em-s1-opt', 'S1 optimisation', COLUMN_X, ROW_Y, {
      jobType: 'Opt',
      tdStates: 1,
      tdRoot: 1,
      checkpoint: 's1_min.chk',
      gates: defaultGates({ finalEnergy: true }),
    }),
    calcNode('em-td', 'Emission (TD at the S1 minimum)', COLUMN_X, emitY, {
      jobType: 'SP',
      tdStates: 3,
      checkpoint: 'emission.chk',
      gates: defaultGates({ finalEnergy: true }),
    }, 'em-s1-opt'),
    noteNode(
      'em-note',
      'What this reports',
      NOTE_X,
      ROW_Y,
      'The first block emits TD=(NStates=1,Root=1) Opt, which relaxes the S1 surface. '
      + 'The second runs TD at that minimum; its lowest excitation energy is the vertical emission. '
      + 'It is not the 0-0 (adiabatic) energy: that needs the S0 and S1 zero-point energies.',
    ),
  ];
  return projectObject(name, nodes, [chainEdge('em-s1-opt', 'em-td', 'checkpoint')]);
}

const RECIPES = {
  'opt-freq': {
    name: 'Reactant optimization + frequency',
    description: 'Optimize the reactant, then run a frequency job to prove it is a minimum.',
    build: buildOptFreq,
  },
  'ts-search': {
    name: 'Transition-state search',
    description: 'Optimize the reactant, search the saddle with Opt=TS/CalcFC, then verify one imaginary mode.',
    build: buildTsSearch,
  },
  'emission': {
    name: 'Emission from S1 (Opt then TD)',
    description: 'Relax the first excited state, then run TD at that minimum to read the vertical emission energy.',
    build: buildEmission,
  },
  'single-point': {
    name: 'Single-point energy + NBO charges',
    description: 'One single-point energy with NBO population charges; no geometry or frequency work.',
    build: buildSinglePoint,
  },
};

/* ── Public API ───────────────────────────────────────────── */

/**
 * Ordered catalogue for the project chooser. `blockCount` is derived from the
 * recipe itself so the UI cannot advertise a count the graph does not have;
 * it counts every node, including the explanatory note block.
 */
export const WORKFLOW_TEMPLATES = Object.freeze(
  Object.entries(RECIPES).map(([id, recipe]) => Object.freeze({
    id,
    name: recipe.name,
    description: recipe.description,
    blockCount: recipe.build(recipe.name).nodes.length,
  })),
);

/**
 * Build one template as a raw, schema-valid project object.
 *
 * @param {string} id one of the ids in WORKFLOW_TEMPLATES
 * @param {{name?: string}} [options] optional project name override
 * @returns {object} a fresh project object on every call
 */
export function templateProject(id, { name } = {}) {
  const recipe = Object.prototype.hasOwnProperty.call(RECIPES, id) ? RECIPES[id] : null;
  if (!recipe) throw new Error(`Unknown workflow template "${String(id)}".`);
  return recipe.build(name === undefined ? recipe.name : name);
}

/**
 * The empty starting point: one calculation block with the default route and
 * gates, no connections, and the default demo geometry.
 *
 * @param {{name?: string}} [options]
 * @returns {object}
 */
export function blankProject({ name = BLANK_NAME } = {}) {
  const nodes = [calcNode('blank-opt', 'Reactant optimization', COLUMN_X, ROW_Y)];
  return projectObject(name, nodes, []);
}
