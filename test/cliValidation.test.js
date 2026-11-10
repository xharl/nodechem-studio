import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');
const dirs = [];

async function ncs(args) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

async function caseFile(document) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ncs-validation-'));
  dirs.push(dir);
  const file = path.join(dir, 'cases.json');
  await writeFile(file, JSON.stringify(document), 'utf8');
  return { dir, file };
}

const CASES = {
  schemaVersion: 1,
  cases: [
    { id: 'water', reference: -76.4, rungs: [{ label: 'HF', energyHartree: -75.9 }, { label: 'DFT', energyHartree: -76.3 }] },
    { id: 'methane', reference: -40.5, rungs: [{ label: 'HF', energyHartree: -40.1 }, { label: 'DFT', energyHartree: -40.4 }] },
    { id: 'ammonia', reference: -56.5, rungs: [{ label: 'HF', energyHartree: -56.1 }, { label: 'DFT', energyHartree: -56.4 }] },
  ],
};

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ncs validation', () => {
  it('prints the table and writes the same table with --out', async () => {
    const { dir, file } = await caseFile(CASES);
    const result = await ncs(['validation', file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Validation matrix');
    expect(result.stdout).toContain('water\tHF');
    expect(result.stdout).toMatch(/aggregate: n=6 MAE=/);

    const out = path.join(dir, 'matrix.txt');
    const written = await ncs(['validation', file, '--out', out]);
    expect(written.code).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(result.stdout);
  });

  it('prints the same matrix as --json', async () => {
    const { file } = await caseFile(CASES);
    const result = await ncs(['validation', file, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.cases).toHaveLength(3);
    expect(payload.aggregate.n).toBe(6);
  });

  it('refuses a malformed case set with exit 2', async () => {
    const { file } = await caseFile({ schemaVersion: 1, cases: [] });
    const result = await ncs(['validation', file]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/validation case set/);
  });
});
