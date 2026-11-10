import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOHR_TO_ANGSTROM } from '../src/shared/cubeFile.js';
import { MAX_FCHK_CHARS, MAX_FCHK_VALUES, jobStatusLabel, parseFchk } from '../src/shared/fchk.js';

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
    // The fixture carries no beta manifold, no ESP charges and no basis table:
    // those are reported as missing rather than filled with zeros.
    expect(fchk.missing).toEqual(expect.arrayContaining([
      'orbitalEnergiesBeta', 'espCharges', 'shellTypes', 'alphaMOCoefficients',
    ]));
    expect(fchk.missing).not.toContain('orbitalEnergies');
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
    expect(fchk.missing).toContain('orbitalEnergies');
    expect(fchk.missing.length).toBeGreaterThan(0);
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

  it('refuses a file over the size bound and names how to raise it', () => {
    let message = '';
    try {
      parseFchk(FCHK, { maxChars: 40 });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/characters; the limit is 40/);
    // #243: "trim the file" is impossible for a line-oriented format, and
    // "export it from a smaller job" blames the calculation for a reader
    // limit. The refusal names the option that actually raises the ceiling.
    expect(message).toMatch(/maxChars/);
    expect(message).not.toMatch(/trim the file|smaller job/);
    expect(MAX_FCHK_CHARS).toBe(256 * 1024 * 1024);
  });

  it('refuses a block over the value bound and names how to raise it', () => {
    let message = '';
    try {
      parseFchk(FCHK, { maxValues: 5 });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/declares 9 values; the limit is 5/);
    expect(message).toMatch(/maxValues/);
  });

  it('refuses an empty file', () => {
    expect(() => parseFchk('')).toThrow(/empty/);
  });

  it('refuses a file that is not a checkpoint at all', () => {
    expect(() => parseFchk('this is a cube, not a checkpoint\n1 2 3'))
      .toThrow(/not a formatted checkpoint/);
  });

  it('names `formchk -3` when the file is not a formatted checkpoint', () => {
    // #242: a user who already ran bare `formchk` has a file that can still
    // parse, so this refusal has to tell them the flag is the fix.
    expect(() => parseFchk('this is a cube, not a checkpoint\n1 2 3'))
      .toThrow(/formchk -3/);
  });

  it('refuses a binary checkpoint by name', () => {
    expect(() => parseFchk('\u0000\u0001binary')).toThrow(/formchk -3|not a formatted checkpoint/);
  });
});

/** A field header padded to column 43, the way `formchk` writes it. */
function fieldLine(label, type, rest) {
  return `${label.padEnd(43)}${type}   ${rest}`;
}

/**
 * One zero block. Each value is the single token `0` rather than a
 * 16-character real: the parser tokenises on whitespace, so the compact form
 * declares and decodes the exact `NBasis²` count without building the ~128 MB
 * of text a real 2000-function open-shell file carries.
 */
function zeroValues(count) {
  const lines = [];
  for (let written = 0; written < count; written += 200) {
    lines.push(new Array(Math.min(200, count - written)).fill('0').join(' '));
  }
  return lines.join('\n');
}

/**
 * A checkpoint whose only purpose is the `NBsUse`/`IOpCl` cross-checks (#246):
 * two atoms, one (or both) MO blocks of `alphaValues` zeros, and the stated
 * dimensions. The zeros are single tokens so the block declares an exact count
 * without carrying 16-character reals.
 */
function dimensionCheckpoint({
  nbf, nbsUse = null, iopcl = null, alphaValues, beta = false, spin = false,
}) {
  const count = (number) => String(number).padStart(12);
  const lines = [
    'synthetic dimension checkpoint',
    '',
    fieldLine('Number of atoms', 'I', '2'),
    fieldLine('Number of basis functions', 'I', String(nbf)),
  ];
  if (Number.isInteger(nbsUse)) lines.push(fieldLine('Number of independent functions', 'I', String(nbsUse)));
  if (Number.isInteger(iopcl)) lines.push(fieldLine('IOpCl', 'I', String(iopcl)));
  lines.push(
    fieldLine('Atomic numbers', 'I', `N= ${count(2)}`),
    '6 6',
    fieldLine('Alpha MO coefficients', 'R', `N= ${count(alphaValues)}`),
    zeroValues(alphaValues),
  );
  if (beta) {
    lines.push(
      fieldLine('Beta MO coefficients', 'R', `N= ${count(alphaValues)}`),
      zeroValues(alphaValues),
    );
  }
  if (spin) {
    const triangular = (nbf * (nbf + 1)) / 2;
    lines.push(
      fieldLine('Spin SCF Density', 'R', `N= ${count(triangular)}`),
      zeroValues(triangular),
    );
  }
  return lines.join('\n');
}

function largeCheckpoint({ nbf, openShell }) {
  const atoms = 2;
  const values = nbf * nbf;
  const count = (number) => String(number).padStart(12);
  const lines = [
    'synthetic large-basis checkpoint',
    '',
    fieldLine('Number of atoms', 'I', String(atoms)),
    fieldLine('Number of basis functions', 'I', String(nbf)),
    fieldLine('Atomic numbers', 'I', `N= ${count(atoms)}`),
    '6 6',
    fieldLine('Current cartesian coordinates', 'R', `N= ${count(atoms * 3)}`),
    '0 0 0 0 0 0',
    fieldLine('Alpha MO coefficients', 'R', `N= ${count(values)}`),
    zeroValues(values),
  ];
  if (openShell) {
    lines.push(
      fieldLine('Beta MO coefficients', 'R', `N= ${count(values)}`),
      zeroValues(values),
    );
  }
  return lines.join('\n');
}

describe('fchk large bases (#243)', () => {
  it('parses a 2000-basis-function closed-shell checkpoint', () => {
    const fchk = parseFchk(largeCheckpoint({ nbf: 2000, openShell: false }));
    expect(fchk.numberOfBasisFunctions).toBe(2000);
    expect(fchk.alphaMOCoefficients).toHaveLength(4_000_000);
    expect(fchk.betaMOCoefficients).toBeUndefined();
    expect(fchk.missing).toContain('betaMOCoefficients');
  }, 120_000);

  it('parses a 2000-basis-function open-shell checkpoint, beta block included', () => {
    const fchk = parseFchk(largeCheckpoint({ nbf: 2000, openShell: true }));
    expect(fchk.alphaMOCoefficients).toHaveLength(4_000_000);
    expect(fchk.betaMOCoefficients).toHaveLength(4_000_000);
    expect(fchk.missing).not.toContain('betaMOCoefficients');
  }, 120_000);

  it('sizes the default guards for a realistic 2000-bf open-shell file', () => {
    // Five 16-character reals per line: alpha MO + beta MO + the density
    // triangle. An open-shell file must not hit a ceiling a closed-shell file
    // of the same dimensions would clear.
    const realistic = 2 * 2000 ** 2 * 16 + ((2000 * 2001) / 2) * 16;
    expect(MAX_FCHK_CHARS).toBeGreaterThan(realistic);
    expect(MAX_FCHK_VALUES).toBeGreaterThan(2000 ** 2);
  });

  it('refuses a declared count the file\'s own NBasis cannot produce, before reading it', () => {
    const broken = largeCheckpoint({ nbf: 2, openShell: false }).replace(
      fieldLine('Alpha MO coefficients', 'R', `N= ${String(4).padStart(12)}`),
      fieldLine('Alpha MO coefficients', 'R', `N= ${String(5).padStart(12)}`),
    );
    // Four values of data remain: an unshaped reader would report "declares 5
    // but the file ends after 4". The shape error names the basis instead.
    expect(() => parseFchk(broken))
      .toThrow(/declares 5 values, but a 2-function basis allows at most 4/);
  });
});

/* ── #244: Job Status, #245: character fields, #246: dimensions ──── */

const DVB = readFileSync('test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk', 'utf8');

/** The real fixture with its `Job Status I 1` line replaced (or removed). */
function withJobStatus(value) {
  const line = `Job Status                                 I                ${value}`;
  return DVB.replace(/^Job Status\s+I\s+1$/m, line);
}

describe('fchk Job Status (#244)', () => {
  it('reads Job Status and treats 1 and 2 as normal completion', () => {
    const one = parseFchk(DVB);
    expect(one.jobStatus).toBe(1);
    expect(one.found).toContain('jobStatus');
    expect(jobStatusLabel(one.jobStatus)).toBe('finished successfully');
    expect(one.warnings).toEqual([]);

    const two = parseFchk(withJobStatus(2));
    expect(two.jobStatus).toBe(2);
    expect(two.warnings).toEqual([]);
    expect(jobStatusLabel(2)).toMatch(/multi-step/);
  });

  it('warns on an error termination (Job Status 3) and says Link 9999', () => {
    const fchk = parseFchk(withJobStatus(3));
    expect(fchk.jobStatus).toBe(3);
    expect(fchk.warnings.join(' ')).toMatch(/Job Status is 3 \(error termination in Link 9999\)/);
  });

  it('warns on in-progress and undefined/old checkpoints', () => {
    expect(parseFchk(withJobStatus(-1)).warnings.join(' ')).toMatch(/Job Status is -1 \(in progress\)/);
    expect(parseFchk(withJobStatus(0)).warnings.join(' ')).toMatch(/Job Status is 0 \(undefined or old checkpoint file\)/);
  });

  it('leaves an absent Job Status absent — it never invents 0', () => {
    const without = DVB.replace(/^Job Status.*\r?\n/m, '');
    const fchk = parseFchk(without);
    expect(fchk.jobStatus).toBeUndefined();
    expect('jobStatus' in fchk).toBe(false);
    expect(fchk.missing).toContain('jobStatus');
    // The fixture is otherwise self-consistent, so removing the field must not
    // produce the "undefined/old checkpoint" warning a 0 would.
    expect(fchk.warnings).toEqual([]);
  });
});

describe('fchk character fields (#245)', () => {
  it('reads Gaussian Version from a C block and normalises its padding', () => {
    const fchk = parseFchk(DVB);
    expect(fchk.version).toBe('ES64L-G16RevA.03');
    expect(fchk.found).toContain('version');
    expect(fchk.missing).not.toContain('version');
  });

  it('reads Full Title and Route without tokenising their spaces', () => {
    const fchk = parseFchk(DVB);
    expect(fchk.fullTitle).toBe('dvb');
    expect(fchk.route).toBe('#p b3lyp/sto-3g opt');
    expect(fchk.found).toEqual(expect.arrayContaining(['fullTitle', 'route']));
  });

  it('preserves spaces inside a multi-element title', () => {
    const text = [
      'synthetic character checkpoint',
      '',
      'Full Title                                 C   N=           2',
      'first  part '.padEnd(12) + 'second  part'.padEnd(12),
    ].join('\n');
    expect(parseFchk(text).fullTitle).toBe('first  part second  part');
  });

  it('reads a 64-character element when a writer uses that width', () => {
    // The fchk documentation says 5A12 and the fixture encodes 2 × 12 chars,
    // but the issue notes a 64-character form; one contiguous element of that
    // width must still round-trip.
    const text = [
      'synthetic character checkpoint',
      '',
      'Gaussian Version                           C   N=           1',
      'ES64L-G16RevA.03'.padEnd(64),
    ].join('\n');
    expect(parseFchk(text).version).toBe('ES64L-G16RevA.03');
  });

  it('tolerates a zero-count character block and keeps the field absent', () => {
    const zero = DVB.replace(
      /^Gaussian Version.*\r?\nES64L-G16RevA\.03[^\r\n]*/m,
      'Gaussian Version                           C   N=           0',
    );
    expect(zero).not.toContain('ES64L-G16RevA.03');
    const fchk = parseFchk(zero);
    expect(fchk.version).toBeUndefined();
    expect('version' in fchk).toBe(false);
    expect(fchk.missing).toContain('version');
  });
});

describe('fchk independent functions and spin case (#246)', () => {
  it('reads NBsUse and IOpCl and leaves the self-consistent fixture warning-free', () => {
    const fchk = parseFchk(DVB);
    expect(fchk.numberOfIndependentFunctions).toBe(60);
    expect(fchk.iopcl).toBe(0);
    expect(fchk.found).toEqual(expect.arrayContaining(['numberOfIndependentFunctions', 'iopcl']));
    expect(fchk.warnings).toEqual([]);
  });

  it('accepts the older `independant` spelling', () => {
    const text = dimensionCheckpoint({ nbf: 2, nbsUse: 2, alphaValues: 4 })
      .replace('Number of independent functions', 'Number of independant functions');
    const fchk = parseFchk(text);
    expect(fchk.numberOfIndependentFunctions).toBe(2);
    expect(fchk.found).toContain('numberOfIndependentFunctions');
  });

  it('refuses 60 orbitals where NBsUse is 58, naming both numbers', () => {
    // 3600 values = 60 NBasis × 60 orbitals; the file says 58 independent
    // functions, so the block is not NBasis × NBsUse.
    const text = dimensionCheckpoint({ nbf: 60, nbsUse: 58, alphaValues: 3600 });
    expect(() => parseFchk(text))
      .toThrow(/3600 values, but 60 basis functions × 58 independent functions = 3480/);
  });

  it('refuses the 3480-value block the issue describes for 58 basis functions', () => {
    // 3480 = 58 × 60: sixty orbitals in a file that states 58 independent
    // functions. The exact product is 58 × 58 = 3364.
    const text = dimensionCheckpoint({ nbf: 58, nbsUse: 58, alphaValues: 3480 });
    expect(() => parseFchk(text))
      .toThrow(/3480 values, but 58 basis functions × 58 independent functions = 3364/);
  });

  it('refuses a truncated MO block that is still divisible by NBasis', () => {
    // Two values with NBasis 2 and NBsUse 2: the old divisibility check passed
    // it as one orbital, and only the exact product catches the missing one.
    const text = dimensionCheckpoint({ nbf: 2, nbsUse: 2, alphaValues: 2 });
    expect(() => parseFchk(text))
      .toThrow(/2 values, but 2 basis functions × 2 independent functions = 4/);
  });

  it('refuses NBsUse outside 1..NBasis', () => {
    const text = dimensionCheckpoint({ nbf: 2, nbsUse: 3, alphaValues: 4 });
    expect(() => parseFchk(text))
      .toThrow(/"Number of independent functions" is 3, but the file states 2 basis functions/);
  });

  it('warns when a closed-shell file carries beta MOs or a spin density', () => {
    const withBeta = parseFchk(dimensionCheckpoint({
      nbf: 2, nbsUse: 2, alphaValues: 4, iopcl: 0, beta: true,
    }));
    expect(withBeta.warnings.join(' ')).toMatch(/IOpCl is 0 \(closed shell\).*"Beta MO coefficients"/);

    const withSpin = parseFchk(dimensionCheckpoint({
      nbf: 2, nbsUse: 2, alphaValues: 4, iopcl: 0, spin: true,
    }));
    expect(withSpin.warnings.join(' ')).toMatch(/IOpCl is 0 \(closed shell\).*"Spin SCF Density"/);
  });

  it('warns when IOpCl >= 1 has no beta block', () => {
    const fchk = parseFchk(dimensionCheckpoint({ nbf: 2, nbsUse: 2, alphaValues: 4, iopcl: 1 }));
    expect(fchk.warnings.join(' ')).toMatch(/IOpCl is 1 \(open shell\).*no "Beta MO coefficients"/);
  });

  it('draws no conclusion from IOpCl = -1, and none from a consistent open-shell file', () => {
    const unspecified = parseFchk(dimensionCheckpoint({
      nbf: 2, nbsUse: 2, alphaValues: 4, iopcl: -1, beta: true,
    }));
    expect(unspecified.warnings).toEqual([]);
    const open = parseFchk(dimensionCheckpoint({
      nbf: 2, nbsUse: 2, alphaValues: 4, iopcl: 1, beta: true,
    }));
    expect(open.warnings).toEqual([]);
  });
});
