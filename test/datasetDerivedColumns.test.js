import { describe, expect, it } from 'vitest';

import {
  DATASET_CSV_COLUMNS,
  DATASET_SCHEMA_VERSION,
  datasetCsv,
  runRow,
} from '../src/shared/datasetExport.js';

/**
 * Issue 175's derived records reach the table.
 *
 * A compute block writes its own `run.json` with `kind: 'derived'` and a
 * `compute { expression, inputs, value, unit, notComputed }` block. Before these
 * columns existed the number lived only in the report, so a protocol's result
 * could not be read beside the energies it was derived from — which is the one
 * place a reader wants it.
 */

const derivedRun = (overrides = {}) => ({
  id: 'protocol~cbs',
  nodeId: 'protocol',
  kind: 'derived',
  title: 'CBS extrapolation',
  createdAt: '2026-11-09T02:00:00.000Z',
  provenance: { kind: 'derived', jobType: 'Analyse', method: {}, basis: null },
  analyse: {
    expression: 'extrapolate_CBS(E1, 3, E2, 2)',
    inputs: [
      { recordId: 'water-avtz', field: 'finalEnergyHartree', value: -76.4000, unit: 'hartree' },
      { recordId: 'water-avdz', field: 'finalEnergyHartree', value: -76.3500, unit: 'hartree' },
    ],
    value: -76.4210526316,
    unit: 'hartree',
    functionCalls: ['extrapolate_CBS'],
    notes: ['E_CBS = (E(X)·X³ − E(Y)·Y³)/(X³ − Y³)'],
    notComputed: null,
    ...overrides,
  },
});

describe('derived records in the dataset table', () => {
  it('carries the value, the unit, the expression and the numbers it read', () => {
    const row = runRow(derivedRun());

    expect(row.derivedValue).toBeCloseTo(-76.4210526316, 10);
    expect(row.derivedUnit).toBe('hartree');
    expect(row.derivedExpression).toBe('extrapolate_CBS(E1, 3, E2, 2)');
    expect(row.derivedInputs).toBe(
      'water-avtz:finalEnergyHartree=-76.4; water-avdz:finalEnergyHartree=-76.35',
    );
    expect(row.derivedNotComputed).toBeNull();
    // A derived record is not a calculation: it must not smuggle a value into
    // the energy column, or a reader would take it for a computed total.
    expect(row.finalEnergyHartree).toBeNull();
  });

  it('keeps the value empty and names the reason when the expression did not compute', () => {
    const row = runRow(derivedRun({
      value: null,
      unit: null,
      notComputed: 'finalEnergyHartree missing for record water-avdz',
    }));

    expect(row.derivedValue).toBeNull();
    expect(row.derivedUnit).toBeNull();
    // The expression and the inputs are still reported: they are what was tried.
    expect(row.derivedExpression).toBe('extrapolate_CBS(E1, 3, E2, 2)');
    expect(row.derivedInputs).toContain('water-avtz');
    expect(row.derivedNotComputed).toBe('finalEnergyHartree missing for record water-avdz');
  });

  it('leaves every derived column empty on a run that computed nothing', () => {
    const row = runRow({ id: 'sp-1', kind: 'run', parsed: { finalEnergy: { hartree: -76.4 } } });

    expect(row.derivedValue).toBeNull();
    expect(row.derivedUnit).toBeNull();
    expect(row.derivedExpression).toBeNull();
    expect(row.derivedInputs).toBeNull();
    expect(row.derivedNotComputed).toBeNull();
    // The value it does have is untouched.
    expect(row.finalEnergyHartree).toBe(-76.4);
  });

  it('marks an input whose value was not reported instead of printing a zero', () => {
    const row = runRow(derivedRun({
      inputs: [
        { recordId: 'water-avtz', field: 'finalEnergyHartree', value: -76.4 },
        { recordId: 'water-avdz', field: 'finalEnergyHartree', value: null },
      ],
    }));

    expect(row.derivedInputs).toBe(
      'water-avtz:finalEnergyHartree=-76.4; water-avdz:finalEnergyHartree=not reported',
    );
  });

  it('appends the columns without moving any earlier one', () => {
    const labels = DATASET_CSV_COLUMNS.map((column) => column.label);
    const keys = DATASET_CSV_COLUMNS.map((column) => column.key);
    expect(labels.slice(-5)).toEqual([
      'derived_value', 'derived_unit', 'derived_expression', 'derived_inputs', 'derived_not_computed',
    ]);
    expect(labels.indexOf('output_sha256')).toBeLessThan(labels.indexOf('derived_value'));
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DATASET_SCHEMA_VERSION).toBe(4);
  });

  it('reaches the CSV text, quoted correctly when the expression contains a comma', () => {
    const csv = datasetCsv([
      runRow(derivedRun({ expression: 'extrapolate_CBS(E1, 3, E2, 2)' })),
      runRow({ id: 'sp-1' }),
    ]);
    const [header, first, second] = csv.trim().split('\n');
    expect(header.split(',')).toContain('derived_expression');
    // RFC 4180: the expression holds commas, so the cell is quoted.
    expect(first).toContain('"extrapolate_CBS(E1, 3, E2, 2)"');
    expect(second.endsWith(',,,,')).toBe(true);
  });
});
