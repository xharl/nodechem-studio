/**
 * Structure import for NodeChem Studio.
 *
 * Reads Cartesian geometries from .xyz, .mol, .sdf, .gjf and .com. Pure module:
 * text in, validated molecule out. Z-matrices are refused with a specific
 * message rather than converted silently.
 *
 * Every imported structure is checked for: known element symbols, finite
 * coordinates, charge/multiplicity range, and electron-count parity.
 */

import { atomicNumber, isElementSymbol } from './elements.js';
import { logFrames, parseCjson, parseMol2, parsePdb, parsePdbModels } from './structureParsers.js';
import { parseTrajectory } from './trajectory.js';

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

const SUPPORTED_EXTENSIONS = Object.freeze(['xyz', 'mol', 'sdf', 'gjf', 'com']);
const EXTRA_EXTENSIONS = Object.freeze(['mol2', 'pdb', 'ent', 'pdbqt', 'cjson', 'log', 'out']);
// Extensions we recognise only in order to refuse them with a reason (#59/#58).
const REFUSED_EXTENSIONS = Object.freeze(['chk', 'fchk', 'smi', 'smiles', 'inchi', 'inchi1']);

function formatFor(filename, text) {
  const extension = String(filename).toLowerCase().split('.').pop();
  if (REFUSED_EXTENSIONS.includes(extension)) return extension;
  if (SUPPORTED_EXTENSIONS.includes(extension)) return extension;
  // Content wins over the extension, because a `.log` can be a Gaussian output
  // or a plain run log, and a MOL2 begins with `#` comment lines that used to
  // look like a .gjf route section.
  if (/@<TRIPOS>MOLECULE/i.test(text)) return 'mol2';
  if (/^\s*Standard orientation:/m.test(text) && /Gaussian|GINC|Entering Link 1/i.test(text)) return 'log';
  if (/^\{"molecule"|"conformer"\s*:\s*\{/m.test(text)) return 'cjson';
  if (/^(ATOM  |HETATM)/m.test(text)) {
    return extension === 'pdbqt' ? 'pdbqt' : 'pdb';
  }
  if (EXTRA_EXTENSIONS.includes(extension)) return extension;
  if (/^\s*\d+\s*\r?\n/.test(text) && /\b\d+\s*\r?\n/.test(text)) return 'xyz';
  if (/V2000|V3000|\$\$\$\$/i.test(text)) return 'mol';
  if (/^\s*%|^\s*#/m.test(text)) return 'gjf';
  return '';
}

function finalize({ atoms, bonds, charge, multiplicity, format, name, warnings, parity = 'error' }) {
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

  // Bonds are 1-based in every file format here; they are validated against the
  // atom count rather than trusted, because a wrong index would draw a bond to
  // an atom that does not exist.
  const finalBonds = [];
  const seenBonds = new Set();
  for (const raw of Array.isArray(bonds) ? bonds : []) {
    const a = integer(raw?.a);
    const b = integer(raw?.b);
    const order = toNumber(raw?.order ?? 1);
    if (a === null || b === null) continue;
    if (a < 1 || b < 1 || a > cleaned.length || b > cleaned.length || a === b) {
      warnings.push(`Dropped a bond between atoms ${raw?.a} and ${raw?.b}: the indices are outside this structure.`);
      continue;
    }
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (seenBonds.has(key)) continue;
    seenBonds.add(key);
    finalBonds.push({ a: Math.min(a, b), b: Math.max(a, b), order: order === 1.5 || order === 2 || order === 3 ? order : 1 });
  }

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
  // Formats that state charge and multiplicity must also agree with the
  // electron count. Formats that state neither (PDB, MOL2, cJSON, a log frame)
  // get the smallest consistent multiplicity instead, with a warning: refusing
  // a crystallographic file because it lacks hydrogens would block the import
  // to protect a number the file never contained.
  let consistentMultiplicity = finalMultiplicity;
  if ((electrons - (consistentMultiplicity - 1)) % 2 !== 0) {
    if (parity === 'error') {
      throw new StructureError(
        `Charge ${finalCharge} and multiplicity ${consistentMultiplicity} are inconsistent with ${electrons} electrons (parity mismatch).`,
      );
    }
    consistentMultiplicity = electrons % 2 === 0 ? 1 : 2;
    warnings.push(
      `The structure has ${electrons} electrons, so the multiplicity was set to ${consistentMultiplicity} `
      + '(this format does not state a spin state; crystallographic files often omit hydrogens — check before running).',
    );
  }

  return {
    format,
    name: String(name || '').trim().slice(0, 120) || 'Imported structure',
    atoms: cleaned,
    // Only a file that states its topology carries bonds. Distance perception
    // is the viewer's job, so an empty list means "not stated", never "none".
    ...(finalBonds.length ? { bonds: finalBonds } : {}),
    charge: finalCharge,
    multiplicity: consistentMultiplicity,
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

/**
 * Every frame of a multi-frame XYZ (an optimisation dump, a trajectory). Each
 * frame is a count line, a comment line and `count` atom lines; a trailing
 * incomplete frame is reported rather than silently ignored.
 */
function xyzFrames(lines) {
  const frames = [];
  let cursor = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    if (cursor >= lines.length) break;
    const count = integer(lines[cursor]);
    if (count === null || count <= 0) break;
    const block = lines.slice(cursor, cursor + count + 2);
    if (block.length < count + 2) {
      frames.push({ error: `Frame ${frames.length + 1} declares ${count} atoms but the file ends early.` });
      break;
    }
    try {
      frames.push(parseXyz(block));
    } catch (error) {
      frames.push({ error: error.message });
    }
    cursor += count + 2;
  }
  return frames;
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

  // The bond block was previously read only to find where it ends; the orders
  // it carries are real chemistry that distance perception cannot recover.
  const bonds = [];
  let aromatic = 0;
  for (let index = 0; index < bondCount; index += 1) {
    const line = lines[countsIndex + 1 + atomCount + index];
    const match = line === undefined ? null : line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)/);
    if (!match) continue;
    const type = integer(match[3]);
    // V2000 bond types: 1 single, 2 double, 3 triple, 4 aromatic.
    if (type === 4) aromatic += 1;
    bonds.push({
      a: integer(match[1]),
      b: integer(match[2]),
      order: type === 4 ? 1.5 : Math.min(Math.max(type ?? 1, 1), 3),
    });
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
    bonds,
    charge,
    multiplicity: 1,
    name: name || (lines[0] || '').trim(),
    warnings: [
      ...(chargeById.size > 0 ? [`Formal charges from ${chargeById.size} M  CHG entr${chargeById.size === 1 ? 'y' : 'ies'} applied.`] : []),
      ...(aromatic > 0 ? [`${aromatic} aromatic bond${aromatic === 1 ? '' : 's'} kept as order 1.5.`] : []),
    ],
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

/**
 * Formats that describe a periodic solid. They are refused by name: a CIF is
 * a unit cell with symmetry operations, not a molecule, and silently parsing
 * the asymmetric unit as if it were a cluster would be a wrong answer rather
 * than a missing feature.
 */
const PERIODIC_EXTENSIONS = Object.freeze(['cif', 'mcif', 'mmcif', 'p1', 'poscar', 'vasp', 'cell']);

function periodicFormatFor(filename, text) {
  const extension = String(filename).toLowerCase().split('.').pop();
  if (PERIODIC_EXTENSIONS.includes(extension)) return extension;
  if (/^\s*_cell_length_a\b/m.test(text) || /^\s*_symmetry_space_group_name_H-M\b/m.test(text)) return 'cif';
  return '';
}

/**
 * Every structure in a file, so a caller can offer a picker instead of guessing.
 *
 * `.sdf` is split on its `$$$$` delimiter and `.xyz` on its frame headers; a
 * single-structure format returns one record. This exists because the previous
 * behaviour — parse record 1 and drop the rest — lost a 5-conformer file
 * without saying so.
 */
export function parseStructureRecords(text, { filename = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new StructureError('The structure file is empty.');
  const normalized = text.replace(/^\uFEFF/, '');
  const periodic = periodicFormatFor(filename, normalized);
  if (periodic) throw periodicError(filename, periodic);
  const format = formatFor(filename, normalized);
  const lines = normalized.split(/\r\n|\n|\r/);

  if (format === 'sdf' && normalized.includes('$$$$')) {
    const blocks = normalized.split('$$$$').map((block) => block.trim()).filter(Boolean);
    const records = [];
    blocks.forEach((block, index) => {
      try {
        records.push(finalize({ ...parseMol(block.split(/\r\n|\n|\r/), { format: 'sdf' }), format: 'sdf' }));
      } catch (error) {
        records.push({ error: `Record ${index + 1}: ${error.message}` });
      }
    });
    if (records.length === 0) throw new StructureError('The SDF contains no records.');
    return { format, records };
  }

  if (format === 'xyz') {
    const frames = xyzFrames(lines);
    if (frames.length > 1) {
      return { format, records: frames.map((frame) => (frame.error ? frame : finalize({ ...frame, format }))) };
    }
  }

  if (format === 'pdb' || format === 'pdbqt') {
    const records = parsePdbModels(normalized, { name: baseName(filename), pdbqt: format === 'pdbqt' });
    return { format: format === 'pdbqt' ? 'pdb' : format, records: records.map((record) => finalize({ ...record, format, parity: 'adjust' })) };
  }

  if (format === 'log') {
    const trajectory = parseTrajectory(normalized);
    const frames = logFrames(trajectory?.steps ?? [], { name: baseName(filename) });
    if (frames.length === 0) {
      throw new StructureError('This Gaussian log contains no Standard orientation block, so there is no geometry to import.');
    }
    return { format: 'log', records: frames.map((frame) => finalize({ ...frame, format: 'xyz', parity: 'adjust' })) };
  }

  const single = parseSingle(text, { filename });
  return { format: single.format, records: [single] };
}

function baseName(filename) {
  return String(filename || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

/**
 * Formats the reader does not implement yet. Naming the format and the tracking
 * issue is more useful than "Unrecognised structure format", which suggests the
 * file is broken rather than the reader being incomplete.
 */
/**
 * Formats that cannot be turned into a molecule here, each refused by reason.
 * A binary checkpoint is #59's scope; a SMILES string has no coordinates at all
 * and generating them needs an embedder this project does not ship.
 */
function unsupportedFormatError(format, filename) {
  if (format === 'chk' || format === 'fchk') {
    return new StructureError(`${String(format).toUpperCase()} is a binary checkpoint, not a structure file. `
      + 'Wavefunction ingest is tracked in #59; export coordinates to .xyz or .mol instead.');
  }
  if (format === 'smiles' || format === 'smarts' || format === 'inchi') {
    return new StructureError('A SMILES/InChI string carries no coordinates. Building a 3D structure from it '
      + 'needs a chemistry engine, which is out of scope (decision recorded in #58/#79). '
      + 'Supply a .xyz, .mol, .sdf, .mol2, .pdb or .cjson file.');
  }
  if (format === 'smi') {
    return new StructureError(`${filename || 'The file'} is a SMILES list, which carries no coordinates. `
      + 'Export the structures as .sdf or .mol2 and import that instead.');
  }
  return null;
}

function periodicError(filename, periodic) {
  return new StructureError(`Periodic systems are not supported: ${filename || `this .${periodic} file`} describes a unit cell, not a molecule. `
    + 'NodeChem Studio drives molecular Gaussian and xTB jobs — there is no unit cell, k-point sampling '
    + 'or band structure. Convert the system to a molecular cluster (.xyz, .gjf, .mol) first.');
}

export function parseStructure(text, { filename = '' } = {}) {
  return parseSingle(text, { filename });
}

function parseSingle(text, { filename = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new StructureError('The structure file is empty.');
  const normalized = text.replace(/^\uFEFF/, '');
  const periodic = periodicFormatFor(filename, normalized);
  if (periodic) throw periodicError(filename, periodic);
  const format = formatFor(filename, normalized);
  const lines = normalized.split(/\r\n|\n|\r/);

  let parsed;
  if (format === 'xyz') parsed = parseXyz(lines);
  else if (format === 'mol' || format === 'sdf') {
    const block = format === 'sdf' || normalized.includes('$$$$')
      ? normalized.split('$$$$')[0]
      : normalized;
    parsed = parseMol(block.split(/\r\n|\n|\r/), { format, name: lines[0] });
    const recordCount = normalized.split('$$$$').filter((part) => part.trim()).length;
    if (recordCount > 1) {
      parsed.warnings = [...(parsed.warnings || []), `The file contains ${recordCount} records; record 1 is loaded. Use the record picker to choose another.`];
    }
  } else if (format === 'gjf' || format === 'com') parsed = parseGjf(lines);
  else if (format === 'mol2') parsed = parseMol2(normalized, { name: baseName(filename) });
  else if (format === 'pdb' || format === 'pdbqt') parsed = parsePdb(normalized, { name: baseName(filename), pdbqt: format === 'pdbqt' });
  else if (format === 'cjson') parsed = parseCjson(normalized, { name: baseName(filename) });
  else if (format === 'log') {
    const frames = logFrames(parseTrajectory(normalized)?.steps ?? [], { name: baseName(filename) });
    if (frames.length === 0) throw new StructureError('This Gaussian log contains no Standard orientation block.');
    parsed = frames[frames.length - 1];
  } else if (unsupportedFormatError(format, filename)) throw unsupportedFormatError(format, filename);
  else throw new StructureError('Unrecognised structure format. Supported: .xyz, .mol, .sdf, .gjf, .com, .mol2, .pdb, .pdbqt, .cjson, .log.');

  // Only .mol/.sdf/.gjf state charge or multiplicity, so only they are held to
  // the parity rule as an error.
  const statesSpin = format === 'mol' || format === 'sdf' || format === 'gjf' || format === 'com';
  return finalize({ ...parsed, format, parity: statesSpin ? 'error' : 'adjust' });
}

/** Deterministic text form used by tests and the provenance record. */
export function structureSummary(structure) {
  const bonds = Array.isArray(structure.bonds) && structure.bonds.length
    ? ` · ${structure.bonds.length} bonds`
    : '';
  return `${structure.atoms.length} atoms${bonds} · charge ${structure.charge} · multiplicity ${structure.multiplicity}`;
}
