import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildRunInput,
  buildWorkflowPlan,
  conformerForNode,
} from '../src/shared/workflowTasks.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { runValidityChecks } from '../src/shared/validityChecks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

const roots = [];

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/** A conformer block feeding one optimisation, through a dependency edge. */
function conformerProject({ output = null, settings = {}, edgeType = 'dependency' } = {}) {
  const raw = {
    schemaVersion: 1,
    name: 'Conformer workflow',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' },
      coords,
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [
      {
        id: 'conf', type: 'conformers', title: 'Conformer ensemble', state: 'ready', x: 0, y: 0,
        settings, output,
      },
      {
        id: 'opt', type: 'calc', title: 'Optimise chosen conformer', state: 'ready', x: 200, y: 0,
        settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null,
      },
    ],
    edges: [{ id: 'e1', from: 'conf', to: 'opt', type: edgeType }],
  };
  const validated = validateProject(raw);
  expect(validated.ok).toBe(true);
  return validated.project;
}

const selection = (atoms = coords, overrides = {}) => ({
  generator: 'crest',
  method: 'gfn2',
  count: 2,
  total: 4,
  spreadKcal: 3.4,
  generatedAt: '2026-11-08T00:00:00.000Z',
  selectedId: 'c1',
  requiresSelection: false,
  autoSelected: true,
  protomers: [],
  pruned: { energy: 2, rmsd: 0, count: 0 },
  warnings: [],
  members: [
    { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.94, rmsdToLowest: 0, protomer: '', kept: true, dropped: null },
    { id: 'c2', rank: 2, energyEh: -76.3946, relativeKcal: 3.4, population: 0.06, rmsdToLowest: 1.1, protomer: '', kept: true, dropped: null },
  ],
  selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 0.94, protomer: '', atoms },
  ...overrides,
});

describe('conformer workflow wiring', () => {
  it('turns a conformer block into one executable CREST task', () => {
    const project = conformerProject({ output: selection() });
    const plan = buildWorkflowPlan(project);
    const task = plan.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.type).toBe('conformers');
    expect(task.executable).toBe(true);
    expect(task.engine).toBeNull();
    expect(task.inputName).toBe('conf.xyz');
    expect(task.inputText.split('\n')[0]).toBe('3');
    expect(task.conformers.argv).toEqual(['conf.xyz', '--gfn2', '--nci']);
    expect(task.conformers.maxConformers).toBe(20);
  });

  it('emits --uhf as 2S, not as the multiplicity', () => {
    const project = conformerProject({ settings: { multiplicity: 3, charge: -1 }, output: selection() });
    const plan = buildWorkflowPlan(project);
    const task = plan.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.conformers.argv).toContain('--uhf');
    expect(task.conformers.argv[task.conformers.argv.indexOf('--uhf') + 1]).toBe('2');
    expect(task.conformers.argv[task.conformers.argv.indexOf('--chrg') + 1]).toBe('-1');
  });

  it('builds the downstream input from the selected conformer, not the imported geometry', () => {
    const chosen = coords.map((atom, index) => (index === 0 ? { ...atom, x: 0.25 } : atom));
    const project = conformerProject({ output: selection(chosen) });
    const calc = project.nodes.find((node) => node.id === 'opt');
    const built = buildRunInput(project, calc);
    expect(built.inputText).toMatch(/O\s+0\.250000/);
    expect(built.conformer.id).toBe('c1');
    expect(built.conformer.spreadKcal).toBeCloseTo(3.4, 6);
  });

  it('builds the downstream input from a non-lowest member when that is the choice', () => {
    const chosen = coords.map((atom, index) => (index === 1 ? { ...atom, x: 1.9 } : atom));
    const project = conformerProject({
      output: selection(coords, {
        selectedId: 'c2',
        autoSelected: false,
        selected: { id: 'c2', energyEh: -76.3946, relativeKcal: 3.4, population: 0.06, protomer: '', atoms: chosen },
      }),
    });
    const calc = project.nodes.find((node) => node.id === 'opt');
    const built = buildRunInput(project, calc);
    expect(built.inputText).toMatch(/H\s+1\.900000/);
    expect(built.conformer.id).toBe('c2');
    expect(built.conformer.relativeKcal).toBeCloseTo(3.4, 6);
  });

  it('refuses to build a downstream input when no conformer is chosen', () => {
    const project = conformerProject({ output: selection(coords, { selected: null, requiresSelection: true, selectedId: '' }) });
    const calc = project.nodes.find((node) => node.id === 'opt');
    expect(() => buildRunInput(project, calc)).toThrow(/no selected conformer/i);
  });

  it('reports the ensemble in the downstream validity context', () => {
    const project = conformerProject({ output: selection() });
    const calc = project.nodes.find((node) => node.id === 'opt');
    const context = {
      settings: { jobType: 'Opt', method: 'B3LYP', basis: '6-31G(d)' },
      molecule: { charge: 0, multiplicity: 1, coords },
      parsed: null,
      conformer: {
        nodeId: 'conf', title: 'Conformer ensemble', memberId: 'c1',
        relativeKcal: 0, population: 0.94, protomer: '',
        spreadKcal: 3.4, thresholdKcal: 2, requiresSelection: false,
      },
    };
    const result = runValidityChecks(context, { phase: 'pre', engine: 'gaussian' });
    const finding = result.findings.find((entry) => entry.id === 'conformer-spread');
    expect(finding.status).toBe('warning');
    expect(finding.message).toMatch(/3\.40 kcal\/mol/);
  });

  it('does not treat a conformer edge as a checkpoint hand-off', () => {
    const project = conformerProject({ output: selection() });
    const calc = project.nodes.find((node) => node.id === 'opt');
    expect(conformerForNode(project, calc)?.selected.id).toBe('c1');
    expect(buildRunInput(project, calc).inputText).not.toContain('%OldChk');
  });
});

describe('conformer queue path', () => {
  afterEach(async () => {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function stack() {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-conformers-'));
    roots.push(base);
    const runsRoot = path.join(base, 'runs');
    const queuesRoot = path.join(base, 'queues');
    await fsp.mkdir(runsRoot, { recursive: true });
    const events = [];
    const runManager = new RunManager({
      runsRoot,
      emit: (event) => events.push(event),
      createRunner: () => ({
        cancel() {},
        async run({ outputName, cwd, onOutput }) {
          const outputPath = path.join(cwd, outputName);
          const text = 'Normal termination of Gaussian 16\n';
          await fsp.writeFile(outputPath, text, 'utf8');
          onOutput({ text });
          return { exitCode: 0, signal: null, cancelled: false, outputPath, outputText: text };
        },
      }),
    });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: (event) => events.push(event) });
    await queueManager.init();
    return { base, runsRoot, queueManager, events };
  }

  async function waitFor(check, timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out');
  }

  it('runs a labelled dry-run ensemble and records the conformer in run.json', async () => {
    const project = conformerProject({ output: selection() });
    const plan = buildWorkflowPlan(project);
    const { queueManager, runsRoot } = await stack();
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: true, executable: null, crestExecutable: null, scratchDir: '' },
    });
    expect(started.status).toBe('running');

    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    expect(done.status).toBe('completed');

    const conformers = done.tasks.find((task) => task.nodeId === 'conf');
    expect(conformers.status).toBe('completed');
    expect(conformers.ensemble.generator).toBe('fixture');
    expect(conformers.ensemble.count).toBeGreaterThan(1);
    expect(conformers.ensemble.spreadKcal).toBeGreaterThan(0);
    expect(conformers.ensemble.selected.atoms).toHaveLength(3);
    // Every kept member carries its geometry, so the table can be re-chosen
    // later without the queue folder.
    const second = conformers.ensemble.members.find((member) => member.kept && member.id !== conformers.ensemble.selectedId);
    expect(second.atoms).toHaveLength(3);
    expect(second.atoms[1].x).toBeGreaterThan(0.96);

    const calc = done.tasks.find((task) => task.nodeId === 'opt');
    expect(calc.status).toBe('completed');
    const record = JSON.parse(await fsp.readFile(path.join(runsRoot, calc.runId, 'run.json'), 'utf8'));
    expect(record.conformer).toMatchObject({ nodeId: 'conf', id: 'c1' });
    expect(record.conformer.spreadKcal).toBeCloseTo(3.4, 6);
  });

  it('fails the block with a clear reason when CREST is not configured', async () => {
    const project = conformerProject({ output: selection() });
    const plan = buildWorkflowPlan(project);
    const { queueManager } = await stack();
    await expect(queueManager.start({
      projectName: project.name,
      tasks: plan.tasks.filter((task) => task.type === 'conformers'),
      edges: [],
      options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
    })).rejects.toThrow(/CREST executable/i);
  });
});
