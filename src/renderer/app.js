'use strict';

/* ============================================================
   Gaussian Node Studio — node-first Electron workspace
   The graph is the primary surface. The runner is local-only.
   ============================================================ */

import {
  buildGaussianInput,
  DEMO_WATER,
  outputNameFor,
} from '../shared/gaussianInput.js';
import { defaultGates, defaultSettings } from '../shared/projectSchema.js';

const desktop = window.desktop || null;

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
  ['6-31G(d)', '6-31G(d)'], ['6-311+G(d,p)', '6-311+G(d,p)'],
  ['def2-TZVP', 'def2-TZVP'], ['cc-pVTZ', 'cc-pVTZ'], ['SDD', 'SDD'],
];
const JOB_TYPES = [
  ['Opt', 'Optimization'], ['Opt Freq', 'Optimization + frequency'],
  ['Opt=TS', 'Transition state'], ['Freq', 'Frequency'], ['IRC', 'IRC path'],
  ['SP', 'Single point'], ['Scan', 'PES scan'],
];
const IRC_DIRECTIONS = [['forward', 'Forward'], ['reverse', 'Reverse'], ['both', 'Both directions']];
const DISPERSIONS = [['', 'None'], ['GD3BJ', 'D3(BJ)'], ['GD3', 'D3']];
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
  },
  defaults: {
    method: 'B3LYP',
    basis: '6-31G(d)',
    memory: '4',
    memoryUnit: 'GB',
    nproc: '4',
  },
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
      settings: { jobType: 'Opt=TS', checkpoint: 'ts_opt.chk' },
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

const state = {
  project,
  selected: { type: 'project', id: null },
  inspectorMode: 'dock',
  inspectorHidden: false,
  inspectorWide: false,
  zoom: 0.94,
  paletteOpen: false,
  drawer: null,
  connecting: null,
  drag: null,
  pan: null,
  toastTimer: null,
  statusMessage: 'Preview project · choose a calculation block to run the local Gaussian slice',
  run: {
    id: null,
    status: 'idle',
    dir: null,
    output: '',
    gates: [],
  },
  queue: {
    id: null,
    status: 'idle',
    tasks: [],
    reason: null,
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
  return ({
    Opt: 'Opt', 'Opt Freq': 'O+F', 'Opt=TS': 'TS', Freq: 'Freq', IRC: 'IRC', SP: 'SP', Scan: 'Scan',
  }[jobType] || 'SP');
}

function routeShort(settings) {
  const job = settings.jobType === 'IRC'
    ? `IRC(${settings.ircDirection === 'both' ? 'forward,reverse' : settings.ircDirection})`
    : settings.jobType;
  return `${settings.method}/${settings.basis} ${job}`;
}

function routeFull(settings) {
  const tokens = [`#p ${routeShort(settings)}`];
  if (settings.dispersion) tokens.push(`EmpiricalDispersion=${settings.dispersion}`);
  if (settings.scf) tokens.push(`SCF=${settings.scf}`);
  if (settings.grid) tokens.push(`Integral=${settings.grid}`);
  if (settings.population) tokens.push(`Pop=${settings.population}`);
  if (settings.verbosity) tokens.push(`Output=${settings.verbosity}`);
  if (settings.solvation) tokens.push(`SCRF=(${settings.solvationModel},Solvent=${settings.solvent})`);
  if (settings.customKeywords) tokens.push(settings.customKeywords);
  return tokens.join(' ');
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

function nodeDetail(node) {
  if (node.type === 'calc') return routeShort(node.settings);
  if (node.type === 'condition') return node.condition.expression.replace(/\s*\n\s*/g, ' · ');
  if (node.type === 'loop') return `max ${node.loop.maxAttempts} attempts · ${nodeById(node.loop.target)?.title || 'no target'}`;
  if (node.type === 'merge') return node.merge.policy === 'any' ? 'wait for any input' : 'wait for all inputs';
  if (node.type === 'output') return `${node.output.bundle} · manifest`;
  if (node.type === 'note') return node.note.text;
  return '';
}

function nodeFoot(node) {
  if (node.type === 'calc') {
    const output = node.output ? 'parsed' : node.state === 'ready' ? 'ready to run' : 'no output';
    return { left: gateChips(node).join(' · '), right: output };
  }
  if (node.type === 'condition') return { left: `unknown → ${node.condition.unknown.replace('-', ' ')}`, right: '2 branches' };
  if (node.type === 'loop') return { left: `until ${node.loop.until}`, right: `×${node.loop.maxAttempts}` };
  if (node.type === 'merge') return { left: `policy: ${node.merge.policy}`, right: 'join' };
  if (node.type === 'output') return { left: 'bundle + manifest', right: 'zip' };
  if (node.type === 'note') return { left: 'annotation', right: '' };
  return { left: '', right: '' };
}

function kindCode(node) {
  if (node.type === 'condition') return 'IF';
  if (node.type === 'loop') return '↻';
  if (node.type === 'merge') return '⋈';
  if (node.type === 'output') return 'OUT';
  if (node.type === 'note') return '✎';
  return node.kind;
}

function kindLabel(node) {
  if (node.type === 'condition') return 'Control';
  if (node.type === 'loop') return 'Control';
  if (node.type === 'merge') return 'Join';
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
    html += `<span class="port true" data-from="${node.id}" data-port="true" role="button" aria-label="Connect TRUE branch"></span>`;
    html += `<span class="port false" data-from="${node.id}" data-port="false" role="button" aria-label="Connect FALSE branch"></span>`;
    html += '<span class="branch-tag true">T</span><span class="branch-tag false">F</span>';
    return html;
  }
  if (node.type === 'loop') {
    return `<span class="port left" aria-hidden="true"></span><span class="port bottom" data-from="${node.id}" data-port="bottom" role="button" aria-label="Connect loop back"></span><span class="loop-tag">↻</span>`;
  }
  if (node.type === 'output') return '<span class="port left" aria-hidden="true"></span>';
  if (node.type === 'merge') {
    return `<span class="port left" aria-hidden="true"></span><span class="port right" data-from="${node.id}" data-port="right" role="button" aria-label="Connect output"></span>`;
  }

  html += '<span class="port left" aria-hidden="true"></span>';
  html += `<span class="port right" data-from="${node.id}" data-port="right" role="button" aria-label="Connect output"></span>`;
  if (outs.some((edge) => edge.fromPort === 'bottom')) {
    html += `<span class="port bottom" data-from="${node.id}" data-port="bottom" role="button" aria-label="Connect output below"></span>`;
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
      data-node-id="${node.id}" tabindex="0" role="button" aria-label="${esc(node.title)}, ${showStatus ? status.label : 'note'}"
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

function renderGraph() {
  const container = nodesEl();
  if (!container) return;
  container.innerHTML = state.project.nodes.map(renderNodeCard).join('');
  renderEdges();
  updateCounts();
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
    count.textContent = `${state.project.nodes.length} blocks · ${state.project.edges.length} connections${loops ? ` · ${loops} loop` : ''}`;
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
  return `<div class="field${full}"><label>${esc(label)}</label><input class="input${type === 'number' ? '' : ''}" type="${type}" data-node-field="${key}" value="${esc(value)}" ${options.min !== undefined ? `min="${options.min}"` : ''} ${options.max !== undefined ? `max="${options.max}"` : ''} ${options.step ? `step="${options.step}"` : ''}></div>`;
}

function selectField(label, key, options, value, full = false) {
  return `<div class="field${full ? ' full' : ''}"><label>${esc(label)}</label><select class="select" data-node-field="${key}">
    ${options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${esc(optionLabel)}</option>`).join('')}
  </select></div>`;
}

function switchRow(label, hint, key, checked, options = {}) {
  const dataAttribute = options.attr || (options.gate ? `data-node-gate="${key}"` : `data-node-field="${key}"`);
  return `<div class="switch-row">
    <div>${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>
    <label class="switch"><input type="checkbox" ${dataAttribute} ${checked ? 'checked' : ''} ${options.disabled ? 'disabled' : ''}><span></span></label>
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
    `${nodes.length} blocks · ${state.project.edges.length} connections${loopCount ? ` · ${loopCount} loop` : ''}`,
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
          <div><strong>Project structure</strong><span>${state.project.molecule.fragments.length} fragments · charge ${state.project.molecule.charge} · multiplicity ${state.project.molecule.multiplicity}</span></div>
        </div>
        <button type="button" class="btn" data-open-modal="molecule">Edit molecule</button>
      </div>
    </section>

    <section class="section">
      <div class="section-label">Project defaults</div>
      <div class="card">
        <div class="kv"><span>Method</span><code>${esc(state.project.defaults.method)}</code></div>
        <div class="kv"><span>Basis</span><code>${esc(state.project.defaults.basis)}</code></div>
        <div class="kv"><span>Resources</span><code>${esc(state.project.defaults.memory)} ${esc(state.project.defaults.memoryUnit)} · ${esc(state.project.defaults.nproc)} cores</code></div>
        <button type="button" class="btn" data-open-modal="molecule">Edit defaults</button>
      </div>
    </section>

    <section class="section">
      <div class="section-label">Validation</div>
      <div class="validation-card">
        <span class="v-icon">✓</span>
        <div><strong>Structure valid</strong>${condCount ? `${condCount} condition · ` : ''}${loopCount} loop. Branch and loop execution is planned; the v0.1 runner executes a single selected calculation.</div>
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

function calcInspector(node) {
  const s = node.settings;
  const ins = incoming(node.id);
  const outs = outgoing(node.id);
  const status = statusFor(node);
  const checkpointSource = node.checkpointFrom ? nodeById(node.checkpointFrom) : null;
  const routeLines = [`%Chk=${esc(s.checkpoint || chkName(node.id))}`];
  if (checkpointSource) routeLines.push(`%OldChk=${esc(chkName(checkpointSource.id))}`);
  routeLines.push(routeFull(s));

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

  const jobGroup = group('Job', s.jobType, true, [
    inputField('Title', 'title', node.title, { full: true }),
    selectField('Job type', 'jobType', JOB_TYPES, s.jobType),
    s.jobType === 'IRC' ? selectField('IRC direction', 'ircDirection', IRC_DIRECTIONS, s.ircDirection) : '',
    `<div class="field"><label>Memory</label><div class="field-row">
      <input class="input" type="number" min="1" max="512" data-node-field="memory" value="${esc(s.memory)}">
      <select class="select" data-node-field="memoryUnit">${MEMORY_UNITS.map(([value, label]) => `<option value="${value}"${s.memoryUnit === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </div></div>`,
    inputField('Cores (nproc)', 'nproc', s.nproc, { type: 'number', min: 1, max: 256 }),
    inputField('Checkpoint file', 'checkpoint', s.checkpoint || chkName(node.id), { full: true }),
  ].join(''));

  const methodGroup = group('Method & basis', `${s.method}/${s.basis}`, true, [
    selectField('Method', 'method', METHODS, s.method),
    selectField('Basis set', 'basis', BASIS_SETS, s.basis),
    selectField('Dispersion', 'dispersion', DISPERSIONS, s.dispersion),
    selectField('SCF convergence', 'scf', SCF_OPTIONS, s.scf),
    selectField('Integration grid', 'grid', GRID_OPTIONS, s.grid),
    selectField('Population analysis', 'population', POP_OPTIONS, s.population),
    selectField('Output verbosity', 'verbosity', VERBOSITY, s.verbosity),
  ].join(''));

  const solvationGroup = group('Solvation', s.solvation ? `${s.solvationModel} · ${s.solvent}` : 'off', s.solvation, [
    switchRow('Implicit solvation', 'PCM / SMD / CPCM', 'solvation', s.solvation),
    selectField('Model', 'solvationModel', SOLVATION_MODELS, s.solvationModel),
    selectField('Solvent', 'solvent', SOLVENTS, s.solvent),
  ].join(''));

  const moleculeGroup = group('Molecule', `${state.project.molecule.fragments.length} fragments`, false, [
    inputField('Charge', 'charge', s.charge, { type: 'number', min: -10, max: 10 }),
    inputField('Multiplicity', 'multiplicity', s.multiplicity, { type: 'number', min: 1, max: 10 }),
    `<div class="field full"><label>Structure</label><div class="card" style="display:flex;align-items:center;gap:8px;justify-content:space-between">
      <span class="inspector-note">Inherited from the project molecule.</span>
      <button type="button" class="btn small" data-open-modal="molecule">Edit</button>
    </div></div>`,
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

  const dependencyGroup = group('Dependencies', `${ins.length} input${ins.length === 1 ? '' : 's'}`, true, [
    `<div class="full">${incomingList(node.id)}</div>`,
    ins.length ? `<div class="field full"><label>Checkpoint hand-off</label><select class="select" data-node-field="checkpointFrom">
      <option value="">None</option>
      ${ins.map((edge) => {
        const source = nodeById(edge.from);
        return source ? `<option value="${source.id}"${node.checkpointFrom === source.id ? ' selected' : ''}>${esc(source.title)}${source.settings?.checkpoint ? ` · ${esc(source.settings.checkpoint)}` : ''}</option>` : '';
      }).join('')}
    </select><span class="inspector-note" style="display:block;margin-top:4px">Adds <code>%OldChk</code>, <code>Geom=Checkpoint</code> and <code>Guess=Read</code> to this task.</span></div>` : '',
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

  const primary = node.state === 'passed'
    ? '<button type="button" class="btn primary" data-action="view-output">View output</button>'
    : node.state === 'ready'
      ? '<button type="button" class="btn primary" data-action="export">Export input</button>'
      : '<button type="button" class="btn primary" data-action="import-log">Import log</button>';

  return `${inspectorHead(`${kindLabel(node)} · ${node.kind}`, node.title, `${routeShort(s)} · ${status.label}`)}
  <div class="inspector-scroll">
    <div class="inspector-status-row">${statusPill(node.state)}<span class="inspector-note">${ins.length} input${ins.length === 1 ? '' : 's'} · ${outs.length} output${outs.length === 1 ? '' : 's'}</span></div>
    ${callout}
    <div class="code-block" style="margin-bottom:10px">${routeLines.map((line) => `<div>${line}</div>`).join('')}</div>
    ${jobGroup}
    ${methodGroup}
    ${solvationGroup}
    ${moleculeGroup}
    ${gatesGroup}
    ${dependencyGroup}
    ${outputGroup}
    ${extraGroup}
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

function simpleInspector(node) {
  const isNote = node.type === 'note';
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
        inputField('Bundle name', 'bundle', node.output.bundle, { full: true }),
        switchRow('Include manifest', 'DAG + provenance sidecar', 'manifest', node.output.manifest, { attr: 'data-output-field="manifest"' }),
        `<div class="field full"><label>Notes</label><textarea class="textarea" data-output-field="notes" rows="3">${esc(node.output.notes)}</textarea></div>`,
      ].join('');

  return `${inspectorHead(
    isNote ? 'Annotation' : node.type === 'merge' ? 'Control · join' : 'Project output',
    node.title,
    isNote ? 'freeform note' : node.type === 'merge' ? 'combine branches' : 'bundle + manifest',
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
  const checkpointLines = edge.type === 'checkpoint'
    ? `<div class="code-block" style="margin-bottom:10px"><div>%OldChk=${esc(chkName(from.id))}</div><div>Geom=Checkpoint</div><div>Guess=Read</div></div>`
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
    : from.settings?.checkpoint
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
    if (node.type === 'calc') { el.innerHTML = calcInspector(node); return; }
    if (node.type === 'condition') { el.innerHTML = conditionInspector(node); return; }
    if (node.type === 'loop') { el.innerHTML = loopInspector(node); return; }
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
  { group: 'Control flow', items: [
    { type: 'condition', icon: 'IF', title: 'Condition', note: 'TRUE / FALSE branches' },
    { type: 'loop', icon: '↻', title: 'Loop', note: 'retry with max attempts' },
    { type: 'merge', icon: '⋈', title: 'Join', note: 'merge branches' },
  ] },
  { group: 'Project', items: [
    { type: 'output', icon: 'OUT', title: 'Output bundle', note: 'zip + manifest' },
    { type: 'note', icon: '✎', title: 'Note', note: 'annotation on the canvas' },
    { type: 'checkpoint', icon: 'CHK', title: 'Checkpoint hand-off', note: 'applied to a connection' },
  ] },
];

function renderPalette() {
  const list = $('#palette-list');
  if (!list) return;
  list.innerHTML = BLOCKS.map((groupDef) => `
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
  if (palette) palette.hidden = !state.paletteOpen;
  if (button) button.setAttribute('aria-expanded', String(state.paletteOpen));
  if (state.paletteOpen) renderPalette();
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
  } else if (type === 'merge') {
    node = {
      id, type: 'merge', kind: 'Merge', title: 'Join branches', state: 'ready', ...position,
      merge: { policy: 'all', notes: '' },
    };
  } else if (type === 'output') {
    node = {
      id, type: 'output', kind: 'Output', title: 'Project output', state: 'ready', ...position,
      output: { bundle: 'project.zip', manifest: true, notes: '' },
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

function updateNodeField(node, key, value) {
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
  if (key in node.settings) {
    if (key === 'solvation') node.settings.solvation = Boolean(value);
    else if (['charge', 'multiplicity', 'imaginary', 'minMagnitude'].includes(key)) {
      node.settings[key] = value === '' ? (key === 'imaginary' || key === 'minMagnitude' ? null : 0) : Number(value);
    } else if (key === 'jobType') {
      node.settings.jobType = value;
      node.kind = kindForJob(value);
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

function removeNode(id) {
  const node = nodeById(id);
  if (!node) return;
  state.project.nodes = state.project.nodes.filter((item) => item.id !== id);
  state.project.edges = state.project.edges.filter((edge) => edge.from !== id && edge.to !== id);
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
  state.project.edges = state.project.edges.filter((item) => edgeId(item) !== id);
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
    if (!from?.settings?.checkpoint) {
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
  if (!from || !to || from.id === to.id) return;
  if (to.type === 'note') { toast('Notes cannot receive connections.'); return; }
  let type = 'dependency';
  let branch = null;
  if (port === 'true' || port === 'false') { type = 'branch'; branch = port; }
  else if (port === 'bottom' && from.type === 'loop') type = 'loop';

  if (type !== 'loop' && wouldCreateCycle(fromId, toId)) {
    toast('That connection would create an ordinary cycle. Use a Loop block for retry paths.');
    return;
  }
  const duplicate = state.project.edges.some((edge) => (
    edge.from === fromId && edge.to === toId && edge.type === type && edge.branch === branch
  ));
  if (duplicate) { toast('That connection already exists.'); return; }

  if (type === 'branch') {
    state.project.edges = state.project.edges.filter((edge) => !(edge.from === fromId && edge.type === 'branch' && edge.branch === branch));
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
  const el = document.querySelector(`.node[data-node-id="${state.drag.id}"]`);
  el?.classList.remove('is-dragging');
  state.drag = null;
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
  return `<div class="field${options.full ? ' full' : ''}"><label>${esc(label)}</label><input class="input" data-drawer-field="${key}" value="${esc(value)}"></div>`;
}

function drawerSelect(label, key, options, value, full = false) {
  return `<div class="field${full ? ' full' : ''}"><label>${esc(label)}</label><select class="select" data-drawer-field="${key}">
    ${options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${esc(optionLabel)}</option>`).join('')}
  </select></div>`;
}

function openMoleculeDrawer(tab = 'structure') {
  state.drawer = {
    type: 'molecule',
    tab,
    draft: {
      smiles: state.project.molecule.smiles,
      charge: state.project.molecule.charge,
      multiplicity: state.project.molecule.multiplicity,
      fragments: [...state.project.molecule.fragments],
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
}

function closeDrawer() {
  const backdrop = $('#modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  const modal = $('#modal');
  if (modal) modal.innerHTML = '';
  state.drawer = null;
}

function renderDrawer() {
  const modal = $('#modal');
  if (!modal || !state.drawer) return;
  const drawer = state.drawer;
  const draft = drawer.draft;
  const tabs = [
    ['structure', 'Structure'],
    ['fragments', 'Charge & fragments'],
    ['defaults', 'Defaults'],
  ];
  let body = '';
  if (drawer.tab === 'structure') {
    body = `
      <div class="form-section">
        <div class="section-label">Structure source</div>
        <textarea class="textarea" data-drawer-field="smiles" rows="4" placeholder="SMILES, e.g. C=CC=C.C=C">${esc(draft.smiles)}</textarea>
        <div class="drop-zone" style="margin-top:10px"><strong>Drop a structure file</strong><span>.mol · .sdf · .xyz · .gjf · .com</span><span>File parsing is planned; the v0.1 runner uses the demo water geometry.</span></div>
      </div>
      <div class="callout green"><strong>Project-level structure.</strong> Blocks inherit this molecule; each block keeps its own charge, multiplicity, method, basis, and gates.</div>
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Project summary</div>
        <div class="card">
          <div class="kv"><span>Fragments</span><code>${draft.fragments.length}</code></div>
          <div class="kv"><span>Charge</span><code>${esc(draft.charge)}</code></div>
          <div class="kv"><span>Multiplicity</span><code>${esc(draft.multiplicity)}</code></div>
          <div class="kv"><span>Default method</span><code>${esc(draft.method)}/${esc(draft.basis)}</code></div>
        </div>
      </div>`;
  } else if (drawer.tab === 'fragments') {
    body = `
      <div class="form-grid">
        ${drawerField('Charge', 'charge', draft.charge)}
        ${drawerField('Multiplicity', 'multiplicity', draft.multiplicity)}
      </div>
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Fragments <span class="group-meta">${draft.fragments.length}</span></div>
        ${draft.fragments.map((fragment, index) => `<div class="fragment-row"><span class="frag-label">Fragment ${index + 1}</span><input class="input" data-drawer-fragment="${index}" value="${esc(fragment)}"></div>`).join('')}
        <button type="button" class="btn small" data-action="add-fragment">Add fragment</button>
      </div>
      <div class="callout">Fragment order maps to <code>(Fragment=N)</code> in the exported route. Charge and multiplicity parity is checked by the real app.</div>`;
  } else {
    body = `
      <div class="form-grid">
        ${drawerSelect('Default method', 'method', METHODS, draft.method)}
        ${drawerSelect('Default basis', 'basis', BASIS_SETS, draft.basis)}
        ${drawerField('Memory', 'memory', draft.memory)}
        ${drawerSelect('Memory unit', 'memoryUnit', MEMORY_UNITS, draft.memoryUnit)}
        ${drawerField('Cores (nproc)', 'nproc', draft.nproc)}
      </div>
      <div class="form-section" style="margin-top:14px">
        <div class="section-label">Default route</div>
        <div class="code-block">#p ${esc(draft.method)}/${esc(draft.basis)} Opt</div>
      </div>
      <div class="callout">Defaults apply to <strong>new</strong> blocks. Existing blocks keep their own parameter snapshot, exactly like a workflow task.</div>`;
  }

  modal.innerHTML = `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Project · molecule</span>
        <h2 id="modal-title">Molecule & defaults</h2>
        <p>Project-level structure and the parameters inherited by new blocks.</p>
      </div>
      <button type="button" class="icon-btn" data-modal-close aria-label="Close drawer">×</button>
    </div>
    <div class="modal-tabs">
      ${tabs.map(([id, label]) => `<button type="button" class="modal-tab${drawer.tab === id ? ' is-active' : ''}" data-drawer-tab="${id}">${label}</button>`).join('')}
    </div>
    <div class="modal-body">
      ${body}
      <div class="callout" style="margin-top:14px"><strong>v0.1 boundary.</strong> The runner uses a demo water geometry. Native structure parsing and project-level molecule propagation are the next milestone.</div>
    </div>
    <div class="modal-foot">
      <div class="modal-note">Changes apply to this project only.</div>
      <button type="button" class="btn" data-modal-close>Cancel</button>
      <button type="button" class="btn primary" data-action="save-molecule">Save changes</button>
    </div>`;
}

function saveMolecule() {
  if (!state.drawer) return;
  const draft = state.drawer.draft;
  state.project.molecule.smiles = draft.smiles;
  state.project.molecule.charge = Number(draft.charge) || 0;
  state.project.molecule.multiplicity = Number(draft.multiplicity) || 1;
  state.project.molecule.fragments = [...draft.fragments];
  state.project.defaults.method = draft.method;
  state.project.defaults.basis = draft.basis;
  state.project.defaults.memory = draft.memory;
  state.project.defaults.memoryUnit = draft.memoryUnit;
  state.project.defaults.nproc = draft.nproc;
  closeDrawer();
  renderInspector();
  toast('Project molecule and defaults updated.');
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
  const conditions = state.project.nodes.filter((node) => node.type === 'condition').length;
  const loops = state.project.edges.filter((edge) => edge.type === 'loop').length;
  if (hasOrdinaryCycle()) {
    state.statusMessage = 'Structure warning · an ordinary dependency cycle exists. Use an explicit Loop block.';
    toast('Validation found an ordinary cycle.');
  } else {
    state.statusMessage = `Structure valid · ${state.project.nodes.length} blocks · ${state.project.edges.length} connections · ${conditions} condition${conditions === 1 ? '' : 's'} · ${loops} loop${loops === 1 ? '' : 's'}. Branch and loop execution is planned.`;
    toast('Structure valid. Branch and loop execution is planned.');
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

function selectedCalcNode() {
  if (state.selected.type !== 'node') return null;
  const node = nodeById(state.selected.id);
  return node?.type === 'calc' ? node : null;
}

function gatesForNode(node) {
  const settings = node.settings;
  const job = String(settings.jobType || '');
  const frequency = job.includes('Freq');
  const expectedImaginary = frequency
    ? (Number.isInteger(settings.gates.imaginary) ? settings.gates.imaginary : (job === 'Opt=TS' ? 1 : 0))
    : null;
  return {
    expectedImaginary,
    minMagnitude: settings.gates.minMagnitude ?? 50,
    requireOptimization: job.startsWith('Opt'),
    requireFrequency: frequency,
    requireThermochemistry: Boolean(settings.gates.thermo),
  };
}

function checkpointNameFor(node) {
  return node?.settings?.checkpoint || `${safeBase(node?.id || 'task')}.chk`;
}

function oldCheckpointFor(node) {
  const edge = state.project.edges.find((item) => item.to === node.id && item.type === 'checkpoint');
  if (!edge) return '';
  const source = nodeById(edge.from);
  return source ? checkpointNameFor(source) : '';
}

function buildInputForNode(node) {
  const settings = {
    ...node.settings,
    charge: state.project.molecule.charge,
    multiplicity: state.project.molecule.multiplicity,
  };
  return buildGaussianInput({
    title: node.title,
    settings,
    molecule: {
      charge: state.project.molecule.charge,
      multiplicity: state.project.molecule.multiplicity,
      coords: DEMO_WATER,
    },
    inputName: `${safeBase(node.id)}.gjf`,
    oldCheckpoint: oldCheckpointFor(node),
  });
}

function openRunConsole() {
  const consoleEl = $('#run-console');
  if (!consoleEl) return;
  consoleEl.hidden = false;
  $('#run-state').focus?.();
  if (!desktop) {
    $('#run-hint').textContent = 'Browser preview: the local runner is unavailable. Start the Electron app with "npm run dev" or "npm start".';
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

function appendRunOutput(text) {
  if (!text) return;
  state.run.output = `${state.run.output}${text}`.slice(-60000);
  const el = $('#run-output');
  if (!el) return;
  el.textContent = state.run.output || 'Waiting for output…';
  el.scrollTop = el.scrollHeight;
}

function renderRunGates(gates = []) {
  state.run.gates = gates;
  const el = $('#run-gates');
  if (!el) return;
  el.innerHTML = gates.map((gate) => (
    `<span class="run-gate ${esc(gate.result)}" title="${esc(gate.detail || '')}">${esc(gate.name)} · ${esc(gate.result)}</span>`
  )).join('');
}

function readRunConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('gaussian-studio.run-config') || '{}');
    if (saved.executable) $('#run-exe').value = saved.executable;
    if (saved.scratchDir) $('#run-scratch').value = saved.scratchDir;
    if (typeof saved.dryRun === 'boolean') $('#run-dry').checked = saved.dryRun;
  } catch {
    // A corrupt preference must not block the app.
  }
}

function saveRunConfig() {
  try {
    localStorage.setItem('gaussian-studio.run-config', JSON.stringify({
      executable: $('#run-exe').value.trim(),
      scratchDir: $('#run-scratch').value.trim(),
      dryRun: $('#run-dry').checked,
    }));
  } catch {
    // Preferences are optional.
  }
}

async function pickGaussian() {
  if (!desktop) { toast('Open the Electron app to choose a Gaussian executable.'); return; }
  try {
    const selected = await desktop.pickExecutable();
    if (selected) {
      $('#run-exe').value = selected;
      saveRunConfig();
      toast('Gaussian executable selected.');
    }
  } catch (error) {
    toast(`Could not choose executable: ${error.message}`);
  }
}

async function preflightRun({ quiet = false } = {}) {
  if (!desktop) {
    appendRunOutput('Browser preview: no Electron bridge. Start the desktop app to run preflight.\n');
    return null;
  }
  saveRunConfig();
  const config = {
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
  const lines = result.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
  appendRunOutput(`Preflight · ${result.ok ? 'ready' : 'issues found'}\n${lines.join('\n')}\n\n`);
  if (!quiet) toast(result.ok ? 'Preflight passed.' : 'Preflight found issues; see the run console.');
  return result;
}

async function startSelectedRun() {
  const node = selectedCalcNode();
  if (!node) { toast('Select a calculation block first.'); return; }
  if (!desktop) { toast('Open the desktop app to start a local Gaussian run.'); return; }

  openRunConsole();
  saveRunConfig();
  const dryRun = $('#run-dry').checked;
  const result = await preflightRun({ quiet: true });
  if (!result || (!result.ok && !dryRun)) {
    toast('Preflight is not ready. Fix the run configuration or use dry run.');
    return;
  }

  let inputText;
  try {
    inputText = buildInputForNode(node);
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
  $('#run-output').textContent = 'Starting local runner…\n';
  $('#run-gates').innerHTML = '';
  $('#run-title').textContent = node.title;
  $('#run-path').textContent = '';
  $('#cancel-run')?.removeAttribute('disabled');
  setRunState('running', dryRun ? 'dry run' : 'running');

  try {
    const response = await desktop.runTask({
      title: node.title,
      inputText,
      inputName: `${safeBase(node.id)}.gjf`,
      outputName: outputNameFor(`${safeBase(node.id)}.gjf`),
      executable: $('#run-exe').value.trim(),
      scratchDir: $('#run-scratch').value.trim(),
      dryRun,
      gates: gatesForNode(node),
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
    state.statusMessage = `Running ${event.record?.title || 'local job'} · ${event.record?.dryRun ? 'dry run' : 'Gaussian'}`;
    const statusEl = $('#status-message');
    if (statusEl) statusEl.textContent = state.statusMessage;
  } else if (event.type === 'output') {
    appendRunOutput(event.text);
  } else if (event.type === 'done') {
    const record = event.record;
    setRunState(record.status, record.status);
    renderRunGates(record.gates?.gates || []);
    $('#cancel-run')?.setAttribute('disabled', '');
    const verdict = record.gates?.overall || 'unknown';
    state.statusMessage = `Run ${record.status} · gates ${verdict} · ${record.title || 'local job'}`;
    const statusEl = $('#status-message');
    if (statusEl) statusEl.textContent = state.statusMessage;
    appendRunOutput(`\nRun ${record.status} · gates: ${verdict}${record.error ? `\n${record.error}` : ''}\n`);
    toast(`Run ${record.status}${verdict !== 'unknown' ? ` · ${verdict}` : ''}.`);
  }
}

async function cancelRun() {
  if (!state.run.id || !desktop) return;
  await desktop.cancelRun(state.run.id);
  setRunState('cancelled', 'stopping');
  appendRunOutput('\nCancellation requested…\n');
}

/* ── Workflow queue ───────────────────────────────────────── */

function checkpointSourceFor(node) {
  const edge = state.project.edges.find((item) => item.to === node.id && item.type === 'checkpoint');
  if (!edge) return null;
  const source = nodeById(edge.from);
  if (!source) return null;
  return { nodeId: source.id, checkpoint: checkpointNameFor(source) };
}

function buildWorkflowTasks() {
  const tasks = state.project.nodes.map((node) => {
    if (node.type !== 'calc') {
      return { nodeId: node.id, title: node.title, kind: node.kind || node.type, executable: false };
    }
    const inputName = `${safeBase(node.id)}.gjf`;
    return {
      nodeId: node.id,
      title: node.title,
      kind: node.kind || 'Calc',
      executable: true,
      inputName,
      outputName: outputNameFor(inputName),
      inputText: buildInputForNode(node),
      gates: gatesForNode(node),
      checkpointName: checkpointNameFor(node),
      checkpointFrom: checkpointSourceFor(node),
    };
  });
  if (!tasks.some((task) => task.executable)) throw new Error('The workflow has no calculation blocks to run.');
  return tasks;
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
        const meta = [task.status, task.attempts > 1 ? `×${task.attempts}` : '', task.gateVerdict ? `gates ${task.gateVerdict}` : '']
          .filter(Boolean).join(' · ');
        return `<li class="queue-item is-${esc(task.status)}" title="${esc(task.error || task.reason || '')}"><span class="queue-dot"></span><span class="queue-title">${esc(task.title)}</span><span class="queue-meta">${esc(meta)}</span></li>`;
      }).join('')
      : '<li class="queue-empty">Queue the workflow to run calculation blocks in dependency order, one at a time.</li>';
  }
  const running = queue.status === 'running';
  const canResume = queue.status === 'paused' || queue.status === 'needs-review';
  const active = running || canResume;
  $('#pause-workflow')?.toggleAttribute('disabled', !running);
  $('#resume-workflow')?.toggleAttribute('disabled', !canResume);
  $('#cancel-workflow')?.toggleAttribute('disabled', !active);
}

async function startWorkflow() {
  if (!desktop) { toast('Open the desktop app to queue a workflow.'); return; }
  openRunConsole();
  saveRunConfig();
  const dryRun = $('#run-dry').checked;

  let tasks;
  try {
    tasks = buildWorkflowTasks();
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
      edges: state.project.edges,
      options: {
        dryRun,
        executable: $('#run-exe').value.trim(),
        scratchDir: $('#run-scratch').value.trim(),
      },
    });
    applyQueue(queue);
    toast(`Workflow queued · ${tasks.filter((task) => task.executable).length} block(s).`);
  } catch (error) {
    appendRunOutput(`Queue error: ${error.message}\n`);
    toast(`Could not queue workflow: ${error.message}`);
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

function handleQueueEvent(event) {
  if (!event) return;
  if (event.type === 'queue-output') {
    const task = state.queue.tasks.find((item) => item.nodeId === event.nodeId);
    appendRunOutput(`\n[${task?.title || event.nodeId}]\n${event.text}`);
    return;
  }
  if (!event.queue) return;
  applyQueue(event.queue);
  if (event.type === 'queue-done') {
    appendRunOutput(`\nWorkflow ${event.queue.status}${event.queue.reason ? ` — ${event.queue.reason}` : ''}\n`);
    toast(`Workflow ${event.queue.status}.`);
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
        const meta = [run.status, run.gates?.overall ? `gates ${run.gates.overall}` : '', run.dryRun ? 'dry' : 'Gaussian']
          .filter(Boolean).join(' · ');
        return `<li class="queue-item is-${esc(run.status)}" title="${esc(run.runDir || '')}"><span class="queue-dot"></span><span class="queue-title">${esc(run.title || run.id)}</span><span class="queue-meta">${esc(meta)}</span></li>`;
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

async function openProject() {
  if (!desktop) { toast('Open the Electron app to use native project files.'); return; }
  try {
    const result = await desktop.openProject();
    if (result.canceled) return;
    if (result.error) {
      toast(`Could not open project: ${result.error.message}`);
      return;
    }
    state.project = result.project;
    state.selected = { type: 'project', id: null };
    const name = $('#project-name-text');
    if (name) name.textContent = state.project.name || 'Untitled project';
    const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
    state.statusMessage = result.migrated
      ? `Opened ${result.path} · migrated from v0.1 to schema v${state.project.schemaVersion}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`
      : `Opened ${result.path}`;
    renderGraph();
    renderInspector();
    updateCounts();
    toast(result.migrated ? 'Project opened and migrated to schema v1.' : 'Project opened.');
  } catch (error) {
    toast(`Could not open project: ${error.message}`);
  }
}

async function saveProject() {
  if (!desktop) { toast('Open the Electron app to save a native project file.'); return; }
  try {
    const result = await desktop.saveProject(state.project);
    if (result.canceled) return;
    if (result.error) {
      toast(`Could not save project: ${result.error.message}`);
      return;
    }
    if (result.project) state.project = result.project;
    toast(`Saved ${result.path}`);
  } catch (error) {
    toast(`Could not save project: ${error.message}`);
  }
}

function exportSelectedInput() {
  const node = selectedCalcNode();
  if (!node) { toast('Select a calculation block to export its input.'); return; }
  try {
    const text = buildInputForNode(node);
    const filename = `${safeBase(node.id)}.gjf`;
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
  } catch (error) {
    toast(`Cannot export input: ${error.message}`);
  }
}

/* ── Event wiring ─────────────────────────────────────────── */

function syncModeButtons() {
  $$('[data-inspector-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.inspectorMode === state.inspectorMode);
  });
  const wide = $('.proto-btn[data-action="toggle-wide"]');
  if (wide) {
    wide.textContent = state.inspectorWide ? 'Compact inspector' : 'Wide inspector';
    wide.classList.toggle('is-active', state.inspectorWide);
  }
}

function handleAction(action, element) {
  switch (action) {
    case 'toggle-palette': togglePalette(); break;
    case 'validate': validateGraph(); break;
    case 'zoom-in': setZoom(state.zoom + 0.05); break;
    case 'zoom-out': setZoom(state.zoom - 0.05); break;
    case 'fit': fitGraph(); break;
    case 'close-inspector': state.inspectorHidden = true; renderInspector(); break;
    case 'open-inspector': state.inspectorHidden = false; renderInspector(); break;
    case 'toggle-wide': state.inspectorWide = !state.inspectorWide; renderInspector(); syncModeButtons(); break;
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
    case 'add-fragment':
      if (state.drawer) { state.drawer.draft.fragments.push(''); renderDrawer(); }
      break;
    case 'save-molecule': saveMolecule(); break;
    case 'open-run-console': openRunConsole(); break;
    case 'close-run-console': closeRunConsole(); break;
    case 'pick-gaussian': pickGaussian(); break;
    case 'preflight': preflightRun(); break;
    case 'run-selected': startSelectedRun(); break;
    case 'run-workflow': startWorkflow(); break;
    case 'pause-workflow': pauseWorkflow(); break;
    case 'resume-workflow': resumeWorkflow(); break;
    case 'cancel-workflow': cancelWorkflow(); break;
    case 'refresh-history': refreshHistory(); break;
    case 'cancel-run': cancelRun(); break;
    case 'open-project': openProject(); break;
    case 'save-project': saveProject(); break;
    case 'export': exportSelectedInput(); break;
    case 'import-log': toast('Runner output is parsed automatically. Native log import is the next milestone.'); break;
    case 'view-output': openRunConsole(); break;
    case 'project-menu': toast('Use Open or Save in the top bar for native project files.'); break;
    case 'about': toast('The graph is the workspace. The inspector exposes the full job parameter set; the local runner executes one selected block in this v0.1 slice.'); break;
    default: break;
  }
}

function onDocumentClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) handleAction(actionEl.dataset.action, actionEl);

  const nodeButton = event.target.closest('[data-select-node]');
  if (nodeButton) selectNode(nodeButton.dataset.selectNode);

  const modalButton = event.target.closest('[data-open-modal]');
  if (modalButton) {
    if (modalButton.dataset.openModal === 'molecule') openMoleculeDrawer();
  }

  const modeButton = event.target.closest('[data-inspector-mode]');
  if (modeButton) {
    state.inspectorMode = modeButton.dataset.inspectorMode;
    $('#app').dataset.inspector = state.inspectorMode;
    syncModeButtons();
  }

  const blockButton = event.target.closest('[data-block]');
  if (blockButton) addBlock(blockButton.dataset.block);

  const drawerTab = event.target.closest('[data-drawer-tab]');
  if (drawerTab && state.drawer) {
    state.drawer.tab = drawerTab.dataset.drawerTab;
    renderDrawer();
  }

  if (event.target.closest('[data-modal-close]')) closeDrawer();

  if (state.paletteOpen && !event.target.closest('#palette') && !event.target.closest('[data-action="toggle-palette"]')) {
    togglePalette(false);
  }
}

function onDocumentChange(event) {
  const target = event.target;
  if (target.id === 'run-dry' || target.id === 'run-exe' || target.id === 'run-scratch') {
    saveRunConfig();
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
        if (edge) state.project.edges = state.project.edges.filter((item) => item !== edge);
      } else if (edge) { edge.to = target.value; edge.toPort = 'bottomIn'; }
      else state.project.edges.push({ from: node.id, to: target.value, type: 'loop', fromPort: 'bottom', toPort: 'bottomIn' });
    }
    const loopEdge = state.project.edges.find((item) => item.from === node.id && item.type === 'loop');
    if (loopEdge && key === 'maxAttempts') loopEdge.maxAttempts = node.loop.maxAttempts;
    renderGraph();
    renderInspector();
    return;
  }
  if (target.dataset.branchEdit) {
    if (state.selected.type !== 'node') return;
    const node = nodeById(state.selected.id);
    if (!node || node.type !== 'condition') return;
    const branch = target.dataset.branchEdit;
    let edge = state.project.edges.find((item) => item.from === node.id && item.type === 'branch' && item.branch === branch);
    if (!target.value) {
      if (edge) state.project.edges = state.project.edges.filter((item) => item !== edge);
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
    const key = target.dataset.outputField;
    if (target.type === 'checkbox') node.output[key] = target.checked;
    else node.output[key] = target.value;
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
  }
  if (target.dataset.drawerFragment !== undefined && state.drawer) {
    state.drawer.draft.fragments[Number(target.dataset.drawerFragment)] = target.value;
  }
}

function onDocumentInput(event) {
  const target = event.target;
  if (target.dataset.drawerField && state.drawer) {
    state.drawer.draft[target.dataset.drawerField] = target.value;
  }
  if (target.dataset.drawerFragment !== undefined && state.drawer) {
    state.drawer.draft.fragments[Number(target.dataset.drawerFragment)] = target.value;
  }
}

function wireEvents() {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('change', onDocumentChange);
  document.addEventListener('input', onDocumentInput);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.drawer) { closeDrawer(); return; }
      if (state.paletteOpen) { togglePalette(false); return; }
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
    syncModeButtons();
  });

  nodesEl().addEventListener('keydown', (event) => {
    const node = event.target.closest('.node');
    if (!node) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
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

function init() {
  if (window.innerWidth <= 820) state.inspectorHidden = true;
  readRunConfig();
  if (desktop?.onRunEvent) desktop.onRunEvent(handleRunEvent);
  if (desktop?.onQueueEvent) desktop.onQueueEvent(handleQueueEvent);
  renderPalette();
  renderGraph();
  renderInspector();
  renderQueue();
  restoreQueue();
  refreshHistory();
  setZoom(state.zoom);
  syncModeButtons();
  wireEvents();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
