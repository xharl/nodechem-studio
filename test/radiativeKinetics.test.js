/**
 * Radiative kinetics from oscillator strengths (#170).
 *
 * Two kinds of number appear here, and they are deliberately kept apart:
 *
 * - numbers **derived** by `radiativeKinetics()` from a parsed field, checked
 *   against the closed form evaluated independently in this file, and
 * - numbers **read from a real log**, quoted with the file and line they came
 *   from: `test/fixtures/real/g16-dvb-td.out` (Gaussian 16, DVB, TD single
 *   point) and `test/fixtures/psi4-td/ethylene-b3lyp-631gd-16states.log`.
 *
 * The physical anchor is external to both: the Einstein A coefficient of two
 * electric-dipole transitions whose f and A are both measured (Na 3s→3p and
 * H Ly-α). If the prefactor were wrong those two checks would move, which is
 * exactly why they are here rather than only a self-consistent round-trip.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EV_TO_WAVENUMBER_CM,
  RADIATIVE_ESTIMATE_NOTE,
  RADIATIVE_NOT_MODELLED,
  RADIATIVE_PREFACTOR_PER_CM,
  RADIATIVE_RATE_RELATION,
  formatLifetime,
  radiativeKinetics,
  radiativeKineticsReport,
  radiativeKineticsSummary,
  wavenumberOf,
} from '../src/shared/kinetics.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parsePsi4Output } from '../src/shared/engines/psi4.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fixture = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The closed form, evaluated from SI constants here and not imported from the
 * module under test: k_r = 2π e² ν² f / (3 ε₀ mₑ c³), ν in Hz.
 */
function closedFormRate({ wavelengthNm, oscillatorStrength }) {
  const e = 1.602176634e-19;
  const eps0 = 8.8541878128e-12;
  const me = 9.1093837015e-31;
  const c = 299792458;
  const nu = c / (wavelengthNm * 1e-9);
  return (2 * Math.PI * e ** 2 * nu ** 2 * oscillatorStrength) / (3 * eps0 * me * c ** 3);
}

describe('radiative rate from an oscillator strength', () => {
  it('reproduces the closed form for f = 1.0 at 300 nm to well within 1 %', () => {
    // The acceptance criterion of #170. The closed form is recomputed from SI
    // constants above; the module evaluates the same expression with ν̄ in cm⁻¹.
    const closed = closedFormRate({ wavelengthNm: 300, oscillatorStrength: 1 });
    const report = radiativeKinetics({ index: 1, wavelengthNm: 300, oscillatorStrength: 1 });
    expect(report.available).toBe(true);
    // 2.4705 × 10⁸ s⁻¹, i.e. τ = 4.05 ns for a fully allowed 300 nm transition.
    expect(report.ratePerSecond / 2.4705e8).toBeCloseTo(1, 4);
    expect(Math.abs(report.ratePerSecond - closed) / closed).toBeLessThan(0.01);
    // 1/k_r, in the unit the card prints.
    expect(report.radiativeLifetimeSeconds).toBeCloseTo(1 / closed, 15);
    expect(report.radiativeLifetimeText).toBe('4.05 ns');
  });

  it('agrees with two measured transition probabilities to within 1 %', () => {
    // Na 3s 2S → 3p 2P°: λ = 589.0 nm, f = 0.982, A_21 = 6.25e7 s⁻¹
    // (NIST Atomic Spectra Database, transition probability tables).
    const na = radiativeKinetics({ wavelengthNm: 589.0, oscillatorStrength: 0.982 });
    expect(na.ratePerSecond).toBeGreaterThan(6.25e7 * 0.99);
    expect(na.ratePerSecond).toBeLessThan(6.25e7 * 1.01);
    // H Ly-α (2p → 1s): λ = 121.567 nm, f = 0.4162, A_21 = 6.265e8 s⁻¹.
    const lyA = radiativeKinetics({ wavelengthNm: 121.567, oscillatorStrength: 0.4162 });
    expect(lyA.ratePerSecond).toBeGreaterThan(6.265e8 * 0.99);
    expect(lyA.ratePerSecond).toBeLessThan(6.265e8 * 1.01);
  });

  it('keeps the prefactor consistent between the two printed forms', () => {
    // 0.22234 · ν̄² · f and 2.2234e13 · f / λ² must be the same number: the
    // constant is derived once, so this catches a mistyped exponent anywhere.
    const nuBar = 1e7 / 300;
    expect((RADIATIVE_PREFACTOR_PER_CM * nuBar ** 2) / (2.2234e13 / 300 ** 2)).toBeCloseTo(1, 4);
    expect(RADIATIVE_RATE_RELATION).toContain(RADIATIVE_PREFACTOR_PER_CM.toPrecision(5));
    expect(RADIATIVE_RATE_RELATION).toContain('2.2234 × 10¹³');
  });

  it('derives ν̄ from the wavelength, and from the energy only when there is none', () => {
    expect(wavenumberOf({ wavelengthNm: 232.39 })).toEqual({
      wavenumberCm: 1e7 / 232.39, source: 'wavelength', reason: null,
    });
    const fromEnergy = wavenumberOf({ energyEv: 5.3351 });
    expect(fromEnergy.source).toBe('energy');
    expect(fromEnergy.wavenumberCm).toBeCloseTo(5.3351 * EV_TO_WAVENUMBER_CM, 9);
    // Gaussian prints both for the same state in g16-dvb-td.out: 232.39 nm and
    // 5.3351 eV. The two routes differ by 0.006 % — rounding of the printed
    // digits, not physics — and the wavelength wins because it is the field the
    // f sits beside.
    expect((1e7 / 232.39) / (5.3351 * EV_TO_WAVENUMBER_CM)).toBeCloseTo(1, 4);
    expect(radiativeKinetics({ wavelengthNm: 232.39, energyEv: 5.3351, oscillatorStrength: 0.1707 })
      .wavenumberSource).toBe('wavelength');
  });
});

describe('the real Gaussian TD log in the corpus', () => {
  const parsed = parseGaussianOutput(fixture('test/fixtures/real/g16-dvb-td.out'));
  const states = parsed.excitedStates.states;

  it('parses the printed f values the rates are built from', () => {
    // Quoted from the log at the `Excited State` rows:
    //   1: 5.3351 eV  232.39 nm  f=0.1707
    //   2: 5.3746 eV  230.68 nm  f=0.6779
    //   3: 6.2152 eV  199.49 nm  f=0.0000
    expect(states.slice(0, 3).map((state) => [state.index, state.energyEv, state.wavelengthNm,
      state.oscillatorStrength])).toEqual([
      [1, 5.3351, 232.39, 0.1707],
      [2, 5.3746, 230.68, 0.6779],
      [3, 6.2152, 199.49, 0],
    ]);
  });

  it('turns those f values into k_r and τ_r that follow from the printed numbers', () => {
    const report = radiativeKineticsReport(states, { levelOfTheory: 'B3LYP/6-31+G(d)' });
    expect(report.available).toBe(true);
    // Five states: three have a positive f, two print f = 0. Every row resolves
    // to a rate — zero for the dark ones — so none is "missing".
    expect(report.computedCount).toBe(5);
    expect(report.missingCount).toBe(0);
    expect(report.rows.filter((row) => row.ratePerSecond > 0)).toHaveLength(3);
    const [first, second] = report.rows;
    // Traceable by hand: 2.2234e13 · 0.1707 / 232.39² = 7.03e7 s⁻¹.
    expect(first.ratePerSecond / closedFormRate({ wavelengthNm: 232.39, oscillatorStrength: 0.1707 }))
      .toBeCloseTo(1, 12);
    expect(first.rateText).toBe('7.03 × 10⁷');
    expect(first.radiativeLifetimeText).toBe('14.2 ns');
    expect(second.rateText).toBe('2.83 × 10⁸');
    expect(second.radiativeLifetimeText).toBe('3.53 ns');
    // The brightest state is the one a reader would compare with a measurement.
    expect(report.fastest.index).toBe(2);
    expect(report.levelOfTheory).toBe('B3LYP/6-31+G(d)');
  });

  it('reports f = 0 as no radiative channel, not as a very long lifetime', () => {
    const dark = radiativeKinetics({ index: 3, wavelengthNm: 199.49, oscillatorStrength: 0 });
    expect(dark.available).toBe(true);
    expect(dark.ratePerSecond).toBe(0);
    expect(dark.radiativeLifetimeSeconds).toBeNull();
    expect(dark.radiativeLifetimeText).toBe('not finite (f = 0)');
    expect(dark.reason).toMatch(/one-photon radiative rate is zero/);
    expect(JSON.stringify(dark)).not.toMatch(/Infinity|NaN/);
  });
});

describe('P4 TD-DFT (canonical excitedStates)', () => {
  it('feeds the same table from Psi4 length-form f', () => {
    const parsed = parsePsi4Output(fixture('test/fixtures/psi4-td/ethylene-b3lyp-631gd-16states.log'));
    const report = radiativeKineticsReport(parsed.excitedStates.states);
    // Psi4 prints 150.54 nm, f = 0.3501 for state 1; the parser derives nm from
    // the printed 0.30267 au energy, so the wavelength route is the one used.
    const bright = report.rows[0];
    expect(bright.oscillatorStrength).toBeCloseTo(0.3501, 4);
    expect(bright.wavenumberSource).toBe('wavelength');
    expect(bright.ratePerSecond / closedFormRate({
      wavelengthNm: 1e7 / bright.wavenumberCm,
      oscillatorStrength: 0.3501,
    })).toBeCloseTo(1, 12);
  });
});

describe('honest empty states', () => {
  it('prints not reported, with the reason, when f or the wavelength is missing', () => {
    const noStrength = radiativeKinetics({ index: 1, wavelengthNm: 300 });
    expect(noStrength.available).toBe(false);
    expect(noStrength.rateText).toBe('not reported');
    expect(noStrength.radiativeLifetimeText).toBe('not reported');
    expect(noStrength.reason).toMatch(/no oscillator strength/);
    const noWavelength = radiativeKinetics({ index: 2, oscillatorStrength: 0.2 });
    expect(noWavelength.available).toBe(false);
    expect(noWavelength.reason).toMatch(/no parsed wavelength or energy/);
    // A missing input is null, never 0.
    expect(noWavelength.wavenumberCm).toBeNull();
    expect(noWavelength.ratePerSecond).toBeNull();
  });

  it('never exposes a field named "lifetime", and never fills an observed one', () => {
    const report = radiativeKinetics({ index: 1, wavelengthNm: 232.39, oscillatorStrength: 0.1707 });
    expect(Object.hasOwn(report, 'lifetime')).toBe(false);
    expect(Object.hasOwn(report, 'lifetimeSeconds')).toBe(false);
    expect(report.observedLifetimeSeconds).toBeNull();
    expect(report.observedLifetimeReason).toMatch(/cannot predict an observed/);
    expect(report.kind).toBe('radiative-estimate');
    expect(report.upperBound).toBe(true);
  });

  it('says what the estimate leaves out, in the summary every card prints', () => {
    const report = radiativeKineticsReport([{ index: 1, wavelengthNm: 232.39, oscillatorStrength: 0.1707 }]);
    const line = radiativeKineticsSummary(report);
    expect(line).toContain('upper bound');
    for (const phrase of ['non-radiative', 'intersystem crossing', 'conical intersections']) {
      expect(line.toLowerCase()).toContain(phrase);
    }
    expect(RADIATIVE_ESTIMATE_NOTE).toContain('not modelled');
    expect(RADIATIVE_NOT_MODELLED).toHaveLength(3);
    // The card prints the channels itself, so it drops the trailing sentence —
    // the upper-bound claim must survive that cut.
    const shortened = radiativeKineticsSummary(report, { note: false });
    expect(shortened).toContain('upper bound on the observed lifetime');
    expect(shortened).not.toContain('not modelled');
    // Nothing available: the sentence is a refusal, not a number.
    const empty = radiativeKineticsSummary(radiativeKineticsReport([{ index: 1 }]));
    expect(empty).toContain('not reported');
  });

  it('formats a lifetime without pretending a non-finite one exists', () => {
    expect(formatLifetime(3.53e-9)).toBe('3.53 ns');
    expect(formatLifetime(2.1e-11)).toBe('21.0 ps');
    expect(formatLifetime(1e-5)).toBe('10.0 µs');
    expect(formatLifetime(120)).toBe('120 s');
    expect(formatLifetime(0)).toBeNull();
    expect(formatLifetime(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('excited-states card', () => {
  const record = () => ({
    status: 'completed',
    engine: 'gaussian',
    parsed: parseGaussianOutput(fixture('test/fixtures/real/g16-dvb-td.out')),
    provenance: { method: { functional: 'B3LYP', basis: '6-31+G(d)' } },
    gates: { overall: 'pass', gates: [] },
  });

  it('labels the derived columns as radiative and prints the relation and the level', () => {
    const html = resultsPanelHtml(record());
    expect(html).toContain('k_r (s⁻¹)');
    expect(html).toContain('τ_r (radiative)');
    expect(html).toContain('data-field="radiative-kinetics"');
    expect(html).toContain('data-field="radiative-lifetime"');
    expect(html).toContain(RADIATIVE_PREFACTOR_PER_CM.toPrecision(5));
    expect(html).toContain('Level of theory: B3LYP/6-31+G(d).');
    expect(html).toContain('2.83 × 10⁸');
    expect(html).toContain('3.53 ns');
  });

  it('names the channels it does not model next to the rates', () => {
    const html = resultsPanelHtml(record());
    expect(html).toContain('data-field="radiative-not-modelled"');
    expect(html).toContain('non-radiative decay (internal conversion)');
    expect(html).toContain('spin–orbit coupling');
    expect(html).toContain('conical intersections');
    expect(html).toContain('upper bound on the observed lifetime');
    expect(html).toContain('No observed lifetime');
  });

  it('says the level is not recorded when the run does not carry one', () => {
    const html = resultsPanelHtml({ ...record(), provenance: null });
    expect(html).toContain('Level of theory: not recorded for this run.');
  });

  it('renders a dark state as not finite rather than as a lifetime', () => {
    const html = resultsPanelHtml(record());
    expect(html).toContain('not finite (f = 0)');
  });

  it('adds nothing to an output with no TD table', () => {
    const html = resultsPanelHtml({
      status: 'completed',
      engine: 'gaussian',
      parsed: parseGaussianOutput(' Normal termination of Gaussian 16'),
      gates: { overall: 'pass', gates: [] },
    });
    expect(html).not.toContain('radiative-kinetics');
  });
});
