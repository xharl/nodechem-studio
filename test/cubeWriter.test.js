import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOHR_TO_ANGSTROM,
  CubeFormatError,
  parseCube,
  writeCube,
} from '../src/shared/cubeFile.js';
import { parseFchk } from '../src/shared/fchk.js';
import { evaluateOrbital, fieldFromCube, fieldOfValues } from '../src/shared/volume.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

/** A 3×2×2 field in Fortran order, the shape `fieldOfValues` produces. */
function smallField(overrides = {}) {
  const values = Float64Array.from({ length: 12 }, (_, index) => Math.sin(index + 1) * 1e-3);
  return {
    dims: [3, 2, 2],
    origin: [-1.5, 0.25, 2],
    axes: [[0.2, 0, 0], [0, 0.2, 0], [0, 0, 0.2]],
    values,
    atoms: [
      { atomicNumber: 8, x: 0, y: 0, z: 0 },
      { element: 'H', x: 0.9, y: 0, z: 0.1 },
    ],
    ...overrides,
  };
}

const tokensOf = (line) => line.trim().split(/\s+/).filter(Boolean);

describe('writeCube — the standard Gaussian/Molden layout', () => {
  it('writes two comment lines, three four-number grid rows, then the atoms', () => {
    const text = writeCube(smallField(), { title: 'a test field', comment: 'second line' });
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('a test field');
    expect(lines[1]).toBe('second line');
    // natoms + origin, in Å.
    expect(tokensOf(lines[2])).toEqual(['2', '-1.500000', '0.250000', '2.000000']);
    // The three grid rows come first, each the count and the step vector itself:
    // four numbers, not five (#153). A negative count is what makes the
    // distances Å.
    expect(tokensOf(lines[3])).toEqual(['-3', '0.200000', '0.000000', '0.000000']);
    expect(tokensOf(lines[4])).toEqual(['-2', '0.000000', '0.200000', '0.000000']);
    expect(tokensOf(lines[5])).toEqual(['-2', '0.000000', '0.000000', '0.200000']);
    // One row per atom, after the grid: atomicNumber, nuclear charge (= Z), x, y, z.
    expect(tokensOf(lines[6])).toEqual(['8', '8.000000', '0.000000', '0.000000', '0.000000']);
    expect(tokensOf(lines[7])).toEqual(['1', '1.000000', '0.900000', '0.000000', '0.100000']);
  });

  it('writes the values in Fortran order, six per line, twelve columns each', () => {
    const field = smallField();
    const lines = writeCube(field).trimEnd().split('\n');
    const data = lines.slice(8);
    expect(data).toHaveLength(2);
    expect(data.map((line) => tokensOf(line).length)).toEqual([6, 6]);
    for (const line of data) {
      expect(line).toHaveLength(6 * 12 + 5);
      for (const token of tokensOf(line)) expect(token).toMatch(/^-?\d\.\d{5}E[+-]\d{2}$/);
    }
    // The first value is the first voxel: x varies fastest.
    expect(Number(tokensOf(data[0])[0])).toBeCloseTo(field.values[0], 9);
    expect(Number(tokensOf(data[0])[4])).toBeCloseTo(field.values[4], 9);
  });

  it('round-trips dims, origin, axes and every value through parseCube', () => {
    const field = smallField();
    const cube = parseCube(writeCube(field));
    expect(cube.dims).toEqual(field.dims);
    expect(cube.origin).toEqual(field.origin);
    expect(cube.axes).toEqual(field.axes);
    expect(cube.atoms.map((atom) => atom.atomicNumber)).toEqual([8, 1]);
    expect(cube.units).toEqual({ coordinates: 'angstrom', source: 'angstrom' });
    expect(cube.layout).toBe('standard');
    expect(cube.valuesOrder).toBe('fortran');
    expect(cube.warnings).toEqual([]);
    for (let index = 0; index < field.values.length; index += 1) {
      expect(cube.values[index]).toBeCloseTo(field.values[index], 8);
    }
    // The file carries six significant digits; `%12.5E` is the reason, and it
    // is under the 1e-5 relative the round trip promises.
    const relative = Math.abs(cube.values[5] - field.values[5]) / Math.abs(field.values[5]);
    expect(relative).toBeLessThan(1e-5);
  });

  it('round-trips a field that has a scalar step instead of axes', () => {
    const { axes, ...rest } = smallField();
    const cube = parseCube(writeCube({ ...rest, step: 0.2 }));
    expect(cube.axes).toEqual(axes);
    expect(cube.spacing).toEqual([0.2, 0.2, 0.2]);
  });

  it('writes bohr with positive counts and converts every distance once', () => {
    const field = smallField();
    const cube = parseCube(writeCube(field, { units: 'bohr' }));
    expect(cube.units.source).toBe('bohr');
    // Written in bohr and read back to Å: the same numbers the field held.
    expect(cube.origin[0]).toBeCloseTo(-1.5, 6);
    expect(cube.axes[0][0]).toBeCloseTo(0.2, 6);
    expect(cube.atoms[1].x).toBeCloseTo(0.9, 6);
    expect(cube.spacing[0]).toBeCloseTo(0.2, 6);
    expect(cube.dims).toEqual([3, 2, 2]);
    expect(writeCube(field, { units: 'bohr' }).split('\n')[3].trim().startsWith('3')).toBe(true);
  });

  it('takes the atoms from the field when the option names none', () => {
    const cube = parseCube(writeCube(smallField()));
    expect(cube.atoms).toHaveLength(2);
    expect(cube.atoms[1]).toMatchObject({ atomicNumber: 1, element: 'H', x: 0.9, z: 0.1 });
  });

  it('accepts a field with no atoms, because a grid alone is legal', () => {
    const cube = parseCube(writeCube(smallField({ atoms: [] })));
    expect(cube.atoms).toEqual([]);
    expect(cube.dims).toEqual([3, 2, 2]);
  });

  it('keeps a two-line comment out and replaces a newline in a title', () => {
    const text = writeCube(smallField(), { title: 'line one\nline two' });
    expect(text.split('\n')[0]).toBe('line one line two');
    expect(parseCube(text).title[0]).toBe('line one line two');
  });

  it('refuses a value count that does not match the grid, a non-finite value and a bad atom', () => {
    expect(() => writeCube(smallField({ values: Float64Array.from([1, 2, 3]) })))
      .toThrow(/holds 3 values for a 3×2×2 grid \(12\)/);
    const nan = Float64Array.from({ length: 12 }, (_, index) => index);
    nan[7] = Number.NaN;
    expect(() => writeCube(smallField({ values: nan }))).toThrow(/value 7 is not a finite number/);
    expect(() => writeCube(smallField({ atoms: [{ x: 0, y: 0, z: 0 }] })))
      .toThrow(/neither an atomic number nor an element symbol/);
    expect(() => writeCube(smallField({ atoms: [{ element: 'Xx', x: 0, y: 0, z: 0 }] })))
      .toThrow(CubeFormatError);
  });

  it('refuses a grid it cannot describe and units it does not know', () => {
    const { axes, ...noAxes } = smallField();
    expect(() => writeCube(noAxes)).toThrow(/neither axes nor a positive step/);
    expect(() => writeCube(smallField({ axes: [[0, 0, 0], [0, 1, 0], [0, 0, 1]] })))
      .toThrow(/grid axis x has zero length/);
    expect(() => writeCube(smallField({ origin: [0, 0] }))).toThrow(/three-number origin/);
    expect(() => writeCube(smallField(), { units: 'furlongs' })).toThrow(/unknown units "furlongs"/);
  });
});

/**
 * Two small cubes written here rather than checked in — test inputs, not
 * calculations. The first is the standard layout (`cubegen`, Psi4): grid rows
 * of four numbers, atoms after them. The second is the legacy atom-first
 * dialect this reader used to assume, kept so the compatibility path stays
 * covered.
 */
const STANDARD_SHAPED = [
  'synthetic standard-layout cube',
  'not a calculation',
  '     2  -1.0  -1.0  -1.0',
  '     2   0.100000   0.000000   0.000000',
  '     3   0.000000   0.100000   0.000000',
  '     2   0.000000   0.000000   0.100000',
  '  8   0.000000   0.000000   0.000000   0.000000',
  '  1   0.000000   0.700000   0.000000   0.400000',
  '  1.0  2.0  3.0  4.0  5.0  6.0',
  '  7.0  8.0  9.0  10.0  11.0  12.0',
  '',
].join('\n');

const PSI4_SHAPED = STANDARD_SHAPED.replace(
  'synthetic standard-layout cube',
  'Psi4 Gaussian Cube File.',
);

const LEGACY_SHAPED = [
  'synthetic legacy-layout cube',
  'not a calculation',
  '     2  -1.0  -1.0  -1.0',
  '  8   8.000000   0.000000   0.000000   0.000000',
  '  1   1.000000   0.700000   0.000000   0.400000',
  '     2   0.100000   1.000000   0.000000   0.000000',
  '     3   0.100000   0.000000   1.000000   0.000000',
  '     2   0.100000   0.000000   0.000000   1.000000',
  '  1.0  2.0  3.0  4.0  5.0  6.0',
  '  7.0  8.0  9.0  10.0  11.0  12.0',
  '',
].join('\n');

describe('parseCube — the standard layout (#153)', () => {
  it('reads the grid rows before the atom block and keeps the step the file states', () => {
    const cube = parseCube(STANDARD_SHAPED);
    expect(cube.dims).toEqual([2, 3, 2]);
    expect(cube.layout).toBe('standard');
    expect(cube.valuesOrder).toBe('fortran');
    expect(cube.units.source).toBe('bohr');
    expect(cube.atoms.map((atom) => atom.atomicNumber)).toEqual([8, 1]);
    // #155: the grid row states the step itself; applying its first number as a
    // spacing on top would square it. 0.1 bohr must read 0.0529 Å.
    expect(cube.spacing).toEqual([0.1 * BOHR_TO_ANGSTROM, 0.1 * BOHR_TO_ANGSTROM, 0.1 * BOHR_TO_ANGSTROM]);
    expect(cube.axes[0]).toEqual([0.1 * BOHR_TO_ANGSTROM, 0, 0]);
    // A standard layout opens without a warning.
    expect(cube.warnings).toEqual([]);
    expect(Array.from(cube.values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('reorders the values of a cube whose first line declares Psi4, and nothing else', () => {
    const cube = parseCube(PSI4_SHAPED);
    expect(cube.valuesOrder).toBe('c-order');
    // Psi4 writes z fastest: (i,j,k) = (1,0,0) is the 7th value in the file,
    // (0,0,1) the 2nd, and the last voxel the 12th.
    const at = (i, j, k) => cube.values[i + 2 * (j + 3 * k)];
    expect(at(0, 0, 0)).toBe(1);
    expect(at(0, 0, 1)).toBe(2);
    expect(at(1, 0, 0)).toBe(7);
    expect(at(0, 1, 0)).toBe(3);
    expect(at(1, 2, 1)).toBe(12);
    // An edited title is not a declaration: the order can be forced.
    expect(Array.from(parseCube(PSI4_SHAPED, { valuesOrder: 'fortran' }).values).slice(0, 3)).toEqual([1, 2, 3]);
    expect(() => parseCube(PSI4_SHAPED, { valuesOrder: 'row-major' })).toThrow(/unknown values order/);
  });

  it('still refuses a standard-layout file whose data block is short', () => {
    const truncated = STANDARD_SHAPED.replace('  7.0  8.0  9.0  10.0  11.0  12.0\n', '');
    expect(() => parseCube(truncated)).toThrow(/grid declares 12 values \(2×3×2\).*truncated/i);
  });

  it('still reads the legacy atom-first, five-number grid row, and says it did', () => {
    const cube = parseCube(LEGACY_SHAPED);
    expect(cube.layout).toBe('legacy');
    expect(cube.dims).toEqual([2, 3, 2]);
    expect(cube.spacing[0]).toBeCloseTo(0.1 * BOHR_TO_ANGSTROM, 12);
    expect(cube.atoms.map((atom) => atom.atomicNumber)).toEqual([8, 1]);
    expect(cube.warnings.join(' ')).toMatch(/atom block before the grid rows/);
  });
});

/**
 * #155, pinned: a cube with a 0.2 bohr step must report 0.1058 Å, and the field
 * built from it must carry the same number. This is the number the Wavefunction
 * view printed as 0.021 Å before the fix.
 */
describe('parseCube / fieldFromCube — the spacing is the file\'s own (#155)', () => {
  it('reads a 0.2 bohr step as 0.1058 Å in both the cube and the field', () => {
    const text = [
      'a cube with a known step',
      'not a calculation',
      '     1   0.0  0.0  0.0',
      '     2   0.200000   0.000000   0.000000',
      '     2   0.000000   0.200000   0.000000',
      '     2   0.000000   0.000000   0.200000',
      '  8   0.000000   0.000000   0.000000   0.000000',
      '  1.0  1.0  1.0  1.0  1.0  1.0',
      '  1.0  1.0',
      '',
    ].join('\n');
    const cube = parseCube(text);
    expect(cube.spacing[0]).toBeCloseTo(0.1058354421806, 10);
    const field = fieldFromCube(cube);
    expect(field.step).toBeCloseTo(0.1058354421806, 10);
    expect(field.cellVolumeAngstrom3).toBeCloseTo(0.1058354421806 ** 3, 12);
  });
});

describe('the fixture cube is a stock Psi4 file, unmodified', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'psi4', 'Psi_a_5_5-A.cube'), 'utf8');

  it('parses with the standard layout and the Psi4 value order', () => {
    const cube = parseCube(text);
    expect(cube.layout).toBe('standard');
    expect(cube.valuesOrder).toBe('c-order');
    expect(cube.title[0]).toBe('Psi4 Gaussian Cube File.');
    expect(cube.warnings).toEqual([]);
    // 0.2 bohr, the step Psi4 wrote.
    expect(cube.spacing[0]).toBeCloseTo(0.2 * BOHR_TO_ANGSTROM, 12);
  });

  it('puts the largest |ψ| on the oxygen atom only in the Psi4 value order', () => {
    // A physical check on the ordering, independent of the evaluator: the HOMO
    // is a 2p on oxygen, so its largest voxel must sit on the nucleus. Measured:
    // 0.22 Å in Psi4's order, 2.07 Å if the same file is read x-fastest.
    const peakDistance = (valuesOrder) => {
      const cube = parseCube(text, { valuesOrder });
      const [nx, ny] = cube.dims;
      let index = 0;
      for (let at = 0; at < cube.values.length; at += 1) {
        if (Math.abs(cube.values[at]) > Math.abs(cube.values[index])) index = at;
      }
      const i = index % nx;
      const j = Math.floor(index / nx) % ny;
      const k = Math.floor(index / (nx * ny));
      const point = [
        cube.origin[0] + i * cube.spacing[0],
        cube.origin[1] + j * cube.spacing[1],
        cube.origin[2] + k * cube.spacing[2],
      ];
      const oxygen = cube.atoms[0];
      return Math.hypot(point[0] - oxygen.x, point[1] - oxygen.y, point[2] - oxygen.z);
    };
    expect(peakDistance('c-order')).toBeLessThan(0.5);
    expect(peakDistance('fortran')).toBeGreaterThan(1.5);
  });
});

/**
 * The independent oracle, committed as a test.
 *
 * `test/fixtures/psi4/` holds a water B3LYP/6-31G* SCF (Psi4 1.11) and the cube
 * `psi4.cubeprop` wrote for its HOMO. The comparison below evaluates the same
 * MO from the same formatted checkpoint with this repository's own basis code,
 * on the grid the Psi4 cube declares, and reports the largest disagreement.
 *
 * The number is measured, not chosen: the fixture's six-digit values alone leave
 * a few 1e-7 of rounding, and the remaining difference is the two independent
 * implementations of the same Gaussian basis.
 */
describe('Psi4 1.11 cross-check — water B3LYP/6-31G*, HOMO', () => {
  const directory = path.join(FIXTURES, 'psi4');
  const fchk = parseFchk(fs.readFileSync(path.join(directory, 'water-b3lyp-631gd.fchk'), 'utf8'));
  const psi4Cube = parseCube(fs.readFileSync(path.join(directory, 'Psi_a_5_5-A.cube'), 'utf8'));

  it('is the fixture the README describes: 18 functions, 5 alpha electrons, 10 electrons', () => {
    expect(fchk.numberOfBasisFunctions).toBe(18);
    expect(fchk.numberOfAlphaElectrons).toBe(5);
    expect(fchk.numberOfElectrons).toBe(10);
    expect(fchk.atoms).toHaveLength(3);
    expect(psi4Cube.dims).toEqual([56, 41, 47]);
    expect(psi4Cube.layout).toBe('standard');
    expect(psi4Cube.valuesOrder).toBe('c-order');
  });

  it('evaluates the HOMO to a measured max |Δψ| = 8.5e-7 a.u. of the Psi4 cube', () => {
    const functions = fchk.numberOfBasisFunctions;
    const homo = fchk.numberOfAlphaElectrons - 1; // 0-based index of MO 5
    const coefficients = fchk.alphaMOCoefficients.slice(homo * functions, (homo + 1) * functions);

    // The same grid the cube states: origin, counts and spacing, in Å.
    const grid = {
      counts: psi4Cube.dims,
      origin: psi4Cube.origin,
      step: psi4Cube.spacing[0],
      atoms: fchk.atoms,
    };
    const ours = evaluateOrbital({ shells: fchk, coefficients, grid, precision: 'f64' });

    // MO phase is arbitrary: pick the sign that makes the two agree, and check
    // that this really is the same orbital (|cos| = 1) rather than a coincidence.
    let dot = 0;
    let norm = 0;
    for (let index = 0; index < ours.length; index += 1) {
      dot += ours[index] * psi4Cube.values[index];
      norm += ours[index] * ours[index];
    }
    const sign = dot < 0 ? -1 : 1;
    expect(Math.abs(dot / norm)).toBeGreaterThan(0.9999);

    let max = 0;
    for (let index = 0; index < ours.length; index += 1) {
      max = Math.max(max, Math.abs(sign * ours[index] - psi4Cube.values[index]));
    }
    // Measured against Psi4 1.11 on 2026-11-08: 8.4969e-7 a.u. The bound is the
    // plan's 1e-3; the measured value is reported in the test name above.
    expect(max).toBeLessThan(1e-3);
    expect(max).toBeLessThan(1e-5);
  });

  it('agrees with Psi4 about the field it wrote, value for value', () => {
    const field = fieldOfValues({
      kind: 'orbital',
      label: 'psi4 fixture',
      grid: {
        counts: psi4Cube.dims,
        origin: psi4Cube.origin,
        axes: psi4Cube.axes,
        step: psi4Cube.spacing[0],
        cellVolumeAngstrom3: psi4Cube.voxelVolumeAngstrom3,
        cellVolumeBohr3: psi4Cube.voxelVolumeAngstrom3 / BOHR_TO_ANGSTROM ** 3,
      },
      values: psi4Cube.values,
      signed: true,
    });
    // |ψ|² over the box Psi4 chose (11.2 × 8.2 × 9.4 bohr) is short of 1 by the
    // tail outside it — the same statement `ncs cube` prints.
    let total = 0;
    for (const value of field.values) total += value * value;
    const integral = total * field.cellVolumeBohr3;
    expect(integral).toBeGreaterThan(0.99);
    expect(integral).toBeLessThan(1);
  });
});
