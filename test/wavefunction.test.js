import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOHR_TO_ANGSTROM, parseCube } from '../src/shared/cubeFile.js';
import { parseFchk } from '../src/shared/fchk.js';
import {
  HARTREE_TO_EV,
  buildWavefunctionRecord,
  chargeSanity,
  cubeSlice,
  cubeValueAt,
  detectWavefunctionFormat,
  orbitalGap,
  spinFromElectrons,
  suggestIsovalue,
  summariseIsosurface,
  wavefunctionRecord,
} from '../src/shared/wavefunction.js';

/** 3×2×2, values 1…12 in Fortran order, one oxygen at the origin. */
function cubeText({ negative = true, spacing = '1.0', dims = [3, 2, 2] } = {}) {
  return [
    'density',
    'generated for the test',
    `1 0.0 0.0 0.0`,
    '8 8.0 0.0 0.0 0.0',
    `  ${negative ? `-${dims[0]}` : dims[0]} ${spacing} 1.0 0.0 0.0`,
    `  ${negative ? `-${dims[1]}` : dims[1]} ${spacing} 0.0 1.0 0.0`,
    `  ${negative ? `-${dims[2]}` : dims[2]} ${spacing} 0.0 0.0 1.0`,
    Array.from({ length: 12 }, (_, index) => String(index + 1)).slice(0, 6).join(' '),
    Array.from({ length: 12 }, (_, index) => String(index + 1)).slice(6).join(' '),
  ].join('\n') + '\n';
}

const FCHK = [
  'water B3LYP/def2-SVP',
  'Number of atoms                            I                3',
  'Number of electrons                        I               10',
  'Charge                                     I                0',
  'Multiplicity                               I                1',
  'Number of alpha electrons                  I                5',
  'Number of beta electrons                   I                5',
  'Atomic numbers                             I   N=           3',
  '           8           1           1',
  'Orbital Energies                          R   N=           6',
  ' -2.00000000E+01 -1.40000000E+00 -7.00000000E-01 -3.00000000E-01  1.00000000E-01',
  '  2.00000000E-01',
  'Mulliken Charges                          R   N=           3',
  ' -8.00000000E-01  4.00000000E-01  4.00000000E-01',
  'Total Energy                               R     -7.60000000E+01',
].join('\n');

describe('format detection', () => {
  it('tells a cube from a checkpoint by content, not by name', () => {
    expect(detectWavefunctionFormat(cubeText())).toBe('cube');
    expect(detectWavefunctionFormat(FCHK)).toBe('fchk');
    expect(detectWavefunctionFormat('a random text file\nwith lines')).toBe('');
    expect(detectWavefunctionFormat('')).toBe('');
  });
});

describe('cube values', () => {
  it('returns the grid value exactly at a node', () => {
    const cube = parseCube(cubeText());
    expect(cubeValueAt(cube, [0, 0, 0])).toBeCloseTo(1, 12);
    expect(cubeValueAt(cube, [2, 1, 1])).toBeCloseTo(12, 12);
    expect(cubeValueAt(cube, [2, 0, 0])).toBeCloseTo(3, 12);
  });

  it('interpolates trilinearly between nodes', () => {
    const cube = parseCube(cubeText());
    // Halfway between the values 1 and 2 along x.
    expect(cubeValueAt(cube, [0.5, 0, 0])).toBeCloseTo(1.5, 12);
    // Centre of the cell is the mean of the eight corner values.
    expect(cubeValueAt(cube, [0.5, 0.5, 0.5])).toBeCloseTo((1 + 2 + 4 + 5 + 7 + 8 + 10 + 11) / 8, 12);
  });

  it('returns null outside the grid instead of zero', () => {
    const cube = parseCube(cubeText());
    expect(cubeValueAt(cube, [-0.1, 0, 0])).toBeNull();
    expect(cubeValueAt(cube, [2.1, 0, 0])).toBeNull();
    expect(cubeValueAt(cube, [0, 0, 2])).toBeNull();
  });

  it('refuses a degenerate grid rather than dividing by zero', () => {
    const flat = parseCube(cubeText());
    flat.axes = [[1, 0, 0], [2, 0, 0], [0, 0, 1]];
    expect(cubeValueAt(flat, [0.5, 0.5, 0.5])).toBeNull();
  });

  it('converts units once: a bohr grid is addressed in Å', () => {
    // 1 bohr per voxel. The second voxel is at 0.529 Å and must hold value 2;
    // a second conversion would put it at 0.28 Å and this would interpolate
    // between voxels instead of landing on one.
    const cube = parseCube(cubeText({ negative: false, spacing: '1.0', dims: [3, 2, 2] }));
    expect(cube.spacing[0]).toBeCloseTo(BOHR_TO_ANGSTROM, 12);
    expect(cubeValueAt(cube, [BOHR_TO_ANGSTROM, 0, 0])).toBeCloseTo(2, 12);
    expect(cubeValueAt(cube, [BOHR_TO_ANGSTROM * 2, 0, 0])).toBeCloseTo(3, 12);
    // Halfway between the second and third point is halfway between 2 and 3.
    expect(cubeValueAt(cube, [BOHR_TO_ANGSTROM * 1.5, 0, 0])).toBeCloseTo(2.5, 12);
    expect(cubeValueAt(cube, [1.2, 0, 0])).toBeNull();
  });
});

describe('cube slices', () => {
  it('extracts an xy plane', () => {
    const cube = parseCube(cubeText());
    const slice = cubeSlice(cube, { axis: 'z', index: 0 });
    expect(slice.width).toBe(3);
    expect(slice.height).toBe(2);
    expect(slice.columns).toBe('x');
    expect(slice.rows).toBe('y');
    expect(slice.origin).toEqual([0, 0, 0]);
    expect(Array.from(slice.values)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slice.min).toBe(1);
    expect(slice.max).toBe(6);
  });

  it('extracts the far plane with the right origin', () => {
    const slice = cubeSlice(parseCube(cubeText()), { axis: 'z', index: 1 });
    expect(slice.origin).toEqual([0, 0, 1]);
    expect(Array.from(slice.values)).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('extracts an xz plane with rows and columns named', () => {
    const slice = cubeSlice(parseCube(cubeText()), { axis: 'y', index: 0 });
    expect(slice.columns).toBe('x');
    expect(slice.rows).toBe('z');
    // z=0 row is 1,2,3; z=1 row is 7,8,9.
    expect(Array.from(slice.values)).toEqual([1, 2, 3, 7, 8, 9]);
  });

  it('refuses an index outside the grid', () => {
    expect(() => cubeSlice(parseCube(cubeText()), { axis: 'z', index: 2 })).toThrow(/0 to 1/);
    expect(() => cubeSlice(parseCube(cubeText()), { axis: 'w', index: 0 })).toThrow(/axis/);
  });
});

describe('isosurfaces', () => {
  it('counts both phases and reports the cell fraction', () => {
    const cube = parseCube(cubeText());
    const summary = summariseIsosurface(cube, { isovalue: 8 });
    expect(summary.positive.voxels).toBe(5);
    expect(summary.negative.voxels).toBe(0);
    expect(summary.positive.fraction).toBeCloseTo(5 / 12, 12);
    expect(summary.cellVolumeAngstrom3).toBeCloseTo(12, 12);
    expect(summary.positive.volumeAngstrom3).toBeCloseTo(5, 12);
    // Values 8…12 sit on the z = 1 plane (8 9 10 11 12 are the top slab).
    expect(summary.extent.min).toEqual([0, 0, 1]);
    expect(summary.extent.max).toEqual([2, 1, 1]);
  });

  it('counts negative lobes separately', () => {
    const cube = parseCube(cubeText());
    for (let index = 0; index < cube.values.length; index += 1) cube.values[index] -= 6.5;
    const summary = summariseIsosurface(cube, { isovalue: 2 });
    expect(summary.positive.voxels).toBe(4);
    expect(summary.negative.voxels).toBe(4);
    expect(summary.extent).not.toBeNull();
  });

  it('reports no extent when nothing reaches the isovalue', () => {
    const summary = summariseIsosurface(parseCube(cubeText()), { isovalue: 100 });
    expect(summary.positive.voxels).toBe(0);
    expect(summary.extent).toBeNull();
  });

  it('refuses a zero or negative isovalue', () => {
    expect(() => summariseIsosurface(parseCube(cubeText()), { isovalue: 0 })).toThrow(/greater than zero/);
    expect(() => summariseIsosurface(parseCube(cubeText()), {})).toThrow(/greater than zero/);
  });

  it('suggests an isovalue that encloses the requested fraction', () => {
    const cube = parseCube(cubeText());
    expect(suggestIsovalue(cube, { fraction: 0.25 })).toBe(10);
    expect(suggestIsovalue(cube, { fraction: 0.5 })).toBe(7);
    expect(() => suggestIsovalue(cube, { fraction: 1 })).toThrow(/between 0 and 1/);
  });
});

describe('orbital gap', () => {
  it('computes HOMO/LUMO from the alpha count', () => {
    const gap = orbitalGap(parseFchk(FCHK));
    expect(gap.ok).toBe(true);
    expect(gap.homo.index).toBe(4);
    expect(gap.lumo.index).toBe(5);
    expect(gap.homo.energyHartree).toBeCloseTo(0.1, 12);
    expect(gap.lumo.energyHartree).toBeCloseTo(0.2, 12);
    expect(gap.gapHartree).toBeCloseTo(0.1, 12);
    expect(gap.gapEv).toBeCloseTo(0.1 * HARTREE_TO_EV, 10);
    expect(gap.gapEv).toBeCloseTo(2.7211386246, 8);
    expect(gap.note).toMatch(/not the fundamental gap/);
  });

  it('says why it cannot compute a gap instead of returning a number', () => {
    const noElectrons = parseFchk(FCHK.replace(/Number of alpha electrons.*\n/, ''));
    expect(orbitalGap(noElectrons)).toEqual({
      ok: false,
      reason: 'the checkpoint has no "Number of alpha electrons", so the occupied orbitals cannot be identified',
    });

    const allOccupied = { ...parseFchk(FCHK), numberOfAlphaElectrons: 6 };
    expect(orbitalGap(allOccupied).ok).toBe(false);
    expect(orbitalGap(allOccupied).reason).toMatch(/no LUMO/);

    expect(orbitalGap({}).ok).toBe(false);
  });

  it('reports the beta gap when a spin-2 array is present', () => {
    const uhf = FCHK.replace(
      '  2.00000000E-01',
      '  2.00000000E-01\nOrbital Energies, spin 2                  R   N=           6\n'
      + ' -2.00000000E+01 -1.50000000E+00 -8.00000000E-01 -4.00000000E-01  5.00000000E-02\n'
      + '  2.50000000E-01',
    );
    const gap = orbitalGap(parseFchk(uhf));
    expect(gap.ok).toBe(true);
    expect(gap.beta.gapHartree).toBeCloseTo(0.2, 12);
    expect(gap.beta.homo.energyHartree).toBeCloseTo(0.05, 12);
  });
});

describe('spin and charge sanity', () => {
  it('derives the multiplicity from the alpha/beta counts', () => {
    const spin = spinFromElectrons(parseFchk(FCHK));
    expect(spin).toMatchObject({ ok: true, alpha: 5, beta: 5, unpairedElectrons: 0, multiplicity: 1, s: 0 });
    expect(spin.sSquared).toBe(0);
    const doublet = spinFromElectrons({ numberOfAlphaElectrons: 5, numberOfBetaElectrons: 4 });
    expect(doublet).toMatchObject({ ok: true, unpairedElectrons: 1, multiplicity: 2, s: 0.5 });
    expect(doublet.sSquared).toBeCloseTo(0.75, 12);
    expect(doublet.note).toMatch(/spin-contaminated/);
  });

  it('says why it cannot derive a spin state', () => {
    expect(spinFromElectrons({})).toEqual({ ok: false, reason: 'the checkpoint has no "Number of alpha/beta electrons" pair' });
  });

  it('checks the Mulliken sum against the stated charge', () => {
    const charge = chargeSanity(parseFchk(FCHK));
    expect(charge.ok).toBe(true);
    expect(charge.source).toBe('mulliken');
    expect(charge.expectedFrom).toBe('the checkpoint Charge field');
    expect(charge.chargeSum).toBeCloseTo(0, 12);
    expect(charge.deviation).toBeCloseTo(0, 12);
    expect(charge.withinTolerance).toBe(true);
  });

  it('flags a charge sum that does not match the total charge', () => {
    const shifted = parseFchk(FCHK.replace(' -8.00000000E-01  4.00000000E-01  4.00000000E-01', ' -7.00000000E-01  4.00000000E-01  4.00000000E-01'));
    const charge = chargeSanity(shifted);
    expect(charge.ok).toBe(true);
    expect(charge.chargeSum).toBeCloseTo(0.1, 12);
    expect(charge.deviation).toBeCloseTo(0.1, 12);
    expect(charge.withinTolerance).toBe(false);
  });

  it('derives the total charge when the file has no Charge field', () => {
    const derived = parseFchk(FCHK.replace(/Charge +I +0\n/, ''));
    const charge = chargeSanity(derived);
    expect(charge.expectedFrom).toBe('nuclear charge minus electron count');
    expect(charge.expectedCharge).toBe(0);
  });

  it('falls back to the ESP charges and labels the source', () => {
    const esp = parseFchk(FCHK.replace('Mulliken Charges', 'ESP Charges'));
    const charge = chargeSanity(esp);
    expect(charge.source).toBe('esp');
  });

  it('says why it cannot check charges', () => {
    const without = parseFchk(FCHK.replace(/Mulliken Charges[\s\S]*$/, '').trimEnd());
    expect(chargeSanity(without)).toEqual({ ok: false, reason: 'the checkpoint has neither "Mulliken Charges" nor "ESP Charges"' });
  });
});

describe('run record block', () => {
  it('summarises the files without copying the grid', () => {
    const record = wavefunctionRecord([
      { text: cubeText(), filename: 'density.cube' },
      { text: FCHK, filename: 'water.fchk' },
    ]);
    expect(record.version).toBe(1);
    expect(record.artifacts).toHaveLength(2);
    expect(record.artifacts[0]).toMatchObject({ kind: 'cube', file: 'density.cube' });
    expect(record.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.artifacts[0].bytes).toBeGreaterThan(0);
    expect(record.artifacts[1]).toMatchObject({ kind: 'fchk', file: 'water.fchk' });
    expect(record.cube.dims).toEqual([3, 2, 2]);
    expect(record.cube.values).toBeUndefined();
    expect(record.cube.stats.max).toBe(12);
    expect(record.fchk.orbitalGap.gapEv).toBeCloseTo(2.7211386246, 8);
    expect(record.fchk.chargeSanity.withinTolerance).toBe(true);
    expect(record.fchk.totalEnergyHartree).toBeCloseTo(-76, 12);
  });

  it('never writes a field the checkpoint did not carry', () => {
    const record = wavefunctionRecord([{ text: FCHK, filename: 'water.fchk' }]);
    expect('virialRatio' in record.fchk).toBe(false);
    expect(record.fchk.fields.missing).toContain('virialRatio');
    expect(record.fchk.fields.found).toContain('orbitalEnergies');
    expect(record.cube).toBeUndefined();
  });

  it('carries completion, revision and dimension evidence into the record (#244-#246)', () => {
    const text = readFileSync('test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk', 'utf8');
    const record = wavefunctionRecord([{ text, filename: 'dvb.fchk' }]);
    expect(record.fchk.jobStatus).toBe(1);
    expect(record.fchk.version).toBe('ES64L-G16RevA.03');
    expect(record.fchk.fullTitle).toBe('dvb');
    expect(record.fchk.route).toBe('#p b3lyp/sto-3g opt');
    expect(record.fchk.numberOfIndependentFunctions).toBe(60);
    expect(record.fchk.iopcl).toBe(0);
    expect(record.fchk.fields.found).toEqual(expect.arrayContaining([
      'jobStatus', 'version', 'numberOfIndependentFunctions', 'iopcl',
    ]));
    expect(record.fchk.warnings).toEqual([]);
  });

  it('keeps an absent Job Status absent in the record and reports why', () => {
    const text = readFileSync('test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk', 'utf8')
      .replace(/^Job Status.*\r?\n/m, '');
    const record = wavefunctionRecord([{ text, filename: 'dvb.fchk' }]);
    expect('jobStatus' in record.fchk).toBe(false);
    expect(record.fchk.fields.missing).toContain('jobStatus');
    expect(record.fchk.warnings).toEqual([]);
  });

  it('keeps a provided digest instead of recomputing it', () => {
    const record = wavefunctionRecord([{ text: cubeText(), filename: 'd.cube', sha256: 'f'.repeat(64) }]);
    expect(record.artifacts[0].sha256).toBe('f'.repeat(64));
  });

  it('is JSON-serialisable as it stands', () => {
    const record = buildWavefunctionRecord({
      cube: parseCube(cubeText()),
      fchk: parseFchk(FCHK),
      artifacts: [{ kind: 'cube', file: 'd.cube', sha256: 'a'.repeat(64), bytes: 10 }],
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it('refuses two cubes in one record and an empty record', () => {
    expect(() => wavefunctionRecord([
      { text: cubeText(), filename: 'a.cube' },
      { text: cubeText(), filename: 'b.cube' },
    ])).toThrow(/Only one cube/);
    expect(() => buildWavefunctionRecord({})).toThrow(/at least one of cube or fchk/);
  });

  it('names the file that is neither format', () => {
    expect(() => wavefunctionRecord([{ text: 'hello', filename: 'notes.txt' }]))
      .toThrow(/notes.txt is neither a Gaussian cube nor a formatted checkpoint/);
  });
});
