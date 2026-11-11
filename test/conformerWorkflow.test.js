import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rmrf } from './helpers/tempCleanup.js';
import {
  buildRunInput,
  buildWorkflowPlan,
  conformerForNode,
} from '../src/shared/workflowTasks.js';
import { parseMultiXyz, rankEnsemble, withEnergies } from '../src/shared/conformers.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { runValidityChecks } from '../src/shared/validityChecks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { CrestRunner } from '../electron/runner/crestRunner.js';

const roots = [];
const onWindows = process.platform === 'win32';

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/**
 * A stand-in for CREST 3 (#100). It refuses to run unless argv names a file it
 * can read from its own working directory, then writes the ensemble and the
 * energies a search produces. The assertion is the point: a suite that only
 * dry-runs never checks that CREST can open the file it was given.
 */
const FAKE_CREST = [
  '#!/bin/sh',
  'set -eu',
  'if [ ! -f "$1" ]; then',
  '  echo "fake crest: no input file at $PWD/$1" >&2',
  '  exit 64',
  'fi',
  'echo "fake crest: read $1 from $PWD ($(sed -n 1p "$1") atoms)"',
  "cat > crest_conformers.xyz <<'EOF'",
  '3',
  'conformer 1',
  'O 0.000000 0.000000 0.000000',
  'H 0.960000 0.000000 0.000000',
  'H -0.240000 0.930000 0.000000',
  '3',
  'conformer 2',
  'O 0.000000 0.000000 0.000000',
  'H 0.960000 0.000000 1.200000',
  'H -0.240000 0.930000 1.200000',
  'EOF',
  "cat > crest.energies <<'EOF'",
  '1 -76.40000000',
  '2 -76.39500000',
  'EOF',
].join('\n');

/**
 * Multi-XYZ text for water frames; one comment per frame. The second frame is
 * displaced so RMSD pruning sees two distinct geometries, not two copies.
 */
const xyzFrames = (comments) => comments
  .map((comment, index) => [
    '3',
    comment,
    'O 0 0 0',
    'H 0.96 0 0',
    `H ${(-0.24 + index * 0.60).toFixed(2)} ${(0.93 + index * 0.70).toFixed(2)} 0`,
  ].join('\n'))
  .join('\n');

/** A conformer block feeding one optimisation, through a dependency edge. */
function conformerProject({ output = null, settings = {}, edgeType = 'dependency', ensemble = null } = {}) {
  const nodes = [];
  const edges = [];
  // ADR 0001: an imported ensemble is an input block, not a generate setting.
  if (ensemble) {
    nodes.push({
      id: 'ens', type: 'input', kind: 'Ensemble input', title: 'Imported ensemble', state: 'ready', x: -200, y: 0,
      input: {
        kind: 'ensemble',
        path: ensemble.path,
        format: 'xyz',
        energyUnit: ensemble.energyUnit || 'hartree',
        energyMethod: ensemble.energyMethod || '',
        origin: ensemble.origin || { program: '', version: '', method: '' },
      },
    });
    edges.push({ id: 'e0', from: 'ens', to: 'conf', type: 'dependency' });
  }
  nodes.push(
    {
      id: 'conf', type: 'generate', title: 'Conformer ensemble', state: 'ready', x: 0, y: 0,
      settings, output,
    },
    {
      id: 'opt', type: 'calculate', title: 'Optimise chosen conformer', state: 'ready', x: 200, y: 0,
      settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null,
    },
  );
  edges.push({ id: 'e1', from: 'conf', to: 'opt', type: edgeType });
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
    nodes,
    edges,
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
    expect(task.type).toBe('generate');
    expect(task.executable).toBe(true);
    expect(task.engine).toBeNull();
    expect(task.inputName).toBe('conf.xyz');
    expect(task.inputText.split('\n')[0]).toBe('3');
    expect(task.generate.argv).toEqual(['conf.xyz', '--gfn2', '--nci']);
    expect(task.generate.maxConformers).toBe(20);
  });

  it('emits --uhf as 2S, not as the multiplicity', () => {
    const project = conformerProject({ settings: { multiplicity: 3, charge: -1 }, output: selection() });
    const plan = buildWorkflowPlan(project);
    const task = plan.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.generate.argv).toContain('--uhf');
    expect(task.generate.argv[task.generate.argv.indexOf('--uhf') + 1]).toBe('2');
    expect(task.generate.argv[task.generate.argv.indexOf('--chrg') + 1]).toBe('-1');
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

  it('propagates the fan-out through a downstream chain (#87)', () => {
    // `conf -> opt -> freq`: the frequency must run once per member, not once
    // on the project geometry after both optimisations finish.
    const project = fanOutProject();
    project.nodes.push({
      id: 'freq', type: 'calculate', title: 'Frequency', state: 'ready', x: 400, y: 0,
      settings: defaultSettings({ jobType: 'Freq' }), output: null, checkpointFrom: null,
    });
    project.edges.push({ id: 'e2', from: 'opt', to: 'freq', type: 'dependency' });
    const plan = buildWorkflowPlan(project);
    expect(plan.tasks.map((task) => task.nodeId)).toEqual([
      'conf~c1', 'conf~c2', 'opt~c1', 'opt~c2', 'freq~c1', 'freq~c2',
    ]);
    expect(plan.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'conf~c1->opt~c1',
      'conf~c2->opt~c2',
      'opt~c1->freq~c1',
      'opt~c2->freq~c2',
    ]);
  });

  it('lets a merge block collect the fanned-out branches', () => {
    const project = fanOutProject();
    project.nodes.push({ id: 'm1', type: 'merge', title: 'Merge members', state: 'ready', x: 400, y: 0, merge: { policy: 'all' } });
    project.edges.push({ id: 'e2', from: 'opt', to: 'm1', type: 'dependency' });
    const plan = buildWorkflowPlan(project);
    expect(plan.edges.filter((edge) => edge.to === 'm1')).toHaveLength(2);
  });

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
    expect(conf2.type).toBe('generate');
    expect(conf2.generate.argv).toEqual([]);
    expect(conf2.generate.member).toMatchObject({ id: 'c2', parentId: 'conf', relativeKcal: 3.4 });
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
          id: 'freq', type: 'calculate', title: 'Frequency', state: 'ready', x: 400, y: 0,
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
    await Promise.all(roots.map((root) => rmrf(root)));
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
    const conformers = done.tasks.filter((task) => task.type === 'generate');
    expect(conformers.map((task) => task.nodeId).sort()).toEqual(['conf~c1', 'conf~c2']);
    for (const task of conformers) {
      expect(task.status).toBe('completed');
      expect(task.ensemble.count).toBe(1);
      expect(task.ensemble.selectedId).toBe(task.generate.member.id);
      // Each member has its own folder with its own geometry.
      const memberText = await fsp.readFile(path.join(task.runDir, 'member.xyz'), 'utf8');
      expect(memberText.split('\n')[0]).toBe('3');
      expect(memberText).toMatch(task.generate.member.id === 'c2' ? /H\s+1\.900000/ : /H\s+0\.960000/);
    }

    const calcs = done.tasks.filter((task) => task.type === 'calculate');
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
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(queueManager.start({
        projectName: project.name,
        tasks: plan.tasks.filter((task) => task.type === 'generate'),
        edges: [],
        options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
      })).rejects.toThrow(/CREST executable/i);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it.skipIf(onWindows)('spawns CREST in the folder where its input was staged (#100)', async () => {
    // Keep both stub frames: this test is about where CREST ran, not pruning.
    const project = conformerProject({ output: selection(), settings: { rmsdThreshold: 0.05 } });
    const plan = buildWorkflowPlan(project);
    const { base, queueManager } = await stack();
    const crestPath = path.join(base, 'fake-crest.sh');
    await fsp.writeFile(crestPath, FAKE_CREST, { encoding: 'utf8', mode: 0o755 });

    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks.filter((task) => task.type === 'generate'),
      edges: [],
      options: { dryRun: false, executable: null, crestExecutable: crestPath, scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });

    const conformers = done.tasks.find((task) => task.nodeId === 'conf');
    expect(conformers.error).toBeNull();
    expect(conformers.status).toBe('completed');
    expect(conformers.ensemble.total).toBe(2);
    expect(conformers.ensemble.spreadKcal).toBeCloseTo(0.005 * 627.5094740631, 2);

    // The stub could only print this after opening the staged file from its cwd.
    const log = await fsp.readFile(path.join(conformers.runDir, 'crest.out'), 'utf8');
    expect(log).toMatch(/fake crest: read ensemble\.xyz from /);
    expect(log).toMatch(/\(3 atoms\)/);
    // CREST's artifacts landed beside the input, in the folder it ran in.
    await fsp.access(path.join(conformers.runDir, 'crest_conformers.xyz'));
    await fsp.access(path.join(conformers.runDir, 'crest.energies'));
  });

  it('ranks an imported ensemble from its sibling crest.energies (#103)', async () => {
    const { base, queueManager } = await stack();
    const ensemblePath = path.join(base, 'crest_conformers.xyz');
    await fsp.writeFile(ensemblePath, xyzFrames(['conformer 1', 'conformer 2']), 'utf8');
    await fsp.writeFile(path.join(base, 'crest.energies'), '1 -76.40000000\n2 -76.39500000\n', 'utf8');

    const project = conformerProject({
      output: selection(),
      settings: { source: 'imported', rmsdThreshold: 0.05 },
      ensemble: { path: ensemblePath },
    });
    const plan = buildWorkflowPlan(project);
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks.filter((task) => task.type !== 'calculate'),
      edges: plan.edges.filter((edge) => edge.to !== 'opt' && edge.from !== 'opt'),
      options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });

    const conformers = done.tasks.find((task) => task.nodeId === 'conf');
    expect(conformers.error).toBeNull();
    expect(conformers.status).toBe('completed');
    expect(conformers.ensemble.generator).toBe('imported');
    expect(conformers.ensemble.count).toBe(2);
    expect(conformers.ensemble.spreadKcal).toBeCloseTo(0.005 * 627.5094740631, 2);
    expect(conformers.ensemble.members.find((member) => member.rank === 2).energyEh).toBeCloseTo(-76.395, 9);
  });

  // Will, modelling the Spartan set: a dry run replaced an imported ensemble
  // with the three-member fixture, so it could never show the real data and the
  // downstream task then failed on "no selected conformer".
  it('keeps a real imported ensemble in a dry run', async () => {
    const { base, queueManager } = await stack();
    const ensemblePath = path.join(base, 'crest_conformers.xyz');
    await fsp.writeFile(ensemblePath, xyzFrames(['conformer 1', 'conformer 2', 'conformer 3']), 'utf8');
    await fsp.writeFile(path.join(base, 'crest.energies'), '1 -76.40000000\n2 -76.39600000\n3 -76.39000000\n', 'utf8');

    const project = conformerProject({
      output: selection(),
      settings: { source: 'imported', rmsdThreshold: 0.05 },
      ensemble: { path: ensemblePath },
    });
    const plan = buildWorkflowPlan(project);
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks.filter((task) => task.type !== 'calculate'),
      edges: plan.edges.filter((edge) => edge.to !== 'opt' && edge.from !== 'opt'),
      options: { dryRun: true, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });

    const conformers = done.tasks.find((task) => task.nodeId === 'conf');
    expect(conformers.error).toBeNull();
    expect(conformers.status).toBe('completed');
    // The fixture is labelled `fixture`; the imported ensemble keeps its own
    // generator and its own member count.
    expect(conformers.ensemble.generator).toBe('imported');
    expect(conformers.ensemble.count).toBe(3);
  });

  // A shipped project carries the ensemble beside it and names it relatively.
  // The GUI knows the project's file path, not its folder, so the queue derives
  // the folder from `options.projectFile`.
  it('resolves a project-relative ensemble path from the project file', async () => {
    const { base, queueManager } = await stack();
    await fsp.writeFile(path.join(base, 'ens.xyz'), xyzFrames(['conformer 1', 'conformer 2']), 'utf8');
    await fsp.writeFile(path.join(base, 'ens.energies'), '1 -76.40000000\n2 -76.39500000\n', 'utf8');

    const project = conformerProject({
      output: selection(),
      settings: { source: 'imported', rmsdThreshold: 0.05 },
      ensemble: { path: 'ens.xyz' },
    });
    const plan = buildWorkflowPlan(project);
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks.filter((task) => task.type !== 'calculate'),
      edges: plan.edges.filter((edge) => edge.to !== 'opt' && edge.from !== 'opt'),
      options: {
        dryRun: true,
        executable: null,
        crestExecutable: '',
        scratchDir: '',
        projectFile: path.join(base, '24dhiiq.ncs'),
      },
    });
    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });

    const conformers = done.tasks.find((task) => task.nodeId === 'conf');
    expect(conformers.error).toBeNull();
    expect(conformers.ensemble.generator).toBe('imported');
    expect(conformers.ensemble.count).toBe(2);
  });
});

describe('imported conformer energies (#103)', () => {
  afterEach(async () => {
    await Promise.all(roots.map((root) => rmrf(root)));
    roots.length = 0;
  });

  async function tempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-crest-import-'));
    roots.push(dir);
    return dir;
  }

  it('reads a sibling crest.energies and ranks frames whose comments are labels', async () => {
    const dir = await tempDir();
    const ensemblePath = path.join(dir, 'crest_conformers.xyz');
    await fsp.writeFile(ensemblePath, xyzFrames(['conformer 1', 'conformer 2']), 'utf8');
    await fsp.writeFile(path.join(dir, 'crest.energies'), '1 -76.40000000\n2 -76.39500000\n', 'utf8');

    const imported = await CrestRunner.readImport(ensemblePath);
    expect(imported.energies).toEqual([-76.4, -76.395]);
    const parsed = parseMultiXyz(imported.ensembleText);
    // Neither comment carries an energy; without the sibling file this fails.
    expect(parsed.frames.map((frame) => frame.energyEh)).toEqual([null, null]);
    const merged = withEnergies(parsed.frames, imported.energies);
    expect(merged.error).toBeNull();
    expect(merged.frames[1].energyEh).toBeCloseTo(-76.395, 9);
    const ranked = rankEnsemble({ frames: merged.frames, rmsdThreshold: 0.05 });
    expect(ranked.error).toBeNull();
    expect(ranked.retained).toHaveLength(2);
    expect(ranked.selectedId).toBe('c1');
  });

  it('falls back to <stem>.energies when the ensemble was renamed', async () => {
    const dir = await tempDir();
    const ensemblePath = path.join(dir, 'run7.xyz');
    await fsp.writeFile(ensemblePath, xyzFrames(['conf a', 'conf b']), 'utf8');
    await fsp.writeFile(path.join(dir, 'run7.energies'), '-76.41000000\n-76.40000000\n', 'utf8');

    const imported = await CrestRunner.readImport(ensemblePath);
    expect(imported.energies).toEqual([-76.41, -76.4]);
  });

  it('keeps working when every frame carries its own energy and no energies file exists', async () => {
    const dir = await tempDir();
    const ensemblePath = path.join(dir, 'crest_conformers.xyz');
    await fsp.writeFile(ensemblePath, xyzFrames(['-76.4180', 'conf 2 -76.4172']), 'utf8');

    const imported = await CrestRunner.readImport(ensemblePath);
    expect(imported.energies).toEqual([]);
    const merged = withEnergies(parseMultiXyz(imported.ensembleText).frames, imported.energies);
    expect(merged.error).toBeNull();
    expect(merged.frames.map((frame) => frame.energyEh)).toEqual([-76.418, -76.4172]);
  });

  it('still names the conformer when neither the comment nor a file has an energy', async () => {
    const dir = await tempDir();
    const ensemblePath = path.join(dir, 'crest_conformers.xyz');
    await fsp.writeFile(ensemblePath, xyzFrames(['conformer 1', 'conformer 2']), 'utf8');

    const imported = await CrestRunner.readImport(ensemblePath);
    expect(imported.energies).toEqual([]);
    const merged = withEnergies(parseMultiXyz(imported.ensembleText).frames, imported.energies);
    expect(merged.error).toBe('Conformer 1 has no energy in its comment line and the energies file has no entry for it.');
  });
});
