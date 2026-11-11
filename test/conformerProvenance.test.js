import { describe, expect, it, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rmrf } from './helpers/tempCleanup.js';
import {
  DEFAULT_CONFORMER_SETTINGS,
  ensembleSummary,
  formatPopulation,
  parseMultiXyz,
  rankEnsemble,
  withEnergies,
} from '../src/shared/conformers.js';
import {
  defaultSettings,
  parseProjectText,
  stringifyProject,
  validateProject,
} from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, conformerSearchTask } from '../src/shared/workflowTasks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

/**
 * #129 and #130: an imported ensemble must say where it came from, and an
 * energy in kcal/mol must never be recorded — or shown — as a Hartree total.
 *
 * Every fixture here is synthetic. Nothing claims to come from Spartan: the
 * program and version strings are a made-up "Spartan-ish" label used to check
 * that a declared origin survives the round trip, not evidence that any file
 * was produced by that program.
 */

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/** Water at a given H–O–H angle: a real shape change, not a translation. */
const waterAt = (angleDeg) => {
  const a = (angleDeg * Math.PI) / 180;
  return [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.96, y: 0, z: 0 },
    { element: 'H', x: 0.96 * Math.cos(a), y: 0.96 * Math.sin(a), z: 0 },
  ];
};

const HASH = 'a'.repeat(64);
const IMPORT_ORIGIN = {
  program: 'SyntheticGaussLike',
  version: '26.1 (test)',
  method: 'MMFF94/DLFF03 (test)',
  sourceSha256: HASH,
};

const molecule = { charge: 0, multiplicity: 1, fragments: [], coords, geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' } };

const project = (nodes, edges = []) => ({
  schemaVersion: 3,
  name: 'Conformer provenance',
  molecule,
  defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
  nodes,
  edges,
});

const conformersNode = (settings = {}, output = null) => ({
  id: 'conf', type: 'generate', title: 'Conformer ensemble', state: 'ready', x: 0, y: 0, settings, output,
});

const ensembleInput = (overrides = {}) => ({
  id: 'ens', type: 'input', kind: 'Ensemble input', title: 'Imported ensemble', state: 'ready', x: 0, y: 0,
  input: {
    kind: 'ensemble',
    path: 'conf.xyz',
    format: 'xyz',
    energyUnit: 'hartree',
    energyMethod: '',
    origin: { program: '', version: '', method: '' },
    ...overrides,
  },
});

/** ADR 0001: an imported generate block is always paired with its input. */
const importedProject = (settings = {}, output = null, input = {}) => project(
  [ensembleInput(input), conformersNode({ source: 'imported', ...settings }, output)],
  [{ from: 'ens', to: 'conf', type: 'dependency' }],
);

const kcalMember = (id, rank, energyKcal, extra = {}) => ({
  id, rank, energyKcal, energyEh: null, energyUnit: 'kcal/mol', energyMethod: 'MMFF94',
  relativeKcal: 0, population: 0.5, rmsdToLowest: 0, protomer: '', kept: true, dropped: null, atoms: coords,
  ...extra,
});

const kcalSummary = (overrides = {}) => ({
  generator: 'import',
  method: '',
  energyUnit: 'kcal/mol',
  energyMethod: 'MMFF94',
  count: 2,
  total: 2,
  spreadKcal: 1.4,
  generatedAt: '2026-11-08T00:00:00.000Z',
  selectedId: 'c1',
  requiresSelection: false,
  autoSelected: true,
  protomers: [],
  pruned: { energy: 0, rmsd: 0, count: 0 },
  warnings: [],
  origin: { ...IMPORT_ORIGIN },
  members: [kcalMember('c1', 1, -120.4), kcalMember('c2', 2, -119.0)],
  selected: { id: 'c1', energyEh: null, energyKcal: -120.4, energyUnit: 'kcal/mol', energyMethod: 'MMFF94', relativeKcal: 0, population: 0.5, protomer: '', atoms: coords },
  ...overrides,
});

describe('#129 an imported ensemble keeps its origin', () => {
  it('survives a save/load round trip with the hash of the file it came from', () => {
    const saved = validateProject(importedProject({ energyWindowKcal: 10 }, kcalSummary(), {
      path: 'spartan_conf.xyz',
      energyUnit: 'kcal/mol',
      energyMethod: 'MMFF94',
      origin: { ...IMPORT_ORIGIN, sourceSha256: '' },
    }));
    expect(saved.ok).toBe(true);
    const text = stringifyProject(saved.project).text;
    const reloaded = parseProjectText(text);
    expect(reloaded.ok).toBe(true);
    const node = reloaded.project.nodes.find((entry) => entry.type === 'generate');
    const input = reloaded.project.nodes.find((entry) => entry.type === 'input');
    expect(node.output.origin).toEqual(IMPORT_ORIGIN);
    expect(node.output.energyUnit).toBe('kcal/mol');
    expect(node.output.energyMethod).toBe('MMFF94');
    expect(input.input.origin.program).toBe('SyntheticGaussLike');
    expect(input.input.origin.version).toBe('26.1 (test)');
    expect(input.input.energyUnit).toBe('kcal/mol');
  });

  it('refuses a sourceSha256 that is not a digest instead of storing a claim', () => {
    const bad = kcalSummary({ origin: { ...IMPORT_ORIGIN, sourceSha256: 'not-a-hash' } });
    const result = validateProject(importedProject({}, bad));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /sourceSha256/.test(error.path))).toBe(true);
  });

  it('keeps a declared origin on the block settings even before a run', () => {
    const result = validateProject(importedProject({}, null, {
      path: 'conf.xyz',
      origin: { program: 'SyntheticGaussLike', version: '26.1 (test)', method: 'MMFF94' },
    }));
    expect(result.ok).toBe(true);
    expect(result.project.nodes.find((entry) => entry.type === 'input').input.origin).toEqual({
      program: 'SyntheticGaussLike', version: '26.1 (test)', method: 'MMFF94', sourceSha256: '',
    });
  });
});

describe('#130 an energy unit and a method per member', () => {
  it('stores a kcal/mol energy in kcal/mol and leaves energyEh empty', () => {
    const summary = kcalSummary();
    const result = validateProject(importedProject({}, summary, { energyUnit: 'kcal/mol', energyMethod: 'MMFF94' }));
    expect(result.ok).toBe(true);
    const member = result.project.nodes.find((entry) => entry.type === 'generate').output.members[0];
    expect(member.energyUnit).toBe('kcal/mol');
    expect(member.energyMethod).toBe('MMFF94');
    expect(member.energyKcal).toBeCloseTo(-120.4, 6);
    expect(member.energyEh).toBeNull();
  });

  it('reads a legacy ensemble with no energyUnit as Hartree', () => {
    const legacy = {
      ...kcalSummary(),
      energyUnit: undefined,
      energyMethod: undefined,
      origin: undefined,
      members: [
        { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.9, rmsdToLowest: 0, protomer: '', kept: true, dropped: null, atoms: coords },
      ],
      selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 0.9, protomer: '', atoms: coords },
    };
    const result = validateProject(project([conformersNode({ generator: 'crest' }, legacy)]));
    expect(result.ok).toBe(true);
    const output = result.project.nodes[0].output;
    expect(output.energyUnit).toBe('hartree');
    expect(output.members[0].energyUnit).toBe('hartree');
    expect(output.members[0].energyEh).toBeCloseTo(-76.4, 6);
    expect(output.members[0].energyKcal).toBeNull();
    expect(output.origin.sourceSha256).toBe('');
  });

  it('ranks kcal/mol members without converting them into Hartree', () => {
    const near = waterAt(104.5);
    const far = waterAt(130);
    const parsed = parseMultiXyz([
      '3', 'E=-120.40 kcal/mol MMFF94', ...near.map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`),
      '3', 'E=-119.00 kcal/mol MMFF94', ...far.map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`),
      '',
    ].join('\n'));
    expect(parsed.errors).toEqual([]);
    const ranked = rankEnsemble({ frames: withEnergies(parsed.frames, []).frames, energyUnit: 'kcal/mol', energyMethod: 'MMFF94', rmsdThreshold: 0.05 });
    expect(ranked.error).toBeNull();
    expect(ranked.retained).toHaveLength(2);
    const [first, second] = ranked.retained;
    expect(first.energyUnit).toBe('kcal/mol');
    expect(first.energyMethod).toBe('MMFF94');
    expect(first.energyEh).toBeNull();
    expect(first.energyKcal).toBeCloseTo(-120.4, 6);
    // 1.4 kcal/mol is 1.4 kcal/mol; multiplying by 627.5 would invent a number.
    expect(second.relativeKcal).toBeCloseTo(1.4, 6);
    expect(first.relativeKcal).toBeCloseTo(0, 9);
    expect(second.population).toBeGreaterThan(0);
    expect(ranked.spreadKcal).toBeCloseTo(1.4, 6);
  });

  it('flags a mixed ensemble instead of averaging across methods', () => {
    // Two DFT frames in Hartree and one MM frame in kcal/mol: the numbers are
    // not comparable, so no population and no spread may be reported.
    const dft = (e, angle) => ({
      index: 0, comment: `energy: ${e}`, atoms: waterAt(angle), energyEh: e, protomer: '',
    });
    const mm = {
      index: 0, comment: 'E=-120.4 kcal/mol method=MMFF94', atoms: waterAt(150),
      energyEh: -120.4, energyUnit: 'kcal/mol', energyMethod: 'MMFF94', protomer: '',
    };
    const ranked = rankEnsemble({
      frames: [dft(-76.4, 100), dft(-76.3, 125), mm],
      energyWindowKcal: 100000,
      rmsdThreshold: 0.05,
      energyUnit: 'hartree',
      energyMethod: 'B3LYP/6-31G(d)',
    });
    expect(ranked.error).toBeNull();
    expect(ranked.retained).toHaveLength(3);
    expect(ranked.mixedEnergies).toBe(true);
    expect(ranked.members.map((member) => member.energyUnit)).toEqual(['hartree', 'hartree', 'kcal/mol']);
    expect(ranked.members.every((member) => member.population === null)).toBe(true);
    expect(ranked.spreadKcal).toBeNull();
    const warning = ranked.warnings.find((entry) => entry.id === 'conformer-mixed-energies');
    expect(warning).toBeTruthy();
    expect(warning.message).toMatch(/different energy units or methods/);
    expect(warning.message).toMatch(/not averaged/);
  });

  it('does not flag an ensemble whose members share a unit and method', () => {
    const ranked = rankEnsemble({
      frames: [
        { index: 1, atoms: coords, energyEh: -76.4, protomer: '' },
        { index: 2, atoms: coords.map((atom) => ({ ...atom, y: atom.y + 0.8 })), energyEh: -76.39, protomer: '' },
      ],
      rmsdThreshold: 0.05,
      energyUnit: 'hartree',
      energyMethod: 'GFN2-xTB',
    });
    expect(ranked.mixedEnergies).toBe(false);
    expect(ranked.members.every((member) => Number.isFinite(member.population))).toBe(true);
    expect(ranked.warnings.some((entry) => entry.id === 'conformer-mixed-energies')).toBe(false);
  });
});

describe('the ensemble summary carries provenance', () => {
  it('records a generated ensemble as crest with a Hartree unit', () => {
    const ranked = rankEnsemble({
      frames: [{ index: 1, atoms: coords, energyEh: -76.4, protomer: '' }],
      rmsdThreshold: 0.05,
    });
    const summary = ensembleSummary(ranked, { generator: 'crest', method: 'gfn2' });
    expect(summary.origin.program).toBe('crest');
    expect(summary.origin.sourceSha256).toBe('');
    expect(summary.energyUnit).toBe('hartree');
    expect(summary.energyMethod).toBe('GFN2-xTB');
    expect(summary.generator).toBe('crest');
  });

  it('carries a declared imported origin through unchanged', () => {
    const ranked = rankEnsemble({
      frames: [
        { index: 1, atoms: coords, energyEh: -120.4, energyUnit: 'kcal/mol', energyMethod: 'MMFF94', protomer: '' },
      ],
      rmsdThreshold: 0.05,
      energyUnit: 'kcal/mol',
      energyMethod: 'MMFF94',
    });
    const summary = ensembleSummary(ranked, {
      generator: 'import',
      origin: { ...IMPORT_ORIGIN },
      energyUnit: 'kcal/mol',
      energyMethod: 'MMFF94',
    });
    expect(summary.origin).toEqual(IMPORT_ORIGIN);
    expect(summary.energyUnit).toBe('kcal/mol');
    expect(summary.energyMethod).toBe('MMFF94');
    expect(summary.members[0].energyUnit).toBe('kcal/mol');
    expect(summary.members[0].energyEh).toBeNull();
  });

  it('passes the declared unit and origin into the task the queue receives', () => {
    const validated = validateProject(importedProject({}, null, {
      path: 'conf.xyz',
      energyUnit: 'kcal/mol',
      energyMethod: 'MMFF94',
      origin: { program: 'SyntheticGaussLike', version: '26.1 (test)', method: 'MMFF94' },
    })).project;
    const generate = validated.nodes.find((entry) => entry.type === 'generate');
    const built = conformerSearchTask(validated, generate);
    expect(built.generate.source).toBe('imported');
    expect(built.generate.ensembleFrom).toBe('ens');
    expect(built.generate.argv).toEqual([]);
    const inputTask = buildWorkflowPlan(validated).tasks.find((entry) => entry.type === 'input');
    expect(inputTask.input.energyUnit).toBe('kcal/mol');
    expect(inputTask.input.origin.program).toBe('SyntheticGaussLike');
  });
});

describe('the queue writes the origin it was given', () => {
  const roots = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rmrf(dir)));
  });

  async function stack() {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-provenance-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const runManager = new RunManager({ runsRoot, emit: () => {} });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await queueManager.init();
    return { base, queueManager };
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

  it('writes program, version, method and the file hash into conformers.json', async () => {
    const { base, queueManager } = await stack();
    const ensemblePath = path.join(base, 'synthetic_mm.xyz');
    const frames = [
      '3', 'confomer 1',
      `O ${coords[0].x} ${coords[0].y} ${coords[0].z}`,
      `H ${coords[1].x} ${coords[1].y} ${coords[1].z}`,
      `H ${coords[2].x} ${coords[2].y} ${coords[2].z}`,
      '3', 'conformer 2',
      `O ${coords[0].x} ${coords[0].y} ${coords[0].z}`,
      `H ${coords[1].x} ${coords[1].y} ${coords[1].z}`,
      `H ${coords[2].x} ${coords[2].y + 0.8} ${coords[2].z}`,
      '',
    ].join('\n');
    await fsp.writeFile(ensemblePath, frames, 'utf8');
    await fsp.writeFile(path.join(base, 'crest.energies'), '-120.40\n-119.00\n', 'utf8');

    const raw = importedProject({ rmsdThreshold: 0.05 }, null, {
      path: ensemblePath,
      energyUnit: 'kcal/mol',
      energyMethod: 'MMFF94',
      origin: { program: 'SyntheticGaussLike', version: '26.1 (test)', method: 'MMFF94/DLFF03 (test)' },
    });
    const validated = validateProject(raw);
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const conformers = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(conformers.error).toBeNull();
    expect(conformers.status).toBe('completed');

    const written = JSON.parse(await fsp.readFile(path.join(conformers.runDir, 'conformers.json'), 'utf8'));
    const digest = createHash('sha256').update(await fsp.readFile(ensemblePath)).digest('hex');
    expect(written.origin.program).toBe('SyntheticGaussLike');
    expect(written.origin.version).toBe('26.1 (test)');
    expect(written.origin.method).toBe('MMFF94/DLFF03 (test)');
    expect(written.origin.sourceSha256).toBe(digest);
    expect(written.energyUnit).toBe('kcal/mol');
    expect(written.energyMethod).toBe('MMFF94');
    expect(written.members[0].energyEh).toBeNull();
    expect(written.members[0].energyKcal).toBeCloseTo(-120.4, 6);
    expect(written.members[1].relativeKcal).toBeCloseTo(1.4, 6);
    // The queue summary and the project summary must agree on the unit.
    expect(conformers.ensemble.energyUnit).toBe('kcal/mol');
  });
});
