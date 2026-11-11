import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rmrf } from './helpers/tempCleanup.js';
import {
  buildWorkflowPlan,
  conformerSearchTask,
} from '../src/shared/workflowTasks.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

const roots = [];

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/** A conformer block feeding one optimisation, through a dependency edge. */
function conformerProject({ output = null, settings = {} } = {}) {
  const raw = {
    schemaVersion: 3,
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
        id: 'conf', type: 'generate', title: 'Conformer ensemble', state: 'ready', x: 0, y: 0,
        settings, output,
      },
      {
        id: 'opt', type: 'calculate', title: 'Optimise chosen conformer', state: 'ready', x: 200, y: 0,
        settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null,
      },
    ],
    edges: [{ id: 'e1', from: 'conf', to: 'opt', type: 'dependency' }],
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
    { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.94, rmsdToLowest: 0, protomer: '', kept: true, dropped: null, atoms },
    {
      id: 'c2', rank: 2, energyEh: -76.3946, relativeKcal: 3.4, population: 0.06, rmsdToLowest: 1.1,
      protomer: '', kept: true, dropped: null,
      atoms: coords.map((atom, index) => (index === 1 ? { ...atom, x: 1.96 } : atom)),
    },
  ],
  selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 0.94, protomer: '', atoms },
  ...overrides,
});

describe('pending conformer calculation (#101)', () => {
  it('plans a fresh ensemble search and leaves the downstream calculation pending', () => {
    const project = conformerProject();
    const plan = buildWorkflowPlan(project);

    expect(plan.tasks.map((task) => task.nodeId)).toEqual(['conf', 'opt']);
    const search = plan.tasks.find((task) => task.nodeId === 'conf');
    const calc = plan.tasks.find((task) => task.nodeId === 'opt');

    // The task that creates the ensemble is runnable; the whole plan is queueable.
    expect(search.type).toBe('generate');
    expect(search.executable).toBe(true);
    expect(search.inputText.split('\n')[0]).toBe('3');
    expect(search.generate.argv).toEqual(['conf.xyz', '--gfn2', '--nci']);

    // The calculation is deferred, not built from the project geometry.
    expect(calc.type).toBe('calculate');
    expect(calc.executable).toBe(false);
    expect(calc.inputText).toBe('');
    expect(calc.argv).toBeNull();
    expect(calc.conformer).toBeUndefined();
    expect(calc.pendingInput).toMatchObject({
      conformerId: 'conf',
      conformerTitle: 'Conformer ensemble',
    });
    expect(calc.pendingInput.reason).toMatch(/"Conformer ensemble" has no selected conformer/);
    expect(calc.pendingInput.reason).toMatch(/"Optimise chosen conformer"/);

    // The ordering edge survives, so the calculation still waits for the search.
    expect(plan.edges).toEqual([{ from: 'conf', to: 'opt', type: 'dependency' }]);
  });

  it('still refuses at plan time when the ensemble exists without a selection', () => {
    const noSelection = conformerProject({
      output: selection(coords, { selected: null, selectedId: '', requiresSelection: true }),
    });
    expect(() => buildWorkflowPlan(noSelection)).toThrow(/no selected conformer/i);

    const noAutomaticChoice = conformerProject({
      output: selection(coords, { selected: null, selectedId: '', autoSelected: false, requiresSelection: false }),
    });
    expect(() => buildWorkflowPlan(noAutomaticChoice)).toThrow(/no selected conformer/i);
  });

  it('builds the pending block on the next plan once the ensemble and member are stored', () => {
    const project = conformerProject();
    // What the renderer writes back after the search: the ensemble, then a
    // deliberate choice of the non-lowest member (c2).
    project.nodes.find((node) => node.id === 'conf').output = selection();
    const chosen = selection().members.find((member) => member.id === 'c2');
    project.nodes.find((node) => node.id === 'conf').output.selectedId = 'c2';
    project.nodes.find((node) => node.id === 'conf').output.selected = {
      id: chosen.id,
      energyEh: chosen.energyEh,
      relativeKcal: chosen.relativeKcal,
      population: chosen.population,
      protomer: chosen.protomer,
      atoms: chosen.atoms,
    };

    const plan = buildWorkflowPlan(project);
    const calc = plan.tasks.find((task) => task.nodeId === 'opt');
    expect(calc.executable).toBe(true);
    expect(calc.pendingInput).toBeUndefined();
    // Built from the chosen member, not from the project geometry.
    expect(calc.inputText).toMatch(/H\s+1\.960000/);
    expect(calc.conformer).toMatchObject({ nodeId: 'conf', id: 'c2' });
  });

  it('keeps the fan-out-off plan unchanged when a selection exists', () => {
    const off = buildWorkflowPlan(conformerProject({ output: selection(), settings: { fanOut: false } }));
    const absent = buildWorkflowPlan(conformerProject({ output: selection(), settings: {} }));
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent));
    expect(off.tasks.find((task) => task.nodeId === 'opt').executable).toBe(true);
  });
});

describe('conformer search task for Run selected block (#101)', () => {
  it('always builds the search, even when the block is fanned out and has an ensemble', () => {
    const project = conformerProject({ output: selection(), settings: { fanOut: true } });
    const node = project.nodes.find((entry) => entry.id === 'conf');
    const task = conformerSearchTask(project, node);

    expect(task.nodeId).toBe('conf');
    expect(task.type).toBe('generate');
    expect(task.executable).toBe(true);
    expect(task.generate.member).toBeUndefined();
    expect(task.generate.argv).toEqual(['conf.xyz', '--gfn2', '--nci']);
    // A search starts from the project geometry; fan-out member tasks carry the
    // ensemble instead.
    expect(task.inputText).toContain('charge 0');
  });

  it('builds the search for a block that has never run', () => {
    const project = conformerProject();
    const task = conformerSearchTask(project, project.nodes.find((entry) => entry.id === 'conf'));
    expect(task.executable).toBe(true);
    expect(task.inputText.split('\n')[0]).toBe('3');
    expect(task.inputText).toMatch(/O\s+0\.000000/);
  });
});

describe('queue path for a pending conformer calculation (#101)', () => {
  afterEach(async () => {
    await Promise.all(roots.map((root) => rmrf(root)));
    roots.length = 0;
  });

  async function stack() {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-pending-'));
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

  async function waitFor(check, timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out');
  }

  it('runs the search, fails the pending calculation with the readable reason, and runs no engine on it', async () => {
    const project = conformerProject();
    const plan = buildWorkflowPlan(project);
    const { runsRoot, queueManager } = await stack();
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: true, executable: null, crestExecutable: null, scratchDir: '' },
    });

    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });

    const search = done.tasks.find((task) => task.nodeId === 'conf');
    expect(search.status).toBe('completed');
    expect(search.ensemble.count).toBeGreaterThan(1);

    const calc = done.tasks.find((task) => task.nodeId === 'opt');
    expect(calc.status).toBe('failed');
    expect(calc.error).toMatch(/"Conformer ensemble" has no selected conformer/);
    expect(calc.error).toMatch(/"Optimise chosen conformer"/);
    // It never ran: no run folder, no input written, no geometry substitution.
    expect(calc.runId).toBeNull();
    expect(calc.runDir).toBeNull();
    const runs = await fsp.readdir(runsRoot);
    expect(runs).toHaveLength(0);
    expect(done.status).toBe('failed');

    // The search still stored an ensemble the renderer can copy into the block.
    expect(search.ensemble.selectedId).toBe('c1');
  });

  it('fails a lone pending calculation when the queue reaches it with no ensemble', async () => {
    const project = conformerProject();
    const plan = buildWorkflowPlan(project);
    const pending = plan.tasks.find((task) => task.nodeId === 'opt');
    const { queueManager } = await stack();
    const started = await queueManager.start({
      projectName: project.name,
      tasks: [pending],
      edges: [],
      options: { dryRun: true, executable: null, crestExecutable: null, scratchDir: '' },
    });

    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    expect(done.tasks[0].status).toBe('failed');
    expect(done.tasks[0].error).toMatch(/no selected conformer/i);
    expect(done.tasks[0].inputText).toBeUndefined();
  });
});
