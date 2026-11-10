/**
 * Explicit solvent clusters (issue #228).
 *
 * This is a deterministic geometric placement, not a molecular-dynamics or
 * free-energy method. Solvent molecules are placed on a seeded Fibonacci
 * shell around the solute, rotated by seeded Euler angles, and rejected when
 * any atom is closer than `minDistanceAngstrom` to an existing atom. The same
 * solute, solvent, count, seed and shell always produce the same coordinates;
 * a request that cannot be placed refuses instead of silently dropping
 * molecules or overlapping them.
 *
 * What this does **not** claim: that the cluster is equilibrated, that the
 * solvent shell is complete, or that a single cluster represents the bulk. The
 * record keeps that limitation, and the report prints it.
 */

import { formulaOf } from './formula.js';

export const EXPLICIT_SOLVATION_SCHEMA_VERSION = 1;

/**
 * Rigid solvent templates used by the placement. Coordinates are in angstrom,
 * at the experimental-ish geometry used by the app's example builder; they are
 * a placement shape, not a level of theory.
 */
export const EXPLICIT_SOLVENTS = Object.freeze({
  water: Object.freeze({
    id: 'water',
    label: 'Water',
    formula: 'H2O',
    atoms: Object.freeze([
      Object.freeze({ element: 'O', x: 0, y: 0, z: 0 }),
      Object.freeze({ element: 'H', x: 0.9572, y: 0, z: 0 }),
      Object.freeze({ element: 'H', x: -0.239987, y: 0.927297, z: 0 }),
    ]),
  }),
  methanol: Object.freeze({
    id: 'methanol',
    label: 'Methanol',
    formula: 'CH4O',
    atoms: Object.freeze([
      Object.freeze({ element: 'C', x: 0, y: 0, z: 0 }),
      Object.freeze({ element: 'O', x: 1.43, y: 0, z: 0 }),
      Object.freeze({ element: 'H', x: 1.09, y: 0.89, z: 0 }),
      Object.freeze({ element: 'H', x: -0.36, y: 0.89, z: 0 }),
      Object.freeze({ element: 'H', x: -0.36, y: -0.89, z: 0 }),
      Object.freeze({ element: 'H', x: -0.36, y: 0, z: 0.89 }),
    ]),
  }),
  acetonitrile: Object.freeze({
    id: 'acetonitrile',
    label: 'Acetonitrile',
    formula: 'C2H3N',
    atoms: Object.freeze([
      Object.freeze({ element: 'C', x: 0, y: 0, z: 0 }),
      Object.freeze({ element: 'C', x: 1.46, y: 0, z: 0 }),
      Object.freeze({ element: 'N', x: 2.62, y: 0, z: 0 }),
      Object.freeze({ element: 'H', x: -0.36, y: 0.89, z: 0 }),
      Object.freeze({ element: 'H', x: -0.36, y: -0.89, z: 0 }),
      Object.freeze({ element: 'H', x: -0.36, y: 0, z: 0.89 }),
    ]),
  }),
});

export const EXPLICIT_SOLVENT_IDS = Object.freeze(Object.keys(EXPLICIT_SOLVENTS));

export function explicitSolventFor(id) {
  return EXPLICIT_SOLVENTS[String(id ?? '').trim().toLowerCase()] || null;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Deterministic 32-bit PRNG; the same seed always gives the same placement. */
function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function centroid(atoms) {
  const sum = atoms.reduce((accumulator, atom) => ({
    x: accumulator.x + Number(atom.x),
    y: accumulator.y + Number(atom.y),
    z: accumulator.z + Number(atom.z),
  }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / atoms.length, y: sum.y / atoms.length, z: sum.z / atoms.length };
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function rotated(template, center, angles) {
  const [rx, ry, rz] = angles;
  const cosX = Math.cos(rx); const sinX = Math.sin(rx);
  const cosY = Math.cos(ry); const sinY = Math.sin(ry);
  const cosZ = Math.cos(rz); const sinZ = Math.sin(rz);
  return template.atoms.map((atom) => {
    let x = atom.x;
    let y = atom.y;
    let z = atom.z;
    // X, then Y, then Z; order is fixed so the seed's three angles have one
    // meaning across builds.
    [y, z] = [y * cosX - z * sinX, y * sinX + z * cosX];
    [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];
    [x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ];
    return { element: atom.element, x: x + center.x, y: y + center.y, z: z + center.z };
  });
}

function unitVector(index, count, random) {
  const y = 1 - (2 * (index + 0.5)) / count;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index + (random() - 0.5) * 0.35;
  return {
    x: Math.cos(theta) * radius,
    y,
    z: Math.sin(theta) * radius,
  };
}

function minimumDistance(candidate, existing) {
  let minimum = Infinity;
  for (const atom of candidate) {
    for (const other of existing) {
      minimum = Math.min(minimum, distance(atom, other));
    }
  }
  return minimum;
}

/**
 * Build one explicit solvent cluster.
 *
 * @returns {{atoms: object[], composition: object, formula: string,
 *   solvent: object, count: number, seed: number, shellAngstrom: number,
 *   minDistanceAngstrom: number, method: string, limitation: string}}
 * @throws when the solute is empty, the count/seed/shell is out of range, the
 *   solvent has no template, or a molecule cannot be placed without overlap.
 */
export function buildSolventCluster({
  solute,
  solvent = 'water',
  count = 10,
  seed = 1,
  shellAngstrom = 3.5,
  minDistanceAngstrom = 2.0,
} = {}) {
  if (!Array.isArray(solute) || solute.length === 0) {
    throw new Error('Explicit solvation needs a solute with at least one atom.');
  }
  const template = explicitSolventFor(solvent);
  if (!template) {
    throw new Error(`No explicit solvent parameters for "${String(solvent ?? '')}". `
      + `This build places: ${EXPLICIT_SOLVENT_IDS.join(', ')}.`);
  }
  const requestedCount = Number(count);
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 64) {
    throw new Error('Solvent molecule count must be a whole number between 1 and 64.');
  }
  const requestedSeed = Number(seed);
  if (!Number.isInteger(requestedSeed) || requestedSeed < 0 || requestedSeed > 0x7fffffff) {
    throw new Error('Placement seed must be a whole number between 0 and 2147483647.');
  }
  const shell = Number(shellAngstrom);
  if (!Number.isFinite(shell) || shell < 1 || shell > 20) {
    throw new Error('Solvent shell thickness must be between 1 and 20 angstrom.');
  }
  const spacing = Number(minDistanceAngstrom);
  if (!Number.isFinite(spacing) || spacing < 0.8 || spacing > 6) {
    throw new Error('Minimum atom distance must be between 0.8 and 6 angstrom.');
  }
  const cleanSolute = solute.map((atom, index) => {
    const coordinates = [atom?.x, atom?.y, atom?.z].map(Number);
    if (coordinates.some((value) => !Number.isFinite(value))) {
      throw new Error(`Solute atom ${index + 1} has a non-finite coordinate.`);
    }
    return { element: String(atom?.element || ''), x: coordinates[0], y: coordinates[1], z: coordinates[2] };
  });
  const center = centroid(cleanSolute);
  const soluteRadius = Math.max(...cleanSolute.map((atom) => distance(atom, center)));
  const random = mulberry32(requestedSeed);
  const atoms = [...cleanSolute];
  let tightest = Infinity;
  for (let index = 0; index < requestedCount; index += 1) {
    let placed = false;
    for (let attempt = 0; attempt < 64 && !placed; attempt += 1) {
      const direction = unitVector(index, requestedCount, random);
      const shellOffset = shell + attempt * 0.35;
      const radius = soluteRadius + shellOffset;
      const solventCenter = {
        x: center.x + direction.x * radius,
        y: center.y + direction.y * radius,
        z: center.z + direction.z * radius,
      };
      const angles = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2];
      const candidate = rotated(template, solventCenter, angles);
      const separation = minimumDistance(candidate, atoms);
      if (separation >= spacing) {
        atoms.push(...candidate);
        tightest = Math.min(tightest, separation);
        placed = true;
      }
    }
    if (!placed) {
      throw new Error(`Could not place solvent molecule ${index + 1} of ${requestedCount} without atom clashes. `
        + 'Increase the shell thickness or reduce the solvent count.');
    }
  }
  return {
    atoms,
    composition: {
      soluteFormula: formulaOf(cleanSolute),
      solventFormula: template.formula,
      solventCount: requestedCount,
      soluteAtoms: cleanSolute.length,
      solventAtoms: template.atoms.length,
      totalAtoms: atoms.length,
    },
    formula: `${formulaOf(cleanSolute)} · ${requestedCount} ${template.formula}`,
    solvent: { id: template.id, label: template.label, formula: template.formula },
    count: requestedCount,
    seed: requestedSeed,
    shellAngstrom: shell,
    minDistanceAngstrom: spacing,
    // The exact fact a reader must not lose: placement is not equilibration.
    method: 'deterministic Fibonacci-shell placement, rigid solvent templates, no relaxation',
    limitation: 'One explicit cluster is not bulk solvent and was not equilibrated; implicit solvation '
      + 'is still the model for the surrounding continuum unless the record says otherwise.',
  };
}
