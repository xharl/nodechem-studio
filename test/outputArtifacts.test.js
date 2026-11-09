import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { QueueManager, resolveArtifactPath } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { datasetCsv, runRows } from '../src/shared/datasetExport.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

const roots = [];
const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

function projectWithOutput({ records = 3, kind = 'html', include = 'records', artifactPath = 'reports/barrier.html' } = {}) {
  const rows = Array.from({ length: records }, (_, index) => ({
    id: `m${index + 1}`,
    label: `molecule ${index + 1}`,
    charge: 0,
    multiplicity: 1,
    coords: water,
    // The third record is deliberately disabled: it must not reach the report.
    enabled: index !== records - 1 || records < 3,
  }));
  const result = validateProject({
    schemaVersion: 3,
    name: 'family artifacts',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 2 },
    datasets: [{
      id: 'family',
      title: 'Family',
      source: { kind: 'inline', path: '', format: 'sdf' },
      fields: { label: '', charge: '', multiplicity: '' },
      records: rows,
      notes: '',
    }],
    flows: [{
      id: 'barrier',
      title: 'Barrier',
      nodes: [
        { id: 'in1', type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0,
          input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
        { id: 'opt', type: 'calculate', kind: 'Opt', title: 'Optimise', state: 'ready', x: 0, y: 100,
          settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null },
        { id: 'out1', type: 'output', kind: 'Output', title: 'Report', state: 'ready', x: 0, y: 200,
          output: { kind, path: artifactPath, include, bundle: 'project.zip', manifest: true, notes: '' } },
      ],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'out1', type: 'dependency' },
      ],
    }],
    reports: [],
    activeFlowId: 'barrier',
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

/** Fake engine: fixture output, optional failure for one output name. */
function fakeRunner(behaviour = () => ({})) {
  return () => ({
    cancel() {},
    async run({ outputName, cwd, onOutput }) {
      const plan = behaviour(outputName) || {};
      if (plan.throw) throw new Error(plan.throw);
      if (plan.fail) throw new Error(`engine exited with code 1 for ${outputName}`);
      const text = plan.output ?? makeFixtureOutput();
      await fsp.writeFile(path.join(cwd, outputName), text, 'utf8');
      onOutput({ stream: 'output', text });
      return {
        exitCode: 0, signal: null, cancelled: false,
        outputPath: path.join(cwd, outputName), outputText: text, stdout: '', stderr: '',
      };
    },
  });
}

async function makeStack({ behaviour, artifactsRoot = null } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-output-'));
  roots.push(base);
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  await fsp.mkdir(runsRoot, { recursive: true });
  const exe = path.join(base, 'g16.exe');
  await fsp.writeFile(exe, '');
  const runManager = new RunManager({ runsRoot, emit: () => {}, createRunner: fakeRunner(behaviour) });
  const queueManager = new QueueManager({
    queuesRoot,
    runManager,
    emit: () => {},
    artifactsRoot: artifactsRoot || null,
  });
  await queueManager.init();
  return { base, runsRoot, queuesRoot, exe, queueManager };
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

async function runProject({ project, exe, queueManager, options = {} }) {
  const plan = buildWorkflowPlan(project);
  const started = await queueManager.start({
    projectName: project.name,
    tasks: plan.tasks,
    edges: plan.edges,
    options: { executable: exe, scratchDir: '', ...options },
  });
  return waitFor(async () => {
    const queue = await queueManager.get(started.id);
    return settled(queue) ? queue : null;
  }, { label: 'artifact queue settlement' });
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('output blocks write artifacts and a hashed manifest', () => {
  it('writes one HTML report per record, names the disabled record nowhere, and hashes each file', async () => {
    const { base, queuesRoot, exe, queueManager } = await makeStack();
    const queue = await runProject({ project: projectWithOutput({ include: 'record' }), exe, queueManager });
    expect(queue.status).toBe('completed');

    const out = queue.tasks.find((task) => task.nodeId === 'out1');
    expect(out.status).toBe('completed');
    expect(out.reason).toContain('2 artifacts');
    expect(out.reason).toContain('barrier-m1.html');

    const root = path.join(queuesRoot, queue.id, 'artifacts');
    const one = await fsp.readFile(path.join(root, 'reports', 'barrier-m1.html'), 'utf8');
    const two = await fsp.readFile(path.join(root, 'reports', 'barrier-m2.html'), 'utf8');
    expect(one).toContain('Record — molecule 1');
    expect(two).toContain('Record — molecule 2');
    expect(one).not.toContain('molecule 3');
    await expect(fsp.readFile(path.join(root, 'reports', 'barrier-m3.html'), 'utf8')).rejects.toThrow();

    const manifest = JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.map((entry) => entry.path)).toEqual(['reports/barrier-m1.html', 'reports/barrier-m2.html']);
    for (const entry of manifest) {
      const bytes = await fsp.readFile(path.join(root, entry.path));
      expect(entry).toMatchObject({ kind: 'html', flowId: 'barrier', queueId: queue.id });
      expect(entry.bytes).toBe(bytes.length);
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(Date.parse(entry.generatedAt)).not.toBeNaN();
    }
  });

  it('writes a CSV that equals the app dataset export for the same run records', async () => {
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-artifacts-root-'));
    roots.push(outRoot);
    const { exe, queueManager } = await makeStack({ artifactsRoot: outRoot });
    const queue = await runProject({
      project: projectWithOutput({ kind: 'csv', artifactPath: 'reports/dataset.csv', records: 2 }),
      exe,
      queueManager,
    });
    expect(queue.status).toBe('completed');
    const artifactFile = path.join(outRoot, 'reports', 'dataset.csv');
    const csv = await fsp.readFile(artifactFile, 'utf8');
    const records = await Promise.all(queue.tasks
      .filter((task) => task.type === 'calculate' && task.runDir)
      .map(async (task) => JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'))));
    expect(csv).toBe(datasetCsv(runRows(records)));
    const manifest = JSON.parse(await fsp.readFile(path.join(outRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].path).toBe('reports/dataset.csv');
  });

  it('writes a zip containing the queue snapshot, record files and each run', async () => {
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-artifacts-zip-'));
    roots.push(outRoot);
    const { exe, queueManager } = await makeStack({ artifactsRoot: outRoot });
    const queue = await runProject({
      project: projectWithOutput({ kind: 'zip', artifactPath: 'reports/project.zip', records: 2 }),
      exe,
      queueManager,
    });
    const archive = await fsp.readFile(path.join(outRoot, 'reports', 'project.zip'));
    const names = [];
    const eocd = archive.length - 22;
    expect(archive.readUInt32LE(eocd)).toBe(0x06054b50);
    const count = archive.readUInt16LE(eocd + 10);
    let offset = archive.readUInt32LE(eocd + 16);
    for (let index = 0; index < count; index += 1) {
      const nameLength = archive.readUInt16LE(offset + 28);
      const extraLength = archive.readUInt16LE(offset + 30);
      const commentLength = archive.readUInt16LE(offset + 32);
      names.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
      offset += 46 + nameLength + extraLength + commentLength;
    }
    expect(names).toContain('queue.json');
    expect(names).toContain('records/m1.json');
    expect(names).toContain('records/m2.json');
    expect(names.some((name) => name.endsWith('runs/' + queue.tasks.find((task) => task.nodeId === 'opt~m1').runId + '/run.json'))).toBe(true);
    expect(names.some((name) => name.endsWith('/opt_m1.gjf'))).toBe(true);
    expect(names).toContain('SHA256SUMS');
    expect(names).toContain('manifest.json');
  });

  it('still writes the report when one record fails, and names the failure', async () => {
    const { queuesRoot, exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName.includes('m2') ? { throw: 'engine lost the record' } : {}),
    });
    const queue = await runProject({ project: projectWithOutput({ records: 2 }), exe, queueManager });
    expect(queue.status).toBe('partial');
    expect(queue.tasks.find((task) => task.nodeId === 'opt~m2').status).toBe('failed');

    const out = queue.tasks.find((task) => task.nodeId === 'out1');
    expect(out.status).toBe('completed');
    const html = await fsp.readFile(path.join(queuesRoot, queue.id, 'artifacts', 'reports', 'barrier.html'), 'utf8');
    expect(html).toContain('Record — molecule 1');
    expect(html).toContain('Record — molecule 2');
    expect(html).toContain('Records needing attention');
    expect(html).toContain('engine lost the record');
  });
});

describe('artifact paths', () => {
  it('refuses a path outside the artifact root', () => {
    const root = path.join(os.tmpdir(), 'gns-artifact-root');
    expect(resolveArtifactPath(root, 'reports/x.html')).toBe(path.join(root, 'reports', 'x.html'));
    expect(() => resolveArtifactPath(root, '../x.html')).toThrow(/escapes/);
    expect(() => resolveArtifactPath(root, '../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveArtifactPath(root, '/etc/passwd')).toThrow(/escapes/);
  });

  it('refuses an output block whose declared path escapes, before anything runs', async () => {
    const { exe, queueManager } = await makeStack();
    const plan = buildWorkflowPlan(projectWithOutput({ records: 2 }));
    const output = plan.tasks.find((task) => task.type === 'output');
    output.output.path = '../escape.html';
    await expect(queueManager.start({
      projectName: 'escape',
      tasks: plan.tasks,
      edges: plan.edges,
      options: { executable: exe, scratchDir: '' },
    })).rejects.toThrow(/stay inside the output folder/);
  });
});
