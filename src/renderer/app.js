'use strict';

/* ============================================================
   NodeChem Studio — node-first Electron workspace
   The graph is the primary surface. The runner is local-only.
   ============================================================ */

import {
  DEMO_WATER,
  tdKeywordFor,
} from '../shared/gaussianInput.js';
import { basisNameFor, ecpRequirement } from '../shared/ecp.js';
import { atomicNumber } from '../shared/elements.js';
import { elementStyle } from './structureViewer.js';
import { routeFor } from '../shared/gaussianInput.js';
import {
  DRAFT_KEY,
  DRAFT_VERSION,
  MAX_DRAFT_BYTES,
  draftAgeLabel,
  draftIsRestorable,
  normalizeDraft,
} from '../shared/draft.js';
import { JOB_TYPES as SHARED_JOB_TYPES, LIMITS, MATRIX_ELEMENT_OPTIONS, defaultGates, defaultSettings, validateProject } from '../shared/projectSchema.js';
import { applyQueueToProject, nextAction } from '../shared/queueReconcile.js';
import { clampFloatingRect, readFloatingRect } from '../shared/floatingWindow.js';
import {
  DERIVATIVE_MAX_EDITS,
  DERIVATIVE_OPS,
  attachGraphAliases,
  activeFlow,
  activeFlowId,
  datasetById,
  enabledRecords,
  flowById,
  flowsOf,
  hydrateProject,
  recordsForInput,
  recordsOf,
  setFlowGraph,
} from '../shared/flows.js';
import { GEOMETRY_NOTE, GEOMETRY_STATUS } from '../shared/derivative.js';
import {
  COMPUTE_FIELDS,
  COMPUTE_FUNCTIONS,
  ComputeError,
  evaluateCompute,
  formatComputeNumber,
} from '../shared/compute.js';
import { DP4_VARIANTS, DP4_VARIANT_LABELS, dp4Levels } from '../shared/dp4.js';
import { dp4RowsFromSources, dp4Summary, evaluateDp4 } from '../shared/dp4Workflow.js';
import {
  MULTIWFN_ANALYSES,
  MULTIWFN_CITATION,
  MULTIWFN_LICENCE,
  MULTIWFN_MENU_VERSION,
  multiwfnAnalysis,
  multiwfnMenuScript,
  multiwfnSummary,
} from '../shared/multiwfn.js';
import {
  COMPLEX_GEOMETRY_NOTE,
  COMPLEX_GEOMETRY_STATUS,
  COMPLEX_MAX_MEMBERS,
  COMPLEX_PLACEMENT_MODES,
} from '../shared/complex.js';
import {
  SERIES_LINKAGE_ORDER,
  SERIES_MAX_MEMBERS,
  SERIES_TERMINAL_RULE,
  atomDistance,
} from '../shared/series.js';
import { parseDataset } from '../shared/datasetImport.js';
import {
  duplicateFlowGraph,
  flowIdFromTitle,
  flowTabModels,
  nextFlowTitle,
  slugifyGraphId,
  uniqueGraphId,
} from './flowTabs.js';
import { groupTasksByRecord, recordSummaryLabel } from './recordSummary.js';
import {
  OUTPUT_KIND_LABELS,
  defaultOutputPath,
  outputOf,
  outputPathError,
} from './outputFields.js';
import { SCORER_MODELS } from '../shared/scorer.js';
import {
  DEFAULT_CONFORMER_METHOD,
  DEFAULT_CONFORMER_SETTINGS,
  DEFAULT_ENSEMBLE_INPUT,
  conformerEnergyLabel,
  conformerGroupLabel,
  conformerGroups,
  conformerOriginLabel,
  conformerOriginShort,
  conformerSearchNote,
  conformerTableCaption,
  formatPopulation,
  formatRelativeKcal,
  isConformerGroupId,
} from '../shared/conformers.js';
import { WORKFLOW_TEMPLATES, blankProject, templateProject } from '../shared/templates.js';
import { engineSummary, formatRecentModified } from '../shared/recentProjects.js';
import { ENGINES, engineOrDefault } from '../shared/engines/index.js';
import { defaultAppSettings, mergeAppSettings } from '../shared/appSettings.js';
import {
  SETTINGS_PAGES,
  engineExecutableMap,
  localOverrides,
  runFieldSeed,
  settingsPageHtml,
} from './settingsView.js';
import { ORCA_BASES, ORCA_METHODS, ORCA_PNO_THRESHOLDS, buildOrcaInput } from '../shared/engines/orca.js';
import { PSI4_BASES, PSI4_JOB_TYPES, PSI4_METHODS, buildPsi4Input } from '../shared/engines/psi4.js';
import {
  PYSCF_BASES,
  PYSCF_JOB_TYPES,
  PYSCF_METHODS,
  PYSCF_SOLVATION_MODELS,
  buildPyscfInput,
} from '../shared/engines/pyscf.js';
import { compositionOf, describeAtoms, formulaOf, massOf } from '../shared/formula.js';
import { prepareConvergenceText, prepareLabel, prepareSummaryLine } from '../shared/prepare.js';
import { EXPLICIT_SOLVENTS } from '../shared/explicitSolvation.js';
import * as shared from '../shared/workflowTasks.js';
import { engineForNode } from '../shared/workflowTasks.js';
import { SPIN_SWEEP_MAX, multiplicitiesFor, spinSweepFor } from '../shared/spinSweep.js';
import { estimateCost } from '../shared/costEstimate.js';
import { XTB_METHODS, XTB_OPT_LEVELS, XTB_SOLVATION_MODELS, XTB_SOLVENTS } from '../shared/engines/xtb.js';
import {
  MODERN_ROUTE_PRESET,
  ROUTE_PRESETS,
  applyRoutePreset,
  clearCompositeConflicts,
  defaultDispersionFor,
  dispersionForMethodChange,
  isCompositeJobType,
  routePresetIdFor,
} from '../shared/routePresets.js';
import { parseStructureRecords } from '../shared/structureImport.js';
import { CHECK_STATUS, VALIDITY_CHECKS, runValidityChecks } from '../shared/validityChecks.js';
import {
  createHistory,
  canUndo,
  canRedo,
  recordSnapshot,
  redoStep,
  undoStep,
} from '../shared/editHistory.js';
import {
  OPT_CONVERGENCE_OPTIONS,
  TS_FORCE_CONSTANT_OPTIONS,
  checkTsForceConstants,
  forceConstantsFor,
  freqGeometryWarnings,
  gridFor,
  isOptJob,
  jobKeywordFor,
  optConvergenceFor,
  optConvergenceWarnings,
  requiresUltraFineGrid,
} from '../shared/tsForceConstants.js';
import {
  CONSTRAINT_KINDS,
  constraintAtomCount,
  constraintFindings,
  describeConstraint,
  qstKindFor,
  qstRequiredStructures,
  qstStructuresFor,
} from '../shared/constraints.js';
import { runClusterAction } from './clusterExport.js';
import { exportRunBundleAction } from './runBundle.js';
import { exportRunFormatAction } from './runConverter.js';
import { exportDeckAction } from './deckExport.js';
import { provenanceSummary, syncVerifyButton, verifyRunInput } from './provenance.js';
import { mountThermochemistryView } from './thermochemistryView.js';
import { installResultsView } from './resultsView.js';
import { IMPORTED_BADGE_TEXT, importedSummary, isImportedRecord } from '../shared/importedRecord.js';
import { mountStructureViewer } from './structureViewer.js';
import { formatPreflightReport, preflightFailureMessage } from './preflightReport.js';
import {
  runSettingsFor,
  showsCheckpointHandoff,
  showsGaussianResources,
  showsXtbThreads,
} from './inspectorFields.js';
import {
  BROWSER_PREVIEW_CONSOLE_HINT,
  BROWSER_PREVIEW_RUN_MESSAGE,
  checkpointHandoffNote,
  dryRunHintFor,
  executableLabelFor,
  executablePlaceholderFor,
  runEngineLabel,
} from './engineCopy.js';
import { executableSeed } from './runExecutable.js';
import {
  companionPlaceholderFor,
  companionSeed,
  detectedCompanionPath,
} from './runTools.js';

const desktop = window.desktop || null;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
let appVersion = APP_VERSION;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const W = 216;
// Cards carry a result line now (energy / SAPT / ensemble), so the height has
// room for it between the route and the footer.
const H = 132;
const STAGE_W = 1080;
const STAGE_H = 580;
const LOOP_LANE = 548;

const STATUS = {
  passed: { label: 'Passed', dot: 'green' },
  ready: { label: 'Ready', dot: 'blue' },
  review: { label: 'Needs review', dot: 'red' },
  blocked: { label: 'Blocked', dot: 'slate' },
  // Issue 177: stopped at its wall-clock limit. Not red: nothing was rejected.
  'timed out': { label: 'Timed out', dot: 'slate' },
};

const METHODS = [
  ['B3LYP', 'B3LYP'], ['M06-2X', 'M06-2X'], ['ωB97X-D', 'ωB97X-D'],
  ['PBE0', 'PBE0'], ['MP2', 'MP2'], ['CCSD(T)', 'CCSD(T)'],
];
const BASIS_SETS = [
  ['def2-SVP', 'def2-SVP'], ['6-31G(d)', '6-31G(d)'], ['6-311+G(d,p)', '6-311+G(d,p)'],
  ['def2-TZVP', 'def2-TZVP'], ['cc-pVTZ', 'cc-pVTZ'], ['SDD', 'SDD'],
];
// The job-type list lives in the schema so a new type cannot be offered by one
// side and refused by the other. Composite methods (#77) arrive through the same
// list; they take no method/basis pair, so the inspector hides that group.
const JOB_TYPE_LABELS = {
  Opt: 'Optimization',
  'Opt Freq': 'Optimization + frequency',
  'Opt=TS': 'Transition state',
  'Opt=QST2': 'Transition state · QST2',
  'Opt=QST3': 'Transition state · QST3',
  Freq: 'Frequency',
  IRC: 'IRC path',
  SP: 'Single point',
  Scan: 'PES scan',
  NMR: 'NMR shieldings',
};
const JOB_TYPES = SHARED_JOB_TYPES.map((id) => [id, JOB_TYPE_LABELS[id] || `${id} · composite`]);
const IRC_DIRECTIONS = [['forward', 'Forward'], ['reverse', 'Reverse'], ['both', 'Both directions']];
const DISPERSIONS = [['', 'None'], ['GD3BJ', 'D3(BJ)'], ['GD3', 'D3'], ['D4', 'D4 (Gaussian 16 C.01+)']];
const SCF_OPTIONS = [['', 'Default'], ['Tight', 'Tight'], ['VeryTight', 'Very tight']];
const GRID_OPTIONS = [['', 'Default'], ['Fine', 'Fine'], ['UltraFine', 'UltraFine']];
const POP_OPTIONS = [['', 'None'], ['NBO', 'NBO'], ['Hirshfeld', 'Hirshfeld'], ['MK', 'MK charges']];
const VERBOSITY = [['', 'Default'], ['Normal', 'Normal'], ['Verbose', 'Verbose']];
const SOLVATION_MODELS = [['PCM', 'PCM'], ['SMD', 'SMD'], ['CPCM', 'CPCM']];
const SOLVENTS = [['Water', 'Water'], ['Dichloromethane', 'Dichloromethane'], ['THF', 'THF'], ['Toluene', 'Toluene'], ['Acetonitrile', 'Acetonitrile']];
const MEMORY_UNITS = [['GB', 'GB'], ['MB', 'MB'], ['MW', 'MW']];

function calcNode(id, kind, title, x, y, options = {}) {
  return {
    id,
    type: 'calculate',
    kind,
    title,
    state: options.state || 'ready',
    x,
    y,
    settings: defaultSettings(options.settings || {}),
    output: options.output || null,
    checkpointFrom: options.checkpointFrom || null,
  };
}

const project = {
  name: 'Diels–Alder TS verification',
  molecule: {
    smiles: 'C=CC=C.C=C',
    charge: 0,
    multiplicity: 1,
    fragments: ['C=CC=C', 'C=C'],
    coords: [],
    geometry: { source: 'demo', file: '', format: '' },
  },
  defaults: {
    engine: 'gaussian',
    method: MODERN_ROUTE_PRESET.method,
    basis: MODERN_ROUTE_PRESET.basis,
    memory: '4',
    memoryUnit: 'GB',
    nproc: '4',
  },
  runner: { maxParallel: 1 },
  nodes: [
    calcNode('r-opt', 'Opt', 'Reactant optimization', 10, 40, {
      state: 'passed',
      output: { file: 'r_opt.log', size: '1.8 MB' },
      settings: { checkpoint: 'r_opt.chk' },
    }),
    calcNode('r-freq', 'Freq', 'Reactant frequency', 10, 250, {
      state: 'passed',
      output: { file: 'r_freq.log', size: '2.4 MB' },
      settings: { jobType: 'Freq', checkpoint: 'r_freq.chk', gates: { thermo: true, imaginary: 0 } },
    }),
    calcNode('ts-opt', 'TS', 'TS guess optimization', 290, 40, {
      state: 'passed',
      output: { file: 'ts_opt.log', size: '2.1 MB' },
      // Issue #15: the seeded saddle search must use the safe curvature form,
      // not a bare Opt=TS. Issue #16: its transition state feeds a frequency
      // job, so optimize tightly (and, with B3LYP, default to UltraFine).
      settings: {
        jobType: 'Opt=TS', forceConstants: 'CalcFC', optConvergence: 'Tight', checkpoint: 'ts_opt.chk',
      },
    }),
    calcNode('ts-freq', 'Freq', 'TS frequency', 290, 250, {
      state: 'review',
      checkpointFrom: 'ts-opt',
      settings: {
        jobType: 'Freq',
        checkpoint: 'ts_freq.chk',
        gates: { thermo: true, imaginary: 1, minMagnitude: 50 },
      },
    }),
    {
      id: 'cond',
      type: 'condition',
      kind: 'If',
      title: 'True saddle?',
      state: 'review',
      x: 570,
      y: 250,
      condition: {
        expression: 'imaginaryCount == 1\nand abs(nu) >= 50',
        unknown: 'block-both',
        notes: 'Evaluated from the parsed frequency block, not from the job exit status.',
      },
    },
    calcNode('irc', 'IRC', 'IRC verification', 850, 110, {
      state: 'blocked',
      settings: { jobType: 'IRC', ircDirection: 'both' },
    }),
    {
      id: 'retry',
      type: 'loop',
      kind: 'Loop',
      title: 'Re-guess TS',
      state: 'ready',
      x: 850,
      y: 370,
      loop: {
        maxAttempts: 3,
        mode: 'retry',
        target: 'ts-opt',
        until: 'condition is false',
      },
    },
  ],
  edges: [
    { from: 'r-opt', to: 'r-freq', type: 'dependency', fromPort: 'bottom', toPort: 'top' },
    { from: 'r-opt', to: 'ts-opt', type: 'dependency', fromPort: 'right', toPort: 'left' },
    { from: 'ts-opt', to: 'ts-freq', type: 'checkpoint', fromPort: 'bottom', toPort: 'top' },
    { from: 'ts-freq', to: 'cond', type: 'dependency', fromPort: 'right', toPort: 'left' },
    { from: 'cond', to: 'irc', type: 'branch', branch: 'true', fromPort: 'true', toPort: 'left' },
    { from: 'cond', to: 'retry', type: 'branch', branch: 'false', fromPort: 'false', toPort: 'left' },
    { from: 'retry', to: 'ts-opt', type: 'loop', fromPort: 'bottom', toPort: 'bottomIn' },
  ],
};

// Schema v2 (RFC 0001): the seed graph lives in a flow. `nodes`/`edges` stay
// as the active flow's aliases, which is what every existing reader uses.
hydrateProject(project);
// A dataset is the only source of record scopes; an empty list keeps a seed
// project behaving exactly like a v1 one.
if (!Array.isArray(project.datasets)) project.datasets = [];

const state = {
  project,
  selected: { type: 'project', id: null },
  inspectorHidden: false,
  inspectorWide: false,
  zoom: 0.94,
  paletteOpen: false,
  drawer: null,
  connecting: null,
  keyboardConnect: null,
  drag: null,
  pan: null,
  toastTimer: null,
  renamingFlowId: null,
  confirmDeleteFlowId: null,
  datasetImportNodeId: null,
  statusMessage: 'Preview project · choose a calculation block to run it locally',
  // Last engineStatus() answer, used to seed the run-console executable field
  // without a second probe (issue issue 233).
  engineStatus: null,
  // Issue 252: machine/app settings loaded once from the main process. The
  // run console's path fields are seeded from these when no local override
  // exists; saving Settings re-seeds them.
  appSettings: defaultAppSettings(),
  settingsDetection: null,
  settingsPath: '',
  // Run console geometry (issue 253): null means docked to the CSS corner.
  runConsoleRect: null,
  runConsoleDrag: null,
  runConsolePersistTimer: null,
  projectPath: null,
  savedSnapshot: null,
  // Snapshot of the project as loaded, used to tell "untitled and untouched"
  // apart from a real edit so a fresh session never writes a draft for the seed
  // project. `savedSnapshot` is null until the first open/save, so it cannot
  // answer that question on its own.
  draftBaseline: null,
  draftTimer: null,
  dirty: null,
  history: null,
  run: {
    id: null,
    status: 'idle',
    dir: null,
    output: '',
    gates: [],
    validity: [],
    // Issue 256: after a run the hint line reports the outcome rather than the
    // pre-run mode. `hintPinned` makes that survive the copy refreshes that
    // follow a selection change.
    hintPinned: false,
    hintText: '',
    hintWarn: false,
    hintAction: null,
    // Issue 255: after a project switch, run events already in flight belong to
    // the previous project's single run. They stay ignored until this project
    // starts its own run.
    ignoreEvents: false,
  },
  queue: {
    id: null,
    status: 'idle',
    tasks: [],
    reason: null,
    starting: false,
    spins: {},
  },
  // Issue 255: the newest queue that belongs to another project. The header
  // names it instead of painting its state over the open project.
  lastForeignQueue: null,
};

let nodeSequence = 0;

/* ── Domain helpers ───────────────────────────────────────── */

const nodeById = (id) => state.project.nodes.find((node) => node.id === id) || null;
const edgeId = (edge) => `${edge.from}->${edge.to}:${edge.type}${edge.branch ? `:${edge.branch}` : ''}`;
const edgeById = (id) => state.project.edges.find((edge) => edgeId(edge) === id) || null;
const incoming = (id) => state.project.edges.filter((edge) => edge.to === id);
const outgoing = (id) => state.project.edges.filter((edge) => edge.from === id);
const statusFor = (node) => STATUS[node.state] || STATUS.blocked;
function kindForJob(jobType) {
  if (isCompositeJobType(jobType)) return 'Composite';
  return ({
    Opt: 'Opt', 'Opt Freq': 'O+F', 'Opt=TS': 'TS', Freq: 'Freq', IRC: 'IRC', SP: 'SP', Scan: 'Scan', NMR: 'NMR',
  }[jobType] || 'SP');
}

function routeShort(settings) {
  // A composite keyword is the whole route: Gaussian supplies method, basis and
  // job steps, so a "method/basis" prefix would describe a route it refuses.
  if (isCompositeJobType(settings?.jobType)) return `#p ${settings.jobType}`;
  // Not a second implementation: this label once showed `ωB97X-D` while the
  // written input carried `wB97XD`, the spelling Gaussian actually reads.
  return routeFull(settings).split('\n')[0].replace(/^#p\s+/, '');
}

/**
 * The route preview is the builder's own output, not a second implementation.
 * It used to re-assemble the keyword list here, which is how it drifted: the
 * preview kept showing a route without the frontier-orbital print while the
 * written input carried `Pop=Full`. A refusal from the builder (for example
 * `Pop=Full` next to `Pop=NBO`) is shown on the preview instead of thrown.
 */
function routeFull(settings) {
  const coords = state.project?.molecule?.coords || [];
  const ecp = ecpRequirement({ basis: settings.basis, elements: coords.map((atom) => atom.element) });
  try {
    return routeFor(settings, { basisName: basisNameFor(settings.basis, ecp) });
  } catch (error) {
    return `# route refused: ${error.message}`;
  }
}

const chkName = (id) => `${id.replace(/-/g, '_')}.chk`;
const inputName = (id) => `${id.replace(/-/g, '_')}.gjf`;
const outputName = (id) => `${id.replace(/-/g, '_')}.log`;

function gateChips(node) {
  if (node.type !== 'calculate') return [];
  const gates = node.settings.gates;
  const parts = [];
  if (gates.thermo) parts.push('thermo');
  if (Number.isInteger(gates.imaginary)) {
    parts.push(`${gates.imaginary} imag`);
    if (gates.imaginary > 0 && Number.isFinite(gates.minMagnitude)) parts.push(`≥${gates.minMagnitude} cm⁻¹`);
  }
  if (gates.finalEnergy) parts.push('final E');
  return parts.length ? parts : ['standard gates'];
}

/* ── Spin-state sweeps (issue 186) ──────────────────────────
 * The model and the planner half already exist in shared/spinSweep.js and
 * shared/workflowTasks.js. The renderer only asks for one, says that it
 * happened, and shows the comparison. A sweep is a set of separate runs over
 * one geometry; nothing here calls its lowest state a ground state.
 */

/** Electrons and the legal multiplicities for a block's own molecule. */
function spinMultiplicitiesForNode(node) {
  const molecule = moleculeForNode(node);
  const atoms = Array.isArray(molecule?.coords) ? molecule.coords : [];
  if (atoms.length === 0) return { electrons: null, values: [] };
  const electrons = atoms.reduce((total, atom) => total + (atomicNumber(atom.element) || 0), 0)
    - Number(molecule.charge || 0);
  if (!Number.isInteger(electrons) || electrons < 0) return { electrons: null, values: [] };
  return { electrons, values: multiplicitiesFor({ electrons }).slice(0, SPIN_SWEEP_MAX) };
}

/** The card/footer line: `spin states 1, 3, 5`, or '' when the block is plain. */
function spinSweepLabel(node) {
  const sweep = node && node.settings ? spinSweepFor(node.settings) : null;
  return sweep ? `spin states ${sweep.multiplicities.join(', ')}` : '';
}

/** A queue row's own multiplicity, named rather than left in the id suffix. */
function spinTaskMeta(task) {
  const spin = task && typeof task.spin === 'object' ? task.spin : null;
  if (!spin || !Number.isInteger(spin.multiplicity)) return '';
  const count = Number.isInteger(spin.count) ? spin.count : null;
  const index = Number.isInteger(spin.index) ? spin.index + 1 : null;
  return count && index
    ? `m${spin.multiplicity} · state ${index}/${count}`
    : `m${spin.multiplicity}`;
}

function datasetForInputNode(node) {
  return node?.type === 'input' ? datasetById(state.project, node.input?.datasetId) : null;
}

/**
 * Issue 169: what a series block would expand into right now, or the refusal.
 * The inspector shows the members the plan will queue, computed by the same
 * function the plan uses — never a second, optimistic count.
 */
function seriesPreview(node, dataset) {
  if (!node?.input?.series) return { records: [], error: '' };
  if (!dataset) return { records: [], error: 'No dataset is bound, so there is no unit to repeat.' };
  try {
    return { records: recordsForInput(node, dataset), error: '' };
  } catch (error) {
    return { records: [], error: error.message };
  }
}

/**
 * Issue 189: what a derivative block would expand into right now, or the
 * refusal. The inspector shows the records the plan will queue, computed by the
 * same function the plan uses — never a second, optimistic expansion.
 */
function derivativePreview(node, dataset) {
  if (!Array.isArray(node?.input?.edits) || node.input.edits.length === 0) return { records: [], error: '' };
  if (!dataset) return { records: [], error: 'No dataset is bound, so there is no parent record to edit.' };
  try {
    return { records: recordsForInput(node, dataset), error: '' };
  } catch (error) {
    return { records: [], error: error.message };
  }
}

/**
 * Issue 188: what a complex block would build right now, or the refusal.
 * The inspector shows the system the plan will queue, computed by the same
 * function the plan uses — never a second, optimistic placement.
 */
function complexPreview(node, dataset) {
  if (!node?.input?.complex) return { records: [], error: '' };
  if (!dataset) return { records: [], error: 'No dataset is bound, so there are no members to combine.' };
  try {
    return { records: recordsForInput(node, dataset, { datasets: state.project.datasets }), error: '' };
  } catch (error) {
    return { records: [], error: error.message };
  }
}

function inputRecordCounts(node) {
  const dataset = datasetForInputNode(node);
  if (!dataset) return { total: 0, enabled: 0 };
  return { total: recordsOf(dataset).length, enabled: enabledRecords(dataset).length };
}

function nodeDetail(node) {
  if (node.type === 'calculate') {
    // The card must describe the engine this block actually runs: with a mixed
    // project the project default is not the block's engine.
    const engine = engineForNode(state.project, node);
    if (engine.id === 'xtb') {
      const label = (XTB_METHODS.find((item) => item.id === (node.settings.xtbMethod || 'gfn2')) || {}).label || 'xTB';
      return `${label} ${node.settings.jobType}`;
    }
    if (engine.id === 'psi4') {
      const method = PSI4_METHODS.find((item) => item.key === String(node.settings.method || '').toLowerCase());
      const basis = PSI4_BASES.find((item) => item.key === String(node.settings.basis || '').toLowerCase());
      return `${method ? method.label : 'Psi4'}${basis ? `/${basis.label}` : ''} ${node.settings.jobType}`;
    }
    if (engine.id === 'pyscf') {
      const method = PYSCF_METHODS.find((item) => item.key === String(node.settings.method || '').toLowerCase());
      const basis = PYSCF_BASES.find((item) => item.key === String(node.settings.basis || '').toLowerCase());
      const space = String(node.settings.pyscfActiveSpace || '').trim();
      return `${method ? method.label : 'PySCF'}${basis ? `/${basis.label}` : ''}${space ? ` CAS(${space})` : ''} ${node.settings.jobType}`;
    }
    return routeShort(node.settings);
  }
  if (node.type === 'condition') return node.condition.expression.replace(/\s*\n\s*/g, ' · ');
  if (node.type === 'analyse') {
    // The card names the expression and the inputs it reads (issue 175): a
    // derived number must never look like a route a block ran.
    const expression = String(node.analyse?.expression || '').trim();
    const names = (Array.isArray(node.analyse?.inputs) ? node.analyse.inputs : [])
      .map((input) => String(input?.name || '').trim()).filter(Boolean);
    if (!expression) return 'no expression yet';
    return names.length ? `${expression} · ${names.join(', ')}` : expression;
  }
  if (node.type === 'generate') {
    const output = node.output;
    if (!output) {
      // Issue 144: the footer says which route is waiting to run, including the
      // in-app one that needs no external binary.
      const route = node.settings.generator === 'import'
        ? 'import'
        : (node.settings.generator === 'uff'
          ? 'UFF (in-app)'
          : (node.settings.generator === 'obabel' ? 'Open Babel (external)' : 'CREST'));
      return `${route} · not run`;
    }
    const spread = Number.isFinite(output.spreadKcal) ? ` · spread ${output.spreadKcal.toFixed(1)}` : '';
    return `${output.count} of ${output.total} kept${spread}`;
  }
  if (node.type === 'loop') return `max ${node.loop.maxAttempts} attempts · ${nodeById(node.loop.target)?.title || 'no target'}`;
  if (node.type === 'merge') return node.merge.policy === 'any' ? 'wait for any input' : 'wait for all inputs';
  if (node.type === 'input') {
    const dataset = datasetForInputNode(node);
    if (!dataset) return 'no dataset bound · import a file';
    if (node.input?.complex) {
      const definition = node.input.complex;
      const preview = complexPreview(node, dataset);
      if (preview.error) return 'complex refused · open the block';
      const atoms = preview.records[0]?.coords.length ?? 0;
      return `${definition.members.length} members · ${definition.placement?.mode || 'as-drawn'} · ${atoms} atoms · needs optimisation`;
    }
    if (node.input?.series) {
      const series = node.input.series;
      const preview = seriesPreview(node, dataset);
      if (preview.error) return 'series refused · open the block';
      return `${node.input.recordId || 'unit'} · n = ${series.from}…${series.to} · ${preview.records.length} members`;
    }
    if (node.input?.edits?.length) {
      const preview = derivativePreview(node, dataset);
      if (preview.error) return 'derivative refused · open the block';
      return `${node.input.recordId || 'every record'} · ${preview.records.length} derivative${preview.records.length === 1 ? '' : 's'} · needs optimisation`;
    }
    const counts = inputRecordCounts(node);
    return `${dataset.title} · ${counts.enabled} of ${counts.total} enabled`;
  }
  if (node.type === 'output') {
    const output = outputOf(node);
    return `${output.kind.toUpperCase()} · ${output.path}`;
  }
  if (node.type === 'note') return node.note.text;
  return '';
}

/**
 * Issue 132: how many conformer blocks in the current flow share a group id.
 * Counted live from the flow and never stored — the id alone is the claim.
 */
function conformerGroupCount(group) {
  const id = String(group || '');
  if (!id) return 0;
  return state.project.nodes.filter((item) => item.type === 'generate'
    && String(item.settings?.group || '') === id).length;
}

function nodeFoot(node) {
  if (node.type === 'calculate') {
    const familyDone = (state.queue?.tasks || []).some((task) => String(task.nodeId || '').startsWith(`${node.id}~`) && task.status === 'completed');
    const output = node.parsed || familyDone ? 'parsed' : node.state === 'ready' ? 'ready to run' : 'no output';
    // Issue 186: a sweeping block says so on its own card — this block queues
    // one run per multiplicity, it is not one run.
    const sweep = spinSweepLabel(node);
    return { left: [gateChips(node).join(' · '), sweep].filter(Boolean).join(' · '), right: output };
  }
  if (node.type === 'condition') return { left: `unknown → ${node.condition.unknown.replace('-', ' ')}`, right: '2 branches' };
  if (node.type === 'prepare') {
    // issue 257: the card footer uses the same tri-state summary as the queue log
    // and the inspector; a dry run never appears as a failed relaxation.
    const output = node.output && typeof node.output === 'object' ? node.output : null;
    const atoms = Number(output?.atomCount);
    return output
      ? { left: prepareSummaryLine(output), right: Number.isFinite(atoms) ? `${atoms} atom${atoms === 1 ? '' : 's'}` : '' }
      : { left: prepareLabel(node.settings), right: 'no output' };
  }
  if (node.type === 'generate') {
    // Issue 129: the footer names what produced the ensemble — an imported
    // file's declared program, or the CREST method that ran here.
    const origin = node.output && typeof node.output === 'object'
      ? conformerOriginShort(node.output)
      : (node.settings.generator === 'crest'
        ? `CREST ${node.settings.method === 'gfnff' ? 'GFN-FF' : 'GFN2'}`
        : (node.settings.generator === 'uff'
          ? 'UFF · in-app'
          : (node.settings.generator === 'obabel' ? 'Open Babel · MMFF94' : 'imported ensemble')));
    // Issue 132: a grouped block says so, and how many blocks in this flow
    // share the id. An ungrouped block adds nothing — no "group null".
    const groupId = node.settings.group || '';
    const groupText = conformerGroupLabel(groupId, { blocks: conformerGroupCount(groupId), compact: true });
    const chosen = node.output?.selectedId || '';
    return { left: [origin, groupText].filter(Boolean).join(' · '), right: chosen ? `using ${chosen}` : 'no choice' };
  }
  if (node.type === 'loop') return { left: `until ${node.loop.until}`, right: `×${node.loop.maxAttempts}` };
  if (node.type === 'merge') return { left: `policy: ${node.merge.policy}`, right: 'join' };
  if (node.type === 'input') {
    const dataset = datasetForInputNode(node);
    const counts = inputRecordCounts(node);
    if (node.input?.complex) {
      const definition = node.input.complex;
      const record = complexPreview(node, dataset).records[0] || null;
      const members = definition.members.length;
      return {
        left: `${members} member${members === 1 ? '' : 's'} · ${record ? record.coords.length : 0} atoms`,
        right: `${definition.placement?.mode || 'as-drawn'} · needs optimisation`,
      };
    }
    if (node.input?.series) {
      const linkage = node.input.series.linkage || {};
      const members = seriesPreview(node, dataset).records.length;
      return {
        left: `n = ${node.input.series.from}…${node.input.series.to} · ${members} member${members === 1 ? '' : 's'}`,
        right: `${linkage.donor ?? '?'}→${linkage.acceptor ?? '?'} · ${Number(linkage.bondLengthAngstrom ?? 0).toFixed(2)} Å`,
      };
    }
    if (node.input?.edits?.length) {
      const derivatives = derivativePreview(node, dataset).records.length;
      const parent = node.input.recordId || 'every record';
      return {
        left: `${derivatives} derivative${derivatives === 1 ? '' : 's'} · ${parent}`,
        right: 'needs optimisation',
      };
    }
    return {
      left: dataset ? `${counts.enabled}/${counts.total} enabled` : 'not bound',
      right: dataset?.source?.format ? String(dataset.source.format).toUpperCase() : 'no dataset',
    };
  }
  if (node.type === 'output') {
    const output = outputOf(node);
    return {
      left: output.include === 'record' ? 'one file per record' : 'one file per flow',
      right: output.manifest ? 'manifest' : 'no manifest',
    };
  }
  if (node.type === 'note') return { left: 'annotation', right: '' };
  if (node.type === 'analyse') {
    const inputs = Array.isArray(node.analyse?.inputs) ? node.analyse.inputs : [];
    return { left: 'derived', right: `${inputs.length} input${inputs.length === 1 ? '' : 's'}` };
  }
  return { left: '', right: '' };
}

function kindCode(node) {
  if (node.type === 'condition') return 'IF';
  if (node.type === 'analyse') return 'fx';
  if (node.type === 'prepare') return 'PR';
  if (node.type === 'generate') return 'CF';
  if (node.type === 'loop') return '↻';
  if (node.type === 'merge') return '⋈';
  if (node.type === 'input') return node.input?.complex ? '⊕' : node.input?.edits?.length ? 'Δ' : node.input?.series ? 'n×' : 'IN';
  if (node.type === 'output') return 'OUT';
  if (node.type === 'note') return '✎';
  return node.kind;
}

function kindLabel(node) {
  if (node.type === 'condition') return 'Control';
  if (node.type === 'analyse') return 'Analyse';
  if (node.type === 'prepare') return 'Prepare';
  if (node.type === 'generate') return 'Generate';
  if (node.type === 'loop') return 'Control';
  if (node.type === 'merge') return 'Join';
  if (node.type === 'input') return node.input?.complex ? 'Complex' : node.input?.edits?.length ? 'Derivative' : node.input?.series ? 'Series' : 'Data';
  if (node.type === 'output') return 'Data';
  if (node.type === 'note') return 'Note';
  return 'Calculate';
}

/* ── Graph rendering ──────────────────────────────────────── */

const nodesEl = () => $('#nodes');
const edgesEl = () => $('#edge-layer');
const worldEl = () => $('#world');
const viewportEl = () => $('#canvas-viewport');
const inspectorEl = () => $('#inspector');

function portHtml(node) {
  if (node.type === 'note') return '';
  const ins = incoming(node.id);
  const outs = outgoing(node.id);
  let html = '';
  if (node.type === 'condition') {
    html += '<span class="port left" aria-hidden="true"></span>';
    html += `<span class="port true" data-from="${node.id}" data-port="true" tabindex="0" role="button" aria-label="Connect TRUE branch"></span>`;
    html += `<span class="port false" data-from="${node.id}" data-port="false" tabindex="0" role="button" aria-label="Connect FALSE branch"></span>`;
    html += '<span class="branch-tag true">T</span><span class="branch-tag false">F</span>';
    return html;
  }
  if (node.type === 'loop') {
    return `<span class="port left" aria-hidden="true"></span><span class="port bottom" data-from="${node.id}" data-port="bottom" tabindex="0" role="button" aria-label="Connect loop back"></span><span class="loop-tag">↻</span>`;
  }
  if (node.type === 'output') return '<span class="port left" aria-hidden="true"></span>';
  if (node.type === 'input') {
    return `<span class="port right" data-from="${node.id}" data-port="right" tabindex="0" role="button" aria-label="Connect dataset output"></span>`;
  }
  if (node.type === 'merge') {
    return `<span class="port left" aria-hidden="true"></span><span class="port right" data-from="${node.id}" data-port="right" tabindex="0" role="button" aria-label="Connect output"></span>`;
  }

  html += '<span class="port left" aria-hidden="true"></span>';
  html += `<span class="port right" data-from="${node.id}" data-port="right" tabindex="0" role="button" aria-label="Connect output"></span>`;
  if (outs.some((edge) => edge.fromPort === 'bottom')) {
    html += `<span class="port bottom" data-from="${node.id}" data-port="bottom" tabindex="0" role="button" aria-label="Connect output below"></span>`;
  }
  if (ins.some((edge) => edge.toPort === 'top')) html += '<span class="port top" aria-hidden="true"></span>';
  if (ins.some((edge) => edge.toPort === 'bottomIn')) html += '<span class="port bottom in" aria-hidden="true"></span>';
  return html;
}

/**
 * The numbers a finished block actually produced, for the card itself.
 *
 * The workbench used to say only "parsed"; the value the user came for was one
 * click away in the run console. A card now carries its own result — energy or
 * SAPT total, plus the quantity that decides its gate — while the inspector and
 * the results panel keep the full table. Nothing is invented: a field the
 * parser did not report is simply absent.
 */
function resultFacts(node) {
  // Issue 131: a block carrying a result another program computed says so on
  // the card, with its program and version. Its number is not dressed as the
  // run's own result line.
  const imported = importedSummary(node);
  if (imported) {
    const energy = Number.isFinite(imported.energyHartree) ? `${imported.energyHartree.toFixed(5)} Eh` : 'no energy recorded';
    return {
      main: IMPORTED_BADGE_TEXT,
      sub: `${imported.program ?? 'unknown program'}${imported.version ? ` ${imported.version}` : ''} · E ${energy}`,
      tone: 'warn',
    };
  }
  if (node.type === 'calculate') {
    // A block downstream of a dataset runs once per record: there is no single
    // energy to show, so the card reports how many records finished and passed.
    const family = (state.queue?.tasks || []).filter((task) => String(task.nodeId || '').startsWith(`${node.id}~`));
    if (family.length > 0) {
      const done = family.filter((task) => task.status === 'completed').length;
      const passed = family.filter((task) => String(task.gateVerdict || '') === 'pass').length;
      const running = family.some((task) => task.status === 'running');
      return {
        main: `${done}/${family.length} records${running ? ' · running' : ''}`,
        sub: `${passed}/${family.length} gates pass`,
        tone: done === family.length ? (passed === family.length ? 'ok' : 'warn') : '',
      };
    }
    // Issue 186: the same block is also a sweep, so its card reports the
    // comparison the queue wrote — never a single state dressed as the answer.
    const sweep = spinSweepFor(node.settings);
    const verdict = sweep && state.queue?.spins ? state.queue.spins[node.id] : null;
    if (sweep && verdict && typeof verdict === 'object') {
      const rows = Array.isArray(verdict.rows) ? verdict.rows : [];
      const missing = rows.filter((row) => !Number.isFinite(row.energyHartree));
      if (verdict.available === true) {
        const ran = rows.length - missing.length;
        const spread = rows.reduce((max, row) => (Number.isFinite(row.relativeKcalPerMol)
          ? Math.max(max, row.relativeKcalPerMol) : max), 0);
        return {
          main: `m${verdict.groundMultiplicity} lowest computed`,
          sub: missing.length
            ? `${ran}/${rows.length} states ran · ${missing.map((row) => `m${row.multiplicity}`).join(', ')} no energy`
            : `states ${rows.map((row) => row.multiplicity).join(', ')} · ΔE ${spread.toFixed(1)} kcal/mol`,
          tone: missing.length ? 'warn' : 'ok',
        };
      }
      return {
        main: 'spin sweep · no comparison',
        sub: String(verdict.reason || 'no state reported a final energy'),
        tone: 'warn',
      };
    }
    const parsed = node.parsed && typeof node.parsed === 'object' ? node.parsed : null;
    if (!parsed) return null;
    const gateVerdict = latestTaskFor(node.id)?.gateVerdict || null;
    const tone = gateVerdict === 'pass' ? 'ok' : gateVerdict === 'fail' ? 'bad' : gateVerdict === 'unknown' ? 'warn' : '';
    const sapt = parsed.sapt && typeof parsed.sapt === 'object' ? parsed.sapt : null;
    if (sapt && Number.isFinite(sapt.totalKj)) {
      const sign = sapt.totalKj > 0 ? '+' : '';
      return {
        main: `${sign}${sapt.totalKj.toFixed(2)} kJ/mol`,
        sub: `SAPT0 · ${sapt.totalKcal.toFixed(2)} kcal/mol`,
        tone,
      };
    }
    const energy = Number.isFinite(parsed.finalEnergy?.hartree) ? parsed.finalEnergy.hartree : null;
    const gibbs = Number.isFinite(parsed.thermochemistry?.freeEnergyHartree) ? parsed.thermochemistry.freeEnergyHartree : null;
    const imaginary = Number.isInteger(parsed.frequencies?.imaginaryCount) ? parsed.frequencies.imaginaryCount : null;
    const extras = [];
    if (Number.isFinite(gibbs)) extras.push(`ΔG ${gibbs.toFixed(5)}`);
    if (imaginary !== null) extras.push(imaginary === 0 ? '0 imaginary' : `${imaginary} imaginary`);
    if (energy === null && extras.length === 0) return null;
    return {
      main: energy === null ? extras.shift() : `E ${energy.toFixed(5)} Eh`,
      sub: extras.join(' · '),
      tone,
    };
  }
  if (node.type === 'generate') {
    const output = node.output && typeof node.output === 'object' ? node.output : null;
    if (!output || !Number.isFinite(output.count)) return null;
    const spread = Number.isFinite(output.spreadKcal) ? ` · spread ${output.spreadKcal.toFixed(2)}` : '';
    const top = Array.isArray(output.members) && output.members.length
      ? Math.max(...output.members.map((member) => Number(member.population) || 0))
      : null;
    // Issue 130: the card says what unit the absolute energies are in. The
    // spread is kcal/mol either way; the unit and method name the members.
    const energy = conformerEnergyLabel(output);
    return {
      main: `${output.count} of ${output.total} kept${spread}`,
      sub: top ? `${energy} · top ${(top * 100).toFixed(1)}%` : energy,
      tone: 'ok',
    };
  }
  if (node.type === 'output') {
    const written = latestTaskFor(node.id);
    if (!written || written.status !== 'completed' || !written.reason) return null;
    if (!/^wrote /.test(String(written.reason))) return null;
    // `path · bytes · sha256 …` is too long for a card: keep path and a short
    // size, the hash stays in the queue record and the run folder.
    const detail = String(written.reason).replace(/^wrote /, '').replace(/ · sha256 .*$/, '');
    // `screen/results.csv · 4105 bytes` is wider than the card; a short size
    // keeps the path readable without clipping the unit mid-word.
    const short = detail.replace(/(\d+) bytes$/, (_m, n) => {
      const bytes = Number(n);
      return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
    });
    return { main: short, sub: '', tone: 'ok' };
  }
  return null;
}

/** The queue task for a block, including the `node~record` family members. */
function latestTaskFor(nodeId) {
  const tasks = Array.isArray(state.queue?.tasks) ? state.queue.tasks : [];
  const own = tasks.filter((task) => task.nodeId === nodeId || String(task.nodeId || '').startsWith(`${nodeId}~`));
  if (own.length === 0) return null;
  return own.find((task) => task.status === 'running') || own[own.length - 1];
}

/** Running/queued state of a block, for the card's live indicator. */
function runStateOf(node) {
  const task = latestTaskFor(node.id);
  if (!task) return null;
  if (task.status === 'running') return 'running';
  if (task.status === 'queued') return 'queued';
  return null;
}

/* ── Cost estimate (issue 143) ─────────────────────────────────
 * The card and Setup pane both read the same module. Neither invents a number:
 * a block the model cannot price says why, in the same slot.
 */

const FALLBACK_CORES = 8;

/** Logical cores the browser can see; 8 is the documented fallback. */
function hostCoreCount() {
  const value = Number(globalThis.navigator?.hardwareConcurrency);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 256) : FALLBACK_CORES;
}

/** A duration a person reads, at the precision the estimate deserves. */
function formatCostDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0 s';
  const tidy = (number, digits = 1) => String(Number(number.toFixed(digits)));
  if (value < 10) return `${tidy(value)} s`;
  if (value < 90) return `${Math.round(value)} s`;
  const minutes = value / 60;
  if (value < 3600) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? tidy(hours) : Math.round(hours)} h`;
  return `${tidy(hours / 24)} d`;
}

function formatCostRange(range) {
  if (!range) return '';
  return `${formatCostDuration(range.low)}\u2013${formatCostDuration(range.high)}`;
}

/** One sentence for a block card or an inspector line. */
function costCardText(entry) {
  if (!entry) return '';
  if (entry.notEstimated) return `no estimate: ${entry.notEstimated}`;
  const cores = `${entry.procs} core${entry.procs === 1 ? '' : 's'}`;
  let text = `≈ ${formatCostRange(entry.wallSeconds)} on ${cores}`
    + ` · ${entry.confidence} confidence (${entry.calibrationPoints} point${entry.calibrationPoints === 1 ? '' : 's'})`;
  if (entry.exceedsOvernight) text += ' · longer than an overnight (8 h) run';
  if (entry.timeout?.exceeds) {
    text += ` · the queue will stop it at the ${formatCostDuration(entry.timeout.limitSeconds)} limit`;
  }
  return text;
}

/**
 * The estimate for one block as its own task. Setup prices the whole flow; a
 * card prices the one run the block would queue, so the two do not disagree.
 */
function costEntryForNode(node) {
  if (!node || node.type !== 'calculate' || !state.project) return null;
  try {
    const engine = engineForNode(state.project, node);
    const entry = estimateCost(state.project, {
      tasks: [{
        taskId: node.id,
        nodeId: node.id,
        type: 'calculate',
        title: node.title,
        engine: engine.id,
        settings: node.settings,
        validity: { molecule: moleculeForNode(node) },
      }],
      edges: [],
    }, { cores: hostCoreCount(), maxParallel: 1 });
    return entry.tasks?.[0] || null;
  } catch {
    // A half-edited project has no plan to price; the card stays silent rather
    // than showing a number for a state that cannot be queued.
    return null;
  }
}

function renderNodeCard(node) {
  const selected = state.selected.type === 'node' && state.selected.id === node.id;
  const chips = nodeFoot(node);
  const status = statusFor(node);
  const showStatus = node.type !== 'note';
  const facts = resultFacts(node);
  const runState = runStateOf(node);
  // Issue 143: a block that has not produced a result yet shows what it is
  // expected to cost, in the slot the result would occupy. No result and no
  // estimate (a refused block) is a sentence, not a blank.
  const cost = facts ? null : costEntryForNode(node);
  const costMain = cost
    ? (cost.notEstimated ? 'no estimate' : `≈ ${formatCostRange(cost.wallSeconds)}`)
    : '';
  const costSub = cost
    ? (cost.notEstimated
      ? cost.notEstimated
      : `${cost.procs} cores · ${cost.confidence} (${cost.calibrationPoints} pts)`)
    : '';
  const checkpointBadge = node.type === 'calculate' && node.checkpointFrom
    ? '<span class="chk-badge">chk</span>'
    : '';
  return `
    <article class="node node-${node.type} state-${String(node.state).replace(/\s+/g, '-')}${selected ? ' is-selected' : ''}${runState ? ` is-${runState}` : ''}"
      data-node-id="${node.id}" data-run="${runState || 'idle'}" tabindex="0" role="group" aria-label="${esc(node.title)}, ${showStatus ? status.label : 'note'}"
      style="left:${node.x}px;top:${node.y}px">
      ${checkpointBadge}
      ${runState === 'running' ? '<span class="node-progress" aria-hidden="true"></span>' : ''}
      <div class="node-head">
        <span class="node-icon">${esc(kindCode(node))}</span>
        <span class="node-kind">${esc(kindLabel(node))}</span>
        ${showStatus ? `<span class="node-status"><i></i>${status.label}</span>` : ''}
      </div>
      <div class="node-title">${esc(node.title)}</div>
      <div class="node-route">${esc(nodeDetail(node))}</div>
      ${facts ? `<div class="node-result${facts.tone ? ` is-${facts.tone}` : ''}">
        <span class="node-result-main">${esc(facts.main)}</span>
        ${facts.sub ? `<span class="node-result-sub">${esc(facts.sub)}</span>` : ''}
      </div>` : (cost ? `<div class="node-result is-cost" data-cost="${esc(costCardText(cost))}"
        title="${esc(cost.basis.join(' '))}">
        <span class="node-result-main">${esc(costMain)}</span>
        <span class="node-result-sub">${esc(costSub)}</span>
      </div>` : '')}
      <div class="node-foot">
        <span class="gate">${esc(chips.left)}</span>
        <span class="out${chips.right ? '' : ' empty'}">${esc(chips.right)}</span>
      </div>
      ${portHtml(node)}
    </article>`;
}

function anchorFor(node, side) {
  if (side === 'left') return { x: node.x, y: node.y + H / 2 };
  if (side === 'right') return { x: node.x + W, y: node.y + H / 2 };
  if (side === 'top') return { x: node.x + W / 2, y: node.y };
  if (side === 'bottom') return { x: node.x + W / 2 + 13, y: node.y + H };
  if (side === 'bottomIn') return { x: node.x + W / 2 - 13, y: node.y + H };
  if (side === 'true') return { x: node.x + W, y: node.y + 34 };
  if (side === 'false') return { x: node.x + W, y: node.y + 82 };
  return { x: node.x + W, y: node.y + H / 2 };
}

function edgeFromSide(edge) {
  if (edge.type === 'loop') return 'bottom';
  if (edge.type === 'branch') return edge.branch;
  if (edge.fromPort) return edge.fromPort;
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return 'right';
  if (to.y > from.y + 40 && Math.abs(to.x - from.x) < 80) return 'bottom';
  return 'right';
}

function edgeToSide(edge) {
  if (edge.type === 'loop') return 'bottomIn';
  if (edge.type === 'branch') return 'left';
  if (edge.toPort) return edge.toPort;
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return 'left';
  if (to.y > from.y + 40 && Math.abs(to.x - from.x) < 80) return 'top';
  return 'left';
}

function loopPath(a, b) {
  const lane = LOOP_LANE;
  return [
    `M ${a.x} ${a.y}`,
    `L ${a.x} ${lane - 14}`,
    `Q ${a.x} ${lane} ${a.x - 14} ${lane}`,
    `L ${b.x + 14} ${lane}`,
    `Q ${b.x} ${lane} ${b.x} ${lane - 14}`,
    `L ${b.x} ${b.y}`,
  ].join(' ');
}

function edgePath(edge) {
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return '';
  const fromSide = edgeFromSide(edge);
  const toSide = edgeToSide(edge);
  const a = anchorFor(from, fromSide);
  const b = anchorFor(to, toSide);
  if (edge.type === 'loop') return loopPath(a, b);
  if (fromSide === 'bottom' && toSide === 'top') {
    const dy = Math.max(34, (b.y - a.y) / 2);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(38, Math.abs(b.x - a.x) * 0.44);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function edgeClass(edge) {
  if (edge.type === 'checkpoint') return 'checkpoint';
  if (edge.type === 'branch') return edge.branch === 'true' ? 'branch-true' : 'branch-false';
  if (edge.type === 'loop') return 'loop';
  const target = nodeById(edge.to);
  if (!target) return 'blocked';
  if (target.state === 'passed') return 'passed';
  if (target.state === 'ready') return 'ready';
  if (target.state === 'review') return 'review';
  return 'blocked';
}

function edgeLabel(edge) {
  if (edge.type === 'checkpoint') return { text: 'chk', width: 30, cls: 'checkpoint' };
  if (edge.type === 'branch') {
    return {
      text: edge.branch === 'true' ? 'TRUE' : 'FALSE',
      width: 38,
      cls: edge.branch === 'true' ? 'branch-true' : 'branch-false',
    };
  }
  if (edge.type === 'loop') {
    const loop = nodeById(edge.from)?.loop;
    return { text: `retry ×${loop?.maxAttempts || 3}`, width: 66, cls: 'loop' };
  }
  return null;
}

function renderEdges() {
  const layer = edgesEl();
  if (!layer) return;
  layer.innerHTML = state.project.edges.map((edge) => {
    const id = edgeId(edge);
    const path = edgePath(edge);
    if (!path) return '';
    const selected = state.selected.type === 'edge' && state.selected.id === id;
    const label = edgeLabel(edge);
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    let labelHtml = '';
    if (label && from && to) {
      const a = anchorFor(from, edgeFromSide(edge));
      const b = anchorFor(to, edgeToSide(edge));
      const lx = edge.type === 'loop' ? (a.x + b.x) / 2 : (a.x + b.x) / 2;
      const ly = edge.type === 'loop' ? LOOP_LANE : (a.y + b.y) / 2;
      labelHtml = `<g class="edge-label ${label.cls}${selected ? ' selected' : ''}" data-edge-id="${esc(id)}" transform="translate(${lx},${ly})">
        <rect x="${-label.width / 2}" y="-8" width="${label.width}" height="16" rx="5"/>
        <text>${esc(label.text)}</text>
      </g>`;
    }
    return `
      <path class="edge-line ${edgeClass(edge)}${selected ? ' selected' : ''}" d="${path}"></path>
      <path class="edge-hit" d="${path}" data-edge-id="${esc(id)}"></path>
      ${labelHtml}`;
  }).join('');
  renderPreview();
}

function renderPreview() {
  const layer = edgesEl();
  if (!layer) return;
  let path = $('#edge-preview');
  if (!state.connecting) {
    if (path) path.remove();
    return;
  }
  const from = nodeById(state.connecting.from);
  if (!from) return;
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('id', 'edge-preview');
    path.setAttribute('class', 'edge-preview');
    layer.appendChild(path);
  }
  const a = anchorFor(from, state.connecting.port);
  const b = state.connecting.point;
  const dx = Math.max(36, Math.abs(b.x - a.x) * 0.44);
  path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
}

/* ── Flow tabs ────────────────────────────────────────────── */

function renderFlowTabs() {
  const el = $('#flow-tabs');
  if (!el) return;
  const tabs = flowTabModels(state.project);
  const tabHtml = tabs.map((tab) => {
    if (state.renamingFlowId === tab.id) {
      return `<span class="flow-tab is-editing"><input class="flow-rename" data-flow-rename="${esc(tab.id)}" value="${esc(tab.title)}" aria-label="Flow title" spellcheck="false" autocomplete="off"></span>`;
    }
    // A tab is a status surface, not just a label: it says how much of the flow
    // has actually passed, and whether this is the flow currently draining.
    const flow = flowById(state.project, tab.id);
    const flowNodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
    const workable = flowNodes.filter((item) => item.type !== 'note');
    const passed = workable.filter((item) => item.state === 'passed').length;
    const review = workable.filter((item) => item.state === 'review').length;
    const blocked = workable.filter((item) => item.state === 'blocked').length;
    const running = state.queue?.flowId === tab.id && /^(running|queued)$/.test(String(state.queue?.status || ''));
    const tone = running ? 'running'
      : review > 0 ? 'review'
        : blocked > 0 ? 'blocked'
          : passed > 0 && passed === workable.length ? 'passed' : 'ready';
    const meta = running ? 'running'
      : passed > 0 ? `${passed}/${workable.length}`
        : tab.recordCount > 0 ? `${tab.recordCount} rec` : `${tab.nodeCount} blk`;
    const title = `${tab.title} · ${countLabel(tab.nodeCount, 'block')}`
      + `${tab.recordCount > 0 ? ` · ${countLabel(tab.recordCount, 'record')}` : ''}`
      + `${passed > 0 ? ` · ${passed} of ${workable.length} passed` : ''}`;
    return `<button type="button" role="tab" class="flow-tab${tab.active ? ' is-active' : ''} is-${tone}" data-flow-id="${esc(tab.id)}" aria-selected="${tab.active}" title="${esc(title)}">
      <i class="flow-dot" aria-hidden="true"></i><span class="flow-tab-title">${esc(tab.title)}</span><span class="flow-tab-meta">${esc(meta)}</span>
    </button>`;
  }).join('');
  const pendingDelete = state.confirmDeleteFlowId ? flowById(state.project, state.confirmDeleteFlowId) : null;
  const actions = pendingDelete
    ? `<span class="flow-confirm">Delete “${esc(pendingDelete.title || pendingDelete.id)}”?
        <button type="button" class="tool danger" data-action="confirm-delete-flow">Delete</button>
        <button type="button" class="tool" data-action="cancel-delete-flow">Cancel</button>
      </span>`
    : `<span class="flow-actions">
        <button type="button" class="tool" data-action="duplicate-flow" title="Duplicate the active flow without its runs">Duplicate</button>
        <button type="button" class="tool" data-action="rename-flow" title="Rename the active flow">Rename</button>
        <button type="button" class="tool" data-action="delete-flow" title="Delete the active flow">Delete</button>
      </span>`;
  el.innerHTML = `${tabHtml}
    <button type="button" class="flow-add" data-action="add-flow" title="Add a flow" aria-label="Add a flow">+</button>
    <span class="flow-spacer"></span>${actions}`;
  if (state.renamingFlowId) {
    const input = $('.flow-rename', el);
    input?.focus();
    input?.select();
  }
}

function switchFlow(id) {
  const wanted = String(id || '');
  if (!wanted || activeFlowId(state.project) === wanted) return;
  if (!flowById(state.project, wanted)) return;
  state.project.activeFlowId = wanted;
  attachGraphAliases(state.project);
  state.selected = { type: 'project', id: null };
  state.renamingFlowId = null;
  state.confirmDeleteFlowId = null;
  renderGraph();
  renderInspector();
}

function addFlow() {
  if (!Array.isArray(state.project.flows)) state.project.flows = [];
  const flows = state.project.flows;
  if (flows.length >= LIMITS.flows) {
    toast(`A project can hold at most ${LIMITS.flows} flows.`);
    return;
  }
  const title = nextFlowTitle(flows);
  const id = flowIdFromTitle(title, flows.map((flow) => flow.id));
  flows.push({ id, title, nodes: [], edges: [] });
  state.project.activeFlowId = id;
  attachGraphAliases(state.project);
  state.selected = { type: 'project', id: null };
  state.renamingFlowId = null;
  state.confirmDeleteFlowId = null;
  renderGraph();
  renderInspector();
  toast(`“${title}” added. Add blocks to build its graph.`);
}

function duplicateActiveFlow() {
  const flow = activeFlow(state.project);
  if (!flow) return;
  if (state.project.flows.length >= LIMITS.flows) {
    toast(`A project can hold at most ${LIMITS.flows} flows.`);
    return;
  }
  const title = `${flow.title || flow.id} copy`;
  const id = flowIdFromTitle(title, state.project.flows.map((entry) => entry.id));
  const copy = duplicateFlowGraph(flow, { id, title });
  const index = state.project.flows.indexOf(flow);
  state.project.flows.splice(index + 1, 0, copy);
  state.project.activeFlowId = id;
  attachGraphAliases(state.project);
  state.selected = { type: 'project', id: null };
  state.renamingFlowId = null;
  state.confirmDeleteFlowId = null;
  renderGraph();
  renderInspector();
  toast(`“${title}” duplicated · outputs and run states were cleared.`);
}

function startFlowRename() {
  const flow = activeFlow(state.project);
  if (!flow) return;
  state.renamingFlowId = flow.id;
  state.confirmDeleteFlowId = null;
  renderFlowTabs();
}

function commitFlowRename(input) {
  const id = input?.dataset?.flowRename;
  const flow = id ? flowById(state.project, id) : null;
  if (!flow || state.renamingFlowId !== id) {
    state.renamingFlowId = null;
    renderFlowTabs();
    return;
  }
  const title = String(input.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (title) flow.title = title;
  state.renamingFlowId = null;
  renderGraph();
  renderInspector();
}

function cancelFlowRename() {
  state.renamingFlowId = null;
  renderFlowTabs();
}

function requestDeleteFlow() {
  if (flowsOf(state.project).length <= 1) {
    toast('A project needs at least one flow.');
    return;
  }
  const flow = activeFlow(state.project);
  if (!flow) return;
  state.confirmDeleteFlowId = flow.id;
  state.renamingFlowId = null;
  renderFlowTabs();
}

function confirmDeleteFlow() {
  const id = state.confirmDeleteFlowId;
  const flows = flowsOf(state.project);
  if (!id || flows.length <= 1) {
    state.confirmDeleteFlowId = null;
    renderFlowTabs();
    return;
  }
  const index = flows.findIndex((flow) => flow.id === id);
  const remaining = flows.filter((flow) => flow.id !== id);
  const fallback = remaining[Math.min(index, remaining.length - 1)] || remaining[0];
  state.project.flows = remaining;
  state.project.activeFlowId = fallback.id;
  state.confirmDeleteFlowId = null;
  attachGraphAliases(state.project);
  state.selected = { type: 'project', id: null };
  renderGraph();
  renderInspector();
  toast(`Flow deleted. Run folders stay on disk.`);
}

function cancelDeleteFlow() {
  state.confirmDeleteFlowId = null;
  renderFlowTabs();
}

function renderGraph() {
  const container = nodesEl();
  if (!container) return;
  container.innerHTML = state.project.nodes.map(renderNodeCard).join('');
  renderEdges();
  renderFlowTabs();
  updateCounts();
  refreshDirty();
}

function updateSavePill(dirty) {
  const pill = $('#save-pill');
  if (!pill) return;
  pill.classList.toggle('is-dirty', dirty);
  pill.innerHTML = `<i class="dot"></i> ${dirty ? 'unsaved changes' : 'saved locally'}`;
}

function refreshDirty() {
  const dirty = state.savedSnapshot === null || JSON.stringify(state.project) !== state.savedSnapshot;
  updateSavePill(dirty);
  syncEditHistory();
  if (dirty !== state.dirty) {
    state.dirty = dirty;
    desktop?.setDirty?.(dirty);
  }
  // Every mutation funnels through here, so this is the one place that needs to
  // know a draft may be stale. The debounce coalesces a burst of edits (a drag,
  // a slider) into a single write; nothing is written once the project is clean.
  if (dirty) scheduleDraftSave();
}

/* ── Undo / redo ──────────────────────────────────────────── */

/**
 * One JSON snapshot per committed edit. `refreshDirty` is the funnel every
 * mutation already passes through, so recording here cannot miss an edit — and
 * a render that changes nothing produces no step.
 */
function syncEditHistory() {
  const snapshot = JSON.stringify(state.project);
  if (!state.history) {
    state.history = createHistory(snapshot);
  } else {
    state.history = recordSnapshot(state.history, snapshot);
  }
}

function resetEditHistory() {
  state.history = createHistory(JSON.stringify(state.project));
}

function applyHistorySnapshot(snapshot) {
  if (typeof snapshot !== 'string') return;
  try {
    state.project = JSON.parse(snapshot);
  } catch {
    toast('That history step could not be restored.');
    return;
  }
  // A snapshot is plain JSON: `nodes`/`edges` are a second copy, so point
  // them back at the active flow's arrays before anything reads them.
  hydrateProject(state.project);
  state.selected = { type: 'project', id: null };
  state.connecting = null;
  state.keyboardConnect = null;
  const name = $('#project-name-text');
  if (name) name.textContent = state.project.name || 'Untitled project';
  renderGraph();
  renderInspector();
  updateCounts();
  updateRunConsoleCopy();
  refreshEngineChips();
  syncRunnerInputs();
}

function undoEdit() {
  const step = undoStep(state.history);
  if (!step.snapshot) {
    toast('Nothing to undo.');
    return;
  }
  state.history = step.history;
  applyHistorySnapshot(step.snapshot);
  toast('Undone.');
}

function redoEdit() {
  const step = redoStep(state.history);
  if (!step.snapshot) {
    toast('Nothing to redo.');
    return;
  }
  state.history = step.history;
  applyHistorySnapshot(step.snapshot);
  toast('Redone.');
}

function markProjectSaved(filePath) {
  state.projectPath = filePath;
  state.savedSnapshot = JSON.stringify(state.project);
  state.draftBaseline = state.savedSnapshot;
  // The draft bar offers to replace what is on screen; once another project
  // becomes current that offer is meaningless, so it goes away with it.
  dismissDraftBar();
  refreshDirty();
}

/* ── Crash-safe draft ─────────────────────────────────────── */

// Long enough that typing or dragging does not hammer localStorage, short
// enough that a crash costs at most the last moment of work.
const DRAFT_DEBOUNCE_MS = 600;

const draftStorage = () => {
  // The renderer is also loaded in a plain browser during development.
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;   // storage disabled: run without drafts rather than fail
  }
};

function clearDraft() {
  try {
    draftStorage()?.removeItem(DRAFT_KEY);
  } catch {
    // A failed removal must not break saving the project itself.
  }
}

function scheduleDraftSave() {
  if (!draftStorage()) return;
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(writeDraft, DRAFT_DEBOUNCE_MS);
}

/**
 * Persist the project as the recovery copy. Oversized projects get no draft at
 * all — a partial or truncated draft would be worse than none, because the next
 * session would offer to restore work that was never fully saved.
 */
function writeDraft() {
  state.draftTimer = null;
  const storage = draftStorage();
  if (!storage || !state.dirty) return;
  let payload;
  try {
    if (JSON.stringify(state.project) === state.draftBaseline) return;
    payload = JSON.stringify({
      version: DRAFT_VERSION,
      updatedAt: Date.now(),
      filePath: state.projectPath || null,
      project: state.project,
    });
  } catch {
    clearDraft();
    return;
  }
  if (!payload || new TextEncoder().encode(payload).length > MAX_DRAFT_BYTES) {
    clearDraft();
    return;
  }
  try {
    storage.setItem(DRAFT_KEY, payload);
  } catch {
    clearDraft();   // over quota: keep the old draft out of the way
  }
}

function dismissDraftBar() {
  const bar = $('#draft-bar');
  if (bar) bar.remove();
}

/**
 * Non-blocking restore bar. It is deliberately not a modal: the draft is an
 * offer, and the user must be able to keep working (or open a file) without
 * answering it. Styling is inline because this element is created by the
 * renderer and owns no stylesheet rule.
 */
function renderDraftBar(draft) {
  dismissDraftBar();
  const bar = document.createElement('div');
  bar.id = 'draft-bar';
  bar.setAttribute('role', 'status');
  bar.style.cssText = [
    // Bottom-left keeps it clear of the run console (right) and the canvas HUD
    // (top-left); it is a prompt to answer, not a banner to read past.
    'position:fixed',
    'bottom:52px',
    'left:18px',
    'z-index:190',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'max-width:min(560px, calc(100vw - 32px))',
    'padding:8px 10px 8px 13px',
    'border:1px solid var(--border-strong)',
    'border-radius:9px',
    'background:var(--surface-raised)',
    'box-shadow:var(--shadow-panel)',
    'color:var(--text-primary)',
    'font-size: var(--text-size-xs)',
  ].join(';');
  bar.innerHTML = `
    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Unsaved draft from ${esc(draftAgeLabel(draft.updatedAt, Date.now()))}</span>
    <button type="button" class="btn small" data-draft-action="restore">Restore</button>
    <button type="button" class="btn small" data-draft-action="discard">Discard</button>`;
  bar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-draft-action]')?.dataset.draftAction;
    if (action === 'restore') { restoreDraft(draft); return; }
    if (action === 'discard') {
      clearDraft();
      dismissDraftBar();
      toast('Draft discarded.');
    }
  });
  document.body.appendChild(bar);
}

/** Re-read the draft at startup; anything untrustworthy is dropped, not shown. */
function offerDraftRestore() {
  const storage = draftStorage();
  if (!storage) return;
  let raw;
  try {
    raw = storage.getItem(DRAFT_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  const draft = normalizeDraft(raw);
  if (!draft) {
    clearDraft();
    return;
  }
  // Same project as the one just loaded: nothing was lost, so say nothing —
  // and drop the copy so it cannot resurface later against a different file.
  if (!draftIsRestorable(draft, state.project)) {
    clearDraft();
    return;
  }
  renderDraftBar(draft);
}

function restoreDraft(draft) {
  // The draft is untrusted storage, so it goes through the same schema check as
  // a file on disk before it can reach the graph renderer.
  const parsed = validateProject(draft.project);
  if (!parsed.ok) {
    clearDraft();
    dismissDraftBar();
    toast('The saved draft was not a valid project, so it was discarded.');
    return;
  }
  state.project = parsed.project;
  state.selected = { type: 'project', id: null };
  state.projectPath = draft.filePath || null;
  state.history = null;
  dismissDraftBar();
  // A restored draft is by definition unsaved work: without this the save pill
  // would claim the project is saved and the close guard would let it go.
  refreshDirty();
  const name = $('#project-name-text');
  if (name) name.textContent = state.project.name || 'Untitled project';
  state.statusMessage = `Restored an unsaved draft from ${draftAgeLabel(draft.updatedAt, Date.now())}`;
  renderGraph();
  renderInspector();
  updateCounts();
  updateRunConsoleCopy();
  syncRunnerInputs();
  toast('Draft restored. Save it to keep it.');
}

/**
 * "1 block · 2 connections" — a bare count reads wrong at one, and the status
 * bar is the first place a template-created project is described.
 */
function countLabel(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function updateCounts() {
  const counts = { passed: 0, ready: 0, review: 0, blocked: 0 };
  state.project.nodes.forEach((node) => {
    if (node.type !== 'note') counts[node.state] = (counts[node.state] || 0) + 1;
  });
  const left = $('.status-left');
  if (left) {
    const items = [
      ['passed', 'green'], ['ready', 'blue'], ['review', 'red'], ['blocked', 'slate'],
    ].filter(([key]) => counts[key] > 0).map(([key, dot]) => (
      `<span class="status-item"><i class="dot ${dot}"></i><strong>${counts[key]}</strong> ${key === 'review' ? 'review' : key}</span>`
    ));
    left.innerHTML = items.join('');
  }
  const count = $('#canvas-count');
  if (count) {
    const loops = state.project.edges.filter((edge) => edge.type === 'loop').length;
    count.textContent = `${countLabel(state.project.nodes.length, 'block')} · ${countLabel(state.project.edges.length, 'connection')}${loops ? ` · ${countLabel(loops, 'loop')}` : ''}`;
  }
  const message = $('#status-message');
  if (message) {
    message.textContent = state.statusMessage;
    message.classList.toggle('is-ok', state.statusMessage.startsWith('Structure valid'));
    message.classList.toggle('is-warn', state.statusMessage.startsWith('Structure warning'));
  }
}

/* ── Selection and inspector ──────────────────────────────── */

function setSelected(next) {
  state.selected = next;
  $$('.node').forEach((el) => {
    el.classList.toggle('is-selected', next.type === 'node' && el.dataset.nodeId === next.id);
  });
  renderEdges();
  renderInspector();
}

function selectNode(id) {
  state.inspectorHidden = false;
  setSelected({ type: 'node', id });
}

function selectEdge(id) {
  state.inspectorHidden = false;
  setSelected({ type: 'edge', id });
}

function selectProject() {
  state.inspectorHidden = false;
  setSelected({ type: 'project', id: null });
}

function statusPill(stateName) {
  const status = STATUS[stateName] || STATUS.blocked;
  return `<span class="status-pill ${stateName}">${status.label}</span>`;
}

function inspectorHead(eyebrow, title, sub) {
  return `
    <div class="inspector-head">
      <div>
        <span class="eyebrow">${esc(eyebrow)}</span>
        <h2>${esc(title)}</h2>
        <div class="sub">${sub}</div>
      </div>
      <div class="inspector-head-actions">
        <button class="icon-btn" data-action="toggle-wide" title="${state.inspectorWide ? 'Compact inspector' : 'Wide inspector'}" aria-label="${state.inspectorWide ? 'Compact inspector' : 'Wide inspector'}">${state.inspectorWide ? '⇥' : '⇤'}</button>
        <button class="icon-btn" data-action="close-inspector" title="Close inspector" aria-label="Close inspector">×</button>
      </div>
    </div>`;
}

function field(label, control, full = false) {
  return `<div class="field${full ? ' full' : ''}"><label>${esc(label)}</label>${control}</div>`;
}

function inputField(label, key, value, options = {}) {
  const type = options.type || 'text';
  const full = options.full ? ' full' : '';
  return `<div class="field${full}"><label>${esc(label)}</label><input class="input${type === 'number' ? '' : ''}" type="${type}" data-node-field="${key}" aria-label="${esc(label)}" value="${esc(value)}" ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''}></div>`;
}

function selectField(label, key, options, value, full = false) {
  return `<div class="field${full ? ' full' : ''}"><label>${esc(label)}</label><select class="select" data-node-field="${key}" aria-label="${esc(label)}">
    ${options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${esc(optionLabel)}</option>`).join('')}
  </select></div>`;
}

function switchRow(label, hint, key, checked, options = {}) {
  const dataAttribute = options.attr || (options.gate ? `data-node-gate="${key}"` : `data-node-field="${key}"`);
  return `<div class="switch-row">
    <div>${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>
    <label class="switch"><input type="checkbox" ${dataAttribute} aria-label="${esc(label)}" ${checked ? 'checked' : ''} ${options.disabled ? 'disabled' : ''}><span></span></label>
  </div>`;
}

function group(title, meta, open, body) {
  return `<details class="param-group"${open ? ' open' : ''}>
    <summary><span>${esc(title)}</span><span class="group-meta">${esc(meta)}</span></summary>
    <div class="param-body"><div class="param-grid">${body}</div></div>
  </details>`;
}

function incomingList(id) {
  const edges = incoming(id);
  if (!edges.length) return '<p class="inspector-note">No inputs. Drag from another block’s output port to connect.</p>';
  return `<div class="dep-list">${edges.map((edge) => {
    const node = nodeById(edge.from);
    if (!node) return '';
    return `<button type="button" class="dep-row" data-select-node="${node.id}">
      <i class="dot ${statusFor(node).dot}"></i>
      <span class="title">${esc(node.title)}</span>
      ${statusPill(node.state)}
    </button>`;
  }).join('')}</div>`;
}

function renderProjectInspector() {
  const nodes = state.project.nodes;
  const counts = { passed: 0, ready: 0, review: 0, blocked: 0, 'timed out': 0 };
  nodes.forEach((node) => { if (node.type !== 'note') counts[node.state] = (counts[node.state] || 0) + 1; });
  // One definition of "what next", shared with the start-up reconciliation so
  // the prompt cannot disagree with the queue it was derived from (issue 160).
  const next = nextAction(nodes)?.node ?? null;
  const segments = ['passed', 'ready', 'review', 'blocked', 'timed out']
    .filter((key) => counts[key] > 0)
    .map((key) => `<span class="${key.replace(/\s+/g, '-')}" style="flex:${counts[key]}"></span>`)
    .join('');
  const loopCount = state.project.edges.filter((edge) => edge.type === 'loop').length;
  const condCount = nodes.filter((node) => node.type === 'condition').length;
  // Issue 132: the groups this flow can see, with the blocks that share each
  // id and each block's own protomer label. An ungrouped block is absent — it
  // is not listed under a null group.
  const conformerGroupList = conformerGroups(nodes
    .filter((node) => node.type === 'generate')
    .map((node) => ({
      id: node.id,
      title: node.title,
      group: node.settings?.group || '',
      protomers: Array.isArray(node.output?.protomers) ? node.output.protomers : [],
    })));

  return `${inspectorHead(
    'Project',
    state.project.name,
    `${countLabel(nodes.length, 'block')} · ${countLabel(state.project.edges.length, 'connection')}${loopCount ? ` · ${countLabel(loopCount, 'loop')}` : ''}`,
  )}
  <div class="inspector-scroll">
    <section class="section">
      <div class="section-label">Next action</div>
      ${next ? `<div class="next-card">
        <div class="next-meta"><i class="dot ${statusFor(next).dot}"></i>${statusPill(next.state)}</div>
        <h3>${next.state === 'review' ? 'Review the output' : next.state === 'timed out' ? 'Give it more time' : 'Run the next block'}</h3>
        <p>${next.state === 'review'
          ? `${esc(next.title)} needs a human decision before the condition can release a branch.`
          : next.state === 'timed out'
            ? `${esc(next.title)} was stopped at its wall-clock limit before it produced a result. There is no output to review: raise the limit in the block's inspector or in Setup, then run it again.`
            : `${esc(next.title)} has all prerequisites and is ready to export.`}</p>
        <button type="button" class="btn primary" data-select-node="${next.id}">Select ${esc(next.title)}</button>
      </div>` : `<div class="next-card"><h3>Everything passed</h3><p>No task is waiting in this project.</p></div>`}
    </section>

    <section class="section">
      <div class="section-label">Readiness <span class="spacer"></span><span>${nodes.length} blocks</span></div>
      <div class="readiness-track">${segments}</div>
      <div class="legend">
        <span><i class="dot green"></i>${counts.passed} passed</span>
        <span><i class="dot blue"></i>${counts.ready} ready</span>
        <span><i class="dot red"></i>${counts.review} review</span>
        ${counts['timed out'] > 0 ? `<span><i class="dot slate"></i>${counts['timed out']} timed out</span>` : ''}
        <span><i class="dot slate"></i>${counts.blocked} blocked</span>
      </div>
    </section>

    <section class="section">
      <div class="section-label">Molecule</div>
      <div class="card">
        <div class="molecule-row">
          <div class="structure-icon">2D</div>
          <div><strong>Project structure</strong><span>${state.project.molecule.coords?.length || 'demo'} atoms · ${state.project.molecule.fragments.length} fragments · charge ${state.project.molecule.charge} · multiplicity ${state.project.molecule.multiplicity}</span></div>
        </div>
        <button type="button" class="btn" data-open-modal="molecule">Edit molecule</button>
      </div>
    </section>

    ${conformerGroupList.length === 0 ? '' : `<section class="section" data-conformer-groups>
      <div class="section-label">Conformer groups <span class="spacer"></span><span>${countLabel(conformerGroupList.length, 'group')}</span></div>
      ${conformerGroupList.map((entry) => `<div class="card">
        <div class="kv"><span>group ${esc(entry.id)}</span><code>${countLabel(entry.blocks.length, 'block')}</code></div>
        ${entry.blocks.map((block) => `<div class="kv"><span>${esc(block.title)}</span><code>${esc(block.protomers.length ? block.protomers.join(', ') : 'protomer label not recorded')}</code></div>`).join('')}
      </div>`).join('')}
      <p class="inspector-note" style="margin-top:8px">A group is a study label set by hand on each block. It does not claim the ensembles are the same molecule, and it does not make energies across protonation states comparable.</p>
    </section>`}

    <section class="section">
      <div class="section-label">Project defaults</div>
      <div class="card">
        <div class="kv"><span>Engine</span><code>${esc(engineOrDefault(state.project.defaults.engine).label)}</code></div>
        ${engineOrDefault(state.project.defaults.engine).id === 'xtb'
    ? `<div class="kv"><span>Hamiltonian</span><code>${esc((XTB_METHODS.find((item) => item.id === (state.project.defaults.xtbMethod || 'gfn2')) || {}).label || 'GFN2-xTB')}</code></div>
        <div class="kv"><span>Optimisation</span><code>${esc(state.project.defaults.xtbOptLevel || 'normal')}</code></div>`
    : `<div class="kv"><span>Method</span><code>${esc(state.project.defaults.method)}</code></div>
        <div class="kv"><span>Basis</span><code>${esc(state.project.defaults.basis)}</code></div>`}
        <div class="kv"><span>Resources</span><code>${esc(state.project.defaults.memory)} ${esc(state.project.defaults.memoryUnit)} · ${esc(state.project.defaults.nproc)} cores</code></div>
        <button type="button" class="btn" data-open-modal="settings">Edit defaults</button>
      </div>
    </section>

    <section class="section">
      <div class="section-label">Validation</div>
      <div class="validation-card">
        <span class="v-icon">✓</span>
        <div><strong>Structure valid</strong>${condCount ? `${condCount} condition · ` : ''}${loopCount} loop. Branch and loop execution is planned; the current runner executes a single selected calculation.</div>
      </div>
      <p class="inspector-note" style="margin-top:8px">Select any block to edit its full Current Job parameter set here; use the expand control for a two-column layout.</p>
    </section>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-open-modal="molecule">Edit molecule</button>
    <button type="button" class="btn" data-action="toggle-palette">Add block</button>
  </div>`;
}

/** Issue #16: the grid select shows the derived UltraFine default as an option label. */
function gridOptionsFor(settings) {
  const implied = requiresUltraFineGrid(settings) && !String(settings.grid || '').trim();
  if (!implied) return GRID_OPTIONS;
  return [['', 'Default → UltraFine'], ...GRID_OPTIONS.slice(1)];
}

/** Issue #16: explain the derived grid so the route keyword is not a surprise. */
function gridDefaultNote(settings) {
  if (!requiresUltraFineGrid(settings) || String(settings.grid || '').trim()) return '';
  return `<div class="field full"><span class="inspector-note">A DFT optimization at `
    + `${esc(optConvergenceFor(settings))} convergence defaults to <code>Int=UltraFine</code>, `
    + 'as Gaussian recommends with <code>Opt=Tight</code>. Choose a grid to override it.</span></div>';
}

/* ── Issue #93: constraints and QST structures ─────────────── */

const CONSTRAINT_KIND_OPTIONS = [
  ['bond', 'Bond length'],
  ['angle', 'Bond angle'],
  ['dihedral', 'Dihedral'],
  ['freeze', 'Frozen atom'],
];

const CONSTRAINT_DEFAULT_ATOMS = { bond: [1, 2], angle: [1, 2, 3], dihedral: [1, 2, 3, 4], freeze: [1] };

function constraintAtomInputs(constraint, index) {
  const count = constraintAtomCount(constraint.kind);
  return Array.from({ length: count }, (_, slot) => `
    <input class="input constraint-atom" type="number" min="1" step="1"
      aria-label="${esc(constraint.kind)} atom ${slot + 1}"
      data-constraint-index="${index}" data-constraint-part="atom" data-atom-slot="${slot}"
      value="${esc(constraint.atoms?.[slot] ?? 1)}">`).join('');
}

function constraintRow(constraint, index, atoms) {
  return `<div class="constraint-row">
    <div class="constraint-row-head">
      <span class="constraint-desc">${esc(describeConstraint(constraint, atoms))}</span>
      <button type="button" class="icon-btn" data-action="remove-constraint" data-constraint-index="${index}"
        title="Remove constraint" aria-label="Remove constraint">×</button>
    </div>
    <div class="constraint-row-controls">
      <select class="select" aria-label="Constraint type" data-constraint-index="${index}" data-constraint-part="kind">
        ${CONSTRAINT_KIND_OPTIONS.map(([value, label]) => `<option value="${value}"${value === constraint.kind ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      ${constraintAtomInputs(constraint, index)}
      ${constraint.kind === 'freeze' ? '' : `<input class="input" type="number" step="0.001" placeholder="value"
        aria-label="Constraint value" data-constraint-index="${index}" data-constraint-part="value"
        value="${constraint.value ?? ''}">`}
    </div>
  </div>`;
}

/**
 * The constrained-coordinate editor. Every row is labelled in chemical terms
 * ("C3–O7 distance, 1.400 Å") and the index is the 1-based atom number in the
 * geometry that will be written.
 */
function constraintsGroup(node, s) {
  const atoms = moleculeForNode(node)?.coords || [];
  const list = Array.isArray(s.constraints) ? s.constraints : [];
  const report = constraintFindings({
    constraints: list,
    atoms,
    jobType: s.jobType,
    forceConstants: s.forceConstants,
  });
  return group('Constraints', list.length ? `${list.length} frozen` : 'none', list.length > 0, [
    list.length
      ? `<div class="full constraint-list">${list.map((constraint, index) => constraintRow(constraint, index, atoms)).join('')}</div>`
      : '<div class="full"><span class="inspector-note">No constrained coordinates. Freezing a bond, angle, dihedral or atom and relaxing everything else is how a transition-state guess is built before an <code>Opt=TS</code> search.</span></div>',
    `<div class="full constraint-add">
      <select class="select" id="constraint-new-kind" aria-label="New constraint type">
        ${CONSTRAINT_KIND_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
      </select>
      <button type="button" class="btn small" data-action="add-constraint">Add constraint</button>
    </div>`,
    report.errors.length
      ? `<div class="full"><div class="callout"><strong>Cannot export.</strong> ${esc(report.errors[0].message)}</div></div>`
      : '',
    report.warnings.map((message) => `<div class="full"><div class="callout"><strong>Warning.</strong> This block ${esc(message)}</div></div>`).join(''),
    '<div class="full"><span class="inspector-note">Written as a Gaussian <code>ModRedundant</code> section after the geometry, one line per coordinate (<code>B 3 7 F</code>). Gaussian freezes each coordinate at the value in the geometry, so a declared value has to match it.</span></div>',
  ].join(''));
}

/** How a stored QST structure compares with the geometry the block writes. */
function qstStructureStatus(structure, atoms) {
  const coords = Array.isArray(structure?.atoms) ? structure.atoms : [];
  if (coords.length === 0) return { ok: false, text: 'no geometry set' };
  if (!Array.isArray(atoms) || atoms.length === 0) return { ok: true, text: `${coords.length} atoms` };
  if (coords.length !== atoms.length) {
    return { ok: false, text: `${coords.length} atoms · the block geometry has ${atoms.length}` };
  }
  const mismatch = coords.findIndex((atom, index) => String(atom?.element) !== String(atoms[index]?.element));
  if (mismatch !== -1) {
    return {
      ok: false,
      text: `atom ${mismatch + 1} is ${coords[mismatch]?.element || '?'} · the geometry has ${atoms[mismatch]?.element || '?'}`,
    };
  }
  return { ok: true, text: `${coords.length} atoms · atom order matches` };
}

function qstStructureRow(node, s, index) {
  const structure = qstStructuresFor(s)[index] || { label: '', source: 'copy', nodeId: '', path: '', atoms: [] };
  const atoms = moleculeForNode(node)?.coords || [];
  const status = qstStructureStatus(structure, atoms);
  const blocks = state.project.nodes.filter((entry) => entry.type === 'calculate'
    && Array.isArray(entry.parsed?.geometry?.final?.atoms)
    && entry.parsed.geometry.final.atoms.length > 0);
  const position = index + 2;
  const label = index === 0 ? 'Structure 2 · product' : 'Structure 3 · initial TS';
  return `<div class="qst-row">
    <div class="qst-row-head">
      <strong>${esc(label)}</strong>
      <span class="qst-status${status.ok ? '' : ' bad'}">${esc(status.text)}</span>
    </div>
    <div class="qst-row-controls">
      <input class="input" type="text" maxlength="60" placeholder="label" aria-label="Structure ${position} label"
        data-qst-index="${index}" data-qst-part="label" value="${esc(structure.label || '')}">
      <select class="select" aria-label="Structure ${position} source" data-qst-index="${index}" data-qst-part="source">
        <option value="copy"${structure.source === 'copy' ? ' selected' : ''}>Copy of the block geometry</option>
        <option value="block"${structure.source === 'block' ? ' selected' : ''}>From a finished block</option>
        <option value="file"${structure.source === 'file' ? ' selected' : ''}>From a structure file</option>
      </select>
      ${structure.source === 'block' ? `<select class="select" aria-label="Structure ${position} source block"
        data-qst-index="${index}" data-qst-part="node">
        <option value="">Choose a block with parsed output</option>
        ${blocks.map((entry) => `<option value="${entry.id}"${structure.nodeId === entry.id ? ' selected' : ''}>${esc(entry.title)}</option>`).join('')}
      </select>` : ''}
      ${structure.source === 'file' ? `<input class="input" type="text" maxlength="260" placeholder="reactant.gjf"
        aria-label="Structure ${position} file name" data-qst-index="${index}" data-qst-part="path"
        value="${esc(structure.path || '')}">
        <input type="file" id="qst-file-${index}" accept=".xyz,.mol,.sdf,.mol2,.pdb,.pdbqt,.cjson,.gjf,.com,.log,.out" hidden>
        <button type="button" class="btn small" data-action="qst-pick-file" data-qst-index="${index}">Choose file</button>` : ''}
      <button type="button" class="btn small" data-action="qst-fill" data-qst-index="${index}">Load geometry</button>
    </div>
  </div>`;
}

/**
 * The QST2/QST3 editor (#93). Gaussian reads the block's geometry as the
 * reactant and these structures after it, so a QST2 block names one product and
 * a QST3 block a product plus an initial TS.
 */
function qstGroup(node, s) {
  const kind = qstKindFor(s.jobType);
  const required = qstRequiredStructures(s.jobType);
  const structures = qstStructuresFor(s);
  const atoms = moleculeForNode(node)?.coords || [];
  const missing = required - structures.length;
  return group(`QST2 / QST3 · ${kind}`, `${structures.length}/${required} structures`, true, [
    `<div class="full"><span class="inspector-note">Gaussian interpolates from the block geometry (reactant) through ${required === 1 ? 'the product' : 'the product to the initial TS'}. All structures must have the same atoms in the same order; nothing is re-sorted.</span></div>`,
    `<div class="full qst-list">${Array.from({ length: required }, (_, index) => qstStructureRow(node, s, index)).join('')}</div>`,
    missing > 0
      ? `<div class="full"><div class="callout"><strong>Cannot export.</strong> This ${kind} block needs ${required} extra structure${required === 1 ? '' : 's'}; ${missing === required ? 'none is' : `${missing} ${missing === 1 ? 'is' : 'are'}`} set.</div></div>`
      : '',
    structures.length > 0
      ? `<div class="full"><span class="inspector-note">The stored structure is a complete molecule specification: ${esc(structureSummary(structures))}. It travels in the .ncs file, so <code>ncs build-input</code> writes the same text the app does.</span></div>`
      : '',
  ].join(''));
}

function structureSummary(structures) {
  return structures
    .map((structure, index) => `${index + 2}${structure.label ? ` (${structure.label})` : ''}: ${(structure.atoms || []).length} atoms`)
    .join(' · ') || 'no structures';
}

function calcInspector(node) {
  const s = node.settings;
  const ins = incoming(node.id);
  const outs = outgoing(node.id);
  const status = statusFor(node);
  const checkpointSource = node.checkpointFrom ? nodeById(node.checkpointFrom) : null;
  const engine = engineForNode(state.project, node);
  const isXtb = engine.id === 'xtb';
  const isPsi4 = engine.id === 'psi4';
  const isOrca = engine.id === 'orca';
  const isPyscf = engine.id === 'pyscf';
  const gaussianResources = showsGaussianResources(engine.id);
  const checkpointHandoff = showsCheckpointHandoff(engine.id);
  const routeLines = [];
  if (isXtb) {
    // Show the real invocation, or say plainly that xTB cannot run this block.
    try {
      const built = buildRunInput(node);
      routeLines.push(`xtb ${esc(built.argv.join(' '))}`);
    } catch (error) {
      routeLines.push(`xTB cannot run this block: ${esc(error.message)}`);
    }
  } else if (engine.id === 'orca') {
    // ORCA never reads a Gaussian route: show the keywords the builder would
    // actually write, or the reason it refuses.
    try {
      const built = buildOrcaInput({
        title: node.title,
        settings: s,
        molecule: moleculeForNode(node),
        inputName: `${node.id}.inp`,
      });
      routeLines.push(...built.inputText.split('\n')
        .filter((line) => line.startsWith('!') || line.startsWith('%'))
        .slice(0, 4)
        .map(esc));
    } catch (error) {
      routeLines.push(`ORCA cannot run this block: ${esc(error.message)}`);
    }
  } else if (engine.id === 'psi4') {
    // Psi4 reads Psithon code, not a Gaussian route. Show the script the
    // builder would actually write, or the reason it refuses to write one.
    try {
      const built = buildPsi4Input({
        title: node.title,
        settings: s,
        molecule: moleculeForNode(node),
        inputName: `${node.id}.dat`,
      });
      routeLines.push(...built.inputText.split('\n')
        .filter((line) => line.startsWith('set ') || /^(energy|optimize|frequencies)\(/.test(line))
        .slice(0, 6)
        .map(esc));
    } catch (error) {
      routeLines.push(`Psi4 cannot run this block: ${esc(error.message)}`);
    }
  } else if (engine.id === 'pyscf') {
    // PySCF's deck is a Python program. The preview shows the route the deck
    // declares, not the script: the data line is base64 and unreadable.
    try {
      const built = buildPyscfInput({
        title: node.title,
        settings: s,
        molecule: moleculeForNode(node),
        inputName: `${node.id}.gjf`,
      });
      routeLines.push(esc(built.route));
      routeLines.push(`python3 ${esc(built.inputName)}`);
    } catch (error) {
      routeLines.push(`PySCF cannot run this block: ${esc(error.message)}`);
    }
  } else {
    routeLines.push(`%Chk=${esc(s.checkpoint || chkName(node.id))}`);
    if (checkpointSource) routeLines.push(`%OldChk=${esc(chkName(checkpointSource.id))}`);
    routeLines.push(routeFull(s));
  }
  let callout = '';
  if (node.state === 'blocked') {
    const waiting = ins.map((edge) => nodeById(edge.from)).find((item) => item && item.state !== 'passed');
    callout = `<div class="callout"><strong>Blocked.</strong> ${waiting ? `${esc(waiting.title)} has not passed its gates yet.` : 'No parsed output has released this block.'}
      <button type="button" class="btn small" data-action="import-log">Import log</button></div>`;
  } else if (node.state === 'review') {
    callout = '<div class="callout"><strong>Needs review.</strong> The parsed output does not satisfy every required gate. The next action is a human decision, not an automatic pass.</div>';
  } else if (node.state === 'timed out') {
    // Issue 177: the card says why it stopped and that there is no result to
    // review. The numbers come from the task's own record, never an estimate.
    const own = (state.queue?.tasks || [])
      .filter((entry) => String(entry.nodeId || '').split('~')[0] === node.id && entry.timeout)
      .pop();
    const detail = own?.timeout
      ? `The queue stopped it after ${formatDuration(own.timeout.elapsedSeconds)} (limit ${formatDuration(own.timeout.limitSeconds)}).`
      : 'The queue stopped it when its wall-clock limit was reached.';
    const last = own?.timeout?.lastOutput ? ` Last output: “${esc(own.timeout.lastOutput)}”.` : '';
    callout = `<div class="callout"><strong>Timed out.</strong> ${esc(detail)}${last} `
      + 'The output was not parsed, so there is no result to review — raise the limit for this block or in Setup, or check whether the engine is stuck.</div>';
  } else if (node.state === 'ready') {
    callout = '<div class="callout green"><strong>Ready.</strong> All prerequisites passed; export the input and run it externally.</div>';
  }

  // Issue #15: the force-constant choice is valid or not independently of the
  // node's run state, so it gets its own callouts. Those rules are Gaussian
  // route rules; xTB refuses transition-state blocks at input build instead.
  const tsIssues = isXtb || isPyscf ? { errors: [], warnings: [] } : tsForceConstantIssues(node);
  callout += tsIssues.errors
    .map((message) => `<div class="callout"><strong>Cannot export.</strong> ${esc(message)}</div>`)
    .join('');
  callout += tsIssues.warnings
    .map((message) => `<div class="callout"><strong>Warning.</strong> This block ${esc(message)}</div>`)
    .join('');
  // Issue #16: grid and frequency-provenance advice is also independent of the
  // node's run state — and Gaussian-only.
  callout += isXtb || isPyscf ? '' : optConvergenceIssues(node)
    .map((message) => `<div class="callout"><strong>Warning.</strong> This block ${esc(message)}</div>`)
    .join('');

  const tsForceField = s.jobType === 'Opt=TS'
    ? [
      selectField(
        'Force constants',
        'forceConstants',
        TS_FORCE_CONSTANT_OPTIONS.map((option) => [option.id, option.label]),
        forceConstantsFor(s),
      ),
      forceConstantsFor(s) === 'ReadFC'
        ? '<div class="field full"><span class="inspector-note">ReadFC reads force constants from this block’s checkpoint hand-off. Connect a Freq or Opt=CalcFC block below.</span></div>'
        : '',
    ].join('')
    : '';

  const jobGroup = group('Job', s.jobType, true, [
    inputField('Title', 'title', node.title, { full: true }),
    // Per-block engine (#63): the empty value inherits the project default, so
    // a project that has never used this setting reads exactly as before.
    selectField('Engine', 'engine', [
      ['', `Project default (${engineOrDefault(state.project?.defaults?.engine).label})`],
      ...Object.values(ENGINES).map((entry) => [entry.id, entry.label]),
    ], s.engine ?? ''),
    // ADR 0001 §2.10: a scorer provider keeps this a calculate block but
    // bypasses the engine. Empty means "run the engine".
    selectField('Provider', 'provider', [
      ['', 'Engine (default)'],
      ...Object.values(SCORER_MODELS).map((model) => [`ml:${model.id}`, `${model.label} (ML scorer)`]),
    ], s.provider ?? ''),
    selectField('Job type', 'jobType', isPyscf
      ? PYSCF_JOB_TYPES.map((id) => [id, id === 'Freq' ? 'Frequency' : id === 'Opt' ? 'Optimization' : id === 'SP' ? 'Single point' : id])
      : isPsi4 ? PSI4_JOB_TYPES.map((id) => [id, id === 'Freq' ? 'Frequency' : id === 'Opt' ? 'Optimization' : id === 'SP' ? 'Single point' : id]) : JOB_TYPES, s.jobType),
    !isXtb && !isPsi4 && !isPyscf && s.jobType === 'IRC' ? selectField('IRC direction', 'ircDirection', IRC_DIRECTIONS, s.ircDirection) : '',
    !isXtb && !isPsi4 && !isPyscf && isOptJob(s.jobType)
      ? selectField(
        'Optimization convergence',
        'optConvergence',
        OPT_CONVERGENCE_OPTIONS.map((option) => [option.id, option.label]),
        optConvergenceFor(s),
      )
      : '',
    !isXtb && !isPsi4 && !isPyscf ? tsForceField : '',
    isPsi4 || isPyscf ? selectField('SCF reference', 'reference', [['', 'Auto (from multiplicity)'], ['rhf', 'RHF'], ['uhf', 'UHF'], ['rohf', 'ROHF']], s.reference || '') : '',
    gaussianResources ? `<div class="field"><label>Memory</label><div class="field-row">
      <input class="input" type="number" min="1" max="512" aria-label="Memory" data-node-field="memory" value="${esc(s.memory)}">
      <select class="select" aria-label="Memory unit" data-node-field="memoryUnit">${MEMORY_UNITS.map(([value, label]) => `<option value="${value}"${s.memoryUnit === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </div></div>` : '',
    gaussianResources ? inputField('Cores (nproc)', 'nproc', s.nproc, { type: 'number', min: 1, max: 256 }) : '',
    isPyscf ? inputField('Threads (OMP_NUM_THREADS)', 'nproc', s.nproc, { type: 'number', min: 1, max: 256 }) : '',
    // Issue 177: an optional wall clock for this block. Blank inherits the
    // project's limit; the field exists because a TD-DFT block on a 40-atom
    // dimer and a single-point on water do not deserve the same hour.
    inputField('Time limit (s)', 'timeoutSeconds', s.timeoutSeconds ?? '', { type: 'number', min: 1, max: LIMITS.timeoutSeconds, full: true }),
    `<div class="field full"><span class="inspector-note">Blank uses the project limit${Number(state.project?.runner?.timeoutSeconds) > 0 ? ` (${Number(state.project.runner.timeoutSeconds)} s)` : ' (3600 s default)'}. A task that reaches it is stopped and recorded as timed out.</span></div>`,
    !isPsi4 && gaussianResources ? inputField('Checkpoint file', 'checkpoint', s.checkpoint || chkName(node.id), { full: true }) : '',
    !gaussianResources && !isPyscf
      ? '<div class="field full"><span class="inspector-note">xTB writes <code>xtbrestart</code> in the run folder; a checkpoint hand-off copies that file.</span></div>'
      : '',
    isPyscf
      ? '<div class="field full"><span class="inspector-note">PySCF has no checkpoint file. The deck is a fixed Python program and the molecule travels as data; a downstream block reads the parsed geometry instead.</span></div>'
      : '',
  ].join(''));

  // A composite method carries its own sequence in one keyword: Gaussian cannot
  // run `G4/6-31G(d)`, so offering the pair here would invite a route the builder
  // refuses. Show what the keyword actually runs instead.
  const compositeJob = isCompositeJobType(s.jobType);
  // Issue #93: constraints read ModRedundant; QST structures exist only for an
  // STQN job. Both are Gaussian-only, so an xTB block shows neither.
  const constraintGroup = isXtb || isPyscf ? '' : constraintsGroup(node, s);
  const qstEditor = isXtb || isPyscf || !qstKindFor(s.jobType) ? '' : qstGroup(node, s);
  const compositeNote = '<div class="field full"><span class="inspector-note">'
    + '<strong>' + esc(s.jobType) + '</strong> is a composite method: Gaussian runs its own fixed '
    + 'sequence and reports one 0 K energy. Method, basis, dispersion, solvation and excited-state '
    + 'settings do not apply and are refused if set.</span></div>';
  const methodGroup = group('Method & basis', `${s.method}/${s.basis}`, true, [
    selectField('Route preset', 'routePreset', [
      ['', 'Custom'],
      ...ROUTE_PRESETS.map((preset) => [preset.id, preset.label]),
    ], routePresetIdFor(s)),
    selectField('Method', 'method', METHODS, s.method),
    selectField('Basis set', 'basis', BASIS_SETS, s.basis),
    selectField('Dispersion', 'dispersion', DISPERSIONS, s.dispersion),
    selectField('SCF convergence', 'scf', SCF_OPTIONS, s.scf),
    selectField('Integration grid', 'grid', gridOptionsFor(s), s.grid),
    gridDefaultNote(s),
    selectField('Population analysis', 'population', POP_OPTIONS, s.population),
    // Frontier orbitals (#88): a separate switch from the charge analysis,
    // because Pop=Full and Pop=NBO cannot share one route.
    switchRow('Frontier-orbital descriptors', 'adds Pop=Full', 'orbitals', s.orbitals === true,
      { disabled: Boolean(s.population) && String(s.population).toLowerCase() !== 'full' }),
    '<div class="field full"><span class="inspector-note">'
      + (s.population && String(s.population).toLowerCase() !== 'full'
        ? 'Clear the population analysis above to request the orbitals: Gaussian prints one population scheme per route.'
        : 'Prints the orbital eigenvalues, so the results panel can report HOMO, LUMO, gap, IP, EA, hardness, softness and electrophilicity.')
      + '</span></div>',
    selectField('Output verbosity', 'verbosity', VERBOSITY, s.verbosity),
    selectField('Matrix element file', 'matrixElement', MATRIX_ELEMENT_OPTIONS.map((value) => [
      value,
      value === '' ? 'None' : value === 'MatrixElement' ? 'Text (MatrixElement)' : 'Raw binary (RawMatrixElement)',
    ]), s.matrixElement || ''),
    '<div class="field full"><span class="inspector-note">Gaussian writes the matrix element file next to the output. This release requests it but does not parse the binary; clear Output verbosity when requesting one, because both share the <code>Output</code> keyword.</span></div>',
  ].join(''));

  // Psi4 is the second code engine: its methods, bases and job list are its
  // own, and every Gaussian route field is refused by name. The group below
  // shows only what the Psithon builder actually writes.
  const psi4MethodEntry = PSI4_METHODS.find((entry) => entry.key === String(s.method || '').toLowerCase())
    || PSI4_METHODS.find((entry) => entry.key === 'b3lyp');
  const psi4BasisEntry = PSI4_BASES.find((entry) => entry.key === String(s.basis || '').toLowerCase())
    || PSI4_BASES[0];
  const psi4MethodGroup = group('Method & basis', `${psi4MethodEntry.label}/${psi4BasisEntry.label}`, true, [
    selectField('Method', 'method', PSI4_METHODS.map((entry) => [entry.key, entry.label]), psi4MethodEntry.key),
    selectField('Basis set', 'basis', PSI4_BASES.map((entry) => [entry.key, entry.label]), psi4BasisEntry.key),
    '<div class="field full"><span class="inspector-note">Psi4 reads Psithon code. Every input writes <code>set basis</code>, '
      + '<code>set reference</code> and <code>set scf_type df</code>; dispersion comes from the functional name '
      + '(ωB97X-D, B97-D), never from a keyword.</span></div>',
    psi4MethodEntry.kind === 'sapt'
      ? '<div class="field full"><span class="inspector-note"><strong>SAPT0 is a single-point energy</strong> and reports an '
        + 'interaction energy for the fragments, not a total energy for the complex. The molecule must carry at least two fragments.</span></div>'
      : '',
    (psi4MethodEntry.key === 'ccsd' || psi4MethodEntry.key === 'ccsd(t)')
      ? '<div class="field full"><span class="inspector-note">CCSD and CCSD(T) have no analytic Hessian in Psi4: '
        + 'Freq and Opt Freq are refused for these methods.</span></div>'
      : '',
    // Issue 174: only a correlated method has a core to freeze, and the choice
    // moves the energy by ~30 mEh at cc-pVQZ, so it is shown where the method is
    // chosen and named for what it changes.
    psi4MethodEntry.kind === 'correlated'
      ? [
        selectField('Core correlation', 'freezeCore', [
          ['auto', 'Engine default'],
          ['true', 'Frozen core'],
          ['false', 'All-electron'],
        ], String(s.freezeCore ?? 'auto')),
        '<div class="field full"><span class="inspector-note">Writes <code>set freeze_core</code> only when you '
          + 'choose it. Frozen core excludes the 1s electrons from the correlation treatment — the usual choice for '
          + 'basis-set extrapolation, and 30 mEh below the all-electron MP2 number on water/cc-pVQZ. The default '
          + 'writes nothing, so an existing project is unchanged.</span></div>',
      ].join('')
      : '',
  ].join(''));

  // PySCF is a code engine: the deck is a fixed Python program with the
  // molecule and settings serialized as data. The group offers exactly the
  // methods, bases and active-space field the builder can spell.
  const pyscfMethodEntry = PYSCF_METHODS.find((entry) => entry.key === String(s.method || '').toLowerCase())
    || PYSCF_METHODS.find((entry) => entry.key === 'b3lyp');
  const pyscfBasisEntry = PYSCF_BASES.find((entry) => entry.key === String(s.basis || '').toLowerCase())
    || PYSCF_BASES[0];
  const pyscfMethodGroup = group('Method & basis', `${pyscfMethodEntry.label}/${pyscfBasisEntry.label}`, true, [
    selectField('Method', 'method', PYSCF_METHODS.map((entry) => [entry.key, entry.label]), pyscfMethodEntry.key),
    selectField('Basis set', 'basis', PYSCF_BASES.map((entry) => [entry.key, entry.label]), pyscfBasisEntry.key),
    pyscfMethodEntry.key === 'casscf'
      ? inputField('Active space (electrons,orbitals)', 'pyscfActiveSpace', s.pyscfActiveSpace ?? '', { full: true })
      : '',
    pyscfMethodEntry.key === 'casscf'
      ? '<div class="field full"><span class="inspector-note"><strong>CASSCF.</strong> The deck writes '
        + '<code>mcscf.CASSCF(mf, ncas, nelecas)</code> from the active space above. It is a single point: '
        + 'Opt, Freq and Opt Freq are refused by name. The reference SCF is RHF for a closed shell and ROHF '
        + 'for an open shell.</span></div>'
      : '',
    ['mp2', 'ccsd', 'ccsd(t)'].includes(pyscfMethodEntry.key)
      ? '<div class="field full"><span class="inspector-note">' + esc(pyscfMethodEntry.label)
        + ' is a single point in this build: Opt, Freq and Opt Freq are refused by name, and so is solvation. '
        + 'CCSD(T) adds the perturbative triples correction to the CCSD energy.</span></div>'
      : '',
    '<div class="field full"><span class="inspector-note">PySCF reads a fixed Python deck. The method, basis, '
      + 'molecule, charge and multiplicity travel as data, never as code. HF and DFT support SP, Opt, Freq and '
      + 'Opt Freq; frequencies use the analytic Hessian, and a density-fitted SCF matches the Psi4 '
      + 'comparison runs. Dispersion is a property of the functional and no D3 keyword is written.</span></div>',
  ].join(''));

  // ORCA is a code engine too: its own method/basis list, its own PNO cutoff,
  // and a route that states the RI approximation instead of leaving it to ORCA.
  const orcaMethodEntry = ORCA_METHODS.find((entry) => entry.id.toLowerCase() === String(s.method || '').toLowerCase())
    || ORCA_METHODS[0];
  const orcaBasisEntry = ORCA_BASES.find((entry) => entry.id.toLowerCase() === String(s.basis || '').toLowerCase())
    || ORCA_BASES[0];
  const orcaDlpno = orcaMethodEntry.id === 'DLPNO-CCSD(T)';
  const orcaMethodGroup = group('Method & basis', `${orcaMethodEntry.id}/${orcaBasisEntry.id}`, true, [
    selectField('Method', 'method', ORCA_METHODS.map((entry) => [entry.id, entry.label]), orcaMethodEntry.id),
    selectField('Basis set', 'basis', ORCA_BASES.map((entry) => [entry.id, entry.label]), orcaBasisEntry.id),
    orcaDlpno
      ? selectField('PNO threshold', 'pnoThreshold', ORCA_PNO_THRESHOLDS.map((entry) => [
        entry.id,
        `${entry.label} (TCutPNO ${entry.tCutPNO.toExponential(2)})`,
      ]), String(s.pnoThreshold || 'NormalPNO'))
      : '',
    orcaDlpno
      ? '<div class="field full"><span class="inspector-note">Writes <code>DLPNO-CCSD(T)</code>, '
        + `<code>${esc(orcaBasisEntry.auxiliary || 'the /C basis')}</code>, <code>def2/J</code> and <code>RIJCOSX</code> explicitly, `
        + 'plus the PNO preset. The preset sets <code>TCutPNO</code>, which controls the truncation error, so it is '
        + 'recorded in the result and the provenance block. DLPNO-CCSD(T) is a single point here: Freq, Opt and '
        + 'Opt Freq are refused by name rather than run without a gradient.</span></div>'
      : '',
    orcaDlpno && !orcaBasisEntry.auxiliary
      ? '<div class="field full"><span class="inspector-note"><strong>No /C basis for this set.</strong> '
        + 'DLPNO-CCSD(T) needs a correlation-fitting auxiliary basis; choose def2-SVP, def2-TZVP(PP) or cc-pVTZ.</span></div>'
      : '',
    selectField('Dispersion', 'dispersion', DISPERSIONS, s.dispersion),
    selectField('SCF convergence', 'scf', SCF_OPTIONS, s.scf),
    selectField('Integration grid', 'grid', GRID_OPTIONS, s.grid),
  ].join(''));

  // Issue 166: Psi4's TD-DFT is a job type of its own, and its state count is
  // not a plain "n lowest" — Psi4 splits the request across the point group's
  // irreducible representations, one state per irrep in order, so a count below
  // the irrep count can come back without the bright state. The field says so
  // where it is set, with the numbers measured on ethylene.
  const pyscfTdGroup = isPyscf && s.jobType === 'TD-DFT'
    ? group('Excited states (TD-DFT)', `${Number(s.tdStates) || 0} states`, true, [
      inputField('States', 'tdStates', s.tdStates ?? 0, { type: 'number', min: 1, max: 50 }),
      '<div class="field full"><span class="inspector-note">Writes <code>tdscf.TDDFT</code> with N roots after the '
        + 'converged reference. <strong>Singlet roots only</strong>: triplet roots are refused by name. Each root '
        + 'records its energy, oscillator strength, wavelength and transition dipole. A solvated reference is '
        + 'refused, because a solvated PySCF block is a single point.</span></div>',
    ].join(''))
    : '';

  const psi4TdGroup = isPsi4 && s.jobType === 'TD-DFT'
    ? group('Excited states (TD-DFT)', `${Number(s.tdStates) || 0} states`, true, [
      inputField('States', 'tdStates', s.tdStates ?? 0, { type: 'number', min: 1, max: 50 }),
      '<div class="field full"><span class="inspector-note">Writes <code>set tdscf_states N</code> and '
        + '<code>energy(&#39;td-&lt;method&gt;&#39;)</code>. Psi4 splits N across the point group&rsquo;s irreducible '
        + 'representations in order, so raise it above the irrep count when the bright state is missing: '
        + 'on D<sub>2h</sub> ethylene, 5 states returned five symmetry-dark ones, 16 returned '
        + 'B<sub>1u</sub> at 8.24 eV with f = 0.35.</span></div>',
      '<div class="field full"><span class="inspector-note">No excited-state optimisation: this build cannot '
        + 'relax an excited surface in Psi4, so the builder refuses a Root above 1. Run that in Gaussian, '
        + 'or use the emission block after an external ES optimisation.</span></div>',
    ].join(''))
    : '';

  // Issue 285: ORCA 6 has no `TDDFT` route keyword — the `%tddft` block is the
  // whole request — so the group is shown only when the job type is TD-DFT and
  // it names the block it writes.
  const orcaTdGroup = isOrca && s.jobType === 'TD-DFT'
    ? group('Excited states (TD-DFT)', `${Number(s.tdStates) || 0} states`, true, [
      inputField('States', 'tdStates', s.tdStates ?? 10, { type: 'number', min: 1, max: 100 }),
      '<div class="field full"><span class="inspector-note">Writes <code>%tddft</code> with '
        + '<code>NRoots N</code> and <code>TDA false</code> — the full response, like the Gaussian, '
        + 'Psi4 and PySCF blocks, not the Tamm-Dancoff approximation. ORCA 6 rejects a '
        + '<code>TDDFT</code> keyword on the route line, so the block is the whole request. '
        + 'Singlets only. The log closes with <code>E(tot) = E(SCF) + DE(CIS)</code>; the record reports the '
        + 'SCF energy as the final energy and keeps that decomposition with the states.</span></div>',
    ].join(''))
    : '';

  // Issue #60: TD-DFT is a route keyword on a wavefunction job. The group is
  // always present for Gaussian so the setting is discoverable; the note says
  // why a Freq/TS/IRC/Scan block cannot carry it.
  const tdEligible = s.jobType === 'SP' || s.jobType === 'Opt';
  const tdStates = Number(s.tdStates || 0);
  const tdRoot = Number(s.tdRoot || 0);
  const tdSummary = tdStates > 0
    ? `${tdStates} states${tdRoot > 0 ? ` · root ${tdRoot}` : ''}${s.tdTriplets === 'triplets' ? ' · triplets' : s.tdTriplets === 'both' ? ' · 50/50' : ''}`
    : (s.emission ? 'emission' : s.nto ? 'NTO' : 'off');
  // issue 146: an excited-state optimisation without a root relaxes the ground state.
  // The inspector says so next to the field; project validation turns it into a
  // blocking error rather than a warning.
  const needsRoot = (s.jobType === 'Opt' || s.jobType === 'Opt Freq') && tdStates > 0 && !(tdRoot > 0);
  const excitedGroup = group('Excited states (TD)', tdSummary, tdStates > 0 || s.emission === true || s.nto === true, [
    inputField('States', 'tdStates', s.tdStates ?? 0, { type: 'number', min: 0, max: 200 }),
    selectField('Spin states', 'tdTriplets', [
      ['', 'Singlets only'],
      ['triplets', 'Triplets only'],
      ['both', '50/50 singlets + triplets'],
    ], s.tdTriplets || ''),
    inputField('Root', 'tdRoot', s.tdRoot ?? 0, { type: 'number', min: 0, max: 200 }),
    inputField('NTO transition', 'ntoTransition', s.ntoTransition ?? 0, { type: 'number', min: 0, max: 200 }),
    tdEligible
      ? '<div class="field full"><span class="inspector-note">Emits <code>TD=(NStates=N)</code> on the route'
        + `${tdRoot > 0 ? ` with <code>Root=${esc(tdRoot)}</code>` : ''}. Root is the state an <code>Opt</code> follows and the state an emission `
        + 'block reports; 0 means "not stated". Excitation energies, wavelengths, oscillator strengths and the '
        + 'dominant transitions are parsed from the output.</span></div>'
      : '<div class="field full"><span class="inspector-note">TD requires a single-point or optimisation job. Choose SP or Opt to enable it; the input builder refuses the other job types.</span></div>',
    needsRoot
      ? '<div class="field full"><span class="inspector-note"><strong>Root is unset.</strong> An Opt job with '
        + `${esc(tdStates)} excited states and no Root optimises the <em>ground</em> state, not the excited state this block reads as. `
        + 'Set Root to the state to follow; validation blocks the run until it is set.</span></div>'
      : '',
    s.emission === true
      ? '<div class="field full"><span class="inspector-note"><strong>Emission (vertical).</strong> This block runs '
        + '<code>SP TD=(NStates=n,Root=1)</code> at the geometry it receives and reports the vertical emission energy. '
        + 'It reports no fluorescence lifetime, no quantum yield and no Stokes shift against an experimental band maximum. '
        + 'Connect the excited-state optimisation above it: a checkpoint edge hands the optimised geometry over; a normal '
        + 'edge only orders the run and leaves the geometry as the block input.</span></div>'
      : '',
    '<div class="field full"><span class="inspector-note">NTO transition adds '
      + '<code>Density=(Check,Transition=k)</code> and writes this block’s checkpoint for a following '
      + '<code>Pop=NTO</code> job (connect it with a checkpoint edge). The NTO block itself carries no TD: '
      + 'tick <strong>NTO analysis</strong> on a separate SP block.</span></div>',
    switchRow('NTO analysis (second job)', 'Guess=Only Pop=NTO', 'nto', s.nto === true, { disabled: tdStates > 0 }),
    s.nto === true
      ? '<div class="field full"><span class="inspector-note"><strong>Pop=NTO.</strong> This block emits '
        + '<code>Guess=Only Pop=NTO</code> and reads its transition density over a checkpoint edge. It must not carry TD, '
        + 'and the source block must. This build does not parse the printed NTO table: no real NTO log exists in the '
        + 'repository, so the pair is shown as a route and the result is reported as not parsed.</span></div>'
      : '',
  ].join(''));

  const gaussianSolvationGroup = group('Solvation', s.solvation ? `${s.solvationModel} · ${s.solvent}` : 'off', s.solvation, [
    switchRow('Implicit solvation', 'PCM / SMD / CPCM', 'solvation', s.solvation),
    selectField('Model', 'solvationModel', SOLVATION_MODELS, s.solvationModel),
    selectField('Solvent', 'solvent', SOLVENTS, s.solvent),
  ].join(''));

  // ORCA implements CPCM and SMD (not Gaussian's PCM keyword), and the builder
  // refuses the rest by name; the group shows only the two it can write.
  const orcaSolvationGroup = group('Solvation', s.solvation ? `${s.solvationModel} · ${s.solvent}` : 'off', s.solvation, [
    switchRow('Implicit solvation', 'CPCM / SMD', 'solvation', s.solvation),
    selectField('Model', 'solvationModel', [['CPCM', 'CPCM'], ['SMD', 'SMD']], s.solvationModel),
    selectField('Solvent', 'solvent', SOLVENTS, s.solvent),
  ].join(''));

  // PySCF writes IEF-PCM ("PCM") and C-PCM; the builder refuses SMD, CPCM and
  // COSMO by name, and solvation is a single-point setting.
  const pyscfSolventModel = PYSCF_SOLVATION_MODELS.includes(s.solvationModel) ? s.solvationModel : 'PCM';
  const pyscfSolvationGroup = group('Solvation', s.solvation ? `${pyscfSolventModel} · ${s.solvent}` : 'off', s.solvation, [
    switchRow('Implicit solvation', 'PCM / C-PCM', 'solvation', s.solvation),
    selectField('Model', 'solvationModel', PYSCF_SOLVATION_MODELS.map((model) => [model, model === 'PCM' ? 'PCM (IEF-PCM)' : 'C-PCM']), pyscfSolventModel),
    selectField('Solvent', 'solvent', SOLVENTS, s.solvent),
    '<div class="field full"><span class="inspector-note">PySCF\'s <code>solvent.PCM</code> writes a dielectric continuum. '
      + 'PCM is IEF-PCM and C-PCM is the conductor-like model; neither is SMD, COSMO or a solvation free energy. '
      + 'A solvated block is a single point: Opt, Freq and Opt Freq are refused by name.</span></div>',
  ].join(''));

  // Issue #42: xTB has its own solvation models and identifiers. The group is
  // always rendered; only the Gaussian wording and model list are replaced.
  const xtbSolvationOn = Boolean(s.solvation);
  const storedXtbModel = String(s.solvationModel || '').toUpperCase();
  const xtbModelValid = XTB_SOLVATION_MODELS.includes(storedXtbModel);
  const xtbModel = xtbModelValid ? storedXtbModel : (xtbSolvationOn ? '' : 'ALPB');
  const xtbSolventLabels = Object.keys(XTB_SOLVENTS[xtbModel] || XTB_SOLVENTS.ALPB);
  const storedXtbSolvent = String(s.solvent || '');
  const xtbSolventValid = xtbSolventLabels.includes(storedXtbSolvent);
  const xtbSolvent = xtbSolventValid ? storedXtbSolvent : (xtbSolvationOn ? '' : 'Water');
  const xtbSolvationOptions = XTB_SOLVATION_MODELS.map((model) => [model, model]);
  if (xtbSolvationOn && !xtbModelValid) xtbSolvationOptions.unshift(['', 'Choose ALPB or GBSA']);
  const xtbSolventOptions = xtbSolventLabels.map((label) => [label, label]);
  if (xtbSolvationOn && !xtbSolventValid) xtbSolventOptions.unshift(['', 'Choose a solvent']);
  const xtbSolvationGroup = group('Solvation', xtbSolvationOn ? `${xtbModel || 'unset'} · ${xtbSolvent || 'unset'}` : 'off', xtbSolvationOn, [
    switchRow('Implicit solvation', 'ALPB / GBSA', 'solvation', s.solvation),
    selectField('Model', 'solvationModel', xtbSolvationOptions, xtbModel),
    selectField('Solvent', 'solvent', xtbSolventOptions, xtbSolvent),
    '<div class="field full"><span class="inspector-note">xTB implements ALPB and GBSA implicit solvation; the solvent is passed by its xTB identifier.</span></div>',
  ].join(''));

  const moleculeGroup = group('Molecule', `${state.project.molecule.fragments.length} fragments`, false, [
    inputField('Charge', 'charge', s.charge, { type: 'number', min: -10, max: 10 }),
    inputField('Multiplicity', 'multiplicity', s.multiplicity, { type: 'number', min: 1, max: 10 }),
    `<div class="field full"><label>Structure</label><div class="card" style="display:flex;align-items:center;gap:8px;justify-content:space-between">
      <span class="inspector-note">Geometry comes from the project molecule; charge and multiplicity are per-block overrides.</span>
      <button type="button" class="btn small" data-open-modal="molecule">Edit</button>
    </div></div>`,
  ].join(''));

  // Issue 186: the spin-state sweep is a control on the block, not a second
  // block. It is off by default and writes nothing until it is switched on, so
  // a project that never used it stays byte-identical. The offered states are
  // the ones the electron count allows — the same rule the planner follows.
  const spinInfo = spinMultiplicitiesForNode(node);
  const storedSweep = s.spinSweep && s.spinSweep.enabled === true ? s.spinSweep : null;
  const sweepOn = Boolean(storedSweep);
  const chosenSpin = new Set((storedSweep?.multiplicities || []).map(Number));
  const impossibleSpin = [...chosenSpin].filter((value) => !spinInfo.values.includes(value));
  const spinMeta = !spinInfo.values.length
    ? 'no electron count'
    : sweepOn
      ? `states ${[...chosenSpin].sort((a, b) => a - b).join(', ')} · one geometry`
      : `off · ${spinInfo.values.length} legal`;
  // A stored sweep may name a multiplicity this electron count cannot have (a
  // hand-edited file, or a charge change after the sweep was set). It is shown
  // so it can be unticked, and named in the warning below.
  const offeredSpin = [...spinInfo.values, ...impossibleSpin.filter((value) => !spinInfo.values.includes(value))]
    .sort((a, b) => a - b);
  const spinGroup = group('Spin states', spinMeta, sweepOn, [
    switchRow('Spin-state sweep', `one run per multiplicity · up to ${SPIN_SWEEP_MAX} states`,
      'spinSweepEnabled', sweepOn, { disabled: spinInfo.values.length < 2 }),
    sweepOn && offeredSpin.length
      ? `<div class="field full"><label>Multiplicities</label><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">`
        + offeredSpin.map((multiplicity) => {
          const legal = spinInfo.values.includes(multiplicity);
          const checked = chosenSpin.has(multiplicity);
          // A sweep needs at least two distinct states; the last two cannot be
          // cleared here, or the project would be invalid on the next keystroke.
          const locked = checked && legal && chosenSpin.size <= 2;
          return `<label class="inspector-note" style="display:inline-flex;gap:5px;align-items:center;cursor:pointer${legal ? '' : ';text-decoration:line-through'}"`
            + `${legal ? '' : ` title="Not allowed for ${spinInfo.electrons} electrons"`}>`
            + `<input type="checkbox" data-spin-state="${multiplicity}" aria-label="Multiplicity ${multiplicity}${legal ? '' : ' (not allowed)'}"`
            + `${checked ? ' checked' : ''}${locked ? ' disabled' : ''}> m${multiplicity}</label>`;
        }).join('')
        + '</div></div>'
      : '',
    sweepOn && impossibleSpin.length
      ? `<div class="field full"><span class="inspector-note"><strong>Not allowed:</strong> `
        + `${impossibleSpin.map((value) => `multiplicity ${value}`).join(', ')} for ${spinInfo.electrons} electrons. `
        + `An ${spinInfo.electrons % 2 === 0 ? 'even' : 'odd'} electron count allows `
        + `${spinInfo.electrons % 2 === 0 ? 'odd' : 'even'} multiplicities only; untick or replace it before queueing.</span></div>`
      : '',
    '<div class="field full"><span class="inspector-note">'
      + (spinInfo.values.length
        ? `Each state is a separate calculation at the same geometry (${spinInfo.electrons} electrons). `
          + 'The comparison names the lowest of the states that ran — it is not a ground-state determination, '
          + 'because no state beyond those listed is computed.'
        : 'No electron count is available for this block, so no multiplicity can be offered.')
      + '</span></div>',
  ].join(''));

  // Raman (#76) is a modifier of the frequency keyword, so the switch only
  // appears where a frequency job exists to carry it.
  const frequencyJob = /Freq/i.test(String(s.jobType || ''));
  // Issue 147: only an NMR job can print couplings, and only when the route asks
  // for them. Off writes no key at all, so an NMR block from before this control
  // serialises byte-identically and its card keeps saying the route did not ask
  // for couplings.
  const nmrJob = /NMR/i.test(String(s.jobType || ''));
  const nmrGroup = group('NMR', s.nmrSpinSpin ? 'shieldings + couplings' : 'shieldings only', s.nmrSpinSpin, [
    switchRow(
      'Spin-spin couplings',
      isOrca
        ? 'adds SSALL to the %EPRNMR block; ORCA then prints the isotropic J matrix'
        : 'adds SpinSpin to the NMR keyword; Gaussian then prints the K and J tables',
      'nmrSpinSpin',
      s.nmrSpinSpin,
    ),
    '<div class="field full"><span class="inspector-note">'
      + (isOrca
        ? 'ORCA prints one J value for every nucleus pair in the coupling summary: '
          + 'on a 20-nucleus molecule that is 190 pairs, each with its own tensor '
          + 'calculation. Without this the results card says couplings were not '
          + 'requested rather than reporting none.'
        : 'A coupling run costs more than shieldings alone and prints one K and one J '
          + 'table for every nucleus pair: on a 20-nucleus molecule that is 190 pairs. '
          + 'Without this, the results card says couplings were not requested rather '
          + 'than reporting none.')
      + '</span></div>',
  ]);
  const ramanGroup = group('Raman', s.raman ? 'activities on' : 'off', s.raman, [
    switchRow('Raman activities', 'adds =Raman to the frequency keyword', 'raman', s.raman, { disabled: !frequencyJob }),
    '<div class="field full"><span class="inspector-note">'
      + (frequencyJob
        ? 'Gaussian prints the Raman activity (Å<sup>4</sup>/amu) and the depolarisation ratios with the modes. '
          + 'The results panel plots the <em>activity</em>, not a scattering cross-section.'
        : 'Requires a frequency job: choose Freq or Opt Freq. The input builder refuses the keyword otherwise.')
      + '</span></div>',
  ].join(''));

  // VCD (#78) is the other modifier of the frequency keyword. It is offered only
  // where a frequency job exists, and the note says what the panel will show and
  // what Gaussian does *not* state (the velocity/length representation).
  const vcdGroup = group('VCD', s.vcd ? 'rotational strengths on' : 'off', s.vcd, [
    switchRow('VCD rotational strengths', 'adds =VCD to the frequency keyword', 'vcd', s.vcd, { disabled: !frequencyJob }),
    '<div class="field full"><span class="inspector-note">'
      + (frequencyJob
        ? 'Gaussian prints the rotational strength <em>R</em> (10<sup>−44</sup> esu<sup>2</sup> cm<sup>2</sup>), '
          + 'the dipole strength and the E–M angle per mode. <em>R</em> is signed and the results panel plots it '
          + 'around a zero line. With Raman also on, one keyword carries both: <code>Freq=(Raman,VCD)</code>.'
        : 'Requires a frequency job: choose Freq or Opt Freq. The input builder refuses the keyword otherwise.')
      + ' Gaussian 16 prints no velocity/length label for the row, so the panel records the unit and says the '
      + 'representation is not stated.'
      + '</span></div>',
  ].join(''));

  // ROA (issue 127) is the third frequency-keyword flag. It is Gaussian-only and
  // needs a frequency job; the panel makes the user choose one of the three
  // printed scattering geometries rather than averaging them.
  const roaGroup = group('ROA', s.roa ? 'intensities on' : 'off', s.roa, [
    switchRow('ROA intensities', 'adds =ROA to the frequency keyword', 'roa', s.roa, { disabled: !frequencyJob }),
    '<div class="field full"><span class="inspector-note">'
      + (frequencyJob
        ? 'Gaussian prints three ROA intensities per mode: <code>ROA1</code> ICPu/SCPu(180), '
          + '<code>ROA2</code> ICPd/SCPd(90) and <code>ROA3</code> DCPI(180), plus <code>RC180</code>. '
          + 'The results panel plots the one you choose and names its geometry; the units are the ones the log states.<br>'
          + 'With Raman and VCD also on, one keyword carries all three: <code>Freq=(Raman,VCD,ROA)</code>.'
        : 'Requires a frequency job: choose Freq or Opt Freq. The input builder refuses the keyword otherwise.')
      + '</span></div>',
  ].join(''));

  const gates = s.gates;
  const gatesGroup = group('Gates', `${[gates.thermo, gates.finalEnergy, gates.imaginary !== null, gates.scf].filter(Boolean).length} active`, true, [
    switchRow('Normal termination', 'always required', 'termination', true, { gate: true, disabled: true }),
    switchRow('SCF record', 'must be present', 'scf', gates.scf, { gate: true }),
    inputField('Imaginary modes', 'imaginary', gates.imaginary === null ? '' : gates.imaginary, { type: 'number', min: 0, max: 10 }),
    inputField('Min |ν| (cm⁻¹)', 'minMagnitude', gates.minMagnitude ?? '', { type: 'number', min: 0, step: 1 }),
    switchRow('Thermochemistry', 'requires a frequency output', 'thermo', gates.thermo, { gate: true }),
    switchRow('Post-HF final energy', 'requires a final energy record', 'finalEnergy', gates.finalEnergy, { gate: true }),
  ].join(''));

  // Issue #25: every validity check can be switched off per block. The schema
  // stores the disabled ids, so the choice survives save/reopen.
  const disabledChecks = Array.isArray(s.disabledChecks) ? s.disabledChecks : [];
  const validityGroup = group(
    'Validity checks',
    `${VALIDITY_CHECKS.length - disabledChecks.length}/${VALIDITY_CHECKS.length} active`,
    false,
    VALIDITY_CHECKS.map((check) => switchRow(
      check.title,
      check.phases.map((phase) => (phase === 'pre' ? 'pre-run' : 'post-run')).join(' · '),
      check.id,
      !disabledChecks.includes(check.id),
      { attr: `data-validity-check="${check.id}"` },
    )).join(''),
  );

  const dependencyGroup = group('Dependencies', `${ins.length} input${ins.length === 1 ? '' : 's'}`, true, [
    `<div class="full">${incomingList(node.id)}</div>`,
    checkpointHandoff && ins.length ? `<div class="field full"><label>Checkpoint hand-off</label><select class="select" aria-label="Checkpoint hand-off" data-node-field="checkpointFrom">
      <option value="">None</option>
      ${ins.map((edge) => {
        const source = nodeById(edge.from);
        const artifact = source && source.type === 'calculate' ? checkpointNameFor(source) : '';
        return source ? `<option value="${source.id}"${node.checkpointFrom === source.id ? ' selected' : ''}>${esc(source.title)}${artifact ? ` · ${esc(artifact)}` : ''}</option>` : '';
      }).join('')}
    </select><span class="inspector-note" style="display:block;margin-top:4px">${checkpointHandoffNote(engine.id)}</span></div>` : '',
  ].join(''));

  const outputGroup = group('Output', node.output ? 'parsed' : 'none', true, [
    node.output
      ? `<div class="full"><div class="output-row"><span class="file-icon">LOG</span><code>${esc(node.output.file)}</code><span class="size">${esc(node.output.size)}</span></div>
        <div class="inspector-actions-row"><button type="button" class="btn small" data-action="view-output">View parsed output</button><button type="button" class="btn small" data-action="import-log">Replace log</button></div></div>`
      : `<div class="full"><div class="callout">No parsed output yet. Run a selected calculation; the runner parses its output and evaluates the gates automatically.<button type="button" class="btn small" data-action="open-run-console">Open runner</button></div></div>`,
  ].join(''));

  const extraGroup = group('Extra keywords', s.customKeywords ? 'custom' : 'none', false, [
    inputField('Route keywords', 'customKeywords', s.customKeywords, { full: true }),
  ].join(''));

  const xtbGroup = group('xTB', `${(XTB_METHODS.find((item) => item.id === (s.xtbMethod || 'gfn2')) || {}).label || 'GFN2-xTB'} · ${s.xtbOptLevel || 'normal'}`, true, [
    selectField('Hamiltonian', 'xtbMethod', XTB_METHODS.map((item) => [item.id, item.label]), s.xtbMethod || 'gfn2'),
    selectField('Optimisation level', 'xtbOptLevel', XTB_OPT_LEVELS.map((level) => [level, level]), s.xtbOptLevel || 'normal'),
    showsXtbThreads(engine.id)
      ? inputField('Threads (OMP_NUM_THREADS)', 'xtbThreads', s.xtbThreads ?? '', { type: 'number', min: 1, max: 256 })
      : '',
    '<div class="full"><div class="callout">This project runs on xTB. Gaussian route fields (method, basis, dispersion, SCF, grid, population) are ignored. GFN2-xTB includes D4 dispersion; transition-state searches, IRC and scans are not supported and are refused at input build.</div></div>',
  ].join(''));
  const headRoute = isXtb ? `${(XTB_METHODS.find((item) => item.id === (s.xtbMethod || 'gfn2')) || {}).label || 'xTB'} · ${s.jobType}` : routeShort(s);

  const primary = node.state === 'passed'
    ? '<button type="button" class="btn primary" data-action="view-output">View output</button>'
    : node.state === 'ready'
      ? '<button type="button" class="btn primary" data-action="export">Export input</button>'
      : '<button type="button" class="btn primary" data-action="import-log">Import log</button>';

  return `${inspectorHead(`${kindLabel(node)} · ${node.kind}`, node.title, `${headRoute} · ${status.label}`)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${ins.length} input${ins.length === 1 ? '' : 's'} · ${outs.length} output${outs.length === 1 ? '' : 's'}</span></div>
    ${callout}
    <div class="code-block" style="margin-bottom:10px">${routeLines.map((line) => `<div>${line}</div>`).join('')}</div>
    ${jobGroup}
    ${constraintGroup}
    ${qstEditor}
    ${isXtb ? xtbGroup : isPsi4 ? psi4MethodGroup : isPyscf ? pyscfMethodGroup : isOrca ? orcaMethodGroup : compositeJob ? compositeNote : methodGroup}
    ${isXtb || isPsi4 || isPyscf || isOrca || compositeJob ? '' : excitedGroup}
    ${psi4TdGroup}${pyscfTdGroup}
    ${orcaTdGroup}
    ${isXtb || isPsi4 || isPyscf || compositeJob || !nmrJob ? '' : nmrGroup}
    ${isXtb || isPsi4 || isPyscf || isOrca || compositeJob ? '' : ramanGroup}
    ${isXtb || isPsi4 || isPyscf || isOrca || compositeJob ? '' : vcdGroup}
    ${isXtb || isPsi4 || isPyscf || isOrca || compositeJob ? '' : roaGroup}
    ${isXtb ? xtbSolvationGroup : isPsi4 ? '' : isPyscf ? pyscfSolvationGroup : compositeJob ? '' : isOrca ? orcaSolvationGroup : gaussianSolvationGroup}
    ${moleculeGroup}
    ${spinGroup}
    ${gatesGroup}
    ${isXtb ? '' : validityGroup}
    ${dependencyGroup}
    ${outputGroup}
    ${isXtb || isPsi4 || isPyscf || isOrca ? '' : extraGroup}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="duplicate-node">Duplicate</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    ${primary}
    <button type="button" class="btn" data-action="validate">Validate</button>
  </div>`;
}

function branchRow(edge, branch, conditionId) {
  const target = edge ? nodeById(edge.to) : null;
  const candidates = state.project.nodes.filter((node) => node.id !== conditionId && node.type !== 'note');
  const label = branch === 'true' ? 'TRUE' : 'FALSE';
  return `<div class="field full">
    <label><span class="${branch === 'true' ? 'branch-tag true' : 'branch-tag false'}" style="position:static;display:inline-block;margin-right:5px">${label}</span>Branch target</label>
    <select class="select" data-branch-edit="${branch}">
      <option value="">Not connected</option>
      ${candidates.map((node) => `<option value="${node.id}"${target?.id === node.id ? ' selected' : ''}>${esc(node.title)} · ${esc(statusFor(node).label)}</option>`).join('')}
    </select>
  </div>`;
}

/**
 * Compute block inspector (issue 175).
 *
 * The preview is not a second implementation of the arithmetic: it calls
 * `shared.computeContext()` and `evaluateCompute()` — the same pair the plan
 * and the queue use — so the number in the inspector is the number the plan
 * will write. It reads the upstream blocks' attached `parsed` results, which is
 * exactly what the plan falls back to when no run records are supplied.
 */
function computeUpstreamBlocks(node) {
  return state.project.edges
    .filter((edge) => edge.to === node.id
      && (edge.type === 'dependency' || edge.type === 'checkpoint' || edge.type === 'barrier'))
    .map((edge) => nodeById(edge.from))
    .filter((item) => item && item.type !== 'note');
}

function computePreviewOf(node) {
  try {
    const context = shared.computeContext(state.project, node);
    if (context.mode === 'multiwfn') {
      // Issue 270: a Multiwfn block has no value to preview. The inspector
      // shows the pinned script it will run instead of pretending to compute.
      return { error: null, mode: 'multiwfn', result: null };
    }
    if (context.mode === 'dp4') {
      // Issue 165: the preview reads the same candidate rows the plan does. It
      // can only see the blocks' attached parsed results (a fresh project has
      // no run folders), so it names what it has and refuses rather than guess.
      const rows = dp4RowsFromSources(context.sources, context.rowsFor);
      return { error: null, mode: 'dp4', result: evaluateDp4(node.analyse?.dp4, { rows }) };
    }
    return {
      error: null,
      mode: 'expression',
      result: evaluateCompute(node.analyse || { expression: '', inputs: [] }, {
        recordId: null,
        resolveSource: context.resolveSource,
        allRecords: context.allRecords,
      }),
    };
  } catch (error) {
    return { error: error instanceof ComputeError ? error.message : String(error?.message || error), result: null };
  }
}

/** The DP4+ inspector preview: the verdict, the table's first column, or the refusal. */
function dp4PreviewHtml(result) {
  if (!result) return '<p class="inspector-note" data-role="compute-preview">not computed</p>';
  if (result.available !== true) {
    return `<p class="inspector-note" data-role="compute-preview">${esc(result.reason || 'DP4+ not computed')}</p>`;
  }
  const rows = (result.candidates || []).map((candidate) => `<tr><td>${esc(candidate.title || candidate.id)}</td>`
    + `<td class="num">${esc(Number(candidate.percent).toFixed(2))}</td>`
    + `<td class="num">${esc(String(candidate.conformerCount ?? ''))}</td>`
    + `<td class="num">${esc(String((candidate.nuclei || []).length))}</td></tr>`).join('');
  const excluded = (result.excluded || []).map((entry) => `<p class="inspector-note" data-role="dp4-excluded">`
    + `Excluded ${esc(entry.candidateId)}: ${esc(entry.reason)}</p>`).join('');
  return `<p data-role="compute-preview"><strong>${esc(dp4Summary(result))}</strong></p>`
    + '<table class="mini-table"><thead><tr><th>Candidate</th><th class="num">p full / %</th>'
    + '<th class="num">Conformers</th><th class="num">Nuclei</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>${excluded}`;
}

function computePreviewHtml(node) {
  const { error, mode, result } = computePreviewOf(node);
  if (error) return `<p class="inspector-note" data-role="compute-preview">${esc(error)}</p>`;
  if (mode === 'multiwfn') {
    const definition = node.analyse?.multiwfn;
    const analysis = multiwfnAnalysis(definition?.analysis);
    if (!analysis) return '<p class="inspector-note" data-role="compute-preview">Choose a Multiwfn analysis.</p>';
    let script;
    try {
      script = multiwfnMenuScript(analysis.id, definition);
    } catch (failure) {
      return `<p class="inspector-note" data-role="compute-preview">${esc(failure.message)}</p>`;
    }
    return `<p class="inspector-note" data-role="compute-preview">Multiwfn ${MULTIWFN_MENU_VERSION} menus · `
      + `${esc(analysis.label)} · ${script.lines.length} menu answers. This block runs the user-installed `
      + 'binary in batch mode; it has no arithmetic preview.</p>'
      + `<div class="code-block" data-role="multiwfn-script">${esc(script.text)}</div>`;
  }
  if (mode === 'dp4') return dp4PreviewHtml(result);
  if (result.status === 'computed') {
    return `<div class="code-block" data-role="compute-preview">`
      + `<div>${esc(result.expression)} = ${esc(formatComputeNumber(result.value))}${result.unit ? ` ${esc(result.unit)}` : ''}</div>`
      + '</div>'
      + `<p class="inspector-note">Derived from ${result.inputs.length} upstream value${result.inputs.length === 1 ? '' : 's'}: `
      + `${esc(result.inputs.map((input) => `${input.field} of ${input.recordId}`).join(', '))}. `
      + 'This is a derived quantity, not a result an engine printed.</p>'
      + (result.notes.length ? `<p class="inspector-note">${result.notes.map((note) => esc(note)).join(' ')}</p>` : '');
  }
  return `<p class="inspector-note" data-role="compute-preview">${esc(result.notComputed || 'not computed')}</p>`;
}

/** Replace only the preview, so typing in the expression field keeps focus. */
function refreshComputePreview() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  const slot = $('#compute-preview-slot');
  if (!node || node.type !== 'analyse' || !slot) return;
  slot.innerHTML = computePreviewHtml(node);
}

function computeInputRow(input, index, upstream) {
  const fields = COMPUTE_FIELDS.map((field) => `<option value="${esc(field.key)}"${input.field === field.key ? ' selected' : ''}>`
    + `${esc(field.label)}${field.unit ? ` · ${esc(field.unit)}` : ''}</option>`).join('');
  const sources = [`<option value="">${upstream.length === 1 ? 'the only upstream block' : 'choose a block'}</option>`]
    .concat(upstream.map((source) => `<option value="${esc(source.id)}"${input.source === source.id ? ' selected' : ''}>${esc(source.title || source.id)}</option>`))
    .join('');
  return `<tr>
    <td><input class="input" data-compute-input="${index}" data-compute-input-field="name" data-role="compute-input-name" value="${esc(input.name || '')}" aria-label="Input name"></td>
    <td><select class="select" data-compute-input="${index}" data-compute-input-field="field" data-role="compute-input-field" aria-label="Field">${fields}</select></td>
    <td><select class="select" data-compute-input="${index}" data-compute-input-field="source" data-role="compute-input-source" aria-label="Upstream block">${sources}</select></td>
    <td><button type="button" class="btn small" data-action="compute-remove-input" data-compute-index="${index}" aria-label="Remove input">×</button></td>
  </tr>`;
}

/**
 * The saved DP4+ definition of a compute block, with the defaults a new block
 * needs filled in — never a number that has not been chosen.
 */
function dp4DefinitionOf(node) {
  if (!node.analyse || typeof node.analyse !== 'object') node.analyse = { expression: '', inputs: [] };
  if (!node.analyse.dp4 || typeof node.analyse.dp4 !== 'object') {
    node.analyse.dp4 = { level: '', solvation: 'gas', solvent: '', variant: 'full', temperature: 298.15, experimental: [] };
  }
  const definition = node.analyse.dp4;
  if (!Array.isArray(definition.experimental)) definition.experimental = [];
  return definition;
}

/** The `id|solvation` pair a level select carries, so the two cannot disagree. */
function dp4LevelValue(definition) {
  const id = String(definition?.level || '');
  if (!id) return '';
  return `${id}|${definition?.solvation || 'gas'}`;
}

function dp4LevelOptions(definition) {
  const levels = dp4Levels();
  const chosen = dp4LevelValue(definition);
  const head = '<option value="">choose a level the bank carries…</option>';
  const options = levels.map((entry) => {
    const value = `${entry.id}|${entry.solvation}`;
    return `<option value="${esc(value)}"${value === chosen ? ' selected' : ''}>${esc(entry.label)}</option>`;
  }).join('');
  // A level the bank does not carry is still shown, selected and named, so a
  // hand-edited project reads as "this is not in the bank" rather than as blank.
  const known = levels.some((entry) => `${entry.id}|${entry.solvation}` === chosen);
  const stale = chosen && !known
    ? `<option value="${esc(chosen)}" selected>${esc(chosen)} — not in the bank, the block will be refused</option>`
    : '';
  return head + stale + options;
}

function dp4SolventOptions(definition) {
  if ((definition.solvation || 'gas') === 'gas') {
    return '<option value="" selected>gas phase — no solvent</option>';
  }
  const entry = dp4Levels().find((item) => item.id === definition.level && item.solvation === definition.solvation);
  const solvents = entry?.solvents || [];
  return ['<option value="">choose the solvent…</option>']
    .concat(solvents.map((name) => `<option value="${esc(name)}"${definition.solvent === name ? ' selected' : ''}>${esc(name)}</option>`))
    .join('');
}

/** One measured shift: nucleus, value, sp², diastereotopic label, atom numbers. */
function dp4RowHtml(row, index) {
  const nucleus = String(row?.nucleus || '13C');
  const atoms = Array.isArray(row?.atoms) ? row.atoms.join(', ') : '';
  return `<tr data-role="dp4-row" data-dp4-row="${index}">
    <td><select class="select" data-dp4-row="${index}" data-dp4-row-field="nucleus" aria-label="Nucleus">
      ${['13C', '1H'].map((label) => `<option value="${label}"${nucleus === label ? ' selected' : ''}>${label}</option>`).join('')}
    </select></td>
    <td><input class="input" type="number" step="0.01" data-dp4-row="${index}" data-dp4-row-field="shift" value="${Number.isFinite(row?.shift) ? row.shift : ''}" aria-label="Measured shift in ppm"></td>
    <td><input class="input" data-dp4-row="${index}" data-dp4-row-field="atoms" value="${esc(atoms)}" placeholder="e.g. 12, 13" aria-label="Atom numbers"></td>
    <td><input type="checkbox" data-dp4-row="${index}" data-dp4-row-field="sp2"${row?.sp2 === true ? ' checked' : ''} aria-label="sp2 carbon"></td>
    <td><input class="input" data-dp4-row="${index}" data-dp4-row-field="exchange" value="${esc(row?.exchange || '')}" placeholder="a" aria-label="Diastereotopic label"></td>
    <td><button type="button" class="btn small" data-action="dp4-remove-row" data-dp4-index="${index}" aria-label="Remove measured shift">×</button></td>
  </tr>`;
}

function dp4InspectorBody(definition) {
  const rows = definition.experimental.length
    ? definition.experimental.map((row, index) => dp4RowHtml(row, index)).join('')
    : '<tr><td colspan="6" class="inspector-note">No measured shifts yet — DP4+ compares a calculation with a measurement.</td></tr>';
  const variants = DP4_VARIANTS.map((key) => `<option value="${esc(key)}"${definition.variant === key ? ' selected' : ''}>${esc(DP4_VARIANT_LABELS[key])}</option>`).join('');
  return group('DP4+ comparison', 'level · variant · measured shifts', true, [
    '<div class="field full"><label>Level of theory</label>'
      + `<select class="select" data-dp4-field="level" aria-label="Level of theory">${dp4LevelOptions(definition)}</select>`
      + '<div class="inspector-note">The bank carries 24 DP4+ levels. A level it does not carry is refused by name at save time, never approximated with another level\'s parameters.</div></div>',
    '<div class="field full"><label>Solvent of the standard</label>'
      + `<select class="select" data-dp4-field="solvent" aria-label="Solvent">${dp4SolventOptions(definition)}</select></div>`,
    `<div class="field"><label>Variant</label><select class="select" data-dp4-field="variant" aria-label="DP4+ variant">${variants}</select></div>`,
    `<div class="field"><label>Temperature / K</label><input class="input" type="number" step="0.01" data-dp4-field="temperature" value="${esc(String(definition.temperature ?? 298.15))}" aria-label="Temperature in kelvin"></div>`,
    `<div class="full"><table class="mini-table"><thead><tr><th>Nucleus</th><th>δ exp / ppm</th><th>Atoms</th><th>sp²</th><th>Exchange</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`,
    '<div class="field full"><button type="button" class="btn small" data-action="dp4-add-row">Add measured shift</button></div>',
    '<div class="field full"><div class="inspector-note">Every measured shift carries its own 1-based atom numbers, as the log prints them; equivalent atoms on one row are averaged, and an atom assigned twice is refused. The candidates are the run records of the blocks wired into this one — one candidate per dataset record, one conformer per fanned-out member.</div></div>',
  ].join(''));
}

/**
 * The saved Multiwfn definition of a block (issue 270), with the defaults a
 * new block needs filled in. No analysis is chosen silently: a block that never
 * asked for Multiwfn keeps its expression byte for byte.
 */
function multiwfnDefinitionOf(node) {
  if (!node.analyse || typeof node.analyse !== 'object') node.analyse = { expression: '', inputs: [] };
  if (!node.analyse.multiwfn || typeof node.analyse.multiwfn !== 'object') {
    const upstream = computeUpstreamBlocks(node);
    node.analyse.multiwfn = {
      analysis: 'qtaim',
      input: upstream.length === 1 ? { nodeId: upstream[0].id } : {},
      grid: 2,
    };
  }
  const definition = node.analyse.multiwfn;
  if (!definition.input || typeof definition.input !== 'object') definition.input = {};
  return definition;
}

/** One Multiwfn inspector: analysis, input source, parameters and pinned script. */
function multiwfnInspectorBody(definition, upstream, node) {
  const analysis = multiwfnAnalysis(definition.analysis);
  const analysisOptions = MULTIWFN_ANALYSES.map((entry) => `<option value="${esc(entry.id)}"${entry.id === definition.analysis ? ' selected' : ''}>`
    + `${esc(entry.label)}</option>`).join('');
  const sourceOptions = ['<option value="">choose an upstream block…</option>']
    .concat(upstream.map((block) => `<option value="${esc(block.id)}"${definition.input.nodeId === block.id ? ' selected' : ''}>`
      + `${esc(block.title || block.id)}</option>`)).join('');
  const input = definition.input || {};
  const parameterFields = Object.entries(analysis?.parameters || {}).map(([key, spec]) => {
    const raw = definition[key] ?? spec.default;
    return `<div class="field"><label>${esc(spec.label)}</label>`
      + `<input class="input" type="number" step="${spec.type === 'integer' ? '1' : 'any'}" min="${spec.min}" max="${spec.max}" `
      + `data-multiwfn-field="${esc(key)}" value="${esc(String(raw))}" aria-label="${esc(spec.label)}">`
      + `<div class="inspector-note">${esc(spec.help)}</div></div>`;
  }).join('');
  let script = '';
  try {
    script = multiwfnMenuScript(analysis?.id || 'qtaim', definition).text;
  } catch (error) {
    script = error.message;
  }
  return group('Multiwfn sidecar', `${MULTIWFN_MENU_VERSION} menus · user-installed`, true, [
    `<div class="field full"><label>Analysis</label><select class="select" data-multiwfn-field="analysis" aria-label="Multiwfn analysis">${analysisOptions}</select>`
      + '<div class="inspector-note">The menu script is chosen from the installed release band '
      + '(<code>2024+</code> or <code>3.8</code>). ELF/LOL write a cube; QTAIM integrates basins and '
      + 'critical points; ESP reports surface statistics; RDG–NCI reports sign(λ₂)ρ / RDG points.</div></div>',
    `<div class="field full"><label>Wavefunction from an upstream block</label><select class="select" data-multiwfn-input="nodeId" aria-label="Upstream block">${sourceOptions}</select></div>`,
    `<div class="field full"><label>…or a project-relative path</label><input class="input" data-multiwfn-input="path" value="${esc(input.path || '')}" placeholder="wavefunctions/water.fchk" aria-label="Wavefunction path" spellcheck="false" autocomplete="off">`
      + '<div class="inspector-note">Exactly one source: an upstream block, a run id, or a path. '
      + 'A path is relative to the project folder and may not contain “..”.</div></div>',
    `<div class="field full"><label>…or a run id</label><input class="input" data-multiwfn-input="runId" value="${esc(input.runId || '')}" placeholder="run id from an upstream task" aria-label="Run id" spellcheck="false" autocomplete="off"></div>`,
    parameterFields,
    `<div class="field full"><label>Menu script</label><div id="compute-preview-slot">${computePreviewHtml(node)}</div></div>`,
    `<div class="full"><div class="inspector-note"><strong>Licence.</strong> ${esc(MULTIWFN_LICENCE)} `
      + `<strong>Cite:</strong> ${esc(MULTIWFN_CITATION)}. A missing binary, an unsupported version or a missing `
      + 'density matrix fails by name; it is never reported as unknown.</div></div>',
  ].join(''));
}

function computeInspector(node) {
  const upstream = computeUpstreamBlocks(node);
  const ins = incoming(node.id);
  const definition = node.analyse && typeof node.analyse === 'object'
    ? node.analyse : { expression: '', inputs: [] };
  const mode = definition.mode === 'dp4'
    ? 'dp4'
    : (definition.mode === 'multiwfn' ? 'multiwfn' : 'expression');
  const dp4 = mode === 'dp4' ? dp4DefinitionOf(node) : null;
  const multiwfn = mode === 'multiwfn' ? multiwfnDefinitionOf(node) : null;
  const inputs = Array.isArray(definition.inputs) ? definition.inputs : [];
  const inputRows = inputs.length
    ? inputs.map((input, index) => computeInputRow(input, index, upstream)).join('')
    : '<tr><td colspan="4" class="inspector-note">No inputs yet — add one to name a field from an upstream block.</td></tr>';
  const functions = COMPUTE_FUNCTIONS.map((fn) => `<div><code>${esc(fn.name)}</code> — ${esc(fn.summary)}</div>`).join('');
  const eyebrow = mode === 'dp4' ? 'Derived · DP4+' : (mode === 'multiwfn' ? 'Sidecar · Multiwfn' : 'Derived · analyse');
  const subtitle = mode === 'dp4'
    ? 'candidate comparison'
    : (mode === 'multiwfn' ? 'wavefunction analysis' : 'derived quantity');
  return `${inspectorHead(eyebrow, node.title, `${upstream.length} upstream · ${subtitle}`)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${ins.length} input${ins.length === 1 ? '' : 's'} · ${mode === 'multiwfn' ? 'ran by the user-installed Multiwfn binary' : 'evaluated from upstream records'}</span></div>
    <div class="callout"><strong>${mode === 'multiwfn' ? 'External analysis' : 'Derived, not measured'}.</strong> This block computes ${mode === 'dp4' ? 'a probability per candidate structure from the committed DP4+ bank' : 'a number from other blocks\' results — a CBS limit, a ΔE, a ratio'}. Its result is never presented as a QM result, and a missing input is a refusal that names it, never a zero.</div>
    ${group('Mode', 'arithmetic, DP4+ or Multiwfn', true, [
      `<div class="field full"><label>What this block computes</label><select class="select" data-compute-mode="mode" aria-label="Analyse mode">
        <option value="expression"${mode === 'expression' ? ' selected' : ''}>Arithmetic expression over upstream fields</option>
        <option value="dp4"${mode === 'dp4' ? ' selected' : ''}>DP4+ probabilities over candidate structures</option>
        <option value="multiwfn"${mode === 'multiwfn' ? ' selected' : ''}>Multiwfn analysis of a wavefunction</option>
      </select></div>`,
    ].join(''))}
    ${mode === 'multiwfn' ? multiwfnInspectorBody(multiwfn, upstream, node) : mode === 'dp4' ? dp4InspectorBody(dp4) : group('Expression', 'safe arithmetic', true, [
      `<div class="field full"><label>Expression</label><textarea class="textarea" rows="3" data-compute-field="expression" data-role="compute-expression" aria-label="Expression">${esc(definition.expression || '')}</textarea></div>`,
      `<div class="field full"><label>Preview</label><div id="compute-preview-slot">${computePreviewHtml(node)}</div></div>`,
    ].join(''))}
    ${mode === 'dp4'
      ? group('Preview', 'the same evaluator the plan uses', true, [
        `<div class="field full"><div id="compute-preview-slot">${computePreviewHtml(node)}</div></div>`,
        `<div class="field full"><div class="inspector-note">The preview reads the upstream blocks' attached results; the plan counts one candidate per dataset record, so a fanned-out ensemble is one candidate with several conformers.</div></div>`,
      ].join(''))
      : mode === 'expression' ? group('Inputs', `${inputs.length}`, true, [
        `<div class="full"><table class="mini-table"><thead><tr><th>Name</th><th>Field</th><th>From</th><th></th></tr></thead><tbody>${inputRows}</tbody></table></div>`,
        `<div class="field full"><button type="button" class="btn small" data-action="compute-add-input">Add input</button></div>`,
      ].join('')) : ''}
    ${mode === 'expression' ? group('Functions', `${COMPUTE_FUNCTIONS.length}`, false, [`<div class="code-block">${functions}</div>`]) : ''}
    ${group('Connections', upstream.length ? `${upstream.length} upstream` : 'not connected', false, [`<div class="full">${incomingList(node.id)}</div>`])}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="validate">Validate</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="validate">Validate workflow</button>
  </div>`;
}

/** One more input row (issue 175), named after the next free letter. */
function addComputeInput() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'analyse') return;
  if (!node.analyse || typeof node.analyse !== 'object') node.analyse = { expression: '', inputs: [] };
  if (!Array.isArray(node.analyse.inputs)) node.analyse.inputs = [];
  const upstream = computeUpstreamBlocks(node);
  const used = new Set(node.analyse.inputs.map((input) => input.name));
  let name = 'E';
  for (let index = 1; used.has(name); index += 1) name = `E${index}`;
  node.analyse.inputs.push({
    name,
    field: 'finalEnergyHartree',
    source: upstream.length === 1 ? upstream[0].id : '',
  });
  renderGraph();
  renderInspector();
}

function removeComputeInput(index) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  const inputs = node?.analyse?.inputs;
  if (!Array.isArray(inputs) || index < 0 || index >= inputs.length) return;
  inputs.splice(index, 1);
  renderGraph();
  renderInspector();
}

/**
 * One more measured shift (issue 165).
 *
 * A new row starts as a carbon with no value and no atom: both are things the
 * user measured or read off the log, and a blank row is refused by name rather
 * than filled with a plausible number.
 */
function addDp4Row() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'analyse') return;
  const definition = dp4DefinitionOf(node);
  definition.experimental.push({ nucleus: '13C', shift: null, atoms: [] });
  renderGraph();
  renderInspector();
}

function removeDp4Row(index) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  const rows = node?.analyse?.dp4?.experimental;
  if (!Array.isArray(rows) || !Number.isInteger(index) || index < 0 || index >= rows.length) return;
  rows.splice(index, 1);
  renderGraph();
  renderInspector();
}

function conditionInspector(node) {
  const ins = incoming(node.id);
  const branches = state.project.edges.filter((edge) => edge.from === node.id && edge.type === 'branch');
  const trueEdge = branches.find((edge) => edge.branch === 'true');
  const falseEdge = branches.find((edge) => edge.branch === 'false');
  const expressionLines = node.condition.expression.split('\n').filter(Boolean);
  return `${inspectorHead('Control · condition', node.title, `${branches.length} branches · unknown policy`)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${ins.length} input${ins.length === 1 ? '' : 's'} · parsed evidence required</span></div>
    <div class="callout"><strong>Waiting for evidence.</strong> The condition is evaluated from a parsed output field such as <code>frequencies.imaginaryCount</code>; an unknown value blocks both branches.</div>
    <div class="code-block" style="margin-bottom:10px">${expressionLines.map((line) => `<div>${esc(line)}</div>`).join('')}</div>
    ${group('Logic', '2 outputs', true, [
      `<div class="field full"><label>Expression</label><textarea class="textarea" data-condition-field="expression" rows="4">${esc(node.condition.expression)}</textarea></div>`,
      `<div class="field full"><label>Unknown policy</label><select class="select" data-condition-field="unknown">
        ${[['block-both', 'Block both branches'], ['treat-false', 'Treat unknown as FALSE'], ['treat-true', 'Treat unknown as TRUE']].map(([value, label]) => `<option value="${value}"${node.condition.unknown === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></div>`,
      `<div class="field full"><label>Notes</label><textarea class="textarea" data-condition-field="notes" rows="3">${esc(node.condition.notes)}</textarea></div>`,
    ].join(''))}
    ${group('Branches', 'TRUE / FALSE', true, [
      branchRow(trueEdge, 'true', node.id),
      branchRow(falseEdge, 'false', node.id),
      `<div class="field full"><div class="inspector-note">Connect a branch by dragging the <strong>T</strong> or <strong>F</strong> port to another block. The FALSE branch may feed a loop block.</div></div>`,
    ].join(''))}
    ${group('Inputs', `${ins.length}`, true, [`<div class="full">${incomingList(node.id)}</div>`].join(''))}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="validate">Validate branches</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="validate">Validate branches</button>
    <button type="button" class="btn" data-action="select-false">Select FALSE target</button>
  </div>`;
}

function loopInspector(node) {
  const loop = node.loop;
  const ins = incoming(node.id);
  const loopEdge = state.project.edges.find((edge) => edge.from === node.id && edge.type === 'loop');
  const target = nodeById(loop.target);
  const candidates = state.project.nodes.filter((item) => item.type === 'calculate');
  return `${inspectorHead('Control · loop', node.title, `retry ×${loop.maxAttempts} · ${target?.title || 'no target'}`)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${ins.length} input${ins.length === 1 ? '' : 's'} · explicit loop edge</span></div>
    <div class="code-block" style="margin-bottom:10px"><div>maxAttempts = ${esc(loop.maxAttempts)}</div><div>target = ${esc(target?.title || 'none')}</div><div>until = ${esc(loop.until)}</div></div>
    ${group('Loop', 'retry control', true, [
      `<div class="field"><label>Max attempts</label><input class="input" type="number" min="1" max="10" data-loop-field="maxAttempts" value="${esc(loop.maxAttempts)}"></div>`,
      `<div class="field"><label>Mode</label><select class="select" data-loop-field="mode">
        ${[['retry', 'Retry until condition'], ['for-each', 'Fan out attempts']].map(([value, label]) => `<option value="${value}"${loop.mode === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select></div>`,
      `<div class="field full"><label>Loop target</label><select class="select" data-loop-field="target">
        ${candidates.map((item) => `<option value="${item.id}"${loop.target === item.id ? ' selected' : ''}>${esc(item.title)}</option>`).join('')}
      </select></div>`,
      `<div class="field full"><label>Exit condition</label><input class="input" data-loop-field="until" value="${esc(loop.until)}"></div>`,
    ].join(''))}
    ${group('Connections', loopEdge ? '1 loop edge' : 'not connected', true, [
      `<div class="full">${incomingList(node.id)}</div>`,
      `<div class="field full"><label>Loop back to</label><div class="card"><div class="kv"><span>Target</span><code>${esc(target?.title || '—')}</code></div><div class="kv"><span>Edge</span><code>${loopEdge ? 'violet dashed' : 'none'}</code></div></div></div>`,
    ].join(''))}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="validate">Validate loop</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="validate">Validate loop</button>
    <button type="button" class="btn" data-select-node="${loop.target}">Select target</button>
  </div>`;
}

function prepareInspector(node) {
  const s = node.settings || {};
  const output = node.output && typeof node.output === 'object' ? node.output : null;
  const kind = s.kind === 'embed3d' ? 'embed3d' : (s.kind === 'solvate' ? 'solvate' : 'relax');
  const converter = kind === 'embed3d' ? 'openbabel' : (s.converter === 'openbabel' ? 'openbabel' : 'uff');
  const detail = output
    ? prepareSummaryLine(output)
    : (kind === 'embed3d' ? 'SMILES → one 3D structure'
      : (kind === 'solvate' ? 'one structure → one explicit solvent cluster' : 'one structure → one relaxed structure'));
  const methodLabel = kind === 'solvate'
    ? 'Deterministic placement, rigid templates, no relaxation'
    : (kind === 'embed3d' ? 'Open Babel, --gen3d' : (converter === 'openbabel' ? 'Open Babel, MMFF94' : (converter === 'aimnet2' ? 'AIMNet2, ML forces + L-BFGS' : 'UFF, in-app')));
  return `${inspectorHead('Structure · prepare', node.title, detail)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">1 structure in, 1 out · no enumeration</span></div>
    ${group('Method', methodLabel, true, [
      `<div class="field"><label>Kind</label><select class="select" data-prepare-field="kind">
        <option value="relax"${kind === 'relax' ? ' selected' : ''}>Relax one structure</option>
        <option value="solvate"${kind === 'solvate' ? ' selected' : ''}>Add explicit solvent</option>
        <option value="embed3d"${kind === 'embed3d' ? ' selected' : ''}>Embed SMILES in 3D</option>
      </select></div>`,
      ...(kind === 'solvate' ? [
        `<div class="field"><label>Solvent</label><select class="select" data-prepare-field="solvent">${Object.values(EXPLICIT_SOLVENTS)
          .map((solvent) => `<option value="${esc(solvent.id)}"${String(s.solvent || 'water') === solvent.id ? ' selected' : ''}>${esc(solvent.label)} (${esc(solvent.formula)})</option>`).join('')}</select></div>`,
        `<div class="field"><label>Molecules</label><input class="input" type="number" min="1" max="64" data-prepare-field="solventCount" value="${esc(s.solventCount ?? 10)}"></div>`,
        `<div class="field"><label>Seed</label><input class="input" type="number" min="0" max="2147483647" data-prepare-field="seed" value="${esc(s.seed ?? 1)}"></div>`,
        `<div class="field"><label>Shell / Å</label><input class="input" type="number" min="1" max="20" step="0.1" data-prepare-field="shellAngstrom" value="${esc(s.shellAngstrom ?? 3.5)}"></div>`,
      ] : [
        `<div class="field"><label>Converter</label><select class="select" data-prepare-field="converter"${kind === 'embed3d' ? ' disabled' : ''}>
          <option value="uff"${converter === 'uff' ? ' selected' : ''}>UFF (in-app)</option>
          <option value="openbabel"${converter === 'openbabel' ? ' selected' : ''}>Open Babel (external)</option>
          <option value="aimnet2"${converter === 'aimnet2' ? ' selected' : ''}>AIMNet2 (ML scorer)</option>
        </select></div>`,
        ...(kind === 'embed3d' ? [
          `<div class="field full"><label>SMILES</label><input class="input" data-prepare-field="smiles" value="${esc(s.smiles || '')}" placeholder="CCO" spellcheck="false" autocomplete="off"></div>`,
        ] : [
          `<div class="field"><label>Force field</label><select class="select" data-prepare-field="forceField">
            <option value="UFF"${s.forceField !== 'MMFF94' && s.forceField !== 'AIMNet2' ? ' selected' : ''}>UFF</option>
            <option value="MMFF94"${s.forceField === 'MMFF94' ? ' selected' : ''}>MMFF94</option>
            <option value="AIMNet2"${s.forceField === 'AIMNet2' || converter === 'aimnet2' ? ' selected' : ''}>AIMNet2 (ML)</option>
          </select></div>`,
        ]),
      ]),
      `<div class="field"><label>Charge</label><input class="input" type="number" min="-10" max="10" data-prepare-field="charge" value="${esc(s.charge ?? 0)}"></div>`,
      `<div class="field"><label>Multiplicity</label><input class="input" type="number" min="1" max="10" data-prepare-field="multiplicity" value="${esc(s.multiplicity ?? 1)}"></div>`,
      `<div class="field full"><span class="inspector-note">${kind === 'solvate'
        ? 'Explicit cluster: deterministic Fibonacci-shell placement around the solute. It is not equilibrated and does not represent bulk solvent; the record keeps that limitation.'
        : 'Deterministic, 1→1: protonation-state and tautomer enumeration belong to Generate. A calculate block wired from this one runs on <code>prepared.xyz</code>.'}</span></div>`,
    ].join(''))}
    ${group('Result', output ? `${output.atomCount} atoms` : 'not prepared yet', Boolean(output), [
      output
        ? `<div class="field full"><div class="card">
            <div class="kv"><span>Outcome</span><code>${esc(output.kind)} · ${esc(output.converter)} · ${esc(output.forceField)}</code></div>
            ${output.solvationModel ? `<div class="kv"><span>Solvation</span><code>${esc(output.solvationModel)}</code></div>` : ''}
            ${output.kind === 'solvate'
              ? `<div class="kv"><span>Composition</span><code>${esc(output.formula || 'not recorded')}</code></div>
                 <div class="kv"><span>Placement</span><code>seed ${esc(output.seed)} · shell ${esc(output.shellAngstrom)} Å · min ${esc(output.minDistanceAngstrom)} Å</code></div>`
              : `<div class="kv"><span>Energy</span><code>${Number.isFinite(output.energyKcal) ? `${output.energyKcal.toFixed(3)} kcal/mol` : 'not reported'}</code></div>`}
            <div class="kv"><span>Converged</span><code>${esc(prepareConvergenceText(output))}</code></div>
            <div class="kv"><span>Iterations</span><code>${esc(output.iterations)}</code></div>
            ${output.limitation ? `<div class="kv"><span>Limit</span><code>${esc(output.limitation)}</code></div>` : ''}
          </div></div>`
        : '<div class="field full"><span class="inspector-note">Run the block to write <code>prepared.xyz</code>. A downstream calculate reads that file, not the geometry this block was planned with.</span></div>',
    ].join(''))}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="duplicate-node">Duplicate</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="run-workflow">Run workflow</button>
    <button type="button" class="btn" data-action="validate">Validate</button>
  </div>`;
}

function conformersInspector(node) {
  const s = node.settings || {};
  const output = node.output && typeof node.output === 'object' ? node.output : null;
  // Issue 226: what the block produces is the first decision, because it
  // decides whether any of the conformer knobs below even apply.
  const produces = s.produces === 'tautomers' ? 'tautomers' : 'conformers';
  const tautomersBlock = produces === 'tautomers';
  const selectedId = output?.selectedId || s.selectedConformerId || '';
  const members = Array.isArray(output?.members) ? output.members : [];
  const warnings = Array.isArray(output?.warnings) ? output.warnings : [];
  const warningBlock = warnings.length
    ? `<div class="code-block" style="margin-bottom:10px">${warnings.map((warning) => `<div>${warning.status === 'info' ? '·' : '⚠'} ${esc(warning.message)}</div>`).join('')}</div>`
    : '';
  const selected = output?.selected;
  const summaryLine = output
    ? (produces === 'tautomers'
      ? `${output.count} tautomer${output.count === 1 ? '' : 's'} enumerated${output.truncated ? ' · cap reached' : ''}`
      : `${output.count} of ${output.total} kept${Number.isFinite(output.spreadKcal) ? ` · spread ${output.spreadKcal.toFixed(2)} kcal/mol` : ''}`)
    : 'no ensemble yet';
  // Issues 129/130: the caption names the absolute energy unit and its
  // method, and the provenance line names what produced the ensemble.
  const caption = output ? conformerTableCaption(output) : '';
  const provenanceLine = output ? conformerOriginLabel(output) : '';
  // Issue 144: what an in-app UFF search did — grid, threshold, trials — and
  // what it is not. Empty for a CREST or imported ensemble.
  const searchLine = output ? conformerSearchNote(output) : '';
  // Issue 132: a block may belong to a study with other blocks. The id is
  // typed by hand; the count is read from the flow, and nothing here claims the
  // ensembles are the same molecule or that their energies are comparable.
  const groupId = s.group || '';
  const groupCount = conformerGroupCount(groupId);
  const groupLine = groupId
    ? conformerGroupLabel(groupId, { blocks: groupCount })
    : 'no group — this block stands alone';
  const groupInvalid = Boolean(groupId) && !isConformerGroupId(groupId);
  const groupBlock = group('Study group', groupId ? groupLine : 'optional', true, [
    `<div class="field full"><label>Group id</label><input class="input" data-conformer-field="group" value="${esc(groupId)}" placeholder="e.g. tautomer-study" maxlength="32"></div>`,
    groupInvalid
      ? `<div class="field full"><span class="inspector-note" data-conformer-group-error>Not a plain group id. Use 1–32 letters, digits, "." "_" or "-", starting with a letter or digit — or leave it empty.</span></div>`
      : '',
    `<div class="field full"><span class="inspector-note">Blocks that share an id belong to the same study. A group is not a protomer or tautomer judgement, and energies across protonation states are not comparable without a proton reference.</span></div>`,
  ].join(''));
  // ADR 0001: a generate block either searches or ranks the one ensemble input
  // wired into it. The inspector says which, and never offers a file picker of
  // its own: the input block owns the path, the unit and the provenance.
  const sourceKind = tautomersBlock ? 'search' : (s.source === 'imported' ? 'imported' : 'search');
  const upstream = incoming(node.id).find((entry) => entry.type === 'input' && entry.input?.kind === 'ensemble') || null;
  const upstreamOutput = upstream?.output && typeof upstream.output === 'object' ? upstream.output : null;
  const rows = members.length
    ? `<table class="batch-table">
        <thead><tr><th>Member</th><th>ΔE (kcal/mol)</th><th>Pop.</th><th>RMSD</th><th></th></tr></thead>
        <tbody>${members.map((member) => `<tr${member.kept ? '' : ' class="is-muted"'}>
          <td>${esc(member.id)}${member.tautomer ? ` · ${esc(member.tautomer)}` : ''}${member.protomer ? ` · ${esc(member.protomer)}` : ''}${member.smiles ? ` <span class="mono">${esc(member.smiles)}</span>` : ''}</td>
          <td>${formatRelativeKcal(member.relativeKcal)}</td>
          <td>${formatPopulation(member.population)}</td>
          <td>${Number.isFinite(member.rmsdToLowest) ? member.rmsdToLowest.toFixed(2) : '—'}</td>
          <td>${member.kept
            ? `<button type="button" class="btn small${member.id === selectedId ? ' primary' : ''}" data-action="select-conformer" data-conformer-id="${esc(member.id)}">${member.id === selectedId ? 'using' : 'use'}</button>`
            : `<span class="inspector-note">${esc(member.dropped || 'dropped')}</span>`}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<div class="inspector-note">No ensemble yet. ${tautomersBlock
      ? 'Run the block with the RDKit tautomer sidecar configured in the run console; there is no in-app enumerator.'
      : (s.source === 'imported'
        ? (upstream ? `Run the block to rank the ensemble from "${esc(upstream.title)}".` : 'Wire an ensemble input into this block first.')
        : (s.generator === 'uff'
          ? 'Run the block: the UFF search runs here and needs no external binary.'
          : (s.generator === 'obabel'
            ? 'Run the block with an Open Babel executable configured in the run console.'
            : 'Run the block with a CREST executable configured.')))}</div>`;

  return `${inspectorHead(tautomersBlock ? 'Generate · tautomers' : 'Generate · conformers', node.title, summaryLine)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${selected
      ? `using ${esc(selected.id)} · ${formatRelativeKcal(selected.relativeKcal)} kcal/mol · ${formatPopulation(selected.population)}`
      : 'no member chosen'}</span></div>
    ${provenanceLine ? `<div class="inspector-note" data-conformer-provenance>${esc(provenanceLine)}</div>` : ''}
    ${searchLine ? `<div class="inspector-note" data-conformer-search>${esc(searchLine)}</div>` : ''}
    ${groupId ? `<div class="inspector-note" data-conformer-group>${esc(groupLine)}</div>` : ''}
    ${warningBlock}
    ${group('Ensemble', output ? caption : summaryLine, true, [rows])}
    ${groupBlock}
    ${group('Source', tautomersBlock
      ? 'RDKit, external'
      : (sourceKind === 'imported'
        ? 'wired ensemble input'
        : (s.generator === 'crest'
          ? 'CREST'
          : (s.generator === 'uff' ? 'UFF, in-app' : 'Open Babel, external'))), true, [
      `<div class="field full"><label>Produces</label><select class="select" data-conformer-field="produces">
        <option value="conformers"${!tautomersBlock ? ' selected' : ''}>Conformers — geometries of one molecule</option>
        <option value="tautomers"${tautomersBlock ? ' selected' : ''}>Tautomers — distinct molecules of one formula</option>
      </select></div>`,
      ...(tautomersBlock ? [
        `<div class="field full"><span class="inspector-note" data-conformer-tautomer-note>Tautomer enumeration is a set of molecules, not geometries: no energy window, no RMSD prune and no Boltzmann population. Each candidate is planned as its own calculation, and the report shows the energy spread across them. pH-dependent protonation (Epik, Dimorphite-DL) is out of scope; charge and multiplicity are taken as given.</span></div>`,
        `<div class="field"><label>Ruleset</label><select class="select" data-conformer-field="tautomerRuleset">
          <option value="rdkit-default"${(s.tautomerRuleset || 'rdkit-default') === 'rdkit-default' ? ' selected' : ''}>rdkit-default (RDKit TautomerEnumerator)</option>
        </select></div>`,
        `<div class="field"><label>Max candidates</label><input class="input" type="number" min="1" max="200" data-conformer-field="maxConformers" value="${esc(s.maxConformers ?? 16)}"></div>`,
      ] : [
      `<div class="field full"><label>Candidate source</label><select class="select" data-conformer-field="source">
        <option value="search"${sourceKind === 'search' ? ' selected' : ''}>Search with a generator</option>
        <option value="imported"${sourceKind === 'imported' ? ' selected' : ''}>Rank a wired ensemble input</option>
      </select></div>`,
      `<div class="field full"><label>Rank by</label><select class="select" data-conformer-field="rankBy">
        <option value=""${!s.rankBy ? ' selected' : ''}>Energy from the source (xTB / MMFF94 / file)</option>
        ${Object.values(SCORER_MODELS).map((model) => `<option value="ml:${esc(model.id)}"${s.rankBy === `ml:${model.id}` ? ' selected' : ''}>${esc(model.label)} (ML scorer)</option>`).join('')}
      </select>${s.rankBy ? '<p class="field-hint">ML ranking needs the scorer sidecar configured in the run console. Its eV energies are converted explicitly; they are never presented as QM.</p>' : ''}</div>`,
      ...(sourceKind === 'imported' ? [
        upstream
          ? `<div class="field full"><div class="card">
              <div class="kv"><span>Input block</span><code>${esc(upstream.title)}</code></div>
              <div class="kv"><span>File</span><code>${esc(upstream.input?.path || '—')}</code></div>
              <div class="kv"><span>Energies</span><code>${esc((upstreamOutput?.energyUnit || upstream.input?.energyUnit) === 'kcal/mol' ? 'kcal/mol' : 'hartree')}${(upstreamOutput?.energyMethod || upstream.input?.energyMethod) ? ` · ${esc(upstreamOutput?.energyMethod || upstream.input?.energyMethod)}` : ''}</code></div>
              <div class="kv"><span>Produced by</span><code>${esc(upstreamOutput?.origin?.program || upstream.input?.origin?.program || 'not recorded')}${upstreamOutput?.sourceSha256 ? ` · sha256 ${esc(String(upstreamOutput.sourceSha256).slice(0, 12))}…` : ''}</code></div>
            </div></div>`
          : '<div class="field full"><div class="callout red"><strong>No ensemble input wired.</strong> Drag a dependency edge from an Ensemble input block into this one.</div></div>',
        `<div class="field full"><span class="inspector-note">Ranking is a generate-block job: the energy window, RMSD and protomer policy below act on the input's frames. The input block owns the path, the energy unit and the provenance, so this block never opens the file.</span></div>`,
      ] : [
        `<div class="field"><label>Generator</label><select class="select" data-conformer-field="generator">
          <option value="crest"${s.generator === 'crest' ? ' selected' : ''}>CREST (external)</option>
          <option value="uff"${s.generator === 'uff' ? ' selected' : ''}>UFF (in-app, no binary)</option>
          <option value="obabel"${s.generator === 'obabel' ? ' selected' : ''}>Open Babel (external, MMFF94)</option>
        </select></div>`,
        ...(s.generator === 'crest' ? [`<div class="field"><label>Method</label><select class="select" data-conformer-field="method">
            <option value="gfn2"${s.method === 'gfn2' ? ' selected' : ''}>GFN2-xTB</option>
            <option value="gfnff"${s.method === 'gfnff' ? ' selected' : ''}>GFN-FF</option>
          </select></div>`] : []),
        ...(s.generator === 'obabel' ? [
          // Issue 240: the force field is the block's `method`, the same value
          // the search writes as `--ff`. There is no second `ff` name.
          `<div class="field"><label>Force field (method)</label><select class="select" data-conformer-field="method">
            <option value="MMFF94"${s.method === undefined || s.method === 'MMFF94' || s.method === 'mmff94' ? ' selected' : ''}>MMFF94</option>
            <option value="MMFF94s"${s.method === 'MMFF94s' || s.method === 'mmff94s' ? ' selected' : ''}>MMFF94s (static)</option>
            <option value="UFF"${s.method === 'UFF' ? ' selected' : ''}>UFF</option>
          </select></div>`,
          `<div class="field"><label>Conformers (--nconf)</label><input class="input" type="number" min="1" max="1000" step="1" data-conformer-field="nconf" value="${esc(s.nconf ?? 20)}"></div>`,
          `<div class="field full"><span class="inspector-note" data-conformer-obabel-note>Open Babel runs as a separate program, like CREST: a genetic-algorithm search scored on the chosen force field, then one energy per conformer. Every member is a force-field structure in kcal/mol — not QM, and not Spartan's DLFF03 stage. MMFF94 covers H, C, N, O, F, Si, P, S, Cl, Br and I; an atom outside that list is refused by name, while UFF is parameterised across the periodic table. Open Babel 3.2.x crashes in its conformer search (--conformer); the queue refuses that series by version before spawning — install 3.1.x or use the in-app UFF search.</span></div>`,
        ] : []),
        ...(s.generator === 'uff' ? [
          `<div class="field"><label>Torsion grid</label><select class="select" data-conformer-field="torsionStepDegrees">
            <option value="60"${Number(s.torsionStepDegrees) === 60 ? ' selected' : ''}>60°</option>
            <option value="90"${Number(s.torsionStepDegrees) === 90 ? ' selected' : ''}>90°</option>
            <option value="120"${s.torsionStepDegrees === undefined || Number(s.torsionStepDegrees) === 120 ? ' selected' : ''}>120°</option>
            <option value="180"${Number(s.torsionStepDegrees) === 180 ? ' selected' : ''}>180°</option>
          </select></div>`,
          `<div class="field"><label>Max trials</label><input class="input" type="number" min="1" max="2000" step="1" data-conformer-field="maxTrials" value="${esc(s.maxTrials ?? 200)}"></div>`,
          `<div class="field full"><span class="inspector-note" data-conformer-uff-note>Torsional grid plus UFF relaxation, run in this app: not a Monte-Carlo or CREST search. Every member is a UFF force-field structure, and its kcal/mol energy is not comparable with a Hartree value. UFF here has no electrostatics term and does not sample ring conformers; a molecule with no rotatable bonds yields one relaxed structure.</span></div>`,
          ] : []),
        ]),
      ]),
      ...(tautomersBlock ? [] : [
        `<div class="field"><label>Energy window (kcal/mol)</label><input class="input" type="number" min="0" max="100" step="0.5" data-conformer-field="energyWindowKcal" value="${esc(s.energyWindowKcal)}"></div>`,
        `<div class="field"><label>RMSD threshold (Å)</label><input class="input" type="number" min="0.01" max="10" step="0.05" data-conformer-field="rmsdThreshold" value="${esc(s.rmsdThreshold)}"></div>`,
        `<div class="field"><label>Keep at most</label><input class="input" type="number" min="1" max="200" data-conformer-field="maxConformers" value="${esc(s.maxConformers)}"></div>`,
        `<div class="field"><label>Temperature (K)</label><input class="input" type="number" min="1" max="1000" step="0.15" data-conformer-field="temperature" value="${esc(s.temperature)}"></div>`,
        `<div class="field"><label>Spread warning (kcal/mol)</label><input class="input" type="number" min="0" max="50" step="0.5" data-conformer-field="spreadThresholdKcal" value="${esc(s.spreadThresholdKcal)}"></div>`,
      ]),
      `<div class="field"><label>Charge</label><input class="input" type="number" min="-10" max="10" data-conformer-field="charge" value="${esc(s.charge)}"></div>`,
      `<div class="field"><label>Multiplicity</label><input class="input" type="number" min="1" max="10" data-conformer-field="multiplicity" value="${esc(s.multiplicity)}"></div>`,
      // Issue #80: one task per retained member instead of one chosen geometry.
      // Issue 226: a tautomer block defaults to on, because one candidate's run
      // says nothing about the other molecules in the set.
      switchRow('Fan out the ensemble', tautomersBlock
        ? 'one task per tautomer candidate downstream (recommended)'
        : 'one task per retained member downstream', 'fanOut', tautomersBlock ? s.fanOut !== false : s.fanOut === true, { attr: 'data-conformer-field="fanOut"' }),
    ].join(''))}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="validate">Validate project</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="run-workflow">Run workflow</button>
    <button type="button" class="btn" data-action="validate">Validate</button>
  </div>`;
}

function datasetTitleFromFilename(filename, count) {
  const base = String(filename || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim() || 'Dataset';
  return `${base.slice(0, 130)} (${count})`;
}

/** A project-relative source path: no separators that a browser file lacks. */
function datasetSourcePath(filename) {
  return String(filename || '')
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((segment) => segment && segment !== '..')
    .join('/')
    .slice(0, 300);
}

function importDatasetText(text, { filename = '', format = '', nodeId = null } = {}) {
  const node = nodeId ? nodeById(nodeId) : null;
  if (!node || node.type !== 'input') return null;
  const result = parseDataset(text, { filename, format });
  if (result.records.length === 0) {
    toast(`Could not import dataset: ${result.errors[0] || 'no record with coordinates was found.'}`);
    return null;
  }
  if (!node.input || typeof node.input !== 'object') {
    node.input = { datasetId: '', recordFilter: { field: '', equals: '' } };
  }
  if (!Array.isArray(state.project.datasets)) state.project.datasets = [];
  const source = {
    kind: filename ? 'file' : 'inline',
    path: filename ? datasetSourcePath(filename) : '',
    format: result.format,
  };
  const title = datasetTitleFromFilename(filename || 'Pasted dataset', result.records.length);
  let dataset = datasetById(state.project, node.input.datasetId);
  const replaced = Boolean(dataset);
  if (dataset) {
    dataset.title = title;
    dataset.source = source;
    dataset.records = result.records;
  } else {
    const base = String(filename || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'dataset';
    dataset = {
      id: uniqueGraphId(slugifyGraphId(base, 'dataset'), state.project.datasets.map((entry) => entry.id)),
      title,
      source,
      fields: { label: '', charge: '', multiplicity: '' },
      records: result.records,
      notes: '',
    };
    state.project.datasets.push(dataset);
  }
  node.input.datasetId = dataset.id;
  if (!node.title || node.title === 'Dataset input') node.title = title;
  renderGraph();
  renderInspector();
  const skipped = result.errors.length ? ` · ${result.errors.length} record(s) skipped` : '';
  const warnings = result.warnings.length ? ` · ${result.warnings.length} warning(s)` : '';
  // Issue 139: a CDXML import is a set of drawings, and the run gate will ask
  // before a frequency or single point uses one. Say so at the moment of import
  // rather than after the flow is queued.
  const drawings = result.records.filter((record) => record.geometry?.dimension === '2d').length;
  const drawingNote = drawings
    ? ` · ${drawings} 2D drawing${drawings === 1 ? '' : 's'} (a depiction, not a geometry)`
    : '';
  toast(`${replaced ? 'Replaced' : 'Imported'} ${result.records.length} record${result.records.length === 1 ? '' : 's'}`
    + ` from ${filename || 'pasted text'}${drawingNote}${skipped}${warnings}.`);
  return dataset;
}

async function importDatasetFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    importDatasetText(text, {
      filename: file.name,
      nodeId: state.datasetImportNodeId || (state.selected.type === 'node' ? state.selected.id : null),
    });
  } catch (error) {
    toast(`Could not read the dataset file: ${error.message}`);
  }
}

/**
 * Issue 169: switch a structure block between a plain dataset and a series.
 *
 * The starting point is visible, never silent: the record's first two atoms as
 * donor and acceptor, a 1.5 Å junction bond, no leaving groups. All of them are
 * fields in the inspector and the preview shows immediately whether that
 * linkage builds — the atoms that actually leave are a chemistry decision the
 * app cannot make for the user.
 */
function enableSeries() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input') return;
  if (!node.input) node.input = { datasetId: '', recordFilter: { field: '', equals: '' } };
  const dataset = datasetForInputNode(node);
  const unit = dataset ? recordsOf(dataset).find((record) => record.enabled !== false) || null : null;
  if (!unit) {
    toast('Bind a dataset with at least one enabled record before making it a series.');
    return;
  }
  const atomCount = Array.isArray(unit.coords) ? unit.coords.length : 0;
  // A block is one kind of structure block: turning it into a series drops an
  // edit list, which the schema refuses beside a series definition.
  delete node.input.edits;
  node.input.recordId = unit.id;
  node.input.series = {
    from: 1,
    to: 3,
    linkage: {
      donor: 1,
      acceptor: atomCount >= 2 ? 2 : 1,
      bondLengthAngstrom: 1.5,
      leaving: [],
    },
  };
  node.kind = 'series';
  renderGraph();
  renderInspector();
  toast(`Series from "${unit.label || unit.id}" · name the donor, acceptor and leaving atoms.`);
}

/** Back to a plain dataset block: the series definition is dropped, nothing else. */
function disableSeries() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input') return;
  if (node.input) {
    delete node.input.series;
    delete node.input.recordId;
  }
  node.kind = 'Input';
  renderGraph();
  renderInspector();
}

/**
 * One series field, with the type the schema expects: counts and indices are
 * integers, the bond length is a number, and the leaving list is written as
 * `9, 10` (the way the user reads the geometry).
 */
function updateSeriesField(node, field, rawValue) {
  const series = node.input?.series;
  if (!series) return;
  const linkage = series.linkage || (series.linkage = {});
  const value = String(rawValue ?? '').trim();
  if (field === 'recordId') {
    node.input.recordId = value;
    return;
  }
  if (field === 'leaving') {
    linkage.leaving = value === ''
      ? []
      : value.split(/[\s,;]+/).filter(Boolean)
        .map((part) => Number(part))
        .filter((index) => Number.isInteger(index) && index >= 1);
    return;
  }
  if (field === 'from' || field === 'to' || field === 'donor' || field === 'acceptor') {
    if (field === 'from' || field === 'to') series[field] = value === '' ? 0 : Number(value);
    else linkage[field] = value === '' ? 0 : Number(value);
    return;
  }
  if (field === 'bondLengthAngstrom') {
    linkage.bondLengthAngstrom = value === '' ? 0 : Number(value);
  }
}

function seriesLinkageDistance(node, dataset) {
  const series = node?.input?.series;
  const unit = series && dataset
    ? recordsOf(dataset).find((record) => record.id === String(node.input.recordId || ''))
      || (recordsOf(dataset).length === 1 ? recordsOf(dataset)[0] : null)
    : null;
  if (!unit || !Array.isArray(unit.coords)) return null;
  const donor = unit.coords[Number(series.linkage?.donor) - 1];
  const acceptor = unit.coords[Number(series.linkage?.acceptor) - 1];
  if (!donor || !acceptor) return null;
  return atomDistance(donor, acceptor);
}

/**
 * Issue 169: the series half of the input inspector.
 *
 * The numbers are the ones the plan will use: the member list is the expansion
 * itself, and a refusal is shown verbatim instead of a plausible-looking
 * preview. The geometry note is not decoration — it is the honest status of
 * what the app produces.
 */
function seriesCard(node, dataset) {
  const series = node.input?.series;
  if (!series) {
    return `<div class="field full">
      <button type="button" class="btn small" data-action="series-enable"${dataset ? '' : ' disabled'}>Repeat this record as a series…</button>
      <p class="field-hint">A series block takes one record as the repeat unit, joins copy i to copy i+1 with one bond, and yields n = 1 … N records. Every downstream block runs once per member, unchanged.</p>
    </div>`;
  }
  const linkage = series.linkage || {};
  const preview = seriesPreview(node, dataset);
  const distance = seriesLinkageDistance(node, dataset);
  const unitOptions = recordsOf(dataset)
    .filter((record) => record.enabled !== false)
    .map((record) => `<option value="${esc(record.id)}"${String(record.id) === String(node.input.recordId || '') ? ' selected' : ''}>${esc(record.label || record.id)} · ${(record.coords || []).length} atoms</option>`)
    .join('');
  const rows = preview.records.map((record) => `
    <tr>
      <td><span class="record-label">${esc(record.label)}</span><span class="record-id">${esc(record.id)}</span></td>
      <td class="mono">${esc(formulaOf(record.coords))}</td>
      <td class="num">${record.coords.length}</td>
      <td class="num">${record.bonds?.length ?? 0}</td>
    </tr>`).join('');
  return `
    <div class="field full"><label>Repeat unit</label>
      <select class="select" data-series-field="recordId" aria-label="Repeat unit">${unitOptions || '<option value="">— no enabled record —</option>'}</select>
    </div>
    <div class="field"><label>from n</label>
      <input class="input" type="number" min="1" step="1" value="${esc(series.from)}" data-series-field="from" aria-label="from n">
    </div>
    <div class="field"><label>to n</label>
      <input class="input" type="number" min="1" step="1" max="${SERIES_MAX_MEMBERS}" value="${esc(series.to)}" data-series-field="to" aria-label="to n">
    </div>
    <div class="field"><label>Donor atom</label>
      <input class="input" type="number" min="1" step="1" value="${esc(linkage.donor ?? 1)}" data-series-field="donor" aria-label="Donor atom">
    </div>
    <div class="field"><label>Acceptor atom</label>
      <input class="input" type="number" min="1" step="1" value="${esc(linkage.acceptor ?? 2)}" data-series-field="acceptor" aria-label="Acceptor atom">
    </div>
    <div class="field"><label>Junction bond (Å)</label>
      <input class="input" type="number" min="0.5" max="4" step="0.01" value="${esc(linkage.bondLengthAngstrom ?? 1.5)}" data-series-field="bondLengthAngstrom" aria-label="Junction bond length in Angstrom">
    </div>
    <div class="field"><label>Leaving atoms</label>
      <input class="input" type="text" value="${esc((linkage.leaving || []).join(', '))}" data-series-field="leaving" aria-label="Leaving atoms" placeholder="9, 10">
    </div>
    <div class="field full"><label>Members</label>
      ${preview.error
    ? `<div class="callout red"><strong>Refused.</strong> ${esc(preview.error)}</div>`
    : (rows
      ? `<div class="dataset-table-wrap"><table class="dataset-table">
           <thead><tr><th>Member</th><th>Formula</th><th>Atoms</th><th>Bonds</th></tr></thead>
           <tbody>${rows}</tbody>
         </table></div>`
      : '<p class="field-hint">No member can be built from this unit yet.</p>')}
    </div>
    <div class="field full">
      <div class="callout"><strong>Starting point, not a minimum.</strong>
        Each copy is the unit's own coordinates moved along the donor → acceptor axis, so every bond inside a copy is the unit's and the new junction bond is exactly ${esc(Number(linkage.bondLengthAngstrom ?? 0).toFixed(2))} Å${distance === null ? '' : ` (the unit's donor → acceptor distance is ${distance.toFixed(2)} Å)`}.
        ${esc(SERIES_TERMINAL_RULE)}
        Optimise a member before reading any energy from it.</div>
      <p class="field-hint">One single bond (order ${SERIES_LINKAGE_ORDER}) joins acceptor(i) to donor(i+1). Atoms are 1-based, as written in the unit's geometry. Up to ${SERIES_MAX_MEMBERS} members.</p>
      <button type="button" class="btn small" data-action="series-disable">Use the dataset without a series</button>
    </div>`;
}

const COMPLEX_MODE_LABELS = Object.freeze({
  'as-drawn': 'As drawn',
  axis: 'Along an axis',
  principal: "Along member 1's principal axis",
});

/**
 * Issue 188: switch a structure block between a plain dataset and a complex.
 *
 * The starting point is visible, never silent: the first two enabled records as
 * members, placed 3.0 Å apart along x. The preview judges that placement
 * immediately, and the card states that the result is a starting geometry.
 */
function enableComplex() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input') return;
  if (!node.input) node.input = { datasetId: '', recordFilter: { field: '', equals: '' } };
  const dataset = datasetForInputNode(node);
  const enabled = dataset ? recordsOf(dataset).filter((record) => record.enabled !== false) : [];
  if (enabled.length < 2) {
    toast('Bind a dataset with at least two enabled records before building a complex.');
    return;
  }
  // A block is one kind of structure block: a complex drops a series definition
  // and an edit list, which the schema refuses beside it.
  delete node.input.series;
  delete node.input.edits;
  delete node.input.recordId;
  node.input.complex = {
    members: [enabled[0], enabled[1]].map((record) => ({ datasetId: dataset.id, recordId: record.id })),
    placement: { mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 },
  };
  node.kind = 'complex';
  renderGraph();
  renderInspector();
  toast(`Complex from "${enabled[0].label || enabled[0].id}" and "${enabled[1].label || enabled[1].id}" · choose the placement.`);
}

/** Back to a plain dataset block: the complex definition is dropped, nothing else. */
function disableComplex() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input') return;
  if (node.input) delete node.input.complex;
  node.kind = 'Input';
  renderGraph();
  renderInspector();
}

/**
 * One complex member: the value is `datasetId::recordId`, because a member may
 * name a record of another dataset and the id alone would be ambiguous.
 */
function updateComplexMember(node, index, rawValue) {
  const members = node.input?.complex?.members;
  if (!Array.isArray(members) || !members[index]) return;
  const [datasetId, recordId] = String(rawValue ?? '').split('::');
  if (!datasetId || !recordId) return;
  members[index] = { datasetId, recordId };
}

/** One membership row; a member of another dataset is shown by its dataset title. */
function addComplexMember() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  const definition = node?.input?.complex;
  if (!node || !definition || !Array.isArray(definition.members)) return;
  if (definition.members.length >= COMPLEX_MAX_MEMBERS) {
    toast(`A complex holds at most ${COMPLEX_MAX_MEMBERS} members.`);
    return;
  }
  const dataset = datasetForInputNode(node);
  const first = dataset ? recordsOf(dataset).find((record) => record.enabled !== false) : null;
  if (!first) {
    toast('No enabled record is available to add as a member.');
    return;
  }
  definition.members.push({ datasetId: dataset.id, recordId: first.id });
  renderGraph();
  renderInspector();
}

/** A complex needs at least two members; the last two cannot be removed. */
function removeComplexMember(index) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  const members = node?.input?.complex?.members;
  if (!Array.isArray(members) || index < 0 || index >= members.length) return;
  if (members.length <= 2) {
    toast('A complex needs at least two members. Turn the block back into a dataset instead.');
    return;
  }
  members.splice(index, 1);
  renderGraph();
  renderInspector();
}

/**
 * One placement field, with the type the schema expects. Switching the mode
 * fills only the parameters that mode reads, and `as-drawn` drops the rest so
 * the saved definition says exactly what the placement is.
 */
function updateComplexField(node, field, rawValue, checked = undefined) {
  const definition = node?.input?.complex;
  if (!definition) return;
  const placement = definition.placement || (definition.placement = { mode: 'as-drawn' });
  const value = String(rawValue ?? '').trim();
  if (field === 'mode') {
    placement.mode = value;
    if (value === 'axis') {
      if (!Array.isArray(placement.axis) || placement.axis.length !== 3) placement.axis = [1, 0, 0];
      if (!Number.isFinite(Number(placement.angleDegrees))) placement.angleDegrees = 0;
    }
    if (value === 'as-drawn') {
      delete placement.distanceAngstrom;
      delete placement.angleDegrees;
    } else if (!(Number(placement.distanceAngstrom) > 0)) {
      placement.distanceAngstrom = 3;
    }
    return;
  }
  if (field === 'homodimer') {
    if (checked) definition.homodimer = true;
    else delete definition.homodimer;
    return;
  }
  if (field === 'axis0' || field === 'axis1' || field === 'axis2') {
    const axis = Array.isArray(placement.axis) && placement.axis.length === 3 ? placement.axis.slice() : [1, 0, 0];
    axis[Number(field.slice(-1))] = value === '' ? 0 : Number(value);
    placement.axis = axis;
    return;
  }
  if (field === 'distanceAngstrom') {
    placement.distanceAngstrom = value === '' ? 0 : Number(value);
    return;
  }
  if (field === 'angleDegrees') placement.angleDegrees = value === '' ? 0 : Number(value);
}

/**
 * Issue 188: the complex half of the input inspector.
 *
 * The member pickers are the block's own definition, the preview is the
 * expansion itself — the same call the plan makes — and a refusal is shown
 * verbatim. The geometry note is not decoration: it is the honest status of
 * what the block produces.
 */
function complexCard(node, dataset) {
  const definition = node.input?.complex;
  if (!definition) {
    return `<div class="field full">
      <button type="button" class="btn small" data-action="complex-enable"${dataset ? '' : ' disabled'}>Combine records into a complex…</button>
      <p class="field-hint">A complex block places two or more records as rigid bodies and labels each member's atoms with its fragment number, so a SAPT0 block consumes the result with no manual labelling. It yields one record; every downstream block runs once on it.</p>
    </div>`;
  }
  const placement = definition.placement || {};
  const preview = complexPreview(node, dataset);
  const members = Array.isArray(definition.members) ? definition.members : [];
  const datasets = Array.isArray(state.project.datasets) ? state.project.datasets : [];
  const memberFields = members.map((member, index) => {
    const current = `${String(member.datasetId || dataset?.id || '')}::${String(member.recordId || '')}`;
    const groups = datasets.map((entry) => {
      const records = recordsOf(entry).filter((record) => record.enabled !== false);
      if (!records.length) return '';
      return `<optgroup label="${esc(entry.title || entry.id)}">${records.map((record) => {
        const value = `${entry.id}::${record.id}`;
        return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(record.label || record.id)} · ${(record.coords || []).length} atoms</option>`;
      }).join('')}</optgroup>`;
    }).join('');
    return `<div class="field full"><label>Member ${index + 1} · fragment ${index + 1}</label>
      <select class="select" data-complex-member="${index}" aria-label="Member ${index + 1} record">${groups || '<option value="">— no enabled record —</option>'}</select>
      <button type="button" class="btn small danger" data-action="complex-remove-member" data-complex-index="${index}"${members.length <= 2 ? ' disabled' : ''}>Remove member ${index + 1}</button>
    </div>`;
  }).join('');
  const record = preview.records[0] || null;
  let offset = 0;
  const fragmentRows = record
    ? record.complex.members.map((entry) => {
      const first = offset + 1;
      const last = offset + entry.atomCount;
      offset = last;
      return `<tr>
        <td class="num">${entry.fragment}</td>
        <td><span class="record-label">${esc(entry.label)}</span><span class="record-id">${esc(entry.id)}</span></td>
        <td class="mono">${first === last ? `${first}` : `${first}–${last}`}</td>
        <td class="num">${entry.atomCount}</td>
      </tr>`;
    }).join('')
    : '';
  const mode = COMPLEX_PLACEMENT_MODES.includes(placement.mode) ? placement.mode : 'as-drawn';
  const axis = Array.isArray(placement.axis) && placement.axis.length === 3 ? placement.axis : [1, 0, 0];
  const distance = Number(placement.distanceAngstrom);
  return `
    ${memberFields}
    <div class="field full">
      <button type="button" class="btn small" data-action="complex-add-member"${members.length >= COMPLEX_MAX_MEMBERS ? ' disabled' : ''}>Add a member</button>
      <p class="field-hint">At most ${COMPLEX_MAX_MEMBERS} members. A member may come from another dataset of this project. Atoms are labelled fragment 1, 2, … in the order the members are listed.</p>
    </div>
    <div class="field full"><label>Placement</label>
      <select class="select" data-complex-field="mode" aria-label="Placement mode">
        ${COMPLEX_PLACEMENT_MODES.map((value) => `<option value="${value}"${mode === value ? ' selected' : ''}>${esc(COMPLEX_MODE_LABELS[value] || value)}</option>`).join('')}
      </select>
    </div>
    ${mode === 'axis' ? `
    <div class="field"><label>x</label>
      <input class="input" type="number" step="0.01" value="${esc(axis[0])}" data-complex-field="axis0" aria-label="Axis x">
    </div>
    <div class="field"><label>y</label>
      <input class="input" type="number" step="0.01" value="${esc(axis[1])}" data-complex-field="axis1" aria-label="Axis y">
    </div>
    <div class="field"><label>z</label>
      <input class="input" type="number" step="0.01" value="${esc(axis[2])}" data-complex-field="axis2" aria-label="Axis z">
    </div>` : ''}
    ${mode === 'as-drawn' ? '' : `
    <div class="field"><label>Separation (Å)</label>
      <input class="input" type="number" min="0.1" step="0.01" value="${esc(Number.isFinite(distance) ? distance : 3)}" data-complex-field="distanceAngstrom" aria-label="Centre of mass separation in Angstrom">
    </div>`}
    ${mode === 'axis' ? `
    <div class="field"><label>Angle (°)</label>
      <input class="input" type="number" min="-360" max="360" step="1" value="${esc(Number.isFinite(Number(placement.angleDegrees)) ? placement.angleDegrees : 0)}" data-complex-field="angleDegrees" aria-label="Rotation about the axis in degrees">
    </div>` : ''}
    ${switchRow('Homodimer', 'the same record twice', 'homodimer', definition.homodimer === true, { attr: 'data-complex-field="homodimer"' })}
    <div class="field full"><label>System this block will queue</label>
      ${preview.error
    ? `<div class="callout red"><strong>Refused.</strong> ${esc(preview.error)}</div>`
    : (record
      ? `<div class="kv"><span>Record</span><code>${esc(record.id)}</code></div>
         <div class="kv"><span>Atoms</span><code>${record.coords.length} · charge ${record.charge} · multiplicity ${record.multiplicity}</code></div>
         <div class="dataset-table-wrap"><table class="dataset-table">
           <thead><tr><th>Fragment</th><th>Member</th><th>Atoms</th><th>Count</th></tr></thead>
           <tbody>${fragmentRows}</tbody>
         </table></div>`
      : '<p class="field-hint">No complex can be built from these members yet.</p>')}
    </div>
    <div class="field full">
      <div class="callout"><strong>${esc(COMPLEX_GEOMETRY_STATUS)}.</strong> ${esc(COMPLEX_GEOMETRY_NOTE)}</div>
      <p class="field-hint">${esc(COMPLEX_MODE_LABELS[mode] || mode)}${mode === 'axis'
    ? `: the members' centres of mass are ${Number.isFinite(distance) ? distance.toFixed(2) : '?'} Å apart along the axis, and every member after the first is turned by the stated angle about it.`
    : mode === 'principal'
      ? `: the members' centres of mass lie ${Number.isFinite(distance) ? distance.toFixed(2) : '?'} Å apart along member 1's smallest principal axis of inertia; member 2 keeps its drawn orientation.`
      : ': every member keeps the coordinates it was drawn or imported with.'}</p>
      <button type="button" class="btn small" data-action="complex-disable">Use the dataset without a complex</button>
    </div>`;
}

/**
 * Issue 189: switch a structure block between a plain dataset and a derivative
 * scan.
 *
 * The first edit is a starting point the preview judges immediately: the first
 * hydrogen (or atom 1) replaced by F. Whether that parent has a topology to
 * check is not decided here — if the record states no bonds the card says so in
 * the engine's own words instead of queueing a guessed structure.
 */
function defaultDerivativeEdit(unit) {
  const atoms = Array.isArray(unit?.coords) ? unit.coords : [];
  const hydrogen = atoms.findIndex((atom) => String(atom?.element) === 'H');
  return { op: 'substitute', atom: hydrogen >= 0 ? hydrogen + 1 : 1, element: 'F' };
}

function enableDerivative() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input') return;
  if (!node.input) node.input = { datasetId: '', recordFilter: { field: '', equals: '' } };
  const dataset = datasetForInputNode(node);
  const unit = dataset ? recordsOf(dataset).find((record) => record.enabled !== false) || null : null;
  if (!unit) {
    toast('Bind a dataset with at least one enabled record before deriving from it.');
    return;
  }
  delete node.input.series;
  const enabled = recordsOf(dataset).filter((record) => record.enabled !== false);
  // One parent or all of them: a scan over a whole dataset is well defined, and
  // the select says which it will be.
  node.input.recordId = enabled.length === 1 ? unit.id : '';
  node.input.edits = [defaultDerivativeEdit(unit)];
  node.kind = 'derivative';
  renderGraph();
  renderInspector();
  toast(`Derivative of "${unit.label || unit.id}" · name the op and the atom. The geometry is a starting point, not a minimum.`);
}

/** Back to a plain dataset block: the edit list is dropped, nothing else. */
function disableDerivative() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input') return;
  if (node.input) {
    delete node.input.edits;
    delete node.input.recordId;
  }
  node.kind = 'Input';
  renderGraph();
  renderInspector();
}

/** One more edit: a full valence here is refused by the preview, not guessed. */
function addDerivativeEdit() {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input' || !Array.isArray(node.input?.edits)) return;
  if (node.input.edits.length >= DERIVATIVE_MAX_EDITS) {
    toast(`An edit list holds at most ${DERIVATIVE_MAX_EDITS} edits.`);
    return;
  }
  const dataset = datasetForInputNode(node);
  const unit = dataset
    ? recordsOf(dataset).find((record) => String(record.id) === String(node.input.recordId || ''))
      || recordsOf(dataset).find((record) => record.enabled !== false) || null
    : null;
  node.input.edits.push(defaultDerivativeEdit(unit));
  renderGraph();
  renderInspector();
}

/** Drop one edit; the last one turns the block back into a plain dataset. */
function removeDerivativeEdit(index) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input' || !Array.isArray(node.input?.edits)) return;
  if (index < 0 || index >= node.input.edits.length) return;
  node.input.edits.splice(index, 1);
  if (node.input.edits.length === 0) {
    disableDerivative();
    return;
  }
  renderGraph();
  renderInspector();
}

/**
 * A derivative field, with the type the schema expects: the parent is a record
 * id, the atom an integer, the element a symbol, and mass/charge/multiplicity
 * are integers that are dropped when the field is cleared — never defaulted,
 * because `protonate`/`deprotonate` refuse an unstated spin state.
 */
function updateDerivativeField(node, index, field, rawValue) {
  if (!node.input) return;
  const value = String(rawValue ?? '').trim();
  if (field === 'parent') {
    if (value) node.input.recordId = value;
    else delete node.input.recordId;
    return;
  }
  const edit = Array.isArray(node.input.edits) ? node.input.edits[index] : null;
  if (!edit) return;
  if (field === 'op') {
    edit.op = value;
    return;
  }
  if (field === 'element') {
    if (value) edit.element = value;
    else delete edit.element;
    return;
  }
  const numericField = field === 'atom' || field === 'mass' || field === 'charge' || field === 'multiplicity';
  if (!numericField) return;
  if (value === '') {
    if (field === 'atom') edit.atom = 0;
    else delete edit[field];
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  edit[field] = number;
}

const DERIVATIVE_OP_LABELS = Object.freeze({
  substitute: 'Substitute',
  add: 'Add atom',
  remove: 'Remove atom',
  isotope: 'Isotope',
  protonate: 'Protonate',
  deprotonate: 'Deprotonate',
});

/** The argument columns an op actually reads; the rest are shown greyed out. */
const DERIVATIVE_OP_FIELDS = Object.freeze({
  substitute: ['element'],
  add: ['element'],
  remove: [],
  isotope: ['mass'],
  protonate: ['charge', 'multiplicity'],
  deprotonate: ['charge', 'multiplicity'],
});

function derivativeRow(edit, index) {
  const fields = DERIVATIVE_OP_FIELDS[edit.op] || [];
  const numberInput = (field, { min, max, step = 1 }) => {
    const value = edit[field] === undefined || edit[field] === null ? '' : edit[field];
    const off = fields.includes(field) ? '' : ' disabled';
    return `<input class="input" type="number" min="${min}" max="${max ?? ''}" step="${step}" value="${esc(value)}"${off}
      data-derivative-edit="${index}" data-derivative-field="${field}" aria-label="${field} of edit ${index + 1}" placeholder="—">`;
  };
  return `
    <tr>
      <td><select class="select" data-derivative-edit="${index}" data-derivative-field="op" aria-label="op of edit ${index + 1}">
        ${DERIVATIVE_OPS.map((op) => `<option value="${op}"${op === edit.op ? ' selected' : ''}>${DERIVATIVE_OP_LABELS[op]}</option>`).join('')}
      </select></td>
      <td><input class="input" type="number" min="1" step="1" value="${esc(edit.atom ?? '')}" data-derivative-edit="${index}" data-derivative-field="atom" aria-label="atom of edit ${index + 1}"></td>
      <td><input class="input" type="text" maxlength="3" value="${esc(edit.element ?? '')}"${fields.includes('element') ? '' : ' disabled'} data-derivative-edit="${index}" data-derivative-field="element" aria-label="element of edit ${index + 1}" placeholder="F"></td>
      <td>${numberInput('mass', { min: 1, max: 400 })}</td>
      <td>${numberInput('charge', { min: -10, max: 10 })}</td>
      <td>${numberInput('multiplicity', { min: 1, max: 10 })}</td>
      <td><button type="button" class="btn small danger" data-action="derivative-remove-edit" data-derivative-index="${index}" aria-label="Remove edit ${index + 1}">×</button></td>
    </tr>`;
}

/**
 * Issue 189: the derivative half of the input inspector.
 *
 * The rows are the block's own edit list, the preview is the expansion itself,
 * and a refusal is shown verbatim. The geometry note is not decoration: it is
 * the honest status of what the block produces.
 */
function derivativeCard(node, dataset) {
  const edits = Array.isArray(node.input?.edits) ? node.input.edits : [];
  if (edits.length === 0) {
    return `<div class="field full">
      <button type="button" class="btn small" data-action="derivative-enable"${dataset ? '' : ' disabled'}>Derive a related structure…</button>
      <p class="field-hint">A derivative block applies one atom-level edit to a parent record — substitute an atom, add or remove one, or change an isotope — and yields one record per edit. Every downstream block runs once per edit, unchanged.</p>
    </div>`;
  }
  const preview = derivativePreview(node, dataset);
  const parentOptions = recordsOf(dataset)
    .filter((record) => record.enabled !== false)
    .map((record) => `<option value="${esc(record.id)}"${String(record.id) === String(node.input.recordId || '') ? ' selected' : ''}>${esc(record.label || record.id)} · ${(record.coords || []).length} atoms${Array.isArray(record.bonds) ? ` · ${record.bonds.length} bonds` : ' · no bonds'}</option>`)
    .join('');
  const rows = preview.records.map((record) => `
    <tr>
      <td><span class="record-label">${esc(record.label)}</span><span class="record-id">${esc(record.id)}</span></td>
      <td class="mono">${esc(record.derivative?.formula || formulaOf(record.coords))}</td>
      <td class="num">${record.coords.length}</td>
      <td class="num">${record.bonds?.length ?? 0}</td>
    </tr>`).join('');
  return `
    <div class="field full"><label>Parent record</label>
      <select class="select" data-derivative-field="parent" aria-label="Parent record">
        <option value=""${node.input.recordId ? '' : ' selected'}>— every enabled record —</option>
        ${parentOptions || '<option value="">— no enabled record —</option>'}
      </select>
    </div>
    <div class="field full"><label>Edits</label>
      <div class="dataset-table-wrap"><table class="dataset-table">
        <thead><tr><th>Op</th><th>Atom</th><th>Element</th><th>Mass</th><th>Charge</th><th>Mult</th><th></th></tr></thead>
        <tbody>${edits.map((edit, index) => derivativeRow(edit, index)).join('')}</tbody>
      </table></div>
      <p class="field-hint">Atoms are 1-based, as written in the parent's geometry. Each row is its own record: the edits do not chain. ${edits.length} of ${DERIVATIVE_MAX_EDITS} used.</p>
      <button type="button" class="btn small" data-action="derivative-add-edit">Add an edit</button>
    </div>
    <div class="field full"><label>Records this block will queue</label>
      ${preview.error
    ? `<div class="callout red"><strong>Refused.</strong> ${esc(preview.error)}</div>`
    : (rows
      ? `<div class="dataset-table-wrap"><table class="dataset-table">
           <thead><tr><th>Derivative</th><th>Formula</th><th>Atoms</th><th>Bonds</th></tr></thead>
           <tbody>${rows}</tbody>
         </table></div>`
      : '<p class="field-hint">No derivative can be built from this parent yet.</p>')}
    </div>
    <div class="field full">
      <div class="callout"><strong>${esc(GEOMETRY_STATUS)}.</strong> ${esc(GEOMETRY_NOTE)}
        The edited atom keeps the direction of the bond it replaces, at the sum of the two tabulated covalent radii; every other atom keeps its coordinates to the last bit.</div>
      <p class="field-hint">A parent record must state its bonds: a valence check or a bond direction built on a perceived topology would be a guess, so a record without bonds is refused by name.</p>
      <button type="button" class="btn small" data-action="derivative-disable">Use the dataset without a derivative</button>
    </div>`;
}

function ensembleInputInspector(node) {
  const input = node.input || {};
  const output = node.output && typeof node.output === 'object' ? node.output : null;
  const fileLabel = input.path ? String(input.path).split(/[\\/]/).pop() : 'no file chosen';
  const digest = output?.sourceSha256 || input.sourceSha256 || '';
  const origin = output?.origin || input.origin || {};
  return `${inspectorHead('Data · input', node.title,
    output ? `${output.frameCount} frame${output.frameCount === 1 ? '' : 's'} · ${output.energyUnit}` : fileLabel)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">Runs once, before the generate block that ranks it</span></div>
    ${group('Ensemble file', input.path ? fileLabel : 'required', true, [
      `<div class="field full"><label>File</label>
        <div style="display:flex;gap:6px">
          <input class="input" data-ensemble-field="path" value="${esc(input.path || '')}" placeholder="path/to/conformers.xyz" spellcheck="false">
          <button type="button" class="btn small" data-action="pick-ensemble">Choose…</button>
        </div>
        <p class="field-hint">One or more XYZ frames. Relative paths resolve against the project file.</p>
      </div>`,
      `<div class="field"><label>Format</label><select class="select" data-ensemble-field="format">
        <option value="xyz"${input.format !== 'xyz' ? '' : ' selected'}>Multi-XYZ</option>
      </select></div>`,
      `<div class="field"><label>Energies are in</label><select class="select" data-ensemble-field="energyUnit">
        <option value="hartree"${input.energyUnit !== 'kcal/mol' ? ' selected' : ''}>Hartree</option>
        <option value="kcal/mol"${input.energyUnit === 'kcal/mol' ? ' selected' : ''}>kcal/mol</option>
      </select></div>`,
      `<div class="field"><label>Energy method</label><input class="input" data-ensemble-field="energyMethod" value="${esc(input.energyMethod || '')}" placeholder="MMFF94" maxlength="40"></div>`,
      `<div class="field"><label>Produced by</label><input class="input" data-ensemble-field="originProgram" value="${esc(origin.program || '')}" placeholder="program name" maxlength="40"></div>`,
      `<div class="field"><label>Program version</label><input class="input" data-ensemble-field="originVersion" value="${esc(origin.version || '')}" placeholder="e.g. 26.1" maxlength="40"></div>`,
      `<div class="field full"><label>Producing method / settings</label><input class="input" data-ensemble-field="originMethod" value="${esc(origin.method || '')}" placeholder="e.g. MMFF94, 15 kJ/mol window" maxlength="60"></div>`,
      `<div class="field full"><span class="inspector-note">The input block owns the file, the energy unit and the provenance. Ranking stays in the generate block that consumes it; the digest is recorded from the bytes read at run time, not typed in.</span></div>`,
    ].join(''))}
    ${group('Read record', output ? `${output.frameCount} frames` : 'not read yet', Boolean(output), [
      output
        ? `<div class="field full"><div class="card">
            <div class="kv"><span>Frames</span><code>${esc(output.frameCount)}</code></div>
            <div class="kv"><span>Energies</span><code>${esc(output.energyUnit)}${output.energyMethod ? ` · ${esc(output.energyMethod)}` : ''}</code></div>
            <div class="kv"><span>SHA-256</span><code>${digest ? `${esc(digest.slice(0, 16))}…` : 'not recorded'}</code></div>
            <div class="kv"><span>Read</span><code>${esc(output.origin?.program || 'origin not recorded')}</code></div>
          </div></div>`
        : '<div class="field full"><span class="inspector-note">Run the block to read, hash and store the ensemble. Every downstream block reads that record, not the original path.</span></div>',
    ].join(''))}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="duplicate-node">Duplicate</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="validate">Validate</button>
    <button type="button" class="btn" data-action="delete-node">Delete</button>
  </div>`;
}

function inputInspector(node) {
  if (node.input?.kind === 'ensemble') return ensembleInputInspector(node);
  const datasets = Array.isArray(state.project.datasets) ? state.project.datasets : [];
  const dataset = datasetForInputNode(node);
  const records = dataset ? recordsOf(dataset) : [];
  const counts = inputRecordCounts(node);
  const options = [
    '<option value="">— choose a dataset —</option>',
    ...datasets.map((entry) => `<option value="${esc(entry.id)}"${entry.id === dataset?.id ? ' selected' : ''}>${esc(entry.title || entry.id)}</option>`),
  ].join('');
  const recordRows = records.length
    ? records.map((record) => `
      <tr class="${record.enabled === false ? 'is-disabled' : ''}">
        <td><span class="record-label">${esc(record.label || record.id)}</span><span class="record-id">${esc(record.id)}</span>${record.geometry?.dimension === '2d' ? ' <span class="status-pill">2D</span>' : ''}</td>
        <td>${esc(record.charge)}</td>
        <td>${esc(record.multiplicity)}</td>
        <td><input type="checkbox" data-dataset-id="${esc(dataset.id)}" data-dataset-record="${esc(record.id)}"${record.enabled === false ? '' : ' checked'} aria-label="Enable ${esc(record.label || record.id)}"></td>
      </tr>`).join('')
    : '';
  // Issue 139: a drawing is not a geometry. The inspector says which records are
  // drawings (the 2D pill) and that a frequency or single point on one is
  // refused at run time until the user confirms it.
  const drawings = records.filter((record) => record.geometry?.dimension === '2d').length;
  const datasetCard = dataset
    ? `<div class="kv"><span>Source</span><code>${esc(dataset.source?.format || '')}${dataset.source?.path ? ` · ${esc(dataset.source.path)}` : ' · inline'}</code></div>
       <div class="kv"><span>Records</span><code>${counts.enabled} of ${counts.total} enabled</code></div>
       ${records.length ? `<div class="dataset-table-wrap">
         <table class="dataset-table">
           <thead><tr><th>Record</th><th>q</th><th>mult</th><th>on</th></tr></thead>
           <tbody>${recordRows}</tbody>
         </table>
       </div>` : '<div class="callout red"><strong>No records.</strong> This dataset has no geometry to run.</div>'}
       ${drawings ? `<div class="callout"><strong>${drawings} 2D drawing${drawings === 1 ? '' : 's'}.</strong> Page coordinates with z = 0, not a geometry. A flow whose first block is a frequency or a single point asks for confirmation before it runs one.</div>` : ''}`
    : '<div class="callout"><strong>No dataset bound.</strong> Import an SDF, XYZ, CSV, JSON or CDXML file of geometries, or paste its text below.</div>';

  const seriesRefused = Boolean(node.input?.series && seriesPreview(node, dataset).error);
  const derivativeRefused = Boolean(node.input?.edits?.length && derivativePreview(node, dataset).error);
  const complexRefused = Boolean(node.input?.complex && complexPreview(node, dataset).error);

  return `${inspectorHead(
    'Data · input',
    node.title,
    node.input?.complex
      ? `${node.input.complex.members.length} members · ${node.input.complex.placement?.mode || 'as-drawn'}${complexRefused ? ' · refused' : ''}`
      : node.input?.series
        ? `${node.input.recordId || 'unit'} · n = ${node.input.series.from}…${node.input.series.to}${seriesRefused ? ' · refused' : ''}`
        : node.input?.edits?.length
          ? `${node.input.recordId || 'all records'} · ${node.input.edits.length} edit${node.input.edits.length === 1 ? '' : 's'}${derivativeRefused ? ' · refused' : ''}`
          : (dataset ? `${esc(dataset.title)} · ${counts.total} record${counts.total === 1 ? '' : 's'}` : 'no dataset bound'),
  )}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${node.input?.complex ? 'Runs once on the complex' : node.input?.series ? 'Runs once per series member' : node.input?.edits?.length ? 'Runs once per edit' : 'Runs once per enabled record'}</span></div>
    ${group('Dataset', dataset ? `${counts.total}` : 'none', true, [
      `<div class="field full"><label>Dataset</label><select class="select" data-input-field="datasetId">${options}</select></div>`,
      datasetCard,
      '<div class="field full"><button type="button" class="btn" data-action="import-dataset">Import dataset file…</button></div>',
      '<input type="file" id="dataset-file" accept=".sdf,.sd,.mol,.xyz,.csv,.json,.cdxml" hidden>',
      `<details class="dataset-paste">
        <summary>Paste records instead</summary>
        <div class="field full"><label>Format</label><select class="select" id="dataset-paste-format">
          <option value="">Detect</option><option value="sdf">SDF</option><option value="xyz">XYZ</option><option value="csv">CSV</option><option value="json">JSON</option><option value="cdxml">CDXML</option>
        </select></div>
        <div class="field full"><label>Dataset text</label><textarea class="textarea" id="dataset-paste" rows="6" spellcheck="false" placeholder="$$$$&#10;… or a CSV header, or a JSON array"></textarea></div>
        <button type="button" class="btn small" data-action="import-dataset-paste">Import pasted text</button>
      </details>`,
    ].join(''))}
    ${node.input?.complex ? '' : group('Homologous series', node.input?.series ? `n = ${node.input.series.from}…${node.input.series.to}` : 'off', Boolean(node.input?.series), seriesCard(node, dataset))}
    ${node.input?.series || node.input?.complex ? '' : group('Derivative', node.input?.edits?.length ? `${node.input.edits.length} edit${node.input.edits.length === 1 ? '' : 's'}` : 'off', Boolean(node.input?.edits?.length), derivativeCard(node, dataset))}
    ${node.input?.series || node.input?.edits?.length ? '' : group('Complex', node.input?.complex ? `${node.input.complex.members.length} members` : 'off', Boolean(node.input?.complex), complexCard(node, dataset))}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="duplicate-node">Duplicate</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="validate">Validate</button>
    <button type="button" class="btn" data-action="delete-node">Delete</button>
  </div>`;
}

function simpleInspector(node) {
  const isNote = node.type === 'note';
  const output = node.type === 'output' ? outputOf(node) : null;
  const pathError = output ? outputPathError(output.path, output.kind) : '';
  const body = isNote
    ? [
      inputField('Title', 'title', node.title, { full: true }),
      `<div class="field full"><label>Note</label><textarea class="textarea" data-note-field="text" rows="6">${esc(node.note.text)}</textarea></div>`,
    ].join('')
    : node.type === 'merge'
      ? [
        inputField('Title', 'title', node.title, { full: true }),
        `<div class="field full"><label>Join policy</label><select class="select" data-merge-field="policy">
          ${[['all', 'Wait for all inputs'], ['any', 'Continue on any input']].map(([value, label]) => `<option value="${value}"${node.merge.policy === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select></div>`,
        `<div class="field full"><label>Notes</label><textarea class="textarea" data-merge-field="notes" rows="3">${esc(node.merge.notes)}</textarea></div>`,
      ].join('')
      : [
        inputField('Title', 'title', node.title, { full: true }),
        `<div class="field full"><label>Output kind</label><select class="select" data-output-field="kind">
          ${Object.entries(OUTPUT_KIND_LABELS).map(([value, label]) => `<option value="${value}"${output.kind === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}
        </select></div>`,
        `<div class="field full"><label>Path</label><input class="input${pathError ? ' is-invalid' : ''}" data-output-field="path" value="${esc(output.path)}" spellcheck="false" autocomplete="off" aria-invalid="${pathError ? 'true' : 'false'}">
          ${pathError ? `<p class="field-hint is-error">${esc(pathError)}</p>` : '<p class="field-hint">Relative to the output folder; the extension follows the kind.</p>'}</div>`,
        `<div class="field full"><label>Include</label><select class="select" data-output-field="include">
          <option value="records"${output.include === 'records' ? ' selected' : ''}>One artifact for the whole flow</option>
          <option value="record"${output.include === 'record' ? ' selected' : ''}>One artifact per record</option>
        </select></div>`,
        switchRow('Include manifest', 'SHA-256 list beside the artifact', 'manifest', output.manifest, { attr: 'data-output-field="manifest"' }),
        `<div class="field full"><label>Notes</label><textarea class="textarea" data-output-field="notes" rows="3">${esc(output.notes)}</textarea></div>`,
      ].join('');

  return `${inspectorHead(
    isNote ? 'Annotation' : node.type === 'merge' ? 'Control · join' : 'Data · output',
    node.title,
    isNote ? 'freeform note' : node.type === 'merge' ? 'combine branches' : `${output.kind.toUpperCase()} · ${output.path}`,
  )}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${isNote ? '' : statusPill(node.state)}<span class="inspector-note">${incoming(node.id).length} input${incoming(node.id).length === 1 ? '' : 's'}</span></div>
    ${group(isNote ? 'Content' : 'Settings', '', true, [body].join(''))}
    ${!isNote ? group('Inputs', `${incoming(node.id).length}`, true, [`<div class="full">${incomingList(node.id)}</div>`].join('')) : ''}
    <div class="inspector-actions-row">
      <button type="button" class="btn small" data-action="duplicate-node">Duplicate</button>
      <button type="button" class="btn small danger" data-action="delete-node">Delete</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn primary" data-action="validate">Validate</button>
    <button type="button" class="btn" data-action="delete-node">Delete</button>
  </div>`;
}

function renderEdgeInspector(edge) {
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return renderProjectInspector();
  const typeLabel = edge.type === 'checkpoint' ? 'Checkpoint hand-off'
    : edge.type === 'branch' ? `${edge.branch === 'true' ? 'TRUE' : 'FALSE'} branch`
      : edge.type === 'loop' ? 'Retry loop' : 'Dependency';
  const isXtb = engineOrDefault(state.project?.defaults?.engine).id === 'xtb';
  const checkpointLines = edge.type === 'checkpoint'
    ? (isXtb
      ? '<div class="code-block" style="margin-bottom:10px"><div>xtbrestart</div><div>xTB reads it automatically from the working directory</div></div>'
      : `<div class="code-block" style="margin-bottom:10px"><div>%OldChk=${esc(chkName(from.id))}</div><div>Geom=Checkpoint</div><div>Guess=Read</div></div>`)
    : '';
  let callout = '';
  if (edge.type === 'checkpoint') {
    callout = '<div class="callout green"><strong>Checkpoint hand-off.</strong> The dependency controls readiness; this edge also passes the upstream checkpoint to the downstream task.</div>';
  } else if (edge.type === 'branch') {
    callout = `<div class="callout"><strong>Conditional branch.</strong> This edge is released only when the condition evaluates ${edge.branch.toUpperCase()}. Unknown evidence blocks both branches.</div>`;
  } else if (edge.type === 'loop') {
    callout = `<div class="callout"><strong>Retry loop.</strong> The loop is explicit and visible: the FALSE branch re-enters the target for up to ${nodeById(edge.from)?.loop?.maxAttempts || 3} attempts.</div>`;
  } else {
    callout = '<div class="callout"><strong>Dependency.</strong> Readiness only; no checkpoint is transferred.</div>';
  }
  const checkpointToggle = edge.type === 'checkpoint'
    ? '<button type="button" class="btn small" data-action="clear-checkpoint">Clear hand-off</button>'
    : (isXtb || from.settings?.checkpoint)
      ? '<button type="button" class="btn small" data-action="set-checkpoint">Pass checkpoint</button>'
      : '';

  return `${inspectorHead('Connection', typeLabel, `${esc(from.title)} → ${esc(to.title)}`)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(to.state)}<span class="inspector-note">${edge.type}${edge.branch ? ` · ${edge.branch}` : ''}</span></div>
    ${callout}
    ${checkpointLines}
    ${group('Endpoints', '', true, [
      `<div class="field full"><label>From</label><button type="button" class="dep-row" data-select-node="${from.id}"><i class="dot ${statusFor(from).dot}"></i><span class="title">${esc(from.title)}</span>${statusPill(from.state)}</button></div>`,
      `<div class="field full"><label>To</label><button type="button" class="dep-row" data-select-node="${to.id}"><i class="dot ${statusFor(to).dot}"></i><span class="title">${esc(to.title)}</span>${statusPill(to.state)}</button></div>`,
    ].join(''))}
    ${checkpointToggle ? `<div class="inspector-actions-row">${checkpointToggle}</div>` : ''}
    <div class="inspector-actions-row">
      <button type="button" class="btn small danger" data-action="remove-edge">Remove connection</button>
    </div>
  </div>
  <div class="inspector-footer">
    <button type="button" class="btn" data-select-node="${from.id}">Select source</button>
    <button type="button" class="btn" data-select-node="${to.id}">Select target</button>
  </div>`;
}

function renderInspector() {
  const el = inspectorEl();
  if (!el) return;
  refreshDirty();
  el.classList.toggle('is-wide', state.inspectorWide);
  el.classList.toggle('is-hidden', state.inspectorHidden);
  const reopen = $('#inspector-reopen');
  if (reopen) reopen.hidden = !state.inspectorHidden;
  if (state.inspectorHidden) return;

  if (state.selected.type === 'edge') {
    const edge = edgeById(state.selected.id);
    el.innerHTML = edge ? renderEdgeInspector(edge) : renderProjectInspector();
    return;
  }
  if (state.selected.type === 'node') {
    const node = nodeById(state.selected.id);
    if (!node) { el.innerHTML = renderProjectInspector(); return; }
    if (node.type === 'calculate') { el.innerHTML = calcInspector(node); mountStructureViewer(el, node); return; }
    if (node.type === 'prepare') { el.innerHTML = prepareInspector(node); return; }
    if (node.type === 'generate') { el.innerHTML = conformersInspector(node); mountStructureViewer(el, node); return; }
    if (node.type === 'condition') { el.innerHTML = conditionInspector(node); return; }
    if (node.type === 'analyse') { el.innerHTML = computeInspector(node); return; }
    if (node.type === 'loop') { el.innerHTML = loopInspector(node); return; }
    if (node.type === 'input') { el.innerHTML = inputInspector(node); return; }
    el.innerHTML = simpleInspector(node);
    return;
  }
  el.innerHTML = renderProjectInspector();
}

/* ── Palette ──────────────────────────────────────────────── */

const BLOCKS = [
  { group: 'Calculations', items: [
    { type: 'opt', icon: 'Opt', title: 'Optimization', note: 'geometry minimum' },
    { type: 'optfreq', icon: 'O+F', title: 'Optimization + frequency', note: 'one job, two stages' },
    { type: 'freq', icon: 'Freq', title: 'Frequency', note: 'thermochemistry + modes' },
    { type: 'irc', icon: 'IRC', title: 'IRC path', note: 'forward / reverse' },
    { type: 'scan', icon: 'Scan', title: 'PES scan', note: 'coordinate scan' },
    { type: 'sp', icon: 'SP', title: 'Single point', note: 'energy at a geometry' },
    { type: 'pop', icon: 'Pop', title: 'Population analysis', note: 'charges + orbitals' },
    { type: 'emission', icon: 'Em', title: 'Emission (vertical)', note: 'TD at the optimised excited-state geometry' },
    { type: 'nto', icon: 'NTO', title: 'NTO analysis', note: 'second job of the Pop=NTO chain' },
  ] },
  { group: 'Structure', items: [
    { type: 'prepare', icon: 'PR', title: 'Prepare structure', note: 'embed 3D or MM-relax one structure' },
    { type: 'generate', icon: 'CF', title: 'Generate structures', note: 'conformer search or rank a wired input' },
  ] },
  { group: 'Control flow', items: [
    { type: 'condition', icon: 'IF', title: 'Condition', note: 'TRUE / FALSE branches' },
    { type: 'loop', icon: '↻', title: 'Loop', note: 'retry with max attempts' },
    { type: 'merge', icon: '⋈', title: 'Join', note: 'merge branches' },
    { type: 'analyse', icon: 'fx', title: 'Analyse', note: 'derived arithmetic: CBS, ΔE, ratios' },
  ] },
  { group: 'Data', items: [
    { type: 'input', icon: 'IN', title: 'Dataset input', note: 'run the graph once per record' },
    { type: 'ensemble', icon: 'XYZ', title: 'Ensemble input', note: 'rank an external multi-XYZ ensemble' },
    { type: 'output', icon: 'OUT', title: 'Output file', note: 'csv / json / html / zip' },
  ] },
  { group: 'Project', items: [
    { type: 'note', icon: '✎', title: 'Note', note: 'annotation on the canvas' },
    { type: 'checkpoint', icon: 'CHK', title: 'Checkpoint hand-off', note: 'applied to a connection' },
  ] },
];

function renderPalette() {
  const list = $('#palette-list');
  if (!list) return;
  const query = String($('#palette-search')?.value || '').trim().toLowerCase();
  const groups = BLOCKS
    .map((groupDef) => ({
      group: groupDef.group,
      items: groupDef.items.filter((item) => !query
        || `${item.title} ${item.note} ${item.type}`.toLowerCase().includes(query)),
    }))
    .filter((groupDef) => groupDef.items.length > 0);
  if (groups.length === 0) {
    list.innerHTML = '<div class="palette-empty">No blocks match that search.</div>';
    return;
  }
  list.innerHTML = groups.map((groupDef) => `
    <div class="palette-group-label">${esc(groupDef.group)}</div>
    ${groupDef.items.map((item) => `<button type="button" class="palette-item" data-block="${item.type}">
      <span class="palette-icon">${esc(item.icon)}</span>
      <span class="palette-copy"><strong>${esc(item.title)}</strong><small>${esc(item.note)}</small></span>
    </button>`).join('')}
  `).join('');
}

function togglePalette(force) {
  state.paletteOpen = typeof force === 'boolean' ? force : !state.paletteOpen;
  const palette = $('#palette');
  const button = $('[data-action="toggle-palette"]');
  const search = $('#palette-search');
  if (palette) palette.hidden = !state.paletteOpen;
  if (button) button.setAttribute('aria-expanded', String(state.paletteOpen));
  if (state.paletteOpen) {
    if (search) search.value = '';
    renderPalette();
    search?.focus();
  }
}

function freePosition() {
  const slots = [];
  for (const y of [40, 250, 460]) {
    for (const x of [10, 290, 570, 850]) slots.push({ x, y });
  }
  const occupied = (spot) => state.project.nodes.some((node) => (
    Math.abs(node.x - spot.x) < W + 20 && Math.abs(node.y - spot.y) < H + 20
  ));
  return slots.find((slot) => !occupied(slot)) || { x: 10 + (state.project.nodes.length % 3) * 20, y: 460 };
}

function addBlock(type) {
  if (type === 'checkpoint') {
    toast('Select a dependency edge, then bind a checkpoint in the connection inspector.');
    togglePalette(false);
    return;
  }
  const position = freePosition();
  const id = `block-${++nodeSequence}`;
  let node;
  if (type === 'condition') {
    node = {
      id, type: 'condition', kind: 'If', title: 'Condition', state: 'ready', ...position,
      condition: { expression: 'imaginaryCount == 1', unknown: 'block-both', notes: '' },
    };
  } else if (type === 'loop') {
    node = {
      id, type: 'loop', kind: 'Loop', title: 'Retry loop', state: 'ready', ...position,
      loop: { maxAttempts: 3, mode: 'retry', target: '', until: 'condition is false' },
    };
  } else if (type === 'prepare') {
    node = {
      id, type: 'prepare', kind: 'Relax', title: 'Prepare structure', state: 'ready', ...position,
      settings: {
        kind: 'relax',
        converter: 'uff',
        forceField: 'UFF',
        smiles: '',
        charge: state.project.molecule.charge,
        multiplicity: state.project.molecule.multiplicity,
        solvent: 'water',
        solventCount: 10,
        seed: 1,
        shellAngstrom: 3.5,
      },
      output: null,
    };
  } else if (type === 'generate') {
    node = {
      id, type: 'generate', kind: 'Generate', title: 'Generate structures', state: 'ready', ...position,
      settings: {
        ...DEFAULT_CONFORMER_SETTINGS,
        charge: state.project.molecule.charge,
        multiplicity: state.project.molecule.multiplicity,
      },
      output: null,
    };
  } else if (type === 'merge') {
    node = {
      id, type: 'merge', kind: 'Merge', title: 'Join branches', state: 'ready', ...position,
      merge: { policy: 'all', notes: '' },
    };
  } else if (type === 'analyse') {
    // Issue 175: one input named `E` reading the upstream final energy, so a
    // new block previews a real number the moment it is wired.
    node = {
      id, type: 'analyse', kind: 'Analyse', title: 'Analyse', state: 'ready', ...position,
      analyse: { expression: 'E', inputs: [{ name: 'E', field: 'finalEnergyHartree', source: '' }] },
    };
  } else if (type === 'ensemble') {
    node = {
      id, type: 'input', kind: 'Ensemble input', title: 'Ensemble input', state: 'ready', ...position,
      input: {
        kind: 'ensemble',
        ...DEFAULT_ENSEMBLE_INPUT,
        // A fresh origin per block: the default is one frozen object, and two
        // blocks must not share the provenance they declare.
        origin: { ...DEFAULT_ENSEMBLE_INPUT.origin },
      },
      output: null,
    };
  } else if (type === 'input') {
    const dataset = Array.isArray(state.project.datasets) ? state.project.datasets[0] : null;
    node = {
      id, type: 'input', kind: 'Input', title: dataset?.title || 'Dataset input', state: 'ready', ...position,
      input: { datasetId: dataset?.id || '', recordFilter: { field: '', equals: '' } },
    };
  } else if (type === 'output') {
    node = {
      id, type: 'output', kind: 'Output', title: 'Output file', state: 'ready', ...position,
      output: {
        kind: 'html',
        path: defaultOutputPath('html'),
        include: 'records',
        bundle: 'project.zip',
        manifest: true,
        notes: '',
      },
    };
  } else if (type === 'note') {
    node = {
      id, type: 'note', kind: 'Note', title: 'Note', state: 'ready', ...position,
      note: { text: 'Double-click a block to expand its inspector.' },
    };
  } else {
    const template = {
      opt: { jobType: 'Opt', title: 'Optimization' },
      optfreq: { jobType: 'Opt Freq', title: 'Optimization + frequency', gates: { thermo: true, imaginary: 0 } },
      freq: { jobType: 'Freq', title: 'Frequency', gates: { thermo: true, imaginary: 0 } },
      irc: { jobType: 'IRC', title: 'IRC path', ircDirection: 'forward' },
      scan: { jobType: 'Scan', title: 'PES scan' },
      sp: { jobType: 'SP', title: 'Single point', gates: { finalEnergy: true } },
      pop: { jobType: 'SP', title: 'Population analysis', population: 'NBO', gates: { finalEnergy: true } },
      // issue 146: the vertical-emission block is a TD single point pinned to Root=1.
      // The NTO block is the second job of the chain and carries no TD; it
      // deliberately starts without dispersion so the written route is the
      // documented `Guess=Only Pop=NTO` form.
      emission: {
        jobType: 'SP', title: 'Emission (vertical)', tdStates: 1, tdRoot: 1, emission: true, gates: { finalEnergy: true },
      },
      nto: {
        jobType: 'SP', title: 'NTO analysis', nto: true, dispersion: '', gates: { finalEnergy: true },
      },
    }[type] || { jobType: 'Opt', title: 'Calculate' };
    node = calcNode(id, kindForJob(template.jobType), template.title, position.x, position.y, {
      state: 'ready',
      settings: {
        ...template,
        method: state.project.defaults.method,
        basis: state.project.defaults.basis,
        memory: state.project.defaults.memory,
        memoryUnit: state.project.defaults.memoryUnit,
        nproc: state.project.defaults.nproc,
        charge: state.project.molecule.charge,
        multiplicity: state.project.molecule.multiplicity,
        checkpoint: `${id.replace(/-/g, '_')}.chk`,
      },
    });
  }
  state.project.nodes.push(node);
  state.selected = { type: 'node', id: node.id };
  state.inspectorHidden = false;
  togglePalette(false);
  renderGraph();
  renderInspector();
  toast(`${node.title} added. Drag from a port to connect it.`);
}

/* ── Node and edge editing ────────────────────────────────── */

/* ── Issue #93: constraint and QST editing ────────────────── */

function inspectorCalcNode() {
  if (state.selected.type !== 'node') return null;
  const node = nodeById(state.selected.id);
  return node && node.type === 'calculate' ? node : null;
}

function addConstraint() {
  const node = inspectorCalcNode();
  if (!node) return;
  const kind = $('#constraint-new-kind')?.value;
  const chosen = CONSTRAINT_KINDS.includes(kind) ? kind : 'bond';
  const list = Array.isArray(node.settings.constraints) ? node.settings.constraints : [];
  node.settings.constraints = [...list, { kind: chosen, atoms: [...CONSTRAINT_DEFAULT_ATOMS[chosen]], value: null }];
  renderInspector();
}

function removeConstraint(index) {
  const node = inspectorCalcNode();
  if (!node || !Array.isArray(node.settings.constraints)) return;
  node.settings.constraints = node.settings.constraints.filter((_, position) => position !== index);
  renderInspector();
}

/** A change to one constraint row. Called on `change`, not `input`, so typing keeps focus. */
function updateConstraintField(target) {
  const node = inspectorCalcNode();
  if (!node) return;
  const index = Number(target.dataset.constraintIndex);
  const list = Array.isArray(node.settings.constraints) ? node.settings.constraints : [];
  const constraint = list[index];
  if (!constraint) return;
  const part = target.dataset.constraintPart;
  if (part === 'kind') {
    const kind = target.value;
    if (!CONSTRAINT_KINDS.includes(kind)) return;
    const count = constraintAtomCount(kind);
    const atoms = Array.from({ length: count }, (_, slot) => Number(constraint.atoms?.[slot]) || slot + 1);
    node.settings.constraints[index] = {
      kind,
      atoms,
      value: kind === 'freeze' ? null : (constraint.value ?? null),
    };
  } else if (part === 'atom') {
    const slot = Number(target.dataset.atomSlot);
    const value = Number(target.value);
    if (!Number.isInteger(value) || value < 1) return;
    constraint.atoms[slot] = value;
  } else if (part === 'value') {
    constraint.value = target.value === '' ? null : Number(target.value);
  } else {
    return;
  }
  renderGraph();
  renderInspector();
}

/** Grow the stored structure list to `index + 1` empty structures. */
function qstStructuresForEdit(node, index) {
  const structures = qstStructuresFor(node.settings).map((structure) => ({
    label: structure.label || '',
    source: structure.source || 'copy',
    nodeId: structure.nodeId || '',
    path: structure.path || '',
    atoms: Array.isArray(structure.atoms) ? structure.atoms.map((atom) => ({ ...atom })) : [],
  }));
  while (structures.length <= index) {
    structures.push({ label: '', source: 'copy', nodeId: '', path: '', atoms: [] });
  }
  return structures;
}

function updateQstField(target) {
  const node = inspectorCalcNode();
  if (!node || !qstKindFor(node.settings.jobType)) return;
  const index = Number(target.dataset.qstIndex);
  const required = qstRequiredStructures(node.settings.jobType);
  if (!Number.isInteger(index) || index < 0 || index >= required) return;
  const structures = qstStructuresForEdit(node, index);
  const structure = structures[index];
  const part = target.dataset.qstPart;
  if (part === 'label') {
    structure.label = String(target.value).slice(0, 60);
  } else if (part === 'source') {
    structure.source = target.value;
    if (structure.source !== 'block') structure.nodeId = '';
    if (structure.source !== 'file') structure.path = '';
  } else if (part === 'node') {
    structure.nodeId = target.value;
  } else if (part === 'path') {
    structure.path = String(target.value).slice(0, 260);
  } else {
    return;
  }
  node.settings.qst = { structures };
  renderInspector();
}

function geometryAtomsOf(parsed) {
  const atoms = parsed?.geometry?.final?.atoms;
  if (!Array.isArray(atoms)) return null;
  return atoms
    .map((atom) => ({
      element: atom.element || atom.symbol || atom.label,
      x: Number(atom.x),
      y: Number(atom.y),
      z: Number(atom.z),
    }))
    .filter((atom) => atom.element && [atom.x, atom.y, atom.z].every(Number.isFinite));
}

/** Copy the chosen source's geometry into a QST structure. */
function fillQstStructure(index) {
  const node = inspectorCalcNode();
  if (!node || !qstKindFor(node.settings.jobType)) return;
  const structures = qstStructuresForEdit(node, index);
  const structure = structures[index];
  let atoms = null;
  if (structure.source === 'block') {
    const block = structure.nodeId ? nodeById(structure.nodeId) : null;
    if (!block) { toast('Choose the block this structure comes from first.'); return; }
    atoms = geometryAtomsOf(block.parsed);
    if (!atoms) { toast(`"${block.title}" has no parsed final geometry yet.`); return; }
  } else if (structure.source === 'file') {
    $('#qst-file-' + index)?.click();
    return;
  } else {
    const coords = moleculeForNode(node)?.coords || [];
    atoms = coords.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z }));
  }
  if (!atoms || atoms.length === 0) { toast('There is no geometry to copy.'); return; }
  structure.atoms = atoms;
  if (!structure.label) structure.label = index === 0 ? 'product' : 'TS guess';
  node.settings.qst = { structures };
  renderInspector();
  toast(`Structure ${index + 2} loaded · ${atoms.length} atoms`);
}

/** Read a structure file the user picked into a QST structure (renderer-side). */
async function importQstStructureFile(index, file) {
  const node = inspectorCalcNode();
  if (!node || !qstKindFor(node.settings.jobType)) return;
  try {
    const text = await file.text();
    const { records } = parseStructureRecords(text, { filename: file.name });
    const record = records.find((entry) => !entry.error);
    if (!record) throw new Error(records[0]?.error || 'No record in this file could be read.');
    const structures = qstStructuresForEdit(node, index);
    structures[index] = {
      ...structures[index],
      source: 'file',
      path: file.name,
      label: structures[index].label || (index === 0 ? 'product' : 'TS guess'),
      atoms: record.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z })),
    };
    node.settings.qst = { structures };
    renderInspector();
    toast(`Structure ${index + 2} · ${record.atoms.length} atoms from ${file.name}`);
  } catch (error) {
    toast(`Could not import structure: ${error.message}`);
  }
}

function updateNodeField(node, key, value) {
  const isXtb = engineForNode(state.project, node).id === 'xtb';
  if (key === 'title') {
    node.title = String(value).trim() || node.title;
    return;
  }
  if (key === 'checkpointFrom') {
    node.checkpointFrom = value || null;
    incoming(node.id).forEach((edge) => {
      edge.type = value && edge.from === value ? 'checkpoint' : 'dependency';
    });
    return;
  }
  if (key === 'imaginary' || key === 'minMagnitude') {
    node.settings.gates[key] = value === '' ? null : Number(value);
    return;
  }
  if (key === 'timeoutSeconds') {
    // Issue 177: absent means "inherit the project limit", so clearing the field
    // removes the key instead of storing a zero or the inherited number.
    const text = String(value ?? '').trim();
    if (text === '') {
      delete node.settings.timeoutSeconds;
      return;
    }
    const seconds = Math.trunc(Number(text));
    if (Number.isFinite(seconds) && seconds >= 1) {
      node.settings.timeoutSeconds = Math.min(seconds, LIMITS.timeoutSeconds);
    }
    return;
  }
  if (key === 'routePreset') {
    const preset = ROUTE_PRESETS.find((item) => item.id === value);
    if (!preset) return;
    const next = applyRoutePreset(node.settings, preset.id);
    node.settings.method = next.method;
    node.settings.basis = next.basis;
    node.settings.dispersion = next.dispersion;
    return;
  }
  // Issue 186: the switch is ours, not a schema field. Off writes `null`, which
  // is exactly what a block that never asked for a sweep carries.
  if (key === 'spinSweepEnabled') {
    if (!value) {
      node.settings.spinSweep = null;
      return;
    }
    const { values } = spinMultiplicitiesForNode(node);
    if (values.length < 2) return;
    const current = Number(node.settings.multiplicity);
    const first = values.includes(current) ? current : values[0];
    const second = values.find((multiplicity) => multiplicity !== first);
    node.settings.spinSweep = {
      enabled: true,
      multiplicities: [first, second].sort((a, b) => a - b),
    };
    return;
  }
  if (key === 'pnoThreshold') {
    node.settings.pnoThreshold = value;
    return;
  }
  // Issue 269: the CASSCF active space. Empty removes the key, so a block that
  // never asked for one serialises without it.
  if (key === 'pyscfActiveSpace') {
    const text = String(value ?? '').trim();
    if (text) node.settings.pyscfActiveSpace = text;
    else delete node.settings.pyscfActiveSpace;
    return;
  }
  // Issue 247: absent means "do not ask for a matrix element file", so the
  // empty option removes the key instead of storing an empty string.
  if (key === 'matrixElement') {
    if (value) node.settings.matrixElement = value;
    else delete node.settings.matrixElement;
    return;
  }
  if (key in node.settings) {
    if (key === 'solvation') {
      node.settings.solvation = Boolean(value);
      if (isXtb && node.settings.solvation) {
        const model = String(node.settings.solvationModel || '').toUpperCase();
        node.settings.solvationModel = XTB_SOLVATION_MODELS.includes(model) ? model : 'ALPB';
        const solvents = XTB_SOLVENTS[node.settings.solvationModel] || {};
        if (!Object.prototype.hasOwnProperty.call(solvents, node.settings.solvent)) node.settings.solvent = 'Water';
      }
    } else if (key === 'solvationModel' && isXtb) {
      node.settings.solvationModel = value;
      const solvents = XTB_SOLVENTS[value] || {};
      if (!Object.prototype.hasOwnProperty.call(solvents, node.settings.solvent)) node.settings.solvent = 'Water';
    } else if (key === 'xtbThreads') {
      const count = Number(value);
      node.settings.xtbThreads = value === '' || !Number.isInteger(count) || count < 1 || count > 256 ? '' : count;
    } else if (['charge', 'multiplicity', 'imaginary', 'minMagnitude', 'tdStates', 'tdRoot', 'ntoTransition'].includes(key)) {
      const nullWhenEmpty = key === 'imaginary' || key === 'minMagnitude';
      node.settings[key] = value === '' ? (nullWhenEmpty ? null : 0) : Number(value);
    } else if (key === 'jobType') {
      const wasComposite = isCompositeJobType(node.settings.jobType);
      node.settings.jobType = value;
      // Issue 285: a TD-DFT node needs a state count. The builders refuse zero
      // rather than guessing, so seed the default when the job type is chosen.
      if (value === 'TD-DFT' && !(Number(node.settings.tdStates) > 0)) node.settings.tdStates = 10;
      node.kind = kindForJob(value);
      const nowComposite = isCompositeJobType(value);
      // A composite keyword carries its own method, basis, dispersion and job
      // steps; leaving the Gaussian pair behind makes the builder refuse the
      // route, and the inspector hides those fields while composite is chosen,
      // so the user could not clear them. Clear on the way in, restore the
      // project default on the way out.
      if (nowComposite && !wasComposite) {
        Object.assign(node.settings, clearCompositeConflicts(node.settings));
      } else if (wasComposite && !nowComposite) {
        node.settings.method = state.project?.defaults?.method || MODERN_ROUTE_PRESET.method;
        node.settings.basis = state.project?.defaults?.basis || MODERN_ROUTE_PRESET.basis;
        node.settings.dispersion = defaultDispersionFor(node.settings.method);
      }
      // Issue #93: the extra QST structures belong to an STQN job. Leaving one
      // drops them instead of leaving a block the builder must refuse.
      if (!qstKindFor(value)) node.settings.qst = null;
      // A QST search is a saddle search: the gate that judges it must expect one
      // imaginary mode, exactly as a TS block does.
      if (qstKindFor(value) && !node.settings.gates?.imaginary) node.settings.gates.imaginary = 1;
    } else if (key === 'engine') {
      node.settings.engine = value;
      const resolved = value || state.project?.defaults?.engine || 'gaussian';
      if (resolved === 'psi4') {
        // Psi4 is a code engine with its own closed method, basis and job list.
        // Carry no Gaussian route field into it: the builder refuses each one by
        // name and the inspector hides them, so a stale value would be unfixable.
        if (!PSI4_JOB_TYPES.includes(node.settings.jobType)) node.settings.jobType = 'SP';
        if (!PSI4_METHODS.some((entry) => entry.key === String(node.settings.method || '').toLowerCase())) {
          node.settings.method = 'b3lyp';
        }
        if (!PSI4_BASES.some((entry) => entry.key === String(node.settings.basis || '').toLowerCase())) {
          node.settings.basis = 'def2-svp';
        }
        node.settings.dispersion = '';
        node.settings.solvation = false;
        node.settings.checkpoint = '';
        node.settings.population = '';
        node.settings.orbitals = false;
        node.settings.raman = false;
        node.settings.vcd = false;
        node.settings.roa = false;
        node.settings.grid = '';
        node.settings.scf = '';
        node.settings.tdStates = 0;
        node.settings.tdTriplets = '';
        node.settings.tdRoot = 0;
        node.settings.ntoTransition = 0;
        node.settings.emission = false;
        node.settings.nto = false;
        node.settings.customKeywords = '';
        node.settings.stableOpt = false;
        node.kind = kindForJob(node.settings.jobType);
      } else if (resolved === 'pyscf') {
        // PySCF is a code engine with a closed method, basis and job list. A
        // Gaussian route field left behind would be refused by the builder and
        // hidden by the inspector, so clear it here.
        if (!PYSCF_JOB_TYPES.includes(node.settings.jobType)) node.settings.jobType = 'SP';
        if (!PYSCF_METHODS.some((entry) => entry.key === String(node.settings.method || '').toLowerCase())) {
          node.settings.method = 'b3lyp';
        }
        if (!PYSCF_BASES.some((entry) => entry.key === String(node.settings.basis || '').toLowerCase())) {
          node.settings.basis = 'def2-svp';
        }
        node.settings.dispersion = '';
        node.settings.solvation = false;
        node.settings.solvationModel = 'PCM';
        node.settings.checkpoint = '';
        node.settings.population = '';
        node.settings.orbitals = false;
        node.settings.raman = false;
        node.settings.vcd = false;
        node.settings.roa = false;
        node.settings.grid = '';
        node.settings.scf = '';
        node.settings.tdStates = 0;
        node.settings.tdTriplets = '';
        node.settings.tdRoot = 0;
        node.settings.ntoTransition = 0;
        node.settings.emission = false;
        node.settings.nto = false;
        node.settings.customKeywords = '';
        node.settings.stableOpt = false;
        node.settings.freezeCore = 'auto';
        delete node.settings.pyscfActiveSpace;
        node.kind = kindForJob(node.settings.jobType);
      } else if (resolved === 'gaussian' && node.settings.method
        && !METHODS.some(([id]) => String(id).toLowerCase() === String(node.settings.method).toLowerCase())) {
        // Coming back from Psi4, a lowercase Psi4 method is not a Gaussian route.
        node.settings.method = state.project?.defaults?.method || MODERN_ROUTE_PRESET.method;
        node.settings.basis = state.project?.defaults?.basis || MODERN_ROUTE_PRESET.basis;
        node.settings.dispersion = defaultDispersionFor(node.settings.method);
      } else if (resolved === 'orca') {
        // ORCA has its own method/basis vocabulary. Carry no Gaussian-only
        // setting into it: the builder refuses each by name and the inspector
        // hides the field, so a stale value would be unfixable.
        if (!ORCA_METHODS.some((entry) => entry.id.toLowerCase() === String(node.settings.method || '').toLowerCase())) {
          node.settings.method = 'B3LYP';
        }
        if (!ORCA_BASES.some((entry) => entry.id.toLowerCase() === String(node.settings.basis || '').toLowerCase())) {
          node.settings.basis = 'def2-SVP';
        }
        node.settings.population = '';
        node.settings.customKeywords = '';
        node.settings.stableOpt = false;
        node.settings.raman = false;
        node.settings.vcd = false;
        node.settings.roa = false;
        node.settings.tdStates = 0;
        node.settings.tdTriplets = '';
        node.settings.tdRoot = 0;
        node.settings.ntoTransition = 0;
        node.settings.emission = false;
        node.settings.nto = false;
        node.settings.orbitals = false;
      }
    } else if (key === 'method') {
      node.settings.method = value;
      if (String(value).toLowerCase() === 'dlpno-ccsd(t)') {
        // DLPNO-CCSD(T) has no empirical dispersion keyword, and its PNO
        // cutoff must be stated before the route can be built.
        node.settings.dispersion = '';
        if (!node.settings.pnoThreshold) node.settings.pnoThreshold = 'NormalPNO';
      } else {
        delete node.settings.pnoThreshold;
        node.settings.dispersion = dispersionForMethodChange(value, node.settings.dispersion);
      }
    } else {
      node.settings[key] = value;
    }
    return;
  }
  if (key === 'gates') return;
}

function updateGate(node, key, checked) {
  if (!node.settings?.gates) return;
  node.settings.gates[key] = checked;
}

/**
 * Issue 186: tick or untick one multiplicity of a sweep. A sweep needs at least
 * two distinct states, so the last two cannot be cleared here; the switch turns
 * the whole sweep off. Adding is capped by SPIN_SWEEP_MAX, the same bound the
 * normaliser applies.
 */
function updateSpinSweepState(node, multiplicity, checked) {
  const sweep = node.settings?.spinSweep;
  if (!sweep || sweep.enabled !== true || !Number.isInteger(multiplicity)) return;
  const values = Array.isArray(sweep.multiplicities) ? sweep.multiplicities.map(Number) : [];
  if (checked) {
    if (!values.includes(multiplicity) && values.length < SPIN_SWEEP_MAX) values.push(multiplicity);
  } else {
    if (values.length <= 2) return;
    const index = values.indexOf(multiplicity);
    if (index === -1) return;
    values.splice(index, 1);
  }
  node.settings.spinSweep = {
    enabled: true,
    multiplicities: values.sort((a, b) => a - b).slice(0, SPIN_SWEEP_MAX),
  };
}

/** Issue #25: a disabled validity check is stored by id; enabling removes it. */
function updateValidityCheck(node, id, enabled) {
  if (!node.settings) return;
  const current = Array.isArray(node.settings.disabledChecks) ? node.settings.disabledChecks : [];
  node.settings.disabledChecks = current.filter((item) => item !== id);
  if (!enabled) node.settings.disabledChecks.push(id);
}

function removeNode(id) {
  const node = nodeById(id);
  if (!node) return;
  setFlowGraph(state.project, {
    nodes: state.project.nodes.filter((item) => item.id !== id),
    edges: state.project.edges.filter((edge) => edge.from !== id && edge.to !== id),
  });
  state.selected = { type: 'project', id: null };
  renderGraph();
  renderInspector();
  toast(`${node.title} deleted.`);
}

function duplicateNode(id) {
  const source = nodeById(id);
  if (!source) return;
  const position = freePosition();
  const copy = clone(source);
  copy.id = `block-${++nodeSequence}`;
  copy.title = `${source.title} copy`;
  copy.x = position.x;
  copy.y = position.y;
  copy.state = 'ready';
  if (copy.type === 'calculate') copy.settings.checkpoint = `${copy.id.replace(/-/g, '_')}.chk`;
  state.project.nodes.push(copy);
  state.selected = { type: 'node', id: copy.id };
  renderGraph();
  renderInspector();
  toast(`${source.title} duplicated.`);
}

function removeEdge(id) {
  const edge = edgeById(id);
  if (!edge) return;
  setFlowGraph(state.project, { edges: state.project.edges.filter((item) => edgeId(item) !== id) });
  state.selected = { type: 'node', id: edge.to };
  renderGraph();
  renderInspector();
  toast('Connection removed.');
}

function setCheckpoint(edgeIdValue, enabled) {
  const edge = edgeById(edgeIdValue);
  if (!edge) return;
  if (enabled) {
    const from = nodeById(edge.from);
    const engine = engineOrDefault(state.project?.defaults?.engine);
    if (!from || (engine.id !== 'xtb' && !from.settings?.checkpoint)) {
      toast('The source block has no checkpoint file.');
      return;
    }
    edge.type = 'checkpoint';
    const to = nodeById(edge.to);
    if (to?.type === 'calculate') to.checkpointFrom = edge.from;
    state.selected = { type: 'edge', id: edgeId(edge) };
    toast('Checkpoint hand-off enabled.');
  } else {
    edge.type = 'dependency';
    const to = nodeById(edge.to);
    if (to?.type === 'calculate' && to.checkpointFrom === edge.from) to.checkpointFrom = null;
    state.selected = { type: 'edge', id: edgeId(edge) };
    toast('Checkpoint hand-off cleared.');
  }
  renderGraph();
  renderInspector();
}

function wouldCreateCycle(fromId, toId) {
  const adjacency = new Map();
  state.project.edges.filter((edge) => edge.type !== 'loop').forEach((edge) => {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  });
  const stack = [toId];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === fromId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    (adjacency.get(current) || []).forEach((next) => stack.push(next));
  }
  return false;
}

function addConnection(fromId, toId, port) {
  const from = nodeById(fromId);
  const to = nodeById(toId);
  if (!from || !to || from.id === to.id) return false;
  if (to.type === 'note') { toast('Notes cannot receive connections.'); return false; }
  let type = 'dependency';
  let branch = null;
  if (port === 'true' || port === 'false') { type = 'branch'; branch = port; }
  else if (port === 'bottom' && from.type === 'loop') type = 'loop';

  if (type !== 'loop' && wouldCreateCycle(fromId, toId)) {
    toast('That connection would create an ordinary cycle. Use a Loop block for retry paths.');
    return false;
  }
  const duplicate = state.project.edges.some((edge) => (
    edge.from === fromId && edge.to === toId && edge.type === type && edge.branch === branch
  ));
  if (duplicate) { toast('That connection already exists.'); return false; }

  if (type === 'branch') {
    setFlowGraph(state.project, {
      edges: state.project.edges.filter((edge) => !(edge.from === fromId && edge.type === 'branch' && edge.branch === branch)),
    });
  }
  state.project.edges.push({
    from: fromId,
    to: toId,
    type,
    branch,
    fromPort: port,
    toPort: type === 'loop' ? 'bottomIn' : type === 'branch' ? 'left' : port === 'bottom' ? 'top' : 'left',
  });
  const id = edgeId(state.project.edges[state.project.edges.length - 1]);
  state.selected = { type: 'edge', id };
  renderGraph();
  renderInspector();
  toast(type === 'loop' ? 'Loop edge created.' : type === 'branch' ? `${branch.toUpperCase()} branch connected.` : 'Dependency connected.');
  return true;
}

/* ── Canvas interaction ───────────────────────────────────── */

function stagePoint(event) {
  const rect = worldEl().getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.zoom,
    y: (event.clientY - rect.top) / state.zoom,
  };
}

function startConnection(fromId, port, event) {
  const from = nodeById(fromId);
  if (!from) return;
  selectNode(fromId);
  state.connecting = { from: fromId, port, point: stagePoint(event) };
  const el = document.querySelector(`.node[data-node-id="${fromId}"]`);
  el?.classList.add('is-connecting-source');
  renderPreview();
}

function clearDropHighlight() {
  $$('.node.is-drop-target, .node.is-drop-invalid').forEach((el) => el.classList.remove('is-drop-target', 'is-drop-invalid'));
}

function targetNodeAt(event) {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  return element?.closest?.('.node') || null;
}

function updateConnection(event) {
  if (!state.connecting) return;
  state.connecting.point = stagePoint(event);
  renderPreview();
  clearDropHighlight();
  const target = targetNodeAt(event);
  if (!target || target.dataset.nodeId === state.connecting.from) return;
  const invalid = target.classList.contains('node-note');
  target.classList.add(invalid ? 'is-drop-invalid' : 'is-drop-target');
}

function finishConnection(event) {
  if (!state.connecting) return;
  const { from, port } = state.connecting;
  const target = targetNodeAt(event);
  clearDropHighlight();
  const sourceEl = document.querySelector(`.node[data-node-id="${from}"]`);
  sourceEl?.classList.remove('is-connecting-source');
  state.connecting = null;
  renderPreview();
  if (!target) return;
  addConnection(from, target.dataset.nodeId, port);
}

function beginKeyboardConnect(portEl) {
  const fromId = portEl.dataset.from;
  state.keyboardConnect = { from: fromId, port: portEl.dataset.port };
  document.querySelector(`.node[data-node-id="${fromId}"]`)?.classList.add('is-keyboard-source');
  portEl.setAttribute('aria-pressed', 'true');
  const node = nodeById(fromId);
  setStatusMessage(`Connecting from ${node?.title || fromId} — focus a target block and press Enter; Esc cancels.`);
}

function cancelKeyboardConnect() {
  state.keyboardConnect = null;
  $$('.node.is-keyboard-source').forEach((el) => el.classList.remove('is-keyboard-source'));
  $$('.port[aria-pressed="true"]').forEach((el) => el.removeAttribute('aria-pressed'));
  setStatusMessage('Connection cancelled.');
}

function completeKeyboardConnect(targetId) {
  const pending = state.keyboardConnect;
  if (!pending) return false;
  cancelKeyboardConnect();
  if (!targetId || targetId === pending.from) return false;
  const connected = addConnection(pending.from, targetId, pending.port);
  const target = nodeById(targetId);
  setStatusMessage(connected
    ? `Connected ${nodeById(pending.from)?.title || pending.from} → ${target?.title || targetId}.`
    : 'Connection not created; see the notice.');
  return connected;
}

function startNodeDrag(nodeEl, event) {
  const node = nodeById(nodeEl.dataset.nodeId);
  if (!node) return;
  selectNode(node.id);
  state.drag = { id: node.id, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y, moved: false };
  nodeEl.classList.add('is-dragging');
  nodeEl.setPointerCapture?.(event.pointerId);
}

function updateNodeDrag(event) {
  if (!state.drag) return;
  const node = nodeById(state.drag.id);
  const el = document.querySelector(`.node[data-node-id="${state.drag.id}"]`);
  if (!node || !el) return;
  const dx = (event.clientX - state.drag.startX) / state.zoom;
  const dy = (event.clientY - state.drag.startY) / state.zoom;
  if (Math.abs(dx) + Math.abs(dy) > 2) state.drag.moved = true;
  node.x = clamp(Math.round(state.drag.x + dx), 0, STAGE_W - W);
  node.y = clamp(Math.round(state.drag.y + dy), 0, STAGE_H - H);
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  renderEdges();
}

function endNodeDrag() {
  if (!state.drag) return;
  const moved = state.drag.moved === true;
  const el = document.querySelector(`.node[data-node-id="${state.drag.id}"]`);
  el?.classList.remove('is-dragging');
  state.drag = null;
  // Dragging writes node.x/node.y but no other handler re-evaluates the dirty
  // state, so without this a moved graph would stay "saved": no draft, and the
  // close guard would let it go without asking.
  if (moved) refreshDirty();
}

function startPan(event) {
  const viewport = viewportEl();
  state.pan = {
    startX: event.clientX,
    startY: event.clientY,
    left: viewport.scrollLeft,
    top: viewport.scrollTop,
    moved: false,
  };
  viewport.classList.add('is-panning');
}

function updatePan(event) {
  if (!state.pan) return;
  const viewport = viewportEl();
  const dx = event.clientX - state.pan.startX;
  const dy = event.clientY - state.pan.startY;
  if (Math.abs(dx) + Math.abs(dy) > 2) state.pan.moved = true;
  viewport.scrollLeft = state.pan.left - dx;
  viewport.scrollTop = state.pan.top - dy;
}

function endPan() {
  if (!state.pan) return;
  const moved = state.pan.moved;
  viewportEl().classList.remove('is-panning');
  state.pan = null;
  if (!moved) selectProject();
}

/* ── Molecule drawer ──────────────────────────────────────── */

function drawerField(label, key, value, options = {}) {
  const type = options.type || 'text';
  const attrs = options.attrs ? ` ${options.attrs}` : '';
  return `<div class="field${options.full ? ' full' : ''}"><label>${esc(label)}</label><input class="input" type="${type}"${attrs} data-drawer-field="${key}" aria-label="${esc(label)}" value="${esc(value)}"></div>`;
}

/** Even electron counts need an odd multiplicity, and the other way round. */
function electronSummary(atoms, charge, multiplicity) {
  if (!Array.isArray(atoms) || atoms.length === 0) return null;
  const electrons = atoms.reduce((total, atom) => total + (atomicNumber(atom.element) || 0), 0) - Number(charge || 0);
  if (!Number.isFinite(electrons)) return null;
  const value = Number(multiplicity);
  const ok = Number.isInteger(value) && (electrons % 2 === 0 ? value % 2 === 1 : value % 2 === 0);
  return { electrons, ok: Boolean(ok) };
}

/** Shared markup so the live parity line and the rendered one cannot drift. */
function parityMarkup(info, multiplicity) {
  if (!info) {
    return '<p class="field-hint" data-parity>Import a structure to check charge and multiplicity against its electron count.</p>';
  }
  return info.ok
    ? `<div class="parity ok" data-parity>${info.electrons} electrons · consistent with multiplicity ${esc(multiplicity)}</div>`
    : `<div class="parity bad" data-parity>${info.electrons} electrons · inconsistent with multiplicity ${esc(multiplicity)} — an even electron count needs an odd multiplicity</div>`;
}

function updateParity() {
  const draft = state.drawer?.draft;
  if (!draft) return;
  const atoms = draft.coords.length ? draft.coords : DEMO_WATER;
  const info = electronSummary(atoms, draft.charge, draft.multiplicity);
  for (const el of document.querySelectorAll('[data-parity]')) {
    if (!info) {
      el.className = 'field-hint';
      el.textContent = 'Import a structure to check charge and multiplicity against its electron count.';
      continue;
    }
    el.className = `parity ${info.ok ? 'ok' : 'bad'}`;
    el.textContent = info.ok
      ? `${info.electrons} electrons · consistent with multiplicity ${draft.multiplicity}`
      : `${info.electrons} electrons · inconsistent with multiplicity ${draft.multiplicity} — an even electron count needs an odd multiplicity`;
  }
}

function moleculeLegend(atoms) {
  const counts = new Map();
  for (const atom of atoms) counts.set(atom.element, (counts.get(atom.element) || 0) + 1);
  return [...counts.entries()]
    .map(([element, count]) => `<span><i style="background:${elementStyle(element).color}"></i>${esc(element)} <b>${count}</b></span>`)
    .join('');
}

/**
 * A flat projection of the coordinates the project would calculate. Picks the
 * two axes with the largest spread so a planar molecule is not drawn edge-on,
 * and only draws a line where the distance is inside a covalent-radius guess.
 */
function moleculePreviewSvg(atoms, width = 300, height = 190) {
  if (!Array.isArray(atoms) || atoms.length === 0) return '<div class="molecule-preview-empty">No coordinates</div>';
  const axes = ['x', 'y', 'z'].map((axis) => {
    const values = atoms.map((atom) => Number(atom[axis]) || 0);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { axis, variance: values.reduce((sum, value) => sum + (value - mean) ** 2, 0) };
  }).sort((a, b) => b.variance - a.variance);
  const [first, second] = [axes[0].axis, axes[1].axis];
  const xs = atoms.map((atom) => Number(atom[first]) || 0);
  const ys = atoms.map((atom) => Number(atom[second]) || 0);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const pad = 24;
  const scale = Math.min((width - 2 * pad) / Math.max(maxX - minX, 0.4), (height - 2 * pad) / Math.max(maxY - minY, 0.4));
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;
  const points = atoms.map((atom) => ({
    element: atom.element,
    x: offsetX + ((Number(atom[first]) || 0) - minX) * scale,
    y: height - offsetY - ((Number(atom[second]) || 0) - minY) * scale,
  }));
  const bonds = [];
  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const a = atoms[i]; const b = atoms[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const limit = 1.25 * (elementStyle(a.element).radius + elementStyle(b.element).radius);
      if (distance > 0.4 && distance < limit) {
        bonds.push(`<line x1="${points[i].x.toFixed(1)}" y1="${points[i].y.toFixed(1)}" x2="${points[j].x.toFixed(1)}" y2="${points[j].y.toFixed(1)}" />`);
      }
    }
  }
  const circles = points.map((point) => {
    const radius = point.element === 'H' ? 6 : 9;
    const fill = elementStyle(point.element).color;
    const label = point.element === 'H'
      ? ''
      : `<text x="${point.x.toFixed(1)}" y="${(point.y + 2.4).toFixed(1)}">${esc(point.element)}</text>`;
    return `<g><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius}" fill="${fill}" />${label}<title>${esc(point.element)}</title></g>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Current geometry: ${atoms.length} atoms projected on ${first.toUpperCase()} / ${second.toUpperCase()}"><g class="bonds">${bonds.join('')}</g>${circles.join('')}</svg>`;
}

function drawerSelect(label, key, options, value, full = false) {
  return `<div class="field${full ? ' full' : ''}"><label>${esc(label)}</label><select class="select" data-drawer-field="${key}" aria-label="${esc(label)}">
    ${options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${esc(optionLabel)}</option>`).join('')}
  </select></div>`;
}

function openSettingsDrawer() {
  state.drawer = {
    type: 'settings',
    tab: 'defaults',
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    draft: {
      engine: engineOrDefault(state.project.defaults.engine).id,
      xtbMethod: state.project.defaults.xtbMethod || 'gfn2',
      xtbOptLevel: state.project.defaults.xtbOptLevel || 'normal',
      method: state.project.defaults.method,
      basis: state.project.defaults.basis,
      memory: state.project.defaults.memory,
      memoryUnit: state.project.defaults.memoryUnit,
      nproc: state.project.defaults.nproc,
    },
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => {
    const modal = $('#modal');
    modal?.querySelector('button, input, select, [tabindex]:not([tabindex="-1"])')?.focus();
  });
}

/* ── App-wide Settings (issue 252) ─────────────────────────── */

function cloneAppSettings(settings) {
  return JSON.parse(JSON.stringify(settings || defaultAppSettings()));
}

/** Load the one settings document at boot; a browser preview uses defaults. */
async function loadAppSettings() {
  if (!desktop?.getSettings) {
    state.appSettings = defaultAppSettings();
    return;
  }
  try {
    const result = await desktop.getSettings();
    if (result?.settings) {
      state.appSettings = mergeAppSettings(defaultAppSettings(), result.settings);
      state.settingsPath = String(result.path || '');
    }
  } catch {
    // A broken settings file must not keep the app from opening; main already
    // falls back to defaults, and the defaults loaded above stay in force.
  }
}

/**
 * A newly created project starts from Settings → Project defaults. Existing
 * project files keep the defaults they were saved with; this is only called
 * for the in-memory seed project and a template just applied.
 */
function applySettingsProjectDefaults(project) {
  const defaults = state.appSettings?.projectDefaults;
  if (!project || !defaults) return project;
  project.defaults = {
    ...(project.defaults || {}),
    engine: defaults.engine,
    method: defaults.method,
    basis: defaults.basis,
    memory: String(defaults.memory),
    memoryUnit: defaults.memoryUnit,
    nproc: Number(defaults.nproc),
    xtbMethod: defaults.xtbMethod,
    xtbOptLevel: defaults.xtbOptLevel,
  };
  const parallel = Number(state.appSettings?.runs?.maxParallel);
  if (Number.isInteger(parallel) && parallel >= 1) {
    if (!project.runner || typeof project.runner !== 'object') project.runner = {};
    project.runner.maxParallel = Math.min(parallel, LIMITS.maxParallel);
  }
  return project;
}

/** Open the Settings window on a page; the modal shell is the existing one. */
function openAppSettings(page = 'engines') {
  state.drawer = {
    type: 'app-settings',
    page: SETTINGS_PAGES.some((entry) => entry.id === page) ? page : 'engines',
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    draft: cloneAppSettings(state.appSettings),
    errors: [],
    detection: state.settingsDetection,
    busy: false,
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderAppSettings();
  requestAnimationFrame(() => {
    const modal = $('#modal');
    modal?.querySelector('.settings-rail button.is-active, input, select, button')?.focus();
  });
  refreshSettingsDetection();
}

async function refreshSettingsDetection() {
  if (!desktop?.detectSettings || state.drawer?.type !== 'app-settings') return;
  try {
    const detection = await desktop.detectSettings();
    if (!detection || typeof detection !== 'object') return;
    state.settingsDetection = detection;
    if (state.drawer?.type === 'app-settings') {
      state.drawer.detection = detection;
      renderAppSettings();
    }
  } catch {
    // Detection is advisory; a failed probe leaves the last answer in place.
  }
}

function renderAppSettings() {
  const modal = $('#modal');
  const drawer = state.drawer;
  if (!modal || drawer?.type !== 'app-settings') return;
  const page = SETTINGS_PAGES.find((entry) => entry.id === drawer.page) || SETTINGS_PAGES[0];
  modal.classList.remove('is-molecule');
  modal.classList.add('is-settings');
  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Application · settings</span>
        <h2 id="modal-title">Settings</h2>
        <p>${esc(page.description)}</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close settings">×</button>
    </div>
    <div class="modal-body settings-body">
      <nav class="settings-rail" aria-label="Settings sections">
        ${SETTINGS_PAGES.map((entry) => `<button type="button" class="settings-rail-item${entry.id === page.id ? ' is-active' : ''}" data-action="settings-page" data-settings-page="${entry.id}"${entry.id === page.id ? ' aria-current="page"' : ''}>${esc(entry.label)}</button>`).join('')}
      </nav>
      <section class="settings-page" data-settings-page-body="${page.id}" aria-label="${esc(page.title)}">
        ${settingsPageHtml({
    page: page.id,
    draft: drawer.draft,
    detection: drawer.detection,
    errors: drawer.errors,
    settingsPath: state.settingsPath,
  })}
      </section>
    </div>
    <div class="modal-foot">
      <div class="modal-note">Applies to every project on this machine · <code>${esc(state.settingsPath || 'settings.json')}</code></div>
      <button type="button" class="btn" data-modal-close>Cancel</button>
      <button type="button" class="btn primary" data-action="save-app-settings"${drawer.busy ? ' disabled' : ''}>Save settings</button>
    </div>`;
  placeModal();
}

function setSettingsField(path, value) {
  const drawer = state.drawer;
  if (drawer?.type !== 'app-settings' || !drawer.draft) return;
  const parts = String(path || '').split('.').filter(Boolean);
  if (parts.length === 0) return;
  let target = drawer.draft;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object') target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
  if (Array.isArray(drawer.errors) && drawer.errors.length) {
    drawer.errors = drawer.errors.filter((error) => error?.field !== path);
  }
}

async function browseSettingsPath(spec) {
  if (!desktop) {
    toast('Open the Electron app to browse for a program.');
    return;
  }
  const [kind, id] = String(spec || '').split(':');
  let selected = null;
  try {
    if (kind === 'engine') selected = await desktop.pickExecutable({ engine: id });
    else if (kind === 'tool' && id === 'crest') selected = await desktop.pickCrestExecutable();
    else if (kind === 'tool' && id === 'obabel') selected = await desktop.pickObabelExecutable();
    else if (kind === 'tool') selected = await desktop.pickToolExecutable(id);
  } catch (error) {
    toast(`Could not choose a program: ${error.message}`);
    return;
  }
  if (!selected) return;
  setSettingsField(kind === 'engine' ? `engines.${id}` : `tools.${id}`, selected);
  renderAppSettings();
}

/** Re-seed the run console after Settings change, without touching projects. */
function applyAppSettingsToRunConsole() {
  readRunConfig();
  updateRunConsoleCopy();
  syncRunnerInputs();
  if (state.appSettings?.appearance?.runConsoleDock === true) dockRunConsole();
}

async function saveAppSettings() {
  const drawer = state.drawer;
  if (drawer?.type !== 'app-settings' || drawer.busy) return;
  if (!desktop?.setSettings) {
    state.appSettings = mergeAppSettings(defaultAppSettings(), drawer.draft);
    closeDrawer();
    applyAppSettingsToRunConsole();
    toast('Settings applied for this preview; the desktop app persists them.');
    return;
  }
  drawer.busy = true;
  drawer.errors = [];
  renderAppSettings();
  let result;
  try {
    result = await desktop.setSettings(drawer.draft);
  } catch (error) {
    result = { ok: false, errors: [{ field: '', message: error.message }] };
  }
  if (!result?.ok) {
    drawer.busy = false;
    drawer.errors = Array.isArray(result?.errors) && result.errors.length
      ? result.errors
      : [{ field: '', message: 'Settings were not saved.' }];
    renderAppSettings();
    toast(drawer.errors[0]?.message || 'Settings were not saved.');
    return;
  }
  state.appSettings = mergeAppSettings(defaultAppSettings(), result.settings);
  state.settingsPath = String(result.path || state.settingsPath);
  closeDrawer();
  applyAppSettingsToRunConsole();
  toast('Settings saved.');
}


/** Every dataset record in the project, flattened with its dataset's title. */
function projectDatasetRecords() {
  const datasets = Array.isArray(state.project?.datasets) ? state.project.datasets : [];
  const records = [];
  for (const dataset of datasets) {
    for (const record of Array.isArray(dataset.records) ? dataset.records : []) {
      records.push({ ...record, datasetId: dataset.id, datasetTitle: dataset.title || dataset.id });
    }
  }
  return { datasets, records };
}

function openMoleculeDrawer(tab = 'structure') {
  state.drawer = {
    type: 'molecule',
    tab,
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    draft: {
      smiles: state.project.molecule.smiles,
      charge: state.project.molecule.charge,
      multiplicity: state.project.molecule.multiplicity,
      fragments: [...state.project.molecule.fragments],
      coords: Array.isArray(state.project.molecule.coords)
        ? state.project.molecule.coords.map((atom) => ({ ...atom }))
        : [],
      // Topology and any multi-record list survive reopening the drawer, so a
      // chosen record is not lost when the panel is closed and re-rendered.
      bonds: Array.isArray(state.project.molecule.bonds)
        ? state.project.molecule.bonds.map((bond) => ({ ...bond }))
        : [],
      records: [],
      recordIndex: 0,
      geometry: { source: 'demo', file: '', format: '', ...(state.project.molecule.geometry || {}) },
      engine: engineOrDefault(state.project.defaults.engine).id,
      xtbMethod: state.project.defaults.xtbMethod || 'gfn2',
      xtbOptLevel: state.project.defaults.xtbOptLevel || 'normal',
      method: state.project.defaults.method,
      basis: state.project.defaults.basis,
      memory: state.project.defaults.memory,
      memoryUnit: state.project.defaults.memoryUnit,
      nproc: state.project.defaults.nproc,
    },
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => {
    const modal = $('#modal');
    const first = modal?.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    first?.focus();
  });
}

function closeDrawer() {
  const returnFocus = state.drawer?.returnFocus;
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  const modal = $('#modal');
  if (modal) modal.innerHTML = '';
  state.drawer = null;
  returnFocus?.focus?.();
}

function renderDrawer() {
  const modal = $('#modal');
  if (!modal || !state.drawer) return;
  modal.classList.remove('is-molecule');
  const drawer = state.drawer;
  // Issue 252: the app-wide Settings window reuses this modal shell but owns
  // its own left rail and footer.
  if (drawer.type === 'app-settings') {
    renderAppSettings();
    return;
  }
  // The New project chooser reuses the modal shell and its close/Escape/focus
  // handling; only the body renderer is different.
  if (drawer.type === 'template') {
    renderTemplateChooser();
    placeModal();
    return;
  }
  if (drawer.type === 'batch') {
    renderBatchImport();
    return;
  }
  if (drawer.type === 'replace-confirm') {
    renderReplaceConfirm();
    placeModal();
    return;
  }
  if (drawer.type === 'drawing-gate') {
    renderDrawingGate();
    placeModal();
    return;
  }
  if (drawer.type === 'rename-project') {
    renderRenameProject();
    placeModal();
    return;
  }
  const draft = drawer.draft;
  const drawerDatasets = projectDatasetRecords();
  const tabs = drawer.type === 'settings'
    ? []
    : [
      ['structure', 'Structure'],
      ['fragments', 'Charge & fragments'],
      ...(drawerDatasets.records.length > 1 ? [['records', `Records ${drawerDatasets.records.length}`]] : []),
    ];
  const activeTab = drawer.type === 'settings' ? 'defaults' : drawer.tab;
  const coords = Array.isArray(draft.coords) ? draft.coords : [];
  const atoms = coords.length ? coords : DEMO_WATER;
  const demo = coords.length === 0;
  const electrons = electronSummary(atoms, draft.charge, draft.multiplicity);
  let body = '';
  if (activeTab === 'structure') {
    const sourceLabel = draft.geometry.source === 'imported' && draft.coords.length
      ? `${esc(draft.geometry.file || 'imported file')} · ${esc(draft.geometry.format || 'structure')}`
      : draft.coords.length
        ? `Coordinates stored in the project file${draft.geometry.file ? ` · ${esc(draft.geometry.file)}` : ''}`
        : 'No structure imported yet — the demo water below is what the project would calculate.';
    body = `
      <div class="molecule-grid">
        <div class="molecule-pane">
          <div class="form-section">
            <div class="section-label">SMILES <span class="group-meta">metadata</span></div>
            <textarea class="textarea" data-drawer-field="smiles" rows="3" aria-label="SMILES" placeholder="SMILES, e.g. C=CC=C.C=C">${esc(draft.smiles)}</textarea>
            <p class="field-hint">Kept with the project as a label; calculations always use the coordinates, never this string.</p>
          </div>
          <div class="form-section">
            <div class="section-label">Geometry</div>
            <div class="drop-zone">
              <strong>${draft.coords.length ? `${draft.coords.length} atoms` : 'Demo water geometry'}</strong>
              <span>${sourceLabel}</span>
              <span class="drop-hint">Drop a .xyz, .mol, .sdf, .mol2, .pdb, .pdbqt, .json, .gjf, .com or Gaussian .log file here.</span>
              <div class="run-actions">
                <button type="button" class="btn small" data-action="import-structure">Import structure file</button>
                ${draft.coords.length ? '<button type="button" class="btn small" data-action="clear-geometry">Use demo water</button>' : ''}
              </div>
              <input type="file" id="structure-file" accept=".xyz,.mol,.sdf,.mol2,.pdb,.pdbqt,.cjson,.gjf,.com,.log,.out,.cdxml,.cdx" hidden>
              ${(draft.records?.length || 0) > 1 ? `
                <label class="field-label" style="margin-top:8px">Record
                  <select data-record-select>
                    ${draft.records.map((record, index) => `<option value="${index}"${index === draft.recordIndex ? ' selected' : ''}>${esc(record.name)} · ${record.atoms.length} atoms</option>`).join('')}
                  </select>
                </label>` : ''}
            </div>
          </div>
        </div>
        <div class="molecule-pane">
          <div class="form-section">
            <div class="section-label">Current geometry <span class="group-meta">${demo ? 'demo · 3 atoms' : `${coords.length} atoms`}</span></div>
            <div class="molecule-preview">${moleculePreviewSvg(atoms)}</div>
            <div class="molecule-legend">${moleculeLegend(atoms)}</div>
          </div>
          <div class="form-section">
            <div class="section-label">Facts</div>
            <div class="card">
              <div class="kv"><span>Atoms</span><code>${draft.coords.length || 'demo (3)'}</code></div>
              <div class="kv"><span>Fragments</span><code>${draft.fragments.length}</code></div>
              <div class="kv"><span>Charge</span><code>${esc(draft.charge)}</code></div>
              <div class="kv"><span>Multiplicity</span><code>${esc(draft.multiplicity)}</code></div>
              <div class="kv"><span>Default method</span><code>${esc(draft.method)}/${esc(draft.basis)}</code></div>
            </div>
            ${parityMarkup(electrons, draft.multiplicity)}
          </div>
        </div>
      </div>
      ${draft.geometry?.dimension === '2d' ? '<div class="callout"><strong>Imported from a 2D drawing.</strong> The coordinates are a depiction, not a structure: bond lengths and angles are page units, every atom sits at z = 0. Optimise this geometry before a frequency, a single point on it, or anything that reports an energy — the numbers would describe the drawing, not the molecule.</div>' : ''}
      <div class="callout green"><strong>Project-level structure.</strong> Every calculation block builds its input from these coordinates; each block keeps its own charge, multiplicity, method, basis and gates.</div>`;
  } else if (activeTab === 'records') {
    const records = drawerDatasets.records;
    const peekIndex = Math.min(Math.max(0, Number(drawer.peekIndex) || 0), Math.max(0, records.length - 1));
    const peek = records[peekIndex] || null;
    const enabled = records.filter((record) => record.enabled !== false);
    const elements = new Set();
    for (const record of records) for (const symbol of compositionOf(record.coords || []).keys()) elements.add(symbol);
    const charges = records.map((record) => Number(record.charge) || 0);
    const multiplicities = records.map((record) => Number(record.multiplicity) || 1);
    const chargeRange = charges.length ? (Math.min(...charges) === Math.max(...charges)
      ? `${charges[0]}`
      : `${Math.min(...charges)} … ${Math.max(...charges)}`) : '–';
    const multiplicityRange = multiplicities.length ? (Math.min(...multiplicities) === Math.max(...multiplicities)
      ? `${multiplicities[0]}`
      : `${Math.min(...multiplicities)} … ${Math.max(...multiplicities)}`) : '–';
    const atomCounts = records.map((record) => (record.coords || []).length);
    const atomRange = atomCounts.length
      ? (Math.min(...atomCounts) === Math.max(...atomCounts) ? `${atomCounts[0]}` : `${Math.min(...atomCounts)} … ${Math.max(...atomCounts)}`)
      : '–';
    const peekAtoms = peek?.coords || [];
    const peekMass = massOf(peekAtoms);
    body = `
      <div class="records-summary">
        <div class="records-stat"><span>Records</span><strong>${records.length}</strong></div>
        <div class="records-stat"><span>Enabled</span><strong>${enabled.length}</strong></div>
        <div class="records-stat"><span>Atoms</span><strong>${atomRange}</strong></div>
        <div class="records-stat"><span>Charge</span><strong>${esc(chargeRange)}</strong></div>
        <div class="records-stat"><span>Multiplicity</span><strong>${esc(multiplicityRange)}</strong></div>
        <div class="records-stat"><span>Elements</span><strong>${esc([...elements].sort().join(' ')) || '–'}</strong></div>
      </div>
      <div class="records-layout">
        <div class="records-table-wrap">
          <table class="records-table">
            <thead><tr><th>#</th><th>Record</th><th>Formula</th><th>Atoms</th><th>Charge</th><th>Mult</th><th>Runs</th></tr></thead>
            <tbody>
              ${records.map((record, index) => `
                <tr class="records-row${index === peekIndex ? ' is-active' : ''}${record.enabled === false ? ' is-disabled' : ''}" data-record-peek="${index}" tabindex="0">
                  <td class="num">${index + 1}</td>
                  <td class="record-label">${esc(record.label || record.id || `record ${index + 1}`)}</td>
                  <td class="mono">${esc(formulaOf(record.coords || []) || '–')}</td>
                  <td class="num">${(record.coords || []).length}</td>
                  <td class="num">${esc(record.charge ?? 0)}</td>
                  <td class="num">${esc(record.multiplicity ?? 1)}</td>
                  <td class="num">${record.enabled === false ? 'off' : 'on'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <p class="field-hint">A flow's input block runs one task per enabled record. Select a row to inspect it; nothing here changes the dataset.</p>
        </div>
        <div class="records-peek">
          ${peek
    ? `<div class="section-label">${esc(peek.label || peek.id || `record ${peekIndex + 1}`)} <span class="group-meta">${esc(peek.datasetTitle)}</span></div>
            <div class="molecule-preview">${moleculePreviewSvg(peekAtoms)}</div>
            <div class="card records-facts">
              <div class="kv"><span>Formula</span><code>${esc(formulaOf(peekAtoms) || '–')}</code></div>
              <div class="kv"><span>Mass</span><code>${peekMass === null ? '–' : `${peekMass.toFixed(2)} u`}</code></div>
              <div class="kv"><span>Atoms</span><code>${peekAtoms.length}</code></div>
              <div class="kv"><span>Charge</span><code>${esc(peek.charge ?? 0)}</code></div>
              <div class="kv"><span>Multiplicity</span><code>${esc(peek.multiplicity ?? 1)}</code></div>
            </div>
            <button type="button" class="btn small" data-action="load-record" data-record-index="${peekIndex}">Load into editor</button>
            <p class="field-hint">The editor writes the project molecule; the dataset record itself is untouched.</p>`
    : '<p class="field-hint">This dataset has no records.</p>'}
        </div>
      </div>`;
  } else if (activeTab === 'fragments') {
    body = `
      <div class="form-grid">
        ${drawerField('Charge', 'charge', draft.charge, { type: 'number', attrs: 'min="-10" max="10" step="1"' })}
        ${drawerField('Multiplicity', 'multiplicity', draft.multiplicity, { type: 'number', attrs: 'min="1" max="10" step="1"' })}
      </div>
      ${parityMarkup(electrons, draft.multiplicity)}
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Fragments <span class="group-meta">${draft.fragments.length}</span></div>
        ${draft.fragments.map((fragment, index) => `<div class="fragment-row"><span class="frag-label">Fragment ${index + 1}</span><input class="input" data-drawer-fragment="${index}" aria-label="Fragment ${index + 1}" value="${esc(fragment)}"></div>`).join('')}
        <button type="button" class="btn small" data-action="add-fragment">Add fragment</button>
      </div>
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Atom partition <span class="group-meta">read by Psi4 SAPT</span></div>
        ${draft.coords.length
    ? draft.coords.map((atom, index) => `<div class="fragment-row">
          <span class="frag-label">${index + 1}. ${esc(atom.element)}</span>
          <select class="select" data-atom-fragment="${index}" aria-label="Fragment for atom ${index + 1}">
            <option value="0"${Number(atom.fragment) > 0 ? '' : ' selected'}>unlabelled</option>
            ${draft.fragments.map((_, fragmentIndex) => `<option value="${fragmentIndex + 1}"${Number(atom.fragment) === fragmentIndex + 1 ? ' selected' : ''}>fragment ${fragmentIndex + 1}</option>`).join('')}
          </select>
        </div>`).join('')
    : '<p class="field-hint">Import a geometry first: the partition lists one row per atom.</p>'}
        <p class="field-hint">Psi4 SAPT0 splits the complex at these labels. Other engines ignore them; a complex without labels cannot run SAPT.</p>
      </div>
      <div class="callout"><strong>Fragment order</strong> maps to <code>Fragment=N</code> in the exported route; the atom partition below is what splits the geometry.</div>`;
  } else {
    const engineId = engineOrDefault(draft.engine).id;
    const isXtb = engineId === 'xtb';
    const isOrca = engineId === 'orca';
    const isPyscf = engineId === 'pyscf';
    const defaultDispersion = defaultDispersionFor(draft.method);
    const gaussianRoute = routeFull({ method: draft.method, basis: draft.basis, jobType: 'Opt', dispersion: defaultDispersion });
    const xtbMethod = draft.xtbMethod || 'gfn2';
    const gfnFlag = xtbMethod === 'gfnff' ? '--gfnff' : `--gfn ${xtbMethod.replace('gfn', '')}`;
    const xtbRoute = `xtb task.xyz ${gfnFlag} --opt ${draft.xtbOptLevel || 'normal'}`;
    const orcaBasisEntry = ORCA_BASES.find((entry) => entry.id === draft.basis) || ORCA_BASES[0];
    const orcaRoute = String(draft.method).toLowerCase() === 'dlpno-ccsd(t)'
      ? `! DLPNO-CCSD(T) ${orcaBasisEntry.keyword} def2/J ${orcaBasisEntry.auxiliary || '<basis>/C'} RIJCOSX NormalPNO`
      : `! ${draft.method} ${orcaBasisEntry.keyword}`;
    const pyscfMethodEntry = PYSCF_METHODS.find((entry) => entry.key === String(draft.method || '').toLowerCase())
      || PYSCF_METHODS.find((entry) => entry.key === 'b3lyp');
    const pyscfBasisEntry = PYSCF_BASES.find((entry) => entry.key === String(draft.basis || '').toLowerCase())
      || PYSCF_BASES[0];
    const pyscfRoute = `PySCF ${pyscfMethodEntry.label}/${pyscfBasisEntry.label} SP`;
    body = `
      <div class="form-grid">
        ${drawerSelect('Engine', 'engine', Object.values(ENGINES).map((item) => [item.id, item.label]), engineId)}
        ${isXtb
    ? drawerSelect('xTB method', 'xtbMethod', XTB_METHODS.map((item) => [item.id, item.label]), draft.xtbMethod || 'gfn2')
    : isOrca
      ? drawerSelect('Default method', 'method', ORCA_METHODS.map((entry) => [entry.id, entry.label]), draft.method)
      : isPyscf
        ? drawerSelect('Default method', 'method', PYSCF_METHODS.map((entry) => [entry.key, entry.label]), pyscfMethodEntry.key)
        : drawerSelect('Default method', 'method', METHODS, draft.method)}
        ${isXtb
    ? drawerSelect('Optimisation level', 'xtbOptLevel', XTB_OPT_LEVELS.map((level) => [level, level]), draft.xtbOptLevel || 'normal')
    : isOrca
      ? drawerSelect('Default basis', 'basis', ORCA_BASES.map((entry) => [entry.id, entry.label]), draft.basis)
      : isPyscf
        ? drawerSelect('Default basis', 'basis', PYSCF_BASES.map((entry) => [entry.key, entry.label]), pyscfBasisEntry.key)
        : drawerSelect('Default basis', 'basis', BASIS_SETS, draft.basis)}
        ${isXtb || isPyscf ? '' : drawerField('Memory', 'memory', draft.memory, { type: 'number', attrs: 'min="1" step="1"' })}
        ${isXtb || isPyscf ? '' : drawerSelect('Memory unit', 'memoryUnit', MEMORY_UNITS, draft.memoryUnit)}
        ${drawerField('Cores (nproc)', 'nproc', draft.nproc, { type: 'number', attrs: 'min="1" max="1024" step="1"' })}
      </div>
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Default route · ${esc(engineOrDefault(engineId).label)}</div>
        <div class="code-block">${esc(isXtb ? xtbRoute : isOrca ? orcaRoute : isPyscf ? pyscfRoute : gaussianRoute)}</div>
        <p class="field-hint">Shown for the current defaults; each block keeps its own snapshot when it is created.</p>
      </div>
      <div class="callout">${isXtb
    ? 'xTB has no basis set, no transition-state search, no IRC and no scan — blocks needing those are refused when their input is built.'
    : isOrca
      ? 'ORCA reads simple input, not a Gaussian route. DLPNO-CCSD(T) blocks are single points here; Freq and Opt are refused when their input is built.'
      : isPyscf
        ? 'PySCF reads a fixed Python deck. CASSCF needs an explicit active space; TD-DFT writes singlet roots only. Periodic, relativistic, QM/MM, GPU, NMR and triplet roots are refused by name when the input is built.'
        : 'Gaussian blocks keep the route, dispersion and basis configured per block; these are only the defaults for new blocks.'}</div>`;
  }

  modal.classList.add('is-molecule');
  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">${drawer.type === 'settings' ? 'Project · settings' : 'Project · molecule'}</span>
        <h2 id="modal-title">${drawer.type === 'settings' ? 'Project settings' : 'Molecule'}</h2>
        <p>${drawer.type === 'settings'
    ? `Engine ${esc(engineOrDefault(draft.engine).label)} · defaults for new blocks`
    : `${demo ? 'Demo water' : `${draft.coords.length} atoms`} · charge ${esc(draft.charge)} · multiplicity ${esc(draft.multiplicity)}${draft.fragments.length ? ` · ${draft.fragments.length} fragment${draft.fragments.length === 1 ? '' : 's'}` : ''}`}</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close drawer">×</button>
    </div>
    ${tabs.length ? `<div class="modal-tabs">
      ${tabs.map(([id, label]) => `<button type="button" class="modal-tab${activeTab === id ? ' is-active' : ''}" data-drawer-tab="${id}">${label}</button>`).join('')}
    </div>` : ''}
    <div class="modal-body">
      ${body}
    </div>
    <div class="modal-foot">
      <div class="modal-note">Applies to this project only · saved with the <code>.ncs</code> file.</div>
      <button type="button" class="btn" data-modal-close>Cancel</button>
      <button type="button" class="btn primary" data-action="save-molecule">Save changes</button>
    </div>`;
  placeModal();
}

function saveMolecule() {
  if (!state.drawer) return;
  const draft = state.drawer.draft;
  if (state.drawer.type === 'molecule') {
  const previousCharge = state.project.molecule.charge;
  const previousMultiplicity = state.project.molecule.multiplicity;
  const nextCharge = Number(draft.charge) || 0;
  const nextMultiplicity = Number(draft.multiplicity) || 1;
  state.project.molecule.smiles = draft.smiles;
  state.project.molecule.charge = nextCharge;
  state.project.molecule.multiplicity = nextMultiplicity;
  // A block that still carried the project default follows the project; an
  // intentional per-block override is left alone.
  for (const node of state.project.nodes) {
    if (!node?.settings) continue;
    if (node.settings.charge === previousCharge) node.settings.charge = nextCharge;
    if (node.settings.multiplicity === previousMultiplicity) node.settings.multiplicity = nextMultiplicity;
  }
  state.project.molecule.fragments = [...draft.fragments];
  state.project.molecule.coords = (draft.coords || []).map((atom) => ({
    element: atom.element,
    x: atom.x,
    y: atom.y,
    z: atom.z,
    // A fragment label is part of the molecule, not a view detail: Psi4's SAPT
    // builder splits the complex on it, so saving the geometry must keep it.
    ...(Number(atom.fragment) > 0 ? { fragment: Number(atom.fragment) } : {}),
  }));
  // Topology stated by the imported file rides with the molecule; an empty
  // list is omitted so nothing implies "no bonds".
  if (Array.isArray(draft.bonds) && draft.bonds.length) {
    state.project.molecule.bonds = draft.bonds.map((bond) => ({ ...bond }));
  } else {
    delete state.project.molecule.bonds;
  }
  state.project.molecule.geometry = { ...draft.geometry };
  }
  state.project.defaults.engine = engineOrDefault(draft.engine).id;
  state.project.defaults.xtbMethod = draft.xtbMethod || 'gfn2';
  state.project.defaults.xtbOptLevel = draft.xtbOptLevel || 'normal';
  state.project.defaults.method = draft.method;
  state.project.defaults.basis = draft.basis;
  state.project.defaults.memory = draft.memory;
  state.project.defaults.memoryUnit = draft.memoryUnit;
  state.project.defaults.nproc = draft.nproc;
  // An xTB project cannot carry a Gaussian-only implicit-solvation model.
  if (state.project.defaults.engine === 'xtb') {
    for (const node of state.project.nodes) {
      if (!node?.settings || !node.settings.solvation) continue;
      const model = String(node.settings.solvationModel || '').toUpperCase();
      node.settings.solvationModel = XTB_SOLVATION_MODELS.includes(model) ? model : 'ALPB';
      const solvents = XTB_SOLVENTS[node.settings.solvationModel] || {};
      if (!Object.prototype.hasOwnProperty.call(solvents, node.settings.solvent)) node.settings.solvent = 'Water';
    }
  }
  closeDrawer();
  renderGraph();
  renderInspector();
  updateRunConsoleCopy();
  toast('Project molecule and defaults updated.');
}

async function importStructureFile(file) {
  if (!state.drawer || !file) return;
  try {
    // .cdx is a binary tagged stream. Reading it with file.text() destroys the
    // bytes before the reader sees them, so binary files take the byte path.
    const binary = /\.cdx$/i.test(file.name);
    const payload = binary ? new Uint8Array(await file.arrayBuffer()) : await file.text();
    const { format, records } = parseStructureRecords(payload, { filename: file.name });
    const usable = records.filter((record) => !record.error);
    if (usable.length === 0) {
      throw new Error(records[0]?.error || 'No record in this file could be read.');
    }
    const skipped = records.length - usable.length;
    state.drawer.draft.records = usable.map((record, index) => ({
      index,
      name: record.name || `Record ${index + 1}`,
      atoms: record.atoms,
      bonds: record.bonds || [],
      charge: record.charge,
      multiplicity: record.multiplicity,
      // A ChemDraw record says its coordinates are a drawing; carrying the flag
      // keeps the structure all the way to the notice below instead of
      // silently becoming a geometry a calculation can start from.
      dimension: record.geometry?.dimension || '',
      warnings: record.warnings || [],
    }));
    applyImportedRecord(0, file.name, format, usable.length + skipped);
    const drawing = usable[0].geometry?.dimension === '2d';
    toast(`Imported ${usable[0].atoms.length} atoms from ${file.name}`
      + `${records.length > 1 ? ` · ${records.length} records, showing record 1` : ''}`
      + `${skipped ? ` · ${skipped} unreadable record${skipped === 1 ? '' : 's'} skipped` : ''}`
      + `${drawing ? '. 2D drawing: these coordinates are a depiction, not a structure.' : '.'}`);
  } catch (error) {
    toast(`Could not import structure: ${error.message}`);
  }
}

function applyImportedRecord(index, fileName, format, total) {
  const draft = state.drawer?.draft;
  const record = draft?.records?.[index];
  if (!draft || !record) return;
  draft.recordIndex = index;
  draft.coords = record.atoms;
  draft.bonds = record.bonds;
  draft.charge = record.charge;
  draft.multiplicity = record.multiplicity;
  draft.geometry = {
    source: 'imported',
    file: fileName || draft.geometry?.file || '',
    format: format || draft.geometry?.format || '',
    dimension: record.dimension || '',
  };
  renderDrawer();
  if (total > 1) toast(`Loaded record ${index + 1} of ${total}: ${record.name}.`);
}

function clearImportedGeometry() {
  if (!state.drawer) return;
  state.drawer.draft.coords = [];
  state.drawer.draft.geometry = { source: 'demo', file: '', format: '' };
  renderDrawer();
  toast('Geometry reset to the demo water molecule.');
}

/* ── Zoom, validation, toast ──────────────────────────────── */

function setZoom(value) {
  state.zoom = clamp(Number(value) || 1, 0.62, 1.18);
  const world = worldEl();
  if (world) world.style.transform = `scale(${state.zoom})`;
  const label = $('#zoom-label');
  if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitGraph() {
  const viewport = viewportEl();
  if (!viewport) return;
  const available = viewport.clientWidth - 38;
  setZoom(clamp(available / STAGE_W, 0.62, 1));
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
  toast('Graph fitted to the viewport.');
}

function hasOrdinaryCycle() {
  const adjacency = new Map();
  state.project.edges.filter((edge) => edge.type !== 'loop').forEach((edge) => {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  });
  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) || []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return state.project.nodes.some((node) => visit(node.id));
}

function validateGraph() {
  const engineId = engineOrDefault(state.project?.defaults?.engine).id;
  const conditions = state.project.nodes.filter((node) => node.type === 'condition').length;
  const loops = state.project.edges.filter((edge) => edge.type === 'loop').length;
  const findings = state.project.nodes
    .filter((node) => node.type === 'calculate')
    .map((node) => {
      // The force-constant and convergence rules are Gaussian route rules;
      // xTB rejects unsupported job types when the input is built.
      const ts = engineId === 'xtb' ? { errors: [], warnings: [] } : tsForceConstantIssues(node);
      // Issue #25: the same pre-run validity checks project validation runs,
      // surfaced in the inspector so a blocked export has a specific reason.
      const validity = runValidityChecks({
        settings: node.settings,
        molecule: moleculeForNode(node),
        parsed: null,
        upstream: validityUpstreamFor(node),
      }, { phase: 'pre', engine: engineId });
      const blocking = new Set(VALIDITY_CHECKS.filter((check) => check.blocking).map((check) => check.id));
      return {
        node,
        errors: [
          ...ts.errors,
          ...validity.findings
            .filter((finding) => finding.status === CHECK_STATUS.FAIL && blocking.has(finding.id))
            .map((finding) => finding.message),
        ],
        warnings: [
          ...ts.warnings,
          ...(engineId === 'xtb' ? [] : optConvergenceIssues(node)),
          ...validity.findings
            .filter((finding) => finding.status === CHECK_STATUS.WARNING
              || (finding.status === CHECK_STATUS.FAIL && !blocking.has(finding.id)))
            .map((finding) => finding.message),
        ],
      };
    });
  const errors = findings.flatMap(({ node, errors: list }) => list.map((message) => `${node.title}: ${message}`));
  const warnings = findings.flatMap(({ node, warnings: list }) => list.map((message) => `${node.title} ${message}`));
  for (const node of state.project.nodes) {
    if (node.type === 'input') {
      if (!node.input?.datasetId) {
        errors.push(`${node.title}: no dataset is bound.`);
        continue;
      }
      const dataset = datasetForInputNode(node);
      if (!dataset) {
        errors.push(`${node.title}: dataset "${node.input.datasetId}" is not in this project.`);
      } else if (enabledRecords(dataset).length === 0) {
        errors.push(`${node.title}: dataset "${dataset.title}" has no enabled records.`);
      } else if (node.input.series) {
        // Issue 169: the same expansion the plan runs, so Validate reports the
        // refusal with the atom indices instead of a count.
        const preview = seriesPreview(node, dataset);
        if (preview.error) errors.push(`${node.title}: ${preview.error}`);
      }
    }
    if (node.type === 'output') {
      const output = outputOf(node);
      const pathError = outputPathError(output.path, output.kind);
      if (pathError) errors.push(`${node.title}: ${pathError}`);
    }
  }
  if (errors.length > 0) {
    const more = errors.length > 1 ? ` · +${errors.length - 1} more` : '';
    state.statusMessage = `Validation failed · ${errors[0]}${more}`;
    toast('Validation found a blocking issue.');
  } else if (hasOrdinaryCycle()) {
    state.statusMessage = 'Structure warning · an ordinary dependency cycle exists. Use an explicit Loop block.';
    toast('Validation found an ordinary cycle.');
  } else {
    const warningText = warnings.length
      ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
      : '';
    state.statusMessage = `Structure valid${warningText} · ${countLabel(state.project.nodes.length, 'block')} · ${countLabel(state.project.edges.length, 'connection')} · ${countLabel(conditions, 'condition')} · ${countLabel(loops, 'loop')}. Branch and loop execution is planned.`;
    toast(warnings.length
      ? `Structure valid with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`
      : 'Structure valid. Branch and loop execution is planned.');
  }
  updateCounts();
}

function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

/* ── Local runner ─────────────────────────────────────────── */

const safeBase = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

function selectedCalcNode({ conformers = false } = {}) {
  if (state.selected.type !== 'node') return null;
  const node = nodeById(state.selected.id);
  if (!node) return null;
  if (node.type === 'calculate') return node;
  // Issue 101: a conformer block is runnable on its own (its search), so the
  // run paths that pass `conformers: true` accept it; export still asks for a
  // calculation and keeps refusing it.
  return conformers && node.type === 'generate' ? node : null;
}

function gatesForNode(node) {
  return shared.gatesForNode(node);
}

function checkpointNameFor(node) {
  return shared.checkpointNameFor(state.project, node);
}

/**
 * Issue #25: the serializable context for the validity checks. Settings are
 * limited to what the checks read; the geometry is the same one the runner
 * builds the input from, including the labelled demo water fallback.
 */
function validityForNode(node) {
  return shared.validityForNode(state.project, node);
}

function oldCheckpointFor(node) {
  return shared.oldCheckpointFor(state.project, node);
}

/** Issue #25: upstream evidence for the optimisation-convergence check. */
function validityUpstreamFor(node) {
  return shared.validityUpstreamFor(state.project, node);
}

/**
 * Issue #25: the one pre-run finding that makes an export or a run
 * meaningless. Checks are independent, so this is the only gate the input
 * builder enforces; warnings stay visible in Validate.
 */
function blockingValidityFinding(node, settings, molecule) {
  return shared.blockingValidityFinding(state.project, node, settings, molecule);
}

/** The block whose checkpoint feeds this one, or null. Mirrors %OldChk. */
function checkpointSourceNode(node) {
  return shared.checkpointSourceNode(state.project, node);
}

/** Issue #15 findings for a node's force-constant choice. */
function tsForceConstantIssues(node) {
  return shared.tsForceConstantIssues(state.project, node);
}

/** Issue #16 findings for a node's optimization convergence and integration grid. */
function optConvergenceIssues(node) {
  return shared.optConvergenceIssues(state.project, node);
}

function moleculeForNode(node) {
  return shared.moleculeForNode(state.project, node);
}

function settingsForNode(node) {
  return shared.settingsForNode(state.project, node);
}

function buildRunInput(node) {
  return shared.buildRunInput(state.project, node);
}

/** The engine's own input text, for the inspector preview. */
function buildInputForNode(node) {
  return buildRunInput(node).inputText;
}

/** Show "detected" or "from Settings" when the visible value came from there. */
function syncRunExecutableDetected(engineId) {
  const field = $('#run-exe');
  const marker = $('#run-exe-detected');
  if (!field || !marker) return;
  const settingsPath = String(state.appSettings?.engines?.[engineId] || '').trim();
  const seed = executableSeed({
    engineId,
    stored: engineExecutableMap(state.appSettings, storedExecutables()),
    status: state.engineStatus,
  });
  const visible = seed.detected && field.value.trim() === seed.value;
  const fromSettings = !visible && Boolean(settingsPath) && field.value.trim() === settingsPath;
  marker.hidden = !visible && !fromSettings;
  marker.textContent = visible ? 'detected' : (fromSettings ? 'from Settings' : '');
  if (visible) marker.title = `Detected at ${seed.path}`;
  else if (fromSettings) marker.title = `Settings → Engines: ${settingsPath}`;
}

/**
 * Issue 258: the engine field's seeded marker exists; every companion path
 * field needs the same affordance. The map is also what the regression test
 * walks, so a field cannot be added without its marker.
 */
const COMPANION_FIELDS = Object.freeze({
  crest: { field: '#run-crest', marker: '#run-crest-detected', label: 'CREST' },
  obabel: { field: '#run-obabel', marker: '#run-obabel-detected', label: 'Open Babel' },
  scorer: { field: '#run-scorer', marker: '#run-scorer-detected', label: 'ML scorer' },
  multiwfn: { field: '#run-multiwfn', marker: '#run-multiwfn-detected', label: 'Multiwfn' },
  tautomer: { field: '#run-tautomer', marker: '#run-tautomer-detected', label: 'Tautomer sidecar' },
});

/** The platform main reports, falling back to the user agent before it lands. */
function rendererPlatform() {
  const reported = state.engineStatus?.platform;
  if (reported === 'win32' || reported === 'darwin' || reported === 'linux') return reported;
  const agent = String(globalThis.navigator?.userAgent || '');
  if (/Windows/i.test(agent)) return 'win32';
  if (/Macintosh|Mac OS X/i.test(agent)) return 'darwin';
  return 'linux';
}

/**
 * Seed CREST, Open Babel, the scorer and the tautomer interpreter from the
 * same detection answer as the engine field. A stored/typed path is never
 * overwritten; an undetected tool says so instead of showing a Windows path
 * on Linux (issue 258).
 */
function syncCompanionExecutables() {
  const platform = rendererPlatform();
  const status = state.engineStatus;
  for (const [toolId, ui] of Object.entries(COMPANION_FIELDS)) {
    const input = $(ui.field);
    if (!input) continue;
    input.placeholder = companionPlaceholderFor(toolId, platform);
    if (!input.value.trim() && document.activeElement !== input) {
      const seed = companionSeed({ toolId, stored: '', status });
      if (seed.detected) input.value = seed.value;
    }
    const marker = $(ui.marker);
    if (!marker) continue;
    const visible = input.value.trim();
    const detected = detectedCompanionPath(status, toolId);
    const isDetected = Boolean(detected) && visible === detected;
    const settingsPath = String(state.appSettings?.tools?.[toolId] || '').trim();
    const fromSettings = Boolean(settingsPath) && visible === settingsPath && !isDetected;
    const missing = Boolean(status) && !visible && !detected;
    marker.hidden = !isDetected && !fromSettings && !missing;
    marker.textContent = isDetected ? 'detected' : (fromSettings ? 'from Settings' : (missing ? 'not found on PATH' : ''));
    marker.classList.toggle('is-missing', missing && !fromSettings);
    marker.title = isDetected
      ? `Detected at ${detected}`
      : fromSettings
        ? `Settings → Tools: ${settingsPath}`
        : (missing ? `No ${ui.label} found on PATH; use Browse to choose it.` : '');
  }
}

/** Issue 256: the hint line reports an outcome until the next run starts. */
function renderRunHint() {
  const hint = $('#run-hint');
  if (!hint) return;
  hint.classList.remove('is-warn');
  if (!state.run.hintPinned) {
    hint.textContent = desktop ? dryRunHintFor(activeRunEngineId()) : BROWSER_PREVIEW_CONSOLE_HINT;
    if (!desktop) hint.classList.add('is-warn');
    return;
  }
  hint.textContent = state.run.hintText || '';
  if (state.run.hintWarn) hint.classList.add('is-warn');
  const action = state.run.hintAction;
  if (!action) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn small run-hint-action';
  button.dataset.action = 'failure-fix';
  button.textContent = action.label;
  if (action.kind) button.dataset.fixKind = action.kind;
  if (action.field) button.dataset.fixField = action.field;
  if (action.nodeId) button.dataset.fixNode = action.nodeId;
  if (action.nodeTitle) button.dataset.fixTitle = action.nodeTitle;
  if (action.taskId) button.dataset.fixTask = action.taskId;
  hint.appendChild(button);
}

function setRunHint(text, { warn = false, action = null } = {}) {
  state.run.hintPinned = true;
  state.run.hintText = String(text || '');
  state.run.hintWarn = Boolean(warn);
  state.run.hintAction = action;
  renderRunHint();
}

function clearRunHint() {
  state.run.hintPinned = false;
  state.run.hintText = '';
  state.run.hintWarn = false;
  state.run.hintAction = null;
  renderRunHint();
}

/** Point the run-console copy at the engine the selected block will run. */
function updateRunConsoleCopy() {
  const engineId = activeRunEngineId();
  const label = $('#run-exe-label');
  if (label) label.textContent = executableLabelFor(engineId);
  const executable = $('#run-exe');
  if (executable) {
    executable.placeholder = executablePlaceholderFor(engineId);
    // Follow the selected block's engine, but never overwrite a path the user
    // is typing into the field right now. Issue issue 233: a stored path wins; on a
    // fresh profile, use the path the app already detected and say so.
    if (document.activeElement !== executable) {
      executable.value = executableSeed({
        engineId,
        stored: storedExecutables(),
        status: state.engineStatus,
      }).value;
    }
    syncRunExecutableDetected(engineId);
  }
  // Issue 256: an outcome hint belongs to the run that just finished, so a
  // later selection change refreshes the copy around it without erasing it.
  renderRunHint();
  const engineChip = $('#run-engine');
  if (engineChip) engineChip.textContent = engineOrDefault(engineId).label;
  const modeChip = $('#run-mode');
  const dry = $('#run-dry');
  if (modeChip && dry) {
    const isDry = dry.checked === true;
    modeChip.textContent = isDry ? 'dry run · fixture' : 'real run';
    modeChip.classList.toggle('is-dry', isDry);
    modeChip.title = isDry
      ? 'Dry run writes synthetic fixture output. Uncheck to run the engine.'
      : 'A real engine binary will be launched.';
  }
  syncCompanionExecutables();
}

/** Queue progress for the console header, e.g. `7/16`. */
function updateRunProgressChip() {
  const chip = $('#run-progress');
  if (!chip) return;
  const tasks = Array.isArray(state.queue?.tasks) ? state.queue.tasks : [];
  const total = tasks.length;
  const done = tasks.filter((task) => ['completed', 'failed', 'skipped', 'blocked', 'cancelled', 'timed out'].includes(task.status)).length;
  chip.hidden = total === 0;
  chip.textContent = `${done}/${total}`;
  chip.classList.toggle('is-live', /^(running|queued)$/.test(String(state.queue?.status || '')));
}

/**
 * The runner settings that belong to a queue: concurrency and the per-task wall
 * clock (issue 177). They are synced together because they are read together.
 */
function syncRunnerInputs() {
  syncMaxParallelInput();
  syncTimeoutInput();
  // Issue 143: the estimate depends on both fields, so it is refreshed with
  // them rather than on a separate control.
  updateCostEstimate();
}

function syncMaxParallelInput() {
  const input = $('#run-max-parallel');
  if (!input) return;
  const value = Math.max(1, Math.min(Number(state.project?.runner?.maxParallel) || 1, LIMITS.maxParallel));
  input.value = String(value);
  const empty = document.querySelector('#queue-list .queue-empty');
  if (empty) {
    empty.textContent = value > 1
      ? `Queue the workflow to run calculation blocks in dependency order, up to ${value} at a time.`
      : 'Queue the workflow to run calculation blocks in dependency order, one at a time.';
  }
}

/**
 * The queue's degree of parallelism. The control edits the project setting as
 * well, so a saved project keeps the value the next run will use.
 */
function applyMaxParallel(value) {
  const clamped = Math.max(1, Math.min(Number(value) || 1, LIMITS.maxParallel));
  if (!state.project.runner || typeof state.project.runner !== 'object') state.project.runner = {};
  state.project.runner.maxParallel = clamped;
  const input = $('#run-max-parallel');
  if (input) input.value = String(clamped);
  refreshDirty();
  updateCostEstimate();
  return clamped;
}

function maxParallelForQueue() {
  const input = $('#run-max-parallel');
  const value = input ? Number(input.value) : Number(state.project?.runner?.maxParallel);
  return applyMaxParallel(Number.isFinite(value) && value > 0 ? value : 1);
}

/**
 * The wall-clock limit a queued task gets when neither the block nor the
 * project names one (issue 177). Kept in step with `DEFAULT_TIMEOUT_SECONDS` in
 * the queue, which is where it is actually enforced; this copy only labels the
 * empty field so the user knows what "blank" means.
 */
const DEFAULT_TASK_TIMEOUT_SECONDS = 3600;

/**
 * Show the project's per-task limit. Absent is not a value: the field stays
 * empty and its placeholder says which default applies, so a project that never
 * set one keeps no key in the file.
 */
function syncTimeoutInput() {
  const input = $('#run-timeout');
  if (!input) return;
  const configured = Number(state.project?.runner?.timeoutSeconds);
  const fromSettings = Number(state.appSettings?.runs?.timeoutSeconds);
  const fallback = Number.isInteger(fromSettings) && fromSettings >= 1
    ? Math.min(fromSettings, LIMITS.timeoutSeconds) : 0;
  input.value = Number.isInteger(configured) && configured >= 1
    ? String(configured)
    : (fallback ? String(fallback) : '');
  input.placeholder = `${DEFAULT_TASK_TIMEOUT_SECONDS} (default)`;
  updateTimeoutHint();
}

/**
 * Apply one wall-clock limit to the project. An empty or invalid value removes
 * the setting instead of writing a default, so the saved project stays
 * byte-identical to one written before this setting existed.
 */
function applyTimeout(value) {
  const text = String(value ?? '').trim();
  if (!state.project.runner || typeof state.project.runner !== 'object') state.project.runner = {};
  const input = $('#run-timeout');
  if (text === '') {
    delete state.project.runner.timeoutSeconds;
    if (input) input.value = '';
    refreshDirty();
    updateCostEstimate();
    return null;
  }
  const seconds = Math.trunc(Number(text));
  if (!Number.isFinite(seconds) || seconds < 1) {
    // Refuse rather than clamp silently: a limit the user did not choose is a
    // number the queue would then enforce against their expectation.
    if (input) input.value = state.project.runner.timeoutSeconds ? String(state.project.runner.timeoutSeconds) : '';
    return state.project.runner.timeoutSeconds ?? null;
  }
  const clamped = Math.min(seconds, LIMITS.timeoutSeconds);
  state.project.runner.timeoutSeconds = clamped;
  if (input) input.value = String(clamped);
  updateTimeoutHint();
  refreshDirty();
  updateCostEstimate();
  return clamped;
}

/** The project's limit for a queue, or null when it was never set. */
function timeoutForQueue() {
  const input = $('#run-timeout');
  const fromSettings = Number(state.appSettings?.runs?.timeoutSeconds);
  const settingsLimit = Number.isInteger(fromSettings) && fromSettings >= 1
    ? Math.min(fromSettings, LIMITS.timeoutSeconds) : null;
  if (!input) {
    return Number.isInteger(Number(state.project?.runner?.timeoutSeconds))
      ? Number(state.project.runner.timeoutSeconds) : settingsLimit;
  }
  const stored = Number(state.project?.runner?.timeoutSeconds);
  const text = String(input.value ?? '').trim();
  if (text === '') return Number.isInteger(stored) ? applyTimeout('') : settingsLimit;
  const value = Math.trunc(Number(text));
  // A queue start must not mark the project dirty for a value it already has.
  if (!Number.isFinite(value) || value < 1) return Number.isInteger(stored) ? stored : settingsLimit;
  // The field is showing the Settings default, not a project override; use it
  // without writing a per-run value into the project.
  if (!Number.isInteger(stored) && settingsLimit !== null && value === settingsLimit) return settingsLimit;
  return value === stored ? stored : applyTimeout(text);
}

/**
 * The limit for one block: its own value first, then the project's, then the
 * default. Mirrors `QueueManager.taskTimeoutSeconds()` so a single-block run and
 * a queued run stop at the same hour.
 */
function timeoutForNode(node) {
  const own = Number(node?.settings?.timeoutSeconds);
  if (Number.isInteger(own) && own >= 1) return Math.min(own, LIMITS.timeoutSeconds);
  return timeoutForQueue() ?? DEFAULT_TASK_TIMEOUT_SECONDS;
}

/** The limit the Setup field currently means, without editing the project. */
function configuredTimeoutSeconds() {
  const input = $('#run-timeout');
  const value = input ? Math.trunc(Number(input.value)) : Number(state.project?.runner?.timeoutSeconds);
  return Number.isFinite(value) && value >= 1
    ? Math.min(value, LIMITS.timeoutSeconds) : DEFAULT_TASK_TIMEOUT_SECONDS;
}

/**
 * Why a block looks like a long run (issue 177), from its own parameters.
 *
 * Deliberately not an estimate: this says *which* parameters make a block
 * expensive (many excited states, an IRC path, a big frequency job) so the user
 * can raise its limit before starting. It never prints a predicted duration —
 * nobody measured one.
 */
function longRunReason(node) {
  if (!node || (node.type !== 'calculate' && node.type !== 'generate')) return '';
  const s = node.settings || {};
  const atoms = Number(state.project?.molecule?.coords?.length) || 0;
  const states = Number(s.tdStates) || 0;
  const jobType = String(s.jobType || '');
  const reasons = [];
  if (states >= 10) reasons.push(`${states} excited states`);
  if (jobType.startsWith('IRC')) reasons.push('an IRC path');
  if (jobType === 'Opt=TS' || jobType === 'Opt=QST2' || jobType === 'Opt=QST3') reasons.push('a transition-state search');
  if (Number(s.counterpoise) > 1) reasons.push(`counterpoise over ${Number(s.counterpoise)} fragments`);
  if (/Freq/.test(jobType) && atoms >= 30) reasons.push(`a frequency job on ${atoms} atoms`);
  if (node.type === 'generate' && s.generator === 'crest' && !s.member) {
    reasons.push(`a CREST search for up to ${Number(s.maxConformers) || 20} conformers`);
  }
  return reasons.join(', ');
}

/**
 * Say which blocks look like long runs, and at what limit they will be stopped.
 * Shown in Setup beside the field so the limit can be chosen before the run.
 */
function updateTimeoutHint() {
  const el = $('#run-timeout-hint');
  if (!el) return;
  const long = (state.project?.nodes || [])
    .map((node) => ({ node, reason: longRunReason(node) }))
    .filter((entry) => entry.reason);
  if (long.length === 0) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-budget');
    return;
  }
  const limit = configuredTimeoutSeconds();
  const named = long.slice(0, 3)
    .map((entry) => `${entry.node.title} (${entry.reason})`)
    .join('; ');
  const more = long.length > 3 ? ` and ${long.length - 3} more` : '';
  const raised = long.filter((entry) => Number(entry.node.settings?.timeoutSeconds) > limit);
  el.hidden = false;
  el.classList.add('is-budget');
  el.textContent = `${countLabel(long.length, 'block')} ${long.length === 1 ? 'here looks like a long run' : 'here look like long runs'}: ${named}${more}. `
    + `Each task is stopped at ${limit} s${raised.length > 0 ? ' unless its own Time limit is higher' : ''}. `
    + 'Raise the limit or set one on the block before starting.';
}

/**
 * Price the active flow before it is queued (issue 143).
 *
 * This is the decision the Setup pane is for: how long the whole flow takes,
 * whether the per-task limit will stop one of its blocks, and whether the run
 * is longer than an overnight. Refusals are shown with their reason instead of
 * being left out of a total that would then look smaller than the run.
 */
function configuredMaxParallel() {
  const input = $('#run-max-parallel');
  const value = input ? Number(input.value) : Number(state.project?.runner?.maxParallel);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, LIMITS.maxParallel) : 1;
}

function updateCostEstimate() {
  const el = $('#run-cost-estimate');
  if (!el) return;
  if (!state.project) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.classList.remove('is-warn');
  let plan = null;
  try {
    plan = shared.buildWorkflowPlan(state.project);
  } catch (error) {
    el.textContent = `No estimate: ${error.message}`;
    return;
  }
  const cores = hostCoreCount();
  const maxParallel = configuredMaxParallel();
  const estimate = estimateCost(state.project, plan, {
    cores,
    maxParallel,
    timeoutSeconds: configuredTimeoutSeconds(),
  });
  const basis = [...(estimate.total.basis || [])];
  el.title = basis.join(' ');
  if (estimate.total.notEstimated) {
    el.textContent = `No estimate: ${estimate.total.notEstimated}`;
    return;
  }
  const total = estimate.total;
  const parts = [
    `Estimated ${formatCostRange(total.wallSeconds)} on ${cores} cores at ${maxParallel} at a time`,
    `${total.confidence} confidence (${total.calibrationPoints} point${total.calibrationPoints === 1 ? '' : 's'})`,
    `${total.estimatedTasks} of ${total.estimatedTasks + total.unestimatedTasks} tasks priced`,
  ];
  if (total.unestimatedTasks > 0) parts.push(`${total.unestimatedTasks} not priced`);
  if (total.exceedsAnyTimeout) {
    const worst = total.exceedingTasks.slice(0, 2)
      .map((entry) => `${entry.title} (${formatCostDuration(entry.limitSeconds)} limit)`)
      .join(', ');
    parts.push(`${worst} will be stopped at the limit`);
    el.classList.add('is-warn');
  } else if (total.wallSeconds.high > 8 * 3600 && !total.exceedsOvernight) {
    parts.push('the upper bound is longer than an overnight (8 h) run');
  }
  if (total.exceedsOvernight) {
    parts.push('longer than an overnight (8 h) run');
    el.classList.add('is-warn');
  }
  el.textContent = `${parts.join(' · ')}.`;
}

const RUN_CONSOLE_RECT_KEY = 'nodechem-studio.run-console-pos';

function readStoredRunConsoleRect() {
  try {
    return readFloatingRect(JSON.parse(localStorage.getItem(RUN_CONSOLE_RECT_KEY) || 'null'));
  } catch {
    return null;
  }
}

function storeRunConsoleRect(rect) {
  if (!rect) return;
  try {
    localStorage.setItem(RUN_CONSOLE_RECT_KEY, JSON.stringify(rect));
  } catch {
    // Window position is a convenience, not state the app depends on.
  }
}

function forgetRunConsoleRect() {
  try {
    localStorage.removeItem(RUN_CONSOLE_RECT_KEY);
  } catch {
    // nothing to clear
  }
}

function runConsoleViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Put the console at a geometry and keep it fully reachable. */
function applyRunConsoleRect(consoleEl, rect) {
  const next = clampFloatingRect(rect, runConsoleViewport(), {
    margin: 8,
    minWidth: 420,
    minHeight: 280,
    headerHeight: 56,
  });
  consoleEl.classList.add('is-floating');
  consoleEl.style.left = `${next.x}px`;
  consoleEl.style.top = `${next.y}px`;
  consoleEl.style.right = 'auto';
  consoleEl.style.bottom = 'auto';
  consoleEl.style.width = `${next.width}px`;
  consoleEl.style.height = `${next.height}px`;
  consoleEl.style.maxHeight = 'none';
  state.runConsoleRect = next;
  return next;
}

function placeRunConsole() {
  const consoleEl = $('#run-console');
  if (!consoleEl) return;
  // Issue 252: Settings → Appearance can make the corner authoritative.
  if (state.appSettings?.appearance?.runConsoleDock === true) {
    dockRunConsole();
    return;
  }
  const stored = state.runConsoleRect || readStoredRunConsoleRect();
  if (!stored) return;
  applyRunConsoleRect(consoleEl, stored);
}

/** Return the window to its CSS corner and forget the custom geometry. */
function dockRunConsole() {
  const consoleEl = $('#run-console');
  state.runConsoleRect = null;
  state.runConsoleDrag = null;
  document.body.classList.remove('is-dragging-run-console');
  forgetRunConsoleRect();
  if (!consoleEl) return;
  consoleEl.classList.remove('is-floating');
  for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height', 'maxHeight']) {
    consoleEl.style[property] = '';
  }
}

function beginRunConsoleDrag(event) {
  const head = event.target?.closest?.('.run-head');
  if (!head || event.target.closest('button, input, select, textarea, a')) return;
  if (window.innerWidth <= 820) return;
  const consoleEl = $('#run-console');
  if (!consoleEl || consoleEl.hidden) return;
  const rect = consoleEl.getBoundingClientRect();
  applyRunConsoleRect(consoleEl, {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  });
  state.runConsoleDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  document.body.classList.add('is-dragging-run-console');
  event.preventDefault();
}

function moveRunConsoleDrag(event) {
  if (!state.runConsoleDrag) return;
  const consoleEl = $('#run-console');
  if (!consoleEl) return;
  state.runConsoleRect = clampFloatingRect({
    x: event.clientX - state.runConsoleDrag.offsetX,
    y: event.clientY - state.runConsoleDrag.offsetY,
    width: state.runConsoleRect?.width,
    height: state.runConsoleRect?.height,
  }, runConsoleViewport(), {
    margin: 8,
    minWidth: 420,
    minHeight: 280,
    headerHeight: 56,
  });
  applyRunConsoleRect(consoleEl, state.runConsoleRect);
}

function endRunConsoleDrag() {
  if (!state.runConsoleDrag) return;
  state.runConsoleDrag = null;
  document.body.classList.remove('is-dragging-run-console');
  storeRunConsoleRect(state.runConsoleRect);
}

/** Native CSS resize changes the box; remember it on pointer-up. */
function persistRunConsoleSize() {
  if (state.runConsoleDrag) return;
  const consoleEl = $('#run-console');
  if (!consoleEl || consoleEl.hidden || !consoleEl.classList.contains('is-floating')) return;
  const rect = consoleEl.getBoundingClientRect();
  state.runConsoleRect = clampFloatingRect({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }, runConsoleViewport(), {
    margin: 8,
    minWidth: 420,
    minHeight: 280,
    headerHeight: 56,
  });
  storeRunConsoleRect(state.runConsoleRect);
}

/** A smaller display must not strand a floating console off-screen. */
function clampRunConsoleToViewport() {
  if (!state.runConsoleRect) return;
  const consoleEl = $('#run-console');
  if (!consoleEl || consoleEl.hidden) return;
  applyRunConsoleRect(consoleEl, state.runConsoleRect);
  storeRunConsoleRect(state.runConsoleRect);
}

function openRunConsole() {
  const consoleEl = $('#run-console');
  if (!consoleEl) return;
  consoleEl.hidden = false;
  placeRunConsole();
  // A fresh console starts following the run, not a section picked last time.
  state.runPanePinned = false;
  const results = $('#run-results');
  setRunPane(results && !results.hidden ? 'results' : 'setup');
  updateRunConsoleCopy();
  updateRunTabBadges();
  $('#run-state').focus?.();
  if (!desktop) {
    $('#run-hint').textContent = BROWSER_PREVIEW_CONSOLE_HINT;
    $('#run-hint').classList.add('is-warn');
  }
}

function closeRunConsole() {
  const consoleEl = $('#run-console');
  if (consoleEl) consoleEl.hidden = true;
  if (state.runConsoleRect) storeRunConsoleRect(state.runConsoleRect);
}

/* ── Run console sections ─────────────────────────────────── */

/**
 * The console is one window with three jobs: configure a run, watch the queue,
 * read the result. Showing all of them at once made every one of them cramped,
 * so they are tabs and the app switches to the one the moment belongs to.
 */
function setRunPane(pane, { user = false } = {}) {
  const consoleEl = $('#run-console');
  if (!consoleEl) return;
  const allowed = ['setup', 'queue', 'results'];
  const next = allowed.includes(pane) ? pane : 'setup';
  if (user) state.runPanePinned = true;
  consoleEl.dataset.pane = next;
  for (const tab of document.querySelectorAll('#run-tabs [data-run-tab]')) {
    const active = tab.dataset.runTab === next;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
}

/** Auto-switch only while the user has not pinned a section by clicking one. */
function autoRunPane(pane) {
  if (state.runPanePinned) return;
  setRunPane(pane);
}

/** Badges: task progress on Queue, a dot on Results when a table is shown. */
function updateRunTabBadges() {
  const badge = $('#run-tab-queue-badge');
  if (badge) {
    const tasks = Array.isArray(state.queue?.tasks) ? state.queue.tasks : [];
    const total = tasks.length;
    const done = tasks.filter((task) => ['completed', 'failed', 'skipped', 'blocked', 'cancelled', 'timed out'].includes(task.status)).length;
    badge.hidden = total === 0;
    badge.textContent = `${done}/${total}`;
  }
  const dot = $('#run-tab-results-dot');
  const results = $('#run-results');
  const hasResults = Boolean(results && !results.hidden);
  if (dot) dot.hidden = !hasResults;
  const resultsTab = document.querySelector('[data-run-tab="results"]');
  if (resultsTab) {
    resultsTab.classList.toggle('is-disabled', !hasResults);
    resultsTab.setAttribute('aria-disabled', String(!hasResults));
    resultsTab.title = hasResults ? 'Parsed results of the last run' : 'No parsed results yet — run a block';
  }
}

function setRunState(status, label) {
  state.run.status = status;
  const el = $('#run-state');
  if (!el) return;
  el.textContent = label || status;
  el.className = `run-state is-${status}`;
}

const RUN_HEADER_IDLE = Object.freeze({ status: 'idle', label: 'idle', progress: '0/0' });

/**
 * Issue 255: a queue names the project and flow it was started from, and only
 * that queue may speak for the console on screen. Matching by name is what the
 * reported build lacked: a completed 16-task queue painted its state over a
 * freshly opened project whose own queue had failed.
 */
function queueBelongsToProject(queue, project = state.project) {
  if (!queue || !project) return false;
  const queueName = String(queue.projectName || '').trim();
  const projectName = String(project.name || '').trim();
  if (!queueName || !projectName || queueName !== projectName) return false;
  const queueFlow = String(queue.flowId || '').trim();
  const projectFlow = String(activeFlowId(project) || '').trim();
  // A single-flow project has nothing to disambiguate. With several flows the
  // queue's flow has to be the one the window is showing, or switching tabs
  // would leave another flow's progress in the header.
  const flowCount = Array.isArray(project.flows) ? project.flows.length : 0;
  if (queueFlow && projectFlow && flowCount > 1 && queueFlow !== projectFlow) return false;
  return true;
}

/**
 * What a queue is allowed to paint in the header. `paint: false` is the answer
 * for a queue from another project (and for a finished queue whose state is
 * restored only to populate the Queue tab): the caller leaves the visible
 * header alone rather than copying someone else's numbers.
 */
function runHeaderFor(queue, project = state.project) {
  if (!queueBelongsToProject(queue, project)) return { paint: false, ...RUN_HEADER_IDLE };
  const status = String(queue.status || 'idle');
  if (!['running', 'queued', 'paused', 'completed', 'failed', 'cancelled', 'partial'].includes(status)) {
    return { paint: false, ...RUN_HEADER_IDLE };
  }
  const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const done = tasks.filter((task) => ['completed', 'failed', 'skipped', 'blocked', 'cancelled', 'timed out'].includes(task.status)).length;
  return { paint: true, status, label: status, progress: `${done}/${tasks.length}` };
}

function emptyQueueState() {
  return {
    id: null,
    status: 'idle',
    flowId: null,
    projectName: null,
    createdAt: null,
    finishedAt: null,
    tasks: [],
    reason: null,
    timeoutSeconds: null,
    spins: {},
  };
}

/**
 * Issue 255: every path that swaps the project in memory must clear the run
 * console first. Returns the queue that was on screen so the caller can name it
 * as the last foreign run after the new project is in place.
 */
function resetRunConsoleForProjectSwap() {
  const previousQueue = state.queue?.id ? { ...state.queue } : null;
  resetRunHeader({ ignoreEvents: true });
  state.queue = emptyQueueState();
  state.lastForeignQueue = null;
  clearRunHint();
  renderQueue();
  updateRunTabBadges();
  renderRunLast();
  return previousQueue;
}

/** Reset the console header to the empty project state (issue 255). */
function resetRunHeader({ ignoreEvents = false } = {}) {
  state.run.id = null;
  state.run.dir = null;
  state.run.nodeId = null;
  state.run.gates = [];
  state.run.validity = [];
  state.run.ignoreEvents = ignoreEvents;
  setRunState('idle', 'idle');
  const title = $('#run-title');
  if (title) title.textContent = 'No run yet';
  const progress = $('#run-progress');
  if (progress) {
    progress.hidden = true;
    progress.textContent = RUN_HEADER_IDLE.progress;
    progress.classList.remove('is-live');
  }
}

/** Issue 255: name the last queue when it belongs to another project. */
function noteForeignQueue(queue) {
  if (!queue?.id) return;
  state.lastForeignQueue = {
    id: queue.id || null,
    projectName: String(queue.projectName || '').trim() || 'Untitled project',
    status: queue.status || 'idle',
    createdAt: queue.createdAt || null,
    flowId: queue.flowId || null,
  };
  renderRunLast();
}

function renderRunLast() {
  const el = $('#run-last');
  if (!el) return;
  const foreign = state.lastForeignQueue;
  // A queue that belongs to the open project is already on screen; the note is
  // only for the one that does not.
  const visible = Boolean(foreign) && !state.queue?.id;
  el.hidden = !visible;
  el.textContent = visible ? `last run: ${foreign.projectName} (other project)` : '';
  if (visible) {
    el.title = `The last queue belongs to ${foreign.projectName}; its state is not shown for the open project.`;
  } else {
    el.removeAttribute('title');
  }
}

function setStatusMessage(text) {
  state.statusMessage = text;
  const el = $('#status-message');
  if (el) el.textContent = text;
}

function appendRunOutput(text) {
  if (!text) return;
  state.run.output = `${state.run.output}${text}`.slice(-60000);
  const el = $('#run-output');
  if (!el) return;
  el.textContent = state.run.output || 'Waiting for output…';
  el.scrollTop = el.scrollHeight;
}

function renderRunGates(gates = [], validity = null) {
  state.run.gates = gates;
  state.run.validity = Array.isArray(validity?.findings) ? validity.findings : [];
  const el = $('#run-gates');
  if (!el) return;
  const chips = gates.map((gate) => (
    `<span class="run-gate ${esc(gate.result)}" title="${esc(gate.detail || '')}">${esc(gate.name)} · ${esc(gate.result)}</span>`
  ));
  // Issue #25: validity findings sit next to the gates but never change the
  // gate verdict. A warning is rendered in the amber tone; a failure in red.
  const findings = state.run.validity.filter((finding) => (
    finding.status !== CHECK_STATUS.PASS && finding.status !== CHECK_STATUS.SKIPPED
  ));
  for (const finding of findings) {
    const tone = finding.status === CHECK_STATUS.WARNING ? 'unknown' : finding.status;
    const detail = `${finding.severity ? `${finding.severity} — ` : ''}${finding.message || ''}`;
    chips.push(`<span class="run-gate ${esc(tone)}" title="${esc(detail)}">${esc(finding.title || finding.id)} · ${esc(finding.status)}</span>`);
  }
  if (validity && findings.length === 0) {
    chips.push(`<span class="run-gate ${validity.overall === 'pass' ? 'pass' : 'unknown'}" title="Issue #25 validity checks ran on the parsed records">validity · ${esc(validity.overall)}</span>`);
  }
  el.innerHTML = chips.join('');
}

// Persisted preference key for the run console.
const RUN_CONFIG_STORAGE_KEY = 'nodechem-studio.run-config';

/**
 * One executable per engine, not one per app (#98 follow-up).
 *
 * A project can mix engines — an xTB optimisation feeding a Psi4 single point —
 * and each task must be launched with its own binary. The field under the run
 * console therefore shows the engine of the selected block (or the project
 * default), and every path is stored per engine so a mixed flow has them all.
 */
function storedRunConfig() {
  try {
    return JSON.parse(localStorage.getItem(RUN_CONFIG_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function storedExecutables() {
  const saved = storedRunConfig();
  const map = saved.executables && typeof saved.executables === 'object' ? { ...saved.executables } : {};
  // Migrate the single-path shape written by earlier builds.
  if (!saved.executables && saved.executable) map[engineOrDefault(state.project?.defaults?.engine).id] = saved.executable;
  return map;
}

/** The engine whose executable the console's single field is editing. */
function activeRunEngineId() {
  const selected = state.selected?.type === 'node' ? nodeById(state.selected.id) : null;
  if (selected && selected.type === 'calculate') return engineForNode(state.project, selected).id;
  return engineOrDefault(state.project?.defaults?.engine).id;
}

/**
 * Issue 252: the effective map is Settings first, then a local per-run
 * override. A fresh profile with Settings configured therefore needs no path
 * typed into the console.
 */
function runExecutables() {
  const map = engineExecutableMap(state.appSettings, storedExecutables());
  const engineId = activeRunEngineId();
  const field = $('#run-exe');
  if (field) {
    const typed = field.value.trim();
    if (typed) map[engineId] = typed;
  }
  return map;
}

function readRunConfig() {
  const saved = storedRunConfig();
  const seed = runFieldSeed({ settings: state.appSettings, saved });
  if ($('#run-crest')) $('#run-crest').value = seed.crest;
  if ($('#run-obabel')) $('#run-obabel').value = seed.obabel;
  if ($('#run-scorer')) $('#run-scorer').value = seed.scorer;
  // Issue 270: the Multiwfn sidecar is user-installed and seeded like the
  // other companion programs; an explicit local path still wins.
  if ($('#run-multiwfn')) $('#run-multiwfn').value = seed.multiwfn;
  // Issue 226: the tautomer sidecar is remembered like the other programs.
  if ($('#run-tautomer')) $('#run-tautomer').value = seed.tautomer;
  if ($('#run-tautomer-script')) $('#run-tautomer-script').value = seed.tautomerScript;
  if ($('#run-scratch')) $('#run-scratch').value = seed.scratch;
  if ($('#run-dry')) $('#run-dry').checked = seed.dryRun;
  const field = $('#run-exe');
  if (field) {
    field.value = executableSeed({
      engineId: activeRunEngineId(),
      stored: engineExecutableMap(state.appSettings, storedExecutables()),
      status: state.engineStatus,
    }).value;
  }
  syncCompanionExecutables();
}

const RUN_TOOL_FIELDS = Object.freeze(['crest', 'obabel', 'scorer', 'multiwfn', 'tautomer', 'tautomerScript', 'scratch']);

function saveRunConfig() {
  try {
    // Only values that differ from Settings are stored: a console field that
    // merely echoes Settings must not shadow a later Settings change.
    const engineValues = { ...storedExecutables() };
    const engineId = activeRunEngineId();
    const field = $('#run-exe');
    if (field) {
      const typed = field.value.trim();
      if (typed) engineValues[engineId] = typed;
      else delete engineValues[engineId];
    }
    const executables = localOverrides(engineValues, state.appSettings?.engines, Object.keys(ENGINES));
    const toolValues = {
      crest: $('#run-crest')?.value.trim() || '',
      obabel: $('#run-obabel')?.value.trim() || '',
      scorer: $('#run-scorer')?.value.trim() || '',
      multiwfn: $('#run-multiwfn')?.value.trim() || '',
      tautomer: $('#run-tautomer')?.value.trim() || '',
      tautomerScript: $('#run-tautomer-script')?.value.trim() || '',
      scratch: $('#run-scratch')?.value.trim() || '',
    };
    const tools = localOverrides(toolValues, state.appSettings?.tools, RUN_TOOL_FIELDS);
    const dry = $('#run-dry')?.checked !== false;
    const payload = {
      executables,
      crestExecutable: tools.crest || '',
      obabelExecutable: tools.obabel || '',
      scorerExecutable: tools.scorer || '',
      multiwfnExecutable: tools.multiwfn || '',
      tautomerExecutable: tools.tautomer || '',
      tautomerScript: tools.tautomerScript || '',
      scratchDir: tools.scratch || '',
    };
    if (typeof state.appSettings?.runs?.dryRun !== 'boolean' || dry !== state.appSettings.runs.dryRun) {
      payload.dryRun = dry;
    }
    localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Preferences are optional.
  }
}

async function pickGaussian() {
  if (!desktop) { toast('Open the Electron app to choose an executable.'); return; }
  try {
    const engine = engineOrDefault(activeRunEngineId());
    const selected = await desktop.pickExecutable({ engine: engine.id });
    if (selected) {
      $('#run-exe').value = selected;
      saveRunConfig();
      toast(`${engine.label} executable selected.`);
    } else {
      // A cancelled picker must not leave the field blank when the engine was
      // already detected (issue issue 233).
      updateRunConsoleCopy();
    }
  } catch (error) {
    toast(`Could not choose executable: ${error.message}`);
  }
}

async function pickObabel() {
  if (!desktop?.pickObabelExecutable) { toast('Open the Electron app to choose an executable.'); return; }
  try {
    const selected = await desktop.pickObabelExecutable();
    if (selected) {
      $('#run-obabel').value = selected;
      saveRunConfig();
      toast('Open Babel executable selected.');
    }
    syncCompanionExecutables();
  } catch (error) {
    toast(`Could not choose the Open Babel executable: ${error.message}`);
  }
}

async function pickCrest() {
  if (!desktop?.pickCrestExecutable) { toast('Open the Electron app to choose an executable.'); return; }
  try {
    const selected = await desktop.pickCrestExecutable();
    if (selected) {
      $('#run-crest').value = selected;
      saveRunConfig();
      toast('CREST executable selected.');
    }
    syncCompanionExecutables();
  } catch (error) {
    toast(`Could not choose the CREST executable: ${error.message}`);
  }
}

/** issue 258: the scorer and tautomer fields use one generic executable picker. */
async function pickCompanionTool(toolId) {
  const ui = COMPANION_FIELDS[toolId];
  if (!ui) return;
  if (!desktop?.pickToolExecutable) { toast('Open the Electron app to choose an executable.'); return; }
  try {
    const selected = await desktop.pickToolExecutable(toolId);
    if (selected) {
      $(ui.field).value = selected;
      saveRunConfig();
      toast(`${ui.label} selected.`);
    }
    syncCompanionExecutables();
  } catch (error) {
    toast(`Could not choose ${ui.label}: ${error.message}`);
  }
}

/**
 * Issue 256: the three common failures each have a control that fixes them.
 * These helpers are the "where to look" half; the hint text is the "what
 * happened" half.
 */
function selectNodeForTask(taskId) {
  const base = String(taskId || '').split('~')[0];
  if (!base) return null;
  const node = nodeById(base);
  if (node) selectNode(node.id);
  return node;
}

function focusRunField(selector, taskId = '') {
  selectNodeForTask(taskId);
  setRunPane('setup');
  updateRunConsoleCopy();
  const field = $(selector) || $('#run-exe');
  if (!field) return;
  field.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  field.focus?.();
}

function focusConformerSource(nodeId, nodeTitle = '') {
  let target = nodeId ? nodeById(nodeId) : null;
  if (!target && nodeTitle) {
    target = state.project.nodes.find((node) => node.type === 'generate' && node.title === nodeTitle) || null;
  }
  if (!target) target = state.project.nodes.find((node) => node.type === 'generate') || null;
  if (target) selectNode(target.id);
  setRunPane('setup');
  const control = $('#inspector [data-action="select-conformer"]')
    || $('#inspector [data-conformer-field="produces"]')
    || $('#inspector');
  if (!control) return;
  if (!control.matches?.('button, select, input, [tabindex]')) control.setAttribute('tabindex', '-1');
  control.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  control.focus?.();
}

function focusQueueTask(taskId) {
  setRunPane('queue');
  const base = String(taskId || '').split('~')[0];
  const row = [...document.querySelectorAll('#queue-list .queue-item')]
    .find((item) => item.dataset.nodeId === taskId || item.dataset.nodeId === base) || null;
  if (row) {
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    row.focus?.();
    return;
  }
  const gate = $('#run-gates .run-gate.fail');
  if (gate) {
    gate.setAttribute('tabindex', '-1');
    gate.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    gate.focus?.();
  }
}

function applyRunHintFix(button) {
  const kind = button?.dataset?.fixKind;
  if (kind === 'executable') {
    focusRunField(button.dataset.fixField || '#run-exe', button.dataset.fixTask || '');
    return;
  }
  if (kind === 'conformer') {
    focusConformerSource(button.dataset.fixNode || '', button.dataset.fixTitle || '');
    return;
  }
  if (kind === 'gate') {
    focusQueueTask(button.dataset.fixTask || '');
  }
}

/**
 * Pick a member of the ensemble and make it the geometry downstream blocks run.
 * The member's atoms travel with the project, so the choice survives a restart
 * even after the queue folder has moved.
 */
function selectConformer(id) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'generate' || !node.output) return;
  const member = (node.output.members || []).find((entry) => entry.id === id);
  if (!member || !member.kept) return;
  if (!Array.isArray(member.atoms) || member.atoms.length === 0) {
    toast('That conformer has no geometry recorded; run the ensemble again.');
    return;
  }
  node.settings.selectedConformerId = id;
  node.output.selectedId = id;
  node.output.selected = {
    id: member.id,
    energyEh: member.energyEh,
    relativeKcal: member.relativeKcal,
    population: member.population,
    protomer: member.protomer,
    atoms: member.atoms,
  };
  node.output.requiresSelection = false;
  node.output.autoSelected = false;
  node.state = 'passed';
  refreshDirty();
  renderGraph();
  renderInspector();
  toast(`Using conformer ${id}${Number.isFinite(member.relativeKcal) ? ` (ΔE ${member.relativeKcal.toFixed(2)} kcal/mol)` : ''}.`);
}

/**
 * A path the project can carry: relative to the project file when the ensemble
 * sits inside its folder, absolute otherwise. The renderer has no `node:path`,
 * so this is textual and conservative — on a different root (another drive, a
 * UNC share) it keeps the absolute path rather than inventing a relative one
 * that cannot resolve.
 */
function portableImportPath(file, projectPath) {
  if (!projectPath || typeof file !== 'string' || typeof projectPath !== 'string') return file;
  const normalise = (value) => value.replace(/\\/g, '/');
  const target = normalise(file);
  const dir = normalise(projectPath).replace(/[^/]*$/, '').replace(/\/+$/, '');
  if (!dir) return file;
  // Windows paths are case-insensitive and the two strings come from different
  // dialogs, so compare the prefix without case.
  if (!target.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return file;
  const relative = target.slice(dir.length + 1);
  return relative && !relative.startsWith('..') ? relative : file;
}

async function pickEnsembleFile() {
  if (!desktop?.pickEnsembleFile) { toast('Open the Electron app to choose an ensemble file.'); return; }
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  const isInput = node?.type === 'input' && node.input?.kind === 'ensemble';
  if (!isInput) {
    toast('Choose the ensemble file on the Ensemble input block, not on the generate block.');
    return;
  }
  try {
    const file = await desktop.pickEnsembleFile();
    if (!file) return;
    // Store the ensemble path relative to the project file when it lives beside
    // it: a project that ships with its data must not be pinned to the machine
    // that wrote the absolute path. Outside the project folder the absolute
    // path stays, because there is nothing to anchor it to.
    node.input.path = portableImportPath(file, state.projectPath);
    node.output = null;
    node.state = 'ready';
    refreshDirty();
    renderGraph();
    renderInspector();
    toast('Ensemble file selected. Run the workflow to read and hash it.');
  } catch (error) {
    toast(`Could not choose the ensemble file: ${error.message}`);
  }
}

async function preflightRun({ quiet = false } = {}) {
  if (!desktop) {
    appendRunOutput('Browser preview: no Electron bridge. Start the desktop app to run preflight.\n');
    return null;
  }
  saveRunConfig();
  // Issue 316: preflight the engines the plan actually runs, not the project's
  // default one. A Psi4/ORCA flow on a machine with no Gaussian licence used to
  // fail on "Gaussian executable configured" and never start; the queue's own
  // preflight only ever demanded the engines in `calcEngines`.
  let enginesInUse = [];
  let engineBlocks = {};
  try {
    const plan = shared.buildWorkflowPlan(state.project);
    enginesInUse = shared.calcEnginesIn(plan.tasks);
    // Issue 316: a failing engine row should name the block that needs it, not
    // only the engine.
    for (const task of plan.tasks) {
      if (!task.executable || task.type !== 'calculate' || task.scorer) continue;
      const engineId = String(task.engine || 'gaussian');
      if (!engineBlocks[engineId]) engineBlocks[engineId] = task.title || task.nodeId || '';
    }
  } catch {
    // An unbuildable plan is reported by the queue's own error; fall back to the
    // engine the selected block names.
    enginesInUse = [];
    engineBlocks = {};
  }
  const primaryEngine = enginesInUse[0] || engineOrDefault(activeRunEngineId()).id;
  const config = {
    // Issue 316: the engines this flow runs. Preflight checks those and lists
    // the rest as SKIP, instead of demanding a Gaussian executable for a
    // workflow that has no Gaussian block.
    engines: enginesInUse.length > 0 ? enginesInUse : [primaryEngine],
    executables: runExecutables(),
    // The block that made each engine necessary, so a failure names it.
    engineBlocks,
    // Kept for the single-engine checks and for older callers.
    engine: engineOrDefault(primaryEngine).id,
    executable: runExecutables()[primaryEngine] || '',
    scratchDir: $('#run-scratch').value.trim(),
    dryRun: $('#run-dry').checked,
  };
  let result;
  try {
    result = await desktop.preflight(config);
  } catch (error) {
    appendRunOutput(`Preflight error: ${error.message}\n`);
    if (!quiet) toast(`Preflight error: ${error.message}`);
    return null;
  }
  // The engine preflight knows nothing about CREST, and a CREST block that
  // cannot find its binary is a blocking failure, not a warning. Check it here
  // and fold the answer into the same report rather than letting the queue be
  // the first place the user hears about it.
  if (!config.dryRun) {
    let needsCrest = false;
    try {
      const tasks = shared.buildWorkflowPlan(state.project).tasks;
      // A fanned-out member task carries a stored ensemble, so it does not need
      // the CREST binary (#80).
      needsCrest = tasks.some((task) => task.type === 'generate'
        && task.generate?.generator === 'crest'
        && !task.generate?.member);
    } catch {
      // An unbuildable plan is reported by the queue's own error; nothing to add.
    }
    if (needsCrest) {
      const crest = $('#run-crest').value.trim();
      result = {
        ...result,
        ok: result.ok && Boolean(crest),
        checks: [
          ...(Array.isArray(result.checks) ? result.checks : []),
          {
            id: 'crest',
            label: 'CREST executable',
            ok: Boolean(crest),
            detail: crest || 'not chosen — a CREST conformer block cannot run',
          },
        ],
      };
    }
    let needsObabel = false;
    try {
      const tasks = shared.buildWorkflowPlan(state.project).tasks;
      needsObabel = tasks.some((task) => task.type === 'generate'
        && task.generate?.generator === 'obabel'
        && !task.generate?.member);
    } catch {
      // An unbuildable plan is reported by the queue's own error.
    }
    if (needsObabel) {
      const obabel = $('#run-obabel')?.value.trim() || '';
      result = {
        ...result,
        ok: result.ok && Boolean(obabel),
        checks: [
          ...(Array.isArray(result.checks) ? result.checks : []),
          {
            id: 'obabel',
            label: 'Open Babel executable',
            ok: Boolean(obabel),
            detail: obabel || 'not chosen — an Open Babel conformer block cannot run',
          },
        ],
      };
    }
    let needsScorer = false;
    try {
      const tasks = shared.buildWorkflowPlan(state.project).tasks;
      needsScorer = tasks.some((task) => (task.type === 'generate' && task.generate?.rankBy)
        || (task.type === 'calculate' && task.scorer)
        || (task.type === 'prepare' && task.prepare?.converter === 'aimnet2'));
    } catch {
      // An unbuildable plan is reported by the queue's own error.
    }
    if (needsScorer) {
      const scorer = $('#run-scorer')?.value.trim() || '';
      result = {
        ...result,
        ok: result.ok && Boolean(scorer),
        checks: [
          ...(Array.isArray(result.checks) ? result.checks : []),
          {
            id: 'scorer',
            label: 'ML scorer sidecar',
            ok: Boolean(scorer),
            detail: scorer || 'not chosen — a block that asks for ML ranking or a scorer provider cannot run',
          },
        ],
      };
    }
    // Issue 226: a tautomer block has no in-app route, so a missing sidecar is
    // a hard refusal rather than a slower fallback.
    let needsTautomer = false;
    try {
      const tasks = shared.buildWorkflowPlan(state.project).tasks;
      needsTautomer = tasks.some((task) => task.type === 'generate'
        && task.generate?.produces === 'tautomers'
        && !task.generate?.member);
    } catch {
      // An unbuildable plan is reported by the queue's own error.
    }
    if (needsTautomer) {
      const tautomer = $('#run-tautomer')?.value.trim() || '';
      result = {
        ...result,
        ok: result.ok && Boolean(tautomer),
        checks: [
          ...(Array.isArray(result.checks) ? result.checks : []),
          {
            id: 'tautomer',
            label: 'Tautomer enumerator sidecar',
            ok: Boolean(tautomer),
            detail: tautomer || 'not chosen — tautomer enumeration needs RDKit; there is no in-app fallback',
          },
        ],
      };
    }
  }
  // Issue 316: the engine rows (which engine is checked, which is skipped) come
  // from the main process, which knows the plan's engines — see
  // `preflightForEngines`. Nothing is appended here for engines any more.
  appendRunOutput(formatPreflightReport(result));
  if (!quiet) toast(result.ok ? 'Preflight passed.' : 'Preflight found issues; see the run console.');
  return result;
}

async function startSelectedRun() {
  const node = selectedCalcNode({ conformers: true });
  if (!node) { toast('Select a calculation or conformer block first.'); return; }
  if (!desktop) { toast(BROWSER_PREVIEW_RUN_MESSAGE); return; }
  // A conformer block is a queue task (CREST is not a calculation engine), so
  // it runs through a one-task queue rather than the single-run bridge.
  if (node.type === 'generate') { await startSelectedConformerRun(node); return; }

  openRunConsole();
  saveRunConfig();
  const dryRun = $('#run-dry').checked;
  const result = await preflightRun({ quiet: true });
  if (!result || (!result.ok && !dryRun)) {
    // The toast disappears; the status bar is where a refusal has to stay.
    if (result) setStatusMessage(preflightFailureMessage(result));
    toast('Preflight is not ready. Fix the run configuration or use dry run.');
    return;
  }

  let built;
  try {
    built = buildRunInput(node);
  } catch (error) {
    appendRunOutput(`Input builder error: ${error.message}\n`);
    toast(`Cannot build input: ${error.message}`);
    return;
  }

  state.run.output = '';
  state.run.gates = [];
  state.run.nodeId = node.id;
  state.run.id = null;
  state.run.dir = null;
  state.run.ignoreEvents = false;
  syncVerifyButton($('#verify-run'), null);
  $('#run-output').textContent = 'Starting local runner…\n';
  $('#run-gates').innerHTML = '';
  mountThermochemistryView($('#run-thermo'), null);
  $('#run-title').textContent = node.title;
  $('#run-path').textContent = '';
  $('#cancel-run')?.removeAttribute('disabled');
  setRunState('running', dryRun ? 'dry run' : 'running');
  clearRunHint();

  try {
    const response = await desktop.runTask({
      title: node.title,
      engine: built.engine,
      argv: built.argv,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      settings: settingsForNode(node),
      executable: runExecutables()[built.engine] || '',
      crestExecutable: $('#run-crest').value.trim(),
      obabelExecutable: $('#run-obabel').value.trim(),
      scorerExecutable: $('#run-scorer')?.value.trim() || '',
      multiwfnExecutable: $('#run-multiwfn')?.value.trim() || '',
      scratchDir: $('#run-scratch').value.trim(),
      dryRun,
      gates: gatesForNode(node),
      validity: validityForNode(node),
      // Issue 177: a single block launched from the console gets the same
      // limit a queued one does, so a hang cannot sit there either.
      timeoutSeconds: timeoutForNode(node),
    });
    state.run.id = response.runId;
    state.run.dir = response.runDir;
    $('#run-path').textContent = response.runDir;
  } catch (error) {
    appendRunOutput(`Runner error: ${error.message}\n`);
    setRunState('failed', 'failed');
    $('#cancel-run')?.setAttribute('disabled', '');
    toast(`Runner error: ${error.message}`);
  }
}

/**
 * Issue 101: run one conformer block on its own.
 *
 * The search is the same task "Run workflow" queues, built by the shared
 * planner; only this block is included, so the documented "run the block once
 * before expanding it" step works without deleting the downstream calculation.
 * The queue's normal events copy the stored ensemble back into the block
 * (`attachQueueEnsembles`), so the table and member choice appear as usual.
 */
async function startSelectedConformerRun(node) {
  openRunConsole();
  saveRunConfig();
  const dryRun = $('#run-dry').checked;
  const crestExecutable = $('#run-crest').value.trim();
  const obabelExecutable = $('#run-obabel').value.trim();
  const tautomerExecutable = $('#run-tautomer')?.value.trim() || '';
  const tautomerScript = $('#run-tautomer-script')?.value.trim() || '';

  let task;
  try {
    task = shared.conformerSearchTask(state.project, node);
  } catch (error) {
    appendRunOutput(`Input builder error: ${error.message}\n`);
    toast(`Cannot build the conformer search: ${error.message}`);
    return;
  }
  // Only the generator this block actually uses needs a binary. The UFF route
  // spawns nothing, and an imported ensemble is read from disk.
  const generator = task.generate?.generator;
  if (!dryRun && generator === 'crest' && !crestExecutable) {
    toast('Choose the CREST executable before running a conformer search.');
    return;
  }
  if (!dryRun && generator === 'obabel' && !obabelExecutable) {
    toast('Choose the Open Babel executable before running an Open Babel conformer search.');
    return;
  }
  // Issue 226: there is no in-app tautomer enumerator, so this block cannot
  // even start without the sidecar.
  if (!dryRun && task.generate?.produces === 'tautomers' && !tautomerExecutable) {
    toast('Choose the RDKit tautomer sidecar before enumerating tautomers; there is no in-app fallback.');
    return;
  }

  state.run.output = '';
  state.run.gates = [];
  state.run.nodeId = node.id;
  state.run.id = null;
  state.run.dir = null;
  state.run.ignoreEvents = false;
  syncVerifyButton($('#verify-run'), null);
  $('#run-output').textContent = 'Starting conformer search…\n';
  $('#run-gates').innerHTML = '';
  mountThermochemistryView($('#run-thermo'), null);
  $('#run-title').textContent = node.title;
  $('#run-path').textContent = '';
  $('#cancel-run')?.setAttribute('disabled', '');
  setRunState('running', dryRun ? 'dry run' : 'running');
  clearRunHint();

  try {
    const queue = await desktop.startQueue({
      projectName: state.project.name || 'Conformer search',
      tasks: [task],
      edges: [],
      options: {
        dryRun,
        executable: runExecutables()[engineForNode(state.project, node).id] || '',
        crestExecutable,
        obabelExecutable,
        // Issue 226: the tautomer sidecar travels with the single-block run
        // exactly as it does with the whole workflow.
        tautomerExecutable,
        tautomerScript,
        scratchDir: $('#run-scratch').value.trim(),
        maxParallel: maxParallelForQueue(),
        // Issue 177: the project's per-task wall clock; null lets the queue
        // apply its 3600 s default, so an untouched project sends nothing.
        timeoutSeconds: timeoutForQueue(),
        // A relative conformer importPath resolves against the project folder.
        projectFile: state.projectPath || null,
      },
    });
    applyQueue(queue);
    appendRunOutput(`Conformer search queued for "${node.title}".\n`);
  } catch (error) {
    appendRunOutput(`Queue error: ${error.message}\n`);
    setRunState('failed', 'failed');
    $('#cancel-run')?.setAttribute('disabled', '');
    toast(`Could not run the conformer search: ${error.message}`);
  }
}

function handleRunEvent(event) {
  if (!event) return;
  // Issue 255: a run started before the project was swapped still emits events;
  // they belong to the previous project and may not paint this header.
  if (state.run.ignoreEvents && !state.run.id) return;
  if (event.type === 'started') {
    if (!state.run.id) state.run.id = event.runId;
  } else if (event.runId !== state.run.id) {
    return;
  }
  if (event.type === 'started') {
    state.run.dir = event.runDir;
    $('#run-path').textContent = event.runDir;
    setStatusMessage(`Running ${event.record?.title || 'local job'} · ${runEngineLabel(event.record?.engine, { dryRun: event.record?.dryRun })}`);
  } else if (event.type === 'output') {
    appendRunOutput(event.text);
  } else if (event.type === 'done') {
    const record = event.record;
    state.run.id = record.id || state.run.id;
    setRunState(record.status, record.status);
    renderRunGates(record.gates?.gates || [], record.gates?.validity || null);
    mountThermochemistryView($('#run-thermo'), record.parsed, { engine: record.engine });
    attachParsedRun(record, state.run.nodeId);
    autoRunPane('results');
    $('#cancel-run')?.setAttribute('disabled', '');
    const verdict = record.gates?.overall || 'unknown';
    const validityVerdict = record.gates?.validity?.overall || null;
    setStatusMessage(`Run ${record.status} · gates ${verdict}${validityVerdict && validityVerdict !== 'pass' ? ` · validity ${validityVerdict}` : ''} · ${record.title || 'local job'}`);
    appendRunOutput(`\nRun ${record.status} · gates: ${verdict}${validityVerdict ? ` · validity: ${validityVerdict}` : ''}${record.error ? `\n${record.error}` : ''}\n`);
    for (const finding of record.gates?.validity?.findings || []) {
      if (finding.status === 'pass' || finding.status === 'skipped') continue;
      appendRunOutput(`Validity [${finding.severity || finding.status}] ${finding.title || finding.id}: ${finding.message}\n`);
    }
    appendRunOutput(`\n${provenanceSummary(record)}\n`);
    // Issue 256: the hint line reports the outcome of this run, not the mode
    // the console was in before it started.
    if (['failed', 'needs-review', 'timed out'].includes(String(record.status))) {
      const failure = taskFailure({
        title: record.title,
        nodeId: state.run.nodeId,
        status: record.status,
        gateVerdict: record.gates?.overall,
        error: record.error,
      });
      if (failure) {
        setRunHint(failureHint(failure, record.status), { warn: true, action: failure.action });
      } else {
        setRunHint(`Run ${record.status}${record.error ? ` — ${record.error}` : ''}.`, { warn: true });
      }
    } else {
      setRunHint(`Run ${record.status}${verdict !== 'unknown' ? ` · gates ${verdict}` : ''}.`);
    }
    syncVerifyButton($('#verify-run'), state.run.id);
    toast(`Run ${record.status}${verdict !== 'unknown' ? ` · ${verdict}` : ''}.`);
  }
}

async function cancelRun() {
  if (!state.run.id || !desktop) return;
  await desktop.cancelRun(state.run.id);
  setRunState('cancelled', 'stopping');
  appendRunOutput('\nCancellation requested…\n');
}

async function verifyCurrentRun() {
  if (!desktop) { toast('Open the desktop app to verify a run folder.'); return; }
  try {
    const result = await verifyRunInput({ desktop, runId: state.run.id });
    appendRunOutput(`${result.text}\n`);
    toast(result.ok ? 'Input hash matches the recorded manifest.' : 'Input hash does not match the recorded manifest.');
  } catch (error) {
    appendRunOutput(`Verify error: ${error.message}\n`);
    toast(`Verify error: ${error.message}`);
  }
}

/* ── Workflow queue ───────────────────────────────────────── */

function checkpointSourceFor(node) {
  return shared.checkpointSourceFor(state.project, node);
}

function buildWorkflowTasks() {
  return shared.buildWorkflowTasks(state.project);
}

/**
 * Make each block's state follow the queue's verdict.
 *
 * A completed, gate-passing block is `passed`; a failed or gate-failed one is
 * `review`. Family tasks (`node~record`) collapse onto their parent: the parent
 * passes only when every record does. Without this the cards, the flow tabs and
 * the status bar kept saying "ready" after a run had already finished.
 */
/**
 * Issue 160: the rules live in `src/shared/queueReconcile.js` so the start-up
 * reconciliation and the live queue updates cannot drift apart, and so they can
 * be tested without a DOM.
 */
function syncNodeStatesFromQueue(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  if (tasks.length === 0) return false;
  return applyQueueToProject(state.project, tasks).changed;
}

/**
 * Issue 160: on start up the queue and the project are restored by two separate
 * calls, and the queue used to arrive first — nothing was there to apply it to,
 * so twelve completed tasks sat beside twelve `ready` blocks and a Next Action
 * telling the user to run work that already existed. This runs after both are in
 * hand and then redraws everything that reads a block state.
 */
function reconcileNodesWithQueue() {
  const changed = syncNodeStatesFromQueue(state.queue);
  if (!changed) return false;
  renderGraph();
  renderInspector();
  updateCounts();
  return true;
}

function applyQueue(queue, { paintHeader = true } = {}) {
  if (!queue) return;
  // Issue 255: a queue event from another project may not touch the visible
  // console. Its state is remembered only so the header can say where the last
  // run went, never copied over the open project's header.
  if (!queueBelongsToProject(queue)) {
    noteForeignQueue(queue);
    return;
  }
  if (state.lastForeignQueue?.id === queue.id) state.lastForeignQueue = null;
  state.queue = {
    id: queue.id || null,
    status: queue.status || 'idle',
    flowId: queue.flowId || null,
    projectName: queue.projectName || null,
    createdAt: queue.createdAt || null,
    finishedAt: queue.finishedAt || null,
    tasks: Array.isArray(queue.tasks) ? queue.tasks : [],
    reason: queue.reason || null,
    // Issue 177: the queue's per-task wall clock, so a running row can show
    // "elapsed / limit" without reading the project.
    timeoutSeconds: Number.isInteger(Number(queue.timeoutSeconds)) ? Number(queue.timeoutSeconds) : null,
    // Issue 186: the comparisons the queue wrote for each swept block, so a
    // card can report the lowest computed state without re-reading run folders.
    spins: queue.spins && typeof queue.spins === 'object' ? queue.spins : {},
  };
  const reconciled = syncNodeStatesFromQueue(queue);
  renderQueue();
  updateRunTabBadges();
  const header = runHeaderFor(queue);
  // A restored, already-finished queue populates the Queue tab and its badge,
  // but it is history: the header stays idle until that project actually runs
  // something in this window (issue 255).
  if (paintHeader && header.paint) {
    updateRunProgressChip();
    setRunState(header.status, header.label);
  }
  // Live cards: the running block gets its progress rail, a finished one its
  // numbers. Cheap enough at canvas scale and it keeps the workbench honest
  // while a queue drains.
  renderGraph();
  // ...and the Next Action is computed from those states, so it follows them.
  if (reconciled) renderInspector();
  renderRunLast();
}

/** A duration a person reads at a glance: `1.4 s`, `3m 12s`. */
function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value.toFixed(1)} s`;
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/** `elapsed / limit` for a running row: measured, never estimated. */
function budgetLabel(startedMs, limitSeconds) {
  const elapsed = Math.max(0, (Date.now() - startedMs) / 1000);
  return `${formatDuration(elapsed)} / ${formatDuration(limitSeconds)}`;
}

let queueTicker = null;

/**
 * Keep a running row's elapsed time moving between queue events (issue 177).
 * Only the budget spans are rewritten — not the list — so a family of thousands
 * of tasks is not rebuilt once a second.
 */
function syncQueueTicker() {
  const spans = document.querySelectorAll('#queue-list .queue-budget');
  if (spans.length === 0) {
    if (queueTicker) clearInterval(queueTicker);
    queueTicker = null;
    return;
  }
  if (queueTicker) return;
  queueTicker = setInterval(() => {
    const live = document.querySelectorAll('#queue-list .queue-budget');
    if (live.length === 0) {
      clearInterval(queueTicker);
      queueTicker = null;
      return;
    }
    live.forEach((span) => {
      const started = Number(span.dataset.elapsed);
      const limit = Number(span.dataset.limit);
      if (!Number.isFinite(started) || !limit) return;
      span.textContent = budgetLabel(started, limit);
    });
  }, 1000);
}

function firstQuoted(text) {
  const match = String(text || '').match(/"([^"]+)"/);
  return match ? match[1] : '';
}

/**
 * Issue 256: which of the three actionable failures a task hit, if any.
 * The order matters: the missing-conformer message also names the block it
 * would have run, so it has to win before the generic gate/executable tests.
 */
function classifyTaskFailure(task, reason) {
  const message = String(reason || '');
  if (/(no selected conformer|has no selected conformer|choose a member)/i.test(message)) return 'conformer';
  if (/(choose the .*(executable|sidecar)|(executable|sidecar).*(not found|not chosen|not configured))/i.test(message)) return 'executable';
  if (task?.gateVerdict === 'fail' || /(gates? (did not pass|failed)|gate failed)/i.test(message)) return 'gate';
  return 'other';
}

/** The Setup field a missing executable should send the user to. */
function executableFixFor(reason, task = null) {
  const message = String(reason || '');
  if (/crest/i.test(message)) return { field: '#run-crest', label: 'CREST' };
  if (/open babel|obabel/i.test(message)) return { field: '#run-obabel', label: 'Open Babel' };
  if (/scorer/i.test(message)) return { field: '#run-scorer', label: 'ML scorer' };
  if (/tautomer/i.test(message)) return { field: '#run-tautomer', label: 'tautomer sidecar' };
  return { field: '#run-exe', label: engineOrDefault(task?.engine).label };
}

function failureActionFor(kind, task, reason) {
  if (kind === 'conformer') {
    return {
      kind,
      label: 'Select conformer…',
      nodeId: String(task?.pendingInput?.conformerId || ''),
      nodeTitle: String(task?.pendingInput?.conformerTitle || firstQuoted(reason) || ''),
    };
  }
  if (kind === 'executable') {
    const fix = executableFixFor(reason, task);
    return { kind, label: `Set ${fix.label} path…`, field: fix.field, taskId: String(task?.nodeId || '') };
  }
  if (kind === 'gate') {
    return { kind, label: 'Review gate…', taskId: String(task?.nodeId || '') };
  }
  return null;
}

/** The failure of one queue task, or null when the row carries no reason. */
function taskFailure(task) {
  if (!task) return null;
  // A completed condition also carries a `reason` ("true — …"); that is an
  // outcome, not a failure, and must not be rendered as one.
  if (!['failed', 'needs-review', 'timed out', 'interrupted'].includes(String(task.status))) return null;
  const reason = String(task.error || task.reason || '').trim();
  if (!reason) return null;
  const kind = classifyTaskFailure(task, reason);
  return {
    task,
    block: String(task.title || task.nodeId || 'block'),
    reason,
    kind,
    action: failureActionFor(kind, task, reason),
  };
}

/** The first failed task in a queue that has a reason to show. */
function queueFailure(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const failed = tasks.find((task) => ['failed', 'needs-review', 'timed out'].includes(String(task?.status))
    && (task.error || task.reason));
  const failure = taskFailure(failed);
  if (failure) return failure;
  const reason = String(queue?.reason || '').trim();
  if (!reason) return null;
  return {
    task: null,
    block: '',
    reason,
    kind: classifyTaskFailure(null, reason),
    action: failureActionFor(classifyTaskFailure(null, reason), null, reason),
  };
}

/** One sentence for the log/hint: what failed and which block. */
function failureDetail(failure) {
  if (!failure) return '';
  if (!failure.block) return failure.reason;
  return failure.reason.includes(failure.block)
    ? failure.reason
    : `"${failure.block}" — ${failure.reason}`;
}

function failureHint(failure, verdict = 'failed') {
  if (!failure) return '';
  const prefix = `Workflow ${verdict} — `;
  if (failure.kind === 'conformer') {
    const source = failure.action?.nodeTitle || failure.action?.nodeId || 'the Generate block';
    return `${prefix}"${failure.block}" has no selected conformer. Choose a member in "${source}".`;
  }
  if (failure.kind === 'executable') {
    return `${prefix}"${failure.block}" could not start: ${failure.reason}`;
  }
  if (failure.kind === 'gate') {
    return `${prefix}"${failure.block}" finished, but its gates did not pass. Review the gate row.`;
  }
  return `${prefix}${failureDetail(failure)}`;
}

/**
 * Issue 256: one queue row. The failure reason is real text in the row body
 * (clamped to two lines, with a keyboard-reachable expander); `title` keeps the
 * complete message as a secondary tooltip.
 */
function queueRowHtml(task, queue = {}, index = 0) {
  const branch = task.conditionResult === true ? '→ true' : task.conditionResult === false ? '→ false' : '';
  const retry = task.loopAttempts
    ? `retry ${Math.min(task.loopAttempts, task.loop?.maxAttempts ?? task.loopAttempts)}/${task.loop?.maxAttempts ?? '?'}`
    : '';
  // Issue 177: the running row shows the wall clock it is spending against the
  // limit it was given. Nothing is estimated here — the elapsed side is
  // `startedAt` and the limit is what the queue enforces.
  const limit = Number(task.timeoutSeconds ?? queue.timeoutSeconds) || null;
  const startedMs = task.status === 'running' ? Date.parse(task.startedAt || '') : NaN;
  const budget = Number.isFinite(startedMs) && limit ? budgetLabel(startedMs, limit) : '';
  const timedOut = task.timeout && typeof task.timeout === 'object' ? task.timeout : null;
  const timeoutNote = timedOut
    ? `after ${formatDuration(timedOut.elapsedSeconds)}${timedOut.limitSeconds ? ` · limit ${formatDuration(timedOut.limitSeconds)}` : ''}`
    : '';
  // Issue 186: a sweep member row names the state it runs, so three rows from
  // one block are three multiplicities, not three anonymous runs.
  const spinMeta = spinTaskMeta(task);
  const meta = [task.status, spinMeta, timeoutNote, task.attempts > 1 ? `×${task.attempts}` : '', retry, branch, task.gateVerdict ? `gates ${task.gateVerdict}` : '']
    .filter(Boolean).join(' · ');
  // The last output line a stopped task wrote is the evidence of where it was,
  // so the row's tooltip carries it rather than the meta line.
  const title = [task.error || task.reason || '', timedOut?.lastOutput ? `Last output: ${timedOut.lastOutput}` : '']
    .filter(Boolean).join('\n');
  // Issue 154: a finished row opens its results, so it must be reachable and
  // activatable from the keyboard. An empty data-run-id is not a run.
  const runId = String(task.runId || '');
  const interactive = runId
    ? ` tabindex="0" role="button" aria-label="Open results for ${esc(task.title)}"`
    : '';
  // `timed out` has a space; a class attribute would split it in two.
  const statusClass = esc(String(task.status).replace(/\s+/g, '-'));
  const budgetAttrs = Number.isFinite(startedMs) && limit
    ? ` data-elapsed="${Math.trunc(startedMs)}" data-limit="${Math.trunc(limit)}"`
    : '';
  const budgetHtml = budget ? ` · <span class="queue-budget"${budgetAttrs}>${esc(budget)}</span>` : '';
  // Issue 256: the reason is ordinary text in the row, not a tooltip-only
  // field. The toggle is a button so a keyboard user can expand the clamp.
  const failure = taskFailure(task);
  const reasonId = `queue-reason-${String(task.nodeId || 'task').replace(/[^A-Za-z0-9_-]/g, '-')}${index ? `-${index}` : ''}`;
  const action = failure?.action;
  const actionAttrs = action
    ? [
      'data-action="failure-fix"',
      `data-fix-kind="${esc(action.kind || '')}"`,
      action.field ? `data-fix-field="${esc(action.field)}"` : '',
      action.nodeId ? `data-fix-node="${esc(action.nodeId)}"` : '',
      action.nodeTitle ? `data-fix-title="${esc(action.nodeTitle)}"` : '',
      action.taskId ? `data-fix-task="${esc(action.taskId)}"` : '',
    ].filter(Boolean).join(' ')
    : '';
  const reasonHtml = failure
    ? `<span class="queue-reason" id="${esc(reasonId)}">${esc(failure.reason)}</span>`
      + '<span class="queue-failure-actions">'
      + `<button type="button" class="queue-reason-toggle" data-action="toggle-queue-reason" aria-expanded="false" aria-controls="${esc(reasonId)}">Show full reason</button>`
      + (action ? `<button type="button" class="btn small queue-fix" ${actionAttrs}>${esc(action.label)}</button>` : '')
      + '</span>'
    : '';
  const describedBy = failure && runId ? ` aria-describedby="${esc(reasonId)}"` : '';
  return `<li class="queue-item is-${statusClass}" data-run-id="${esc(runId)}" data-node-id="${esc(task.nodeId || '')}"${interactive}${describedBy} title="${esc(title)}"><span class="queue-dot"></span><span class="queue-title">${esc(task.title)}</span><span class="queue-meta">${esc(meta)}${budgetHtml}</span>${reasonHtml}</li>`;
}

function renderQueue() {
  const queue = state.queue;
  const stateEl = $('#queue-state');
  if (stateEl) {
    stateEl.textContent = queue.status === 'idle' ? 'idle' : queue.status;
    stateEl.className = `run-state is-${queue.status}`;
  }
  const listEl = $('#queue-list');
  if (listEl) {
    listEl.innerHTML = queue.tasks.length
      ? queue.tasks.map((task, index) => queueRowHtml(task, queue, index)).join('')
      : '<li class="queue-empty">Queue the workflow to run calculation blocks in dependency order, one at a time.</li>';
  }
  syncQueueTicker();
  const running = queue.status === 'running';
  const canResume = queue.status === 'paused' || queue.status === 'needs-review';
  const active = running || canResume;
  const starting = Boolean(queue.starting);
  $('#run-workflow')?.toggleAttribute('disabled', active || starting);
  $('#pause-workflow')?.toggleAttribute('disabled', !running);
  $('#resume-workflow')?.toggleAttribute('disabled', !canResume);
  $('#cancel-workflow')?.toggleAttribute('disabled', !active);
  $('#report-workflow')?.toggleAttribute('disabled', !queue.id || queue.status === 'running');
  $('#report-figures')?.toggleAttribute('disabled', !queue.id || queue.status === 'running');
  renderRecordSummary();
}

/**
 * RFC 0001: when the plan iterates a dataset, the queue's task list is one row
 * per block per record. This groups it back into one row per record with the
 * status, gate verdict and first error. A queue with no record ids renders
 * nothing here, so the single-molecule console is byte-for-byte unchanged.
 */
function renderRecordSummary() {
  const el = $('#run-records');
  if (!el) return;
  const group = groupTasksByRecord(state.queue.tasks);
  if (!group.hasRecords) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const failed = group.records.filter((record) => record.failed);
  const rows = group.records.map((record) => `
    <tr class="is-${esc(String(record.status).replace(/\s+/g, '-'))}">
      <td><span class="record-label">${esc(record.label)}</span><span class="record-id">${esc(record.id)}</span></td>
      <td><span class="record-status is-${esc(String(record.status).replace(/\s+/g, '-'))}">${esc(record.status)}</span></td>
      <td>${esc(record.gates || '—')}</td>
      <td class="record-error" title="${esc(record.error)}">${esc(record.error || '')}</td>
    </tr>`).join('');
  el.hidden = false;
  el.innerHTML = `
    <div class="run-records-head"><span>Records</span><span>${esc(recordSummaryLabel(group))}</span></div>
    ${failed.length ? `<div class="callout red run-partial"><strong>Partial run.</strong> Failed record${failed.length === 1 ? '' : 's'}: ${failed.map((record) => esc(record.label)).join(', ')}. The other records continue.</div>` : ''}
    <div class="record-table-wrap">
      <table class="record-table">
        <thead><tr><th>Record</th><th>Status</th><th>Gates</th><th>Error</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function startWorkflow() {
  if (!desktop) { toast('Open the desktop app to queue a workflow.'); return; }
  if (state.queue.starting) return;
  state.queue.starting = true;
  renderQueue();
  try {
    await startWorkflowUnlocked();
  } finally {
    state.queue.starting = false;
    renderQueue();
  }
}

async function startWorkflowUnlocked() {
  openRunConsole();
  saveRunConfig();
  const dryRun = $('#run-dry').checked;

  let tasks;
  let edges = state.project.edges;
  try {
    // The plan expands method-ladder blocks into one task per rung and rewires
    // the edges so a downstream block waits for every rung.
    const plan = shared.buildWorkflowPlan(state.project);
    tasks = plan.tasks;
    edges = plan.edges;
  } catch (error) {
    appendRunOutput(`Input builder error: ${error.message}\n`);
    toast(`Cannot queue workflow: ${error.message}`);
    return;
  }

  // Issue 139: a 2D drawing may not be handed to a first frequency or single
  // point without the user saying so. The plan keeps those tasks and refuses
  // them; this is the confirmation path, and cancelling queues nothing.
  const refusedDrawings = tasks.filter((task) => task.drawingRefusal);
  if (refusedDrawings.length > 0) {
    appendRunOutput(`Drawing gate: ${refusedDrawings.length} record(s) came from a 2D drawing and the first block would report on the drawing. Confirmation requested.\n`);
    openDrawingGate(refusedDrawings.map((task) => task.drawingRefusal));
    return;
  }

  const preflight = await preflightRun({ quiet: true });
  if (!preflight || (!preflight.ok && !dryRun)) {
    if (preflight) setStatusMessage(preflightFailureMessage(preflight));
    toast('Preflight is not ready. Fix the run configuration or use dry run.');
    return;
  }

  state.run.output = '';
  state.run.ignoreEvents = false;
  appendRunOutput(`Queued workflow · ${tasks.filter((task) => task.executable).length} calculation block(s)\n`);
  $('#run-gates').innerHTML = '';
  $('#run-title').textContent = state.project.name || 'Workflow';
  clearRunHint();

  try {
    const queue = await desktop.startQueue({
      projectName: state.project.name,
      flowId: activeFlowId(state.project),
      flowTitle: activeFlow(state.project)?.title || '',
      tasks,
      edges,
      options: {
        dryRun,
        executables: runExecutables(),
        crestExecutable: $('#run-crest').value.trim(),
        obabelExecutable: $('#run-obabel').value.trim(),
        scorerExecutable: $('#run-scorer')?.value.trim() || '',
        multiwfnExecutable: $('#run-multiwfn')?.value.trim() || '',
        // Issue 226: the tautomer enumerator sidecar and, when the executable
        // is an interpreter, the script it should run.
        tautomerExecutable: $('#run-tautomer')?.value.trim() || '',
        tautomerScript: $('#run-tautomer-script')?.value.trim() || '',
        scratchDir: $('#run-scratch').value.trim(),
        maxParallel: maxParallelForQueue(),
        // Issue 177: the project's per-task wall clock; null lets the queue
        // apply its 3600 s default, so an untouched project sends nothing.
        timeoutSeconds: timeoutForQueue(),
        projectFile: state.projectPath || null,
      },
    });
    applyQueue(queue);
    toast(`Workflow queued · ${tasks.filter((task) => task.executable).length} block(s).`);
  } catch (error) {
    appendRunOutput(`Queue error: ${error.message}\n`);
    toast(`Could not queue workflow: ${error.message}`);
  }
}

/**
 * Write the workflow report for the current queue (report.html + report.json).
 * The main process reads the queue's run folders; the renderer only asks.
 *
 * The figure set beside the button is `ncs report --figures` under another
 * name: `basic` (the default, and the document the window has always written),
 * `surfaces` (also mesh the .cube files in each run folder) or `none`.
 */
async function exportWorkflowReportAction() {
  if (!desktop?.exportWorkflowReport) {
    toast('Open the desktop app to write a workflow report.');
    return;
  }
  if (!state.queue.id) {
    toast('Run a workflow first; the report describes a finished queue.');
    return;
  }
  const figures = $('#report-figures')?.value || 'basic';
  try {
    const result = await desktop.exportWorkflowReport(state.queue.id, figures);
    if (!result || result.canceled) return;
    if (result.error) {
      toast(`Could not write the report: ${result.error.message}`);
      return;
    }
    toast(`Report written · ${result.taskCount} task(s) · verdict ${result.verdict} · figures ${result.figures || figures}`);
  } catch (error) {
    toast(`Could not write the report: ${error.message}`);
  }
}

async function pauseWorkflow() {
  if (!state.queue.id || !desktop) return;
  const result = await desktop.pauseQueue(state.queue.id);
  if (!result?.paused) toast('Nothing to pause.');
}

async function resumeWorkflow() {
  if (!state.queue.id || !desktop) return;
  try {
    const result = await desktop.resumeQueue(state.queue.id);
    if (!result?.resumed) toast('This workflow cannot resume.');
  } catch (error) {
    toast(`Could not resume: ${error.message}`);
  }
}

async function cancelWorkflow() {
  if (!state.queue.id || !desktop) return;
  await desktop.cancelQueue(state.queue.id);
  appendRunOutput('\nWorkflow cancellation requested…\n');
}

function attachParsedRun(record, nodeId) {
  if (!record?.parsed || !nodeId) return;
  const node = nodeById(nodeId);
  if (!node || node.type !== 'calculate') return;
  node.parsed = record.parsed;
  // The card carries the result now, so it has to be redrawn when one arrives.
  renderGraph();
  if (state.selected.type === 'node' && state.selected.id === node.id) renderInspector();
}

async function attachQueueParsed(queue) {
  if (!desktop?.listRuns || !queue?.tasks?.length) return;
  const runs = await desktop.listRuns();
  if (!Array.isArray(runs)) return;
  const byId = new Map(runs.map((run) => [run?.id, run]));
  let changed = false;
  for (const task of queue.tasks) {
    if (!task?.runId || !task?.nodeId) continue;
    const record = byId.get(task.runId);
    const node = nodeById(task.nodeId);
    if (!record?.parsed || !node || node.type !== 'calculate') continue;
    node.parsed = record.parsed;
    changed = true;
  }
  if (changed) {
    renderGraph();
    if (state.selected.type === 'node') renderInspector();
  }
}

/**
 * Copy finished conformer ensembles into their blocks. The queue is the only
 * place a real search result exists, so this is what makes the table appear in
 * the inspector; a re-run with the same stamp does not stomp a later choice.
 */
function attachQueueEnsembles(queue) {
  let changed = false;
  for (const task of queue?.tasks || []) {
    // ADR 0001 §2.9: a prepare block's summary is the only result it has.
    if (task?.type === 'prepare' && task.status === 'completed' && task.prepared) {
      const prepareNode = nodeById(task.nodeId);
      if (prepareNode && prepareNode.type === 'prepare') {
        prepareNode.output = task.prepared;
        prepareNode.state = task.prepared.converged === false ? 'review' : 'passed';
        changed = true;
      }
      continue;
    }
    // ADR 0001: an ensemble input's run records how many frames were read and
    // the digest of the exact file. The frames stay in the run folder.
    if (task?.type === 'input' && task.input?.kind === 'ensemble'
      && task.status === 'completed' && task.ensemble) {
      const inputNode = nodeById(task.nodeId);
      if (inputNode && inputNode.type === 'input' && inputNode.input?.kind === 'ensemble') {
        inputNode.output = task.ensemble;
        inputNode.state = 'passed';
        changed = true;
      }
      continue;
    }
    if (task?.type !== 'generate' || task.status !== 'completed' || !task.ensemble) continue;
    const node = nodeById(task.nodeId);
    if (!node || node.type !== 'generate') continue;
    if (node.output && node.output.generatedAt === task.ensemble.generatedAt) continue;
    node.output = task.ensemble;
    node.settings.selectedConformerId = task.ensemble.selectedId || '';
    // Issue 226: a tautomer set that fans out needs no member chosen — the
    // candidates are the point. One that does not fan out still needs a pick.
    const tautomers = task.ensemble.produces === 'tautomers';
    const needsChoice = tautomers
      ? node.settings.fanOut === false && !task.ensemble.selectedId
      : task.ensemble.requiresSelection;
    node.state = needsChoice ? 'review' : 'passed';
    changed = true;
  }
  if (changed) {
    refreshDirty();
    renderGraph();
    renderInspector();
  }
}

/**
 * Attach each finished task's parsed result to its block while the queue is
 * still draining, so a card shows its energy the moment that record is done.
 * Debounced: a burst of task updates must not read every run folder per event.
 */
function scheduleAttachParsed(queue) {
  if (!queue) return;
  clearTimeout(state.attachParsedTimer);
  state.attachParsedTimer = setTimeout(() => {
    attachQueueParsed(queue).catch(() => {});
  }, 400);
}

function handleQueueEvent(event) {
  if (!event) return;
  if (event.type === 'queue-output') {
    // Issue 255: output from a queue that is not the visible one must not be
    // pasted into this project's log.
    if (event.queueId && event.queueId !== state.queue.id) return;
    const task = state.queue.tasks.find((item) => item.nodeId === event.nodeId);
    appendRunOutput(`\n[${task?.title || event.nodeId}]\n${event.text}`);
    return;
  }
  if (!event.queue) return;
  // A live queue from another project is remembered, never painted (issue 255).
  if (!queueBelongsToProject(event.queue)) {
    noteForeignQueue(event.queue);
    return;
  }
  applyQueue(event.queue);
  attachQueueEnsembles(event.queue);
  if (event.type === 'queue-started') {
    state.runPanePinned = false;
    setRunPane('queue');
    const queuedEngine = event.queue.tasks.find((task) => task.engine)?.engine
      || state.project?.defaults?.engine;
    const records = groupTasksByRecord(event.queue.tasks);
    const recordCopy = records.hasRecords ? ` · ${countLabel(records.total, 'record')}` : '';
    setStatusMessage(`Workflow running · ${countLabel(event.queue.tasks.length, 'block')}${recordCopy} · ${runEngineLabel(queuedEngine, { dryRun: event.queue.options?.dryRun })}`);
  }
  if (event.type !== 'queue-done') scheduleAttachParsed(event.queue);
  if (event.type === 'queue-done') {
    const verdict = event.queue.status;
    autoRunPane('results');
    // Issue 256: "Workflow failed" without the reason is not an outcome. The
    // line names the first failed block and the same text goes to the hint.
    const failure = ['failed', 'needs-review', 'partial', 'timed out'].includes(String(verdict))
      ? queueFailure(event.queue)
      : null;
    if (failure) {
      appendRunOutput(`\nWorkflow ${verdict} — ${failureDetail(failure)}\n`);
      setRunHint(failureHint(failure, verdict), {
        warn: true,
        action: failure.action,
      });
      setStatusMessage(`Workflow ${verdict} · ${failure.block || 'queue'}: ${failure.reason}`);
      toast(`Workflow ${verdict} · ${failure.block || 'see the queue'}`);
    } else {
      appendRunOutput(`\nWorkflow ${verdict}${event.queue.reason ? ` — ${event.queue.reason}` : ''}\n`);
      setRunHint(`Workflow ${verdict}${event.queue.reason ? ` — ${event.queue.reason}` : ''}.`);
      setStatusMessage(`Workflow ${verdict}${event.queue.reason ? ` · ${event.queue.reason}` : ''}`);
      toast(`Workflow ${verdict}.`);
    }
    attachQueueParsed(event.queue).catch(() => {});
    refreshHistory();
  }
}

/**
 * Status-bar engine chips: which binaries this machine can launch right now.
 *
 * The academic failure mode this prevents is discovering a missing engine when
 * a queue is already half drained. Presence only — the console's preflight is
 * still the authority before a run.
 */
async function refreshEngineChips() {
  const el = $('#engine-chips');
  if (!el || !desktop?.engineStatus) return;
  let status = null;
  try {
    status = await desktop.engineStatus();
  } catch {
    return;
  }
  if (!status || typeof status !== 'object') return;
  state.engineStatus = status;
  const order = ['xtb', 'psi4', 'pyscf', 'orca', 'gaussian'];
  const labels = { xtb: 'xTB', psi4: 'Psi4', pyscf: 'PySCF', orca: 'ORCA', gaussian: 'Gaussian' };
  el.innerHTML = order
    .filter((id) => status[id])
    .map((id) => {
      const entry = status[id] || {};
      const label = labels[id] || id;
      const title = entry.ok ? `${label}: ${entry.path}` : `${label} not found on PATH`;
      return `<span class="engine-chip${entry.ok ? ' is-ok' : ' is-missing'}" title="${esc(title)}"><i></i>${esc(label)}</span>`;
    })
    .join('');
  // The status answer may arrive after the console first rendered; seed the
  // executable field now rather than making the user open the pane again.
  updateRunConsoleCopy();
}

const HISTORY_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/** `09 Nov 21:04` in the user's local time, or '' for an unknown stamp. */
function formatRunStart(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getDate())} ${HISTORY_MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Issue 255: attribute each run row to the queue that produced it, so the list
 * says which project (and flow) a run belongs to and when it started. Runs
 * outside a queue keep their own `startedAt` and simply have no project name.
 */
function historyRows(runs, queues, { limit = 6 } = {}) {
  const byRunId = new Map();
  for (const queue of Array.isArray(queues) ? queues : []) {
    for (const task of Array.isArray(queue?.tasks) ? queue.tasks : []) {
      const runId = String(task?.runId || '');
      if (!runId || byRunId.has(runId)) continue;
      byRunId.set(runId, {
        queueId: queue.id || null,
        projectName: String(queue.projectName || '').trim(),
        flowId: queue.flowId || null,
        startedAt: task.startedAt || queue.createdAt || null,
      });
    }
  }
  return (Array.isArray(runs) ? runs : []).slice(0, limit).map((run) => {
    const attribution = byRunId.get(String(run.id || '')) || null;
    const startedAt = run.startedAt || attribution?.startedAt || '';
    return {
      run,
      runId: String(run.id || ''),
      queueId: attribution?.queueId || run.queueId || null,
      projectName: String(run.projectName || attribution?.projectName || '').trim(),
      flowId: attribution?.flowId || run.flowId || null,
      startedAt,
      date: formatRunStart(startedAt),
    };
  });
}

function historyRowHtml(row) {
  const { run } = row;
  // Issue 131: an imported record in the runs folder is listed, but its row
  // says where the number came from instead of adopting the run's status/engine
  // meta. Issue 255: a queue-produced run also names its project and start.
  const meta = isImportedRecord(run)
    ? [row.projectName, row.date, importedSummary(run)?.badge].filter(Boolean).join(' · ')
    : [
      row.projectName,
      row.date,
      run.status,
      run.gates?.overall ? `gates ${run.gates.overall}` : '',
      run.dryRun ? 'dry' : engineOrDefault(run.engine).label,
    ].filter(Boolean).join(' · ');
  // Issue 154: the same keyboard contract as the queue rows.
  const interactive = row.runId
    ? ` tabindex="0" role="button" aria-label="Open results for ${esc(run.title || row.runId)}${row.projectName ? ` from ${esc(row.projectName)}` : ''}"`
    : '';
  const queueAttr = row.queueId ? ` data-queue-id="${esc(row.queueId)}"` : '';
  const queueButton = row.queueId
    ? `<button type="button" class="btn small queue-history-open" data-action="open-history-queue" data-queue-id="${esc(row.queueId)}" aria-label="Open queue ${esc(row.queueId)}">Queue</button>`
    : '';
  return `<li class="queue-item is-${esc(run.status)}" data-run-id="${esc(row.runId)}"${queueAttr}${interactive} title="${esc(run.runDir || '')}"><span class="queue-dot"></span><span class="queue-title">${esc(run.title || run.id)}</span><span class="queue-meta">${esc(meta)}${queueButton}</span></li>`;
}

/**
 * Issue 255: the history row's Queue button opens the queue that produced the
 * run. A queue from another project is named rather than painted over this one.
 */
async function openHistoryQueue(queueId) {
  if (!queueId || !desktop?.listQueues) return;
  try {
    const queues = await desktop.listQueues();
    const queue = (Array.isArray(queues) ? queues : []).find((item) => String(item.id) === String(queueId));
    if (!queue) {
      toast('That queue is no longer on disk.');
      return;
    }
    if (!queueBelongsToProject(queue)) {
      toast(`That queue belongs to ${queue.projectName || 'another project'}, not the open project.`);
      return;
    }
    applyQueue(queue, { paintHeader: ['running', 'queued', 'paused'].includes(String(queue.status)) });
    openRunConsole();
    setRunPane('queue', { user: true });
  } catch (error) {
    toast(`Could not open queue: ${error.message}`);
  }
}

async function refreshHistory() {
  if (!desktop?.listRuns) return;
  try {
    const [runList, queueList] = await Promise.all([
      desktop.listRuns(),
      desktop.listQueues ? desktop.listQueues().catch(() => []) : Promise.resolve([]),
    ]);
    const rows = historyRows(Array.isArray(runList) ? runList : [], Array.isArray(queueList) ? queueList : []);
    const el = $('#run-history');
    if (!el) return;
    el.innerHTML = rows.length
      ? rows.map((row) => historyRowHtml(row)).join('')
      : '<li class="queue-empty">No runs recorded yet.</li>';
  } catch {
    // History is optional; a failure must not break the console.
  }
}

async function restoreQueue() {
  if (!desktop?.listQueues) return;
  try {
    const queues = await desktop.listQueues();
    if (!Array.isArray(queues)) return;
    // Issue 255: restore the queue that belongs to the open project, not
    // whichever queue happens to be newest. A finished queue fills the Queue
    // tab and badge; only a live one may paint the header.
    const matching = queues.filter((queue) => queueBelongsToProject(queue));
    const live = matching.find((queue) => ['running', 'queued', 'paused'].includes(String(queue.status)));
    const target = live || matching[0] || null;
    if (target) {
      applyQueue(target, { paintHeader: ['running', 'queued', 'paused'].includes(String(target.status)) });
      return;
    }
    const other = queues[0] || null;
    if (other) noteForeignQueue(other);
    renderRunLast();
  } catch {
    // No queue history yet.
  }
}

function applyOpenedProject(result) {
  if (!result || result.canceled) return false;
  if (result.error) {
    toast(`Could not open project: ${result.error.message}`);
    return false;
  }
  // Issue 255: capture where the previous queue went before replacing the
  // project, then clear the console. A fresh project must not inherit counters,
  // a title or an outcome hint from the one that was on screen.
  const previousQueue = resetRunConsoleForProjectSwap();
  state.project = result.project;
  hydrateProject(state.project);
  // Issue 160: the queue may already be restored — it is read at start up, before
  // any project file exists — so the verdicts are applied here, where the blocks
  // finally exist, and before the project is marked saved: otherwise simply
  // opening a project would immediately read as unsaved.
  syncNodeStatesFromQueue(state.queue);
  state.selected = { type: 'project', id: null };
  state.history = null;
  markProjectSaved(result.path);
  const name = $('#project-name-text');
  if (name) name.textContent = state.project.name || 'Untitled project';
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
  state.statusMessage = result.migrated
    ? `Opened ${result.path} · migrated from v0.1 to schema v${state.project.schemaVersion}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
    : `Opened ${result.path}`;
  if (previousQueue && !queueBelongsToProject(previousQueue)) noteForeignQueue(previousQueue);
  renderQueue();
  updateRunTabBadges();
  renderRunLast();
  renderGraph();
  renderInspector();
  updateCounts();
  updateRunConsoleCopy();
  syncRunnerInputs();
  // Attach the new project's own queue (if any) after the shell has reset.
  restoreQueue().catch(() => {});
  toast(result.migrated ? 'Project opened and migrated to schema v1.' : 'Project opened.');
  return true;
}

async function openProjectPath(filePath) {
  if (!desktop) { toast('Open the Electron app to use native project files.'); return; }
  if (!filePath) return;
  try {
    const result = await desktop.openProjectPath(filePath);
    applyOpenedProject(result);
  } catch (error) {
    toast(`Could not open project: ${error.message}`);
  }
}

async function openProject() {
  if (!desktop) { toast('Open the Electron app to use native project files.'); return; }
  closeProjectMenu();
  // issue 149: the same unsaved-changes prompt guards every path that swaps the
  // project in memory, so Open project… and a recent entry cannot lose work.
  requestProjectReplacement(async () => {
    try {
      const result = await desktop.openProject();
      applyOpenedProject(result);
    } catch (error) {
      toast(`Could not open project: ${error.message}`);
    }
  });
}

/** Open a recorded recent path; main refuses anything that is not in its list. */
async function openRecentProject(filePath) {
  if (!desktop?.openRecentProject) {
    toast('Open the Electron app to use recent projects.');
    return;
  }
  closeProjectMenu();
  requestProjectReplacement(async () => {
    try {
      const result = await desktop.openRecentProject(filePath);
      if (result?.canceled) return;
      if (result?.error) {
        toast(`Could not open project: ${result.error.message}`);
        return;
      }
      applyOpenedProject(result);
    } catch (error) {
      toast(`Could not open project: ${error.message}`);
    }
  });
}

/**
 * Ask before a menu action replaces the project in memory. `run` is held on the
 * drawer (like the template chooser's step) so the confirm button can resume
 * exactly the action the user chose.
 */
function requestProjectReplacement(run) {
  if (typeof run !== 'function') return;
  if (!hasUnsavedChanges()) {
    run();
    return;
  }
  state.drawer = {
    type: 'replace-confirm',
    run,
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => {
    $('#modal')?.querySelector('[data-action="confirm-replace"]')?.focus();
  });
}

/* ── New project from a template ──────────────────────────── */

const BLANK_TEMPLATE = Object.freeze({
  id: 'blank',
  name: 'Blank project',
  description: 'One empty calculation block with the default route and gates.',
  blockCount: 1,
});

function hasUnsavedChanges() {
  // "Unsaved" means different from what the session loaded, not "has no file":
  // the seeded demo would otherwise warn about changes nobody made.
  const baseline = state.savedSnapshot ?? state.draftBaseline ?? null;
  return baseline === null || JSON.stringify(state.project) !== baseline;
}

/**
 * Open the template chooser in the shared modal shell. The modal is also where
 * an unsaved project is confirmed: there is no native confirm dialog in this
 * renderer, and an inline step keeps the decision keyboard-accessible and
 * testable.
 */
function openNewProject() {
  state.drawer = {
    type: 'template',
    step: hasUnsavedChanges() ? 'confirm' : 'choose',
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => {
    const modal = $('#modal');
    modal?.querySelector('button, [tabindex]:not([tabindex="-1"])')?.focus();
  });
}

function templateRow(template) {
  const count = Number(template.blockCount) || 0;
  return `<button type="button" class="palette-item" data-action="apply-template" data-template-id="${esc(template.id)}">
    <span class="palette-copy" style="flex:1;min-width:0">
      <strong>${esc(template.name)}</strong>
      <small>${esc(template.description)}</small>
    </span>
    <span class="status-pill">${count} block${count === 1 ? '' : 's'}</span>
  </button>`;
}

/**
 * Open the batch-import drawer and scan a folder. The drawer is shown first
 * with a loading line so a big folder does not look like a dead button.
 */
async function openBatchImport() {
  if (!desktop?.importLogDirectory) {
    toast('Open the desktop app to scan a folder of logs.');
    return;
  }
  state.drawer = {
    type: 'batch',
    loading: true,
    rows: [],
    skipped: [],
    directory: '',
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  try {
    const result = await desktop.importLogDirectory();
    if (!state.drawer || state.drawer.type !== 'batch') return;
    if (!result || result.canceled) {
      closeDrawer();
      return;
    }
    if (result.error) {
      state.drawer = { ...state.drawer, loading: false, error: result.error.message };
    } else {
      state.drawer = {
        ...state.drawer,
        loading: false,
        rows: Array.isArray(result.rows) ? result.rows : [],
        skipped: Array.isArray(result.skipped) ? result.skipped : [],
        directory: result.directory || '',
      };
    }
  } catch (error) {
    if (!state.drawer || state.drawer.type !== 'batch') return;
    state.drawer = { ...state.drawer, loading: false, error: error.message };
  }
  renderDrawer();
}

/**
 * Batch import: a read-only index of every log in a folder. The rows come from
 * the same parser a live run uses, so a status here means what it means there.
 */
function renderBatchImport() {
  const modal = $('#modal');
  const drawer = state.drawer;
  if (!modal || drawer?.type !== 'batch') return;
  const rows = Array.isArray(drawer.rows) ? drawer.rows : [];
  const skipped = Array.isArray(drawer.skipped) ? drawer.skipped : [];
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  const bodyHtml = drawer.loading
    ? '<p class="inspector-note">Scanning the folder…</p>'
    : drawer.error
      ? `<div class="callout red">${esc(drawer.error)}</div>`
      : rows.length === 0
        ? '<div class="callout">No <code>.log</code> or <code>.out</code> files were found in that folder.</div>'
        : `<div class="batch-table-wrap"><table class="batch-table">
            <thead><tr><th>File</th><th>Status</th><th>Level</th><th class="num">E / Eh</th><th class="num">G / Eh</th><th class="num">Imag.</th><th>Cause</th></tr></thead>
            <tbody>${rows.map((row) => {
              const level = [row.method, row.basis].filter(Boolean).join('/') || (row.engine === 'xtb' ? row.method || 'xTB' : '—');
              return `<tr data-log-name="${esc(row.name)}" class="is-${esc(row.status)}">
                <td class="batch-name">${esc(row.name)}</td>
                <td><span class="batch-status is-${esc(row.status)}">${esc(row.status)}</span></td>
                <td>${esc(level)}${row.jobType ? ` <span class="batch-job">${esc(row.jobType)}</span>` : ''}</td>
                <td class="num">${row.finalEnergyHartree === null ? '—' : esc(row.finalEnergyHartree.toFixed(6))}</td>
                <td class="num">${row.gibbsHartree === null ? '—' : esc(row.gibbsHartree.toFixed(6))}</td>
                <td class="num">${row.imaginaryCount === null ? '—' : esc(row.imaginaryCount)}</td>
                <td class="batch-cause">${esc(row.errorCause || '')}</td>
              </tr>`;
            }).join('')}</tbody></table></div>
            ${skipped.length ? `<div class="callout" style="margin-top:10px"><strong>${skipped.length} file(s) skipped:</strong> ${esc(skipped.map((item) => `${item.name} (${item.reason})`).join('; '))}</div>` : ''}`;

  const summary = rows.length
    ? `${rows.length} log${rows.length === 1 ? '' : 's'} · ${counts.completed || 0} completed · ${counts.error || 0} error · ${counts.incomplete || 0} incomplete`
    : '';

  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Batch import</span>
        <h2 id="modal-title">Logs in this folder</h2>
        <p>${drawer.directory ? esc(drawer.directory) : 'Read-only index; nothing is imported into the project.'}</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      ${bodyHtml}
    </div>
    <div class="modal-foot">
      <div class="modal-note">${esc(summary)}</div>
      <button type="button" class="btn" data-modal-close>Close</button>
    </div>`;
}

/**
 * The unsaved-changes prompt for actions that replace the open project (issue 149).
 * Same modal shell and same wording as the template chooser's confirm step; the
 * pending action is resumed only after the user chooses Discard.
 */
function renderReplaceConfirm() {
  const modal = $('#modal');
  if (!modal || state.drawer?.type !== 'replace-confirm') return;
  const current = state.project?.name || 'Untitled project';
  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Unsaved changes</span>
        <h2 id="modal-title">Discard unsaved changes?</h2>
        <p>Continuing replaces the graph that is open now.</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="callout red"><strong>“${esc(current)}” has unsaved changes.</strong> The project is replaced in memory, and the app keeps no undo copy of it.</div>
      <p class="inspector-note" style="margin-top:10px">Save the project first if you want to keep it. Cancel here leaves this project exactly as it is.</p>
    </div>
    <div class="modal-foot">
      <div class="modal-note">Nothing is written or closed until you choose.</div>
      <button type="button" class="btn" data-modal-close>Keep editing</button>
      <button type="button" class="btn primary" data-action="confirm-replace">Discard and continue</button>
    </div>`;
}

/**
 * The 2D-drawing run gate (issue 139).
 *
 * A CDXML record is page coordinates with z = 0: a depiction. A flow whose first
 * block is a frequency or a single point would report on the drawing, not the
 * molecule, so the planner refuses those tasks and this sheet asks. Confirming
 * writes `drawingConfirmed` on each record — the decision belongs to the record,
 * not to one queue — and the workflow is planned again from that answer.
 * Cancelling queues nothing and changes nothing.
 */
function openDrawingGate(refusals) {
  // A block that expands (a spin sweep, a method ladder) produces one refused
  // task per expansion; the sheet asks once per record and block.
  const seen = new Set();
  const unique = [];
  for (const refusal of Array.isArray(refusals) ? refusals : []) {
    const key = `${refusal.datasetId}|${refusal.recordId}|${refusal.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(refusal);
  }
  state.drawer = {
    type: 'drawing-gate',
    refusals: unique,
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => {
    $('#modal')?.querySelector('[data-action="confirm-drawing"]')?.focus();
  });
}

function renderDrawingGate() {
  const modal = $('#modal');
  if (!modal || state.drawer?.type !== 'drawing-gate') return;
  const refusals = Array.isArray(state.drawer.refusals) ? state.drawer.refusals : [];
  const rows = refusals.map((entry) => `
    <li><strong>${esc(entry.recordLabel || entry.recordId)}</strong> — ${esc(entry.blockTitle || entry.blockId)}
      <span class="record-id">${esc(entry.jobType)}</span></li>`).join('');
  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Run gate · 2D drawing</span>
        <h2 id="modal-title">Run ${refusals.length === 1 ? 'a drawing' : `${refusals.length} drawings`} without building a geometry first?</h2>
        <p>The first block of this flow reads the coordinates it is given.</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="callout red"><strong>A drawing gives numbers about itself, not the molecule.</strong>
        These records are ChemDraw page coordinates: bond lengths are typographic, every atom sits at z = 0,
        and the hydrogens the drawing left implicit are not there. A frequency on that layout reports modes
        of the layout; a single point reports its energy.</div>
      <ul class="inspector-note" style="margin:12px 0 0 18px">${rows}</ul>
      <p class="inspector-note" style="margin-top:12px">Put an optimisation before this block, or confirm here.
        Confirming is stored on each record, so the next run of this flow does not ask again.</p>
    </div>
    <div class="modal-foot">
      <div class="modal-note">Nothing is queued unless you confirm.</div>
      <button type="button" class="btn" data-modal-close>Cancel</button>
      <button type="button" class="btn primary" data-action="confirm-drawing">Use the drawings and continue</button>
    </div>`;
}

/** Record the user's answer on the records themselves, then plan again. */
function confirmDrawingGate() {
  const refusals = Array.isArray(state.drawer?.refusals) ? state.drawer.refusals : [];
  const datasets = Array.isArray(state.project?.datasets) ? state.project.datasets : [];
  let confirmed = 0;
  for (const refusal of refusals) {
    const dataset = refusal.datasetId
      ? datasets.find((entry) => entry.id === refusal.datasetId)
      : null;
    const pools = dataset ? [dataset] : datasets;
    for (const pool of pools) {
      for (const record of Array.isArray(pool.records) ? pool.records : []) {
        if (record.id !== refusal.recordId || record.geometry?.dimension !== '2d') continue;
        record.drawingConfirmed = true;
        confirmed += 1;
      }
    }
  }
  closeDrawer();
  if (confirmed === 0) {
    toast('The drawing record could not be found; nothing was confirmed.');
    return;
  }
  renderInspector();
  startWorkflow();
}

/** Rename is a project field, not a file rename: the next Save writes the name. */
function renderRenameProject() {
  const modal = $('#modal');
  if (!modal || state.drawer?.type !== 'rename-project') return;
  const name = state.drawer.draft?.name || '';
  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Project</span>
        <h2 id="modal-title">Rename project</h2>
        <p>The name is stored inside the <code>.ncs</code> file. The file name does not change.</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="form-section">
        <label class="section-label" for="project-name-input">Project name</label>
        <input class="input" id="project-name-input" data-drawer-field="name" value="${esc(name)}" maxlength="120" autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="modal-foot">
      <div class="modal-note">The graph and file path are unchanged.</div>
      <button type="button" class="btn" data-modal-close>Cancel</button>
      <button type="button" class="btn primary" data-action="save-project-name">Rename</button>
    </div>`;
}

function renderTemplateChooser() {
  const modal = $('#modal');
  if (!modal || state.drawer?.type !== 'template') return;

  if (state.drawer.step === 'confirm') {
    const current = state.project.name || 'Untitled project';
    modal.innerHTML = `
      <div class="modal-head">
        <div>
          <span class="eyebrow">New project</span>
          <h2 id="modal-title">Discard unsaved changes?</h2>
          <p>Starting a new project replaces the graph that is open now.</p>
        </div>
        <button type="button" class="icon-btn" data-modal-close aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="callout red"><strong>“${esc(current)}” has unsaved changes.</strong> The template chooser replaces this project in memory, and the app keeps no undo copy of it.</div>
        <p class="inspector-note" style="margin-top:10px">Save the project first if you want to keep it. A new project starts clean and its first Save opens Save As.</p>
      </div>
      <div class="modal-foot">
        <div class="modal-note">Nothing is written to disk until you save the new project.</div>
        <button type="button" class="btn" data-modal-close>Keep editing</button>
        <button type="button" class="btn primary" data-action="template-discard">Discard and choose</button>
      </div>`;
    return;
  }

  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">New project</span>
        <h2 id="modal-title">Start from a template</h2>
        <p>A ready-made starting graph you can edit; nothing is written until you save.</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="form-section">
        <div class="section-label">Start from scratch</div>
        <button type="button" class="palette-item" data-action="new-blank-settings">
          <span class="palette-copy" style="flex:1;min-width:0">
            <strong>Blank project</strong>
            <small>One empty optimisation block. Set the engine, method and basis before it runs.</small>
          </span>
          <span class="status-pill">configure settings</span>
        </button>
      </div>
      <div class="form-section">
        <div class="section-label">Or start from a template</div>
        <div class="dep-list">${WORKFLOW_TEMPLATES.map(templateRow).join('')}</div>
      </div>
      <div class="callout"><strong>Replaces the current project.</strong> The graph is swapped in memory, so Save asks for a new <code>.ncs</code> path instead of overwriting the file that was open.</div>
    </div>
    <div class="modal-foot">
      <div class="modal-note">Templates use the schema defaults. Set the molecule and route before a real run.</div>
      <button type="button" class="btn" data-modal-close>Cancel</button>
    </div>`;
}

/** Swap in a template project and start it clean, with no file path yet. */
function applyTemplateProject(templateId) {
  if (state.drawer?.type !== 'template') return;
  let project;
  try {
    project = templateId === BLANK_TEMPLATE.id ? blankProject() : templateProject(templateId);
  } catch (error) {
    toast(`Could not start from template: ${error.message}`);
    return;
  }
  // Issue 252: a new project adopts the app-wide defaults; a saved project
  // never does, because its own `defaults` travel with the file.
  applySettingsProjectDefaults(project);
  closeDrawer();
  const previousQueue = resetRunConsoleForProjectSwap();
  state.project = project;
  state.selected = { type: 'project', id: null };
  state.connecting = null;
  state.keyboardConnect = null;
  state.paletteOpen = false;
  state.history = null;
  // Issue 255: the previous project's queue is now history, not this project's
  // header. Name it instead of leaving its counters on screen.
  if (previousQueue && !queueBelongsToProject(previousQueue)) noteForeignQueue(previousQueue);
  renderRunLast();
  // markProjectSaved(null) clears the path (Save becomes Save As) and snapshots
  // the freshly built project, so it opens clean and the dirty flag clears.
  markProjectSaved(null);
  // A draft from the project we just replaced must not be offered next launch.
  clearDraft();
  const name = $('#project-name-text');
  if (name) name.textContent = state.project.name || 'Untitled project';
  state.statusMessage = templateId === BLANK_TEMPLATE.id
    ? 'Blank project · Save to choose a file name'
    : `Started "${state.project.name}" from a template · Save to choose a file name`;
  renderGraph();
  renderInspector();
  updateCounts();
  updateRunConsoleCopy();
  syncRunnerInputs();
  toast(templateId === BLANK_TEMPLATE.id ? 'Blank project created.' : 'Template applied.');
}

async function openStartupProject() {
  if (!desktop?.startupProject) return;
  try {
    const result = await desktop.startupProject();
    if (result?.path) await openProjectPath(result.path);
  } catch {
    // The seed project is still usable when a startup path cannot be read.
  }
}

/**
 * Run the project save flow. Returns 'saved' | 'canceled' | 'failed' |
 * 'unavailable' so the close guard can tell "the user backed out" from "the
 * write failed" — the window stays open in every non-saved case.
 */
async function saveProject() {
  if (!desktop) { toast('Open the Electron app to save a native project file.'); return 'unavailable'; }
  try {
    const result = await desktop.saveProject(state.project, state.projectPath);
    if (result.canceled) return 'canceled';
    if (result.error) {
      toast(`Could not save project: ${result.error.message}`);
      return 'failed';
    }
    if (result.project) state.project = result.project;
    markProjectSaved(result.path);
    // The work is on disk now, so the recovery copy has nothing left to offer.
    clearDraft();
    toast(`Saved ${result.path}`);
    return 'saved';
  } catch (error) {
    toast(`Could not save project: ${error.message}`);
    return 'failed';
  }
}

/**
 * Main asks for a save when the user picks "Save" in the close dialog (it owns
 * the window, the renderer owns the project). Answer exactly once: confirmClose
 * lets main close, cancelClose keeps the window open.
 */
function installCloseGuard() {
  if (!desktop?.onSaveAndClose) return;
  desktop.onSaveAndClose(async () => {
    const outcome = await saveProject();
    if (outcome === 'saved') {
      desktop.confirmClose?.();
      return;
    }
    // Anything else must leave the window alone: a failed save has already
    // toasted its reason, and a cancelled save dialog is the user saying no.
    if (outcome === 'canceled') toast('Close canceled: the project was not saved.');
    desktop.cancelClose?.();
  });
}

/**
 * Export the selected block as an NWChem / GAMESS / Q-Chem deck.
 *
 * The deck text comes from `exportDeckAction` → `renderBlockDeck`, the same
 * function `ncs export-input` calls, so the menu and the CLI cannot diverge.
 * A refusal (solvation, TD-DFT, `Opt Freq`, no geometry, an unlisted basis) is
 * shown as the exporter wrote it and nothing is saved.
 */
async function exportDeckInput(engineId) {
  await exportDeckAction({
    desktop,
    project: state.project,
    node: selectedCalcNode(),
    engine: engineId,
    notify: toast,
  });
}

async function exportSelectedInput() {
  const node = selectedCalcNode();
  if (!node) { toast('Select a calculation block to export its input.'); return; }
  let text;
  try {
    text = buildInputForNode(node);
  } catch (error) {
    toast(`Cannot export input: ${error.message}`);
    return;
  }
  const filename = `${safeBase(node.id)}.gjf`;
  if (desktop?.exportInput) {
    try {
      const result = await desktop.exportInput({ filename, text });
      if (result?.canceled) return;
      if (result?.error) { toast(`Could not export: ${result.error.message}`); return; }
      toast(`Exported ${result.path}`);
    } catch (error) {
      toast(`Could not export: ${error.message}`);
    }
    return;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${filename}.`);
}

/* ── Event wiring ─────────────────────────────────────────── */

/**
 * Bug-report helpers. The renderer contributes only the current project's
 * shape and engine defaults; the main process owns build, platform and run
 * history. Coordinates and atom data are never placed in this payload, so
 * there is nothing to redact out later.
 */
function validationErrorCountForDiagnostics() {
  const nodes = state.project?.nodes;
  if (!Array.isArray(nodes)) return null;
  const engineId = engineOrDefault(state.project?.defaults?.engine).id;
  const blocking = new Set(VALIDITY_CHECKS.filter((check) => check.blocking).map((check) => check.id));
  return nodes
    .filter((node) => node.type === 'calculate')
    .reduce((count, node) => {
      const ts = engineId === 'xtb' ? { errors: [] } : tsForceConstantIssues(node);
      const validity = runValidityChecks({
        settings: node.settings,
        molecule: moleculeForNode(node),
        parsed: null,
        upstream: validityUpstreamFor(node),
      }, { phase: 'pre', engine: engineId });
      const blockingErrors = validity.findings.filter((finding) => (
        finding.status === CHECK_STATUS.FAIL && blocking.has(finding.id)
      ));
      return count + ts.errors.length + blockingErrors.length;
    }, 0);
}

function diagnosticsProjectSummary() {
  const project = state.project || {};
  const defaults = project.defaults || {};
  return {
    project: {
      name: project.name || null,
      blockCount: Array.isArray(project.nodes) ? project.nodes.length : null,
      edgeCount: Array.isArray(project.edges) ? project.edges.length : null,
      validationErrors: validationErrorCountForDiagnostics(),
      defaults: {
        engine: defaults.engine || null,
        method: defaults.method || null,
        basis: defaults.basis || null,
        xtbMethod: defaults.xtbMethod || null,
        xtbOptLevel: defaults.xtbOptLevel || null,
        memory: defaults.memory || null,
        memoryUnit: defaults.memoryUnit || null,
        nproc: defaults.nproc || null,
      },
    },
  };
}

/** Clipboard first, a hidden textarea second; both stay entirely local. */
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied; the fallback may still work.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Export every finished run as one dataset file (CSV or JSON). The main process
 * writes it; the renderer only chooses the format.
 */
async function exportRunDataset(format) {
  if (!desktop?.exportDataset) {
    toast('Open the desktop app to export a run dataset.');
    return;
  }
  try {
    const result = await desktop.exportDataset(format === 'json' ? 'json' : 'csv');
    if (!result || result.canceled) return;
    if (result.error) {
      toast(`Could not export the dataset: ${result.error.message}`);
      return;
    }
    const count = Number(result.rowCount) || 0;
    toast(`Exported ${count} run${count === 1 ? '' : 's'} → ${result.path}`);
  } catch (error) {
    toast(`Could not export the dataset: ${error.message}`);
  }
}

async function copyDiagnostics() {
  if (!desktop?.collectDiagnostics) { toast('Open the desktop app to create a diagnostics bundle.'); return; }
  try {
    const markdown = await desktop.collectDiagnostics(diagnosticsProjectSummary());
    const copied = await copyTextToClipboard(markdown);
    toast(copied ? 'Diagnostics copied' : 'Could not copy diagnostics; use Save diagnostics instead.');
  } catch (error) {
    toast(`Could not collect diagnostics: ${error.message}`);
  }
}

async function saveDiagnostics() {
  if (!desktop?.collectDiagnostics || !desktop?.saveDiagnostics) {
    toast('Open the desktop app to save a diagnostics bundle.');
    return;
  }
  try {
    const markdown = await desktop.collectDiagnostics(diagnosticsProjectSummary());
    const result = await desktop.saveDiagnostics(markdown);
    if (result?.error) { toast(result.error.message); return; }
    if (result?.saved) {
      setStatusMessage(`Saved diagnostics to ${result.path}`);
      toast('Diagnostics saved.');
    }
  } catch (error) {
    toast(`Could not save diagnostics: ${error.message}`);
  }
}

/* ── Update notice (#82) ──────────────────────────────────── */

/**
 * The only outbound call the app can make, and only from this click. The
 * banner is assembled from DOM nodes rather than an HTML string: the version
 * and URL come from a remote response, and `esc()` exists to compose markup we
 * wrote, not to sanitise a value that must never be parsed as markup.
 */
async function checkForUpdatesAction() {
  if (!desktop?.checkForUpdates) {
    toast('Open the Electron app to check for GitHub releases.');
    return;
  }
  toast('Checking GitHub Releases…');
  let result = null;
  try {
    result = await desktop.checkForUpdates();
  } catch {
    // A rejected invoke is the same user-facing event as an unreachable host.
    result = null;
  }
  if (!result?.ok) {
    showUpdateBanner({ state: 'unreachable' });
    return;
  }
  if (!result.newer) {
    // `up-to-date` and `prerelease-not-offered` both mean this stable build is
    // as new as the channel allows. Any other reason means the list could not
    // be read, which is not the same claim and must not be shown as one.
    if (result.reason === 'up-to-date' || result.reason === 'prerelease-not-offered') {
      toast(`You are on the newest release${appVersion ? ` (v${appVersion})` : ''}.`);
    } else {
      showUpdateBanner({
        state: 'unreachable',
        message: result.reason === 'no-releases'
          ? 'No published release was found on GitHub.'
          : 'GitHub returned a release list this build could not read.',
      });
    }
    return;
  }
  showUpdateBanner({ state: 'newer', version: result.version, url: result.url });
}

function updateBannerElement() {
  let banner = $('#update-banner');
  if (banner) return banner;
  banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  document.body.appendChild(banner);
  return banner;
}

function showUpdateBanner(notice) {
  // The banner is the answer; a "Checking…" toast left underneath it would
  // claim the request is still in flight.
  const transient = $('#toast');
  if (transient) transient.hidden = true;
  clearTimeout(state.toastTimer);
  const banner = updateBannerElement();
  banner.textContent = '';
  const message = document.createElement('span');
  message.className = 'update-banner-text';
  message.textContent = notice.message ?? (notice.state === 'newer'
    ? `NodeChem Studio ${notice.version} is available.`
    : 'Could not reach GitHub. Check your connection and try again.');
  const actions = document.createElement('span');
  actions.className = 'update-banner-actions';
  if (notice.state === 'newer' && notice.url) {
    // `target="_blank"` is the existing external-link path: the main process
    // intercepts the window open and hands the URL to `shell.openExternal`.
    const link = document.createElement('a');
    link.className = 'btn small';
    link.href = notice.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Release notes';
    actions.appendChild(link);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'icon-btn';
  dismiss.dataset.action = 'dismiss-update';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss update notice');
  dismiss.textContent = '×';
  actions.appendChild(dismiss);
  banner.append(message, actions);
  banner.hidden = false;
}

function dismissUpdateBanner() {
  const banner = $('#update-banner');
  if (!banner) return;
  banner.hidden = true;
  banner.textContent = '';
}

function syncMenuButton(selector, open) {
  const button = $(selector);
  if (button) button.setAttribute('aria-expanded', String(open));
}

function closeAppMenu() {
  const menu = $('#app-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  syncMenuButton('#app-menu-btn', false);
}

function closeExportMenu() {
  const menu = $('#export-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  syncMenuButton('#export-menu-btn', false);
}

/* ── Project menu and recent projects (issue 149) ────────────────
 * The project name was already drawn as a menu trigger (`aria-haspopup`), but
 * its handler was a toast. This is the real menu: current-project actions, Open
 * project…, the last ten projects main recorded, and Clear recent list.
 */

let projectMenuLoad = 0;

function recentProjectRow(entry) {
  const name = entry.name || 'Untitled project';
  const missing = entry.missing === true;
  // Name, parent folder, engine summary and modified label all come from the
  // file/main's stat — never from this menu's assumptions.
  const meta = [
    entry.folder || 'Folder not recorded',
    entry.engineSummary || engineSummary(entry.engines),
    entry.modifiedLabel || formatRecentModified(entry.modifiedAt, Date.now()),
    missing ? 'not on disk' : '',
  ].filter(Boolean).join(' · ');
  const row = `<button type="button" class="overflow-item" role="menuitem" style="display:block;width:100%;min-width:0;text-align:left"${missing
    ? ' disabled aria-disabled="true"'
    : ` data-action="open-recent" data-recent-path="${esc(entry.path)}"`} title="${esc(entry.path)}">
      <span style="display:flex;align-items:baseline;gap:6px;min-width:0">
        <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        ${missing ? '<span class="status-pill review">Missing</span>' : ''}
      </span>
      <span style="display:block;color:var(--text-tertiary);font-size:var(--text-size-xs);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(meta)}</span>
    </button>`;
  if (!missing) return row;
  // A missing entry is visible but not openable; Remove is a separate menu item
  // so the disabled row is not the only thing the user can act on.
  return `<div role="none" style="display:flex;gap:2px;align-items:stretch">
    <div role="none" style="flex:1;min-width:0">${row}</div>
    <button type="button" class="overflow-item" role="menuitem" data-action="forget-recent" data-recent-path="${esc(entry.path)}" style="flex:0 0 auto" title="Remove this missing project from the list" aria-label="Remove ${esc(name)} from the recent list">Remove</button>
  </div>`;
}

function projectMenuHtml(entries, { loading = false, error = '' } = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  let recentBody;
  if (loading) recentBody = '<div class="overflow-note">Loading recent projects…</div>';
  else if (error) recentBody = `<div class="overflow-note">${esc(error)}</div>`;
  else if (!desktop?.recentProjects) recentBody = '<div class="overflow-note">Recent projects are available in the desktop app.</div>';
  else if (!rows.length) recentBody = '<div class="overflow-note">No recent projects. Open a <code>.ncs</code> file to start the list.</div>';
  else recentBody = rows.map(recentProjectRow).join('');

  const projectTitle = state.project?.name || 'Untitled project';
  return `
    <div class="overflow-note" role="presentation" style="padding-bottom:2px"><strong style="color:var(--text-secondary)">Current project</strong><br>${esc(projectTitle)}${state.projectPath ? `<br><span style="overflow-wrap:anywhere">${esc(state.projectPath)}</span>` : ' · not saved yet'}</div>
    <button type="button" class="overflow-item" role="menuitem" data-action="rename-project">Rename project…</button>
    <button type="button" class="overflow-item" role="menuitem" data-action="reveal-project"${state.projectPath ? '' : ' disabled'} title="${state.projectPath ? 'Show the project file in the file manager' : 'Save the project first'}">Reveal in file manager</button>
    <button type="button" class="overflow-item" role="menuitem" data-action="close-project">Close project</button>
    <div class="overflow-split" aria-hidden="true"></div>
    <button type="button" class="overflow-item" role="menuitem" data-action="open-project">Open project…</button>
    <div class="overflow-split" aria-hidden="true"></div>
    <div class="overflow-note" role="presentation" style="padding-bottom:2px"><strong style="color:var(--text-secondary)">Recent projects</strong></div>
    ${recentBody}
    <div class="overflow-split" aria-hidden="true"></div>
    <button type="button" class="overflow-item" role="menuitem" data-action="clear-recent"${rows.length ? '' : ' disabled'}>Clear recent list</button>`;
}

function focusFirstProjectMenuItem() {
  const menu = $('#project-menu');
  if (!menu || menu.hidden) return;
  const first = menu.querySelector('[role="menuitem"]:not([disabled])');
  first?.focus();
}

function closeProjectMenu({ focus = false } = {}) {
  const menu = $('#project-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  syncMenuButton('#project-menu-btn', false);
  if (focus) $('#project-menu-btn')?.focus();
}

async function toggleProjectMenu() {
  const menu = $('#project-menu');
  if (!menu) return;
  const opening = menu.hidden;
  closeAppMenu();
  closeExportMenu();
  if (!opening) {
    closeProjectMenu();
    return;
  }
  const load = ++projectMenuLoad;
  menu.innerHTML = projectMenuHtml([], { loading: Boolean(desktop?.recentProjects) });
  menu.hidden = false;
  syncMenuButton('#project-menu-btn', true);
  focusFirstProjectMenuItem();
  if (!desktop?.recentProjects) return;
  try {
    const result = await desktop.recentProjects();
    // The user may have closed the menu while the list was being read.
    if (load !== projectMenuLoad || menu.hidden) return;
    menu.innerHTML = projectMenuHtml(result?.entries, {});
    focusFirstProjectMenuItem();
  } catch (error) {
    if (load !== projectMenuLoad || menu.hidden) return;
    menu.innerHTML = projectMenuHtml([], { error: `Could not read the recent list: ${error.message}` });
    focusFirstProjectMenuItem();
  }
}

/** Re-render an open menu after Forget/Clear, keeping focus inside it. */
async function refreshProjectMenu() {
  const menu = $('#project-menu');
  if (!menu || menu.hidden || !desktop?.recentProjects) return;
  try {
    const result = await desktop.recentProjects();
    if (menu.hidden) return;
    menu.innerHTML = projectMenuHtml(result?.entries, {});
    focusFirstProjectMenuItem();
  } catch {
    // The project actions still work; only the list is unavailable.
  }
}

/** ↓/↑ move, Home/End jump, Esc closes and returns focus to the trigger. */
function onProjectMenuKeydown(event) {
  const menu = event.currentTarget;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeProjectMenu({ focus: true });
    return;
  }
  if (event.key === 'Tab') {
    closeProjectMenu();
    return;
  }
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const items = [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  if (!items.length) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  let next;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (index < 0) next = event.key === 'ArrowDown' ? 0 : items.length - 1;
  else next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
}

function setProjectNameLabel() {
  const name = $('#project-name-text');
  if (name) name.textContent = state.project?.name || 'Untitled project';
}

function openProjectRename() {
  closeProjectMenu();
  state.drawer = {
    type: 'rename-project',
    draft: { name: state.project?.name || '' },
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => {
    const input = $('#project-name-input');
    input?.focus();
    input?.select?.();
  });
}

function saveProjectName() {
  const input = $('#project-name-input');
  const value = String(input?.value || '').trim();
  if (!value) {
    toast('Enter a project name.');
    input?.focus();
    return;
  }
  closeDrawer();
  state.project.name = value;
  setProjectNameLabel();
  refreshDirty();
  renderInspector();
  toast('Project renamed. Save to write the new name to the file.');
}

/** Close the current project: the canvas returns to a clean blank project. */
function closeProject() {
  closeProjectMenu();
  requestProjectReplacement(() => {
    const previousQueue = resetRunConsoleForProjectSwap();
    state.project = blankProject();
    // Issue 252: closing a project creates a new blank one, so it adopts the
    // machine's project defaults just like a template does.
    applySettingsProjectDefaults(state.project);
    state.selected = { type: 'project', id: null };
    state.connecting = null;
    state.keyboardConnect = null;
    state.paletteOpen = false;
    state.history = null;
    // Issue 255: a closed project's queue is history, not a fresh project's run.
    if (previousQueue && !queueBelongsToProject(previousQueue)) noteForeignQueue(previousQueue);
    renderRunLast();
    markProjectSaved(null);
    clearDraft();
    setProjectNameLabel();
    state.statusMessage = 'Project closed · blank project in memory';
    renderGraph();
    renderInspector();
    updateCounts();
    updateRunConsoleCopy();
    syncRunnerInputs();
    toast('Project closed. The canvas now holds a blank project.');
  });
}

async function revealProjectInFileManager() {
  closeProjectMenu();
  if (!state.projectPath) {
    toast('Save the project first: there is no file to show yet.');
    return;
  }
  if (!desktop?.revealProject) {
    toast('Open the Electron app to show the project file.');
    return;
  }
  try {
    const result = await desktop.revealProject(state.projectPath);
    if (!result?.ok) toast(result?.error?.message || 'Could not show the project file.');
  } catch (error) {
    toast(`Could not show the project file: ${error.message}`);
  }
}

async function forgetRecentProject(filePath) {
  if (!desktop?.forgetRecentProject) return;
  try {
    await desktop.forgetRecentProject(filePath);
    await refreshProjectMenu();
    toast('Removed from the recent list.');
  } catch (error) {
    toast(`Could not update the recent list: ${error.message}`);
  }
}

async function clearRecentProjects() {
  if (!desktop?.clearRecentProjects) return;
  try {
    await desktop.clearRecentProjects();
    await refreshProjectMenu();
    toast('Recent projects cleared.');
  } catch (error) {
    toast(`Could not clear the recent list: ${error.message}`);
  }
}

/**
 * The application menu (File/Edit/Help equivalents) hangs off the brand mark.
 * Undo/redo are mirrored from the toolbar state so a disabled command does not
 * look available; everything else is the same action the topbar already uses.
 */
function toggleAppMenu() {
  const menu = $('#app-menu');
  if (!menu) return;
  const opening = menu.hidden;
  closeExportMenu();
  closeProjectMenu();
  if (!opening) {
    closeAppMenu();
    return;
  }
  const undo = $('#app-menu-undo');
  const redo = $('#app-menu-redo');
  if (undo) undo.disabled = !canUndo(state.history);
  if (redo) redo.disabled = !canRedo(state.history);
  menu.hidden = false;
  syncMenuButton('#app-menu-btn', true);
  menu.querySelector('.overflow-item:not(:disabled)')?.focus();
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'interrupted', 'timed out']);
const TERMINAL_QUEUE_STATUSES = new Set(['completed', 'failed', 'needs-review', 'blocked', 'cancelled', 'interrupted', 'skipped']);

/**
 * Only the exports that make sense for the current selection, grouped so the
 * menu never offers "export a run" when no run exists. Each entry is the same
 * data-action the old overflow menu used, so nothing here re-implements a flow.
 */
async function exportMenuGroups() {
  const groups = [];
  const node = selectedCalcNode();
  if (node) {
    groups.push([
      {
        label: `Input file — ${node.title} (.gjf)`,
        attrs: 'data-action="export"',
      },
      // Export-only engines (issue 148): the label says "export only" wherever
      // the engine is named, because this build cannot run them. The text comes
      // from `renderBlockDeck`, the same function `ncs export-input` uses.
      {
        label: `NWChem input (.nw) — ${node.title}, export only`,
        attrs: 'data-action="export-deck" data-engine="nwchem"',
      },
      {
        label: `GAMESS input (.inp) — ${node.title}, export only`,
        attrs: 'data-action="export-deck" data-engine="gamess"',
      },
      {
        label: `Q-Chem input (.qcin) — ${node.title}, export only`,
        attrs: 'data-action="export-deck" data-engine="qchem"',
      },
    ]);
  }
  const hasCalc = (state.project?.nodes || []).some((item) => item.type === 'calculate');
  if (hasCalc) {
    groups.push([
      { label: 'SLURM script set…', attrs: 'data-action="cluster" data-cluster-op="export" data-cluster-format="slurm"' },
      { label: 'PBS script set…', attrs: 'data-action="cluster" data-cluster-op="export" data-cluster-format="pbs"' },
    ]);
  }
  const results = [];
  if (state.run.id && TERMINAL_RUN_STATUSES.has(state.run.status)) {
    results.push({ label: 'Run bundle (methods.md, manifest, files)…', attrs: 'data-action="export-run-bundle"' });
  }
  if (state.queue.id && TERMINAL_QUEUE_STATUSES.has(state.queue.status)) {
    results.push({ label: 'Workflow report (report.html)…', attrs: 'data-action="export-workflow-report"' });
  }
  if (results.length) groups.push(results);

  let runs = [];
  if (desktop?.listRuns) {
    try { runs = (await desktop.listRuns()) || []; } catch { runs = []; }
  }
  if (Array.isArray(runs) && runs.length > 0) {
    const count = runs.length;
    groups.push([
      { label: `Run dataset (CSV) — ${count} run${count === 1 ? '' : 's'}…`, attrs: 'data-action="export-dataset" data-dataset-format="csv"' },
      { label: 'Run dataset (JSON)…', attrs: 'data-action="export-dataset" data-dataset-format="json"' },
    ]);
  }
  return groups;
}

async function toggleExportMenu() {
  const menu = $('#export-menu');
  if (!menu) return;
  const opening = menu.hidden;
  closeAppMenu();
  closeProjectMenu();
  if (!opening) {
    closeExportMenu();
    return;
  }
  const groups = await exportMenuGroups();
  menu.innerHTML = groups.length
    ? groups
      .map((group) => group
        .map((entry) => `<button class="overflow-item" role="menuitem" ${entry.attrs}>${esc(entry.label)}</button>`)
        .join(''))
      .join('<div class="overflow-split" aria-hidden="true"></div>')
    : '<div class="overflow-note">Nothing selected can be exported. Pick a calculation block, run one, or finish a queue first.</div>';
  menu.hidden = false;
  syncMenuButton('#export-menu-btn', true);
  menu.querySelector('.overflow-item')?.focus();
}

function handleAction(action, element) {
  switch (action) {
    case 'toggle-app-menu': toggleAppMenu(); break;
    // Issue 252: app-wide settings, distinct from per-project settings.
    case 'open-app-settings': openAppSettings(element.dataset.settingsPage || 'engines'); break;
    case 'save-app-settings': saveAppSettings(); break;
    case 'settings-page':
      if (state.drawer?.type === 'app-settings') {
        state.drawer.page = element.dataset.settingsPage || 'engines';
        renderAppSettings();
      }
      break;
    case 'settings-detect': refreshSettingsDetection(); break;
    case 'settings-browse': browseSettingsPath(element.dataset.settingsBrowse); break;
    case 'settings-reset-console': dockRunConsole(); toast('Run console returned to the corner.'); break;
    case 'toggle-export-menu': toggleExportMenu(); break;
    case 'quit': window.close(); break;
    case 'toggle-palette': togglePalette(); break;
    case 'add-flow': addFlow(); break;
    case 'duplicate-flow': duplicateActiveFlow(); break;
    case 'rename-flow': startFlowRename(); break;
    case 'delete-flow': requestDeleteFlow(); break;
    case 'confirm-delete-flow': confirmDeleteFlow(); break;
    case 'cancel-delete-flow': cancelDeleteFlow(); break;
    case 'import-dataset': {
      if (state.selected.type === 'node') state.datasetImportNodeId = state.selected.id;
      $('#dataset-file')?.click();
      break;
    }
    case 'import-dataset-paste': {
      const nodeId = state.selected.type === 'node' ? state.selected.id : state.datasetImportNodeId;
      importDatasetText($('#dataset-paste')?.value || '', {
        format: $('#dataset-paste-format')?.value || '',
        nodeId,
      });
      break;
    }
    // Issue 169 and issue 189: the switches of a structure block — series,
    // derivative scan, or plain dataset.
    case 'series-enable': enableSeries(); break;
    case 'series-disable': disableSeries(); break;
    case 'derivative-enable': enableDerivative(); break;
    case 'derivative-disable': disableDerivative(); break;
    // Issue 188: the complex half of a structure block.
    case 'complex-enable': enableComplex(); break;
    case 'complex-disable': disableComplex(); break;
    case 'complex-add-member': addComplexMember(); break;
    case 'complex-remove-member': removeComplexMember(Number(element?.dataset?.complexIndex)); break;
    case 'derivative-add-edit': addDerivativeEdit(); break;
    case 'derivative-remove-edit': removeDerivativeEdit(Number(element?.dataset?.derivativeIndex)); break;
    // Issue 175: the input rows of a compute block.
    case 'compute-add-input': addComputeInput(); break;
    case 'compute-remove-input': removeComputeInput(Number(element?.dataset?.computeIndex)); break;
    case 'dp4-add-row': addDp4Row(); break;
    case 'dp4-remove-row': removeDp4Row(Number(element?.dataset?.dp4Index)); break;
    case 'validate': validateGraph(); break;
    case 'zoom-in': setZoom(state.zoom + 0.05); break;
    case 'zoom-out': setZoom(state.zoom - 0.05); break;
    case 'fit': fitGraph(); break;
    case 'close-inspector': state.inspectorHidden = true; renderInspector(); break;
    case 'open-inspector': state.inspectorHidden = false; renderInspector(); break;
    case 'toggle-wide': state.inspectorWide = !state.inspectorWide; renderInspector(); break;
    case 'duplicate-node':
      if (state.selected.type === 'node') duplicateNode(state.selected.id);
      break;
    case 'delete-node':
      if (state.selected.type === 'node') removeNode(state.selected.id);
      break;
    case 'remove-edge':
      if (state.selected.type === 'edge') removeEdge(state.selected.id);
      break;
    case 'set-checkpoint':
      if (state.selected.type === 'edge') setCheckpoint(state.selected.id, true);
      break;
    case 'clear-checkpoint':
      if (state.selected.type === 'edge') setCheckpoint(state.selected.id, false);
      break;
    case 'select-false': {
      const node = state.selected.type === 'node' ? nodeById(state.selected.id) : null;
      const edge = node && state.project.edges.find((item) => item.from === node.id && item.type === 'branch' && item.branch === 'false');
      if (edge) selectNode(edge.to);
      else toast('No FALSE branch is connected yet.');
      break;
    }
    case 'add-constraint': addConstraint(); break;
    case 'remove-constraint': removeConstraint(Number(element.dataset.constraintIndex)); break;
    case 'qst-fill': fillQstStructure(Number(element.dataset.qstIndex)); break;
    case 'qst-pick-file': $('#qst-file-' + Number(element.dataset.qstIndex))?.click(); break;
    case 'add-fragment':
      if (state.drawer) { state.drawer.draft.fragments.push(''); renderDrawer(); }
      break;
    case 'import-structure': $('#structure-file')?.click(); break;
    case 'clear-geometry': clearImportedGeometry(); break;
    case 'save-molecule': saveMolecule(); break;
    case 'open-run-console': openRunConsole(); break;
    case 'close-run-console': closeRunConsole(); break;
    case 'dock-run-console': dockRunConsole(); break;
    case 'pick-gaussian': pickGaussian(); break;
    case 'preflight': preflightRun(); break;
    case 'run-selected': startSelectedRun(); break;
    case 'run-workflow': startWorkflow(); break;
    case 'select-conformer': selectConformer(element.dataset.conformerId); break;
    case 'pick-ensemble': pickEnsembleFile(); break;
    case 'pick-crest': pickCrest(); break;
    case 'pick-obabel': pickObabel(); break;
    case 'pick-scorer': pickCompanionTool('scorer'); break;
    case 'pick-multiwfn': pickCompanionTool('multiwfn'); break;
    case 'pick-tautomer': pickCompanionTool('tautomer'); break;
    case 'pause-workflow': pauseWorkflow(); break;
    case 'export-workflow-report': exportWorkflowReportAction(); break;
    case 'resume-workflow': resumeWorkflow(); break;
    case 'cancel-workflow': cancelWorkflow(); break;
    case 'refresh-history': refreshHistory(); break;
    case 'open-history-queue': openHistoryQueue(element.dataset.queueId || ''); break;
    case 'toggle-queue-reason': {
      const item = element.closest('.queue-item');
      if (item) {
        const expanded = item.classList.toggle('is-expanded');
        element.setAttribute('aria-expanded', String(expanded));
        element.textContent = expanded ? 'Show less' : 'Show full reason';
      }
      break;
    }
    case 'run-hint-fix': applyRunHintFix(element); break;
    case 'failure-fix': applyRunHintFix(element); break;
    case 'cancel-run': cancelRun(); break;
    case 'verify-run': verifyCurrentRun(); break;
    case 'export-run-bundle':
      exportRunBundleAction({ desktop, runId: state.run.id, notify: toast });
      break;
    case 'export-run-format': {
      const choice = document.getElementById('run-export-format')?.value || 'extxyz';
      exportRunFormatAction({ desktop, runId: state.run.id, choice, notify: toast });
      break;
    }
    case 'copy-diagnostics': copyDiagnostics(); break;
    case 'export-dataset': exportRunDataset(element.dataset.datasetFormat); break;
    case 'save-diagnostics': saveDiagnostics(); break;
    case 'check-updates': checkForUpdatesAction(); break;
    case 'dismiss-update': dismissUpdateBanner(); break;
    case 'open-project': openProject(); break;
    case 'undo': undoEdit(); break;
    case 'redo': redoEdit(); break;
    case 'new-project': openNewProject(); break;
    case 'template-discard':
      if (state.drawer?.type === 'template') {
        state.drawer.step = 'choose';
        renderDrawer();
      }
      break;
    case 'apply-template': applyTemplateProject(element.dataset.templateId); break;
    case 'new-blank-settings': {
      // Blank project first (it closes the chooser), then its settings drawer,
      // so the route is configured before the first block exists.
      applyTemplateProject(BLANK_TEMPLATE.id);
      openSettingsDrawer();
      break;
    }
    case 'save-project': saveProject(); break;
    case 'export': exportSelectedInput(); break;
    case 'export-deck': exportDeckInput(element.dataset.engine); break;
    case 'cluster':
      runClusterAction({
        op: element.dataset.clusterOp,
        format: element.dataset.clusterFormat,
        project: state.project,
        buildTasks: buildWorkflowTasks,
        notify: toast,
      });
      break;
    case 'import-log': openBatchImport(); break;
    case 'import-log-directory': openBatchImport(); break;
    case 'view-output': openRunConsole(); break;
    case 'project-menu': toggleProjectMenu(); break;
    case 'toggle-project-menu': toggleProjectMenu(); break;
    case 'rename-project': openProjectRename(); break;
    case 'save-project-name': saveProjectName(); break;
    case 'reveal-project': revealProjectInFileManager(); break;
    case 'close-project': closeProject(); break;
    case 'open-recent': openRecentProject(element.dataset.recentPath); break;
    case 'forget-recent': forgetRecentProject(element.dataset.recentPath); break;
    case 'clear-recent': clearRecentProjects(); break;
    case 'confirm-replace': {
      const run = state.drawer?.run;
      closeDrawer();
      if (typeof run === 'function') run();
      break;
    }
    case 'confirm-drawing': confirmDrawingGate(); break;
    case 'about': toast(`NodeChem Studio — the graph is the workspace. The inspector exposes the full job parameter set; the local runner executes one selected block or the whole workflow queue${appVersion ? ` (v${appVersion})` : ''}. Some capabilities are CLI-only by design: ncs export, ncs record import, ncs diff, ncs merge, ncs export-input, ncs qcschema, ncs cache, ncs validation. docs/guide/cli.md lists every command and where it lives.`); break;
    default: break;
  }
}

function onDocumentClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) handleAction(actionEl.dataset.action, actionEl);

  // A command chosen from one of the dropdowns closes it; a click anywhere
  // outside closes the dropdown that owns the click target.
  if (actionEl?.closest('#app-menu, #export-menu')) {
    closeAppMenu();
    closeExportMenu();
  } else {
    if (!event.target.closest('.brand-wrap')) closeAppMenu();
    if (!event.target.closest('.export-wrap')) closeExportMenu();
  }
  // The project menu sits in its own wrapper, so it is closed independently of
  // the brand and export dropdowns. A click on its chrome (a heading) keeps it
  // open; a command or an outside click closes it.
  if (actionEl?.closest('#project-menu')) closeProjectMenu();
  else if (!event.target.closest('#project-menu, #project-menu-btn')) closeProjectMenu();

  const nodeButton = event.target.closest('[data-select-node]');
  if (nodeButton) selectNode(nodeButton.dataset.selectNode);

  const modalButton = event.target.closest('[data-open-modal]');
  if (modalButton) {
    if (modalButton.dataset.openModal === 'molecule') openMoleculeDrawer();
    else if (modalButton.dataset.openModal === 'settings') openSettingsDrawer();
  }

  const blockButton = event.target.closest('[data-block]');
  if (blockButton) addBlock(blockButton.dataset.block);

  const flowTab = event.target.closest('[data-flow-id]');
  if (flowTab) switchFlow(flowTab.dataset.flowId);

  const runTab = event.target.closest('[data-run-tab]');
  if (runTab) {
    const disabled = runTab.classList.contains('is-disabled');
    if (!disabled) setRunPane(runTab.dataset.runTab, { user: true });
    else if (runTab.dataset.runTab === 'results') toast('No parsed results yet — run a block or a workflow.');
  }

  const recordRow = event.target.closest('[data-record-peek]');
  if (recordRow && state.drawer) {
    state.drawer.peekIndex = Number(recordRow.dataset.recordPeek) || 0;
    renderDrawer();
  }

  const loadRecord = event.target.closest('[data-action="load-record"]');
  if (loadRecord && state.drawer) {
    const { records } = projectDatasetRecords();
    const record = records[Number(loadRecord.dataset.recordIndex) || 0];
    if (record && Array.isArray(record.coords) && record.coords.length) {
      state.drawer.draft.coords = record.coords.map((atom) => ({ ...atom }));
      state.drawer.draft.charge = Number.isInteger(record.charge) ? record.charge : state.drawer.draft.charge;
      state.drawer.draft.multiplicity = Number.isInteger(record.multiplicity) ? record.multiplicity : state.drawer.draft.multiplicity;
      state.drawer.draft.geometry = { source: 'manual', file: '', format: '' };
      state.drawer.tab = 'structure';
      renderDrawer();
      toast(`${record.label || record.id} loaded into the editor — save to apply.`);
    }
  }

  const drawerTab = event.target.closest('[data-drawer-tab]');
  if (drawerTab && state.drawer) {
    state.drawer.tab = drawerTab.dataset.drawerTab;
    renderDrawer();
    requestAnimationFrame(() => {
      $('#modal')?.querySelector('button, input, select, textarea')?.focus();
    });
  }

  if (event.target.closest('[data-modal-close]')) closeDrawer();

  if (state.paletteOpen && !event.target.closest('#palette') && !event.target.closest('[data-action="toggle-palette"]')) {
    togglePalette(false);
  }
}

function onDocumentChange(event) {
  const target = event.target;
  if (target.dataset.settingsField && state.drawer?.type === 'app-settings') {
    setSettingsField(target.dataset.settingsField, target.type === 'checkbox' ? target.checked : target.value);
    return;
  }
  if (target.matches('[data-flow-rename]')) {
    commitFlowRename(target);
    return;
  }
  if (target.matches('[data-record-select]')) {
    const draft = state.drawer?.draft;
    if (!draft) return;
    applyImportedRecord(Number(target.value) || 0, draft.geometry?.file, draft.geometry?.format, draft.records.length);
    return;
  }
  if (target.id === 'structure-file') {
    const file = target.files?.[0];
    if (file) importStructureFile(file);
    target.value = '';
    return;
  }
  if (target.id === 'dataset-file') {
    const file = target.files?.[0];
    if (file) importDatasetFile(file);
    target.value = '';
    return;
  }
  if (target.id === 'run-dry' || target.id === 'run-exe' || target.id === 'run-scratch') {
    saveRunConfig();
    // The header chips name the engine and the run mode; both can change here.
    updateRunConsoleCopy();
    return;
  }
  if (target.id === 'run-max-parallel') {
    applyMaxParallel(target.value);
    return;
  }
  if (target.id === 'run-timeout') {
    applyTimeout(target.value);
    return;
  }
  if (target.dataset.prepareField) {
    applyPrepareField(target);
    return;
  }
  if (target.dataset.ensembleField) {
    applyEnsembleInputField(target);
    return;
  }
  if (target.dataset.inputField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'input') return;
    if (!node.input) node.input = { datasetId: '', recordFilter: { field: '', equals: '' } };
    node.input[target.dataset.inputField] = target.value;
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.seriesField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'input' || !node.input?.series) return;
    updateSeriesField(node, target.dataset.seriesField, target.value);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.complexMember !== undefined) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'input' || !node.input?.complex) return;
    updateComplexMember(node, Number(target.dataset.complexMember), target.value);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.complexField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'input' || !node.input?.complex) return;
    updateComplexField(node, target.dataset.complexField,
      target.type === 'checkbox' ? null : target.value, target.checked);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.derivativeEdit !== undefined) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'input' || !Array.isArray(node.input?.edits)) return;
    updateDerivativeField(node, Number(target.dataset.derivativeEdit), target.dataset.derivativeField, target.value);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.derivativeField === 'parent') {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'input' || !Array.isArray(node.input?.edits)) return;
    updateDerivativeField(node, null, 'parent', target.value);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.datasetRecord) {
    const dataset = datasetById(state.project, target.dataset.datasetId);
    const record = recordsOf(dataset).find((entry) => entry.id === target.dataset.datasetRecord);
    if (!record) return;
    record.enabled = target.checked;
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.constraintIndex !== undefined) {
    updateConstraintField(target);
    return;
  }
  if (target.dataset.qstIndex !== undefined) {
    updateQstField(target);
    return;
  }
  if (typeof target.id === 'string' && target.id.startsWith('qst-file-')) {
    const index = Number(target.id.slice('qst-file-'.length));
    const file = target.files?.[0];
    target.value = '';
    if (file && Number.isInteger(index)) importQstStructureFile(index, file);
    return;
  }
  if (target.dataset.nodeField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node) return;
    const key = target.dataset.nodeField;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    if (key === 'title') {
      node.title = String(value).trim() || node.title;
      renderGraph();
      renderInspector();
      return;
    }
    if (node.type !== 'calculate') return;
    updateNodeField(node, key, value);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.nodeGate) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'calculate') return;
    updateGate(node, target.dataset.nodeGate, target.checked);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.validityCheck) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'calculate') return;
    updateValidityCheck(node, target.dataset.validityCheck, target.checked);
    renderInspector();
    return;
  }
  // Issue 186: one multiplicity of a sweep's checkbox row. This is not a
  // settings key — the sweep object itself is rewritten.
  if (target.dataset.spinState) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'calculate') return;
    updateSpinSweepState(node, Number(target.dataset.spinState), target.checked);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.computeField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'analyse') return;
    if (!node.analyse || typeof node.analyse !== 'object') node.analyse = { expression: '', inputs: [] };
    node.analyse[target.dataset.computeField] = target.value;
    refreshDirty();
    // Only the preview redraws: re-rendering the inspector on every keystroke
    // would take the caret out of the expression field.
    refreshComputePreview();
    return;
  }
  if (target.dataset.computeInput !== undefined) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    const index = Number(target.dataset.computeInput);
    const key = target.dataset.computeInputField;
    const input = node?.analyse?.inputs?.[index];
    if (!node || node.type !== 'analyse' || !input || !key) return;
    input[key] = target.value;
    refreshDirty();
    refreshComputePreview();
    return;
  }
  if (target.dataset.computeMode) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'analyse') return;
    if (!node.analyse || typeof node.analyse !== 'object') node.analyse = { expression: '', inputs: [] };
    const mode = target.value === 'dp4'
      ? 'dp4'
      : (target.value === 'multiwfn' ? 'multiwfn' : 'expression');
    if (mode === 'dp4') {
      // Switching modes creates the DP4+ definition with no level chosen: a
      // block that quietly inherited the first bank level would be computing a
      // level the user never picked.
      node.analyse.mode = 'dp4';
      dp4DefinitionOf(node);
      // The arithmetic declaration is kept until the file is saved, so flipping
      // the mode back does not lose an expression the user typed.
    } else if (mode === 'multiwfn') {
      // Issue 270: a new Multiwfn definition defaults to QTAIM and the only
      // upstream block, if there is exactly one; nothing is chosen silently for
      // two upstream blocks.
      node.analyse.mode = 'multiwfn';
      multiwfnDefinitionOf(node);
    } else {
      delete node.analyse.mode;
    }
    refreshDirty();
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.multiwfnField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'analyse') return;
    const definition = multiwfnDefinitionOf(node);
    const key = target.dataset.multiwfnField;
    if (key === 'analysis') {
      definition.analysis = target.value;
      const analysis = multiwfnAnalysis(definition.analysis);
      for (const [param, spec] of Object.entries(analysis?.parameters || {})) {
        definition[param] = spec.default;
      }
      for (const param of ['grid', 'isovalue']) {
        if (!analysis?.parameters?.[param]) delete definition[param];
      }
      refreshDirty();
      renderGraph();
      renderInspector();
      return;
    }
    if (key === 'grid') definition.grid = Number(target.value);
    else if (key === 'isovalue') definition.isovalue = Number(target.value);
    else definition[key] = target.value;
    refreshDirty();
    refreshComputePreview();
    return;
  }
  if (target.dataset.multiwfnInput) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'analyse') return;
    const definition = multiwfnDefinitionOf(node);
    const key = target.dataset.multiwfnInput;
    // Exactly one source: typing a path clears the block and run id, and vice
    // versa. The schema refuses two sources, and the inspector should not make
    // that state easy to reach.
    for (const other of ['nodeId', 'runId', 'path']) {
      if (other !== key) delete definition.input[other];
    }
    const value = String(target.value || '').trim();
    if (value) definition.input[key] = value;
    else delete definition.input[key];
    refreshDirty();
    refreshComputePreview();
    return;
  }
  if (target.dataset.dp4Field) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'analyse') return;
    const definition = dp4DefinitionOf(node);
    const key = target.dataset.dp4Field;
    if (key === 'level') {
      const [id, solvation] = String(target.value || '').split('|');
      definition.level = id || '';
      definition.solvation = solvation || 'gas';
      // A level carries the solvents its standard table has; a solvent left over
      // from the previous level would name a table this level does not carry.
      const entry = dp4Levels().find((item) => item.id === definition.level && item.solvation === definition.solvation);
      if (definition.solvation === 'gas' || !(entry?.solvents || []).includes(definition.solvent)) definition.solvent = '';
      refreshDirty();
      renderGraph();
      renderInspector();
      return;
    }
    if (key === 'temperature') {
      definition.temperature = Number(target.value);
    } else {
      definition[key] = target.value;
    }
    refreshDirty();
    // The solvent list depends on the level, so a level change redraws; the
    // other fields only move the preview.
    if (key === 'solvent' || key === 'variant') {
      renderGraph();
      renderInspector();
      return;
    }
    refreshComputePreview();
    return;
  }
  if (target.dataset.dp4Row !== undefined) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'analyse') return;
    const definition = dp4DefinitionOf(node);
    const index = Number(target.dataset.dp4Row);
    const key = target.dataset.dp4RowField;
    const row = definition.experimental[index];
    if (!row || !key) return;
    if (key === 'shift') {
      row.shift = target.value === '' ? null : Number(target.value);
    } else if (key === 'sp2') {
      row.sp2 = target.checked;
    } else if (key === 'exchange') {
      if (String(target.value).trim()) row.exchange = String(target.value).trim();
      else delete row.exchange;
    } else if (key === 'atoms') {
      // "12, 13" → [12, 13]; anything that is not a whole number stays as typed
      // and the validator refuses it by name rather than dropping it.
      const indices = String(target.value || '').split(/[,\s]+/).filter(Boolean).map(Number);
      if (indices.length && indices.every((value) => Number.isInteger(value) && value > 0)) row.atoms = indices;
      else delete row.atoms;
    } else {
      row[key] = target.value;
    }
    refreshDirty();
    refreshComputePreview();
    return;
  }
  if (target.dataset.conditionField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'condition') return;
    node.condition[target.dataset.conditionField] = target.value;
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.loopField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'loop') return;
    const key = target.dataset.loopField;
    if (key === 'maxAttempts') node.loop.maxAttempts = clamp(Number(target.value) || 1, 1, 10);
    else node.loop[key] = target.value;
    if (key === 'target') {
      const edge = state.project.edges.find((item) => item.from === node.id && item.type === 'loop');
      if (!target.value) {
        if (edge) setFlowGraph(state.project, { edges: state.project.edges.filter((item) => item !== edge) });
      } else if (edge) { edge.to = target.value; edge.toPort = 'bottomIn'; }
      else state.project.edges.push({ from: node.id, to: target.value, type: 'loop', fromPort: 'bottom', toPort: 'bottomIn' });
    }
    const loopEdge = state.project.edges.find((item) => item.from === node.id && item.type === 'loop');
    if (loopEdge && key === 'maxAttempts') loopEdge.maxAttempts = node.loop.maxAttempts;
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.conformerField) {
    applyConformerField(target);
    return;
  }
  if (target.dataset.branchEdit) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'condition') return;
    const branch = target.dataset.branchEdit;
    let edge = state.project.edges.find((item) => item.from === node.id && item.type === 'branch' && item.branch === branch);
    if (!target.value) {
      if (edge) setFlowGraph(state.project, { edges: state.project.edges.filter((item) => item !== edge) });
    } else if (edge) {
      edge.to = target.value;
      edge.toPort = 'left';
    } else {
      if (wouldCreateCycle(node.id, target.value)) { toast('That branch would create an ordinary cycle.'); return; }
      state.project.edges.push({ from: node.id, to: target.value, type: 'branch', branch, fromPort: branch, toPort: 'left' });
    }
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.mergeField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'merge') return;
    node.merge[target.dataset.mergeField] = target.value;
    renderInspector();
    return;
  }
  if (target.dataset.outputField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'output') return;
    if (!node.output || typeof node.output !== 'object') node.output = outputOf(node);
    const key = target.dataset.outputField;
    if (key === 'kind') {
      const nextKind = Object.prototype.hasOwnProperty.call(OUTPUT_KIND_LABELS, target.value) ? target.value : 'zip';
      const previousDefault = defaultOutputPath(outputOf(node).kind);
      if (!node.output.path || node.output.path === previousDefault) node.output.path = defaultOutputPath(nextKind);
      node.output.kind = nextKind;
    } else if (key === 'include') {
      node.output.include = target.value === 'record' ? 'record' : 'records';
    } else if (target.type === 'checkbox') {
      node.output[key] = target.checked;
    } else {
      node.output[key] = target.value;
    }
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.noteField) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'note') return;
    node.note[target.dataset.noteField] = target.value;
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.drawerField && state.drawer) {
    const key = target.dataset.drawerField;
    state.drawer.draft[key] = target.value;
    // Switching engine swaps the parameter set, so re-render the drawer.
    if (key === 'engine') renderDrawer();
  }
  if (target.dataset.drawerFragment !== undefined && state.drawer) {
    state.drawer.draft.fragments[Number(target.dataset.drawerFragment)] = target.value;
  }
  if (target.dataset.atomFragment !== undefined && state.drawer) {
    const index = Number(target.dataset.atomFragment);
    const value = Number(target.value);
    const atom = state.drawer.draft.coords[index];
    if (atom) {
      if (Number.isInteger(value) && value > 0) atom.fragment = value;
      else delete atom.fragment;
    }
  }
}

/**
 * One writer for the conformer block's settings. Both the input and the change
 * listeners come here, so typing a number and picking from a select behave the
 * same way.
 */
/**
 * ADR 0001 §2.9: one writer for a prepare block. The kind decides which
 * converter is legal, exactly as the schema does; switching kind clears the
 * prepared record because it no longer describes the same operation.
 */
function applyPrepareField(target) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'prepare') return;
  const key = target.dataset.prepareField;
  if (['charge', 'multiplicity'].includes(key)) {
    const bounds = key === 'charge' ? [-10, 10] : [1, 10];
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    node.settings[key] = clamp(value, bounds[0], bounds[1]);
  } else if (['solventCount', 'seed', 'shellAngstrom'].includes(key)) {
    const bounds = key === 'solventCount' ? [1, 64] : (key === 'seed' ? [0, 0x7fffffff] : [1, 20]);
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    node.settings[key] = key === 'shellAngstrom' ? clamp(value, bounds[0], bounds[1]) : Math.round(clamp(value, bounds[0], bounds[1]));
  } else if (key === 'kind') {
    node.settings.kind = target.value === 'embed3d' ? 'embed3d' : (target.value === 'solvate' ? 'solvate' : 'relax');
    node.settings.converter = node.settings.kind === 'embed3d'
      ? 'openbabel'
      : (node.settings.kind === 'solvate' ? 'geometric' : 'uff');
    if (node.settings.kind === 'solvate') node.settings.forceField = 'none';
    node.kind = node.settings.kind === 'embed3d' ? '3D embed' : (node.settings.kind === 'solvate' ? 'Solvate' : 'Relax');
    node.output = null;
    node.state = 'ready';
  } else if (key === 'converter' || key === 'forceField' || key === 'smiles' || key === 'solvent') {
    node.settings[key] = String(target.value || '');
    node.output = null;
    node.state = 'ready';
  } else {
    return;
  }
  refreshDirty();
  renderGraph();
  renderInspector();
}

/**
 * ADR 0001: one writer for an ensemble input's fields. The path and the energy
 * declaration live on `input`; the provenance is nested, so it needs its own
 * branch like the conformer block's origin.
 */
function applyEnsembleInputField(target) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'input' || node.input?.kind !== 'ensemble') return;
  const key = target.dataset.ensembleField;
  const originField = { originProgram: 'program', originVersion: 'version', originMethod: 'method' }[key];
  if (originField) {
    node.input.origin = { ...(node.input.origin || {}), [originField]: String(target.value || '') };
  } else if (key === 'path' || key === 'format' || key === 'energyUnit' || key === 'energyMethod') {
    node.input[key] = String(target.value || '');
  } else {
    return;
  }
  // Any change to what the file is voids the record read from the old one.
  node.output = null;
  node.state = 'ready';
  refreshDirty();
  renderGraph();
  renderInspector();
}

function applyConformerField(target) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'generate') return;
  const key = target.dataset.conformerField;
  const numeric = ['energyWindowKcal', 'rmsdThreshold', 'maxConformers', 'temperature', 'spreadThresholdKcal', 'charge', 'multiplicity', 'torsionStepDegrees', 'maxTrials', 'nconf'];
  // Issue 129: the declared provenance lives in a nested `origin` object, so
  // the flat `settings[key] = value` path cannot write it.
  const originField = { originProgram: 'program', originVersion: 'version', originMethod: 'method' }[key];
  if (originField) {
    node.settings.origin = { ...(node.settings.origin || {}), [originField]: String(target.value || '') };
  } else if (numeric.includes(key)) {
    const bounds = {
      energyWindowKcal: [0, 100], rmsdThreshold: [0.01, 10], maxConformers: [1, 200],
      temperature: [1, 1000], spreadThresholdKcal: [0, 50], charge: [-10, 10], multiplicity: [1, 10],
      // Issue 144: the in-app UFF route's grid resolution and trial cap.
      torsionStepDegrees: [15, 360], maxTrials: [1, 2000],
      // The Open Babel route's conformer count; the schema bounds it the same way.
      nconf: [1, 1000],
    }[key];
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    node.settings[key] = clamp(value, bounds[0], bounds[1]);
  } else {
    // A switch writes its checked state, not the string "on".
    node.settings[key] = target.type === 'checkbox' ? target.checked : target.value;
    if (key === 'source') {
      // ADR 0001: search and imported are exclusive. A stored generator on an
      // imported block would be a claim that no search will honour.
      node.settings.generator = node.settings.source === 'imported' ? '' : 'crest';
      node.output = null;
      node.state = 'ready';
    }
    if (key === 'generator') {
      // Issue 240: the method allowed values belong to the generator, so
      // switching generator carries its default instead of leaving a method
      // the new route would never run.
      node.settings.method = DEFAULT_CONFORMER_METHOD[target.value] || '';
    }
    if (key === 'generator' && node.output && node.output.generator !== target.value) {
      // A CREST table is not what UFF would produce, and a UFF run is not the
      // CREST search that was chosen: switching the generator voids the choice.
      node.output = null;
      node.state = 'ready';
    }
    if (key === 'rankBy' && node.output) {
      // A table ranked by one method cannot stand after choosing another.
      node.output = null;
      node.state = 'ready';
    }
    // Issue 226: conformers and tautomers are exclusive jobs with different
    // generators and different knobs. Switching rewrites the fields the new job
    // cannot honour, and voids the ensemble the old one produced.
    if (key === 'produces') {
      if (node.settings.produces === 'tautomers') {
        node.settings.source = 'search';
        node.settings.generator = 'rdkit';
        node.settings.method = '';
        node.settings.rankBy = '';
        node.settings.fanOut = true;
        node.settings.tautomerRuleset = node.settings.tautomerRuleset || 'rdkit-default';
      } else {
        node.settings.generator = 'crest';
        node.settings.method = 'gfn2';
        node.settings.fanOut = false;
      }
      node.output = null;
      node.state = 'ready';
    }
    if (key === 'tautomerRuleset' && node.output) {
      // Another ruleset is another candidate set; the stored one is stale.
      node.output = null;
      node.state = 'ready';
    }
  }
  refreshDirty();
  renderGraph();
  renderInspector();
}

function onDocumentInput(event) {
  const target = event.target;
  if (target.dataset.settingsField && state.drawer?.type === 'app-settings') {
    setSettingsField(target.dataset.settingsField, target.type === 'checkbox' ? target.checked : target.value);
    return;
  }
  if (target.dataset.prepareField) {
    applyPrepareField(target);
    return;
  }
  if (target.dataset.ensembleField) {
    applyEnsembleInputField(target);
    return;
  }
  if (target.dataset.conformerField) {
    applyConformerField(target);
    return;
  }
  if (target.id === 'palette-search') {
    renderPalette();
    return;
  }
  if (target.dataset.drawerField && state.drawer) {
    state.drawer.draft[target.dataset.drawerField] = target.value;
    if (target.dataset.drawerField === 'charge' || target.dataset.drawerField === 'multiplicity') updateParity();
  }
  if (target.dataset.drawerFragment !== undefined && state.drawer) {
    state.drawer.draft.fragments[Number(target.dataset.drawerFragment)] = target.value;
  }
}

/* ── Draggable modal windows ──────────────────────────────── */

const MODAL_POS_KEY = 'nodechem-studio.modal-pos';

/**
 * The drawer is a window, not a sheet: its position belongs to the user.
 *
 * The panel still opens where the CSS puts it (top-right, out of the canvas'
 * way) until the user drags it; after that the position is remembered for the
 * session and across launches. A double-click on the header restores the
 * default anchor, so a window can never be lost off-screen.
 */
function readStoredModalPos() {
  try {
    const saved = JSON.parse(localStorage.getItem(MODAL_POS_KEY) || 'null');
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
  } catch {
    return null;
  }
}

function storeModalPos(pos) {
  try {
    localStorage.setItem(MODAL_POS_KEY, JSON.stringify(pos));
  } catch {
    // Position is a convenience, not state the app depends on.
  }
}

/** True when the window is too small for a floating panel (full-screen sheet). */
function modalDragDisabled() {
  return window.innerWidth <= 520;
}

function applyModalPos(modal, pos) {
  const width = modal.offsetWidth || 420;
  const maxX = Math.max(8, window.innerWidth - width - 8);
  // Keep the header reachable even if the body is taller than the viewport.
  const maxY = Math.max(8, window.innerHeight - 64);
  const x = Math.min(Math.max(8, Math.round(pos.x)), maxX);
  const y = Math.min(Math.max(8, Math.round(pos.y)), maxY);
  modal.style.left = `${x}px`;
  modal.style.top = `${y}px`;
  modal.style.right = 'auto';
  modal.classList.add('is-floating');
  return { x, y };
}

/** Re-apply the remembered position after every re-render of the drawer. */
function placeModal() {
  const modal = $('#modal');
  if (!modal || modalDragDisabled()) return;
  const pos = state.modalPos || readStoredModalPos();
  if (!pos) return;
  state.modalPos = applyModalPos(modal, pos);
}

function beginModalDrag(event) {
  const head = event.target?.closest?.('.modal-head');
  if (!head || modalDragDisabled()) return;
  if (event.target.closest('button, input, select, textarea, a')) return;
  const modal = $('#modal');
  if (!modal) return;
  const rect = modal.getBoundingClientRect();
  state.modalPos = applyModalPos(modal, { x: rect.left, y: rect.top });
  state.modalDrag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  document.body.classList.add('is-dragging-modal');
  event.preventDefault();
}

function moveModalDrag(event) {
  if (!state.modalDrag) return;
  const modal = $('#modal');
  if (!modal) return;
  state.modalPos = applyModalPos(modal, {
    x: event.clientX - state.modalDrag.offsetX,
    y: event.clientY - state.modalDrag.offsetY,
  });
}

function endModalDrag() {
  if (!state.modalDrag) return;
  state.modalDrag = null;
  document.body.classList.remove('is-dragging-modal');
  if (state.modalPos) storeModalPos(state.modalPos);
}

/** Double-click the header to return the window to its default anchor. */
function resetModalPosition() {
  const modal = $('#modal');
  if (!modal) return;
  modal.classList.remove('is-floating');
  modal.style.left = '';
  modal.style.top = '';
  modal.style.right = '';
  state.modalPos = null;
  try {
    localStorage.removeItem(MODAL_POS_KEY);
  } catch {
    // nothing to clear
  }
}

function wireEvents() {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('change', onDocumentChange);
  document.addEventListener('input', onDocumentInput);
  // Window dragging: delegated, because the drawer's header is re-rendered
  // every time its draft changes.
  document.addEventListener('pointerdown', beginModalDrag);
  document.addEventListener('pointermove', moveModalDrag);
  document.addEventListener('pointerup', endModalDrag);
  document.addEventListener('pointercancel', endModalDrag);
  // Issue 253: the run console is a second floating window with its own stored
  // geometry. It is not modal, so Esc never closes it.
  document.addEventListener('pointerdown', beginRunConsoleDrag);
  document.addEventListener('pointermove', moveRunConsoleDrag);
  document.addEventListener('pointerup', endRunConsoleDrag);
  document.addEventListener('pointerup', persistRunConsoleSize);
  document.addEventListener('pointercancel', endRunConsoleDrag);
  window.addEventListener('resize', clampRunConsoleToViewport);
  document.addEventListener('dblclick', (event) => {
    if (event.target?.closest?.('.modal-head') && !event.target.closest('button, input, select')) resetModalPosition();
  });

  const modal = $('#modal');
  modal?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  modal?.addEventListener('dragover', (event) => {
    const zone = event.target.closest('.drop-zone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.add('is-drop');
  });
  modal?.addEventListener('dragleave', (event) => {
    event.target.closest('.drop-zone')?.classList.remove('is-drop');
  });
  modal?.addEventListener('drop', (event) => {
    const zone = event.target.closest('.drop-zone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove('is-drop');
    const file = event.dataTransfer?.files?.[0];
    if (file) importStructureFile(file);
  });

  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    // Issue 252: the conventional Settings shortcut, available from any
    // surface including a focused input.
    if (mod && !event.altKey && event.key === ',') {
      event.preventDefault();
      openAppSettings();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')
      || event.target?.isContentEditable === true;
    if (mod && !event.altKey && !typing && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoEdit(); else undoEdit();
      return;
    }
    if (mod && !event.altKey && !typing && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redoEdit();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      togglePalette(true);
      return;
    }
    if (event.key === 'Escape') {
      if (state.renamingFlowId) { cancelFlowRename(); return; }
      if (state.confirmDeleteFlowId) { cancelDeleteFlow(); return; }
      if (state.drawer) { closeDrawer(); return; }
      if (!$('#project-menu')?.hidden) { closeProjectMenu({ focus: true }); return; }
      if (!$('#app-menu')?.hidden) { closeAppMenu(); return; }
      if (!$('#export-menu')?.hidden) { closeExportMenu(); return; }
      if (state.paletteOpen) { togglePalette(false); return; }
      if (state.keyboardConnect) { cancelKeyboardConnect(); return; }
      if (state.connecting) { state.connecting = null; clearDropHighlight(); renderPreview(); }
    }
  });

  nodesEl().addEventListener('click', (event) => {
    const node = event.target.closest('.node');
    if (node) selectNode(node.dataset.nodeId);
  });

  nodesEl().addEventListener('dblclick', (event) => {
    const node = event.target.closest('.node');
    if (!node) return;
    state.inspectorWide = true;
    selectNode(node.dataset.nodeId);
  });

  nodesEl().addEventListener('keydown', (event) => {
    const port = event.target.closest('.port[data-port]');
    if (port && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.stopPropagation();
      if (state.keyboardConnect) {
        if (state.keyboardConnect.from === port.dataset.from) cancelKeyboardConnect();
        else completeKeyboardConnect(port.dataset.from);
      } else {
        beginKeyboardConnect(port);
      }
      return;
    }
    if (event.key === 'Escape' && state.keyboardConnect) {
      event.preventDefault();
      cancelKeyboardConnect();
      return;
    }
    const node = event.target.closest('.node');
    if (!node) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (state.keyboardConnect) {
        completeKeyboardConnect(node.dataset.nodeId);
        return;
      }
      selectNode(node.dataset.nodeId);
    }
  });

  nodesEl().addEventListener('pointerdown', (event) => {
    const port = event.target.closest('.port[data-port]');
    if (port) {
      event.preventDefault();
      event.stopPropagation();
      startConnection(port.dataset.from, port.dataset.port, event);
      return;
    }
    const nodeEl = event.target.closest('.node');
    if (!nodeEl) return;
    const head = event.target.closest('.node-head');
    if (!head) return;
    event.preventDefault();
    startNodeDrag(nodeEl, event);
  });

  edgesEl().addEventListener('click', (event) => {
    const edgeTarget = event.target.closest('[data-edge-id]');
    if (edgeTarget) selectEdge(edgeTarget.dataset.edgeId);
  });

  viewportEl().addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.node, .port, .canvas-hud, .palette, .canvas-legend, [data-edge-id]')) return;
    startPan(event);
  });

  window.addEventListener('pointermove', (event) => {
    if (state.connecting) { updateConnection(event); return; }
    if (state.drag) { updateNodeDrag(event); return; }
    if (state.pan) updatePan(event);
  });

  window.addEventListener('pointerup', (event) => {
    if (state.connecting) { finishConnection(event); return; }
    if (state.drag) { endNodeDrag(); return; }
    if (state.pan) endPan();
  });

  const backdrop = $('#modal-backdrop');
  backdrop?.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) closeDrawer();
  });

  // issue 149: the project menu's keyboard contract (↓/↑/Home/End/Esc).
  $('#project-menu')?.addEventListener('keydown', onProjectMenuKeydown);
}

/* ── Boot ─────────────────────────────────────────────────── */

// Exported for the Node-side inspector tests: importing this module with a
// stubbed `document.readyState = 'loading'` does not boot the UI.
export {
  applyQueue,
  calcInspector,
  costCardText,
  failureDetail,
  failureHint,
  formatCostDuration,
  formatRunStart,
  handleQueueEvent,
  historyRowHtml,
  historyRows,
  inputInspector,
  nodeDetail,
  nodeFoot,
  prepareInspector,
  queueBelongsToProject,
  queueFailure,
  queueRowHtml,
  readRunConfig,
  renderFlowTabs,
  renderRecordSummary,
  resetRunHeader,
  resultFacts,
  runExecutables,
  runHeaderFor,
  runStateOf,
  setRunHint,
  clearRunHint,
  simpleInspector,
  spinMultiplicitiesForNode,
  spinSweepLabel,
  spinTaskMeta,
  state,
  syncNodeStatesFromQueue,
  reconcileNodesWithQueue,
  taskFailure,
  updateNodeField,
  updateRunConsoleCopy,
  updateSpinSweepState,
};

function applyAppInfo() {
  const chip = $('#app-version-chip');
  const statusTag = $('#app-version-status');
  if (chip) chip.textContent = appVersion ? `v${appVersion} · desktop preview` : 'desktop preview';
  if (statusTag) statusTag.textContent = appVersion ? `v${appVersion} · local runner` : 'local runner';
}

async function loadAppInfo() {
  if (!desktop?.getInfo) { applyAppInfo(); return; }
  try {
    const info = await desktop.getInfo();
    if (info?.version) appVersion = String(info.version);
  } catch {
    // Keep the build-time version; the app can still work without the info call.
  }
  applyAppInfo();
}

async function init() {
  loadAppInfo();
  // Issue 252: Settings are loaded before the console is seeded, so a fresh
  // profile with machine paths configured needs nothing typed in the console.
  await loadAppSettings();
  applySettingsProjectDefaults(state.project);
  // Remember the project exactly as loaded: until it changes, there is nothing
  // worth drafting, and a fresh session must not overwrite a recoverable draft.
  state.draftBaseline = JSON.stringify(state.project);
  if (window.innerWidth <= 820) state.inspectorHidden = true;
  readRunConfig();
  updateRunConsoleCopy();
  refreshEngineChips();
  syncRunnerInputs();
  if (desktop?.onRunEvent) desktop.onRunEvent(handleRunEvent);
  if (desktop?.onQueueEvent) desktop.onQueueEvent(handleQueueEvent);
  if (desktop?.onOpenProjectPath) desktop.onOpenProjectPath((filePath) => { openProjectPath(filePath); });
  const kbdHint = $('#kbd-hint');
  if (kbdHint) {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || '');
    kbdHint.innerHTML = isMac
      ? '<kbd>⌘</kbd><kbd>K</kbd> search blocks'
      : '<kbd>Ctrl</kbd><kbd>K</kbd> search blocks';
  }
  renderPalette();
  renderGraph();
  renderInspector();
  renderQueue();
  // Issue 160: the project first, then its queue. The other order left the
  // restored verdicts with nowhere to land.
  openStartupProject()
    .then(() => restoreQueue())
    .then(() => reconcileNodesWithQueue())
    .finally(offerDraftRestore);
  refreshHistory();
  setZoom(state.zoom);
  wireEvents();
  installResultsView({ desktop });
  installCloseGuard();
  installThemeSwitcher();
}

/* ── Appearance (#52) ────────────────────────────────────────────
 * localStorage is the source of truth and is read by public/theme-boot.js
 * before first paint; the preference file in userData is only a launch cache
 * for the native window colour. Switching therefore never reloads the window.
 */
const THEME_KEY = 'ncs.theme';
const THEME_IDS = ['current', 'graphite', 'paper'];
const THEME_DARK = { current: true, graphite: true, paper: false };

function resolveThemePreference(preference) {
  if (THEME_IDS.includes(preference)) return preference;
  const light = window.matchMedia?.('(prefers-color-scheme: light)')?.matches === true;
  return light ? 'paper' : 'graphite';
}

function applyTheme(preference) {
  const mode = preference === 'system' || THEME_IDS.includes(preference) ? preference : 'current';
  const resolved = resolveThemePreference(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = THEME_DARK[resolved] ? 'dark' : 'light';
  try { window.localStorage.setItem(THEME_KEY, mode); } catch { /* private mode */ }
  if (desktop?.setTheme) desktop.setTheme({ mode, resolved }).catch(() => {});
  return resolved;
}

function installThemeSwitcher() {
  const select = document.getElementById('theme-select');
  const stored = document.documentElement.getAttribute('data-theme-mode') || 'current';
  if (select) {
    select.value = stored;
    select.addEventListener('change', () => { applyTheme(select.value); });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
