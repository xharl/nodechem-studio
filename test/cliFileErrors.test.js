import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { validateProject } from '../src/shared/projectSchema.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * Issues 324 and 325 — what the CLI says when a path or a block id is wrong.
 *
 * 325: `ncs validate /some/directory` and a missing file printed a Node stack
 *      trace instead of one line, and every verb that takes a path had the same
 *      hole.
 * 324: `ncs convert --node <unknown>` ignored the id, converted the project's
 *      molecule instead, exited 0 and wrote a file beside the project.
 */

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');
const roots = [];

afterAll(async () => {
  await rmrfAll(roots.splice(0));
});

async function rmrfAll(targets) {
  await Promise.all(targets.map((target) => rmrf(target)));
}

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

/** A directory that is definitely not a project file, and a path that is absent. */
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ncs-errors-'));
  roots.push(dir);
  return dir;
}

/**
 * One calculation block and one note block, with a real geometry: the note has
 * no structure of its own, which is the case issue 324 wants named.
 */
async function projectFixture() {
  const dir = await tempDir();
  const project = JSON.parse(readFileSync(path.join(root, 'examples', 'single-point.ncs'), 'utf8'));
  project.molecule.coords = [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
    { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
  ];
  project.molecule.charge = 0;
  project.molecule.multiplicity = 1;
  project.molecule.geometry = { source: 'imported', file: 'water.xyz', format: 'xyz' };
  project.flows[0].nodes.push({
    id: 'note-1', type: 'note', title: 'Why this basis', note: { text: 'because' }, x: 60, y: 40,
  });
  const check = validateProject(project);
  expect(check.errors, 'the fixture must be a valid project').toEqual([]);
  const file = path.join(dir, 'water.ncs');
  await writeFile(file, JSON.stringify(project, null, 2), 'utf8');
  return { dir, file };
}

describe('ncs convert --node (issue 324)', () => {
  it('refuses an unknown block id instead of exporting the molecule', async () => {
    const { dir, file } = await projectFixture();
    const result = await ncs(['convert', file, '--node', 'no-such-node', '--format', 'xyz']);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no block "no-such-node"/);
    // The ids that do exist, so the caller can fix the typo.
    expect(result.stderr).toMatch(/sp-energy/);
    expect(result.stderr).toMatch(/note-1/);
    expect(result.stdout).toBe('');
    // Nothing was written: the command failed before it could guess a path.
    await expect(stat(path.join(dir, 'water.xyz'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a block that has no structure, by name and type', async () => {
    const { file } = await projectFixture();
    const result = await ncs(['convert', file, '--node', 'note-1', '--format', 'xyz']);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/block "note-1" is a note block/);
    expect(result.stderr).toMatch(/no structure to convert/);
  });

  it('writes the converted text to stdout when --out is absent', async () => {
    const { dir, file } = await projectFixture();
    const result = await ncs(['convert', file, '--node', 'sp-energy', '--format', 'xyz']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split('\n')[0].trim()).toBe('3');
    expect(result.stdout).toMatch(/O\s+0\.000000\s+0\.000000\s+0\.117300/);
    // No file is invented beside the project.
    await expect(stat(path.join(dir, 'water.xyz'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes exactly the named file when --out is given', async () => {
    const { dir, file } = await projectFixture();
    const out = path.join(dir, 'block.xyz');
    const result = await ncs(['convert', file, '--node', 'sp-energy', '--format', 'xyz', '--out', out]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/xyz written to .*block\.xyz/);
    expect((await readFile(out, 'utf8')).split('\n')[0].trim()).toBe('3');
  });

  it('is the same refusal in build-input and export-input', async () => {
    const { file } = await projectFixture();
    const built = await ncs(['build-input', file, '--node', 'no-such-node']);
    const exported = await ncs(['export-input', file, '--node', 'no-such-node', '--engine', 'nwchem']);

    expect(built.code).toBe(2);
    expect(exported.code).toBe(2);
    expect(built.stderr).toMatch(/no block "no-such-node".*blocks: sp-energy/);
    expect(exported.stderr).toMatch(/no block "no-such-node".*blocks: sp-energy/);
  });
});

describe('a path that cannot be read (issue 325)', () => {
  it.each([
    ['validate', (dir, missing) => ['validate', dir], /is a directory/],
    ['validate (missing)', (dir, missing) => ['validate', missing], /not found/],
    ['build-input', (dir) => ['build-input', dir, '--node', 'x'], /is a directory/],
    ['export-input', (dir, missing) => ['export-input', missing, '--node', 'x', '--engine', 'nwchem'], /not found/],
    ['convert', (dir) => ['convert', dir, '--format', 'xyz'], /is a directory/],
    ['cache', (dir, missing) => ['cache', missing], /not found/],
    ['cube', (dir, missing) => ['cube', missing, '--orbital', 'homo', '--out', path.join(dir, 'x.cube')], /not found/],
    ['qcschema import', (dir, missing) => ['qcschema', 'import', missing], /not found/],
  ])('%s says cannot read, with no stack trace', async (_label, args, reason) => {
    const dir = await tempDir();
    const missing = path.join(dir, 'absent.ncs');
    const result = await ncs(args(dir, missing));

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(reason);
    expect(result.stderr).toMatch(/cannot read /);
    // A stack trace is the bug: no "at async" frames, no internal/ path.
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toMatch(/node:internal/);
  });

  it('names the file it could not read, not just the reason', async () => {
    const dir = await tempDir();
    const result = await ncs(['validate', dir]);

    expect(result.stderr.trim()).toBe(`ncs: cannot read ${dir}: is a directory`);
  });
});
