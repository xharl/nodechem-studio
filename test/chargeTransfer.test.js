/**
 * Issue 173, route B: charge-transfer character from the transition density.
 *
 * Two committed fixture runs back this file, both computed by
 * `psi4/psi4:1.11` from decks this app's own builder wrote:
 *
 * - `fixtures/psi4-ct/ethylene-dimer-td.*` — a slipped cofacial ethylene dimer.
 *   The two fragments are chemically identical, so the hole and the particle of
 *   every state are spread equally over both: the CT *fraction* is large for the
 *   charge-transfer states and the net transferred charge Δq is exactly 0.
 * - `fixtures/psi4-ct/ammonia-water-td.*` — ammonia donating to water, 4 atoms
 *   to 3. Different fragments, so the transfer has a direction and a sign.
 *
 * The arithmetic below is written out rather than compared against a stored
 * number wherever the definition allows it: a fraction that is stored and
 * compared to itself proves nothing.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parsePsi4Output } from '../src/shared/engines/psi4.js';
import { canonicalResult } from '../src/shared/engines/canonical.js';
import { parseFchk } from '../src/shared/fchk.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';
import {
  CT_NORMALISATION_TOLERANCE, chargeTransferReport, chargeTransferOf, fragmentOwnership,
  transitionDensityOf,
} from '../src/shared/chargeTransfer.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/psi4-ct/${name}`, import.meta.url), 'utf8');

const DIMER_LOG = fixture('ethylene-dimer-td.log');
const DIMER_FCHK = fixture('ethylene-dimer-td.fchk');
const HETERODIMER_LOG = fixture('ammonia-water-td.log');
const HETERODIMER_FCHK = fixture('ammonia-water-td.fchk');

const dimer = parsePsi4Output(DIMER_LOG, { fchk: DIMER_FCHK });
const heterodimer = parsePsi4Output(HETERODIMER_LOG, { fchk: HETERODIMER_FCHK });

const near = (actual, expected, tolerance = 1e-6) => Math.abs(actual - expected) <= tolerance;

describe('the transition-density record in the Psi4 log', () => {
  it('is parsed for every root, with its dimensions and its kind', () => {
    expect(dimer.excitedStates.transitionDensityCount).toBe(20);
    const state = dimer.excitedStates.states.find((entry) => entry.index === 9);
    expect(state.transitionDensity.nocc).toBe(16);
    expect(state.transitionDensity.nvir).toBe(80);
    expect(state.transitionDensity.tda).toBe(true);
    expect(state.transitionDensity.values).toHaveLength(16 * 80);
    // Σ X² = 1 is what makes the partition normalisable, and it is a property of
    // the amplitudes the log recorded, not of the analysis.
    const sum = [...state.transitionDensity.values].reduce((total, value) => total + value * value, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('carries the fragment labels the deck wrote, one per atom', () => {
    expect(dimer.excitedStates.fragmentLabels).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(heterodimer.excitedStates.fragmentLabels).toEqual([1, 1, 1, 1, 2, 2, 2]);
  });
});

describe('the CT fraction of a homodimer', () => {
  const report = dimer.chargeTransfer;

  it('survives the canonical result, whole', () => {
    expect(report).toBeTruthy();
    expect(report.modelled).toBe(true);
    expect(dimer.chargeTransfer).toBe(report);
    expect(report.states).toHaveLength(20);
    expect(report.partitions).toEqual(['lowdin', 'mulliken']);
    expect(report.fragments.map((fragment) => fragment.atoms)).toEqual([6, 6]);
    // The block is not a bare number: the partition and the level travel with it.
    expect(report.partition).toBe('lowdin');
    expect(report.method).toMatch(/Plasser/);
    expect(report.statement).toMatch(/not a measured quantity/);
    // The level the numbers belong to, from the engine's own task line — not a
    // guess from the app's settings, which the parser never sees.
    expect(report.level).toBe('td-b3lyp/def2-svp');
    expect(report.statement).toContain('td-b3lyp/def2-svp');
  });

  it('partitions the transition density to exactly 1 in both schemes', () => {
    for (const state of report.states) {
      expect(near(state.omegaTotal, 1, CT_NORMALISATION_TOLERANCE)).toBe(true);
      for (const partition of ['lowdin', 'mulliken']) {
        const blocks = state.partitions[partition].blocks;
        const total = blocks.flat().reduce((sum, value) => sum + value, 0);
        expect(total).toBeCloseTo(1, 9);
        // The fraction and the local part are two views of one number.
        expect(state.partitions[partition].ctFraction
          + state.partitions[partition].localFraction).toBeCloseTo(1, 9);
      }
    }
  });

  it('computes Λ as Σ_A √(Ω_AA), the expression the card states', () => {
    for (const state of report.states) {
      const blocks = state.partitions.lowdin.blocks;
      const lambda = Math.sqrt(blocks[0][0]) + Math.sqrt(blocks[1][1]);
      expect(state.lambda).toBeCloseTo(lambda, 9);
      // 0 when every bit of the hole sits on the other fragment from every bit
      // of the particle, 1 when it is localised on one fragment, √2 when the two
      // fragments share it equally — and never outside 0…2.
      expect(state.lambda).toBeGreaterThanOrEqual(0);
      expect(state.lambda).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
      expect(state.lambda).toBeLessThanOrEqual(2);
    }
  });

  it('reports CT in 0…1 and Δq as the difference of the fragment populations', () => {
    for (const state of report.states) {
      expect(state.ctFraction).toBeGreaterThanOrEqual(0);
      expect(state.ctFraction).toBeLessThanOrEqual(1);
      for (const partition of ['lowdin', 'mulliken']) {
        const entry = state.partitions[partition];
        const deltaQ = entry.particle[0] - entry.hole[0];
        expect(entry.deltaQe).toBeCloseTo(deltaQ, 9);
        // The pump and the dump are the same size: nothing is created.
        expect(entry.hole[0] + entry.hole[1]).toBeCloseTo(1, 6);
        expect(entry.particle[0] + entry.particle[1]).toBeCloseTo(1, 6);
      }
    }
  });

  it('gives no net transfer in a symmetric dimer, even for a 99 % CT state', () => {
    const transfer = report.states.find((state) => state.index === 1);
    // Both fragments are the same molecule: the excitation moves an electron
    // each way with equal weight, so the fraction is high and the net charge 0.
    expect(transfer.ctFraction).toBeGreaterThan(0.9);
    expect(transfer.fragments[0].hole).toBeCloseTo(0.5, 6);
    expect(transfer.fragments[1].particle).toBeCloseTo(0.5, 6);
    expect(Math.abs(transfer.deltaQe)).toBeLessThan(1e-6);
    for (const state of report.states) expect(Math.abs(state.deltaQe)).toBeLessThan(1e-6);
  });

  it('gives a near-zero fraction for the bright, monomer-localised state', () => {
    const bright = report.states.find((state) => state.index === 9);
    expect(bright.oscillatorStrength).toBeGreaterThan(1);
    expect(bright.ctFraction).toBeLessThan(0.05);
    expect(bright.localFraction).toBeGreaterThan(0.95);
    // Delocalised over both fragments but with hole and particle in the same
    // place: Λ near √2, which is an exciton, not a charge transfer.
    expect(bright.lambda).toBeGreaterThan(1.3);
  });

  it('reports a near-degenerate pair as two states, not one merged number', () => {
    const first = chargeTransferOf(report, 12);
    const second = chargeTransferOf(report, 13);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(Math.abs(first.energyEv - second.energyEv)).toBeLessThan(0.01);
    expect(first.ctFraction).toBeGreaterThan(0.9);
    expect(second.ctFraction).toBeGreaterThan(0.9);
    expect(Math.abs(first.ctFraction - second.ctFraction)).toBeLessThan(0.01);
  });

  it('does not depend on the partition beyond a few thousandths', () => {
    expect(report.partitionSpread).toBeLessThan(0.02);
    for (const state of report.states) {
      expect(Math.abs(state.partitions.lowdin.ctFraction - state.partitions.mulliken.ctFraction))
        .toBeLessThan(0.02);
    }
  });
});

describe('the CT fraction and Δq of a heterodimer', () => {
  const report = heterodimer.chargeTransfer;

  it('reads the unequal fragments the deck declared', () => {
    expect(report.modelled).toBe(true);
    expect(report.fragments).toEqual([
      { fragment: 1, label: 'fragment 1', atoms: 4 },
      { fragment: 2, label: 'fragment 2', atoms: 3 },
    ]);
    expect(report.states).toHaveLength(12);
  });

  it('moves charge one way, with Δq equal to the magnitude of the transfer', () => {
    const state = chargeTransferOf(report, 1);
    // The whole transfer runs 2 → 1 (the water donates to the ammonia), so the
    // cross block in the other direction is empty and CT = |Δq|.
    expect(state.partitions.lowdin.blocks[0][1]).toBeLessThan(0.01);
    expect(state.partitions.lowdin.blocks[1][0]).toBeGreaterThan(0.8);
    expect(state.ctFraction).toBeCloseTo(0.827, 3);
    expect(state.deltaQe).toBeCloseTo(0.827, 3);
    expect(Math.abs(state.deltaQe)).toBeCloseTo(state.ctFraction, 3);
    // Fragment 1 gains the electron the excitation moved.
    expect(state.fragments[0].particle - state.fragments[0].hole).toBeCloseTo(state.deltaQe, 9);
  });

  it('reports the sign of the transfer, so the direction is readable', () => {
    const back = chargeTransferOf(report, 7);
    expect(back.ctFraction).toBeGreaterThan(0.4);
    expect(back.deltaQe).toBeLessThan(-0.2);
  });

  it('reaches a nearly pure CT state with a small Λ', () => {
    const pure = chargeTransferOf(report, 5);
    expect(pure.ctFraction).toBeGreaterThan(0.99);
    expect(Math.abs(pure.deltaQe)).toBeGreaterThan(0.99);
    expect(pure.lambda).toBeLessThan(0.15);
    expect(pure.localFraction).toBeLessThan(0.01);
  });
});

describe('what the CT analysis refuses', () => {
  const states = dimer.excitedStates.states;
  const checkpoint = parseFchk(DIMER_FCHK);
  const labels = dimer.excitedStates.fragmentLabels;

  it('refuses a monomer run with the words the card already uses', () => {
    const report = chargeTransferReport({
      states,
      checkpoint,
      fragments: new Array(12).fill(1),
    });
    expect(report.modelled).toBe(false);
    expect(report.reason).toBe('not modelled: no dimer geometry');
    expect(report.states).toBeUndefined();
  });

  it('refuses a run that recorded no transition density instead of scoring 0', () => {
    const report = chargeTransferReport({
      states: states.map((state) => ({ index: state.index, energyEv: state.energyEv })),
      checkpoint,
      fragments: labels,
    });
    expect(report.modelled).toBe(false);
    expect(report.reason).toBe('not modelled: no transition density was recorded for any state');
  });

  it('refuses a run with no checkpoint rather than inventing a basis', () => {
    const report = chargeTransferReport({ states, checkpoint: null, fragments: labels });
    expect(report.modelled).toBe(false);
    expect(report.reason).toBe('not modelled: no wavefunction (the run has no checkpoint)');
  });

  it('refuses a truncated amplitude block', () => {
    const broken = states.map((state) => ({
      ...state,
      transitionDensity: state.transitionDensity
        ? { ...state.transitionDensity, values: state.transitionDensity.values.slice(0, 100) }
        : state.transitionDensity,
    }));
    const report = chargeTransferReport({ states: broken, checkpoint, fragments: labels });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/holds 100 amplitudes for a 16×80 block/);
  });

  it('refuses a density that does not partition to 1', () => {
    // Twice the amplitude is not a normalized transition density; the partition
    // sums to 4, and a "fraction" of 4 is not a fraction.
    const scaled = states.map((state) => ({
      ...state,
      transitionDensity: state.transitionDensity
        ? {
          ...state.transitionDensity,
          values: state.transitionDensity.values.map((value) => value * 2),
        }
        : state.transitionDensity,
    }));
    const report = chargeTransferReport({ states: scaled, checkpoint, fragments: labels });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/partition of state \d+ sums to 4\.000000 instead of 1/);
  });

  it('refuses a random-phase density, which is not the object this partitions', () => {
    const rpa = states.map((state) => ({
      ...state,
      transitionDensity: state.transitionDensity
        ? { ...state.transitionDensity, tda: false }
        : state.transitionDensity,
    }));
    const report = chargeTransferReport({ states: rpa, checkpoint, fragments: labels });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/not TDA/);
  });

  it('refuses a checkpoint that describes a different molecule', () => {
    const report = chargeTransferReport({
      states,
      checkpoint,
      fragments: labels,
      atoms: checkpoint.atoms.map((atom) => ({ element: atom.atomicNumber === 6 ? 'N' : atom.element })),
    });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/is N in this run and C in the checkpoint/);
  });

  it('refuses a three-fragment system rather than silently merging fragments', () => {
    const three = [...labels.slice(0, 2), ...labels.slice(6, 8), ...new Array(8).fill(3)];
    const report = chargeTransferReport({ states, checkpoint, fragments: three });
    expect(report.modelled).toBe(false);
    expect(report.reason).toMatch(/two-fragment model and the run declares 3 fragments/);
  });
});

describe('the exciton card with a CT analysis', () => {
  const record = {
    status: 'completed',
    engine: 'psi4',
    parsed: dimer,
    gates: { overall: 'pass', gates: [] },
  };
  const complex = {
    members: [
      { atomCount: 6, fragment: 1, label: 'ethylene 1' },
      { atomCount: 6, fragment: 2, label: 'ethylene 2' },
    ],
  };

  it('prints the CT fraction, Δq, Ω, Λ and the partition beside J', () => {
    const html = resultsPanelHtml(record, { complex });
    expect(html).toContain('data-field="exciton-j"');
    expect(html).toContain('data-field="exciton-ct-state-1"');
    expect(html).toContain('data-field="exciton-ct-state-2"');
    expect(html).toContain('Löwdin partition');
    expect(html).toContain('Δq =');
    expect(html).toContain('Λ =');
    // The statement of what the numbers are travels with them.
    expect(html).toContain('data-field="exciton-ct-statement"');
    expect(html).toContain('not a measured quantity');
  });

  it('says plainly that J is unreliable where CT is large', () => {
    const html = resultsPanelHtml(record, { complex });
    // The paired states are the two lowest bright ones, and in this run both are
    // charge-transfer states, so the caveat has to fire.
    expect(html).toContain('data-field="exciton-ct-warning"');
    expect(html).toContain('The point-dipole J is not a reliable number');
  });

  it('prints the refusal, not a zero, when the run has no CT analysis', () => {
    const refused = { ...dimer, chargeTransfer: { modelled: false, reason: 'not modelled: no dimer geometry' } };
    const html = resultsPanelHtml({ ...record, parsed: refused }, { complex });
    expect(html).toContain('data-field="exciton-ct"');
    expect(html).toContain('not modelled: no dimer geometry');
    expect(html).not.toContain('data-field="exciton-ct-state-1"');
  });

  it('names the missing transition density when the record predates the analysis', () => {
    const plain = { ...dimer };
    delete plain.chargeTransfer;
    const html = resultsPanelHtml({ ...record, parsed: plain }, { complex });
    // Route A alone cannot answer the question, and the card says so rather than
    // leaving the row out and letting a reader assume there is no CT.
    expect(html).toContain('data-field="exciton-ct"');
    expect(html).toContain('not modelled: the run recorded no transition density');
    expect(html).toContain('data-field="exciton-j"');
  });
});

describe('the pieces', () => {
  it('reads fragment labels as one number per atom, in atom order', () => {
    expect(fragmentOwnership([2, 1, 2])).toEqual([
      { id: 1, label: 'fragment 1', atoms: [1] },
      { id: 2, label: 'fragment 2', atoms: [0, 2] },
    ]);
    expect(() => fragmentOwnership([1, 0], { atomCount: 2 })).toThrow(/not a whole number of at least 1/);
    expect(() => fragmentOwnership([1, 2], { atomCount: 3 })).toThrow(/covers 2 atoms but the geometry has 3/);
    expect(fragmentOwnership([])).toBeNull();
  });

  it('treats a state with no density as absent, and a malformed one as an error', () => {
    expect(transitionDensityOf({ index: 1 })).toBeNull();
    expect(() => transitionDensityOf({ transitionDensity: { nocc: 2, nvir: 2, values: [1] } }))
      .toThrow(/holds 1 amplitudes for a 2×2 block/);
    expect(() => transitionDensityOf({ transitionDensity: { nocc: 0, nvir: 2, values: [] } }))
      .toThrow(/occupied and virtual dimensions/);
  });

  it('returns the block unchanged through the canonical contract', () => {
    const block = dimer.chargeTransfer;
    expect(canonicalResult({ engine: 'psi4', chargeTransfer: block }).chargeTransfer).toBe(block);
    // A section without `modelled` is not an analysis and is not passed on.
    expect('chargeTransfer' in canonicalResult({ engine: 'psi4' })).toBe(false);
    expect('chargeTransfer' in canonicalResult({ engine: 'psi4', chargeTransfer: {} })).toBe(false);
  });
});
