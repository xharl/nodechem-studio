import { describe, expect, it } from 'vitest';
import {
  BOHR_TO_ANGSTROM,
  MAX_CUBE_VOXELS,
  parseCube,
} from '../src/shared/cubeFile.js';

/**
 * A real cube, generated here rather than checked in: 3×2×2 with values 1…12
 * in Fortran order, a negative first dimension (Å units) and two atoms. If the
 * reader ever stops putting x innermost, or converts a header that was already
 * in Å, these assertions fail.
 */
function cubeText({
  negative = true,
  dims = [3, 2, 2],
  origin = ['0.0', '0.0', '0.0'],
  atoms = [['8', '8.0', '0.0', '0.0', '0.0'], ['1', '1.0', '0.9', '0.0', '0.0']],
  values = Array.from({ length: 12 }, (_, index) => String(index + 1)),
  axes = [['1.0', '1.0', '0.0', '0.0'], ['1.0', '0.0', '1.0', '0.0'], ['1.0', '0.0', '0.0', '1.0']],
  countLine = null,
  dataLines = null,
  count = null,
} = {}) {
  const grid = axes.map(([spacing, x, y, z], axis) => (
    `  ${negative ? `-${dims[axis]}` : dims[axis]} ${spacing} ${x} ${y} ${z}`
  ));
  // Six values per line, the way cubegen writes them, so a line number in an
  // error message is worth something.
  const data = values.length
    ? [values.slice(0, 6).join(' '), values.slice(6).join(' ')].filter((line) => line.trim())
    : [];
  return [
    'water density',
    'OUTER LOOP: X, MIDDLE LOOP: Y, INNER LOOP: Z',
    countLine ?? `${count ?? atoms.length} ${origin.join(' ')}`,
    ...atoms.map((row) => row.join(' ')),
    ...grid,
    ...(dataLines ?? data),
  ].join('\n') + '\n';
}

describe('cube header', () => {
  it('reads a 3×2×2 grid with the negative-count Å convention', () => {
    const cube = parseCube(cubeText());
    expect(cube.format).toBe('cube');
    expect(cube.title).toEqual(['water density', 'OUTER LOOP: X, MIDDLE LOOP: Y, INNER LOOP: Z']);
    expect(cube.dims).toEqual([3, 2, 2]);
    expect(cube.units).toEqual({ coordinates: 'angstrom', source: 'angstrom' });
    expect(cube.origin).toEqual([0, 0, 0]);
    expect(cube.spacing).toEqual([1, 1, 1]);
    expect(cube.axes).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(cube.volumeAngstrom3).toBeCloseTo(12, 12);
    expect(cube.atoms).toEqual([
      { atomicNumber: 8, element: 'O', x: 0, y: 0, z: 0 },
      { atomicNumber: 1, element: 'H', x: 0.9, y: 0, z: 0 },
    ]);
    expect(Array.from(cube.values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('keeps the grid in Fortran order (x fastest)', () => {
    const cube = parseCube(cubeText());
    // values[i + nx(j + ny k)]: (2,1,1) is the last value, (0,0,1) is the seventh.
    expect(cube.values[2 + 3 * (1 + 2 * 1)]).toBe(12);
    expect(cube.values[0 + 3 * (0 + 2 * 1)]).toBe(7);
    expect(cube.values[2 + 3 * (1 + 2 * 0)]).toBe(6);
  });

  it('describes the extrema and their voxels', () => {
    const { stats } = parseCube(cubeText());
    expect(stats.count).toBe(12);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(12);
    expect(stats.mean).toBeCloseTo(6.5, 12);
    expect(stats.absMax).toBe(12);
    expect(stats.minVoxel).toEqual([0, 0, 0]);
    expect(stats.maxVoxel).toEqual([2, 1, 1]);
    expect(stats.maxIndex).toBe(11);
  });

  it('converts a bohr cube to Å exactly once', () => {
    // Everything is 1 bohr: origin, spacing and the atom position. After the
    // conversion each is 0.529… Å — half of 1/0.529 would be the bug.
    const cube = parseCube(cubeText({
      negative: false,
      origin: ['1.0', '0.0', '0.0'],
      atoms: [['8', '8.0', '1.0', '0.0', '0.0']],
    }));
    expect(cube.units).toEqual({ coordinates: 'angstrom', source: 'bohr' });
    expect(cube.origin[0]).toBeCloseTo(BOHR_TO_ANGSTROM, 12);
    expect(cube.spacing[0]).toBeCloseTo(BOHR_TO_ANGSTROM, 12);
    expect(cube.atoms[0].x).toBeCloseTo(BOHR_TO_ANGSTROM, 12);
    expect(cube.volumeAngstrom3).toBeCloseTo(BOHR_TO_ANGSTROM ** 3 * 12, 12);
  });

  it('does not convert a file that already declares Å', () => {
    const cube = parseCube(cubeText());
    expect(cube.atoms[1].x).toBe(0.9);
    expect(cube.spacing[0]).toBe(1);
  });

  it('warns when the three dimensions disagree about their sign', () => {
    const text = cubeText().replace('  -2 1.0 0.0 1.0 0.0', '  2 1.0 0.0 1.0 0.0');
    const cube = parseCube(text);
    expect(cube.dims).toEqual([3, 2, 2]);
    expect(cube.units.source).toBe('angstrom');
    expect(cube.warnings.join(' ')).toMatch(/disagree about their sign/);
  });

  it('keeps a ghost atom without an element and says so', () => {
    const cube = parseCube(cubeText({ atoms: [['0', '0.0', '0.0', '0.0', '0.0']] }));
    expect(cube.atoms[0]).toEqual({ atomicNumber: 0, element: null, x: 0, y: 0, z: 0 });
    expect(cube.warnings.join(' ')).toMatch(/ghost atom/);
  });
});

describe('cube refusals', () => {
  it('refuses a truncated data block', () => {
    expect(() => parseCube(cubeText({ values: ['1', '2', '3', '4', '5', '6'] })))
      .toThrow(/declares 12 values \(3×2×2\) but the file ends after 6; the cube is truncated/);
  });

  it('refuses a non-numeric grid value with its line number', () => {
    const values = ['1', '2', 'nope', ...Array.from({ length: 9 }, (_, index) => String(index + 4))];
    expect(() => parseCube(cubeText({ values }))).toThrow(/Line 9: a grid value "nope" is not a number/);
  });

  it('refuses a non-numeric header token with its line number', () => {
    expect(() => parseCube(cubeText({ countLine: '2 zero 0.0 0.0' })))
      .toThrow(/Line 3: the origin x "zero" is not a number/);
  });

  it('refuses more values than the grid holds', () => {
    const values = Array.from({ length: 13 }, (_, index) => String(index + 1));
    expect(() => parseCube(cubeText({ values }))).toThrow(/the grid holds 12 values.*continues with "13"/);
  });

  it('refuses a second dataset after the grid', () => {
    const text = cubeText().replace('11 12\n', '11 12\n13 14\n');
    expect(() => parseCube(text)).toThrow(/unexpected text after the 12 grid values/);
  });

  it('refuses a multi-value cube instead of reading the first value', () => {
    expect(() => parseCube(cubeText({ countLine: '2 0.0 0.0 0.0 2' })))
      .toThrow(/stores 2 values per grid point/);
  });

  it('refuses a file over the size bound', () => {
    expect(() => parseCube(cubeText(), { maxChars: 100 })).toThrow(/characters; the limit is 100/);
  });

  it('refuses an empty file and a file with no comment lines', () => {
    expect(() => parseCube('')).toThrow(/empty/);
    expect(() => parseCube('1 2 3')).toThrow(/too short/);
  });

  it('refuses a truncated atom block instead of shifting the grid into it', () => {
    const text = cubeText({ count: 2, atoms: [['8', '8.0', '0.0', '0.0', '0.0']] });
    // The grid row lands where the second atom should be; its negative first
    // token is caught, and the message says what that pattern means.
    expect(() => parseCube(text)).toThrow(/Line 5: atomic number -3 is outside 0–118.*atom count on line 3/);
  });

  it('accepts a density with no atoms in the header', () => {
    // Zero atoms is legal in the format (a field on a grid alone), so it must
    // parse rather than be mistaken for a truncated atom block.
    const cube = parseCube(cubeText({ atoms: [] }));
    expect(cube.atoms).toEqual([]);
    expect(cube.dims).toEqual([3, 2, 2]);
  });

  it('refuses an atomic number outside the periodic table', () => {
    expect(() => parseCube(cubeText({ atoms: [['200', '200.0', '0.0', '0.0', '0.0']] })))
      .toThrow(/atomic number 200 is outside 0–118/);
  });

  it('keeps the voxel bound at a size a desktop can hold', () => {
    expect(MAX_CUBE_VOXELS).toBe(4_000_000);
    const text = cubeText({ dims: [300, 300, 300], values: [] });
    expect(() => parseCube(text)).toThrow(new RegExp(`the limit is ${MAX_CUBE_VOXELS}`));
  });
});
