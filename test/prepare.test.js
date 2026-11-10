import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultSettings,
  validateProject,
} from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

const onWindows = process.platform === 'win32';

/**
 * ADR 0001 §2.9: prepare is 1→1. These tests hold the contract the ADR states —
 * two kinds, no enumeration, no method settings — and exercise both converters.
 * Every fixture is synthetic; the fake obabel only proves the command shape.
 */

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const molecule = {
  charge: 0,
  multiplicity: 1,
  fragments: [],
  coords,
  geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' },
};

const project = (nodes, edges = []) => ({
  schemaVersion: 3,
  name: 'Prepare test',
  molecule,
  defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
  nodes,
  edges,
});

const prepareNode = (settings = {}, output = null) => ({
  id: 'prep', type: 'prepare', title: 'Prepare structure', state: 'ready', x: 0, y: 0,
  settings: { kind: 'relax', converter: 'uff', forceField: 'UFF', smiles: '', charge: 0, multiplicity: 1, ...settings },
  output,
});

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-prepare-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queueManager };
}

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the queue');
}

describe('prepare block schema (ADR 0001 §2.9)', () => {
  it('defaults to an in-app UFF relaxation and fills the documented settings', () => {
    const result = validateProject(project([{
      id: 'prep', type: 'prepare', title: 'Prepare', state: 'ready', x: 0, y: 0,
      settings: {},
    }]));
    expect(result.ok).toBe(true);
    const node = result.project.nodes[0];
    expect(node.kind).toBe('Relax');
    expect(node.settings.kind).toBe('relax');
    expect(node.settings.converter).toBe('uff');
    expect(node.settings.forceField).toBe('UFF');
  });

  it('refuses embed3d without a SMILES or with the in-app converter', () => {
    const noSmiles = validateProject(project([prepareNode({ kind: 'embed3d', converter: 'openbabel' })]));
    expect(noSmiles.ok).toBe(false);
    expect(noSmiles.errors.some((error) => /settings\.smiles/.test(error.path))).toBe(true);

    const wrongConverter = validateProject(project([prepareNode({ kind: 'embed3d', converter: 'uff', smiles: 'O' })]));
    expect(wrongConverter.ok).toBe(false);
    expect(wrongConverter.errors.some((error) => /settings\.converter/.test(error.path))).toBe(true);

    const ok = validateProject(project([prepareNode({ kind: 'embed3d', converter: 'openbabel', smiles: 'O' })]));
    expect(ok.ok).toBe(true);
    expect(ok.project.nodes[0].kind).toBe('3D embed');
  });

  it('names the prepared structure on a downstream calculate task', () => {
    const validated = validateProject(project([
      prepareNode(),
      {
        id: 'opt', type: 'calculate', title: 'Optimise prepared', state: 'ready', x: 200, y: 0,
        settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null,
      },
    ], [{ id: 'e1', from: 'prep', to: 'opt', type: 'dependency' }]));
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const prepareTask = plan.tasks.find((task) => task.type === 'prepare');
    expect(prepareTask.prepare.converter).toBe('uff');
    expect(prepareTask.inputText.trim().split('\n')[0]).toBe('3');
    const calcTask = plan.tasks.find((task) => task.nodeId === 'opt');
    expect(calcTask.prepareFrom).toEqual({ nodeId: 'prep' });
  });
});

describe('prepare runtime', () => {
  it('relaxes one structure with UFF and writes prepared.xyz + prepare.json', async () => {
    const { queueManager } = await stack();
    const validated = validateProject(project([prepareNode()]));
    expect(validated.ok).toBe(true);
    const task = buildWorkflowPlan(validated.project).tasks.find((entry) => entry.type === 'prepare');
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: [task],
      edges: [],
      options: { dryRun: true, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const preparedTask = done.tasks.find((entry) => entry.nodeId === 'prep');
    expect(preparedTask.error).toBeNull();
    expect(preparedTask.status).toBe('completed');
    const xyz = await fsp.readFile(path.join(preparedTask.runDir, 'prepared.xyz'), 'utf8');
    expect(xyz.trim().split('\n')[0]).toBe('3');
    const record = JSON.parse(await fsp.readFile(path.join(preparedTask.runDir, 'prepare.json'), 'utf8'));
    expect(record.kind).toBe('relax');
    expect(record.converter).toBe('uff');
    expect(record.forceField).toBe('UFF');
    expect(record.atomCount).toBe(3);
    expect(Number.isFinite(record.energyKcal)).toBe(true);
  });

  it.skipIf(onWindows)('runs the Open Babel converter for embed3d and keeps its transcript', async () => {
    const { base, queueManager } = await stack();
    const fake = path.join(base, 'obabel');
    await fsp.writeFile(fake, [
      '#!/bin/sh',
      'if [ "$1" = "-V" ]; then echo "Open Babel 3.1.0 -- fake"; exit 0; fi',
      'out=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-O" ]; then out="$arg"; fi',
      '  prev="$arg"',
      'done',
      'cat > "$out" <<EOF',
      '3',
      'embedded O',
      'O 0.000000 0.000000 0.000000',
      'H 0.960000 0.000000 0.000000',
      'H -0.240000 0.930000 0.000000',
      'EOF',
      'echo "1 molecule converted"',
    ].join('\n'), { mode: 0o755 });

    const validated = validateProject(project([prepareNode({
      kind: 'embed3d', converter: 'openbabel', forceField: 'MMFF94', smiles: 'O',
    })]));
    expect(validated.ok).toBe(true);
    const task = buildWorkflowPlan(validated.project).tasks.find((entry) => entry.type === 'prepare');
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: [task],
      edges: [],
      options: { dryRun: false, executable: null, crestExecutable: '', obabelExecutable: fake, scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const preparedTask = done.tasks.find((entry) => entry.nodeId === 'prep');
    expect(preparedTask.error).toBeNull();
    expect(preparedTask.status).toBe('completed');
    const record = JSON.parse(await fsp.readFile(path.join(preparedTask.runDir, 'prepare.json'), 'utf8'));
    expect(record.kind).toBe('embed3d');
    expect(record.converter).toBe('openbabel');
    expect(record.origin.program).toBe('Open Babel');
    const log = await fsp.readFile(path.join(preparedTask.runDir, 'obabel.log'), 'utf8');
    expect(log).toMatch(/-:O -O prepared\.xyz --gen3d/);
  });
});

describe.skipIf(onWindows)('prepare with an ML scorer', () => {
  it('relaxes one structure with scorer forces and records the provenance', async () => {
    const { base, queueManager } = await stack();
    const fake = path.join(base, 'ml-scorer');
    await fsp.writeFile(fake, [
      '#!/usr/bin/env node',
      'let text = "";',
      'process.stdin.on("data", (c) => { text += c; });',
      'process.stdin.on("end", () => {',
      '  const req = JSON.parse(text);',
      '  const targets = [[0,0,0],[0.96,0,0],[-0.24,0.93,0]];',
      '  let energy = 0;',
      '  const results = req.frames.map((frame) => {',
      '    const forces = frame.atoms.map((atom, i) => {',
      '      const d = [atom.x - targets[i][0], atom.y - targets[i][1], atom.z - targets[i][2]];',
      '      energy += d[0]*d[0] + d[1]*d[1] + d[2]*d[2];',
      '      return [-2*d[0], -2*d[1], -2*d[2]];',
      '    });',
      '    return { id: frame.id, energyEv: energy, forces };',
      '  });',
      '  process.stdout.write(JSON.stringify({',
      '    model: "aimnet2", version: "2.0.0", weightsSha256: "d".repeat(64),',
      '    dtype: "float32", device: "cpu", cutoffAngstrom: 5,',
      '    charge: req.charge, multiplicity: req.multiplicity, results,',
      '  }));',
      '});',
    ].join('\n'), { mode: 0o755 });

    const validated = validateProject(project([prepareNode({
      kind: 'relax', converter: 'aimnet2', forceField: 'AIMNet2',
    })]));
    expect(validated.ok).toBe(true);
    const task = buildWorkflowPlan(validated.project).tasks.find((entry) => entry.type === 'prepare');
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: [task],
      edges: [],
      options: { dryRun: false, executable: null, crestExecutable: '', scorerExecutable: fake, scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const preparedTask = done.tasks.find((entry) => entry.nodeId === 'prep');
    expect(preparedTask.error).toBeNull();
    expect(preparedTask.status).toBe('completed');
    const record = JSON.parse(await fsp.readFile(path.join(preparedTask.runDir, 'prepare.json'), 'utf8'));
    expect(record.converter).toBe('aimnet2');
    expect(record.forceField).toBe('AIMNet2');
    expect(record.converged).toBe(true);
    expect(record.energyKcal).toBeLessThan(1);
    expect(record.scorer.comparableWithQuantumChemistry).toBe(false);
  });
});
