import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { QueueManager } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';
import { withRunProvenance } from '../electron/runner/runProvenance.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { buildMethodsMarkdown } from '../src/shared/runBundle.js';

/**
 * Issue 193: a run record says which record a task ran and how that record was
 * derived.
 *
 * The assertions are made against `run.json` files written by the real queue
 * and the real RunManager, not against the object a helper returns, so a copy
 * that never reaches disk fails here. The absent-by-default case is asserted on
 * the key set (`'record' in obj === false`), because `null` would satisfy a
 * loose equality check and is exactly what this shape must never write.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'ncs.js');
const LEGACY_RECORD = path.join(ROOT, 'test', 'fixtures', 'run-record', 'gaussian-dry-run.json');
const run = promisify(execFile);

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/** Ethene as a repeat unit: one leaving H per carbon along the chain axis. */
const ethene = {
  id: 'ethene',
  label: 'Ethene',
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'C', x: 1.34, y: 0, z: 0 },
    { element: 'H', x: -0.54, y: 0.935, z: 0 },
    { element: 'H', x: -0.54, y: -0.935, z: 0 },
    { element: 'H', x: 1.88, y: 0.935, z: 0 },
    { element: 'H', x: 1.88, y: -0.935, z: 0 },
  ],
};
const etheneLinkage = { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [3, 6] };

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

/** A project with one input block feeding one single-point block. */
function project({ name, datasets, input, nodes = null }) {
  const result = validateProject({
    schemaVersion: 2,
    name,
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 3 },
    datasets,
    flows: [{
      id: 'main',
      title: name,
      nodes: [
        { id: 'in1', type: 'input', kind: input.kind || 'Input', title: input.title, state: 'ready', x: 0, y: 0, input: input.input },
        ...(nodes || [{
          id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 200, y: 0,
          settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null,
        }]),
      ],
      edges: [{ from: 'in1', to: 'sp', type: 'dependency' }],
    }],
    reports: [],
    activeFlowId: 'main',
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

function datasetProject() {
  const records = [1, 2, 3].map((n) => ({
    id: `m${n}`,
    label: `molecule ${n}`,
    charge: 0,
    multiplicity: 1,
    coords: water,
    enabled: true,
  }));
  return project({
    name: 'Family',
    datasets: [{
      id: 'family',
      title: 'Family',
      source: { kind: 'inline', path: '', format: 'sdf' },
      fields: { label: '', charge: '', multiplicity: '' },
      records,
      notes: '',
    }],
    input: { title: 'Family', input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
  });
}

function seriesProject() {
  return project({
    name: 'Series plan',
    datasets: [{
      id: 'units',
      title: 'Units',
      source: { kind: 'inline', path: '', format: 'sdf' },
      fields: { label: '', charge: '', multiplicity: '' },
      records: [{ ...ethene, enabled: true }],
      notes: '',
    }],
    input: {
      kind: 'series',
      title: 'Oligomers',
      input: {
        datasetId: 'units',
        recordFilter: { field: '', equals: '' },
        recordId: 'ethene',
        series: { from: 1, to: 3, linkage: { ...etheneLinkage, leaving: [...etheneLinkage.leaving] } },
      },
    },
  });
}

/** A project with no input block: one task on the project molecule. */
function singleProject() {
  const result = validateProject({
    schemaVersion: 2,
    name: 'Single',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{
      id: 'main',
      title: 'Single',
      nodes: [{
        id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 0, y: 0,
        settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null,
      }],
      edges: [],
    }],
    reports: [],
    activeFlowId: 'main',
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

/**
 * A dry run needs no engine binary, and the runner path is the production one:
 * `QueueManager` → `RunManager` → `run.json` on disk.
 */
async function runQueue(projectValue) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-provenance-'));
  roots.push(base);
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  await fsp.mkdir(runsRoot, { recursive: true });
  const queueManager = new QueueManager({
    queuesRoot,
    runManager: new RunManager({ runsRoot, emit: () => {} }),
    emit: () => {},
  });
  await queueManager.init();
  const plan = buildWorkflowPlan(projectValue);
  const started = await queueManager.start({
    projectName: projectValue.name,
    tasks: plan.tasks,
    edges: plan.edges,
    options: { dryRun: true, scratchDir: '' },
  });
  const deadline = Date.now() + 20000;
  let queue = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    queue = await queueManager.get(started.id);
    if (['completed', 'failed', 'needs-review', 'partial', 'cancelled'].includes(queue.status)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await queueManager.flush();
  if (!queue || queue.status === 'running') throw new Error('Timed out waiting for the queue');
  const records = [];
  for (const task of queue.tasks) {
    if (!task.runId || !task.runDir) continue;
    // eslint-disable-next-line no-await-in-loop
    const text = await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8');
    records.push({ task, text, record: JSON.parse(text) });
  }
  return { base, queue, records };
}

const byTask = (records, nodeId) => records.find((entry) => entry.task.nodeId === nodeId);

describe('run.json names the record it ran (issue 193)', () => {
  it('a 3-record dataset fan-out writes three records, each with its own id and dataset', async () => {
    const { records } = await runQueue(datasetProject());
    expect(records.map((entry) => entry.task.nodeId).sort()).toEqual(['sp~m1', 'sp~m2', 'sp~m3']);

    for (const entry of records) {
      const taskId = entry.task.nodeId.split('~')[1];
      expect(entry.record.record).toEqual({
        id: taskId,
        label: entry.task.record.label,
        datasetId: 'family',
      });
      // The identity is the task's, not a re-derivation from the id string.
      expect(entry.record.record.id).toBe(entry.task.record.id);
      // A plain dataset record is not a series member.
      expect('series' in entry.record).toBe(false);
    }
    // Three distinct identities, not one copied three times.
    expect(new Set(records.map((entry) => entry.record.record.id)).size).toBe(3);
  });

  it('a 3-member series writes n = 1,2,3 with one shared parent and the linkage rule', async () => {
    const { records } = await runQueue(seriesProject());
    expect(records).toHaveLength(3);
    const ordered = records
      .map((entry) => entry.record)
      .sort((a, b) => a.series.n - b.series.n);

    expect(ordered.map((record) => record.series.n)).toEqual([1, 2, 3]);
    expect(new Set(ordered.map((record) => record.series.parentId))).toEqual(new Set(['ethene']));
    for (const record of ordered) {
      expect(record.series.count).toBe(3);
      expect(record.series.linkage).toEqual({
        donor: etheneLinkage.donor,
        acceptor: etheneLinkage.acceptor,
        bondLengthAngstrom: etheneLinkage.bondLengthAngstrom,
        leaving: etheneLinkage.leaving,
      });
      // The member is a record in the series dataset, and says which.
      expect(record.record).toMatchObject({ datasetId: 'units' });
      expect(record.record.id).toBe(`ethene-n${record.series.n}`);
    }
  });

  it('a single-structure block writes neither key — absent, not null', async () => {
    const { records } = await runQueue(singleProject());
    expect(records).toHaveLength(1);
    const { record, text } = records[0];
    expect('record' in record).toBe(false);
    expect('series' in record).toBe(false);
    // Absent in the bytes too, so no reader can see a stray null.
    expect(text).not.toMatch(/"record":\s*null/);
    expect(text).not.toMatch(/"series":\s*null/);
    expect(record.record).toBeUndefined();
  });
});

describe('a pre-change run record is unchanged (issue 193)', () => {
  it('normalising a legacy run.json emits no new key and is byte-identical', async () => {
    const bytes = await fsp.readFile(LEGACY_RECORD, 'utf8');
    const legacy = JSON.parse(bytes);
    // The writer's only normalisation step for this shape: the provenance keys
    // are added only when the task carried them. A pre-change task carried none.
    const normalised = withRunProvenance(legacy, {});
    expect('record' in normalised).toBe(false);
    expect('series' in normalised).toBe(false);
    expect(Object.keys(normalised)).toEqual(Object.keys(legacy));
    expect(`${JSON.stringify(normalised, null, 2)}\n`).toBe(bytes);
  });

  it('adds the keys only for the source that is present', () => {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_RECORD, 'utf8'));
    const withRecord = withRunProvenance(legacy, { record: { id: 'm2', label: 'molecule 2', datasetId: 'family' } });
    expect(withRecord.record).toEqual({ id: 'm2', label: 'molecule 2', datasetId: 'family' });
    expect('series' in withRecord).toBe(false);

    const withSeries = withRunProvenance(legacy, {
      series: { parentId: 'ethene', n: 2, count: 3, linkage: etheneLinkage },
    });
    expect(withSeries.series).toMatchObject({ parentId: 'ethene', n: 2, count: 3 });
    expect('record' in withSeries).toBe(false);

    // A task that names neither — an empty object, a null, or a series with no
    // member number — adds nothing rather than a placeholder.
    for (const source of [undefined, {}, { record: null, series: null }, { series: { parentId: 'ethene' } }]) {
      const result = withRunProvenance(legacy, source);
      expect('record' in result).toBe(false);
      expect('series' in result).toBe(false);
    }
  });
});

describe('methods.md attributes the number to its record (issue 193)', () => {
  // The stored fixture is a dry run, and a methods paragraph refuses to describe
  // one. This is the same record with the fixture labels removed, so only the
  // provenance sentence under test changes.
  const base = () => {
    const record = JSON.parse(fs.readFileSync(LEGACY_RECORD, 'utf8'));
    record.dryRun = false;
    record.outputSource = 'file';
    record.provenance.kind = 'calculation';
    return record;
  };

  it('renders "record 3 of 6 from dataset *monomers*" and "the 3-mer of *ethene*"', () => {
    const record = base();
    record.record = { id: 'ethene-n3', label: 'Ethene · n=3', datasetId: 'monomers' };
    record.series = { parentId: 'ethene', n: 3, count: 6, linkage: etheneLinkage };
    const markdown = buildMethodsMarkdown(record);
    expect(markdown).toContain('record 3 of 6 from dataset *monomers*');
    expect(markdown).toContain('the 3-mer of *ethene*');
  });

  it('renders nothing for a record that carries neither key', () => {
    const markdown = buildMethodsMarkdown(base());
    expect(markdown).not.toContain('dataset');
    expect(markdown).not.toContain('-mer of');
    expect(markdown).not.toContain('**Record:**');
  });
});

describe('ncs export carries the new keys (issue 193)', () => {
  it('exports a run record with its record and series blocks verbatim', async () => {
    const base = JSON.parse(fs.readFileSync(LEGACY_RECORD, 'utf8'));
    base.id = 'provenance-export';
    base.record = { id: 'm3', label: 'molecule 3', datasetId: 'family' };
    base.series = { parentId: 'ethene', n: 3, count: 3, linkage: etheneLinkage };
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-provenance-export-'));
    roots.push(out);
    const dir = path.join(out, 'runs', base.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(base, null, 2)}\n`, 'utf8');

    const result = await run(process.execPath, [CLI, 'export', out, '--json'], { cwd: ROOT });
    const envelope = JSON.parse(result.stdout);
    const exported = envelope.records.find((record) => record.id === base.id);
    expect(exported.record).toEqual(base.record);
    expect(exported.series).toEqual(base.series);
  });
});
