import { describe, expect, it } from 'vitest';
import { compareRuns, comparisonHtml } from '../src/shared/runCompare.js';

function run(overrides = {}) {
  return {
    id: 'run-a',
    title: 'Water SP',
    status: 'completed',
    engine: 'gaussian',
    elapsedSeconds: 12.5,
    provenance: {
      jobType: 'SP',
      method: { functional: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ', solvation: null },
    },
    parsed: {
      engine: 'gaussian',
      finalEnergy: { hartree: -76.4, source: 'scf' },
      scf: { cycles: 8, energyHartree: -76.4 },
      frequencies: { imaginaryCount: 0 },
      thermochemistry: { freeEnergyHartree: -76.3 },
    },
    gates: { overall: 'pass' },
    outputSha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('run comparison', () => {
  it('reports a same-method re-run delta in kcal/mol with the right sign', () => {
    const baseline = run();
    const comparison = run({
      id: 'run-b',
      parsed: {
        ...run().parsed,
        finalEnergy: { hartree: -76.401, source: 'scf' },
        scf: { cycles: 6, energyHartree: -76.401 },
      },
      elapsedSeconds: 10,
    });
    const model = compareRuns(baseline, comparison);
    expect(model.sameLevelOfTheory).toBe(true);
    const energyDelta = model.rows.find((row) => row.id === 'energy-delta');
    expect(energyDelta.delta).toBeCloseTo(-0.001 * 627.5094740631, 3);
    expect(model.rows.find((row) => row.id === 'scf-cycles').delta).toBe(-2);
    expect(model.rows.find((row) => row.id === 'elapsed').delta).toBe(-2.5);
    expect(model.summary).toMatch(/Energy difference/);
  });

  it('marks a cross-method comparison instead of calling it a re-run', () => {
    const model = compareRuns(run(), run({
      id: 'run-c',
      provenance: { jobType: 'SP', method: { functional: 'M06-2X', basis: 'def2-SVP', dispersion: '' } },
    }));
    expect(model.sameLevelOfTheory).toBe(false);
    expect(model.changedLevelKeys).toContain('functional');
    const delta = model.rows.find((row) => row.id === 'energy-delta');
    expect(delta.comparable).toBe(false);
    expect(delta.note).toMatch(/cross-method/);
    const html = comparisonHtml(model);
    expect(html).toContain('data-role="cross-method"');
  });

  it('never invents a value one run does not carry', () => {
    const model = compareRuns(run(), run({
      id: 'run-d',
      parsed: { engine: 'gaussian', finalEnergy: { hartree: -76.4, source: 'scf' } },
    }));
    const gibbs = model.rows.find((row) => row.id === 'gibbs');
    expect(gibbs.right).toBeNull();
    expect(gibbs.delta).toBeNull();
    const html = comparisonHtml(model);
    expect(html).toContain('not reported');
    expect(html).toContain('data-delta="none"');
  });

  it('tolerates malformed records without throwing', () => {
    expect(() => compareRuns(null, undefined)).not.toThrow();
    const model = compareRuns({}, {});
    expect(model.rows).toHaveLength(7);
    expect(comparisonHtml(model)).toContain('results-compare');
  });

  it('flags changed gate verdicts and output hashes', () => {
    const model = compareRuns(run(), run({
      id: 'run-e',
      gates: { overall: 'fail' },
      outputSha256: 'b'.repeat(64),
    }));
    const gates = model.statusChanges.find((entry) => entry.id === 'gates');
    expect(gates.changed).toBe(true);
    const html = comparisonHtml(model);
    expect(html).toContain('data-compare-status="gates" class="is-changed"');
  });

  it('escapes record text in the rendered table', () => {
    const model = compareRuns(run({ title: '<img onerror=x>' }), run({ id: 'r2', title: '<b>' }));
    const html = comparisonHtml(model);
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });
});
