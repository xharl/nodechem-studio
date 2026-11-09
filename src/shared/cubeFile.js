/**
 * Gaussian cube reader (#59).
 *
 * A cube is a volumetric scalar field on a regular grid plus the nuclei it was
 * computed for: two comment lines, the atom count and grid origin, one row per
 * atom, three rows describing the grid axes, then every grid value. The file
 * states no units of its own — the sign of the first grid dimension does. A
 * negative count means the header distances are in Å; a positive one means
 * bohr. That is the single most common way to read a cube wrongly, so the
 * decision is made once, at the end of the header, and applied once.
 *
 * What this module refuses, rather than guesses:
 * - a file over `MAX_CUBE_CHARS` characters or a grid over `MAX_CUBE_VOXELS`
 *   points (a cube is parsed in memory, so the limit is stated, not implied);
 * - a header row with the wrong number of tokens, or a token that is not a
 *   number (the message carries the line number);
 * - a data block shorter than `nx·ny·nz` (truncated) or longer than it
 *   (a second dataset appended, which this reader does not model);
 * - `NVAL > 1`, i.e. a cube that stores several values per grid point;
 * - a file whose grid counts declare units other than the ones the caller
 *   asked for (`parseCube(text, { units: 'angstrom' })`), because the sign is
 *   one character wide and losing it is silent.
 *
 * What it does not refuse: a ghost atom (nuclear charge 0) is kept as an atom
 * with no element and reported as a warning, because Gaussian writes ghosts
 * this way and dropping them would shift every distance in the file.
 *
 * Values are returned exactly as written. A density cube usually holds
 * electrons/bohr³ and an orbital cube the wavefunction amplitude, but the file
 * does not say which, so this reader never labels them.
 */

import { ELEMENTS } from './elements.js';

/**
 * CODATA 2018 Bohr radius in Å. Defined here once and imported by `fchk.js`,
 * so every module converts with the same number and no coordinate is converted
 * twice.
 */
export const BOHR_TO_ANGSTROM = 0.529177210903;

/** Characters, not bytes: the guard bounds the work, and text is decoded already. */
export const MAX_CUBE_CHARS = 64 * 1024 * 1024;
export const MAX_CUBE_ATOMS = 2000;
export const MAX_CUBE_VOXELS = 4_000_000;

export class CubeFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CubeFormatError';
  }
}

const SYMBOL_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));

// Fortran output writes `D` exponents; both spellings are numbers here.
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;

function isNumericToken(token) {
  return NUMBER.test(String(token));
}

function numberToken(token, line, what) {
  const raw = String(token ?? '');
  if (!NUMBER.test(raw)) {
    throw new CubeFormatError(`Line ${line}: ${what} "${raw}" is not a number.`);
  }
  const value = Number(raw.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) {
    throw new CubeFormatError(`Line ${line}: ${what} "${raw}" is outside the range of a double.`);
  }
  return value;
}

function integerToken(token, line, what) {
  const value = numberToken(token, line, what);
  if (!Number.isInteger(value)) {
    throw new CubeFormatError(`Line ${line}: ${what} "${String(token)}" is not an integer.`);
  }
  return value;
}

function tokensOf(line) {
  return String(line ?? '').trim().split(/\s+/).filter(Boolean);
}

function requireLine(lines, index, what) {
  if (index >= lines.length) {
    throw new CubeFormatError(`The file ends before ${what} (line ${index + 1}).`);
  }
  return lines[index];
}

function gridIndex(flat, dims) {
  const [nx, ny] = dims;
  return [flat % nx, Math.floor(flat / nx) % ny, Math.floor(flat / (nx * ny))];
}

function summarise(values, dims) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let absMax = -Infinity;
  let minIndex = 0;
  let maxIndex = 0;
  let absMaxIndex = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    sum += value;
    if (value < min) {
      min = value;
      minIndex = index;
    }
    if (value > max) {
      max = value;
      maxIndex = index;
    }
    const magnitude = Math.abs(value);
    if (magnitude > absMax) {
      absMax = magnitude;
      absMaxIndex = index;
    }
  }
  return {
    count: values.length,
    min,
    max,
    mean: values.length ? sum / values.length : 0,
    absMax,
    minIndex,
    maxIndex,
    absMaxIndex,
    // Voxel coordinates are (x, y, z) in the same order as `dims`, which is
    // the order the header declares the axes in.
    minVoxel: gridIndex(minIndex, dims),
    maxVoxel: gridIndex(maxIndex, dims),
    absMaxVoxel: gridIndex(absMaxIndex, dims),
  };
}

/**
 * Parse a Gaussian cube file.
 *
 * The layout is decided by one fact, not by a guess: the row after
 * `natoms ox oy oz` is a grid row in the standard layout (`count vx vy vz`,
 * four numbers — what `cubegen` and Psi4 `cubeprop` write) and an atom row in
 * the layout this reader used to assume (`atomicNumber charge x y z`, five
 * numbers). Four tokens means grid rows first; anything else means the legacy
 * atom-first dialect, which is still read and is marked as such.
 *
 * Value order is a second, independent question. Gaussian writes the values
 * with x varying fastest; Psi4's `cubeprop` writes the same header and then z
 * fastest. A file whose first line is Psi4's own `Psi4 Gaussian Cube File.`
 * declares its writer, so its values are reordered to the x-fastest contract
 * every caller of this module expects. `valuesOrder` overrides that for a file
 * whose title was edited.
 *
 * @param {string} text
 * @param {{ maxChars?: number, valuesOrder?: 'auto'|'fortran'|'c-order', units?: 'auto'|'bohr'|'angstrom' }} [options]
 *   `maxChars` exists so the bound can be tested without building a 64 MB
 *   string; callers should not pass it. `units` states what the caller expects
 *   the file to declare (`'auto'`, the default, accepts either): a file that
 *   disagrees is refused here rather than read with every distance off by the
 *   bohr-to-Å factor.
 * @returns {object} cube in Å, values in Fortran order (x fastest)
 */
export function parseCube(text, { maxChars = MAX_CUBE_CHARS, valuesOrder = 'auto', units = 'auto' } = {}) {
  const lines = cubeLines(text, maxChars);
  const layout = cubeLayoutOf(lines);
  const order = valuesOrder === 'auto' ? cubeValuesOrderOf(lines, layout) : valuesOrder;
  if (order !== 'fortran' && order !== 'c-order') {
    throw new CubeFormatError(`unknown values order "${valuesOrder}"; use "auto", "fortran" or "c-order".`);
  }
  if (units !== 'auto' && units !== 'bohr' && units !== 'angstrom') {
    throw new CubeFormatError(`unknown units "${units}"; use "auto", "bohr" or "angstrom".`);
  }
  return parseCubeLines(lines, layout, order, units);
}

/**
 * The row after the `natoms ox oy oz` line: a grid row (four numbers) in the
 * standard layout, an atom row (five) in the legacy one. Nothing is inferred
 * beyond that token count, and the chosen layout then has to parse completely.
 */
function cubeLayoutOf(lines) {
  return tokensOf(lines[3]).length === 4 ? 'standard' : 'legacy';
}

/**
 * Psi4 states its own name on the first line and writes values with the last
 * axis fastest. Only a standard-layout file with that title is reordered: a
 * Gaussian cube keeps the order its format specifies, and a legacy file has no
 * declared writer.
 */
function cubeValuesOrderOf(lines, layout) {
  if (layout !== 'standard') return 'fortran';
  return PSI4_TITLE.test(String(lines[0] ?? '').trim()) ? 'c-order' : 'fortran';
}

const PSI4_TITLE = /^Psi4 Gaussian Cube File\.?$/i;

/**
 * The size, emptiness and short-file guards, shared by both layouts: a file
 * refused here cannot be rescued by reading it differently.
 */
function cubeLines(text, maxChars) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new CubeFormatError('The cube file is empty.');
  }
  if (text.length > maxChars) {
    throw new CubeFormatError(
      `The cube is ${text.length} characters; the limit is ${maxChars}. `
      + 'Regenerate it on a coarser grid (cubegen takes the grid size as an argument).',
    );
  }

  const lines = text.split(/\r\n|\n|\r/);

  // Two comment lines are part of the format. Some writers emit one; a cube
  // read with the wrong offset silently treats a comment as the count line, so
  // the offsets are fixed here and a short file is an error rather than a
  // guess.
  if (lines.length < 4) {
    throw new CubeFormatError('The cube is too short to hold the two comment lines, the header and a grid.');
  }
  return lines;
}

function parseCubeLines(lines, layout, valuesOrder, expectedUnits = 'auto') {
  const legacy = layout === 'legacy';
  const title = [lines[0].trim(), lines[1].trim()];

  const countLine = requireLine(lines, 2, 'the "atoms ox oy oz" header');
  const countTokens = tokensOf(countLine);
  if (countTokens.length < 4) {
    throw new CubeFormatError(
      `Line 3: expected "atoms ox oy oz [nval]", found ${countTokens.length} token${countTokens.length === 1 ? '' : 's'}.`,
    );
  }
  if (countTokens.length > 5) {
    throw new CubeFormatError(`Line 3: found ${countTokens.length} tokens; the header defines at most 5 ("atoms ox oy oz nval").`);
  }

  const atomCount = integerToken(countTokens[0], 3, 'the atom count');
  if (atomCount < 0) {
    throw new CubeFormatError(`Line 3: the atom count is ${atomCount}; it cannot be negative.`);
  }
  if (atomCount > MAX_CUBE_ATOMS) {
    throw new CubeFormatError(`The cube declares ${atomCount} atoms; the limit is ${MAX_CUBE_ATOMS}.`);
  }
  const valueCount = countTokens.length === 5 ? integerToken(countTokens[4], 3, 'the value count NVAL') : 1;
  if (valueCount !== 1) {
    throw new CubeFormatError(
      `The cube stores ${valueCount} values per grid point (NVAL=${valueCount}); only single-value cubes are read. `
      + 'Write one cube per quantity instead.',
    );
  }

  const originRaw = countTokens.slice(1, 4).map((token, axis) => (
    numberToken(token, 3, `the origin ${'xyz'[axis]}`)
  ));

  // The standard layout writes the three grid rows first and the atoms after
  // them; the legacy layout this reader used to assume has the two blocks the
  // other way round. Which one this is was decided by the token count on line 4.
  const atomBlockStart = legacy ? 3 : 6;
  const axisBlockStart = legacy ? 3 + atomCount : 3;

  const atoms = [];
  let ghostAtoms = 0;
  for (let index = 0; index < atomCount; index += 1) {
    const lineIndex = atomBlockStart + index;
    const line = requireLine(lines, lineIndex, `the atom block (${atomCount} rows expected)`);
    const parts = tokensOf(line);
    const lineNumber = lineIndex + 1;
    if (parts.length < 5) {
      throw new CubeFormatError(`Line ${lineNumber}: an atom row needs "atomicNumber charge x y z", found ${parts.length} token${parts.length === 1 ? '' : 's'}.`);
    }
    const atomicNumber = integerToken(parts[0], lineNumber, 'the atomic number');
    if (atomicNumber < 0 || atomicNumber > 118) {
      throw new CubeFormatError(
        `Line ${lineNumber}: atomic number ${atomicNumber} is outside 0–118. `
        + 'A negative value here usually means the atom count on line 3 is larger than the atom block.',
      );
    }
    // The nuclear charge is part of the format but not part of the geometry;
    // it is read so a malformed row is caught here rather than at the grid.
    numberToken(parts[1], lineNumber, 'the nuclear charge');
    const element = SYMBOL_BY_NUMBER.get(atomicNumber) ?? null;
    if (atomicNumber === 0) ghostAtoms += 1;
    atoms.push({
      atomicNumber,
      element,
      x: numberToken(parts[2], lineNumber, 'the x coordinate'),
      y: numberToken(parts[3], lineNumber, 'the y coordinate'),
      z: numberToken(parts[4], lineNumber, 'the z coordinate'),
    });
  }

  const dims = [];
  const signs = [];
  const axesRaw = [];
  const spacingRaw = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const lineIndex = axisBlockStart + axis;
    const line = requireLine(lines, lineIndex, 'the grid axis block (3 rows expected)');
    const parts = tokensOf(line);
    const lineNumber = lineIndex + 1;
    const stated = integerToken(parts[0], lineNumber, `the ${'xyz'[axis]} grid count`);
    if (stated === 0) {
      throw new CubeFormatError(`Line ${lineNumber}: the ${'xyz'[axis]} grid count is 0.`);
    }
    dims.push(Math.abs(stated));
    signs.push(stated < 0 ? -1 : 1);
    // Standard: `count vx vy vz` — three numbers, and the vector already is the
    // step (0.2 bohr along x is written `0.200000 0.000000 0.000000`).
    // Legacy: `count spacing vx vy vz` — a separate spacing and a direction, so
    // the step is the product. Multiplying in both would square the spacing
    // (#155); the axis vector, and its `hypot`, are the file's own step either
    // way.
    let vector;
    if (legacy) {
      if (parts.length < 5) {
        throw new CubeFormatError(`Line ${lineNumber}: a grid row needs "count spacing vx vy vz", found ${parts.length} token${parts.length === 1 ? '' : 's'}.`);
      }
      const spacing = numberToken(parts[1], lineNumber, `the ${'xyz'[axis]} grid spacing`);
      vector = [
        spacing * numberToken(parts[2], lineNumber, `the ${'xyz'[axis]} axis x component`),
        spacing * numberToken(parts[3], lineNumber, `the ${'xyz'[axis]} axis y component`),
        spacing * numberToken(parts[4], lineNumber, `the ${'xyz'[axis]} axis z component`),
      ];
    } else {
      if (parts.length !== 4) {
        throw new CubeFormatError(
          `Line ${lineNumber}: a grid row needs "count vx vy vz" (four numbers), found ${parts.length} token${parts.length === 1 ? '' : 's'}. `
          + 'A five-number row belongs to the non-standard atom-first layout, which is detected on line 4.',
        );
      }
      vector = [
        numberToken(parts[1], lineNumber, `the ${'xyz'[axis]} grid step x`),
        numberToken(parts[2], lineNumber, `the ${'xyz'[axis]} grid step y`),
        numberToken(parts[3], lineNumber, `the ${'xyz'[axis]} grid step z`),
      ];
    }
    const spacing = Math.hypot(vector[0], vector[1], vector[2]);
    if (!(spacing > 0)) {
      throw new CubeFormatError(`Line ${lineNumber}: the ${'xyz'[axis]} grid step is zero-length, so the axis has no direction.`);
    }
    spacingRaw.push(spacing);
    axesRaw.push(vector);
  }

  const warnings = [];
  if (legacy) {
    warnings.push(
      'This cube writes its atom block before the grid rows and states a separate spacing in each grid row '
      + '(the non-standard layout this reader used to assume); it was read in that layout.',
    );
  }
  if (ghostAtoms > 0) {
    warnings.push(`${ghostAtoms} ghost atom${ghostAtoms === 1 ? '' : 's'} (nuclear charge 0) kept without an element symbol; they still occupy their grid position.`);
  }

  // The sign of the first dimension sets the units, per the format. Writers
  // that set only the first one negative are read the same way; a disagreement
  // is reported instead of being resolved silently.
  const nativeBohr = signs[0] > 0;
  const declaredUnits = nativeBohr ? 'bohr' : 'angstrom';
  if (expectedUnits !== 'auto' && expectedUnits !== declaredUnits) {
    // The defect this guard exists for: a file whose counts lost (or gained) a
    // minus sign reads without complaint and puts every distance off by the
    // bohr-to-Å factor, which a picture of the slice does not reveal.
    throw new CubeFormatError(
      `The cube declares its distances in ${declaredUnits} (${nativeBohr ? 'positive' : 'negative'} grid counts on line 4) `
      + `but it was read as ${expectedUnits}. Reading it as ${expectedUnits} would move every atom, the origin and `
      + `the grid step by the ${declaredUnits}-to-${expectedUnits} factor. `
      + `Read it with units "${declaredUnits}", or rewrite its header in ${expectedUnits}.`,
    );
  }
  if (!signs.every((sign) => sign === signs[0])) {
    warnings.push('The three grid dimensions disagree about their sign; the first one decides the units (negative means Å), as the format specifies.');
  }

  const expected = dims[0] * dims[1] * dims[2];
  if (expected > MAX_CUBE_VOXELS) {
    throw new CubeFormatError(`The grid is ${dims.join('×')} = ${expected} points; the limit is ${MAX_CUBE_VOXELS}.`);
  }

  const values = new Float64Array(expected);
  let filled = 0;
  const dataStart = Math.max(atomBlockStart + atomCount, axisBlockStart + 3);
  // Last line that contributed values, so trailing text can be checked after
  // the value that completed the grid rather than at the top of the block.
  let lastDataLine = dataStart - 1;
  for (let lineIndex = dataStart; lineIndex < lines.length && filled < expected; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    lastDataLine = lineIndex;
    const parts = tokensOf(line);
    for (const token of parts) {
      if (filled >= expected) {
        throw new CubeFormatError(
          `Line ${lineIndex + 1}: the grid holds ${expected} values (${dims.join('×')}), but the data continues with "${token}". `
          + 'A file with more values than its grid holds is a multi-dataset cube, which is not read.',
        );
      }
      values[filled] = numberToken(token, lineIndex + 1, 'a grid value');
      filled += 1;
    }
  }

  if (filled < expected) {
    throw new CubeFormatError(
      `The grid declares ${expected} values (${dims.join('×')}) but the file ends after ${filled}; the cube is truncated.`,
    );
  }
  // A blank line may separate the grid from the end of the file, but any
  // non-blank line after it is data this reader would otherwise drop.
  for (let lineIndex = lastDataLine + 1; lineIndex < lines.length; lineIndex += 1) {
    if (lines[lineIndex].trim()) {
      throw new CubeFormatError(`Line ${lineIndex + 1}: unexpected text after the ${expected} grid values.`);
    }
  }

  // A file that says it came from Psi4 has its values reordered here, once, so
  // every caller gets the same x-fastest contract.
  const ordered = valuesOrder === 'c-order' ? fortranFromC(values, dims) : values;

  const scale = nativeBohr ? BOHR_TO_ANGSTROM : 1;
  // |det(axes)| is one voxel's volume (the axes are per-voxel vectors), so the
  // cell volume is that times the number of points. Both are reported: an
  // isosurface summary needs the cell, a viewer's mesh needs the voxel.
  const voxelVolumeAngstrom3 = Math.abs(
    axesRaw[0][0] * (axesRaw[1][1] * axesRaw[2][2] - axesRaw[1][2] * axesRaw[2][1])
    - axesRaw[0][1] * (axesRaw[1][0] * axesRaw[2][2] - axesRaw[1][2] * axesRaw[2][0])
    + axesRaw[0][2] * (axesRaw[1][0] * axesRaw[2][1] - axesRaw[1][1] * axesRaw[2][0]),
  ) * scale ** 3;
  return {
    format: 'cube',
    title,
    atoms: atoms.map((atom) => ({
      ...atom,
      x: atom.x * scale,
      y: atom.y * scale,
      z: atom.z * scale,
    })),
    origin: originRaw.map((value) => value * scale),
    axes: axesRaw.map((vector) => vector.map((value) => value * scale)),
    spacing: spacingRaw.map((value) => Math.abs(value) * scale),
    dims,
    values: ordered,
    stats: summarise(ordered, dims),
    layout,
    valuesOrder,
    units: {
      coordinates: 'angstrom',
      source: nativeBohr ? 'bohr' : 'angstrom',
    },
    volumeAngstrom3: voxelVolumeAngstrom3 * expected,
    voxelVolumeAngstrom3,
    warnings,
  };
}

/** C-order (last axis fastest) → the Fortran order every field here uses. */
function fortranFromC(raw, dims) {
  const [nx, ny, nz] = dims;
  const ordered = new Float64Array(raw.length);
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) {
        ordered[i + nx * (j + ny * k)] = raw[i * ny * nz + j * nz + k];
      }
    }
  }
  return ordered;
}

/* ── writing ──────────────────────────────────────────────── */

/** `%12.5E`, the field cubegen and Psi4 both use for the value block. */
function exponential(value) {
  // `-0` is a real number but writes as noise; 0.0 is its only meaning here.
  const clean = Object.is(value, -0) ? 0 : value;
  const [mantissa, rawExponent] = clean.toExponential(5).split('e');
  const sign = rawExponent.startsWith('-') ? '-' : '+';
  const digits = rawExponent.replace(/^[+-]/, '').padStart(2, '0');
  return `${mantissa}E${sign}${digits}`.padStart(12, ' ');
}

/** `%12.6f`: a coordinate column, or a charge. */
function decimal(value, width = 12, places = 6) {
  const clean = Object.is(value, -0) ? 0 : value;
  return clean.toFixed(places).padStart(width, ' ');
}

function commentLine(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function checkpointAtoms(atoms) {
  if (!Array.isArray(atoms)) return [];
  return atoms.map((atom, index) => {
    const x = Number(atom?.x);
    const y = Number(atom?.y);
    const z = Number(atom?.z);
    if (![x, y, z].every((value) => Number.isFinite(value))) {
      throw new CubeFormatError(`atom ${index + 1} has a missing or non-finite coordinate, so it cannot be written.`);
    }
    let atomicNumber = Number.isInteger(atom?.atomicNumber) ? atom.atomicNumber : null;
    if (atomicNumber === null && typeof atom?.element === 'string') {
      atomicNumber = ELEMENTS.get(atom.element) ?? ELEMENTS.get(capitalise(atom.element)) ?? null;
    }
    if (atomicNumber === null && typeof atom?.symbol === 'string') {
      atomicNumber = ELEMENTS.get(capitalise(atom.symbol)) ?? null;
    }
    if (!Number.isInteger(atomicNumber) || atomicNumber < 0 || atomicNumber > 118) {
      throw new CubeFormatError(
        `atom ${index + 1} carries neither an atomic number nor an element symbol from the periodic table, `
        + 'and a cube row cannot be written without one.',
      );
    }
    return { atomicNumber, x, y, z };
  });
}

function capitalise(symbol) {
  const text = String(symbol).trim();
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : text;
}

/**
 * Write a cube in the standard Gaussian/Molden layout.
 *
 * The inverse of `parseCube`: two comment lines, `natoms ox oy oz`, the three
 * grid rows (`count vx vy vz` — four numbers, the step vector itself), one row
 * per atom (`atomicNumber charge x y z`), then the values in Fortran order, six
 * per line in `%12.5E`. `units: 'angstrom'` (the default) writes the negative
 * counts that mean "these distances are Å"; `units: 'bohr'` writes positive
 * counts and converts origin, axes and atom positions to bohr, which is what
 * `cubegen` itself writes.
 *
 * The field is the shape `fieldFromOrbital`/`fieldOfValues` produce: `values`
 * indexed `i + nx*(j + ny*k)`, `dims` (or `counts`), `origin` in Å and either
 * `axes` (three per-voxel vectors) or a scalar `step`. The values are rounded to
 * six significant digits by the format, so `parseCube(writeCube(field))`
 * reproduces them to about 5e-6 relative — the file's precision, not a loss in
 * the writer.
 *
 * What it refuses rather than guesses: a value that is not finite, an atom with
 * no atomic number or known element, a value count that does not match the grid,
 * and a grid axis with no length.
 *
 * @param {object} field
 * @param {{ title?: string, comment?: string, atoms?: object[], units?: 'angstrom'|'bohr' }} [options]
 * @returns {string} the cube text
 */
export function writeCube(field, { title = null, comment = null, atoms = null, units = 'angstrom' } = {}) {
  if (!field || typeof field !== 'object') throw new CubeFormatError('writeCube needs a field (values plus a grid).');
  const dims = field.dims ?? field.counts;
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every((n) => Number.isInteger(Number(n)) && Number(n) > 1)) {
    throw new CubeFormatError('the field needs three integer grid dimensions above 1 (dims or counts).');
  }
  const counts = dims.map(Number);
  const values = field.values;
  if (!values || typeof values.length !== 'number') {
    throw new CubeFormatError('the field has no values to write.');
  }
  const expected = counts[0] * counts[1] * counts[2];
  if (values.length !== expected) {
    throw new CubeFormatError(
      `the field holds ${values.length} values for a ${counts.join('×')} grid (${expected}), so the file would not round-trip.`,
    );
  }
  if (!Array.isArray(field.origin) || field.origin.length !== 3 || !field.origin.every((value) => Number.isFinite(Number(value)))) {
    throw new CubeFormatError('the field needs a three-number origin.');
  }

  let axes = Array.isArray(field.axes) ? field.axes : null;
  if (axes) {
    if (axes.length !== 3 || !axes.every((axis) => Array.isArray(axis) && axis.length === 3 && axis.every((value) => Number.isFinite(Number(value))))) {
      throw new CubeFormatError('the field axes must be three vectors of three numbers.');
    }
  } else if (Number.isFinite(Number(field.step)) && Number(field.step) > 0) {
    const step = Number(field.step);
    axes = [[step, 0, 0], [0, step, 0], [0, 0, step]];
  } else {
    throw new CubeFormatError('the field has neither axes nor a positive step, so the grid geometry is unknown.');
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const length = Math.hypot(...axes[axis].map(Number));
    if (!(length > 0)) throw new CubeFormatError(`grid axis ${'xyz'[axis]} has zero length.`);
  }

  const mode = String(units).toLowerCase();
  if (mode !== 'angstrom' && mode !== 'bohr') {
    throw new CubeFormatError(`unknown units "${units}"; use "angstrom" or "bohr".`);
  }
  const perAngstrom = mode === 'bohr' ? 1 / BOHR_TO_ANGSTROM : 1;
  const countSign = mode === 'bohr' ? 1 : -1;

  const list = checkpointAtoms(atoms ?? field.atoms ?? []);
  if (list.length > MAX_CUBE_ATOMS) {
    throw new CubeFormatError(`the cube would hold ${list.length} atoms; the reader accepts at most ${MAX_CUBE_ATOMS}.`);
  }

  const lines = [
    commentLine(title ?? field.label, 'NodeChem Studio cube'),
    commentLine(comment, 'OUTER LOOP: X, MIDDLE LOOP: Y, INNER LOOP: Z'),
    `${String(list.length).padStart(5)}${field.origin.map((value) => decimal(Number(value) * perAngstrom)).join('')}`,
  ];
  // The standard layout: the three grid rows come first, each one the point
  // count and the step vector itself (`count vx vy vz`, four numbers), and the
  // atom block follows them (#153). A negative count is what makes the
  // distances Å.
  for (let axis = 0; axis < 3; axis += 1) {
    const vector = axes[axis].map((value) => Number(value) * perAngstrom);
    lines.push(
      `${String(countSign * counts[axis]).padStart(5)}`
      + vector.map((value) => decimal(value)).join(''),
    );
  }
  for (const atom of list) {
    // The nuclear charge column is the atomic number; there is no separate
    // partial charge in this file, and writing one would invent a number.
    lines.push(
      `${String(atom.atomicNumber).padStart(5)}`
      + `${decimal(atom.atomicNumber)}`
      + `${decimal(atom.x * perAngstrom)}${decimal(atom.y * perAngstrom)}${decimal(atom.z * perAngstrom)}`,
    );
  }

  let row = [];
  for (let index = 0; index < expected; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      throw new CubeFormatError(`value ${index} is not a finite number, so it cannot be written as a cube value.`);
    }
    // A single space between the 12-wide fields: `%12.5E` columns that touch
    // have no separator once a mantissa is negative, and every cube reader
    // (including `parseCube`) splits the block on whitespace.
    row.push(exponential(value));
    if ((index + 1) % 6 === 0 || index === expected - 1) {
      lines.push(row.join(' '));
      row = [];
    }
  }
  return `${lines.join('\n')}\n`;
}
