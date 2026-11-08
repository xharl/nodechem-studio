import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStructure, parseStructureRecords } from '../src/shared/structureImport.js';

const read = (name) => readFileSync(`test/fixtures/structures/${name}`, 'utf8');

/**
 * The atom counts here come from an outside tool, not from the parser:
 * `grep -c '^ATOM'` on each file and each molecule's formula.
 */
describe('PDB — 1CRN crambin', () => {
  it('reads all 327 atoms from the fixed columns', () => {
    const structure = parseStructure(read('1crn.pdb'), { filename: '1crn.pdb' });
    expect(structure.atoms).toHaveLength(327);
    expect(structure.format).toBe('pdb');
  });

  it('uses the element column, so CA is carbon and not calcium', () => {
    const structure = parseStructure(read('1crn.pdb'), { filename: '1crn.pdb' });
    const elements = new Set(structure.atoms.map((atom) => atom.element));
    expect(elements).toEqual(new Set(['C', 'N', 'O', 'S']));
    expect(elements.has('Ca')).toBe(false);
  });

  it('says why CONECT was not used as a topology', () => {
    const structure = parseStructure(read('1crn.pdb'), { filename: '1crn.pdb' });
    expect(structure.bonds).toBeUndefined();
    expect(structure.warnings.join(' ')).toContain('CONECT');
  });

  it('sets a parity-consistent multiplicity and warns that it had to', () => {
    const structure = parseStructure(read('1crn.pdb'), { filename: '1crn.pdb' });
    const electrons = structure.atoms.reduce((total, atom) => total + electronCount(atom.element), 0) - structure.charge;
    expect((electrons - (structure.multiplicity - 1)) % 2).toBe(0);
    expect(structure.warnings.join(' ')).toContain('multiplicity was set to');
  });

  it('keeps the coordinates it read, in ångström', () => {
    const structure = parseStructure(read('1crn.pdb'), { filename: '1crn.pdb' });
    // First ATOM record of 1CRN: N of THR 1 at 17.047, 14.099, 3.625.
    expect(structure.atoms[0]).toMatchObject({ element: 'N' });
    expect(structure.atoms[0].x).toBeCloseTo(17.047, 3);
    expect(structure.atoms[0].y).toBeCloseTo(14.099, 3);
    expect(structure.atoms[0].z).toBeCloseTo(3.625, 3);
  });
});

describe('PDB — multi-model ensemble', () => {
  it('offers one record per MODEL', () => {
    const { records } = parseStructureRecords(read('1l2y-first-2-models.pdb'), { filename: '1l2y.pdb' });
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.atoms.length)).toEqual([304, 304]);
    expect(records[0].name).toContain('model 1');
    expect(records[1].name).toContain('model 2');
  });

  it('gives different coordinates for the two models', () => {
    const { records } = parseStructureRecords(read('1l2y-first-2-models.pdb'), { filename: '1l2y.pdb' });
    expect(records[0].atoms[0].x).not.toBeCloseTo(records[1].atoms[0].x, 1);
  });

  it('reads a single structure from the first model, not a merged ensemble', () => {
    const structure = parseStructure(read('1l2y-first-2-models.pdb'), { filename: '1l2y.pdb' });
    expect(structure.atoms).toHaveLength(304);
    expect(structure.warnings.join(' ')).not.toContain('alternative-location');
  });
});

describe('PDBQT — AutoDock ligand', () => {
  const structure = parseStructure(read('vina-1iep-ligand.pdbqt'), { filename: 'ligand.pdbqt' });

  it('keeps every atom even though the ligand reuses atom names', () => {
    expect(structure.atoms).toHaveLength(40);
  });

  it('reads the AutoDock atom types as elements', () => {
    expect(new Set(structure.atoms.map((atom) => atom.element))).toEqual(new Set(['C', 'N', 'O', 'H']));
    expect(structure.warnings.join(' ')).not.toContain('inferred');
  });

  it('reports that partial charges exist without turning them into a total charge', () => {
    expect(structure.warnings.join(' ')).toContain('Partial charges');
    expect(structure.charge).toBe(0);
  });
});

describe('MOL2 — Tripos files', () => {
  it('reads atoms, bonds and bond orders', () => {
    const structure = parseStructure(read('rdkit-sulfonate.mol2'), { filename: 'sulfonate.mol2' });
    expect(structure.atoms).toHaveLength(8);
    expect(structure.bonds).toHaveLength(7);
    expect(structure.bonds.every((bond) => bond.a >= 1 && bond.b <= 8)).toBe(true);
  });

  it('reads a charged species and adjusts the multiplicity to the electron count', () => {
    const structure = parseStructure(read('rdkit-sulfonate.mol2'), { filename: 'sulfonate.mol2' });
    expect(structure.atoms.map((atom) => atom.element)).toContain('S');
    const electrons = structure.atoms.reduce((total, atom) => total + electronCount(atom.element), 0) - structure.charge;
    expect((electrons - (structure.multiplicity - 1)) % 2).toBe(0);
  });

  it('reads the larger N-oxide file with its bond block intact', () => {
    const structure = parseStructure(read('rdkit-noxide.mol2'), { filename: 'noxide.mol2' });
    expect(structure.atoms).toHaveLength(27);
    expect(structure.bonds).toHaveLength(27);
    expect(new Set(structure.atoms.map((atom) => atom.element)).has('O')).toBe(true);
  });

  it('does not claim a total charge it cannot compute', () => {
    const structure = parseStructure(read('rdkit-noxide.mol2'), { filename: 'noxide.mol2' });
    expect(Number.isInteger(structure.charge)).toBe(true);
  });
});

describe('Gaussian log as a geometry source', () => {
  it('offers every optimisation frame', () => {
    const { records } = parseStructureRecords(readFileSync('test/fixtures/real/g16-dvb-gopt.out', 'utf8'), { filename: 'opt.out' });
    expect(records).toHaveLength(6);
    expect(records[0].atoms).toHaveLength(18);
  });

  it('returns the last frame for a single-structure read, which is the optimised geometry', () => {
    const structure = parseStructure(readFileSync('test/fixtures/real/g16-dvb-gopt.out', 'utf8'), { filename: 'opt.out' });
    expect(structure.atoms).toHaveLength(18);
    expect(structure.format).toBe('log');
  });
});

describe('cJSON', () => {
  // Written to RDKit's documented Chem.Mol.ToJSON shape. Not captured from a
  // real RDKit run — the schema is documented, so the fixture follows it and
  // says so rather than pretending to be a corpus file.
  const cjson = JSON.stringify({
    molecule: {
      atoms: [{ element: 'C' }, { element: 'O' }, { element: 'O' }],
      bonds: [{ aid1: 0, aid2: 1, order: 2 }, { aid1: 0, aid2: 2, order: 2 }],
      conformer: { position: [0, 0, 0, -1.16, 0, 0, 1.16, 0, 0] },
    },
  });

  it('reads elements, positions and bond orders', () => {
    const structure = parseStructure(cjson, { filename: 'co2.cjson' });
    expect(structure.atoms.map((atom) => atom.element)).toEqual(['C', 'O', 'O']);
    expect(structure.atoms[1].x).toBeCloseTo(-1.16, 6);
    expect(structure.bonds).toEqual([{ a: 1, b: 2, order: 2 }, { a: 1, b: 3, order: 2 }]);
  });

  it('refuses a file with atoms but no 3D conformer', () => {
    const flat = JSON.stringify({ molecule: { atoms: [{ element: 'C' }], bonds: [] } });
    expect(() => parseStructure(flat, { filename: 'flat.cjson' })).toThrow(/no conformer with 3D positions/);
  });
});

describe('refusals name the reason', () => {
  it('refuses a CIF as periodic', () => {
    expect(() => parseStructure(read('1crn.cif'), { filename: '1crn.cif' })).toThrow(/Periodic systems are not supported/);
  });

  it('refuses a binary checkpoint and points at #59', () => {
    expect(() => parseStructure('binary', { filename: 'water.chk' })).toThrow(/#59/);
    expect(() => parseStructure('binary', { filename: 'water.fchk' })).toThrow(/binary checkpoint/);
  });

  it('refuses a SMILES list for having no coordinates', () => {
    expect(() => parseStructure('CCO\nc1ccccc1\n', { filename: 'ligands.smi' })).toThrow(/no coordinates/);
  });
});

/** Atomic numbers for the parity assertions. */
function electronCount(element) {
  const table = {
    H: 1, C: 6, N: 7, O: 8, F: 9, P: 15, S: 16, Cl: 17, Br: 35, I: 53, Se: 34, B: 5, Si: 14,
  };
  return table[element] ?? 0;
}
