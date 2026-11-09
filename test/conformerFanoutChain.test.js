import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

/**
 * Issue #87: conformer fan-out has to survive a chain, not just one hop.
 *
 * `conformers -> opt -> freq` must run once per retained member: each
 * optimisation starts from its own member geometry, and each frequency reads
 * that member's own checkpoint when the hand-off is a checkpoint edge. The
 * tests below pin the task ids, the per-member input text and the pairing,
 * because getting any of them wrong silently runs one member's branch twice.
 */

const roots = [];

const projectCoords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/** A water geometry with one visibly different H position per member. */
const memberCoords = (x) => [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const C1_X = 1.11;
const C2_X = 1.9;

const ensemble = (overrides = {}) => ({
  generator: 'crest',
  method: 'gfn2',
  count: 2,
  total: 2,
  spreadKcal: 3.4,
  generatedAt: '2026-11-08T00:00:00.000Z',
  selectedId: 'c1',
  requiresSelection: false,
  autoSelected: true,
  protomers: [],
  pruned: { energy: 0, rmsd: 0, count: 0 },
  warnings: [],
  members: [
    { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.94, rmsdToLowest: 0, protomer: '', kept: true, dropped: null, atoms: memberCoords(C1_X) },
    { id: 'c2', rank: 2, energyEh: -76.3946, relativeKcal: 3.4, population: 0.06, rmsdToLowest: 1.1, protomer: '', kept: true, dropped: null, atoms: memberCoords(C2_X) },
  ],
  selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 0.94, protomer: '', atoms: memberCoords(C1_X) },
  ...overrides,
});

const calc = (id, title, jobType, extra = {}) => ({
  id,
  type: 'calculate',
  kind: 'Opt',
  title,
  state: 'ready',
  x: 0,
  y: 0,
  settings: defaultSettings({ jobType, ...extra }),
  output: null,
  checkpointFrom: null,
});

const conformers = (id, title, { fanOut = true, output = ensemble() } = {}) => ({
  id,
  type: 'generate',
  kind: 'Conformers',
  title,
  state: 'ready',
  x: 0,
  y: 0,
  settings: fanOut ? { fanOut: true } : {},
  output,
});

const dataset = (records) => ({
  id: 'family',
  title: 'Family',
  source: { kind: 'inline', path: '', format: 'sdf' },
  fields: { label: '', charge: '', multiplicity: '' },
  records,
  notes: '',
});

function project({ nodes, edges, datasets = [], activeFlowId = 'main' }) {
  const result = validateProject({
    schemaVersion: 3,
    name: 'Fan-out chain fixture',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords: projectCoords,
      geometry: { source: 'demo', file: '', format: '' },
    },
    defaults: { method: 'B3LYP', basis: 'def-2SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets,
    flows: [{ id: 'main', title: 'Main', nodes, edges }],
    reports: [],
    activeFlowId,
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

describe('conformer fan-out through a chain (#87)', () => {
  it('expands conf -> opt -> freq over dependency edges, one task per member', () => {
    const p = project({
      nodes: [conformers('conf', 'Ensemble'), calc('opt', 'Optimise', 'Opt'), calc('freq', 'Frequency', 'Freq')],
      edges: [
        { from: 'conf', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'dependency' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    expect(plan.tasks.map((task) => task.nodeId)).toEqual([
      'conf~c1', 'conf~c2', 'opt~c1', 'opt~c2', 'freq~c1', 'freq~c2',
    ]);
    expect(plan.edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`)).toEqual([
      'conf~c1->opt~c1:dependency',
      'conf~c2->opt~c2:dependency',
      'opt~c1->freq~c1:dependency',
      'opt~c2->freq~c2:dependency',
    ]);

    const opt1 = plan.tasks.find((task) => task.nodeId === 'opt~c1');
    const opt2 = plan.tasks.find((task) => task.nodeId === 'opt~c2');
    const freq1 = plan.tasks.find((task) => task.nodeId === 'freq~c1');
    const freq2 = plan.tasks.find((task) => task.nodeId === 'freq~c2');

    // Each stage builds from its own member's geometry, never the project's.
    expect(opt1.inputText).toMatch(/H\s+1\.110000/);
    expect(opt2.inputText).toMatch(/H\s+1\.900000/);
    expect(freq1.inputText).toMatch(/H\s+1\.110000/);
    expect(freq2.inputText).toMatch(/H\s+1\.900000/);
    expect(freq1.inputText).not.toBe(freq2.inputText);
    expect(freq1.conformer).toMatchObject({ nodeId: 'conf', id: 'c1' });
    expect(freq2.conformer).toMatchObject({ nodeId: 'conf', id: 'c2' });
    expect(freq1.fanOut).toMatchObject({ conformerId: 'conf', memberId: 'c1', count: 2 });
    expect(freq2.fanOut).toMatchObject({ conformerId: 'conf', memberId: 'c2', count: 2 });
    expect(freq1.inputText).not.toContain('%OldChk');
  });

  it('pairs a checkpoint hand-off member to member through the chain', () => {
    const p = project({
      nodes: [
        conformers('conf', 'Ensemble'),
        calc('opt', 'Optimise', 'Opt'),
        { ...calc('freq', 'Frequency', 'Freq'), checkpointFrom: 'opt' },
      ],
      edges: [
        { from: 'conf', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'checkpoint' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    expect(plan.tasks.map((task) => task.nodeId)).toEqual([
      'conf~c1', 'conf~c2', 'opt~c1', 'opt~c2', 'freq~c1', 'freq~c2',
    ]);
    expect(plan.edges.filter((edge) => edge.type === 'checkpoint').map((edge) => `${edge.from}->${edge.to}`))
      .toEqual(['opt~c1->freq~c1', 'opt~c2->freq~c2']);

    const freq1 = plan.tasks.find((task) => task.nodeId === 'freq~c1');
    const freq2 = plan.tasks.find((task) => task.nodeId === 'freq~c2');
    expect(freq1.checkpointFrom).toMatchObject({ nodeId: 'opt~c1', checkpoint: 'opt_c1.chk', fanOutMember: 'c1' });
    expect(freq2.checkpointFrom).toMatchObject({ nodeId: 'opt~c2', checkpoint: 'opt_c2.chk', fanOutMember: 'c2' });
    // The input must name the checkpoint the queue will actually stage; a
    // shared `opt.chk` here is the one-hop hand-off bug this issue fixes.
    expect(freq1.inputText).toContain('%OldChk=opt_c1.chk');
    expect(freq2.inputText).toContain('%OldChk=opt_c2.chk');
    expect(freq1.inputText).not.toBe(freq2.inputText);
    // A geometry read from the checkpoint must not also carry member c2's
    // pre-optimisation coordinates.
    expect(freq1.inputText).not.toMatch(/H\s+1\.900000/);
  });

  it('keeps the record segment in the task id and checkpoint name', () => {
    const record = {
      id: 'm1', label: 'one', charge: 0, multiplicity: 1, coords: projectCoords, enabled: true,
    };
    const p = project({
      datasets: [dataset([record])],
      nodes: [
        { id: 'in1', type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0,
          input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
        conformers('conf', 'Ensemble'),
        calc('opt', 'Optimise', 'Opt'),
        { ...calc('freq', 'Frequency', 'Freq'), checkpointFrom: 'opt' },
      ],
      edges: [
        { from: 'in1', to: 'conf', type: 'dependency' },
        { from: 'conf', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'checkpoint' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    const ids = plan.tasks.filter((task) => task.type !== 'input').map((task) => task.nodeId);
    expect(ids).toEqual([
      'conf~m1~c1', 'conf~m1~c2', 'opt~m1~c1', 'opt~m1~c2', 'freq~m1~c1', 'freq~m1~c2',
    ]);
    const freq2 = plan.tasks.find((task) => task.nodeId === 'freq~m1~c2');
    expect(freq2.recordId).toBe('m1');
    expect(freq2.checkpointFrom).toMatchObject({ nodeId: 'opt~m1~c2', checkpoint: 'opt_m1_c2.chk' });
    expect(freq2.inputText).toContain('%OldChk=opt_m1_c2.chk');
    const opt1 = plan.tasks.find((task) => task.nodeId === 'opt~m1~c1');
    expect(opt1.inputText).toMatch(/H\s+1\.110000/);
  });

  it('refuses two different conformer ensembles feeding one calculation', () => {
    const p = project({
      nodes: [
        conformers('confA', 'Ensemble A'),
        conformers('confB', 'Ensemble B'),
        calc('opt', 'Optimise', 'Opt'),
      ],
      edges: [
        { from: 'confA', to: 'opt', type: 'dependency' },
        { from: 'confB', to: 'opt', type: 'dependency' },
      ],
    });
    expect(() => buildWorkflowPlan(p)).toThrow(/two conformer ensembles/i);
    expect(() => buildWorkflowPlan(p)).toThrow(/Ensemble A/);
    expect(() => buildWorkflowPlan(p)).toThrow(/Ensemble B/);
  });

  it('refuses a fanned branch mixed with an unfanned one, naming both', () => {
    const p = project({
      nodes: [
        conformers('confA', 'Ensemble A', { fanOut: true }),
        conformers('confB', 'Static choice', { fanOut: false, output: ensemble() }),
        calc('opt', 'Optimise', 'Opt'),
      ],
      edges: [
        { from: 'confA', to: 'opt', type: 'dependency' },
        { from: 'confB', to: 'opt', type: 'dependency' },
      ],
    });
    expect(() => buildWorkflowPlan(p)).toThrow(/fanned-out branch from "Ensemble A"/i);
    expect(() => buildWorkflowPlan(p)).toThrow(/Static choice/);
  });

  it('names records and conformer members when the plan cap is hit', () => {
    const records = Array.from({ length: 60 }, (_, index) => ({
      id: `r${index}`, label: `r${index}`, charge: 0, multiplicity: 1, coords: projectCoords, enabled: true,
    }));
    const calcs = Array.from({ length: 42 }, (_, index) => calc(`c${index}`, `Block ${index}`, 'SP'));
    const nodes = [
      { id: 'in1', type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0,
        input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
      conformers('conf', 'Ensemble'),
      ...calcs,
    ];
    const edges = [{ from: 'in1', to: 'conf', type: 'dependency' }];
    let previous = 'conf';
    for (const node of calcs) {
      edges.push({ from: previous, to: node.id, type: 'dependency' });
      previous = node.id;
    }
    const p = project({ nodes, edges, datasets: [dataset(records)] });
    expect(() => buildWorkflowPlan(p)).toThrow(/expands to 5161 tasks/i);
    expect(() => buildWorkflowPlan(p)).toThrow(/60 records × 2 conformer members/);
  });

  it('keeps bare ids when fan-out is off', () => {
    const p = project({
      nodes: [
        conformers('conf', 'Ensemble', { fanOut: false }),
        calc('opt', 'Optimise', 'Opt'),
        calc('freq', 'Frequency', 'Freq'),
      ],
      edges: [
        { from: 'conf', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'dependency' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    expect(plan.tasks.map((task) => task.nodeId)).toEqual(['conf', 'opt', 'freq']);
  });
});

describe('queue hand-off for a fanned-out chain (#87)', () => {
  afterEach(async () => {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function stack() {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-fanout-chain-'));
    roots.push(base);
    const runsRoot = path.join(base, 'runs');
    const queuesRoot = path.join(base, 'queues');
    await fsp.mkdir(runsRoot, { recursive: true });
    const runManager = new RunManager({
      runsRoot,
      emit: () => {},
      createRunner: () => ({
        cancel() {},
        async run({ outputName, cwd }) {
          const outputPath = path.join(cwd, outputName);
          const text = 'Normal termination of Gaussian 16\n';
          await fsp.writeFile(outputPath, text, 'utf8');
          return { exitCode: 0, signal: null, cancelled: false, outputPath, outputText: text };
        },
      }),
    });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await queueManager.init();
    return { runsRoot, queueManager };
  }

  async function waitFor(check, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out');
  }

  it('stages each member checkpoint under its own name', async () => {
    const p = project({
      nodes: [
        conformers('conf', 'Ensemble'),
        calc('opt', 'Optimise', 'Opt'),
        { ...calc('freq', 'Frequency', 'Freq'), checkpointFrom: 'opt' },
      ],
      edges: [
        { from: 'conf', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'checkpoint' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    const { runsRoot, queueManager } = await stack();
    const started = await queueManager.start({
      projectName: p.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: true, executable: null, crestExecutable: null, scratchDir: '' },
    });

    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    expect(done.status).toBe('completed');
    const freq1 = done.tasks.find((task) => task.nodeId === 'freq~c1');
    const freq2 = done.tasks.find((task) => task.nodeId === 'freq~c2');
    expect(freq1.status).toBe('completed');
    expect(freq2.status).toBe('completed');
    const record1 = JSON.parse(await fsp.readFile(path.join(runsRoot, freq1.runId, 'run.json'), 'utf8'));
    const record2 = JSON.parse(await fsp.readFile(path.join(runsRoot, freq2.runId, 'run.json'), 'utf8'));
    expect(record1.checkpointHandoff).toMatchObject({ file: 'opt_c1.chk' });
    expect(record2.checkpointHandoff).toMatchObject({ file: 'opt_c2.chk' });
    // The staged file is beside the input that names it.
    await fsp.access(path.join(runsRoot, freq1.runId, 'opt_c1.chk'));
    await fsp.access(path.join(runsRoot, freq2.runId, 'opt_c2.chk'));
  });
});
