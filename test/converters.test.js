import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONVERT_FORMATS,
  ConversionError,
  convertParsed,
  convertStructure,
  framesFromParsed,
  formatById,
  spectrumFromParsed,
} from '../src/shared/converters/index.js';
import { writeExtxyz } from '../src/shared/converters/extxyz.js';
import { writeJcampDx } from '../src/shared/converters/jcampDx.js';
import { writeSdf } from '../src/shared/converters/sdf.js';
import { writeXyz } from '../src/shared/converters/xyz.js';
import { HARTREE_TO_EV } from '../src/shared/orbitals.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseStructureRecords } from '../src/shared/structureImport.js';

const real = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');
const structure = (name) => readFileSync(`test/fixtures/structures/${name}`, 'utf8');

/** Minimal extxyz reader: enough to prove the writer produced legal frames. */
function readExtxyz(text) {
  const lines = text.trimEnd().split('\n');
  const frames = [];
  let index = 0;
  while (index < lines.length) {
    const count = Number(lines[index]);
    const info = Object.fromEntries(
      [...lines[index + 1].matchAll(/(\w+)=("[^"]*"|\S+)/g)].map((match) => [match[1], match[2].replace(/"/g, '')]),
    );
    const atoms = lines.slice(index + 2, index + 2 + count).map((line) => {
      const [element, x, y, z] = line.trim().split(/\s+/);
      return { element, x: Number(x), y: Number(y), z: Number(z) };
    });
    frames.push({ atoms, info });
    index += 2 + count;
  }
  return frames;
}

const optimisation = parseGaussianOutput(real('g16-dvb-gopt.out'));

describe('extxyz — trajectory interchange', () => {
  const text = writeExtxyz(framesFromParsed(optimisation).frames);
  const frames = readExtxyz(text);

  it('writes every frame the log printed', () => {
    expect(frames).toHaveLength(6);
    expect(frames.every((frame) => frame.atoms.length === 18)).toBe(true);
  });

  it('declares its columns so a reader does not guess', () => {
    expect(text).toContain('Properties=species:S:1:pos:R:3');
    expect(text).toContain('pbc="F F F"');
  });

  it('writes energy in eV for ASE and keeps the hartree value', () => {
    const last = frames[frames.length - 1].info;
    expect(Number(last.energy_hartree)).toBeCloseTo(-382.308266602, 6);
    expect(Number(last.energy)).toBeCloseTo(-382.308266602 * HARTREE_TO_EV, 4);
  });

  it('omits the energy of a frame that never had one instead of writing zero', () => {
    // The first optimisation cycle prints a geometry before any SCF energy.
    expect(frames[0].info.energy).toBeUndefined();
    expect(frames[0].info.energy_hartree).toBeUndefined();
    expect(frames[0].info.step).toBe('1');
  });

  it('keeps the coordinates to the precision the log carried', () => {
    const source = optimisation.trajectory.steps[0].atoms[0];
    expect(frames[0].atoms[0].element).toBe(source.element);
    expect(frames[0].atoms[0].x).toBeCloseTo(source.x, 6);
    expect(frames[0].atoms[0].z).toBeCloseTo(source.z, 6);
  });
});

describe('plain xyz', () => {
  const text = writeXyz(framesFromParsed(optimisation).frames, { comment: 'DVB optimisation' });

  it('writes one block per frame with the atom count first', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('18');
    expect(lines[1]).toBe('DVB optimisation | step 1');
  });

  it('writes the same number of geometries as frames', () => {
    expect(text.trimEnd().split('\n').filter((line) => line === '18')).toHaveLength(6);
  });

  it('carries the energy in the comment, where a reader may ignore it', () => {
    expect(text).toContain('energy -382.30826660 Eh');
  });
});

describe('sdf — structure with a bond table', () => {
  const source = parseStructureRecords(structure('rdkit-noxide.mol2'), { filename: 'rdkit-noxide.mol2' }).records[0];

  it('round-trips atoms, bonds and aromatic order through our own reader', () => {
    const text = writeSdf({ atoms: source.atoms, bonds: source.bonds, title: 'n-oxide' });
    const back = parseStructureRecords(text, { filename: 'n-oxide.sdf' }).records[0];
    expect(back.atoms).toHaveLength(27);
    expect(back.bonds).toHaveLength(27);
    // MOL2 says 1.5, V2000 says 4, and the importer maps it back to 1.5.
    expect(back.bonds.some((bond) => bond.order === 1.5)).toBe(true);
  });

  it('states the atom and bond counts where the format expects them', () => {
    const text = writeSdf({ atoms: source.atoms, bonds: source.bonds });
    const counts = text.split('\n')[3];
    expect(counts.slice(0, 3).trim()).toBe('27');
    expect(counts.slice(3, 6).trim()).toBe('27');
    expect(counts).toContain('V2000');
  });

  it('refuses more atoms than V2000 can hold', () => {
    const atoms = Array.from({ length: 1000 }, () => ({ element: 'C', x: 0, y: 0, z: 0 }));
    expect(() => writeSdf({ atoms })).toThrow(/999 atoms/);
  });

  it('refuses a bond that points outside the structure', () => {
    expect(() => writeSdf({ atoms: source.atoms, bonds: [{ a: 1, b: 999 }] })).toThrow(/outside|refers to atom/);
  });
});

describe('jcamp-dx — spectra as data', () => {
  const water = parseGaussianOutput(real('g16-h2o-raman.out'));

  it('writes the Raman activities with units in the header', () => {
    const converted = convertParsed(water, 'jcamp', { spectrum: 'raman', title: 'water' });
    expect(converted.text).toContain('##DATA TYPE=RAMAN SPECTRUM');
    expect(converted.text).toContain('##XUNITS=1/CM');
    expect(converted.text).toContain('##NPOINTS=3');
    expect(converted.text).toContain('11.4937');
    expect(converted.text).toContain('95.663');
    expect(converted.text).toContain('44.0813');
    expect(converted.text.trimEnd().endsWith('##END=')).toBe(true);
  });

  it('writes the IR intensities the normal-mode table carries', () => {
    const converted = convertParsed(water, 'jcamp', { spectrum: 'ir' });
    expect(converted.text).toContain('##DATA TYPE=INFRARED SPECTRUM');
    expect(converted.text).toContain('79.9529');
    expect(converted.text).toContain('0.0487');
    expect(converted.text).toContain('9.169');
  });

  it('broadens excited states for UV/Vis and says so', () => {
    const td = parseGaussianOutput(real('g16-dvb-td.out'));
    const converted = convertParsed(td, 'jcamp', { spectrum: 'uv' });
    expect(converted.text).toContain('##DATA TYPE=UV/VIS SPECTRUM');
    expect(converted.text).toContain('##XUNITS=NM');
    expect(converted.notes.join(' ')).toMatch(/FWHM/);
    const points = Number(converted.text.match(/##NPOINTS=(\d+)/)[1]);
    expect(points).toBe(240);
  });

  it('refuses a spectrum the run does not have', () => {
    const td = parseGaussianOutput(real('g16-dvb-td.out'));
    expect(() => spectrumFromParsed(td, 'raman')).toThrow(/no Raman table/);
    expect(() => convertParsed(water, 'jcamp', { spectrum: 'uv' })).toThrow(/no excited states/);
  });

  it('sorts the axis and refuses duplicate positions', () => {
    const text = writeJcampDx({
      title: 't', dataType: 'INFRARED SPECTRUM', xUnits: '1/CM', yUnits: 'ARBITRARY UNITS',
      points: [{ x: 3, y: 1 }, { x: 1, y: 2 }],
    });
    expect(text.indexOf('1, 2')).toBeLessThan(text.indexOf('3, 1'));
    expect(() => writeJcampDx({
      title: 't', dataType: 'INFRARED SPECTRUM', xUnits: '1/CM', yUnits: 'ARBITRARY UNITS',
      points: [{ x: 1, y: 1 }, { x: 1, y: 2 }],
    })).toThrow(/strictly increasing/);
  });
});

describe('the conversion surface', () => {
  it('names the formats it writes', () => {
    expect(CONVERT_FORMATS.map((entry) => entry.id)).toEqual(['extxyz', 'xyz', 'sdf', 'jcamp', 'molden']);
    expect(formatById('nope')).toBeNull();
  });

  it('says where the frames came from', () => {
    expect(framesFromParsed(optimisation)).toMatchObject({ source: 'trajectory' });
    const single = parseGaussianOutput(real('g16-dvb-sp.out'));
    expect(framesFromParsed(single).frames).toHaveLength(1);
    // A record with no `Standard orientation` block at all falls back to the
    // geometry it does carry, and names which one.
    const fallback = { geometry: { final: { atoms: [{ element: 'H', x: 0, y: 0, z: 0 }] } } };
    expect(framesFromParsed(fallback)).toMatchObject({ source: 'final-geometry' });
    expect(() => framesFromParsed({})).toThrow(/no geometry/);
  });

  it('refuses SDF for a log, because a log states no bonds', () => {
    expect(() => convertParsed(optimisation, 'sdf')).toThrow(/no bonds/);
  });

  it('refuses a format it does not write', () => {
    expect(() => convertParsed(optimisation, 'cif')).toThrow(/unknown format/);
    // Molden is a format the app writes, just not from a log.
    expect(() => convertParsed(optimisation, 'molden')).toThrow(/needs basis functions and MO coefficients/);
  });

  it('converts an imported structure without a parsed run', () => {
    const record = parseStructureRecords(structure('1crn.pdb'), { filename: '1crn.pdb' }).records[0];
    const converted = convertStructure({ atoms: record.atoms }, 'extxyz');
    expect(converted.text.startsWith('327\n')).toBe(true);
    expect(converted.notes[0]).toMatch(/1 frame/);
  });

  it('never writes a spectrum for a structure', () => {
    expect(() => convertStructure({ atoms: [{ element: 'H', x: 0, y: 0, z: 0 }] }, 'jcamp')).toThrow(/spectrum format/);
  });
});

describe('errors say what is missing rather than writing a plausible file', () => {
  it('refuses an empty frame list', () => {
    expect(() => writeXyz([])).toThrow(ConversionError);
    expect(() => writeExtxyz([])).toThrow(ConversionError);
  });

  it('refuses an atom without an element', () => {
    expect(() => writeXyz([{ atoms: [{ x: 0, y: 0, z: 0 }] }])).toThrow(/no element symbol/);
  });

  it('refuses a null coordinate instead of writing 0', () => {
    expect(() => writeXyz([{ atoms: [{ element: 'C', x: null, y: 0, z: 0 }] }])).toThrow(/not a finite number/);
  });
});
