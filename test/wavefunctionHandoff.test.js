/**
 * Issue 343: the wavefunction hand-off to Multiwfn.
 *
 * The guide documents `input.nodeId`: a Multiwfn block reads the wavefunction
 * file its upstream run left in the run folder. That only works if the engine
 * writes one, so this file pins the three halves of the contract:
 *
 * - the Psi4 deck calls `fchk(wfn, '<job>.fchk')` on every job type that has a
 *   wavefunction, and prints why SAPT0 has none;
 * - the xTB argv carries `--molden`, except on GFN-FF, which has no orbitals;
 * - the run-folder scan finds `molden.input` by its whole name and refuses a
 *   folder with only unrelated `.input` files with a message that names both the
 *   formats and the engines that can produce them.
 *
 * No Psi4 or xTB binary is run here: the assertions are on the generated input
 * and argv, which is what the app controls. A live run of either is not part of
 * this suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rmrf } from './helpers/tempCleanup.js';
import { buildPsi4Input } from '../src/shared/engines/psi4.js';
import { buildXtbInput } from '../src/shared/engines/xtb.js';
import {
  multiwfnAnalysis,
  multiwfnEngineSourcesSentence,
  multiwfnInputFormat,
  validateMultiwfnDefinition,
} from '../src/shared/multiwfn.js';
import { QueueManager } from '../electron/runner/queue.js';
import { RunManager, wavefunctionForRun } from '../electron/runner/runManager.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOLDEN = path.join(ROOT, 'test/fixtures/molden/water-cartesian-au.molden');
const FCHK = path.join(ROOT, 'test/fixtures/esp/water-esp.fchk');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];
const DIMER = [
  { element: 'O', x: 0, y: 0, z: 0, fragment: 1 },
  { element: 'H', x: 0.9, y: 0, z: 0, fragment: 1 },
  { element: 'O', x: 0, y: 0, z: 3, fragment: 2 },
  { element: 'H', x: 0, y: 0.9, z: 3, fragment: 2 },
];

const psi4 = ({ jobType = 'SP', coords = WATER, ...settings } = {}) => buildPsi4Input({
  settings: { jobType, method: 'b3lyp', basis: '6-31g(d)', tdStates: 3, ...settings },
  molecule: { charge: 0, multiplicity: 1, coords, fragments: [] },
  inputName: 'sp.dat',
});

const xtb = (settings = {}) => buildXtbInput({
  settings: { jobType: 'SP', ...settings },
  molecule: { charge: 0, multiplicity: 1, coords: WATER },
  inputName: 'sp.xyz',
});

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

describe('issue 343 — Psi4 writes the checkpoint Multiwfn reads', () => {
  it('writes <job>.fchk after the energy call of a single point', () => {
    const built = psi4();
    expect(built.inputText).toContain("E, wfn = energy('b3lyp', return_wfn=True)");
    expect(built.inputText).toContain("fchk(wfn, 'sp.fchk')");
    expect(built.outputName).toBe('sp.out');
  });

  it('writes it for Opt, Freq and Opt Freq from the call that returns the wavefunction', () => {
    const opt = psi4({ jobType: 'Opt' });
    expect(opt.inputText).toContain("E, wfn = optimize('b3lyp', return_wfn=True)");
    expect(opt.inputText).toContain("fchk(wfn, 'sp.fchk')");

    const freq = psi4({ jobType: 'Freq' });
    expect(freq.inputText).toContain("E, wfn = frequencies('b3lyp', return_wfn=True)");
    expect(freq.inputText).toContain("fchk(wfn, 'sp.fchk')");

    const both = psi4({ jobType: 'Opt Freq' });
    // One file, written after the Hessian: the density belongs to the optimised
    // geometry, and a second write would leave two candidates in the folder.
    expect(both.inputText.match(/fchk\(wfn, /g)).toHaveLength(1);
    expect(both.inputText.indexOf("E, wfn = frequencies('b3lyp', return_wfn=True)"))
      .toBeLessThan(both.inputText.indexOf("fchk(wfn, 'sp.fchk')"));
  });

  it('writes it for TD-DFT, with and without the transition-dipole record', () => {
    for (const settings of [{}, { recordTransitionDipoles: true }]) {
      const built = psi4({ jobType: 'TD-DFT', ...settings });
      expect(built.inputText).toContain("fchk(wfn, 'sp.fchk')");
      expect(built.inputText.match(/fchk\(wfn, /g)).toHaveLength(1);
    }
    expect(psi4({ jobType: 'TD-DFT' }).inputText)
      .toContain("E, wfn = energy('td-b3lyp', return_wfn=True)");
  });

  it('names the file after the job, so the run folder holds one stable name', () => {
    const built = buildPsi4Input({
      settings: { jobType: 'Opt', method: 'hf', basis: '6-31g(d)' },
      molecule: { charge: 0, multiplicity: 1, coords: WATER, fragments: [] },
      inputName: 'water-opt.dat',
    });
    expect(built.inputText).toContain("fchk(wfn, 'water-opt.fchk')");
  });

  it('writes one for MP2 and says the checkpoint is its SCF reference', () => {
    const built = psi4({ method: 'mp2' });
    expect(built.inputText).toContain("E, wfn = energy('mp2', return_wfn=True)");
    expect(built.inputText).toContain("fchk(wfn, 'sp.fchk')");
    // Psi4's `return_wfn` for MP2 is the reference wavefunction; a file named
    // after an MP2 job must not imply an MP2 density.
    expect(built.inputText).toContain('its SCF reference');
    expect(built.inputText).toContain('not a correlated one');
  });

  it('writes none for SAPT0, and the deck says why', () => {
    const built = psi4({ method: 'sapt0', coords: DIMER });
    expect(built.inputText).toContain("energy('sapt0')");
    expect(built.inputText).not.toContain('fchk(wfn');
    expect(built.inputText).not.toMatch(/^fchk\(/m);
    expect(built.inputText).toContain('No checkpoint: SAPT0 is a property of the dimer');
  });
});

describe('issue 343 — xTB asks for a Molden file', () => {
  it('carries --molden on every GFN job type', () => {
    for (const jobType of ['SP', 'Opt', 'Freq', 'Opt Freq']) {
      expect(xtb({ jobType }).argv, jobType).toContain('--molden');
    }
  });

  it('does not carry it for GFN-FF, which has no orbitals', () => {
    const built = xtb({ xtbMethod: 'gfnff' });
    expect(built.argv).toContain('--gfnff');
    expect(built.argv).not.toContain('--molden');
  });

  it('leaves the rest of the argv in place', () => {
    const built = xtb({ jobType: 'Opt', xtbOptLevel: 'tight', solvation: true, solvent: 'Water' });
    expect(built.argv).toEqual(['sp.xyz', '--gfn', '2', '--opt', 'tight', '--molden', '--alpb', 'water']);
  });
});

describe('issue 343 — Multiwfn input discovery', () => {
  const definitionFor = (analysis, input = { nodeId: 'calc' }) => validateMultiwfnDefinition({
    analysis, input,
  }).value;

  async function resolveIn(runDir, analysis = 'qtaim') {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfhandoff-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runManager = new RunManager({ runsRoot: path.join(base, 'runs'), emit: () => {} });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await queueManager.init();
    const definition = definitionFor(analysis);
    const queue = {
      id: 'wf-queue',
      projectName: 'Wavefunction',
      status: 'running',
      createdAt: new Date().toISOString(),
      options: { projectDir: base, maxParallel: 1, dryRun: false },
      timeoutSeconds: 60,
      edges: [{ from: 'calc', to: 'mw', type: 'dependency' }],
      tasks: [
        { nodeId: 'calc', title: 'xTB SP', status: 'completed', runDir, runId: 'run-1' },
        {
          nodeId: 'mw', type: 'analyse', title: 'Multiwfn QTAIM', status: 'pending', attempts: 0,
          analyse: { mode: 'multiwfn', multiwfn: definition, sources: ['calc'] },
        },
      ],
    };
    return queueManager.resolveMultiwfnInput(queue, queue.tasks[1], definition, multiwfnAnalysis(analysis));
  }

  async function runFolder(files) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfrun-'));
    roots.push(dir);
    for (const [name, source] of Object.entries(files)) {
      await fsp.copyFile(source, path.join(dir, name));
    }
    return dir;
  }

  it('finds xTB\'s molden.input in the upstream run folder', async () => {
    const runDir = await runFolder({ 'molden.input': MOLDEN });
    const resolved = await resolveIn(runDir);
    expect(resolved.name).toBe('molden.input');
    expect(resolved.format).toBe('molden');
    expect(resolved.source).toMatchObject({ kind: 'node', nodeId: 'calc', file: 'molden.input' });
  });

  it('attaches molden.input to the run record as a Molden wavefunction', async () => {
    const runDir = await runFolder({ 'molden.input': MOLDEN });
    const record = await wavefunctionForRun(runDir);
    expect(record.artifacts.map((entry) => [entry.kind, entry.file]))
      .toEqual([['molden', 'molden.input']]);
    expect(record.fchk.format).toBe('molden');
  });

  it('does not attach an unrelated .input file', async () => {
    const runDir = await runFolder({ 'notes.input': MOLDEN });
    expect(await wavefunctionForRun(runDir)).toBeNull();
  });

  it('does not read an unrelated .input file as a wavefunction', async () => {
    const runDir = await runFolder({ 'notes.input': MOLDEN });
    await expect(resolveIn(runDir)).rejects.toThrow(/carries no/);
  });

  it('still prefers an .fchk over a molden file when both are present', async () => {
    const runDir = await runFolder({ 'molden.input': MOLDEN, 'job.fchk': FCHK });
    const resolved = await resolveIn(runDir);
    expect(resolved.name).toBe('job.fchk');
    expect(resolved.format).toBe('fchk');
  });

  it('names the formats and the engines in the refusal', async () => {
    const runDir = await runFolder({ 'notes.input': MOLDEN });
    const error = await resolveIn(runDir).catch((caught) => caught);
    expect(error.message).toContain('carries no');
    // The formats the analysis reads.
    for (const format of ['.fchk', '.wfn', '.wfx', '.molden']) {
      expect(error.message).toContain(format);
    }
    // The engines that can satisfy it, and the one that cannot.
    for (const engine of ['Psi4', 'xTB', 'Gaussian', 'ORCA']) {
      expect(error.message).toContain(engine);
    }
    expect(error.message).toContain('molden.input');
    expect(error.message).toContain('formchk -3');
    expect(error.message).toContain('.gbw');
  });

  it('accepts molden.input as a project-relative input.path, and not a bare .input', () => {
    const accepted = validateMultiwfnDefinition({
      analysis: 'qtaim',
      input: { path: 'wavefunctions/molden.input' },
    });
    expect(accepted.errors).toEqual([]);
    expect(accepted.value.input).toEqual({ path: 'wavefunctions/molden.input' });

    const refused = validateMultiwfnDefinition({
      analysis: 'qtaim',
      input: { path: 'wavefunctions/notes.input' },
    });
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0].path).toBe('input.path');
    expect(refused.errors[0].message).toContain('.input file');
  });

  it('maps names to formats without inventing an .input extension', () => {
    expect(multiwfnInputFormat('molden.input')).toBe('molden');
    expect(multiwfnInputFormat('MOLDEN.INPUT')).toBe('molden');
    expect(multiwfnInputFormat('notes.input')).toBe('');
    expect(multiwfnInputFormat('job.fchk')).toBe('fchk');
    expect(multiwfnInputFormat('job.cube')).toBe('cube');
    expect(multiwfnInputFormat('molden')).toBe('');
  });

  it('states the same engine list the refusal uses', () => {
    const sentence = multiwfnEngineSourcesSentence();
    for (const token of ['Psi4', 'xTB', 'molden.input', 'Gaussian', 'formchk -3', 'ORCA', '.gbw']) {
      expect(sentence).toContain(token);
    }
  });
});
