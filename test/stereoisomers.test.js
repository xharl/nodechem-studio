import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { QueueManager } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';
import { validateProject } from '../src/shared/projectSchema.js';
import {
  normalizeStereoisomerOptions,
  normalizeStereoisomerResult,
  stereoisomerSummary,
} from '../src/shared/stereoisomers.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * ADR 0003 §3.5 — stereoisomer candidates.
 *
 * The answer is a real RDKit recording: four configurations, one identical to
 * the input and therefore carrying its coordinates, three re-embedded. No
 * energies are assigned at this stage.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chem/stereoisomers.json', import.meta.url), 'utf8'));

const atoms = [
  { element: 'C', x: 0.0, y: 0.0, z: 0.0 },
  { element: 'C', x: 1.5, y: 0.0, z: 0.0 },
  { element: 'Cl', x: 2.1, y: 1.2, z: 0.0 },
  { element: 'C', x: 2.2, y: -1.0, z: 0.0 },
  { element: 'F', x: 3.4, y: -1.4, z: 0.0 },
  { element: 'Br', x: 1.4, y: -2.0, z: 0.0 },
  { element: 'H', x: -0.4, y: 1.0, z: 0.0 },
  { element: 'H', x: -0.4, y: -1.0, z: 0.0 },
  { element: 'H', x: -0.4, y: 0.0, z: 1.0 },
];

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-stereo-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queueManager };
}

async function fakeChem(base) {
  const answerPath = path.join(base, 'answer.json');
  await fsp.writeFile(answerPath, JSON.stringify(fixture), 'utf8');
  const script = path.join(base, 'fake-stereo.js');
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
    nodeId: 'stereo',
    type: 'generate',
    title: 'Stereoisomers',
    kind: 'Generate',
    executable: true,
    inputName: 'stereo.xyz',
    outputName: 'stereoisomers.json',
    inputText: [`${atoms.length}`, 'starting geometry', ...atoms.map((atom) => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`)].join('\n') + '\n',
    generate: {
      source: 'search',
      generator: 'rdkit',
      produces: 'stereoisomers',
      maxConformers: 16,
      seed: 1,
      energyWindowKcal: 10,
      rmsdThreshold: 0.5,
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

describe('stereoisomer options and summary', () => {
  it('defaults to sixteen candidates and refuses an out-of-range cap', () => {
    expect(normalizeStereoisomerOptions({})).toEqual({ maxCandidates: 16, seed: 1 });
    expect(() => normalizeStereoisomerOptions({ maxCandidates: 0 })).toThrow(/maxCandidates/);
    expect(() => normalizeStereoisomerOptions({ maxCandidates: 129 })).toThrow(/maxCandidates/);
  });

  it('keeps the geometry policy and assigns no energies', () => {
    const result = normalizeStereoisomerResult(fixture);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates[0].geometry.source).toBe('input');
    expect(result.candidates.slice(1).every((candidate) => candidate.geometry.source === 'etkdgv4')).toBe(true);
    const summary = stereoisomerSummary({ result });
    expect(summary.produces).toBe('stereoisomers');
    expect(summary.members.every((member) => member.energyKcal === null && member.population === null)).toBe(true);
    expect(summary.warnings[0].message).toMatch(/distinct molecules/);
    expect(summary.stereoisomers).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('refuses a duplicate SMILES in the answer', () => {
    const answer = JSON.parse(JSON.stringify(fixture));
    answer.result.candidates[1].smiles = answer.result.candidates[0].smiles;
    expect(() => normalizeStereoisomerResult(answer)).toThrow(/duplicates/);
  });
});

describe('stereoisomer schema', () => {
  const project = (settings) => ({
    schemaVersion: 3,
    name: 'Stereo',
    molecule: { charge: 0, multiplicity: 1, fragments: [], coords: atoms, geometry: { source: 'imported', file: 'x.xyz', format: 'xyz' } },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [{ id: 'stereo', type: 'generate', title: 'Stereo', state: 'ready', x: 0, y: 0, settings }],
    edges: [],
  });

  it('accepts produces stereoisomers only with the rdkit generator', () => {
    const ok = validateProject(project({ produces: 'stereoisomers', generator: 'rdkit', fanOut: true }));
    expect(ok.errors).toEqual([]);
    expect(ok.project.nodes[0].settings.produces).toBe('stereoisomers');
    expect(ok.project.nodes[0].settings.maxConformers).toBe(16);

    const wrong = validateProject(project({ produces: 'stereoisomers', generator: 'crest' }));
    expect(wrong.errors.some((error) => /must be "rdkit"/.test(error.message))).toBe(true);
  });
});

describe('stereoisomers through the queue', () => {
  it('writes the candidate set without energies and preserves geometry sources', async () => {
    const { base, queueManager } = await stack();
    const script = await fakeChem(base);
    const started = await queueManager.start({
      projectName: 'stereoisomers',
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
    const task = done.tasks.find((entry) => entry.nodeId === 'stereo');
    expect(task.error).toBeNull();
    expect(task.status).toBe('completed');
    expect(task.ensemble.produces).toBe('stereoisomers');
    expect(task.ensemble.count).toBe(4);
    expect(task.ensemble.members[0].geometry.source).toBe('input');
    expect(task.ensemble.members[1].geometry.source).toBe('etkdgv4');
    const record = JSON.parse(await fsp.readFile(path.join(task.runDir, 'conformers.json'), 'utf8'));
    expect(record.members.every((member) => member.energyKcal === null)).toBe(true);
    const request = JSON.parse(await fsp.readFile(path.join(base, 'seen-request.json'), 'utf8'));
    expect(request.op).toBe('stereoisomers');
    expect(request.options.maxCandidates).toBe(16);
  });

  it('refuses a dry run rather than fabricating molecules', async () => {
    const { base, queueManager } = await stack();
    const script = await fakeChem(base);
    const started = await queueManager.start({
      projectName: 'stereoisomers dry',
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
    const task = done.tasks.find((entry) => entry.nodeId === 'stereo');
    expect(task.status).toBe('failed');
    expect(task.refusal?.code).toBe('stereoisomer-dry-run');
    await expect(fsp.stat(path.join(base, 'seen-request.json'))).rejects.toThrow();
  });
});
