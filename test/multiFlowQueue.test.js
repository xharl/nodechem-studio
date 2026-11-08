import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

/**
 * RFC 0001, queue half: records in the queue folder, a bounded parallel drain,
 * and the barrier fence holding a stage until every record has cleared it.
 */

const roots = [];
const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

function task(nodeId, overrides = {}) {
  return {
    nodeId,
    title: nodeId,
    kind: 'SP',
    executable: true,
    inputName: `${nodeId}.gjf`,
    outputName: `${nodeId}.out`,
    inputText: '#p B3LYP/6-31G(d) SP\n\ntest\n\n0 1\nO 0.000000 0.000000 0.117300\n',
    gates: {},
    ...overrides,
  };
}

/** Fake engine: deterministic output, optional delay, and a concurrency meter. */
function fakeRunner(behaviour = () => ({})) {
  const meter = { current: 0, peak: 0, order: [] };
  const factory = () => {
    const state = { cancelled: false };
    return {
      cancel() { state.cancelled = true; },
      async run({ outputName, cwd, onOutput, executable }) {
        meter.current += 1;
        meter.peak = Math.max(meter.peak, meter.current);
        meter.order.push({ event: 'start', outputName, executable });
        try {
          const plan = behaviour(outputName) || {};
          if (plan.delay) await new Promise((resolve) => setTimeout(resolve, plan.delay));
          if (state.cancelled) {
            return { exitCode: null, signal: 'SIGTERM', cancelled: true, outputPath: path.join(cwd, outputName), outputText: '', stdout: '', stderr: '' };
          }
          if (plan.throw) throw new Error(plan.throw);
          const text = plan.output ?? makeFixtureOutput();
          await fsp.writeFile(path.join(cwd, outputName), text, 'utf8');
          onOutput({ stream: 'output', text });
          return { exitCode: 0, signal: null, cancelled: false, outputPath: path.join(cwd, outputName), outputText: text, stdout: '', stderr: '' };
        } finally {
          meter.current -= 1;
          meter.order.push({ event: 'end', outputName });
        }
      },
    };
  };
  factory.meter = meter;
  return factory;
}

async function makeStack({ behaviour } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-multiflow-'));
  roots.push(base);
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  await fsp.mkdir(runsRoot, { recursive: true });
  const exe = path.join(base, 'g16.exe');
  await fsp.writeFile(exe, '');
  const factory = fakeRunner(behaviour);
  const runManager = new RunManager({ runsRoot, emit: () => {}, createRunner: factory });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queuesRoot, exe, factory, queueManager, runManager };
}

async function waitFor(check, { timeout = 20000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const settled = (queue) => ['completed', 'failed', 'needs-review', 'partial', 'cancelled'].includes(queue.status);

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

function datasetProject({ records = 2 } = {}) {
  const rows = Array.from({ length: records }, (_, index) => ({
    id: `m${index + 1}`,
    label: `molecule ${index + 1}`,
    charge: index === 1 ? -1 : 0,
    multiplicity: index === 1 ? 2 : 1,
    coords: water,
    enabled: true,
  }));
  const result = validateProject({
    schemaVersion: 2,
    name: 'family',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [{
      id: 'family',
      source: { kind: 'inline', path: '', format: 'sdf' },
      fields: { label: '', charge: '', multiplicity: '' },
      records: rows,
      notes: '',
    }],
    flows: [{
      id: 'main',
      title: 'Workflow',
      nodes: [
        { id: 'in1', type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0,
          input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
        { id: 'opt', type: 'calc', kind: 'Opt', title: 'Optimise', state: 'ready', x: 0, y: 0,
          settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null },
      ],
      edges: [{ from: 'in1', to: 'opt', type: 'dependency' }],
    }],
    reports: [],
    activeFlowId: 'main',
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

describe('RFC 0001 — the queue keeps the family on disk and runs it', () => {
  it('writes one record file per record into the queue folder', async () => {
    const { exe, queueManager, queuesRoot } = await makeStack();
    const plan = buildWorkflowPlan(datasetProject());
    const started = await queueManager.start({ projectName: 'family', tasks: plan.tasks, edges: plan.edges, options: { executable: exe, scratchDir: '' } });
    await waitFor(async () => settled(await queueManager.get(started.id)), { label: 'family completion' });
    const dir = path.join(queuesRoot, started.id, 'records');
    const files = (await fsp.readdir(dir)).sort();
    expect(files).toEqual(['m1.json', 'm2.json']);
    const m2 = JSON.parse(await fsp.readFile(path.join(dir, 'm2.json'), 'utf8'));
    expect(m2).toMatchObject({ id: 'm2', label: 'molecule 2', charge: -1, multiplicity: 2 });
  });

  it('runs two records at once when maxParallel is 2, and one at a time by default', async () => {
    const behaviour = () => ({ delay: 60 });
    const { exe, queueManager, factory } = await makeStack({ behaviour });
    const plan = buildWorkflowPlan(datasetProject());
    const started = await queueManager.start({
      projectName: 'family', tasks: plan.tasks, edges: plan.edges, options: { executable: exe, scratchDir: '', maxParallel: 2 },
    });
    await waitFor(async () => settled(await queueManager.get(started.id)), { label: 'parallel completion' });
    expect(factory.meter.peak).toBe(2);

    const serialStack = await makeStack({ behaviour });
    const serial = await serialStack.queueManager.start({
      projectName: 'family', tasks: plan.tasks, edges: plan.edges, options: { executable: serialStack.exe, scratchDir: '' },
    });
    await waitFor(async () => settled(await serialStack.queueManager.get(serial.id)), { label: 'serial completion' });
    expect(serialStack.factory.meter.peak).toBe(1);
  });

  it('launches each task with the binary of its own engine', async () => {
    const { base, exe, queueManager, factory } = await makeStack();
    const psi4Exe = path.join(base, 'psi4');
    await fsp.writeFile(psi4Exe, '');
    const tasks = [
      task('opt', { engine: 'xtb', inputName: 'opt.xyz', outputName: 'opt.out', argv: ['opt.xyz', '--gfn', '2', '--sp'] }),
      task('sp', { engine: 'psi4', inputName: 'sp.dat', outputName: 'sp.out', argv: ['sp.dat'] }),
    ];
    const started = await queueManager.start({
      projectName: 'mixed engines',
      tasks,
      // No dependency edge: this test is about which binary each task gets,
      // not about gate propagation between them.
      edges: [],
      options: { executables: { xtb: exe, psi4: psi4Exe }, scratchDir: '' },
    });
    await waitFor(async () => settled(await queueManager.get(started.id)), { label: 'mixed-engine completion' });
    const byOutput = Object.fromEntries(factory.meter.order
      .filter((entry) => entry.event === 'start')
      .map((entry) => [entry.outputName, entry.executable]));
    expect(byOutput['opt.out']).toBe(exe);
    expect(byOutput['sp.out']).toBe(psi4Exe);
  });

  it('names the engine whose executable is missing instead of one generic message', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [task('sp', { engine: 'psi4', inputName: 'sp.dat', outputName: 'sp.out', argv: ['sp.dat'] })];
    await expect(queueManager.start({
      projectName: 'missing psi4',
      tasks,
      edges: [],
      options: { executables: { xtb: exe }, scratchDir: '' },
    })).rejects.toThrow(/Psi4 executable/);
  });

  it('reports partial when one record fails and the other finishes', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (/^opt_m2\.out$/.test(outputName) ? { output: ' Error termination via Lnk1e\n' } : {}),
    });
    const plan = buildWorkflowPlan(datasetProject());
    const started = await queueManager.start({ projectName: 'family', tasks: plan.tasks, edges: plan.edges, options: { executable: exe, scratchDir: '' } });
    const done = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return settled(queue) ? queue : null;
    }, { label: 'partial settlement' });
    expect(done.status).toBe('partial');
    expect(done.tasks.find((task) => task.nodeId === 'opt~m1').status).toBe('completed');
    expect(done.tasks.find((task) => task.nodeId === 'opt~m2').status).toBe('failed');
  });
});

describe('RFC 0001 — the barrier holds the stage until every record clears it', () => {
  it('starts no stage-2 task before the last stage-1 task finished', async () => {
    const water2 = water;
    const result = validateProject({
      schemaVersion: 2,
      name: 'barrier',
      molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water2, geometry: { source: 'demo', file: '', format: '' } },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 2 },
      datasets: [{
        id: 'family',
        source: { kind: 'inline', path: '', format: 'sdf' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [
          { id: 'm1', label: 'one', charge: 0, multiplicity: 1, coords: water2, enabled: true },
          { id: 'm2', label: 'two', charge: 0, multiplicity: 1, coords: water2, enabled: true },
        ],
        notes: '',
      }],
      flows: [{
        id: 'main',
        title: 'Workflow',
        nodes: [
          { id: 'in1', type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0,
            input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
          { id: 'opt', type: 'calc', kind: 'Opt', title: 'Optimise', state: 'ready', x: 0, y: 0,
            settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null },
          { id: 'sp', type: 'calc', kind: 'SP', title: 'High level', state: 'ready', x: 0, y: 0,
            settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null },
        ],
        edges: [
          { from: 'in1', to: 'opt', type: 'dependency' },
          { from: 'opt', to: 'sp', type: 'barrier' },
        ],
      }],
      reports: [],
      activeFlowId: 'main',
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const plan = buildWorkflowPlan(result.project);
    const { exe, queueManager, factory } = await makeStack({ behaviour: () => ({ delay: 40 }) });
    const started = await queueManager.start({
      projectName: 'barrier', tasks: plan.tasks, edges: plan.edges, options: { executable: exe, scratchDir: '', maxParallel: 2 },
    });
    // Windows under load has lost this 20 s bet once: the fence still held,
    // the machine was simply slower than the poll. Patience, not a relaxed
    // assertion — the ordering check below is unchanged.
    await waitFor(async () => settled(await queueManager.get(started.id)), { timeout: 25000, label: 'barrier completion' });

    // Every opt ends before any sp starts: that is what the fence means.
    const lastOptEnd = Math.max(...factory.meter.order
      .map((entry, index) => (entry.event === 'end' && entry.outputName.startsWith('opt') ? index : -1)));
    const firstSpStart = factory.meter.order
      .findIndex((entry) => entry.event === 'start' && entry.outputName.startsWith('sp'));
    expect(firstSpStart).toBeGreaterThan(lastOptEnd);
  });
});
