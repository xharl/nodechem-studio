/**
 * EPR from an unrestricted spin density (issue 168).
 *
 * The numbers pinned here are measured from a real Psi4 1.11 run committed under
 * `test/fixtures/psi4-epr/` (CH3·, UB3LYP/6-31G*, doublet) — see that folder's
 * README for the image, command and hashes. Nothing is a chosen tolerance in
 * disguise: the band the proton coupling is asserted in is the band the method
 * supports, and the sum a doublet must satisfy is n_alpha − n_beta = 1.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseFchk } from '../src/shared/fchk.js';
import { writeCube } from '../src/shared/cubeFile.js';
import { basisFunctions } from '../src/shared/esp.js';
import {
  GAUSS_PER_MHZ,
  MHZ_PER_BOHR3_PER_G,
  NUCLEAR_ISOTOPES,
  SPIN_SUM_TOLERANCE,
  eprBlock,
  eprCardRows,
  fermiContactMhz,
  gTensorRefusal,
  hyperfineCouplings,
  overlapMatrix,
  spinDensityMatrix,
  spinDensityOnGrid,
  spinPopulations,
  unpairedElectrons,
} from '../src/shared/epr.js';
import { canonicalResult } from '../src/shared/engines/canonical.js';
import { PSI4_CAPABILITIES, buildPsi4Input, parsePsi4Output } from '../src/shared/engines/psi4.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';
import { spinDensitySets } from '../src/renderer/wavefunctionViewport.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

const FIXTURES = new URL('./fixtures/psi4-epr/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');

const LOG = read('ch3-ub3lyp-631gd.log');
const FCHK_TEXT = read('ch3-ub3lyp-631gd.fchk');
const FCHK = parseFchk(FCHK_TEXT);
const WATER_LOG = readFileSync(new URL('./fixtures/psi4-live/water-sp.out', import.meta.url), 'utf8');

const RADICAL = {
  charge: 0,
  multiplicity: 2,
  coords: [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0, y: 1.079, z: 0 },
    { element: 'H', x: 0.932984, y: -0.5395, z: 0 },
    { element: 'H', x: -0.932984, y: -0.5395, z: 0 },
  ],
};

describe('the checkpoint reader carries the spin density (issue 168)', () => {
  it('reads Psi4 1.11 `Spin SCF Density` as a triangular block', () => {
    expect(FCHK.found).toContain('spinScfDensity');
    expect(FCHK.spinScfDensity).toBeInstanceOf(Float64Array);
    const nbf = FCHK.numberOfBasisFunctions;
    expect(nbf).toBe(21);
    expect(FCHK.spinScfDensity.length).toBe((nbf * (nbf + 1)) / 2);
  });

  it('reads the file\'s d shell as the 21 functions the file states', () => {
    // Psi4 writes `Pure/Cartesian d shells = 1` for a *Cartesian* d (6 functions);
    // reading the flag the other way gives 20 functions and throws. The basis
    // must match the density matrix's dimension or every population is shifted.
    const basis = basisFunctions(FCHK);
    expect(basis.count).toBe(21);
    expect(basis.atomOfFunction).toHaveLength(21);
    expect(new Set(basis.atomOfFunction).size).toBe(4);
  });

  it('refuses a file with no spin block instead of returning zeros', () => {
    const closed = parseFchk(readFileSync(new URL('./fixtures/esp/water-esp.fchk', import.meta.url), 'utf8'));
    const density = spinDensityMatrix(closed);
    expect(density.ok).toBe(false);
    expect(density.reason).toBe('no spin density in this file');
  });
});

describe('spin populations of the doublet', () => {
  const populations = spinPopulations({ fchk: FCHK });

  it('satisfies the one hard constraint: the populations sum to n_alpha − n_beta', () => {
    expect(populations.ok).toBe(true);
    // Printed so a failing run shows the number it got, not just "expected 1".
    console.log(`Mulliken spin population sum = ${populations.mullikenSum} (tolerance ±${SPIN_SUM_TOLERANCE})`);
    console.log(`Löwdin   spin population sum = ${populations.lowdinSum}`);
    expect(unpairedElectrons(FCHK)).toBe(1);
    expect(Math.abs(populations.mullikenSum - 1)).toBeLessThan(SPIN_SUM_TOLERANCE);
    expect(Math.abs(populations.lowdinSum - 1)).toBeLessThan(SPIN_SUM_TOLERANCE);
  });

  it('puts the unpaired electron on carbon, with negative spin on each hydrogen', () => {
    const [carbon, h1, h2, h3] = populations.populations;
    expect(carbon.element).toBe('C');
    expect(carbon.mulliken).toBeCloseTo(1.1552, 3);
    for (const hydrogen of [h1, h2, h3]) {
      expect(hydrogen.element).toBe('H');
      expect(hydrogen.mulliken).toBeCloseTo(-0.05175, 4);
      expect(hydrogen.lowdin).toBeCloseTo(-0.0272, 3);
    }
    // Three equivalent hydrogens: their populations agree to the SCF's own noise.
    expect(Math.abs(h1.mulliken - h3.mulliken)).toBeLessThan(1e-4);
  });

  it('builds a symmetric overlap matrix with unit diagonal for normalised AOs', () => {
    const basis = basisFunctions(FCHK);
    const S = overlapMatrix(basis);
    expect(S).toHaveLength(21 * 21);
    for (let i = 0; i < 21; i += 1) expect(S[i * 21 + i]).toBeCloseTo(1, 6);
    for (let i = 0; i < 21; i += 1) {
      for (let j = 0; j < 21; j += 1) expect(S[i * 21 + j]).toBeCloseTo(S[j * 21 + i], 12);
    }
  });

  it('states the scheme and the density block it came from', () => {
    expect(populations.source).toBe('Spin SCF Density');
    expect(populations.scheme).toContain('Mulliken');
    expect(populations.scheme).toContain('Löwdin');
    expect(populations.scheme).toContain('alpha');
  });
});

describe('Fermi-contact hyperfine coupling', () => {
  const hyperfine = hyperfineCouplings({ fchk: FCHK });

  it('reproduces the hydrogen-atom limit to 1 MHz — the constants are right', () => {
    // The H atom's spin density at the nucleus is 1/π bohr⁻³ for a single 1s
    // electron. The non-relativistic formula this module implements gives
    // 1422.8 MHz; the measured 21 cm line is 1420.4058 MHz, 0.17 % lower, and
    // that gap is exactly the relativistic / finite-proton-mass correction the
    // caveat says is omitted. So the assertion is against the formula's own
    // value, not against the measurement it does not reproduce.
    const hydrogenAtom = MHZ_PER_BOHR3_PER_G * NUCLEAR_ISOTOPES.H.gN * (1 / Math.PI);
    expect(hydrogenAtom).toBeCloseTo(1422.8, 0);
    expect(Math.abs(hydrogenAtom - 1420.4058) / 1420.4058).toBeLessThan(0.002);
    // And the gauss conversion: 1 G = 2.8024 MHz at g_e = 2.0023.
    expect(1 / GAUSS_PER_MHZ).toBeCloseTo(2.8024, 3);
  });

  it('gives CH3· couplings in the band this level supports', () => {
    const rows = hyperfine.couplings;
    expect(rows).toHaveLength(4);
    const hydrogen = rows[1];
    expect(hydrogen.status).toBe('reported');
    expect(hydrogen.element).toBe('H');
    // Measured on this fixture: −70.80 MHz (−25.26 G). The gas-phase
    // experimental proton coupling is 23.04 G, so a density-only UB3LYP value
    // lands within ~15 % on the high side — the band below says so.
    expect(hydrogen.aIsoMhz).toBeCloseTo(-70.8, 1);
    expect(hydrogen.aIsoGauss).toBeCloseTo(-25.26, 1);
    expect(Math.abs(hydrogen.aIsoGauss)).toBeGreaterThan(20);
    expect(Math.abs(hydrogen.aIsoGauss)).toBeLessThan(30);
    // Carbon carries most of the spin: ¹³C is the nucleus with I = 1/2.
    const carbon = rows[0];
    expect(carbon.massNumber).toBe(13);
    expect(carbon.naturalIsotope).toBe(false);
    expect(carbon.aIsoGauss).toBeGreaterThan(35);
    expect(carbon.aIsoGauss).toBeLessThan(50);
  });

  it('recomputes one coupling from the density independently', () => {
    // The hand formula, written out here with CODATA 2018 values so the test
    // does not borrow the module's constants:
    //   A[MHz] = (2 μ0 / 3) g_e μ_B g_N μ_N ρ_s(0) / (h a0³) / 10⁶
    const mu0 = 4 * Math.PI * 1e-7;              // N A⁻² (exact in the SI used here)
    const gElectron = 2.00231930436256;
    const muBohr = 9.2740100783e-24;             // J T⁻¹
    const muNuclear = 5.0507837461e-27;          // J T⁻¹
    const planck = 6.62607015e-34;               // J s
    const bohr = 5.29177210903e-11;              // m
    const perBohr3 = ((2 * mu0 / 3) * gElectron * muBohr * muNuclear) / (planck * bohr ** 3) / 1e6;

    const hydrogen = hyperfine.couplings[1];
    const handMhz = perBohr3 * NUCLEAR_ISOTOPES.H.gN * hydrogen.rhoSpinBohr3;
    expect(handMhz).toBeCloseTo(hydrogen.aIsoMhz, 6);
    // And the density itself: −0.015839 bohr⁻³ at each H nucleus.
    expect(hydrogen.rhoSpinBohr3).toBeCloseTo(-0.015839, 6);
    // Gauss from MHz, independently: B = h ν / (g_e μ_B).
    const handGauss = (handMhz * 1e6 * planck) / (gElectron * muBohr) * 1e4;
    expect(handGauss).toBeCloseTo(hydrogen.aIsoGauss, 6);
  });

  it('carries the method statement and the core-polarisation caveat', () => {
    expect(hyperfine.method).toContain('Fermi contact');
    expect(hyperfine.caveat).toContain('Density-only');
    expect(hyperfine.caveat).toContain('core polarisation');
    expect(hyperfine.caveat).toContain('spin-orbit');
    expect(hyperfine.unit).toEqual({ frequency: 'MHz', field: 'gauss', density: 'bohr^-3' });
  });

  it('reports no coupling for an element it has no nuclear data for', () => {
    // A spin density at a nucleus with no tabulated g-factor is a gap in this
    // module, not a zero coupling — the row says which one it is.
    const blinded = { ...FCHK, atoms: FCHK.atoms.map((atom) => ({ ...atom, element: 'Xx' })) };
    const rows = hyperfineCouplings({ fchk: blinded });
    expect(rows.couplings[0].status).toBe('no nuclear data');
    expect(rows.couplings[0].aIsoMhz).toBeUndefined();
  });
});

describe('the card states what the density supports', () => {
  it('an open-shell run renders both tables with their units', () => {
    const parsed = parsePsi4Output(LOG, { fchk: FCHK_TEXT });
    const html = resultsPanelHtml({ id: 'run-ch3', engine: 'psi4', parsed, gates: null });
    expect(html).toContain('Spin density / EPR');
    expect(html).toContain('data-field="epr-population-table"');
    expect(html).toContain('data-field="epr-hyperfine-table"');
    expect(html).toContain('Mulliken');
    expect(html).toContain('Löwdin');
    expect(html).toContain('MHz');
    expect(html).toContain('gauss');
    expect(html).toContain('electron');
    // The level of theory and the density-only caveat are on the card.
    expect(html).toContain('B3LYP');
    expect(html).toContain('Density-only');
  });

  it('a closed-shell molecule prints the exact words `no unpaired electrons`', () => {
    const parsed = parsePsi4Output(WATER_LOG);
    expect(parsed.epr.status).toBe('closed-shell');
    expect(parsed.epr.message).toBe('no unpaired electrons');
    expect(parsed.epr.populations).toEqual([]);
    expect(parsed.epr.hyperfine).toEqual([]);
    const html = resultsPanelHtml({ id: 'run-water', engine: 'psi4', parsed, gates: null });
    expect(html).toContain('no unpaired electrons');
    // And no empty table is drawn beside it.
    expect(html).not.toContain('data-field="epr-population-table"');
    expect(eprCardRows(parsed.epr)).toContainEqual(['EPR state', 'no unpaired electrons']);
  });

  it('an open-shell run with no checkpoint says so rather than showing empty tables', () => {
    const parsed = parsePsi4Output(LOG);
    expect(parsed.epr.status).toBe('unavailable');
    expect(parsed.epr.reason).toContain('no checkpoint');
    const html = resultsPanelHtml({ id: 'run-ch3', engine: 'psi4', parsed, gates: null });
    expect(html).toContain('not available');
    expect(html).not.toContain('data-field="epr-population-table"');
  });

  it('refuses the g-tensor by name — no number, no placeholder', () => {
    const parsed = parsePsi4Output(LOG, { fchk: FCHK_TEXT });
    const refusal = parsed.epr.gTensor;
    expect(refusal.status).toBe('refused');
    expect(refusal.engine).toBe('Psi4');
    expect(refusal.message).toContain('Psi4');
    expect(refusal.message).toContain('ORCA');
    expect(refusal).not.toHaveProperty('value');
    expect(parsed.epr.populations.some((row) => 'gTensor' in row)).toBe(false);
    const html = resultsPanelHtml({ id: 'run-ch3', engine: 'psi4', parsed, gates: null });
    expect(html).toContain('data-field="epr-gtensor"');
    expect(html).toContain('does not produce a g-tensor');
    expect(gTensorRefusal().missingCapability).toContain('g-tensor');
    // The capability table refuses it too, so a settings dialog cannot offer it.
    expect(PSI4_CAPABILITIES.epr.gTensor).toBe(false);
    expect(PSI4_CAPABILITIES.unsupportedFeatures.join(' ')).toContain('g-tensor');
  });
});

describe('canonicalResult and run.json carry the section', () => {
  const block = eprBlock({ fchk: FCHK, level: 'UKS B3LYP/6-31G*', engine: 'Psi4', multiplicity: 2 });

  it('passes the whole block through, not a whitelisted subset', () => {
    const canonical = canonicalResult({ engine: 'psi4', epr: block });
    expect(canonical.epr).toBe(block);
    expect(canonical.epr.populations[0].mulliken).toBeCloseTo(1.1552, 3);
    expect(canonical.epr.hyperfine[1].aIsoMhz).toBeCloseTo(-70.8, 1);
    expect(canonical.epr.gTensor.status).toBe('refused');
  });

  it('keeps the section gone when the engine reported none', () => {
    const canonical = canonicalResult({ engine: 'gaussian' });
    expect('epr' in canonical).toBe(false);
  });

  it('survives a JSON round trip, which is what run.json is', () => {
    const parsed = parsePsi4Output(LOG, { fchk: FCHK_TEXT });
    const round = JSON.parse(JSON.stringify({ id: 'run-ch3', parsed }));
    expect(round.parsed.epr.status).toBe('open-shell');
    expect(round.parsed.epr.populations).toHaveLength(4);
    expect(round.parsed.epr.populationSum).toBeCloseTo(1, 6);
  });
});

describe('the report section', () => {
  const parsed = parsePsi4Output(LOG, { fchk: FCHK_TEXT });
  const queue = {
    id: 'q-epr',
    projectName: 'Methyl radical',
    status: 'completed',
    tasks: [{ nodeId: 'sp~ch3', title: 'CH3 radical SP', type: 'calculate', status: 'passed', runId: 'run-ch3' }],
  };
  const records = { 'run-ch3': { id: 'run-ch3', engine: 'psi4', parsed, gates: { overall: 'pass' } } };

  it('renders both tables with units and the level of theory', () => {
    const html = workflowReportHtml(buildWorkflowReport(queue, records, { appVersion: '0.4.0' }));
    expect(html).toContain('Spin density / EPR');
    expect(html).toContain('data-field="epr-populations"');
    expect(html).toContain('Mulliken / e');
    expect(html).toContain('Löwdin / e');
    expect(html).toContain('data-field="epr-hyperfine"');
    expect(html).toContain('A_iso / MHz');
    expect(html).toContain('A_iso / gauss');
    expect(html).toContain('B3LYP');
    expect(html).toContain('Density-only');
    expect(html).toContain('g-tensor:');
  });

  it('prints `no unpaired electrons` for a closed-shell run in the report too', () => {
    const closed = parsePsi4Output(WATER_LOG);
    const closedQueue = {
      ...queue,
      tasks: [{ nodeId: 'sp~water', title: 'Water SP', type: 'calculate', status: 'passed', runId: 'run-water' }],
    };
    const html = workflowReportHtml(buildWorkflowReport(closedQueue, {
      'run-water': { id: 'run-water', engine: 'psi4', parsed: closed, gates: { overall: 'pass' } },
    }));
    expect(html).toContain('no unpaired electrons');
    expect(html).not.toContain('data-field="epr-populations"');
  });
});

describe('the spin density is a field the cube machinery can show', () => {
  it('returns the same field contract as a potential grid, and writes a cube', () => {
    const field = spinDensityOnGrid({ fchk: FCHK, grid: { counts: [8, 8, 8], origin: [-2.2, -2.2, -1.2], step: 0.55 } });
    expect(field.ok).toBe(true);
    expect(field.kind).toBe('spin-density');
    expect(field.signed).toBe(true);
    expect(field.dims).toEqual([8, 8, 8]);
    expect(field.values).toHaveLength(8 * 8 * 8);
    // Signed and normalised like a spin density: some points positive, some negative.
    expect(field.stats.max).toBeGreaterThan(0);
    const text = writeCube(field, { atoms: FCHK.atoms, units: 'angstrom' });
    // Cube layout: two comment lines, then `natoms ox oy oz`, then `nx ax ay az`.
    expect(text.split('\n')[2].trim().split(/\s+/)).toHaveLength(4);
    // An Å cube writes negative grid counts (the cube convention for units).
    expect(Math.abs(Number(text.split('\n')[3].trim().split(/\s+/)[0]))).toBe(8);
    expect(text).toContain('spin density');
  });

  it('offers the surface view an alpha−beta set, and nothing for a closed shell', () => {
    // The viewport draws a field by calling the density evaluator with +1/−1
    // occupations; that is the whole of the wiring, so the sets are what the
    // test pins. 5 alpha and 4 beta electrons over a 21-function basis.
    const sets = spinDensitySets(FCHK);
    expect(sets).not.toBeNull();
    expect(sets.coefficientsByMo).toHaveLength(9);
    expect(sets.occupations).toEqual([1, 1, 1, 1, 1, -1, -1, -1, -1]);
    expect(sets.unpaired).toBe(1);
    const closed = parseFchk(readFileSync(new URL('./fixtures/esp/water-esp.fchk', import.meta.url), 'utf8'));
    expect(spinDensitySets(closed)).toBeNull();
  });

  it('refuses a checkpoint without a spin block', () => {
    const closed = parseFchk(readFileSync(new URL('./fixtures/esp/water-esp.fchk', import.meta.url), 'utf8'));
    const field = spinDensityOnGrid({ fchk: closed, grid: { counts: [4, 4, 4], origin: [0, 0, 0], step: 0.5 } });
    expect(field.ok).toBe(false);
    expect(field.reason).toBe('no spin density in this file');
  });
});

describe('the Psi4 builder asks for the checkpoint it needs', () => {
  const build = (overrides = {}, moleculeOverrides = {}) => buildPsi4Input({
    settings: { method: 'b3lyp', basis: '6-31g(d)', jobType: 'SP', ...overrides },
    molecule: { ...RADICAL, ...moleculeOverrides },
    inputName: 'ch3.dat',
  });

  it('writes return_wfn and the fchk line for an open-shell single point', () => {
    const built = build();
    expect(built.inputText).toContain("E, wfn = energy('b3lyp', return_wfn=True)");
    expect(built.inputText).toContain("fchk(wfn, 'ch3.fchk')");
    expect(built.inputText).toContain('set reference uhf');
  });

  it('writes the checkpoint for a closed-shell single point too (issue 343)', () => {
    // A closed-shell checkpoint carries no `Spin SCF Density`, so the EPR block
    // still answers `no unpaired electrons`; the file exists because a Multiwfn
    // block wired to this run reads it.
    const built = build({}, { multiplicity: 1 });
    expect(built.inputText).toContain("E, wfn = energy('b3lyp', return_wfn=True)");
    expect(built.inputText).toContain("fchk(wfn, 'ch3.fchk')");
  });

  it('writes a checkpoint for every job type, and labels the correlated one', () => {
    // Issue 343: an optimisation writes the checkpoint at its final geometry.
    const opt = build({ jobType: 'Opt' });
    expect(opt.inputText).toContain("E, wfn = optimize('b3lyp', return_wfn=True)");
    expect(opt.inputText).toContain("fchk(wfn, 'ch3.fchk')");
    // MP2's `return_wfn` wavefunction is the SCF reference, and the deck says so
    // rather than letting `<job>.fchk` imply an MP2 density.
    const mp2 = build({ method: 'mp2' });
    expect(mp2.inputText).toContain("E, wfn = energy('mp2', return_wfn=True)");
    expect(mp2.inputText).toContain("fchk(wfn, 'ch3.fchk')");
    expect(mp2.inputText).toContain('its SCF reference');
  });

  it('does not label reference spin populations with a correlated method (issue 343)', () => {
    // The same log with an MP2 input echo; the committed checkpoint is a UB3LYP
    // one, which is exactly the "reference density" this must not misreport.
    const mp2Log = LOG.replace("energy('b3lyp', return_wfn=True)", "energy('mp2', return_wfn=True)");
    const parsed = parsePsi4Output(mp2Log, { fchk: FCHK_TEXT });
    expect(parsed.epr.status).toBe('unavailable');
    expect(parsed.epr.reason).toContain('SCF reference density');
    expect(parsed.epr.populations).toEqual([]);
    expect(parsed.epr.hyperfine).toEqual([]);
  });
});

describe('the fixture is the calculation it claims to be', () => {
  it('parses to the doublet it was run as', () => {
    const parsed = parsePsi4Output(LOG, { fchk: FCHK_TEXT });
    expect(parsed.engine).toBe('psi4');
    // Psi4 1.11's stdout prints no version line (only `psi4 --version` does), so
    // `program.version` is null for this build and the README carries the image
    // tag instead. The name is still there.
    expect(parsed.program.name).toBe('Psi4');
    expect(parsed.epr.electrons).toEqual({ alpha: 5, beta: 4, unpaired: 1 });
    expect(parsed.epr.level).toContain('B3LYP');
    expect(parsed.epr.provenance.spinDensityBlock).toBe('Spin SCF Density');
  });
});
