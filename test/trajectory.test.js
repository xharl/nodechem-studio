import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTrajectory, trajectoryEnergies, trajectorySvg } from '../src/shared/trajectory.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8');

describe('optimisation trajectory on a real log', () => {
  const trajectory = parseTrajectory(fixture('g09-dvb-gopt-unconverged.log'));

  it('reads every printed geometry with its atoms', () => {
    expect(trajectory).not.toBeNull();
    expect(trajectory.steps).toHaveLength(6);
    expect(trajectory.steps[0].atoms).toHaveLength(20);
    expect(trajectory.steps[0].atoms[0].element).toBe('C');
  });

  it('pairs each geometry with the SCF energy that preceded it', () => {
    const series = trajectoryEnergies(trajectory);
    expect(series[1].energyHartree).toBeCloseTo(-382.294280335, 9);
    expect(series[5].energyHartree).toBeCloseTo(-382.308176867, 9);
  });

  it('leaves the first geometry without an energy rather than borrowing one', () => {
    const series = trajectoryEnergies(trajectory);
    expect(series[0].energyHartree).toBeNull();
    expect(series[0].relativeKcal).toBeNull();
  });

  it('measures energies against the lowest step, which is the reference', () => {
    const series = trajectoryEnergies(trajectory);
    const reference = series.find((point) => point.reference);
    expect(reference.step).toBe(6);
    expect(reference.relativeKcal).toBeCloseTo(0, 9);
    expect(series[1].relativeKcal).toBeCloseTo(8.72, 1);
  });

  it('draws the curve with one marker per computed energy and a gap for the rest', () => {
    const svg = trajectorySvg(trajectory);
    expect(svg).toContain('data-field="trajectory"');
    expect((svg.match(/<circle/g) || []).length).toBe(5);
    expect(svg).toContain('reference is step 6');
  });

  it('returns the single printed geometry for a job that never optimised', () => {
    const single = parseTrajectory(fixture('g16-dvb-sp.out'));
    expect(single.steps).toHaveLength(1);
    const html = resultsPanelHtml({ id: 'r-sp', title: 'SP', status: 'completed', parsed: parseGaussianOutput(fixture('g16-dvb-sp.out')) });
    expect(html).not.toContain('data-field="optimisation-replay"');
  });
});

describe('the replay card', () => {
  const parsed = parseGaussianOutput(fixture('g09-dvb-gopt-unconverged.log'));

  it('renders one row per step with its energy and its geometry', () => {
    const html = resultsPanelHtml({ id: 'r-opt', title: 'Opt', status: 'completed', parsed });
    expect(html).toContain('data-field="optimisation-replay"');
    expect((html.match(/<summary>geometry<\/summary>/g) || []).length).toBe(6);
    expect(html).toContain('not reported');
    expect(html).toContain('is-reference');
  });
});
