import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DERIVATIVE_MAX_EDITS,
  DERIVATIVE_OPS,
  derivativeParents,
  expandDerivative,
  recordsForInput,
} from '../src/shared/flows.js';
import { DerivativeEditError, GEOMETRY_NOTE, GEOMETRY_STATUS } from '../src/shared/derivative.js';
import { formulaOf } from '../src/shared/formula.js';
import { COVALENT_RADII_ANGSTROM } from '../src/shared/validityChecks.js';
import { defaultSettings, stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

/**
 * Issue 189: a derivative block is an `input` block with `kind: 'derivative'`.
 * Each edit in `input.edits` is applied to the parent record on its own, so one
 * block is a substituent scan or a protonated/deprotonated pair. These tests pin
 * the geometry, the provenance, the plan expansion and — most importantly — that
 * every refusal is the edit engine's own, not a second copy of the rules.
 */

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');

/** Benzene, atoms 1–6 = C ring, 7–12 = the H atoms. */
const benzeneRing = [
  [1.3960, 0.0, 0.0], [0.6980, 1.2092, 0.0], [-0.6980, 1.2092, 0.0],
  [-1.3960, 0.0, 0.0], [-0.6980, -1.2092, 0.0], [0.6980, -1.2092, 0.0],
];
const benzeneHydrogens = [
  [2.4780, 0.0, 0.0], [1.2390, 2.1460, 0.0], [-1.2390, 2.1460, 0.0],
  [-2.4780, 0.0, 0.0], [-1.2390, -2.1460, 0.0], [1.2390, -2.1460, 0.0],
];
const benzeneCoords = [
  ...benzeneRing.map(([x, y, z]) => ({ element: 'C', x, y, z })),
  ...benzeneHydrogens.map(([x, y, z]) => ({ element: 'H', x, y, z })),
];
const benzeneBonds = [
  // `a < b`, the order the schema and the edit engine store a bond in.
  ...Array.from({ length: 6 }, (_, index) => ({
    a: Math.min(index + 1, ((index + 1) % 6) + 1),
    b: Math.max(index + 1, ((index + 1) % 6) + 1),
    order: 1.5,
  })),
  ...Array.from({ length: 6 }, (_, index) => ({ a: index + 1, b: index + 7, order: 1 })),
];

const benzene = {
  id: 'benzene',
  label: 'Benzene',
  charge: 0,
  multiplicity: 1,
  coords: benzeneCoords,
  bonds: benzeneBonds,
  enabled: true,
};

const water = {
  id: 'water',
  label: 'Water',
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.96, y: 0, z: 0 },
    { element: 'H', x: -0.24, y: 0.93, z: 0 },
  ],
  bonds: [{ a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
  enabled: true,
};

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, but the call succeeded');
};

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('issue 189 — one edit becomes one record', () => {
  it('turns benzene into fluorobenzene: 12 atoms, 12 bonds, C6H5F', () => {
    const [fluorobenzene] = expandDerivative([benzene], [{ op: 'substitute', atom: 7, element: 'F' }]);
    expect(fluorobenzene.coords).toHaveLength(12);
    expect(fluorobenzene.bonds).toHaveLength(12);
    expect(fluorobenzene.derivative.formula).toBe('C6H5F');
    expect(formulaOf(fluorobenzene.coords)).toBe('C6H5F');
    // The bond that replaced C1–H7 is now C1–F7, and its length is the sum of
    // the two tabulated Cordero covalent radii.
    const bond = fluorobenzene.bonds.find((entry) => entry.a === 1 && entry.b === 7);
    expect(bond).toEqual({ a: 1, b: 7, order: 1 });
    const length = distance(fluorobenzene.coords[0], fluorobenzene.coords[6]);
    expect(Math.abs(length - (COVALENT_RADII_ANGSTROM.C + COVALENT_RADII_ANGSTROM.F))).toBeLessThan(1e-9);
  });

  it('leaves every other coordinate unchanged to the last bit', () => {
    const [fluorobenzene] = expandDerivative([benzene], [{ op: 'substitute', atom: 7, element: 'F' }]);
    benzeneCoords.forEach((atom, index) => {
      if (index === 6) return;
      expect(fluorobenzene.coords[index].x).toBe(atom.x);
      expect(fluorobenzene.coords[index].y).toBe(atom.y);
      expect(fluorobenzene.coords[index].z).toBe(atom.z);
    });
    // And the input molecule is not mutated by the expansion.
    expect(benzene.coords[6]).toEqual({ element: 'H', x: 2.478, y: 0, z: 0 });
  });

  it('carries parent, operation and atom index as provenance on the record', () => {
    const [fluorobenzene] = expandDerivative([benzene], [{ op: 'substitute', atom: 7, element: 'F' }]);
    expect(fluorobenzene.derivative).toMatchObject({
      parentId: 'benzene',
      atomIndexBase: 1,
      formula: 'C6H5F',
      summary: 'H7 → F',
      geometryStatus: GEOMETRY_STATUS,
      geometryNote: GEOMETRY_NOTE,
    });
    expect(fluorobenzene.derivative.operations).toHaveLength(1);
    expect(fluorobenzene.derivative.operations[0]).toMatchObject({
      op: 'substitute',
      atomIndex: 7,
      element: 'F',
      before: { element: 'H', isotope: null },
      after: { element: 'F', isotope: null },
    });
    expect(fluorobenzene.derivative.geometryStatus).toBe('needs optimisation');
  });

  it('names the record after its parent and its edit, without a position', () => {
    const records = expandDerivative([benzene], [
      { op: 'substitute', atom: 7, element: 'F' },
      { op: 'substitute', atom: 8, element: 'Cl' },
      // Removing one atom changes the electron count, so the spin state is
      // stated: 41 electrons need an even multiplicity.
      { op: 'remove', atom: 9, charge: 0, multiplicity: 2 },
      { op: 'isotope', atom: 10, mass: 2 },
    ]);
    expect(records.map((record) => record.id)).toEqual([
      'benzene-sub7-F',
      'benzene-sub8-Cl',
      'benzene-rm9',
      'benzene-iso10-2',
    ]);
  });

  it('changes the mass number and nothing else for an isotopologue', () => {
    const [deuterated] = expandDerivative([benzene], [{ op: 'isotope', atom: 7, mass: 2 }]);
    expect(deuterated.coords).toHaveLength(12);
    expect(deuterated.bonds).toEqual(benzene.bonds);
    expect(deuterated.charge).toBe(benzene.charge);
    expect(deuterated.multiplicity).toBe(benzene.multiplicity);
    expect(deuterated.coords[6]).toEqual({ element: 'H', x: 2.478, y: 0, z: 0, isotope: 2 });
    deuterated.coords.forEach((atom, index) => {
      if (index === 6) return;
      expect(atom.x).toBe(benzeneCoords[index].x);
      expect(atom.z).toBe(benzeneCoords[index].z);
    });
  });

  it('states the charge and multiplicity a protonation produces', () => {
    const [protonated] = expandDerivative([water], [
      { op: 'protonate', atom: 1, charge: 1, multiplicity: 1 },
    ]);
    expect(protonated.charge).toBe(1);
    expect(protonated.multiplicity).toBe(1);
    expect(protonated.coords).toHaveLength(4);
    expect(protonated.derivative.summary).toBe('+H on atom 1 (charge 1, multiplicity 1)');

    const [deprotonated] = expandDerivative([water], [
      { op: 'deprotonate', atom: 2, charge: -1, multiplicity: 1 },
    ]);
    expect(deprotonated.charge).toBe(-1);
    expect(deprotonated.coords).toHaveLength(2);
    expect(deprotonated.derivative.summary).toBe('−H2 (charge -1, multiplicity 1)');
  });

  it('fans out over every enabled record when no parent is named', () => {
    const toluene = {
      ...benzene,
      id: 'toluene',
      label: 'Toluene',
      // A different parent, so the two derived records are not duplicates.
      coords: benzeneCoords.map((atom) => ({ ...atom, z: atom.z + 1 })),
    };
    const records = expandDerivative([benzene, toluene], [{ op: 'isotope', atom: 7, mass: 2 }]);
    expect(records.map((record) => record.id)).toEqual(['benzene-iso7-2', 'toluene-iso7-2']);
    expect(records.map((record) => record.derivative.parentId)).toEqual(['benzene', 'toluene']);
    expect(derivativeParents([benzene, toluene], '').map((record) => record.id)).toEqual(['benzene', 'toluene']);
    // A disabled record is not a parent, and naming one is a refusal.
    expect(derivativeParents([benzene, { ...toluene, enabled: false }], 'benzene')).toHaveLength(1);
    expect(derivativeParents([benzene], 'benzene')).toHaveLength(1);
    expect(refusal(() => derivativeParents([benzene], 'toluene')).message).toMatch(/not an enabled record/);
  });
});

describe('issue 189 — the guards are the edit engine\'s own refusals', () => {
  it('refuses a parent that states no bonds, by name', () => {
    const { bonds, ...withoutBonds } = benzene;
    const error = refusal(() => expandDerivative([withoutBonds], [{ op: 'substitute', atom: 7, element: 'F' }]));
    expect(error).toBeInstanceOf(DerivativeEditError);
    expect(error.code).toBe('no-bonds');
    expect(error.message).toMatch(/The molecule states no bonds/);
    expect(error.message).toMatch(/state the topology first/);
  });

  it('refuses an atom index outside the structure, naming it', () => {
    const error = refusal(() => expandDerivative([benzene], [{ op: 'remove', atom: 99 }]));
    expect(error.code).toBe('atom-out-of-range');
    expect(error.message).toMatch(/Atom 99 is outside this structure, which has 12 atoms \(indices start at 1\)/);
  });

  it('refuses a valence overrun, naming the atom and the element', () => {
    const error = refusal(() => expandDerivative([benzene], [{ op: 'add', atom: 7, element: 'Cl' }]));
    expect(error.code).toBe('valence-exceeded');
    expect(error.message).toMatch(/Atom 7 \(H\) already uses 1 of 1 and cannot take another bond/);
  });

  it('refuses a dangling bond in the parent', () => {
    const broken = { ...benzene, bonds: [...benzeneBonds, { a: 1, b: 40, order: 1 }] };
    const error = refusal(() => expandDerivative([broken], [{ op: 'remove', atom: 7 }]));
    expect(error.code).toBe('dangling-bond');
    expect(error.message).toMatch(/joins atoms 1 and 40; the structure has 12 atoms/);
  });

  it('refuses an unknown isotope, listing the ones that exist', () => {
    const error = refusal(() => expandDerivative([benzene], [{ op: 'isotope', atom: 1, mass: 999 }]));
    expect(error.code).toBe('unknown-isotope');
    expect(error.message).toMatch(/Atom 1 \(C\) has no isotope of mass 999; the table lists 12, 13, 14/);
  });

  it('refuses a protonation that does not state its charge or multiplicity', () => {
    const noCharge = refusal(() => expandDerivative([water], [{ op: 'protonate', atom: 1, multiplicity: 1 }]));
    expect(noCharge.code).toBe('charge-not-stated');
    expect(noCharge.message).toMatch(/protonate must state the resulting charge/);
    const noSpin = refusal(() => expandDerivative([water], [{ op: 'deprotonate', atom: 2, charge: -1 }]));
    expect(noSpin.code).toBe('multiplicity-not-stated');
    expect(noSpin.message).toMatch(/deprotonate must state the resulting multiplicity/);
  });

  it('refuses two edits that produce the same structure', () => {
    const error = refusal(() => expandDerivative([benzene], [
      { op: 'isotope', atom: 7, mass: 2 },
      { op: 'isotope', atom: 7, mass: 2 },
    ]));
    expect(error.code).toBe('duplicate-record');
    expect(error.message).toMatch(/Edits 1 and 2 of "benzene" produce the same structure; two identical records leave nothing to compare|Edits 1 and 2 of "benzene" produce the same structure/);
  });

  it('refuses a record with no 3D coordinates instead of falling back to water', () => {
    const error = refusal(() => expandDerivative([{ ...benzene, coords: [] }], [{ op: 'remove', atom: 1 }]));
    expect(error.code).toBe('no-coordinates');
    expect(error.message).toMatch(/has no 3D coordinates/);
    expect(error.message).toMatch(/demo water molecule/);
  });

  it('refuses an empty edit list and an unknown parent', () => {
    expect(refusal(() => expandDerivative([benzene], [])).code).toBe('no-edits');
    expect(refusal(() => derivativeParents([benzene], 'nope')).message).toMatch(/not an enabled record/);
  });

  it('reports the same refusal through recordsForInput, which the plan calls', () => {
    const dataset = { id: 'parents', records: [{ ...benzene, bonds: undefined, enabled: true }] };
    const node = {
      type: 'input',
      kind: 'derivative',
      input: {
        datasetId: 'parents',
        recordFilter: { field: '', equals: '' },
        recordId: 'benzene',
        edits: [{ op: 'substitute', atom: 7, element: 'F' }],
      },
    };
    expect(() => recordsForInput(node, dataset)).toThrow(/The molecule states no bonds/);
  });
});

describe('issue 189 — the schema keeps the edit list and refuses it by name', () => {
  const project = (overrides = {}) => ({
    schemaVersion: 2,
    name: 'Derivative fixture',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: benzeneCoords, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [{
      id: 'parents',
      title: 'Parents',
      source: { kind: 'inline', path: '', format: 'json' },
      fields: { label: '', charge: '', multiplicity: '' },
      records: [{
        id: 'benzene',
        label: 'Benzene',
        charge: 0,
        multiplicity: 1,
        coords: benzeneCoords,
        bonds: benzeneBonds,
        enabled: true,
      }],
      notes: '',
    }],
    flows: [{
      id: 'main',
      title: 'Derivatives',
      nodes: [
        {
          id: 'in1',
          type: 'input',
          kind: 'derivative',
          title: 'Analogues',
          state: 'ready',
          x: 0,
          y: 0,
          input: {
            datasetId: 'parents',
            recordFilter: { field: '', equals: '' },
            recordId: 'benzene',
            edits: [
              { op: 'substitute', atom: 7, element: 'F' },
              { op: 'isotope', atom: 7, mass: 2 },
            ],
          },
        },
        {
          id: 'sp',
          type: 'calc',
          kind: 'SP',
          title: 'Single point',
          state: 'ready',
          x: 200,
          y: 0,
          settings: defaultSettings({ jobType: 'SP' }),
          output: null,
          checkpointFrom: null,
        },
      ],
      edges: [{ from: 'in1', to: 'sp', type: 'dependency' }],
    }],
    reports: [],
    activeFlowId: 'main',
    ...overrides,
  });

  it('validates a derivative block and stores the edit list', () => {
    const result = validateProject(project());
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const node = result.project.nodes[0];
    expect(node.kind).toBe('derivative');
    expect(node.input.edits).toEqual([
      { op: 'substitute', atom: 7, element: 'F' },
      { op: 'isotope', atom: 7, mass: 2 },
    ]);
    expect(node.input.recordId).toBe('benzene');
    expect(result.warnings).toEqual([]);
  });

  it('round-trips the edit list byte for byte', () => {
    const first = stringifyProject(project());
    expect(first.errors).toEqual([]);
    const second = stringifyProject(JSON.parse(first.text));
    expect(second.text).toBe(first.text);
    expect(first.text).toContain('"kind": "derivative"');
    expect(first.text).toContain('"edits"');
  });

  it('leaves a plain dataset block without the derivative keys', () => {
    const plain = project();
    plain.flows[0].nodes[0] = {
      id: 'in1', type: 'input', kind: 'Input', title: 'Parents', state: 'ready', x: 0, y: 0,
      input: { datasetId: 'parents', recordFilter: { field: '', equals: '' } },
    };
    const result = stringifyProject(plain);
    expect(result.errors).toEqual([]);
    expect(result.text).not.toContain('edits');
    expect(result.text).not.toContain('derivative');
  });

  it('refuses an unusable edit when the project is opened, with the engine\'s message', () => {
    const bad = project();
    bad.flows[0].nodes[0].input.edits = [{ op: 'substitute', atom: 99, element: 'F' }];
    const result = validateProject(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('input.edits')
      && /Atom 99 is outside this structure, which has 12 atoms/.test(error.message))).toBe(true);
  });

  it('refuses a record without bonds at load time, by name', () => {
    const bad = project();
    delete bad.datasets[0].records[0].bonds;
    const result = validateProject(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('input.edits')
      && /The molecule states no bonds/.test(error.message))).toBe(true);
  });

  it('requires the edit list for a kind of "derivative", and refuses both kinds at once', () => {
    const empty = project();
    delete empty.flows[0].nodes[0].input.edits;
    const emptyResult = validateProject(empty);
    expect(emptyResult.errors.some((error) => error.path.endsWith('input.edits')
      && /is required when the block kind is "derivative"/.test(error.message))).toBe(true);

    const both = project();
    both.flows[0].nodes[0].input.series = { from: 1, to: 2, linkage: { donor: 1, acceptor: 7, bondLengthAngstrom: 1.5, leaving: [] } };
    const bothResult = validateProject(both);
    expect(bothResult.errors.some((error) => error.path.endsWith('input')
      && /cannot carry both a series definition and an edit list/.test(error.message))).toBe(true);
  });

  it('drops an unknown edit key with a warning instead of storing it', () => {
    const extra = project();
    extra.flows[0].nodes[0].input.edits[0].group = 'OMe';
    const result = validateProject(extra);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => warning.path.endsWith('input.edits[0].group'))).toBe(true);
    expect(result.project.nodes[0].input.edits[0].group).toBeUndefined();
  });

  it('caps the list and names the cap', () => {
    const long = project();
    long.flows[0].nodes[0].input.edits = Array.from({ length: DERIVATIVE_MAX_EDITS + 1 },
      (_, index) => ({ op: 'isotope', atom: (index % 6) + 1, mass: 13 }));
    const result = validateProject(long);
    expect(result.errors.some((error) => error.path.endsWith('input.edits')
      && new RegExp(`must contain at most ${DERIVATIVE_MAX_EDITS} edits`).test(error.message))).toBe(true);
  });
});

describe('issue 189 — the plan expands one task per edit', () => {
  const planProject = (nodes) => {
    const result = validateProject({
      schemaVersion: 2,
      name: 'Derivative plan',
      molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: benzeneCoords, geometry: { source: 'demo', file: '', format: '' } },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [{
        id: 'parents',
        title: 'Parents',
        source: { kind: 'inline', path: '', format: 'json' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [{ id: 'benzene', label: 'Benzene', charge: 0, multiplicity: 1, coords: benzeneCoords, bonds: benzeneBonds, enabled: true }],
        notes: '',
      }],
      flows: [{ id: 'main', title: 'Derivatives', nodes, edges: [{ from: 'in1', to: 'sp', type: 'dependency' }] }],
      reports: [],
      activeFlowId: 'main',
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    return { built: buildWorkflowPlan(result.project), project: result.project };
  };

  const nodes = () => [
    {
      id: 'in1', type: 'input', kind: 'derivative', title: 'Analogues', state: 'ready', x: 0, y: 0,
      input: {
        datasetId: 'parents',
        recordFilter: { field: '', equals: '' },
        recordId: 'benzene',
        edits: [{ op: 'substitute', atom: 7, element: 'F' }, { op: 'isotope', atom: 8, mass: 2 }],
      },
    },
    {
      id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 200, y: 0,
      settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null,
    },
  ];

  it('queues two runs with distinct ids, one per edit', () => {
    const { built } = planProject(nodes());
    const executable = built.tasks.filter((task) => task.executable).map((task) => task.nodeId);
    expect(executable).toEqual(['sp~benzene-sub7-F', 'sp~benzene-iso8-2']);
    const into = built.edges.filter((edge) => edge.to.startsWith('sp~') && edge.type === 'dependency')
      .map((edge) => `${edge.from}->${edge.to}`);
    expect(into).toEqual(['in1->sp~benzene-sub7-F', 'in1->sp~benzene-iso8-2']);
  });

  it('carries parent, operations and the 1-based atom numbering on the task and the record', () => {
    const { built } = planProject(nodes());
    const task = built.tasks.find((entry) => entry.nodeId === 'sp~benzene-sub7-F');
    expect(task.record).toMatchObject({ id: 'benzene-sub7-F', label: 'Benzene · H7 → F', charge: 0, multiplicity: 1 });
    expect(task.record.derivative.parentId).toBe('benzene');
    expect(task.record.derivative.atomIndexBase).toBe(1);
    expect(task.record.derivative.operations[0]).toMatchObject({ op: 'substitute', atomIndex: 7, element: 'F' });
    // The provenance is on the task itself too, so a run record can copy it.
    expect(task.derivative).toEqual(task.record.derivative);
    expect(task.title).toBe('Single point — H7 → F');

    const inputTask = built.tasks.find((entry) => entry.type === 'input');
    expect(inputTask.input.records.map((record) => record.id)).toEqual(['benzene-sub7-F', 'benzene-iso8-2']);
    expect(inputTask.input.edits).toHaveLength(2);
  });

  it('writes the derivative geometry — C6H5F — into the planned input', () => {
    const { built } = planProject(nodes());
    const task = built.tasks.find((entry) => entry.nodeId === 'sp~benzene-sub7-F');
    expect(formulaOf(task.validity.molecule.coords)).toBe('C6H5F');
    const lines = task.inputText.split('\n');
    const start = lines.findIndex((line) => /^0 1$/.test(line.trim()));
    const atoms = lines.slice(start + 1).filter((line) => /^[A-Z][a-z]?\s/.test(line));
    expect(atoms).toHaveLength(12);
    // The fluorine sits where H7 was: same direction from C1, radii-sum length.
    const fluorine = atoms[6].trim().split(/\s+/);
    expect(fluorine[0]).toBe('F');
    // H7 sat on the +x axis at 2.478 Å; F keeps that direction and takes the
    // radii-sum distance from C1.
    const expected = 1.396 + COVALENT_RADII_ANGSTROM.C + COVALENT_RADII_ANGSTROM.F;
    expect(Math.abs(Number(fluorine[1]) - expected)).toBeLessThan(1e-9);
    expect(Number(fluorine[2])).toBe(0);
  });

  it('is byte-identical when the kind is absent and mentions no derivative key', () => {
    const plainNodes = () => [
      {
        id: 'in1', type: 'input', title: 'Parents', state: 'ready', x: 0, y: 0,
        input: { datasetId: 'parents', recordFilter: { field: '', equals: '' } },
      },
      ...nodes().slice(1),
    ];
    const absent = planProject(plainNodes());
    const explicit = planProject(plainNodes().map((node) => (node.type === 'input'
      ? { ...node, kind: 'Input' } : node)));
    expect(JSON.stringify(explicit.built)).toBe(JSON.stringify(absent.built));
    const text = JSON.stringify(absent.built);
    expect(text).not.toContain('"edits"');
    expect(text).not.toContain('"derivative"');
    expect(absent.project.nodes[0].kind).toBe('Input');
  });
});

describe('issue 189 — a dry `ncs run` executes every derivative', () => {
  it('runs both derived records and writes their run records', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-derivative-'));
    const file = path.join(dir, 'derivative.ncs');
    const project = {
      schemaVersion: 2,
      name: 'Derivative dry run',
      molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: benzeneCoords, geometry: { source: 'demo', file: '', format: '' } },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [{
        id: 'parents',
        title: 'Parents',
        source: { kind: 'inline', path: '', format: 'json' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [{ id: 'benzene', label: 'Benzene', charge: 0, multiplicity: 1, coords: benzeneCoords, bonds: benzeneBonds, enabled: true }],
        notes: '',
      }],
      flows: [{
        id: 'main',
        title: 'Derivatives',
        nodes: [
          {
            id: 'in1', type: 'input', kind: 'derivative', title: 'Analogues', state: 'ready', x: 0, y: 0,
            input: {
              datasetId: 'parents',
              recordFilter: { field: '', equals: '' },
              recordId: 'benzene',
              edits: [{ op: 'substitute', atom: 7, element: 'F' }, { op: 'isotope', atom: 8, mass: 2 }],
            },
          },
          {
            id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 200, y: 0,
            settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null,
          },
          {
            id: 'out1', type: 'output', kind: 'Output', title: 'Table', state: 'ready', x: 400, y: 0,
            output: { kind: 'csv', path: 'reports/derivatives.csv', include: 'records', bundle: 'project.zip', manifest: true, notes: '' },
          },
        ],
        edges: [
          { from: 'in1', to: 'sp', type: 'dependency' },
          { from: 'sp', to: 'out1', type: 'dependency' },
        ],
      }],
      reports: [],
      activeFlowId: 'main',
    };
    await writeFile(file, JSON.stringify(project), 'utf8');
    const out = path.join(dir, 'out');
    let result;
    try {
      const done = await run(process.execPath, [cli, 'run', file, '--out', out, '--dry-run'], {
        cwd: root, timeout: 120000,
      });
      result = { code: 0, stdout: done.stdout, stderr: done.stderr };
    } catch (error) {
      result = { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe('completed');
    // The input and output blocks are tasks too; only the two calculations run.
    expect(summary.runs.map((entry) => entry.nodeId).sort())
      .toEqual(['in1', 'out1', 'sp~benzene-iso8-2', 'sp~benzene-sub7-F']);
    for (const entry of summary.runs.filter((item) => item.nodeId.startsWith('sp~'))) {
      expect(entry.gates).toBe('pass');
      const record = JSON.parse(await readFile(path.join(entry.runDir, 'run.json'), 'utf8'));
      expect(record.status).toBe('completed');
      expect(record.provenance.kind).toBe('fixture');
    }
  }, 180000);
});

describe('issue 189 — the input inspector shows the scan it will queue', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', { desktop: null, innerWidth: 1440, innerHeight: 900, addEventListener: () => {} });
    vi.stubGlobal('document', { readyState: 'loading', addEventListener: () => {}, querySelector: () => null });
    app = await import('../src/renderer/app.js');
    app.state.project = {
      datasets: [{
        id: 'parents',
        title: 'Parents',
        source: { kind: 'inline', path: '', format: 'json' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [{ id: 'benzene', label: 'Benzene', charge: 0, multiplicity: 1, coords: benzeneCoords, bonds: benzeneBonds, enabled: true }],
        notes: '',
      }],
      nodes: [],
      edges: [],
    };
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const inputNode = (overrides = {}) => ({
    id: 'in1',
    type: 'input',
    kind: 'Input',
    title: 'Analogues',
    state: 'ready',
    x: 0,
    y: 0,
    input: { datasetId: 'parents', recordFilter: { field: '', equals: '' } },
    ...overrides,
  });

  it('offers to derive a related structure from a plain record set', () => {
    const html = app.inputInspector(inputNode());
    expect(html).toContain('data-action="derivative-enable"');
    expect(html).not.toContain('data-derivative-field="op"');
    expect(html).toContain('data-action="series-enable"');
  });

  it('renders one editor row per edit and the records the plan will queue', () => {
    const html = app.inputInspector(inputNode({
      kind: 'derivative',
      input: {
        datasetId: 'parents',
        recordFilter: { field: '', equals: '' },
        recordId: 'benzene',
        edits: [{ op: 'substitute', atom: 7, element: 'F' }, { op: 'isotope', atom: 8, mass: 2 }],
      },
    }));
    for (const field of ['op', 'atom', 'element', 'mass', 'charge', 'multiplicity']) {
      expect(html).toContain(`data-derivative-field="${field}"`);
    }
    expect(html).toContain('data-derivative-field="parent"');
    expect(html).toContain('data-derivative-edit="1"');
    expect(html).toContain('data-action="derivative-add-edit"');
    expect(html).toContain('data-action="derivative-disable"');
    // The ids and the resulting formula, from the expansion the plan uses.
    expect(html).toContain('benzene-sub7-F');
    expect(html).toContain('benzene-iso8-2');
    expect(html).toContain('C6H5F');
    // The honest status of the geometry, in those words.
    expect(html).toContain(GEOMETRY_STATUS);
    expect(html).toContain('topology with a plausible starting geometry');
  });

  it('shows the refusal verbatim instead of a plausible preview', () => {
    const html = app.inputInspector(inputNode({
      kind: 'derivative',
      input: {
        datasetId: 'parents',
        recordFilter: { field: '', equals: '' },
        recordId: 'benzene',
        edits: [{ op: 'substitute', atom: 99, element: 'F' }],
      },
    }));
    expect(html).toContain('Refused');
    expect(html).toContain('Atom 99 is outside this structure, which has 12 atoms');
    expect(html).not.toContain('benzene-sub99-F');
  });

  it('offers every op the engine implements, and nothing else', () => {
    expect([...DERIVATIVE_OPS]).toEqual(['substitute', 'add', 'remove', 'isotope', 'protonate', 'deprotonate']);
    const html = app.inputInspector(inputNode({
      kind: 'derivative',
      input: { datasetId: 'parents', recordFilter: { field: '', equals: '' }, edits: [{ op: 'deprotonate', atom: 7, charge: -1, multiplicity: 2 }] },
    }));
    for (const op of DERIVATIVE_OPS) expect(html).toContain(`value="${op}"`);
  });
});
