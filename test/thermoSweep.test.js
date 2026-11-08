import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { thermoAt, thermoCsv, thermoGrid } from '../src/shared/thermoSweep.js';

const parsed = parseGaussianOutput(readFileSync(
  fileURLToPath(new URL('./fixtures/real/g09-dvb-ir.out', import.meta.url)),
  'utf8',
));

describe('thermochemistry constants are parsed', () => {
  it('reads mass, symmetry number and the thermochemistry-block rotational constants', () => {
    const thermo = parsed.thermochemistry;
    expect(thermo.molecularMassAmu).toBeCloseTo(130.07825, 5);
    expect(thermo.symmetryNumber).toBe(2);
    expect(thermo.rotationalConstantsGHz).toEqual([4.62649, 0.68494, 0.59661]);
    expect(thermo.rotationalTemperaturesK).toEqual([0.22204, 0.03287, 0.02863]);
  });
});

describe('reproduces Gaussian at the printed temperature', () => {
  const result = thermoAt(parsed, { temperatureK: 298.15, pressureAtm: 1 });

  it('is available from a real frequency job', () => {
    expect(result.available).toBe(true);
    expect(result.geometry).toBe('nonlinear');
    expect(result.frequencyCount).toBe(54);
  });

  it('matches the printed entropy components to 0.001 cal/mol/K', () => {
    const printed = parsed.thermochemistry.entropyCalPerMolK;
    expect(result.components.translational.entropyCalPerMolK).toBeCloseTo(printed.translational, 3);
    expect(result.components.rotational.entropyCalPerMolK).toBeCloseTo(printed.rotational, 3);
    expect(result.components.vibrational.entropyCalPerMolK).toBeCloseTo(printed.vibrational, 2);
    expect(result.totals.entropyCalPerMolK).toBeCloseTo(printed.total, 3);
  });

  it('matches the printed thermal and free-energy corrections in hartree', () => {
    const printed = parsed.thermochemistry;
    expect(result.totals.enthalpyKcalPerMol / 627.5094740631)
      .toBeCloseTo(printed.thermalCorrectionEnthalpyHartree, 5);
    expect(result.totals.gibbsKcalPerMol / 627.5094740631)
      .toBeCloseTo(printed.thermalCorrectionFreeEnergyHartree, 5);
    expect(result.absolute.gibbsHartree).toBeCloseTo(printed.freeEnergyHartree, 5);
  });

  it('matches the printed vibrational thermal energy once the ZPE is removed', () => {
    const printed = parsed.thermochemistry;
    expect(result.components.vibrational.energyKcalPerMol)
      .toBeCloseTo(printed.thermalEnergyKcalPerMol.vibrational - printed.zeroPointVibrationalEnergyKcalPerMol, 2);
  });

  it('matches the printed heat capacity', () => {
    expect(result.totals.heatCapacityCalPerMolK)
      .toBeCloseTo(parsed.thermochemistry.heatCapacityCalPerMolK.total, 2);
  });
});

describe('sweeps away from the printed conditions', () => {
  const cold = thermoAt(parsed, { temperatureK: 298.15, pressureAtm: 1 });
  const hot = thermoAt(parsed, { temperatureK: 350, pressureAtm: 0.1 });

  it('raises entropy and makes the Gibbs correction more negative with temperature', () => {
    expect(hot.totals.entropyCalPerMolK).toBeGreaterThan(cold.totals.entropyCalPerMolK);
    expect(hot.totals.gibbsKcalPerMol).toBeLessThan(cold.totals.gibbsKcalPerMol);
    expect(hot.totals.enthalpyKcalPerMol).toBeGreaterThan(cold.totals.enthalpyKcalPerMol);
  });

  it('changes translational entropy by exactly R ln(p1/p2) with pressure', () => {
    const sameT = thermoAt(parsed, { temperatureK: 298.15, pressureAtm: 0.1 });
    const delta = sameT.components.translational.entropyCalPerMolK - cold.components.translational.entropyCalPerMolK;
    expect(delta).toBeCloseTo((8.314462618 * Math.log(10)) / 4.184, 6);
    expect(sameT.components.vibrational.entropyCalPerMolK).toBeCloseTo(cold.components.vibrational.entropyCalPerMolK, 9);
  });

  it('itemises terms that sum to the Gibbs correction', () => {
    const sum = hot.terms.reduce((total, term) => total + (term.enabled ? term.kcalPerMol : 0), 0);
    expect(sum).toBeCloseTo(hot.totals.gibbsKcalPerMol, 6);
  });

  it('drops the zero-point term when corrections are switched off', () => {
    const withoutZpe = thermoAt(parsed, { temperatureK: 298.15, pressureAtm: 1, includeZeroPoint: false });
    expect(withoutZpe.terms.find((term) => term.id === 'zero-point').kcalPerMol).toBe(0);
    expect(withoutZpe.totals.gibbsKcalPerMol)
      .toBeCloseTo(cold.totals.gibbsKcalPerMol - cold.zeroPointKcalPerMol, 4);
  });

  it('builds a T×p grid and CSV with one row per condition', () => {
    const rows = thermoGrid(parsed, { temperaturesK: [298.15, 350], pressuresAtm: [1, 0.1] });
    expect(rows).toHaveLength(4);
    const csv = thermoCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0].split(',')[0]).toBe('temperature_K');
    expect(lines[1].split(',')[0]).toBe('298.15');
    expect(lines[1].split(',')[1]).toBe('1');
    expect(lines[2].split(',')[1]).toBe('0.1');
    expect(lines[3].split(',')[0]).toBe('350');
  });
});

describe('honest gaps', () => {
  it('reports what is missing instead of reusing the printed table', () => {
    const result = thermoAt({ thermochemistry: { temperatureK: 298.15 }, frequencies: { values: [] } }, {});
    expect(result.available).toBe(false);
    expect(result.missing).toEqual(['molecular mass', 'rotational constants', 'vibrational frequencies']);
  });

  it('rejects a non-positive temperature or pressure', () => {
    expect(() => thermoAt(parsed, { temperatureK: 0 })).toThrow(/positive/);
    expect(() => thermoAt(parsed, { pressureAtm: -1 })).toThrow(/positive/);
  });
});
