import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { QueueManager } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';
import { rmrf } from './helpers/tempCleanup.js';
import {
  RDKIT_CONFORMER_DEFAULTS,
  normalizeRdkitConformerOptions,
  normalizeRdkitConformerResult,
  rdkitConformerWarnings,
} from '../src/shared/rdkitConformers.js';

/**
 * ADR 0003 §3.4 — the RDKit conformer search.
 *
 * The sidecar answer is a real recording (aspirin, 2 unique geometries after
 * ETKDGv4 pruning). These tests hold the option bounds, the refusal contract and
 * the queue's use of the *existing* curation — the sidecar never decides what is
 * kept.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chem/conformers.json', import.meta.url), 'utf8'));

const atoms = [
  { element: 'C', x: 0.0, y: 0.0, z: 0.0 },
  { element: 'C', x: 1.4, y: 0.0, z: 0.0 },
  { element: 'O', x: 2.2, y: 1.0, z: 0.0 },
  { element: 'O', x: 1.4, y: -1.2, z: 0.0 },
  { element: 'H', x: -0.4, y: 0.9, z: 0.0 },
];

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-rdkit-conf-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queueManager };
}

async function fakeChem(base, answer) {
  const answerPath = path.join(base, 'answer.json');
  await fsp.writeFile(answerPath, JSON.stringify(answer), 'utf8');
  const script = path.join(base, 'fake-conformers.js');
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

function generateTask() {
  return {
    nodeId: 'conf',
    type: 'generate',
    title: 'Conformers',
    kind: 'Generate',
    executable: true,
    inputName: 'conf.xyz',
    outputName: 'rdkit.log',
    inputText: [`${atoms.length}`, 'starting geometry', ...atoms.map((atom) => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`)].join('\n') + '\n',
    generate: {
      source: 'search',
      generator: 'rdkit',
      method: 'MMFF94',
      nconf: 10,
      seed: 7,
      pruneRms: 0.3,
      forceField: 'MMFF94',
      maxHeavyAtoms: 60,
      threads: 1,
      energyWindowKcal: 10,
      rmsdThreshold: 0.5,
      maxConformers: 20,
      temperature: 298.15,
      spreadThresholdKcal: 2,
      charge: 0,
      multiplicity: 1,
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

describe('RDKit conformer options and answer', () => {
  it('defaults to fifty ETKDGv4 geometries and MMFF94, one thread', () => {
    expect(normalizeRdkitConformerOptions({})).toEqual({
      nconf: RDKIT_CONFORMER_DEFAULTS.nconf,
      seed: 1,
      pruneRms: 0.5,
      forceField: 'MMFF94',
      maxHeavyAtoms: 60,
      threads: 1,
    });
  });

  it('refuses out-of-range options instead of clamping them', () => {
    expect(() => normalizeRdkitConformerOptions({ nconf: 0 })).toThrow(/nconf/);
    expect(() => normalizeRdkitConformerOptions({ nconf: 201 })).toThrow(/nconf/);
    expect(() => normalizeRdkitConformerOptions({ maxHeavyAtoms: 101 })).toThrow(/maxHeavyAtoms/);
    expect(() => normalizeRdkitConformerOptions({ threads: 9 })).toThrow(/threads/);
    expect(() => normalizeRdkitConformerOptions({ forceField: 'B3LYP' })).toThrow(/forceField/);
    expect(() => normalizeRdkitConformerOptions({ pruneRms: -1 })).toThrow(/pruneRms/);
  });

  it('reads the recorded answer and names the force field in its origin', () => {
    const result = normalizeRdkitConformerResult(fixture);
    expect(result.embedding).toBe('ETKDGv4');
    expect(result.forceField).toBe('MMFF94');
    expect(result.conformers).toHaveLength(2);
    expect(result.origin.method).toBe('ETKDGv4 + MMFF94');
    expect(rdkitConformerWarnings(result).some((line) => /force-field search, not a CREST/.test(line))).toBe(true);
  });
});

describe('RDKit conformers through the queue', () => {
  it('writes conformers.json through the shared curation and records kcal/mol', async () => {
    const { base, queueManager } = await stack();
    const script = await fakeChem(base, fixture);
    const started = await queueManager.start({
      projectName: 'rdkit conformers',
      tasks: [generateTask()],
      edges: [],
      options: {
        dryRun: false, executable: null, crestExecutable: '', obabelExecutable: '',
        chemExecutable: process.execPath, chemScript: script, scratchDir: '',
      },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const task = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.error).toBeNull();
    expect(task.status).toBe('completed');
    expect(task.ensemble.generator).toBe('rdkit');
    expect(task.ensemble.energyUnit).toBe('kcal/mol');
    expect(task.ensemble.energyMethod).toBe('MMFF94');
    expect(task.ensemble.origin.method).toBe('ETKDGv4 + MMFF94');
    expect(task.ensemble.count).toBe(2);
    const record = JSON.parse(await fsp.readFile(path.join(task.runDir, 'conformers.json'), 'utf8'));
    expect(record.count).toBe(2);
    const request = JSON.parse(await fsp.readFile(path.join(base, 'seen-request.json'), 'utf8'));
    expect(request.op).toBe('conformers');
    expect(request.options.nconf).toBe(10);
    expect(request.options.forceField).toBe('MMFF94');
  });

  it('names a size refusal instead of returning a partial search', async () => {
    const { base, queueManager } = await stack();
    const script = await fakeChem(base, {
      protocol: 'nodechem-chem/1', op: 'conformers', ok: false,
      error: { code: 'size-refused', message: 'This molecule has 62 heavy atoms; the RDKit conformer search is capped at 60.' },
    });
    const started = await queueManager.start({
      projectName: 'rdkit conformers refused',
      tasks: [generateTask()],
      edges: [],
      options: {
        dryRun: false, executable: null, crestExecutable: '', obabelExecutable: '',
        chemExecutable: process.execPath, chemScript: script, scratchDir: '',
      },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const task = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.status).toBe('failed');
    expect(task.refusal?.code).toBe('size-refused');
    expect(task.error).toMatch(/capped at 60/);
  });

  it('never spawns in a dry run', async () => {
    const { base, queueManager } = await stack();
    const script = await fakeChem(base, fixture);
    const started = await queueManager.start({
      projectName: 'rdkit conformers dry',
      tasks: [generateTask()],
      edges: [],
      options: {
        dryRun: true, executable: null, crestExecutable: '', obabelExecutable: '',
        chemExecutable: process.execPath, chemScript: script, scratchDir: '',
      },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const task = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.status).toBe('completed');
    expect(task.ensemble.generator).toBe('fixture');
    await expect(fsp.stat(path.join(base, 'seen-request.json'))).rejects.toThrow();
  });
});
