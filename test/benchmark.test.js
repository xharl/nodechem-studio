import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_DATASETS,
  benchmarkDataset,
  benchmarkSummaryText,
  bondLengthsFromGeometry,
  runBenchmark,
} from '../src/shared/benchmark.js';
import { EXPERIMENTAL_BOND_LENGTHS } from '../src/shared/referenceData/experimentalBondLengths.js';

const water = (oh = 0.9578) => [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: oh, y: 0, z: 0 },
  { element: 'H', x: oh * Math.cos((104.4776 * Math.PI) / 180), y: oh * Math.sin((104.4776 * Math.PI) / 180), z: 0 },
];

const methane = (ch = 1.087) => {
  const d = ch / Math.sqrt(3);
  return [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'H', x: d, y: d, z: d },
    { element: 'H', x: d, y: -d, z: -d },
    { element: 'H', x: -d, y: d, z: -d },
    { element: 'H', x: -d, y: -d, z: d },
  ];
};

describe('shipped reference dataset', () => {
  it('is registered under a stable name', () => {
    expect(Object.keys(BENCHMARK_DATASETS)).toContain('experimental-bond-lengths');
    expect(benchmarkDataset('experimental-bond-lengths')).toBe(EXPERIMENTAL_BOND_LENGTHS);
  });

  it('carries provenance for every entry — source, level of theory, units and a citation', () => {
    const dataset = benchmarkDataset('experimental-bond-lengths');
    expect(dataset.source).toBeTruthy();
    expect(dataset.url).toMatch(/^https:\/\/cccbdb\.nist\.gov\//);
    expect(dataset.units).toBe('angstrom');
    expect(dataset.entries.length).toBeGreaterThanOrEqual(6);
    for (const entry of dataset.entries) {
      expect(entry.id, 'entry id').toBeTruthy();
      expect(entry.name, entry.id).toBeTruthy();
      expect(entry.formula, entry.id).toBeTruthy();
      expect(entry.level, entry.id).toMatch(/^experimental/);
      expect(entry.units, entry.id).toBe('angstrom');
      expect(entry.source, entry.id).toBeTruthy();
      expect(entry.citation, entry.id).toBeTruthy();
      expect(entry.url, entry.id).toMatch(/^https:\/\/cccbdb\.nist\.gov\//);
      expect(entry.bonds.length, entry.id).toBeGreaterThan(0);
      for (const bond of entry.bonds) {
        expect(bond.elements, entry.id).toHaveLength(2);
        expect(bond.count, entry.id).toBeGreaterThan(0);
        expect(bond.length, entry.id).toBeGreaterThan(0.5);
        expect(bond.length, entry.id).toBeLessThan(3);
        expect(bond.label, entry.id).toBeTruthy();
      }
    }
  });

  it('does not mix a non-r_e structure into the r_e dataset', () => {
    const dataset = benchmarkDataset('experimental-bond-lengths');
    expect(dataset.entries.every((entry) => entry.level === 'experimental r_e')).toBe(true);
    // Acetylene is only available as r_m in the source; it must be left out
    // rather than compared as if it were an equilibrium bond length.
    expect(dataset.entries.some((entry) => entry.formula === 'C2H2')).toBe(false);
  });
});

describe('bond length extraction', () => {
  it('finds only the bonded pairs, grouped by element pair', () => {
    const bonds = bondLengthsFromGeometry(water());
    expect(bonds).toHaveLength(2);
    for (const bond of bonds) {
      expect(bond.elements).toEqual(['H', 'O']);
      expect(bond.length).toBeCloseTo(0.9578, 6);
    }
    expect(bondLengthsFromGeometry(methane())).toHaveLength(4);
  });
});

describe('benchmark runner', () => {
  it('compares a computed geometry to the cited reference and reports zero-ish error', () => {
    const result = runBenchmark(benchmarkDataset('experimental-bond-lengths'), [
      { id: 'water-opt', label: 'B3LYP/def2-TZVP', level: 'B3LYP/def2-TZVP', atoms: water() },
    ]);
    const waterPoint = result.points.find((point) => point.entryId === 'water');
    expect(waterPoint.status).toBe('computed');
    expect(waterPoint.property).toBe('bond_length');
    expect(waterPoint.reference).toBeCloseTo(0.9578, 6);
    expect(waterPoint.computed).toBeCloseTo(0.9578, 6);
    expect(waterPoint.error).toBeCloseTo(0, 6);
    expect(result.summary.bond_length.n).toBe(2);
    expect(result.summary.bond_length.mae).toBeCloseTo(0, 6);
    expect(result.summary.bond_length.rmse).toBeCloseTo(0, 6);
    expect(result.summary.bond_length.maxAbsError).toBeCloseTo(0, 6);
  });

  it('reports systematic error, spread and the number of points for a distorted set', () => {
    const result = runBenchmark(benchmarkDataset('experimental-bond-lengths'), [
      { id: 'water-opt', label: 'B3LYP/def2-TZVP', level: 'B3LYP/def2-TZVP', atoms: water(1.02) },
      { id: 'methane-opt', label: 'B3LYP/def2-TZVP', level: 'B3LYP/def2-TZVP', atoms: methane(1.10) },
    ]);
    const summary = result.summary.bond_length;
    expect(summary.n).toBe(6); // two O–H and four C–H bonds
    expect(summary.mae).toBeGreaterThan(0);
    expect(summary.rmse).toBeGreaterThanOrEqual(summary.mae);
    expect(summary.maxAbsError).toBeGreaterThanOrEqual(summary.mae);
    expect(summary.maxAbsError).toBeLessThanOrEqual(summary.rmse * Math.sqrt(summary.n));
    expect(summary.meanSignedError).toBeGreaterThan(0); // computed longer than reference
    expect(summary.spread).toBeGreaterThan(0);
    expect(summary.spread).toBeCloseTo(summary.maxSignedError - summary.minSignedError, 12);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('marks an entry it could not compute instead of dropping it', () => {
    const result = runBenchmark(benchmarkDataset('experimental-bond-lengths'), [
      { id: 'water-opt', label: 'B3LYP/def2-TZVP', level: 'B3LYP/def2-TZVP', atoms: water() },
    ]);
    const missing = result.missing.find((point) => point.entryId === 'methane');
    expect(missing).toBeTruthy();
    expect(missing.status).toBe('not computed');
    expect(missing.reason).toMatch(/no computed geometry/);
    expect(result.entriesConsidered).toBe(EXPERIMENTAL_BOND_LENGTHS.entries.length);
    expect(result.summary.bond_length.n).toBe(2);
  });

  it('marks a geometry with the wrong composition rather than guessing a mapping', () => {
    const wrong = [
      { element: 'O', x: 0, y: 0, z: 0 },
      { element: 'H', x: 0.96, y: 0, z: 0 },
    ];
    const result = runBenchmark(benchmarkDataset('experimental-bond-lengths'), [
      { id: 'broken', label: 'B3LYP/def2-TZVP', level: 'B3LYP/def2-TZVP', atoms: wrong },
    ]);
    const waterPoint = result.missing.find((point) => point.entryId === 'water');
    expect(waterPoint.status).toBe('not computed');
    expect(waterPoint.reason).toMatch(/composition|bond/);
  });

  it('formats the per-property summary with the point count and both error measures', () => {
    const result = runBenchmark(benchmarkDataset('experimental-bond-lengths'), [
      { id: 'water-opt', label: 'B3LYP/def2-TZVP', level: 'B3LYP/def2-TZVP', atoms: water(1.0) },
    ]);
    const text = benchmarkSummaryText(result);
    expect(text).toContain('bond_length');
    expect(text).toContain('MAE');
    expect(text).toContain('RMSE');
    expect(text).toContain('max');
    expect(text).toMatch(/n = 2/);
    expect(text).toMatch(/angstrom/);
  });
});
