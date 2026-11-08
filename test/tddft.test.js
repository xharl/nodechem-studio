/**
 * TD-DFT (issue #60): route composition, output parsing and the results card.
 *
 * The output below reproduces only the record shapes the parser reads. It is
 * synthetic and labelled; no Gaussian executable ran.
 */
import { describe, expect, it } from 'vitest';
import { buildGaussianInput, tdKeywordFor, DEMO_WATER } from '../src/shared/gaussianInput.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const TD_OUT = [
  ' FIXTURE OUTPUT — synthetic, not a real calculation',
  ' Excitation energies and oscillator strengths:',
  '',
  ' Excited State   1:      Singlet-A      4.0115 eV  309.03 nm  f=0.1234  <S**2>=0.000',
  '     12 -> 15         0.70123',
  '     11 -> 16        -0.12345',
  '',
  ' Excited State   2:      Singlet-A      6.2000 eV  199.99 nm  f=0.0456  <S**2>=0.000',
  '     12 -> 16         0.61200',
  '',
  ' Excited State   3:      Triplet-A      3.1000 eV  399.95 nm  f=0.0000  <S**2>=2.000',
  '     12 -> 15         0.50000',
  '',
  ' Normal termination of Gaussian 16',
].join('\n');

function inputFor(settings) {
  return buildGaussianInput({
    title: 'TD test',
    settings: { ...defaultSettings(), jobType: 'SP', ...settings },
    molecule: { coords: DEMO_WATER, charge: 0, multiplicity: 1 },
    inputName: 'td.gjf',
  });
}

describe('TD route keyword', () => {
  it('is absent when no states were requested', () => {
    expect(tdKeywordFor({})).toBeNull();
    expect(inputFor({ tdStates: 0 })).not.toContain('TD=(');
  });

  it('emits NStates on the route', () => {
    expect(tdKeywordFor({ tdStates: 10 })).toBe('TD=(NStates=10)');
    expect(inputFor({ tdStates: 10 })).toContain('TD=(NStates=10)');
  });

  it('maps the spin-state choice to Gaussian vocabulary', () => {
    expect(tdKeywordFor({ tdStates: 5, tdTriplets: 'triplets' })).toBe('TD=(NStates=5,Triplets)');
    expect(tdKeywordFor({ tdStates: 5, tdTriplets: 'both' })).toBe('TD=(NStates=5,50-50)');
  });

  it('clamps and floors the state count', () => {
    expect(tdKeywordFor({ tdStates: 2.7 })).toBe('TD=(NStates=2)');
    expect(tdKeywordFor({ tdStates: 5000 })).toBe('TD=(NStates=200)');
    expect(tdKeywordFor({ tdStates: -4 })).toBeNull();
  });

  it('refuses job types Gaussian cannot combine with TD', () => {
    expect(() => inputFor({ tdStates: 5, jobType: 'Freq' })).toThrow(/SP and Opt/);
    expect(() => inputFor({ tdStates: 5, jobType: 'Opt=TS' })).toThrow(/SP and Opt/);
    expect(() => inputFor({ tdStates: 5, jobType: 'Opt' })).not.toThrow();
  });
});

describe('TD output parsing', () => {
  const parsed = parseGaussianOutput(TD_OUT);

  it('reads every excited state with its energy, wavelength and f', () => {
    expect(parsed.excitedStates.count).toBe(3);
    const first = parsed.excitedStates.states[0];
    expect(first.index).toBe(1);
    expect(first.spin).toBe('Singlet');
    expect(first.symmetry).toBe('A');
    expect(first.energyEv).toBeCloseTo(4.0115, 4);
    expect(first.wavelengthNm).toBeCloseTo(309.03, 2);
    expect(first.oscillatorStrength).toBeCloseTo(0.1234, 4);
    expect(first.transitions).toHaveLength(2);
    expect(first.transitions[0]).toEqual({ from: 12, to: 15, coefficient: 0.70123 });
  });

  it('keeps triplets distinct from singlets', () => {
    const triplet = parsed.excitedStates.states[2];
    expect(triplet.spin).toBe('Triplet');
    expect(triplet.s2).toBeCloseTo(2, 3);
  });

  it('returns an empty block when the output has no TD table', () => {
    const plain = parseGaussianOutput(' Normal termination of Gaussian 16');
    expect(plain.excitedStates).toEqual({ count: 0, states: [] });
  });
});

describe('TD results card', () => {
  it('renders the parsed states and their dominant transitions', () => {
    const html = resultsPanelHtml({
      status: 'completed',
      engine: 'gaussian',
      parsed: parseGaussianOutput(TD_OUT),
      gates: { overall: 'pass', gates: [] },
    });
    expect(html).toContain('data-field="excited-states"');
    expect(html).toContain('data-excited-state="1"');
    expect(html).toContain('Singlet-A');
    expect(html).toContain('4.0115');
    expect(html).toContain('12→15');
    expect(html).toContain('Triplet-A');
  });

  it('omits the card when no excited states were parsed', () => {
    const html = resultsPanelHtml({
      status: 'completed',
      engine: 'gaussian',
      parsed: parseGaussianOutput(' Normal termination of Gaussian 16'),
      gates: { overall: 'pass', gates: [] },
    });
    expect(html).not.toContain('data-field="excited-states"');
    expect(html).not.toContain('Excited states');
  });
});
