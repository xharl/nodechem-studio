import { describe, it, expect } from 'vitest';
import { parseGaussianOutput, evaluateGates, outputEvidence } from '../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

describe('Gaussian output parser', () => {
  it('labels a fixture as synthetic before any Gaussian-looking line', () => {
    const firstLine = makeFixtureOutput().split('\n')[0];
    expect(firstLine).toContain('FIXTURE OUTPUT');
    expect(firstLine).not.toContain('Entering Gaussian');
  });

  it('recognises a normal termination, SCF record and frequencies', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput({ imaginary: 0 }));
    expect(parsed.status).toBe('completed');
    expect(parsed.termination).toBe('Normal termination of Gaussian');
    expect(parsed.scf.status).toBe('converged');
    expect(parsed.scf.energyHartree).toBeCloseTo(-76.0);
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.frequencies.count).toBe(4);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-76.02);
  });

  it('recognises an error termination and does not treat it as success', () => {
    const parsed = parseGaussianOutput([
      ' SCF Done:  E(RB3LYP) =  -75.0     A.U. after    1 cycles',
      ' Error termination via Lnk1e in C:\\G16W\\l502.exe',
    ].join('\n'));
    expect(parsed.status).toBe('error');
    expect(parsed.termination).toBe('Error termination');
  });

  it('counts imaginary modes from a frequency line', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput({ imaginary: 1 }));
    expect(parsed.frequencies.imaginaryCount).toBe(1);
    expect(parsed.frequencies.minImaginary).toBeLessThan(0);
  });

  it('marks a missing termination marker as incomplete', () => {
    const parsed = parseGaussianOutput('SCF Done:  E(RB3LYP) = -75.0 A.U. after 1 cycles');
    expect(parsed.status).toBe('incomplete');
    expect(parsed.termination).toBe('No termination marker');
  });
});

describe('run gates', () => {
  it('passes a clean frequency result when no imaginary mode is expected', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput({ imaginary: 0 }));
    const result = evaluateGates(parsed, { expectedImaginary: 0, requireFrequency: true });
    expect(result.overall).toBe('pass');
    expect(result.gates.every((gate) => gate.result === 'pass')).toBe(true);
  });

  it('fails a saddle when the wrong number of imaginary modes is found', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput({ imaginary: 0 }));
    const result = evaluateGates(parsed, { expectedImaginary: 1, minMagnitude: 50 });
    expect(result.overall).toBe('fail');
    expect(result.gates.find((gate) => gate.name === 'Imaginary mode count').result).toBe('fail');
  });

  it('fails a saddle below the magnitude floor', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput({ imaginary: 1 }));
    const result = evaluateGates(parsed, { expectedImaginary: 1, minMagnitude: 500 });
    expect(result.overall).toBe('fail');
    expect(result.gates.find((gate) => gate.name === 'Imaginary magnitude').result).toBe('fail');
  });

  it('returns unknown when the output has no termination marker', () => {
    const parsed = parseGaussianOutput('no useful records');
    const result = evaluateGates(parsed, {});
    expect(result.overall).toBe('unknown');
    expect(result.gates.find((gate) => gate.name === 'Normal termination').result).toBe('unknown');
  });

  it('parses a correlated post-HF energy as the final energy', () => {
    const parsed = parseGaussianOutput([
      ' SCF Done:  E(RHF) =  -76.000000000     A.U. after    8 cycles',
      ' CCSD(T)= -76.1234567890D+00',
      ' Normal termination of Gaussian 16 at Fri Nov  7 12:00:00 2026.',
    ].join('\n'));
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.123456789, 6);
    expect(parsed.finalEnergy.source).toBe('post-hf');
  });

  it('falls back to E(CORR) and then the SCF energy', () => {
    const corr = parseGaussianOutput([
      ' SCF Done:  E(RB3LYP) =  -76.100000000     A.U. after    8 cycles',
      ' E(CORR)= -76.2000000000D+00',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(corr.finalEnergy).toEqual({ hartree: -76.2, source: 'post-hf' });

    const scf = parseGaussianOutput([
      ' SCF Done:  E(RB3LYP) =  -76.000000000     A.U. after    8 cycles',
      ' Normal termination of Gaussian 16',
    ].join('\n'));
    expect(scf.finalEnergy).toEqual({ hartree: -76, source: 'scf' });
  });

  it('evaluates the final-energy gate as pass or unknown, never fail-on-missing-silence', () => {
    const withEnergy = parseGaussianOutput(makeFixtureOutput());
    expect(evaluateGates(withEnergy, { requireFinalEnergy: true }).overall).toBe('pass');

    const withoutEnergy = parseGaussianOutput(' Normal termination of Gaussian 16\n');
    const result = evaluateGates(withoutEnergy, { requireFinalEnergy: true });
    expect(result.overall).toBe('unknown');
    expect(result.gates.find((gate) => gate.name === 'Final energy record').result).toBe('unknown');
  });
});

describe('output completeness', () => {
  it('records a complete parse and the byte range it read', () => {
    const text = makeFixtureOutput();
    const size = Buffer.byteLength(text, 'utf8');
    const parsed = parseGaussianOutput(text, {
      byteRange: {
        size,
        bytesRead: size,
        windows: [{ name: 'full', start: 0, end: size, bytes: size, supplied: ['termination'] }],
      },
    });
    expect(parsed.complete).toBe(true);
    expect(parsed.bytes).toEqual({
      size,
      bytesRead: size,
      truncated: false,
      windows: [{ name: 'full', start: 0, end: size, bytes: size, supplied: ['termination'] }],
    });
    expect(evaluateGates(parsed, { expectedImaginary: 0 }).overall).toBe('pass');
  });

  it('marks a truncated parse incomplete and refuses to pass any gate', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput(), {
      truncated: true,
      byteRange: {
        size: 52_428_800,
        bytesRead: 33_554_432,
        windows: [
          { name: 'head', start: 0, end: 1_048_576, bytes: 1_048_576, supplied: ['banner', 'route'] },
          { name: 'tail', start: 18_874_368, end: 52_428_800, bytes: 33_554_432, supplied: ['termination', 'scf'] },
        ],
      },
    });
    expect(parsed.complete).toBe(false);
    const result = evaluateGates(parsed, {
      expectedImaginary: 0,
      requireOptimization: true,
      requireFrequency: true,
      requireThermochemistry: true,
      requireFinalEnergy: true,
    });
    expect(result.overall).toBe('unknown');
    expect(result.complete).toBe(false);
    const gate = result.gates.find((entry) => entry.name === 'Output complete');
    expect(gate).toMatchObject({ required: true, result: 'unknown' });
    expect(gate.detail).toContain('33554432 of 52428800 bytes');
  });

  it('treats a byte range that stops short of the file as partial even when the flag is missing', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput(), {
      byteRange: { size: 1000, bytesRead: 400 },
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.bytes.truncated).toBe(true);
  });

  it('never lets a parse without a completeness record pass', () => {
    const parsed = parseGaussianOutput(makeFixtureOutput());
    const withoutCompleteness = { ...parsed };
    delete withoutCompleteness.complete;
    expect(evaluateGates(withoutCompleteness, { expectedImaginary: 0 }).overall).toBe('unknown');
    expect(evaluateGates({ ...parsed, complete: false }, { expectedImaginary: 0 }).overall).toBe('unknown');
    expect(evaluateGates(parsed, { expectedImaginary: 0 }).overall).toBe('pass');
  });

  it('names the evidence each window can supply', () => {
    expect(outputEvidence(makeFixtureOutput())).toEqual([
      'banner', 'route', 'geometry', 'scf', 'optimization', 'frequencies', 'thermochemistry', 'termination',
    ]);
    expect(outputEvidence('')).toEqual([]);
    expect(outputEvidence('no records here')).toEqual([]);
  });
});

/* Issue #77: the composite energy, never a component energy. */
describe('composite method output and gates', () => {
  const synthetic = (lines) => [
    '! FIXTURE OUTPUT — synthetic Gaussian-shaped log, not a licensed Gaussian run',
    ...lines,
  ].join('\n');

  it('reads the CBS-QB3 summary and reports its 0 K energy as the final energy', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p CBS-QB3',
      '',
      ' CBS-QB3 on water',
      '',
      ' 0 1',
      ' O 0.0 0.0 0.0',
      ' SCF Done:  E(RB3LYP) =  -76.400000000     A.U. after   10 cycles',
      ' CBS-QB3 (0 K)=        -39.069832 CBS-QB3 Energy=           -39.066969',
      ' CBS-QB3 Enthalpy=     -39.066025 CBS-QB3 Free Energy=      -39.088192',
      ' Normal termination of Gaussian 16',
    ]));
    expect(parsed.composite).toMatchObject({
      expected: 'CBS-QB3',
      method: 'CBS-QB3',
      zeroPointEnergyHartree: -39.069832,
      thermalEnergyHartree: -39.066969,
      enthalpyHartree: -39.066025,
      freeEnergyHartree: -39.088192,
    });
    expect(parsed.finalEnergy).toEqual({ hartree: -39.069832, source: 'composite:CBS-QB3' });
    const gate = evaluateGates(parsed, {}).gates.find((entry) => entry.name === 'Composite energy');
    expect(gate.result).toBe('pass');
  });

  it('reads G4(MP2) as G4MP2 in the route and in the summary', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p G4MP2',
      ' SCF Done:  E(RB3LYP) =  -76.500000000     A.U. after   10 cycles',
      ' G4(MP2)(0 K)=   -76.450000000 G4(MP2) Energy=   -76.447000000',
      ' G4(MP2) Enthalpy=   -76.446000000 G4(MP2) Free Energy=   -76.468000000',
      ' Normal termination of Gaussian 16',
    ]));
    expect(parsed.composite.expected).toBe('G4(MP2)');
    expect(parsed.composite.method).toBe('G4(MP2)');
    expect(parsed.composite.keyword).toBe('G4MP2');
    expect(parsed.finalEnergy.source).toBe('composite:G4(MP2)');
    expect(evaluateGates(parsed, { requireComposite: 'G4(MP2)' }).gates
      .find((entry) => entry.name === 'Composite energy').result).toBe('pass');
  });

  /*
   * This is the regression test for the bug the issue describes: a composite
   * block whose log carries only component SCF/CCSD energies used to report
   * the last one as the final energy and pass the final-energy gate.
   */
  it('refuses to report a component energy when the composite summary is missing', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p G4',
      '',
      ' G4 on water',
      '',
      ' 0 1',
      ' O 0.0 0.0 0.0',
      ' SCF Done:  E(RB3LYP) =  -76.400000000     A.U. after   10 cycles',
      ' CCSD(T)= -76.4200000000D+00',
      ' Normal termination of Gaussian 16',
    ]));
    // The parser must not fall back to the SCF or the CCSD(T) component.
    expect(parsed.finalEnergy).toEqual({ hartree: null, source: null });
    expect(parsed.composite).toMatchObject({ expected: 'G4', found: false });

    const result = evaluateGates(parsed, { requireFinalEnergy: true });
    const compositeGate = result.gates.find((entry) => entry.name === 'Composite energy');
    expect(compositeGate.result).toBe('fail');
    expect(compositeGate.detail).toMatch(/component link, not the composite result/);
    expect(result.gates.find((entry) => entry.name === 'Final energy record').result).toBe('unknown');
    expect(result.overall).toBe('fail');
  });

  it('fails a composite block whose log printed a different composite method', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p G4',
      ' SCF Done:  E(RB3LYP) =  -76.400000000     A.U. after   10 cycles',
      ' G3(0 K)=   -76.410000000 G3 Energy=   -76.407000000',
      ' Normal termination of Gaussian 16',
    ]));
    expect(parsed.composite.method).toBe('G3');
    expect(evaluateGates(parsed, {}).gates.find((entry) => entry.name === 'Composite energy').result).toBe('fail');
  });

  it('marks an incomplete composite log as not evaluated rather than failed or passed', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p G4',
      ' SCF Done:  E(RB3LYP) =  -76.400000000     A.U. after   10 cycles',
    ]), { truncated: true });
    const gate = evaluateGates(parsed, {}).gates.find((entry) => entry.name === 'Composite energy');
    expect(gate.result).toBe('unknown');
    expect(evaluateGates(parsed, {}).overall).toBe('unknown');
  });

  /*
   * Issue #373: the `(0 K)` matcher is a module constant and the three term
   * matchers are memoised per method, so a longer summary must not compile more
   * RegExp objects. Counting constructions is the observable form of "reused":
   * a matcher rebuilt per line makes the repeated block cost more than the
   * single one, which is exactly the regression this pins.
   */
  it('compiles no RegExp per summary line', () => {
    const summary = [
      ' CBS-QB3 (0 K)=        -39.069832 CBS-QB3 Energy=           -39.066969',
      ' CBS-QB3 Enthalpy=     -39.066025 CBS-QB3 Free Energy=      -39.088192',
    ];
    const single = synthetic([...summary, ' Normal termination of Gaussian 16']);
    const repeated = synthetic([
      ...Array.from({ length: 40 }, () => summary).flat(),
      ' Normal termination of Gaussian 16',
    ]);

    const countRegExpConstructions = (text) => {
      const RealRegExp = RegExp;
      let constructions = 0;
      class CountingRegExp extends RealRegExp {
        constructor(...args) {
          super(...args);
          constructions += 1;
        }
      }
      globalThis.RegExp = CountingRegExp;
      try {
        parseGaussianOutput(text);
      } finally {
        globalThis.RegExp = RealRegExp;
      }
      return constructions;
    };

    // Warm the per-method matcher cache so the two counts compare like with like.
    countRegExpConstructions(single);
    expect(countRegExpConstructions(repeated)).toBe(countRegExpConstructions(single));

    const one = parseGaussianOutput(single).composite;
    const many = parseGaussianOutput(repeated).composite;
    expect(many).toEqual({ ...one, line: one.line + 39 * summary.length });
  });

  /*
   * A G2 job prints G1 lines before its own. The memo is keyed by method id, so
   * the last block wins with G2's labels; a single shared entry would read G2's
   * terms with G1's label and leave them null.
   */
  it('keeps the terms of a G1-then-G2 summary separate', () => {
    // Warm the memo with G1 alone: a cache keyed by anything but the method id
    // would answer G2's summary with G1's labels and lose its terms.
    parseGaussianOutput(synthetic([
      ' #p G1',
      ' G1(0 K)=   -76.300000000 G1 Energy=   -76.297000000',
      ' G1 Enthalpy=   -76.296000000 G1 Free Energy=   -76.318000000',
      ' Normal termination of Gaussian 16',
    ]));
    const g2 = parseGaussianOutput(synthetic([
      ' #p G2',
      ' G1(0 K)=   -76.300000000 G1 Energy=   -76.297000000',
      ' G1 Enthalpy=   -76.296000000 G1 Free Energy=   -76.318000000',
      ' G2(0 K)=   -76.410000000 G2 Energy=   -76.407000000',
      ' G2 Enthalpy=   -76.406000000 G2 Free Energy=   -76.428000000',
      ' Normal termination of Gaussian 16',
    ])).composite;
    expect(g2).toMatchObject({
      method: 'G2',
      zeroPointEnergyHartree: -76.41,
      thermalEnergyHartree: -76.407,
      enthalpyHartree: -76.406,
      freeEnergyHartree: -76.428,
    });
  });
});

/* Issue #77: counterpoise block parsing and BSSE. */
describe('counterpoise output', () => {
  const synthetic = (lines) => [
    '! FIXTURE OUTPUT — synthetic Gaussian-shaped log, not a licensed Gaussian run',
    ...lines,
  ].join('\n');

  const COUNTERPOISE_BLOCK = [
    ' #p B3LYP/6-31G(d) SP Counterpoise=2',
    '',
    ' water dimer',
    '',
    ' 0 1',
    ' O(Fragment=1) 0.0 0.0 0.0',
    ' Counterpoise corrected energy =    -622.483714884838',
    '                  BSSE energy =       0.005664641553',
    '             sum of fragments =    -622.333463706103',
    '          complexation energy =     -97.84 kcal/mole (raw)',
    '          complexation energy =     -94.28 kcal/mole (corrected)',
    ' Normal termination of Gaussian 16',
  ];

  it('parses the corrected complex, monomer sum, BSSE and both interaction energies', () => {
    const parsed = parseGaussianOutput(synthetic(COUNTERPOISE_BLOCK));
    expect(parsed.counterpoise).toMatchObject({
      fragments: 2,
      found: true,
      complexEnergyHartree: -622.483714884838,
      monomerSumHartree: -622.333463706103,
      bsseHartree: 0.005664641553,
      bsseSource: 'printed',
      rawInteractionKcalPerMol: -97.84,
      correctedInteractionKcalPerMol: -94.28,
    });
    expect(parsed.counterpoise.bsseKcalPerMol).toBeCloseTo(3.5546, 4);
    expect(parsed.counterpoise.interactionCorrectedHartree).toBeCloseTo(-0.1502447, 6);
    expect(parsed.finalEnergy).toEqual({
      hartree: -622.483714884838,
      source: 'counterpoise-corrected',
    });
  });

  it('accepts the older Counterpoise: prefix', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p B3LYP/6-31G(d) Counterpoise=2',
      ' Counterpoise: corrected energy = -2660.083831739527',
      ' Counterpoise: BSSE energy = 0.003902746890',
      ' Normal termination of Gaussian 16',
    ]));
    expect(parsed.counterpoise.complexEnergyHartree).toBeCloseTo(-2660.083831739527, 10);
    expect(parsed.counterpoise.bsseHartree).toBeCloseTo(0.003902746890, 12);
  });

  it('records a requested Counterpoise route even when the summary is missing', () => {
    const parsed = parseGaussianOutput(synthetic([
      ' #p B3LYP/6-31G(d) SP Counterpoise=2',
      ' SCF Done:  E(RB3LYP) =  -622.400000000     A.U. after   10 cycles',
      ' Normal termination of Gaussian 16',
    ]));
    expect(parsed.counterpoise).toMatchObject({ fragments: 2, found: false, bsseHartree: null });
    // The route requested a correction but the block is missing: the raw SCF
    // energy must not be reported as the corrected answer.
    expect(parsed.finalEnergy).toEqual({ hartree: null, source: null });
  });
});
