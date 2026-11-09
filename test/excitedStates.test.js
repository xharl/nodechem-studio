/**
 * Excited-state optimisation parser (#146).
 *
 * THE TEXT BELOW IS SYNTHETIC. It is fabricated in the Gaussian 16 output shape
 * to test the *parser*, not to claim a calculation: no real `Opt TD` log exists
 * in this repository, and the parser therefore reports `verified: false`.
 * Numbers in it are illustrative only. The real TD single-point fixture
 * (`test/fixtures/real/g16-dvb-td.out`) is used separately to confirm the
 * table-line format this text imitates.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  UNVERIFIED_ESOPT_NOTE,
  excitedStateGate,
  parseExcitedStateOptimization,
} from '../src/shared/excitedStates.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';

const SYNTHETIC_ESOPT = [
  ' Entering Gaussian System, Link 0=g16',
  ' %chk=esopt.chk',
  ' %mem=4GB',
  ' %nprocshared=4',
  ' #p B3LYP/6-31G(d) Opt TD=(NStates=3,Root=1)',
  '',
  ' ethylene S1 optimisation (synthetic format fixture)',
  '',
  ' 0 1',
  ' C    0.000000     0.000000     0.669500',
  ' C    0.000000     0.000000    -0.669500',
  ' H    0.000000     0.928900     1.238000',
  ' H    0.000000    -0.928900     1.238000',
  ' H    0.000000     0.928900    -1.238000',
  ' H    0.000000    -0.928900    -1.238000',
  '',
  ' SCF Done:  E(RB3LYP) =  -78.587458000     A.U. after   10 cycles',
  '',
  ' Excitation energies and oscillator strengths:',
  ' Excited State   1:      Singlet-B1U     5.3351 eV  232.39 nm  f=0.1707  <S**2>=0.000',
  '      12 -> 15         0.70123',
  ' This state for optimization and/or second-order correction.',
  ' Total Energy, E(TD-HF/TD-DFT) =  -78.351205281',
  ' Copying the excited state density for this state as the 1-particle RhoCI density.',
  ' Excited State   2:      Singlet-B1U     5.3746 eV  230.68 nm  f=0.6779  <S**2>=0.000',
  '      11 -> 15         0.51234',
  ' Excited State   3:      Singlet-AG      6.2152 eV  199.49 nm  f=0.0000  <S**2>=0.000',
  '      12 -> 16         0.49876',
  '',
  ' Step number   1',
  ' SCF Done:  E(RB3LYP) =  -78.588001000     A.U. after    9 cycles',
  '',
  ' Excitation energies and oscillator strengths:',
  ' Excited State   1:      Singlet-B1U     5.2104 eV  237.95 nm  f=0.1822  <S**2>=0.000',
  '      12 -> 15         0.70011',
  ' This state for optimization and/or second-order correction.',
  ' Total Energy, E(TD-HF/TD-DFT) =  -78.352001123',
  ' Excited State   2:      Singlet-B1U     5.3010 eV  233.88 nm  f=0.6600  <S**2>=0.000',
  '      11 -> 15         0.50111',
  ' Excited State   3:      Singlet-AG      6.1000 eV  203.26 nm  f=0.0000  <S**2>=0.000',
  '      12 -> 16         0.49111',
  '',
  ' Step number   2',
  ' SCF Done:  E(RB3LYP) =  -78.588444000     A.U. after    8 cycles',
  '',
  ' Excitation energies and oscillator strengths:',
  ' Excited State   1:      Singlet-B1U     5.1012 eV  243.05 nm  f=0.1901  <S**2>=0.000',
  '      12 -> 15         0.69999',
  ' This state for optimization and/or second-order correction.',
  ' Total Energy, E(TD-HF/TD-DFT) =  -78.353112000',
  ' Excited State   2:      Singlet-B1U     5.2000 eV  238.43 nm  f=0.6500  <S**2>=0.000',
  '      11 -> 15         0.50001',
  ' Excited State   3:      Singlet-AG      6.0000 eV  206.65 nm  f=0.0000  <S**2>=0.000',
  '      12 -> 16         0.48888',
  '',
  ' Optimization completed.',
  '    -- Stationary point found.',
  '',
  ' Normal termination of Gaussian 16 at Mon Nov  9 10:00:00 2026.',
].join('\n');

/** The same text with its prologue and first step cut off — a head window. */
const TRUNCATED_ESOPT = (() => {
  const first = SYNTHETIC_ESOPT.indexOf('Excitation energies');
  const second = SYNTHETIC_ESOPT.indexOf('Excitation energies', first + 1);
  return SYNTHETIC_ESOPT.slice(second);
})();

const STOPPED_ESOPT = SYNTHETIC_ESOPT
  .replace(' Optimization completed.', ' Optimization stopped.')
  .replace('    -- Stationary point found.', ' -- Number of steps exceeded,  NStep= 20');

describe('parseExcitedStateOptimization — synthetic format fixture', () => {
  const report = parseExcitedStateOptimization(SYNTHETIC_ESOPT);

  it('reads the root the log names and every step of its ladder', () => {
    expect(report.root).toBe(1);
    expect(report.rootSource).toBe('marker');
    expect(report.steps).toHaveLength(3);
    expect(report.steps.map((step) => step.energyEv)).toEqual([5.3351, 5.2104, 5.1012]);
    expect(report.steps.map((step) => step.energyHartree))
      .toEqual([-78.351205281, -78.352001123, -78.353112]);
    expect(report.steps.map((step) => step.tableIndex)).toEqual([1, 2, 3]);
    // A per-step geometry is not parsed: the format is unverified and a guessed
    // atom list would be worse than an explicit null.
    expect(report.steps.every((step) => step.geometry === null)).toBe(true);
  });

  it('reports convergence only because the completion marker and the root are both present', () => {
    expect(report.converged).toBe(true);
    expect(report.convergedReason).toMatch(/Optimization completed/);
    expect(report.truncated).toBe(false);
    expect(report.applicable).toBe(true);
    expect(report.evidence.some((entry) => entry.kind === 'optimization-completed')).toBe(true);
  });

  it('keeps the final table and marks the root row', () => {
    expect(report.finalTable.states).toHaveLength(3);
    expect(report.finalTable.states[0]).toMatchObject({
      index: 1,
      energyEv: 5.1012,
      wavelengthNm: 243.05,
      oscillatorStrength: 0.1901,
    });
    expect(report.finalTable.states[0].transitions).toEqual([{ from: 12, to: 15, coefficient: 0.69999 }]);
  });

  it('never claims verification: no real Opt TD log has been seen', () => {
    expect(report.verified).toBe(false);
    expect(UNVERIFIED_ESOPT_NOTE).toBe('this build has not seen a real log for this job type');
  });

  it('honours the requested root and reports it as requested', () => {
    const rootTwo = parseExcitedStateOptimization(SYNTHETIC_ESOPT, { root: 2 });
    expect(rootTwo.root).toBe(2);
    expect(rootTwo.rootSource).toBe('requested');
    expect(rootTwo.steps.map((step) => step.energyEv)).toEqual([5.3746, 5.3010, 5.2000]);
    expect(excitedStateGate(rootTwo, { requestedRoot: 2 }).result).toBe('pass');
  });

  it('marks the report partial when the log starts mid-run', () => {
    const truncated = parseExcitedStateOptimization(TRUNCATED_ESOPT);
    expect(truncated.truncated).toBe(true);
    expect(truncated.converged).toBeNull();
    expect(truncated.convergedReason).toMatch(/does not start at the beginning/);
  });

  it('reports a stopped optimisation as false, not unknown', () => {
    const stopped = parseExcitedStateOptimization(STOPPED_ESOPT);
    expect(stopped.converged).toBe(false);
    expect(excitedStateGate(stopped, { requestedRoot: 1 }).result).toBe('fail');
  });

  it('returns the same shape when the output has no TD record', () => {
    const empty = parseExcitedStateOptimization(' Entering Gaussian System\n Normal termination of Gaussian 16\n');
    expect(empty.applicable).toBe(false);
    expect(empty.converged).toBeNull();
    expect(empty.steps).toEqual([]);
    expect(empty.finalTable).toBeNull();
    expect(excitedStateGate(empty, { requestedRoot: 1 }).result).toBe('unknown');
  });
});

describe('excited-state gate', () => {
  const report = parseExcitedStateOptimization(SYNTHETIC_ESOPT);

  it('passes only when the completion marker and the requested root agree', () => {
    expect(excitedStateGate(report, { requestedRoot: 1 }).result).toBe('pass');
    // A root the final table does not carry cannot be confirmed: unknown, never pass.
    expect(excitedStateGate(report, { requestedRoot: 5 }).result).toBe('unknown');
  });

  it('is unknown on a truncated log even when the tail holds the marker', () => {
    const truncated = parseExcitedStateOptimization(TRUNCATED_ESOPT, { root: 1 });
    expect(truncated.converged).toBeNull();
    const gate = excitedStateGate(truncated, { requestedRoot: 1 });
    expect(gate.result).toBe('unknown');
    expect(gate.detail).toMatch(/partial/);
  });

  it('says the format is unverified in every verdict', () => {
    for (const result of [
      excitedStateGate(report, { requestedRoot: 1 }),
      excitedStateGate(null),
    ]) {
      expect(result.name).toBe('excited-state');
      expect(result.required).toBe(true);
    }
    expect(excitedStateGate(report, { requestedRoot: 1 }).detail).toMatch(/unverified/);
  });
});

describe('integration with the Gaussian parser', () => {
  it('exposes the report on PARSED output without inventing verification', () => {
    const parsed = parseGaussianOutput(SYNTHETIC_ESOPT);
    expect(parsed.excitedStateOptimization).toBeTruthy();
    expect(parsed.excitedStateOptimization.verified).toBe(false);
    expect(parsed.excitedStateOptimization.root).toBe(1);
    expect(parsed.excitedStateOptimization.converged).toBe(true);
  });

  it('does not mistake the real single-point TD fixture for an optimisation', () => {
    // `test/fixtures/real/g16-dvb-td.out` is a real SP: it carries an excitation
    // table and even the "This state for optimization" line, but its route has
    // no Opt keyword and it printed no ladder. The report is not applicable and
    // the gate must not read that as a failure.
    const realText = readFileSync(
      fileURLToPath(new URL('./fixtures/real/g16-dvb-td.out', import.meta.url)),
      'utf8',
    );
    const real = parseGaussianOutput(realText);
    expect(real.excitedStateOptimization.applicable).toBe(false);
    expect(real.excitedStateOptimization.converged).toBeNull();
    expect(excitedStateGate(real.excitedStateOptimization, { requestedRoot: 1 }).result).toBe('unknown');
  });
});
