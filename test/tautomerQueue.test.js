import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * Issue #226 — tautomer enumeration through a sidecar, in the queue.
 *
 * CI has no RDKit, so every test here uses a fake sidecar that replays the
 * committed RDKit fixture through the same JSON protocol. The point of these
 * tests is not the chemistry (that is `tautomers.test.js`); it is that the queue
 * fans the candidates out, records their provenance, and refuses loudly when
 * the enumerator is missing or returns nothing — never falling back to the
 * input geometry.
 */

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/tautomers/acetylacetone.json', import.meta.url),
  'utf8',
));
const xyz = readFileSync(new URL('./fixtures/tautomers/acetylacetone.xyz', import.meta.url), 'utf8');

const roots = [];

const atomsOfXyz = () => xyz
  .split('\n')
  .slice(2)
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts.length >= 4)
  .map(([element, x, y, z]) => ({ element, x: Number(x), y: Number(y), z: Number(z) }));

const coords = atomsOfXyz();

function project(nodes, edges = []) {
  const result = validateProject({
    schemaVersion: 3,
    name: 'Tautomer queue',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords,
      geometry: { source: 'imported', file: 'acetylacetone.xyz', format: 'xyz' },
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    nodes,
    edges,
    reports: [],
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

const generateNode = (settings = {}) => ({
  id: 'gen',
  type: 'generate',
  kind: 'Generate',
  title: 'Tautomers of acetylacetone',
  state: 'ready',
  x: 0,
  y: 0,
  settings: { produces: 'tautomers', ...settings },
  output: null,
});

const calcNode = (id = 'sp', title = 'Single point') => ({
  id,
  type: 'calculate',
  kind: 'SP',
  title,
  state: 'ready',
  x: 200,
  y: 0,
  settings: defaultSettings({ jobType: 'SP' }),
  output: null,
  checkpointFrom: null,
});

/** A fake sidecar that replays the fixture, or a supplied answer, from disk. */
async function fakeSidecar(base, answer = fixture) {
  const answerPath = path.join(base, 'answer.json');
  await fsp.writeFile(answerPath, JSON.stringify(answer), 'utf8');
  const script = path.join(base, 'fake-tautomer');
  await fsp.writeFile(script, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const answer = fs.readFileSync(${JSON.stringify(answerPath)}, 'utf8');`,
    'let request = "";',
    'process.stdin.on("data", (chunk) => { request += chunk; });',
    'process.stdin.on("end", () => {',
    '  fs.writeFileSync(process.env.NCS_FAKE_REQUEST || "seen-request.json", request);',
    '  process.stdout.write(answer);',
    '});',
  ].join('\n'), { mode: 0o755 });
  return script;
}

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-tautomer-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queueManager };
}

async function waitFor(check, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the queue');
}

async function runOne(queueManager, tasks, options) {
  const started = await queueManager.start({
    projectName: 'Tautomer queue',
    tasks,
    edges: [],
    options: { executable: null, crestExecutable: '', scratchDir: '', ...options },
  });
  return waitFor(async () => {
    const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
    return queue && queue.status !== 'running' ? queue : null;
  });
}

afterEach(async () => {
  while (roots.length > 0) {
    await rmrf(roots.pop());
  }
});

describe('tautomer enumeration in the queue (#226)', () => {
  it('enumerates through the sidecar, records provenance, and fans out one task per candidate', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeSidecar(base);
    const p = project([generateNode(), calcNode()]);
    const plan = buildWorkflowPlan(p);
    const generateTask = plan.tasks.find((task) => task.nodeId === 'gen');
    expect(generateTask.generate.produces).toBe('tautomers');
    expect(generateTask.generate.generator).toBe('rdkit');
    expect(generateTask.generate.method).toBe('');
    expect(generateTask.outputName).toBe('tautomers.json');
    expect(generateTask.generate.argv).toEqual([]);

    const done = await runOne(queueManager, [generateTask], {
      dryRun: false,
      tautomerExecutable: process.execPath,
      tautomerScript: sidecar,
    });
    const task = done.tasks.find((entry) => entry.nodeId === 'gen');
    expect(task.error).toBeNull();
    expect(task.status).toBe('completed');
    const ensemble = task.ensemble;
    expect(ensemble.produces).toBe('tautomers');
    expect(ensemble.generator).toBe('rdkit');
    expect(ensemble.count).toBe(5);
    expect(ensemble.tautomers).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(ensemble.members.map((member) => member.smiles)).toEqual(
      fixture.candidates.map((candidate) => candidate.smiles),
    );
    // No energy, no population: the candidates are distinct molecules, and a
    // number here would be a force-field ranking masquerading as an answer.
    expect(ensemble.members.every((member) => member.energyEh === null)).toBe(true);
    expect(ensemble.members.every((member) => member.population === null)).toBe(true);
    expect(ensemble.spreadKcal).toBeNull();
    // Provenance: version, ruleset, options and the digest of the geometry.
    expect(ensemble.origin.program).toBe('RDKit');
    expect(ensemble.origin.version).toBe(fixture.version);
    expect(ensemble.origin.ruleset).toBe('rdkit-default');
    expect(ensemble.origin.options.maxCandidates).toBe(16);
    expect(ensemble.origin.sourceSha256).toMatch(/^[0-9a-f]{64}$/);

    const dir = task.runDir;
    for (const name of ['conformers.json', 'tautomers.json', 'tautomers.xyz', 'request.json']) {
      await expect(fsp.stat(path.join(dir, name))).resolves.toBeTruthy();
    }
    const stored = JSON.parse(await fsp.readFile(path.join(dir, 'conformers.json'), 'utf8'));
    expect(stored.tautomers).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // The raw answer is kept, so a reader can check the curated summary.
    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'tautomers.json'), 'utf8'));
    expect(raw.protocol).toBe('nodechem-tautomers/1');
    expect(raw.candidates).toHaveLength(5);
    const request = JSON.parse(await fsp.readFile(path.join(dir, 'request.json'), 'utf8'));
    expect(request.options.ruleset).toBe('rdkit-default');
    expect(request.options.maxCandidates).toBe(16);
    expect(request.atoms).toHaveLength(15);
    expect(request.charge).toBe(0);
    expect(request.multiplicity).toBe(1);

    // Fan-out: the stored ensemble, re-attached to the block, becomes one
    // calculate task per candidate — through the existing member mechanism.
    const withOutput = project([
      { ...generateNode(), output: ensemble },
      calcNode('sp', 'Single point'),
    ], [{ id: 'e1', from: 'gen', to: 'sp', type: 'dependency' }]);
    const fanPlan = buildWorkflowPlan(withOutput);
    const calcs = fanPlan.tasks.filter((entry) => entry.type === 'calculate');
    expect(calcs).toHaveLength(5);
    expect(calcs.map((entry) => entry.fanOut.memberId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(calcs.map((entry) => entry.title)).toEqual([
      'Single point — c1 (t1)',
      'Single point — c2 (t2)',
      'Single point — c3 (t3)',
      'Single point — c4 (t4)',
      'Single point — c5 (t5)',
    ]);
    const generated = fanPlan.tasks.filter((entry) => entry.type === 'generate');
    expect(generated).toHaveLength(5);
    expect(generated.map((entry) => entry.generate.member.tautomer)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(new Set(generated.map((entry) => entry.inputText)).size).toBe(5);
    expect(calcs[0].inputText).toContain('O ');
  });

  it('carries each tautomer member forward without re-running the enumerator', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeSidecar(base);
    const p = project([generateNode(), calcNode()], [{ id: 'e1', from: 'gen', to: 'sp', type: 'dependency' }]);
    const generateTask = buildWorkflowPlan(p).tasks.find((task) => task.nodeId === 'gen');
    const done = await runOne(queueManager, [generateTask], {
      dryRun: false,
      tautomerExecutable: process.execPath,
      tautomerScript: sidecar,
    });
    const ensemble = done.tasks.find((entry) => entry.nodeId === 'gen').ensemble;

    const withOutput = project([
      { ...generateNode(), output: ensemble },
      calcNode('sp', 'Single point'),
    ], [{ id: 'e1', from: 'gen', to: 'sp', type: 'dependency' }]);
    const memberTasks = buildWorkflowPlan(withOutput).tasks.filter((task) => task.type === 'generate');
    expect(memberTasks).toHaveLength(5);

    // No sidecar: a member is carried from the stored ensemble, not searched.
    const carried = await runOne(queueManager, memberTasks, { dryRun: false });
    for (const task of carried.tasks.filter((entry) => entry.type === 'generate')) {
      expect(task.error).toBeNull();
      expect(task.status).toBe('completed');
      expect(task.ensemble.produces).toBe('tautomers');
      expect(task.ensemble.tautomers).toEqual([task.conformer.tautomer]);
      expect(task.conformer.tautomer).toMatch(/^t[1-5]$/);
      const stored = JSON.parse(await fsp.readFile(path.join(task.runDir, 'conformers.json'), 'utf8'));
      expect(stored.members[0].tautomer).toBe(task.conformer.tautomer);
      expect(stored.members[0].energyEh).toBeNull();
    }
  });

  it('refuses a dry run instead of fabricating a tautomer set', async () => {
    const { queueManager } = await stack();
    const p = project([generateNode()]);
    const generateTask = buildWorkflowPlan(p).tasks.find((task) => task.nodeId === 'gen');
    const done = await runOne(queueManager, [generateTask], { dryRun: true });
    const task = done.tasks.find((entry) => entry.nodeId === 'gen');
    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('tautomer-dry-run');
    expect(task.error).toMatch(/cannot enumerate tautomers/);
    expect(task.ensemble).toBeNull();
    // Nothing was written that could be mistaken for an ensemble.
    const dir = path.join(queueManager.queueDir(done.id), 'generate', 'gen');
    await expect(fsp.stat(path.join(dir, 'conformers.json'))).rejects.toThrow();
  });

  it('refuses at start when no sidecar is configured', async () => {
    const { queueManager } = await stack();
    const p = project([generateNode()]);
    const generateTask = buildWorkflowPlan(p).tasks.find((task) => task.nodeId === 'gen');
    await expect(queueManager.start({
      projectName: 'Tautomer queue',
      tasks: [generateTask],
      edges: [],
      options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
    })).rejects.toThrow(/tautomer sidecar/i);
  });

  it('refuses zero candidates and records the code', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeSidecar(base, { ...fixture, candidates: [] });
    const p = project([generateNode()]);
    const generateTask = buildWorkflowPlan(p).tasks.find((task) => task.nodeId === 'gen');
    const done = await runOne(queueManager, [generateTask], {
      dryRun: false,
      tautomerExecutable: process.execPath,
      tautomerScript: sidecar,
    });
    const task = done.tasks.find((entry) => entry.nodeId === 'gen');
    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('no-candidates');
    expect(task.error).toMatch(/zero candidates/);
    expect(task.ensemble).toBeNull();
    const dir = path.join(queueManager.queueDir(done.id), 'generate', 'gen');
    // The refusal answer is kept as evidence, but no ensemble was produced.
    const raw = JSON.parse(await fsp.readFile(path.join(dir, 'tautomers.json'), 'utf8'));
    expect(raw.candidates).toEqual([]);
    await expect(fsp.stat(path.join(dir, 'conformers.json'))).rejects.toThrow();
  });

  it('refuses another protocol instead of reading the answer as empty', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeSidecar(base, { ...fixture, protocol: 'nodechem-tautomers/9' });
    const p = project([generateNode()]);
    const generateTask = buildWorkflowPlan(p).tasks.find((task) => task.nodeId === 'gen');
    const done = await runOne(queueManager, [generateTask], {
      dryRun: false,
      tautomerExecutable: process.execPath,
      tautomerScript: sidecar,
    });
    const task = done.tasks.find((entry) => entry.nodeId === 'gen');
    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('protocol-mismatch');
    expect(task.error).toMatch(/protocol/);
  });

  it('honours the candidate cap from the block', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeSidecar(base);
    const p = project([generateNode({ maxConformers: 3 })]);
    const generateTask = buildWorkflowPlan(p).tasks.find((task) => task.nodeId === 'gen');
    expect(generateTask.generate.maxConformers).toBe(3);
    const done = await runOne(queueManager, [generateTask], {
      dryRun: false,
      tautomerExecutable: process.execPath,
      tautomerScript: sidecar,
    });
    // The fixture carries five candidates; a cap of three is a protocol
    // violation, not a silent truncation, so the block refuses.
    const task = done.tasks.find((entry) => entry.nodeId === 'gen');
    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('cap-exceeded');
  });
});

describe('tautomer schema round-trip (#226)', () => {
  const projectWith = (settings, output = null) => ({
    schemaVersion: 3,
    name: 'Tautomer schema',
    molecule: { charge: 0, multiplicity: 1, fragments: [], coords, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [{ ...generateNode(settings), output }],
    edges: [],
    reports: [],
  });

  it('normalizes the tautomer settings the mode owns', () => {
    const result = validateProject(projectWith({}));
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const settings = result.project.nodes[0].settings;
    expect(settings.produces).toBe('tautomers');
    expect(settings.generator).toBe('rdkit');
    expect(settings.source).toBe('search');
    expect(settings.method).toBe('');
    expect(settings.rankBy).toBe('');
    expect(settings.fanOut).toBe(true);
    expect(settings.maxConformers).toBe(16);
    expect(settings.tautomerRuleset).toBe('rdkit-default');
  });

  it('survives validate → serialise → validate unchanged', () => {
    const first = validateProject(projectWith({ maxConformers: 8 }));
    expect(first.errors).toEqual([]);
    const text = JSON.stringify(first.project);
    const second = validateProject(JSON.parse(text));
    expect(second.errors).toEqual([]);
    expect(JSON.stringify(second.project)).toBe(text);
  });

  it('keeps an enumerated ensemble round-trip stable', () => {
    const summary = {
      generator: 'rdkit',
      produces: 'tautomers',
      method: '',
      energyUnit: 'hartree',
      energyMethod: '',
      mixedEnergies: false,
      origin: {
        program: 'RDKit',
        version: '2026.9.1',
        method: 'TautomerEnumerator · rdkit-default',
        sourceSha256: 'a'.repeat(64),
        ruleset: 'rdkit-default',
        protocol: 'nodechem-tautomers/1',
        options: { maxCandidates: 16, maxTransforms: 1000, relaxGeometry: true, removeSp3Stereo: false, removeBondStereo: false },
      },
      group: '',
      count: 2,
      total: 2,
      spreadKcal: null,
      pruned: { energy: 0, rmsd: 0, count: 0 },
      warnings: [{ id: 'tautomer-distinct-molecules', status: 'warn', message: 'distinct molecules' }],
      requiresSelection: true,
      autoSelected: false,
      protomers: [],
      tautomers: ['t1', 't2'],
      truncated: false,
      selectedId: '',
      selected: null,
      members: [
        {
          id: 'c1', rank: 1, tautomer: 't1', smiles: 'C=C(O)CC(C)=O', formula: 'C5H8O2',
          energyEh: null, energyKcal: null, energyUnit: 'hartree', energyMethod: '',
          relativeKcal: null, population: null, rmsdToLowest: null, protomer: '',
          kept: true, dropped: null, atoms: coords,
        },
        {
          id: 'c2', rank: 2, tautomer: 't2', smiles: 'CC(=O)CC(C)=O', formula: 'C5H8O2',
          energyEh: null, energyKcal: null, energyUnit: 'hartree', energyMethod: '',
          relativeKcal: null, population: null, rmsdToLowest: null, protomer: '',
          kept: true, dropped: null, atoms: coords,
        },
      ],
    };
    const first = validateProject(projectWith({}, summary));
    expect(first.errors, JSON.stringify(first.errors)).toEqual([]);
    const stored = first.project.nodes[0].output;
    expect(stored.produces).toBe('tautomers');
    expect(stored.tautomers).toEqual(['t1', 't2']);
    expect(stored.origin.ruleset).toBe('rdkit-default');
    expect(stored.origin.options.maxCandidates).toBe(16);
    expect(stored.members[0].tautomer).toBe('t1');
    expect(stored.members[0].relativeKcal).toBeNull();
    const text = JSON.stringify(first.project);
    const second = validateProject(JSON.parse(text));
    expect(second.errors).toEqual([]);
    expect(JSON.stringify(second.project)).toBe(text);
  });

  it('refuses a tautomer block that names another generator or an import', () => {
    const wrongGenerator = validateProject(projectWith({ generator: 'crest' }));
    expect(wrongGenerator.errors.some((error) => /must be "rdkit"/.test(error.message))).toBe(true);
    const imported = validateProject(projectWith({ source: 'imported' }));
    expect(imported.errors.some((error) => /must be "search"/.test(error.message))).toBe(true);
    const scored = validateProject(projectWith({ rankBy: 'ml:aimnet2' }));
    expect(scored.errors.some((error) => /not supported for a tautomer block/.test(error.message))).toBe(true);
  });

  it('refuses an rdkit conformer search, which this build does not implement', () => {
    const result = validateProject(projectWith({ produces: 'conformers', generator: 'rdkit' }));
    expect(result.errors.some((error) => /only wired for tautomer enumeration/.test(error.message))).toBe(true);
  });

  it('does not add a produces key to a conformer block', () => {
    const result = validateProject(projectWith({ produces: 'conformers' }));
    expect(result.errors).toEqual([]);
    // The conformer block chose "conformers" explicitly, so the key stays —
    // but a block that says nothing about produces must serialise as before.
    const silent = validateProject({
      ...projectWith({}),
      nodes: [{ ...generateNode({}), settings: {} }],
    });
    expect(silent.errors).toEqual([]);
    expect('produces' in silent.project.nodes[0].settings).toBe(false);
  });
});
