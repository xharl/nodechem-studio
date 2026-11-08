import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseScanSummary } from '../src/shared/reactionPath.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${rel}`, import.meta.url)), 'utf8');
const ircText = read('irc-summary.log');
const relaxedText = read('scan-relaxed.log');

const record = (parsed) => ({
  id: '20261108-000000-abc123',
  status: 'completed',
  engine: 'gaussian',
  title: 'Reaction',
  dryRun: false,
  truncated: false,
  parsed,
  gates: { overall: 'pass' },
  provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: '6-31G(d)' } },
});

describe('reaction card kinetics', () => {
  const parsed = parseGaussianOutput(ircText);

  it('prints k with its unit, the temperature table and the ΔG‡ it came from', () => {
    const html = resultsPanelHtml(record(parsed), {
      reaction: { available: true, kcalPerMol: 20, temperatureK: 298.15 },
      molecularity: 1,
    });
    expect(html).toContain('data-field="kinetics"');
    expect(html).toContain('k = 1.36 × 10⁻² s⁻¹ at 298.15 K');
    expect(html).toContain('data-field="kinetics-temperature-table"');
    expect(html).toContain('ΔG‡ = 20.00 kcal mol⁻¹ from G(TS) − G(reactant)');
    expect(html).toContain('Sum of electronic and thermal Free Energies');
    expect(html).toContain('Molecularity 1 from');
  });

  it('uses M⁻¹s⁻¹ for a bimolecular reaction and refuses a half-life', () => {
    const html = resultsPanelHtml(record(parsed), {
      reaction: { available: true, kcalPerMol: 20, temperatureK: 298.15 },
      molecularity: 2,
    });
    expect(html).toContain('M⁻¹s⁻¹');
    expect(html).toContain('not applicable (bimolecular rate depends on concentration)');
  });

  it('renders not reported when the reaction has no free energies', () => {
    const html = resultsPanelHtml(record(parsed), {
      reaction: { available: false, reason: 'the reactant has no free energy.' },
      molecularity: 1,
    });
    expect(html).toContain('k = not reported');
    expect(html).toContain('the reactant has no free energy');
    expect(html).not.toContain('k = 0');
  });

  it('does not claim a rate without a queue verdict', () => {
    const html = resultsPanelHtml(record(parsed));
    expect(html).toContain('data-field="kinetics"');
    expect(html).toContain('k = <strong>not reported</strong>');
    expect(html).not.toContain('s⁻¹');
  });
});

describe('scan card names a scan barrier', () => {
  it('prints the extremum as a scan barrier with its grid resolution', () => {
    const recordWithScan = record({ scan: parseScanSummary(relaxedText) });
    const html = resultsPanelHtml(recordWithScan);
    expect(html).toContain('Scan barrier:');
    expect(html).toContain('±');
    expect(html).toContain('not a transition-state barrier');
    expect(html).toContain('no ΔG‡');
    expect(html).not.toContain('data-field="kinetics"');
  });
});

describe('solution energetics card', () => {
  const species = (label, hartree) => ({ label, thermochemistry: { freeEnergyHartree: hartree } });

  it('renders a pKa cycle with its reference citation and the 1.364 unit', () => {
    const html = resultsPanelHtml(record({
      cycles: [{
        kind: 'pka',
        acid: species('acetic acid', -100),
        conjugateBase: species('acetate', -99.98),
        referenceAcid: species('reference acid', -90),
        referenceBase: species('reference base', -89.99),
        referenceId: 'acetic-acid',
        solvent: 'water',
        temperatureK: 298.15,
      }],
    }));
    expect(html).toContain('data-field="pka-cycle"');
    expect(html).toContain('pKa = 9.36');
    expect(html).toContain('1.364 kcal mol⁻¹ per pKa unit');
    expect(html).toContain('CRC Handbook');
    expect(html).toContain('ΔG_deprot = 12.55 kcal mol⁻¹');
  });

  it('renders a refusal for a cycle with no conjugate-base free energy', () => {
    const html = resultsPanelHtml(record({
      cycles: [{
        kind: 'pka',
        acid: species('acetic acid', -100),
        conjugateBase: { label: 'acetate', thermochemistry: {} },
        referenceAcid: species('reference acid', -90),
        referenceBase: species('reference base', -89.99),
        referenceId: 'acetic-acid',
        solvent: 'water',
      }],
    }));
    expect(html).toContain('pKa = not reported');
    expect(html).toContain('conjugate base free energy');
  });

  it('renders a redox cycle with n, F and the SHE offset', () => {
    const html = resultsPanelHtml(record({
      cycles: [{
        kind: 'redox',
        oxidized: { label: 'Ox+', charge: 1, thermochemistry: { freeEnergyHartree: -100 } },
        reduced: { label: 'Red', charge: 0, thermochemistry: { freeEnergyHartree: -100.02 } },
        reference: {
          coupleId: 'ag-agcl',
          oxidized: species('Ag+', -90),
          reduced: species('Ag', -90.01),
        },
        solvent: 'water',
        temperatureK: 298.15,
      }],
    }));
    expect(html).toContain('data-field="redox-cycle"');
    expect(html).toContain('E° = 0.469 V vs SHE');
    expect(html).toContain('n = 1');
    expect(html).toContain('F = 23.0605 kcal mol⁻¹ V⁻¹');
    expect(html).toContain('SHE offset 0.197 V');
  });

  it('renders nothing when no cycle is present', () => {
    expect(resultsPanelHtml(record({}))).not.toContain('Solution energetics');
  });
});
