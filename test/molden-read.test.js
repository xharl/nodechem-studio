import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BOHR_TO_ANGSTROM } from '../src/shared/cubeFile.js';
import { moldenFromFchk, shellsFromFchk, writeMolden } from '../src/shared/converters/molden.js';
import { MoldenFormatError, parseMolden } from '../src/shared/molden.js';
import {
  detectWavefunctionFormat,
  orbitalGap,
  readWavefunction,
  wavefunctionRecord,
} from '../src/shared/wavefunction.js';

/**
 * The Molden reader, against hand-written fixtures and this repository's own
 * writer.
 *
 * Every fixture in `test/fixtures/molden/` is synthetic (see its README). The
 * round-trip test writes a file with `moldenFromFchk`, reads it back and
 * compares the numbers; no fixture claims to come from ORCA, Psi4 or any other
 * program.
 */

const SPHERICAL = readFileSync('test/fixtures/molden/water-spherical-d.molden', 'utf8');
const CARTESIAN_AU = readFileSync('test/fixtures/molden/water-cartesian-au.molden', 'utf8');

/** A minimal one-atom file, used to isolate one marker or one shell. */
function markerFixture(marker, shellLines, nbf, { extraSections = [] } = {}) {
  const lines = [
    '[Molden Format]',
    '[Atoms] Angs',
    'O 1 8 0.00000000 0.00000000 0.00000000',
  ];
  if (marker) lines.push(marker);
  lines.push(...extraSections);
  lines.push('[GTO]', '1 0', ...shellLines);
  lines.push('[MO]', ' Sym= A1', ' Ene= -0.500000', ' Spin= Alpha', ' Occup= 2.0000');
  for (let index = 1; index <= nbf; index += 1) {
    lines.push(`  ${index} ${index === 1 ? '1.00000000' : '0.00000000'}`);
  }
  return `${lines.join('\n')}\n`;
}

function minimalS({ energy = '-1.0', occupation = '2.0', spin = 'Alpha', coefficients = ['  1 1.0'] } = {}) {
  return [
    '[Molden Format]',
    '[Atoms] Angs',
    'H 1 1 0.0 0.0 0.0',
    '[GTO]',
    '1 0',
    's 1 1.00',
    '  0.50000000 1.00000000',
    '[MO]',
    ' Sym= A1',
    ...(energy === null ? [] : [` Ene= ${energy}`]),
    ...(spin === null ? [] : [` Spin= ${spin}`]),
    ...(occupation === null ? [] : [` Occup= ${occupation}`]),
    ...coefficients,
  ].join('\n') + '\n';
}

/** A synthetic checkpoint whose only job is to feed the writer. */
function syntheticFchk() {
  const atoms = [
    { element: 'O', x: 0, y: 0, z: 0.1 },
    { element: 'H', x: 0.757, y: 0.586, z: 0 },
    { element: 'H', x: -0.757, y: 0.586, z: 0 },
  ];
  const shells = [
    {
      atom: 1,
      type: 0,
      primitives: [
        { exponent: 130.70932, s: 0.15432897 },
        { exponent: 23.94538, s: 0.53532814 },
        { exponent: 6.44314, s: 0.44463454 },
      ],
    },
    {
      atom: 1,
      type: -1,
      primitives: [
        { exponent: 0.7, s: -0.09996723, p: 0.15591627 },
        { exponent: 0.3, s: 0.39951283, p: 0.60768372 },
        { exponent: 0.15, s: 0.70011547, p: 0.39195739 },
      ],
    },
    { atom: 1, type: -2, primitives: [{ exponent: 0.8, s: 1 }] },
    {
      atom: 2,
      type: 0,
      primitives: [
        { exponent: 3.42525091, s: 0.15432897 },
        { exponent: 0.62391373, s: 0.53532814 },
      ],
    },
    {
      atom: 3,
      type: 0,
      primitives: [
        { exponent: 3.42525091, s: 0.15432897 },
        { exponent: 0.62391373, s: 0.53532814 },
      ],
    },
  ];
  const nbf = 12;
  const orbitals = [
    { energy: -20.551234, coefficients: Array.from({ length: nbf }, (_, i) => ((i + 1) * 0.01) - 0.05) },
    { energy: -1.234567, coefficients: Array.from({ length: nbf }, (_, i) => ((i + 2) * 0.02) - 0.1) },
    { energy: -0.56789, coefficients: Array.from({ length: nbf }, (_, i) => ((i + 3) * 0.03) - 0.2) },
    { energy: 0.123456, coefficients: Array.from({ length: nbf }, (_, i) => ((i + 4) * 0.04) - 0.3) },
  ];

  const primitiveExponents = [];
  const contractionCoefficients = [];
  const spContractionCoefficients = [];
  for (const shell of shells) {
    for (const primitive of shell.primitives) {
      primitiveExponents.push(primitive.exponent);
      contractionCoefficients.push(primitive.s);
      spContractionCoefficients.push(shell.type === -1 ? primitive.p : 0);
    }
  }

  return {
    numberOfAtoms: atoms.length,
    numberOfBasisFunctions: nbf,
    numberOfElectrons: 6,
    charge: 0,
    multiplicity: 1,
    numberOfAlphaElectrons: 3,
    numberOfBetaElectrons: 3,
    atomicNumbers: [8, 1, 1],
    coordinatesBohr: atoms.flatMap((atom) => [
      atom.x / BOHR_TO_ANGSTROM,
      atom.y / BOHR_TO_ANGSTROM,
      atom.z / BOHR_TO_ANGSTROM,
    ]),
    shellTypes: shells.map((shell) => shell.type),
    primitivesPerShell: shells.map((shell) => shell.primitives.length),
    shellToAtomMap: shells.map((shell) => shell.atom),
    primitiveExponents,
    contractionCoefficients,
    spContractionCoefficients,
    alphaMOCoefficients: orbitals.flatMap((orbital) => orbital.coefficients),
    orbitalEnergies: orbitals.map((orbital) => orbital.energy),
  };
}

describe('Molden format detection and the import path', () => {
  it('detects a Molden file by its header', () => {
    expect(detectWavefunctionFormat(SPHERICAL)).toBe('molden');
    expect(detectWavefunctionFormat(`\uFEFF\n  [Molden Format]\n[Atoms] Angs\nH 1 1 0 0 0\n`)).toBe('molden');
  });

  it('returns the same {kind, parsed} shape as a checkpoint', () => {
    const { kind, parsed } = readWavefunction(SPHERICAL, { filename: 'water.molden' });
    expect(kind).toBe('molden');
    expect(parsed.format).toBe('molden');
    expect(parsed.numberOfBasisFunctions).toBe(12);
    expect(parsed.found).toContain('alphaMOCoefficients');
  });

  it('reaches the run-record summary block without a second code path', () => {
    const record = wavefunctionRecord([{ text: SPHERICAL, filename: 'water.molden' }]);
    expect(record.artifacts[0]).toMatchObject({ kind: 'molden', file: 'water.molden' });
    expect(record.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fchk.format).toBe('molden');
    expect(record.fchk.orbitalGap.ok).toBe(true);
    expect(record.fchk.orbitalGap.gapHartree).toBeCloseTo(20.67469, 5);
    expect(record.fchk.spin).toMatchObject({ ok: true, multiplicity: 1, unpairedElectrons: 0 });
    // Molden carries no partial charges, so the charge check says it cannot
    // answer instead of reporting a zero.
    expect(record.fchk.chargeSanity).toMatchObject({ ok: false });
    expect(record.cube).toBeUndefined();
  });

  it('does not steal a cube or a checkpoint', () => {
    expect(detectWavefunctionFormat('cube title\ncomment\n1 0 0 0\n8 8 0 0 0\n-1 1.0 1 0 0\n-1 1.0 0 1 0\n-1 1.0 0 0 1\n1\n')).toBe('cube');
    expect(detectWavefunctionFormat('Number of atoms I 1\n')).toBe('fchk');
  });
});

describe('Molden reader: atoms and title', () => {
  const parsed = parseMolden(SPHERICAL);

  it('reads the title, the atoms and the Angstrom unit', () => {
    expect(parsed.title).toBe('synthetic water with a spherical d shell');
    expect(parsed.numberOfAtoms).toBe(3);
    expect(parsed.units).toMatchObject({ coordinates: 'angstrom', source: 'angs' });
    expect(parsed.atoms[0]).toMatchObject({ atomicNumber: 8, element: 'O', x: 0, y: 0, z: 0 });
    expect(parsed.atoms[1]).toMatchObject({ atomicNumber: 1, element: 'H' });
    expect(parsed.atoms[1].x).toBeCloseTo(0.757, 8);
    expect(parsed.atoms[1].y).toBeCloseTo(0.586, 8);
    expect(parsed.atomicNumbers).toEqual([8, 1, 1]);
  });

  it('takes the title from a comment line when there is no [Title] section', () => {
    expect(parseMolden(CARTESIAN_AU).title).toBe('synthetic water in atomic units');
  });

  it('converts AU coordinates once and keeps coordinatesBohr in bohr', () => {
    const parsedAu = parseMolden(CARTESIAN_AU);
    expect(parsedAu.units.source).toBe('bohr');
    expect(parsedAu.atoms[1].x).toBeCloseTo(1.43 * BOHR_TO_ANGSTROM, 10);
    expect(parsedAu.atoms[1].y).toBeCloseTo(1.107 * BOHR_TO_ANGSTROM, 10);
    expect(parsedAu.coordinatesBohr[3]).toBeCloseTo(1.43, 10);
  });
});

describe('Molden reader: basis and markers', () => {
  it('reads the split s/p form and the combined sp form to the same sp shell', () => {
    const parsed = parseMolden(SPHERICAL);
    expect(parsed.shellTypes).toEqual([0, -1, -2, 0, 0]);
    expect(parsed.primitivesPerShell).toEqual([3, 3, 1, 2, 2]);
    expect(parsed.shellToAtomMap).toEqual([1, 1, 1, 2, 3]);
    const sp = parsed.shells[1];
    expect(sp).toMatchObject({ atom: 1, type: -1, label: 'sp' });
    expect(sp.primitives).toHaveLength(3);
    expect(sp.primitives[0].exponent).toBeCloseTo(0.7, 10);
    expect(sp.primitives[0].s).toBeCloseTo(-0.09996723, 10);
    expect(sp.primitives[0].p).toBeCloseTo(0.15591627, 10);
    expect(parsed.numberOfBasisFunctions).toBe(12);
    expect(parsed.spContractionCoefficients).toHaveLength(11);
  });

  it('recombines an s shell followed by a p shell with the same exponents', () => {
    const atomic = {
      element: 'O', x: 0, y: 0, z: 0,
    };
    const text = writeMolden({
      atoms: [atomic],
      shells: [{
        atom: 1,
        type: -1,
        primitives: [
          { exponent: 0.7, s: 0.1, p: 0.2 },
          { exponent: 0.3, s: 0.3, p: 0.4 },
        ],
      }],
      orbitals: [{ energy: -0.5, occupation: 2, spin: 'Alpha', coefficients: [1, 0, 0, 0] }],
    });
    const parsed = parseMolden(text);
    expect(parsed.shellTypes).toEqual([-1]);
    expect(parsed.primitivesPerShell).toEqual([2]);
    expect(parsed.shells[0].primitives[0]).toMatchObject({ exponent: 0.7, s: 0.1, p: 0.2 });
    expect(parsed.numberOfBasisFunctions).toBe(4);
  });

  it('honours [5D] and the compound [5D10F] marker', () => {
    const sphericalD = parseMolden(markerFixture('[5D]', ['d 1 1.00', '  0.8 1.0'], 5));
    expect(sphericalD.shellTypes).toEqual([-2]);
    expect(sphericalD.spherical).toMatchObject({ d: true, f: true, g: false });

    const mixed = parseMolden(markerFixture('[5D10F]', [
      'd 1 1.00', '  0.8 1.0',
      'f 1 1.00', '  1.2 1.0',
    ], 15));
    expect(mixed.shellTypes).toEqual([-2, 3]);
    expect(mixed.spherical).toMatchObject({ d: true, f: false, g: false });
    expect(mixed.numberOfBasisFunctions).toBe(15);
  });

  it('honours [7F], [5D7F] and [9G]', () => {
    // The specification defines [5D] as five d *and* seven f functions.
    const sphericalDF = parseMolden(markerFixture('[5D]', [
      'd 1 1.00', '  0.8 1.0',
      'f 1 1.00', '  1.2 1.0',
    ], 12));
    expect(sphericalDF.shellTypes).toEqual([-2, -3]);
    expect(sphericalDF.spherical).toMatchObject({ d: true, f: true, g: false });

    const cartesianDSphericalF = parseMolden(markerFixture('[7F]', [
      'd 1 1.00', '  0.8 1.0',
      'f 1 1.00', '  1.2 1.0',
    ], 13));
    expect(cartesianDSphericalF.shellTypes).toEqual([2, -3]);
    expect(cartesianDSphericalF.spherical).toMatchObject({ d: false, f: true, g: false });

    const bothSpherical = parseMolden(markerFixture('[5D7F]', [
      'd 1 1.00', '  0.8 1.0',
      'f 1 1.00', '  1.2 1.0',
    ], 12));
    expect(bothSpherical.shellTypes).toEqual([-2, -3]);

    const sphericalG = parseMolden(markerFixture('[9G]', ['g 1 1.00', '  1.5 1.0'], 9));
    expect(sphericalG.shellTypes).toEqual([-4]);
    expect(sphericalG.spherical).toMatchObject({ d: false, f: false, g: true });
  });

  it('treats an absent marker as Cartesian and accepts an explicit [6D]', () => {
    const defaultCartesian = parseMolden(markerFixture('', ['d 1 1.00', '  0.8 1.0'], 6));
    expect(defaultCartesian.shellTypes).toEqual([2]);
    expect(defaultCartesian.spherical.d).toBe(false);

    const explicitCartesian = parseMolden(markerFixture('[6D]', ['d 1 1.00', '  0.8 1.0'], 6));
    expect(explicitCartesian.shellTypes).toEqual([2]);
  });
});

describe('Molden reader: molecular orbitals', () => {
  const parsed = parseMolden(SPHERICAL);

  it('reads energy, spin, occupation, symmetry and coefficients', () => {
    expect(parsed.orbitals).toHaveLength(2);
    expect(parsed.orbitals[0]).toMatchObject({ symmetry: 'A1', spin: 'Alpha', occupation: 2 });
    expect(parsed.orbitals[0].energy).toBeCloseTo(-20.551234, 8);
    expect(parsed.orbitals[0].coefficients).toHaveLength(12);
    expect(parsed.orbitals[0].coefficients[1]).toBeCloseTo(0.026, 10);
    expect(parsed.orbitals[1].occupation).toBe(0);
    expect(parsed.alphaMOCoefficients).toHaveLength(24);
    expect(parsed.orbitalEnergies).toEqual([-20.551234, 0.123456]);
  });

  it('derives the alpha/beta counts a checkpoint would have carried', () => {
    expect(parsed.numberOfAlphaElectrons).toBe(1);
    expect(parsed.numberOfBetaElectrons).toBe(1);
    expect(parsed.numberOfElectrons).toBe(2);
  });

  it('works in the existing orbital-gap view with no branch', () => {
    const gap = orbitalGap(parsed);
    expect(gap.ok).toBe(true);
    expect(gap.homo.index).toBe(0);
    expect(gap.lumo.index).toBe(1);
    expect(gap.homo.energyHartree).toBeCloseTo(-20.551234, 8);
    expect(gap.gapHartree).toBeCloseTo(20.67469, 5);
  });

  it('separates an unrestricted alpha and beta manifold', () => {
    const text = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[GTO]',
      '1 0',
      's 1 1.00',
      '  0.5 1.0',
      '[MO]',
      ' Sym= A1',
      ' Ene= -0.6',
      ' Spin= Alpha',
      ' Occup= 1.0',
      '  1 1.0',
      ' Sym= A1',
      ' Ene= -0.5',
      ' Spin= Beta',
      ' Occup= 1.0',
      '  1 1.0',
    ].join('\n');
    const uhf = parseMolden(text);
    expect(uhf.alphaMOCoefficients).toEqual([1]);
    expect(uhf.betaMOCoefficients).toEqual([1]);
    expect(uhf.orbitalEnergies).toEqual([-0.6]);
    expect(uhf.orbitalEnergiesBeta).toEqual([-0.5]);
    expect(uhf.numberOfAlphaElectrons).toBe(1);
    expect(uhf.numberOfBetaElectrons).toBe(1);
    expect(uhf.numberOfElectrons).toBe(2);
  });
});

describe('Molden round-trip through this repository\'s writer', () => {
  const fchk = syntheticFchk();
  const written = moldenFromFchk(fchk, { title: 'synthetic round-trip' });
  const parsed = parseMolden(written.text);

  it('reads back the same atoms', () => {
    expect(parsed.title).toBe('synthetic round-trip');
    expect(parsed.numberOfAtoms).toBe(fchk.numberOfAtoms);
    expect(parsed.atomicNumbers).toEqual(fchk.atomicNumbers);
    for (let index = 0; index < fchk.numberOfAtoms; index += 1) {
      expect(parsed.atoms[index].x).toBeCloseTo(fchk.coordinatesBohr[index * 3] * BOHR_TO_ANGSTROM, 7);
      expect(parsed.atoms[index].y).toBeCloseTo(fchk.coordinatesBohr[index * 3 + 1] * BOHR_TO_ANGSTROM, 7);
      expect(parsed.atoms[index].z).toBeCloseTo(fchk.coordinatesBohr[index * 3 + 2] * BOHR_TO_ANGSTROM, 7);
    }
  });

  it('reads back the same shells, including the recombined sp shell', () => {
    expect(parsed.shellTypes).toEqual(fchk.shellTypes);
    expect(parsed.primitivesPerShell).toEqual(fchk.primitivesPerShell);
    expect(parsed.shellToAtomMap).toEqual(fchk.shellToAtomMap);
    expect(parsed.numberOfBasisFunctions).toBe(fchk.numberOfBasisFunctions);
    expect(parsed.primitiveExponents).toHaveLength(fchk.primitiveExponents.length);
    for (let index = 0; index < fchk.primitiveExponents.length; index += 1) {
      expect(parsed.primitiveExponents[index]).toBeCloseTo(fchk.primitiveExponents[index], 9);
      expect(parsed.contractionCoefficients[index]).toBeCloseTo(fchk.contractionCoefficients[index], 9);
      expect(parsed.spContractionCoefficients[index]).toBeCloseTo(fchk.spContractionCoefficients[index], 9);
    }
  });

  it('reads back the same MO energies, occupations and coefficients', () => {
    expect(parsed.orbitals).toHaveLength(4);
    expect(parsed.orbitalEnergies).toHaveLength(4);
    for (let orbital = 0; orbital < 4; orbital += 1) {
      expect(parsed.orbitals[orbital].energy).toBeCloseTo(fchk.orbitalEnergies[orbital], 5);
      expect(parsed.orbitals[orbital].occupation).toBeCloseTo(orbital < 3 ? 2 : 0, 4);
      for (let basis = 0; basis < 12; basis += 1) {
        expect(parsed.orbitals[orbital].coefficients[basis]).toBeCloseTo(
          fchk.alphaMOCoefficients[orbital * 12 + basis],
          7,
        );
      }
    }
  });

  it('is consumable by the existing checkpoint-shell decoder', () => {
    const shells = shellsFromFchk(parsed);
    expect(shells).toHaveLength(fchk.shellTypes.length);
    expect(shells.map((shell) => shell.type)).toEqual(fchk.shellTypes);
    expect(shells[1].primitives[0]).toMatchObject({ exponent: 0.7 });
    expect(shells[1].primitives[0].p).toBeCloseTo(0.15591627, 9);
  });
});

describe('Molden reader: refusals by name', () => {
  it('refuses a file without the [Molden Format] header', () => {
    const error = () => parseMolden('[Atoms] Angs\nH 1 1 0 0 0\n');
    expect(error).toThrow(MoldenFormatError);
    expect(error).toThrow(/does not start with \[Molden Format\]/);
  });

  it('refuses a [STO] section', () => {
    const text = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[STO]',
      '1 0',
      's 1 1.0',
      '  1.0 1.0',
    ].join('\n');
    expect(() => parseMolden(text)).toThrow(/\[STO\] section .*Slater orbitals.*not supported/);
  });

  it('refuses a shell beyond g', () => {
    expect(() => parseMolden(markerFixture('', ['h 1 1.00', '  0.8 1.0'], 11)))
      .toThrow(/\[GTO\] shell 1 .*shell type "h".*supports s, p, sp, d, f and g/);
  });

  it('refuses a [GTO] atom index outside the [Atoms] table', () => {
    expect(() => parseMolden(markerFixture('', ['s 1 1.00', '  0.8 1.0'], 1).replace('1 0\n', '2 0\n')))
      .toThrow(/\[GTO\] atom 2 .*out of range.*\[Atoms\].*1 atom/);
  });

  it('refuses a shell whose primitive count disagrees with its header', () => {
    const text = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[GTO]',
      '1 0',
      's 3 1.00',
      '  0.5 1.0',
      '  0.3 1.0',
      '[MO]',
      ' Sym= A1',
      ' Ene= -1.0',
      ' Spin= Alpha',
      ' Occup= 2.0',
      '  1 1.0',
    ].join('\n');
    expect(() => parseMolden(text)).toThrow(/\[GTO\] shell 1 \(s\) on atom 1 declares 3 primitives but has 2/);
  });

  it('refuses a coefficient count that does not match the contraction', () => {
    const sWithTwo = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[GTO]',
      '1 0',
      's 1 1.00',
      '  0.5 1.0 0.5',
      '[MO]',
      ' Sym= A1',
      ' Ene= -1.0',
      ' Spin= Alpha',
      ' Occup= 2.0',
      '  1 1.0',
    ].join('\n');
    expect(() => parseMolden(sWithTwo)).toThrow(/\[GTO\] line 7: the s shell on atom 1 needs 1 contraction coefficient.*found 2/);

    const spWithOne = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[GTO]',
      '1 0',
      'sp 1 1.00',
      '  0.5 1.0',
      '[MO]',
      ' Sym= A1',
      ' Ene= -1.0',
      ' Spin= Alpha',
      ' Occup= 2.0',
      '  1 1.0',
    ].join('\n');
    expect(() => parseMolden(spWithOne)).toThrow(/the sp shell on atom 1 needs 2 contraction coefficients.*found 1/);
  });

  it('refuses a marker that contradicts the coefficient vector', () => {
    // [5D] makes this a five-function d shell; the MO block has six.
    expect(() => parseMolden(markerFixture('[5D]', ['d 1 1.00', '  0.8 1.0'], 6)))
      .toThrow(/\[MO\] orbital 1.*has 6 coefficients but the basis has 5 functions.*\[5D\]/);
  });

  it('refuses conflicting markers and an impossible function tally', () => {
    const conflict = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[5D]',
      '[6D]',
      '[GTO]',
      '1 0',
      'd 1 1.00',
      '  0.8 1.0',
      '[MO]',
      ' Sym= A1',
      ' Ene= -1.0',
      ' Spin= Alpha',
      ' Occup= 2.0',
      '  1 1.0',
    ].join('\n');
    expect(() => parseMolden(conflict)).toThrow(/\[5D\].*\[6D\].*disagree about d functions \(5 vs 6\)/);

    expect(() => parseMolden(markerFixture('[6F]', ['f 1 1.00', '  1.2 1.0'], 6)))
      .toThrow(/\[6F\] marker asks for 6 f functions; f is 7 .* or 10/);
  });

  it('refuses a truncated [MO] block', () => {
    const text = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[GTO]',
      '1 0',
      's 1 1.00',
      '  0.5 1.0',
      's 1 1.00',
      '  0.3 1.0',
      '[MO]',
      ' Sym= A1',
      ' Ene= -1.0',
      ' Spin= Alpha',
      ' Occup= 2.0',
      '  1 1.0',
    ].join('\n');
    expect(() => parseMolden(text)).toThrow(/\[MO\] orbital 1.*has 1 coefficient but the basis has 2 functions/);
  });

  it('refuses an out-of-range or repeated coefficient index', () => {
    expect(() => parseMolden(minimalS({ coefficients: ['  2 1.0'] })))
      .toThrow(/\[MO\] orbital 1.*has coefficient index 2; the basis has 1 function/);
    expect(() => parseMolden(minimalS({ coefficients: ['  1 1.0', '  1 0.0'] })))
      .toThrow(/\[MO\] orbital 1.*repeats coefficient index 1/);
  });

  it('refuses an orbital without an energy or an occupation, or with an unknown spin', () => {
    expect(() => parseMolden(minimalS({ energy: null }))).toThrow(/\[MO\] orbital 1.*has no Ene= line/);
    expect(() => parseMolden(minimalS({ occupation: null }))).toThrow(/\[MO\] orbital 1.*has no Occup= line/);
    expect(() => parseMolden(minimalS({ spin: 'Gamma' }))).toThrow(/\[MO\] orbital 1 has Spin= "Gamma"; only Alpha and Beta/);
  });

  it('refuses [MO] coefficients with no [GTO] basis to attach them to', () => {
    const text = [
      '[Molden Format]',
      '[Atoms] Angs',
      'H 1 1 0 0 0',
      '[MO]',
      ' Sym= A1',
      ' Ene= -1.0',
      ' Spin= Alpha',
      ' Occup= 2.0',
      '  1 1.0',
    ].join('\n');
    expect(() => parseMolden(text)).toThrow(/\[MO\].*no \[GTO\] basis/);
  });
});
