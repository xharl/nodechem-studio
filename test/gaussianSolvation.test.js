import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { canonicalResult } from '../src/shared/engines/canonical.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';
import { runValidityChecks } from '../src/shared/validityChecks.js';
import { methodsParagraphFor } from '../src/shared/methodsParagraph.js';

/**
 * Issue 223: a Gaussian SCRF run must not parse to the same record as the same
 * run in vacuum. The two fixtures are the public cclib Gaussian 16 files:
 *
 *   water_hf_solvent_smd.log  route line 87: SCRF=(SMD, Solvent=Toluene)
 *                             PCM header 179-195; SMD-CDS line 356
 *   water_hf_solvent_pcm.log  route line 87: SCRF=(PCM, Solvent=Toluene)
 *                             PCM header 179-195; no non-electrostatic term
 *
 * The numbers below are read from those lines, not invented.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'test/fixtures/real-public/gaussian-solvation');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const smd = parseGaussianOutput(read('water_hf_solvent_smd.log'));
const pcm = parseGaussianOutput(read('water_hf_solvent_pcm.log'));
const vacuum = parseGaussianOutput(fs.readFileSync(
  path.join(ROOT, 'test/fixtures/real/g16-a03-water-sp.out'),
  'utf8',
));

describe('Gaussian solvation record (issue 223)', () => {
  it('reads SMD from the route and the header, with the terms the log prints', () => {
    expect(smd.solvation).toMatchObject({
      provider: 'gaussian-scrf',
      model: 'SMD',
      headerModel: 'PCM',
      solvent: 'Toluene',
      dielectricConstant: 2.3741,
      epsilonInfinity: 2.238315,
      radiiSet: 'SMD-Coulomb',
      cavityType: 'VdW (van der Waals Surface)',
      cavityAlpha: 1,
      totalEnergyHartree: -74.9673020784,
      totalEnergyIncludesNonElectrostatic: true,
      electrostaticHartree: null,
      gasPhaseHartree: null,
      deltaHartree: null,
    });
    expect(smd.solvation.nonElectrostatic).toEqual({
      name: 'SMD-CDS',
      kcalPerMol: -0.85,
      hartree: -0.0013470649,
    });
  });

  it('reads a plain PCM run without inventing a non-electrostatic term', () => {
    expect(pcm.solvation).toMatchObject({
      provider: 'gaussian-scrf',
      model: 'PCM',
      solvent: 'Toluene',
      radiiSet: 'UFF (Universal Force Field)',
      cavityType: 'Scaled VdW (van der Waals Surface)',
      cavityAlpha: 1.1,
      totalEnergyHartree: -74.9663496977,
      totalEnergyIncludesNonElectrostatic: false,
      electrostaticHartree: null,
    });
    expect(pcm.solvation).not.toHaveProperty('nonElectrostatic');
  });

  it('leaves the section absent on a gas-phase log', () => {
    expect(vacuum.solvation).toBeUndefined();
    expect(vacuum.route).not.toMatch(/SCRF/i);
  });

  it('keeps the model and drops the solvent when the solvent line is removed', () => {
    const mutated = read('water_hf_solvent_smd.log').replace(/^\s*Solvent\s*:.*$/m, '');
    const parsed = parseGaussianOutput(mutated);
    expect(parsed.solvation).toMatchObject({ model: 'SMD', solvent: null });
  });

  it('survives canonicalResult with its evidence intact', () => {
    const canonical = canonicalResult({
      engine: 'gaussian',
      program: smd.program,
      termination: smd.termination,
      terminationCode: 'normal',
      finalEnergy: smd.finalEnergy,
      solvation: smd.solvation,
    });
    expect(canonical.solvation).toEqual(smd.solvation);
  });

  it('renders the Gaussian terms, not the DDX rows', () => {
    const html = resultsPanelHtml({
      engine: 'gaussian',
      status: 'completed',
      parsed: smd,
      gates: null,
    });
    expect(html).toContain('solvation-model');
    expect(html).toContain('SMD');
    expect(html).toContain('Toluene');
    expect(html).toContain('solvation-total');
    expect(html).toContain('-74.96730208 Eh');
    expect(html).toContain('solvation-non-electrostatic');
    expect(html).toContain('-0.85 kcal/mol');
    expect(html).toContain('not a solvation free energy');
    expect(html).not.toContain('DDX solute');
    expect(html).not.toContain('data-field="solvation-delta"');
  });
});

describe('solvation evidence check (issue 223)', () => {
  const finding = (parsed, solvation) => runValidityChecks({
    settings: { solvation },
    parsed,
  }, { phase: 'post', engine: 'gaussian' }).findings
    .find((entry) => entry.id === 'solvation-evidence');

  it('passes when the block asked for solvation and the log reports it', () => {
    expect(finding(smd, true)).toMatchObject({ status: 'pass' });
  });

  it('warns when the block asked and the log reports none', () => {
    expect(finding(vacuum, true)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/requested solvation/),
    });
  });

  it('warns when the log reports solvation the block did not ask for', () => {
    expect(finding(smd, false)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/did not request/),
    });
  });
});

describe('solvation in the methods paragraph (issue 223)', () => {
  it('names the parsed model and solvent instead of saying not recorded', () => {
    const paragraph = methodsParagraphFor({ engine: 'gaussian', parsed: smd }, { form: 'full' });
    expect(paragraph.plain).toContain('SMD');
    expect(paragraph.plain).toContain('Toluene');
    expect(paragraph.plain).toContain('not a solvation free energy');
  });
});
