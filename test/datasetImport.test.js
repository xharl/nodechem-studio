import { describe, it, expect } from 'vitest';
import { parseDataset, slugifyRecordId } from '../src/shared/datasetImport.js';
import { LIMITS } from '../src/shared/projectSchema.js';

const atomLine = (element, x, y, z) => `${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}${z.toFixed(4).padStart(10)} ${element.padEnd(3)}0  0  0  0  0  0  0  0  0  0  0  0`;

function sdfBlock(title, atoms, { charge = 0 } = {}) {
  const lines = [
    title,
    '  NodeChem 11082600003D',
    '',
    `${String(atoms.length).padStart(3)}  0  0  0  0  0            999 V2000`,
    ...atoms.map((atom) => atomLine(atom.element, atom.x, atom.y, atom.z)),
  ];
  if (charge !== 0) lines.push(`M  CHG  1   1  ${charge}`);
  return `${lines.join('\n')}\n$$$$\n`;
}

describe('datasetImport — SDF', () => {
  it('reads every $$$$ record, its title, geometry and formal charge', () => {
    const text = [
      sdfBlock('water', [
        { element: 'O', x: 0, y: 0, z: 0.1173 },
        { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
        { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
      ]),
      sdfBlock('hydroxide', [
        { element: 'O', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0, y: 0, z: 0.97 },
      ], { charge: -1 }),
    ].join('');
    const result = parseDataset(text, { filename: 'family.sdf' });

    expect(result.format).toBe('sdf');
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: 'water', label: 'water', charge: 0, multiplicity: 1, enabled: true,
    });
    expect(result.records[0].coords).toHaveLength(3);
    expect(result.records[0].coords[0]).toMatchObject({ element: 'O', x: 0, z: 0.1173 });
    expect(result.records[1]).toMatchObject({ id: 'hydroxide', charge: -1 });
  });

  it('derives a unique id from a repeated title', () => {
    const block = sdfBlock('water', [{ element: 'O', x: 0, y: 0, z: 0 }]);
    const result = parseDataset(`${block}${block}`, { format: 'sdf' });
    expect(result.records.map((record) => record.id)).toEqual(['water', 'water-2']);
  });

  it('refuses an SDF record that declares no atoms', () => {
    const text = 'empty\n  x\n\n  0  0  0  0  0  0            999 V2000\n$$$$\n';
    const result = parseDataset(text, { format: 'sdf' });
    expect(result.records).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/declares no atoms/);
  });

  it('refuses a record that ends before its declared atom block', () => {
    const text = [
      'truncated',
      '  NodeChem',
      '',
      '  3  0  0  0  0  0            999 V2000',
      atomLine('O', 0, 0, 0),
      atomLine('H', 0, 0, 1),
    ].join('\n');
    const result = parseDataset(text, { format: 'sdf' });
    expect(result.records).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/ends before atom 3/);
  });
});

describe('datasetImport — multi-XYZ', () => {
  it('reads one record per frame and uses the comment line as the label', () => {
    const text = [
      '2', 'frame one', 'O 0 0 0', 'H 0 0 0.97', '',
      '2', 'frame two', 'O 1 1 1', 'H 1 1 2.97', '',
    ].join('\n');
    const result = parseDataset(text, { filename: 'frames.xyz' });
    expect(result.format).toBe('xyz');
    expect(result.records).toHaveLength(2);
    expect(result.records[0].label).toBe('frame one');
    expect(result.records[0].id).toBe('frame-one');
    expect(result.records[1].coords[1]).toMatchObject({ element: 'H', z: 2.97 });
  });

  it('reports a truncated trailing frame instead of accepting it', () => {
    const text = '3\nbroken\nO 0 0 0\nH 0 0 1\n';
    const result = parseDataset(text, { format: 'xyz' });
    expect(result.records).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/ends early|atom line/);
  });
});

describe('datasetImport — CSV', () => {
  it('groups one-atom-per-row records by id', () => {
    const text = [
      'id,label,charge,multiplicity,element,x,y,z',
      'water,Water,0,1,O,0,0,0.1173',
      'water,Water,0,1,H,0,0.7572,-0.4692',
      'ammonia,Ammonia,0,1,N,0,0,0',
      'ammonia,Ammonia,0,1,H,0,0.94,0.33',
    ].join('\n');
    const result = parseDataset(text, { filename: 'family.csv' });
    expect(result.format).toBe('csv');
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ id: 'water', label: 'Water' });
    expect(result.records[0].coords).toHaveLength(2);
    expect(result.records[1].coords[0].element).toBe('N');
  });

  it('reads repeated xN,yN,zN columns as one record per row', () => {
    const text = [
      'id,label,charge,multiplicity,element1,x1,y1,z1,element2,x2,y2,z2',
      'pair,Pair,0,1,O,0,0,0,H,0,0,0.97',
    ].join('\n');
    const result = parseDataset(text, { format: 'csv' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe('pair');
    expect(result.records[0].coords).toEqual([
      { element: 'O', x: 0, y: 0, z: 0 },
      { element: 'H', x: 0, y: 0, z: 0.97 },
    ]);
  });

  it('refuses coordinates with no element column', () => {
    const text = 'id,label,charge,multiplicity,x,y,z\nwater,Water,0,1,0,0,0\n';
    const result = parseDataset(text, { format: 'csv' });
    expect(result.records).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/no element column/);
  });
});

describe('datasetImport — JSON', () => {
  it('accepts an array of records and a { records } wrapper', () => {
    const record = {
      id: 'water',
      label: 'Water',
      charge: 0,
      multiplicity: 1,
      coords: [{ element: 'O', x: 0, y: 0, z: 0 }],
    };
    const direct = parseDataset(JSON.stringify([record]), { format: 'json' });
    const wrapped = parseDataset(JSON.stringify({ records: [record] }), { filename: 'family.json' });
    expect(direct.records).toHaveLength(1);
    expect(wrapped.records).toHaveLength(1);
    expect(direct.records[0]).toEqual(wrapped.records[0]);
  });

  it('keeps an explicit enabled:false flag', () => {
    const result = parseDataset(JSON.stringify([{
      id: 'off', label: 'Disabled', charge: 0, multiplicity: 1, enabled: false,
      coords: [{ element: 'H', x: 0, y: 0, z: 0 }],
    }]), { format: 'json' });
    expect(result.records[0].enabled).toBe(false);
  });
});

describe('datasetImport — refusals and bounds', () => {
  it('refuses an empty file', () => {
    const result = parseDataset('   ', { filename: 'empty.sdf' });
    expect(result.records).toEqual([]);
    expect(result.errors[0]).toMatch(/empty/);
  });

  it('refuses a record with no coordinates instead of inventing a geometry', () => {
    const result = parseDataset(JSON.stringify([{ id: 'ghost', label: 'Ghost', coords: [] }]), { format: 'json' });
    expect(result.records).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/empty|no coordinates|at least one atom/i);
  });

  it('refuses an unknown format', () => {
    const result = parseDataset('not a dataset', { filename: 'mystery.bin' });
    expect(result.records).toEqual([]);
    expect(result.errors[0]).toMatch(/Could not tell the dataset format/);
  });

  it('refuses a file above the record limit', () => {
    const records = Array.from({ length: LIMITS.records + 1 }, (_, index) => ({
      id: `m${index + 1}`,
      label: `m${index + 1}`,
      coords: [{ element: 'H', x: 0, y: 0, z: 0 }],
    }));
    const result = parseDataset(JSON.stringify(records), { format: 'json' });
    expect(result.records).toEqual([]);
    expect(result.errors[0]).toContain(String(LIMITS.records));
  });

  it('skips a record above the atom limit and names it', () => {
    const tooMany = Array.from({ length: LIMITS.atoms + 1 }, () => ({ element: 'H', x: 0, y: 0, z: 0 }));
    const result = parseDataset(JSON.stringify([
      { id: 'huge', label: 'Huge', coords: tooMany },
      { id: 'ok', label: 'Ok', coords: [{ element: 'H', x: 0, y: 0, z: 0 }] },
    ]), { format: 'json' });
    expect(result.records.map((record) => record.id)).toEqual(['ok']);
    expect(result.errors.join(' ')).toMatch(new RegExp(`limit is ${LIMITS.atoms}`));
  });

  it('slugs a label into a task-id-safe record id', () => {
    expect(slugifyRecordId('Acetylacetone (enol)')).toBe('acetylacetone-enol');
    expect(slugifyRecordId('  ')).toBe('');
    expect(slugifyRecordId('2-methyl-1-propanol')).toBe('2-methyl-1-propanol');
  });
});
