import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseFchk } from '../src/shared/fchk.js';
import { convertFchk } from '../src/shared/converters/index.js';
import { moldenFromFchk, writeMolden, shellsFromFchk } from '../src/shared/converters/molden.js';
import { orbitalGap } from '../src/shared/wavefunction.js';

/**
 * The Molden writer, tested against a real Gaussian 16 checkpoint.
 *
 * The fixture is a complete fchk (10 C + 10 H, STO-3G, 60 basis functions), so
 * the test exercises the real layout: 30 shells, ten of them `sp`, 90
 * primitives and 3 600 MO coefficients.
 *
 * The file written here was also read back by **iodata** (qc-iodata 1.0.1), an
 * independent Molden implementation: 60 basis functions, 60 orbitals, MO
 * energies within 5e-7 Eh and coefficients within 5e-9 of the checkpoint. That
 * check needs Python, so it is not part of this suite — the assertions below
 * pin the same numbers as constants instead.
 */
const FCHK = readFileSync('test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk', 'utf8');
const parsed = parseFchk(FCHK);

/** Minimal spec-derived reader, written for this test — it shares no code with the writer. */
function readMolden(text) {
  const lines = text.split('\n');
  const result = { atoms: [], shells: [], orbitals: [], markers: [] };
  let section = '';
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      section = line.toLowerCase();
      if (section === '[5d]' || section === '[7f]' || section === '[9g]') result.markers.push(section);
      continue;
    }
    if (section === '[atoms] angs' && line) {
      const [element, index, atomicNumber, x, y, z] = line.split(/\s+/);
      result.atoms.push({
        element, index: Number(index), atomicNumber: Number(atomicNumber), x: Number(x), y: Number(y), z: Number(z),
      });
    } else if (section === '[gto]') {
      if (!line) { current = null; continue; }
      const words = line.split(/\s+/);
      if (/^\d+$/.test(words[0])) { current = { atom: Number(words[0]), shells: [] }; result.shells.push(current); continue; }
      if (!current) continue;
      // A shell header is `label nprim 1.00`; a primitive line is `exp coef…`.
      if (/^[a-z]+$/i.test(words[0])) {
        current.shells.push({ label: words[0], primitives: [] });
      } else {
        const shell = current.shells[current.shells.length - 1];
        shell.primitives.push({ exponent: Number(words[0]), coefficients: words.slice(1).map(Number) });
      }
    } else if (section === '[mo]') {
      if (line.startsWith('Sym=')) { current = { sym: line.split('=')[1].trim(), coefficients: [] }; result.orbitals.push(current); continue; }
      if (!current) continue;
      if (line.startsWith('Ene=')) current.energy = Number(line.split('=')[1]);
      else if (line.startsWith('Spin=')) current.spin = line.split('=')[1].trim();
      else if (line.startsWith('Occup=')) current.occupation = Number(line.split('=')[1]);
      else if (line) {
        const [index, value] = line.split(/\s+/);
        current.coefficients[Number(index) - 1] = Number(value);
      }
    }
  }
  return result;
}

describe('fchk basis and orbital fields (#111)', () => {
  it('reads the shell table, the primitives and the MO coefficients', () => {
    expect(parsed.shellTypes).toHaveLength(30);
    expect(parsed.primitivesPerShell.reduce((sum, value) => sum + value, 0)).toBe(90);
    expect(parsed.primitiveExponents).toHaveLength(90);
    expect(parsed.contractionCoefficients).toHaveLength(90);
    expect(parsed.alphaMOCoefficients).toHaveLength(3600);
    expect(parsed.spContractionCoefficients).toHaveLength(90);
    expect(parsed.numberOfBasisFunctions).toBe(60);
    expect(parsed.shellTypes.filter((type) => type === -1)).toHaveLength(10);
  });

  it('now reads the orbital energies from a real Gaussian fchk', () => {
    // Gaussian writes `Alpha Orbital Energies`; the reader used to look for
    // `Orbital Energies` and silently report the field as missing.
    expect(parsed.orbitalEnergies).toHaveLength(60);
    expect(parsed.orbitalEnergies[0]).toBeCloseTo(-10.0202201, 7);
    expect(parsed.orbitalEnergies[59]).toBeCloseTo(0.79456469, 8);
    const gap = orbitalGap(parsed);
    expect(gap.ok).toBe(true);
    expect(gap.homo.energyHartree).toBeCloseTo(parsed.orbitalEnergies[34], 9);
    expect(gap.lumo.energyHartree).toBeCloseTo(parsed.orbitalEnergies[35], 9);
    expect(gap.occupiedCount).toBe(35);
  });
});

describe('Molden writer', () => {
  const written = moldenFromFchk(parsed, { title: 'dvb' });
  const read = readMolden(written.text);

  it('writes the format header, the atoms and the basis', () => {
    expect(written.text.startsWith('[Molden Format]')).toBe(true);
    expect(written.text).toContain('[Atoms] Angs');
    expect(written.text).toContain('[GTO]');
    expect(written.text).toContain('[MO]');
    expect(read.atoms).toHaveLength(20);
    expect(read.atoms[0]).toMatchObject({ element: 'C', atomicNumber: 6 });
    // Coordinates are Angstrom: the fchk stores Bohr, and 2.32642 bohr is 1.23109 Å.
    expect(read.atoms[0].x).toBeCloseTo(1.231088, 5);
    expect(written.basisFunctions).toBe(60);
    expect(written.orbitals).toBe(60);
  });

  it('splits an sp shell into an s and a p shell and keeps every primitive', () => {
    const carbon = read.shells[0];
    expect(carbon.atom).toBe(1);
    expect(carbon.shells.map((shell) => shell.label)).toEqual(['s', 's', 'p']);
    const totalPrimitives = read.shells
      .flatMap((atom) => atom.shells)
      .reduce((sum, shell) => sum + shell.primitives.length, 0);
    expect(totalPrimitives).toBe(120);
    // 30 fchk shells, ten of them sp → 40 Molden shells.
    expect(read.shells.flatMap((atom) => atom.shells)).toHaveLength(40);
  });

  it('writes every MO with its energy, spin and occupation', () => {
    expect(read.orbitals).toHaveLength(60);
    expect(read.orbitals[0].spin).toBe('Alpha');
    expect(read.orbitals[0].energy).toBeCloseTo(-10.020220, 5);
    expect(read.orbitals[0].occupation).toBe(2);
    expect(read.orbitals[35].occupation).toBe(0);
    expect(read.orbitals.reduce((sum, orbital) => sum + orbital.occupation, 0)).toBe(70);
    for (const orbital of read.orbitals) expect(orbital.coefficients).toHaveLength(60);
  });

  it('writes the coefficients the checkpoint holds, in the same order', () => {
    const nbf = 60;
    const first = read.orbitals[0].coefficients;
    const source = parsed.alphaMOCoefficients.slice(0, nbf);
    for (let index = 0; index < nbf; index += 1) {
      expect(first[index]).toBeCloseTo(source[index], 8);
    }
    // The vectors must stay normalised to what the checkpoint said.
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    const sourceNorm = Math.sqrt(source.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(sourceNorm, 6);
  });

  it('marks spherical shells only when the checkpoint uses them', () => {
    expect(read.markers).toEqual([]);
    const withPure = writeMolden({
      atoms: [{ element: 'O', x: 0, y: 0, z: 0 }],
      shells: [{ atom: 1, type: -2, primitives: [{ exponent: 0.8, s: 1 }] }],
      orbitals: [{ energy: -0.5, occupation: 2, spin: 'Alpha', coefficients: [1, 0, 0, 0, 0] }],
    });
    expect(withPure).toContain('[5D]');
  });

  it('refuses what it cannot write faithfully', () => {
    const atoms = [{ element: 'O', x: 0, y: 0, z: 0 }];
    expect(() => writeMolden({ atoms, shells: [], orbitals: [] })).toThrow(/needs basis functions/);
    expect(() => writeMolden({ atoms, shells: [{ atom: 1, type: 0, primitives: [{ exponent: 1, s: 1 }] }], orbitals: [] }))
      .toThrow(/needs molecular orbitals/);
    expect(() => writeMolden({
      atoms,
      shells: [{ atom: 1, type: 0, primitives: [{ exponent: 1, s: 1 }] }],
      orbitals: [{ energy: 0, occupation: 2, spin: 'Alpha', coefficients: [1, 2] }],
    })).toThrow(/carries 2 coefficients/);
    expect(() => writeMolden({
      atoms,
      shells: [{ atom: 1, type: 5, primitives: [{ exponent: 1, s: 1 }] }],
      orbitals: [{ energy: 0, occupation: 2, spin: 'Alpha', coefficients: [1] }],
    })).toThrow(/cannot express shell type 5/);
    expect(() => writeMolden({
      atoms,
      shells: [
        { atom: 1, type: 2, primitives: [{ exponent: 1, s: 1 }] },
        { atom: 1, type: -2, primitives: [{ exponent: 1, s: 1 }] },
      ],
      orbitals: [{ energy: 0, occupation: 2, spin: 'Alpha', coefficients: new Array(11).fill(0) }],
    })).toThrow(/mixes spherical and Cartesian/);
  });

  it('refuses a checkpoint without the basis instead of writing empty orbitals', () => {
    const noBasis = { ...parsed };
    delete noBasis.shellTypes;
    expect(() => shellsFromFchk(noBasis)).toThrow(/no shell table/);
    expect(() => moldenFromFchk(noBasis)).toThrow(/no shell table/);
    const noMo = { ...parsed };
    delete noMo.alphaMOCoefficients;
    expect(() => moldenFromFchk(noMo)).toThrow(/no MO coefficients/);
  });

  it('refuses to write an error-terminated checkpoint as a finished wavefunction (#244)', () => {
    // The fixture's Job Status is 1; a job killed in Link 9999 leaves the same
    // basis and MO blocks but no completed result, so Molden is not written.
    const failed = parseFchk(FCHK.replace(/^Job Status\s+I\s+1$/m, 'Job Status                                 I                3'));
    expect(() => moldenFromFchk(failed)).toThrow(/Job Status 3 \(error termination in Link 9999\)/);
    expect(() => convertFchk(failed, 'molden')).toThrow(/Job Status 3/);
  });
});

describe('convertFchk', () => {
  it('converts a checkpoint to Molden and says what it wrote', () => {
    const converted = convertFchk(parsed, 'molden', { title: 'dvb' });
    expect(converted.format).toBe('molden');
    expect(converted.extension).toBe('molden');
    expect(converted.text).toContain('[Molden Format]');
    expect(converted.notes.join(' ')).toMatch(/60 basis function/);
    expect(converted.notes.join(' ')).toMatch(/atomic units/);
  });

  it('refuses to build Molden from a log', async () => {
    const { convertParsed } = await import('../src/shared/converters/index.js');
    expect(() => convertParsed({ finalGeometry: [] }, 'molden')).toThrow(/needs basis functions and MO coefficients/);
  });

  it('refuses a log format for a checkpoint', () => {
    expect(() => convertFchk(parsed, 'xyz')).toThrow(/not written from a checkpoint/);
  });
});
