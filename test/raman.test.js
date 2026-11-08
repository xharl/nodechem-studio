import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { attachRaman, parseRamanActivities, ramanPolyline, ramanSpectrum } from '../src/shared/raman.js';
import { jobKeywordFor } from '../src/shared/tsForceConstants.js';
import { CHECK_STATUS, runValidityChecks } from '../src/shared/validityChecks.js';

const log = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');

describe('Raman activities — real G16 water log (exa-analytics/exatomic)', () => {
  const raman = parseRamanActivities(log('g16-h2o-raman.out'));

  it('reads one activity and both depolarisation ratios per mode', () => {
    expect(raman.activities).toEqual([11.4937, 95.663, 44.0813]);
    expect(raman.depolarizationPlane).toEqual([0.4298, 0.218, 0.75]);
    expect(raman.depolarizationUnpolarized).toEqual([0.6012, 0.358, 0.8571]);
  });

  it('reads the long layout as well as the short one', () => {
    const longLayout = [
      ' Raman Activ --     11.4937                95.6630                44.0813',
      ' Depolar (P) --      0.4298                 0.2180                 0.7500',
      ' Depolar (U) --      0.6012                 0.3580                 0.8571',
    ].join('\n');
    const parsed = parseRamanActivities(longLayout);
    expect(parsed.activities).toEqual([11.4937, 95.663, 44.0813]);
    expect(parsed.depolarizationPlane).toEqual([0.4298, 0.218, 0.75]);
    expect(parsed.depolarizationUnpolarized).toEqual([0.6012, 0.358, 0.8571]);
  });

  it('returns null for a log without Raman data, rather than a zero row', () => {
    expect(parseRamanActivities(log('g16-dvb-sp.out'))).toBeNull();
    expect(parseRamanActivities('')).toBeNull();
  });

  it('attaches to modes and keeps an unreported mode null', () => {
    const modes = attachRaman([{ wavenumber: 1799.2881 }, { wavenumber: 3812.3772 }], raman);
    expect(modes[0].ramanActivity).toBe(11.4937);
    expect(modes[1].depolarizationPlane).toBe(0.218);
    const truncated = attachRaman([{ wavenumber: 1 }, { wavenumber: 2 }], {
      activities: [5], depolarizationPlane: [], depolarizationUnpolarized: [],
    });
    expect(truncated[0].ramanActivity).toBe(5);
    expect(truncated[1].ramanActivity).toBeNull();
    expect(truncated.every((mode) => mode.depolarizationPlane !== 0)).toBe(true);
  });
});

describe('Raman spectrum', () => {
  const parsed = parseGaussianOutput(log('g16-h2o-raman.out'));

  it('exposes the per-mode table on the parsed record', () => {
    expect(parsed.raman).toHaveLength(3);
    expect(parsed.raman[1]).toMatchObject({
      wavenumber: 3812.3772,
      ramanActivity: 95.663,
      depolarizationPlane: 0.218,
      depolarizationUnpolarized: 0.358,
    });
  });

  it('is absent for a single-point log', () => {
    expect(parseGaussianOutput(log('g16-dvb-sp.out')).raman).toBeNull();
  });

  it('states the quantity, its units, its broadening and its normalisation', () => {
    const spectrum = ramanSpectrum(parsed.raman, { fwhmCm: 12 });
    expect(spectrum.quantity).toBe('Raman activity');
    expect(spectrum.units).toBe('Å⁴/amu');
    expect(spectrum.fwhmCm).toBe(12);
    expect(spectrum.shape).toBe('lorentzian');
    expect(spectrum.normalisation).toContain('95.6630');
    expect(Math.max(...spectrum.curve.map((point) => point.intensity))).toBeCloseTo(1, 6);
  });

  it('widens with the stated FWHM instead of silently reshaping', () => {
    const narrow = ramanSpectrum(parsed.raman, { fwhmCm: 4 });
    const wide = ramanSpectrum(parsed.raman, { fwhmCm: 40 });
    expect(wide.maxCm - wide.minCm).toBeGreaterThan(narrow.maxCm - narrow.minCm);
    expect(wide.fwhmCm).toBe(40);
  });

  it('returns null when no mode carries an activity', () => {
    expect(ramanSpectrum([{ wavenumber: 100, ramanActivity: null }])).toBeNull();
    expect(ramanSpectrum([])).toBeNull();
  });

  it('draws inside the 0–100 box', () => {
    const points = ramanPolyline(ramanSpectrum(parsed.raman)).split(' ');
    expect(points.length).toBeGreaterThan(10);
    for (const point of points) {
      const [x, y] = point.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });
});

describe('the Raman keyword', () => {
  it('is a flag on the frequency keyword, never a job of its own', () => {
    expect(jobKeywordFor({ jobType: 'Freq', raman: true })).toBe('Freq=Raman');
    expect(jobKeywordFor({ jobType: 'Opt Freq', raman: true })).toBe('Opt Freq=Raman');
    expect(jobKeywordFor({ jobType: 'Opt Freq', raman: true, optConvergence: 'Tight' })).toBe('Opt=Tight Freq=Raman');
  });

  it('changes nothing when the flag is off', () => {
    expect(jobKeywordFor({ jobType: 'Freq' })).toBe('Freq');
    expect(jobKeywordFor({ jobType: 'Opt Freq' })).toBe('Opt Freq');
  });

  it('is refused on an xTB block', () => {
    const finding = runValidityChecks(
      { settings: { jobType: 'Freq', raman: true } },
      { phase: 'pre', engine: 'xtb' },
    ).findings.find((check) => check.id === 'engine-settings');
    expect(finding.status).toBe(CHECK_STATUS.FAIL);
    expect(finding.detail).toContain('Raman activities');
  });
});
