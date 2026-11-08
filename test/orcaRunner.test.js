import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OrcaRunner } from '../electron/runner/orcaRunner.js';
import { RunManager } from '../electron/runner/runManager.js';
import { classifyOrcaTermination, makeOrcaFixtureOutput, parseOrcaOutput } from '../src/shared/engines/orca.js';

/**
 * The ORCA runner, exercised without ORCA.
 *
 * No ORCA binary exists on this machine and it is not redistributable, so every
 * test here drives a shell script that is *not* ORCA: it prints the same text the
 * parser's documented fixture carries, or prints nothing, or sleeps. That is
 * enough to test what this runner owns — spawning, capturing the stream, writing
 * the artifact, keeping stderr apart, timing out, cancelling — and it proves
 * nothing about ORCA itself, which is stated in the guides as well.
 */
const canSpawnShell = process.platform !== 'win32';

const FIXTURE = makeOrcaFixtureOutput();

async function sandbox() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-orca-'));
  return root;
}

/** A fake driver: prints `payload`, writes the side file ORCA would write. */
async function fakeOrca(root, { payload = FIXTURE, exitCode = 0, stderr = '', sleepMs = 0 } = {}) {
  const dir = await fsp.mkdtemp(path.join(root, 'bin-'));
  const script = path.join(dir, 'orca');
  await fsp.writeFile(path.join(dir, 'payload.txt'), payload, 'utf8');
  await fsp.writeFile(script, [
    '#!/bin/sh',
    sleepMs > 0 ? `sleep ${sleepMs / 1000}` : '',
    stderr ? `printf '%s\\n' '${stderr}' >&2` : '',
    'job="$1"',
    'case "${job%.inp}" in *) touch "${job%.inp}.gbw" ;; esac',
    'cat "$(dirname "$0")/payload.txt"',
    `exit ${exitCode}`,
    '',
  ].join('\n'), 'utf8');
  await fsp.chmod(script, 0o755);
  return script;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!canSpawnShell)('OrcaRunner', () => {
  it('captures stdout into the run artifact and never into a merged stderr blob', async () => {
    const root = await sandbox();
    const executable = await fakeOrca(root, { stderr: 'driver chatter' });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    await fsp.writeFile(path.join(cwd, 'water.inp'), '! B3LYP def2-SVP\n', 'utf8');

    const result = await new OrcaRunner().run({
      executable, argv: ['water.inp'], cwd, outputName: 'water.out',
    });

    const written = await fsp.readFile(path.join(cwd, 'water.out'), 'utf8');
    expect(written).toContain('FINAL SINGLE POINT ENERGY');
    expect(written).not.toContain('driver chatter');
    expect(result.stderr.trim()).toBe('driver chatter');
    expect(result.outputText).toBe(written);
    expect(result.exitCode).toBe(0);
    expect(result.outputSource).toBe('stdout');
    expect(result.outputBytes.size).toBe(Buffer.byteLength(written, 'utf8'));
  });

  it('records the side files the binary actually wrote', async () => {
    const root = await sandbox();
    const executable = await fakeOrca(root);
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const result = await new OrcaRunner().run({
      executable, argv: ['job.inp'], cwd, outputName: 'job.out',
    });
    expect(result.artifacts).toEqual([{ file: 'job.gbw', bytes: expect.any(Number) }]);
    expect(result.driverAbsolute).toBe(true);
  });

  it('does not invent an artifact when the binary wrote nothing', async () => {
    const root = await sandbox();
    const executable = await fakeOrca(root, { payload: '' });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const result = await new OrcaRunner().run({
      executable, argv: ['job.inp'], cwd, outputName: 'job.out',
    });
    expect(result.outputText).toBe('');
    expect(result.artifacts).toEqual([{ file: 'job.gbw', bytes: 0 }]);
    expect(classifyOrcaTermination(result.outputText, 0).code).toBe('none');
  });

  it('cancels a running job', async () => {
    const root = await sandbox();
    const executable = await fakeOrca(root, { sleepMs: 5000 });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const runner = new OrcaRunner();
    const running = runner.run({ executable, argv: ['job.inp'], cwd, outputName: 'job.out' });
    await sleep(200);
    runner.cancel();
    const result = await running;
    expect(result.cancelled).toBe(true);
  });

  it('honours the timeout by cancelling, not by waiting forever', async () => {
    const root = await sandbox();
    const executable = await fakeOrca(root, { sleepMs: 5000 });
    const cwd = await fsp.mkdtemp(path.join(root, 'run-'));
    const started = Date.now();
    const result = await new OrcaRunner().run({
      executable, argv: ['job.inp'], cwd, outputName: 'job.out', timeoutMs: 300,
    });
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('refuses a run with no arguments rather than spawning an interactive driver', async () => {
    await expect(new OrcaRunner().run({ executable: '/bin/true', argv: [], cwd: os.tmpdir(), outputName: 'x.out' }))
      .rejects.toThrow(/no arguments/);
  });
});

describe('OrcaRunner static helpers', () => {
  it('tells an absolute driver path from a bare name', () => {
    expect(OrcaRunner.driverIsAbsolute('/opt/orca/orca')).toBe(true);
    expect(OrcaRunner.driverIsAbsolute('C:\\ORCA\\orca.exe')).toBe(true);
    expect(OrcaRunner.driverIsAbsolute('orca')).toBe(false);
  });

  it('names the side files beside the input, not beside the output', () => {
    expect(OrcaRunner.artifactNamesFor('water.inp')).toContain('water.gbw');
    expect(OrcaRunner.artifactNamesFor('water.inp')).toContain('water_trj.xyz');
  });
});

describe.skipIf(!canSpawnShell)('RunManager with the ORCA engine', () => {
  async function startRun(script, overrides = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-orca-run-'));
    const events = [];
    const manager = new RunManager({ runsRoot: root, emit: (event) => events.push(event) });
    const started = await manager.start({
      title: 'water single point',
      engine: 'orca',
      argv: ['water.inp'],
      route: '! B3LYP def2-SVP',
      inputText: '! B3LYP def2-SVP\n* xyz 0 1\nO 0 0 0\nH 0.7 0.5 0\nH -0.7 0.5 0\n*\n',
      inputName: 'water.inp',
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

  it('writes a record with the engine, the parsed energy and the captured stream', async () => {
    const script = await fakeOrca(await sandbox());
    const { record, runDir } = await startRun(script);

    expect(record.engine).toBe('orca');
    expect(record.status).toBe('completed');
    expect(record.outputSource).toBe('stdout');
    expect(record.exitCode).toBe(0);
    expect(record.parsed.engine).toBe('orca');
    expect(record.parsed.finalEnergy.hartree).toBeCloseTo(-76.067231252, 9);
    expect(record.parsed.termination).toBe('ORCA TERMINATED NORMALLY');
    expect(record.gates.overall).toBe('pass');
    expect(record.provenance.orca.artifacts.map((entry) => entry.file)).toContain('water.gbw');
    const written = await fsp.readFile(path.join(runDir, 'water.out'), 'utf8');
    expect(written).toContain('ORCA TERMINATED NORMALLY');
  });

  it('a dry run records the ORCA engine and a labelled fixture', async () => {
    const { record, runDir } = await startRun('/bin/false', { dryRun: true });
    expect(record.engine).toBe('orca');
    expect(record.dryRun).toBe(true);
    expect(record.status).toBe('completed');
    expect(record.outputSource).toBe('fixture');
    expect(record.parsed.finalEnergy.hartree).toBeCloseTo(-76.067231252, 9);
    expect(await fsp.readFile(path.join(runDir, 'water.out'), 'utf8')).toContain('FIXTURE OUTPUT');
  });

  it('calls an exit-0 error termination a failure', async () => {
    const failing = FIXTURE.replace(
      '****ORCA TERMINATED NORMALLY****',
      'ORCA finished by error termination in SCF',
    );
    const script = await fakeOrca(await sandbox(), { payload: failing, exitCode: 0 });
    const { record } = await startRun(script);

    expect(record.status).toBe('failed');
    expect(record.exitCode).toBe(0);
    expect(record.parsed.termination).toMatch(/error termination in SCF/);
  });

  it('reports stderr when the binary printed nothing at all', async () => {
    const script = await fakeOrca(await sandbox(), { payload: '', stderr: 'cannot load libmpi', exitCode: 1 });
    const { record } = await startRun(script);
    expect(record.status).toBe('failed');
    expect(record.error).toMatch(/produced no output/);
    expect(record.error).toMatch(/cannot load libmpi/);
    expect(record.provenance.orca.stderr).toContain('cannot load libmpi');
  });
});
