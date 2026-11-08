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
 * - `NVAL > 1`, i.e. a cube that stores several values per grid point.
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
 * @param {string} text
 * @param {{ maxChars?: number }} [options] `maxChars` exists so the bound can be
 *   tested without building a 64 MB string; callers should not pass it.
 * @returns {object} cube in Å, values in file order (Fortran: x fastest)
 */
export function parseCube(text, { maxChars = MAX_CUBE_CHARS } = {}) {
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

  const atoms = [];
  let ghostAtoms = 0;
  for (let index = 0; index < atomCount; index += 1) {
    const lineIndex = 3 + index;
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
    const lineIndex = 3 + atomCount + axis;
    const line = requireLine(lines, lineIndex, 'the grid axis block (3 rows expected)');
    const parts = tokensOf(line);
    const lineNumber = lineIndex + 1;
    if (parts.length < 4) {
      throw new CubeFormatError(`Line ${lineNumber}: a grid row needs "count spacing vx vy vz", found ${parts.length} token${parts.length === 1 ? '' : 's'}.`);
    }
    const stated = integerToken(parts[0], lineNumber, `the ${'xyz'[axis]} grid count`);
    if (stated === 0) {
      throw new CubeFormatError(`Line ${lineNumber}: the ${'xyz'[axis]} grid count is 0.`);
    }
    dims.push(Math.abs(stated));
    signs.push(stated < 0 ? -1 : 1);
    const spacing = numberToken(parts[1], lineNumber, `the ${'xyz'[axis]} grid spacing`);
    spacingRaw.push(spacing);
    axesRaw.push([
      spacing * numberToken(parts[2], lineNumber, `the ${'xyz'[axis]} axis x component`),
      spacing * numberToken(parts[3], lineNumber, `the ${'xyz'[axis]} axis y component`),
      spacing * numberToken(parts[4], lineNumber, `the ${'xyz'[axis]} axis z component`),
    ]);
  }

  const warnings = [];
  if (ghostAtoms > 0) {
    warnings.push(`${ghostAtoms} ghost atom${ghostAtoms === 1 ? '' : 's'} (nuclear charge 0) kept without an element symbol; they still occupy their grid position.`);
  }

  // The sign of the first dimension sets the units, per the format. Writers
  // that set only the first one negative are read the same way; a disagreement
  // is reported instead of being resolved silently.
  const nativeBohr = signs[0] > 0;
  if (!signs.every((sign) => sign === signs[0])) {
    warnings.push('The three grid dimensions disagree about their sign; the first one decides the units (negative means Å), as the format specifies.');
  }

  const expected = dims[0] * dims[1] * dims[2];
  if (expected > MAX_CUBE_VOXELS) {
    throw new CubeFormatError(`The grid is ${dims.join('×')} = ${expected} points; the limit is ${MAX_CUBE_VOXELS}.`);
  }

  const values = new Float64Array(expected);
  let filled = 0;
  // Last line that contributed values, so trailing text can be checked after
  // the value that completed the grid rather than at the top of the block.
  let lastDataLine = 3 + atomCount + 2;
  for (let lineIndex = 3 + atomCount + 3; lineIndex < lines.length && filled < expected; lineIndex += 1) {
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
    values,
    stats: summarise(values, dims),
    units: {
      coordinates: 'angstrom',
      source: nativeBohr ? 'bohr' : 'angstrom',
    },
    volumeAngstrom3: voxelVolumeAngstrom3 * expected,
    voxelVolumeAngstrom3,
    warnings,
  };
}
