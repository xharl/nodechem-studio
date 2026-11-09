import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

const roots = [];
const onWindows = process.platform === 'win32';

const coords = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 1.53, y: 0, z: 0 },
  { element: 'C', x: 2.1, y: 1.4, z: 0 },
  { element: 'C', x: 3.6, y: 1.4, z: 0 },
];

/**
 * A stand-in for `obabel`. It answers `-V`, and for each of the two passes it
 * writes the file the real binary writes — a search that produced three
 * conformers, and a scored ensemble whose comment lines end in kcal/mol. The
 * numbers are deliberately positive and negative: an MM energy has no sign
 * convention, and a reader that assumes Hartree would drop the positive one.
 */
const FAKE_OBABEL = [
  '#!/bin/sh',
  'set -eu',
  'if [ "$1" = "-V" ]; then',
  '  echo "Open Babel 9.9.9 -- fake build"',
  '  exit 0',
  'fi',
  'case "$*" in',
  '  *--writeconformers*)',
  '    cat > obabel_conformers.xyz <<\'EOF\'',
  '4',
  'conformer 1',
  'C 0.000000 0.000000 0.000000',
  'C 1.530000 0.000000 0.000000',
  'C 2.100000 1.400000 0.000000',
  'C 3.600000 1.400000 0.000000',
  '4',
  'conformer 2',
  'C 0.000000 0.000000 0.000000',
  'C 1.530000 0.000000 0.000000',
  'C 2.100000 1.400000 1.200000',
  'C 3.600000 1.400000 1.200000',
  '4',
  'conformer 3',
  'C 0.000000 0.000000 0.000000',
  'C 1.530000 0.000000 0.000000',
  'C 2.100000 -1.400000 0.000000',
  'C 3.600000 -1.400000 0.000000',
  'EOF',
  '    echo "Initial conformer count: 3"',
  '    echo "11 attempts,  5 duplicates, 1 failed filter."',
  '    echo "Generation #1  -1.50000"',
  '    exit 0',
  '    ;;',
  '  *--energy*)',
  '    cat > obabel_scored.xyz <<\'EOF\'',
  '4',
  'ensemble.xyz 215.90000',
  'C 0.000000 0.000000 0.000000',
  'C 1.530000 0.000000 0.000000',
  'C 2.100000 1.400000 0.000000',
  'C 3.600000 1.400000 0.000000',
  '4',
  'ensemble.xyz -5.44311',
  'C 0.000000 0.000000 0.000000',
  'C 1.530000 0.000000 0.000000',
  'C 2.100000 1.400000 1.200000',
  'C 3.600000 1.400000 1.200000',
  '4',
  'ensemble.xyz -2.91903',
  'C 0.000000 0.000000 0.000000',
  'C 1.530000 0.000000 0.000000',
  'C 2.100000 -1.400000 0.000000',
  'C 3.600000 -1.400000 0.000000',
  'EOF',
  '    echo "3 molecules converted"',
  '    exit 0',
  '    ;;',
  'esac',
  'echo "fake obabel: unexpected arguments: $*" >&2',
  'exit 64',
].join('\n');

function projectWith({ settings = {}, coordsOverride = coords } = {}) {
  const raw = {
    schemaVersion: 1,
    name: 'Open Babel workflow',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      geometry: { source: 'imported', file: 'butane.xyz', format: 'xyz' },
      coords: coordsOverride,
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [
      {
        id: 'conf', type: 'conformers', title: 'Open Babel search', state: 'ready', x: 0, y: 0,
        settings: { generator: 'obabel', nconf: 3, ff: 'mmff94', ...settings }, output: null,
      },
    ],
    edges: [],
  };
  const validated = validateProject(raw);
  expect(validated.ok).toBe(true);
  return validated.project;
}

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'obabel-workflow-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  const executable = path.join(base, 'obabel');
  await fsp.writeFile(executable, FAKE_OBABEL, { mode: 0o755 });
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
  return { base, queuesRoot, queueManager, events, executable };
}

async function waitFor(check, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe.skipIf(onWindows)('the Open Babel route through the queue', () => {
  it('runs two passes and records the ensemble in kcal/mol with its provenance', async () => {
    const project = projectWith();
    const plan = buildWorkflowPlan(project);
    const task = plan.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.conformers.generator).toBe('obabel');
    expect(task.conformers.argv).toEqual([
      'conf.xyz', '-O', 'obabel_conformers.xyz',
      '--conformer', '--nconf', '3', '--ff', 'MMFF94',
      '--score', 'energy', '--writeconformers',
    ]);

    const { queueManager, executable } = await stack();
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: false, executable: null, crestExecutable: null, obabelExecutable: executable, scratchDir: '' },
    });

    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' && queue.status !== 'queued' ? queue : null;
    });
    const conf = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(conf.status).toBe('completed');
    expect(conf.ensemble.generator).toBe('obabel');
    // All three conformers are in the record; the 10 kcal/mol window drops the
    // +215.9 member, and the RMSD threshold drops the near-duplicate.
    expect(conf.ensemble.total).toBe(3);
    expect(conf.ensemble.count).toBe(1);
    expect(conf.ensemble.members.map((member) => member.energyKcal)).toEqual([-5.44311, -2.91903, 215.9]);
    expect(conf.ensemble.energyUnit).toBe('kcal/mol');
    expect(conf.ensemble.energyMethod).toBe('MMFF94');
    expect(conf.ensemble.origin).toMatchObject({ program: 'Open Babel', version: '9.9.9', method: 'MMFF94' });
    // Ranked by energy, so the lowest is first and ΔE is measured from it.
    expect(conf.ensemble.members[0].rank).toBe(1);
    expect(conf.ensemble.members[0].relativeKcal).toBeCloseTo(0, 9);
    expect(conf.ensemble.members[1].relativeKcal).toBeCloseTo(2.52408, 4);
    expect(conf.ensemble.members[0].dropped).toBeNull();
    expect(conf.ensemble.selected.id).toBe(conf.ensemble.selectedId);
  });

  it('refuses an element MMFF94 cannot type, by name, before spawning', async () => {
    const selenium = coords.map((atom, index) => (index === 0 ? { ...atom, element: 'Se' } : atom));
    const project = projectWith({ coordsOverride: selenium });
    const plan = buildWorkflowPlan(project);
    const { queueManager, executable } = await stack();
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: false, executable: null, crestExecutable: null, obabelExecutable: executable, scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' && queue.status !== 'queued' ? queue : null;
    });
    const conf = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(conf.status).toBe('failed');
    expect(conf.error).toMatch(/MMFF94 has no parameters for Se/);
  });

  it('requires the binary before the queue starts', async () => {
    const project = projectWith();
    const plan = buildWorkflowPlan(project);
    const { queueManager } = await stack();
    await expect(queueManager.start({
      projectName: project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: false, executable: null, crestExecutable: null, obabelExecutable: '', scratchDir: '' },
    })).rejects.toThrow(/Choose the Open Babel executable/);
  });

  it('labels a dry run with the fixture, not as an Open Babel result', async () => {
    const project = projectWith();
    const plan = buildWorkflowPlan(project);
    const { queueManager } = await stack();
    const started = await queueManager.start({
      projectName: project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: true, executable: null, crestExecutable: null, obabelExecutable: null, scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' && queue.status !== 'queued' ? queue : null;
    });
    const conf = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(conf.ensemble.generator).toBe('fixture');
    expect(conf.ensemble.energyUnit).toBe('hartree');
    expect(conf.ensemble.energyMethod).toBe('');
  });
});
