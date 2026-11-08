import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStructure, parseStructureRecords } from '../src/shared/structureImport.js';

/**
 * CDXML import (#120).
 *
 * The fixtures are hand-written CDXML — synthetic-but-valid documents, not
 * ChemDraw exports — so every assertion here is about the reader's contract,
 * not about one file ChemDraw happened to write.
 */

const read = (name) => readFileSync(`test/fixtures/structures/cdxml/${name}`, 'utf8');

describe('CDXML — one fragment, one record', () => {
  const file = read('benzene.cdxml');

  it('reads the fragment as a flat drawing with z = 0', () => {
    const { records } = parseStructureRecords(file, { filename: 'benzene.cdxml' });
    expect(records).toHaveLength(1);
    const [benzene] = records;
    expect(benzene.name).toBe('benzene');
    expect(benzene.atoms).toHaveLength(6);
    expect(benzene.atoms.every((atom) => atom.element === 'C')).toBe(true);
    expect(benzene.atoms.every((atom) => atom.z === 0)).toBe(true);
    expect(benzene.atoms[0]).toMatchObject({ x: 114.4, y: 100 });
  });

  it('marks the record as a 2D drawing, in the record and in the warnings', () => {
    const [benzene] = parseStructureRecords(file, { filename: 'benzene.cdxml' }).records;
    expect(benzene.geometry).toMatchObject({ dimension: '2d', source: 'cdxml-drawing' });
    const said = benzene.warnings.join(' ');
    expect(said).toContain('2D ChemDraw drawing');
    expect(said).toContain('not a computed 3D structure');
  });

  it('keeps Order="1.5" as aromatic instead of rounding it to single', () => {
    const [benzene] = parseStructureRecords(file, { filename: 'benzene.cdxml' }).records;
    expect(benzene.bonds.map((bond) => bond.order)).toEqual([1.5, 1.5, 1.5, 1.5, 1.5, 1.5]);
    expect(benzene.warnings.join(' ')).toContain('aromatic');
  });

  it('accepts the document without the extension, from its header', () => {
    const { format, records } = parseStructureRecords(file, { filename: 'pasted-text.txt' });
    expect(format).toBe('cdxml');
    expect(records).toHaveLength(1);
  });
});

describe('CDXML — fragments are records, not one merged molecule', () => {
  it('imports a two-fragment salt as two records', () => {
    const { records } = parseStructureRecords(read('salt.cdxml'), { filename: 'salt.cdxml' });
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.atoms.map((atom) => atom.element))).toEqual([['Na'], ['Cl']]);
    expect(records.map((record) => record.charge)).toEqual([1, -1]);
    expect(records.map((record) => record.name)).toEqual(['sodium cation', 'chloride anion']);
  });

  it('reads an unlabelled node as carbon', () => {
    const [butane] = parseStructureRecords(read('butane.cdxml'), { filename: 'butane.cdxml' }).records;
    expect(butane.atoms.map((atom) => atom.element)).toEqual(['C', 'C', 'C', 'C']);
    expect(butane.bonds.map((bond) => bond.order)).toEqual([1, 1, 1]);
  });

  it('reads an explicit charge label as the formal charge', () => {
    const [ammonium] = parseStructureRecords(read('ammonium.cdxml'), { filename: 'ammonium.cdxml' }).records;
    expect(ammonium.atoms.map((atom) => atom.element)).toEqual(['N', 'H', 'H', 'H', 'H']);
    expect(ammonium.charge).toBe(1);
    expect(ammonium.bonds).toHaveLength(4);
    // N + 4 H minus one electron is ten electrons: a singlet, not a warning.
    expect(ammonium.multiplicity).toBe(1);
  });

  it('names a fragment from the text block drawn beside it', () => {
    const [ethanol] = parseStructureRecords(read('graphics.cdxml'), { filename: 'graphics.cdxml' }).records;
    expect(ethanol.name).toBe('ethanol');
  });

  it('reads an explicit Element attribute and an isotope prefix when no label is drawn', () => {
    const file = `<?xml version="1.0"?>
<CDXML Name="atoms"><page id="1">
  <fragment id="2" Name="atoms">
    <n id="11" p="100 100" Element="8"/>
    <n id="12" p="114 100"><t id="13" p="114 100"><s>13</s><s>C</s></t></n>
    <b id="21" B="11" E="12" Order="1"/>
  </fragment>
</page></CDXML>`;
    const [record] = parseStructureRecords(file, { filename: 'atoms.cdxml' }).records;
    expect(record.atoms[0].element).toBe('O');
    expect(record.atoms[1]).toMatchObject({ element: 'C', isotope: 13 });
  });
});

describe('CDXML — stereo is a drawing cue, not a computed assignment', () => {
  const [wedge] = parseStructureRecords(read('wedge.cdxml'), { filename: 'wedge.cdxml' }).records;

  it('records the narrow end the file states', () => {
    const solid = wedge.bonds.find((bond) => bond.stereo?.kind === 'wedge');
    const hashed = wedge.bonds.find((bond) => bond.stereo?.kind === 'hash');
    expect(solid).toMatchObject({ a: 1, b: 2, order: 1, stereo: { kind: 'wedge', narrowEnd: 1 } });
    expect(hashed).toMatchObject({ a: 1, b: 4, order: 1, stereo: { kind: 'hash', narrowEnd: 1 } });
  });

  it('never upgrades a wedge into an R/S label or a chirality flag', () => {
    expect(wedge).not.toHaveProperty('chirality');
    for (const bond of wedge.bonds) {
      expect(bond).not.toHaveProperty('chirality');
      expect(bond).not.toHaveProperty('stereocenter');
      if (bond.stereo) expect(Object.keys(bond.stereo).sort()).toEqual(['kind', 'narrowEnd']);
    }
    expect(JSON.stringify(wedge.bonds)).not.toMatch(/"(?:r|s|cip|parity)"\s*:/i);
    expect(wedge.warnings.join(' ')).toContain('drawing cue');
    expect(wedge.warnings.join(' ')).toContain('no R/S assignment');
  });

  it('leaves the other bonds without a stereo field', () => {
    expect(wedge.bonds.filter((bond) => !bond.stereo)).toHaveLength(2);
  });
});

describe('CDXML — refusals name what they refuse', () => {
  it('refuses a .cdx by name and asks for CDXML', () => {
    // CDX is ChemDraw's binary form; only the extension is needed to refuse it.
    expect(() => parseStructureRecords('VjCD010007000000', { filename: 'sketch.cdx' }))
      .toThrow(/\.cdx/);
    expect(() => parseStructureRecords('VjCD010007000000', { filename: 'sketch.cdx' }))
      .toThrow(/CDXML/);
    expect(() => parseStructure('VjCD010007000000', { filename: 'sketch.cdx' }))
      .toThrow(/save it as CDXML/);
  });

  it('refuses an unrecognised atom label by naming it, instead of calling it carbon', () => {
    const { records } = parseStructureRecords(read('refuse-label.cdxml'), { filename: 'refuse-label.cdxml' });
    expect(records[0].error).toContain('Fragment 1');
    expect(records[0].error).toContain('CO2H');
    expect(records[0].error).toContain('cannot reduce to one element');
  });

  it('refuses a bond that points at a node the fragment does not own', () => {
    const { records } = parseStructureRecords(read('cross-fragment-bond.cdxml'), { filename: 'cross-fragment-bond.cdxml' });
    expect(records[0].error).toContain('Fragment 1');
    expect(records[0].error).toContain('belongs to fragment 2');
    expect(records[0].error).toContain('may not leave its fragment');
    // The other fragment is unaffected.
    expect(records[1].atoms.map((atom) => atom.element)).toEqual(['Cl', 'C']);
  });

  it('names the non-molecule graphics it ignored', () => {
    const [ethanol] = parseStructureRecords(read('graphics.cdxml'), { filename: 'graphics.cdxml' }).records;
    const said = ethanol.warnings.join(' ');
    expect(said).toContain('Ignored non-molecule elements');
    expect(said).toContain('arrow (2)');
    expect(said).toContain('curve (1)');
  });

  it('refuses a document with no fragment', () => {
    const empty = '<?xml version="1.0"?><CDXML Name="empty"><page id="1"/></CDXML>';
    expect(() => parseStructureRecords(empty, { filename: 'empty.cdxml' })).toThrow(/no <fragment>/);
  });

  it('refuses text that only claims to be CDXML', () => {
    expect(() => parseStructureRecords('<html><body>not a drawing</body></html>', { filename: 'x.cdxml' }))
      .toThrow(/not a CDXML document/);
  });
});

describe('CDXML — the single-structure path', () => {
  it('loads fragment 1 and says how many more the drawing holds', () => {
    const first = parseStructure(read('salt.cdxml'), { filename: 'salt.cdxml' });
    expect(first.format).toBe('cdxml');
    expect(first.name).toBe('sodium cation');
    expect(first.atoms[0].element).toBe('Na');
    expect(first.geometry.dimension).toBe('2d');
    expect(first.warnings.join(' ')).toContain('2 fragments; fragment 1 is loaded');
  });

  it('throws the fragment error rather than returning a half molecule', () => {
    expect(() => parseStructure(read('refuse-label.cdxml'), { filename: 'refuse-label.cdxml' }))
      .toThrow(/CO2H/);
  });
});
