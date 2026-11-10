import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCdxDocument, parseCdxRecords } from '../src/shared/cdx.js';
import { parseCdxmlRecords } from '../src/shared/cdxml.js';
import { parseStructureRecords } from '../src/shared/structureImport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'cdx');
const names = ['Aspirin', 'Caffeine', 'Ibuprofen'];

function fixture(name, extension) {
  return fs.readFileSync(path.join(fixtures, `${name}.${extension}`));
}

describe('ChemDraw binary .cdx reader (#221)', () => {
  it.each(names)('reads %s with the same atom and bond model as its CDXML twin', (name) => {
    const cdx = parseCdxRecords(fixture(name, 'cdx'), { name: `${name}.cdx` });
    const cdxml = parseCdxmlRecords(fixture(name, 'cdxml').toString('utf8'), { name: `${name}.cdxml` });
    expect(cdx).toHaveLength(1);
    expect(cdxml).toHaveLength(1);
    const binary = cdx[0];
    const xml = cdxml[0];
    expect(binary.error).toBeUndefined();
    expect(xml.error).toBeUndefined();
    expect(binary.atoms.map((atom) => atom.element)).toEqual(xml.atoms.map((atom) => atom.element));
    expect(binary.bonds).toEqual(xml.bonds);
    expect(binary.charge).toBe(xml.charge);
    expect(binary.geometry.dimension).toBe('2d');
    expect(binary.atoms).toHaveLength(xml.atoms.length);
    for (let index = 0; index < binary.atoms.length; index += 1) {
      // CDX stores signed 1/65536 page units; CDXML prints two decimals. The
      // reader must agree with the independent conversion to that rounding,
      // not to a made-up tolerance.
      expect(binary.atoms[index].x).toBeCloseTo(xml.atoms[index].x, 4);
      expect(binary.atoms[index].y).toBeCloseTo(xml.atoms[index].y, 4);
      expect(binary.atoms[index].z).toBe(0);
    }
  });

  it('recognises the header and refuses a file that is not a CDX', () => {
    const real = fixture('Aspirin', 'cdx');
    expect(isCdxDocument(real)).toBe(true);
    expect(isCdxDocument(Buffer.from('not a cdx'))).toBe(false);
    expect(() => parseCdxRecords(Buffer.from('not a cdx'))).toThrow(/VjCD0100/);
  });

  it('refuses a truncated stream instead of returning a partial fragment', () => {
    const real = fixture('Caffeine', 'cdx');
    // Cut inside the first fragment's node table; a reader that ignored the
    // end-of-file would return a molecule with missing atoms.
    expect(() => parseCdxRecords(real.subarray(0, Math.floor(real.length / 2))))
      .toThrow(/truncated/);
  });

  it('imports the binary file through the structure-import path as a 2D drawing', () => {
    const { format, records } = parseStructureRecords(fixture('Ibuprofen', 'cdx'), { filename: 'Ibuprofen.cdx' });
    expect(format).toBe('cdx');
    expect(records).toHaveLength(1);
    expect(records[0].atoms).toHaveLength(15);
    expect(records[0].bonds).toHaveLength(15);
    expect(records[0].format).toBe('cdx');
    expect(records[0].geometry).toMatchObject({ dimension: '2d' });
    expect(records[0].warnings.join(' ')).toMatch(/not a computed 3D structure/);
  });
});
