/**
 * Structure import for Gaussian Node Studio.
 *
 * Reads Cartesian geometries from .xyz, .mol, .sdf, .gjf and .com. Pure module:
 * text in, validated molecule out. Z-matrices are refused with a specific
 * message rather than converted silently.
 *
 * Every imported structure is checked for: known element symbols, finite
 * coordinates, charge/multiplicity range, and electron-count parity.
 */

import { atomicNumber, isElementSymbol } from './elements.js';

export class StructureError extends Error {}

const MAX_ATOMS = 1000;
const MAX_COORD = 1e6;

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const number = Number(String(value).trim().replace(/[Dd]/, 'E'));
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = Number(String(value).trim());
  return Number.isInteger(number) ? number : null;
}

function formatFor(filename, text) {
  const extension = String(filename).toLowerCase().split('.').pop();
  if (['xyz', 'mol', 'sdf', 'gjf', 'com'].includes(extension)) return extension;
  if (/^\s*\d+\s*\r?\n/.test(text) && /\b\d+\s*\r?\n/.test(text)) return 'xyz';
  if (/V2000|V3000|\$\$\$\$/i.test(text)) return 'mol';
  if (/^\s*%|^\s*#/m.test(text)) return 'gjf';
  return '';
}

function finalize({ atoms, charge, multiplicity, format, name, warnings }) {
  if (atoms.length === 0) throw new StructureError('The structure has no atoms.');
  if (atoms.length > MAX_ATOMS) throw new StructureError(`The structure has ${atoms.length} atoms; the limit is ${MAX_ATOMS}.`);

  const cleaned = atoms.map((atom, index) => {
    const element = String(atom.element || '').trim();
    if (!isElementSymbol(element)) {
      throw new StructureError(`Atom ${index + 1} has an unknown element symbol "${element}".`);
    }
    const coords = [atom.x, atom.y, atom.z].map((value) => {
      const number = toNumber(value);
      if (number === null || Math.abs(number) > MAX_COORD) {
        throw new StructureError(`Atom ${index + 1} (${element}) has a non-finite or out-of-range coordinate.`);
      }
      return number;
    });
    return { element, x: coords[0], y: coords[1], z: coords[2] };
  });

  const finalCharge = integer(charge ?? 0);
  if (finalCharge === null || finalCharge < -10 || finalCharge > 10) {
    throw new StructureError('Charge must be an integer between -10 and 10.');
  }
  const finalMultiplicity = integer(multiplicity ?? 1);
  if (finalMultiplicity === null || finalMultiplicity < 1 || finalMultiplicity > 10) {
    throw new StructureError('Multiplicity must be an integer between 1 and 10.');
  }

  const electrons = cleaned.reduce((total, atom) => total + atomicNumber(atom.element), 0) - finalCharge;
  if (electrons < 0) {
    throw new StructureError(`Charge ${finalCharge} removes more electrons than the ${cleaned.length} atoms provide.`);
  }
  if ((electrons - (finalMultiplicity - 1)) % 2 !== 0) {
    throw new StructureError(
      `Charge ${finalCharge} and multiplicity ${finalMultiplicity} are inconsistent with ${electrons} electrons (parity mismatch).`,
    );
  }

  return {
    format,
    name: String(name || '').trim().slice(0, 120) || 'Imported structure',
    atoms: cleaned,
    charge: finalCharge,
    multiplicity: finalMultiplicity,
    warnings,
  };
}

/* ── XYZ ──────────────────────────────────────────────────── */

function parseXyz(lines) {
  const count = integer(lines[0]);
  if (count === null || count <= 0) throw new StructureError('The XYZ header must start with the atom count.');
  if (count > MAX_ATOMS) throw new StructureError(`The XYZ file declares ${count} atoms; the limit is ${MAX_ATOMS}.`);
  const name = (lines[1] || '').trim();
  const atoms = [];
  for (let index = 0; index < count; index += 1) {
    const line = lines[index + 2];
    if (line === undefined || !line.trim()) {
      throw new StructureError(`The XYZ file declares ${count} atoms but contains only ${index}.`);
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) throw new StructureError(`XYZ atom line ${index + 3} needs an element and three coordinates.`);
    const [element, x, y, z] = parts;
    atoms.push({ element, x, y, z });
  }
  const warnings = [];
  if (lines.length > count + 2 && lines.slice(count + 2).some((line) => line.trim())) {
    warnings.push('Trailing lines after the declared atoms were ignored.');
  }
  return { atoms, charge: 0, multiplicity: 1, name, warnings };
}

/* ── MOL / SDF (V2000) ────────────────────────────────────── */

function atomFromMolLine(line) {
  const fixed = {
    x: line.slice(0, 10),
    y: line.slice(10, 20),
    z: line.slice(20, 30),
    element: line.slice(31, 34).trim(),
  };
  if (toNumber(fixed.x) !== null && fixed.element) return fixed;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;
  return { x: parts[0], y: parts[1], z: parts[2], element: parts[3] };
}

function parseMol(lines, { format = 'mol', name = '' } = {}) {
  const countsIndex = lines.findIndex((line, index) => index >= 2 && /^\s*\d+\s+\d+/.test(line));
  if (countsIndex < 0) throw new StructureError('The MOL block has no counts line.');
  const counts = lines[countsIndex].trim().split(/\s+/);
  const atomCount = integer(counts[0]);
  const bondCount = integer(counts[1]) ?? 0;
  if (!atomCount || atomCount <= 0) throw new StructureError('The MOL block declares no atoms.');
  if (atomCount > MAX_ATOMS) throw new StructureError(`The MOL block declares ${atomCount} atoms; the limit is ${MAX_ATOMS}.`);

  const atoms = [];
  for (let index = 0; index < atomCount; index += 1) {
    const line = lines[countsIndex + 1 + index];
    if (line === undefined) throw new StructureError(`The MOL block ends before atom ${index + 1}.`);
    const atom = atomFromMolLine(line);
    if (!atom) throw new StructureError(`MOL atom line ${index + 1} is malformed.`);
    atoms.push(atom);
  }

  const chargeById = new Map();
  for (let index = countsIndex + 1 + atomCount + bondCount; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^M\s+CHG\s+(.+)$/i);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/);
    for (let pair = 0; pair + 1 < tokens.length; pair += 2) {
      const atomIndex = integer(tokens[pair]);
      const value = integer(tokens[pair + 1]);
      if (atomIndex && value !== null) chargeById.set(atomIndex, value);
    }
  }
  const charge = [...chargeById.values()].reduce((total, value) => total + value, 0);

  return {
    atoms,
    charge,
    multiplicity: 1,
    name: name || (lines[0] || '').trim(),
    warnings: chargeById.size > 0 ? [`Formal charges from ${chargeById.size} M  CHG entr${chargeById.size === 1 ? 'y' : 'ies'} applied.`] : [],
  };
}

/* ── GJF / COM ────────────────────────────────────────────── */

function parseGjf(lines) {
  const routeIndex = lines.findIndex((line) => line.trim().startsWith('#'));
  if (routeIndex < 0) throw new StructureError('No Gaussian route line (#...) was found.');
  let linkEnd = lines.length;
  const linkIndex = lines.findIndex((line, index) => index > routeIndex && /^--Link1--/i.test(line.trim()));
  if (linkIndex >= 0) linkEnd = linkIndex;

  let chargeIndex = -1;
  for (let index = routeIndex + 1; index < linkEnd; index += 1) {
    if (/^\s*[+-]?\d+\s+\d+\s*$/.test(lines[index])) {
      chargeIndex = index;
      break;
    }
  }
  if (chargeIndex < 0) throw new StructureError('No charge/multiplicity line was found after the route section.');
  const [charge, multiplicity] = lines[chargeIndex].trim().split(/\s+/).map(Number);

  const atoms = [];
  for (let index = chargeIndex + 1; index < linkEnd; index += 1) {
    const line = lines[index];
    if (!line.trim()) break;
    if (/^--Link1--/i.test(line.trim())) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || !isElementSymbol(parts[0])) {
      throw new StructureError(
        `Coordinate line ${index + 1} is not Cartesian (element x y z). Z-matrix input is not supported; supply Cartesian coordinates.`,
      );
    }
    atoms.push({ element: parts[0], x: parts[1], y: parts[2], z: parts[3] });
  }
  if (atoms.length === 0) {
    throw new StructureError('No Cartesian coordinates were found after the charge/multiplicity line.');
  }
  const warnings = [];
  if (linkIndex >= 0) warnings.push('Only the first link was imported.');
  return { atoms, charge, multiplicity, name: '', warnings };
}

/* ── Public API ───────────────────────────────────────────── */

export function parseStructure(text, { filename = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new StructureError('The structure file is empty.');
  const normalized = text.replace(/^\uFEFF/, '');
  const format = formatFor(filename, normalized);
  const lines = normalized.split(/\r\n|\n|\r/);

  let parsed;
  if (format === 'xyz') parsed = parseXyz(lines);
  else if (format === 'mol' || format === 'sdf') {
    const block = format === 'sdf' || normalized.includes('$$$$')
      ? normalized.split('$$$$')[0]
      : normalized;
    parsed = parseMol(block.split(/\r\n|\n|\r/), { format, name: lines[0] });
  } else if (format === 'gjf' || format === 'com') parsed = parseGjf(lines);
  else throw new StructureError('Unrecognised structure format. Supported: .xyz, .mol, .sdf, .gjf, .com.');

  return finalize({ ...parsed, format });
}

/** Deterministic text form used by tests and the provenance record. */
export function structureSummary(structure) {
  return `${structure.atoms.length} atoms · charge ${structure.charge} · multiplicity ${structure.multiplicity}`;
}
