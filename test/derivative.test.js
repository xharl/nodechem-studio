import { describe, expect, it } from 'vitest';
import {
  DerivativeEditError,
  GEOMETRY_STATUS,
  ISOTOPES,
  MAX_VALENCE,
  applyEdit,
  applyEdits,
  formulaOf,
} from '../src/shared/derivative.js';
import { COVALENT_RADII_ANGSTROM } from '../src/shared/validityChecks.js';

/**
 * Fixtures are built here from explicit coordinates and bonds, not imported:
 * the engine's whole claim is about what happens to a geometry it can see.
 */

const RADII = COVALENT_RADII_ANGSTROM;

/** Benzene: C–C 1.397 Å in a planar hexagon, C–H 1.084 Å radial. Atoms 1–6 C, 7–12 H. */
function benzene() {
  const ring = 1.397;
  const ch = 1.084;
  const atoms = [];
  for (let k = 0; k < 6; k += 1) {
    const angle = (k * Math.PI) / 3;
    atoms.push({ element: 'C', x: ring * Math.cos(angle), y: ring * Math.sin(angle), z: 0 });
  }
  for (let k = 0; k < 6; k += 1) {
    const angle = (k * Math.PI) / 3;
    atoms.push({ element: 'H', x: (ring + ch) * Math.cos(angle), y: (ring + ch) * Math.sin(angle), z: 0 });
  }
  const bonds = [];
  for (let k = 0; k < 6; k += 1) {
    const next = ((k + 1) % 6) + 1;
    bonds.push({ a: Math.min(k + 1, next), b: Math.max(k + 1, next), order: 1.5 });
  }
  for (let k = 0; k < 6; k += 1) {
    bonds.push({ a: k + 1, b: k + 7, order: 1 });
  }
  return { atoms, bonds, charge: 0, multiplicity: 1 };
}

/** Water: 0.9572 Å O–H at 104.52°. Atoms 1 O, 2 H, 3 H. */
function water() {
  const r = 0.9572;
  const theta = (104.52 * Math.PI) / 180;
  return {
    atoms: [
      { element: 'O', x: 0, y: 0, z: 0 },
      { element: 'H', x: r, y: 0, z: 0 },
      { element: 'H', x: r * Math.cos(theta), y: r * Math.sin(theta), z: 0 },
    ],
    bonds: [{ a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
    charge: 0,
    multiplicity: 1,
  };
}

/** Methanol. Atoms 1 C, 2 O, 3–5 methyl H, 6 hydroxyl H. */
function methanol() {
  return {
    atoms: [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'O', x: 1.43, y: 0, z: 0 },
      { element: 'H', x: -0.36, y: 1.03, z: 0 },
      { element: 'H', x: -0.36, y: -0.52, z: 0.89 },
      { element: 'H', x: -0.36, y: -0.52, z: -0.89 },
      { element: 'H', x: 1.133, y: 0.913, z: 0 },
    ],
    bonds: [
      { a: 1, b: 2, order: 1 },
      { a: 1, b: 3, order: 1 },
      { a: 1, b: 4, order: 1 },
      { a: 1, b: 5, order: 1 },
      { a: 2, b: 6, order: 1 },
    ],
    charge: 0,
    multiplicity: 1,
  };
}

const distance = (left, right) => Math.sqrt(
  (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2,
);

const snapshot = (value) => JSON.parse(JSON.stringify(value));

describe('benzene → fluorobenzene (issue #189 acceptance criterion)', () => {
  const parent = benzene();
  const before = snapshot(parent);
  const result = applyEdit(parent, { op: 'substitute', atom: 7, element: 'F' });

  it('keeps the atom and bond count and reports the derived formula', () => {
    expect(parent.atoms).toHaveLength(12);
    expect(parent.bonds).toHaveLength(12);
    expect(result.atoms).toHaveLength(12);
    expect(result.bonds).toHaveLength(12);
    expect(result.formula).toBe('C6H5F');
  });

  it('gives exactly one C–F bond at the sum of the two Cordero radii', () => {
    expect(result.atoms[6].element).toBe('F');
    const carbons = result.atoms
      .map((atom, index) => ({ atom, index }))
      .filter(({ atom }) => atom.element === 'C');
    const cf = carbons
      .map(({ atom }) => distance(atom, result.atoms[6]))
      .filter((length) => length <= RADII.C + RADII.F + 1e-6);
    expect(cf).toHaveLength(1);
    expect(RADII.C).toBe(0.76);
    expect(RADII.F).toBe(0.57);
    expect(cf[0]).toBeCloseTo(RADII.C + RADII.F, 9);
    // A naive "swap the element symbol" edit would keep the C–H distance
    // (1.084 Å) and this assertion would fail: the two are 0.25 Å apart.
    expect(cf[0]).not.toBeCloseTo(1.084, 2);
    expect(result.bonds.filter((bond) => bond.a === 1 && bond.b === 7)).toHaveLength(1);
    expect(result.bonds.find((bond) => bond.a === 1 && bond.b === 7).order).toBe(1);
  });

  it('keeps the replaced bond direction and every other coordinate bit for bit', () => {
    const parentAtom = parent.atoms[6];
    const partner = parent.atoms[0];
    const length = Math.hypot(parentAtom.x - partner.x, parentAtom.y - partner.y, parentAtom.z - partner.z);
    const unit = {
      x: (parentAtom.x - partner.x) / length,
      y: (parentAtom.y - partner.y) / length,
      z: (parentAtom.z - partner.z) / length,
    };
    const expected = [
      partner.x + unit.x * (RADII.C + RADII.F),
      partner.y + unit.y * (RADII.C + RADII.F),
      partner.z + unit.z * (RADII.C + RADII.F),
    ];
    expect(result.atoms[6].x).toBeCloseTo(expected[0], 12);
    expect(result.atoms[6].y).toBeCloseTo(expected[1], 12);
    expect(result.atoms[6].z).toBeCloseTo(expected[2], 12);

    result.atoms.forEach((atom, index) => {
      if (index === 6) return;
      expect(atom.x).toBe(parent.atoms[index].x);
      expect(atom.y).toBe(parent.atoms[index].y);
      expect(atom.z).toBe(parent.atoms[index].z);
      expect(atom.element).toBe(parent.atoms[index].element);
    });
    expect(result.bonds).toEqual(parent.bonds);
  });

  it('flags the record as a topology, not a minimum', () => {
    expect(result.geometryStatus).toBe(GEOMETRY_STATUS);
    expect(result.geometryStatus).toBe('needs optimisation');
    expect(result.geometryNote).toMatch(/not a minimum/i);
    expect(result.geometryNote).toMatch(/plausible starting geometry/i);
    expect(result.provenance.geometry.status).toBe('needs optimisation');
    expect(result.provenance.geometry.rule).toMatch(/Cordero/);
  });

  it('records parent, operation, atom index and the resulting formula', () => {
    expect(result.provenance.kind).toBe('derivative');
    expect(result.provenance.parent.formula).toBe('C6H6');
    expect(result.provenance.parent.atomCount).toBe(12);
    expect(result.provenance.parent.bondCount).toBe(12);
    expect(result.provenance.atomIndexBase).toBe(1);
    const [operation] = result.provenance.operations;
    expect(operation.op).toBe('substitute');
    expect(operation.atomIndex).toBe(7);
    expect(operation.element).toBe('F');
    expect(operation.before).toEqual({ element: 'H', isotope: null });
    expect(operation.after).toEqual({ element: 'F', isotope: null });
    expect(operation.formula).toBe('C6H5F');
  });

  it('returns a new object and leaves the input deep-equal to what it was', () => {
    expect(result).not.toBe(parent);
    expect(result.atoms).not.toBe(parent.atoms);
    expect(result.atoms[6]).not.toBe(parent.atoms[6]);
    expect(result.bonds).not.toBe(parent.bonds);
    expect(parent).toEqual(before);
  });
});

describe('refusals, by name', () => {
  it('refuses a substitution on an atom already at full valence, naming atom and element', () => {
    const edit = () => applyEdit(benzene(), { op: 'substitute', atom: 1, element: 'F' });
    expect(edit).toThrow(DerivativeEditError);
    expect(edit).toThrow(/Atom 1 \(C\) is at full valence \(4 of 4\)/);
    try {
      edit();
    } catch (error) {
      expect(error.code).toBe('not-single-bond');
      expect(error.atomIndex).toBe(1);
      expect(error.element).toBe('C');
    }
  });

  it('refuses a molecule that states no bonds, instead of guessing a topology', () => {
    const parent = benzene();
    const absent = () => applyEdit({ atoms: parent.atoms, charge: 0, multiplicity: 1 }, {
      op: 'substitute', atom: 7, element: 'F',
    });
    expect(absent).toThrow(/states no bonds/);
    expect(absent).toThrow(/guess/);
    try {
      absent();
    } catch (error) {
      expect(error.code).toBe('no-bonds');
    }
    const empty = () => applyEdit({ ...parent, bonds: [] }, { op: 'isotope', atom: 7, mass: 2 });
    expect(empty).toThrow(DerivativeEditError);
  });

  it('refuses an atom index outside the structure', () => {
    expect(() => applyEdit(benzene(), { op: 'substitute', atom: 13, element: 'F' }))
      .toThrow(/Atom 13 is outside this structure, which has 12 atoms/);
    expect(() => applyEdit(benzene(), { op: 'remove', atom: 0, charge: -1, multiplicity: 1 }))
      .toThrow(/Atom 0 is outside this structure/);
  });

  it('refuses an add to an atom with no free valence', () => {
    expect(() => applyEdit(benzene(), { op: 'add', atom: 1, element: 'F', charge: 0, multiplicity: 2 }))
      .toThrow(/Atom 1 \(C\) already uses 4 of 4 and cannot take another bond/);
  });

  it('refuses an isotope the element does not have, and lists the ones it does', () => {
    expect(() => applyEdit(benzene(), { op: 'isotope', atom: 7, mass: 5 }))
      .toThrow(/Atom 7 \(H\) has no isotope of mass 5; the table lists 1, 2, 3/);
    expect(ISOTOPES.H).toEqual([1, 2, 3]);
  });

  it('refuses an empty edit list and an unknown op', () => {
    expect(() => applyEdits(benzene(), [])).toThrow(/at least one edit/);
    expect(() => applyEdit(benzene(), { op: 'polymerise', atom: 1 })).toThrow(/Unknown edit op "polymerise"/);
  });

  it('refuses an edit list that produces the same structure twice', () => {
    const edit = { op: 'substitute', atom: 7, element: 'F' };
    expect(() => applyEdits(benzene(), [edit, { ...edit }]))
      .toThrow(/structure identical to one this list already produced/);
  });

  it('refuses an edit whose spin state the parent no longer supports', () => {
    // Removing an H from a closed-shell 42-electron molecule leaves 41
    // electrons; multiplicity 1 cannot describe that, and the module will not
    // pick 2 on its own.
    expect(() => applyEdit(benzene(), { op: 'remove', atom: 7 }))
      .toThrow(/odd count, so multiplicity 1 cannot describe the structure/);
  });
});

describe('isotopologue: ¹H → ²H changes the mass number and nothing else', () => {
  it('sets the isotope and copies every coordinate and bond unchanged', () => {
    const parent = benzene();
    const result = applyEdit(parent, { op: 'isotope', atom: 8, mass: 2 });

    expect(result.atoms[7].element).toBe('H');
    expect(result.atoms[7].isotope).toBe(2);
    expect(parent.atoms[7].isotope).toBeUndefined();

    result.atoms.forEach((atom, index) => {
      expect(atom.x).toBe(parent.atoms[index].x);
      expect(atom.y).toBe(parent.atoms[index].y);
      expect(atom.z).toBe(parent.atoms[index].z);
      expect(atom.element).toBe(parent.atoms[index].element);
    });
    // One neutron more: mass number 1 → 2, which is the only stored change.
    expect(result.atoms[7].isotope - (parent.atoms[7].isotope ?? 1)).toBe(1);
    expect(result.bonds).toEqual(parent.bonds);
    expect(result.charge).toBe(parent.charge);
    expect(result.multiplicity).toBe(parent.multiplicity);
    expect(result.formula).toBe('C6H6');
    expect(result.provenance.operations[0].before).toEqual({ element: 'H', isotope: null });
    expect(result.provenance.operations[0].after).toEqual({ element: 'H', isotope: 2 });
  });
});

describe('protonate and deprotonate require the state they produce', () => {
  it('refuses a deprotonation with no stated charge', () => {
    expect(() => applyEdit(methanol(), { op: 'deprotonate', atom: 6, multiplicity: 1 }))
      .toThrow(/deprotonate must state the resulting charge/);
  });

  it('refuses a deprotonation with no stated multiplicity', () => {
    expect(() => applyEdit(methanol(), { op: 'deprotonate', atom: 6, charge: -1 }))
      .toThrow(/deprotonate must state the resulting multiplicity/);
  });

  it('accepts a deprotonation that states both, and removes the H and its bond', () => {
    const result = applyEdit(methanol(), { op: 'deprotonate', atom: 6, charge: -1, multiplicity: 1 });
    expect(result.atoms).toHaveLength(5);
    expect(result.bonds).toHaveLength(4);
    expect(result.formula).toBe('CH3O');
    expect(result.charge).toBe(-1);
    expect(result.multiplicity).toBe(1);
    expect(result.provenance.operations[0].op).toBe('deprotonate');
    expect(result.provenance.operations[0].charge).toBe(-1);
  });

  it('refuses a deprotonation on an atom that is not hydrogen', () => {
    expect(() => applyEdit(methanol(), { op: 'deprotonate', atom: 1, charge: -1, multiplicity: 1 }))
      .toThrow(/Atom 1 is C, not hydrogen/);
  });

  it('protonates water to H3O+ along the bisector of the two O–H bonds', () => {
    const parent = water();
    const result = applyEdit(parent, { op: 'protonate', atom: 1, charge: 1, multiplicity: 1 });

    expect(result.atoms).toHaveLength(4);
    expect(result.bonds).toHaveLength(3);
    expect(result.formula).toBe('H3O');
    expect(result.charge).toBe(1);
    expect(result.multiplicity).toBe(1);

    const oxygen = result.atoms[0];
    const added = result.atoms[3];
    expect(added.element).toBe('H');
    expect(distance(oxygen, added)).toBeCloseTo(RADII.O + RADII.H, 12);

    const units = [result.atoms[1], result.atoms[2]].map((atom) => {
      const length = distance(oxygen, atom);
      return { x: (atom.x - oxygen.x) / length, y: (atom.y - oxygen.y) / length, z: (atom.z - oxygen.z) / length };
    });
    const sum = { x: units[0].x + units[1].x, y: units[0].y + units[1].y, z: units[0].z + units[1].z };
    const magnitude = Math.hypot(sum.x, sum.y, sum.z);
    expect(added.x).toBeCloseTo(oxygen.x - (sum.x / magnitude) * (RADII.O + RADII.H), 12);
    expect(added.y).toBeCloseTo(oxygen.y - (sum.y / magnitude) * (RADII.O + RADII.H), 12);
    expect(added.z).toBeCloseTo(oxygen.z - (sum.z / magnitude) * (RADII.O + RADII.H), 12);
  });

  it('refuses a protonation that would leave the stated spin state impossible', () => {
    expect(() => applyEdit(water(), { op: 'protonate', atom: 1, charge: 1, multiplicity: 2 }))
      .toThrow(/cannot describe the structure/);
  });
});

describe('add', () => {
  it('places a new atom opposite the parent bonds and bonds it', () => {
    // Water plus a hydrogen: a hydroxyl radical, so the caller states
    // multiplicity 2 rather than letting the module invent it.
    const result = applyEdit(water(), { op: 'add', atom: 1, element: 'H', charge: 0, multiplicity: 2 });
    expect(result.atoms).toHaveLength(4);
    expect(result.bonds).toHaveLength(3);
    expect(result.bonds[2]).toEqual({ a: 1, b: 4, order: 1 });
    expect(result.formula).toBe('H3O');
    expect(distance(result.atoms[0], result.atoms[3])).toBeCloseTo(RADII.O + RADII.H, 12);
    expect(result.provenance.operations[0].atomCreated).toBe(4);
  });

  it('refuses an add with no free valence and names the atom and element', () => {
    const methaneLike = {
      atoms: [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'H', x: 1.087, y: 0, z: 0 },
        { element: 'H', x: -0.362, y: 1.026, z: 0 },
        { element: 'H', x: -0.362, y: -0.513, z: 0.889 },
        { element: 'H', x: -0.362, y: -0.513, z: -0.889 },
      ],
      bonds: [
        { a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 },
        { a: 1, b: 4, order: 1 }, { a: 1, b: 5, order: 1 },
      ],
      charge: 0,
      multiplicity: 1,
    };
    expect(MAX_VALENCE.C).toBe(4);
    expect(() => applyEdit(methaneLike, { op: 'add', atom: 1, element: 'H', charge: 0, multiplicity: 2 }))
      .toThrow(/Atom 1 \(C\) already uses 4 of 4/);
  });
});

describe('applyEdits composes in order', () => {
  it('applies a substitution then an isotope, each step recorded', () => {
    const result = applyEdits(benzene(), [
      { op: 'substitute', atom: 7, element: 'F' },
      { op: 'isotope', atom: 8, mass: 2 },
    ]);
    expect(result.formula).toBe('C6H5F');
    expect(result.atoms[6].element).toBe('F');
    expect(result.atoms[7].isotope).toBe(2);
    expect(result.provenance.operations.map((operation) => operation.op)).toEqual(['substitute', 'isotope']);
    expect(result.provenance.operations.map((operation) => operation.formula)).toEqual(['C6H5F', 'C6H5F']);
  });

  it('resolves indices against the structure each edit reaches', () => {
    // Remove H(7) first: atom 8 becomes atom 7, so the isotope lands on the H
    // that was atom 8 in the parent.
    const result = applyEdits(benzene(), [
      { op: 'remove', atom: 7, charge: -1, multiplicity: 1 },
      { op: 'isotope', atom: 7, mass: 2 },
    ]);
    expect(result.atoms).toHaveLength(11);
    expect(result.formula).toBe('C6H5');
    expect(result.atoms[6].isotope).toBe(2);
    expect(result.atoms[6].element).toBe('H');
    expect(result.provenance.operations[1].atomIndex).toBe(7);
  });
});

describe('formulaOf', () => {
  it('is Hill order and never a stored string', () => {
    expect(formulaOf(benzene().atoms)).toBe('C6H6');
    expect(formulaOf(water().atoms)).toBe('H2O');
    expect(formulaOf([{ element: 'Cl' }, { element: 'Na' }])).toBe('ClNa');
    expect(formulaOf([])).toBe('');
  });
});
