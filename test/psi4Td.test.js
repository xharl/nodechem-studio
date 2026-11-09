import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPsi4Input, parsePsi4Output } from '../src/shared/engines/psi4.js';

/**
 * TD-DFT as a Psi4 job type (issue 166).
 *
 * Both fixtures are real Psi4 1.11 runs of the same ethylene/B3LYP/6-31G* job,
 * made here and committed unedited — see `test/fixtures/psi4-td/README.md`. They
 * differ only in how the states were requested, and that difference is the point:
 * with a scalar request Psi4 splits the count across the point group's
 * irreducible representations in point-group order, so asking for 5 states on
 * D2h ethylene returns five states that are all symmetry-dark and never touches
 * B1u — which is the bright π→π*. Asking for two per irrep returns it.
 */

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/psi4-td/${name}`, import.meta.url)), 'utf8');

const WATER = {
  coords: [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.757, z: -0.4692 },
    { element: 'H', x: 0, y: -0.757, z: -0.4692 },
  ],
  charge: 0,
  multiplicity: 1,
};

const build = (settings) => buildPsi4Input({
  settings: { jobType: 'TD-DFT', method: 'b3lyp', basis: '6-31g(d)', tdStates: 5, reference: 'rhf', ...settings },
  molecule: WATER,
  inputName: 'td.dat',
});

describe('the Psi4 TD-DFT input', () => {
  it('writes tdscf_states and the td- entry point, not a Gaussian keyword', () => {
    const built = build({});
    expect(built.inputText).toContain('set tdscf_states 5');
    expect(built.inputText).toContain("energy('td-b3lyp')");
    // `set tda` is not a Psi4 option at all; `nstates` is a Gaussian belief.
    expect(built.inputText).not.toMatch(/set\s+tda\b/);
    expect(built.inputText).not.toMatch(/set\s+nstates\b/);
    expect(built.route).toBe('psi4 B3LYP/6-31G(d) TD-DFT (5 states)');
  });

  it('refuses a method with no excited-state path', () => {
    expect(() => build({ method: 'ccsd' })).toThrow(/single-reference SCF method/i);
    expect(() => build({ method: 'sapt0' })).toThrow(/single-reference SCF method/i);
  });

  it('refuses a TD-DFT block with no state count', () => {
    expect(() => build({ tdStates: undefined })).toThrow(/number of excited states/i);
    expect(() => build({ tdStates: 0 })).toThrow(/number of excited states/i);
    expect(() => build({ tdStates: 51 })).toThrow(/number of excited states/i);
  });

  it('refuses a root, because this build cannot relax an excited surface', () => {
    expect(() => build({ tdRoot: 3 })).toThrow(/cannot optimise on an excited surface in Psi4/i);
    // Root 1 means "the first excited state", which a single point does report.
    expect(() => build({ tdRoot: 1 })).not.toThrow();
  });

  it('refuses the Gaussian-style excited-state flag on a non-TD job', () => {
    expect(() => buildPsi4Input({
      settings: { jobType: 'SP', method: 'b3lyp', basis: '6-31g(d)', tddft: true },
      molecule: WATER,
    })).toThrow(/Excited states in Psi4 are a job type/i);
  });
});

describe('parsing the TDSCF table', () => {
  it('reads the five-state run, and records that Psi4 split it across irreps', () => {
    const parsed = parsePsi4Output(fixture('ethylene-b3lyp-631gd-5states.log'));
    const excited = parsed.excitedStates;

    expect(excited.count).toBe(5);
    expect(excited.requested).toBe(5);
    expect(excited.source).toBe('tdscf');
    expect(excited.verified).toBe(true);
    // Psi4's own "==> Requested Excitations <==" block: one state in each of the
    // first five irreps, none in B1u.
    const split = Object.fromEntries(excited.perIrrep.map((entry) => [entry.irrep, entry.count]));
    expect(split).toEqual({
      Ag: 1, B1g: 1, B2g: 1, B3g: 1, Au: 1, B1u: 0, B2u: 0, B3u: 0,
    });

    // First row of the table, verbatim: 0.31247 au, 8.50279 eV.
    const first = excited.states[0];
    expect(first.index).toBe(1);
    expect(first.from).toBe('Ag');
    expect(first.to).toBe('B1g');
    expect(first.energyHartree).toBeCloseTo(0.31247, 5);
    expect(first.energyEv).toBeCloseTo(8.50279, 5);
    expect(first.wavelengthNm).toBeCloseTo(1239.841984 / 8.50279, 6);
    expect(first.oscillatorStrength).toBe(0);
    expect(first.totalEnergyHartree).toBeCloseTo(-78.27484, 5);
    // The composition block, read from the second half of the log: this state is
    // 1b3g → 1b2g to 98.4 %, with a small mixed-in term of the opposite sign.
    expect(first.spin).toBe('Singlet');
    expect(first.symmetry).toBe('B1g');
    expect(first.transitions).toHaveLength(2);
    expect(first.transitions[0]).toMatchObject({ from: '1b3g', to: '1b2g', coefficient: 0.99215, percent: 98.436 });
    expect(first.transitions[1].coefficient).toBeCloseTo(-0.123542, 6);
  });

  it('shows the price of that split: every state in the five-state run is dark', () => {
    // Not a parser claim — a property of the run, kept as a test so that a later
    // change to the request cannot quietly break it. Ethylene's bright state is
    // B1u (π→π*), and B1u was allocated zero states here.
    const excited = parsePsi4Output(fixture('ethylene-b3lyp-631gd-5states.log')).excitedStates;
    expect(excited.states.every((state) => state.oscillatorStrength < 0.01)).toBe(true);
    expect(excited.states.some((state) => state.irrep === 'B1u')).toBe(false);
  });

  it('reads the sixteen-state run, where the bright state appears', () => {
    const excited = parsePsi4Output(fixture('ethylene-b3lyp-631gd-16states.log')).excitedStates;
    expect(excited.count).toBe(16);
    expect(excited.requested).toBe(16);
    expect(excited.perIrrep.every((entry) => entry.count === 2)).toBe(true);

    const first = excited.states[0];
    expect(first.to).toBe('B1u');
    expect(first.energyEv).toBeCloseTo(8.23612, 5);
    expect(first.oscillatorStrength).toBeCloseTo(0.3501, 4);
    // The strongest transition in the table, and its velocity-form strength, so
    // the two columns are not confused for one another.
    const strongest = excited.states.reduce((best, state) => (
      state.oscillatorStrength > best.oscillatorStrength ? state : best
    ));
    expect(strongest.energyEv).toBeCloseTo(12.69596, 5);
    expect(strongest.oscillatorStrength).toBeCloseTo(0.4183, 4);
    expect(strongest.oscillatorStrengthVelocity).toBeCloseTo(0.4104, 4);
    // A de-excitation is kept as printed, with its direction, not re-oriented.
    const s1 = excited.states[0];
    expect(s1.transitions.map((entry) => `${entry.from}${entry.direction === 'excitation' ? ' -> ' : ' <- '}${entry.to}`))
      .toContain('1b3u <- 1b2g');
  });

  it('reports no excitation table for a job that computed none', () => {
    const single = [
      '    Psi4: An Open-Source Ab Initio Electronic Structure Package',
      '    Total Energy =                        -75.9609364137418623',
      '*** Psi4 exiting successfully. Buy a developer a beer!',
    ].join('\n');
    // Absent, not an empty table: a consumer must be able to tell "no excited
    // states were computed" from "the parse failed".
    expect(parsePsi4Output(single).excitedStates).toBeUndefined();
  });
});
