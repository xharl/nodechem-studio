import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

const roots = [];

async function makeManager(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gaussian-studio-run-'));
  roots.push(root);
  const events = [];
  const manager = new RunManager({ runsRoot: root, emit: (event) => events.push(event), ...options });
  return { manager, events, root };
}

async function fakeExecutable(root) {
  const file = path.join(root, 'g16.exe');
  await fsp.writeFile(file, '', 'utf8');
  return file;
}

function waitForDone(events) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const done = events.find((event) => event.type === 'done');
      if (done) { clearInterval(timer); resolve(done); }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error('run did not finish')); }
    }, 20);
  });
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('RunManager dry-run path', () => {
  it('writes a run record and evaluates the fixture output', async () => {
    const { manager, events, root } = await makeManager();
    const response = await manager.start({
      title: 'Fixture frequency',
      inputText: '%Chk=fixture.chk\n#p B3LYP/6-31G(d) Freq\n\nFixture\n\n0 1\nO 0 0 0\n',
      inputName: 'fixture.gjf',
      outputName: 'fixture.out',
      dryRun: true,
      gates: { expectedImaginary: 0, minMagnitude: 50, requireFrequency: true },
    });
    const done = await waitForDone(events);
    expect(done.runId).toBe(response.runId);
    expect(done.record.status).toBe('completed');
    expect(done.record.gates.overall).toBe('pass');
    expect(done.record.dryRun).toBe(true);

    const runJson = JSON.parse(await fsp.readFile(path.join(root, response.runId, 'run.json'), 'utf8'));
    expect(runJson.status).toBe('completed');
    expect(runJson.gates.overall).toBe('pass');
    expect(runJson.parsed.termination).toBe('Normal termination of Gaussian');
  });

  it('lists completed runs newest first', async () => {
    const { manager, events } = await makeManager();
    await manager.start({
      inputText: '#p HF/STO-3G SP\n\nFixture\n\n0 1\nH 0 0 0\n',
      inputName: 'a.gjf',
      outputName: 'a.out',
      dryRun: true,
      gates: {},
    });
    await waitForDone(events);
    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('completed');
  });
});

describe('RunManager real-run record', () => {
  async function runWith(result, { inputName = 'job.gjf', outputName = 'job.out', gates = {} } = {}) {
    const { manager, events, root } = await makeManager({
      createRunner: () => ({ cancel() {}, async run() { return result; } }),
    });
    const executable = await fakeExecutable(root);
    const response = await manager.start({
      title: 'real run record',
      inputText: '%Chk=job.chk\n#p B3LYP/6-31G(d) SP\n\nJob\n\n0 1\nO 0 0 0\n',
      inputName,
      outputName,
      executable,
      dryRun: false,
      gates,
    });
    const done = await waitForDone(events);
    return { done, response, root };
  }

  it('records the output file Gaussian actually wrote', async () => {
    const { done } = await runWith({
      exitCode: 0,
      signal: null,
      cancelled: false,
      outputPath: '/tmp/job.log',
      outputName: 'job.log',
      outputSource: 'file',
      truncated: false,
      outputText: makeFixtureOutput(),
      stdout: '',
      stderr: '',
    });
    expect(done.record.status).toBe('completed');
    expect(done.record.outputFile).toBe('job.log');
    expect(done.record.outputSource).toBe('file');
    expect(done.record.outputName).toBe('job.out');
    const runJson = JSON.parse(await fsp.readFile(path.join(done.runDir, 'run.json'), 'utf8'));
    expect(runJson.outputFile).toBe('job.log');
  });

  it('never treats exit code 0 with an error termination as success', async () => {
    const { done } = await runWith({
      exitCode: 0,
      signal: null,
      cancelled: false,
      outputPath: '/tmp/job.out',
      outputName: 'job.out',
      outputSource: 'file',
      truncated: false,
      outputText: ' Error termination via Lnk1e in C:\\\\G16W\\\\l502.exe\n',
      stdout: '',
      stderr: '',
    });
    expect(done.record.exitCode).toBe(0);
    expect(done.record.parsed.status).toBe('error');
    expect(done.record.status).toBe('failed');
    expect(done.record.gates.overall).toBe('fail');
  });

  it('passes the final-energy gate when a correlated energy is present', async () => {
    const output = `${makeFixtureOutput()}\n CCSD(T)= -76.4000000000D+00\n`;
    const { done } = await runWith({
      exitCode: 0,
      signal: null,
      cancelled: false,
      outputPath: '/tmp/job.out',
      outputName: 'job.out',
      outputSource: 'file',
      truncated: false,
      outputText: output,
      stdout: '',
      stderr: '',
    }, { gates: { requireFinalEnergy: true } });
    expect(done.record.gates.overall).toBe('pass');
    expect(done.record.parsed.finalEnergy.source).toBe('post-hf');
  });
});
