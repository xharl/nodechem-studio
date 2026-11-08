import { describe, expect, it } from 'vitest';
import { evaluateGates, parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { buildGaussianInput } from '../src/shared/gaussianInput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';

const water = {
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.9572, y: 0, z: 0 },
    { element: 'H', x: -0.239, y: 0.927, z: 0 },
  ],
};

/**
 * These strings are Gaussian's documented stability verdicts. The repo corpus
 * has no `Stable` job yet, so this fixture is synthetic and deliberately
 * minimal: it tests the parser and the gate, not a real calculation.
 */
const syntheticLog = (verdict) => [
  ' Entering Gaussian System',
  ' Gaussian 16:  ES64L-G16RevC.01  3-Jun-2019',
  ' SCF Done:  E(RB3LYP) =  -76.4000000000     A.U. after    8 cycles',
  ' Stability analysis using the SCF density wavefunction:',
  verdict,
  ' Normal termination of Gaussian 16',
].join('\n');

describe('stability parser', () => {
  it('reads a stable verdict', () => {
    const parsed = parseGaussianOutput(syntheticLog(' The wavefunction is stable under the perturbations considered.'));
    expect(parsed.wavefunctionStability).toEqual({ stable: true, detail: 'stable under the perturbations considered' });
  });

  it('reads an internal instability', () => {
    const parsed = parseGaussianOutput(syntheticLog(' The wavefunction has an internal instability.'));
    expect(parsed.wavefunctionStability.stable).toBe(false);
  });

  it('is null when the job never asked for a stability analysis', () => {
    const parsed = parseGaussianOutput(syntheticLog(' SCF Done:  E(RB3LYP) =  -76.4'));
    expect(parsed.wavefunctionStability).toEqual({ stable: null, detail: null });
  });
});

describe('stability gate', () => {
  it('passes, fails and stays unknown as the verdict dictates', () => {
    const stable = evaluateGates(parseGaussianOutput(syntheticLog(' The wavefunction is stable under the perturbations considered.')), { requireStableWavefunction: true });
    expect(stable.gates.find((g) => g.name === 'Wavefunction stability').result).toBe('pass');

    const unstable = evaluateGates(parseGaussianOutput(syntheticLog(' The wavefunction has an internal instability.')), { requireStableWavefunction: true });
    const gate = unstable.gates.find((g) => g.name === 'Wavefunction stability');
    expect(gate.result).toBe('fail');
    expect(gate.detail).toMatch(/re-run with Stable=Opt/);

    const absent = evaluateGates(parseGaussianOutput(syntheticLog(' SCF Done:  E(RB3LYP) =  -76.4')), { requireStableWavefunction: true });
    const missing = absent.gates.find((g) => g.name === 'Wavefunction stability');
    expect(missing.result).toBe('unknown');
    expect(missing.detail).toMatch(/no stability analysis/);
  });

  it('is not added when Stable was not requested', () => {
    const gates = evaluateGates(parseGaussianOutput(syntheticLog(' SCF Done:  E(RB3LYP) =  -76.4')), {});
    expect(gates.gates.some((g) => g.name === 'Wavefunction stability')).toBe(false);
  });
});

describe('the route', () => {
  it('adds Stable=Opt only when the setting is on', () => {
    const settings = defaultSettings({ jobType: 'Opt' });
    const withoutRoute = buildGaussianInput({ title: 'x', settings, molecule: water, inputName: 'x.gjf' });
    expect(withoutRoute).not.toContain('Stable=Opt');
    const withRoute = buildGaussianInput({
      title: 'x',
      settings: { ...settings, stableOpt: true },
      molecule: water,
      inputName: 'x.gjf',
    });
    expect(withRoute).toContain('Stable=Opt');
  });
});
