import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { ecdPolyline, ecdSpectrum, parseRotatoryStrengths } from '../src/shared/ecd.js';
import { templateProject } from '../src/shared/templates.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { tdKeywordFor } from '../src/shared/gaussianInput.js';

const real = readFileSync('test/fixtures/real/g16-dvb-td.out', 'utf8');

/**
 * The only public Gaussian ECD logs (cclib dvb_td.out, cclib-data 534.out) are
 * achiral test molecules: every rotatory strength printed is -0.0000. That
 * proves the layout but not the signs, so the sign tests below use a table
 * whose columns are copied verbatim from the real block with values that
 * differ in sign and magnitude.
 */
const SYNTHETIC = [
  ' Rotatory Strengths (R) in cgs (10**-40 erg-esu-cm/Gauss)',
  '       state          XX          YY          ZZ    R(velocity)    E-M Angle',
  '         1        12.3400      0.0000     -0.0000      12.3400       37.50',
  '         2        -8.2000      0.0000      0.0000      -8.2000       62.10',
  ' 1/2[<0|r|b>*<b|rxdel|0> + (<0|rxdel|b>*<b|r|0>)*]',
  ' Rotatory Strengths (R) in cgs (10**-40 erg-esu-cm/Gauss)',
  '       state          XX          YY          ZZ     R(length)',
  '         1        11.9800      0.0000     -0.0000      11.9800',
  '         2        -7.9100      0.0000      0.0000      -7.9100',
].join('\n');

describe('rotatory strengths — real Gaussian 16 block', () => {
  const parsed = parseRotatoryStrengths(real);

  it('reads both conventions without mixing them up', () => {
    expect(parsed.conventions.velocity).toHaveLength(5);
    expect(parsed.conventions.length).toHaveLength(5);
    expect(parsed.conventions.velocity[0]).toMatchObject({ state: 1, r: -0, emAngleDeg: 90 });
    expect(parsed.conventions.length[0]).toMatchObject({ state: 1, r: -0, emAngleDeg: null });
  });

  it('states the unit Gaussian printed', () => {
    expect(parsed.unit).toContain('10^-40');
    expect(parsed.scaleFactor).toContain('1e-40');
  });

  it('returns null when the block is absent', () => {
    expect(parseRotatoryStrengths(readFileSync('test/fixtures/real/g16-dvb-sp.out', 'utf8'))).toBeNull();
  });

  it('reaches the parsed record of a TD job and not of a single point', () => {
    expect(parseGaussianOutput(real).rotatoryStrengths.conventions.velocity).toHaveLength(5);
    expect(parseGaussianOutput(readFileSync('test/fixtures/real/g16-dvb-sp.out', 'utf8')).rotatoryStrengths).toBeNull();
  });
});

describe('rotatory strengths — signs', () => {
  const parsed = parseRotatoryStrengths(SYNTHETIC);

  it('keeps the sign of each band in both conventions', () => {
    expect(parsed.conventions.velocity.map((row) => row.r)).toEqual([12.34, -8.2]);
    expect(parsed.conventions.length.map((row) => row.r)).toEqual([11.98, -7.91]);
  });

  it('draws a signed curve: one positive band, one negative', () => {
    const states = [
      { index: 1, energyEv: 3.1, rotatoryStrength: 12.34 },
      { index: 2, energyEv: 4.4, rotatoryStrength: -8.2 },
    ];
    const spectrum = ecdSpectrum(states, { convention: 'velocity', fwhmEv: 0.1 });
    expect(spectrum.conventionLabel).toBe('R(velocity)');
    const intensities = spectrum.curve.map((point) => point.intensity);
    expect(Math.max(...intensities)).toBeCloseTo(1, 6);
    expect(Math.min(...intensities)).toBeLessThan(-0.1);
    expect(spectrum.peaks.map((peak) => peak.rotatoryStrength)).toEqual([12.34, -8.2]);
  });

  it('names the convention it plotted', () => {
    const states = [{ index: 1, energyEv: 3.1, rotatoryStrength: 11.98 }];
    expect(ecdSpectrum(states, { convention: 'length' }).conventionLabel).toBe('R(length)');
    expect(ecdSpectrum(states, { convention: 'length' }).units).toContain('10^-40');
  });

  it('centres the polyline on zero so the sign is visible', () => {
    const states = [
      { index: 1, energyEv: 3.1, rotatoryStrength: 5 },
      { index: 2, energyEv: 4.4, rotatoryStrength: -5 },
    ];
    const ys = ecdPolyline(ecdSpectrum(states, { fwhmEv: 0.05 }), { height: 100 })
      .split(' ')
      .map((point) => Number(point.split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(Math.max(...ys)).toBeGreaterThan(50);
    expect(Math.min(...ys)).toBeLessThan(50);
  });

  it('returns null when no state carries a rotatory strength', () => {
    expect(ecdSpectrum([{ index: 1, energyEv: 3.1 }])).toBeNull();
  });
});

describe('emission template and Root keyword', () => {
  it('emits Root only when it is set', () => {
    expect(tdKeywordFor({ tdStates: 5 })).toBe('TD=(NStates=5)');
    expect(tdKeywordFor({ tdStates: 1, tdRoot: 1 })).toBe('TD=(NStates=1,Root=1)');
  });

  it('ships an S1 optimisation followed by TD at that minimum', () => {
    const project = templateProject('emission');
    const plan = buildWorkflowPlan(project);
    // The plan carries the note block as a non-executable task.
    expect(plan.tasks.map((task) => task.nodeId)).toEqual(['em-s1-opt', 'em-td', 'em-note']);
    expect(plan.tasks.find((task) => task.nodeId === 'em-note').executable).toBe(false);
    const [opt, emission] = plan.tasks.filter((task) => task.type === 'calc');
    expect(opt.settings.jobType).toBe('Opt');
    expect(opt.settings.tdStates).toBe(1);
    expect(opt.settings.tdRoot).toBe(1);
    expect(opt.inputText).toContain('TD=(NStates=1,Root=1)');
    expect(emission.inputText).toContain('TD=(NStates=3)');
  });

  it('labels the downstream TD block as vertical emission from S1', () => {
    const plan = buildWorkflowPlan(templateProject('emission'));
    const emission = plan.tasks.find((task) => task.nodeId === 'em-td');
    expect(emission.emission).toMatchObject({
      sourceNodeId: 'em-s1-opt',
      root: 1,
      quantity: 'vertical emission from the excited-state minimum',
    });
    const opt = plan.tasks.find((task) => task.nodeId === 'em-s1-opt');
    expect(opt.emission).toBeNull();
  });

  it('does not label a ground-state TD job as emission', () => {
    const project = templateProject('opt-freq');
    const plan = buildWorkflowPlan(project);
    expect(plan.tasks.every((task) => task.emission === null)).toBe(true);
  });
});
