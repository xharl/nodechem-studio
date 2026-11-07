import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverOutput, outputCandidates } from '../electron/runner/outputDiscovery.js';

const roots = [];

async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-output-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  roots.length = 0;
});

describe('outputCandidates', () => {
  it('tries both Gaussian extensions, requested file first', () => {
    expect(outputCandidates({ inputName: 'opt.gjf', outputName: 'opt.out' })).toEqual(['opt.out', 'opt.log']);
    expect(outputCandidates({ inputName: 'opt.gjf', outputName: 'opt.log' })).toEqual(['opt.log', 'opt.out']);
  });

  it('falls back to the input stem when no output name is given', () => {
    expect(outputCandidates({ inputName: 'ts_freq.com' })).toEqual(['ts_freq.out', 'ts_freq.log']);
  });

  it('refuses unsafe names instead of walking the filesystem', () => {
    expect(outputCandidates({ inputName: 'a b.gjf', outputName: 'a b.out' })).toEqual([]);
    expect(outputCandidates({ inputName: 'x.gjf', outputName: '../escape.out' })).toEqual(['x.out', 'x.log']);
  });
});

describe('discoverOutput', () => {
  it('finds a .log file when Gaussian ignored the requested .out', async () => {
    const cwd = await tempDir();
    await fsp.writeFile(path.join(cwd, 'job.log'), ' Normal termination of Gaussian 16\n', 'utf8');
    const found = await discoverOutput({ cwd, inputName: 'job.gjf', outputName: 'job.out', settleMs: 0 });
    expect(found).toMatchObject({ name: 'job.log', terminated: true });
    expect(found.size).toBeGreaterThan(0);
  });

  it('prefers the file that actually contains a termination record', async () => {
    const cwd = await tempDir();
    await fsp.writeFile(path.join(cwd, 'job.out'), ' SCF Done:  E(RB3LYP) = -76.0 A.U. after 8 cycles\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(path.join(cwd, 'job.log'), ' Normal termination of Gaussian 16\n', 'utf8');

    const found = await discoverOutput({ cwd, inputName: 'job.gjf', outputName: 'job.out', settleMs: 0 });
    expect(found.name).toBe('job.log');
  });

  it('returns null when the process wrote no output file', async () => {
    const cwd = await tempDir();
    expect(await discoverOutput({ cwd, inputName: 'job.gjf', outputName: 'job.out', settleMs: 0 })).toBeNull();
  });

  it('ignores an empty file', async () => {
    const cwd = await tempDir();
    await fsp.writeFile(path.join(cwd, 'job.out'), '', 'utf8');
    expect(await discoverOutput({ cwd, inputName: 'job.gjf', outputName: 'job.out', settleMs: 0 })).toBeNull();
  });
});
