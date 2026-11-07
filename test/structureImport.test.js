import { describe, it, expect } from 'vitest';
import { parseStructure, structureSummary } from '../src/shared/structureImport.js';

const WATER_XYZ = `3
water
O 0.000000 0.000000 0.117300
H 0.000000 0.757200 -0.469200
H 0.000000 -0.757200 -0.469200
`;

const BENZENE_XYZ = `12
benzene
C 1.3960 0.0000 ${'0.0000'}
C 0.6980 1.2090 ${'0.0000'}
C -0.6980 1.2090 ${'0.0000'}
C -1.3960 0.0000 ${'0.0000'}
C -0.6980 -1.2090 ${'0.0000'}
C 0.6980 -1.2090 ${'0.0000'}
H 2.4790 0.0000 ${'0.0000'}
H 1.2400 2.1470 ${'0.0000'}
H -1.2400 2.1470 ${'0.0000'}
H -2.4790 0.0000 ${'0.0000'}
H -1.2400 -2.1470 ${'0.0000'}
H 1.2400 -2.1470 ${'0.0000'}
`;

const WATER_MOL = `water
  Gaussian Node Studio

  3  2  0  0  0  0  0  0  0  0  1 V2000
    0.0000    0.0000    0.1173 O   0  0
    0.0000    0.7572   -0.4692 H   0  0
    0.0000   -0.7572   -0.4692 H   0  0
  1  2  1  0
  1  3  1  0
M  END
`;

const AMMONIUM_MOL = `ammonium
  test

  5  4  0  0  0  0  0  0  0  0  1 V2000
    0.0000    0.0000    0.0000 N   0  0
    0.9400    0.0000    0.0000 H   0  0
   -0.3133    0.8867    0.0000 H   0  0
   -0.3133   -0.4433    0.7670 H   0  0
   -0.3133   -0.4433   -0.7670 H   0  0
  1  2  1  0
  1  3  1  0
  1  4  1  0
  1  5  1  0
M  CHG  1   1   1
M  END
`;

const WATER_GJF = `%chk=water.chk
#p B3LYP/6-31G(d) Opt

water

0 1
O   0.000000    0.000000    0.117300
H   0.000000    0.757200   -0.469200
H   0.000000   -0.757200   -0.469200

`;

describe('XYZ import', () => {
  it('reads water', () => {
    const structure = parseStructure(WATER_XYZ, { filename: 'water.xyz' });
    expect(structure.format).toBe('xyz');
    expect(structure.atoms).toHaveLength(3);
    expect(structure.atoms[0]).toEqual({ element: 'O', x: 0, y: 0, z: 0.1173 });
    expect(structure.charge).toBe(0);
    expect(structure.multiplicity).toBe(1);
    expect(structure.name).toBe('water');
    expect(structureSummary(structure)).toContain('3 atoms');
  });

  it('reads benzene (12 atoms, 42 electrons)', () => {
    const structure = parseStructure(BENZENE_XYZ, { filename: 'benzene.xyz' });
    expect(structure.atoms).toHaveLength(12);
    expect(structure.atoms.filter((atom) => atom.element === 'C')).toHaveLength(6);
  });

  it('rejects a declared count that does not match the file', () => {
    const truncated = WATER_XYZ.replace('H 0.000000 -0.757200 -0.469200\n', '');
    expect(() => parseStructure(truncated, { filename: 'water.xyz' })).toThrow(/declares 3 atoms/);
  });

  it('rejects an unknown element symbol', () => {
    const bad = WATER_XYZ.replace('O 0.000000', 'Xx 0.000000');
    expect(() => parseStructure(bad, { filename: 'water.xyz' })).toThrow(/unknown element symbol "Xx"/);
  });

  it('rejects a non-finite coordinate', () => {
    const bad = WATER_XYZ.replace('0.117300', 'not-a-number');
    expect(() => parseStructure(bad, { filename: 'water.xyz' })).toThrow(/out-of-range coordinate/);
  });
});

describe('MOL / SDF import', () => {
  it('reads a V2000 MOL block', () => {
    const structure = parseStructure(WATER_MOL, { filename: 'water.mol' });
    expect(structure.atoms).toHaveLength(3);
    expect(structure.atoms[1].element).toBe('H');
  });

  it('applies formal charges from M  CHG', () => {
    const structure = parseStructure(AMMONIUM_MOL, { filename: 'ammonium.mol' });
    expect(structure.charge).toBe(1);
    expect(structure.multiplicity).toBe(1);
    expect(structure.warnings.join(' ')).toMatch(/Formal charges/);
  });

  it('reads the first molecule of an SDF', () => {
    const structure = parseStructure(`${WATER_MOL}$$$$\n`, { filename: 'set.sdf' });
    expect(structure.format).toBe('sdf');
    expect(structure.atoms).toHaveLength(3);
  });
});

describe('GJF / COM import', () => {
  it('reads Cartesian coordinates and the charge/multiplicity line', () => {
    const structure = parseStructure(WATER_GJF, { filename: 'water.gjf' });
    expect(structure.atoms).toHaveLength(3);
    expect(structure.charge).toBe(0);
    expect(structure.multiplicity).toBe(1);
  });

  it('refuses Z-matrix input instead of converting it', () => {
    const zmat = `#p HF/STO-3G Opt

water

0 1
O
H 1 0.96
H 1 0.96 2 104.5
`;
    expect(() => parseStructure(zmat, { filename: 'water.gjf' })).toThrow(/Z-matrix input is not supported/);
  });

  it('rejects a charge/multiplicity parity mismatch', () => {
    const bad = WATER_GJF.replace('0 1', '0 2');
    expect(() => parseStructure(bad, { filename: 'water.gjf' })).toThrow(/parity mismatch/);
  });
});

describe('structure validation', () => {
  it('rejects an empty file', () => {
    expect(() => parseStructure('   ', { filename: 'x.xyz' })).toThrow(/empty/);
  });

  it('rejects an unsupported format', () => {
    expect(() => parseStructure('hello', { filename: 'notes.txt' })).toThrow(/Unrecognised structure format/);
  });
});
