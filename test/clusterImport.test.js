import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildGaussianInput, DEMO_WATER, outputNameFor } from '../src/shared/gaussianInput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';
import { planClusterExport } from '../src/shared/clusterExport.js';
import { writeClusterExport, importClusterExport } from '../electron/runner/clusterFiles.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';
import { RunManager } from '../electron/runner/runManager.js';
import { rmrf } from './helpers/tempCleanup.js';

const roots = [];

async function tempRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gn-cluster-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rmrf(root)));
  roots.length = 0;
});

function calcTask(nodeId, extra = {}) {
  const settings = defaultSettings(extra.settings || {});
  const inputName = `${nodeId}.gjf`;
  const inputText = buildGaussianInput({
    title: `Task ${nodeId}`,
    settings: { ...settings, charge: 0, multiplicity: 1 },
    molecule: { charge: 0, multiplicity: 1, coords: DEMO_WATER },
    inputName,
    oldCheckpoint: extra.checkpointFrom?.checkpoint || '',
  });
  return {
    nodeId,
    type: 'calculate',
    title: `Task ${nodeId}`,
    kind: 'Calc',
    executable: true,
    inputName,
    outputName: outputNameFor(inputName),
    inputText,
    gates: {
      expectedImaginary: null,
      minMagnitude: 50,
      requireOptimization: false,
      requireFrequency: false,
      requireThermochemistry: false,
      requireFinalEnergy: false,
      ...(extra.gates || {}),
    },
    checkpointName: settings.checkpoint || `${nodeId}.chk`,
    checkpointFrom: extra.checkpointFrom || null,
  };
}

async function makeExport({ tasks, edges = [], format = 'slurm', now = new Date('2026-11-07T12:00:00.000Z') } = {}) {
  const root = await tempRoot();
  const parent = path.join(root, 'exports');
  await fsp.mkdir(parent);
  const plan = planClusterExport({ format, projectName: 'Cluster import test', tasks, edges, createdAt: now.toISOString() });
  const written = await writeClusterExport({ parentDir: parent, format, files: plan.files, now });
  return { root, plan, dir: written.path };
}

describe('writeClusterExport', () => {
  it('writes a new folder next to the chosen parent and never overwrites', async () => {
    const root = await tempRoot();
    const parent = path.join(root, 'exports');
    await fsp.mkdir(parent);
    const now = new Date('2026-11-07T12:00:00.000Z');
    const files = [{ name: 'manifest.json', content: '{}\n' }, { name: 'submit-all.sh', content: '#!/bin/sh\n' }];
    const first = await writeClusterExport({ parentDir: parent, format: 'slurm', files, now });
    const second = await writeClusterExport({ parentDir: parent, format: 'slurm', files, now });
    expect(first.path).not.toBe(second.path);
    expect(path.basename(first.path)).toMatch(/^cluster-slurm-20261107-120000/);
    expect(await fsp.readFile(path.join(first.path, 'manifest.json'), 'utf8')).toBe('{}\n');
  });

  it('refuses path traversal and duplicate names from the renderer', async () => {
    const root = await tempRoot();
    const parent = path.join(root, 'exports');
    await fsp.mkdir(parent);
    await expect(writeClusterExport({
      parentDir: parent,
      format: 'slurm',
      files: [{ name: '../escape.sh', content: 'x' }],
    })).rejects.toThrow(/Unsafe/);
    await expect(writeClusterExport({
      parentDir: parent,
      format: 'slurm',
      files: [{ name: 'a.gjf', content: 'x' }, { name: 'a.gjf', content: 'y' }],
    })).rejects.toThrow(/Duplicate/);
  });
});

describe('importClusterExport', () => {
  it('turns returned outputs into run records with parsed termination and gates', async () => {
    const tasks = [
      calcTask('opt'),
      calcTask('freq', { gates: { expectedImaginary: 0, requireFrequency: true } }),
    ];
    const { root, dir } = await makeExport({
      tasks,
      edges: [{ from: 'opt', to: 'freq', type: 'dependency' }],
    });
    await fsp.writeFile(path.join(dir, 'freq.out'), makeFixtureOutput({ imaginary: 0 }), 'utf8');
    const runsRoot = path.join(root, 'runs');

    const result = await importClusterExport({
      exportDir: dir,
      runsRoot,
      now: new Date('2026-11-07T12:30:00.000Z'),
    });

    expect(result.runs).toHaveLength(1);
    expect(result.missing).toEqual([{ nodeId: 'opt', expected: 'opt.out' }]);
    const record = result.runs[0];
    expect(record.status).toBe('completed');
    expect(record.dryRun).toBe(false);
    expect(record.exitCode).toBeNull();
    expect(record.parsed.termination).toBe('Normal termination of Gaussian');
    expect(record.gates.overall).toBe('pass');
    expect(record.outputSource).toBe('cluster-import');
    expect(record.outputFile).toBe('freq.out');
    expect(record.provenance.source).toBe('cluster-import');
    expect(record.provenance.nodeId).toBe('freq');

    const runJson = JSON.parse(await fsp.readFile(path.join(runsRoot, record.id, 'run.json'), 'utf8'));
    expect(runJson.gates.overall).toBe('pass');
    expect(runJson.parsed.termination).toBe('Normal termination of Gaussian');

    // The imported run is a normal run folder: the app's run history lists it.
    const listed = await new RunManager({ runsRoot }).list();
    expect(listed.map((run) => run.id)).toEqual([record.id]);

    // The staged input travels with the record for provenance.
    const stagedInput = await fsp.readFile(path.join(runsRoot, record.id, 'freq.gjf'), 'utf8');
    expect(stagedInput).toContain('%NProcShared=4');
  });

  it('never turns an error termination into a pass', async () => {
    const tasks = [calcTask('freq')];
    const { root, dir } = await makeExport({ tasks });
    await fsp.writeFile(
      path.join(dir, 'freq.out'),
      ' Error termination via Lnk1e in C:\\\\G16W\\\\l502.exe\n',
      'utf8',
    );
    const result = await importClusterExport({ exportDir: dir, runsRoot: path.join(root, 'runs') });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].parsed.status).toBe('error');
    expect(result.runs[0].gates.overall).toBe('fail');
    expect(result.runs[0].status).toBe('failed');
  });

  it('applies the manifest gate set, so a frequency expectation can fail the import', async () => {
    const tasks = [calcTask('freq', { gates: { expectedImaginary: 1, requireFrequency: true } })];
    const { root, dir } = await makeExport({ tasks });
    await fsp.writeFile(path.join(dir, 'freq.out'), makeFixtureOutput({ imaginary: 0 }), 'utf8');
    const result = await importClusterExport({ exportDir: dir, runsRoot: path.join(root, 'runs') });
    expect(result.runs[0].gates.overall).toBe('fail');
    expect(result.runs[0].status).toBe('failed');
  });

  it('accepts a returned .log when the manifest expects .out', async () => {
    const tasks = [calcTask('freq')];
    const { root, dir } = await makeExport({ tasks });
    await fsp.writeFile(path.join(dir, 'freq.log'), makeFixtureOutput(), 'utf8');
    const result = await importClusterExport({ exportDir: dir, runsRoot: path.join(root, 'runs') });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].outputFile).toBe('freq.log');
    expect(result.runs[0].status).toBe('completed');
  });

  it('reports a missing output instead of fabricating a run', async () => {
    const tasks = [calcTask('opt'), calcTask('freq')];
    const { root, dir } = await makeExport({ tasks });
    const result = await importClusterExport({ exportDir: dir, runsRoot: path.join(root, 'runs') });
    expect(result.runs).toEqual([]);
    expect(result.missing).toEqual(expect.arrayContaining([
      { nodeId: 'opt', expected: 'opt.out' },
      { nodeId: 'freq', expected: 'freq.out' },
    ]));
    await expect(fsp.stat(path.join(root, 'runs'))).resolves.toBeTruthy();
  });

  it('rejects a folder that is not a cluster export', async () => {
    const root = await tempRoot();
    const empty = path.join(root, 'empty');
    await fsp.mkdir(empty);
    await expect(importClusterExport({ exportDir: empty, runsRoot: path.join(root, 'runs') }))
      .rejects.toThrow(/manifest\.json/);
  });

  it('keeps the import module free of network code', async () => {
    const source = await readFile(new URL('../electron/runner/clusterFiles.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:http|https|net|tls|dgram)['"]/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
