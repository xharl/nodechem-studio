import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { ENGINES } from '../src/shared/engines/index.js';
import { readOutputFile } from '../electron/runner/gaussianRunner.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

const roots = [];
const MIB = 1024 * 1024;

async function makeManager(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-studio-run-'));
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

function waitForDone(events, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const done = events.find((event) => event.type === 'done');
      if (done) { clearInterval(timer); resolve(done); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('run did not finish')); }
    }, 20);
  });
}

// Synthetic output that reproduces the shape of a large Gaussian log without
// pretending to be a calculation. Only the truncation path reads it.
const SYNTHETIC_LARGE_HEADER = [
  ' FIXTURE OUTPUT — synthetic, not a Gaussian calculation',
  ' This file exists only to exercise the >32 MiB truncation path; no Gaussian ran.',
  '',
  ' Entering Gaussian System, Link 0=g16',
  '',
  ' #P B3LYP/6-31G(d) Opt Freq',
  '',
  ' Synthetic large-output fixture',
  '',
  ' Symbolic Z-matrix:',
  ' O   0.000000    0.000000    0.117300',
  ' H   0.000000    0.757200   -0.469200',
  ' H   0.000000   -0.757200   -0.469200',
  '',
].join('\n');

const SYNTHETIC_LARGE_TAIL = [
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

async function writeSyntheticLargeLog(file, targetBytes = 33 * MIB) {
  const padding = ` ${'x'.repeat(4000)}\n`;
  const chunk = padding.repeat(64);
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  let written = Buffer.byteLength(SYNTHETIC_LARGE_HEADER, 'utf8');
  await fsp.writeFile(file, SYNTHETIC_LARGE_HEADER, 'utf8');
  while (written < targetBytes) {
    await fsp.appendFile(file, chunk, 'utf8');
    written += chunkBytes;
  }
  await fsp.appendFile(file, SYNTHETIC_LARGE_TAIL, 'utf8');
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
    // A dry run's output is a fixture, so no binary cache is left behind.
    expect(runJson.cache).toBeNull();
    expect(runJson.parsed.termination).toBe('Normal termination of Gaussian');
    expect(runJson.parsed.complete).toBe(true);
    expect(runJson.parsed.bytes.windows.map((window) => window.name)).toEqual(['fixture']);
  });

  it('reports validity findings next to the gates without changing the gate verdict', async () => {
    const { manager, events, root } = await makeManager();
    const response = await manager.start({
      title: 'Validity fixture',
      inputText: '%Chk=validity.chk\n#p B3LYP/6-31G(d) SP\n\nValidity\n\n0 2\nO 0 0 0.1173\n',
      inputName: 'validity.gjf',
      outputName: 'validity.out',
      dryRun: true,
      gates: {},
      validity: {
        settings: { jobType: 'SP', method: 'B3LYP', basis: '6-31G(d)', dispersion: '' },
        molecule: {
          charge: 0,
          multiplicity: 2,
          coords: [
            { element: 'O', x: 0, y: 0, z: 0.1173 },
            { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
            { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
          ],
        },
      },
    });
    const done = await waitForDone(events);
    // The job ran and its gates pass; the science does not. Both are recorded.
    expect(done.record.status).toBe('completed');
    expect(done.record.gates.overall).toBe('pass');
    expect(done.record.gates.validity.overall).toBe('fail');
    const finding = done.record.gates.validity.findings.find((entry) => entry.id === 'charge-multiplicity');
    expect(finding).toMatchObject({ status: 'fail', severity: 'error' });
    expect(finding.evidence.electrons).toBe(10);

    const runJson = JSON.parse(await fsp.readFile(path.join(root, response.runId, 'run.json'), 'utf8'));
    expect(runJson.gates.validity.overall).toBe('fail');
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

describe('RunManager large-output handling', () => {
  it('records a complete parse and the whole byte range for a small file', async () => {
    const { manager, events, root } = await makeManager({
      createRunner: () => ({
        cancel() {},
        async run({ cwd }) {
          const file = path.join(cwd, 'synthetic-small.log');
          const text = makeFixtureOutput();
          await fsp.writeFile(file, text, 'utf8');
          const read = await readOutputFile(file);
          return {
            exitCode: 0,
            signal: null,
            cancelled: false,
            outputPath: file,
            outputName: 'synthetic-small.log',
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
    const response = await manager.start({
      title: 'small synthetic output',
      inputText: '%Chk=job.chk\n#p HF/STO-3G SP\n\nJob\n\n0 1\nH 0 0 0\n',
      inputName: 'job.gjf',
      outputName: 'job.out',
      executable,
      dryRun: false,
      gates: {},
    });
    const done = await waitForDone(events);
    expect(done.record.status).toBe('completed');

    const runJson = JSON.parse(await fsp.readFile(path.join(response.runDir, 'run.json'), 'utf8'));
    expect(runJson.parsed.complete).toBe(true);
    expect(runJson.parsed.bytes.truncated).toBe(false);
    expect(runJson.parsed.bytes.bytesRead).toBe(runJson.parsed.bytes.size);
    expect(runJson.parsed.bytes.windows.map((window) => window.name)).toEqual(['full']);
    expect(runJson.gates.overall).toBe('pass');
  });

  it('never passes a truncated >32 MiB parse and records the byte ranges it read', async () => {
    const { manager, events, root } = await makeManager({
      createRunner: () => ({
        cancel() {},
        async run({ cwd }) {
          const file = path.join(cwd, 'synthetic-large.log');
          await writeSyntheticLargeLog(file);
          const read = await readOutputFile(file);
          return {
            exitCode: 0,
            signal: null,
            cancelled: false,
            outputPath: file,
            outputName: 'synthetic-large.log',
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
    const response = await manager.start({
      title: 'large synthetic output',
      inputText: '%Chk=job.chk\n#p B3LYP/6-31G(d) Opt Freq\n\nJob\n\n0 1\nO 0 0 0\n',
      inputName: 'job.gjf',
      outputName: 'job.out',
      executable,
      dryRun: false,
      gates: { expectedImaginary: 0, requireFrequency: true, requireThermochemistry: true, requireFinalEnergy: true },
    });
    const done = await waitForDone(events, 120000);
    expect(done.runId).toBe(response.runId);
    // Truncated output is never a completed run, even with a normal termination.
    expect(done.record.status).toBe('needs-review');
    expect(done.record.truncated).toBe(true);

    const runJson = JSON.parse(await fsp.readFile(path.join(response.runDir, 'run.json'), 'utf8'));
    expect(runJson.truncated).toBe(true);
    expect(runJson.status).toBe('needs-review');
    // The synthetic log has no `Standard orientation` block, so there is
    // nothing to cache — and the record says that rather than writing an empty
    // file that would look like a trajectory with zero frames.
    expect(runJson.cache.file).toBeNull();
    expect(runJson.cache.skipped).toMatch(/no trajectory/);
    expect(runJson.parsed.termination).toBe('Normal termination of Gaussian');
    expect(runJson.parsed.complete).toBe(false);
    expect(runJson.parsed.bytes.truncated).toBe(true);
    expect(runJson.parsed.bytes.size).toBeGreaterThan(32 * MIB);
    expect(runJson.parsed.bytes.bytesRead).toBe(32 * MIB);
    expect(runJson.parsed.bytes.windows).toHaveLength(2);

    // The head window supplied the banner, route echo and initial geometry.
    const [headWindow, tailWindow] = runJson.parsed.bytes.windows;
    expect(headWindow).toMatchObject({ name: 'head', start: 0, end: 1 * MIB, bytes: 1 * MIB });
    expect(headWindow.supplied).toEqual(expect.arrayContaining(['banner', 'route', 'geometry']));

    // The tail window supplied termination, the final SCF and the frequency/thermo blocks.
    expect(tailWindow.name).toBe('tail');
    expect(tailWindow.end).toBe(runJson.parsed.bytes.size);
    expect(tailWindow.supplied).toEqual(expect.arrayContaining(['termination', 'scf', 'frequencies', 'thermochemistry']));
    expect(runJson.parsed.scf.energyHartree).toBeCloseTo(-76);
    expect(runJson.parsed.finalEnergy).toEqual({ hartree: -76, source: 'scf' });
    expect(runJson.parsed.frequencies.count).toBe(4);
    expect(runJson.parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-76.02);

    // A partial parse is structurally incapable of passing the gates.
    const completeGate = runJson.gates.gates.find((gate) => gate.name === 'Output complete');
    expect(completeGate).toMatchObject({ required: true, result: 'unknown' });
    expect(runJson.gates.overall).toBe('unknown');
    expect(runJson.gates.overall).not.toBe('pass');
  }, 180000);
});

describe('RunManager engine selection', () => {
  // Every registered engine gets its own runner. Borrowing the Gaussian runner
  // for another engine would execute g16 on that engine's input and record
  // whatever came back, so the mapping is explicit and the fallback refuses.
  it('maps each engine to its own runner and refuses an unknown one', () => {
    const manager = new RunManager({ root: os.tmpdir() });
    expect(manager.runnerFor(ENGINES.gaussian).constructor.name).toMatch(/GaussianRunner/);
    expect(manager.runnerFor(ENGINES.xtb).constructor.name).toMatch(/XtbRunner/);
    expect(manager.runnerFor(ENGINES.orca).constructor.name).toMatch(/OrcaRunner/);
    expect(manager.runnerFor(ENGINES.psi4).constructor.name).toMatch(/Psi4Runner/);
    expect(() => manager.runnerFor({ id: 'nwchem', label: 'NWChem' })).toThrow(/has no runner/);
  });
});
