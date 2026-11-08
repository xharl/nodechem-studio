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
import { JOB_TYPES as SHARED_JOB_TYPES, LIMITS, defaultGates, defaultSettings, validateProject } from '../shared/projectSchema.js';
import {
  attachGraphAliases,
  activeFlow,
  activeFlowId,
  datasetById,
  enabledRecords,
  flowById,
  flowsOf,
  hydrateProject,
  recordsOf,
  setFlowGraph,
} from '../shared/flows.js';
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
import {
  DEFAULT_CONFORMER_SETTINGS,
  formatPopulation,
  formatRelativeKcal,
} from '../shared/conformers.js';
import { WORKFLOW_TEMPLATES, blankProject, templateProject } from '../shared/templates.js';
import { ENGINES, engineOrDefault } from '../shared/engines/index.js';
import { buildOrcaInput } from '../shared/engines/orca.js';
import * as shared from '../shared/workflowTasks.js';
import { engineForNode } from '../shared/workflowTasks.js';
import { XTB_METHODS, XTB_OPT_LEVELS, XTB_SOLVATION_MODELS, XTB_SOLVENTS } from '../shared/engines/xtb.js';
import {
  MODERN_ROUTE_PRESET,
  ROUTE_PRESETS,
  applyRoutePreset,
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
import { provenanceSummary, syncVerifyButton, verifyRunInput } from './provenance.js';
import { mountThermochemistryView } from './thermochemistryView.js';
import { installResultsView } from './resultsView.js';
import { mountStructureViewer } from './structureViewer.js';
import { formatPreflightReport } from './preflightReport.js';
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
const H = 112;
const STAGE_W = 1080;
const STAGE_H = 580;
const LOOP_LANE = 548;

const STATUS = {
  passed: { label: 'Passed', dot: 'green' },
  ready: { label: 'Ready', dot: 'blue' },
  review: { label: 'Needs review', dot: 'red' },
  blocked: { label: 'Blocked', dot: 'slate' },
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
    type: 'calc',
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
  },
  queue: {
    id: null,
    status: 'idle',
    tasks: [],
    reason: null,
    starting: false,
  },
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
  // The preview must show the route that will be written: a heavy element with
  // an ECP basis becomes GenECP and carries a basis/ECP block after the atoms.
  const coords = state.project?.molecule?.coords || [];
  const ecp = ecpRequirement({ basis: settings.basis, elements: coords.map((atom) => atom.element) });
  return `${settings.method}/${basisNameFor(settings.basis, ecp)} ${jobKeywordFor(settings)}`;
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
  if (node.type !== 'calc') return [];
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

function datasetForInputNode(node) {
  return node?.type === 'input' ? datasetById(state.project, node.input?.datasetId) : null;
}

function inputRecordCounts(node) {
  const dataset = datasetForInputNode(node);
  if (!dataset) return { total: 0, enabled: 0 };
  return { total: recordsOf(dataset).length, enabled: enabledRecords(dataset).length };
}

function nodeDetail(node) {
  if (node.type === 'calc') {
    // The card must describe the engine the project actually runs.
    if (engineOrDefault(state.project?.defaults?.engine).id === 'xtb') {
      const label = (XTB_METHODS.find((item) => item.id === (node.settings.xtbMethod || 'gfn2')) || {}).label || 'xTB';
      return `${label} ${node.settings.jobType}`;
    }
    return routeShort(node.settings);
  }
  if (node.type === 'condition') return node.condition.expression.replace(/\s*\n\s*/g, ' · ');
  if (node.type === 'conformers') {
    const output = node.output;
    if (!output) return `${node.settings.generator === 'import' ? 'import' : 'CREST'} · not run`;
    const spread = Number.isFinite(output.spreadKcal) ? ` · spread ${output.spreadKcal.toFixed(1)}` : '';
    return `${output.count} of ${output.total} kept${spread}`;
  }
  if (node.type === 'loop') return `max ${node.loop.maxAttempts} attempts · ${nodeById(node.loop.target)?.title || 'no target'}`;
  if (node.type === 'merge') return node.merge.policy === 'any' ? 'wait for any input' : 'wait for all inputs';
  if (node.type === 'input') {
    const dataset = datasetForInputNode(node);
    if (!dataset) return 'no dataset bound · import a file';
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

function nodeFoot(node) {
  if (node.type === 'calc') {
    const output = node.output ? 'parsed' : node.state === 'ready' ? 'ready to run' : 'no output';
    return { left: gateChips(node).join(' · '), right: output };
  }
  if (node.type === 'condition') return { left: `unknown → ${node.condition.unknown.replace('-', ' ')}`, right: '2 branches' };
  if (node.type === 'conformers') {
    const method = node.settings.generator === 'crest'
      ? `CREST ${node.settings.method === 'gfnff' ? 'GFN-FF' : 'GFN2'}`
      : 'imported ensemble';
    const chosen = node.output?.selectedId || '';
    return { left: method, right: chosen ? `using ${chosen}` : 'no choice' };
  }
  if (node.type === 'loop') return { left: `until ${node.loop.until}`, right: `×${node.loop.maxAttempts}` };
  if (node.type === 'merge') return { left: `policy: ${node.merge.policy}`, right: 'join' };
  if (node.type === 'input') {
    const dataset = datasetForInputNode(node);
    const counts = inputRecordCounts(node);
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
  return { left: '', right: '' };
}

function kindCode(node) {
  if (node.type === 'condition') return 'IF';
  if (node.type === 'conformers') return 'CF';
  if (node.type === 'loop') return '↻';
  if (node.type === 'merge') return '⋈';
  if (node.type === 'input') return 'IN';
  if (node.type === 'output') return 'OUT';
  if (node.type === 'note') return '✎';
  return node.kind;
}

function kindLabel(node) {
  if (node.type === 'condition') return 'Control';
  if (node.type === 'conformers') return 'Structure';
  if (node.type === 'loop') return 'Control';
  if (node.type === 'merge') return 'Join';
  if (node.type === 'input') return 'Data';
  if (node.type === 'output') return 'Data';
  if (node.type === 'note') return 'Note';
  return 'Calculation';
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

function renderNodeCard(node) {
  const selected = state.selected.type === 'node' && state.selected.id === node.id;
  const chips = nodeFoot(node);
  const status = statusFor(node);
  const showStatus = node.type !== 'note';
  const checkpointBadge = node.type === 'calc' && node.checkpointFrom
    ? '<span class="chk-badge">chk</span>'
    : '';
  return `
    <article class="node node-${node.type} state-${node.state}${selected ? ' is-selected' : ''}"
      data-node-id="${node.id}" tabindex="0" role="group" aria-label="${esc(node.title)}, ${showStatus ? status.label : 'note'}"
      style="left:${node.x}px;top:${node.y}px">
      ${checkpointBadge}
      <div class="node-head">
        <span class="node-icon">${esc(kindCode(node))}</span>
        <span class="node-kind">${kindLabel(node)}</span>
        ${showStatus ? `<span class="node-status"><i></i>${status.label}</span>` : ''}
      </div>
      <div class="node-title">${esc(node.title)}</div>
      <div class="node-route">${esc(nodeDetail(node))}</div>
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
    const meta = tab.recordCount > 0 ? `${tab.recordCount} rec` : `${tab.nodeCount} blk`;
    const title = `${tab.title} · ${countLabel(tab.nodeCount, 'block')}`
      + `${tab.recordCount > 0 ? ` · ${countLabel(tab.recordCount, 'record')}` : ''}`;
    return `<button type="button" role="tab" class="flow-tab${tab.active ? ' is-active' : ''}" data-flow-id="${esc(tab.id)}" aria-selected="${tab.active}" title="${esc(title)}">
      <span class="flow-tab-title">${esc(tab.title)}</span><span class="flow-tab-meta">${esc(meta)}</span>
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
  syncMaxParallelInput();
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
    'position:fixed',
    'top:64px',
    'left:50%',
    'transform:translateX(-50%)',
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
  syncMaxParallelInput();
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
  const counts = { passed: 0, ready: 0, review: 0, blocked: 0 };
  nodes.forEach((node) => { if (node.type !== 'note') counts[node.state] += 1; });
  const next = nodes.find((node) => node.state === 'review')
    || nodes.find((node) => node.state === 'ready')
    || null;
  const segments = ['passed', 'ready', 'review', 'blocked']
    .filter((key) => counts[key] > 0)
    .map((key) => `<span class="${key}" style="flex:${counts[key]}"></span>`)
    .join('');
  const loopCount = state.project.edges.filter((edge) => edge.type === 'loop').length;
  const condCount = nodes.filter((node) => node.type === 'condition').length;

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
        <h3>${next.state === 'review' ? 'Review the output' : 'Run the next block'}</h3>
        <p>${next.state === 'review'
          ? `${esc(next.title)} needs a human decision before the condition can release a branch.`
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

    <div class="inspector-actions-row">
      <button type="button" class="btn" data-action="toggle-palette">+ Add block</button>
      <button type="button" class="btn" data-action="validate">Validate</button>
    </div>
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
  const blocks = state.project.nodes.filter((entry) => entry.type === 'calc'
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
  } else if (node.state === 'ready') {
    callout = '<div class="callout green"><strong>Ready.</strong> All prerequisites passed; export the input and run it externally.</div>';
  }

  // Issue #15: the force-constant choice is valid or not independently of the
  // node's run state, so it gets its own callouts. Those rules are Gaussian
  // route rules; xTB refuses transition-state blocks at input build instead.
  const tsIssues = isXtb ? { errors: [], warnings: [] } : tsForceConstantIssues(node);
  callout += tsIssues.errors
    .map((message) => `<div class="callout"><strong>Cannot export.</strong> ${esc(message)}</div>`)
    .join('');
  callout += tsIssues.warnings
    .map((message) => `<div class="callout"><strong>Warning.</strong> This block ${esc(message)}</div>`)
    .join('');
  // Issue #16: grid and frequency-provenance advice is also independent of the
  // node's run state — and Gaussian-only.
  callout += isXtb ? '' : optConvergenceIssues(node)
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
    selectField('Job type', 'jobType', JOB_TYPES, s.jobType),
    !isXtb && s.jobType === 'IRC' ? selectField('IRC direction', 'ircDirection', IRC_DIRECTIONS, s.ircDirection) : '',
    !isXtb && isOptJob(s.jobType)
      ? selectField(
        'Optimization convergence',
        'optConvergence',
        OPT_CONVERGENCE_OPTIONS.map((option) => [option.id, option.label]),
        optConvergenceFor(s),
      )
      : '',
    !isXtb ? tsForceField : '',
    gaussianResources ? `<div class="field"><label>Memory</label><div class="field-row">
      <input class="input" type="number" min="1" max="512" aria-label="Memory" data-node-field="memory" value="${esc(s.memory)}">
      <select class="select" aria-label="Memory unit" data-node-field="memoryUnit">${MEMORY_UNITS.map(([value, label]) => `<option value="${value}"${s.memoryUnit === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </div></div>` : '',
    gaussianResources ? inputField('Cores (nproc)', 'nproc', s.nproc, { type: 'number', min: 1, max: 256 }) : '',
    gaussianResources ? inputField('Checkpoint file', 'checkpoint', s.checkpoint || chkName(node.id), { full: true }) : '',
    !gaussianResources
      ? '<div class="field full"><span class="inspector-note">xTB writes <code>xtbrestart</code> in the run folder; a checkpoint hand-off copies that file.</span></div>'
      : '',
  ].join(''));

  // A composite method carries its own sequence in one keyword: Gaussian cannot
  // run `G4/6-31G(d)`, so offering the pair here would invite a route the builder
  // refuses. Show what the keyword actually runs instead.
  const compositeJob = isCompositeJobType(s.jobType);
  // Issue #93: constraints read ModRedundant; QST structures exist only for an
  // STQN job. Both are Gaussian-only, so an xTB block shows neither.
  const constraintGroup = isXtb ? '' : constraintsGroup(node, s);
  const qstEditor = isXtb || !qstKindFor(s.jobType) ? '' : qstGroup(node, s);
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
  ].join(''));

  // Issue #60: TD-DFT is a route keyword on a wavefunction job. The group is
  // always present for Gaussian so the setting is discoverable; the note says
  // why a Freq/TS/IRC/Scan block cannot carry it.
  const tdEligible = s.jobType === 'SP' || s.jobType === 'Opt';
  const tdSummary = s.tdStates > 0
    ? `${s.tdStates} states${s.tdTriplets === 'triplets' ? ' · triplets' : s.tdTriplets === 'both' ? ' · 50/50' : ''}`
    : 'off';
  const excitedGroup = group('Excited states (TD)', tdSummary, s.tdStates > 0, [
    inputField('States', 'tdStates', s.tdStates ?? 0, { type: 'number', min: 0, max: 200 }),
    selectField('Spin states', 'tdTriplets', [
      ['', 'Singlets only'],
      ['triplets', 'Triplets only'],
      ['both', '50/50 singlets + triplets'],
    ], s.tdTriplets || ''),
    tdEligible
      ? '<div class="field full"><span class="inspector-note">Emits <code>TD=(NStates=N)</code> on the route. Excitation energies, wavelengths, oscillator strengths and the dominant transitions are parsed from the output.</span></div>'
      : '<div class="field full"><span class="inspector-note">TD requires a single-point or optimisation job. Choose SP or Opt to enable it; the input builder refuses the other job types.</span></div>',
  ].join(''));

  const gaussianSolvationGroup = group('Solvation', s.solvation ? `${s.solvationModel} · ${s.solvent}` : 'off', s.solvation, [
    switchRow('Implicit solvation', 'PCM / SMD / CPCM', 'solvation', s.solvation),
    selectField('Model', 'solvationModel', SOLVATION_MODELS, s.solvationModel),
    selectField('Solvent', 'solvent', SOLVENTS, s.solvent),
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

  // Raman (#76) is a modifier of the frequency keyword, so the switch only
  // appears where a frequency job exists to carry it.
  const frequencyJob = /Freq/i.test(String(s.jobType || ''));
  const ramanGroup = group('Raman', s.raman ? 'activities on' : 'off', s.raman, [
    switchRow('Raman activities', 'adds =Raman to the frequency keyword', 'raman', s.raman, { disabled: !frequencyJob }),
    '<div class="field full"><span class="inspector-note">'
      + (frequencyJob
        ? 'Gaussian prints the Raman activity (Å<sup>4</sup>/amu) and the depolarisation ratios with the modes. '
          + 'The results panel plots the <em>activity</em>, not a scattering cross-section.'
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
        const artifact = source && source.type === 'calc' ? checkpointNameFor(source) : '';
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
    ${isXtb ? xtbGroup : compositeJob ? compositeNote : methodGroup}
    ${isXtb || compositeJob ? '' : excitedGroup}
    ${isXtb || compositeJob ? '' : ramanGroup}
    ${isXtb ? xtbSolvationGroup : compositeJob ? '' : gaussianSolvationGroup}
    ${moleculeGroup}
    ${gatesGroup}
    ${isXtb ? '' : validityGroup}
    ${dependencyGroup}
    ${outputGroup}
    ${isXtb ? '' : extraGroup}
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
  const candidates = state.project.nodes.filter((item) => item.type === 'calc');
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

function conformersInspector(node) {
  const s = node.settings || {};
  const output = node.output && typeof node.output === 'object' ? node.output : null;
  const selectedId = output?.selectedId || s.selectedConformerId || '';
  const members = Array.isArray(output?.members) ? output.members : [];
  const warnings = Array.isArray(output?.warnings) ? output.warnings : [];
  const warningBlock = warnings.length
    ? `<div class="code-block" style="margin-bottom:10px">${warnings.map((warning) => `<div>⚠ ${esc(warning.message)}</div>`).join('')}</div>`
    : '';
  const selected = output?.selected;
  const summaryLine = output
    ? `${output.count} of ${output.total} kept${Number.isFinite(output.spreadKcal) ? ` · spread ${output.spreadKcal.toFixed(2)} kcal/mol` : ''}`
    : 'no ensemble yet';
  const rows = members.length
    ? `<table class="batch-table">
        <thead><tr><th>Member</th><th>ΔE</th><th>Pop.</th><th>RMSD</th><th></th></tr></thead>
        <tbody>${members.map((member) => `<tr${member.kept ? '' : ' class="is-muted"'}>
          <td>${esc(member.id)}${member.protomer ? ` · ${esc(member.protomer)}` : ''}</td>
          <td>${formatRelativeKcal(member.relativeKcal)}</td>
          <td>${formatPopulation(member.population)}</td>
          <td>${Number.isFinite(member.rmsdToLowest) ? member.rmsdToLowest.toFixed(2) : '—'}</td>
          <td>${member.kept
            ? `<button type="button" class="btn small${member.id === selectedId ? ' primary' : ''}" data-action="select-conformer" data-conformer-id="${esc(member.id)}">${member.id === selectedId ? 'using' : 'use'}</button>`
            : `<span class="inspector-note">${esc(member.dropped || 'dropped')}</span>`}</td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<div class="inspector-note">No ensemble yet. ${s.generator === 'import'
      ? 'Choose a multi-XYZ file and run the block.'
      : 'Run the block with a CREST executable configured.'}</div>`;

  return `${inspectorHead('Structure · conformers', node.title, summaryLine)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${selected
      ? `using ${esc(selected.id)} · ${formatRelativeKcal(selected.relativeKcal)} kcal/mol · ${formatPopulation(selected.population)}`
      : 'no member chosen'}</span></div>
    ${warningBlock}
    ${group('Ensemble', summaryLine, true, [rows])}
    ${group('Search', s.generator === 'crest' ? 'CREST' : 'imported file', true, [
      `<div class="field"><label>Generator</label><select class="select" data-conformer-field="generator">
        <option value="crest"${s.generator === 'crest' ? ' selected' : ''}>CREST (external)</option>
        <option value="import"${s.generator === 'import' ? ' selected' : ''}>Import a multi-XYZ</option>
      </select></div>`,
      s.generator === 'crest'
        ? `<div class="field"><label>Method</label><select class="select" data-conformer-field="method">
            <option value="gfn2"${s.method === 'gfn2' ? ' selected' : ''}>GFN2-xTB</option>
            <option value="gfnff"${s.method === 'gfnff' ? ' selected' : ''}>GFN-FF</option>
          </select></div>`
        : `<div class="field full"><label>Ensemble file</label>
            <div style="display:flex;gap:6px">
              <input class="input" data-conformer-field="importPath" value="${esc(s.importPath || '')}" placeholder="C:\\path\\to\\conformers.xyz">
              <button type="button" class="btn small" data-action="pick-ensemble">Choose…</button>
            </div>
          </div>`,
      `<div class="field"><label>Energy window (kcal/mol)</label><input class="input" type="number" min="0" max="100" step="0.5" data-conformer-field="energyWindowKcal" value="${esc(s.energyWindowKcal)}"></div>`,
      `<div class="field"><label>RMSD threshold (Å)</label><input class="input" type="number" min="0.01" max="10" step="0.05" data-conformer-field="rmsdThreshold" value="${esc(s.rmsdThreshold)}"></div>`,
      `<div class="field"><label>Keep at most</label><input class="input" type="number" min="1" max="200" data-conformer-field="maxConformers" value="${esc(s.maxConformers)}"></div>`,
      `<div class="field"><label>Temperature (K)</label><input class="input" type="number" min="1" max="1000" step="0.15" data-conformer-field="temperature" value="${esc(s.temperature)}"></div>`,
      `<div class="field"><label>Spread warning (kcal/mol)</label><input class="input" type="number" min="0" max="50" step="0.5" data-conformer-field="spreadThresholdKcal" value="${esc(s.spreadThresholdKcal)}"></div>`,
      `<div class="field"><label>Charge</label><input class="input" type="number" min="-10" max="10" data-conformer-field="charge" value="${esc(s.charge)}"></div>`,
      `<div class="field"><label>Multiplicity</label><input class="input" type="number" min="1" max="10" data-conformer-field="multiplicity" value="${esc(s.multiplicity)}"></div>`,
      // Issue #80: one task per retained member instead of one chosen geometry.
      switchRow('Fan out the ensemble', 'one task per retained member downstream', 'fanOut', s.fanOut === true, { attr: 'data-conformer-field="fanOut"' }),
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
  toast(`${replaced ? 'Replaced' : 'Imported'} ${result.records.length} record${result.records.length === 1 ? '' : 's'}`
    + ` from ${filename || 'pasted text'}${skipped}${warnings}.`);
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

function inputInspector(node) {
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
        <td><span class="record-label">${esc(record.label || record.id)}</span><span class="record-id">${esc(record.id)}</span></td>
        <td>${esc(record.charge)}</td>
        <td>${esc(record.multiplicity)}</td>
        <td><input type="checkbox" data-dataset-id="${esc(dataset.id)}" data-dataset-record="${esc(record.id)}"${record.enabled === false ? '' : ' checked'} aria-label="Enable ${esc(record.label || record.id)}"></td>
      </tr>`).join('')
    : '';
  const datasetCard = dataset
    ? `<div class="kv"><span>Source</span><code>${esc(dataset.source?.format || '')}${dataset.source?.path ? ` · ${esc(dataset.source.path)}` : ' · inline'}</code></div>
       <div class="kv"><span>Records</span><code>${counts.enabled} of ${counts.total} enabled</code></div>
       ${records.length ? `<div class="dataset-table-wrap">
         <table class="dataset-table">
           <thead><tr><th>Record</th><th>q</th><th>mult</th><th>on</th></tr></thead>
           <tbody>${recordRows}</tbody>
         </table>
       </div>` : '<div class="callout red"><strong>No records.</strong> This dataset has no geometry to run.</div>'}`
    : '<div class="callout"><strong>No dataset bound.</strong> Import an SDF, XYZ, CSV or JSON file of geometries, or paste its text below.</div>';

  return `${inspectorHead(
    'Data · input',
    node.title,
    dataset ? `${esc(dataset.title)} · ${counts.total} record${counts.total === 1 ? '' : 's'}` : 'no dataset bound',
  )}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">Runs once per enabled record</span></div>
    ${group('Dataset', dataset ? `${counts.total}` : 'none', true, [
      `<div class="field full"><label>Dataset</label><select class="select" data-input-field="datasetId">${options}</select></div>`,
      datasetCard,
      '<div class="field full"><button type="button" class="btn" data-action="import-dataset">Import dataset file…</button></div>',
      '<input type="file" id="dataset-file" accept=".sdf,.sd,.mol,.xyz,.csv,.json" hidden>',
      `<details class="dataset-paste">
        <summary>Paste records instead</summary>
        <div class="field full"><label>Format</label><select class="select" id="dataset-paste-format">
          <option value="">Detect</option><option value="sdf">SDF</option><option value="xyz">XYZ</option><option value="csv">CSV</option><option value="json">JSON</option>
        </select></div>
        <div class="field full"><label>Dataset text</label><textarea class="textarea" id="dataset-paste" rows="6" spellcheck="false" placeholder="$$$$&#10;… or a CSV header, or a JSON array"></textarea></div>
        <button type="button" class="btn small" data-action="import-dataset-paste">Import pasted text</button>
      </details>`,
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
    if (node.type === 'calc') { el.innerHTML = calcInspector(node); mountStructureViewer(el, node); return; }
    if (node.type === 'conformers') { el.innerHTML = conformersInspector(node); mountStructureViewer(el, node); return; }
    if (node.type === 'condition') { el.innerHTML = conditionInspector(node); return; }
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
  ] },
  { group: 'Structure', items: [
    { type: 'conformers', icon: 'CF', title: 'Conformer ensemble', note: 'rank + prune conformers' },
  ] },
  { group: 'Control flow', items: [
    { type: 'condition', icon: 'IF', title: 'Condition', note: 'TRUE / FALSE branches' },
    { type: 'loop', icon: '↻', title: 'Loop', note: 'retry with max attempts' },
    { type: 'merge', icon: '⋈', title: 'Join', note: 'merge branches' },
  ] },
  { group: 'Data', items: [
    { type: 'input', icon: 'IN', title: 'Dataset input', note: 'run the graph once per record' },
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
  } else if (type === 'conformers') {
    node = {
      id, type: 'conformers', kind: 'Conformers', title: 'Conformer ensemble', state: 'ready', ...position,
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
    }[type] || { jobType: 'Opt', title: 'Calculation' };
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
  return node && node.type === 'calc' ? node : null;
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
  if (key === 'routePreset') {
    const preset = ROUTE_PRESETS.find((item) => item.id === value);
    if (!preset) return;
    const next = applyRoutePreset(node.settings, preset.id);
    node.settings.method = next.method;
    node.settings.basis = next.basis;
    node.settings.dispersion = next.dispersion;
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
    } else if (['charge', 'multiplicity', 'imaginary', 'minMagnitude', 'tdStates'].includes(key)) {
      const nullWhenEmpty = key === 'imaginary' || key === 'minMagnitude';
      node.settings[key] = value === '' ? (nullWhenEmpty ? null : 0) : Number(value);
    } else if (key === 'jobType') {
      const wasComposite = isCompositeJobType(node.settings.jobType);
      node.settings.jobType = value;
      node.kind = kindForJob(value);
      const nowComposite = isCompositeJobType(value);
      // A composite keyword carries its own method, basis, dispersion and job
      // steps; leaving the Gaussian pair behind makes the builder refuse the
      // route, and the inspector hides those fields while composite is chosen,
      // so the user could not clear them. Clear on the way in, restore the
      // project default on the way out.
      if (nowComposite && !wasComposite) {
        node.settings.method = '';
        node.settings.basis = '';
        node.settings.dispersion = '';
        node.settings.solvation = false;
        node.settings.population = '';
        node.settings.orbitals = false;
        node.settings.tdStates = 0;
        node.settings.customKeywords = '';
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
    } else if (key === 'method') {
      node.settings.method = value;
      node.settings.dispersion = dispersionForMethodChange(value, node.settings.dispersion);
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
  if (copy.type === 'calc') copy.settings.checkpoint = `${copy.id.replace(/-/g, '_')}.chk`;
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
    if (to?.type === 'calc') to.checkpointFrom = edge.from;
    state.selected = { type: 'edge', id: edgeId(edge) };
    toast('Checkpoint hand-off enabled.');
  } else {
    edge.type = 'dependency';
    const to = nodeById(edge.to);
    if (to?.type === 'calc' && to.checkpointFrom === edge.from) to.checkpointFrom = null;
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
  // The New project chooser reuses the modal shell and its close/Escape/focus
  // handling; only the body renderer is different.
  if (drawer.type === 'template') {
    renderTemplateChooser();
    return;
  }
  if (drawer.type === 'batch') {
    renderBatchImport();
    return;
  }
  const draft = drawer.draft;
  const tabs = drawer.type === 'settings'
    ? []
    : [['structure', 'Structure'], ['fragments', 'Charge & fragments']];
  const activeTab = drawer.type === 'settings' ? 'defaults' : drawer.tab;
  const coords = Array.isArray(draft.coords) ? draft.coords : [];
  const atoms = coords.length ? coords : DEMO_WATER;
  const demo = coords.length === 0;
  const electrons = electronSummary(atoms, draft.charge, draft.multiplicity);
  let body = '';
  if (activeTab === 'structure') {
    const sourceLabel = draft.geometry.source === 'imported' && draft.coords.length
      ? `${esc(draft.geometry.file || 'imported file')} · ${esc(draft.geometry.format || 'structure')}`
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
              <input type="file" id="structure-file" accept=".xyz,.mol,.sdf,.mol2,.pdb,.pdbqt,.cjson,.gjf,.com,.log,.out" hidden>
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
      <div class="callout green"><strong>Project-level structure.</strong> Every calculation block builds its input from these coordinates; each block keeps its own charge, multiplicity, method, basis and gates.</div>`;
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
      <div class="callout"><strong>Fragment order</strong> maps to <code>Fragment=N</code> in the exported route. Fragment labels are metadata; the atom partition comes from the geometry.</div>`;
  } else {
    const engineId = engineOrDefault(draft.engine).id;
    const isXtb = engineId === 'xtb';
    const defaultDispersion = defaultDispersionFor(draft.method);
    const gaussianRoute = `#p ${draft.method}/${draft.basis} Opt${defaultDispersion ? ` EmpiricalDispersion=${defaultDispersion}` : ''}`;
    const xtbMethod = draft.xtbMethod || 'gfn2';
    const gfnFlag = xtbMethod === 'gfnff' ? '--gfnff' : `--gfn ${xtbMethod.replace('gfn', '')}`;
    const xtbRoute = `xtb task.xyz ${gfnFlag} --opt ${draft.xtbOptLevel || 'normal'}`;
    body = `
      <div class="form-grid">
        ${drawerSelect('Engine', 'engine', Object.values(ENGINES).map((item) => [item.id, item.label]), engineId)}
        ${isXtb
    ? drawerSelect('xTB method', 'xtbMethod', XTB_METHODS.map((item) => [item.id, item.label]), draft.xtbMethod || 'gfn2')
    : drawerSelect('Default method', 'method', METHODS, draft.method)}
        ${isXtb
    ? drawerSelect('Optimisation level', 'xtbOptLevel', XTB_OPT_LEVELS.map((level) => [level, level]), draft.xtbOptLevel || 'normal')
    : drawerSelect('Default basis', 'basis', BASIS_SETS, draft.basis)}
        ${isXtb ? '' : drawerField('Memory', 'memory', draft.memory, { type: 'number', attrs: 'min="1" step="1"' })}
        ${isXtb ? '' : drawerSelect('Memory unit', 'memoryUnit', MEMORY_UNITS, draft.memoryUnit)}
        ${drawerField('Cores (nproc)', 'nproc', draft.nproc, { type: 'number', attrs: 'min="1" max="1024" step="1"' })}
      </div>
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Default route · ${esc(engineOrDefault(engineId).label)}</div>
        <div class="code-block">${esc(isXtb ? xtbRoute : gaussianRoute)}</div>
        <p class="field-hint">Shown for the current defaults; each block keeps its own snapshot when it is created.</p>
      </div>
      <div class="callout">${isXtb
    ? 'xTB has no basis set, no transition-state search, no IRC and no scan — blocks needing those are refused when their input is built.'
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
    const text = await file.text();
    const { format, records } = parseStructureRecords(text, { filename: file.name });
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
    }));
    applyImportedRecord(0, file.name, format, usable.length + skipped);
    toast(`Imported ${usable[0].atoms.length} atoms from ${file.name}`
      + `${records.length > 1 ? ` · ${records.length} records, showing record 1` : ''}`
      + `${skipped ? ` · ${skipped} unreadable record${skipped === 1 ? '' : 's'} skipped` : ''}.`);
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
    .filter((node) => node.type === 'calc')
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
  if (node.type === 'calc') return node;
  // Issue 101: a conformer block is runnable on its own (its search), so the
  // run paths that pass `conformers: true` accept it; export still asks for a
  // calculation and keeps refusing it.
  return conformers && node.type === 'conformers' ? node : null;
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

/** Point the run-console copy at the engine the project will actually use. */
function updateRunConsoleCopy() {
  const engineId = engineOrDefault(state.project?.defaults?.engine).id;
  const label = $('#run-exe-label');
  if (label) label.textContent = executableLabelFor(engineId);
  const executable = $('#run-exe');
  if (executable) executable.placeholder = executablePlaceholderFor(engineId);
  const hint = $('#run-hint');
  if (hint && desktop) {
    hint.textContent = dryRunHintFor(engineId);
    hint.classList.remove('is-warn');
  }
}

function syncMaxParallelInput() {
  const input = $('#run-max-parallel');
  if (!input) return;
  const value = Math.max(1, Math.min(Number(state.project?.runner?.maxParallel) || 1, LIMITS.maxParallel));
  input.value = String(value);
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
  return clamped;
}

function maxParallelForQueue() {
  const input = $('#run-max-parallel');
  const value = input ? Number(input.value) : Number(state.project?.runner?.maxParallel);
  return applyMaxParallel(Number.isFinite(value) && value > 0 ? value : 1);
}

function openRunConsole() {
  const consoleEl = $('#run-console');
  if (!consoleEl) return;
  consoleEl.hidden = false;
  updateRunConsoleCopy();
  $('#run-state').focus?.();
  if (!desktop) {
    $('#run-hint').textContent = BROWSER_PREVIEW_CONSOLE_HINT;
    $('#run-hint').classList.add('is-warn');
  }
}

function closeRunConsole() {
  const consoleEl = $('#run-console');
  if (consoleEl) consoleEl.hidden = true;
}

function setRunState(status, label) {
  state.run.status = status;
  const el = $('#run-state');
  if (!el) return;
  el.textContent = label || status;
  el.className = `run-state is-${status}`;
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

function readRunConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(RUN_CONFIG_STORAGE_KEY) || '{}');
    if (saved.executable) $('#run-exe').value = saved.executable;
    if (saved.crestExecutable) $('#run-crest').value = saved.crestExecutable;
    if (saved.scratchDir) $('#run-scratch').value = saved.scratchDir;
    if (typeof saved.dryRun === 'boolean') $('#run-dry').checked = saved.dryRun;
  } catch {
    // A corrupt preference must not block the app.
  }
}

function saveRunConfig() {
  try {
    localStorage.setItem(RUN_CONFIG_STORAGE_KEY, JSON.stringify({
      executable: $('#run-exe').value.trim(),
      crestExecutable: $('#run-crest').value.trim(),
      scratchDir: $('#run-scratch').value.trim(),
      dryRun: $('#run-dry').checked,
    }));
  } catch {
    // Preferences are optional.
  }
}

async function pickGaussian() {
  if (!desktop) { toast('Open the Electron app to choose an executable.'); return; }
  try {
    const engine = engineOrDefault(state.project?.defaults?.engine);
    const selected = await desktop.pickExecutable({ engine: engine.id });
    if (selected) {
      $('#run-exe').value = selected;
      saveRunConfig();
      toast(`${engine.label} executable selected.`);
    }
  } catch (error) {
    toast(`Could not choose executable: ${error.message}`);
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
  } catch (error) {
    toast(`Could not choose the CREST executable: ${error.message}`);
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
  if (!node || node.type !== 'conformers' || !node.output) return;
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

async function pickEnsembleFile() {
  if (!desktop?.pickEnsembleFile) { toast('Open the Electron app to choose an ensemble file.'); return; }
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'conformers') return;
  try {
    const file = await desktop.pickEnsembleFile();
    if (!file) return;
    node.settings.importPath = file;
    node.settings.generator = 'import';
    node.output = null;
    node.state = 'ready';
    refreshDirty();
    renderGraph();
    renderInspector();
    toast('Ensemble file selected. Run the block to rank it.');
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
  const config = {
    engine: engineOrDefault(state.project?.defaults?.engine).id,
    executable: $('#run-exe').value.trim(),
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
      needsCrest = tasks.some((task) => task.type === 'conformers'
        && task.conformers?.generator === 'crest'
        && !task.conformers?.member);
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
  }
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
  if (node.type === 'conformers') { await startSelectedConformerRun(node); return; }

  openRunConsole();
  saveRunConfig();
  const dryRun = $('#run-dry').checked;
  const result = await preflightRun({ quiet: true });
  if (!result || (!result.ok && !dryRun)) {
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
  syncVerifyButton($('#verify-run'), null);
  $('#run-output').textContent = 'Starting local runner…\n';
  $('#run-gates').innerHTML = '';
  mountThermochemistryView($('#run-thermo'), null);
  $('#run-title').textContent = node.title;
  $('#run-path').textContent = '';
  $('#cancel-run')?.removeAttribute('disabled');
  setRunState('running', dryRun ? 'dry run' : 'running');

  try {
    const response = await desktop.runTask({
      title: node.title,
      engine: built.engine,
      argv: built.argv,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      settings: settingsForNode(node),
      executable: $('#run-exe').value.trim(),
      crestExecutable: $('#run-crest').value.trim(),
      scratchDir: $('#run-scratch').value.trim(),
      dryRun,
      gates: gatesForNode(node),
      validity: validityForNode(node),
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
  if (!dryRun && !crestExecutable) {
    toast('Choose the CREST executable before running a conformer search.');
    return;
  }

  let task;
  try {
    task = shared.conformerSearchTask(state.project, node);
  } catch (error) {
    appendRunOutput(`Input builder error: ${error.message}\n`);
    toast(`Cannot build the conformer search: ${error.message}`);
    return;
  }

  state.run.output = '';
  state.run.gates = [];
  state.run.nodeId = node.id;
  state.run.id = null;
  state.run.dir = null;
  syncVerifyButton($('#verify-run'), null);
  $('#run-output').textContent = 'Starting conformer search…\n';
  $('#run-gates').innerHTML = '';
  mountThermochemistryView($('#run-thermo'), null);
  $('#run-title').textContent = node.title;
  $('#run-path').textContent = '';
  $('#cancel-run')?.setAttribute('disabled', '');
  setRunState('running', dryRun ? 'dry run' : 'running');

  try {
    const queue = await desktop.startQueue({
      projectName: state.project.name || 'Conformer search',
      tasks: [task],
      edges: [],
      options: {
        dryRun,
        executable: $('#run-exe').value.trim(),
        crestExecutable,
        scratchDir: $('#run-scratch').value.trim(),
        maxParallel: maxParallelForQueue(),
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

function applyQueue(queue) {
  if (!queue) return;
  state.queue = {
    id: queue.id || null,
    status: queue.status || 'idle',
    tasks: Array.isArray(queue.tasks) ? queue.tasks : [],
    reason: queue.reason || null,
  };
  renderQueue();
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
      ? queue.tasks.map((task) => {
        const branch = task.conditionResult === true ? '→ true' : task.conditionResult === false ? '→ false' : '';
        const retry = task.loopAttempts
          ? `retry ${Math.min(task.loopAttempts, task.loop?.maxAttempts ?? task.loopAttempts)}/${task.loop?.maxAttempts ?? '?'}`
          : '';
        const meta = [task.status, task.attempts > 1 ? `×${task.attempts}` : '', retry, branch, task.gateVerdict ? `gates ${task.gateVerdict}` : '']
          .filter(Boolean).join(' · ');
        return `<li class="queue-item is-${esc(task.status)}" data-run-id="${esc(task.runId || '')}" title="${esc(task.error || task.reason || '')}"><span class="queue-dot"></span><span class="queue-title">${esc(task.title)}</span><span class="queue-meta">${esc(meta)}</span></li>`;
      }).join('')
      : '<li class="queue-empty">Queue the workflow to run calculation blocks in dependency order, one at a time.</li>';
  }
  const running = queue.status === 'running';
  const canResume = queue.status === 'paused' || queue.status === 'needs-review';
  const active = running || canResume;
  const starting = Boolean(queue.starting);
  $('#run-workflow')?.toggleAttribute('disabled', active || starting);
  $('#pause-workflow')?.toggleAttribute('disabled', !running);
  $('#resume-workflow')?.toggleAttribute('disabled', !canResume);
  $('#cancel-workflow')?.toggleAttribute('disabled', !active);
  $('#report-workflow')?.toggleAttribute('disabled', !queue.id || queue.status === 'running');
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
    <tr class="is-${esc(record.status)}">
      <td><span class="record-label">${esc(record.label)}</span><span class="record-id">${esc(record.id)}</span></td>
      <td><span class="record-status is-${esc(record.status)}">${esc(record.status)}</span></td>
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

  const preflight = await preflightRun({ quiet: true });
  if (!preflight || (!preflight.ok && !dryRun)) {
    toast('Preflight is not ready. Fix the run configuration or use dry run.');
    return;
  }

  state.run.output = '';
  appendRunOutput(`Queued workflow · ${tasks.filter((task) => task.executable).length} calculation block(s)\n`);
  $('#run-gates').innerHTML = '';
  $('#run-title').textContent = state.project.name || 'Workflow';

  try {
    const queue = await desktop.startQueue({
      projectName: state.project.name,
      tasks,
      edges,
      options: {
        dryRun,
        executable: $('#run-exe').value.trim(),
        crestExecutable: $('#run-crest').value.trim(),
        scratchDir: $('#run-scratch').value.trim(),
        maxParallel: maxParallelForQueue(),
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
  try {
    const result = await desktop.exportWorkflowReport(state.queue.id);
    if (!result || result.canceled) return;
    if (result.error) {
      toast(`Could not write the report: ${result.error.message}`);
      return;
    }
    toast(`Report written · ${result.taskCount} task(s) · verdict ${result.verdict}`);
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
  if (!node || node.type !== 'calc') return;
  node.parsed = record.parsed;
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
    if (!record?.parsed || !node || node.type !== 'calc') continue;
    node.parsed = record.parsed;
    changed = true;
  }
  if (changed && state.selected.type === 'node') renderInspector();
}

/**
 * Copy finished conformer ensembles into their blocks. The queue is the only
 * place a real search result exists, so this is what makes the table appear in
 * the inspector; a re-run with the same stamp does not stomp a later choice.
 */
function attachQueueEnsembles(queue) {
  let changed = false;
  for (const task of queue?.tasks || []) {
    if (task?.type !== 'conformers' || task.status !== 'completed' || !task.ensemble) continue;
    const node = nodeById(task.nodeId);
    if (!node || node.type !== 'conformers') continue;
    if (node.output && node.output.generatedAt === task.ensemble.generatedAt) continue;
    node.output = task.ensemble;
    node.settings.selectedConformerId = task.ensemble.selectedId || '';
    node.state = task.ensemble.requiresSelection ? 'review' : 'passed';
    changed = true;
  }
  if (changed) {
    refreshDirty();
    renderGraph();
    renderInspector();
  }
}

function handleQueueEvent(event) {
  if (!event) return;
  if (event.type === 'queue-output') {
    const task = state.queue.tasks.find((item) => item.nodeId === event.nodeId);
    appendRunOutput(`\n[${task?.title || event.nodeId}]\n${event.text}`);
    return;
  }
  if (!event.queue) return;
  applyQueue(event.queue);
  attachQueueEnsembles(event.queue);
  if (event.type === 'queue-started') {
    const queuedEngine = event.queue.tasks.find((task) => task.engine)?.engine
      || state.project?.defaults?.engine;
    const records = groupTasksByRecord(event.queue.tasks);
    const recordCopy = records.hasRecords ? ` · ${countLabel(records.total, 'record')}` : '';
    setStatusMessage(`Workflow running · ${countLabel(event.queue.tasks.length, 'block')}${recordCopy} · ${runEngineLabel(queuedEngine, { dryRun: event.queue.options?.dryRun })}`);
  }
  if (event.type === 'queue-done') {
    const verdict = event.queue.status;
    appendRunOutput(`\nWorkflow ${verdict}${event.queue.reason ? ` — ${event.queue.reason}` : ''}\n`);
    setStatusMessage(`Workflow ${verdict}${event.queue.reason ? ` · ${event.queue.reason}` : ''}`);
    attachQueueParsed(event.queue).catch(() => {});
    toast(`Workflow ${verdict}.`);
    refreshHistory();
  }
}

async function refreshHistory() {
  if (!desktop?.listRuns) return;
  try {
    const runs = (await desktop.listRuns()).slice(0, 6);
    const el = $('#run-history');
    if (!el) return;
    el.innerHTML = runs.length
      ? runs.map((run) => {
        const meta = [run.status, run.gates?.overall ? `gates ${run.gates.overall}` : '', run.dryRun ? 'dry' : engineOrDefault(run.engine).label]
          .filter(Boolean).join(' · ');
        return `<li class="queue-item is-${esc(run.status)}" data-run-id="${esc(run.id || '')}" title="${esc(run.runDir || '')}"><span class="queue-dot"></span><span class="queue-title">${esc(run.title || run.id)}</span><span class="queue-meta">${esc(meta)}</span></li>`;
      }).join('')
      : '<li class="queue-empty">No runs recorded yet.</li>';
  } catch {
    // History is optional; a failure must not break the console.
  }
}

async function restoreQueue() {
  if (!desktop?.listQueues) return;
  try {
    const queues = await desktop.listQueues();
    const active = queues.find((queue) => ['running', 'paused'].includes(queue.status)) || queues[0];
    if (active) applyQueue(active);
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
  state.project = result.project;
  hydrateProject(state.project);
  state.selected = { type: 'project', id: null };
  state.history = null;
  markProjectSaved(result.path);
  const name = $('#project-name-text');
  if (name) name.textContent = state.project.name || 'Untitled project';
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
  state.statusMessage = result.migrated
    ? `Opened ${result.path} · migrated from v0.1 to schema v${state.project.schemaVersion}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
    : `Opened ${result.path}`;
  renderGraph();
  renderInspector();
  updateCounts();
  updateRunConsoleCopy();
  syncMaxParallelInput();
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
  try {
    const result = await desktop.openProject();
    applyOpenedProject(result);
  } catch (error) {
    toast(`Could not open project: ${error.message}`);
  }
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
  closeDrawer();
  state.project = project;
  state.selected = { type: 'project', id: null };
  state.connecting = null;
  state.keyboardConnect = null;
  state.paletteOpen = false;
  state.history = null;
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
  syncMaxParallelInput();
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
    .filter((node) => node.type === 'calc')
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

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'interrupted']);
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
    groups.push([{
      label: `Input file — ${node.title} (.gjf)`,
      attrs: 'data-action="export"',
    }]);
  }
  const hasCalc = (state.project?.nodes || []).some((item) => item.type === 'calc');
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
    case 'pick-gaussian': pickGaussian(); break;
    case 'preflight': preflightRun(); break;
    case 'run-selected': startSelectedRun(); break;
    case 'run-workflow': startWorkflow(); break;
    case 'select-conformer': selectConformer(element.dataset.conformerId); break;
    case 'pick-ensemble': pickEnsembleFile(); break;
    case 'pick-crest': pickCrest(); break;
    case 'pause-workflow': pauseWorkflow(); break;
    case 'export-workflow-report': exportWorkflowReportAction(); break;
    case 'resume-workflow': resumeWorkflow(); break;
    case 'cancel-workflow': cancelWorkflow(); break;
    case 'refresh-history': refreshHistory(); break;
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
    case 'project-menu': toast('Use Open or Save in the top bar for native project files.'); break;
    case 'about': toast(`NodeChem Studio — the graph is the workspace. The inspector exposes the full job parameter set; the local runner executes one selected block or the whole workflow queue${appVersion ? ` (v${appVersion})` : ''}.`); break;
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
    return;
  }
  if (target.id === 'run-max-parallel') {
    applyMaxParallel(target.value);
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
    if (node.type !== 'calc') return;
    updateNodeField(node, key, value);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.nodeGate) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'calc') return;
    updateGate(node, target.dataset.nodeGate, target.checked);
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.validityCheck) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'calc') return;
    updateValidityCheck(node, target.dataset.validityCheck, target.checked);
    renderInspector();
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
}

/**
 * One writer for the conformer block's settings. Both the input and the change
 * listeners come here, so typing a number and picking from a select behave the
 * same way.
 */
function applyConformerField(target) {
  if (state.selected.type !== 'node') return;
  const node = nodeById(state.selected.id);
  if (!node || node.type !== 'conformers') return;
  const key = target.dataset.conformerField;
  const numeric = ['energyWindowKcal', 'rmsdThreshold', 'maxConformers', 'temperature', 'spreadThresholdKcal', 'charge', 'multiplicity'];
  if (numeric.includes(key)) {
    const bounds = {
      energyWindowKcal: [0, 100], rmsdThreshold: [0.01, 10], maxConformers: [1, 200],
      temperature: [1, 1000], spreadThresholdKcal: [0, 50], charge: [-10, 10], multiplicity: [1, 10],
    }[key];
    const value = Number(target.value);
    if (!Number.isFinite(value)) return;
    node.settings[key] = clamp(value, bounds[0], bounds[1]);
  } else {
    // A switch writes its checked state, not the string "on".
    node.settings[key] = target.type === 'checkbox' ? target.checked : target.value;
    if (key === 'generator' && node.output && node.output.generator !== target.value) {
      // An imported table is not what CREST would produce, and a CREST run is
      // not the file that was imported: switching the source voids the choice.
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

function wireEvents() {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('change', onDocumentChange);
  document.addEventListener('input', onDocumentInput);

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
      if (!$('#app-menu')?.hidden) { closeAppMenu(); return; }
      if (!$('#export-menu')?.hidden) { closeExportMenu(); return; }
      if (state.paletteOpen) { togglePalette(false); return; }
      if (!$('#run-console')?.hidden) { closeRunConsole(); return; }
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
}

/* ── Boot ─────────────────────────────────────────────────── */

// Exported for the Node-side inspector tests: importing this module with a
// stubbed `document.readyState = 'loading'` does not boot the UI.
export { calcInspector, inputInspector, nodeDetail, renderFlowTabs, renderRecordSummary, simpleInspector, state };

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

function init() {
  loadAppInfo();
  // Remember the project exactly as loaded: until it changes, there is nothing
  // worth drafting, and a fresh session must not overwrite a recoverable draft.
  state.draftBaseline = JSON.stringify(state.project);
  if (window.innerWidth <= 820) state.inspectorHidden = true;
  readRunConfig();
  updateRunConsoleCopy();
  syncMaxParallelInput();
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
  restoreQueue();
  // Offer the draft only after a startup project has had the chance to load,
  // so the comparison is against the project the user will actually see.
  openStartupProject().finally(offerDraftRestore);
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
