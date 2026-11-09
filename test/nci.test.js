import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFchk } from '../src/shared/fchk.js';
import {
  compileDensity,
  densityPropertiesAtBohr,
} from '../src/shared/qtaim.js';
import {
  FERMI_CONSTANT,
  NCI_PADDING_BOHR,
  NCI_RHO_CUTOFF,
  NCI_S_ISOVALUE,
  NCI_S_MAX,
  NCI_SPACING_BOHR,
  nciAnalysis,
  nciCardRows,
  nciGrid,
  reducedDensityGradient,
} from '../src/shared/nci.js';
import { nciFigure } from '../src/shared/figures/nci.js';
import { figure } from '../src/shared/figures/index.js';

const FIXTURES = new URL('./fixtures/esp/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

const WATER_FCHK = read('water-esp.fchk');
const fchk = parseFchk(WATER_FCHK);

describe('the reduced density gradient, against the formula by hand (issue 59)', () => {
  it('is |∇ρ| / (2 (3π²)^{1/3} ρ^{4/3}) at three densities', () => {
    // The constant, to the digits used below: (3π²)^{1/3} = 3.0936677262801355.
    expect(FERMI_CONSTANT).toBeCloseTo(3.093667726, 9);

    // The three points are real points of this water density, in bohr:
    //   A  cube-grid point (18,12,12) = (0.8466835374448003, 0.42334176872240015,
    //      0.3332535819838518)       ρ = 0.08058589226975008, |∇ρ| = 0.19165062958665063
    //   B  (0, 0, 0.6298)             ρ = 0.6264009503927431,  |∇ρ| = 1.1564377433257556
    //   C  (3.8107, 1.6924, −1.0456)  ρ = 0.00006471371653117096, |∇ρ| = 0.00019463824686663937
    // and the arithmetic, written out per point:
    //
    //   A: ρ^{4/3} = 0.08058589226975008^{4/3} = 0.034807969671059286
    //      s = 0.19165062958665063 / (2 × 3.0936677262801355 × 0.034807969671059286)
    //        = 0.19165062958665063 / 0.2153680045… = 0.8898727257958591
    //   B: ρ^{4/3} = 0.5359651406631238
    //      s = 1.1564377433257556 / (2 × 3.0936677262801355 × 0.5359651406631238)
    //        = 1.1564377433257556 / 3.316074… = 0.34872417155604435
    //   C: ρ^{4/3} = 2.598135455933757e-6
    //      s = 0.00019463824686663937 / (2 × 3.0936677262801355 × 2.598135455933757e-6)
    //        = 0.00019463824686663937 / 0.000016078… = 12.107730125033527
    const cases = [
      { rho: 0.08058589226975008, gradient: 0.19165062958665063, s: 0.8898727257958591 },
      { rho: 0.6264009503927431, gradient: 1.1564377433257556, s: 0.34872417155604435 },
      { rho: 0.00006471371653117096, gradient: 0.00019463824686663937, s: 12.107730125033527 },
    ];
    for (const sample of cases) {
      const expected = sample.gradient / (2 * 3.0936677262801355 * sample.rho ** (4 / 3));
      expect(reducedDensityGradient(sample.rho, sample.gradient)).toBeCloseTo(expected, 12);
      expect(reducedDensityGradient(sample.rho, sample.gradient)).toBeCloseTo(sample.s, 9);
    }

    // And the same three numbers come out of the density evaluator, so the
    // points are not invented: ρ and |∇ρ| are read from the checkpoint. The
    // first point is the cube grid point (18,12,12), whose grid origin and
    // 0.4 bohr steps give 1.6, 0.8, 0.629758 bohr.
    const compiled = compileDensity(fchk);
    const points = [
      [1.6, 0.8, 0.629758],
      [0, 0, 0.6298],
      [3.8107, 1.6924, -1.0456],
    ];
    points.forEach((point, index) => {
      const { rho, gradient } = densityPropertiesAtBohr(compiled, ...point);
      expect(rho).toBeCloseTo(cases[index].rho, 12);
      expect(Math.hypot(...gradient)).toBeCloseTo(cases[index].gradient, 12);
      expect(reducedDensityGradient(rho, Math.hypot(...gradient))).toBeCloseTo(cases[index].s, 9);
    });
  });

  it('refuses a non-positive density rather than returning a number', () => {
    expect(reducedDensityGradient(0, 1)).toBeNull();
    expect(reducedDensityGradient(-0.1, 1)).toBeNull();
    expect(reducedDensityGradient(0.1, Number.NaN)).toBeNull();
  });
});

describe('the NCI grid (issue 59)', () => {
  it('is the molecular box plus the stated padding, at the stated spacing', () => {
    const atoms = [{ x: -1, y: -0.5, z: 0 }, { x: 1, y: 0.5, z: 1 }];
    const grid = nciGrid(atoms, { spacingBohr: 0.5, paddingBohr: 1 });
    // Box: x ∈ [−2, 2] → ceil(4/0.5)+1 = 9 points; y ∈ [−1.5, 1.5] → 7; z ∈ [−1, 2] → 7.
    expect(grid.counts).toEqual([9, 7, 7]);
    expect(grid.points).toBe(9 * 7 * 7);
    expect(grid.originBohr).toEqual([-2, -1.5, -1]);
    expect(grid.originAngstrom[0]).toBeCloseTo(-2 * 0.529177210903, 12);
    expect(grid.upperBohr).toEqual([2, 1.5, 2]);
    expect(grid.note).toContain('0.5 bohr');
    expect(NCI_SPACING_BOHR).toBe(0.2);
    expect(NCI_PADDING_BOHR).toBe(2.5);
  });

  it('refuses a grid above the point cap by name, instead of truncating the box', () => {
    const grid = nciGrid([{ x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 20 }], { spacingBohr: 0.05, maxPoints: 1000 });
    expect(grid.ok).toBe(false);
    expect(grid.reason).toMatch(/exceeds the 1000-point cap/);
    expect(() => nciGrid([], {})).toThrow(/at least one atom/);
    expect(() => nciGrid([{ x: 0, y: 0, z: 0 }], { spacingBohr: 0 })).toThrow(/positive number of bohr/);
  });
});

describe('the NCI analysis on the committed water checkpoint (issue 59)', () => {
  const analysis = nciAnalysis({ fchk });

  it('scans the stated grid and keeps its counts consistent', () => {
    expect(analysis.ok).toBe(true);
    expect(analysis.grid.counts).toEqual([41, 26, 32]);
    expect(analysis.grid.spacingBohr).toBe(0.2);
    expect(analysis.grid.points).toBe(41 * 26 * 32);
    const { counts } = analysis;
    // Every grid point is accounted for: plotted, removed by the density
    // cutoff, removed by the s cutoff, or not positive.
    expect(counts.densityInside + counts.excludedByDensity + counts.nonPositiveDensity).toBe(counts.gridPoints);
    expect(counts.plotted + counts.excludedByGradient).toBe(counts.densityInside);
    expect(counts.attractive + counts.repulsive).toBe(counts.plotted);
    expect(counts.nonPositiveDensity).toBe(0); // a density is positive everywhere
  }, 60000);

  it('has every plotted point inside the two cutoffs, with λ₂ from the Hessian', () => {
    const { points, parameters } = analysis;
    expect(points.count).toBeGreaterThan(1000);
    for (let index = 0; index < points.count; index += 1) {
      expect(points.s[index]).toBeGreaterThanOrEqual(0);
      expect(points.s[index]).toBeLessThanOrEqual(parameters.sMax);
      expect(Math.abs(points.x[index])).toBeLessThanOrEqual(parameters.rhoCutoff);
    }
    expect(parameters.sIsovalue).toBe(0.5);
    expect(parameters.rhoCutoff).toBe(0.05);
    expect(parameters.lambda2).toContain('analytic Hessian');
    expect(NCI_S_ISOVALUE).toBe(0.5);
    expect(NCI_RHO_CUTOFF).toBe(0.05);
    expect(NCI_S_MAX).toBe(2);
  }, 60000);

  it('states that no point reaches the s = 0.5 isosurface, with the lowest s', () => {
    // Measured for this fixture: the lowest s inside the cutoffs is 1.034, at
    // the density cutoff. That is a statement about 6-31G* (no diffuse
    // functions) on a single water molecule — the NCI region needs a weak
    // contact and a basis that describes the outer density — and the report
    // prints it rather than implying a feature by drawing the line alone.
    expect(analysis.counts.belowIsovalue).toBe(0);
    expect(analysis.range.sMin).toBeGreaterThan(1);
    expect(analysis.range.sMin).toBeLessThan(1.1);
  }, 60000);

  it('prints the exact words for a checkpoint with no density', () => {
    const withoutDensity = WATER_FCHK.split('\n')
      .filter((line) => !line.startsWith('Total SCF Density'))
      .join('\n');
    const stripped = parseFchk(withoutDensity);
    const empty = nciAnalysis({ fchk: stripped });
    expect(empty).toMatchObject({ ok: false, reason: 'no density in this file' });
    expect(nciCardRows(empty)).toEqual([['NCI', 'no density in this file']]);
    expect(nciFigure(empty)).toBeNull();
  });

  it('prints the card rows with the grid, the cutoffs and the λ₂ method', () => {
    const rows = nciCardRows(analysis);
    const text = rows.map(([term, value]) => `${term}: ${value}`).join('\n');
    expect(text).toContain('41×26×32');
    expect(text).toContain('0.2 bohr');
    expect(text).toContain('ρ ≤ 0.05 e/bohr³');
    expect(text).toContain('isosurface s = 0.5');
    expect(text).toContain('no finite difference');
  }, 60000);
});

describe('the NCI figure (issue 59)', () => {
  const analysis = nciAnalysis({ fchk });
  const drawn = nciFigure(analysis);

  it('is a self-contained, accessible SVG with a title and a description', () => {
    expect(drawn).not.toBeNull();
    expect(drawn.kind).toBe('nci');
    expect(drawn.svg).toContain('role="img"');
    expect(drawn.svg).toMatch(/<title>[^<]+<\/title>/);
    expect(drawn.svg).toMatch(/<desc>[^<]+<\/desc>/);
    expect(drawn.svg).not.toMatch(/<script/i);
    expect(drawn.svg).not.toMatch(/https?:/i);
    expect(drawn.svg).not.toMatch(/href=/i);
    expect(drawn.svg).not.toMatch(/url\(/i);
    expect(drawn.svg).not.toMatch(/@import/i);
    expect(drawn.svg).not.toMatch(/<image/i);
  }, 60000);

  it('states the grid, the isosurface value, the cutoffs and the λ₂ method in the caption', () => {
    const caption = drawn.caption;
    expect(caption).toContain('41×26×32');
    expect(caption).toContain('0.2 bohr');
    expect(caption).toContain('padding 2.5 bohr');
    expect(caption).toContain('ρ ≤ 0.050');
    expect(caption).toContain('s ≤ 2.00');
    expect(caption).toContain('s = 0.50 isosurface');
    expect(caption).toContain('λ₂ from the analytic Hessian');
    expect(caption).toContain('no finite difference');
    // 5,624 + 838 = 6,462 points, and the caption says how many were dropped.
    expect(caption).toContain('6462');
    expect(caption).toContain('no point reaches s = 0.50');
    expect(drawn.params.sIsovalue).toBe(0.5);
    expect(drawn.params.spacingBohr).toBe(0.2);
  }, 60000);

  it('draws the isosurface line and both axes, sized to the cutoff', () => {
    expect(drawn.svg).toContain('s = 0.50 isosurface');
    expect(drawn.svg).toContain('reduced density gradient s');
    expect(drawn.svg).toContain('sign(λ₂)·ρ');
    expect(drawn.svg).toContain('attractive');
    expect(drawn.svg).toContain('repulsive');
    // The x axis runs from −0.05 to +0.05 at the density cutoff, so its tick
    // labels include a negative and a positive value.
    expect(drawn.svg).toContain('-0.040');
    expect(drawn.svg).toContain('0.040');
  }, 60000);

  it('is reachable through the figure registry and returns null without data', () => {
    expect(figure('nci', analysis)).not.toBeNull();
    expect(figure('nci', {})).toBeNull();
    expect(nciFigure({ points: { count: 0 } })).toBeNull();
  }, 60000);
});
