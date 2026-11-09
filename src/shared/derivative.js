/**
 * Derivative structures — one graph edit applied to a structure that already
 * exists (issue #189).
 *
 * Three routine questions are the same edit:
 *
 *   - a substituent scan (H → F, Cl, OMe) compares N structures that differ by
 *     one atom, each traceable to its parent;
 *   - a protomer or charge state is the protonated/deprotonated form of the
 *     same molecule, not a second import;
 *   - an isotopologue is a one-atom edit with an exact expected answer.
 *
 * This module owns that edit and nothing else: no UI, no project schema, no
 * plan expansion. Given a molecule and an edit it returns a **new** molecule —
 * the input is never mutated — plus the provenance that says what was done.
 *
 * Contract
 * --------
 *
 *   applyEdit(molecule, edit)   -> record
 *   applyEdits(molecule, edits) -> record, edits composed in order
 *
 * The record is
 *
 *   { atoms, bonds, charge, multiplicity, formula, geometryStatus,
 *     geometryNote, provenance }
 *
 * Atom indices are **1-based**, the same numbering as `bonds[].a/.b`, the
 * project schema and the atom list in the app. An index is resolved against the
 * molecule as each edit reaches it: a `remove` renumbers the atoms after it, so
 * a later edit in the same list sees the shifted numbering. Each provenance
 * step records the index it actually used.
 *
 * Ops
 * ---
 *
 *   substitute  { op, atom, element }         replace atom `atom` by `element`
 *   add         { op, atom, element }         new atom bonded to atom `atom`
 *   remove      { op, atom }                  delete atom `atom` and its bonds
 *   isotope     { op, atom, mass }            set the mass number only
 *   protonate   { op, atom, charge, multiplicity }   add H at atom `atom`
 *   deprotonate { op, atom, charge, multiplicity }   remove H from atom `atom`
 *
 * `protonate`/`deprotonate` are sugar over `add`/`remove` plus the resulting
 * charge and multiplicity, which the caller **must** state. They are never
 * inferred: the spin state of the product is the caller's claim, not this
 * module's guess. Any op may state `charge`/`multiplicity` to replace the
 * inherited values.
 *
 * Geometry
 * --------
 *
 * A substitution or an addition needs a coordinate, and a plausible one is all
 * this module claims to produce:
 *
 *   - `substitute` keeps the direction of the replaced bond, seen from the atom
 *     that stays, and sets the new bond length to the sum of the two Cordero
 *     covalent radii;
 *   - `add` places the new atom along the direction opposite the parent atom's
 *     existing bonds (the bisector when there are several) at the same
 *     radii-sum distance;
 *   - every other coordinate is copied unchanged, bit for bit.
 *
 * `remove` deletes an atom and `isotope` moves nothing at all. Radii are the
 * Cordero et al., Dalton Trans. 2008, 2832 single-bond values already shipped
 * as `COVALENT_RADII_ANGSTROM` in `validityChecks.js` — this module does not
 * carry a second table.
 *
 * The result is therefore **a topology with a plausible starting geometry, not
 * a minimum** (a C–F placed on a C–H vector is not a relaxed C–F), and
 * `geometryStatus` says exactly `needs optimisation`.
 *
 * Refusals
 * --------
 *
 * Every refusal is by name, carries `code`, `atomIndex` and `element` where
 * they apply, and happens before a record is built:
 *
 *   atom-out-of-range    the index is not an atom of this structure
 *   no-bonds             the molecule states no bonds: a valence check or a
 *                        bond direction would be a guess, so nothing is edited
 *                        (the same precedent as `structureImport.js`)
 *   dangling-bond        an input bond refers to an atom that does not exist
 *   not-single-bond      substitution needs exactly one single bond to replace
 *   valence-exceeded     the edit would use more bonds than the element forms
 *   no-anchor            `add` to an atom with no existing bond has no direction
 *   no-direction         the parent's bond directions cancel (a linear centre)
 *   empty-molecule       `remove` would leave no atoms
 *   unknown-isotope      the element has no isotope of that mass number
 *   charge-not-stated    `protonate`/`deprotonate` without a charge
 *   multiplicity-not-stated  same, without a multiplicity
 *   not-hydrogen         `deprotonate` on an atom that is not hydrogen
 *   spin-parity          charge and multiplicity disagree with the electron
 *                        count (odd electron count needs an even multiplicity)
 *   unknown-op / no-edits / duplicate-record
 *
 * A value that cannot be computed is never invented: an element outside the
 * shipped tables is refused rather than given a guessed radius or valence.
 */

import { atomicNumber, isElementSymbol } from './elements.js';
import { formulaOf } from './formula.js';
import { COVALENT_RADII_ANGSTROM } from './validityChecks.js';

/**
 * Re-exported so a caller of this module never has to know that `formula.js`
 * owns the Hill ordering; the formula in a record is computed from its atoms.
 */
export { formulaOf };

/** The one status an edited geometry may carry. Never reword it in one place. */
export const GEOMETRY_STATUS = 'needs optimisation';

/** The sentence the card and the provenance both print. */
export const GEOMETRY_NOTE = 'This is a topology with a plausible starting geometry, not a '
  + 'minimum: nothing here was relaxed, and a bond placed at the sum of two covalent radii is a '
  + 'starting distance, not an optimised one.';

/** The rule the coordinates follow, verbatim, in the provenance. */
export const GEOMETRY_RULE = 'substitute keeps the direction of the replaced bond from the atom '
  + 'that stays and sets the new bond length to the sum of the two Cordero covalent radii; add '
  + 'places the new atom opposite the parent atom\'s existing bonds (the bisector when there are '
  + 'several) at the same radii-sum distance; every other coordinate is copied unchanged.';

/**
 * Largest number of covalent bonds an element is treated as able to carry, as a
 * guard and not as a valence model: the values are the ceilings reached by
 * ordinary closed-shell compounds (N 4 for ammonium, O 3 for oxonium, S 6 for
 * sulfate, Cl 7 for perchlorate). An element absent from the table has no
 * tabulated ceiling, so an edit that would need one is refused instead of
 * guessed.
 */
export const MAX_VALENCE = Object.freeze({
  H: 1, He: 0,
  Li: 1, Be: 2, B: 3, C: 4, N: 4, O: 3, F: 1, Ne: 0,
  Na: 1, Mg: 2, Al: 3, Si: 4, P: 5, S: 6, Cl: 7, Ar: 0,
  K: 1, Ca: 2, Ga: 3, Ge: 4, As: 5, Se: 6, Br: 7, Kr: 0,
  Rb: 1, Sr: 2, In: 3, Sn: 4, Sb: 5, Te: 6, I: 7, Xe: 0,
  Cs: 1, Ba: 2, Tl: 3, Pb: 4, Bi: 5, Po: 6, At: 7, Rn: 0,
});

/**
 * Known isotopes, by mass number, for H through I. Stable isotopes only, plus
 * the two long-lived tracers that are used in practice (³H, ¹⁴C). An element
 * outside this table, or a mass number not listed for it, is refused: an
 * isotope record that names a nucleus which does not exist would travel into an
 * input deck and be silently rounded by the engine.
 */
export const ISOTOPES = Object.freeze({
  H: Object.freeze([1, 2, 3]),
  He: Object.freeze([3, 4]),
  Li: Object.freeze([6, 7]),
  Be: Object.freeze([9]),
  B: Object.freeze([10, 11]),
  C: Object.freeze([12, 13, 14]),
  N: Object.freeze([14, 15]),
  O: Object.freeze([16, 17, 18]),
  F: Object.freeze([19]),
  Ne: Object.freeze([20, 21, 22]),
  Na: Object.freeze([23]),
  Mg: Object.freeze([24, 25, 26]),
  Al: Object.freeze([27]),
  Si: Object.freeze([28, 29, 30]),
  P: Object.freeze([31]),
  S: Object.freeze([32, 33, 34, 36]),
  Cl: Object.freeze([35, 37]),
  Ar: Object.freeze([36, 38, 40]),
  K: Object.freeze([39, 40, 41]),
  Ca: Object.freeze([40, 42, 43, 44, 46, 48]),
  Sc: Object.freeze([45]),
  Ti: Object.freeze([46, 47, 48, 49, 50]),
  V: Object.freeze([50, 51]),
  Cr: Object.freeze([50, 52, 53, 54]),
  Mn: Object.freeze([55]),
  Fe: Object.freeze([54, 56, 57, 58]),
  Co: Object.freeze([59]),
  Ni: Object.freeze([58, 60, 61, 62, 64]),
  Cu: Object.freeze([63, 65]),
  Zn: Object.freeze([64, 66, 67, 68, 70]),
  Ga: Object.freeze([69, 71]),
  Ge: Object.freeze([70, 72, 73, 74, 76]),
  As: Object.freeze([75]),
  Se: Object.freeze([74, 76, 77, 78, 80, 82]),
  Br: Object.freeze([79, 81]),
  Kr: Object.freeze([78, 80, 82, 83, 84, 86]),
  Rb: Object.freeze([85, 87]),
  Sr: Object.freeze([84, 86, 87, 88]),
  Y: Object.freeze([89]),
  Zr: Object.freeze([90, 91, 92, 94, 96]),
  Nb: Object.freeze([93]),
  Mo: Object.freeze([92, 94, 95, 96, 97, 98, 100]),
  Tc: Object.freeze([97, 98, 99]),
  Ru: Object.freeze([96, 98, 99, 100, 101, 102, 104]),
  Rh: Object.freeze([103]),
  Pd: Object.freeze([102, 104, 105, 106, 108, 110]),
  Ag: Object.freeze([107, 109]),
  Cd: Object.freeze([106, 108, 110, 111, 112, 113, 114, 116]),
  In: Object.freeze([113, 115]),
  Sn: Object.freeze([112, 114, 115, 116, 117, 118, 119, 120, 122, 124]),
  Sb: Object.freeze([121, 123]),
  Te: Object.freeze([120, 122, 123, 124, 125, 126, 128, 130]),
  I: Object.freeze([127]),
});

/** A refused edit. `code`, `atomIndex` and `element` are for the caller's UI. */
export class DerivativeEditError extends Error {
  constructor(message, { code = 'derivative', atomIndex = null, element = null } = {}) {
    super(message);
    this.name = 'DerivativeEditError';
    this.code = code;
    this.atomIndex = atomIndex;
    this.element = element;
  }
}

const BOND_ORDERS = Object.freeze([1, 1.5, 2, 3]);
const MAX_CHARGE = 10;
const MAX_MULTIPLICITY = 10;
/** A bisector shorter than this is a straight centre: the direction is undefined. */
const DIRECTION_FLOOR = 1e-6;

function refuse(message, code, { atomIndex = null, element = null } = {}) {
  throw new DerivativeEditError(message, { code, atomIndex, element });
}

function own(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/* ── reading the parent ───────────────────────────────────── */

/**
 * A molecule here is `{ atoms | coords, bonds?, charge?, multiplicity? }`. The
 * topology must be stated: an absent `bonds` array means "never stated" (see
 * `normalizeBonds`), and this module refuses it for every op rather than
 * perceive bonds from distances — a valence check or a bond direction built on
 * a perception guess is exactly the silent fallback `structureImport.js`
 * refuses for SMILES.
 */
function readMolecule(molecule) {
  if (!molecule || typeof molecule !== 'object') {
    refuse('A derivative needs a molecule object with atoms; this is not one.', 'no-atoms');
  }
  const source = Array.isArray(molecule.atoms)
    ? molecule.atoms
    : (Array.isArray(molecule.coords) ? molecule.coords : null);
  if (!source || source.length === 0) {
    refuse('The molecule has no atoms; there is nothing to edit.', 'no-atoms');
  }
  const atoms = source.map((atom, index) => readAtom(atom, index));
  const bonds = readBonds(molecule.bonds, atoms.length);
  if (bonds.length === 0) {
    refuse(
      `The molecule states no bonds. An edit would have to guess which atoms are joined, and a `
      + `valence check or a bond direction built on that guess is not a check — state the topology `
      + `first (${atoms.length} atoms, no bonds given).`,
      'no-bonds',
    );
  }
  const charge = readInteger(molecule.charge, { label: 'charge', fallback: 0, min: -MAX_CHARGE, max: MAX_CHARGE });
  const multiplicity = readInteger(molecule.multiplicity, {
    label: 'multiplicity', fallback: 1, min: 1, max: MAX_MULTIPLICITY,
  });
  return { atoms, bonds, charge, multiplicity };
}

function readAtom(atom, index) {
  const position = index + 1;
  if (!atom || typeof atom !== 'object') {
    refuse(`Atom ${position} is not an object with element, x, y and z.`, 'atom-out-of-range', { atomIndex: position });
  }
  const element = String(atom.element ?? '').trim();
  if (!isElementSymbol(element)) {
    refuse(`Atom ${position} has an unknown element symbol "${atom.element}".`, 'unknown-element', {
      atomIndex: position, element: element || null,
    });
  }
  const coords = [atom.x, atom.y, atom.z].map((value) => Number(value));
  if (!coords.every(Number.isFinite)) {
    refuse(`Atom ${position} (${element}) has a non-finite coordinate.`, 'bad-coordinate', {
      atomIndex: position, element,
    });
  }
  const copy = { ...atom, element, x: coords[0], y: coords[1], z: coords[2] };
  const isotope = Number(atom.isotope);
  if (Number.isInteger(isotope) && isotope > 0) copy.isotope = isotope;
  else delete copy.isotope;
  return copy;
}

function readBonds(raw, atomCount) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    refuse('`bonds` must be an array of { a, b, order } entries; it is not.', 'dangling-bond');
  }
  const bonds = [];
  const seen = new Set();
  for (const [index, entry] of raw.entries()) {
    const a = Number(entry?.a);
    const b = Number(entry?.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
      refuse(`Bond ${index + 1} does not name two different atoms.`, 'dangling-bond');
    }
    if (a < 1 || b < 1 || a > atomCount || b > atomCount) {
      refuse(
        `Bond ${index + 1} joins atoms ${a} and ${b}; the structure has ${atomCount} atoms.`,
        'dangling-bond',
      );
    }
    const order = Number(entry?.order ?? 1);
    if (!BOND_ORDERS.includes(order)) {
      refuse(`Bond ${index + 1} has order ${entry?.order}; orders are 1, 1.5 (aromatic), 2 and 3.`, 'dangling-bond');
    }
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bonds.push({
      ...entry,
      a: Math.min(a, b),
      b: Math.max(a, b),
      order,
    });
  }
  return bonds;
}

function readInteger(value, { label, fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    refuse(`The molecule's ${label} must be an integer between ${min} and ${max}; it is "${value}".`, 'bad-' + label);
  }
  return number;
}

/* ── lookups ──────────────────────────────────────────────── */

function radiusOf(element, atomIndex) {
  const radius = own(COVALENT_RADII_ANGSTROM, element);
  if (!Number.isFinite(radius)) {
    refuse(
      `No Cordero covalent radius is tabulated for ${element}${atomIndex ? ` (atom ${atomIndex})` : ''}, `
      + 'so a bond length cannot be placed without inventing one.',
      'no-radius', { atomIndex, element },
    );
  }
  return radius;
}

function valenceCeilingOf(element, atomIndex) {
  const ceiling = own(MAX_VALENCE, element);
  if (!Number.isInteger(ceiling)) {
    refuse(
      `Atom ${atomIndex} (${element}) has no tabulated maximum valence, so the edit cannot be `
      + 'checked against it.',
      'no-valence', { atomIndex, element },
    );
  }
  return ceiling;
}

/** Bonds of one atom, in file order, with the partner on the far side. */
function bondsOf(bonds, atomIndex) {
  return bonds
    .filter((bond) => bond.a === atomIndex || bond.b === atomIndex)
    .map((bond) => ({ order: bond.order, partner: bond.a === atomIndex ? bond.b : bond.a }));
}

/** Used valence, respecting bond order (aromatic 1.5 counts as 1.5). */
function usedValenceOf(bonds, atomIndex) {
  return bondsOf(bonds, atomIndex).reduce((total, bond) => total + bond.order, 0);
}

/* ── geometry ─────────────────────────────────────────────── */

function unitVector(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(length > 0)) return null;
  return { x: dx / length, y: dy / length, z: dz / length, length };
}

/**
 * The direction a new atom takes on `parent`: exactly opposite the sum of the
 * unit vectors to its existing partners, so two bonds give the bisector and one
 * gives the continuation of that bond. A sum that cancels (a linear centre, or
 * two bonds at 180°) leaves no direction, and is refused rather than fudged.
 */
function outwardDirection(atoms, bonds, parentIndex) {
  const parent = atoms[parentIndex - 1];
  let sum = { x: 0, y: 0, z: 0 };
  for (const bond of bondsOf(bonds, parentIndex)) {
    const unit = unitVector(parent, atoms[bond.partner - 1]);
    if (!unit) continue;
    sum = { x: sum.x + unit.x, y: sum.y + unit.y, z: sum.z + unit.z };
  }
  const magnitude = Math.sqrt(sum.x * sum.x + sum.y * sum.y + sum.z * sum.z);
  if (!(magnitude > DIRECTION_FLOOR)) {
    refuse(
      `Atom ${parentIndex} (${parent.element}) has bond directions that cancel, so there is no `
      + 'direction to place a new atom in.',
      'no-direction', { atomIndex: parentIndex, element: parent.element },
    );
  }
  return { x: -sum.x / magnitude, y: -sum.y / magnitude, z: -sum.z / magnitude };
}

function placeAlong(origin, direction, distance) {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance,
  };
}

/* ── spin state ───────────────────────────────────────────── */

/**
 * Charge and multiplicity are carried, never inferred — and a pair that cannot
 * describe the electron count is refused, because a structure with the wrong
 * multiplicity builds an input deck that asks for a state the molecule does not
 * have. Same rule as `structureImport.js`, same arithmetic.
 */
function checkSpinState(atoms, charge, multiplicity, atomIndex = null) {
  const electrons = atoms.reduce((total, atom) => total + (atomicNumber(atom.element) ?? 0), 0) - charge;
  if (electrons < 0) {
    refuse(
      `Charge ${charge} removes more electrons than the ${atoms.length} atoms provide.`,
      'spin-parity', { atomIndex },
    );
  }
  if ((electrons - (multiplicity - 1)) % 2 !== 0) {
    const parity = electrons % 2 === 0 ? 'even' : 'odd';
    refuse(
      `${atoms.length} atoms at charge ${charge} give ${electrons} electrons, an ${parity} count, `
      + `so multiplicity ${multiplicity} cannot describe the structure. State the multiplicity the `
      + 'product actually has (an odd electron count needs an even multiplicity).',
      'spin-parity', { atomIndex },
    );
  }
}

/* ── the ops ──────────────────────────────────────────────── */

function requireAtomIndex(state, edit) {
  const index = Number(edit.atom);
  if (!Number.isInteger(index) || index < 1 || index > state.atoms.length) {
    refuse(
      `Atom ${edit.atom} is outside this structure, which has ${state.atoms.length} atoms `
      + '(indices start at 1).',
      'atom-out-of-range', { atomIndex: Number.isInteger(index) ? index : null },
    );
  }
  return index;
}

function requireElement(symbol, atomIndex, what) {
  const element = String(symbol ?? '').trim();
  if (!isElementSymbol(element)) {
    refuse(
      `${what} needs an element symbol; it was given "${symbol}" (atom ${atomIndex}).`,
      'unknown-element', { atomIndex, element: element || null },
    );
  }
  return element;
}

function substituteAtom(state, edit) {
  const index = requireAtomIndex(state, edit);
  const atom = state.atoms[index - 1];
  const element = requireElement(edit.element, index, 'substitute');
  const attached = bondsOf(state.bonds, index);

  if (attached.length === 0) {
    refuse(
      `Atom ${index} (${atom.element}) has no bonds; substitute replaces an atom joined to exactly `
      + 'one other atom.',
      'not-single-bond', { atomIndex: index, element: atom.element },
    );
  }
  if (attached.length > 1) {
    const used = usedValenceOf(state.bonds, index);
    const ceiling = own(MAX_VALENCE, atom.element);
    const valenceText = Number.isInteger(ceiling) && used >= ceiling
      ? `is at full valence (${used} of ${ceiling})`
      : `has ${attached.length} bonds worth ${used}`;
    refuse(
      `Atom ${index} (${atom.element}) ${valenceText}; substitute replaces an atom with exactly one `
      + 'single bond.',
      'not-single-bond', { atomIndex: index, element: atom.element },
    );
  }
  const [bond] = attached;
  if (bond.order !== 1) {
    refuse(
      `Atom ${index} (${atom.element}) is joined to atom ${bond.partner} by a bond of order `
      + `${bond.order}; substitute replaces a single bond only.`,
      'not-single-bond', { atomIndex: index, element: atom.element },
    );
  }

  const used = usedValenceOf(state.bonds, index);
  const ceiling = valenceCeilingOf(element, index);
  if (used > ceiling) {
    refuse(
      `Atom ${index} (${atom.element}) already uses ${used} of its bonds and ${element} takes `
      + `at most ${ceiling}.`,
      'valence-exceeded', { atomIndex: index, element: atom.element },
    );
  }

  const partner = state.atoms[bond.partner - 1];
  const direction = unitVector(partner, atom);
  if (!direction) {
    refuse(
      `Atom ${index} (${atom.element}) sits on top of atom ${bond.partner}, so the replaced bond `
      + 'has no direction to follow.',
      'no-direction', { atomIndex: index, element: atom.element },
    );
  }
  const distance = radiusOf(partner.element, bond.partner) + radiusOf(element, index);
  const placed = placeAlong(partner, direction, distance);

  const replacement = { ...atom, element, ...placed };
  delete replacement.isotope;
  const atoms = state.atoms.map((one, position) => (position === index - 1 ? replacement : one));
  return {
    state: { ...state, atoms },
    operation: {
      op: 'substitute',
      atomIndex: index,
      element,
      before: { element: atom.element, isotope: atom.isotope ?? null },
      after: { element, isotope: null },
      bondLengthAngstrom: distance,
    },
  };
}

function addAtom(state, edit, { op = 'add', element, charge, multiplicity } = {}) {
  const index = requireAtomIndex(state, edit);
  const parent = state.atoms[index - 1];
  const added = requireElement(element ?? edit.element, index, op);

  const attached = bondsOf(state.bonds, index);
  if (attached.length === 0) {
    refuse(
      `Atom ${index} (${parent.element}) has no bonds, so there is no existing direction to place `
      + 'a new atom opposite.',
      'no-anchor', { atomIndex: index, element: parent.element },
    );
  }
  const used = usedValenceOf(state.bonds, index);
  const ceiling = valenceCeilingOf(parent.element, index);
  if (used + 1 > ceiling) {
    refuse(
      `Atom ${index} (${parent.element}) already uses ${used} of ${ceiling} and cannot take another `
      + 'bond.',
      'valence-exceeded', { atomIndex: index, element: parent.element },
    );
  }
  const addedCeiling = valenceCeilingOf(added, index);
  if (addedCeiling < 1) {
    refuse(
      `Atom ${index} (${parent.element}) cannot be bonded to ${added}, which forms no bonds.`,
      'valence-exceeded', { atomIndex: index, element: added },
    );
  }

  const direction = outwardDirection(state.atoms, state.bonds, index);
  const distance = radiusOf(parent.element, index) + radiusOf(added, index);
  const position = state.atoms.length + 1;
  // The new atom joins the fragment its parent is labelled with (#77), so a
  // counterpoise-ready structure keeps every atom accounted for.
  const newAtom = {
    element: added,
    ...placeAlong(parent, direction, distance),
    ...(Number.isInteger(parent.fragment) && parent.fragment > 0 ? { fragment: parent.fragment } : {}),
  };
  const atoms = [...state.atoms, newAtom];
  const bonds = [...state.bonds, {
    a: Math.min(index, position), b: Math.max(index, position), order: 1,
  }];
  return {
    state: { atoms, bonds, charge: charge ?? state.charge, multiplicity: multiplicity ?? state.multiplicity },
    operation: {
      op,
      atomIndex: index,
      atomCreated: position,
      element: added,
      before: null,
      after: { element: added, isotope: null },
      bondLengthAngstrom: distance,
    },
  };
}

function removeAtom(state, edit, { op = 'remove', charge, multiplicity } = {}) {
  const index = requireAtomIndex(state, edit);
  const atom = state.atoms[index - 1];
  if (state.atoms.length === 1) {
    refuse(
      `Atom ${index} (${atom.element}) is the only atom; removing it would leave no structure.`,
      'empty-molecule', { atomIndex: index, element: atom.element },
    );
  }
  const atoms = state.atoms.filter((_, position) => position !== index - 1);
  const shift = (value) => (value > index ? value - 1 : value);
  const bonds = state.bonds
    .filter((bond) => bond.a !== index && bond.b !== index)
    .map((bond) => {
      const moved = { ...bond, a: shift(bond.a), b: shift(bond.b) };
      // A wedge's narrow end is an atom index too; it is shifted with the atoms
      // and dropped when the atom it pointed at is the one deleted.
      if (bond.stereo && Number.isInteger(bond.stereo.narrowEnd)) {
        if (bond.stereo.narrowEnd === index) delete moved.stereo;
        else moved.stereo = { ...bond.stereo, narrowEnd: shift(bond.stereo.narrowEnd) };
      }
      return moved;
    });
  return {
    state: { atoms, bonds, charge: charge ?? state.charge, multiplicity: multiplicity ?? state.multiplicity },
    operation: {
      op,
      atomIndex: index,
      element: atom.element,
      before: { element: atom.element, isotope: atom.isotope ?? null },
      after: null,
    },
  };
}

function isotopeAtom(state, edit) {
  const index = requireAtomIndex(state, edit);
  const atom = state.atoms[index - 1];
  const known = own(ISOTOPES, atom.element);
  if (!known) {
    refuse(
      `Atom ${index} (${atom.element}) has no isotopes in the shipped table (H–I), so mass number `
      + `${edit.mass} cannot be checked.`,
      'unknown-isotope', { atomIndex: index, element: atom.element },
    );
  }
  const mass = Number(edit.mass);
  if (!Number.isInteger(mass) || !known.includes(mass)) {
    refuse(
      `Atom ${index} (${atom.element}) has no isotope of mass ${edit.mass}; the table lists `
      + `${known.join(', ')}.`,
      'unknown-isotope', { atomIndex: index, element: atom.element },
    );
  }
  const atoms = state.atoms.map((one, position) => (position === index - 1
    ? { ...one, isotope: mass }
    : one));
  return {
    state: { ...state, atoms },
    operation: {
      op: 'isotope',
      atomIndex: index,
      element: atom.element,
      before: { element: atom.element, isotope: atom.isotope ?? null },
      after: { element: atom.element, isotope: mass },
    },
  };
}

/**
 * `protonate`/`deprotonate` are sugar, and the sugar is the *statement*: the
 * resulting charge and multiplicity are required, never inferred from the
 * electron count.
 */
function requireSpinStatement(edit, op) {
  const stated = (value) => value !== undefined && value !== null && value !== '' && Number.isInteger(Number(value));
  if (!stated(edit.charge)) {
    refuse(
      `${op} must state the resulting charge; the protonation state of the product is the `
      + 'caller\'s claim, not something this module infers.',
      'charge-not-stated',
    );
  }
  if (!stated(edit.multiplicity)) {
    refuse(
      `${op} must state the resulting multiplicity; a proton changes the electron count and the `
      + 'spin state is the caller\'s claim.',
      'multiplicity-not-stated',
    );
  }
  const charge = Number(edit.charge);
  const multiplicity = Number(edit.multiplicity);
  if (charge < -MAX_CHARGE || charge > MAX_CHARGE) {
    refuse(`Charge ${charge} is outside the supported range -${MAX_CHARGE} to ${MAX_CHARGE}.`, 'bad-charge');
  }
  if (multiplicity < 1 || multiplicity > MAX_MULTIPLICITY) {
    refuse(
      `Multiplicity ${multiplicity} is outside the supported range 1 to ${MAX_MULTIPLICITY}.`,
      'bad-multiplicity',
    );
  }
  return { charge, multiplicity };
}

function protonate(state, edit) {
  const { charge, multiplicity } = requireSpinStatement(edit, 'protonate');
  const step = addAtom(state, edit, { op: 'protonate', element: 'H', charge, multiplicity });
  return {
    state: step.state,
    operation: {
      ...step.operation,
      charge,
      multiplicity,
    },
  };
}

function deprotonate(state, edit) {
  const { charge, multiplicity } = requireSpinStatement(edit, 'deprotonate');
  const index = requireAtomIndex(state, edit);
  const atom = state.atoms[index - 1];
  if (atom.element !== 'H') {
    refuse(
      `Atom ${index} is ${atom.element}, not hydrogen; deprotonate removes an H.`,
      'not-hydrogen', { atomIndex: index, element: atom.element },
    );
  }
  const step = removeAtom(state, edit, { op: 'deprotonate', charge, multiplicity });
  return {
    state: step.state,
    operation: {
      ...step.operation,
      charge,
      multiplicity,
    },
  };
}

/**
 * Charge and multiplicity stated on any edit. `null` means "not stated": the
 * parent's value is carried. Validation is deliberately strict — a value that
 * is not an integer in range is refused, never rounded.
 */
function readStatedSpin(edit) {
  const pick = (value, label, min, max) => {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      refuse(
        `The stated ${label} "${value}" is not an integer between ${min} and ${max}.`,
        'bad-' + label,
      );
    }
    return number;
  };
  return {
    charge: pick(edit.charge, 'charge', -MAX_CHARGE, MAX_CHARGE),
    multiplicity: pick(edit.multiplicity, 'multiplicity', 1, MAX_MULTIPLICITY),
  };
}

function applyOne(state, edit) {
  if (!edit || typeof edit !== 'object') {
    refuse('An edit must be an object with an op; this is not.', 'unknown-op');
  }
  const op = String(edit.op ?? '');
  const spin = readStatedSpin(edit);
  let step;
  switch (op) {
    case 'substitute': step = substituteAtom(state, edit); break;
    case 'add': step = addAtom(state, edit); break;
    case 'remove': step = removeAtom(state, edit); break;
    case 'isotope': step = isotopeAtom(state, edit); break;
    case 'protonate': step = protonate(state, edit); break;
    case 'deprotonate': step = deprotonate(state, edit); break;
    default:
      refuse(
        `Unknown edit op "${op}"; the ops are substitute, add, remove, isotope, protonate and `
        + 'deprotonate.',
        'unknown-op',
      );
  }
  step.state = {
    ...step.state,
    charge: spin.charge ?? step.state.charge,
    multiplicity: spin.multiplicity ?? step.state.multiplicity,
  };
  if (spin.charge !== null || spin.multiplicity !== null) {
    step.operation = {
      ...step.operation,
      statedCharge: spin.charge,
      statedMultiplicity: spin.multiplicity,
    };
  }
  checkSpinState(step.state.atoms, step.state.charge, step.state.multiplicity, step.operation.atomIndex);
  return step;
}

/* ── public entry points ──────────────────────────────────── */

function signatureOf(state) {
  return JSON.stringify({
    atoms: state.atoms.map((atom) => [atom.element, atom.isotope ?? null, atom.x, atom.y, atom.z]),
    bonds: state.bonds.map((bond) => [bond.a, bond.b, bond.order]),
    charge: state.charge,
    multiplicity: state.multiplicity,
  });
}

function copyBond(bond) {
  return {
    ...bond,
    ...(bond.stereo && typeof bond.stereo === 'object' ? { stereo: { ...bond.stereo } } : {}),
  };
}

function freezeOperation(operation) {
  return Object.freeze({
    ...operation,
    before: operation.before ? Object.freeze(operation.before) : null,
    after: operation.after ? Object.freeze(operation.after) : null,
  });
}

/**
 * Apply one edit and return a new record. The input molecule is not touched:
 * every atom and bond in the result is a copy.
 */
export function applyEdit(molecule, edit) {
  return applyEdits(molecule, [edit]);
}

/**
 * Apply edits in order, each against the structure the previous one produced,
 * and return the composed record. A list that returns to a structure it already
 * produced (a duplicate edit, or an edit that undoes an earlier one) is
 * refused: two identical records leave nothing to compare.
 */
export function applyEdits(molecule, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    refuse(
      'An edit list needs at least one edit; an empty list has no structure to build.',
      'no-edits',
    );
  }
  const parent = readMolecule(molecule);
  const signatures = [signatureOf(parent)];
  const operations = [];
  let state = parent;

  edits.forEach((edit, position) => {
    let step;
    try {
      step = applyOne(state, edit);
    } catch (error) {
      if (error instanceof DerivativeEditError && edits.length > 1) {
        error.message = `Edit ${position + 1}: ${error.message}`;
      }
      throw error;
    }
    const signature = signatureOf(step.state);
    if (signatures.includes(signature)) {
      refuse(
        `Edit ${position + 1} (${step.operation.op} on atom ${step.operation.atomIndex}) produces a `
        + 'structure identical to one this list already produced; two identical records leave '
        + 'nothing to compare.',
        'duplicate-record', { atomIndex: step.operation.atomIndex },
      );
    }
    signatures.push(signature);
    operations.push(freezeOperation({
      step: position + 1,
      ...step.operation,
      formula: formulaOf(step.state.atoms),
    }));
    state = step.state;
  });

  const parentId = molecule?.recordId ?? molecule?.id ?? null;
  return {
    atoms: state.atoms.map((atom) => ({ ...atom })),
    bonds: state.bonds.map(copyBond),
    charge: state.charge,
    multiplicity: state.multiplicity,
    formula: formulaOf(state.atoms),
    geometryStatus: GEOMETRY_STATUS,
    geometryNote: GEOMETRY_NOTE,
    provenance: Object.freeze({
      kind: 'derivative',
      parent: Object.freeze({
        id: parentId === null ? null : String(parentId),
        formula: formulaOf(parent.atoms),
        atomCount: parent.atoms.length,
        bondCount: parent.bonds.length,
      }),
      atomIndexBase: 1,
      operations: Object.freeze(operations),
      geometry: Object.freeze({ status: GEOMETRY_STATUS, rule: GEOMETRY_RULE }),
    }),
  };
}
