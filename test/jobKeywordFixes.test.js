import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { routeFor, buildGaussianInput } from '../src/shared/gaussianInput.js';
import { constraintFindings, modRedundantLine } from '../src/shared/constraints.js';
import { templateProject } from '../src/shared/templates.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';

/**
 * Defects a real Gaussian 16 A.03 run exposed, each pinned by the input the app
 * now writes instead of the route that failed.
 */
const base = {
  method: 'B3LYP', basis: '6-31G(d)', memory: '2', memoryUnit: 'GB', nproc: 2,
};
const water = {
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
    { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
  ],
};

describe('IRC carries a Hessian source', () => {
  it('writes IRC(forward,CalcFC) instead of the bare form Gaussian refuses', () => {
    // A real run: "You must use ReadCartesianFC, FCCards, or CalcFC with IRC."
    expect(routeFor({ ...base, jobType: 'IRC' })).toBe('#p B3LYP/6-31G(d) IRC(forward,CalcFC)');
  });

  it('honours both directions and a ReadFC choice', () => {
    expect(routeFor({ ...base, jobType: 'IRC', ircDirection: 'both' }))
      .toBe('#p B3LYP/6-31G(d) IRC(forward,reverse,CalcFC)');
    expect(routeFor({ ...base, jobType: 'IRC', forceConstants: 'ReadFC' }))
      .toBe('#p B3LYP/6-31G(d) IRC(forward,ReadFC)');
  });
});

describe('Scan becomes a relaxed scan', () => {
  const scanned = { kind: 'bond', atoms: [1, 2], mode: 'scan', steps: 10, size: 0.05 };

  it('writes Opt=ModRedundant, not the bare Scan keyword', () => {
    // `Scan` alone steps Z-matrix variables; a Cartesian geometry has none and
    // Gaussian stops in l108 with "No variables in Z-matrix."
    expect(routeFor({ ...base, jobType: 'Scan', constraints: [scanned] }))
      .toBe('#p B3LYP/6-31G(d) Opt=ModRedundant');
  });

  it('writes the S line with its step count and size', () => {
    expect(modRedundantLine(scanned)).toBe('B 1 2 S 10 0.05');
    // Gaussian's l101 reads the step size as a real number and stops a Scan with
    // "Wanted a floating point number as input. Found an integer as input." when
    // a whole-number step arrives without a decimal point, so one is written.
    expect(modRedundantLine({ kind: 'dihedral', atoms: [1, 2, 3, 4], mode: 'scan', steps: 12, size: -5 }))
      .toBe('D 1 2 3 4 S 12 -5.0');
  });

  it('refuses a Scan with nothing to scan', () => {
    const report = constraintFindings({ constraints: [], jobType: 'Scan', atoms: water.coords });
    expect(report.errors.map((entry) => entry.message).join(' ')).toMatch(/needs one coordinate marked as scanned/);
  });

  it('refuses two scanned coordinates and a scan on a non-Scan job', () => {
    const two = constraintFindings({
      constraints: [scanned, { kind: 'angle', atoms: [1, 2, 3], mode: 'scan', steps: 5, size: 1 }],
      jobType: 'Scan',
      atoms: water.coords,
    });
    expect(two.errors.map((entry) => entry.message).join(' ')).toMatch(/scans one coordinate at a time/);
    const wrongJob = constraintFindings({ constraints: [scanned], jobType: 'Opt', atoms: water.coords });
    expect(wrongJob.errors.map((entry) => entry.message).join(' ')).toMatch(/only for a Scan job/);
  });

  it('does not count a scanned coordinate as a removed degree of freedom', () => {
    // A two-atom scan removes nothing: the coordinate is stepped, not frozen.
    const report = constraintFindings({ constraints: [scanned], jobType: 'Scan', atoms: water.coords.slice(0, 2) });
    expect(report.errors).toEqual([]);
  });

  it('writes the section into the input file', () => {
    const text = buildGaussianInput({
      settings: { ...base, jobType: 'Scan', constraints: [scanned] },
      molecule: water,
      inputName: 'scan.gjf',
    });
    const lines = text.split('\n');
    expect(lines).toContain('#p B3LYP/6-31G(d) Opt=ModRedundant');
    expect(lines).toContain('B 1 2 S 10 0.05');
  });
});

describe('Stable=Opt only on a job that optimises', () => {
  it('refuses it on a single point', () => {
    expect(() => routeFor({ ...base, jobType: 'SP', stableOpt: true }))
      .toThrow(/only applies to an Opt job/);
  });

  it('keeps it on an optimisation', () => {
    expect(routeFor({ ...base, jobType: 'Opt', stableOpt: true }))
      .toContain('Stable=Opt');
  });
});

describe('the opt-freq template links the checkpoint', () => {
  it('uses a checkpoint edge, so the frequency runs on the optimised geometry', () => {
    const project = templateProject('opt-freq', { name: 'opt-freq' });
    const edge = project.edges.find((entry) => entry.from === 'of-opt' && entry.to === 'of-freq');
    expect(edge.type).toBe('checkpoint');
    const freq = project.nodes.find((node) => node.id === 'of-freq');
    expect(freq.checkpointFrom).toBe('of-opt');
  });
});

describe('Hirshfeld charges from a real G16 log', () => {
  it('reads Q-H as the charge and drops the Tot row', () => {
    const parsed = parseGaussianOutput(readFileSync('test/fixtures/real/g16-a03-water-hirshfeld.out', 'utf8'));
    expect(parsed.charges.hirshfeld.map((entry) => entry.element)).toEqual(['O', 'H', 'H']);
    expect(parsed.charges.hirshfeld[0].charge).toBeCloseTo(-0.323144, 6);
    expect(parsed.charges.hirshfeld[1].charge).toBeCloseTo(0.161572, 6);
    expect(parsed.charges.hirshfeld.reduce((sum, entry) => sum + entry.charge, 0)).toBeCloseTo(0, 6);
  });
});
