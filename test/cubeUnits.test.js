import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { BOHR_TO_ANGSTROM, parseCube } from '../src/shared/cubeFile.js';
import { fieldFromCube, sliceOfField } from '../src/shared/volume.js';

/**
 * The sign of a cube's grid count is the only statement of its units: negative
 * means the atom rows, origin and step vectors are Å, positive means bohr.
 * A reader that ignores it loads the field, draws the slice, and is wrong by
 * the bohr-to-Å factor everywhere — the silent class of defect this pair is
 * here to catch (issue 178).
 *
 * The pair in `test/fixtures/psi4/` is one Psi4 1.11 cube and its Å twin:
 *
 *   Psi_a_5_5-A-bohr.cube      captured from Psi4 1.11 (positive counts)
 *   Psi_a_5_5-A-angstrom.cube  the same bytes with an Å header (negative counts)
 *
 * The Å file is a conversion of the captured one, not a second capture: no
 * installed writer emits the negative-count form (see the README beside the
 * fixtures). That does not weaken what is asserted here, because every
 * expectation below is computed from the units *the file declares* — declared
 * bohr means the numbers are multiplied by the bohr radius once, declared Å
 * means they are used as written — and the values are the pair's shared,
 * unmodified data block.
 */
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => fs.readFileSync(path.join(FIXTURES, 'psi4', name), 'utf8');

const bohrText = read('Psi_a_5_5-A-bohr.cube');
const angstromText = read('Psi_a_5_5-A-angstrom.cube');
const bohr = parseCube(bohrText);
const angstrom = parseCube(angstromText);

/**
 * What the file itself says, read from the header rather than from the parser:
 * the counts (and so the units), the dims they imply, and the step vector of
 * each axis in the file's own units. Every expectation below is derived from
 * this, which is what makes a reader that assumes bohr fail.
 */
function declared(text) {
  const lines = text.split('\n');
  const rows = lines.slice(3, 6).map((line) => line.trim().split(/\s+/).map(Number));
  return {
    counts: rows.map((row) => row[0]),
    dims: rows.map((row) => Math.abs(row[0])),
    unit: rows[0][0] < 0 ? 'angstrom' : 'bohr',
    steps: rows.map((row) => Math.hypot(row[1], row[2], row[3])),
  };
}

const inAngstrom = (value, unit) => (unit === 'bohr' ? value * BOHR_TO_ANGSTROM : value);

describe('positive and negative grid counts — a captured Psi4 cube and its Å twin (issue 178)', () => {
  it('declares the same grid in both files and reports the same dims', () => {
    const bohrHeader = declared(bohrText);
    const angstromHeader = declared(angstromText);
    expect(bohrHeader.counts).toEqual([23, 17, 20]);
    expect(angstromHeader.counts).toEqual([-23, -17, -20]);
    expect(bohrHeader.unit).toBe('bohr');
    expect(angstromHeader.unit).toBe('angstrom');
    // dims are the absolute values of the counts, in both files.
    expect(bohrHeader.dims).toEqual(angstromHeader.dims);
    expect(bohr.dims).toEqual([23, 17, 20]);
    expect(angstrom.dims).toEqual(bohr.dims);
    expect(bohr.units.source).toBe('bohr');
    expect(angstrom.units.source).toBe('angstrom');
    expect(bohr.units.coordinates).toBe('angstrom');
    expect(angstrom.units.coordinates).toBe('angstrom');
  });

  it('gives the same step in Å from both files, computed from the units each one declares', () => {
    // The bohr file states 0.5 bohr; that is 0.2645886 Å, not 0.5 Å, and not
    // (0.5 bohr) scaled twice, which would be 0.14 Å.
    const bohrHeader = declared(bohrText);
    const angstromHeader = declared(angstromText);
    expect(bohrHeader.steps[0]).toBeCloseTo(0.5, 12);
    expect(angstromHeader.steps[0]).toBeCloseTo(0.264589, 9);

    const bohrStep = inAngstrom(bohrHeader.steps[0], bohrHeader.unit);
    const angstromStep = inAngstrom(angstromHeader.steps[0], angstromHeader.unit);
    expect(bohr.spacing[0]).toBeCloseTo(bohrStep, 12);
    expect(angstrom.spacing[0]).toBeCloseTo(angstromStep, 12);

    // The assertion the pair exists for: one physical grid, one step in Å.
    expect(angstrom.spacing[0]).toBeCloseTo(bohr.spacing[0], 5);
    expect(Math.abs(angstrom.spacing[0] - bohr.spacing[0]) / bohr.spacing[0]).toBeLessThan(5e-5);

    // And it is not any of the wrong answers: the raw number (a reader that
    // ignored the sign), or the number scaled twice (a reader that converted
    // the header and then the axes as well).
    expect(bohr.spacing[0]).not.toBeCloseTo(0.5, 3);
    expect(bohr.spacing[0]).not.toBeCloseTo(0.5 * BOHR_TO_ANGSTROM ** 2, 3);
    expect(angstrom.spacing[0]).not.toBeCloseTo(0.264589 * BOHR_TO_ANGSTROM, 3);
    for (const axis of [1, 2]) expect(angstrom.spacing[axis]).toBeCloseTo(angstrom.spacing[0], 12);
  });

  it('converts the origin and the atoms to Å in both files, and to the same place', () => {
    const bohrHeader = declared(bohrText);
    expect(bohr.origin[0]).toBeCloseTo(-5.5 * BOHR_TO_ANGSTROM, 9);
    expect(angstrom.origin[0]).toBeCloseTo(-2.910475, 9);
    // The same physical box read from either file: the Å file states the
    // converted numbers to six decimals, so the agreement is 1e-5, not exact.
    for (const axis of [0, 1, 2]) {
      expect(angstrom.origin[axis]).toBeCloseTo(bohr.origin[axis], 5);
    }
    // A box this size is a molecule in Å, not a 5-Å-per-side box in bohr.
    expect(Math.abs(bohr.origin[0])).toBeLessThan(3.5);
    expect(bohrHeader.steps[0]).toBeCloseTo(0.5, 12);

    expect(bohr.atoms.map((atom) => atom.atomicNumber)).toEqual([8, 1, 1]);
    expect(angstrom.atoms.map((atom) => atom.atomicNumber)).toEqual([8, 1, 1]);
    for (let atom = 0; atom < bohr.atoms.length; atom += 1) {
      for (const axis of ['x', 'y', 'z']) {
        expect(angstrom.atoms[atom][axis]).toBeCloseTo(bohr.atoms[atom][axis], 5);
      }
    }
    // O–H is 0.957 Å in this fixture: read as bohr it would be half that.
    const hydrogen = bohr.atoms[1];
    const oxygen = bohr.atoms[0];
    const distance = Math.hypot(
      hydrogen.x - oxygen.x,
      hydrogen.y - oxygen.y,
      hydrogen.z - oxygen.z,
    );
    expect(distance).toBeCloseTo(0.9572, 2);
  });

  it('evaluates the same slice from both, to the grid\'s own resolution', () => {
    const bohrField = fieldFromCube(bohr, { label: 'psi4 bohr' });
    const angstromField = fieldFromCube(angstrom, { label: 'psi4 angstrom' });
    expect(bohrField.step).toBeCloseTo(bohr.spacing[0], 12);
    expect(angstromField.step).toBeCloseTo(bohr.spacing[0], 5);
    // Same counts, same step in Å, so the cell volumes agree.
    expect(angstromField.cellVolumeAngstrom3).toBeCloseTo(bohrField.cellVolumeAngstrom3, 6);
    expect(angstromField.cellVolumeAngstrom3 / bohrField.cellVolumeAngstrom3).toBeCloseTo(1, 5);

    // The two files share their data block, so the slices carry the same
    // numbers; what differs is only where the header puts them, by less than
    // a millionth of the grid step. A reader that scaled one file twice would
    // put the slice's corner a factor of 1.89 away.
    for (const plane of ['xy', 'xz', 'yz']) {
      const fromBohr = sliceOfField(bohrField, { plane, offset: 0.5 });
      const fromAngstrom = sliceOfField(angstromField, { plane, offset: 0.5 });
      expect(fromAngstrom.width).toBe(fromBohr.width);
      expect(fromAngstrom.height).toBe(fromBohr.height);
      let largest = 0;
      for (let index = 0; index < fromBohr.values.length; index += 1) {
        largest = Math.max(largest, Math.abs(fromAngstrom.values[index] - fromBohr.values[index]));
      }
      expect(largest).toBe(0);
      for (const axis of [0, 1, 2]) {
        // A millionth of the grid step, against a step of a quarter of an ångström.
        expect(Math.abs(fromAngstrom.origin[axis] - fromBohr.origin[axis])).toBeLessThan(1e-4);
      }
    }
    // The values really are the field: the HOMO peak is not a flat slice.
    expect(bohrField.values.length).toBe(23 * 17 * 20);
    expect(Math.abs(bohr.stats.absMax)).toBeGreaterThan(0.1);
  });

  it('refuses a sign-flipped variant with a message that names units, not numbers', () => {
    // The Å header with its three minus signs removed claims bohr: every
    // distance in it would then be read 1.89 times too small.
    const flipped = angstromText
      .split('\n')
      .map((line, index) => (index >= 3 && index <= 5 ? line.replace(/^(\s*)-(\d+)/, '$1$2') : line))
      .join('\n');
    expect(declared(flipped).unit).toBe('bohr');
    expect(declared(flipped).counts).toEqual([23, 17, 20]);

    let message = '';
    try {
      parseCube(flipped, { units: 'angstrom' });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/declares its distances in bohr/);
    expect(message).toMatch(/read as angstrom/);
    // It names the units and the conversion; it does not argue in numbers.
    expect(message).not.toMatch(/\d\.\d/);
    expect(() => parseCube(flipped, { units: 'angstrom' })).toThrow(/positive grid counts/);

    // Read as what it now says it is, the flipped file parses — and its step is
    // wrong by the factor, which is exactly what the pair assertion above
    // catches when the two are compared.
    const wrong = parseCube(flipped, { units: 'bohr' });
    expect(Math.abs(wrong.spacing[0] - bohr.spacing[0])).toBeGreaterThan(0.1);

    // The same guard the other way round, and for a units name it does not know.
    expect(() => parseCube(bohrText, { units: 'angstrom' })).toThrow(/declares its distances in bohr/);
    expect(() => parseCube(bohrText, { units: 'angstrom' })).toThrow(/negative|positive/);
    expect(() => parseCube(bohrText, { units: 'furlongs' })).toThrow(/unknown units "furlongs"/);
    // The default is still to accept whatever the file declares.
    expect(parseCube(angstromText).units.source).toBe('angstrom');
  });
});

/**
 * The writer side: `ncs cube --units angstrom` must emit the negative counts,
 * and reading the file back must return the field that was evaluated. The
 * default is the form the command has always written (angstrom), so the two
 * are compared: same values, one header in Å and one in bohr.
 */
const run = promisify(execFile);
const roots = [];
afterEach(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  roots.length = 0;
});

async function ncs(args) {
  const cli = path.join(ROOT, 'bin', 'ncs.js');
  const result = await run(process.execPath, [cli, ...args], { cwd: ROOT });
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('ncs cube --units — the writer emits both conventions (issue 178)', () => {
  it('writes negative counts for angstrom and positive ones for bohr, and reads both back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-cube-units-'));
    roots.push(dir);
    const wavefunction = path.join(FIXTURES, 'psi4', 'water-b3lyp-631gd.fchk');
    const common = ['--orbital', 'homo', '--grid', '1', '--padding', '1', '--json'];

    const angstromOut = path.join(dir, 'homo-angstrom.cube');
    const bohrOut = path.join(dir, 'homo-bohr.cube');
    const defaultOut = path.join(dir, 'homo-default.cube');

    const fromAngstrom = await ncs(['cube', wavefunction, ...common, '--units', 'angstrom', '--out', angstromOut]);
    const fromBohr = await ncs(['cube', wavefunction, ...common, '--units', 'bohr', '--out', bohrOut]);
    const fromDefault = await ncs(['cube', wavefunction, ...common, '--out', defaultOut]);

    expect(JSON.parse(fromAngstrom.stdout).units).toMatchObject({ header: 'angstrom' });
    expect(JSON.parse(fromBohr.stdout).units).toMatchObject({ header: 'bohr' });

    const angstromText = await readFile(angstromOut, 'utf8');
    const bohrText = await readFile(bohrOut, 'utf8');
    expect(declared(angstromText).unit).toBe('angstrom');
    expect(declared(bohrText).unit).toBe('bohr');
    // --grid 1 Å: the Å header states 1, the bohr header 1.889.
    expect(declared(angstromText).steps[0]).toBeCloseTo(1, 6);
    expect(declared(bohrText).steps[0]).toBeCloseTo(1 / BOHR_TO_ANGSTROM, 6);

    const readAngstrom = parseCube(angstromText, { units: 'angstrom' });
    const readBohr = parseCube(bohrText, { units: 'bohr' });
    expect(readAngstrom.dims).toEqual(readBohr.dims);
    expect(readAngstrom.spacing[0]).toBeCloseTo(1, 6);
    expect(readBohr.spacing[0]).toBeCloseTo(readAngstrom.spacing[0], 6);
    for (const axis of [0, 1, 2]) {
      expect(readBohr.origin[axis]).toBeCloseTo(readAngstrom.origin[axis], 5);
    }
    for (let index = 0; index < readAngstrom.atoms.length; index += 1) {
      expect(readBohr.atoms[index].x).toBeCloseTo(readAngstrom.atoms[index].x, 5);
      expect(readBohr.atoms[index].y).toBeCloseTo(readAngstrom.atoms[index].y, 5);
      expect(readBohr.atoms[index].z).toBeCloseTo(readAngstrom.atoms[index].z, 5);
    }
    // The same evaluation, written twice: the values are identical.
    expect(readAngstrom.values.length).toBe(readBohr.values.length);
    let largest = 0;
    for (let index = 0; index < readAngstrom.values.length; index += 1) {
      largest = Math.max(largest, Math.abs(readAngstrom.values[index] - readBohr.values[index]));
    }
    expect(largest).toBe(0);
    // "homo" is MO 5 of this checkpoint; the values are not an empty field.
    expect(Math.abs(readAngstrom.stats.absMax)).toBeGreaterThan(0.01);

    // The default is unchanged: byte for byte what --units angstrom writes.
    expect(await readFile(defaultOut, 'utf8')).toBe(angstromText);
  }, 180000);

  it('refuses a units name it does not have, naming the two it does', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-cube-units-'));
    roots.push(dir);
    const wavefunction = path.join(FIXTURES, 'psi4', 'water-b3lyp-631gd.fchk');
    const result = await run(process.execPath, [
      path.join(ROOT, 'bin', 'ncs.js'),
      'cube', wavefunction, '--orbital', 'homo', '--units', 'furlongs', '--out', path.join(dir, 'x.cube'),
    ], { cwd: ROOT }).then(
      (output) => ({ code: 0, ...output }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--units takes angstrom or bohr/);
  }, 120000);
});
