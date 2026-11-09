/**
 * Issue 173, route A: record the Psi4 transition dipole, carry it through the
 * canonical result, and couple two chromophores of a complex.
 *
 * The Psi4 log below is a **synthetic line set**, labelled on its first line. It
 * reproduces only the record shapes the parser reads — the TDSCF row and the
 * `NCS-TDM` lines the builder writes — and no Psi4 executable ran. It is
 * deliberately kept in this file and not under `test/fixtures/real/`, which the
 * coverage test (issue 176) treats as captured output.
 */
import { describe, expect, it } from 'vitest';

import { buildPsi4Input, parsePsi4Output } from '../src/shared/engines/psi4.js';
import { expandComplex } from '../src/shared/complex.js';
import {
  DIPOLE_AU_TO_DEBYE, POINT_DIPOLE_PREFACTOR_CM, complexFragments, excitonReport,
  pointDipoleCoupling, transitionDipoleOf,
} from '../src/shared/exciton.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

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
  settings: {
    jobType: 'TD-DFT', method: 'b3lyp', basis: '6-31g(d)', tdStates: 5, reference: 'rhf', ...settings,
  },
  molecule: WATER,
  inputName: 'td.dat',
});

/** The deck this builder produced before issue 173, verbatim. */
const DECK_BEFORE_ISSUE_173 = [
  '# NodeChem Studio — generated Psi4 input',
  '# Psi4 task',
  '# Every line below is written by the app; edit and re-run at your own risk.',
  '',
  '',
  'molecule {',
  '0 1',
  '  O  0.000000  0.000000  0.117300',
  '  H  0.000000  0.757000  -0.469200',
  '  H  0.000000  -0.757000  -0.469200',
  '}',
  '',
  'set basis 6-31G*',
  'set reference rhf',
  'set scf_type df',
  '',
  'set tdscf_states 5',
  "energy('td-b3lyp')",
  '',
].join('\n');

describe('the transition-dipole record in the Psi4 deck', () => {
  it('is byte-identical when the block did not opt in', () => {
    expect(build({}).inputText).toBe(DECK_BEFORE_ISSUE_173);
    expect(build({ recordTransitionDipoles: false }).inputText).toBe(DECK_BEFORE_ISSUE_173);
  });

  it('adds the wavefunction record and changes nothing else when it did', () => {
    const text = build({ recordTransitionDipoles: true }).inputText;
    expect(text).toContain('set tdscf_states 5');
    expect(text).toContain("E, wfn = energy('td-b3lyp', return_wfn=True)");
    expect(text).toContain("if 'ELECTRIC TRANSITION DIPOLE MOMENT (LEN)' not in _ncs_name:");
    // Issue 173, route B: the same record also carries the transition density,
    // the fragment labels and the checkpoint that turns amplitudes into a
    // density over atoms.
    expect(text).toContain("psi4.core.print_out('NCS-CTFRAG 3 1 1 1'");
    expect(text).toContain("psi4.core.print_out('NCS-TDMAT ROOT %d %d %d tda");
    expect(text).toContain('set tdscf_tda true');
    expect(text).toContain('symmetry c1');
    expect(text).toContain("fchk(wfn, 'td.fchk')");
    // The record has to go through Psi4's own stream and through the accessor
    // 1.11 actually has; `print` and `get_array` both leave the record outside
    // the log (measured, issue 173).
    expect(text).toContain('psi4.core.print_out(');
    expect(text).not.toContain('get_array(');
    expect(text).not.toMatch(/^print\(/m);
    // One energy call, and it is the one that hands back the wavefunction: a
    // second bare call would run the calculation twice.
    expect(text.match(/energy\('td-b3lyp'/g)).toHaveLength(1);
    expect(text).not.toContain("energy('td-b3lyp')\n");

    // Removing exactly the inserted lines gives back the old deck, so the block
    // is the only difference.
    const onLines = text.split('\n');
    const start = onLines.indexOf('set tdscf_states 5');
    const end = onLines.indexOf("fchk(wfn, 'td.fchk')");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const rebuilt = [
      ...onLines.slice(0, start + 1),
      "energy('td-b3lyp')",
      ...onLines.slice(end + 1),
    ].join('\n');
    expect(rebuilt.replace('symmetry c1\n', '')).toBe(DECK_BEFORE_ISSUE_173);
  });

  it('refuses the setting on a job that runs no TD wavefunction', () => {
    expect(() => buildPsi4Input({
      settings: { jobType: 'SP', method: 'b3lyp', basis: '6-31g(d)', recordTransitionDipoles: true },
      molecule: WATER,
      inputName: 'sp.dat',
    })).toThrow(/needs a TD-DFT block/i);
  });
});

/**
 * Synthetic: two-singlet table plus the three `NCS-TDM` lines a run of the deck
 * above would print, one state left without a line on purpose.
 */
const SYNTHETIC_TD_LOG = [
  ' FIXTURE OUTPUT — synthetic line set for issue 173, not a real calculation',
  '',
  '    Psi4: An Open-Source Ab Initio Electronic Structure Package',
  '    Psi4 1.11',
  '',
  '==> Requested Excitations <==',
  '',
  '    2 singlet states with B1u symmetry',
  '    1 singlet states with B2u symmetry',
  '',
  '    #   Sym: GS->ES (Trans)        au              eV              au          au (length)    au (velocity)    au (length)    au (velocity)',
  '    1    Ag->B1u (1 B1u)      0.25000         6.80272        -76.10000        0.5000          0.5100          0.0000         -0.0000',
  '    2    Ag->B2u (1 B2u)      0.28000         7.61900        -76.10000        0.3000          0.3100          0.0000         -0.0000',
  '    3    Ag->B1u (1 B1u)      0.31000         8.43500        -76.10000        0.0400          0.0400          0.0000         -0.0000',
  '',
  'NCS-TDM ROOT 1 B1u 0.5000000000 -0.2500000000 0.0000000000 a.u.',
  'NCS-TDM ROOT 2 B2u 0.0000000000 0.0000000000 0.6000000000 a.u.',
  '',
  '*** Psi4 exiting successfully. Buy a developer a beer!',
].join('\n');

describe('parsing the transition-dipole record', () => {
  const parsed = parsePsi4Output(SYNTHETIC_TD_LOG);

  it('reads one a.u. vector per root onto the state it belongs to', () => {
    const [first, second] = parsed.excitedStates.states;
    expect(first.transitionDipoleAu).toEqual({ x: 0.5, y: -0.25, z: 0 });
    expect(second.transitionDipoleAu).toEqual({ x: 0, y: 0, z: 0.6 });
    expect(parsed.excitedStates.transitionDipoleCount).toBe(2);
    // Kept in atomic units at parse time: the conversion belongs in
    // `transitionDipoleOf`, exactly once, not in the parser.
    expect(first.transitionDipoleDebye).toBeUndefined();
  });

  it('leaves a state without a line with no dipole field at all', () => {
    const third = parsed.excitedStates.states[2];
    expect('transitionDipoleAu' in third).toBe(false);
    expect(third.oscillatorStrength).toBeCloseTo(0.04, 6);
  });

  it('converts a.u. to debye exactly once', () => {
    const first = parsed.excitedStates.states[0];
    const expected = Math.hypot(0.5, -0.25, 0) * DIPOLE_AU_TO_DEBYE;
    expect(transitionDipoleOf(first).magnitudeDebye).toBeCloseTo(expected, 12);
    // A vector already in debye is not scaled again, so the two agree.
    expect(transitionDipoleOf({ transitionDipoleDebye: { x: 0.5, y: -0.25, z: 0 } }).magnitudeDebye)
      .toBeCloseTo(Math.hypot(0.5, -0.25, 0), 12);
  });

  it('carries the dipoles through the canonical result', () => {
    // `parsePsi4Output` returns `canonicalResult(...)`, so this is the whitelist
    // test: a field that is not carried disappears here and no consumer sees it.
    expect(parsed.canonicalVersion).toBe(1);
    expect(parsed.excitedStates.states[0].transitionDipoleAu).toEqual({ x: 0.5, y: -0.25, z: 0 });
    expect(parsed.excitedStates.transitionDipoleCount).toBe(2);
  });

  it('refuses a line that names a unit other than atomic units', () => {
    const mixed = [
      SYNTHETIC_TD_LOG,
      'NCS-TDM ROOT 3 B1u 0.1000000000 0.2000000000 0.3000000000 debye',
    ].join('\n');
    const states = parsePsi4Output(mixed).excitedStates.states;
    expect('transitionDipoleAu' in states[2]).toBe(false);
  });
});

/* ── The coupling, on a hand-built dimer ──────────────────── */

const DIMER_DATASET = {
  id: 'water-pair',
  records: [
    { id: 'water-a', label: 'water-a', charge: 0, multiplicity: 1, coords: WATER.coords, bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }] },
    { id: 'water-b', label: 'water-b', charge: 0, multiplicity: 1, coords: WATER.coords, bonds: [{ a: 0, b: 1, order: 1 }, { a: 0, b: 2, order: 1 }] },
  ],
};

/** A water dimer placed on x at `distanceAngstrom` between centres of mass. */
function waterDimer(distanceAngstrom) {
  const { records: [record] } = expandComplex({
    members: [{ datasetId: 'water-pair', recordId: 'water-a' }, { datasetId: 'water-pair', recordId: 'water-b' }],
    placement: { mode: 'axis', axis: [1, 0, 0], distanceAngstrom },
  }, { dataset: DIMER_DATASET });
  return record;
}

/** One recorded state, with its dipole in atomic units as Psi4 stores it. */
function state({ index = 1, mu, f = 0.1, energyEv = 6.8 } = {}) {
  return {
    index,
    spin: 'Singlet',
    symmetry: 'B1u',
    energyEv,
    oscillatorStrength: f,
    ...(mu ? { transitionDipoleAu: mu } : {}),
  };
}

describe('the exciton coupling of a complex', () => {
  const dimer = waterDimer(12);

  it('reads each member as a fragment, with its own centre of mass and extent', () => {
    const fragments = complexFragments({ complex: dimer.complex, coords: dimer.coords });
    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.fragment)).toEqual([1, 2]);
    expect(fragments.map((fragment) => fragment.atomCount)).toEqual([3, 3]);
    // Placed 12 Å apart on x, so the centres differ by exactly that.
    expect(fragments[1].centreAngstrom.x - fragments[0].centreAngstrom.x).toBeCloseTo(12, 6);
    // A water molecule's largest dimension is its H···H separation, ~1.5 Å.
    fragments.forEach((fragment) => {
      expect(fragment.extentAngstrom).toBeGreaterThan(1.4);
      expect(fragment.extentAngstrom).toBeLessThan(1.7);
    });
  });

  it('gives the closed-form J for parallel head-to-tail dipoles', () => {
    const muAu = 0.5;
    const muDebye = muAu * DIPOLE_AU_TO_DEBYE;
    // J = 5030.0 · (μ̂₁·μ̂₂ − 3(μ̂₁·r̂)(μ̂₂·r̂)) · |μ₁||μ₂| / r³, written out here:
    // parallel dipoles along r give κ = 1 − 3 = −2.
    const expected = POINT_DIPOLE_PREFACTOR_CM * -2 * muDebye * muDebye / (12 ** 3);
    const report = excitonReport({
      states: [state({ index: 1, mu: { x: muAu, y: 0, z: 0 } }), state({ index: 2, mu: { x: muAu, y: 0, z: 0 } })],
      complex: dimer.complex,
      coords: dimer.coords,
    });
    expect(report.modelled).toBe(true);
    expect(report.distanceAngstrom).toBeCloseTo(12, 6);
    expect(report.orientationFactor).toBeCloseTo(-2, 9);
    expect(report.couplingCm).toBeCloseTo(expected, 9);
    // The same number the module's own entry point returns for the same inputs.
    expect(report.couplingCm).toBeCloseTo(pointDipoleCoupling({
      dipole1: { x: muDebye, y: 0, z: 0 },
      dipole2: { x: muDebye, y: 0, z: 0 },
      separationAngstrom: { x: 12, y: 0, z: 0 },
    }).couplingCm, 9);
    // Signed, so the Davydov split and the shift are both printed.
    expect(report.couplingCm).toBeLessThan(0);
    expect(report.splitCm).toBeCloseTo(2 * Math.abs(report.couplingCm), 10);
    expect(report.approximation).toMatch(/charge-transfer character is not described/i);
  });

  it('reports J below the validity ratio with the warning, not without the number', () => {
    const close = waterDimer(4);
    const report = excitonReport({
      states: [state({ index: 1, mu: { x: 0.5, y: 0, z: 0 } }), state({ index: 2, mu: { x: 0.5, y: 0, z: 0 } })],
      complex: close.complex,
      coords: close.coords,
    });
    expect(report.modelled).toBe(true);
    expect(Number.isFinite(report.couplingCm)).toBe(true);
    expect(report.validity.ratio).toBeLessThan(3);
    expect(report.validity.threshold).toBe(3);
    expect(report.validity.valid).toBe(false);
    expect(report.validity.note).toMatch(/order-of-magnitude estimate only/);
  });

  it('pairs only states that carry both a dipole and f > 0', () => {
    const report = excitonReport({
      states: [
        state({ index: 1, mu: { x: 0.5, y: 0, z: 0 }, f: 0 }), // dark: f = 0
        state({ index: 2, mu: { x: 0.5, y: 0, z: 0 }, f: 0.2 }),
        state({ index: 3, mu: { x: 0, y: 0.5, z: 0 }, f: 0.15 }),
      ],
      complex: dimer.complex,
      coords: dimer.coords,
    });
    expect(report.modelled).toBe(true);
    expect([report.state1.index, report.state2.index]).toEqual([2, 3]);
  });

  it('produces no coupling when only one state could couple', () => {
    const report = excitonReport({
      states: [
        state({ index: 1, mu: { x: 0.5, y: 0, z: 0 }, f: 0.2 }),
        state({ index: 2, mu: { x: 0.5, y: 0, z: 0 }, f: 0 }), // f = 0 and no transition
        state({ index: 3, f: 0.3 }), // bright, but no recorded dipole vector
      ],
      complex: dimer.complex,
      coords: dimer.coords,
    });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/^not modelled: fewer than two states/);
    expect(report.couplingCm).toBeUndefined();
  });

  it('produces no coupling from a zero dipole vector', () => {
    const report = excitonReport({
      states: [
        state({ index: 1, mu: { x: 0, y: 0, z: 0 }, f: 0.2 }),
        state({ index: 2, mu: { x: 0.5, y: 0, z: 0 }, f: 0.2 }),
      ],
      complex: dimer.complex,
      coords: dimer.coords,
    });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/^not modelled: .*zero transition dipole/);
  });

  it('says not modelled for a monomer run, never a number from one chromophore', () => {
    const report = excitonReport({
      states: [state({ index: 1, mu: { x: 0.5, y: 0, z: 0 } }), state({ index: 2, mu: { x: 0.4, y: 0, z: 0 } })],
      complex: null,
      coords: dimer.coords,
    });
    expect(report).toMatchObject({ modelled: false, reason: 'not modelled: no dimer geometry' });
    expect(report.couplingCm).toBeUndefined();
  });

  it('refuses a complex whose atom counts do not match its geometry', () => {
    const report = excitonReport({
      states: [state({ index: 1, mu: { x: 0.5, y: 0, z: 0 } }), state({ index: 2, mu: { x: 0.5, y: 0, z: 0 } })],
      complex: { members: [{ atomCount: 3, fragment: 1 }, { atomCount: 4, fragment: 2 }] },
      coords: dimer.coords,
    });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/^not modelled: .*do not describe the same system/);
  });
});

describe('the exciton-coupling card', () => {
  const dimer = waterDimer(12);
  const parsedLog = parsePsi4Output(SYNTHETIC_TD_LOG);
  const record = {
    status: 'completed',
    engine: 'psi4',
    parsed: { ...parsedLog, extras: { ...parsedLog.extras, finalGeometry: dimer.coords } },
    gates: { overall: 'pass', gates: [] },
  };

  it('prints J, the split, the validity ratio and the approximation', () => {
    const html = resultsPanelHtml(record, { complex: dimer.complex });
    expect(html).toContain('data-field="exciton-j"');
    expect(html).toContain('cm⁻¹');
    expect(html).toContain('data-field="exciton-split"');
    expect(html).toContain('data-field="exciton-validity"');
    expect(html).toContain('Threshold: r/extent ≥ 3');
    expect(html).toContain('charge-transfer character');
    // The printed J is the module's, to two decimals.
    const report = excitonReport({
      states: parsedLog.excitedStates.states,
      complex: dimer.complex,
      coords: dimer.coords,
    });
    expect(html).toContain(`${report.couplingCm.toFixed(2)} cm⁻¹`);
  });

  it('says not modelled: no dimer geometry for a monomer run', () => {
    const monomer = {
      status: 'completed',
      engine: 'psi4',
      parsed: { ...parsedLog, extras: { ...parsedLog.extras, finalGeometry: WATER.coords } },
      gates: { overall: 'pass', gates: [] },
    };
    const html = resultsPanelHtml(monomer, {});
    expect(html).toContain('not modelled: no dimer geometry');
    expect(html).not.toContain('data-field="exciton-j"');
  });
});
