import { describe, expect, it } from 'vitest';
import {
  boltzmannWeights,
  boltzmannWeightedObservables,
  rankEnsemble,
} from '../src/shared/conformers.js';

const twoMember = (temperature = 298.15) => {
  const weights = boltzmannWeights([0, 1], temperature);
  return [
    { id: 'c1', population: weights[0], values: { energyHartree: -76.4, gapEv: 5.0 } },
    { id: 'c2', population: weights[1], values: { energyHartree: -76.39, gapEv: 4.0 } },
  ];
};

describe('Boltzmann weights', () => {
  it('splits a two-member ensemble by exp(-ΔE/RT)', () => {
    const weights = boltzmannWeights([0, 1], 298.15);
    expect(weights[0] + weights[1]).toBeCloseTo(1, 12);
    expect(weights[0]).toBeCloseTo(0.8439, 4);
    expect(weights[1]).toBeCloseTo(0.1561, 4);
  });

  it('moves population toward the higher member as the temperature rises', () => {
    const cold = boltzmannWeights([0, 1], 298.15);
    const hot = boltzmannWeights([0, 1], 1000);
    expect(hot[1]).toBeGreaterThan(cold[1]);
    expect(hot[0]).toBeLessThan(cold[0]);
    expect(hot[0] + hot[1]).toBeCloseTo(1, 12);
  });

  it('refuses a temperature of zero and an empty ensemble', () => {
    expect(boltzmannWeights([0, 1], 0)).toEqual([]);
    expect(boltzmannWeights([], 298.15)).toEqual([]);
    expect(boltzmannWeights([0, Number.NaN], 298.15)).toEqual([]);
  });
});

describe('Boltzmann-weighted observables', () => {
  it('averages the named observables with the retained populations and labels the result', () => {
    const result = boltzmannWeightedObservables(twoMember(), {
      temperature: 298.15,
      observables: ['energyHartree', 'gapEv'],
    });
    expect(result.available).toBe(true);
    expect(result.label).toBe('ensemble-averaged');
    expect(result.temperatureK).toBe(298.15);
    expect(result.memberCount).toBe(2);
    expect(result.populations).toHaveLength(2);
    expect(result.populations[0].id).toBe('c1');
    expect(result.populations[0].population).toBeCloseTo(0.8439, 4);
    expect(result.populations[1].id).toBe('c2');
    expect(result.populations[1].population).toBeCloseTo(0.1561, 4);

    const energy = result.observables.find((entry) => entry.key === 'energyHartree');
    expect(energy.label).toMatch(/energy/i);
    expect(energy.unit).toBe('Eh');
    expect(energy.weightedMean).toBeCloseTo(0.8439 * -76.4 + 0.1561 * -76.39, 4);
    expect(energy.unweightedMean).toBeCloseTo(-76.395, 9);
    expect(energy.spread).toBeCloseTo(0.01, 9);
    expect(energy.weightedStdDev).toBeGreaterThan(0);
    expect(energy.count).toBe(2);

    const gap = result.observables.find((entry) => entry.key === 'gapEv');
    expect(gap.weightedMean).toBeCloseTo(0.8439 * 5 + 0.1561 * 4, 4);
    expect(gap.unweightedMean).toBeCloseTo(4.5, 9);
  });

  it('carries the unweighted value beside the weighted one when the ensemble is not converged', () => {
    const result = boltzmannWeightedObservables(twoMember(), {
      temperature: 298.15,
      observables: ['energyHartree'],
    });
    expect(result.converged).toBe(false);
    expect(result.convergence).toMatch(/retained/i);
    expect(result.observables[0].unweightedMean).not.toBeCloseTo(result.observables[0].weightedMean, 6);
  });

  it('marks a one-member ensemble as converged', () => {
    const result = boltzmannWeightedObservables([
      { id: 'c1', population: 1, values: { energyHartree: -76.4 } },
    ], { observables: ['energyHartree'] });
    expect(result.available).toBe(true);
    expect(result.converged).toBe(true);
    expect(result.observables[0].weightedMean).toBeCloseTo(-76.4, 9);
    expect(result.observables[0].spread).toBe(0);
  });

  it('refuses populations that do not sum to one', () => {
    const result = boltzmannWeightedObservables([
      { id: 'c1', population: 0.6, values: { energyHartree: -76.4 } },
      { id: 'c2', population: 0.3, values: { energyHartree: -76.39 } },
    ], { observables: ['energyHartree'] });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/sum to 1/);
    expect(result.reason).toMatch(/0.9/);
  });

  it('refuses a member with no population instead of inventing one', () => {
    const result = boltzmannWeightedObservables([
      { id: 'c1', population: 1, values: { energyHartree: -76.4 } },
      { id: 'c2', values: { energyHartree: -76.39 } },
    ], { observables: ['energyHartree'] });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/c2/);
    expect(result.reason).toMatch(/population/);
  });

  it('omits an observable a member did not report rather than averaging a subset', () => {
    const result = boltzmannWeightedObservables([
      { id: 'c1', population: 0.8, values: { energyHartree: -76.4, gapEv: 5.0 } },
      { id: 'c2', population: 0.2, values: { energyHartree: -76.39 } },
    ], { observables: ['energyHartree', 'gapEv'] });
    expect(result.available).toBe(true);
    expect(result.observables.map((entry) => entry.key)).toEqual(['energyHartree']);
    expect(result.omitted).toEqual([
      { key: 'gapEv', reason: expect.stringMatching(/c2/) },
    ]);
  });

  it('uses the populations rankEnsemble assigned to the retained set', () => {
    const frame = (energyEh, angle) => ({
      index: 1,
      comment: '',
      energyEh,
      atoms: [
        { element: 'O', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0.96, y: 0, z: 0 },
        { element: 'H', x: 0.96 * Math.cos((angle * Math.PI) / 180), y: 0.96 * Math.sin((angle * Math.PI) / 180), z: 0 },
      ],
    });
    const ranked = rankEnsemble({
      frames: [frame(-76.4, 104), frame(-76.4 + 1 / 627.5094740631, 130)],
      energyWindowKcal: 10,
      rmsdThreshold: 0.1,
    });
    const result = boltzmannWeightedObservables(
      ranked.retained.map((member) => ({
        id: member.id,
        population: member.population,
        values: { energyHartree: member.energyEh },
      })),
      { temperature: 298.15, observables: ['energyHartree'] },
    );
    expect(result.available).toBe(true);
    expect(result.populations[0].population).toBeCloseTo(ranked.retained[0].population, 12);
    expect(result.observables[0].weightedMean).toBeCloseTo(
      ranked.retained.reduce((sum, member) => sum + member.population * member.energyEh, 0),
      12,
    );
  });
});
