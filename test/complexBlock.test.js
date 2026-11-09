import { describe, it, expect } from 'vitest';
import {
  COMPLEX_GEOMETRY_STATUS,
  COMPLEX_MAX_ATOMS,
  COMPLEX_MAX_MEMBERS,
  COMPLEX_MIN_SEPARATION_ANGSTROM,
  COMPLEX_PLACEMENT_MODES,
  ComplexError,
  centreOfMass,
  complexRecordId,
  expandComplex,
  principalAxesOfInertia,
} from '../src/shared/complex.js';
import { recordsForInput } from '../src/shared/flows.js';
import { LIMITS, defaultSettings, stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { flowTabModels } from '../src/renderer/flowTabs.js';
import { buildPsi4Input } from '../src/shared/engines/psi4.js';
import { formulaOf } from '../src/shared/formula.js';

/**
 * Issue 188: a complex block is an `input` block with `kind: 'complex'`. Two or
 * more records are placed as rigid bodies and labelled fragment 1, 2, … so one
 * system comes out of the block and every downstream block consumes it with no
 * change. These tests pin the geometry, the fragment numbering, the guards and
 * the plan expansion — a wrong distance or a wrong label here is a silent
 * chemistry error, not a crash, so every number is asserted rather than
 * eyeballed.
 */

const waterCoords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const water = (id, overrides = {}) => ({
  id,
  label: id,
  charge: 0,
  multiplicity: 1,
  enabled: true,
  coords: waterCoords.map((atom) => ({ ...atom })),
  bonds: [{ a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
  ...overrides,
});

const dataset = (records, id = 'monomers') => ({
  id,
  title: id,
  source: { kind: 'inline', path: '', format: 'sdf' },
  fields: { label: '', charge: '', multiplicity: '' },
  records,
  notes: '',
});

const axisPlacement = (overrides = {}) => ({
  mode: 'axis',
  axis: [1, 0, 0],
  distanceAngstrom: 3,
  angleDegrees: 0,
  ...overrides,
});

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, but the call succeeded');
};

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('issue 188 — two records become one system', () => {
  it('builds a 6-atom complex whose two O atoms are exactly 3.0 Å apart', () => {
    const monomers = dataset([water('water-a'), water('water-b')]);
    const { records } = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement({ distanceAngstrom: 3 }),
    }, { dataset: monomers });
    expect(records).toHaveLength(1);
    const [complex] = records;
    expect(complex.coords).toHaveLength(6);
    expect(formulaOf(complex.coords)).toBe('H4O2');
    const [firstO, , , secondO] = complex.coords;
    expect(firstO.element).toBe('O');
    expect(secondO.element).toBe('O');
    expect(Math.abs(distance(firstO, secondO) - 3)).toBeLessThan(1e-9);
    // The record names both parents and the placement that made it.
    expect(complex.id).toBe('complex-water-a-water-b');
    expect(complex.label).toBe('water-a + water-b');
    expect(complex.complex.placement).toEqual({ mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 });
    expect(complex.complex.members.map((member) => member.fragment)).toEqual([1, 2]);
    expect(complex.complex.members.map((member) => member.atomCount)).toEqual([3, 3]);
    expect(complex.complex.geometryStatus).toBe(COMPLEX_GEOMETRY_STATUS);
  });

  it('labels every atom with its member: fragment 1 then fragment 2', () => {
    const monomers = dataset([water('water-a'), water('water-b')]);
    const [complex] = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement(),
    }, { dataset: monomers }).records;
    expect(complex.coords.map((atom) => atom.fragment)).toEqual([1, 1, 1, 2, 2, 2]);
    // Fragments are 1-based, the numbering `atom.fragment` and Psithon's `--` use.
    expect(Math.min(...complex.coords.map((atom) => atom.fragment))).toBe(1);
    // Member bonds are renumbered, never dropped or multiplied.
    expect(complex.bonds).toHaveLength(4);
    expect(complex.bonds.slice(0, 2)).toEqual([{ a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }]);
    expect(complex.bonds.slice(2)).toEqual([{ a: 4, b: 5, order: 1 }, { a: 4, b: 6, order: 1 }]);
  });

  it('moves each member as a rigid body: internal geometry is unchanged', () => {
    const monomers = dataset([water('water-a'), water('water-b')]);
    const [complex] = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement(),
    }, { dataset: monomers }).records;
    const before = [0, 1, 2].map((index) => waterCoords[index]);
    // Member 1 is not moved at all; member 2 keeps every internal distance.
    expect(complex.coords[0]).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(distance(complex.coords[0], complex.coords[1])).toBeCloseTo(distance(before[0], before[1]), 12);
    expect(distance(complex.coords[3], complex.coords[4])).toBeCloseTo(distance(before[0], before[1]), 12);
    expect(distance(complex.coords[3], complex.coords[5])).toBeCloseTo(distance(before[0], before[2]), 12);
  });

  it('rotates member 2 by the stated angle about the axis, through its own centre of mass', () => {
    const monomers = dataset([water('water-a'), water('water-b')]);
    const [complex] = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement({ axis: [0, 0, 1], angleDegrees: 90, distanceAngstrom: 4 }),
    }, { dataset: monomers }).records;
    const com = centreOfMass(waterCoords);
    const o = complex.coords[3];
    const h = complex.coords[4];
    // A 90° turn about z maps the O→H vector (0.96, 0, 0) to (0, 0.96, 0).
    expect(h.x - o.x).toBeCloseTo(0, 9);
    expect(h.y - o.y).toBeCloseTo(0.96, 9);
    // COM of member 2 sits 4 Å along z from member 1's COM.
    const secondCom = centreOfMass(complex.coords.slice(3));
    expect(secondCom.z - com.z).toBeCloseTo(4, 9);
    expect(secondCom.x - com.x).toBeCloseTo(0, 9);
  });

  it('places member 2 along member 1\'s smallest principal axis of inertia', () => {
    // CO2 is linear, so its smallest principal moment is the molecular axis.
    const co2 = {
      id: 'co2',
      label: 'CO2',
      charge: 0,
      multiplicity: 1,
      enabled: true,
      coords: [
        { element: 'O', x: -1.16, y: 0, z: 0 },
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'O', x: 1.16, y: 0, z: 0 },
      ],
    };
    const co2b = { ...co2, id: 'co2-b', label: 'CO2 b' };
    const gases = dataset([co2, co2b]);
    const { axes, moments } = principalAxesOfInertia(co2.coords);
    expect(moments[0]).toBeCloseTo(0, 6);
    expect(Math.abs(axes[0][0])).toBeCloseTo(1, 6);
    const [complex] = expandComplex({
      members: [{ recordId: 'co2' }, { recordId: 'co2-b' }],
      placement: { mode: 'principal', distanceAngstrom: 4.5 },
    }, { dataset: gases }).records;
    const left = centreOfMass(complex.coords.slice(0, 3));
    const right = centreOfMass(complex.coords.slice(3));
    expect(right.x - left.x).toBeCloseTo(4.5, 9);
    expect(right.y - left.y).toBeCloseTo(0, 9);
    expect(right.z - left.z).toBeCloseTo(0, 9);
    // The placement records the derived axis, so the geometry is reproducible.
    expect(complex.complex.placement.axis[0]).toBeCloseTo(1, 9);
  });

  it('refuses a principal placement when the axis is not unique', () => {
    // Methane is a spherical top: three equal principal moments.
    const methane = {
      id: 'methane',
      label: 'Methane',
      charge: 0,
      multiplicity: 1,
      enabled: true,
      coords: [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0.6291, y: 0.6291, z: 0.6291 },
        { element: 'H', x: 0.6291, y: -0.6291, z: -0.6291 },
        { element: 'H', x: -0.6291, y: 0.6291, z: -0.6291 },
        { element: 'H', x: -0.6291, y: -0.6291, z: 0.6291 },
      ],
    };
    const gases = dataset([methane, { ...methane, id: 'methane-b' }]);
    const error = refusal(() => expandComplex({
      members: [{ recordId: 'methane' }, { recordId: 'methane-b' }],
      placement: { mode: 'principal', distanceAngstrom: 4 },
    }, { dataset: gases }));
    expect(error).toBeInstanceOf(ComplexError);
    expect(error.message).toMatch(/no unique principal axis/);
    expect(error.message).toMatch(/methane/);
  });

  it('reproduces the input coordinates exactly in as-drawn mode', () => {
    const monomers = dataset([
      water('water-a'),
      water('water-b', {
        coords: [
          { element: 'O', x: 6, y: 0, z: 0 },
          { element: 'H', x: 6.96, y: 0, z: 0 },
          { element: 'H', x: 5.76, y: 0.93, z: 0 },
        ],
      }),
    ]);
    const [complex] = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: { mode: 'as-drawn' },
    }, { dataset: monomers }).records;
    // Not "close to": the same numbers, in the same order, coordinate for coordinate.
    expect(complex.coords.map((atom) => [atom.element, atom.x, atom.y, atom.z])).toEqual([
      ['O', 0, 0, 0], ['H', 0.96, 0, 0], ['H', -0.24, 0.93, 0],
      ['O', 6, 0, 0], ['H', 6.96, 0, 0], ['H', 5.76, 0.93, 0],
    ]);
    expect(complex.complex.placement).toEqual({ mode: 'as-drawn' });
  });
});

describe('issue 188 — a SAPT0 block consumes the complex with no manual labelling', () => {
  it('writes two Psi4 fragments separated by -- from the record alone', () => {
    const monomers = dataset([water('water-a'), water('water-b')]);
    const [complex] = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement(),
    }, { dataset: monomers }).records;
    const settings = {
      jobType: 'SP', method: 'sapt0', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 2,
    };
    const built = buildPsi4Input({
      settings,
      molecule: { charge: complex.charge, multiplicity: complex.multiplicity, coords: complex.coords },
    });
    expect(built.inputText).toContain("energy('sapt0')");
    expect(built.inputText).toContain('\n--\n');
    // Before the complex block, an unlabelled dimer was refused by name.
    expect(() => buildPsi4Input({
      settings,
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: complex.coords.map(({ element, x, y, z }) => ({ element, x, y, z })),
      },
    })).toThrow(/at least two fragments/);
  });
});

describe('issue 188 — guards refuse by name, before a record is built', () => {
  const monomers = dataset([water('water-a'), water('water-b')]);

  it('refuses a 0.4 Å placement, naming both atoms and the distance', () => {
    const error = refusal(() => expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement({ distanceAngstrom: 0.4 }),
    }, { dataset: monomers }));
    expect(error).toBeInstanceOf(ComplexError);
    expect(error.message).toMatch(/water-a/);
    expect(error.message).toMatch(/water-b/);
    expect(error.message).toMatch(/atom 1 \(O\)/);
    expect(error.message).toMatch(/0\.400 Å/);
    expect(error.message).toMatch(new RegExp(`${COMPLEX_MIN_SEPARATION_ANGSTROM} Å`));
  });

  it('refuses a member with no coordinates by name, never a demo geometry', () => {
    const empty = dataset([water('empty', { coords: [] }), water('water-b')]);
    const error = refusal(() => expandComplex({
      members: [{ recordId: 'empty' }, { recordId: 'water-b' }],
      placement: { mode: 'as-drawn' },
    }, { dataset: empty }));
    expect(error.message).toMatch(/member "empty" has no 3D coordinates/);
    expect(error.message).toMatch(/demo water molecule/);
  });

  it('refuses the same record twice unless the block says homodimer', () => {
    const twice = () => expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-a' }],
      placement: axisPlacement(),
    }, { dataset: monomers });
    const error = refusal(twice);
    expect(error.message).toMatch(/appears twice/);
    expect(error.message).toMatch(/homodimer/);
    const { records } = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-a' }],
      placement: axisPlacement(),
      homodimer: true,
    }, { dataset: monomers });
    expect(records[0].coords).toHaveLength(6);
    expect(records[0].complex.homodimer).toBe(true);
    expect(records[0].complex.members.map((member) => member.fragment)).toEqual([1, 2]);
  });

  it('refuses a homodimer flag on two different records, or on more than two members', () => {
    const different = refusal(() => expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement(),
      homodimer: true,
    }, { dataset: monomers }));
    expect(different.message).toMatch(/A homodimer is two copies of one record/);
    const three = refusal(() => expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-a' }, { recordId: 'water-a' }],
      placement: axisPlacement(),
      homodimer: true,
    }, { dataset: monomers }));
    expect(three.message).toMatch(/exactly two members/);
  });

  it('refuses more members than the cap, and more atoms than a structure holds', () => {
    const many = refusal(() => expandComplex({
      members: Array.from({ length: COMPLEX_MAX_MEMBERS + 1 }, () => ({ recordId: 'water-a' })),
      placement: axisPlacement(),
    }, { dataset: monomers }));
    expect(many.message).toMatch(new RegExp(`capped at ${COMPLEX_MAX_MEMBERS} members`));

    const heavy = (id) => water(id, {
      coords: Array.from({ length: 600 }, (_, index) => ({ element: 'C', x: index * 1.5, y: 0, z: 0 })),
    });
    const big = dataset([heavy('big-a'), heavy('big-b')]);
    const error = refusal(() => expandComplex({
      members: [{ recordId: 'big-a' }, { recordId: 'big-b' }],
      placement: { mode: 'as-drawn' },
    }, { dataset: big }));
    expect(error.message).toMatch(/1200 atoms/);
    expect(error.message).toMatch(new RegExp(`capped at ${COMPLEX_MAX_ATOMS} atoms`));
    // The cap is the schema's own atom ceiling, not a second number.
    expect(COMPLEX_MAX_ATOMS).toBe(LIMITS.atoms);
  });

  it('refuses a separation below the members\' covalent radii', () => {
    // 1.4 Å clears the 0.7 Å clash floor for heavy atoms but not the radius sum.
    const bromine = (id) => ({ ...water(id), coords: [{ element: 'Br', x: 0, y: 0, z: 0 }] });
    const halogens = dataset([bromine('br-a'), bromine('br-b')]);
    const error = refusal(() => expandComplex({
      members: [{ recordId: 'br-a' }, { recordId: 'br-b' }],
      placement: axisPlacement({ distanceAngstrom: 1.4 }),
    }, { dataset: halogens }));
    expect(error.message).toMatch(/covalent radii/);
    expect(error.message).toMatch(/Br 1\.20 Å/);
    expect(error.message).toMatch(/1\.40 Å/);
  });

  it('refuses an unknown record, an unknown mode and an axis with no direction', () => {
    expect(refusal(() => expandComplex({
      members: [{ recordId: 'nope' }, { recordId: 'water-b' }],
      placement: axisPlacement(),
    }, { dataset: monomers })).message).toMatch(/not an enabled record/);

    expect(refusal(() => expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: { mode: 'sideways', distanceAngstrom: 3 },
    }, { dataset: monomers })).message).toMatch(/not a placement mode/);

    expect(refusal(() => expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement({ axis: [0, 0, 0] }),
    }, { dataset: monomers })).message).toMatch(/zero vector/);
  });

  it('refuses a complex of fewer than two members', () => {
    const error = refusal(() => expandComplex({
      members: [{ recordId: 'water-a' }],
      placement: axisPlacement(),
    }, { dataset: monomers }));
    expect(error.message).toMatch(/at least two members/);
  });
});

describe('issue 188 — the definition is a schema key, absent unless asked for', () => {
  const project = (overrides = {}) => {
    const base = {
      schemaVersion: 2,
      name: 'Complex',
      molecule: {
        smiles: '', charge: 0, multiplicity: 1, fragments: [],
        coords: waterCoords, geometry: { source: 'demo', file: '', format: '' },
      },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [dataset([water('water-a'), water('water-b')])],
      flows: [{
        id: 'main',
        title: 'Complex',
        nodes: [
          {
            id: 'in1', type: 'input', kind: 'complex', title: 'Dimer', state: 'ready', x: 0, y: 0,
            input: {
              datasetId: 'monomers',
              recordFilter: { field: '', equals: '' },
              complex: {
                members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
                placement: { mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 },
              },
            },
          },
          {
            id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 200, y: 0,
            settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null,
          },
          {
            id: 'out1', type: 'output', kind: 'Output', title: 'Table', state: 'ready', x: 400, y: 0,
            output: {
              kind: 'csv', path: 'reports/complex.csv', include: 'records',
              bundle: 'project.zip', manifest: true, notes: '',
            },
          },
        ],
        edges: [{ from: 'in1', to: 'sp', type: 'dependency' }, { from: 'sp', to: 'out1', type: 'dependency' }],
      }],
      reports: [],
      activeFlowId: 'main',
      ...overrides,
    };
    return base;
  };

  it('validates the block and stores the definition', () => {
    const result = validateProject(project());
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const node = result.project.nodes[0];
    expect(node.kind).toBe('complex');
    expect(node.input.complex).toEqual({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: { mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 },
    });
    expect(result.warnings).toEqual([]);
  });

  it('round-trips the definition byte for byte', () => {
    const first = stringifyProject(project());
    expect(first.errors).toEqual([]);
    const second = stringifyProject(JSON.parse(first.text));
    expect(second.text).toBe(first.text);
    expect(first.text).toContain('"kind": "complex"');
    expect(first.text).toContain('"mode": "axis"');
  });

  it('leaves a plain dataset block without the complex keys', () => {
    const plain = project();
    plain.flows[0].nodes[0] = {
      id: 'in1', type: 'input', kind: 'Input', title: 'Monomers', state: 'ready', x: 0, y: 0,
      input: { datasetId: 'monomers', recordFilter: { field: '', equals: '' } },
    };
    const result = stringifyProject(plain);
    expect(result.errors).toEqual([]);
    expect(result.text).not.toContain('"kind": "complex"');
    expect(result.text).not.toContain('"placement"');
    expect(result.text).not.toContain('"members"');
  });

  it('refuses a kind of "complex" with no definition, and a one-member definition', () => {
    const empty = project();
    delete empty.flows[0].nodes[0].input.complex;
    const emptyResult = validateProject(empty);
    expect(emptyResult.errors.some((error) => error.path.endsWith('input.complex')
      && /is required when the block kind is "complex"/.test(error.message))).toBe(true);

    const single = project();
    single.flows[0].nodes[0].input.complex.members = [{ recordId: 'water-a' }];
    const singleResult = validateProject(single);
    expect(singleResult.errors.some((error) => error.path.endsWith('input.complex.members')
      && /at least two members/.test(error.message))).toBe(true);
  });

  it('refuses one block carrying two structure definitions', () => {
    const both = project();
    both.flows[0].nodes[0].input.series = {
      from: 1, to: 2, linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    };
    const result = validateProject(both);
    expect(result.errors.some((error) => error.path.endsWith('input')
      && /more than one of a series definition, an edit list and a complex/.test(error.message))).toBe(true);
  });

  it('shows a refused placement when the project is opened, naming the atoms', () => {
    const bad = project();
    bad.flows[0].nodes[0].input.complex.placement.distanceAngstrom = 0.4;
    const result = validateProject(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('input.complex')
      && /overlap/.test(error.message)
      && /0\.400 Å/.test(error.message))).toBe(true);
  });

  it('requires the placement numbers instead of inventing them', () => {
    const missing = project();
    delete missing.flows[0].nodes[0].input.complex.placement.distanceAngstrom;
    const result = validateProject(missing);
    expect(result.errors.some((error) => error.path.endsWith('input.complex.placement.distanceAngstrom')
      && /is required/.test(error.message))).toBe(true);
  });

  it('drops an unknown complex key with a warning instead of storing it', () => {
    const extra = project();
    extra.flows[0].nodes[0].input.complex.placement.solvent = 'water';
    const result = validateProject(extra);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => warning.path.endsWith('input.complex.placement.solvent'))).toBe(true);
    expect(result.project.nodes[0].input.complex.placement.solvent).toBeUndefined();
  });
});

describe('issue 188 — the plan queues one complex, and the task carries its provenance', () => {
  const plan = () => {
    const result = validateProject({
      schemaVersion: 2,
      name: 'Complex plan',
      molecule: {
        smiles: '', charge: 0, multiplicity: 1, fragments: [],
        coords: waterCoords, geometry: { source: 'demo', file: '', format: '' },
      },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [dataset([water('water-a'), water('water-b')])],
      flows: [{
        id: 'main',
        title: 'Complex',
        nodes: [
          {
            id: 'in1', type: 'input', kind: 'complex', title: 'Dimer', state: 'ready', x: 0, y: 0,
            input: {
              datasetId: 'monomers',
              recordFilter: { field: '', equals: '' },
              complex: {
                members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
                placement: { mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 },
              },
            },
          },
          {
            id: 'sp', type: 'calc', kind: 'SP', title: 'SAPT0', state: 'ready', x: 200, y: 0,
            settings: defaultSettings({ jobType: 'SP', engine: 'psi4', method: 'sapt0', basis: 'def2-SVP' }),
            output: null, checkpointFrom: null,
          },
          {
            id: 'out1', type: 'output', kind: 'Output', title: 'Table', state: 'ready', x: 400, y: 0,
            output: {
              kind: 'csv', path: 'reports/complex.csv', include: 'records',
              bundle: 'project.zip', manifest: true, notes: '',
            },
          },
        ],
        edges: [{ from: 'in1', to: 'sp', type: 'dependency' }, { from: 'sp', to: 'out1', type: 'dependency' }],
      }],
      reports: [],
      activeFlowId: 'main',
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    return buildWorkflowPlan(result.project);
  };

  it('queues one record for the block, not one per member', () => {
    const built = plan();
    const inputTask = built.tasks.find((task) => task.nodeId === 'in1');
    expect(inputTask.input.records).toHaveLength(1);
    expect(inputTask.input.records[0].id).toBe('complex-water-a-water-b');
    expect(inputTask.input.complex.placement.distanceAngstrom).toBe(3);
    expect(inputTask.input.records[0].complex.placement.mode).toBe('axis');
    const calc = built.tasks.find((task) => task.nodeId.startsWith('sp'));
    expect(calc.complex.placement).toEqual({ mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 });
    expect(calc.complex.members.map((member) => member.fragment)).toEqual([1, 2]);
    expect(calc.title).toContain('water-a + water-b');
  });

  it('counts one record on the flow tab, not one per member', () => {
    const result = validateProject({
      schemaVersion: 2,
      name: 'Complex tab',
      molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: waterCoords, geometry: { source: 'demo', file: '', format: '' } },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [dataset([water('water-a'), water('water-b')])],
      flows: [{
        id: 'main',
        title: 'Complex',
        nodes: [{
          id: 'in1', type: 'input', kind: 'complex', title: 'Dimer', state: 'ready', x: 0, y: 0,
          input: {
            datasetId: 'monomers',
            recordFilter: { field: '', equals: '' },
            complex: {
              members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
              placement: { mode: 'axis', axis: [1, 0, 0], distanceAngstrom: 3, angleDegrees: 0 },
            },
          },
        }],
        edges: [],
      }],
      reports: [],
      activeFlowId: 'main',
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(flowTabModels(result.project)[0].recordCount).toBe(1);
  });

  it('writes a Psi4 SAPT0 input with two fragments and one complex', () => {
    const built = plan();
    const calc = built.tasks.find((task) => task.nodeId.startsWith('sp'));
    expect(calc.engine).toBe('psi4');
    expect(calc.inputText).toContain("energy('sapt0')");
    expect(calc.inputText).toContain('\n--\n');
    // The writer downstream sees one record, so a CSV has one row per complex.
    const rows = built.tasks.filter((task) => task.nodeId.startsWith('sp'));
    expect(rows).toHaveLength(1);
  });
});

describe('issue 188 — a member may name another dataset', () => {
  it('resolves members from the project\'s datasets, not only the bound one', () => {
    const monomers = dataset([water('water-a')]);
    const guests = dataset([water('guest')], 'guests');
    const definition = {
      members: [{ datasetId: 'monomers', recordId: 'water-a' }, { datasetId: 'guests', recordId: 'guest' }],
      placement: axisPlacement(),
    };
    const node = {
      type: 'input',
      input: { datasetId: 'monomers', recordFilter: { field: '', equals: '' }, complex: definition },
    };
    const records = recordsForInput(node, monomers, { datasets: [monomers, guests] });
    expect(records).toHaveLength(1);
    expect(records[0].complex.members.map((member) => `${member.datasetId}:${member.id}`))
      .toEqual(['monomers:water-a', 'guests:guest']);
    // Without the list, the member of another dataset is refused by name.
    expect(() => recordsForInput(node, monomers)).toThrow(/names dataset "guests"/);
  });

  it('builds an id that names every parent and fits the record-id budget', () => {
    const monomers = dataset([water('water-a'), water('water-b')]);
    const [record] = expandComplex({
      members: [{ recordId: 'water-a' }, { recordId: 'water-b' }],
      placement: axisPlacement(),
    }, { dataset: monomers }).records;
    expect(record.id).toBe(complexRecordId([{ id: 'water-a' }, { id: 'water-b' }]));
    expect(record.id.length).toBeLessThanOrEqual(64);
  });

  it('states the placement modes it implements', () => {
    expect([...COMPLEX_PLACEMENT_MODES]).toEqual(['as-drawn', 'axis', 'principal']);
  });

  it('adds nothing to defaultSettings(), and uses the same needs-optimisation status', () => {
    expect(JSON.stringify(defaultSettings())).not.toContain('complex');
    expect(COMPLEX_GEOMETRY_STATUS).toBe('needs optimisation');
  });
});
