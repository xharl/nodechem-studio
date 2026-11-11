import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunManager } from '../electron/runner/runManager.js';
import { wavefunctionForRun } from '../electron/runner/runManager.js';
import { validateRecord } from '../schemas/record-schema.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * Issue 334 — no run.json carried a `wavefunction` block.
 *
 * `wavefunctionRecord()` was called only from tests, so the dataset export's
 * checkpoint columns and the wavefunction view read a field a shipped build never
 * wrote. The runner now calls it when the run folder carries a wavefunction file.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const FCHK = path.join(root, 'test', 'fixtures', 'esp', 'he-sto3g.fchk');

const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rmrf(dir)));
});

/** A finished-enough run folder: the minimum `finish()` reads and rewrites. */
async function runDir() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-wavefunction-'));
  dirs.push(base);
  const runDirPath = path.join(base, 'run-1');
  await fsp.mkdir(runDirPath, { recursive: true });
  const record = {
    schemaVersion: 1,
    id: 'run-1',
    status: 'running',
    engine: 'psi4',
    argv: ['sp.dat'],
    dryRun: false,
    title: 'sp',
    inputName: 'sp.dat',
    outputName: 'sp.out',
    outputFile: null,
    outputSource: null,
    truncated: false,
    outputBytes: null,
    executable: '/usr/bin/psi4',
    scratchDir: null,
    checkpointHandoff: null,
    inputSha256: 'a'.repeat(64),
    outputSha256: null,
    provenance: { kind: 'calculation', jobType: 'SP', method: {}, input: { name: 'sp.dat', bytes: 10 }, output: null },
    startedAt: '2026-11-11T00:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    parsed: null,
    gates: null,
    error: null,
  };
  await fsp.writeFile(path.join(runDirPath, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
  return runDirPath;
}

describe('the wavefunction block a run record carries (issue 334)', () => {
  it('scans a run folder and builds the block from a real fchk', async () => {
    const dir = await runDir();
    await fsp.copyFile(FCHK, path.join(dir, 'he.fchk'));

    const block = await wavefunctionForRun(dir);
    expect(block).toBeTruthy();
    expect(block.version).toBe(1);
    expect(block.artifacts).toEqual([expect.objectContaining({
      kind: 'fchk',
      file: 'he.fchk',
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })]);
    // The numbers the dataset export reads are there, not just the file name.
    expect(block.fchk.numberOfBasisFunctions).toBeGreaterThan(0);
    expect(block.fchk.fields.found.length).toBeGreaterThan(0);
  });

  it('returns null for a folder with no wavefunction file', async () => {
    const dir = await runDir();
    expect(await wavefunctionForRun(dir)).toBeNull();
  });

  it('writes the block into run.json when the run settles', async () => {
    const dir = await runDir();
    await fsp.copyFile(FCHK, path.join(dir, 'he.fchk'));
    const manager = new RunManager({ runsRoot: path.join(path.dirname(dir), 'runs'), emit: () => {} });

    const context = {
      runId: 'run-1',
      runDir: dir,
      finished: false,
      outputMeta: {},
      outputText: '',
      stderr: '',
      engineId: 'psi4',
      scratch: null,
      scratchExhausted: false,
    };
    await manager.finish(context, {
      status: 'completed', exitCode: 0, parsed: {}, gates: null, error: null,
    });

    const record = JSON.parse(await fsp.readFile(path.join(dir, 'run.json'), 'utf8'));
    expect(record.status).toBe('completed');
    expect(record.wavefunction.artifacts[0]).toMatchObject({ kind: 'fchk', file: 'he.fchk' });
    // The record is still a valid v1 and v2 document — the envelope is closed.
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    expect(validateRecord(record, { version: 2 }).errors).toEqual([]);
  });

  it('leaves the field off a run that carried no wavefunction file', async () => {
    const dir = await runDir();
    const manager = new RunManager({ runsRoot: path.join(path.dirname(dir), 'runs'), emit: () => {} });
    await manager.finish({
      runId: 'run-1', runDir: dir, finished: false, outputMeta: {}, outputText: '', stderr: '',
      engineId: 'psi4', scratch: null, scratchExhausted: false,
    }, { status: 'completed', exitCode: 0, parsed: {}, gates: null, error: null });

    const record = JSON.parse(await fsp.readFile(path.join(dir, 'run.json'), 'utf8'));
    expect(record).not.toHaveProperty('wavefunction');
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
  });
});
