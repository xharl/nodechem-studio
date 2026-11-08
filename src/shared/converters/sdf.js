/**
 * MDL SDF (V2000), the structure format every chemistry program reads.
 *
 * The point of writing it is the bond table: an XYZ file states atoms and
 * nothing else, so a reader has to guess connectivity from radii — the same
 * guess NodeChem makes when a file carries no topology. An SDF hands the
 * reader the bonds it already knows, including their orders.
 *
 * V2000 stops at 999 atoms and 999 bonds. This writer refuses past that limit
 * instead of truncating or silently switching to V3000, which is a different
 * file layout with different line forms.
 */

import { ConversionError } from './xyz.js';

export const SDF_V2000_LIMIT = 999;

function finite(value, what) {
  const number = (value === null || value === undefined || value === '') ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) {
    throw new ConversionError(`${what} is not a finite number (${JSON.stringify(value)}).`);
  }
  return number;
}

function atomLine(atom, index) {
  const element = typeof atom?.element === 'string' ? atom.element.trim() : '';
  if (!element) throw new ConversionError(`atom ${index + 1} has no element symbol.`);
  const x = finite(atom.x, `atom ${index + 1} x`).toFixed(4);
  const y = finite(atom.y, `atom ${index + 1} y`).toFixed(4);
  const z = finite(atom.z, `atom ${index + 1} z`).toFixed(4);
  const symbol = element.padStart(3);
  return `${x.padStart(10)}${y.padStart(10)}${z.padStart(10)} ${symbol}  0  0  0  0  0  0  0  0  0  0  0  0`;
}

function bondLine(bond, index, atomCount) {
  // Both spellings of a bond are accepted: the importer's `{a, b}` (1-based,
  // as every structure file states it) and the clearer `{from, to}`.
  const from = Number(bond?.from ?? bond?.a);
  const to = Number(bond?.to ?? bond?.b);
  const order = Number(bond?.order ?? 1);
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new ConversionError(`bond ${index + 1} does not name two 1-based atoms.`);
  }
  if (from < 1 || to < 1 || from > atomCount || to > atomCount) {
    throw new ConversionError(`bond ${index + 1} refers to atom ${from}-${to}, but the structure has ${atomCount} atoms.`);
  }
  if (from === to) throw new ConversionError(`bond ${index + 1} joins atom ${from} to itself.`);
  if (![1, 1.5, 2, 3, 4].includes(order)) {
    throw new ConversionError(`bond ${index + 1} has order ${order}; SDF V2000 writes 1, 2, 3 or 4 (aromatic).`);
  }
  // MOL2 states aromatic bonds as 1.5; V2000 states them as type 4. The
  // conversion is lossy in the other direction, so it is noted in the export.
  const written = order === 1.5 ? 4 : order;
  return `${String(from).padStart(3)}${String(to).padStart(3)}${String(written).padStart(3)}  0  0  0  0`;
}

/**
 * @param {{atoms: Array<{element: string, x: number, y: number, z: number}>,
 *          bonds?: Array<{from: number, to: number, order?: number}>,
 *          title?: string, program?: string, comment?: string}} structure
 *   `bonds` are 1-based, as the SDF itself is.
 * @returns {string}
 */
export function writeSdf({ atoms, bonds = [], title = '', program = 'NodeChem', comment = '' } = {}) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new ConversionError('there is no structure to write: no atoms.');
  }
  if (atoms.length > SDF_V2000_LIMIT) {
    throw new ConversionError(`SDF V2000 holds ${SDF_V2000_LIMIT} atoms; this structure has ${atoms.length}.`);
  }
  const bondList = Array.isArray(bonds) ? bonds : [];
  if (bondList.length > SDF_V2000_LIMIT) {
    throw new ConversionError(`SDF V2000 holds ${SDF_V2000_LIMIT} bonds; this structure has ${bondList.length}.`);
  }
  const lines = [
    String(title || '').slice(0, 80),
    `${String(program).slice(0, 8).padStart(8)}${'3D'.padStart(10)}`,
    String(comment || '').slice(0, 80),
    `${String(atoms.length).padStart(3)}${String(bondList.length).padStart(3)}`
      + '  0  0  0  0  0  0  0  0999 V2000',
    ...atoms.map(atomLine),
    ...bondList.map((bond, index) => bondLine(bond, index, atoms.length)),
    'M  END',
  ];
  return `${lines.join('\n')}\n`;
}
