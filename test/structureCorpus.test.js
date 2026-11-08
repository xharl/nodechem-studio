import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStructure, parseStructureRecords } from '../src/shared/structureImport.js';
import { parseTrajectory } from '../src/shared/trajectory.js';

const read = (name) => readFileSync(`test/fixtures/structures/${name}`, 'utf8');

/**
 * Atom counts are checked against the molecular formula of each PubChem record,
 * not against the parser's own output: aspirin C9H8O4 = 21, caffeine C8H10N4O2 =
 * 24, ibuprofen C13H18O2 = 33, penicillin G C16H18N2O4S = 41, ATP C10H16N5O13P3 =
 * 47. A parser that dropped a column would disagree with the formula.
 */
describe('PubChem SDF — five real records', () => {
  const file = read('pubchem-5molecules.sdf');

  it('lists all five records with their titles', () => {
    const { records } = parseStructureRecords(file, { filename: 'pubchem-5molecules.sdf' });
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.name)).toEqual(['2244', '2519', '3672', '5904', '5957']);
  });

  it('gives each record the atom count its formula requires', () => {
    const { records } = parseStructureRecords(file, { filename: 'pubchem-5molecules.sdf' });
    expect(records.map((record) => record.atoms.length)).toEqual([21, 24, 33, 41, 47]);
  });

  it('carries every element in the set, including sulfur and phosphorus', () => {
    const { records } = parseStructureRecords(file, { filename: 'pubchem-5molecules.sdf' });
    const elements = new Set(records.flatMap((record) => record.atoms.map((atom) => atom.element)));
    for (const element of ['C', 'H', 'N', 'O', 'S', 'P']) expect(elements).toContain(element);
  });

  it('keeps a bond block and bond orders for every record', () => {
    const { records } = parseStructureRecords(file, { filename: 'pubchem-5molecules.sdf' });
    for (const record of records) {
      expect(Array.isArray(record.bonds)).toBe(true);
      expect(record.bonds.length).toBeGreaterThan(0);
      for (const bond of record.bonds) {
        expect([1, 1.5, 2, 3]).toContain(bond.order);
        expect(bond.a).toBeGreaterThanOrEqual(1);
        expect(bond.b).toBeLessThanOrEqual(record.atoms.length);
      }
    }
  });

  it('finds aspirin’s five double bonds: three ring, one ester carbonyl, one acid carbonyl', () => {
    const aspirin = parseStructureRecords(file, { filename: 'x.sdf' }).records[0];
    expect(aspirin.bonds.filter((bond) => bond.order === 2)).toHaveLength(5);
  });

  it('warns instead of losing records when only one is requested', () => {
    const first = parseStructure(file, { filename: 'pubchem-5molecules.sdf' });
    expect(first.atoms).toHaveLength(21);
    expect(first.warnings.join(' ')).toContain('5 records');
  });
});

describe('multi-frame XYZ — derived from a real Gaussian optimisation', () => {
  const frames = parseStructureRecords(read('g16-dvb-gopt-frames.xyz'), { filename: 'g16-dvb-gopt-frames.xyz' });

  it('offers every frame, not just the first', () => {
    expect(frames.records).toHaveLength(6);
    for (const record of frames.records) expect(record.atoms).toHaveLength(18);
  });

  it('matches the geometry the Gaussian log contains, frame for frame', () => {
    const log = readFileSync('test/fixtures/real/g16-dvb-gopt.out', 'utf8');
    const steps = parseTrajectory(log).steps;
    expect(steps).toHaveLength(frames.records.length);
    for (let index = 0; index < steps.length; index += 1) {
      const fromLog = steps[index].atoms;
      const fromXyz = frames.records[index].atoms;
      expect(fromXyz.map((atom) => atom.element)).toEqual(fromLog.map((atom) => atom.element));
      for (let atom = 0; atom < fromLog.length; atom += 1) {
        expect(fromXyz[atom].x).toBeCloseTo(fromLog[atom].x, 5);
        expect(fromXyz[atom].y).toBeCloseTo(fromLog[atom].y, 5);
        expect(fromXyz[atom].z).toBeCloseTo(fromLog[atom].z, 5);
      }
    }
  });
});

/**
 * These four formats are not parsed yet. The assertion is that the refusal
 * *names the reason* — a silent "Unrecognised structure format" would tell the
 * user their file is broken when the reader is simply incomplete.
 */
describe('refusals that name the format', () => {
  it('refuses a CIF by naming periodic systems', () => {
    expect(() => parseStructure(read('1crn.cif'), { filename: '1crn.cif' }))
      .toThrow(/Periodic systems are not supported/);
  });

  it('refuses a single-model PDB as not implemented, not as unrecognised', () => {
    expect(() => parseStructure(read('1crn.pdb'), { filename: '1crn.pdb' }))
      .toThrow(/PDB import is not implemented yet \(#79\)/);
  });

  it('refuses a multi-model PDB the same way, without mistaking it for a .mol', () => {
    expect(() => parseStructure(read('1l2y-first-2-models.pdb'), { filename: '1l2y.pdb' }))
      .toThrow(/PDB import is not implemented yet/);
  });

  it('refuses MOL2 rather than sniffing its "#" comments as a Gaussian route', () => {
    expect(() => parseStructure(read('rdkit-sulfonate.mol2'), { filename: 'sulfonate.mol2' }))
      .toThrow(/MOL2 import is not implemented yet/);
    expect(() => parseStructure(read('rdkit-noxide.mol2'), { filename: 'noxide.mol2' }))
      .toThrow(/MOL2 import is not implemented yet/);
  });
});

/**
 * Counts taken from the files themselves with a tool that is not this parser:
 * `grep -c '^ATOM'` for the crystallographic structures.
 */
describe('the fixtures are what they claim to be', () => {
  it('1CRN has 327 ATOM records and 6 CONECT lines for its three disulfides', () => {
    const pdb = read('1crn.pdb');
    expect(pdb.match(/^ATOM/gm)?.length).toBe(327);
    expect(pdb.match(/^CONECT/gm)?.length).toBe(6);
    expect(pdb.match(/^HETATM/gm)).toBeNull();
  });

  it('the truncated 1L2Y keeps exactly two complete models', () => {
    const pdb = read('1l2y-first-2-models.pdb');
    expect(pdb.match(/^MODEL/gm)?.length).toBe(2);
    expect(pdb.match(/^ENDMDL/gm)?.length).toBe(2);
    expect(pdb.match(/^ATOM/gm)?.length).toBe(608); // 304 per model
  });

  it('the MOL2 fixtures declare their own atom and bond counts', () => {
    expect(read('rdkit-sulfonate.mol2')).toMatch(/@<TRIPOS>MOLECULE\s*\n\S+\s*\n\s*8\s+7/);
    expect(read('rdkit-noxide.mol2')).toMatch(/@<TRIPOS>BOND/);
  });
});
