import { describe, expect, it } from 'vitest';
import {
  DATASET_CSV_COLUMNS,
  DATASET_SCHEMA_VERSION,
  datasetCsv,
  datasetJson,
  runRow,
  runRows,
} from '../src/shared/datasetExport.js';

function record(overrides = {}) {
  return {
    id: 'run-1',
    title: 'Water SP',
    status: 'completed',
    engine: 'gaussian',
    finishedAt: '2026-11-08T01:00:00.000Z',
    elapsedSeconds: 12.5,
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    provenance: {
      jobType: 'SP',
      method: { functional: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ', solvation: null },
    },
    parsed: {
      finalEnergy: { hartree: -76.4 },
      scf: { cycles: 8 },
      frequencies: { imaginaryCount: 0 },
      thermochemistry: { freeEnergyHartree: -76.3 },
      resources: { elapsedSeconds: 11.9 },
    },
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    ...overrides,
  };
}

describe('dataset rows', () => {
  it('flattens a run record into one row', () => {
    const row = runRow(record());
    expect(row).toMatchObject({
      id: 'run-1',
      engine: 'gaussian',
      jobType: 'SP',
      method: 'B3LYP',
      basis: 'def2-SVP',
      dispersion: 'GD3BJ',
      status: 'completed',
      gates: 'pass',
      validity: 'pass',
      finalEnergyHartree: -76.4,
      gibbsHartree: -76.3,
      imaginaryCount: 0,
      scfCycles: 8,
      elapsedSeconds: 12.5,
      dryRun: false,
    });
  });

  it('keeps a dry run flagged and never invents a missing value', () => {
    const row = runRow({ id: 'r2', dryRun: true, parsed: {} });
    expect(row.dryRun).toBe(true);
    expect(row.finalEnergyHartree).toBeNull();
    expect(row.gibbsHartree).toBeNull();
    expect(row.scfCycles).toBeNull();
    expect(row.method).toBeNull();
  });

  it('falls back to the SCF energy when no final-energy record exists', () => {
    expect(runRow({ parsed: { scf: { energyHartree: -1.5, cycles: 5 } } }).finalEnergyHartree).toBe(-1.5);
  });

  it('survives malformed records', () => {
    expect(() => runRow(null)).not.toThrow();
    expect(runRow(null).id).toBeNull();
    expect(runRows(null)).toEqual([]);
    expect(runRows([record(), null]).length).toBe(2);
  });
});

describe('dataset CSV', () => {
  it('writes the documented header in a stable order', () => {
    const csv = datasetCsv([]);
    expect(csv.split('\n')[0]).toBe(DATASET_CSV_COLUMNS.map((column) => column.label).join(','));
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('quotes values containing a comma, quote or newline', () => {
    const csv = datasetCsv([
      runRow(record({ title: 'A, B' })),
      runRow(record({ title: 'He said "hi"' })),
      runRow(record({ title: 'line\nbreak' })),
    ]);
    expect(csv).toContain('"A, B"');
    expect(csv).toContain('"He said ""hi"""');
    expect(csv).toContain('"line\nbreak"');
  });

  it('leaves a missing value as an empty cell, not zero', () => {
    const csv = datasetCsv([runRow(record({ parsed: {} }))]);
    const cells = csv.split('\n')[1].split(',');
    const index = DATASET_CSV_COLUMNS.findIndex((column) => column.key === 'finalEnergyHartree');
    expect(cells[index]).toBe('');
  });
});

describe('dataset JSON', () => {
  it('wraps the rows in a versioned envelope', () => {
    const rows = runRows([record()]);
    const json = datasetJson(rows, { generatedAt: '2026-11-08T01:00:00.000Z', appVersion: '0.2.1' });
    expect(json.schemaVersion).toBe(DATASET_SCHEMA_VERSION);
    expect(json.kind).toBe('nodechem-studio.dataset');
    expect(json.rowCount).toBe(1);
    expect(json.appVersion).toBe('0.2.1');
    expect(json.rows[0].id).toBe('run-1');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('reports null provenance instead of guessing it', () => {
    const json = datasetJson([], {});
    expect(json.generatedAt).toBeNull();
    expect(json.appVersion).toBeNull();
    expect(json.rowCount).toBe(0);
  });
});
