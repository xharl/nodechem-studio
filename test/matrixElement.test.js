import { describe, expect, it } from 'vitest';
import { routeFor } from '../src/shared/gaussianInput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';

const base = {
  ...defaultSettings(),
  jobType: 'SP',
  method: 'B3LYP',
  basis: '6-31G(d)',
  dispersion: '',
  verbosity: '',
};

describe('Gaussian matrix element route (#247 Tier 1)', () => {
  it('requests the text and raw forms without changing the method route', () => {
    expect(routeFor({ ...base, matrixElement: 'MatrixElement' }))
      .toBe('#p B3LYP/6-31G(d) SP Output=MatrixElement');
    expect(routeFor({ ...base, matrixElement: 'RawMatrixElement' }))
      .toBe('#p B3LYP/6-31G(d) SP Output=RawMatrixElement');
  });

  it('refuses to combine it with Output verbosity', () => {
    expect(() => routeFor({ ...base, verbosity: 'Normal', matrixElement: 'MatrixElement' }))
      .toThrow(/share|Output keyword|choose one/i);
  });

  it('leaves an existing route byte-identical when the option is absent', () => {
    expect(routeFor(base)).toBe('#p B3LYP/6-31G(d) SP');
    expect('matrixElement' in defaultSettings()).toBe(false);
  });
});
