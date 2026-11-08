import { describe, expect, it } from 'vitest';
import { BOHR_TO_ANGSTROM } from '../src/shared/cubeFile.js';
import { MAX_FCHK_CHARS, parseFchk } from '../src/shared/fchk.js';

/**
 * A formatted checkpoint with the subset this reader claims to support. The
 * labels are padded to column 43 the way `formchk` does, and the arrays wrap at
 * five reals per line, so a parser that counts columns rather than tokens has
 * to get the wrap right here too.
 */
const FCHK = [
  'water B3LYP/def2-SVP',
  '',
  'Number of atoms                            I                3',
  'Number of basis functions                  I               19',
  'Number of electrons                        I               10',
  'Charge                                     I                0',
  'Multiplicity                               I                1',
  'Number of alpha electrons                  I                5',
  'Number of beta electrons                   I                5',
  'Atomic numbers                             I   N=           3',
  '           8           1           1',
  'Current cartesian coordinates              R   N=           9',
  '  0.00000000E+00  0.00000000E+00  0.00000000E+00  0.00000000E+00  1.43000000E+00',
  '  0.90000000E+00  0.00000000E+00 -1.43000000E+00  0.90000000E+00',
  'Orbital Energies                          R   N=           6',
  ' -2.00000000E+01 -1.40000000E+00 -7.00000000E-01 -3.00000000E-01  1.00000000E-01',
  '  2.00000000E-01',
  'Mulliken Charges                          R   N=           3',
  ' -8.00000000E-01  4.00000000E-01  4.00000000E-01',
  'Total Energy                               R     -7.60000000E+01',
  'Virial Ratio                               R      2.00000000E+00',
].join('\n');

describe('fchk subset', () => {
  it('reads every field it claims to support', () => {
    const fchk = parseFchk(FCHK);
    expect(fchk.format).toBe('fchk');
    expect(fchk.found).toEqual([
      'numberOfAtoms',
      'numberOfBasisFunctions',
      'numberOfElectrons',
      'charge',
      'multiplicity',
      'numberOfAlphaElectrons',
      'numberOfBetaElectrons',
      'atomicNumbers',
      'coordinatesBohr',
      'orbitalEnergies',
      'mullikenCharges',
      'totalEnergyHartree',
      'virialRatio',
    ]);
    expect(fchk.missing).toEqual(['orbitalEnergiesBeta', 'espCharges']);
    expect(fchk.numberOfAtoms).toBe(3);
    expect(fchk.numberOfBasisFunctions).toBe(19);
    expect(fchk.charge).toBe(0);
    expect(fchk.atomicNumbers).toEqual([8, 1, 1]);
    expect(fchk.orbitalEnergies).toHaveLength(6);
    expect(fchk.orbitalEnergies[5]).toBeCloseTo(0.2, 12);
    expect(fchk.totalEnergyHartree).toBeCloseTo(-76, 12);
    expect(fchk.virialRatio).toBeCloseTo(2, 12);
  });

  it('converts the bohr coordinates to Å once', () => {
    const fchk = parseFchk(FCHK);
    expect(fchk.units).toEqual({ coordinates: 'angstrom', source: 'bohr' });
    expect(fchk.atoms).toHaveLength(3);
    expect(fchk.atoms[1]).toEqual({
      atomicNumber: 1,
      element: 'H',
      x: 0,
      y: 1.43 * BOHR_TO_ANGSTROM,
      z: 0.9 * BOHR_TO_ANGSTROM,
    });
    // 1.43 bohr is 0.7567 Å; 1.43/0.529 twice would be 5.1 Å.
    expect(fchk.atoms[1].y).toBeCloseTo(0.75672, 4);
  });

  it('omits a missing field instead of zero-filling it', () => {
    const withoutVirial = FCHK.split('\n').filter((line) => !line.startsWith('Virial Ratio')).join('\n');
    const fchk = parseFchk(withoutVirial);
    expect(fchk.virialRatio).toBeUndefined();
    expect('virialRatio' in fchk).toBe(false);
    expect(fchk.missing).toContain('virialRatio');
  });

  it('reports an empty subset rather than throwing when nothing of interest is present', () => {
    const minimal = [
      'a checkpoint from another code',
      'Number of atoms                            I                2',
      'Total Energy                               R     -1.00000000E+00',
    ].join('\n');
    const fchk = parseFchk(minimal);
    expect(fchk.found).toEqual(['numberOfAtoms', 'totalEnergyHartree']);
    expect(fchk.missing).toHaveLength(13);
    expect(fchk.orbitalEnergies).toBeUndefined();
    expect(fchk.atoms).toBeUndefined();
  });

  it('reads a spin-2 orbital array without confusing it with the alpha set', () => {
    const uhf = FCHK.replace(
      '  2.00000000E-01',
      '  2.00000000E-01\nOrbital Energies, spin 2                  R   N=           6\n'
      + ' -2.00000000E+01 -1.50000000E+00 -8.00000000E-01 -4.00000000E-01  5.00000000E-02\n'
      + '  2.50000000E-01',
    );
    const fchk = parseFchk(uhf);
    expect(fchk.orbitalEnergies).toHaveLength(6);
    expect(fchk.orbitalEnergies[4]).toBeCloseTo(0.1, 12);
    expect(fchk.orbitalEnergiesBeta).toHaveLength(6);
    expect(fchk.orbitalEnergiesBeta[4]).toBeCloseTo(0.05, 12);
  });

  it('warns when the alpha/beta counts contradict the electron count', () => {
    const broken = FCHK.replace(
      'Number of electrons                        I               10',
      'Number of electrons                        I               11',
    );
    const fchk = parseFchk(broken);
    expect(fchk.warnings.join(' ')).toMatch(/do not add up to Number of electrons \(11\)/);
  });
});

describe('fchk refusals', () => {
  it('refuses a non-numeric token with the line number', () => {
    const broken = FCHK.replace('  2.00000000E-01', '  2.00000000E-0X');
    expect(() => parseFchk(broken)).toThrow(/Line 17: field "Orbital Energies" has the non-numeric token "2.00000000E-0X"/);
  });

  it('refuses an array that ends early', () => {
    const broken = FCHK.split('\n').filter((line) => !line.includes('2.00000000E-01')).join('\n');
    expect(() => parseFchk(broken))
      .toThrow(/Field "Orbital Energies" declares 6 values but stops after 5 at line 17/);
  });

  it('refuses an array with more data than its declared count', () => {
    const broken = FCHK.split('\n').filter((line) => !line.includes('  2.00000000E-01'))
      .join('\n')
      .replace('Orbital Energies                          R   N=           6', 'Orbital Energies                          R   N=           4');
    expect(() => parseFchk(broken))
      .toThrow(/declares 4 values but the data continues with "1.00000000E-01"/);
  });

  it('refuses an atomic-number array that disagrees with Number of atoms', () => {
    const broken = FCHK
      .replace('Atomic numbers                             I   N=           3', 'Atomic numbers                             I   N=           2')
      .replace('           8           1           1', '           8           1');
    expect(() => parseFchk(broken)).toThrow(/Field "Atomic numbers" has 2 values for 3 atoms/);
  });

  it('refuses coordinates that are not three per atom', () => {
    const broken = FCHK.replace(
      'Current cartesian coordinates              R   N=           9',
      'Current cartesian coordinates              R   N=           6',
    ).replace('  0.90000000E+00  0.00000000E+00 -1.43000000E+00  0.90000000E+00', '');
    expect(() => parseFchk(broken)).toThrow(/has 5 values for 3 atoms|stops after/);
  });

  it('refuses a file over the size bound', () => {
    expect(() => parseFchk(FCHK, { maxChars: 40 })).toThrow(/characters; the limit is 40/);
    expect(MAX_FCHK_CHARS).toBe(64 * 1024 * 1024);
  });

  it('refuses an empty file', () => {
    expect(() => parseFchk('')).toThrow(/empty/);
  });

  it('refuses a file that is not a checkpoint at all', () => {
    expect(() => parseFchk('this is a cube, not a checkpoint\n1 2 3'))
      .toThrow(/not a formatted checkpoint/);
  });

  it('refuses a binary checkpoint by name', () => {
    expect(() => parseFchk('\u0000\u0001binary')).toThrow(/formchk|not a formatted checkpoint/);
  });
});
