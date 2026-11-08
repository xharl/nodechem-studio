import { describe, expect, it } from 'vitest';
import {
  DATASET_CSV_COLUMNS,
  DATASET_SCHEMA_VERSION,
  datasetCsv,
  datasetJson,
  runRow,
  runRows,
} from '../src/shared/datasetExport.js';
import { wavefunctionRecord } from '../src/shared/wavefunction.js';

/** A formatted checkpoint with just the fields the export columns read. */
const FCHK = [
  'water B3LYP/def2-SVP',
  'Number of atoms                            I                3',
  'Charge                                     I                0',
  'Number of alpha electrons                  I                5',
  'Number of beta electrons                   I                5',
  'Orbital Energies                          R   N=           6',
  ' -2.00000000E+01 -1.40000000E+00 -7.00000000E-01 -3.00000000E-01  1.00000000E-01',
  '  2.00000000E-01',
  'Mulliken Charges                          R   N=           3',
  '  0.00000000E+00  0.00000000E+00  0.00000000E+00',
].join('\n');

/** 2×1×1 cube: the smallest grid the reader accepts, with known extrema. */
const CUBE = [
  'density',
  'test grid',
  '1 0.0 0.0 0.0',
  '8 8.0 0.0 0.0 0.0',
  '  -2 1.0 1.0 0.0 0.0',
  '  -1 1.0 0.0 1.0 0.0',
  '  -1 1.0 0.0 0.0 1.0',
  '0.25 0.75',
].join('\n');

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

  it('keeps the conformer member grouping on every fanned-out row', () => {
    const rows = runRows([
      record({ id: 'run-c1', conformer: { nodeId: 'conf', id: 'c1', relativeKcal: 0, population: 0.94, protomer: '' } }),
      record({ id: 'run-c2', conformer: { nodeId: 'conf', id: 'c2', relativeKcal: 3.4, population: 0.06, protomer: 'A' } }),
      record({ id: 'run-plain' }),
    ]);
    expect(rows[0]).toMatchObject({ conformerNode: 'conf', conformerMember: 'c1', conformerRelativeKcal: 0, conformerPopulation: 0.94 });
    expect(rows[1]).toMatchObject({ conformerMember: 'c2', conformerRelativeKcal: 3.4, conformerProtomer: 'A' });
    expect(rows[2].conformerMember).toBeNull();
    const header = datasetCsv(rows).split('\n')[0];
    expect(header).toContain('conformer_member');
    expect(header).toContain('conformer_relative_kcal');
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

  it('is at version 2 now that the wavefunction columns exist', () => {
    expect(DATASET_SCHEMA_VERSION).toBe(2);
  });
});

describe('wavefunction columns', () => {
  it('fills the wavefunction columns from a run record that carries one', () => {
    const wavefunction = wavefunctionRecord([
      { text: CUBE, filename: 'density.cube' },
      { text: FCHK, filename: 'water.fchk' },
    ]);
    const row = runRow(record({ wavefunction }));
    expect(row.fchkSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.cubeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.cubeDims).toBe('2x1x1');
    expect(row.cubeMin).toBe(0.25);
    expect(row.cubeMax).toBe(0.75);
    expect(row.cubeMean).toBeCloseTo(0.5, 12);
    // No Pop=Full print in this record, so the gap columns come from the
    // checkpoint rather than staying empty.
    expect(row.homoEv).toBeCloseTo(0.1 * 27.211386245988, 10);
    expect(row.lumoEv).toBeCloseTo(0.2 * 27.211386245988, 10);
    expect(row.gapEv).toBeCloseTo(2.7211386246, 8);
    expect(row.hardnessEv).toBeNull();
    expect(row.mullikenChargeSum).toBe(0);
    expect(row.mullikenChargeDeviation).toBe(0);
    expect(row.spinMultiplicity).toBe(1);
    expect(row.unpairedElectrons).toBe(0);
    // Not in the fixture, so an empty cell rather than a zero.
    expect(row.fchkTotalEnergyHartree).toBeNull();
  });

  it('leaves every wavefunction column null when the run has none', () => {
    const row = runRow(record());
    const keys = [
      'fchkSha256', 'cubeSha256', 'cubeDims', 'cubeMin', 'cubeMax', 'cubeMean',
      'homoEv', 'lumoEv', 'gapEv', 'hardnessEv', 'fchkTotalEnergyHartree',
      'mullikenChargeSum', 'mullikenChargeDeviation', 'spinMultiplicity', 'unpairedElectrons',
    ];
    for (const key of keys) expect(row[key], key).toBeNull();
  });

  it('treats a derived value that is not computable as an empty cell', () => {
    const wavefunction = {
      version: 1,
      artifacts: [{ kind: 'fchk', file: 'run.fchk', sha256: 'c'.repeat(64), bytes: 10 }],
      fchk: {
        fields: { found: [], missing: [] },
        orbitalGap: { ok: false, reason: 'the checkpoint has no "Orbital Energies" array' },
        spin: { ok: false, reason: 'no counts' },
        chargeSanity: { ok: false, reason: 'no charges' },
      },
    };
    const row = runRow(record({ wavefunction }));
    expect(row.fchkSha256).toBe('c'.repeat(64));
    expect(row.cubeSha256).toBeNull();
    expect(row.homoEv).toBeNull();
    expect(row.lumoEv).toBeNull();
    expect(row.gapEv).toBeNull();
    expect(row.mullikenChargeSum).toBeNull();
    expect(row.spinMultiplicity).toBeNull();
  });

  it('accepts the block under parsed.wavefunction as well', () => {
    const wavefunction = wavefunctionRecord([{ text: CUBE, filename: 'density.cube' }]);
    const row = runRow(record({ parsed: { wavefunction } }));
    expect(row.cubeDims).toBe('2x1x1');
    expect(row.mullikenChargeSum).toBeNull();
  });

  it('appends the columns without moving or duplicating the existing ones', () => {
    const labels = DATASET_CSV_COLUMNS.map((column) => column.label);
    expect(labels.slice(0, 2)).toEqual(['run_id', 'finished_at']);
    expect(labels).toContain('output_sha256');
    expect(labels.indexOf('output_sha256')).toBeLessThan(labels.indexOf('fchk_sha256'));
    expect(labels[labels.length - 1]).toBe('unpaired_electrons');
    // The frontier-orbital columns belong to the log reader (#81); this change
    // must not add a second `homo_ev` beside them.
    expect(labels.filter((label) => label === 'homo_ev')).toHaveLength(1);
    expect(labels.filter((label) => label === 'gap_ev')).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(DATASET_CSV_COLUMNS.map((column) => column.key)).size).toBe(DATASET_CSV_COLUMNS.length);
  });

  it('prefers the log orbital table over the checkpoint when both exist', () => {
    const wavefunction = wavefunctionRecord([{ text: FCHK, filename: 'water.fchk' }]);
    const row = runRow(record({
      wavefunction,
      parsed: { orbitals: { alpha: { homoEv: -4.165519, lumoEv: 1.01825, gapEv: 5.183769, etaEv: 2.591885 } } },
    }));
    expect(row.homoEv).toBe(-4.165519);
    expect(row.gapEv).toBe(5.183769);
    expect(row.hardnessEv).toBe(2.591885);
  });

  it('writes an empty CSV cell for a run without a wavefunction', () => {
    const csv = datasetCsv([runRow(record())]);
    const cells = csv.split('\n')[1].split(',');
    const index = DATASET_CSV_COLUMNS.findIndex((column) => column.key === 'gapEv');
    expect(cells[index]).toBe('');
  });
});
