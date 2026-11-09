import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { readOutputFile } from '../electron/runner/gaussianRunner.js';
import { buildGaussianInput, DEMO_WATER, methodBlockFor, routeFor } from '../src/shared/gaussianInput.js';
import { buildXtbInput, makeXtbFixtureOutput } from '../src/shared/engines/xtb.js';
import { provenanceSummary } from '../src/shared/provenance.js';
import { defaultSettings } from '../src/shared/projectSchema.js';
import { parseGaussianOutput, outputEvidence } from '../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

// Synthetic logs only: this machine has no Gaussian. The first line says so,
// and the banner below reproduces the documented format for the parser test.
const SYNTHETIC_VERSIONED_OUTPUT = [
  ' SYNTHETIC FIXTURE — not a Gaussian calculation; hand-written to exercise the parser.',
  '',
  ' Entering Gaussian System, Link 0=g16',
  '',
  ' Copyright (c) 2016, Gaussian, Inc.  All Rights Reserved.',
  '',
  ' Gaussian 16, Revision C.01',
  ' 7-Apr-2020',
  '',
  ' #P B3LYP/6-31G(d) Opt Freq',
  '',
  ' Synthetic water fixture',
  '',
  ' 0 1',
  ' O   0.000000    0.000000    0.117300',
  ' H   0.000000    0.757200   -0.469200',
  ' H   0.000000   -0.757200   -0.469200',
  '',
  ' SCF Done:  E(RB3LYP) =  -76.000000000     A.U. after    8 cycles',
  ' Optimization completed.',
  ' Stationary point found.',
  '',
  ' Harmonic frequencies (cm**-1), IR intensities',
  ' Frequencies --    610.0000   1580.0000   3650.0000   3760.0000',
  ' Red. masses --',
  '',
  ' Sum of electronic and thermal Free Energies=        -76.020000',
  '',
  ' Normal termination of Gaussian 16 at Fri Nov  7 12:00:00 2026.',
  '',
].join('\n');

const roots = [];

async function makeManager(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-studio-provenance-'));
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

function waitForDone(events, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const done = events.find((event) => event.type === 'done');
      if (done) { clearInterval(timer); resolve(done); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('run did not finish')); }
    }, 20);
  });
}

const sha256Buffer = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sha256Text = (text) => sha256Buffer(Buffer.from(text, 'utf8'));

async function readRunJson(runDir) {
  return JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'));
}

function fixtureSettings() {
  return defaultSettings({
    method: 'PBE0',
    basis: 'def2-TZVP',
    dispersion: 'GD3BJ',
    scf: 'VeryTight',
    grid: 'UltraFine',
    solvation: true,
    solvationModel: 'SMD',
    solvent: 'THF',
  });
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('Gaussian program banner', () => {
  it('records the product, version and revision from a version banner', () => {
    const parsed = parseGaussianOutput(SYNTHETIC_VERSIONED_OUTPUT);
    expect(parsed.program).toEqual({ name: 'Gaussian', version: '16', revision: 'C.01' });
    expect(parsed.status).toBe('completed');
    // The banner is also named as evidence so a windowed parse says it saw it.
    expect(outputEvidence(SYNTHETIC_VERSIONED_OUTPUT)).toContain('program');
  });

  it('does not invent a version when no banner is present', () => {
    const fixture = parseGaussianOutput(makeFixtureOutput());
    expect(fixture.program).toEqual({ name: null, version: null, revision: null });

    // A termination line mentions "Gaussian 16" but has no revision: that is
    // not a build banner and must not be reported as one.
    const terminationOnly = parseGaussianOutput(' Normal termination of Gaussian 16 at Fri Nov  7 12:00:00 2026.\n');
    expect(terminationOnly.program).toEqual({ name: null, version: null, revision: null });
    expect(terminationOnly.termination).toBe('Normal termination of Gaussian');
  });
});

describe('method block', () => {
  it('normalises the same settings the route is built from', () => {
    const settings = fixtureSettings();
    expect(methodBlockFor(settings)).toEqual({
      functional: 'PBE0',
      basis: 'def2-TZVP',
      dispersion: 'GD3BJ',
      solvation: 'SMD/THF',
      grid: 'UltraFine',
      scf: 'VeryTight',
      td: null,
    });
    expect(routeFor(settings)).toBe(
      '#p PBE0/def2TZVP Opt EmpiricalDispersion=GD3BJ SCF=VeryTight Integral=UltraFine SCRF=(SMD,Solvent=THF)',
    );
  });

  it('reports null for a field that does not appear in the route', () => {
    const settings = defaultSettings();
    expect(methodBlockFor(settings)).toEqual({
      functional: 'B3LYP',
      basis: 'def2-SVP',
      dispersion: 'GD3BJ',
      solvation: null,
      grid: null,
      scf: null,
      td: null,
    });
    expect(routeFor(settings)).toBe('#p B3LYP/def2SVP Opt EmpiricalDispersion=GD3BJ');
  });
});

describe('dry-run provenance manifest', () => {
  it('records hashes of the files on disk and marks the run as a fixture', async () => {
    const settings = fixtureSettings();
    const inputName = 'fixture-run.gjf';
    const outputName = 'fixture-run.out';
    const inputText = buildGaussianInput({
      title: 'Fixture provenance',
      settings,
      molecule: { coords: DEMO_WATER },
      inputName,
    });

    const { manager, events } = await makeManager({ appInfo: { version: '0.1.0', commit: 'deadbee' } });
    const response = await manager.start({
      title: 'Fixture provenance',
      inputText,
      inputName,
      outputName,
      settings,
      dryRun: true,
      gates: { expectedImaginary: 0, requireFrequency: true },
    });
    const done = await waitForDone(events);
    expect(done.record.status).toBe('completed');

    const runJson = await readRunJson(response.runDir);
    const inputOnDisk = await fsp.readFile(path.join(response.runDir, inputName));
    const outputOnDisk = await fsp.readFile(path.join(response.runDir, outputName));

    expect(runJson.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runJson.inputSha256).toBe(sha256Buffer(inputOnDisk));
    expect(runJson.inputSha256).toBe(sha256Text(inputText));
    expect(runJson.provenance.input).toEqual({ name: inputName, bytes: inputOnDisk.length });

    expect(runJson.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runJson.outputSha256).toBe(sha256Buffer(outputOnDisk));
    expect(runJson.provenance.output).toEqual({
      name: outputName,
      source: 'fixture',
      bytes: outputOnDisk.length,
      hashSource: 'file',
      sha256: sha256Buffer(outputOnDisk),
    });

    expect(runJson.app).toEqual({ version: '0.1.0', commit: 'deadbee' });
    expect(runJson.provenance.method).toEqual(methodBlockFor(settings));
    // The manifest method block is the route in the input that was written.
    expect(inputOnDisk.toString('utf8')).toContain(routeFor(settings));

    // Identifiable as a fixture from the record alone: no disk or UI state.
    const recordOnly = JSON.parse(JSON.stringify(runJson));
    expect(recordOnly.provenance.kind).toBe('fixture');
    expect(recordOnly.dryRun).toBe(true);
    // A fixture never claims a Gaussian build it did not use.
    expect(recordOnly.parsed.program).toEqual({ name: null, version: null, revision: null });
  });

  it('falls back to app version/commit "unknown" when none was injected', async () => {
    const { manager, events } = await makeManager();
    const response = await manager.start({
      inputText: '#p HF/STO-3G SP\n\nFixture\n\n0 1\nH 0 0 0\n',
      inputName: 'unknown-app.gjf',
      outputName: 'unknown-app.out',
      dryRun: true,
      gates: {},
    });
    await waitForDone(events);
    const runJson = await readRunJson(response.runDir);
    expect(runJson.app).toEqual({ version: 'unknown', commit: 'unknown' });
    expect(runJson.provenance.kind).toBe('fixture');
    expect(runJson.provenance.method).toBeNull();
  });
});

describe('real-run provenance manifest', () => {
  async function startWithOutputFile(outputText) {
    const { manager, events, root } = await makeManager({
      appInfo: { version: '0.1.0', commit: 'cafe123' },
      createRunner: () => ({
        cancel() {},
        async run({ cwd }) {
          const file = path.join(cwd, 'job.out');
          await fsp.writeFile(file, outputText, 'utf8');
          const read = await readOutputFile(file);
          return {
            exitCode: 0,
            signal: null,
            cancelled: false,
            outputPath: file,
            outputName: 'job.out',
            outputSource: 'file',
            truncated: read.truncated,
            outputText: read.text,
            outputBytes: read.byteRange,
            stdout: '',
            stderr: '',
          };
        },
      }),
    });
    const executable = await fakeExecutable(root);
    const settings = fixtureSettings();
    const inputText = buildGaussianInput({
      title: 'Manifest real run',
      settings,
      molecule: { coords: DEMO_WATER },
      inputName: 'job.gjf',
    });
    const response = await manager.start({
      title: 'Manifest real run',
      inputText,
      inputName: 'job.gjf',
      outputName: 'job.out',
      settings,
      executable,
      dryRun: false,
      gates: { expectedImaginary: 0, requireFrequency: true },
    });
    const done = await waitForDone(events);
    return { manager, done, response, settings };
  }

  it('records the Gaussian version, app info and hashes of the parsed file', async () => {
    const { done, response, settings } = await startWithOutputFile(SYNTHETIC_VERSIONED_OUTPUT);
    expect(done.record.status).toBe('completed');

    const runJson = await readRunJson(response.runDir);
    expect(runJson.provenance.kind).toBe('calculation');
    expect(runJson.parsed.program).toEqual({ name: 'Gaussian', version: '16', revision: 'C.01' });
    expect(runJson.app).toEqual({ version: '0.1.0', commit: 'cafe123' });
    expect(runJson.provenance.method).toEqual(methodBlockFor(settings));

    const outputOnDisk = await fsp.readFile(path.join(response.runDir, 'job.out'));
    expect(runJson.outputSha256).toBe(sha256Buffer(outputOnDisk));
    expect(runJson.provenance.output).toMatchObject({
      name: 'job.out',
      source: 'file',
      hashSource: 'file',
      bytes: outputOnDisk.length,
      sha256: sha256Buffer(outputOnDisk),
    });

    const inputOnDisk = await fsp.readFile(path.join(response.runDir, 'job.gjf'));
    expect(runJson.inputSha256).toBe(sha256Buffer(inputOnDisk));
  });

  it('hashes the parsed stream when Gaussian left no output file', async () => {
    const streamText = ' SCF Done:  E(RB3LYP) =  -76.0 A.U. after 2 cycles\n Normal termination of Gaussian 16\n';
    const { manager, events, root } = await makeManager({
      createRunner: () => ({
        cancel() {},
        async run() {
          return {
            exitCode: 0,
            signal: null,
            cancelled: false,
            outputPath: path.join(root, 'never-written.out'),
            outputName: null,
            outputSource: 'stdout',
            truncated: false,
            outputText: streamText,
            stdout: streamText,
            stderr: '',
          };
        },
      }),
    });
    const executable = await fakeExecutable(root);
    const response = await manager.start({
      inputText: '#p HF/STO-3G SP\n\nStream\n\n0 1\nH 0 0 0\n',
      inputName: 'stream.gjf',
      outputName: 'stream.out',
      executable,
      dryRun: false,
      gates: {},
    });
    await waitForDone(events);
    const runJson = await readRunJson(response.runDir);
    expect(runJson.outputSha256).toBe(sha256Text(streamText));
    expect(runJson.provenance.output).toMatchObject({
      source: 'stdout',
      hashSource: 'stream',
      bytes: Buffer.byteLength(streamText, 'utf8'),
    });
  });
});

describe('queued workflow provenance', () => {
  it('carries the method block through a queued task', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-studio-queue-provenance-'));
    roots.push(root);
    const runManager = new RunManager({
      runsRoot: path.join(root, 'runs'),
      emit: () => {},
      appInfo: { version: '0.1.0', commit: 'queued1' },
    });
    const queueEvents = [];
    const queueManager = new QueueManager({
      queuesRoot: path.join(root, 'queues'),
      runManager,
      emit: (event) => queueEvents.push(event),
    });
    await queueManager.init();
    const settings = fixtureSettings();
    const inputText = buildGaussianInput({
      title: 'Queued provenance',
      settings,
      molecule: { coords: DEMO_WATER },
      inputName: 'calc-1.gjf',
    });
    const started = await queueManager.start({
      projectName: 'Queued provenance',
      tasks: [{
        nodeId: 'calc-1',
        type: 'calculate',
        title: 'Queued provenance',
        kind: 'Calc',
        executable: true,
        inputName: 'calc-1.gjf',
        outputName: 'calc-1.out',
        inputText,
        settings,
        gates: {},
      }],
      edges: [],
      options: { dryRun: true },
    });

    let queue = null;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      queue = await queueManager.get(started.id);
      if (queueEvents.some((event) => event.type === 'queue-done')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    queueManager.dispose();
    expect(queueEvents.some((event) => event.type === 'queue-done')).toBe(true);
    expect(queue?.status).toBe('completed');
    const task = queue.tasks.find((item) => item.nodeId === 'calc-1');
    expect(task.runDir).toBeTruthy();

    const runJson = await readRunJson(task.runDir);
    expect(runJson.provenance.kind).toBe('fixture');
    expect(runJson.provenance.method).toEqual(methodBlockFor(settings));
    expect(runJson.app).toEqual({ version: '0.1.0', commit: 'queued1' });
    expect(runJson.inputSha256).toBe(sha256Text(inputText));
  });
});

describe('xTB provenance manifest', () => {
  it('records the Hamiltonian and argv, never the Gaussian route', async () => {
    const { manager, events, root } = await makeManager({
      createRunner: () => ({
        cancel() {},
        async run({ outputName }) {
          const text = makeXtbFixtureOutput();
          return {
            exitCode: 0,
            signal: null,
            cancelled: false,
            outputPath: null,
            outputName,
            outputSource: 'stdout',
            truncated: false,
            outputText: text,
            stdout: text,
            stderr: '',
          };
        },
      }),
    });
    const executable = await fakeExecutable(root);
    // Gaussian fields are present in the settings on purpose: an xTB run must
    // not copy them into the manifest just because the node still carries them.
    const settings = {
      jobType: 'Opt',
      method: 'B3LYP',
      basis: 'def2-SVP',
      dispersion: 'GD3BJ',
      scf: '',
      grid: '',
      solvation: false,
      xtbMethod: 'gfn1',
      xtbOptLevel: 'normal',
    };
    const built = buildXtbInput({
      title: 'xTB opt provenance',
      settings,
      molecule: { charge: 0, multiplicity: 1, coords: DEMO_WATER },
      inputName: 'r-opt.xyz',
    });
    const response = await manager.start({
      title: 'xTB opt provenance',
      engine: 'xtb',
      argv: built.argv,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      settings,
      executable,
      dryRun: false,
      gates: {},
    });
    const done = await waitForDone(events);
    expect(done.record.engine).toBe('xtb');

    const runJson = await readRunJson(response.runDir);
    expect(runJson.argv).toEqual(['r-opt.xyz', '--gfn', '1', '--opt', 'normal']);
    expect(runJson.provenance.jobType).toBe('Opt');
    expect(runJson.provenance.method).toMatchObject({
      hamiltonian: 'gfn1',
      optLevel: 'normal',
      dispersion: 'D3(BJ) (built in)',
      solvation: null,
      argv: ['r-opt.xyz', '--gfn', '1', '--opt', 'normal'],
    });

    // The regression: the method record must not claim the node's Gaussian
    // route settings when a different engine actually ran.
    const methodJson = JSON.stringify(runJson.provenance.method);
    for (const forbidden of ['B3LYP', 'def2-SVP', 'GD3BJ', 'functional', 'basis', 'grid', 'scf']) {
      expect(methodJson).not.toContain(forbidden);
    }

    expect(provenanceSummary(runJson)).toContain('method: GFN1-xTB · opt normal');
  });
});

describe('Verify action', () => {
  async function completedFixtureRun() {
    const { manager, events } = await makeManager();
    const response = await manager.start({
      inputText: '#p HF/STO-3G SP\n\nVerify\n\n0 1\nH 0 0 0\n',
      inputName: 'verify.gjf',
      outputName: 'verify.out',
      dryRun: true,
      gates: {},
    });
    await waitForDone(events);
    const runJson = await readRunJson(response.runDir);
    return { manager, response, runJson };
  }

  it('recomputes the input hash and matches a pristine run folder', async () => {
    const { manager, response, runJson } = await completedFixtureRun();
    const result = await manager.verify(response.runId);
    expect(result).toMatchObject({
      status: 'match',
      ok: true,
      inputName: 'verify.gjf',
      expected: runJson.inputSha256,
    });
    expect(result.actual).toBe(runJson.inputSha256);
  });

  it('reports a mismatch when the input file is tampered with after the run', async () => {
    const { manager, response, runJson } = await completedFixtureRun();
    const inputPath = path.join(response.runDir, 'verify.gjf');
    await fsp.appendFile(inputPath, '\n# tampered after the run\n', 'utf8');
    const tampered = await fsp.readFile(inputPath);

    const result = await manager.verify(response.runId);
    expect(result.status).toBe('mismatch');
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(runJson.inputSha256);
    expect(result.actual).toBe(sha256Buffer(tampered));
    expect(result.actual).not.toBe(result.expected);
  });

  it('reports a missing input file rather than a pass', async () => {
    const { manager, response } = await completedFixtureRun();
    await fsp.rm(path.join(response.runDir, 'verify.gjf'));
    const result = await manager.verify(response.runId);
    expect(result).toMatchObject({ status: 'missing', ok: false, expected: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('rejects a run id that is not a single safe folder name', async () => {
    const { manager } = await completedFixtureRun();
    await expect(manager.verify('../escape')).rejects.toThrow(/safe run folder/);
    await expect(manager.verify('..')).rejects.toThrow(/safe run folder/);
  });
});
