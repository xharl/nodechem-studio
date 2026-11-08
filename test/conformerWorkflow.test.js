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
    { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.94, rmsdToLowest: 0, protomer: '', kept: true, dropped: null, atoms },
    { id: 'c2', rank: 2, energyEh: -76.3946, relativeKcal: 3.4, population: 0.06, rmsdToLowest: 1.1, protomer: '', kept: true, dropped: null, atoms: coords.map((atom, index) => (index === 1 ? { ...atom, x: 1.9 } : atom)) },
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

describe('conformer fan-out (#80)', () => {
  const fanOutProject = (output = selection(), settings = { fanOut: true }) => conformerProject({ output, settings });

  it('expands the block and its calculation into one task per retained member', () => {
    const plan = buildWorkflowPlan(fanOutProject());
    expect(plan.tasks.map((task) => task.nodeId)).toEqual(['conf~c1', 'conf~c2', 'opt~c1', 'opt~c2']);
    expect(plan.tasks.every((task) => task.executable)).toBe(true);
    expect(plan.edges.map((edge) => [edge.from, edge.to, edge.type])).toEqual([
      ['conf~c1', 'opt~c1', 'dependency'],
      ['conf~c2', 'opt~c2', 'dependency'],
    ]);
  });

  it('builds each fanned-out calculation from that member’s geometry', () => {
    const plan = buildWorkflowPlan(fanOutProject());
    const opt1 = plan.tasks.find((task) => task.nodeId === 'opt~c1');
    const opt2 = plan.tasks.find((task) => task.nodeId === 'opt~c2');
    expect(opt1.inputText).toMatch(/H\s+0\.960000/);
    expect(opt2.inputText).toMatch(/H\s+1\.900000/);
    expect(opt1.conformer).toMatchObject({ nodeId: 'conf', id: 'c1' });
    expect(opt2.conformer).toMatchObject({ nodeId: 'conf', id: 'c2' });
    expect(opt2.conformer.relativeKcal).toBeCloseTo(3.4, 6);
    expect(opt2.validity.conformer.memberId).toBe('c2');
    expect(opt1.validity.conformer.memberId).toBe('c1');
    const conf2 = plan.tasks.find((task) => task.nodeId === 'conf~c2');
    expect(conf2.type).toBe('conformers');
    expect(conf2.conformers.argv).toEqual([]);
    expect(conf2.conformers.member).toMatchObject({ id: 'c2', parentId: 'conf', relativeKcal: 3.4 });
    expect(conf2.inputText.split('\n')[0]).toBe('3');
    expect(conf2.inputText).toMatch(/H\s+1\.900000/);
  });

  it('refuses to fan out a multi-protomer ensemble with nothing selected', () => {
    const output = selection(coords, {
      requiresSelection: true,
      selectedId: '',
      selected: null,
      protomers: ['A', 'B'],
      members: [
        { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.5, rmsdToLowest: 0, protomer: 'A', kept: true, dropped: null, atoms: coords },
        { id: 'c2', rank: 2, energyEh: -76.3946, relativeKcal: 3.4, population: 0.5, rmsdToLowest: 1.1, protomer: 'B', kept: true, dropped: null, atoms: coords },
      ],
    });
    expect(() => buildWorkflowPlan(fanOutProject(output))).toThrow(/protomer/i);
  });

  it('pairs a checkpoint hand-off member to member', () => {
    const base = conformerProject({ settings: { fanOut: true }, output: selection() });
    const validated = validateProject({
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: 'freq', type: 'calc', title: 'Frequency', state: 'ready', x: 400, y: 0,
          settings: defaultSettings({ jobType: 'Freq' }), output: null, checkpointFrom: 'opt',
        },
      ],
      edges: [
        ...base.edges,
        { id: 'e2', from: 'conf', to: 'freq', type: 'dependency' },
        { id: 'e3', from: 'opt', to: 'freq', type: 'checkpoint' },
      ],
    });
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const freq2 = plan.tasks.find((task) => task.nodeId === 'freq~c2');
    expect(freq2.checkpointFrom).toMatchObject({ nodeId: 'opt~c2', checkpoint: 'opt_c2.chk', fanOutMember: 'c2' });
    expect(plan.edges.filter((edge) => edge.type === 'checkpoint').map((edge) => [edge.from, edge.to])).toEqual([
      ['opt~c1', 'freq~c1'],
      ['opt~c2', 'freq~c2'],
    ]);
  });

  it('keeps today’s single-member plan byte-identical when fan-out is off or absent', () => {
    const off = buildWorkflowPlan(conformerProject({ settings: { fanOut: false }, output: selection() }));
    const absent = buildWorkflowPlan(conformerProject({ settings: {}, output: selection() }));
    expect(JSON.stringify(off)).toBe(JSON.stringify(absent));
    expect(off.tasks.map((task) => task.nodeId)).toEqual(['conf', 'opt']);
    expect(off.tasks.find((task) => task.nodeId === 'opt').conformer).toMatchObject({ id: 'c1' });
    expect(off.tasks.find((task) => task.nodeId === 'opt').inputText).not.toMatch(/H\s+1\.900000/);
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

  it('runs one branch per fanned-out member and records the member on each run', async () => {
    const project = conformerProject({ settings: { fanOut: true }, output: selection() });
    const plan = buildWorkflowPlan(project);
    const { queueManager, runsRoot } = await stack();
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
    expect(done.status).toBe('completed');
    const conformers = done.tasks.filter((task) => task.type === 'conformers');
    expect(conformers.map((task) => task.nodeId).sort()).toEqual(['conf~c1', 'conf~c2']);
    for (const task of conformers) {
      expect(task.status).toBe('completed');
      expect(task.ensemble.count).toBe(1);
      expect(task.ensemble.selectedId).toBe(task.conformers.member.id);
      // Each member has its own folder with its own geometry.
      const memberText = await fsp.readFile(path.join(task.runDir, 'member.xyz'), 'utf8');
      expect(memberText.split('\n')[0]).toBe('3');
      expect(memberText).toMatch(task.conformers.member.id === 'c2' ? /H\s+1\.900000/ : /H\s+0\.960000/);
    }

    const calcs = done.tasks.filter((task) => task.type === 'calc');
    expect(calcs).toHaveLength(2);
    const members = [];
    for (const task of calcs) {
      const record = JSON.parse(await fsp.readFile(path.join(runsRoot, task.runId, 'run.json'), 'utf8'));
      expect(record.conformer.nodeId).toBe('conf');
      expect(record.conformer.id).toBe(task.conformer.id);
      members.push(record.conformer.id);
    }
    expect(members.sort()).toEqual(['c1', 'c2']);
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
