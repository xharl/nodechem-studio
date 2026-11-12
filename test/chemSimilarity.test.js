import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { QueueManager } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';
import { validateProject, defaultSettings } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import {
  normalizeSimilarityOptions,
  normalizeSimilarityResult,
  similaritySummary,
} from '../src/shared/chemSimilarity.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * ADR 0003 §3.7 — similarity over a dataset.
 *
 * The answer is a real RDKit recording of four molecules; the queue test uses
 * two records so the matrix it verifies is over exactly what was wired.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chem/similarity.json', import.meta.url), 'utf8'));

const atoms = [
  { element: 'C', x: 0.0, y: 0.0, z: 0.0 },
  { element: 'C', x: 1.4, y: 0.0, z: 0.0 },
  { element: 'O', x: 2.2, y: 1.0, z: 0.0 },
];

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-similarity-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queueManager };
}

function twoMoleculeAnswer() {
  const molecules = fixture.result.molecules.slice(0, 2);
  return {
    ...fixture,
    result: {
      molecules,
      matrix: [[1, 0.2727272727272727], [0.2727272727272727, 1]],
      clusters: [{ id: 'k1', members: [0] }, { id: 'k2', members: [1] }],
      pairs: [{ i: 0, j: 1, similarity: 0.2727272727272727 }],
      mcs: fixture.result.mcs,
    },
  };
}

async function fakeChem(base, answer) {
  const answerPath = path.join(base, 'answer.json');
  await fsp.writeFile(answerPath, JSON.stringify(answer), 'utf8');
  const script = path.join(base, 'fake-similarity.js');
  await fsp.writeFile(script, [
    "const fs = require('node:fs');",
    'let request = "";',
    'process.stdin.on("data", (chunk) => { request += chunk; });',
    'process.stdin.on("end", () => {',
    `  fs.writeFileSync(${JSON.stringify(path.join(base, 'seen-request.json'))}, request);`,
    `  process.stdout.write(fs.readFileSync(${JSON.stringify(answerPath)}, "utf8"));`,
    '});',
  ].join('\n'), 'utf8');
  return script;
}

function similarityQueue(base, runDirs, script) {
  return {
    id: 'q-sim',
    status: 'running',
    options: { dryRun: false, chemExecutable: process.execPath, chemScript: script },
    edges: [
      { from: 'run1', to: 'sim', type: 'dependency' },
      { from: 'run2', to: 'sim', type: 'dependency' },
    ],
    tasks: [
      { nodeId: 'run1', type: 'calculate', title: 'Molecule 1', status: 'completed', runDir: runDirs[0] },
      { nodeId: 'run2', type: 'calculate', title: 'Molecule 2', status: 'completed', runDir: runDirs[1] },
    ],
    currentTaskId: null,
  };
}

async function recordDirs(base, { emptySecond = false } = {}) {
  const dirs = [];
  for (const [index, id] of ['run1', 'run2'].entries()) {
    const dir = path.join(base, 'queues', 'q-sim', 'runs', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(emptySecond && index === 1
      ? { status: 'completed', parsed: {} }
      : { status: 'completed', title: `Molecule ${index + 1}`, parsed: { finalGeometry: { atoms } } }), 'utf8');
    dirs.push(dir);
  }
  return dirs;
}

function similarityTask() {
  return {
    nodeId: 'sim',
    type: 'analyse',
    title: 'Similarity',
    executable: false,
    analyse: {
      mode: 'similarity',
      options: normalizeSimilarityOptions({}),
      declared: [],
      sources: ['run1', 'run2'],
      status: 'pending',
    },
  };
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

describe('similarity options and answer', () => {
  it('validates the fingerprint, matrix shape and cluster members', () => {
    const result = normalizeSimilarityResult(fixture);
    expect(result.molecules).toHaveLength(4);
    expect(result.matrix[1][0]).toBe(result.matrix[0][1]);
    expect(result.clusters).toHaveLength(4);
    expect(result.mcs.timedOut).toBe(false);
    expect(similaritySummary(result)).toContain('4 molecules');

    expect(() => normalizeSimilarityOptions({ fingerprint: 'ecfp' })).toThrow(/fingerprint/);
    expect(() => normalizeSimilarityOptions({ nBits: 16 })).toThrow(/nBits/);
    expect(() => normalizeSimilarityOptions({ clusterCutoff: 2 })).toThrow(/clusterCutoff/);
  });

  it('refuses a matrix that does not match the molecule count', () => {
    const answer = JSON.parse(JSON.stringify(fixture));
    answer.result.matrix.pop();
    expect(() => normalizeSimilarityResult(answer)).toThrow(/does not match/);
  });
});

describe('similarity schema and planning', () => {
  const project = (edges) => ({
    schemaVersion: 3,
    name: 'Similarity',
    molecule: { charge: 0, multiplicity: 1, fragments: [], coords: atoms, geometry: { source: 'imported', file: 'x.xyz', format: 'xyz' } },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [
      { id: 'a', type: 'calculate', title: 'A', state: 'ready', x: 0, y: 0, settings: defaultSettings({ jobType: 'Opt' }) },
      { id: 'b', type: 'calculate', title: 'B', state: 'ready', x: 0, y: 0, settings: defaultSettings({ jobType: 'Opt' }) },
      { id: 'sim', type: 'analyse', title: 'Similarity', state: 'ready', x: 200, y: 0, analyse: { mode: 'similarity', similarity: { fingerprint: 'morgan' }, expression: '', inputs: [] } },
    ],
    edges,
  });

  it('accepts mode similarity and validates its options', () => {
    const validated = validateProject(project([
      { from: 'a', to: 'sim', type: 'dependency' }, { from: 'b', to: 'sim', type: 'dependency' },
    ]));
    expect(validated.errors).toEqual([]);
    expect(validated.project.nodes[2].analyse.mode).toBe('similarity');
    expect(validated.project.nodes[2].analyse.similarity.nBits).toBe(2048);

    const badProject = project([
      { from: 'a', to: 'sim', type: 'dependency' }, { from: 'b', to: 'sim', type: 'dependency' },
    ]);
    badProject.nodes[2].analyse.similarity = { nBits: 16 };
    const bad = validateProject(badProject);
    expect(bad.errors.some((error) => /analyse\.similarity/.test(error.path))).toBe(true);
  });

  it('refuses a block with fewer than two wired sources at plan time', () => {
    const validated = validateProject(project([{ from: 'a', to: 'sim', type: 'dependency' }]));
    expect(validated.errors).toEqual([]);
    expect(() => buildWorkflowPlan(validated.project)).toThrow(/at least two upstream blocks/);
  });

  it('plans one matrix task, not one per record', () => {
    const validated = validateProject(project([
      { from: 'a', to: 'sim', type: 'dependency' }, { from: 'b', to: 'sim', type: 'dependency' },
    ]));
    const plan = buildWorkflowPlan(validated.project);
    const tasks = plan.tasks.filter((task) => task.nodeId === 'sim');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].analyse.mode).toBe('similarity');
  });
});

describe('similarity through the queue', () => {
  it('writes one derived matrix record over every wired record', async () => {
    const { base, queueManager } = await stack();
    const dirs = await recordDirs(base);
    const script = await fakeChem(base, twoMoleculeAnswer());
    const queue = similarityQueue(base, dirs, script);
    const task = similarityTask();
    await queueManager.runSimilarity(queue, task);
    expect(task.error).toBeNull();
    expect(task.status).toBe('completed');
    expect(task.analyse.similarity.matrix).toHaveLength(2);
    expect(task.analyse.similarity.clusters).toHaveLength(2);
    expect(task.summary).toContain('2 molecules');
    const record = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
    expect(record.kind).toBe('derived');
    expect(record.similarity.matrix[0][1]).toBeCloseTo(0.2727, 3);
    const request = JSON.parse(await fsp.readFile(path.join(base, 'seen-request.json'), 'utf8'));
    expect(request.op).toBe('similarity');
    expect(request.molecules).toHaveLength(2);
  });

  it('refuses a record with no geometry rather than comparing a partial set', async () => {
    const { base, queueManager } = await stack();
    const dirs = await recordDirs(base, { emptySecond: true });
    const script = await fakeChem(base, twoMoleculeAnswer());
    const queue = similarityQueue(base, dirs, script);
    const task = similarityTask();
    await queueManager.runSimilarity(queue, task);
    expect(task.status).toBe('failed');
    expect(task.refusal?.message).toMatch(/no geometry/);
  });
});
