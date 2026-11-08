import { describe, expect, it } from 'vitest';
import { buildGaussianInput, gaussianMethodKeyword } from '../src/shared/gaussianInput.js';

/**
 * Gaussian has no Greek omega and spells several functionals without the hyphen
 * chemists write. Before this mapping the app wrote `#p ωB97X-D/def2TZVP` — a
 * QPErr syntax error at Link 1 on Gaussian 16 A.03, verified on a real job.
 */
const molecule = {
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
    { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
  ],
};

const routeOf = (settings) => buildGaussianInput({ settings, molecule, inputName: 'probe.gjf' })
  .split('\n').find((line) => line.startsWith('#p'));

describe('Gaussian method keywords', () => {
  it('writes ωB97X-D as the ASCII wB97XD', () => {
    expect(gaussianMethodKeyword('ωB97X-D')).toBe('wB97XD');
    expect(gaussianMethodKeyword('wB97X-D')).toBe('wB97XD');
    expect(routeOf({ jobType: 'Opt Freq', method: 'ωB97X-D', basis: 'def2-TZVP' }))
      .toBe('#p wB97XD/def2TZVP Opt Freq');
  });

  it('drops the hyphen only where Gaussian does', () => {
    expect(gaussianMethodKeyword('B97-D')).toBe('B97D');
    expect(gaussianMethodKeyword('B97-D3')).toBe('B97D3');
    // These keep their hyphen: M06-2X is not M062X in a Gaussian route.
    expect(gaussianMethodKeyword('M06-2X')).toBe('M06-2X');
    expect(gaussianMethodKeyword('B3LYP')).toBe('B3LYP');
    expect(gaussianMethodKeyword('TPSSTPSS')).toBe('TPSSTPSS');
  });

  it('never leaves a non-ASCII character in the route', () => {
    for (const method of ['ωB97X-D', 'ωB97X-D3', 'ωB97X-V', 'ωB97M-V', 'B3LYP', 'M06-2X']) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]*$/.test(gaussianMethodKeyword(method))).toBe(true);
    }
  });
});
