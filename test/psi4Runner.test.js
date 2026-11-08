import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Psi4Runner } from '../electron/runner/psi4Runner.js';
import { RunManager } from '../electron/runner/runManager.js';
import { makePsi4FixtureOutput, parsePsi4Output } from '../src/shared/engines/psi4.js';

/**
 * The Psi4 runner, exercised without Psi4.
 *
 * No Psi4 installation exists on this machine, so every test drives a shell
 * script that is not Psi4: it prints the documented fixture text, an error
 * banner, or nothing. That proves the runner's own job — spawn, capture,
 * threads from the environment, artifact write, cancellation, timeout — and
 * nothing about Psi4 itself.
 */
const canSpawnShell = process.platform !== 'win32';
const FIXTURE = makePsi4FixtureOutput();

async function sandbox() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-psi4-'));
}

async function fakePsi4(root, { payload = FIXTURE, exitCode = 0, stderr = '', sleepMs = 0 } = {}) {
  const dir = await fsp.mkdtemp(path.join(root, 'bin-'));
  const script = path.join(dir, 'psi4');
  await fsp.writeFile(path.join(dir, 'payload.txt'), payload, 'utf8');
  await fsp.writeFile(script, [
    '#!/bin/sh',
    sleepMs > 0 ? `sleep ${sleepMs / 1000}` : '',
    stderr ? `printf '%s\\n' '${stderr}' >&2` : '',
    'cat "$(dirname "$0")/payload.txt"',
    `exit ${exitCode}`,
    '',
  ].join('\n'), 'utf8');
  await fsp.chmod(script, 0o755);
  return script;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!canSpawnShell)('Psi4Runner', () => {
  it('captures stdout into the run artifact and keeps stderr apart', async () => {
    const root = await sandbox();
    const executable = await fakePsi4(root, { stderr: 'PSIDATADIR is not set' });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    await fsp.writeFile(path.join(cwd, 'water.dat'), 'molecule {}\n', 'utf8');

    const result = await new Psi4Runner().run({
      executable, argv: ['water.dat'], cwd, outputName: 'water.out',
    });

    const written = await fsp.readFile(path.join(cwd, 'water.out'), 'utf8');
    expect(written).toContain('Psi4 exiting successfully');
    expect(written).not.toContain('PSIDATADIR is not set');
    expect(result.stderr.trim()).toBe('PSIDATADIR is not set');
    expect(result.exitCode).toBe(0);
    expect(result.outputSource).toBe('stdout');
    expect(parsePsi4Output(written).finalEnergy.hartree).toBeCloseTo(-76.42139511922374, 9);
  });

  it('passes the thread count to Psi4 through the environment', async () => {
    const root = await sandbox();
    const dir = await fsp.mkdtemp(path.join(root, 'bin-'));
    const script = path.join(dir, 'psi4');
    await fsp.writeFile(script, '#!/bin/sh\nprintf "threads=%s mkl=%s\\n" "$OMP_NUM_THREADS" "$MKL_NUM_THREADS"\n', 'utf8');
    await fsp.chmod(script, 0o755);
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const result = await new Psi4Runner().run({
      executable: script, argv: ['job.dat'], cwd, outputName: 'job.out', threads: 3,
    });
    expect(result.outputText.trim()).toBe('threads=3 mkl=3');
  });

  it('refuses a nonsense thread count instead of silently using one', () => {
    expect(() => Psi4Runner.environmentFor({ threads: '0' })).toThrow(/between 1 and 256/);
    expect(() => Psi4Runner.environmentFor({ threads: 'many' })).toThrow(/between 1 and 256/);
  });

  it('cancels the whole process group', async () => {
    const root = await sandbox();
    const executable = await fakePsi4(root, { sleepMs: 5000 });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const runner = new Psi4Runner();
    const running = runner.run({ executable, argv: ['job.dat'], cwd, outputName: 'job.out' });
    await sleep(200);
    runner.cancel();
    const result = await running;
    expect(result.cancelled).toBe(true);
  });

  it('honours a timeout by cancelling', async () => {
    const root = await sandbox();
    const executable = await fakePsi4(root, { sleepMs: 5000 });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const started = Date.now();
    const result = await new Psi4Runner().run({
      executable, argv: ['job.dat'], cwd, outputName: 'job.out', timeoutMs: 300,
    });
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('reads the log Psi4 writes itself instead of clobbering it with an empty capture', async () => {
    // Psi4 1.9+ writes `<input>.out` in the working directory and prints
    // nothing to stdout. Writing our capture over that file would destroy the
    // only record of the calculation.
    const root = await sandbox();
    const dir = await fsp.mkdtemp(path.join(root, 'bin-'));
    const script = path.join(dir, 'psi4');
    await fsp.writeFile(path.join(dir, 'payload.txt'), FIXTURE, 'utf8');
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'job="$1"',
      'cp "$(dirname "$0")/payload.txt" "${job%.dat}.out"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    await fsp.chmod(script, 0o755);
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));

    const result = await new Psi4Runner().run({
      executable: script, argv: ['job.dat'], cwd, outputName: 'job.out',
    });

    expect(result.outputText).toContain('Psi4 exiting successfully');
    expect(result.outputSource).toBe('file');
    expect(await fsp.readFile(path.join(cwd, 'job.out'), 'utf8')).toContain('FIXTURE OUTPUT');
  });

  it('refuses a run with no arguments', async () => {
    await expect(new Psi4Runner().run({ executable: '/bin/true', argv: [], cwd: os.tmpdir(), outputName: 'x.out' }))
      .rejects.toThrow(/no arguments/);
  });
});

describe.skipIf(!canSpawnShell)('RunManager with the Psi4 engine', () => {
  async function startRun(script, overrides = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-psi4-run-'));
    const events = [];
    const manager = new RunManager({ runsRoot: root, emit: (event) => events.push(event) });
    const started = await manager.start({
      title: 'water single point',
      engine: 'psi4',
      argv: ['water.dat'],
      route: 'psi4 B3LYP/def2-SVP',
      inputText: 'molecule {\n0 1\nO 0 0 0\nH 0.7 0.5 0\nH -0.7 0.5 0\n}\nset basis def2-svp\nenergy(\'b3lyp\')\n',
      inputName: 'water.dat',
      outputName: 'water.out',
      executable: script,
      gates: { requireFinalEnergy: true },
      ...overrides,
    });
    const deadline = Date.now() + 20_000;
    let record = null;
    while (Date.now() < deadline) {
      const raw = await fsp.readFile(path.join(started.runDir, 'run.json'), 'utf8').catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.status !== 'running') { record = parsed; break; }
      }
      await sleep(100);
    }
    if (!record) throw new Error('run did not finish');
    return { record, events, runDir: started.runDir };
  }

  it('writes a record with the engine, the energy and the captured stream', async () => {
    const script = await fakePsi4(await sandbox());
    const { record, runDir } = await startRun(script);

    expect(record.engine).toBe('psi4');
    expect(record.status).toBe('completed');
    expect(record.outputSource).toBe('stdout');
    expect(record.parsed.engine).toBe('psi4');
    expect(record.parsed.finalEnergy.hartree).toBeCloseTo(-76.42139511922374, 9);
    expect(record.outputName).toBe('water.out');
    const written = await fsp.readFile(path.join(runDir, 'water.out'), 'utf8');
    expect(written).toContain('Psi4 exiting successfully');
  });

  it('a dry run records the Psi4 engine and a labelled fixture', async () => {
    const { record, runDir } = await startRun('/bin/false', { dryRun: true });
    expect(record.engine).toBe('psi4');
    expect(record.dryRun).toBe(true);
    expect(record.status).toBe('completed');
    expect(record.outputSource).toBe('fixture');
    expect(await fsp.readFile(path.join(runDir, 'water.out'), 'utf8')).toContain('FIXTURE OUTPUT');
  });

  it('records an error termination as failed even when the process exits 0', async () => {
    const failing = FIXTURE.replace(
      '*** Psi4 exiting successfully. Buy a developer a beer!',
      '*** Psi4 encountered an error. Buy a developer more coffee!',
    );
    const script = await fakePsi4(await sandbox(), { payload: failing, exitCode: 0 });
    const { record } = await startRun(script);
    expect(record.status).toBe('failed');
    expect(record.exitCode).toBe(0);
    expect(record.parsed.termination).toMatch(/encountered an error/);
  });

  it('fails a run that printed nothing instead of asking for review', async () => {
    const script = await fakePsi4(await sandbox(), { payload: '', stderr: 'ImportError: no module named psi4', exitCode: 1 });
    const { record } = await startRun(script);
    expect(record.status).toBe('failed');
    expect(record.error).toMatch(/produced no output/);
    expect(record.error).toMatch(/no module named psi4/);
  });
});
