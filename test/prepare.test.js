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

describe('prepare outputs the report could not value', () => {
  it('accepts a null energyKcal, so a non-converged run can still be saved', () => {
    // #260: Open Babel reports no final energy when a minimisation hits its cap;
    // refusing null made the whole project unsaveable after a legitimate run.
    const validated = validateProject(project([prepareNode({}, {
      kind: 'relax', converter: 'openbabel', forceField: 'MMFF94',
      energyKcal: null, converged: false,
      reason: 'converter-did-not-report-convergence', iterations: 500, atomCount: 3,
    })]));
    expect(validated.ok).toBe(true);
    expect(validated.project.nodes[0].output.energyKcal).toBeNull();
    expect(validated.project.nodes[0].output.reason).toBe('converter-did-not-report-convergence');
  });

  it('preserves a null converged, so a saved dry run reloads as a dry run', () => {
    // #257: null is "never ran"; coercing it to false made the reloaded record
    // read as a relaxation that hit its cap.
    const validated = validateProject(project([prepareNode({}, {
      kind: 'relax', converter: 'openbabel', forceField: 'MMFF94',
      energyKcal: null, converged: null,
      reason: 'dry-run (converter not run)', iterations: 0, atomCount: 3,
    })]));
    expect(validated.ok).toBe(true);
    expect(validated.project.nodes[0].output.converged).toBeNull();
    // A missing boolean is still an error; only an explicit null is allowed.
    const missing = validateProject(project([prepareNode({}, {
      kind: 'relax', converter: 'openbabel', forceField: 'MMFF94',
      energyKcal: null, reason: 'dry-run (converter not run)', iterations: 0, atomCount: 3,
    })]));
    expect(missing.ok).toBe(false);
    expect(missing.errors.some((error) => /output\.converged/.test(error.path))).toBe(true);
  });
});

describe('prepare under a dry run', () => {
  it('spawns no converter and records why', async () => {
    // `--dry-run` records no binaries, so a prepare block that spawns anyway made
    // a dry run of any Open Babel project fail with "No Open Babel executable".
    const validated = validateProject(project([prepareNode({ converter: 'openbabel', forceField: 'MMFF94' })]));
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const { queueManager } = await stack();
    const started = await queueManager.start({
      projectName: 'dry prepare',
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: true, obabelExecutable: '', scratchDir: '' },
    });
    await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return queue.tasks.every((task) => !['pending', 'running'].includes(task.status));
    });
    const queue = await queueManager.get(started.id);
    const prep = queue.tasks.find((task) => task.nodeId === 'prep');
    expect(prep.status).toBe('completed');
    expect(prep.prepared.reason).toBe('dry-run (converter not run)');
    expect(prep.prepared.converged).toBeNull();
    expect(prep.prepared.energyKcal).toBeNull();
    // #257: the summary line must not claim a relaxation that never ran.
    expect(prep.summary).toBe('dry run · converter not run (geometry unchanged)');
    expect(prep.summary).not.toMatch(/converged/i);
  });
});

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

  it('accepts an explicit solvent block and records its placement provenance', () => {
    const validated = validateProject(project([prepareNode({
      kind: 'solvate', converter: 'geometric', forceField: 'none',
      solvent: 'water', solventCount: 4, seed: 7, shellAngstrom: 3.5,
    })]));
    expect(validated.ok).toBe(true);
    const node = validated.project.nodes[0];
    expect(node.kind).toBe('Solvate');
    expect(node.settings).toMatchObject({
      kind: 'solvate', converter: 'geometric', forceField: 'none',
      solvent: 'water', solventCount: 4, seed: 7, shellAngstrom: 3.5,
    });
    const output = {
      kind: 'solvate', converter: 'geometric', forceField: 'none',
      solvationModel: 'explicit',
      energyKcal: null, converged: null, reason: 'placement-completed', iterations: 0, atomCount: 15,
      solvent: { id: 'water', label: 'Water', formula: 'H2O' }, count: 4, seed: 7,
      shellAngstrom: 3.5, minDistanceAngstrom: 2, formula: 'H2O · 4 H2O',
      method: 'deterministic Fibonacci-shell placement, rigid solvent templates, no relaxation',
      limitation: 'One explicit cluster is not bulk solvent.',
      composition: {
        soluteFormula: 'H2O', solventFormula: 'H2O', solventCount: 4,
        soluteAtoms: 3, solventAtoms: 3, totalAtoms: 15,
      },
    };
    const reloaded = validateProject(project([prepareNode({
      kind: 'solvate', converter: 'geometric', forceField: 'none',
      solvent: 'water', solventCount: 4, seed: 7, shellAngstrom: 3.5,
    }, output)]));
    expect(reloaded.ok).toBe(true);
    expect(reloaded.project.nodes[0].output.composition.totalAtoms).toBe(15);
    expect(reloaded.project.nodes[0].output.solvationModel).toBe('explicit');
    expect(reloaded.project.nodes[0].output.formula).toBe('H2O · 4 H2O');
    expect(reloaded.project.nodes[0].output.limitation).toMatch(/not bulk solvent/);
  });

  it('refuses a solvate block with a force-field converter or an unknown solvent', () => {
    const wrongConverter = validateProject(project([prepareNode({ kind: 'solvate', converter: 'uff' })]));
    expect(wrongConverter.ok).toBe(false);
    expect(wrongConverter.errors.some((error) => /settings\.converter/.test(error.path))).toBe(true);
    const unknown = validateProject(project([prepareNode({ kind: 'solvate', converter: 'geometric', solvent: 'benzene' })]));
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.some((error) => /settings\.solvent/.test(error.path))).toBe(true);
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
  it('builds an explicit solvent cluster and writes prepared.xyz + prepare.json', async () => {
    const { queueManager } = await stack();
    const validated = validateProject(project([prepareNode({
      kind: 'solvate', converter: 'geometric', forceField: 'none',
      solvent: 'water', solventCount: 4, seed: 7, shellAngstrom: 3.5,
    })]));
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
    expect(xyz.trim().split('\n')[0]).toBe('15');
    const record = JSON.parse(await fsp.readFile(path.join(preparedTask.runDir, 'prepare.json'), 'utf8'));
    expect(record.kind).toBe('solvate');
    expect(record.converter).toBe('geometric');
    expect(record.forceField).toBe('none');
    expect(record.solvationModel).toBe('explicit');
    expect(record.atomCount).toBe(15);
    expect(record.composition.totalAtoms).toBe(15);
    expect(record.seed).toBe(7);
    expect(record.limitation).toMatch(/not bulk solvent/);
    expect(record.method).toMatch(/no relaxation/);
  });

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
