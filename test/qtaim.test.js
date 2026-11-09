import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFchk } from '../src/shared/fchk.js';
import { parseCube } from '../src/shared/cubeFile.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import {
  BOND_FACTOR,
  COVALENT_RADII,
  bcpTable,
  bcpTableHtml,
  candidateBonds,
  compileDensity,
  criticalPointSearch,
  densityPropertiesAtBohr,
  qtaimAnalysis,
  qtaimCardRows,
  symmetricEigen,
} from '../src/shared/qtaim.js';

const FIXTURES = new URL('./fixtures/esp/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

const WATER_FCHK = read('water-esp.fchk');
const DENSITY_CUBE = read('Dt.cube');

const BOHR = 0.529177210903;
const fchk = parseFchk(WATER_FCHK);

/**
 * The cited reference numbers for the O–H bond critical point of water (issue
 * 59). They are **not** from this calculation: the source is the electronic
 * supplementary information of
 *
 *   "The Ehrenfest force topology: a physically intuitive approach for
 *   analyzing chemical interactions", Phys. Chem. Chem. Phys. 2013,
 *   DOI 10.1039/c3cp52687a, ESI Table S1(a), molecular graph H2O, BCP O2−H1.
 *
 * with a modified ANO-RCC basis (see the paper's abstract), whereas the
 * checkpoint here is the committed Psi4 1.11 B3LYP/6-31G* water run
 * (`test/fixtures/psi4/`, whose `water-b3lyp-631gd.fchk` is byte-identical to
 * `test/fixtures/esp/water-esp.fchk`). Different functional and very different
 * basis, so the test asserts a **band** around the cited value and says which
 * band and why — it does not claim agreement with the citation.
 */
const LITERATURE = Object.freeze({
  rho: 0.3780, // e/bohr^3
  laplacian: -2.7083, // e/bohr^5
  ellipticity: 0.0215,
  bondPathBohr: 1.7968,
  citation: 'PCCP 2013, DOI 10.1039/c3cp52687a, ESI Table S1(a), H2O O2−H1 (modified ANO-RCC)',
});

describe('analytic density derivatives (issue 59)', () => {
  it('reproduces Psi4\'s density cube from the matrix, point for point', () => {
    const compiled = compileDensity(fchk);
    expect(compiled.ok).toBe(true);
    const cube = parseCube(DENSITY_CUBE);
    const [nx, ny, nz] = cube.dims;
    let worst = 0;
    for (let k = 0; k < nz; k += 1) {
      for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
          const x = cube.origin[0] + cube.axes[0][0] * i;
          const y = cube.origin[1] + cube.axes[1][1] * j;
          const z = cube.origin[2] + cube.axes[2][2] * k;
          const { rho } = densityPropertiesAtBohr(compiled, x / BOHR, y / BOHR, z / BOHR);
          worst = Math.max(worst, Math.abs(rho - cube.values[i + nx * (j + ny * k)]));
        }
      }
    }
    // The cube writes six significant digits, so a value of order 10 e/bohr³
    // arrives to ±1e-4 and one of order 100 to ±1e-3. Measured over the 14,616
    // points: worst |Δρ| = 8.8e-4 e/bohr³ — the file's own rounding, not the
    // reader's, and the same number the ESP work measured.
    expect(worst).toBeLessThan(1e-2);
    expect(worst).toBeLessThan(1e-3);
  });

  it('gives the gradient the cube implies, at a point where 0.4 bohr can resolve it', () => {
    const compiled = compileDensity(fchk);
    const cube = parseCube(DENSITY_CUBE);
    const [nx, ny] = cube.dims;
    // A grid point 1.7 Å from the oxygen, where the density is smooth on the
    // cube's 0.4 bohr spacing: ρ = 0.0806 e/bohr³.
    const [i, j, k] = [18, 12, 12];
    const x = cube.origin[0] + cube.axes[0][0] * i;
    const y = cube.origin[1] + cube.axes[1][1] * j;
    const z = cube.origin[2] + cube.axes[2][2] * k;
    const index = (di, dj, dk) => (i + di) + nx * ((j + dj) + ny * (k + dk));
    const step = 0.4; // bohr — the cube's own spacing, stated so the truncation is stated
    const fd = [0, 1, 2].map((axis) => {
      const di = axis === 0 ? 1 : 0;
      const dj = axis === 1 ? 1 : 0;
      const dk = axis === 2 ? 1 : 0;
      return (cube.values[index(di, dj, dk)] - cube.values[index(-di, -dj, -dk)]) / (2 * step);
    });
    const { rho, gradient } = densityPropertiesAtBohr(compiled, x / BOHR, y / BOHR, z / BOHR);
    expect(rho).toBeCloseTo(cube.values[index(0, 0, 0)], 6);
    const analyticNorm = Math.hypot(...gradient);
    const finiteNorm = Math.hypot(...fd);
    // Central differences on a 0.4 bohr grid are O(h²): measured 0.17 % on the
    // magnitude and cos = 0.9993 on the direction at this point. The same check
    // at a point 0.9 Å from oxygen is 20 % off, because 0.4 bohr cannot resolve
    // the curvature there — which is why the QTAIM code differentiates the
    // basis analytically and only *checks* against the cube.
    expect(Math.abs(finiteNorm - analyticNorm) / analyticNorm).toBeLessThan(5e-3);
    const cosine = (gradient[0] * fd[0] + gradient[1] * fd[1] + gradient[2] * fd[2])
      / (analyticNorm * finiteNorm);
    expect(cosine).toBeGreaterThan(0.999);
  });

  it('has a Hessian that is the derivative of its own gradient, to the finite-difference step', () => {
    const compiled = compileDensity(fchk);
    const point = [0.5, 0.2, 0.1]; // bohr, nucleus-free
    const { hessian } = densityPropertiesAtBohr(compiled, ...point);
    const h = 1e-4; // bohr, stated: central differences of the analytic gradient
    for (let axis = 0; axis < 3; axis += 1) {
      const plus = [...point];
      const minus = [...point];
      plus[axis] += h;
      minus[axis] -= h;
      const gp = densityPropertiesAtBohr(compiled, ...plus).gradient;
      const gm = densityPropertiesAtBohr(compiled, ...minus).gradient;
      for (let component = 0; component < 3; component += 1) {
        const finite = (gp[component] - gm[component]) / (2 * h);
        expect(hessian[axis * 3 + component]).toBeCloseTo(finite, 5);
      }
    }
    // Trace is the Laplacian, and the matrix is symmetric by construction.
    const eigen = symmetricEigen(hessian);
    expect(hessian[0] + hessian[4] + hessian[8]).toBeCloseTo(eigen.values.reduce((a, b) => a + b, 0), 10);
    expect(hessian[1]).toBe(hessian[3]);
    expect(hessian[5]).toBe(hessian[7]);
  });

  it('diagonalises a symmetric 3×3 matrix exactly where the answer is known', () => {
    const diagonal = symmetricEigen([2, 0, 0, 0, 4, 0, 0, 0, 3]);
    expect(diagonal.values).toEqual([2, 3, 4]);
    // [[1,1,0],[1,1,0],[0,0,2]] has eigenvalues 0, 2, 2.
    const degenerate = symmetricEigen([1, 1, 0, 1, 1, 0, 0, 0, 2]);
    expect(degenerate.values[0]).toBeCloseTo(0, 12);
    expect(degenerate.values[1]).toBeCloseTo(2, 12);
    expect(degenerate.values[2]).toBeCloseTo(2, 12);
    // Sum of eigenvalues = trace, for a matrix without a closed form here.
    const general = [1.3, -0.4, 0.2, -0.4, 0.7, 0.9, 0.2, 0.9, -2.1];
    const eigen = symmetricEigen(general);
    expect(eigen.values.reduce((a, b) => a + b, 0)).toBeCloseTo(1.3 + 0.7 - 2.1, 10);
  });
});

describe('bond critical points (issue 59)', () => {
  it('finds the two O–H BCPs of water, converged to the stated tolerance', () => {
    const analysis = qtaimAnalysis({ fchk });
    expect(analysis.ok).toBe(true);
    // Two O–H bonds; the H···H pair is 1.51 Å apart, over 1.3 × (0.31 + 0.31) Å.
    expect(analysis.bonds.map((bond) => bond.labels.join('–'))).toEqual(['O1–H2', 'O1–H3']);
    expect(analysis.found).toBe(2);
    expect(analysis.missing).toBe(0);
    for (const bond of analysis.bonds) {
      expect(bond.found).toBe(true);
      // Convergence criterion, asserted rather than described: |∇ρ| ≤ 1e-8
      // e/bohr⁴. Measured: 3.0e-12 after 5 iterations.
      expect(bond.gradientNorm).toBeLessThan(1e-8);
      expect(bond.iterations).toBeLessThan(200);
      // Signature (3,−1): two negative eigenvalues across the bond, one positive
      // along it, and λ1 + λ2 + λ3 is the Laplacian.
      expect(bond.eigenvalues[0]).toBeLessThan(0);
      expect(bond.eigenvalues[1]).toBeLessThan(0);
      expect(bond.eigenvalues[2]).toBeGreaterThan(0);
      expect(bond.laplacian).toBeCloseTo(bond.eigenvalues.reduce((a, b) => a + b, 0), 10);
      expect(bond.classification).toBe('shared-shell');
      // The BCP of an O–H bond sits between the two nuclei, nearer the hydrogen.
      expect(bond.at.z).toBeGreaterThan(0);
      expect(bond.at.z).toBeLessThan(0.5204);
      expect(Math.abs(bond.at.x)).toBeLessThan(0.757);
    }
  }, 60000);

  it('reports ρ, the Laplacian and the ellipticity, in a band around the cited values', () => {
    const analysis = qtaimAnalysis({ fchk, bondPath: true });
    const bond = analysis.bonds[0];
    // Ours: ρ = 0.35605 e/bohr³, ∇²ρ = −1.86665 e/bohr⁵, ε = 0.02393.
    // Cited: ρ = 0.3780, ∇²ρ = −2.7083, ε = 0.0215 (see LITERATURE above).
    // The sign and order of magnitude agree; the magnitudes do not, and the
    // band is wide because the level of theory is not the same — 6-31G* has no
    // diffuse functions, and the Laplacian at a BCP is far more basis-sensitive
    // than ρ. This is a sanity band, not an agreement claim.
    expect(bond.rho).toBeGreaterThan(0.30);
    expect(bond.rho).toBeLessThan(0.40);
    expect(Math.abs(bond.rho - LITERATURE.rho) / LITERATURE.rho).toBeLessThan(0.10);
    expect(bond.laplacian).toBeLessThan(0);
    // |∇²ρ| is 31 % below the cited value (1.87 vs 2.71 e/bohr⁵): the
    // Laplacian is the quantity a small, diffuse-function-free basis gets most
    // wrong, so the band is wide and the deviation is stated rather than
    // tuned away.
    expect(bond.laplacian).toBeLessThan(-1.0);
    expect(bond.laplacian).toBeGreaterThan(-4.0);
    expect(bond.ellipticity).toBeGreaterThan(0.005);
    expect(bond.ellipticity).toBeLessThan(0.05);
    // ε is defined from the two negative eigenvalues, not from λ3.
    expect(bond.ellipticity).toBeCloseTo(bond.eigenvalues[0] / bond.eigenvalues[1] - 1, 10);
    expect(bond.criteria.sharedShell).toContain('0.10 e/bohr³');
  }, 60000);

  it('measures the bond path as the steepest-ascent length, stated step and all', () => {
    const analysis = qtaimAnalysis({ fchk, bondPath: true });
    const bond = analysis.bonds[0];
    expect(bond.bondPath.complete).toBe(true);
    // A bond path is at least as long as the internuclear distance and, for a
    // near-linear O–H bond, only just: measured 0.95745 Å against 0.95731 Å.
    expect(bond.bondPath.lengthAngstrom).toBeGreaterThanOrEqual(bond.bondLengthAngstrom - 1e-6);
    expect(bond.bondPath.lengthAngstrom - bond.bondLengthAngstrom).toBeLessThan(0.01);
    // The cited path (1.7968 bohr) is for a shorter O–H bond at another level;
    // the path length is within 2 % of it, which is the bond length's own scale.
    const cited = LITERATURE.bondPathBohr * 0.529177210903;
    expect(Math.abs(bond.bondPath.lengthAngstrom - cited) / cited).toBeLessThan(0.02);
    expect(bond.bondPath.stepBohr).toBe(0.01);
    expect(bond.bondPath.note).toContain('RK4');
    expect(analysis.parameters.bondPathStepBohr).toBe(0.01);
  }, 60000);

  it('reports a pair with no BCP as not found, and never invents a point', () => {
    // The H···H pair of water has no bond critical point. Asked for explicitly,
    // the search must say so: no ρ, no Laplacian, no ellipticity.
    const analysis = qtaimAnalysis({ fchk, bonds: [[1, 2]] });
    const [bond] = analysis.bonds;
    expect(bond.found).toBe(false);
    expect(bond.reason).toMatch(/left the bond|no convergence|stalled|not a bond critical point/);
    expect(bond.rho).toBeUndefined();
    expect(bond.laplacian).toBeUndefined();
    expect(bond.ellipticity).toBeUndefined();
    expect(analysis.missing).toBe(1);
    const rows = qtaimCardRows(analysis);
    expect(rows.some(([, value]) => value.startsWith('no BCP:'))).toBe(true);
    // The table keeps the row, with dashes in every numeric column.
    const table = bcpTable(analysis);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][0]).toBe('H2–H3');
    expect(table.rows[0].slice(1, 8).every((cell) => cell === null)).toBe(true);
    expect(table.missing[0][0]).toBe('H2–H3');
    expect(bcpTableHtml(analysis)).toContain('—');
  }, 60000);

  it('lists the candidate bonds from covalent radii and names an element it cannot', () => {
    const atoms = [
      { symbol: 'O', atomicNumber: 8, x: 0, y: 0, z: 0 },
      { symbol: 'H', atomicNumber: 1, x: 0.957, y: 0, z: 0 },
      { symbol: 'H', atomicNumber: 1, x: -0.24, y: 0.93, z: 0 },
    ];
    const bonds = candidateBonds(atoms);
    expect(bonds.filter((bond) => bond.considered).map((bond) => bond.atoms)).toEqual([[0, 1], [0, 2]]);
    expect(BOND_FACTOR).toBe(1.3);
    expect(COVALENT_RADII.O).toBe(0.66);
    // No covalent radius is stored beyond barium; a pair with one is reported
    // as not searched rather than guessed at.
    const exotic = candidateBonds([
      { symbol: 'O', atomicNumber: 8, x: 0, y: 0, z: 0 },
      { symbol: 'Z99', atomicNumber: 99, x: 2, y: 0, z: 0 },
    ]);
    expect(exotic[0].considered).toBe(false);
    expect(exotic[0].reason).toBe('no covalent radius for Z99');
  });

  it('converges from an off-centre start onto the same critical point', () => {
    const compiled = compileDensity(fchk);
    const atoms = compiled.atoms;
    const start = [
      (atoms[0].x + atoms[1].x) / 2 + 0.1,
      (atoms[0].y + atoms[1].y) / 2 + 0.1,
      (atoms[0].z + atoms[1].z) / 2 - 0.1,
    ];
    const search = criticalPointSearch(compiled, start);
    expect(search.ok).toBe(true);
    expect(search.gradientNorm).toBeLessThan(1e-8);
    expect(search.properties.rho).toBeCloseTo(0.3560528793, 6);
  }, 30000);

  it('prints the exact words for a checkpoint with no density, and no bond rows', () => {
    const withoutDensity = WATER_FCHK.split('\n')
      .filter((line) => !line.startsWith('Total SCF Density'))
      .join('\n');
    const stripped = parseFchk(withoutDensity);
    const analysis = qtaimAnalysis({ fchk: stripped });
    expect(analysis).toMatchObject({ ok: false, reason: 'no density in this file' });
    expect(qtaimCardRows(analysis)).toEqual([['QTAIM', 'no density in this file']]);
    expect(bcpTable(analysis)).toMatchObject({ reason: 'no density in this file', rows: [] });
    expect(bcpTableHtml(analysis)).toContain('no density in this file');
  });

  it('prints the table with every number and the classification', () => {
    const analysis = qtaimAnalysis({ fchk, bondPath: false });
    const table = bcpTable(analysis);
    expect(table.columns).toEqual([
      'bond', 'ρ (e/bohr³)', '∇²ρ (e/bohr⁵)', 'λ₁', 'λ₂', 'λ₃', 'ε', 'bond path (Å)', 'class', 'note',
    ]);
    expect(table.rows).toHaveLength(2);
    const [label, rho, laplacian, , , , ellipticity, path, classification] = table.rows[0];
    expect(label).toBe('O1–H2');
    expect(rho).toBeCloseTo(0.3560528793, 6);
    expect(laplacian).toBeCloseTo(-1.8666512136, 6);
    expect(ellipticity).toBeCloseTo(0.0239264239, 6);
    expect(path).toBeNull(); // bondPath: false — absent, not zero
    expect(classification).toBe('shared-shell');
    const html = bcpTableHtml(analysis);
    expect(html).toContain('<table class="bcp-table">');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('shared-shell');
  }, 30000);
});

describe('the report section (issue 59)', () => {
  const QUEUE = {
    id: 'q-1',
    projectName: 'Water',
    status: 'completed',
    tasks: [{ nodeId: 'opt', title: 'Optimise', type: 'calc', status: 'passed', runId: 'run-1' }],
  };

  it('prints the BCP table and the NCI figure when a checkpoint is supplied', () => {
    const model = buildWorkflowReport(QUEUE, {}, { generatedAt: '2026-11-09T00:00:00.000Z', wavefunction: fchk });
    expect(model.analysis).not.toBeNull();
    expect(model.analysis.table.rows).toHaveLength(2);
    expect(model.analysis.figure.key).toBe('nci');
    expect(model.analysis.figure.caption).toContain('0.2 bohr');
    const html = workflowReportHtml(model);
    expect(html).toContain('Wavefunction analysis');
    expect(html).toContain('<table class="bcp-table">');
    expect(html).toContain('O1–H2');
    expect(html).toContain('shared-shell');
    expect(html).toContain('role="img"');
    expect(html).toContain('s = 0.50 isosurface');
    expect(html).toContain('no point reaches s = 0.50');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:/i);
  }, 90000);

  it('is absent when no checkpoint is attached, and says so when one holds no density', () => {
    const plain = buildWorkflowReport(QUEUE, {});
    expect(plain.analysis).toBeNull();
    expect(workflowReportHtml(plain)).not.toContain('Wavefunction analysis');

    const withoutDensity = parseFchk(WATER_FCHK.split('\n')
      .filter((line) => !line.startsWith('Total SCF Density'))
      .join('\n'));
    const empty = buildWorkflowReport(QUEUE, {}, { wavefunction: withoutDensity });
    expect(empty.analysis.qtaim).toMatchObject({ ok: false, reason: 'no density in this file' });
    expect(empty.analysis.figure).toBeNull();
    expect(workflowReportHtml(empty)).toContain('no density in this file');
  }, 90000);
});
