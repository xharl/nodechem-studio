import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ORCA_BASES,
  ORCA_CAPABILITIES,
  ORCA_METHODS,
  ORCA_SOLVENTS,
  buildOrcaInput,
  classifyOrcaTermination,
  makeOrcaFixtureOutput,
  orcaCheckpointArtifact,
  orcaMethodBlock,
  orcaSettingsOffenders,
  parseOrcaOutput,
} from '../src/shared/engines/orca.js';
import { ENGINES, engineFor, engineOrDefault, isEngineId } from '../src/shared/engines/index.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildRunInput, engineForNode } from '../src/shared/workflowTasks.js';
import { evaluateGates } from '../src/shared/gaussianOutput.js';
import { preflight } from '../electron/runner/preflight.js';
import { RunManager } from '../electron/runner/runManager.js';

/**
 * ORCA engine tests.
 *
 * The output fixtures are synthetic but quote the block shapes documented in
 * the ORCA 6.0 manual/tutorials. No ORCA binary was available, so these tests
 * prove the parser reads the documented format — not that a live ORCA run was
 * parsed.
 */
const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'orca', name), 'utf8');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const molecule = (overrides = {}) => ({ charge: 0, multiplicity: 1, coords: WATER, ...overrides });

const settings = (overrides = {}) => defaultSettings({
  jobType: 'SP',
  method: 'B3LYP',
  basis: 'def2-SVP',
  dispersion: '',
  ...overrides,
});

const build = (overrides = {}, name = 'task.inp') => buildOrcaInput({
  title: 'water',
  settings: settings(overrides),
  molecule: molecule(),
  inputName: name,
});

const roots = [];

async function tempRoot(prefix = 'gns-orca-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const canonical = await fsp.realpath(root);
  roots.push(canonical);
  return canonical;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('ORCA engine registry', () => {
  it('registers ORCA alongside Gaussian and xTB', () => {
    expect(Object.keys(ENGINES)).toEqual(['gaussian', 'xtb', 'orca', 'psi4', 'pyscf']);
    expect(isEngineId('orca')).toBe(true);
    expect(engineFor('orca').id).toBe('orca');
    expect(engineOrDefault('orca').label).toBe('ORCA 6');
    // The inspector builds both engine menus from Object.values(ENGINES).
    expect(Object.values(ENGINES).map((engine) => engine.label)).toContain('ORCA 6');
  });

  it('exposes the simple-input capabilities', () => {
    expect(ORCA_CAPABILITIES.inputExtension).toBe('.inp');
    expect(ORCA_CAPABILITIES.capturesStdout).toBe(true);
    expect(ORCA_CAPABILITIES.restartArtifact).toBe('.gbw');
    expect(ORCA_CAPABILITIES.jobTypes).toEqual(['SP', 'Opt', 'Opt Freq', 'Freq', 'TD-DFT']);
    expect(ORCA_CAPABILITIES.unsupportedJobTypes).toContain('Opt=TS');
    expect(ORCA_METHODS.map((method) => method.id)).toContain('CCSD(T)');
    expect(ORCA_BASES.find((basis) => basis.id === '6-31G(d)').keyword).toBe('6-31G*');
    expect(ORCA_SOLVENTS.THF).toBe('THF');
  });
});

describe('ORCA input builder', () => {
  it('writes a simple input for a single point', () => {
    const built = build();
    expect(built.engine).toBe('orca');
    expect(built.inputName).toBe('task.inp');
    expect(built.outputName).toBe('task.out');
    expect(built.argv).toEqual(['task.inp']);
    expect(built.captureStdout).toBe(true);
    const lines = built.inputText.split('\n');
    expect(lines[0]).toBe('! B3LYP def2-SVP');
    expect(lines[1]).toBe('# water');
    expect(lines).toContain('* xyz 0 1');
    expect(lines.at(-2)).toBe('*');
    expect(built.inputText).toContain('O    ');
  });

  it('maps each supported job type to its ORCA keyword', () => {
    expect(build({ jobType: 'SP' }).inputText.split('\n')[0]).toBe('! B3LYP def2-SVP');
    expect(build({ jobType: 'Opt' }).inputText.split('\n')[0]).toBe('! B3LYP def2-SVP Opt');
    expect(build({ jobType: 'Freq' }).inputText.split('\n')[0]).toBe('! B3LYP def2-SVP Freq');
    expect(build({ jobType: 'Opt Freq' }).inputText.split('\n')[0]).toBe('! B3LYP def2-SVP Opt Freq');
  });

  it('writes %pal and %maxcore from the Gaussian resource fields', () => {
    const built = build({ nproc: 8, memory: '16', memoryUnit: 'GB' });
    const lines = built.inputText.split('\n');
    expect(lines).toContain('%pal nprocs 8 end');
    expect(lines).toContain('%maxcore 2048');
    expect(built.resources).toEqual({ nprocs: 8, maxcoreMb: 2048 });
  });

  it('maps dispersion, SCF, grid and optimisation keywords', () => {
    const built = build({
      jobType: 'Opt',
      dispersion: 'GD3BJ',
      scf: 'Tight',
      grid: 'UltraFine',
      optConvergence: 'VeryTight',
    });
    expect(built.inputText.split('\n')[0]).toBe('! B3LYP def2-SVP Opt D3BJ TightSCF DEFGRID3 VeryTightOpt');
    expect(built.dispersion).toBe('D3BJ');
  });

  it('maps D3 and D4 dispersion to ORCA keywords', () => {
    expect(build({ dispersion: 'GD3' }).dispersion).toBe('D3ZERO');
    expect(build({ dispersion: 'D4' }).dispersion).toBe('D4');
    expect(build({ dispersion: '' }).dispersion).toBeNull();
  });

  it('writes CPCM as a keyword and SMD as the documented %cpcm block', () => {
    const cpcm = build({ solvation: true, solvationModel: 'CPCM', solvent: 'Water' });
    expect(cpcm.inputText.split('\n')[0]).toContain('CPCM(WATER)');
    expect(cpcm.solvation).toEqual({ model: 'CPCM', solvent: 'WATER', label: 'Water' });

    const smd = build({ solvation: true, solvationModel: 'SMD', solvent: 'Toluene' });
    expect(smd.inputText).toContain('CPCM(TOLUENE)');
    expect(smd.inputText).toContain('%cpcm');
    expect(smd.inputText).toContain('  smd true');
    expect(smd.inputText).toContain('  smdsolvent "TOLUENE"');
    expect(smd.solvation.model).toBe('SMD');
  });

  it('refuses job types simple input cannot express instead of degrading them', () => {
    for (const jobType of ['Opt=TS', 'IRC', 'Scan', 'NMR']) {
      expect(() => build({ jobType })).toThrow(/ORCA simple input cannot express/);
    }
  });

  it('refuses a method or basis this builder cannot spell', () => {
    expect(() => build({ method: 'ωB97X-D' })).toThrow(/no simple-input keyword for method/);
    expect(() => build({ basis: 'SDD' })).toThrow(/no simple-input keyword for basis/);
  });

  it('refuses a Gaussian solvation model, dispersion keyword or SCF keyword', () => {
    expect(() => build({ solvation: true, solvationModel: 'PCM', solvent: 'Water' }))
      .toThrow(/does not implement PCM/);
    expect(() => build({ dispersion: 'GD3BJ2' })).toThrow(/no keyword for dispersion/);
    expect(() => build({ scf: 'Loose' })).toThrow(/no SCF keyword/);
    expect(() => build({ grid: 'Coarse' })).toThrow(/no integration-grid keyword/);
  });

  it('refuses Gaussian-only settings with a message naming the setting', () => {
    expect(() => build({ customKeywords: 'Geom=Check' })).toThrow(/Custom route keywords cannot be used on an ORCA block/);
    expect(() => build({ tdStates: 5 })).toThrow(/TD-DFT states cannot be used on an ORCA block/);
    expect(() => build({ stableOpt: true })).toThrow(/Stable=Opt cannot be used on an ORCA block/);
    // Issue 288: Raman is supported now; only the job-type mismatch is refused.
    expect(() => build({ raman: true })).toThrow(/Raman activities need a frequency job/);
    expect(() => build({ population: 'NBO' })).toThrow(/Population analysis cannot be used on an ORCA block/);
    expect(orcaSettingsOffenders({})).toEqual([]);
  });

  it('rejects a charge/multiplicity parity mismatch', () => {
    expect(() => buildOrcaInput({
      settings: settings(),
      molecule: molecule({ multiplicity: 2 }),
      inputName: 't.inp',
    })).toThrow(/incompatible with multiplicity/);
  });

  it('rejects an unsafe input name and an invalid element', () => {
    expect(() => build({}, 'bad name.inp')).toThrow(/safe \.inp/);
    expect(() => buildOrcaInput({
      settings: settings(),
      molecule: molecule({ coords: [{ element: 'Xx', x: 0, y: 0, z: 0 }] }),
      inputName: 't.inp',
    })).toThrow(/invalid element/);
  });

  it('rewrites the planner’s Gaussian-style input name to .inp', () => {
    const built = build({}, 'node-1.gjf');
    expect(built.inputName).toBe('node-1.inp');
    expect(built.outputName).toBe('node-1.out');
  });
});

  it('writes a numerical Hessian and %elprop for Raman', () => {
    const built = build({ jobType: 'Freq', raman: true });
    // ORCA has no analytic Hessian for Raman intensities.
    expect(built.inputText.split('\n')[0]).toBe('! B3LYP def2-SVP NumFreq');
    expect(built.inputText).toContain('%elprop');
    expect(built.inputText).toContain('  Polar 1');
    expect(built.raman).toBe(true);
    expect(built.vcd).toBe(false);
  });

  it('writes %freq DOVCD for VCD and keeps the analytic Freq keyword', () => {
    const built = build({ jobType: 'Opt Freq', vcd: true });
    // VCD cannot be computed with NumFreq, so the analytic keyword stands.
    expect(built.inputText.split('\n')[0]).toBe('! B3LYP def2-SVP Opt Freq');
    expect(built.inputText).toContain('%freq');
    expect(built.inputText).toContain('  DOVCD true');
    expect(built.vcd).toBe(true);
    expect(built.raman).toBe(false);
  });

  it('refuses the Raman/VCD/ROA combinations ORCA cannot run', () => {
    expect(() => build({ jobType: 'SP', raman: true })).toThrow(/frequency job/);
    expect(() => build({ jobType: 'SP', vcd: true })).toThrow(/frequency job/);
    expect(() => build({ jobType: 'Freq', raman: true, vcd: true }))
      .toThrow(/cannot share one ORCA job/);
    expect(() => build({ jobType: 'Freq', roa: true })).toThrow(/no ROA/);
  });

  it('writes the %tddft block instead of a route keyword', () => {
    const built = build({ jobType: 'TD-DFT', tdStates: 5 });
    expect(built.inputText).toContain('%tddft');
    expect(built.inputText).toContain('  NRoots 5');
    // Full response, matching the Gaussian, Psi4 and PySCF blocks.
    expect(built.inputText).toContain('  TDA false');
    expect(built.tddft).toEqual({ nroots: 5, approximation: 'TD-DFT' });
    expect(built.route).toBe('B3LYP def2-SVP %tddft NRoots 5');
    // ORCA 6 stops on `TDDFT` in the simple input line, so the route stays clean.
    expect(built.inputText.split('\n')[0]).toBe('! B3LYP def2-SVP');
  });

  it('refuses a TD-DFT job it cannot express honestly', () => {
    expect(() => build({ jobType: 'TD-DFT' })).toThrow(/positive number of excited states/);
    expect(() => build({ jobType: 'TD-DFT', tdStates: 0 })).toThrow(/positive number of excited states/);
    expect(() => build({ jobType: 'TD-DFT', tdStates: 101 })).toThrow(/100 or fewer/);
    expect(() => build({ jobType: 'TD-DFT', tdStates: 5, method: 'MP2' }))
      .toThrow(/Hartree-Fock or density-functional reference/);
    expect(() => build({ jobType: 'TD-DFT', tdStates: 5, method: 'CCSD(T)' }))
      .toThrow(/Hartree-Fock or density-functional reference/);
  });

  it('refuses excited-state settings on a job that will not compute them', () => {
    expect(orcaSettingsOffenders({ jobType: 'SP', tdStates: 5 })).toEqual([
      { label: 'TD-DFT states', value: '5' },
    ]);
    expect(orcaSettingsOffenders({ jobType: 'TD-DFT', tdStates: 5 })).toEqual([]);
    expect(orcaSettingsOffenders({ jobType: 'TD-DFT', tdTriplets: 3 }).map((item) => item.label))
      .toEqual(['TD-DFT triplets']);
  });

describe('ORCA provenance and checkpoint artifacts', () => {
  it('records ORCA vocabulary rather than a Gaussian route', () => {
    const block = orcaMethodBlock(settings({
      jobType: 'Opt Freq',
      dispersion: 'GD3BJ',
      scf: 'Tight',
      grid: 'Fine',
      solvation: true,
      solvationModel: 'CPCM',
      solvent: 'Water',
      nproc: 4,
      memory: '8',
      memoryUnit: 'GB',
    }), { argv: ['task.inp'], jobType: 'Opt Freq' });
    expect(block).toMatchObject({
      program: 'ORCA',
      method: 'B3LYP',
      basis: 'def2-SVP',
      jobType: 'Opt Freq',
      dispersion: 'D3BJ',
      solvation: 'CPCM/WATER',
      scf: 'TightSCF',
      grid: 'DEFGRID2',
      resources: { nprocs: 4, maxcoreMb: 2048 },
    });
    const serialized = JSON.stringify(block);
    expect(serialized).not.toContain('EmpiricalDispersion');
    expect(serialized).not.toContain('%Chk');
  });

  it('maps a Gaussian checkpoint name to ORCA’s .gbw artifact', () => {
    expect(orcaCheckpointArtifact({ checkpointName: 'a.chk' })).toBe('a.gbw');
    expect(orcaCheckpointArtifact({ nodeId: 'node-1' })).toBe('node-1.gbw');
    expect(ENGINES.orca.checkpointArtifact({ checkpointName: 'a.chk' })).toBe('a.gbw');
  });

  it('writes %moinp for a .gbw hand-off and refuses any other artifact', () => {
    const built = buildOrcaInput({
      settings: settings(),
      molecule: molecule(),
      inputName: 'down.inp',
      oldCheckpoint: 'up.gbw',
    });
    expect(built.inputText).toContain('%moinp "up.gbw"');
    expect(() => buildOrcaInput({
      settings: settings(),
      molecule: molecule(),
      inputName: 'down.inp',
      oldCheckpoint: 'up.chk',
    })).toThrow(/requires a \.gbw/);
  });
});

describe('ORCA workflow integration', () => {
  const orcaProject = (nodeOverrides = {}) => validateProject({
    schemaVersion: 3,
    name: 'orca project',
    defaults: { engine: 'orca', method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4 },
    molecule: { charge: 0, multiplicity: 1, coords: WATER, fragments: [], geometry: { kind: 'manual' } },
    nodes: [{
      id: 'sp',
      type: 'calculate',
      title: 'water sp',
      x: 0,
      y: 0,
      settings: defaultSettings({ jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', ...nodeOverrides }),
    }],
    edges: [],
  }).project;

  it('resolves ORCA from the project default and from a per-block override', () => {
    const project = orcaProject();
    expect(engineForNode(project, project.nodes[0]).id).toBe('orca');

    const mixed = validateProject({
      ...orcaProject(),
      defaults: { engine: 'gaussian', method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4 },
    }).project;
    mixed.nodes[0].settings.engine = 'orca';
    expect(engineForNode(mixed, mixed.nodes[0]).id).toBe('orca');
  });

  it('builds an .inp through the existing buildRunInput path', () => {
    const project = orcaProject();
    const built = buildRunInput(project, project.nodes[0]);
    expect(built.engine).toBe('orca');
    expect(built.inputName).toBe('sp.inp');
    expect(built.outputName).toBe('sp.out');
    expect(built.inputText.split('\n')[0]).toMatch(/^! B3LYP def2-SVP( D3BJ)?$/);
  });

  it('refuses a Gaussian-only setting through buildRunInput', () => {
    const project = orcaProject({ tdStates: 5 });
    expect(() => buildRunInput(project, project.nodes[0]))
      .toThrow(/TD-DFT states cannot be used on an ORCA block/);
  });
});

describe('ORCA output parser — synthetic fixtures in documented format', () => {
  it('parses a single point: version, SCF, final energy, termination', () => {
    const parsed = parseOrcaOutput(fixture('water-sp.out'));
    expect(parsed.engine).toBe('orca');
    expect(parsed.status).toBe('completed');
    expect(parsed.terminationCode).toBe('normal');
    expect(parsed.termination).toBe('ORCA TERMINATED NORMALLY');
    expect(parsed.program).toEqual({ name: 'ORCA', version: '6.0.0', revision: 'RELEASE' });
    expect(parsed.scf.status).toBe('converged');
    expect(parsed.scf.cycles).toBe(12);
    expect(parsed.scf.energyHartree).toBeCloseTo(-76.02664842298829, 10);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.067231549516, 10);
    expect(parsed.finalEnergy.source).toBe('final-single-point');
    expect(parsed.scf.method).toBe('B3LYP');
    expect(parsed.extras.basis).toBe('def2-SVP');
    expect(parsed.extras.jobType).toBe('SP');
    expect(parsed.frequencies.count).toBe(0);
    expect(parsed.optimization.attempted).toBe(false);
    expect(parsed.extras.unrecognised).toBeUndefined();
  });

  it('parses an optimisation and frequency job: convergence, modes, thermochemistry', () => {
    const parsed = parseOrcaOutput(fixture('water-opt-freq.out'));
    expect(parsed.status).toBe('completed');
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.stationary).toBe(true);
    expect(parsed.optimization.attempted).toBe(true);
    expect(parsed.optimization.cycles).toBe(8);
    expect(parsed.frequencies.count).toBe(9);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.frequencies.imaginaryValues).toEqual([]);
    expect(parsed.frequencies.minImaginary).toBeNull();
    expect(parsed.frequencies.scalingFactor).toBe(1);
    expect(parsed.frequencies.entropyTreatment).toBe('QRRHO');
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-76.067, 6);
    expect(parsed.thermochemistry.enthalpyHartree).toBeCloseTo(-76.045, 6);
    expect(parsed.thermochemistry.zpeHartree).toBeCloseTo(0.021, 8);
    expect(parsed.extras.jobType).toBe('Opt Freq');
    expect(parsed.extras.thermochemistryTemperatureK).toBe(298.15);

    // The canonical result is what the gates read; no Gaussian branch.
    const gates = evaluateGates(parsed, {
      expectedImaginary: 0,
      requireOptimization: true,
      requireFrequency: true,
      requireThermochemistry: true,
      requireFinalEnergy: true,
    });
    expect(gates.overall).toBe('pass');
  });

  it('reports an SCF failure as an error with no final energy', () => {
    const parsed = parseOrcaOutput(fixture('failure-scf.out'));
    expect(parsed.status).toBe('error');
    expect(parsed.terminationCode).toBe('error');
    expect(parsed.termination).toMatch(/error termination in SCF/);
    expect(parsed.scf.status).toBe('failed');
    expect(parsed.scf.cycles).toBe(125);
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.extras.errorModule).toBe('SCF');
  });

  it('returns an explicit unrecognised result for a non-ORCA document', () => {
    const parsed = parseOrcaOutput(fixture('not-orca.out'));
    expect(parsed.engine).toBe('orca');
    expect(parsed.status).toBe('incomplete');
    expect(parsed.terminationCode).toBe('none');
    expect(parsed.termination).toBe('Not ORCA output');
    expect(parsed.extras.unrecognised).toBe(true);
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.scf.status).toBe('unknown');
  });

  it('never reports a truncated parse as complete', () => {
    const parsed = parseOrcaOutput(fixture('water-opt-freq.out'), { truncated: true });
    expect(parsed.complete).toBe(false);
    expect(parsed.status).toBe('completed');
  });

  it('parses the dry-run fixture, including an imaginary mode', () => {
    const real = parseOrcaOutput(makeOrcaFixtureOutput());
    expect(real.status).toBe('completed');
    expect(real.program.version).toBe('6.0.0');
    expect(real.scf.method).toBe('B3LYP');
    expect(real.frequencies.count).toBe(9);
    expect(real.frequencies.imaginaryCount).toBe(0);

    const imaginary = parseOrcaOutput(makeOrcaFixtureOutput({ imaginary: 1 }));
    expect(imaginary.frequencies.imaginaryCount).toBe(1);
    expect(imaginary.frequencies.minImaginary).toBeCloseTo(-83.22, 2);
  });

  it('reads the Raman table from a real ORCA 6.1.1 log', () => {
    const parsed = parseOrcaOutput(fixture('water-raman.out'));
    expect(parsed.raman).toHaveLength(3);
    expect(parsed.raman[0]).toEqual({
      mode: 6, frequencyCm: 1596.13, ramanActivity: 6.367325, depolarization: 0.524741,
    });
    // The two A1 modes carry most of the activity; the table keeps mode numbers.
    expect(parsed.raman.map((mode) => mode.mode)).toEqual([6, 7, 8]);
    expect(parsed.raman[1].ramanActivity).toBeCloseTo(74.743698, 6);
    expect(parsed.vcd).toBeUndefined();
  });

  it('reads the VCD table and keeps the sign of each rotational strength', () => {
    const parsed = parseOrcaOutput(fixture('chfclbr-vcd.out'));
    expect(parsed.vcd).toHaveLength(9);
    expect(parsed.vcd[0]).toEqual({ mode: 6, frequencyCm: 218.8, rotationalStrength: -0.21 });
    // The sign is the enantiomer signal; a reader that normalised it would be wrong.
    expect(parsed.vcd.map((mode) => Math.sign(mode.rotationalStrength)))
      .toEqual(expect.arrayContaining([-1, 1]));
    expect(parsed.raman).toBeUndefined();
  });

  it('carries no Raman or VCD table when the log has none', () => {
    const parsed = parseOrcaOutput(fixture('water-opt-freq.out'));
    expect(parsed.raman).toBeUndefined();
    expect(parsed.vcd).toBeUndefined();
  });

  it('reads the excited states of a real ORCA 6.1.1 TD-DFT log', () => {
    const parsed = parseOrcaOutput(fixture('water-tddft.out'));
    expect(parsed.status).toBe('completed');
    expect(parsed.program.version).toBe('6.1.1');
    expect(parsed.extras.jobType).toBe('TD-DFT');
    expect(parsed.scf.energyHartree).toBeCloseTo(-76.32111959665978, 10);
    // ORCA prints FINAL SINGLE POINT ENERGY as E(SCF)+DE(CIS); the record keeps
    // the ground state there and carries the decomposition beside the states.
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.32111959665978, 10);
    expect(parsed.finalEnergy.source).toMatch(/scf-ground-state/);

    const es = parsed.excitedStates;
    expect(es.count).toBe(5);
    expect(es.source).toBe('orca-tddft');
    expect(es.verified).toBe(true);
    expect(es.transitionDipoleCount).toBe(5);
    expect(es.totalEnergy.hartree).toBeCloseTo(-76.042399842, 9);
    expect(es.totalEnergy.scfHartree).toBeCloseTo(-76.321119597, 9);
    expect(es.totalEnergy.excitationHartree).toBeCloseTo(0.278719754, 9);
    expect(es.totalEnergy.root).toBe(1);

    const first = es.states[0];
    expect(first.index).toBe(1);
    expect(first.energyEv).toBeCloseTo(7.58435, 5);
    expect(first.wavelengthNm).toBeCloseTo(163.5, 4);
    expect(first.oscillatorStrength).toBeCloseTo(0.018099348, 9);
    expect(first.transitionDipoleAu.x).toBeCloseTo(0.3121, 4);
    expect(first.transitions[0]).toMatchObject({ from: '4a', to: '5a' });
    // A dark state keeps its zero vector rather than losing the field.
    expect(es.states[1].oscillatorStrength).toBe(0);
    expect(es.states[1].transitionDipoleAu).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('reads the ethene pi-pi* root from the same layout', () => {
    const parsed = parseOrcaOutput(fixture('ethene-tddft.out'));
    expect(parsed.extras.jobType).toBe('TD-DFT');
    expect(parsed.excitedStates.count).toBe(5);
    const first = parsed.excitedStates.states[0];
    expect(first.energyEv).toBeCloseTo(8.136085, 5);
    expect(first.wavelengthNm).toBeCloseTo(152.4, 4);
    expect(first.oscillatorStrength).toBeCloseTo(0.375187279, 8);
    expect(Math.abs(first.transitionDipoleAu.x)).toBeCloseTo(1.37195, 4);
  });

  it('has no excited-state block when the log carries none', () => {
    expect(parseOrcaOutput(fixture('water-sp.out')).excitedStates).toBeUndefined();
  });

  it('carries the route through when the caller supplies one', () => {
    const parsed = parseOrcaOutput(fixture('water-sp.out'), { route: '! B3LYP def2-SVP' });
    expect(parsed.route).toBe('! B3LYP def2-SVP');
  });
});

describe('ORCA termination classifier', () => {
  it('treats the documented final line as normal termination', () => {
    expect(classifyOrcaTermination(fixture('water-sp.out'), 0).code).toBe('normal');
  });

  it('treats an error termination in a module as an error', () => {
    const classified = classifyOrcaTermination(fixture('failure-scf.out'), 0);
    expect(classified.code).toBe('error');
    expect(classified.reason).toMatch(/error termination in SCF/);
  });

  it('treats a non-zero exit with no marker as an error', () => {
    expect(classifyOrcaTermination('nothing useful', 1).code).toBe('error');
  });

  it('leaves an empty run unknown', () => {
    expect(classifyOrcaTermination('', 0).code).toBe('none');
  });
});

describe('ORCA dry run through the production RunManager path', () => {
  it('parses the fixture, records ORCA provenance and passes the gates', async () => {
    const runsRoot = await tempRoot('gns-orca-runs-');
    const manager = new RunManager({ runsRoot, emit: () => {} });
    const built = build({ jobType: 'Opt Freq', dispersion: 'GD3BJ', nproc: 4, memory: '4' });
    const started = await manager.start({
      title: 'water opt freq',
      engine: 'orca',
      dryRun: true,
      argv: built.argv,
      route: built.route,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      settings: { jobType: 'Opt Freq', method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ', nproc: 4, memory: '4', memoryUnit: 'GB' },
      gates: {
        expectedImaginary: 0,
        requireOptimization: true,
        requireFrequency: true,
        requireThermochemistry: true,
        requireFinalEnergy: true,
      },
    });

    const runPath = path.join(started.runDir, 'run.json');
    let record = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const candidate = JSON.parse(await fsp.readFile(runPath, 'utf8'));
        record = candidate;
        if (candidate.status !== 'running') break;
      } catch {
        // run.json is rewritten in place; a read can catch a partial write.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(record).not.toBeNull();

    expect(record.status).toBe('completed');
    expect(record.engine).toBe('orca');
    expect(record.parsed.engine).toBe('orca');
    expect(record.parsed.terminationCode).toBe('normal');
    expect(record.parsed.optimization.completed).toBe(true);
    expect(record.parsed.frequencies.count).toBe(9);
    expect(record.parsed.thermochemistry.freeEnergyHartree).not.toBeNull();
    expect(record.gates.overall).toBe('pass');
    expect(record.provenance.method.program).toBe('ORCA');
    expect(record.provenance.method.method).toBe('B3LYP');
    expect(record.provenance.method.dispersion).toBe('D3BJ');
    expect(fs.existsSync(path.join(started.runDir, built.inputName))).toBe(true);
  });
});

describe('ORCA preflight', () => {
  it('checks an ORCA executable by name and does not require Gaussian Link 1', async () => {
    const root = await tempRoot();
    const executable = path.join(root, 'orca');
    await fsp.writeFile(executable, '#!/bin/sh\nexit 0\n');
    await fsp.chmod(executable, 0o755);
    const userData = await tempRoot('gns-orca-user-');
    const result = await preflight(
      { engine: 'orca', executable },
      { platform: process.platform === 'win32' ? 'win32' : 'linux', env: {}, userData },
    );
    const byId = Object.fromEntries(result.checks.map((entry) => [entry.id, entry]));
    expect(byId.executable.ok).toBe(true);
    expect(byId['executable-exists'].ok).toBe(true);
    expect(byId['executable-name'].ok).toBe(true);
    expect(byId['executable-name'].detail).toContain('orca');
    expect(byId['gauss-exedir']).toBeUndefined();
    expect(byId['link1-present']).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('rejects a non-ORCA executable name', async () => {
    const root = await tempRoot();
    const executable = path.join(root, 'g16');
    await fsp.writeFile(executable, '#!/bin/sh\nexit 0\n');
    await fsp.chmod(executable, 0o755);
    const userData = await tempRoot('gns-orca-user-');
    const result = await preflight(
      { engine: 'orca', executable },
      { platform: process.platform === 'win32' ? 'win32' : 'linux', env: {}, userData },
    );
    const name = result.checks.find((entry) => entry.id === 'executable-name');
    expect(name.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});
