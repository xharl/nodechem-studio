import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFchk } from '../src/shared/fchk.js';
import { parseCube } from '../src/shared/cubeFile.js';
import { fieldFromCube } from '../src/shared/volume.js';
import { extractSurface } from '../src/shared/marchingCubes.js';
import {
  BOHR_PER_ANGSTROM,
  boysFunctions,
  densityMatrix,
  electronDensityAt,
  espCardRows,
  espForSurface,
  electrostaticPotential,
  potentialOnGrid,
  potentialRange,
} from '../src/shared/esp.js';
import { espSurfaceFigure } from '../src/shared/figures/surface.js';
import { figure } from '../src/shared/figures/index.js';

const FIXTURES = new URL('./fixtures/esp/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

const WATER_FCHK = read('water-esp.fchk');
const ESP_CUBE = read('ESP.cube');
const DENSITY_CUBE = read('Dt.cube');
const ORBITAL_CUBE = read('Psi_a_5_5-A.cube');
const HE_FCHK = read('he-sto3g.fchk');
const HE_ESP_CUBE = read('he-ESP.cube');

/** Every grid point of a parsed cube, in Å, in the cube's own x-fastest order. */
function gridPoints(cube) {
  const [nx, ny, nz] = cube.dims;
  const points = new Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        points[i + nx * (j + ny * k)] = [
          cube.origin[0] + cube.axes[0][0] * i,
          cube.origin[1] + cube.axes[1][1] * j,
          cube.origin[2] + cube.axes[2][2] * k,
        ];
      }
    }
  }
  return points;
}

/** Distance from a point to the nearest atom, Å. */
function nearestAtom(point, atoms) {
  let best = Infinity;
  for (const atom of atoms) {
    best = Math.min(best, Math.hypot(point[0] - atom.x, point[1] - atom.y, point[2] - atom.z));
  }
  return best;
}

/**
 * The exact potential of a spherically symmetric density, by 1-D radial
 * quadrature — an independent reference: no Boys function, no erf, no basis
 * algebra, just
 *
 *     V(r) = Z/r − 4π[ (1/r)∫₀ʳ ρ(s)s²ds + ∫ᵣ^∞ ρ(s)s ds ].
 *
 * `terms` is `[{ weight, alpha }]` with ρ(s) = Σ weight·e^(−alpha·s²), which is
 * exactly what a sum of s-type primitive pairs is.
 */
function radialPotential(terms, nuclearCharge, radius) {
  const density = (s) => terms.reduce((sum, term) => sum + term.weight * Math.exp(-term.alpha * s * s), 0);
  const integrand = (s, power) => density(s) * s ** power;
  const simpson = (from, to, steps, power) => {
    const h = (to - from) / steps;
    let total = integrand(from, power) + integrand(to, power);
    for (let i = 1; i < steps; i += 1) total += (i % 2 ? 4 : 2) * integrand(from + i * h, power);
    return (h / 3) * total;
  };
  const inner = simpson(0, radius, 4000, 2);
  const outer = simpson(radius, radius + 25, 4000, 1);
  const electron = 4 * Math.PI * (inner / radius + outer);
  return nuclearCharge / radius - electron;
}

/** The same reference for a one-function s-only checkpoint. */
function atomicTerms(fchk) {
  const exponents = fchk.primitiveExponents;
  const coefficients = fchk.contractionCoefficients;
  const density = fchk.totalScfDensity[0];
  const weight = (alpha, coefficient) => coefficient * (2 * alpha / Math.PI) ** 0.75;
  const terms = [];
  for (let a = 0; a < exponents.length; a += 1) {
    for (let b = 0; b < exponents.length; b += 1) {
      terms.push({
        alpha: exponents[a] + exponents[b],
        weight: density * weight(exponents[a], coefficients[a]) * weight(exponents[b], coefficients[b]),
      });
    }
  }
  return terms;
}

describe('fchk density matrix (issue 164)', () => {
  it('reads the triangular block as a typed array with the lowest triangle first', () => {
    const fchk = parseFchk(WATER_FCHK);
    expect(fchk.numberOfBasisFunctions).toBe(18);
    expect(fchk.totalScfDensity).toBeInstanceOf(Float64Array);
    expect(fchk.totalScfDensity).toHaveLength((18 * 19) / 2);
    const matrix = densityMatrix(fchk);
    expect(matrix.ok).toBe(true);
    expect(matrix.source).toBe('Total SCF Density');
    // D(1,1) is the oxygen 1s diagonal element, 2.08356133 in the file.
    expect(matrix.values[0]).toBeCloseTo(2.08356133, 8);
    // D(i,j) is stored once and read symmetrically.
    expect(matrix.element(3, 7)).toBe(matrix.element(7, 3));
    expect(matrix.element(3, 7)).toBe(matrix.values[(7 * 8) / 2 + 3]);
  });

  it('reproduces Psi4\'s own density cube from the matrix, which pins the triangle order', () => {
    const fchk = parseFchk(WATER_FCHK);
    const cube = parseCube(DENSITY_CUBE);
    const points = gridPoints(cube);
    const density = electronDensityAt({ fchk, points });
    expect(density.ok).toBe(true);
    let worst = 0;
    for (let index = 0; index < points.length; index += 1) {
      worst = Math.max(worst, Math.abs(density.values[index] - cube.values[index]));
    }
    // The cube writes six significant digits, so 148 e/bohr³ arrives as ±5e-3;
    // anything at that level is the file's precision, not the reader's.
    expect(worst).toBeLessThan(1e-2);
  });

  it('refuses a density block that is shorter than the basis requires, by name', () => {
    const fchk = parseFchk(WATER_FCHK);
    const shortened = fchk ? WATER_FCHK.replace(/^(Total SCF Density\s+R\s+N=\s*)171$/m, '$1100') : '';
    expect(shortened).not.toBe(WATER_FCHK);
    expect(() => parseFchk(shortened)).toThrow(/Total SCF Density.*171/);
  });

  it('refuses a density block that stops in the middle, by name', () => {
    const lines = WATER_FCHK.split('\n');
    const start = lines.findIndex((line) => line.startsWith('Total SCF Density'));
    // Keep the header and one line of values, then let the next field begin:
    // the declared count can no longer be met.
    const truncated = [
      ...lines.slice(0, start + 2),
      ...lines.slice(start + 2).filter((line) => /^[A-Za-z]/.test(line)).slice(0, 1),
      'Number of alpha electrons                  I                5',
    ].join('\n');
    expect(() => parseFchk(truncated)).toThrow(/Total SCF Density/);
  });

  it('says there is no density in a file that has none, and never answers zero', () => {
    const withoutDensity = WATER_FCHK.split('\n')
      .filter((line) => !line.startsWith('Total SCF Density'))
      .join('\n');
    const fchk = parseFchk(withoutDensity);
    expect(fchk.totalScfDensity).toBeUndefined();
    expect(densityMatrix(fchk)).toMatchObject({ ok: false, reason: 'no density in this file' });
    const potential = electrostaticPotential({ fchk, points: [[0, 0, 0]] });
    expect(potential).toMatchObject({ ok: false, reason: 'no density in this file' });
    expect(potential.values).toBeUndefined();
    expect(espCardRows({ fchk })).toEqual([['ESP', 'no density in this file']]);
  });

  it('refuses the density of an error-terminated checkpoint (#244)', () => {
    const text = readFileSync('test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk', 'utf8')
      .replace(/^Job Status\s+I\s+1$/m, 'Job Status                                 I                3');
    const fchk = parseFchk(text);
    expect(fchk.totalScfDensity).toBeInstanceOf(Float64Array);
    const matrix = densityMatrix(fchk);
    expect(matrix.ok).toBe(false);
    expect(matrix.reason).toMatch(/Job Status 3 \(error termination in Link 9999\)/);
    // The card must print the refusal, not "no density in this file": the
    // block is there, but it is not a completed result.
    expect(espCardRows({ fchk })[0][1]).toMatch(/Job Status 3/);
  });
});

describe('Boys functions', () => {
  it('matches the tabulated values the expansion depends on', () => {
    // F_n(1) = 0.7468241328, 0.1894723458, 0.1002687981, 0.0667322748.
    const F = boysFunctions(1, 3);
    expect(F[0]).toBeCloseTo(0.7468241328, 9);
    expect(F[1]).toBeCloseTo(0.1894723458, 9);
    expect(F[2]).toBeCloseTo(0.1002687981, 9);
    expect(F[3]).toBeCloseTo(0.0667322748, 9);
    // Large argument, where a naive upward recursion would be unstable.
    expect(boysFunctions(4000, 2)[0]).toBeCloseTo(Math.sqrt(Math.PI / (4 * 4000)), 12);
  });
});

describe('electrostatic potential (issue 164)', () => {
  it('gives the exact potential of a single s function, so the kernel is not approximate', () => {
    const lines = [
      'synthetic one-function check',
      'Number of atoms                            I                1',
      'Number of electrons                        I                1',
      'Number of basis functions                  I                1',
      'Atomic numbers                             I   N=           1',
      '           1',
      'Current cartesian coordinates              R   N=           3',
      '  0.00000000E+00  0.00000000E+00  0.00000000E+00',
      'Shell types                                I   N=           1',
      '           0',
      'Number of primitives per shell             I   N=           1',
      '           1',
      'Shell to atom map                          I   N=           1',
      '           1',
      'Primitive exponents                        R   N=           1',
      '  1.00000000E+00',
      'Contraction coefficients                   R   N=           1',
      '  1.00000000E+00',
      'Total SCF Density                          R   N=           1',
      '  1.00000000E+00',
    ];
    const fchk = parseFchk(lines.join('\n'));
    const radii = [0.25, 0.5, 1, 2, 4];
    const points = radii.map((r) => [r / BOHR_PER_ANGSTROM, 0, 0]);
    const potential = electrostaticPotential({ fchk, points, includeNuclei: false });
    const w = (2 / Math.PI) ** 0.75;
    const terms = [{ alpha: 2, weight: w * w }];
    radii.forEach((r, index) => {
      expect(potential.values[index]).toBeCloseTo(radialPotential(terms, 0, r), 8);
    });
  });

  it('agrees with Psi4\'s OWN esp cube on the shared grid, within the stated tolerance', () => {
    const fchk = parseFchk(WATER_FCHK);
    const cube = parseCube(ESP_CUBE);
    const points = gridPoints(cube);
    const potential = potentialOnGrid({ fchk, grid: {
      counts: cube.dims,
      origin: cube.origin,
      step: cube.spacing[0],
    } });
    expect(potential.ok).toBe(true);
    expect(potential.values.length).toBe(points.length);

    let worst = 0;
    let at = 0;
    for (let index = 0; index < points.length; index += 1) {
      const deviation = Math.abs(potential.values[index] - cube.values[index]);
      if (deviation > worst) {
        worst = deviation;
        at = index;
      }
    }
    // Printed on every run: the tolerance is a claim about the pair of files,
    // so the reader sees the number it is checked against.
    // eslint-disable-next-line no-console
    console.log(`ESP vs Psi4: worst |ΔV| = ${worst.toExponential(3)} hartree at `
      + `[${points[at].map((value) => value.toFixed(2)).join(', ')}] Å, `
      + `${nearestAtom(points[at], fchk.atoms).toFixed(2)} Å from the nearest nucleus`);
    expect(worst).toBeLessThan(2e-3);
  }, 60000);

  it('is more accurate than the oracle it is checked against, on a case with an exact answer', () => {
    const fchk = parseFchk(HE_FCHK);
    const cube = parseCube(HE_ESP_CUBE);
    const points = gridPoints(cube);
    const terms = atomicTerms(fchk);
    const potential = potentialOnGrid({ fchk, grid: { counts: cube.dims, origin: cube.origin, step: cube.spacing[0] } });
    let ours = 0;
    let oracle = 0;
    let count = 0;
    for (let index = 0; index < points.length; index += 1) {
      const radius = Math.hypot(...points[index]) * BOHR_PER_ANGSTROM;
      if (radius < 0.5) continue; // the nuclear singularity itself
      const exact = radialPotential(terms, fchk.atomicNumbers[0], radius);
      ours = Math.max(ours, Math.abs(potential.values[index] - exact));
      oracle = Math.max(oracle, Math.abs(cube.values[index] - exact));
      count += 1;
    }
    expect(count).toBeGreaterThan(4000);
    // eslint-disable-next-line no-console
    console.log(`He: worst |ΔV| ours ${ours.toExponential(3)} vs Psi4's cube ${oracle.toExponential(3)} hartree`);
    expect(ours).toBeLessThan(1e-6);
    // Psi4's cube is the looser of the two here; that is why the water tolerance
    // above is stated in units of its error, not in units of ours.
    expect(oracle).toBeGreaterThan(1e-3);
  }, 60000);

  it('marks the points where the nuclear term diverges instead of hiding them', () => {
    const fchk = parseFchk(WATER_FCHK);
    const atom = fchk.atoms[0];
    const potential = electrostaticPotential({
      fchk,
      points: [[atom.x + 0.02, atom.y, atom.z], [atom.x + 3, atom.y, atom.z]],
    });
    expect(potential.nearNucleus[0]).toBe(1);
    expect(potential.nearNucleus[1]).toBe(0);
  });
});

describe('the colour range and the figure (issue 164)', () => {
  const fchk = parseFchk(WATER_FCHK);
  const cube = parseCube(DENSITY_CUBE);
  const field = fieldFromCube(cube);
  const iso = 0.001;
  const mesh = extractSurface(field, iso);
  const meshes = [{ ...mesh, sign: 1 }];
  const esp = espForSurface({ fchk, cube, meshes });

  it('computes the potential on the cube\'s own grid and colours the surface with it', () => {
    expect(esp.ok).toBe(true);
    expect(esp.grid.counts).toEqual(cube.dims);
    expect(esp.values.length).toBe(mesh.triangleCount);
    expect(esp.grid.note).toContain(`${cube.dims.join('×')}`);
    expect(esp.grid.note).toContain('Å');
  }, 60000);

  it('prints the legend range in kcal/mol and in a.u., and says what it is scaled to', () => {
    const figure = espSurfaceFigure({
      meshes,
      values: esp.values,
      range: esp.range,
      iso,
      grid: esp.grid.note,
      method: 'analytic basis-function potential (Hermite/Boys)',
      width: 380,
      height: 320,
    });
    expect(figure).not.toBeNull();
    expect(figure.svg).toContain('kcal/mol');
    expect(figure.svg).toContain('hartree');
    expect(figure.svg).toContain('own extremes');
    expect(figure.svg).toMatch(/\d+×\d+×\d+/);
    expect(figure.caption).toContain('kcal/mol');
    expect(figure.caption).toContain('iso 0.001 au');
    expect(figure.caption).toContain('Hermite');
    expect(figure.params.coloured).toBe(true);
    // No neighbour to stand in for: the range is symmetric about zero.
    expect(figure.params.colourRange.min).toBeCloseTo(-figure.params.colourRange.max, 12);
  }, 60000);

  it('emits a self-contained, accessible figure: no script, no external reference', () => {
    const figure = espSurfaceFigure({
      meshes,
      values: esp.values,
      range: esp.range,
      iso,
      grid: esp.grid.note,
      method: 'analytic',
    });
    expect(figure.svg).toMatch(/^<svg[^>]*role="img"/);
    expect(figure.svg).toMatch(/<title>[^<]+<\/title>/);
    expect(figure.svg).toMatch(/<desc>[^<]+<\/desc>/);
    expect(figure.svg).not.toMatch(/<script/i);
    expect(figure.svg).not.toMatch(/https?:/i);
    expect(figure.svg).not.toMatch(/href=/i);
    expect(figure.svg).not.toMatch(/url\(/i);
    expect(figure.svg).not.toMatch(/@import/i);
    expect(figure.svg).not.toMatch(/<image/i);
  }, 60000);

  it('states the range in kcal/mol on the card and names the grid it was computed on', () => {
    const rows = espCardRows({ fchk, esp });
    const text = rows.map(([term, value]) => `${term}: ${value}`).join('\n');
    expect(text).toContain('kcal/mol');
    expect(text).toContain('Ha');
    expect(text).toContain(esp.grid.note);
    expect(text).toContain('own extremes');
    expect(rows.some(([term]) => term.startsWith('ESP'))).toBe(true);
  });

  it('refuses a surface colour range without a finite domain rather than drawing one', () => {
    expect(() => espSurfaceFigure({ meshes, values: esp.values, range: { min: NaN, max: 1 } }))
      .toThrow(/finite range/);
    expect(() => espSurfaceFigure({ meshes, values: Float64Array.from([1, 2]), range: esp.range }))
      .toThrow(/one value per triangle/);
    // Nothing to draw is not an error: the registry contract is a null figure.
    expect(espSurfaceFigure({ meshes: [], values: null, range: null })).toBeNull();
  });

  it('is reachable through the figure registry, so the report can ask for it by name', () => {
    const built = figure('esp-surface', {
      meshes,
      values: esp.values,
      range: esp.range,
      iso,
      grid: esp.grid.note,
      method: 'analytic',
    });
    expect(built).not.toBeNull();
    expect(built.svg).toContain('kcal/mol');
    expect(() => figure('esp-surface', {})).not.toThrow();
  }, 60000);

  it('makes the range symmetric about zero, and says when it clips', () => {
    const range = potentialRange([-0.01, 0.03, 0.02], { subject: 'surface' });
    expect(range.min).toBeCloseTo(-0.03, 12);
    expect(range.max).toBeCloseTo(0.03, 12);
    expect(range.kcal.max).toBeCloseTo(0.03 * 627.5094740631, 6);
    expect(range.scaledTo).toContain('own extremes');
    const clipped = potentialRange([-0.01, 0.3], { limitHartree: 0.05, subject: 'surface' });
    expect(clipped.max).toBeCloseTo(0.05, 12);
    expect(clipped.scaled).toBe('clipped');
    expect(clipped.scaledTo).toContain('clipped');
  });
});
