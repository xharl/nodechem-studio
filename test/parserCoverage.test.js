import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateGates, geometryToXyz, parseGaussianOutput } from '../src/shared/gaussianOutput.js';

const coverageText = readFileSync(
  fileURLToPath(new URL('./fixtures/synthetic-parser-coverage.out', import.meta.url)),
  'utf8',
);
const parsed = parseGaussianOutput(coverageText);

describe('program banner and route echo', () => {
  it('labels the fixture synthetic before any Gaussian-looking record', () => {
    const firstLine = coverageText.split('\n')[0];
    expect(firstLine).toContain('FIXTURE OUTPUT');
    expect(firstLine.toLowerCase()).toContain('synthetic');
    expect(firstLine).not.toContain('Entering Gaussian');
  });

  it('records name, version and revision from the banner, at the root and per link', () => {
    expect(parsed.program).toEqual({ name: 'Gaussian', version: '16', revision: 'C.01' });
    expect(parsed.links[0].program).toEqual({ name: 'Gaussian', version: '16', revision: 'C.01' });
  });

  it('echoes the route exactly as Gaussian printed it', () => {
    expect(parsed.route).toBe('#P B3LYP/6-31G(d) Opt Freq');
    expect(parsed.links[0].route).toBe('#P B3LYP/6-31G(d) Opt Freq');
  });
});

describe('orientation geometry', () => {
  it('parses the Input and Standard orientation tables with element symbols', () => {
    expect(parsed.geometry.input).toMatchObject({ source: 'input', atomCount: 4 });
    expect(parsed.geometry.standard).toMatchObject({ source: 'standard', atomCount: 4 });
    expect(parsed.geometry.input.atoms[0]).toEqual({
      center: 1,
      atomicNumber: 6,
      atomicType: 0,
      element: 'C',
      x: 0,
      y: 0,
      z: 0,
    });
    expect(parsed.geometry.standard.atoms.map((atom) => atom.element)).toEqual(['C', 'H', 'H', 'H']);
  });

  it('takes the link final geometry from the last orientation table', () => {
    const final = parsed.finalGeometry;
    expect(final).toBe(parsed.geometry.final);
    expect(final.source).toBe('standard');
    expect(final.atoms[1].z).toBeCloseTo(1.089, 6);
    // The final table differs from the input table, so this is not just the
    // first geometry echoed twice.
    expect(parsed.geometry.input.atoms[1].z).toBeCloseTo(1.09, 6);
    expect(final.atoms[2].x).toBeCloseTo(1.025, 6);
    expect(parsed.links[0].geometry.final.atoms[3].z).toBeCloseTo(-0.362, 6);
  });

  it('round-trips the optimised structure to XYZ at printed precision', () => {
    const final = parsed.finalGeometry;
    const xyz = geometryToXyz(final, { comment: 'synthetic coverage' });
    const lines = xyz.trimEnd().split('\n');
    expect(lines[0]).toBe('4');
    expect(lines[1]).toBe('synthetic coverage');
    expect(lines.slice(2)).toEqual([
      'C 0.000000 0.000000 0.000000',
      'H 0.000000 0.000000 1.089000',
      'H 1.025000 0.000000 -0.362000',
      'H -0.512000 0.888000 -0.362000',
    ]);

    const atoms = lines.slice(2).map((line) => {
      const [element, x, y, z] = line.split(/\s+/);
      return { element, x: Number(x), y: Number(y), z: Number(z) };
    });
    expect(atoms).toHaveLength(final.atoms.length);
    atoms.forEach((atom, index) => {
      expect(atom.element).toBe(final.atoms[index].element);
      expect(atom.x).toBeCloseTo(final.atoms[index].x, 6);
      expect(atom.y).toBeCloseTo(final.atoms[index].y, 6);
      expect(atom.z).toBeCloseTo(final.atoms[index].z, 6);
    });
  });

  it('falls back to the Input orientation when no Standard table was printed', () => {
    const parsedInputOnly = parseGaussianOutput([
      ' FIXTURE OUTPUT — synthetic, not a real calculation',
      ' #P HF/STO-3G SP',
      '',
      ' Input orientation:',
      ' ---------------------------------------------------------------------',
      ' Center     Atomic      Atomic             Coordinates (Angstroms)',
      ' Number     Number       Type             X           Y           Z',
      ' ---------------------------------------------------------------------',
      '      1          8           0        0.000000    0.000000    0.117300',
      ' ---------------------------------------------------------------------',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(parsedInputOnly.geometry.standard).toBeNull();
    expect(parsedInputOnly.finalGeometry.source).toBe('input');
    expect(parsedInputOnly.finalGeometry.atoms[0].element).toBe('O');
  });

  it('refuses to write an XYZ for an empty geometry', () => {
    expect(() => geometryToXyz(null)).toThrow(TypeError);
    expect(() => geometryToXyz({ atoms: [] })).toThrow(TypeError);
  });
});

describe('per-step SCF records and optimisation convergence', () => {
  it('records one SCF record per optimisation step with absolute line numbers', () => {
    const link = parsed.links[0];
    expect(link.steps).toHaveLength(2);
    expect(link.steps[0].scf.records).toHaveLength(1);
    expect(link.steps[0].scf.records[0]).toMatchObject({
      energyHartree: -100.49,
      cycles: 9,
      method: 'RB3LYP',
    });
    expect(link.steps[1].scf.records[0].energyHartree).toBeCloseTo(-100.5, 9);
    expect(link.steps[1].scf.records[0].cycles).toBe(10);

    // The flattened per-link records are the same two SCF evaluations, in order.
    expect(link.scf.records).toHaveLength(2);
    expect(link.scf.records[0].energyHartree).toBeCloseTo(-100.49, 9);
    expect(link.scf.energyHartree).toBeCloseTo(-100.5, 9);
    expect(link.scf.records[0].line).toBeLessThan(link.scf.records[1].line);
  });

  it('parses the final convergence table, not the first', () => {
    const optimization = parsed.links[0].optimization;
    expect(optimization.completed).toBe(true);
    expect(optimization.stationary).toBe(true);
    expect(optimization.steps).toBe(2);
    expect(optimization.cycles).toBe(2);
    expect(optimization.convergence).toMatchObject({
      maxForce: 0.000015,
      rmsForce: 0.000004,
      maxDisplacement: 0.00006,
      rmsDisplacement: 0.000017,
      thresholds: {
        maxForce: 0.00045,
        rmsForce: 0.0003,
        maxDisplacement: 0.0018,
        rmsDisplacement: 0.0012,
      },
      converged: {
        maxForce: true,
        rmsForce: true,
        maxDisplacement: true,
        rmsDisplacement: true,
      },
      allConverged: true,
      predictedChangeInEnergy: -1.234567e-8,
    });
    expect(optimization.history).toHaveLength(2);
    expect(optimization.history[0].allConverged).toBe(false);
    expect(optimization.history[0].maxForce).toBeCloseTo(0.0012, 9);
  });

  it('exposes the final convergence detail at the root', () => {
    expect(parsed.optimization.steps).toBe(2);
    expect(parsed.optimization.cycles).toBe(2);
    expect(parsed.optimization.convergence.allConverged).toBe(true);
    expect(parsed.optimization.convergence.rmsDisplacement).toBeCloseTo(0.000017, 9);
  });

  it('reports null convergence detail for a job with no optimisation table', () => {
    const frequencyOnly = parseGaussianOutput([
      ' FIXTURE OUTPUT — synthetic, not a real calculation',
      ' SCF Done:  E(RB3LYP) =  -76.0     A.U. after    1 cycles',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(frequencyOnly.optimization.steps).toBeNull();
    expect(frequencyOnly.optimization.convergence).toBeNull();
    expect(frequencyOnly.optimization.completed).toBe(false);
  });
});

describe('frequency block detail', () => {
  const block = parsed.links[0].frequencyBlocks[0];

  it('marks non-finite frequency tokens invalid and fails the frequency gates', () => {
    const bad = parseGaussianOutput([
      ' FIXTURE OUTPUT — synthetic, not a real calculation',
      ' SCF Done:  E(RB3LYP) =  -76.0     A.U. after    1 cycles',
      ' Frequencies --  NaN Inf -0.0000 100.0',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(bad.frequencies.invalid).toBe(true);
    expect(bad.frequencies.invalidTokens).toEqual(['NaN', 'Inf']);
    expect(bad.frequencies.values).toHaveLength(2);
    expect(bad.frequencies.values[0]).toBeCloseTo(0, 9);
    expect(bad.frequencies.values[1]).toBe(100);
    const gates = evaluateGates(bad, { expectedImaginary: 0, requireFrequency: true });
    expect(gates.gates.find((gate) => gate.name === 'Imaginary mode count')?.result).toBe('fail');
    expect(gates.gates.find((gate) => gate.name === 'Frequency record')?.result).toBe('fail');
  });

  it('keeps reduced masses, force constants and IR intensities aligned with the modes', () => {
    expect(block.reducedMasses).toEqual([1.0823, 1.0874, 1.0812, 1.081]);
    expect(block.forceConstants).toEqual([0.2374, 1.6011, 8.4885, 9.0011]);
    expect(block.irIntensities).toEqual([67.2384, 73.4201, 58.9218, 45.12]);
    expect(block.lowModes).toHaveLength(4);
    expect(block.lowModes[0]).toEqual({
      wavenumber: 610,
      reducedMass: 1.0823,
      forceConstant: 0.2374,
      irIntensity: 67.2384,
    });
  });

  it('parses the low-frequency line and the ten lowest modes', () => {
    expect(block.lowFrequencies).toEqual([-0.0006, -0.0004, 0.001, 2.9999, 8.5]);
    expect(block.lowest).toEqual([610, 1580, 3650, 3760]);
  });
});

describe('population analysis, dipole, T1 and resources', () => {
  it('parses Mulliken charges including spin densities', () => {
    expect(parsed.charges.mulliken).toHaveLength(4);
    expect(parsed.charges.mulliken[0]).toEqual({
      atom: 1,
      element: 'C',
      charge: -0.12,
      spinDensity: 0,
    });
    expect(parsed.charges.mulliken[3].charge).toBeCloseTo(0.05, 9);
  });

  it('parses Löwdin charges', () => {
    expect(parsed.charges.lowdin).toHaveLength(4);
    expect(parsed.charges.lowdin[0]).toEqual({
      atom: 1,
      element: 'C',
      charge: -0.1,
      spinDensity: null,
    });
  });

  it('parses NBO natural charges with the core/valence breakdown', () => {
    expect(parsed.charges.nbo).toHaveLength(4);
    expect(parsed.charges.nbo[0]).toEqual({
      element: 'C',
      atom: 1,
      charge: -0.11,
      core: 1.99973,
      valence: 4.1,
      rydberg: 0,
      total: 6.1,
    });
  });

  it('parses ESP charges', () => {
    expect(parsed.charges.esp).toHaveLength(4);
    expect(parsed.charges.esp[0].charge).toBeCloseTo(-0.08, 9);
  });

  it('parses the dipole moment in Debye', () => {
    expect(parsed.charges.dipole).toEqual({ x: 0, y: 0, z: 0.1234, total: 0.1234 });
  });

  it('parses the T1 diagnostic', () => {
    expect(parsed.t1Diagnostic).toBeCloseTo(0.012345, 9);
    expect(parsed.links[0].t1Diagnostic).toBeCloseTo(0.012345, 9);
  });

  it('parses NBasis and the resource lines per link', () => {
    expect(parsed.resources).toEqual({
      nBasis: 34,
      basisFunctions: 34,
      primitiveGaussians: 60,
      processors: 4,
      memory: '4GB',
      cpuSeconds: 1.2,
      elapsedSeconds: 1.5,
    });
    expect(parsed.links[0].resources.nBasis).toBe(34);
  });

  it('parses the real Gaussian "Will use up to N processors" line', () => {
    // Regression: the parser once matched a synthetic phrase ("the tester use
    // up to"), which no real log prints, so processors were always null.
    const real = parseGaussianOutput([
      ' FIXTURE OUTPUT — synthetic, not a real calculation',
      ' Will use up to    8 processors via shared memory.',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(real.resources.processors).toBe(8);

    const twelve = parseGaussianOutput([
      ' Will use up to   12 processors via shared memory.',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(twelve.resources.processors).toBe(12);
  });

  it('keeps population records scoped to the link that printed them', () => {
    expect(parsed.links[0].charges.mulliken).toHaveLength(4);
    expect(parsed.links[0].charges.dipole.total).toBeCloseTo(0.1234, 9);
    expect(parsed.links[0].error).toBeNull();
  });

  it('returns empty population arrays and null fields when no block was printed', () => {
    const plain = parseGaussianOutput([
      ' FIXTURE OUTPUT — synthetic, not a real calculation',
      ' SCF Done:  E(RB3LYP) =  -76.0     A.U. after    1 cycles',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(plain.charges).toEqual({ mulliken: [], lowdin: [], nbo: [], esp: [], dipole: null });
    expect(plain.t1Diagnostic).toBeNull();
    expect(plain.resources).toEqual({
      nBasis: null,
      basisFunctions: null,
      primitiveGaussians: null,
      processors: null,
      memory: null,
      cpuSeconds: null,
      elapsedSeconds: null,
    });
  });
});

describe('error termination cause', () => {
  const errorText = readFileSync(
    fileURLToPath(new URL('./fixtures/synthetic-error-termination.out', import.meta.url)),
    'utf8',
  );
  const errorParsed = parseGaussianOutput(errorText);

  it('labels the fixture synthetic before any Gaussian-looking record', () => {
    const firstLine = errorText.split('\n')[0];
    expect(firstLine).toContain('FIXTURE OUTPUT');
    expect(firstLine.toLowerCase()).toContain('synthetic');
    expect(firstLine).not.toContain('Entering Gaussian');
  });

  it('captures the actionable lines preceding Error termination', () => {
    expect(errorParsed.status).toBe('error');
    expect(errorParsed.termination).toBe('Error termination');
    expect(errorParsed.errorTermination).toMatchObject({
      cause: 'Convergence failure -- run terminated.',
      linkIndex: 0,
    });
    expect(errorParsed.errorTermination.lines).toEqual([
      '>>>>>>>>>> Convergence criterion not met.',
      'Convergence failure -- run terminated.',
    ]);
    expect(errorParsed.errorTermination.terminationLine).toContain('l502.exe');
    expect(errorParsed.links[0].error.cause).toBe('Convergence failure -- run terminated.');
  });

  it('marks the SCF record failed and fails the normal-termination gate', () => {
    expect(errorParsed.scf.status).toBe('failed');
    expect(errorParsed.scf.failure).toBe('Convergence failure -- run terminated.');
    const gates = evaluateGates(errorParsed, {});
    expect(gates.overall).toBe('fail');
    expect(gates.gates.find((gate) => gate.name === 'Normal termination').result).toBe('fail');
    expect(gates.gates.find((gate) => gate.name === 'SCF record').result).toBe('fail');
  });

  it('leaves errorTermination null on a clean log', () => {
    expect(parsed.errorTermination).toBeNull();
    expect(parsed.links[0].error).toBeNull();
  });
});
