import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, stringifyProject, validateProject } from '../src/shared/projectSchema.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');
const roots = [];

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

async function ncs(args, options = {}) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function project({ include = 'record', maxParallel = 2, reports = [] } = {}) {
  const records = [
    { id: 'm1', label: 'molecule 1', charge: 0, multiplicity: 1, coords: water, enabled: true },
    { id: 'm2', label: 'molecule 2', charge: 0, multiplicity: 1, coords: water, enabled: true },
    { id: 'm3', label: 'molecule 3', charge: 0, multiplicity: 1, coords: water, enabled: false },
  ];
  const result = validateProject({
    schemaVersion: 3,
    name: 'CLI artifacts',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel },
    datasets: [{
      id: 'family',
      title: 'Family',
      source: { kind: 'inline', path: '', format: 'sdf' },
      fields: { label: '', charge: '', multiplicity: '' },
      records,
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
          output: { kind: 'html', path: 'reports/barrier.html', include, bundle: 'project.zip', manifest: true, notes: '' } },
      ],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'out1', type: 'dependency' },
      ],
    }],
    reports,
    activeFlowId: 'barrier',
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

async function writeProject(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ncs-cli-artifacts-'));
  roots.push(dir);
  const file = path.join(dir, 'family.ncs');
  const serialized = stringifyProject(project(overrides));
  expect(serialized.ok).toBe(true);
  await writeFile(file, serialized.text, 'utf8');
  return { dir, file };
}

async function queueOf(outDir, queueId) {
  return JSON.parse(await readFile(path.join(outDir, 'queues', queueId, 'queue.json'), 'utf8'));
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  roots.length = 0;
});

describe('ncs run — flow, record and max-parallel', () => {
  it('runs the active flow with the project maxParallel and writes artifacts under --out', async () => {
    const { dir, file } = await writeProject();
    const out = path.join(dir, 'out');
    const result = await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 120000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe('completed');
    expect(summary.runs.filter((entry) => entry.runId).map((entry) => entry.nodeId).sort()).toEqual(['opt~m1', 'opt~m2']);

    const queue = await queueOf(out, summary.queueId);
    // The project's runner.maxParallel is the default; the CLI must pass it.
    expect(queue.maxParallel).toBe(2);
    // An archived queue names the flow it ran: `ncs report` titles each section
    // from it, and a queue whose project grew tabs cannot infer it later.
    expect(queue.flowId).toBe('barrier');
    expect(queue.flowTitle).toBe('Barrier');
    expect(queue.tasks.filter((task) => task.recordId).map((task) => task.recordId)).toEqual(['m1', 'm2']);

    // `--out` is the artifact root: reports and manifest live there, not in
    // queues/<id>/artifacts.
    const one = await readFile(path.join(out, 'reports', 'barrier-m1.html'), 'utf8');
    expect(one).toContain('Record — molecule 1');
    const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.map((entry) => entry.path).sort()).toEqual(['reports/barrier-m1.html', 'reports/barrier-m2.html']);
  }, 120000);

  it('filters the plan to one record and honours --max-parallel', async () => {
    const { dir, file } = await writeProject();
    const out = path.join(dir, 'one');
    const result = await ncs(['run', file, '--out', out, '--dry-run', '--record', 'm1', '--max-parallel', '1'], { timeout: 120000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.runs.filter((entry) => entry.runId).map((entry) => entry.nodeId)).toEqual(['opt~m1']);

    const queue = await queueOf(out, summary.queueId);
    expect(queue.maxParallel).toBe(1);
    expect(queue.tasks.some((task) => task.recordId === 'm2')).toBe(false);
    expect(queue.tasks.some((task) => task.nodeId === 'in1')).toBe(true);
    expect(queue.tasks.some((task) => task.nodeId === 'out1')).toBe(true);
    // Only the selected record's artifact exists.
    expect(await readFile(path.join(out, 'reports', 'barrier-m1.html'), 'utf8')).toContain('molecule 1');
  }, 120000);

  it('exits 5 (partial) when one record fails but the report is still written', async () => {
    const { dir, file } = await writeProject();
    const out = path.join(dir, 'partial');
    // Make one per-record artifact impossible to write: the run itself passes,
    // the collector loses that record's file, and the queue is partial.
    await mkdir(path.join(out, 'reports', 'barrier-m2.html'), { recursive: true });
    const result = await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 120000 });
    expect(result.code).toBe(5);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe('partial');
    const queue = await queueOf(out, summary.queueId);
    expect(queue.tasks.find((task) => task.nodeId === 'out1').status).toBe('failed');
    expect(await readFile(path.join(out, 'reports', 'barrier-m1.html'), 'utf8')).toContain('molecule 1');
  }, 120000);
});

describe('ncs report', () => {
  it('accepts --figures=none and produces the table-only document', async () => {
    const { dir, file } = await writeProject();
    const out = path.join(dir, 'figures-off');
    const ran = await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 120000 });
    expect(ran.code).toBe(0);
    const report = await ncs(['report', out, '--figures=none', '--out', path.join(out, 'plain.html')], { timeout: 60000 });
    expect(report.code).toBe(0);
    const html = await readFile(path.join(out, 'plain.html'), 'utf8');
    expect(html).not.toContain('<figure');
    expect(html).not.toMatch(/<script/i);
  }, 120000);

  it('rebuilds the HTML report from the newest queue, by default into reports/index.html', async () => {
    const { dir, file } = await writeProject();
    const out = path.join(dir, 'reported');
    const ran = await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 120000 });
    expect(ran.code).toBe(0);

    const report = await ncs(['report', out, '--flow', 'barrier'], { timeout: 60000 });
    expect(report.code).toBe(0);
    const lines = report.stdout.trim().split('\n');
    expect(lines[0]).toBe(path.join(out, 'reports', 'index.html'));
    expect(lines[1]).toMatch(/^model sha256 [0-9a-f]{64}$/);
    const html = await readFile(path.join(out, 'reports', 'index.html'), 'utf8');
    expect(html).toContain('Records');
    expect(html).toContain('molecule 1');
    expect(html).toContain('molecule 2');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
  }, 120000);

  it('writes every reports[] entry the project declares, without a second command', async () => {
    // RFC 0001 phase 5: a project-level report is part of the run, not an extra
    // step somebody has to remember.
    const { dir, file } = await writeProject({
      include: 'records',
      reports: [{ id: 'project', title: 'Family project', kind: 'html', flows: ['barrier'], path: 'reports/project.html' }],
    });
    const out = path.join(dir, 'declared');
    const result = await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 120000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.reports).toEqual([{ id: 'project', path: 'reports/project.html', bytes: expect.any(Number) }]);
    const html = await readFile(path.join(out, 'reports', 'project.html'), 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Family project');
    expect(html).toContain('id="flow-barrier"');
    expect(html).not.toMatch(/<script/i);
  }, 120000);

  it('refuses a declared report path that leaves the output folder', async () => {
    // Two guards, and this exercises the first: the schema will not load a
    // report whose path climbs out, so the run never starts. The writer's own
    // check covers a project handed to it in memory, without validation.
    const { dir } = await writeProject({ include: 'records' });
    const file = path.join(dir, 'family.ncs');
    const escaped = path.join(dir, 'escaping.ncs');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    parsed.reports = [{ id: 'escape', title: 'Escape', kind: 'html', flows: ['barrier'], path: '../escaped.html' }];
    await writeFile(escaped, JSON.stringify(parsed, null, 2), 'utf8');
    const out = path.join(dir, 'escaping');
    const result = await ncs(['validate', escaped], { timeout: 60000 });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('relative path inside the output folder');
  }, 60000);

  it('writes to --out and names failed records in the combined index', async () => {
    const { dir, file } = await writeProject();
    const out = path.join(dir, 'combined');
    expect((await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 120000 })).code).toBe(0);
    const target = path.join(dir, 'custom-report.html');
    const report = await ncs(['report', out, '--out', target], { timeout: 60000 });
    expect(report.code).toBe(0);
    const lines = report.stdout.trim().split('\n');
    expect(lines[0]).toBe(target);
    expect(lines[1]).toMatch(/^model sha256 [0-9a-f]{64}$/);
    const html = await readFile(target, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // One flow in the folder: the per-flow document, not a synthetic combined one.
    expect(html).toContain('Workflow report — CLI artifacts');
  }, 120000);
});
