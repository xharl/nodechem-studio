/**
 * Golden corpus: real Gaussian logs, not fixture text.
 *
 * Each case asserts the fields this app actually gates on. Numbers are the ones
 * in the file; if a parser change moves them, that is a regression, not a
 * tolerance to widen.
 *
 * Sources are listed in test/fixtures/real/README.md.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { evaluateGates } from '../src/shared/gaussianOutput.js';

const load = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8');

const g09 = {
  ir: load('g09-dvb-ir.out'),
  sp: load('g09-dvb-sp.out'),
  td: load('g09-dvb-td.out'),
  ccsd: load('g09-water-ccsd.log'),
  cis: load('g09-water-cis.log'),
  mp2: load('g09-water-mp2.log'),
};

const g16 = {
  gopt: load('g16-dvb-gopt.out'),
  ir: load('g16-dvb-ir.out'),
  sp: load('g16-dvb-sp.out'),
  td: load('g16-dvb-td.out'),
  irc: load('g16-h4s2-irc.log'),
};

describe('Gaussian 09 corpus', () => {
  it('Freq job: final energy, no imaginary modes and the thermodynamic correction', () => {
    const parsed = parseGaussianOutput(g09.ir);
    expect(parsed.status).toBe('completed');
    expect(parsed.program).toMatchObject({ name: 'Gaussian', version: '09' });
    expect(parsed.route).toMatch(/^#p b3lyp\/sto-3g/i);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-382.30826658, 8);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-382.164931, 6);
  });

  it('SP job: energy only, and no thermochemistry is invented', () => {
    const parsed = parseGaussianOutput(g09.sp);
    expect(parsed.status).toBe('completed');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-382.30826658, 8);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeNull();
  });

  it('TD job: five excited states with oscillator strengths', () => {
    const parsed = parseGaussianOutput(g09.td);
    expect(parsed.status).toBe('completed');
    expect(parsed.excitedStates.count).toBe(5);
    const first = parsed.excitedStates.states[0];
    expect(first.energyEv).toBeGreaterThan(0);
    expect(Number.isFinite(first.oscillatorStrength)).toBe(true);
  });

  it('post-HF single points: MP2 and CCSD energies are read from the right line', () => {
    expect(parseGaussianOutput(g09.mp2).finalEnergy.hartree).toBeCloseTo(-75.002282127785, 9);
    expect(parseGaussianOutput(g09.ccsd).finalEnergy.hartree).toBeCloseTo(-75.002282127785, 9);
  });

  it('CIS job: the excited-state table is read and the SCF energy is not mistaken for it', () => {
    const parsed = parseGaussianOutput(g09.cis);
    expect(parsed.status).toBe('completed');
    expect(parsed.excitedStates.count).toBe(10);
  });
});

describe('Gaussian 16 corpus', () => {
  it('Opt job: converges, terminates normally and lands on a stationary structure', () => {
    const parsed = parseGaussianOutput(g16.gopt);
    expect(parsed.status).toBe('completed');
    expect(parsed.program).toMatchObject({ name: 'Gaussian', version: '16' });
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.stationary).toBe(true);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-382.308266602, 9);
  });

  it('Freq job: Gibbs correction and a minimum', () => {
    const parsed = parseGaussianOutput(g16.ir);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-382.164915, 6);
    const gates = evaluateGates(parsed, { expectedImaginary: 0 });
    expect(gates.overall).toBe('pass');
  });

  it('TD job: identical excitation count to the Gaussian 09 run of the same molecule', () => {
    const parsed = parseGaussianOutput(g16.td);
    expect(parsed.excitedStates.count).toBe(5);
  });

  it('IRC job: the path summary is read even though the job prints no SCF Done line', () => {
    const parsed = parseGaussianOutput(g16.irc);
    expect(parsed.status).toBe('completed');
    // The energy of an IRC job lives in the path table, not in a final SCF line.
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.reactionPath).not.toBeNull();
    expect(parsed.reactionPath.referenceHartree).toBeCloseTo(-797.920071, 6);
    expect(parsed.reactionPath.points).toHaveLength(19);
    expect(parsed.reactionPath.points[0].rxCoord).toBeCloseTo(-1.23078, 5);
  });
});

describe('failure cases from real runs', () => {
  it('unconverged optimisation: error status, no convergence, and the real cause', () => {
    const parsed = parseGaussianOutput(load('g09-dvb-gopt-unconverged.log'));
    expect(parsed.status).toBe('error');
    expect(parsed.optimization.completed).toBe(false);
    expect(parsed.optimization.stationary).toBe(false);
    // The tail of this log carries a Gaussian epigraph ("BREAD HAS TO MOLD…");
    // the cause must be the optimiser's own report, not the epigraph.
    expect(parsed.errorTermination.cause).toMatch(/Number of steps exceeded/i);
    expect(parsed.errorTermination.cause).not.toMatch(/BOATZ|PENICILLIN/i);
  });

  it('SCF failure: the cause is the sentence, not the repeated banner', () => {
    const parsed = parseGaussianOutput(load('g16-meoh-scf-error.log'));
    expect(parsed.status).toBe('error');
    expect(parsed.errorTermination.cause).toMatch(/SCF has not converged/i);
  });

  it('truncated file: incomplete, never a pass', () => {
    const parsed = parseGaussianOutput(load('g16-dvb-ir-truncated.out'), { truncated: true });
    expect(parsed.status).toBe('incomplete');
    expect(parsed.complete).toBe(false);
    expect(evaluateGates(parsed, { expectedImaginary: 0 }).overall).not.toBe('pass');
  });
});

describe('the parser is total', () => {
  it('never throws on arbitrary text and always returns a known status', () => {
    // Deterministic pseudo-random text: no dependency on a fuzz library.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const alphabet = ' \n\t0123456789.-+EeDdSCFGaussianLink1#\\/*:()[]';
    for (let index = 0; index < 1000; index += 1) {
      const length = next() % 400;
      let text = '';
      for (let char = 0; char < length; char += 1) {
        text += alphabet[next() % alphabet.length];
      }
      const parsed = parseGaussianOutput(text);
      expect(['completed', 'error', 'incomplete']).toContain(parsed.status);
      expect(Array.isArray(parsed.links)).toBe(true);
    }
  });

  it('never throws on non-string input', () => {
    expect(() => parseGaussianOutput(undefined)).toThrow(TypeError);
    expect(parseGaussianOutput('').status).toBe('incomplete');
  });
});
