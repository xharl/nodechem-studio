import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCube } from '../src/shared/cubeFile.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');
const fixtures = path.join(root, 'test', 'fixtures');
const roots = [];

const DVB = path.join(fixtures, 'fchk', 'dvb-g16-b3lyp-sto3g.fchk');
const PSI4_FCHK = path.join(fixtures, 'psi4', 'water-b3lyp-631gd.fchk');
const MOLDEN = path.join(fixtures, 'molden', 'water-spherical-d.molden');

async function ncs(args, options = {}) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

async function scratch(prefix = 'ncs-cube-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  roots.length = 0;
});

describe('ncs cube — write one orbital as a Gaussian cube', () => {
  it('writes the HOMO of a real checkpoint and reports the grid and the integral it used', async () => {
    const dir = await scratch();
    const out = path.join(dir, 'dvb-homo.cube');
    const result = await ncs(['cube', DVB, '--orbital', 'homo', '--grid', '0.3', '--padding', '3', '--out', out, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);

    expect(payload.file).toBe(DVB);
    expect(payload.orbital).toMatchObject({ requested: 'homo', index: 35, label: 'MO 35 (homo)', occupation: 2 });
    // 70 electrons, 35 alpha: the HOMO of the fixture is orbital 35.
    expect(payload.energyEh).toBeCloseTo(-0.153072687, 9);
    expect(payload.grid.spacing).toBe(0.3);
    expect(payload.grid.capped).toBe(false);
    expect(payload.grid.points).toBeGreaterThan(1000);
    expect(payload.grid.note).toContain('points at 0.300');
    // ∫|ψ|² over the box: near 1 but never claimed to be exactly 1.
    expect(payload.integral.value).toBeGreaterThan(0.9);
    expect(payload.integral.value).toBeLessThan(1.1);
    expect(payload.integral.boxAngstrom3).toBeCloseTo(payload.grid.points * 0.3 ** 3, 6);
    expect(payload.integral.note).toMatch(/does not integrate to exactly 1/);
    expect(payload.wavefunction).toMatchObject({ kind: 'fchk', basisFunctions: 60 });

    const text = await readFile(out, 'utf8');
    const cube = parseCube(text);
    expect(cube.layout).toBe('standard');
    expect(cube.units.source).toBe('angstrom');
    expect(cube.dims.reduce((total, n) => total * n, 1)).toBe(payload.grid.points);
    expect(cube.atoms).toHaveLength(20);
    expect(cube.values.length).toBe(payload.grid.points);
    expect(cube.title[0]).toBe('MO 35 (homo) from dvb-g16-b3lyp-sto3g.fchk');
    expect(payload.bytes).toBe(Buffer.byteLength(text));
  }, 120000);

  it('takes the orbital by number, 1-based as the file prints it', async () => {
    const dir = await scratch();
    const out = path.join(dir, 'dvb-lumo.cube');
    const result = await ncs(['cube', DVB, '--orbital', 'lumo', '--grid', '0.6', '--padding', '2', '--out', out, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.orbital).toMatchObject({ requested: 'lumo', index: 36, occupation: 0 });
    expect(parseCube(await readFile(out, 'utf8')).dims).toEqual([24, 17, 8]);
  }, 120000);

  it('finds the one wavefunction in a run folder and accepts --key=value flags', async () => {
    const dir = await scratch();
    await copyFile(PSI4_FCHK, path.join(dir, 'water.fchk'));
    const out = path.join(dir, 'water-homo.cube');
    const result = await ncs(['cube', dir, '--orbital=HOMO', '--grid=0.5', '--padding=2', `--out=${out}`, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.file).toBe(path.join(dir, 'water.fchk'));
    expect(payload.orbital).toMatchObject({ requested: 'homo', index: 5 });
    expect(payload.grid.spacing).toBe(0.5);
    expect(payload.wavefunction.basisFunctions).toBe(18);
    expect(parseCube(await readFile(out, 'utf8')).atoms.map((atom) => atom.atomicNumber)).toEqual([8, 1, 1]);
  }, 120000);

  it('reads a Molden file and writes the density-free gamma of an orbital it carries', async () => {
    const dir = await scratch();
    const out = path.join(dir, 'molden-homo.cube');
    const result = await ncs(['cube', MOLDEN, '--orbital', 'homo', '--grid', '0.4', '--padding', '2', '--out', out, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.wavefunction.kind).toBe('molden');
    expect(payload.orbital.index).toBe(1);
    expect(parseCube(await readFile(out, 'utf8')).atoms).toHaveLength(3);
  }, 120000);

  it('prints the human summary with the integral and the file it wrote', async () => {
    const dir = await scratch();
    const out = path.join(dir, 'plain.cube');
    const result = await ncs(['cube', PSI4_FCHK, '--orbital', 'n=1', '--grid', '0.8', '--padding', '1', '--out', out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('orbital: MO 1 (n=1)');
    expect(result.stdout).toMatch(/energy: -19\.\d+ Eh/);
    expect(result.stdout).toMatch(/integral: ∫\|ψ\|²dV = \d+\.\d+ over .* Å³/);
    expect(result.stdout).toContain(`wrote: ${out}`);
  }, 120000);
});

describe('ncs cube — refusals', () => {
  it('refuses an orbital index the file does not have, and says how many it does', async () => {
    const dir = await scratch();
    const result = await ncs(['cube', DVB, '--orbital', 'n=61', '--grid', '0.6', '--out', path.join(dir, 'x.cube')]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/outside 1–60: the file has 60 alpha orbitals/);
  }, 120000);

  it('refuses an orbital request it does not understand', async () => {
    const dir = await scratch();
    const result = await ncs(['cube', DVB, '--orbital', 'somomo', '--out', path.join(dir, 'x.cube')]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--orbital takes homo, lumo or n=<i>/);
  }, 120000);

  it('refuses a folder with two wavefunctions instead of picking one', async () => {
    const dir = await scratch();
    await copyFile(PSI4_FCHK, path.join(dir, 'a.fchk'));
    await copyFile(MOLDEN, path.join(dir, 'b.molden'));
    const result = await ncs(['cube', dir, '--orbital', 'homo', '--out', path.join(dir, 'x.cube')]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/holds 2 wavefunction files \(a\.fchk, b\.molden\)/);
  }, 60000);

  it('refuses a folder with no wavefunction and a file that is not one', async () => {
    const dir = await scratch();
    await mkdir(path.join(dir, 'out'));
    await writeFile(path.join(dir, 'notes.txt'), 'nothing to evaluate\n', 'utf8');
    const folder = await ncs(['cube', path.join(dir, 'out'), '--orbital', 'homo', '--out', path.join(dir, 'x.cube')]);
    expect(folder.code).toBe(2);
    expect(folder.stderr).toMatch(/holds no wavefunction file/);

    const text = await ncs(['cube', path.join(dir, 'notes.txt'), '--orbital', 'homo', '--out', path.join(dir, 'x.cube')]);
    expect(text.code).toBe(2);
    expect(text.stderr).toMatch(/is not a wavefunction this build reads/);
  }, 60000);

  it('refuses a cube as the wavefunction, because it has no coefficients', async () => {
    const dir = await scratch();
    const cube = path.join(dir, 'in.cube');
    expect((await ncs(['cube', PSI4_FCHK, '--orbital', 'n=1', '--grid', '1', '--padding', '1', '--out', cube])).code).toBe(0);
    const result = await ncs(['cube', cube, '--orbital', 'homo', '--out', path.join(dir, 'x.cube')]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/is a cube, not a wavefunction/);
  }, 120000);

  it('requires --orbital and --out, and a positive --grid', async () => {
    const dir = await scratch();
    const noOrbital = await ncs(['cube', DVB, '--out', path.join(dir, 'x.cube')]);
    expect(noOrbital.code).toBe(1);
    expect(noOrbital.stderr).toMatch(/--orbital is required/);

    const noOut = await ncs(['cube', DVB, '--orbital', 'homo']);
    expect(noOut.code).toBe(1);
    expect(noOut.stderr).toMatch(/--out is required/);

    const badGrid = await ncs(['cube', DVB, '--orbital', 'homo', '--grid', '0', '--out', path.join(dir, 'x.cube')]);
    expect(badGrid.code).toBe(1);
    expect(badGrid.stderr).toMatch(/--grid needs a positive number of Å/);
  }, 60000);
});
