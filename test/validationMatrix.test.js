import { describe, expect, it } from 'vitest';
import {
  ValidationFormatError,
  parseValidationCases,
  validationMatrix,
  validationMatrixText,
} from '../src/shared/validationMatrix.js';

const CASES = {
  schemaVersion: 1,
  cases: [
    {
      id: 'water',
      name: 'Water',
      reference: -76.4,
      rungs: [
        { label: 'HF/STO-3G', energyHartree: -75.9 },
        { label: 'B3LYP/def2-SVP', energyHartree: -76.3 },
        { label: 'MP2/def2-TZVP', energyHartree: null, reason: 'engine not available' },
      ],
    },
    {
      id: 'methane',
      name: 'Methane',
      reference: { value: -40.5, unit: 'hartree' },
      rungs: [
        { label: 'HF/STO-3G', energyHartree: -40.1 },
        { label: 'B3LYP/def2-SVP', energyHartree: -40.4 },
      ],
    },
    {
      id: 'ammonia',
      name: 'Ammonia',
      reference: -56.5,
      rungs: [
        { label: 'HF/STO-3G', energyHartree: -56.1 },
        { label: 'B3LYP/def2-SVP', energyHartree: -56.4 },
      ],
    },
  ],
};

describe('validation matrix (#230)', () => {
  it('accepts three cases with two or more rungs and keeps a not-computed rung', () => {
    const matrix = validationMatrix(CASES);
    expect(matrix.cases).toHaveLength(3);
    expect(matrix.cases[0].rungs).toHaveLength(3);
    expect(matrix.cases[0].rungs[2].status).toBe('not computed');
    expect(matrix.cases[0].rungs[2].reason).toBe('engine not available');
    expect(matrix.cases[0].computedRungs).toBe(2);
    expect(matrix.cases[0].spreadKcal).toBeCloseTo(((-75.9) - (-76.3)) * 627.5094740631, 3);
    expect(matrix.missing).toEqual(['water: MP2/def2-TZVP']);
  });

  it('reports MAE/RMSE over the computed rungs and per rung', () => {
    const matrix = validationMatrix(CASES);
    expect(matrix.aggregate.n).toBe(6);
    expect(matrix.aggregate.maeKcal).toBeGreaterThan(0);
    expect(matrix.aggregate.rmseKcal).toBeGreaterThanOrEqual(matrix.aggregate.maeKcal);
    expect(matrix.perRung.map((entry) => entry.label)).toEqual([
      'B3LYP/def2-SVP', 'HF/STO-3G',
    ]);
    // MP2 had no energy, so it has no aggregate row rather than a fake one.
    expect(matrix.perRung.find((entry) => entry.label === 'MP2/def2-TZVP')).toBeUndefined();
  });

  it('renders the same deterministic table every time', () => {
    const first = validationMatrixText(validationMatrix(CASES));
    const second = validationMatrixText(validationMatrix(CASES));
    expect(second).toBe(first);
    expect(first).toContain('Validation matrix');
    expect(first).toContain('water\tHF/STO-3G');
    expect(first).toContain('not computed — engine not available');
    expect(first).toMatch(/aggregate: n=6 MAE=/);
  });

  it('marks a case with fewer than two computed rungs as not computed, without dropping it', () => {
    const matrix = validationMatrix({
      schemaVersion: 1,
      cases: [{
        id: 'broken',
        reference: -1,
        rungs: [
          { label: 'HF', energyHartree: -0.9 },
          { label: 'DFT', energyHartree: null, reason: 'crashed' },
        ],
      }],
    });
    expect(matrix.cases[0].status).toBe('not computed');
    expect(matrix.cases[0].spreadKcal).toBeNull();
    expect(matrix.cases[0].reason).toMatch(/fewer than 2 rungs/);
    expect(matrix.aggregate.n).toBe(1);
  });

  it('refuses a malformed or empty reference set', () => {
    expect(() => parseValidationCases({ schemaVersion: 1, cases: [] })).toThrow(ValidationFormatError);
    expect(() => parseValidationCases({ schemaVersion: 1, cases: [{ id: 'x', reference: 'nope', rungs: [] }] }))
      .toThrow(/reference/);
    expect(() => parseValidationCases({ schemaVersion: 2, cases: CASES.cases }))
      .toThrow(/schemaVersion/);
    expect(() => parseValidationCases({
      schemaVersion: 1,
      cases: [{ id: 'x', reference: -1, rungs: [{ label: 'one', energyHartree: -1 }] }],
    })).toThrow(/at least 2 rungs/);
    expect(() => parseValidationCases({
      schemaVersion: 1,
      cases: [{ id: 'x', reference: -1, rungs: [{ label: 'a', energyHartree: -1 }, { label: 'b', energyHartree: 'bad' }] }],
    })).toThrow(/energyHartree/);
  });
});
