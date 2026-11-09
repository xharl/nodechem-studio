import { describe, expect, it } from 'vitest';
import { artifactFor } from '../src/shared/artifactExport.js';
import { datasetCsv, datasetJson, runRows } from '../src/shared/datasetExport.js';

const QUEUE = {
  id: 'q-family',
  projectName: 'Enol family',
  flowId: 'barrier',
  flowTitle: 'Proton transfer barrier',
  status: 'partial',
  tasks: [
    {
      nodeId: 'opt~m1', recordId: 'm1', flowId: 'barrier', type: 'calculate', title: 'Optimise — one',
      status: 'completed', runId: 'run-1', record: { id: 'm1', label: 'one', charge: 0, multiplicity: 1 },
    },
    {
      nodeId: 'opt~m2', recordId: 'm2', flowId: 'barrier', type: 'calculate', title: 'Optimise — two',
      status: 'failed', runId: 'run-2', error: ' Error termination',
      record: { id: 'm2', label: 'two', charge: -1, multiplicity: 2 },
    },
  ],
};

const RECORDS = {
  'run-1': {
    id: 'run-1',
    status: 'completed',
    engine: 'gaussian',
    title: 'Optimise — one',
    finishedAt: '2026-11-08T01:00:00.000Z',
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.4 } },
    gates: { overall: 'pass', validity: { overall: 'pass' } },
  },
  'run-2': {
    id: 'run-2',
    status: 'failed',
    engine: 'gaussian',
    title: 'Optimise — two',
    finishedAt: '2026-11-08T01:02:00.000Z',
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.39 } },
    gates: { overall: 'fail', validity: { overall: 'unknown' } },
  },
};

const CONTEXT = { queue: QUEUE, records: RECORDS, entries: QUEUE.tasks, generatedAt: '2026-11-08T02:00:00.000Z', appVersion: 'cli' };

describe('artifactFor — csv and json', () => {
  it('writes the dataset CSV byte-for-byte and one row per run', () => {
    const artifact = artifactFor({ kind: 'csv', path: 'reports/dataset.csv' }, CONTEXT);
    expect(artifact.path).toBe('reports/dataset.csv');
    expect(Buffer.isBuffer(artifact.bytes)).toBe(true);
    expect(artifact.bytes.toString('utf8')).toBe(datasetCsv(runRows([RECORDS['run-1'], RECORDS['run-2']])));
    expect(artifact.bytes.toString('utf8').trimEnd().split('\n')).toHaveLength(3);
  });

  it('writes the versioned dataset JSON envelope', () => {
    const artifact = artifactFor({ kind: 'json', path: 'reports/dataset.json' }, CONTEXT);
    const payload = JSON.parse(artifact.bytes.toString('utf8'));
    expect(payload.kind).toBe('nodechem-studio.dataset');
    expect(payload.rowCount).toBe(2);
    expect(payload.appVersion).toBe('cli');
    expect(payload.rows.map((row) => row.id)).toEqual(['run-1', 'run-2']);
    expect(payload).toEqual(datasetJson(runRows([RECORDS['run-1'], RECORDS['run-2']]), {
      generatedAt: '2026-11-08T02:00:00.000Z',
      appVersion: 'cli',
    }));
  });

  it('refuses a path that climbs out of the artifact root', () => {
    expect(() => artifactFor({ kind: 'csv', path: '../escape.csv' }, CONTEXT)).toThrow(/relative/);
    expect(() => artifactFor({ kind: 'csv', path: '/tmp/escape.csv' }, CONTEXT)).toThrow(/relative/);
    expect(() => artifactFor({ kind: 'csv', path: 'reports/../../escape.csv' }, CONTEXT)).toThrow(/relative/);
  });
});

describe('artifactFor — HTML report', () => {
  it('groups the tasks per record and names the failed one', () => {
    const artifact = artifactFor({ kind: 'html', path: 'reports/barrier.html' }, CONTEXT);
    const html = artifact.bytes.toString('utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain('Records');
    expect(html).toContain('Record — one');
    expect(html).toContain('Record — two');
    expect(html).toContain('Error termination');
    expect(html).toContain('data-record="m1"');
    expect(html).toContain('data-record="m2"');
  });
});

describe('artifactFor — include: record', () => {
  it('writes one file per record with the record id before the extension', () => {
    const first = artifactFor(
      { kind: 'csv', path: 'reports/dataset.csv', include: 'record' },
      { ...CONTEXT, entries: [QUEUE.tasks[0]], recordId: 'm1' },
    );
    const second = artifactFor(
      { kind: 'csv', path: 'reports/dataset.csv', include: 'record' },
      { ...CONTEXT, entries: [QUEUE.tasks[1]], recordId: 'm2' },
    );
    expect(first.path).toBe('reports/dataset-m1.csv');
    expect(second.path).toBe('reports/dataset-m2.csv');
    expect(first.bytes.toString('utf8').trimEnd().split('\n')).toHaveLength(2);
    expect(first.bytes.toString('utf8')).toContain('run-1');
    expect(first.bytes.toString('utf8')).not.toContain('run-2');
  });

  it('refuses to mix records in one include-record artifact', () => {
    expect(() => artifactFor(
      { kind: 'csv', path: 'reports/dataset.csv', include: 'record' },
      CONTEXT,
    )).toThrow(/one record at a time/);
  });

  it('uses the caller record id when a record has no finished tasks', () => {
    const artifact = artifactFor(
      { kind: 'html', path: 'reports/barrier.html', include: 'record' },
      { ...CONTEXT, entries: [], recordId: 'm3' },
    );
    expect(artifact.path).toBe('reports/barrier-m3.html');
    expect(artifact.bytes.toString('utf8')).toContain('<!doctype html>');
  });
});

describe('artifactFor — zip', () => {
  it('stores the files the caller read, with UTF-8 names', () => {
    const artifact = artifactFor(
      { kind: 'zip', path: 'reports/project.zip' },
      { ...CONTEXT, files: [{ name: 'manifest.json', bytes: '{"files":[]}' }, { name: 'notes/ümlaut.txt', bytes: 'grüße' }] },
    );
    const bytes = artifact.bytes;
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.includes(Buffer.from('notes/ümlaut.txt', 'utf8'))).toBe(true);
    expect(bytes.includes(Buffer.from('manifest.json'))).toBe(true);
    const eocd = bytes.length - 22;
    expect(bytes.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(eocd + 10)).toBe(2);
  });
});
