/**
 * Coordinate constraints and QST2/QST3 structures (issue #93).
 *
 * A constraint freezes one internal coordinate during a Berny optimisation.
 * Gaussian 16 writes that as a ModRedundant input section *after* the molecule
 * specification:
 *
 *   [Type] N1 [N2 [N3 [N4]]] F
 *
 * with `X` (one atom, all three Cartesian coordinates), `B` (bond), `A` (angle)
 * and `D` (dihedral); atom numbering starts at 1 (Gaussian 16 Opt keyword,
 * "ModRedundant"). The value frozen is the one in the geometry — since G09
 * C.01 a value on the ModRedundant line is not read, so this module never
 * writes one. A declared `value` is therefore a *check*: it must match the
 * geometry, or the builder refuses rather than freezing a different number.
 *
 * QST2/QST3 (STQN) take two or three complete molecule specifications in one
 * input: reactant, product, and — for QST3 — an initial TS guess. Gaussian's
 * requirement, stated in the Opt keyword documentation, is that "the order of
 * the atoms must be identical within all molecule specifications". A mismatch
 * is the classic silent failure: the interpolation pairs atom 4 of one
 * structure with atom 4 of another and walks through a barrier that does not
 * exist. Every check here refuses that mismatch and names the first differing
 * index; nothing is ever reordered automatically.
 *
 * Pure module: no DOM, no filesystem, no Electron.
 */

export const CONSTRAINT_KINDS = Object.freeze(['bond', 'angle', 'dihedral', 'freeze']);

const CONSTRAINT_ATOM_COUNTS = Object.freeze({ bond: 2, angle: 3, dihedral: 4, freeze: 1 });

const CONSTRAINT_LABELS = Object.freeze({
  bond: 'Bond length',
  angle: 'Bond angle',
  dihedral: 'Dihedral',
  freeze: 'Frozen atom',
});

/** Gaussian's one-letter ModRedundant coordinate type. */
const CONSTRAINT_CODES = Object.freeze({ bond: 'B', angle: 'A', dihedral: 'D', freeze: 'X' });

/** How many internal coordinates a frozen atom removes (its three Cartesian axes). */
const ATOM_DEGREES_OF_FREEDOM = 3;

/** Declared values are compared with the geometry at this tolerance. */
export const CONSTRAINT_VALUE_TOLERANCE = Object.freeze({ bond: 0.02, angle: 0.5, dihedral: 0.5 });

export const MAX_CONSTRAINTS = 256;
export const MAX_QST_STRUCTURES = 2;

const QST_KINDS = Object.freeze({ 'Opt=QST2': 'QST2', 'Opt=QST3': 'QST3' });
const QST_STRUCTURE_COUNTS = Object.freeze({ QST2: 1, QST3: 2 });

/** Job types that read a ModRedundant section at all. */
const MODREDUNDANT_JOB_TYPES = Object.freeze(['Opt', 'Opt Freq', 'Opt=TS', 'Opt=QST2', 'Opt=QST3']);

function oneLine(value, fallback = '') {
  return String(value ?? fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isConstraintKind(kind) {
  return CONSTRAINT_KINDS.includes(String(kind ?? ''));
}

export function constraintAtomCount(kind) {
  return CONSTRAINT_ATOM_COUNTS[String(kind ?? '')] ?? 0;
}

export function constraintLabel(kind) {
  return CONSTRAINT_LABELS[String(kind ?? '')] || 'Constraint';
}

/** True when a block actually carries constraints (not merely an empty array). */
export function hasConstraints(settings = {}) {
  return Array.isArray(settings?.constraints) && settings.constraints.length > 0;
}

/* ── Geometry helpers ─────────────────────────────────────── */

function atomAt(atoms, index) {
  if (!Array.isArray(atoms)) return null;
  const atom = atoms[index - 1];
  return atom && typeof atom === 'object' ? atom : null;
}

function labelFor(atom, index) {
  const element = oneLine(atom?.element);
  return element ? `${element}${index}` : `#${index}`;
}

function coordinates(atom) {
  const x = Number(atom?.x);
  const y = Number(atom?.y);
  const z = Number(atom?.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
const cross = (a, b) => ({
  x: (a.y * b.z) - (a.z * b.y),
  y: (a.z * b.x) - (a.x * b.z),
  z: (a.x * b.y) - (a.y * b.x),
});
const norm = (a) => Math.hypot(a.x, a.y, a.z);

function distance(a, b) {
  return norm(subtract(a, b));
}

function angleDegrees(a, centre, b) {
  const v1 = subtract(a, centre);
  const v2 = subtract(b, centre);
  const lengths = norm(v1) * norm(v2);
  if (!(lengths > 0)) return null;
  const cosine = Math.max(-1, Math.min(1, dot(v1, v2) / lengths));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Signed dihedral p0-p1-p2-p3. The sign flips when the atom order is reversed,
 * which is exactly the symmetry `canonicalAtoms` uses to detect duplicates.
 */
function dihedralDegrees(p0, p1, p2, p3) {
  const b0 = subtract(p0, p1);
  const b1 = subtract(p2, p1);
  const b2 = subtract(p3, p2);
  const length = norm(b1);
  if (!(length > 0)) return null;
  const unit = { x: b1.x / length, y: b1.y / length, z: b1.z / length };
  const v = subtract(b0, { x: unit.x * dot(b0, unit), y: unit.y * dot(b0, unit), z: unit.z * dot(b0, unit) });
  const w = subtract(b2, { x: unit.x * dot(b2, unit), y: unit.y * dot(b2, unit), z: unit.z * dot(b2, unit) });
  if (!(norm(v) > 0) || !(norm(w) > 0)) return null;
  return (Math.atan2(dot(cross(unit, v), w), dot(v, w)) * 180) / Math.PI;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * The measured value of a constraint in the geometry it belongs to, in Å for a
 * bond and degrees for an angle or dihedral. `null` for a frozen atom (three
 * coordinates, no single number) or when the geometry is too small.
 */
export function measureConstraint(constraint, atoms) {
  const kind = String(constraint?.kind ?? '');
  const indices = Array.isArray(constraint?.atoms) ? constraint.atoms : [];
  const points = indices.map((index) => coordinates(atomAt(atoms, Number(index))));
  if (points.some((point) => point === null)) return null;
  if (kind === 'bond' && points.length === 2) {
    return { value: round(distance(points[0], points[1]), 3), unit: 'Å' };
  }
  if (kind === 'angle' && points.length === 3) {
    const value = angleDegrees(points[0], points[1], points[2]);
    return value === null ? null : { value: round(value, 1), unit: '°' };
  }
  if (kind === 'dihedral' && points.length === 4) {
    const value = dihedralDegrees(points[0], points[1], points[2], points[3]);
    return value === null ? null : { value: round(value, 1), unit: '°' };
  }
  return null;
}

function formatValue(kind, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const text = kind === 'bond' ? number.toFixed(3) : number.toFixed(1);
  return `${text}${kind === 'bond' ? ' Å' : '°'}`;
}

/** "C3–O7 distance", "C3–O7–H9 angle", "H4 atom frozen" — no value. */
function constraintLabelOnly(constraint, atoms) {
  const kind = String(constraint?.kind ?? '');
  const indices = Array.isArray(constraint?.atoms) ? constraint.atoms.map(Number) : [];
  const labels = indices.map((index) => labelFor(atomAt(atoms, index), index));
  if (kind === 'freeze') return `${labels[0] || '#?'} atom frozen`;
  const noun = kind === 'bond' ? 'distance' : kind === 'angle' ? 'angle' : 'dihedral';
  return `${labels.join('–')} ${noun}`;
}

/**
 * A constraint in chemical terms: "C3–O7 distance, 1.800 Å",
 * "C3–O7–H9 angle, 108.4°", "H4 atom frozen". The declared value is shown when
 * there is one, otherwise the value measured in the geometry.
 */
export function describeConstraint(constraint, atoms) {
  const kind = String(constraint?.kind ?? '');
  if (kind === 'freeze') return constraintLabelOnly(constraint, atoms);
  const declared = constraint?.value === null || constraint?.value === undefined
    ? null
    : Number(constraint.value);
  const measured = measureConstraint(constraint, atoms);
  const value = Number.isFinite(declared) ? declared : measured?.value;
  const suffix = value === undefined || value === null ? '' : `, ${formatValue(kind, value)}`;
  return `${constraintLabelOnly(constraint, atoms)}${suffix}`;
}

/* ── ModRedundant emission ────────────────────────────────── */

/**
 * One ModRedundant line. `B`/`A`/`D`/`X` are Gaussian's coordinate types and
 * `F` freezes the coordinate at its current value. No value is written: G16
 * ignores one on this line, so a value would be a silent lie.
 */
export function modRedundantLine(constraint) {
  const kind = String(constraint?.kind ?? '');
  const code = CONSTRAINT_CODES[kind];
  const indices = Array.isArray(constraint?.atoms) ? constraint.atoms : [];
  if (!code || indices.length !== constraintAtomCount(kind)) {
    throw new Error(`Cannot write a ModRedundant line for the constraint ${JSON.stringify(constraint)}.`);
  }
  const numbers = indices.map((index) => {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`ModRedundant atom indices are 1-based; got ${JSON.stringify(index)}.`);
    }
    return value;
  });
  return `${code} ${numbers.join(' ')} F`;
}

/** The whole section, in the order the constraints were listed. */
export function modRedundantSection(constraints = []) {
  return (Array.isArray(constraints) ? constraints : []).map(modRedundantLine);
}

/* ── Duplicate detection ──────────────────────────────────── */

/**
 * The chemically identical reading of an atom tuple: a bond is unordered, an
 * angle reads the same from either end, and a dihedral reverses exactly.
 */
function canonicalAtoms(kind, atoms) {
  const list = (Array.isArray(atoms) ? atoms : []).map(Number);
  if (kind === 'bond') return [...list].sort((a, b) => a - b);
  if (kind === 'angle' || kind === 'dihedral') {
    const forward = list.join(',');
    const reversed = [...list].reverse().join(',');
    return forward <= reversed ? list : [...list].reverse();
  }
  return list;
}

export function constraintSignature(constraint) {
  const kind = String(constraint?.kind ?? '');
  return `${kind}:${canonicalAtoms(kind, constraint?.atoms).join(',')}`;
}

function sameConstraint(a, b) {
  return constraintSignature(a) === constraintSignature(b);
}

/* ── Degrees of freedom ───────────────────────────────────── */

/**
 * Internal degrees of freedom of an N-atom system: 3N-6 (3N-5 for a diatomic,
 * 0 for a single atom). A frozen atom removes three; a frozen bond, angle or
 * dihedral removes one. The count is deliberately an estimate — the rank of a
 * redundant set is not computed — so it is only used to refuse the case where
 * nothing is left to optimise at all.
 */
export function internalDegreesOfFreedom(atomCount) {
  const count = Number(atomCount);
  if (!Number.isInteger(count) || count < 1) return 0;
  if (count === 1) return 0;
  if (count === 2) return 1;
  return (3 * count) - 6;
}

function removedDegreesOfFreedom(constraints) {
  return constraints.reduce((total, constraint) => (
    total + (constraint.kind === 'freeze' ? ATOM_DEGREES_OF_FREEDOM : 1)
  ), 0);
}

/* ── Validation ───────────────────────────────────────────── */

function isTsOrQst(jobType) {
  return jobType === 'Opt=TS' || jobType === 'Opt=QST2' || jobType === 'Opt=QST3';
}

/**
 * Check a constraint set against the geometry that will actually be written.
 *
 * `atoms` is that written geometry: the block's molecule for an ordinary flow,
 * or a dataset record's coordinates under RFC 0001. Range, value and
 * degrees-of-freedom checks need it and are skipped when it is absent (the
 * schema normaliser calls this before a geometry exists).
 *
 * Returns findings with the index of the offending constraint (`null` for a
 * set-level finding) so a caller can point at the exact JSON path.
 */
export function constraintFindings({
  constraints = [],
  atoms = null,
  jobType = 'Opt',
  forceConstants = null,
  engine = 'gaussian',
} = {}) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(constraints) ? constraints : [];
  if (list.length === 0) return { errors, warnings };
  const fail = (message, index = null) => errors.push({ index, message });

  const job = oneLine(jobType, 'Opt');
  if (engine !== 'gaussian') {
    fail(
      `Coordinate constraints are written as a Gaussian ModRedundant section, but this block runs on `
      + `${engine}. Choose the Gaussian engine for the block, or remove the ${list.length} constraint`
      + `${list.length === 1 ? '' : 's'}.`,
    );
    return { errors, warnings };
  }
  if (!MODREDUNDANT_JOB_TYPES.includes(job)) {
    fail(job === 'Scan'
      ? 'A Scan job steps Gaussian\'s Scan keyword, which has no ModRedundant section: a frozen '
        + 'coordinate inside a scanned step cannot be expressed. Use an Opt job with constraints '
        + '(a relaxed scan) or remove them.'
      : `${job} does not read a ModRedundant section. Constraints are written for ${MODREDUNDANT_JOB_TYPES.join(', ')} only.`);
    return { errors, warnings };
  }

  const atomCount = Array.isArray(atoms) ? atoms.length : 0;
  const seen = [];

  list.forEach((constraint, index) => {
    const position = index + 1;
    const kind = String(constraint?.kind ?? '');
    const indices = Array.isArray(constraint?.atoms) ? constraint.atoms.map(Number) : [];

    if (!isConstraintKind(kind)) {
      fail(`Constraint ${position} has an unknown type "${kind || '(empty)'}"; use ${CONSTRAINT_KINDS.join(', ')}.`, index);
      return;
    }
    if (indices.length !== constraintAtomCount(kind)) {
      fail(`Constraint ${position} is a ${kind} and needs ${constraintAtomCount(kind)} atom indices, not ${indices.length}.`, index);
      return;
    }
    if (indices.some((value) => !Number.isInteger(value) || value < 1)) {
      fail(`Constraint ${position} (${describeConstraint(constraint, atoms)}) uses a non-positive or non-integer atom index; ModRedundant atom numbers are 1-based.`, index);
      return;
    }
    if (atomCount > 0 && indices.some((value) => value > atomCount)) {
      const offender = indices.find((value) => value > atomCount);
      fail(
        `Constraint ${position} refers to atom ${offender}, but the geometry written for this block has `
        + `${atomCount} atom${atomCount === 1 ? '' : 's'}. Atom indices are 1-based and must name atoms in `
        + 'the geometry that is actually written, including a dataset record that replaces the project geometry.',
        index,
      );
      return;
    }

    const duplicateOf = seen.find((entry) => sameConstraint(entry.constraint, constraint));
    if (duplicateOf) {
      fail(`Constraint ${position} (${describeConstraint(constraint, atoms)}) repeats constraint ${duplicateOf.position} (${describeConstraint(duplicateOf.constraint, atoms)}).`, index);
      return;
    }
    seen.push({ position, constraint });

    const declared = constraint?.value === null || constraint?.value === undefined
      ? null
      : Number(constraint.value);
    if (declared !== null) {
      if (!Number.isFinite(declared)) {
        fail(`Constraint ${position} has a non-numeric value ${JSON.stringify(constraint.value)}.`, index);
        return;
      }
      if (kind === 'freeze') {
        fail(`Constraint ${position} freezes an atom and takes no value; use a bond, angle or dihedral to hold a coordinate at a number.`, index);
        return;
      }
      const measured = measureConstraint(constraint, atoms);
      if (measured && Math.abs(measured.value - declared) > CONSTRAINT_VALUE_TOLERANCE[kind]) {
        fail(
          `Constraint ${position} asks for ${constraintLabelOnly(constraint, atoms)} = `
          + `${formatValue(kind, declared)}, but the geometry has ${formatValue(kind, measured.value)}. Gaussian 16 `
          + 'freezes a ModRedundant coordinate at the value in the geometry and ignores a value on the line, '
          + 'so it would silently hold a different number: set the geometry to that value, or clear the value '
          + 'to freeze the coordinate as drawn.',
          index,
        );
      }
    }
  });

  if (errors.length > 0) return { errors, warnings };

  if (atomCount > 0) {
    const available = internalDegreesOfFreedom(atomCount);
    const removed = removedDegreesOfFreedom(list);
    if (available <= 0) {
      fail(`Constraints on a ${atomCount}-atom geometry leave no internal degree of freedom to optimise.`);
    } else if (removed >= available) {
      fail(
        `The ${list.length} constraint${list.length === 1 ? '' : 's'} remove ${removed} of the `
        + `${available} internal degrees of freedom of a ${atomCount}-atom geometry: no internal degree of `
        + 'freedom is left to optimise. Freeze fewer coordinates, or relax the geometry with a smaller set first.',
      );
    }
  }

  if (isTsOrQst(job) && (forceConstants === null || forceConstants === 'default' || forceConstants === '')) {
    warnings.push(
      'freezes coordinates in a saddle search that uses the estimated initial Hessian. Berny and STQN '
      + 'need real curvature where the constrained guess sits, so choose CalcFC (or ReadFC from a '
      + 'Freq block) before trusting the saddle.',
    );
  }

  return { errors, warnings };
}

/** The same checks as plain messages, for callers that do not need paths. */
export function validateConstraints(args = {}) {
  const { errors, warnings } = constraintFindings(args);
  return { errors: errors.map((entry) => entry.message), warnings };
}

/* ── QST2 / QST3 ──────────────────────────────────────────── */

export function qstKindFor(jobType) {
  return QST_KINDS[oneLine(jobType)] || null;
}

/** How many structures a block must name *in addition to* its own geometry. */
export function qstRequiredStructures(jobType) {
  const kind = qstKindFor(jobType);
  return kind ? QST_STRUCTURE_COUNTS[kind] : 0;
}

/** Total molecule specifications Gaussian reads, including the block's own. */
export function qstTotalStructures(jobType) {
  const kind = qstKindFor(jobType);
  return kind ? QST_STRUCTURE_COUNTS[kind] + 1 : 1;
}

/** The stored extra structures, in reaction order; `[]` when QST is off. */
export function qstStructuresFor(settings = {}) {
  const structures = settings?.qst?.structures;
  return Array.isArray(structures) ? structures : [];
}

function structureName(structure, index) {
  const label = oneLine(structure?.label);
  return `Structure ${index}${label ? ` (${label})` : ''}`;
}

function elementsOf(atoms) {
  return (Array.isArray(atoms) ? atoms : []).map((atom) => oneLine(atom?.element));
}

/**
 * Check two or three structures against each other before Gaussian sees them.
 *
 * The atom *order* check is the important one: STQN pairs atom N of every
 * structure, so a reordered input silently interpolates the wrong atoms and the
 * job either fails late or finds a saddle that does not connect the reactants.
 * `validateQst` never reorders; it names the first mismatching index.
 */
export function qstFindings({ qst = null, atoms = null, jobType = 'Opt' } = {}) {
  const errors = [];
  const warnings = [];
  const structures = qstStructuresFor({ qst });
  const kind = qstKindFor(jobType);
  const required = qstRequiredStructures(jobType);
  const fail = (message, index = null) => errors.push({ index, message });

  if (!kind) {
    if (structures.length > 0) {
      fail(
        `${structures.length} extra structure${structures.length === 1 ? ' is' : 's are'} stored on this block, `
        + `but its job type is ${oneLine(jobType, 'Opt')}. Choose Opt=QST2 or Opt=QST3, or remove them.`,
      );
    }
    return { errors, warnings };
  }

  if (structures.length < required) {
    if (kind === 'QST2') {
      fail(
        'Opt=QST2 needs a second structure (the product). Set the product geometry on the block; '
        + 'Gaussian interpolates between the block geometry (reactant) and that second structure.',
      );
    } else {
      fail(
        `Opt=QST3 needs a third structure (the initial TS guess) after the product; only ${structures.length} `
        + `extra structure${structures.length === 1 ? ' is' : 's are'} set.`,
      );
    }
  } else if (structures.length > required) {
    fail(
      `Opt=${kind} reads ${required + 1} structures (the block geometry plus ${required}); this block names `
      + `${structures.length} extra. Remove one${kind === 'QST2' ? ', or choose Opt=QST3 for a TS guess' : ''}.`,
    );
  }

  const reference = Array.isArray(atoms) ? atoms : [];
  structures.forEach((structure, index) => {
    const position = index + 2;
    const name = structureName(structure, position);
    const coords = Array.isArray(structure?.atoms) ? structure.atoms : [];
    if (coords.length === 0) {
      fail(`${name} has no atoms. QST needs a complete molecule specification for every structure.`, index);
      return;
    }
    if (reference.length === 0) return;
    if (coords.length !== reference.length) {
      fail(
        `${name} has ${coords.length} atoms but the block's geometry has ${reference.length} atoms. QST requires `
        + 'the same atoms in the same order in every structure; nothing is reordered or dropped automatically.',
        index,
      );
      return;
    }
    const structureElements = elementsOf(coords);
    const referenceElements = elementsOf(reference);
    const mismatch = structureElements.findIndex((element, atomIndex) => element !== referenceElements[atomIndex]);
    if (mismatch !== -1) {
      fail(
        `${name} atom ${mismatch + 1} is ${structureElements[mismatch] || '(empty)'}, but the block's geometry `
        + `has ${referenceElements[mismatch] || '(empty)'} at atom ${mismatch + 1}. QST requires identical atoms `
        + 'in identical order; reorder the structure or edit the geometry, the atoms are never sorted for you.',
        index,
      );
    }
  });

  return { errors, warnings };
}

/** The same checks as plain messages, for callers that do not need paths. */
export function validateQst(args = {}) {
  const { errors, warnings } = qstFindings(args);
  return { errors: errors.map((entry) => entry.message), warnings };
}
