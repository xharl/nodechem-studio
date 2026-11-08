import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PADDING,
  DEFAULT_SPACING,
  MAX_GRID_POINTS,
  UnsupportedShellError,
  VolumeError,
  evaluateDensity,
  evaluateOrbital,
  fieldFromCube,
  fieldFromOrbital,
  fieldOfValues,
  gridFor,
  integrateField,
  monomialMetric,
  nearestGridPlane,
  planeThroughAtoms,
  pureComponents,
  shellsFromCheckpoint,
  sliceOfField,
} from '../src/shared/volume.js';
import { BOHR_TO_ANGSTROM, parseCube } from '../src/shared/cubeFile.js';
import { parseFchk } from '../src/shared/fchk.js';

/**
 * The angular contract, tested from the outside.
 *
 * Every check here is a number that a picture would hide: an AO that does not
 * integrate to 1 still draws, a p orbital with the wrong sign still draws, and
 * a pure d set with the wrong relative scale draws a perfectly plausible — and
 * perfectly wrong — lobe. These are the assertions that make the renderers
 * above them trustworthy.
 */

const BOHR = 1 / BOHR_TO_ANGSTROM;

const ORIGIN_ATOM = [{ element: 'H', x: 0, y: 0, z: 0 }];

/** ψ at a named Å point of a grid, by index arithmetic (no interpolation). */
function valueAt(values, grid, point) {
  const index = [0, 1, 2].map((axis) => Math.round((point[axis] - grid.origin[axis]) / grid.step));
  const [nx, ny] = grid.counts;
  return values[index[0] + nx * (index[1] + ny * index[2])];
}

describe('the grid', () => {
  it('covers the atom box plus padding, with one step on all three axes', () => {
    const atoms = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ];
    const grid = gridFor(atoms, { spacing: 0.25, padding: 2 });
    expect(grid.step).toBe(0.25);
    expect(grid.origin).toEqual([-2, -2, -2]);
    // extent 1 + 2×2 = 5 Å, so ceil(5/0.25) + 1 = 21 points per axis.
    expect(grid.counts).toEqual([21, 21, 21]);
    expect(grid.points).toBe(21 ** 3);
    expect(grid.capped).toBe(false);
    expect(grid.note).toContain('9261 points at 0.250 Å');
    // The far side of the last point is at least the padding away.
    for (let axis = 0; axis < 3; axis += 1) {
      const last = grid.origin[axis] + (grid.counts[axis] - 1) * grid.step;
      expect(last).toBeGreaterThanOrEqual(1 + 2 - 1e-9);
    }
  });

  it('defaults to 0.3 Å and 3.5 Å', () => {
    const grid = gridFor([{ x: 0, y: 0, z: 0 }]);
    expect(grid.step).toBe(DEFAULT_SPACING);
    expect(grid.origin).toEqual([-DEFAULT_PADDING, -DEFAULT_PADDING, -DEFAULT_PADDING]);
    expect(grid.note).toContain('points at 0.300 Å');
  });

  it('coarsens the grid to respect the point cap, and says what it did', () => {
    const atoms = [
      { x: -8, y: -8, z: -8 },
      { x: 8, y: 8, z: 8 },
    ];
    const grid = gridFor(atoms, { spacing: 0.2, padding: 3, maxPoints: 200_000 });
    expect(grid.points).toBeLessThanOrEqual(200_000);
    expect(grid.capped).toBe(true);
    expect(grid.spacing).toBeGreaterThan(0.2);
    expect(grid.requestedSpacing).toBe(0.2);
    expect(grid.note).toContain('coarsened from 0.200 Å');
    expect(grid.note).toContain('to stay under 200000 points');
  });

  it('refuses a spacing or padding that is not a number', () => {
    expect(() => gridFor(ORIGIN_ATOM, { spacing: 0 })).toThrow(VolumeError);
    expect(() => gridFor(ORIGIN_ATOM, { spacing: -0.3 })).toThrow(/positive number of Å/);
    expect(() => gridFor(ORIGIN_ATOM, { padding: -1 })).toThrow(/zero or more Å/);
    expect(() => gridFor([], {})).toThrow(/at least one atom/);
  });

  it('keeps the default cap at four million points', () => {
    expect(MAX_GRID_POINTS).toBe(4_000_000);
  });
});

describe('a hydrogen 1s Gaussian', () => {
  // Padding is a whole number of steps so the nucleus is a grid node: a test
  // that samples between nodes would be measuring the grid, not the function.
  const grid = gridFor(ORIGIN_ATOM, { spacing: 0.25, padding: 2.5 });
  const shells = [{ atom: 1, type: 0, primitives: [{ exponent: 1.0, s: 1 }] }];

  it('has ψ(0) = (2α/π)^(3/4) exactly, which is the normalised Gaussian value', () => {
    const values = evaluateOrbital({ shells, coefficients: [1], grid });
    // (2/π)^(3/4) = 0.712705…, NOT (1/π)^(1/2) = 0.564190: the latter is the
    // Slater 1s, a different function. A Gaussian with α = 1 is what the code
    // path evaluates, so this is the number that must come out.
    expect(valueAt(values, grid, [0, 0, 0])).toBeCloseTo((2 / Math.PI) ** 0.75, 12);
    expect(Math.abs(valueAt(values, grid, [0, 0, 0]) - (1 / Math.PI) ** 0.5)).toBeGreaterThan(0.1);
  });

  it('decays as exp(−α r²) with r in bohr, not in Å', () => {
    const values = evaluateOrbital({ shells, coefficients: [1], grid });
    const normalisation = (2 / Math.PI) ** 0.75;
    // Three steps along +x, which is 0.75 Å = 1.417 bohr.
    const exact = 3 * grid.step;
    const r = exact * BOHR;
    expect(valueAt(values, grid, [exact, 0, 0])).toBeCloseTo(normalisation * Math.exp(-r * r), 12);
    // Reading the same distance as bohr would be wrong by e^{r²−r²_angstrom},
    // a factor of 1.4 here — clearly not the answer this code gives.
    expect(normalisation * Math.exp(-(exact * exact))).not.toBeCloseTo(valueAt(values, grid, [exact, 0, 0]), 2);
  });

  it('is normalised: Σ ψ² dV = 1 with the grid\'s own bohr³ volume element', () => {
    const fine = gridFor(ORIGIN_ATOM, { spacing: 0.12, padding: 4.6 });
    const values = evaluateOrbital({ shells, coefficients: [1], grid: fine });
    const field = fieldOfValues({ grid: fine, values });
    expect(integrateField(field, { square: true })).toBeCloseTo(1, 4);
    // ∫ψ (not ψ²) is a different number and is not a normalisation: it must
    // not come out as 1 by accident, or a caller could report the wrong one.
    expect(Math.abs(integrateField(field) - 1)).toBeGreaterThan(1);
  });

  it('converts a contraction into a normalised contracted function', () => {
    const contracted = [{
      atom: 1,
      type: 0,
      primitives: [
        { exponent: 3.42525091, s: 0.15432897 },
        { exponent: 0.62391373, s: 0.53532814 },
        { exponent: 0.16885540, s: 0.44463454 },
      ],
    }];
    const fine = gridFor(ORIGIN_ATOM, { spacing: 0.1, padding: 5 });
    const values = evaluateOrbital({ shells: contracted, coefficients: [1], grid: fine });
    // STO-3G hydrogen: the three primitives are chosen so the contraction is
    // ≈ the 1s orbital, and its self-overlap is 1 on a grid that resolves it.
    expect(integrateField(fieldOfValues({ grid: fine, values }), { square: true })).toBeCloseTo(1, 3);
  });
});

describe('a p orbital', () => {
  const grid = gridFor(ORIGIN_ATOM, { spacing: 0.25, padding: 2.5 });
  const shells = [{ atom: 1, type: 1, primitives: [{ exponent: 1.5, s: 1 }] }];

  it('changes sign across the node plane', () => {
    const values = evaluateOrbital({ shells, coefficients: [1, 0, 0], grid });
    const plus = valueAt(values, grid, [0.8, 0, 0]);
    const minus = valueAt(values, grid, [-0.8, 0, 0]);
    expect(plus).toBeGreaterThan(0);
    expect(minus).toBeLessThan(0);
    expect(plus).toBeCloseTo(-minus, 10);
    // On the node the amplitude is zero, not small-but-arbitrary.
    expect(Math.abs(valueAt(values, grid, [0, 0, 0]))).toBeLessThan(1e-12);
    // The y and z components of a p_x orbital are empty.
    expect(Math.abs(valueAt(values, grid, [0, 0.8, 0]))).toBeLessThan(1e-12);
  });

  it('keeps p_y and p_z independent', () => {
    const py = evaluateOrbital({ shells, coefficients: [0, 1, 0], grid });
    const pz = evaluateOrbital({ shells, coefficients: [0, 0, 1], grid });
    expect(valueAt(py, grid, [0, 0.8, 0])).toBeGreaterThan(0);
    expect(valueAt(py, grid, [0, 0, 0.8])).toBeLessThan(1e-12);
    expect(valueAt(pz, grid, [0, 0, 0.8])).toBeGreaterThan(0);
    expect(valueAt(pz, grid, [0.8, 0, 0])).toBeLessThan(1e-12);
  });
});

/**
 * The normalisation of every shell type, checked end to end: one basis function
 * at a time, integrated on a grid. A wrong constant here is exactly the defect
 * that produces a plausible picture, so it is measured rather than trusted.
 */
describe('normalisation of every angular component', () => {
  const grid = gridFor(ORIGIN_ATOM, { spacing: 0.1, padding: 4.2 });
  const cases = [
    ['s', 0, 1],
    ['p', 1, 3],
    ['sp', -1, 4],
    ['d cartesian', 2, 6],
    ['d spherical', -2, 5],
    ['f cartesian', 3, 10],
    ['f spherical', -3, 7],
    ['g cartesian', 4, 15],
  ];

  for (const [label, type, functions] of cases) {
    it(`integrates each of the ${functions} ${label} functions to 1`, () => {
      const shell = {
        atom: 1,
        type,
        // Unit contraction coefficients in this test: it measures the angular
        // normalisation, not the contraction.
        primitives: type === -1
          ? [{ exponent: 1.7, s: 1, p: 1 }]
          : [{ exponent: 1.7, s: 1 }],
      };
      for (let component = 0; component < functions; component += 1) {
        const coefficients = new Array(functions).fill(0);
        coefficients[component] = 1;
        const values = evaluateOrbital({ shells: [shell], coefficients, grid });
        const integral = integrateField(fieldOfValues({ grid, values }), { square: true });
        expect(integral).toBeCloseTo(1, 3);
      }
    });
  }

  it('gives an sp shell one s and three p functions, not two half-shells', () => {
    const shell = { atom: 1, type: -1, primitives: [{ exponent: 1.2, s: 0.7, p: 0.3 }] };
    const s = evaluateOrbital({ shells: [shell], coefficients: [1, 0, 0, 0], grid });
    const px = evaluateOrbital({ shells: [shell], coefficients: [0, 1, 0, 0], grid });
    // The s part has a maximum at the nucleus; the p part is zero there.
    expect(valueAt(s, grid, [0, 0, 0])).toBeGreaterThan(0);
    expect(Math.abs(valueAt(px, grid, [0, 0, 0]))).toBeLessThan(1e-12);
    // The p amplitude follows the p contraction coefficient (0.3) and not the
    // s one (0.7), so it is 0.3 of what a coefficient of 1 would give.
    const pScaled = evaluateOrbital({ shells: [{ atom: 1, type: -1, primitives: [{ exponent: 1.2, s: 0.7, p: 0.3 }] }], coefficients: [0, 1, 0, 0], grid });
    const pFull = evaluateOrbital({ shells: [{ atom: 1, type: -1, primitives: [{ exponent: 1.2, s: 0.7, p: 1 }] }], coefficients: [0, 1, 0, 0], grid });
    expect(valueAt(pScaled, grid, [0.8, 0, 0]) / valueAt(pFull, grid, [0.8, 0, 0])).toBeCloseTo(0.3, 10);
  });
});

/**
 * The pure set's *shapes*, independent of its scale: the addition theorem says
 * Σ_m Y_m(direction)² is the same in every direction for a complete orthonormal
 * set of degree l. A mistyped monomial breaks it; so does a missing component.
 */
describe('the pure d and f shapes', () => {
  const valueOf = (component, [x, y, z]) => component
    .reduce((total, term) => total + term.coefficient * x ** term.i * y ** term.j * z ** term.k, 0);

  for (const [l, count] of [[2, 5], [3, 7]]) {
    it(`satisfies the addition theorem for the ${count} pure l=${l} functions`, () => {
      const components = pureComponents(l);
      expect(components).toHaveLength(count);
      let seed = 20261108;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      let low = Infinity;
      let high = -Infinity;
      for (let trial = 0; trial < 400; trial += 1) {
        const z = 2 * random() - 1;
        const phi = 2 * Math.PI * random();
        const ring = Math.sqrt(1 - z * z);
        const direction = [ring * Math.cos(phi), ring * Math.sin(phi), z];
        const total = components.reduce((sum, component) => sum + valueOf(component, direction) ** 2, 0);
        low = Math.min(low, total);
        high = Math.max(high, total);
      }
      expect(high / low).toBeCloseTo(1, 6);
    });

    it(`makes the ${count} pure l=${l} functions orthonormal in the exact metric`, () => {
      const components = pureComponents(l);
      const monomials = l === 2
        ? [[2, 0, 0], [0, 2, 0], [0, 0, 2], [1, 1, 0], [1, 0, 1], [0, 1, 1]]
        : [[3, 0, 0], [0, 3, 0], [0, 0, 3], [1, 2, 0], [2, 1, 0], [2, 0, 1], [1, 0, 2], [0, 1, 2], [0, 2, 1], [1, 1, 1]];
      const metric = monomialMetric(l);
      const vectors = components.map((component) => {
        const vector = new Array(monomials.length).fill(0);
        for (const term of component) {
          const at = monomials.findIndex(([i, j, k]) => i === term.i && j === term.j && k === term.k);
          vector[at] += term.coefficient;
        }
        return vector;
      });
      for (let a = 0; a < vectors.length; a += 1) {
        for (let b = 0; b < vectors.length; b += 1) {
          let overlap = 0;
          for (let row = 0; row < vectors[a].length; row += 1) {
            for (let column = 0; column < vectors[b].length; column += 1) {
              overlap += vectors[a][row] * metric[row][column] * vectors[b][column];
            }
          }
          expect(overlap).toBeCloseTo(a === b ? 1 : 0, 9);
        }
      }
    });
  }
});

/**
 * A water-like 10-electron density.
 *
 * The MOs are built by orthonormalising five s functions against an overlap
 * matrix computed *analytically in the test* (the standard normalised-1s
 * formula), so the integral is a check on the evaluator's normalisation and not
 * a restatement of its own metric. Two electrons per MO, five MOs, ten
 * electrons.
 */
describe('a 10-electron density', () => {
  const water = [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.757, y: 0.586, z: 0 },
    { element: 'H', x: -0.757, y: 0.586, z: 0 },
  ];

  /** ⟨a|b⟩ for normalised 1s Gaussians, in bohr. */
  function overlap(alpha, A, beta, B) {
    const distanceSquared = (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2;
    return (2 * Math.sqrt(alpha * beta) / (alpha + beta)) ** 1.5
      * Math.exp(-(alpha * beta) / (alpha + beta) * distanceSquared);
  }

  function orthonormalCoefficients(alphas, centres) {
    const count = alphas.length;
    const overlapMatrix = alphas.map((a, i) => alphas.map((b, j) => overlap(a, centres[i], b, centres[j])));
    const columns = alphas.map((_, i) => alphas.map((__, j) => (i === j ? 1 : 0)));
    for (let column = 0; column < count; column += 1) {
      for (let previous = 0; previous < column; previous += 1) {
        let dot = 0;
        for (let a = 0; a < count; a += 1) {
          for (let b = 0; b < count; b += 1) dot += columns[a][previous] * overlapMatrix[a][b] * columns[b][column];
        }
        for (let a = 0; a < count; a += 1) columns[a][column] -= dot * columns[a][previous];
      }
      let norm = 0;
      for (let a = 0; a < count; a += 1) {
        for (let b = 0; b < count; b += 1) norm += columns[a][column] * overlapMatrix[a][b] * columns[b][column];
      }
      const scale = 1 / Math.sqrt(norm);
      for (let a = 0; a < count; a += 1) columns[a][column] *= scale;
    }
    return columns[0].map((_, a) => columns.map((column) => column[a]));
  }

  const alphas = [3.0, 1.4, 0.7, 1.1, 1.1];
  const centres = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0.757 * BOHR, 0.586 * BOHR, 0], [-0.757 * BOHR, 0.586 * BOHR, 0]];
  const shells = alphas.map((alpha, index) => ({
    atom: index < 3 ? 1 : index === 3 ? 2 : 3,
    type: 0,
    primitives: [{ exponent: alpha, s: 1 }],
  }));

  it('integrates to 10 electrons within 2 %', () => {
    const grid = gridFor(water, { spacing: 0.2, padding: 4 });
    const coefficientsByMo = orthonormalCoefficients(alphas, centres);
    const values = evaluateDensity({
      shells,
      coefficientsByMo,
      occupations: [2, 2, 2, 2, 2],
      grid,
    });
    const field = fieldOfValues({ grid: { ...grid, atoms: water }, values });
    const electrons = integrateField(field);
    expect(electrons).toBeGreaterThan(9.8);
    expect(electrons).toBeLessThan(10.2);
    // Non-negative everywhere and peaked on a nucleus.
    expect(field.stats.min).toBeGreaterThanOrEqual(0);
    expect(field.stats.max).toBeGreaterThan(1);
  });

  it('loses electrons at once when the occupations are halved, which is the check that it is not a constant', () => {
    const grid = gridFor(water, { spacing: 0.4, padding: 3.5 });
    const coefficientsByMo = orthonormalCoefficients(alphas, centres);
    const values = evaluateDensity({ shells, coefficientsByMo, occupations: [1, 1, 1, 1, 1], grid });
    expect(integrateField(fieldOfValues({ grid, values }))).toBeGreaterThan(4.5);
    expect(integrateField(fieldOfValues({ grid, values }))).toBeLessThan(5.5);
  });

  it('refuses occupations that do not match the orbitals', () => {
    const grid = gridFor(water, { spacing: 0.6, padding: 2 });
    const coefficientsByMo = orthonormalCoefficients(alphas, centres);
    expect(() => evaluateDensity({ shells, coefficientsByMo, occupations: [2, 2], grid }))
      .toThrow(/one occupation per orbital/);
    expect(() => evaluateDensity({ shells, coefficientsByMo: [], occupations: [], grid }))
      .toThrow(/at least one orbital/);
  });
});

describe('refusals', () => {
  const grid = gridFor(ORIGIN_ATOM, { spacing: 0.6, padding: 1 });

  it('names an h shell instead of filling the grid with zeros', () => {
    const shells = [{ atom: 1, type: 5, primitives: [{ exponent: 1, s: 1 }] }];
    let error = null;
    try {
      evaluateOrbital({ shells, coefficients: [1], grid });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedShellError);
    expect(error.message).toBe(
      'the h shell (shell type 5) is not implemented (shell 1); '
      + 'only s, p, sp, d, f and Cartesian g shells are evaluated.',
    );
    expect(error.label).toBe('h');
    expect(error.shellType).toBe(5);
  });

  it('refuses a spherical g shell by name, and says why it is not guessed', () => {
    const shells = [{ atom: 1, type: -4, primitives: [{ exponent: 1, s: 1 }] }];
    expect(() => evaluateOrbital({ shells, coefficients: [1], grid })).toThrow(UnsupportedShellError);
    expect(() => evaluateOrbital({ shells, coefficients: [1], grid })).toThrow(
      /the spherical g shell \(shell type -4, 9 functions\) is not implemented/,
    );
  });

  it('refuses a coefficient count that does not match the basis', () => {
    const shells = [{ atom: 1, type: 1, primitives: [{ exponent: 1, s: 1 }] }];
    expect(() => evaluateOrbital({ shells, coefficients: [1, 0], grid })).toThrow(
      /has 2 coefficients but the basis has 3 functions/,
    );
  });

  it('refuses a basis whose function count disagrees with the record', () => {
    const checkpoint = {
      shellTypes: [0],
      primitivesPerShell: [1],
      shellToAtomMap: [1],
      primitiveExponents: [1],
      contractionCoefficients: [1],
      numberOfBasisFunctions: 5,
    };
    expect(() => shellsFromCheckpoint(checkpoint)).toThrow(
      /the basis describes 1 basis functions but the record states 5/,
    );
  });

  it('refuses an sp shell with no p coefficient rather than reading the s value twice', () => {
    const checkpoint = {
      shellTypes: [-1],
      primitivesPerShell: [1],
      shellToAtomMap: [1],
      primitiveExponents: [1],
      contractionCoefficients: [0.5],
    };
    expect(() => shellsFromCheckpoint(checkpoint)).toThrow(/has no p contraction coefficients/);
  });

  it('refuses a record with no basis at all, and names what it looked for', () => {
    expect(() => shellsFromCheckpoint({ numberOfAtoms: 3 })).toThrow(
      /carries neither a "shells" list nor the checkpoint arrays/,
    );
  });

  it('refuses a grid that carries no atoms', () => {
    expect(() => evaluateOrbital({
      shells: [{ atom: 1, type: 0, primitives: [{ exponent: 1, s: 1 }] }],
      coefficients: [1],
      grid: { origin: [-1, -1, -1], counts: [3, 3, 3], step: 0.5 },
    })).toThrow(/does not carry atoms/);
  });
});

describe('shell lists from a checkpoint', () => {
  it('reads the flat arrays into shells and keeps the s/p split', () => {
    const checkpoint = {
      shellTypes: [-1, 0, -2],
      primitivesPerShell: [2, 1, 1],
      shellToAtomMap: [1, 2, 1],
      primitiveExponents: [10, 1, 4, 1.2],
      contractionCoefficients: [0.3, 0.6, 0.7, 1],
      spContractionCoefficients: [0.2, 0.5, 0, 0],
      numberOfBasisFunctions: 4 + 1 + 5,
    };
    const parsed = shellsFromCheckpoint(checkpoint);
    expect(parsed.numberOfBasisFunctions).toBe(10);
    expect(parsed.shells[0].primitives).toEqual([
      { exponent: 10, s: 0.3, p: 0.2 },
      { exponent: 1, s: 0.6, p: 0.5 },
    ]);
    expect(parsed.shells[1].type).toBe(0);
    expect(parsed.shells[2].type).toBe(-2);
    expect(parsed.spherical.d).toBe(true);
    expect(parsed.spherical.f).toBe(false);
  });

  it('takes the pure/Cartesian flags as a fallback for a positive shell type', () => {
    const checkpoint = {
      shellTypes: [2],
      primitivesPerShell: [1],
      shellToAtomMap: [1],
      primitiveExponents: [1],
      contractionCoefficients: [1],
      pureDShells: 1,
    };
    expect(shellsFromCheckpoint(checkpoint).shells[0].type).toBe(-2);
    // The signed type wins when the file carries both: a per-shell type cannot
    // be overridden by one file-wide flag without guessing which was meant.
    const signed = shellsFromCheckpoint({ ...checkpoint, shellTypes: [-2] });
    expect(signed.shells[0].type).toBe(-2);
  });

  it('evaluates a real formatted checkpoint through the same path', () => {
    const fchk = parseFchk([
      'water 6-31G(d)',
      'Number of atoms                            I                1',
      'Number of basis functions                 I                6',
      'Number of electrons                        I               10',
      'Atomic numbers                             I   N=           1',
      '           8',
      'Current cartesian coordinates              R   N=           3',
      '  0.00000000E+00  0.00000000E+00  0.00000000E+00',
      'Shell types                                I   N=           1',
      '           2',
      'Number of primitives per shell             I   N=           1',
      '           1',
      'Shell to atom map                          I   N=           1',
      '           1',
      'Primitive exponents                        R   N=           1',
      '  1.00000000E+00',
      'Contraction coefficients                   R   N=           1',
      '  1.00000000E+00',
      'Alpha MO coefficients                      R   N=           6',
      '  1.0 0.0 0.0 0.0 0.0 0.0',
    ].join('\n'));
    expect(fchk.shellTypes).toEqual([2]);
    const parsed = shellsFromCheckpoint(fchk);
    // Cartesian d: six functions, so no shell-type/spherical disagreement.
    expect(parsed.numberOfBasisFunctions).toBe(6);
    const grid = gridFor([{ x: 0, y: 0, z: 0 }], { spacing: 0.5, padding: 2 });
    const values = evaluateOrbital({
      shells: parsed.shells,
      coefficients: fchk.alphaMOCoefficients.slice(0, 6),
      grid,
      atoms: [{ x: 0, y: 0, z: 0 }],
    });
    expect(values).toHaveLength(grid.points);
    expect(values.some((value) => value !== 0)).toBe(true);
  });
});

describe('fields', () => {
  it('carries the geometry and the statistics a renderer needs', () => {
    const grid = gridFor(ORIGIN_ATOM, { spacing: 0.5, padding: 1.5 });
    const field = fieldFromOrbital({
      shells: [{ atom: 1, type: 0, primitives: [{ exponent: 1, s: 1 }] }],
      coefficients: [1],
      grid,
      label: 'MO 1',
    });
    expect(field.kind).toBe('orbital');
    expect(field.label).toBe('MO 1');
    expect(field.signed).toBe(true);
    expect(field.dims).toEqual(grid.counts);
    expect(field.origin).toEqual(grid.origin);
    expect(field.values.length).toBe(grid.points);
    expect(field.stats.max).toBeCloseTo((2 / Math.PI) ** 0.75, 12);
    expect(field.cellVolumeBohr3).toBeCloseTo(grid.cellVolumeBohr3, 12);
    expect(field.units.values).toBe('a.u.');
  });

  it('rejects a value array that does not fill the grid', () => {
    const grid = gridFor(ORIGIN_ATOM, { spacing: 1, padding: 1 });
    expect(() => fieldOfValues({ grid, values: new Float64Array(4) })).toThrow(/holds 4 values/);
  });

  it('takes a parsed cube as the same contract', () => {
    const cube = parseCube([
      'density',
      'test',
      '1 0.0 0.0 0.0',
      '8 0.0 0.0 0.0 0.0',
      '  3 0.5 1.0 0.0 0.0',
      '  3 0.5 0.0 1.0 0.0',
      '  3 0.5 0.0 0.0 1.0',
      '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27',
    ].join('\n'));
    const field = fieldFromCube(cube, { label: 'from disk' });
    expect(field.kind).toBe('cube');
    expect(field.label).toBe('from disk');
    expect(field.dims).toEqual([3, 3, 3]);
    expect(field.signed).toBe(false);
    // The cube header is in bohr, so a 0.5 bohr step is 0.2646 Å a side.
    expect(field.cellVolumeAngstrom3).toBeCloseTo((0.5 * BOHR_TO_ANGSTROM) ** 3, 12);
    expect(field.cellVolumeBohr3).toBeCloseTo(0.125, 12);
    expect(field.stats.max).toBe(27);
  });
});

describe('slices and planes', () => {
  const grid = gridFor([{ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }], { spacing: 0.5, padding: 1 });
  const values = Float64Array.from({ length: grid.points }, (_, index) => index);
  const field = fieldOfValues({ grid, values });

  it('cuts a plane with the axes named, x fastest inside a row', () => {
    const slice = sliceOfField(field, { plane: 'xy', offset: 0.5 });
    expect(slice.width).toBe(grid.counts[0]);
    expect(slice.height).toBe(grid.counts[1]);
    expect(slice.axes).toEqual([[0.5, 0, 0], [0, 0.5, 0]]);
    expect(slice.normal).toEqual([0, 0, 0.5]);
    expect(slice.values[0]).toBe(values[grid.counts[0] * grid.counts[1] * slice.index]);
    // One row on: still on the same plane, one y step further.
    expect(slice.values[grid.counts[0]]).toBe(
      values[grid.counts[0] * (grid.counts[1] * slice.index + 1)],
    );
  });

  it('clamps the offset and refuses an unknown plane', () => {
    expect(sliceOfField(field, { plane: 'xy', offset: -3 }).index).toBe(0);
    expect(sliceOfField(field, { plane: 'xy', offset: 3 }).index).toBe(grid.counts[2] - 1);
    expect(() => sliceOfField(field, { plane: 'qq' })).toThrow(/unknown slice plane/);
  });

  it('finds the plane through three atoms and the nearest grid plane to it', () => {
    const atoms = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];
    const plane = planeThroughAtoms(atoms, [0, 1, 2]);
    expect(Math.abs(plane.normal[2])).toBeCloseTo(1, 12);
    const nearest = nearestGridPlane(field, plane);
    expect(nearest.plane).toBe('xy');
    expect(nearest.separationAngstrom).toBeLessThan(0.25);
  });

  it('refuses three collinear atoms', () => {
    const atoms = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];
    expect(() => planeThroughAtoms(atoms, [0, 1, 2])).toThrow(
      /atoms 1, 2 and 3 are collinear/,
    );
  });
});
