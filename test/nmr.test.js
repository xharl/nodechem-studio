import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  elementForNucleus,
  nmrPolyline,
  nmrShifts,
  nmrSpectrum,
  parseShieldings,
} from '../src/shared/nmr.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { buildGaussianInput } from '../src/shared/gaussianInput.js';
import { jobKeywordFor } from '../src/shared/tsForceConstants.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const nmrText = readFileSync(
  fileURLToPath(new URL('./fixtures/real/g09-dvb-nmr.log', import.meta.url)),
  'utf8',
);

describe('NMR shielding parser (real Gaussian 09 log)', () => {
  const parsed = parseShieldings(nmrText);

  it('reads the gauge, the method and every atom', () => {
    expect(parsed).not.toBeNull();
    expect(parsed.gauge).toBe('GIAO');
    expect(parsed.method).toBe('SCF');
    expect(parsed.count).toBe(20);
    expect(parsed.atoms).toHaveLength(20);
  });

  it('keeps isotropic, anisotropy and the tensor eigenvalues', () => {
    const first = parsed.atoms[0];
    expect(first).toMatchObject({ index: 1, element: 'C' });
    expect(first.isotropic).toBeCloseTo(114.088, 3);
    expect(first.anisotropy).toBeCloseTo(147.6438, 4);
    expect(first.eigenvalues).toEqual([48.6622, 81.0847, 212.5172]);
    expect(parsed.atoms.at(-1)).toMatchObject({ index: 20, element: 'H' });
    expect(parsed.atoms.at(-1).isotropic).toBeCloseTo(27.098, 3);
  });

  it('returns null when the job printed no shielding block', () => {
    expect(parseShieldings('')).toBeNull();
    expect(parseShieldings(' Normal termination of Gaussian 16')).toBeNull();
  });
});

describe('shifts and referencing', () => {
  const atoms = [
    { index: 1, element: 'C', isotropic: 114.088, anisotropy: 147.6 },
    { index: 2, element: 'C', isotropic: 128.4236, anisotropy: 100 },
    { index: 3, element: 'H', isotropic: 25.5, anisotropy: 5 },
  ];

  it('produces no shift without a reference', () => {
    const shifted = nmrShifts(atoms);
    expect(shifted.map((atom) => atom.shiftPpm)).toEqual([null, null, null]);
  });

  it('uses the IUPAC convention σ_ref − σ_iso', () => {
    const shifted = nmrShifts(atoms, { referencePpm: 190 });
    expect(shifted[0].shiftPpm).toBeCloseTo(75.912, 6);
    expect(shifted[1].shiftPpm).toBeCloseTo(61.5764, 4);
  });

  it('maps a nucleus label to its element', () => {
    expect(elementForNucleus('13C')).toBe('C');
    expect(elementForNucleus('1H')).toBe('H');
    expect(elementForNucleus('7Li')).toBeNull();
  });
});

describe('simulated spectrum', () => {
  const parsed = parseShieldings(nmrText);

  it('selects the requested nucleus and keeps one peak per atom', () => {
    const carbon = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C', referencePpm: 190, fwhmPpm: 2 });
    expect(carbon.peaks).toHaveLength(10);
    expect(carbon.units).toBe('ppm shift');
    expect(carbon.peaks[0].value).toBeLessThan(carbon.peaks.at(-1).value);
    const proton = nmrSpectrum({ atoms: parsed.atoms, nucleus: '1H' });
    expect(proton.peaks).toHaveLength(10);
  });

  it('states absolute shielding when no reference is set', () => {
    const spectrum = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C' });
    expect(spectrum.referencePpm).toBeNull();
    expect(spectrum.units).toBe('ppm shielding (absolute)');
    expect(spectrum.peaks.every((peak) => peak.shiftPpm === null)).toBe(true);
  });

  it('broadens with the stated FWHM and normalises the curve', () => {
    const narrow = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C', referencePpm: 190, fwhmPpm: 0.2 });
    const wide = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C', referencePpm: 190, fwhmPpm: 4 });
    expect(narrow.fwhmPpm).toBeCloseTo(0.2, 6);
    expect(wide.maxPpm - wide.minPpm).toBeGreaterThan(narrow.maxPpm - narrow.minPpm);
    expect(Math.max(...wide.curve.map((point) => point.intensity))).toBeCloseTo(1, 6);
    expect(nmrPolyline(wide).split(' ')).toHaveLength(wide.curve.length);
  });

  it('returns null when the nucleus is absent', () => {
    expect(nmrSpectrum({ atoms: parsed.atoms, nucleus: '31P' })).toBeNull();
  });
});

describe('NMR job type and route', () => {
  it('emits the NMR keyword', () => {
    expect(jobKeywordFor({ jobType: 'NMR' })).toBe('NMR');
    const text = buildGaussianInput({
      settings: { functional: 'B3LYP', basis: 'def2-SVP', jobType: 'NMR' },
      molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'C', x: 0, y: 0, z: 0 }] },
      inputName: 'nmr.gjf',
    });
    expect(text).toMatch(/^#p B3LYP\/def2SVP NMR$/m);
  });

  it('parses the NMR block into the run summary', () => {
    const parsed = parseGaussianOutput(nmrText);
    expect(parsed.nmr).not.toBeNull();
    expect(parsed.nmr.count).toBe(20);
    expect(parsed.reactionPath).toBeNull();
    expect(parsed.scan).toBeNull();
  });
});

describe('results panel', () => {
  const record = (parsed) => ({
    id: '20261108-010000-nmr001',
    status: 'completed',
    engine: 'gaussian',
    title: 'NMR',
    dryRun: false,
    truncated: false,
    parsed,
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: 'STO-3G' } },
  });

  it('renders the shielding table, the controls and the convention', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(nmrText)));
    expect(html).toContain('data-field="nmr-shieldings"');
    expect(html).toContain('data-field="nmr-spectrum"');
    expect(html).toContain('data-nmr-reference');
    expect(html).toContain('data-nmr-fwhm');
    expect(html).toContain('GIAO');
    expect(html).toContain('no reference set (absolute shielding)');
    expect(html).toContain('not reported');
  });

  it('renders nothing when the job has no shielding block', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(' Normal termination of Gaussian 16')));
    expect(html).not.toContain('data-field="nmr-shieldings"');
  });
});
