/**
 * Issue 167: Psi4 blocks in solvent, through the DDX addon.
 *
 * The fixture pair in `fixtures/psi4-ddx/` is two real Psi4 1.11 runs at one
 * level — gas phase and DDX-PCM water — produced from decks this builder wrote
 * (see the PROVENANCE.md beside them for image, command and sha256). Three
 * things here are deliberately not asserted from memory:
 *
 * - the two decks are compared byte-for-byte against what `buildPsi4Input`
 *   writes now, so a builder change that invalidates the fixtures fails;
 * - the energies are pinned to the logs' own digits, and the difference is also
 *   recomputed from the two of them rather than compared with itself;
 * - the image *without* pyddx is a fixture too: the addon is a prerequisite, and
 *   the parser must not read a failed solvated run as a solvated number.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PSI4_CAPABILITIES,
  PSI4_DDX_SOLVENTS,
  PSI4_SOLVATION_MODELS,
  buildPsi4Input,
  parsePsi4Output,
  psi4MethodBlock,
  psi4SettingsOffenders,
  psi4SolvationFor,
} from '../src/shared/engines/psi4.js';
import { parseFchk } from '../src/shared/fchk.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/psi4-ddx/${name}`, import.meta.url), 'utf8');

const GAS_DECK = fixture('water-gas.dat');
const GAS_LOG = fixture('water-gas.out');
const PCM_DECK = fixture('water-pcm.dat');
const PCM_LOG = fixture('water-pcm.out');
const FCHK_DECK = fixture('water-pcm-fchk.dat');
const FCHK_LOG = fixture('water-pcm-fchk.out');
const FCHK = fixture('water-pcm.fchk');
const NO_PYDDX_LOG = fixture('water-pcm-no-pyddx.out');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];
const molecule = { charge: 0, multiplicity: 1, coords: WATER, fragments: [] };
const SETTINGS = {
  jobType: 'SP', method: 'hf', basis: '6-31g(d)', memory: '4', memoryUnit: 'GB',
  solvation: false, solvationModel: 'PCM', solvent: 'Water',
};
const build = (overrides = {}, inputName = 'water-gas.dat', title = 'water gas phase') => buildPsi4Input({
  title, settings: { ...SETTINGS, ...overrides }, molecule, inputName,
});

// The four numbers these logs print, to the digits they print.
const GAS_HARTREE = -76.010478658918117;
const SOLVATED_HARTREE = -76.018719371410768;
const INTERACTION_HARTREE = -0.008887466630479;
const HARTREE_KCAL = 627.5094740631;

describe('Psi4 DDX solvation — the committed fixture pair', () => {
  it('reads the gas-phase half and reports no solvation block at all', () => {
    const parsed = parsePsi4Output(GAS_LOG);
    expect(parsed.program.version).toBe('1.11');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(GAS_HARTREE, 12);
    expect(parsed.solvation).toBeUndefined();
  });

  it('reads both single points, their difference and the interaction term', () => {
    const parsed = parsePsi4Output(PCM_LOG);
    const solvation = parsed.solvation;
    expect(solvation.provider).toBe('ddx');
    expect(solvation.model).toBe('pcm');
    expect(solvation.solvent).toBe('water');
    expect(solvation.radiiSet).toBe('uff');
    expect(solvation.radiiScaling).toBeCloseTo(1.1, 12);
    expect(solvation.dielectricConstant).toBeCloseTo(78.3553, 4);
    expect(solvation.pyddxVersion).toBe('1.0.0');

    expect(solvation.gasPhaseHartree).toBeCloseTo(GAS_HARTREE, 12);
    expect(solvation.solvatedHartree).toBeCloseTo(SOLVATED_HARTREE, 12);
    // Recomputed, not compared with itself: the difference of the two printed
    // totals, at the precision the log prints them.
    expect(solvation.deltaHartree).toBeCloseTo(SOLVATED_HARTREE - GAS_HARTREE, 12);
    expect(solvation.deltaKcal).toBeCloseTo((SOLVATED_HARTREE - GAS_HARTREE) * HARTREE_KCAL, 8);
    expect(solvation.deltaKcal).toBeCloseTo(-5.1711, 4);
  });

  it('keeps the DDX solute-solvent interaction apart from the difference', () => {
    const { solvation } = parsePsi4Output(PCM_LOG);
    expect(solvation.interactionHartree).toBeCloseTo(INTERACTION_HARTREE, 12);
    expect(solvation.interactionKcal).toBeCloseTo(-5.5770, 4);
    // They are different quantities on this molecule: the interaction is taken
    // at the solvated density and does not include the solvent's effect on the
    // solute's own electron distribution. Reporting one as the other would be a
    // 0.65 mEh error presented as a definition.
    const gap = Math.abs(solvation.deltaHartree - solvation.interactionHartree);
    expect(gap * 1000).toBeCloseTo(0.6468, 3);
  });

  it('reads the same three energies from the deck that writes the checkpoint', () => {
    const parsed = parsePsi4Output(FCHK_LOG, { fchk: FCHK });
    expect(parsed.solvation.solvatedHartree).toBeCloseTo(SOLVATED_HARTREE, 12);
    expect(parsed.solvation.deltaKcal).toBeCloseTo(-5.1711, 4);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(SOLVATED_HARTREE, 10);
    // The checkpoint beside it is still readable, and it is a closed-shell RHF
    // density: solvation does not turn the EPR block into something else.
    const checkpoint = parseFchk(FCHK);
    expect(checkpoint.atoms).toHaveLength(3);
    expect(parsed.epr.status).toBe('closed-shell');
  });

  it('treats a solvated run in an image without pyddx as an error, not a number', () => {
    const parsed = parsePsi4Output(NO_PYDDX_LOG);
    expect(parsed.terminationCode).toBe('error');
    expect(parsed.extras.errorDetail).toMatch(/Python module ddx not found/);
    // The deck's echo names the model and the solvent, and the gas-phase half
    // did converge — but no solvated energy was produced, so the difference and
    // the interaction are absent rather than zero.
    expect(parsed.solvation).toBeDefined();
    expect(parsed.solvation.gasPhaseHartree).toBeCloseTo(GAS_HARTREE, 12);
    expect(parsed.solvation.solvatedHartree).toBeNull();
    expect(parsed.solvation.deltaHartree).toBeNull();
    expect(parsed.solvation.interactionHartree).toBeNull();
  });

  it('reports no difference when the log carries no gas-phase half', () => {
    // A hand-written deck (or a trimmed log) prints the solvated total but not
    // the gas-phase one. The interaction term is then the only solvent number,
    // and the difference stays unknown instead of being derived from it.
    const trimmed = PCM_LOG
      .split('\n')
      .filter((line) => !/^NCS gas-phase energy/.test(line))
      .join('\n');
    const parsed = parsePsi4Output(trimmed);
    expect(parsed.solvation.gasPhaseHartree).toBeNull();
    expect(parsed.solvation.deltaHartree).toBeNull();
    expect(parsed.solvation.deltaKcal).toBeNull();
    expect(parsed.solvation.solvatedHartree).toBeCloseTo(SOLVATED_HARTREE, 12);
    expect(parsed.solvation.interactionHartree).toBeCloseTo(INTERACTION_HARTREE, 12);
  });
});

describe('Psi4 DDX deck', () => {
  it('writes the gas-phase and the solvated single point into one reviewed script', () => {
    const { inputText } = build({ solvation: true }, 'water-pcm.dat', 'water DDX-PCM');
    const gasCall = inputText.indexOf("E_gas = energy('scf')");
    const ddxOn = inputText.indexOf('set ddx true');
    const solvCall = inputText.indexOf("E_solv, wfn = energy('scf', return_wfn=True)");
    expect(gasCall).toBeGreaterThan(-1);
    expect(gasCall).toBeLessThan(ddxOn);
    expect(ddxOn).toBeLessThan(solvCall);
    // The gas-phase half is run with DDX explicitly off, not by relying on a
    // default that a future release could change.
    expect(inputText.indexOf('set ddx false')).toBeLessThan(gasCall);
    expect(inputText).toContain('set ddx_model pcm');
    expect(inputText).toContain('set ddx_solvent water');
    expect(inputText).toContain('set ddx_radii_set uff');
    expect(inputText).toContain('set ddx_radii_scaling 1.1');
    // Both energies are echoed with a marker; the log prints `@DF-RHF Final
    // Energy:` twice, and position alone is not a label.
    expect(inputText).toContain('"NCS gas-phase energy = %.15f');
    expect(inputText).toContain('"NCS solvated energy = %.15f');
    // Issue 343: the checkpoint is the solvated density — the last SCF — and it
    // is written after the solvated energy, not after the gas-phase one.
    expect(inputText.indexOf("fchk(wfn, 'water-pcm.fchk')")).toBeGreaterThan(solvCall);
  });

  // Issue 343: every deck with a wavefunction now appends `return_wfn=True` and a
  // `fchk(...)` line. The captured `.dat` fixtures are the same scripts without
  // those two statements, so removing them has to reproduce the measured input
  // byte for byte; a change anywhere else fails here.
  const stripGasCheckpoint = (text) => text
    .replace("E, wfn = energy('scf', return_wfn=True)", "energy('scf')")
    .replace("\nfchk(wfn, 'water-gas.fchk')\n", '\n');
  const stripPcmCheckpoint = (text) => text
    .replace("E_solv, wfn = energy('scf', return_wfn=True)", "E_solv = energy('scf')")
    .replace("\nfchk(wfn, 'water-pcm.fchk')\n", '\n');

  it('writes the measured decks plus the checkpoint statements issue 343 added', () => {
    const gas = build().inputText;
    const pcm = build({ solvation: true }, 'water-pcm.dat', 'water DDX-PCM').inputText;
    expect(stripGasCheckpoint(gas)).toBe(GAS_DECK);
    expect(stripPcmCheckpoint(pcm)).toBe(PCM_DECK);
    // The solvated deck is the hand-touched `water-pcm-fchk.dat` whose log and
    // .fchk are committed; the builder's own quote style is the only difference.
    expect(pcm).toBe(FCHK_DECK.replace(
      'E_solv, wfn = energy("scf", return_wfn=True)',
      "E_solv, wfn = energy('scf', return_wfn=True)",
    ));
  });

  it('writes nothing about DDX when the block asks for no solvent', () => {
    const { inputText } = build({ solvation: false, solvationModel: 'SMD', solvent: 'Toluene' });
    expect(stripGasCheckpoint(inputText)).toBe(GAS_DECK);
    expect(inputText).not.toContain('ddx');
    // A stored model/solvent on a solvation-off block is an inert placeholder,
    // not a request — the schema fills both fields on every block.
    expect(psi4SettingsOffenders({ ...SETTINGS, solvation: false, solvationModel: 'SMD' })).toEqual([]);
  });

  it('refuses a solvent it cannot name, instead of running it in water', () => {
    expect(() => build({ solvation: true, solvent: 'Diethyl Ether' }, 'x.dat'))
      .toThrow(/Solvent "Diethyl Ether" has no DDX name/);
    // The refusal names what is available, so the user can pick one.
    expect(() => build({ solvation: true, solvent: 'Diethyl Ether' }, 'x.dat'))
      .toThrow(/Water, Dichloromethane, THF/);
    // And a preflight sees the same refusal on the field that caused it.
    expect(psi4SettingsOffenders({ ...SETTINGS, solvation: true, solvent: 'Diethyl Ether' }))
      .toEqual([{ field: 'solvent', message: expect.stringMatching(/has no DDX name/) }]);
  });

  it('refuses SMD, CPCM and LPB by name, with what to choose instead', () => {
    expect(() => build({ solvation: true, solvationModel: 'SMD' }, 'x.dat'))
      .toThrow(/Psi4 has no SMD solvation/);
    expect(() => build({ solvation: true, solvationModel: 'SMD' }, 'x.dat'))
      .toThrow(/SMD needs a cavity and thermodynamic treatment/);
    expect(() => build({ solvation: true, solvationModel: 'CPCM' }, 'x.dat'))
      .toThrow(/conductor model DDX implements is COSMO/);
    expect(() => build({ solvation: true, solvationModel: 'LPB' }, 'x.dat'))
      .toThrow(/ddx_solvent_kappa/);
    expect(psi4SettingsOffenders({ ...SETTINGS, solvation: true, solvationModel: 'LPB' }))
      .toEqual([{ field: 'solvationModel', message: expect.stringMatching(/ddx_solvent_kappa/) }]);
  });

  it('refuses solvation where the deck cannot write the pair', () => {
    expect(() => build({ solvation: true, jobType: 'Opt' }, 'x.dat'))
      .toThrow(/must be SP/);
    expect(() => build({ solvation: true, jobType: 'TD-DFT', tdStates: 3 }, 'x.dat'))
      .toThrow(/must be SP/);
    // DDX couples to the SCF in 1.11, so a correlated "solvated energy" would be
    // correlation on a solvated reference with no solvent response of its own.
    expect(() => build({ solvation: true, method: 'mp2' }, 'x.dat'))
      .toThrow(/DDX couples to the SCF/);
    // A solvated block runs two SCFs, so it has no single spin density for the
    // open-shell EPR checkpoint (issue 168).
    expect(() => buildPsi4Input({
      title: 'open shell', settings: { ...SETTINGS, solvation: true, multiplicity: 2 },
      molecule: { ...molecule, multiplicity: 2 }, inputName: 'x.dat',
    })).toThrow(/no single spin density/);
  });

  it('accepts every solvent it advertises, and no other', () => {
    for (const label of Object.keys(PSI4_DDX_SOLVENTS)) {
      const deck = build({ solvation: true, solvent: label }, 'x.dat').inputText;
      expect(deck).toContain(`set ddx_solvent ${PSI4_DDX_SOLVENTS[label]}`);
      expect(deck).toContain('set ddx true');
      expect(psi4SettingsOffenders({ ...SETTINGS, solvation: true, solvent: label })).toEqual([]);
    }
  });

  it('records the model and the cavity in the run provenance', () => {
    const built = build({ solvation: true }, 'water-pcm.dat', 'water DDX-PCM');
    expect(built.route).toContain('PCM/water (DDX)');
    const solvOf = (settings) => psi4MethodBlock({ ...SETTINGS, ...settings }).solvation;
    expect(solvOf({ solvation: true })).toBe('DDX PCM/Water (uff radii x1.1)');
    expect(solvOf({ solvation: true, solvationModel: 'COSMO', solvent: 'THF' }))
      .toBe('DDX COSMO/THF (uff radii x1.1)');
    expect(solvOf({ solvation: false })).toBeNull();
  });
});

describe('Psi4 capability table matches what the builder writes', () => {
  it('names exactly the models the builder emits', () => {
    expect(PSI4_CAPABILITIES.solvationModels).toEqual(PSI4_SOLVATION_MODELS);
    for (const model of PSI4_CAPABILITIES.solvationModels) {
      const deck = build({ solvation: true, solvationModel: model }, 'x.dat').inputText;
      expect(deck).toContain(`set ddx_model ${model.toLowerCase()}`);
      expect(psi4SolvationFor({ ...SETTINGS, solvation: true, solvationModel: model }).model)
        .toBe(model);
    }
    // A model the builder refuses must not appear in the same list.
    for (const refused of ['SMD', 'CPCM', 'LPB']) {
      expect(PSI4_CAPABILITIES.solvationModels).not.toContain(refused);
      expect(() => build({ solvation: true, solvationModel: refused }, 'x.dat')).toThrow();
    }
  });

  it('names exactly the solvents the builder accepts', () => {
    expect(PSI4_CAPABILITIES.solvents).toEqual(PSI4_DDX_SOLVENTS);
    expect(Object.keys(PSI4_CAPABILITIES.solvents).sort())
      .toEqual(Object.keys(PSI4_DDX_SOLVENTS).sort());
    // Every advertised solvent must resolve, and an unadvertised one must not.
    for (const label of Object.keys(PSI4_CAPABILITIES.solvents)) {
      expect(psi4SolvationFor({ ...SETTINGS, solvation: true, solvent: label })).not.toBeNull();
    }
    expect(() => psi4SolvationFor({ ...SETTINGS, solvation: true, solvent: 'Not A Solvent' })).toThrow();
  });

  it('states what a solvated block is, and what it needs', () => {
    const { solvation } = PSI4_CAPABILITIES;
    expect(solvation.provider).toBe('ddx');
    expect(solvation.jobTypes).toEqual(['SP']);
    expect(solvation.gasPhasePair).toBe(true);
    expect(solvation.radiiSet).toBe('uff');
    // The addon is not part of Psi4 core, and the reference image does not ship
    // it — the capability says so rather than implying solvation runs anywhere.
    expect(solvation.requires).toMatch(/pyddx/);
    expect(solvation.quantity).toMatch(/not a solvation free energy/);
    expect(PSI4_CAPABILITIES.unsupportedFeatures.join(' ')).toMatch(/solvation free energies/);
    expect(PSI4_CAPABILITIES.unsupportedFeatures.join(' ')).not.toMatch(/Psi4 core has no PCM/);
  });
});

describe('Results card for a solvated run', () => {
  const html = () => resultsPanelHtml({ id: 'run-pcm', engine: 'psi4', parsed: parsePsi4Output(PCM_LOG), gates: null });

  it('shows the gas phase, the solvated energy, the difference and the interaction', () => {
    const panel = html();
    expect(panel).toContain('Solvation');
    expect(panel).toContain('data-field="solvation-gas"');
    expect(panel).toContain('data-field="solvation-solvated"');
    expect(panel).toContain('data-field="solvation-delta"');
    expect(panel).toContain('data-field="solvation-interaction"');
    expect(panel).toContain('-76.01047866');
    expect(panel).toContain('-76.01871937');
    expect(panel).toContain('-5.17 kcal/mol');
    expect(panel).toContain('-5.58 kcal/mol');
    expect(panel).toContain('DDX 1.0.0');
    expect(panel).toContain('uff');
  });

  it('never calls any of it a free energy', () => {
    const panel = html();
    expect(panel).toContain('not a solvation free energy');
    expect(panel).toMatch(/not PCMSolver/);
    expect(panel).not.toMatch(/ΔG/);
    expect(JSON.stringify(parsePsi4Output(PCM_LOG))).not.toMatch(/deltaG|freeEnergy.?solv/i);
  });

  it('draws no card for a gas-phase run, and says why the difference is missing when it is', () => {
    expect(resultsPanelHtml({ id: 'run-gas', engine: 'psi4', parsed: parsePsi4Output(GAS_LOG), gates: null }))
      .not.toContain('data-field="solvation-delta"');

    const trimmed = PCM_LOG.split('\n').filter((line) => !/^NCS gas-phase energy/.test(line)).join('\n');
    const partial = resultsPanelHtml({ id: 'run-p', engine: 'psi4', parsed: parsePsi4Output(trimmed), gates: null });
    expect(partial).toContain('data-field="solvation-delta"');
    expect(partial).toContain('carries no gas-phase single point');
    // The absent number is shown as missing, never as 0.00.
    expect(partial).not.toMatch(/ΔE\(solv\)<\/dt><dd data-field="solvation-delta">0\.00000000/);
  });
});
