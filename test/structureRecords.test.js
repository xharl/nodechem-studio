import { describe, expect, it } from 'vitest';
import { parseStructure, parseStructureRecords } from '../src/shared/structureImport.js';
import { prepareGeometry } from '../src/renderer/structureViewer.js';

const MOL = (name, atoms, bonds) => {
  const lines = [name, '  test', '', `  ${String(atoms.length).padStart(3)} ${String(bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`];
  for (const [element, x, y, z] of atoms) {
    lines.push(`${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}${z.toFixed(4).padStart(10)} ${element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }
  for (const [a, b, order] of bonds) lines.push(`  ${a}  ${b}  ${order}  0`);
  lines.push('M  END');
  return lines.join('\n');
};

const ethanol = MOL('ethanol', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.6, 0, 0]], [[1, 2, 1], [2, 3, 1]]);
const carbonDioxide = MOL('co2', [['C', 0, 0, 0], ['O', -1.16, 0, 0], ['O', 1.16, 0, 0]], [[1, 2, 2], [1, 3, 2]]);

describe('bond topology from a MOL block', () => {
  it('keeps the bond orders the file states', () => {
    const structure = parseStructure(carbonDioxide, { filename: 'co2.mol' });
    expect(structure.bonds).toEqual([{ a: 1, b: 2, order: 2 }, { a: 1, b: 3, order: 2 }]);
  });

  it('omits bonds entirely when the block declares none', () => {
    const structure = parseStructure(MOL('atom', [['C', 0, 0, 0]], []), { filename: 'c.mol' });
    expect(structure.bonds).toBeUndefined();
  });

  it('keeps aromatic bonds at order 1.5 and says so', () => {
    const benzene = MOL('benzene', [['C', 0, 0, 0], ['C', 1.4, 0, 0]], [[1, 2, 4]]);
    const structure = parseStructure(benzene, { filename: 'b.mol' });
    expect(structure.bonds[0].order).toBe(1.5);
    expect(structure.warnings.join(' ')).toContain('aromatic');
  });

  it('drops a bond that points outside the atom list instead of drawing it', () => {
    const broken = MOL('broken', [['C', 0, 0, 0]], [[1, 4, 1]]);
    const structure = parseStructure(broken, { filename: 'b.mol' });
    expect(structure.bonds).toBeUndefined();
    expect(structure.warnings.join(' ')).toContain('outside this structure');
  });
});

describe('multi-record files', () => {
  it('lists every SDF record instead of silently keeping the first', () => {
    const file = `${ethanol}\n$$$$\n${carbonDioxide}\n$$$$\n`;
    const { records } = parseStructureRecords(file, { filename: 'two.sdf' });
    expect(records).toHaveLength(2);
    expect(records[0].atoms).toHaveLength(3);
    expect(records[1].bonds.map((bond) => bond.order)).toEqual([2, 2]);
  });

  it('warns that a single-structure parse loaded only record 1', () => {
    const file = `${ethanol}\n$$$$\n${carbonDioxide}\n$$$$\n`;
    const first = parseStructure(file, { filename: 'two.sdf' });
    expect(first.name).toBe('ethanol');
    expect(first.warnings.join(' ')).toContain('2 records');
  });

  it('splits a multi-frame XYZ', () => {
    const file = '3\nframe one\nO 0 0 0\nH 0.9572 0 0\nH -0.2390 0.9270 0\n3\nframe two\nO 0 0 0\nH 0.9600 0 0\nH -0.2400 0.9300 0';
    const { records } = parseStructureRecords(file, { filename: 'traj.xyz' });
    expect(records).toHaveLength(2);
    expect(records[1].atoms[1].x).toBeCloseTo(0.96, 6);
  });

  it('returns one record for a single-structure format', () => {
    const { records } = parseStructureRecords(ethanol, { filename: 'one.mol' });
    expect(records).toHaveLength(1);
  });
});

describe('viewer honours stated topology', () => {
  it('draws the file bonds and marks them as stated, not perceived', () => {
    const structure = parseStructure(carbonDioxide, { filename: 'co2.mol' });
    const prepared = prepareGeometry({ atoms: structure.atoms, bonds: structure.bonds });
    expect(prepared.bondsFrom).toBe('file');
    expect(prepared.bonds.map((bond) => bond.order)).toEqual([2, 2]);
    expect(prepared.bonds[0].distance).toBeCloseTo(1.16, 2);
  });

  it('falls back to distance perception when the source states nothing', () => {
    const prepared = prepareGeometry({ atoms: [{ element: 'O', x: 0, y: 0, z: 0 }, { element: 'H', x: 0.96, y: 0, z: 0 }] });
    expect(prepared.bondsFrom).toBe('perceived');
    expect(prepared.bonds).toHaveLength(1);
  });

  it('ignores a bond index that is out of range rather than throwing', () => {
    const prepared = prepareGeometry({
      atoms: [{ element: 'C', x: 0, y: 0, z: 0 }, { element: 'H', x: 1.09, y: 0, z: 0 }],
      bonds: [{ a: 1, b: 2, order: 1 }, { a: 1, b: 9, order: 1 }],
    });
    expect(prepared.bonds).toHaveLength(1);
  });
});
