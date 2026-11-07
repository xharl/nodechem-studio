import { describe, it, expect } from 'vitest';
import { parseGaussianOutput, evaluateGates } from '../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

describe('Gaussian output parser', () => {
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
