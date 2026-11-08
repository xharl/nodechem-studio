import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { ensembleThermo, thermoAt } from '../src/shared/thermoSweep.js';
import { resultsPanelHtml, thermoTableData } from '../src/renderer/resultsView.js';

const parsed = parseGaussianOutput(readFileSync(
  fileURLToPath(new URL('./fixtures/real/g09-dvb-ir.out', import.meta.url)),
  'utf8',
));

function record(parsedOutput) {
  return {
    id: '20261108-000000-thermo',
    status: 'completed',
    engine: 'gaussian',
    title: 'Frequency',
    dryRun: false,
    truncated: false,
    parsed: parsedOutput,
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
  };
}

describe('thermochemistry workbench data', () => {
  it('reports the six itemised terms and a total that is the correction to G', () => {
    const data = thermoTableData(parsed, { temperatureK: 298.15, pressureAtm: 1 });
    expect(data.available).toBe(true);
    expect(data.terms.map((term) => term.id)).toEqual([
      'zero-point', 'translational', 'rotational', 'vibrational', 'pv', 'entropy',
    ]);
    const sum = data.terms.reduce((total, term) => total + term.kcalPerMol, 0);
    expect(sum).toBeCloseTo(data.totalKcalPerMol, 9);
    // 89.944 kcal/mol below the electronic energy at the printed conditions.
    expect(data.totalKcalPerMol).toBeCloseTo(89.944, 2);
    expect(data.gibbsHartree).toBeCloseTo(-382.164931, 4);
  });

  it('switching a term off removes exactly that contribution', () => {
    const withZpe = thermoTableData(parsed, { temperatureK: 298.15, pressureAtm: 1 });
    const zeroPoint = withZpe.terms.find((term) => term.id === 'zero-point').kcalPerMol;
    const without = thermoTableData(parsed, {
      temperatureK: 298.15,
      pressureAtm: 1,
      enabled: new Set(['translational', 'rotational', 'vibrational', 'pv', 'entropy']),
    });
    expect(without.terms.some((term) => term.id === 'zero-point')).toBe(false);
    expect(without.totalKcalPerMol).toBeCloseTo(withZpe.totalKcalPerMol - zeroPoint, 9);
  });

  it('answers 350 K and 0.1 atm with the printed standard state stated', () => {
    const data = thermoTableData(parsed, { temperatureK: 350, pressureAtm: 0.1 });
    expect(data.temperatureK).toBe(350);
    expect(data.pressureAtm).toBe(0.1);
    expect(data.standardState).toEqual({ temperatureK: 298.15, pressureAtm: 1 });
    expect(data.totalKcalPerMol).toBeCloseTo(83.421, 2);
  });

  it('refuses to fabricate a table when the constants are missing', () => {
    const data = thermoTableData({ thermochemistry: {}, frequencies: { values: [] } });
    expect(data.available).toBe(false);
    expect(data.reason).toMatch(/molecular mass/);
  });
});

describe('thermochemistry card', () => {
  const html = resultsPanelHtml(record(parsed));

  it('renders the workbench controls and the itemised table', () => {
    expect(html).toContain('data-role="thermo-workbench"');
    expect(html).toContain('data-thermo-temperature');
    expect(html).toContain('data-thermo-pressure');
    expect(html).toContain('data-thermo-export');
    expect(html).toContain('data-field="thermo-workbench-holder"');
    expect(html).toContain('Σ correction to G');
    expect(html).toContain('Zero-point energy');
  });

  it('states the conditions, the standard state and what is not modelled', () => {
    expect(html).toContain('RRHO at 298.15 K and 1 atm');
    expect(html).toContain('Standard state for the printed table: 298.15 K, 1 atm');
    expect(html).toContain('Electronic excitation is not modelled');
  });

  it('offers the conformer ensemble picker', () => {
    expect(html).toContain('data-field="thermo-ensemble-picker"');
  });

  it('omits the workbench when the output cannot support a recomputation', () => {
    const bare = resultsPanelHtml(record(parseGaussianOutput(' Normal termination of Gaussian 16')));
    expect(bare).not.toContain('data-role="thermo-workbench"');
  });
});

describe('conformer ensemble', () => {
  const H = (kcal) => kcal / 627.5094740631;

  it('gives Boltzmann populations that sum to one', () => {
    const result = ensembleThermo([
      { id: 'a', gibbsHartree: -100 },
      { id: 'b', gibbsHartree: -100 + H(0.6) },
      { id: 'c', gibbsHartree: -100 + H(1.5) },
    ], { temperatureK: 298.15 });
    expect(result.available).toBe(true);
    const total = result.entries.reduce((sum, entry) => sum + entry.population, 0);
    expect(total).toBeCloseTo(1, 12);
    // Ratio of neighbours is exp(-ΔG/RT), independent of the normalisation.
    const ratio = result.entries[1].population / result.entries[0].population;
    expect(ratio).toBeCloseTo(Math.exp(-0.6 / ((8.314462618 * 298.15) / 4184)), 9);
    expect(result.entries[0].population).toBeGreaterThan(result.entries[1].population);
    expect(result.entries[1].population).toBeGreaterThan(result.entries[2].population);
  });

  it('matches the two-state Boltzmann fraction at 298 K', () => {
    const two = ensembleThermo([
      { id: 'low', gibbsHartree: -100 },
      { id: 'high', gibbsHartree: -100 + H(0.6) },
    ], { temperatureK: 298.15 });
    expect(two.entries[0].population).toBeCloseTo(0.734, 3);
    expect(two.entries[1].population).toBeCloseTo(0.266, 3);
  });

  it('reports an ensemble free energy below the lowest member', () => {
    const result = ensembleThermo([{ id: 'a', gibbsHartree: -100 }, { id: 'b', gibbsHartree: -100 + H(0.6) }], { temperatureK: 298.15 });
    expect(result.ensembleRelativeKcalPerMol).toBeLessThan(0);
    expect(result.ensembleHartree).toBeLessThan(-100);
  });

  it('refuses to build an ensemble from one record', () => {
    const result = ensembleThermo([{ id: 'a', gibbsHartree: -100 }], {});
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/at least two/);
  });

  it('never mixes in a record that has no free energy', () => {
    const result = ensembleThermo([{ id: 'a', gibbsHartree: -100 }, { id: 'b' }, { id: 'c', gibbsHartree: -99.9 }], {});
    expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'c']);
  });
});
