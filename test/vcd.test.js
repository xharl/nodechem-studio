import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import {
  attachVcd,
  parseVcdStrengths,
  vcdPolyline,
  vcdSpectrum,
  VCD_DIPOLE_UNITS,
  VCD_UNITS,
} from '../src/shared/vcd.js';
import { jobKeywordFor } from '../src/shared/tsForceConstants.js';
import { buildGaussianInput } from '../src/shared/gaussianInput.js';

const log = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');

/**
 * The fixture is a real Gaussian 16 Rev A.03 run: (S)-propylene oxide,
 * `#p B3LYP/6-31G(d) Opt Freq=(VCD) EmpiricalDispersion=GD3BJ`, 10 atoms,
 * normal termination. It is the first VCD log in the corpus; every number
 * below is read out of it, not invented (see the fixtures README).
 */
describe('VCD — real G16 Rev A.03 log, (S)-propylene oxide', () => {
  const table = parseVcdStrengths(log('g16-propyleneoxide-vcd.out'));

  it('reads one rotational strength, dipole strength and E–M angle per mode', () => {
    expect(table.rotationalStrengths).toHaveLength(24); // 3N − 6 for 10 atoms
    expect(table.dipoleStrengths).toHaveLength(24);
    expect(table.emAngles).toHaveLength(24);
    expect(table.rotationalStrengths.slice(0, 6)).toEqual([3.9145, -12.6414, -2.0675, 8.6029, 7.4089, 21.3851]);
    expect(table.dipoleStrengths[0]).toBe(9.8394);
    expect(table.emAngles[0]).toBe(70.6644);
  });

  it('keeps the sign: a rotational strength is not a magnitude', () => {
    const negative = table.rotationalStrengths.filter((value) => value < 0);
    expect(negative.length).toBeGreaterThan(0);
    expect(negative[0]).toBe(-12.6414);
  });

  it('records the printed unit and refuses to invent a representation', () => {
    expect(table.units).toBe(VCD_UNITS);
    expect(table.dipoleUnits).toBe(VCD_DIPOLE_UNITS);
    // Gaussian 16 A.03 prints the unit but no velocity/length label.
    expect(table.representation).toBeNull();
  });

  it('reads a representation only when the log actually states one', () => {
    const stated = parseVcdStrengths([
      ' Rotational strengths (10**-44 esu**2-cm**2), velocity representation',
      ' Rot. str.   --      1.5',
    ].join('\n'));
    expect(stated.representation).toBe('velocity');
  });

  it('returns null for a log with no VCD rows rather than a row of zeros', () => {
    expect(parseVcdStrengths(log('g16-dvb-ir.out'))).toBeNull();
    expect(parseVcdStrengths('')).toBeNull();
  });
});

describe('VCD — canonical result', () => {
  it('exposes signed modes plus the table metadata', () => {
    const parsed = parseGaussianOutput(log('g16-propyleneoxide-vcd.out'));
    expect(parsed.vcd).toHaveLength(24);
    expect(parsed.vcd[0]).toEqual({
      wavenumber: 212.7138,
      rotationalStrength: 3.9145,
      dipoleStrength: 9.8394,
      emAngle: 70.6644,
    });
    expect(parsed.vcdTable.units).toBe(VCD_UNITS);
    expect(parsed.vcdTable.representation).toBeNull();
  });

  it('leaves vcd null for a plain frequency job', () => {
    const parsed = parseGaussianOutput(log('g16-dvb-ir.out'));
    expect(parsed.vcd).toBeNull();
    expect(parsed.vcdTable).toBeNull();
  });

  it('attaches null, never 0, to a mode with no printed row', () => {
    const modes = attachVcd([{ wavenumber: 1 }, { wavenumber: 2 }], { rotationalStrengths: [2.5], dipoleStrengths: [], emAngles: [] });
    expect(modes[0].rotationalStrength).toBe(2.5);
    expect(modes[1].rotationalStrength).toBeNull();
    expect(modes[1].dipoleStrength).toBeNull();
  });
});

describe('VCD — spectrum', () => {
  const parsed = parseGaussianOutput(log('g16-propyleneoxide-vcd.out'));
  const spectrum = vcdSpectrum(parsed.vcd, { fwhmCm: 12 });

  it('is signed and says so', () => {
    expect(spectrum.signed).toBe(true);
    expect(spectrum.counts.total).toBe(24);
    expect(spectrum.counts.positive + spectrum.counts.negative).toBe(24);
    expect(spectrum.counts.negative).toBeGreaterThan(0);
    expect(spectrum.curve.some((point) => point.intensity < 0)).toBe(true);
    expect(spectrum.curve.some((point) => point.intensity > 0)).toBe(true);
  });

  it('normalises to the strongest |R|, not the strongest positive band', () => {
    const strongest = Math.max(...parsed.vcd.map((mode) => Math.abs(mode.rotationalStrength)));
    expect(spectrum.normalisation).toBe(`strongest |R| = 1.00 (${strongest.toFixed(4)} ${VCD_UNITS})`);
    expect(Math.max(...spectrum.curve.map((point) => point.intensity))).toBeLessThanOrEqual(1.0000001);
  });

  it('states its FWHM and the quantity it plots', () => {
    expect(spectrum.fwhmCm).toBe(12);
    expect(spectrum.quantity).toBe('VCD rotational strength');
    expect(spectrum.units).toBe(VCD_UNITS);
  });

  it('draws around a midline so the sign is visible without a legend', () => {
    const points = vcdPolyline(spectrum).split(' ');
    const ys = points.map((point) => Number(point.split(',')[1]));
    expect(ys.some((y) => y < 50)).toBe(true);
    expect(ys.some((y) => y > 50)).toBe(true);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
  });

  it('returns null when no mode carries a strength', () => {
    expect(vcdSpectrum([{ wavenumber: 1000, rotationalStrength: null }])).toBeNull();
  });
});

describe('VCD — route keyword', () => {
  it('rides the frequency keyword', () => {
    expect(jobKeywordFor({ jobType: 'Freq', vcd: true })).toBe('Freq=VCD');
    expect(jobKeywordFor({ jobType: 'Opt Freq', vcd: true })).toBe('Opt Freq=VCD');
    expect(jobKeywordFor({ jobType: 'Opt', vcd: true })).toBe('Opt');
    expect(jobKeywordFor({ jobType: 'Freq' })).toBe('Freq');
  });

  it('combines with Raman in one parenthesised list', () => {
    expect(jobKeywordFor({ jobType: 'Freq', raman: true, vcd: true })).toBe('Freq=(Raman,VCD)');
    expect(jobKeywordFor({ jobType: 'Freq', raman: true })).toBe('Freq=Raman');
  });

  it('is refused on a job with no frequency to attach to', () => {
    const molecule = {
      charge: 0,
      multiplicity: 1,
      coords: [
        { element: 'O', x: 0, y: 0, z: 0.1173 },
        { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
        { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
      ],
    };
    expect(() => buildGaussianInput({ settings: { jobType: 'SP', vcd: true }, molecule, inputName: 'vcd.gjf' }))
      .toThrow(/VCD rotational strengths need a frequency job/);
    const written = buildGaussianInput({ settings: { jobType: 'Freq', vcd: true }, molecule, inputName: 'vcd.gjf' });
    expect(written).toMatch(/^#p .*Freq=VCD/m);
  });
});
