import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { groupAimPrimitives } from '../src/shared/aimBasis.js';
import { BOHR_TO_ANGSTROM } from '../src/shared/cubeFile.js';
import { WfnFormatError, parseWfn } from '../src/shared/wfn.js';
import { WfxFormatError, parseWfx } from '../src/shared/wfx.js';
import {
  detectWavefunctionFormat,
  orbitalGap,
  readWavefunction,
  wavefunctionRecord,
} from '../src/shared/wavefunction.js';

/**
 * WFN and WFX readers, against synthetic fixtures.
 *
 * Every file in `test/fixtures/aim/` is hand-written for these tests (see its
 * README). None was produced by AIMAll, Gaussian, Multiwfn or any other
 * program, and no number here is a chemical result: the coefficients are
 * position-coded (0.01, 0.02, …) so a permutation can be seen.
 */

// Windows checkouts convert line endings (core.autocrlf), and several cases
// below build their refusal fixtures by matching `\n` in this text: a CRLF copy
// made those replacements miss and the refusal never fired, so the packaging job
// failed on the same commit CI passed. Read fixtures as LF on every platform.
const read = (name) => readFileSync(`test/fixtures/aim/${name}`, 'utf8').replace(/\r\n/g, '\n');
const THREE_LINE = read('water-3line-gaussian.wfn');
const FIVE_LINE = read('water-5line-mep-gaussian.wfn');
const LABELLED = read('water-3line-labelled.wfn');
const LABELLED_MEP = read('water-5line-mep-labelled.wfn');
const LABELLED_D = read('water-d-labelled.wfn');
const WFX = read('water.wfx');

const OCCUPATIONS = [2, 2, 2, 2, 2, 0];
const ENERGIES = [-20.2402, -1.2683, -0.617, -0.4537, -0.3918, 0.1234];

/** Indices of the lines belonging to one MO block: header + coefficient lines. */
function moBlockLines(lines, moNumber) {
  const start = lines.findIndex((line) => new RegExp(`^MO\\s+${moNumber}\\s+`).test(line));
  if (start < 0) throw new Error(`MO ${moNumber} not found`);
  let end = start + 1;
  while (end < lines.length && !/^MO\s+\d+\s+/.test(lines[end]) && !/^END\s+DATA/.test(lines[end])) end += 1;
  return { start, end };
}

/** Remove the last coefficient token of one MO. */
function dropLastCoefficient(text, moNumber) {
  const lines = text.split('\n');
  const { start, end } = moBlockLines(lines, moNumber);
  for (let index = end - 1; index > start; index -= 1) {
    if (!lines[index].trim()) continue;
    lines[index] = lines[index].replace(/\s*\S+\s*$/, '');
    return lines.join('\n');
  }
  throw new Error('no coefficient line to drop');
}

/** Append one coefficient token to one MO. */
function addCoefficient(text, moNumber) {
  const lines = text.split('\n');
  const { start, end } = moBlockLines(lines, moNumber);
  lines[end - 1] = `${lines[end - 1].trimEnd()}   1.00000000D-3`;
  return lines.join('\n');
}

/** Replace the modern MO header with the older `'MO' index occupation energy` form. */
function withOldMoHeaders(text) {
  return text.replace(
    /^MO\s+(\d+)\s+MO 0\.0\s+OCC NO =\s+(\S+)\s+ORB\. ENERGY =\s+(\S+)$/gm,
    "'MO' $1 $2 $3",
  );
}

describe('AIM format detection', () => {
  it('detects WFN by its count line and WFX by its required sections', () => {
    expect(detectWavefunctionFormat(THREE_LINE)).toBe('wfn');
    expect(detectWavefunctionFormat(FIVE_LINE)).toBe('wfn');
    expect(detectWavefunctionFormat(LABELLED)).toBe('wfn');
    expect(detectWavefunctionFormat(WFX)).toBe('wfx');
  });

  it('finds the count line under a long title block', () => {
    const prefixed = `${Array.from({ length: 30 }, (_, i) => `mail header ${i + 1}`).join('\n')}\n${THREE_LINE}`;
    expect(detectWavefunctionFormat(prefixed)).toBe('wfn');
    const parsed = parseWfn(prefixed);
    expect(parsed.header.titleLines).toBe(31);
    expect(parsed.title).toContain('mail header 30');
    expect(parsed.title).toContain('synthetic water');
  });

  it('does not steal a cube, a checkpoint or a Molden file', () => {
    expect(detectWavefunctionFormat('cube title\ncomment\n1 0 0 0\n8 8 0 0 0\n-1 1.0 1 0 0\n-1 1.0 0 1 0\n-1 1.0 0 0 1\n1\n')).toBe('cube');
    expect(detectWavefunctionFormat('Number of atoms I 1\n')).toBe('fchk');
    expect(detectWavefunctionFormat('[Molden Format]\n[Atoms] Angs\nH 1 1 0 0 0\n')).toBe('molden');
  });

  it('returns the same {kind, parsed} shape as the other readers', () => {
    const wfn = readWavefunction(THREE_LINE, { filename: 'water.wfn' });
    expect(wfn.kind).toBe('wfn');
    expect(wfn.parsed.format).toBe('wfn');
    const wfx = readWavefunction(WFX, { filename: 'water.wfx' });
    expect(wfx.kind).toBe('wfx');
    expect(wfx.parsed.format).toBe('wfx');
  });
});

describe('WFN header variants', () => {
  it('reads a three-line header and says MEP is absent', () => {
    const parsed = parseWfn(THREE_LINE);
    expect(parsed.header).toMatchObject({
      form: '3-line',
      program: 'GAUSSIAN',
      countsLine: 2,
      titleLines: 1,
      basisOrdering: 'gaussian',
    });
    expect(parsed.mep.present).toBe(false);
    expect(parsed.mep.reason).toMatch(/no MEP block/);
    expect(parsed.warnings.join(' ')).toMatch(/no MEP block/);
  });

  it('reads a five-line header with MEP data and keeps the values', () => {
    const parsed = parseWfn(FIVE_LINE);
    expect(parsed.header.form).toBe('5-line');
    expect(parsed.header.countsLine).toBe(2);
    expect(parsed.mep).toMatchObject({
      present: true,
      values: [-22.123456, -1.234567, -1.234567],
      unit: 'hartree/e',
    });
    // No gradient or Hessian is invented from the MEP values.
    expect(parsed.mep.gradient).toBeUndefined();
  });

  it('keeps a non-GAUSSIAN program label from the count line', () => {
    const parsed = parseWfn(THREE_LINE.replace('GAUSSIAN', 'GAMESS'));
    expect(parsed.header.program).toBe('GAMESS');
  });

  it('refuses an MEP block that does not cover every nucleus or is overlong', () => {
    const short = FIVE_LINE.replace('-22.12345600 -1.23456700 -1.23456700', '-22.12345600 -1.23456700');
    expect(() => parseWfn(short)).toThrow(/MEP block carries 2 values for 3 nuclei/);

    const declared = FIVE_LINE.replace('MEP 3', 'MEP 2');
    expect(() => parseWfn(declared)).toThrow(/MEP block declares 2 values but the count line says 3 nuclei/);

    const long = FIVE_LINE.replace('-22.12345600 -1.23456700 -1.23456700', '-22.12345600 -1.23456700 -1.23456700 -1.23456700');
    expect(() => parseWfn(long)).toThrow(/MEP block carries 4 values for 3 nuclei/);
  });
});

describe('WFN atoms and basis', () => {
  it('reads the three nuclei in bohr and converts to Å once', () => {
    const parsed = parseWfn(THREE_LINE);
    expect(parsed.numberOfAtoms).toBe(3);
    expect(parsed.atomicNumbers).toEqual([8, 1, 1]);
    expect(parsed.nuclearCharges).toEqual([8, 1, 1]);
    expect(parsed.atoms[0]).toMatchObject({ atomicNumber: 8, element: 'O' });
    expect(parsed.atoms[0].z).toBeCloseTo(0.22142907 * BOHR_TO_ANGSTROM, 10);
    expect(parsed.coordinatesBohr[2]).toBeCloseTo(0.22142907, 10);
  });

  it('decontracts the Gaussian type table into one shell per primitive', () => {
    const parsed = parseWfn(THREE_LINE);
    expect(parsed.basisOrdering).toBe('gaussian');
    // 21 primitive functions become 15 shells: six s primitives, three
    // one-primitive p shells (three functions each), six more s primitives.
    expect(parsed.shellTypes).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(parsed.primitivesPerShell).toEqual(new Array(15).fill(1));
    expect(parsed.shellToAtomMap).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(parsed.numberOfBasisFunctions).toBe(21);
    expect(parsed.primitiveExponents[0]).toBeCloseTo(130.70932, 6);
    expect(parsed.primitiveExponents[6]).toBeCloseTo(3.4252509, 8);
    expect(parsed.contractionCoefficients).toEqual(new Array(15).fill(1));
  });

  it('permutes coefficients from component-major to shell-major order', () => {
    const parsed = parseWfn(THREE_LINE);
    // Source order is px1 px2 px3 py1 py2 py3 pz1 pz2 pz3; shell order is
    // (px1,py1,pz1), (px2,py2,pz2), (px3,py3,pz3). The coefficients are
    // 0.01, 0.02, … in source order, so the permutation is visible.
    expect(parsed.alphaMOCoefficients.slice(0, 3)).toEqual([0.01, 0.02, 0.03]);
    expect(parsed.alphaMOCoefficients.slice(6, 9)).toEqual([0.07, 0.1, 0.13]);
    expect(parsed.alphaMOCoefficients.slice(9, 12)).toEqual([0.08, 0.11, 0.14]);
    expect(parsed.alphaMOCoefficients.slice(12, 15)).toEqual([0.09, 0.12, 0.15]);
    expect(parsed.alphaMOCoefficients.slice(15, 18)).toEqual([0.16, 0.17, 0.18]);
  });

  it('maps a labelled s/sp table onto the checkpoint shell order', () => {
    const parsed = parseWfn(LABELLED);
    expect(parsed.basisOrdering).toBe('non-gaussian');
    expect(parsed.shellTypes).toEqual([0, -1, 0, 0]);
    expect(parsed.primitivesPerShell).toEqual([2, 2, 2, 2]);
    expect(parsed.shellToAtomMap).toEqual([1, 1, 2, 3]);
    expect(parsed.numberOfBasisFunctions).toBe(7);
    expect(parsed.spContractionCoefficients).toHaveLength(8);
    expect(parsed.spContractionCoefficients[2]).toBeCloseTo(0.15591627, 9);
    // No permutation is applied: the file's own shell order is the basis order.
    expect(parsed.alphaMOCoefficients.slice(0, 7)).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07]);
  });

  it('uses the type code, not the block position, for a non-canonical f table', () => {
    // Real writers order f components as 11 12 13 17 14 15 18 19 16 20 rather
    // than 11..20; the code says which component a run is.
    const order = [11, 12, 13, 17, 14, 15, 18, 19, 16, 20];
    const grouped = groupAimPrimitives({
      centres: order.map(() => 1),
      types: order,
      exponents: order.map(() => 1),
      atomCount: 1,
    });
    expect(grouped.numberOfBasisFunctions).toBe(10);
    // Canonical output is xxx yyy zzz xxy xxz yyz xyy xzz yzz xyz.
    expect(grouped.permutation).toEqual([0, 1, 2, 4, 5, 8, 3, 6, 7, 9]);
  });

  it('refuses a labelled d shell rather than guess its component order', () => {
    const error = () => parseWfn(LABELLED_D);
    expect(error).toThrow(WfnFormatError);
    expect(error).toThrow(/lists a "D" shell on atom 2/);
    expect(error).toThrow(/does not state its component order/);
  });

  it('refuses a basis table it does not recognise', () => {
    const text = THREE_LINE.replace(/^CENTRE ASSIGNMENTS.*\nCENTRE ASSIGNMENTS.*\nTYPE ASSIGNMENTS.*\nTYPE ASSIGNMENTS.*\nEXPONENTS.*\nEXPONENTS.*\nEXPONENTS.*\nEXPONENTS.*\nEXPONENTS.*\n/m, '');
    expect(() => parseWfn(text)).toThrow(/basis table was not recognised/);
  });
});

describe('WFN molecular orbitals', () => {
  it('reads energies, occupations and the coefficient run', () => {
    const parsed = parseWfn(THREE_LINE);
    expect(parsed.orbitals).toHaveLength(6);
    expect(parsed.orbitalEnergies).toEqual(ENERGIES);
    expect(parsed.occupations).toEqual(OCCUPATIONS);
    expect(parsed.orbitals[0].coefficients).toHaveLength(21);
    expect(parsed.alphaMOCoefficients).toHaveLength(6 * 21);
    expect(parsed.numberOfAlphaElectrons).toBe(5);
    expect(parsed.numberOfBetaElectrons).toBe(5);
    expect(parsed.numberOfElectrons).toBe(10);
  });

  it('accepts the older `<MO> index occupation energy` header', () => {
    const parsed = parseWfn(withOldMoHeaders(THREE_LINE));
    expect(parsed.orbitalEnergies).toEqual(ENERGIES);
    expect(parsed.occupations).toEqual(OCCUPATIONS);
    expect(parsed.alphaMOCoefficients.slice(6, 9)).toEqual([0.07, 0.1, 0.13]);
  });

  it('reads a $MOSPIN block and splits the alpha and beta manifolds', () => {
    const text = `${THREE_LINE.trimEnd()}\n $MOSPIN $END\n 1 1 1 2 2 2\n`;
    const parsed = parseWfn(text);
    expect(parsed.orbitals.map((orbital) => orbital.spin)).toEqual([
      'Alpha', 'Alpha', 'Alpha', 'Beta', 'Beta', 'Beta',
    ]);
    expect(parsed.alphaMOCoefficients).toHaveLength(3 * 21);
    expect(parsed.betaMOCoefficients).toHaveLength(3 * 21);
    expect(parsed.orbitalEnergiesBeta).toEqual([-0.4537, -0.3918, 0.1234]);
    expect(parsed.numberOfAlphaElectrons).toBe(6);
    expect(parsed.numberOfBetaElectrons).toBe(4);
    expect(parsed.numberOfElectrons).toBe(10);
  });

  it('carries fractional natural-orbital occupations without rounding them', () => {
    const text = THREE_LINE
      .replace(/OCC NO =\s+2\.0000000\s+ORB\. ENERGY =   -20\.240200/, 'OCC NO =     1.6300000  ORB. ENERGY =   -20.240200')
      .replace(/OCC NO =\s+2\.0000000\s+ORB\. ENERGY =    -1\.268300/, 'OCC NO =     0.3700000  ORB. ENERGY =    -1.268300');
    const parsed = parseWfn(text);
    expect(parsed.occupations[0]).toBe(1.63);
    expect(parsed.occupations[1]).toBe(0.37);
    // The total is still an integer, so the count can be reported; the
    // alpha/beta split cannot be derived without spin labels and is absent.
    expect(parsed.numberOfElectrons).toBe(8);
    expect(parsed.numberOfAlphaElectrons).toBeUndefined();
    expect(parsed.numberOfBetaElectrons).toBeUndefined();
    expect(parsed.warnings.join(' ')).toMatch(/alpha\/beta split cannot be derived/);
  });

  it('does not divide 0/1 occupations between alpha and beta without spin labels', () => {
    const text = THREE_LINE.replace(/OCC NO =\s+2\.0000000/g, 'OCC NO =     1.0000000');
    const parsed = parseWfn(text);
    expect(parsed.numberOfElectrons).toBe(5);
    expect(parsed.numberOfAlphaElectrons).toBeUndefined();
    expect(parsed.numberOfBetaElectrons).toBeUndefined();
    expect(parsed.warnings.join(' ')).toMatch(/alpha\/beta split is left absent/);
  });

  it('reads the END DATA energy and virial ratio', () => {
    const parsed = parseWfn(THREE_LINE);
    expect(parsed.totalEnergyHartree).toBeCloseTo(-75.987654321, 9);
    expect(parsed.virialRatio).toBeCloseTo(2.00412345, 8);
  });

  it('works in the existing orbital-gap view with no branch', () => {
    const parsed = parseWfn(THREE_LINE);
    const gap = orbitalGap(parsed);
    expect(gap.ok).toBe(true);
    expect(gap.homo.index).toBe(4);
    expect(gap.lumo.index).toBe(5);
    expect(gap.homo.energyHartree).toBeCloseTo(-0.3918, 8);
    expect(gap.gapHartree).toBeCloseTo(0.5152, 8);
  });
});

describe('WFN refusals by name', () => {
  it('refuses a truncated coefficient block with both numbers', () => {
    expect(() => parseWfn(dropLastCoefficient(THREE_LINE, 2)))
      .toThrow(/MO 2 has 20 coefficients but the basis has 21 primitive functions/);
  });

  it('refuses a coefficient block that is longer than the basis', () => {
    expect(() => parseWfn(addCoefficient(THREE_LINE, 2)))
      .toThrow(/MO 2 has 22 coefficients but the basis has 21 primitive functions/);
  });

  it('refuses an MO count that disagrees with the file', () => {
    const text = THREE_LINE.replace('6 MOL ORBITALS', '7 MOL ORBITALS');
    expect(() => parseWfn(text)).toThrow(/count line says 7 molecular orbitals but the file has 6 MO blocks/);
  });

  it('refuses a nucleus table shorter than the count line', () => {
    const text = THREE_LINE.replace(/^  H    3.*\n/m, '');
    expect(() => parseWfn(text)).toThrow(/nucleus table ends after 2 rows but the count line says 3 nuclei/);
  });

  it('refuses a non-numeric coefficient token with its line', () => {
    const text = THREE_LINE.replace('1.00000000D-2', 'one');
    expect(() => parseWfn(text)).toThrow(/MO 1 coefficients \(line \d+\) has the non-numeric token "one"/);
  });

  it('refuses a file that is not a WFN', () => {
    expect(() => parseWfn('just a title\nand nothing else\n')).toThrow(/No WFN count line was found/);
    expect(() => parseWfn('')).toThrow(/empty/);
  });

  it('enforces its size bound', () => {
    expect(() => parseWfn(THREE_LINE, { maxChars: 100 })).toThrow(/limit is 100/);
  });
});

describe('WFX reader', () => {
  const parsed = parseWfx(WFX);

  it('reads the title, version, atoms and counts', () => {
    expect(parsed.format).toBe('wfx');
    expect(parsed.title).toBe('synthetic water, WFX 1.0');
    expect(parsed.version).toBe('1.x (not stated in the file)');
    expect(parsed.numberOfAtoms).toBe(3);
    expect(parsed.atomicNumbers).toEqual([8, 1, 1]);
    expect(parsed.nuclearNames).toEqual(['O1', 'H2', 'H3']);
    expect(parsed.nuclearCharges).toEqual([8, 1, 1]);
    expect(parsed.atoms[1].x).toBeCloseTo(1.43044242 * BOHR_TO_ANGSTROM, 10);
    expect(parsed.coordinatesBohr[3]).toBeCloseTo(1.43044242, 10);
    expect(parsed.numberOfPrimitives).toBe(21);
    expect(parsed.numberOfBasisFunctions).toBe(21);
  });

  it('reads energies, occupations, spin types and coefficients', () => {
    expect(parsed.numberOfMolecularOrbitals).toBe(6);
    expect(parsed.orbitalEnergies).toEqual(ENERGIES);
    expect(parsed.occupations).toEqual(OCCUPATIONS);
    expect(parsed.orbitals.map((orbital) => orbital.spin)).toEqual(new Array(6).fill('Alpha and Beta'));
    expect(parsed.alphaMOCoefficients).toHaveLength(6 * 21);
    expect(parsed.alphaMOCoefficients.slice(6, 9)).toEqual([0.07, 0.1, 0.13]);
    expect(parsed.betaMOCoefficients).toBeUndefined();
  });

  it('reads the charge, electron counts, energy and virial ratio', () => {
    expect(parsed.charge).toBe(0);
    expect(parsed.numberOfElectrons).toBe(10);
    expect(parsed.numberOfAlphaElectrons).toBe(5);
    expect(parsed.numberOfBetaElectrons).toBe(5);
    expect(parsed.multiplicity).toBe(1);
    expect(parsed.totalEnergyHartree).toBeCloseTo(-75.987654321, 9);
    expect(parsed.virialRatio).toBeCloseTo(2.00412345, 8);
  });

  it('agrees with the WFN reader on the same synthetic wavefunction', () => {
    const wfn = parseWfn(THREE_LINE);
    expect(parsed.atomicNumbers).toEqual(wfn.atomicNumbers);
    expect(parsed.orbitalEnergies).toEqual(wfn.orbitalEnergies);
    expect(parsed.occupations).toEqual(wfn.occupations);
    expect(parsed.alphaMOCoefficients).toEqual(wfn.alphaMOCoefficients);
    expect(parsed.numberOfBasisFunctions).toBe(wfn.numberOfBasisFunctions);
  });

  it('works in the existing orbital-gap view with no branch', () => {
    const gap = orbitalGap(parsed);
    expect(gap.ok).toBe(true);
    expect(gap.gapHartree).toBeCloseTo(0.5152, 8);
  });

  it('keeps fractional natural-orbital occupations as written', () => {
    const text = WFX.replace(
      '<Molecular Orbital Occupation Numbers>\n2.00000000000000E+0\n2.00000000000000E+0',
      '<Molecular Orbital Occupation Numbers>\n1.63000000000000E+0\n0.37000000000000E+0',
    );
    const natural = parseWfx(text);
    expect(natural.occupations[0]).toBeCloseTo(1.63, 10);
    expect(natural.occupations[1]).toBeCloseTo(0.37, 10);
  });

  it('says an EDF section is present but not applied', () => {
    const text = WFX.replace(
      '</Number of Occupied Molecular Orbitals>',
      '</Number of Occupied Molecular Orbitals>\n<Additional Electron Density Function (EDF)>\n<Number of EDF Primitives>\n1\n</Number of EDF Primitives>\n</Additional Electron Density Function (EDF)>',
    );
    expect(parseWfx(text).edf).toMatchObject({ present: true, used: false });
  });

  it('refuses a WFX version outside the supported range', () => {
    const text = WFX.replace('<Title>', '<Version>\n2.0\n</Version>\n<Title>');
    const error = () => parseWfx(text);
    expect(error).toThrow(WfxFormatError);
    expect(error).toThrow(/states WFX version 2\.0; this reader supports 1\.x only/);
  });

  it('refuses a non-GTO keyword set', () => {
    const text = WFX.replace('<Keywords>\nGTO', '<Keywords>\nSTO');
    expect(() => parseWfx(text)).toThrow(/supports GTO \(Cartesian Gaussian\) primitives only/);
  });

  it('refuses a truncated coefficient block with both numbers', () => {
    const text = WFX.replace(/\s+2\.10000000000000E-1\n<\/Molecular Orbital Primitive Coefficients>/, '\n</Molecular Orbital Primitive Coefficients>');
    expect(() => parseWfx(text)).toThrow(/MO 6 has 20 coefficients but <Number of Primitives> says 21/);
  });

  it('refuses a coefficient block with the wrong number of MO sections', () => {
    const text = WFX.replace(
      /<MO Number>\n6\n<\/MO Number>\n(?:[^\n]*\n){6}<\/Molecular Orbital Primitive Coefficients>/,
      '</Molecular Orbital Primitive Coefficients>',
    );
    expect(() => parseWfx(text)).toThrow(/coefficient block has 5 <MO Number> sections but <Number of Occupied Molecular Orbitals> says 6/);
  });

  it('refuses a coordinate array that disagrees with the nucleus count', () => {
    const text = WFX.replace(
      /(<Nuclear Cartesian Coordinates>\n)(?:[^\n]*\n){3}/,
      '$1  0.0 0.0 0.0\n  0.0 0.0 0.0\n',
    );
    expect(() => parseWfx(text)).toThrow(/<Nuclear Cartesian Coordinates> has 6 values for 3 nuclei/);
  });

  it('refuses a file without the required sections', () => {
    expect(() => parseWfx('<Title>\nnothing\n</Title>\n')).toThrow(/no <Number of Nuclei>/);
    expect(() => parseWfx('')).toThrow(/empty/);
  });

  it('enforces its size bound', () => {
    expect(() => parseWfx(WFX, { maxChars: 100 })).toThrow(/limit is 100/);
  });
});

describe('WFN and WFX in the run record', () => {
  it('puts a WFN beside a cube in one record, with its header and MEP state', () => {
    const record = wavefunctionRecord([{ text: FIVE_LINE, filename: 'water.wfn' }]);
    expect(record.artifacts[0]).toMatchObject({ kind: 'wfn', file: 'water.wfn' });
    expect(record.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.fchk.format).toBe('wfn');
    expect(record.fchk.header.form).toBe('5-line');
    expect(record.fchk.mep.present).toBe(true);
    expect(record.fchk.orbitalGap.ok).toBe(true);
    expect(record.fchk.spin).toMatchObject({ ok: true, multiplicity: 1, unpairedElectrons: 0 });
    expect(record.fchk.chargeSanity.ok).toBe(false);
  });

  it('puts a WFX in the same block and reports its version and EDF state', () => {
    const record = wavefunctionRecord([{ text: WFX, filename: 'water.wfx' }]);
    expect(record.artifacts[0]).toMatchObject({ kind: 'wfx', file: 'water.wfx' });
    expect(record.fchk.format).toBe('wfx');
    expect(record.fchk.version).toBe('1.x (not stated in the file)');
    expect(record.fchk.edf).toMatchObject({ present: false, used: false });
    expect(record.fchk.orbitalGap.gapHartree).toBeCloseTo(0.5152, 8);
  });

  it('refuses a second wavefunction source in one record', () => {
    expect(() => wavefunctionRecord([
      { text: THREE_LINE, filename: 'a.wfn' },
      { text: WFX, filename: 'b.wfx' },
    ])).toThrow(/Only one checkpoint, Molden, WFN or WFX file/);
  });
});
