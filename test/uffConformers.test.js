import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from './helpers/tempCleanup.js';
import {
  UFF_SEARCH_METHOD,
  findRotatableBonds,
  generateUffEnsemble,
  heavyAtomRmsd,
  perceiveBonds,
  pruneNearDuplicates,
  rotateTorsionBy,
  searchUffConformers,
  torsionTrials,
} from '../src/shared/uffConformers.js';
import {
  conformerOriginLabel,
  conformerOriginShort,
  conformerSearchNote,
  conformerTableCaption,
} from '../src/shared/conformers.js';
import { dihedralAngleRadians } from '../src/shared/uff.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, conformerSearchTask } from '../src/shared/workflowTasks.js';
import { parseStructure } from '../src/shared/structureImport.js';
import { QueueManager } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const onWindows = process.platform === 'win32';

/* ── test molecules ─────────────────────────────────────────
 * Built from internal coordinates (C–C 1.53 Å, C–C–C 112°, C–H 1.09 Å) and
 * then relaxed by UFF itself, so the numbers asserted below are UFF energies
 * of geometries UFF produced — not hand-typed "expected" energies.
 */
const ANGLE = (112 * Math.PI) / 180;
const norm = (v) => {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
const unit = (a, b) => norm({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** A straight-chain alkane with explicit hydrogens. */
function alkane(carbons) {
  const list = [];
  const chain = [];
  const spacing = 1.53 * Math.sin(ANGLE / 2);
  const rise = 1.53 * Math.cos(ANGLE / 2);
  for (let index = 0; index < carbons; index += 1) {
    chain.push({ element: 'C', x: index * spacing, y: (index % 2) * rise, z: 0 });
  }
  list.push(...chain);
  const hydrogens = [];
  for (let index = 0; index < carbons; index += 1) {
    const centre = chain[index];
    const neighbours = [chain[index - 1], chain[index + 1]].filter(Boolean);
    const directions = [];
    if (neighbours.length === 2) {
      const u1 = unit(centre, neighbours[0]);
      const u2 = unit(centre, neighbours[1]);
      const bisector = norm({ x: -(u1.x + u2.x), y: -(u1.y + u2.y), z: -(u1.z + u2.z) });
      const perpendicular = norm(cross(u1, u2));
      const half = (109.47 * Math.PI) / 360;
      for (const sign of [1, -1]) {
        directions.push(norm({
          x: bisector.x * Math.cos(half) + sign * perpendicular.x * Math.sin(half),
          y: bisector.y * Math.cos(half) + sign * perpendicular.y * Math.sin(half),
          z: bisector.z * Math.cos(half) + sign * perpendicular.z * Math.sin(half),
        }));
      }
    } else {
      const u = unit(centre, neighbours[0]);
      const helper = Math.abs(u.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const e1 = norm(cross(u, helper));
      const e2 = cross(u, e1);
      for (let h = 0; h < 3; h += 1) {
        const phi = (h * 2 * Math.PI) / 3;
        directions.push(norm({
          x: -u.x / 3 + (e1.x * Math.cos(phi) + e2.x * Math.sin(phi)) * Math.sqrt(8 / 9),
          y: -u.y / 3 + (e1.y * Math.cos(phi) + e2.y * Math.sin(phi)) * Math.sqrt(8 / 9),
          z: -u.z / 3 + (e1.z * Math.cos(phi) + e2.z * Math.sin(phi)) * Math.sqrt(8 / 9),
        }));
      }
    }
    for (const direction of directions) {
      hydrogens.push({ parent: index + 1 });
      list.push({
        element: 'H',
        x: centre.x + direction.x * 1.09,
        y: centre.y + direction.y * 1.09,
        z: centre.z + direction.z * 1.09,
      });
    }
  }
  const bonds = [];
  for (let index = 1; index < carbons; index += 1) bonds.push({ a: index, b: index + 1, order: 1 });
  hydrogens.forEach((hydrogen, index) => bonds.push({ a: hydrogen.parent, b: carbons + index + 1, order: 1 }));
  return { atoms: list, bonds };
}

const ethane = () => alkane(2);
const butane = () => alkane(4);
const pentane = () => alkane(5);

/** A real 21-atom molecule with its bond orders, from the shipped SDF fixture. */
async function aspirin() {
  const text = await fsp.readFile(path.join(ROOT, 'test/fixtures/structures/pubchem-5molecules.sdf'), 'utf8');
  const record = parseStructure(text.split('$$$$')[0], { filename: 'aspirin.sdf' });
  return { atoms: record.atoms, bonds: record.bonds };
}

describe('rotatable bonds (issue 144)', () => {
  it('finds the two chain torsions of pentane and no methyl rotors', () => {
    const { atoms, bonds } = pentane();
    const { rotors, excluded } = findRotatableBonds(atoms, bonds);
    expect(rotors.map((rotor) => rotor.bond)).toEqual([[2, 3], [3, 4]]);
    // The C–C bonds to the methyl groups are excluded because a methyl rotor
    // moves only hydrogens.
    expect(excluded.filter((entry) => entry.reason === 'terminal').length).toBeGreaterThan(0);
  });

  it('excludes ring bonds, multiple bonds and amides, and says why', async () => {
    const { atoms, bonds } = await aspirin();
    const { excluded } = findRotatableBonds(atoms, bonds);
    const reasons = new Set(excluded.map((entry) => entry.reason));
    expect(reasons.has('ring')).toBe(true);
    expect(reasons.has('order')).toBe(true);
  });

  it('perceives connectivity when a structure arrives without bonds', () => {
    const { atoms } = ethane();
    const perceived = perceiveBonds(atoms);
    expect(perceived).toHaveLength(7);
    expect(perceived.every((bond) => bond.order === 1)).toBe(true);
    expect(perceived.every((bond) => bond.a >= 1 && bond.b >= 1)).toBe(true);
  });
});

describe('torsion grid (issue 144)', () => {
  it('turns a bond by exactly the requested dihedral change', () => {
    const { atoms, bonds } = butane();
    const { rotors } = findRotatableBonds(atoms, bonds);
    const before = dihedralAngleRadians({ atoms, bonds }, ...rotors[0].torsion) * (180 / Math.PI);
    const moved = rotateTorsionBy(atoms, rotors[0], 60);
    const after = dihedralAngleRadians({ atoms: moved, bonds }, ...rotors[0].torsion) * (180 / Math.PI);
    expect(((after - before + 540) % 360) - 180).toBeCloseTo(60, 6);
  });

  it('walks the grid in a fixed odometer order and reports truncation', () => {
    const small = torsionTrials(2, 120, 100);
    expect(small.trials[0]).toEqual([0, 0]);
    expect(small.trials[1]).toEqual([0, 120]);
    expect(small.trials[2]).toEqual([0, 240]);
    expect(small.trials[3]).toEqual([120, 0]);
    expect(small.trials).toHaveLength(9);
    expect(small.truncated).toBe(false);
    expect(small.planned).toBe(9);

    const capped = torsionTrials(3, 60, 10);
    expect(capped.trials).toHaveLength(10);
    expect(capped.truncated).toBe(true);
    expect(capped.planned).toBe(216);
    expect(capped.stepDegrees).toBe(60);
  });
});

describe('UFF conformer search (issue 144)', () => {
  it('gives the same ensemble twice, member by member', () => {
    const { atoms, bonds } = pentane();
    const first = generateUffEnsemble({ atoms, bonds, torsionStepDegrees: 180, maxTrials: 4 });
    const second = generateUffEnsemble({ atoms, bonds, torsionStepDegrees: 180, maxTrials: 4 });
    expect(first.error).toBeNull();
    expect(first.summary.search.randomized).toBe(false);
    expect(first.summary.search.seed).toBeNull();
    expect(second.summary.members).toHaveLength(first.summary.members.length);
    first.summary.members.forEach((member, index) => {
      const other = second.summary.members[index];
      expect(other.id).toBe(member.id);
      expect(other.energyKcal).toBe(member.energyKcal);
      expect(other.atoms).toEqual(member.atoms);
    });
    expect(second.summary.selected.atoms).toEqual(first.summary.selected.atoms);
  });

  it('finds several distinct members for a two-torsion molecule on a coarse grid', () => {
    const { atoms, bonds } = pentane();
    const found = generateUffEnsemble({ atoms, bonds, torsionStepDegrees: 120 });
    expect(found.error).toBeNull();
    expect(found.summary.count).toBeGreaterThanOrEqual(2);
    const energies = found.summary.members.filter((member) => member.kept).map((member) => member.energyKcal);
    // Ranked by the UFF energy that produced them, lowest first.
    expect(energies).toEqual([...energies].sort((left, right) => left - right));
    for (const member of found.summary.members.filter((entry) => entry.kept)) {
      expect(member.energyUnit).toBe('kcal/mol');
      expect(member.energyMethod).toBe('UFF');
      expect(member.energyEh).toBeNull();
      expect(member.energyKcal).toBeGreaterThan(0);
      expect(member.relativeKcal).toBeCloseTo(member.energyKcal - energies[0], 9);
    }
    expect(found.summary.search.torsionStepDegrees).toBe(120);
    expect(found.summary.search.trials).toBe(9);
    expect(found.summary.search.rotatableBonds).toBe(2);
  });

  it('collapses two trials that relax to the same geometry', async () => {
    // Aspirin's four first trials: trial 4 (a different pair of torsion values)
    // relaxes onto trial 1's geometry, and the heavy-atom RMSD test keeps one.
    const { atoms, bonds } = await aspirin();
    const found = searchUffConformers({ atoms, bonds, maxTrials: 4 });
    expect(found.error).toBeNull();
    expect(found.search.trials).toBe(4);
    expect(found.search.deduplicated).toBeGreaterThanOrEqual(1);
    // Nothing is lost: every trial is either a kept member or a recorded duplicate.
    expect(found.search.unique + found.search.deduplicated).toBe(found.search.trials);
    const duplicate = found.duplicates[0];
    expect(duplicate.rmsd).toBeLessThan(found.search.rmsdThreshold);
    expect(duplicate.trialIndex).not.toBe(duplicate.matchedTrialIndex);
  });

  it('keeps a member when the heavy-atom RMSD is above the threshold', () => {
    const { atoms, bonds } = pentane();
    const members = searchUffConformers({ atoms, bonds }).members;
    expect(members.length).toBeGreaterThan(1);
    expect(heavyAtomRmsd(members[0].atoms, members[1].atoms)).toBeGreaterThan(0.5);
    const pruned = pruneNearDuplicates([
      { trialIndex: 0, energyKcal: 1, atoms: members[0].atoms },
      { trialIndex: 1, energyKcal: 2, atoms: members[0].atoms },
      { trialIndex: 2, energyKcal: 3, atoms: members[1].atoms },
    ], 0.5);
    expect(pruned.members.map((member) => member.trialIndex)).toEqual([0, 2]);
    expect(pruned.duplicates).toHaveLength(1);
    expect(pruned.duplicates[0].trialIndex).toBe(1);
    expect(pruned.duplicates[0].matchedTrialIndex).toBe(0);
    expect(pruned.duplicates[0].rmsd).toBeCloseTo(0, 12);
  });

  it('yields one relaxed member and a reason when there is nothing to rotate', () => {
    const { atoms, bonds } = ethane();
    const found = generateUffEnsemble({ atoms, bonds });
    expect(found.error).toBeNull();
    expect(found.summary.members).toHaveLength(1);
    expect(found.summary.count).toBe(1);
    expect(found.summary.search.rotatableBonds).toBe(0);
    expect(found.summary.search.trials).toBe(1);
    expect(found.summary.warnings.map((warning) => warning.id)).toContain('uff-no-rotors');
    expect(conformerSearchNote(found.summary)).toMatch(/No rotatable bonds/);
    expect(conformerSearchNote(found.summary)).toMatch(/relaxed with UFF/);
  });

  it('refuses an element outside the UFF table by name', () => {
    const molecule = {
      atoms: [
        { element: 'Si', x: 0, y: 0, z: 0 },
        { element: 'O', x: 1.6, y: 0, z: 0 },
        { element: 'O', x: -1.6, y: 0, z: 0 },
      ],
      bonds: [{ a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
    };
    const found = generateUffEnsemble(molecule);
    expect(found.summary).toBeNull();
    expect(found.error).toMatch(/Si/);
    expect(found.error).toMatch(/does not type/);
  });

  it('warns that a perceived topology is all-single and not the real typing', async () => {
    const { atoms } = await aspirin();
    const found = generateUffEnsemble({ atoms, bonds: null, maxTrials: 1 });
    expect(found.summary.search.bondSource).toBe('perceived');
    const warning = found.summary.warnings.find((entry) => entry.id === 'uff-bonds-perceived');
    expect(warning.message).toMatch(/treated as single/);
    expect(warning.message).toMatch(/sp3/);
  });

  it('records the relaxation cap and reports trials that did not converge', async () => {
    const { atoms, bonds } = await aspirin();
    const found = searchUffConformers({ atoms, bonds, maxTrials: 1, relaxMaxIterations: 5 });
    expect(found.error).toBeNull();
    expect(found.search.relaxMaxIterations).toBe(5);
    expect(found.warnings.map((warning) => warning.id)).toContain('uff-not-converged');
    expect(found.warnings.find((warning) => warning.id === 'uff-not-converged').message)
      .toMatch(/did not reach the UFF force tolerance/);
  });

  it('returns the RANKED members, so the unit travels with the number (issue 144)', () => {
    const ensemble = generateUffEnsemble({
      atoms: [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'C', x: 1.52, y: 0, z: 0 },
        { element: 'O', x: 2.1, y: 1.35, z: 0 },
        { element: 'H', x: -0.4, y: 1.0, z: 0 },
        { element: 'H', x: 2.4, y: 2.1, z: 0 },
      ],
      bonds: [[0, 1], [1, 2]],
    }, {});
    expect(ensemble.error).toBeNull();
    const [member] = ensemble.members;
    // The four fields that keep a force-field energy from being read as a QM
    // total. Returning the raw trials dropped all of them.
    expect(member.energyUnit).toBe('kcal/mol');
    expect(member.energyMethod).toBe('UFF');
    expect(member.energyEh).toBeNull();
    expect(typeof member.energyKcal).toBe('number');
    // ...and the ensemble's own bookkeeping: an id and a rank, which the fan-out
    // and the report both need to name a member.
    expect(member.id).toBeTruthy();
    expect(member.rank).toBe(1);
    // The trial that produced it is still named.
    expect(member.trialIndex).toBe(0);
    // The members and the summary must agree about who is in the ensemble.
    expect(ensemble.members.map((entry) => entry.id)).toEqual(ensemble.summary.members.map((entry) => entry.id));
  });

  it('states the search, the grid and the limit in the ensemble copy', () => {
    const { atoms, bonds } = pentane();
    const found = generateUffEnsemble({ atoms, bonds });
    const summary = found.summary;
    expect(summary.search.method).toBe(UFF_SEARCH_METHOD);
    expect(summary.search.comparableWithQuantumChemistry).toBe(false);
    expect(summary.search.electrostatics).toBe(false);
    expect(summary.search.ringSampling).toBe(false);

    const note = conformerSearchNote(summary);
    expect(note).toMatch(/120° torsional grid/);
    expect(note).toMatch(/9 trials/);
    expect(note).toMatch(/0\.50 Å heavy-atom RMSD/);
    expect(note).toMatch(/not a Monte-Carlo or CREST search/);
    expect(note).toMatch(/not comparable with a Hartree value/);
    expect(conformerTableCaption(summary)).toMatch(/force-field energies, not QM/);
    expect(conformerTableCaption(summary)).toMatch(/120° grid/);
    expect(conformerTableCaption(summary)).toMatch(/0\.50 Å dedupe/);
    expect(conformerTableCaption(summary)).toMatch(/9 trials/);
    expect(conformerTableCaption(summary)).toMatch(/not a Monte-Carlo search/);
    expect(conformerOriginShort(summary)).toBe('UFF · in-app torsion grid');
    expect(conformerOriginLabel(summary)).toMatch(/computed here · UFF/);
    expect(conformerOriginLabel(summary)).toMatch(/not QM/);
    // The same copy must never appear on another route.
    expect(conformerSearchNote({ generator: 'crest', energyMethod: 'GFN2-xTB' })).toBe('');
    expect(conformerSearchNote({ generator: 'import', energyMethod: 'MMFF94' })).toBe('');
  });
});

describe('UFF route wiring (issue 144)', () => {
  const project = (settings = {}, output = null, molecule = null) => {
    const base = butane();
    const raw = {
      schemaVersion: 3,
      name: 'UFF route',
      molecule: molecule || {
        charge: 0,
        multiplicity: 1,
        fragments: [],
        geometry: { source: 'imported', file: 'butane.sdf', format: 'sdf' },
        coords: base.atoms,
        bonds: base.bonds,
      },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [
        {
          id: 'conf', type: 'generate', title: 'Conformer ensemble', state: 'ready', x: 0, y: 0,
          settings, output,
        },
        {
          id: 'opt', type: 'calculate', title: 'Optimise chosen conformer', state: 'ready', x: 200, y: 0,
          settings: defaultSettings({ jobType: 'Opt' }), output: null, checkpointFrom: null,
        },
      ],
      edges: [{ id: 'e1', from: 'conf', to: 'opt', type: 'dependency' }],
    };
    const validated = validateProject(raw);
    expect(validated.ok).toBe(true);
    return validated.project;
  };

  it('plans the same task shape as the CREST route, with no executable', () => {
    const crestProject = project({ generator: 'crest' });
    const uffProject = project({ generator: 'uff', torsionStepDegrees: 180, maxTrials: 4 });
    const crestTask = conformerSearchTask(crestProject, crestProject.nodes[0]);
    const uffTask = conformerSearchTask(uffProject, uffProject.nodes[0]);

    expect(Object.keys(uffTask).sort()).toEqual(Object.keys(crestTask).sort());
    expect(uffTask.type).toBe('generate');
    expect(uffTask.executable).toBe(true);
    expect(uffTask.engine).toBeNull();
    expect(uffTask.inputText).toBe(crestTask.inputText);
    // Nothing is spawned for the UFF route: no argv, and no CREST output name.
    expect(uffTask.generate.argv).toEqual([]);
    expect(crestTask.generate.argv.length).toBeGreaterThan(0);
    expect(uffTask.outputName).toBe('uff.log');
    expect(crestTask.outputName).toBe('crest.out');
    // The project's bond table travels with the task, because the search types
    // atoms from it; CREST perceives its own topology and does not carry it.
    expect(uffTask.generate.bonds).toHaveLength(butane().bonds.length);
    expect(crestTask.generate.bonds).toBeUndefined();
    expect(uffTask.generate.torsionStepDegrees).toBe(180);
    expect(uffTask.generate.maxTrials).toBe(4);

    const plan = buildWorkflowPlan(uffProject);
    const planned = plan.tasks.find((task) => task.nodeId === 'conf');
    expect(planned.generate.generator).toBe('uff');
  });

  it('serialises an unset route byte-identically, with no UFF keys at all', () => {
    const plain = project({ generator: 'crest' });
    const text = JSON.stringify(plain);
    expect(text).not.toMatch(/torsionStepDegrees|maxTrials/);
    // ADR 0001 serialises the generic source key; no UFF route key appears.
    expect(text).not.toMatch(/"uff"/);
    // A second validation of the same bytes produces the same bytes.
    const again = validateProject(JSON.parse(text));
    expect(again.ok).toBe(true);
    expect(JSON.stringify(again.project)).toBe(text);
  });

  it('accepts the UFF knobs and refuses out-of-range values by name', () => {
    const molecule = butane();
    const good = validateProject({
      schemaVersion: 3,
      name: 'uff knobs',
      molecule: {
        charge: 0, multiplicity: 1, fragments: [],
        geometry: { source: 'imported', file: 'butane.sdf', format: 'sdf' },
        coords: molecule.atoms, bonds: molecule.bonds,
      },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [{
        id: 'conf', type: 'generate', title: 'Conf', state: 'ready', x: 0, y: 0,
        settings: { generator: 'uff', torsionStepDegrees: 90, maxTrials: 12 },
      }],
      edges: [],
    });
    expect(good.ok).toBe(true);
    expect(good.project.nodes[0].settings.torsionStepDegrees).toBe(90);
    expect(good.project.nodes[0].settings.maxTrials).toBe(12);

    const bad = validateProject({
      schemaVersion: 3,
      name: 'uff knobs',
      molecule: {
        charge: 0, multiplicity: 1, fragments: [],
        geometry: { source: 'imported', file: 'butane.sdf', format: 'sdf' },
        coords: molecule.atoms,
      },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [{
        id: 'conf', type: 'generate', title: 'Conf', state: 'ready', x: 0, y: 0,
        settings: { generator: 'uff', torsionStepDegrees: 5, maxTrials: 0 },
      }],
      edges: [],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['nodes[0].settings.torsionStepDegrees', 'nodes[0].settings.maxTrials']),
    );
  });

  it('round-trips a UFF ensemble summary through the project schema', () => {
    const { atoms, bonds } = pentane();
    const found = generateUffEnsemble({ atoms, bonds, torsionStepDegrees: 180 });
    const saved = validateProject({
      schemaVersion: 3,
      name: 'uff summary',
      molecule: {
        charge: 0, multiplicity: 1, fragments: [],
        geometry: { source: 'imported', file: 'pentane.sdf', format: 'sdf' },
        coords: atoms, bonds,
      },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [{
        id: 'conf', type: 'generate', title: 'Conf', state: 'ready', x: 0, y: 0,
        settings: { generator: 'uff' }, output: found.summary,
      }],
      edges: [],
    });
    expect(saved.ok).toBe(true);
    const output = saved.project.nodes[0].output;
    expect(output.generator).toBe('uff');
    expect(output.energyUnit).toBe('kcal/mol');
    expect(output.energyMethod).toBe('UFF');
    expect(output.search.torsionStepDegrees).toBe(180);
    expect(output.search.trials).toBe(4);
    expect(output.search.randomized).toBe(false);
    expect(output.search.rotors).toHaveLength(2);
    expect(output.search.excluded.length).toBeGreaterThan(0);
    expect(output.search.excluded[0].reason).toBeTruthy();
    expect(output.members[0].energyKcal).toBeGreaterThan(0);
    expect(output.members[0].energyEh).toBeNull();
  });
});

describe('UFF route in the queue (issue 144)', () => {
  const roots = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rmrf(root)));
  });

  async function stack() {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-uff-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(queuesRoot, { recursive: true });
    await fsp.mkdir(runsRoot, { recursive: true });
    const runManager = new RunManager({ runsRoot });
    const events = [];
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: (event) => events.push(event) });
    return { base, queueManager, events, runsRoot };
  }

  const waitFor = async (probe, timeoutMs = 60000) => {
    const started = Date.now();
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error('queue did not finish');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it.skipIf(onWindows)('completes a UFF search with no chemistry binary configured', async () => {
    const molecule = butane();
    const raw = {
      schemaVersion: 3,
      name: 'UFF queue',
      molecule: {
        charge: 0,
        multiplicity: 1,
        fragments: [],
        geometry: { source: 'imported', file: 'butane.sdf', format: 'sdf' },
        coords: molecule.atoms,
        bonds: molecule.bonds,
      },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [{
        id: 'conf', type: 'generate', title: 'UFF ensemble', state: 'ready', x: 0, y: 0,
        settings: { generator: 'uff', torsionStepDegrees: 180, maxTrials: 2, rmsdThreshold: 0.05 },
      }],
      edges: [],
    };
    const validated = validateProject(raw);
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const { queueManager } = await stack();
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: plan.tasks.filter((task) => task.type === 'generate'),
      edges: [],
      // No executable and no CREST path: the in-app route must not need either.
      options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const list = await queueManager.list();
      const queue = list.find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });

    const task = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(task.error).toBeNull();
    expect(task.status).toBe('completed');
    expect(task.ensemble.generator).toBe('uff');
    expect(task.ensemble.energyUnit).toBe('kcal/mol');
    expect(task.ensemble.energyMethod).toBe('UFF');
    expect(task.ensemble.search.trials).toBe(2);
    expect(task.ensemble.search.bondSource).toBe('supplied');
    expect(task.ensemble.search.comparableWithQuantumChemistry).toBe(false);
    expect(task.ensemble.members.every((member) => member.energyEh === null)).toBe(true);
    expect(task.ensemble.members[0].energyKcal).toBeGreaterThan(0);
    // The run folder says what ran, in a file a reader can open without the app.
    const log = await fsp.readFile(path.join(task.runDir, 'uff.log'), 'utf8');
    expect(log).toMatch(/in-app conformer search/);
    expect(log).toMatch(/180° over 1 rotatable bond/);
    expect(log).toMatch(/not comparable with a Hartree value/);
    await fsp.access(path.join(task.runDir, 'conformers.json'));
    await fsp.access(path.join(task.runDir, 'ensemble.xyz'));
  });
});
