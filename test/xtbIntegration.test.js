import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildXtbInput, parseXtbGeometry, parseXtbOutput } from '../src/shared/engines/xtb.js';
import { XtbRunner } from '../electron/runner/xtbRunner.js';
import { RunManager } from '../electron/runner/runManager.js';

/**
 * End-to-end engine test against a real xTB binary.
 *
 * xTB is LGPL and needs no licence, so this is the one engine the suite can
 * exercise for real. Skipped when XTB_BIN is unset; CI sets it after installing
 * a pinned, hash-verified release.
 */
const XTB_BIN = process.env.XTB_BIN && fs.existsSync(process.env.XTB_BIN)
  ? process.env.XTB_BIN
  : null;

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for RunManager to finish writing run.json (start() returns while running). */
async function waitForRecord(runDir, timeoutMs = 120_000) {
  const runPath = path.join(runDir, 'run.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await fsp.readFile(runPath, 'utf8').catch(() => null);
    if (raw) {
      const record = JSON.parse(raw);
      if (record.status !== 'running') return record;
    }
    await sleep(250);
  }
  throw new Error(`run.json did not leave the running state within ${timeoutMs} ms`);
}

async function runBuilt(built) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-xtb-'));
  await fsp.writeFile(path.join(dir, built.inputName), built.inputText, 'utf8');
  const runner = new XtbRunner();
  const result = await runner.run({
    executable: XTB_BIN,
    argv: built.argv,
    cwd: dir,
    outputName: built.outputName,
  });
  return { dir, result, parsed: parseXtbOutput(result.outputText, { argv: built.argv }) };
}

describe.skipIf(!XTB_BIN)('xTB end-to-end (real binary)', () => {
  it('runs a single point, captures stdout and parses the energy', async () => {
    const built = buildXtbInput({ title: 'water sp', settings: { jobType: 'SP' }, molecule: { charge: 0, multiplicity: 1, coords: WATER }, inputName: 'water.xyz' });
    const { dir, result, parsed } = await runBuilt(built);

    expect(result.exitCode).toBe(0);
    expect(parsed.status).toBe('completed');
    expect(parsed.scf.method).toBe('GFN2-xTB');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-5.0704, 3);

    const artifact = path.join(dir, built.outputName);
    expect(fs.existsSync(artifact)).toBe(true);
    expect(fs.statSync(artifact).size).toBeGreaterThan(1000);
    await fsp.rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('optimises, writes xtbopt.xyz and reports convergence', async () => {
    const built = buildXtbInput({
      title: 'water opt',
      settings: { jobType: 'Opt', xtbOptLevel: 'tight' },
      molecule: { charge: 0, multiplicity: 1, coords: WATER },
      inputName: 'water.xyz',
    });
    const { dir, result, parsed } = await runBuilt(built);

    expect(result.exitCode).toBe(0);
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.finalEnergy.hartree).not.toBeNull();

    const geometry = parseXtbGeometry(await fsp.readFile(path.join(dir, 'xtbopt.xyz'), 'utf8'));
    expect(geometry.atoms).toHaveLength(3);
    // Water at GFN2: both O–H bonds within 0.01 A of 0.959 A.
    const [o, h1] = geometry.atoms;
    const r = Math.hypot(o.x - h1.x, o.y - h1.y, o.z - h1.z);
    expect(r).toBeGreaterThan(0.94);
    expect(r).toBeLessThan(0.98);
    await fsp.rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('computes frequencies and thermochemistry with --ohess', async () => {
    const built = buildXtbInput({
      title: 'water freq',
      settings: { jobType: 'Opt Freq', xtbOptLevel: 'tight' },
      molecule: { charge: 0, multiplicity: 1, coords: WATER },
      inputName: 'water.xyz',
    });
    const { dir, result, parsed } = await runBuilt(built);

    expect(result.exitCode).toBe(0);
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.thermochemistry.freeEnergyHartree).not.toBeNull();
    expect(parsed.thermochemistry.zpeHartree).not.toBeNull();
    expect(parsed.frequencies.entropyTreatment).toBe('mRRHO');
    await fsp.rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('runs GFN-FF Opt Freq without a topology runtime exception', async () => {
    const built = buildXtbInput({
      title: 'water gfnff freq',
      settings: { jobType: 'Opt Freq', xtbMethod: 'gfnff', xtbOptLevel: 'tight' },
      molecule: { charge: 0, multiplicity: 1, coords: WATER },
      inputName: 'water-ff.xyz',
    });
    const { dir, result, parsed } = await runBuilt(built);

    expect(result.exitCode).toBe(0);
    expect(parsed.status).toBe('completed');
    expect(parsed.extras.runtimeException).not.toBe(true);
    expect(parsed.finalEnergy.source).toBe('force-field');
    expect(parsed.scf.applicable).toBe(false);
    expect(parsed.frequencies.count).toBe(3);
    await fsp.rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('classifies a missing input file as a failure with exit 128', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-xtb-'));
    const runner = new XtbRunner();
    const result = await runner.run({ executable: XTB_BIN, argv: ['absent.xyz'], cwd: dir, outputName: 'absent.out' });
    expect(result.exitCode).toBe(128);
    expect(parseXtbOutput(result.outputText).status).toBe('error');
    await fsp.rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('records the canonical result in run.json through the production RunManager path', async () => {
    const runsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-runs-'));
    const manager = new RunManager({ runsRoot, emit: () => {} });
    const built = buildXtbInput({
      title: 'water opt',
      settings: { jobType: 'Opt', xtbOptLevel: 'tight' },
      molecule: { charge: 0, multiplicity: 1, coords: WATER },
      inputName: 'water.xyz',
    });
    const started = await manager.start({
      title: 'water opt',
      engine: 'xtb',
      argv: built.argv,
      route: built.route,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      executable: XTB_BIN,
      gates: { requireOptimization: true, requireFinalEnergy: true },
    });

    const record = await waitForRecord(started.runDir);
    expect(record.status).toBe('completed');
    expect(record.engine).toBe('xtb');
    expect(record.argv).toEqual(built.argv);
    expect(record.outputSource).toBe('stdout');
    expect(record.exitCode).toBe(0);
    expect(record.parsed.engine).toBe('xtb');
    expect(record.parsed.terminationCode).toBe('normal');
    expect(record.parsed.route).toBe(built.route);
    expect(record.parsed.optimization.completed).toBe(true);
    expect(record.parsed.finalEnergy.hartree).not.toBeNull();
    expect(record.gates.overall).toBe('pass');

    // The captured stdout is the run's artifact even though xTB writes no file.
    const artifact = path.join(started.runDir, built.outputName);
    expect(fs.statSync(artifact).size).toBeGreaterThan(1000);
    expect(fs.existsSync(path.join(started.runDir, 'xtbopt.xyz'))).toBe(true);
    await fsp.rm(runsRoot, { recursive: true, force: true });
  }, 180_000);

  it('fails the run when the executable is missing rather than pretending', async () => {
    const runsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-runs-'));
    const manager = new RunManager({ runsRoot, emit: () => {} });
    const built = buildXtbInput({ settings: { jobType: 'SP' }, molecule: { charge: 0, multiplicity: 1, coords: WATER }, inputName: 'water.xyz' });
    await expect(manager.start({
      engine: 'xtb',
      argv: built.argv,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      executable: path.join(runsRoot, 'nope', 'xtb'),
    })).rejects.toThrow(/executable not found/);
    await fsp.rm(runsRoot, { recursive: true, force: true });
  }, 60_000);

  it('rejects a Gaussian input name on the xTB engine', async () => {
    const runsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-runs-'));
    const manager = new RunManager({ runsRoot, emit: () => {} });
    await expect(manager.start({
      engine: 'xtb',
      argv: ['water.gjf'],
      inputText: 'whatever',
      inputName: 'water.gjf',
      outputName: 'water.out',
      executable: XTB_BIN,
    })).rejects.toThrow(/safe \.xyz/);
    await fsp.rm(runsRoot, { recursive: true, force: true });
  }, 30_000);
});
