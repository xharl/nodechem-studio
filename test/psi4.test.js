import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PSI4_BASES,
  PSI4_CAPABILITIES,
  PSI4_METHODS,
  buildPsi4Input,
  classifyPsi4Termination,
  isSafePsi4InputName,
  makePsi4FixtureOutput,
  parsePsi4Output,
  psi4SettingsOffenders,
} from '../src/shared/engines/psi4.js';
import { ENGINES, engineFor, engineOrDefault, isEngineId } from '../src/shared/engines/index.js';
import * as projectSchema from '../src/shared/projectSchema.js';

const real = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const settings = (overrides = {}) => ({
  jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4, ...overrides,
});

const molecule = (overrides = {}) => ({ charge: 0, multiplicity: 1, coords: WATER, fragments: [], ...overrides });

describe('Psi4 engine registry', () => {
  it('registers Psi4 as a fourth engine', () => {
    expect(Object.keys(ENGINES)).toEqual(['gaussian', 'xtb', 'orca', 'psi4']);
    expect(isEngineId('psi4')).toBe(true);
    expect(engineFor('psi4').id).toBe('psi4');
    expect(engineOrDefault('psi4').label).toBe('Psi4');
  });

  it('states the capabilities it actually implements', () => {
    expect(PSI4_CAPABILITIES.inputExtension).toBe('.dat');
    expect(PSI4_CAPABILITIES.capturesStdout).toBe(true);
    expect(PSI4_CAPABILITIES.restartArtifact).toBeNull();
    expect(PSI4_CAPABILITIES.jobTypes).toEqual(['SP', 'Opt', 'Freq', 'Opt Freq']);
    expect(PSI4_CAPABILITIES.unsupportedFeatures.join(' ')).toMatch(/implicit solvation/);
  });
});

describe('Psi4 input builder', () => {
  it('writes a Psithon script with the molecule, the basis and one call', () => {
    const built = buildPsi4Input({ title: 'water sp', settings: settings(), molecule: molecule(), inputName: 'sp.dat' });
    expect(built.engine).toBe('psi4');
    expect(built.inputName).toBe('sp.dat');
    expect(built.outputName).toBe('sp.out');
    expect(built.argv).toEqual(['sp.dat']);
    expect(built.inputText).toContain('memory 4096 mb');
    expect(built.inputText).toContain('molecule {');
    expect(built.inputText).toContain('0 1');
    expect(built.inputText).toContain('O  0.000000  0.000000  0.117300');
    expect(built.inputText).toContain('set basis def2-svp');
    expect(built.inputText).toContain('set reference rhf');
    expect(built.inputText).toContain("energy('b3lyp')");
  });

  it('rewrites the planner\'s .gjf name and keeps the name strict', () => {
    const built = buildPsi4Input({ settings: settings(), molecule: molecule(), inputName: 'task.gjf' });
    expect(built.inputName).toBe('task.dat');
    expect(() => buildPsi4Input({ settings: settings(), molecule: molecule(), inputName: '../x.dat' }))
      .toThrow(/safe \.dat basename/);
    expect(isSafePsi4InputName('task.dat')).toBe(true);
  });

  it('writes the job the settings ask for', () => {
    const opt = buildPsi4Input({ settings: settings({ jobType: 'Opt' }), molecule: molecule() });
    expect(opt.inputText).toContain("optimize('b3lyp')");
    const freq = buildPsi4Input({ settings: settings({ jobType: 'Freq' }), molecule: molecule() });
    expect(freq.inputText).toContain("frequencies('b3lyp')");
    const both = buildPsi4Input({ settings: settings({ jobType: 'Opt Freq' }), molecule: molecule() });
    expect(both.inputText).toContain("optimize('b3lyp')");
    expect(both.inputText.indexOf("optimize('b3lyp')")).toBeLessThan(both.inputText.indexOf("frequencies('b3lyp')"));
  });

  it('maps the app\'s basis keys to the names Psi4 reads', () => {
    expect(PSI4_BASES.find((entry) => entry.key === '6-31g(d)').psi4).toBe('6-31G*');
    const built = buildPsi4Input({ settings: settings({ basis: '6-31g(d)' }), molecule: molecule() });
    expect(built.inputText).toContain('set basis 6-31G*');
  });

  it('sets UHF for an open-shell molecule and tightens SCF only when asked', () => {
    const open = buildPsi4Input({ settings: settings(), molecule: molecule({ multiplicity: 2 }) });
    expect(open.inputText).toContain('set reference uhf');
    const plain = buildPsi4Input({ settings: settings(), molecule: molecule() });
    expect(plain.inputText).not.toContain('e_convergence');
    const tight = buildPsi4Input({ settings: settings({ scf: 'tight' }), molecule: molecule() });
    expect(tight.inputText).toContain('set e_convergence 1.0e-8');
  });

  it('separates fragments for SAPT and refuses a single fragment', () => {
    const dimer = molecule({
      coords: [
        { element: 'O', x: 0, y: 0, z: 0, fragment: 1 },
        { element: 'H', x: 0.9, y: 0, z: 0, fragment: 1 },
        { element: 'O', x: 0, y: 0, z: 3, fragment: 2 },
        { element: 'H', x: 0, y: 0.9, z: 3, fragment: 2 },
      ],
    });
    const built = buildPsi4Input({ settings: settings({ method: 'sapt0' }), molecule: dimer });
    expect(built.inputText).toContain('\n--\n');
    expect(built.inputText).toContain("energy('sapt0')");
    expect(() => buildPsi4Input({ settings: settings({ method: 'sapt0' }), molecule: molecule() }))
      .toThrow(/at least two fragments/);
  });

  it('refuses jobs the method cannot do', () => {
    expect(() => buildPsi4Input({ settings: settings({ method: 'sapt0', jobType: 'Opt' }), molecule: molecule() }))
      .toThrow(/SAPT0 is an energy method/);
    expect(() => buildPsi4Input({ settings: settings({ method: 'ccsd(t)', jobType: 'Freq' }), molecule: molecule() }))
      .toThrow(/no analytic Hessian/);
    expect(() => buildPsi4Input({ settings: settings({ method: 'b97-3c' }), molecule: molecule() }))
      .toThrow(/cannot run method/);
    expect(() => buildPsi4Input({ settings: settings({ basis: 'lanl2dz' }), molecule: molecule() }))
      .toThrow(/cannot run basis/);
    expect(() => buildPsi4Input({ settings: settings({ jobType: 'Opt=TS' }), molecule: molecule() }))
      .toThrow(/not supported/);
  });

  it('names every setting it will not honour instead of dropping it', () => {
    const fields = psi4SettingsOffenders({
      solvation: 'PCM', solvent: 'water', tddft: true, population: 'NBO', dispersion: 'GD3BJ',
      grid: 'UltraFine', stableOpt: true, customKeywords: 'Int=UltraFine',
    }).map((entry) => entry.field);
    expect(fields).toEqual(['solvation', 'tddft', 'population', 'dispersion', 'grid', 'stableOpt', 'customKeywords']);
  });

  it('accepts the schema defaults: solvation off and a solvent name are not a request', () => {
    // Regression: the guard tested `String(false)` ("false", truthy) and the
    // always-filled solvent name, so every default Psi4 block was refused.
    const { defaultSettings } = projectSchema;
    const defaults = defaultSettings({ engine: 'psi4', jobType: 'SP', method: 'hf', basis: '6-31g(d)' });
    expect(defaults.solvation).toBe(false);
    expect(psi4SettingsOffenders(defaults)).toEqual([]);
    expect(() => buildPsi4Input({ settings: defaults, molecule: molecule(), inputName: 'x.dat' })).not.toThrow();
    expect(psi4SettingsOffenders({ solvation: true, solvent: 'Water' }).map((entry) => entry.field)).toEqual(['solvation']);
  });

  it('refuses the Gaussian-only switches it cannot write instead of dropping them', () => {
    const fields = psi4SettingsOffenders({ raman: true, orbitals: true, verbosity: 'Normal' }).map((entry) => entry.field);
    expect(fields).toEqual(['raman', 'orbitals', 'verbosity']);
  });

  it('never interpolates a setting into the script as code', () => {
    const built = buildPsi4Input({
      title: "water'); import os; os.system('echo pwned",
      settings: settings(),
      molecule: molecule(),
    });
    const scriptLines = built.inputText.split('\n');
    expect(scriptLines.some((line) => line.startsWith('import os'))).toBe(false);
    // The title lands in a comment, so the quote cannot close a call.
    expect(built.inputText.split('\n')[1].startsWith('# ')).toBe(true);
  });
});

describe('Psi4 output parser — real logs', () => {
  it('reads an RHF single point and its basis', () => {
    const parsed = parsePsi4Output(real('psi4-scf1.out'));
    expect(parsed.engine).toBe('psi4');
    expect(parsed.status).toBe('completed');
    expect(parsed.termination).toBe('Psi4 exiting successfully');
    expect(parsed.program.version).toBe('1.1rc3.dev5');
    expect(parsed.extras.method).toBe('HF');
    expect(parsed.extras.basis).toBe('cc-pVQZ');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-25.103546896978017, 9);
    expect(parsed.scf.energyHartree).toBeCloseTo(-25.10354689697802, 9);
    expect(parsed.scf.status).toBe('converged');
  });

  it('reads a B3LYP frequency job with thermochemistry', () => {
    const parsed = parsePsi4Output(real('psi4-dft-freq.out'));
    expect(parsed.extras.method).toBe('B3LYP');
    expect(parsed.extras.basis).toBe('6-31G(d)');
    expect(parsed.scf.cycles).toBe(8);
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.thermochemistry.enthalpyHartree).toBeCloseTo(-76.38400752, 8);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-76.40545351, 8);
    expect(parsed.thermochemistry.zpeHartree).toBeCloseTo(0.02116896, 8);
    expect(parsed.extras.temperatureK).toBeCloseTo(298.15, 2);
  });

  it('reports the last optimisation in the file, including one that failed', () => {
    const parsed = parsePsi4Output(real('psi4-opt1.out'));
    expect(parsed.optimization.attempted).toBe(true);
    expect(parsed.optimization.completed).toBe(false);
    expect(parsed.optimization.cycles).toBe(2);
    expect(parsed.extras.finalGeometry).toHaveLength(3);
    expect(parsed.extras.finalGeometry[0].element).toBe('O');
  });

  it('reports a converged optimisation with its step count and final geometry', () => {
    const parsed = parsePsi4Output(real('psi4-opt2.out'));
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.cycles).toBe(7);
    expect(parsed.extras.finalGeometry).toHaveLength(7);
  });

  it('takes the correlated energy, not the SCF energy, for MP2 and CCSD', () => {
    const mp2 = parsePsi4Output(real('psi4-mp2-1.out'));
    expect(mp2.finalEnergy.source).toBe('mp2');
    expect(mp2.finalEnergy.hartree).toBeCloseTo(-76.22244865295652, 9);
    expect(mp2.scf.energyHartree).toBeCloseTo(-76.02289572716097, 9);

    const ccsd = parsePsi4Output(real('psi4-cc1.out'));
    expect(ccsd.finalEnergy.source).toBe('ccsd');
    expect(ccsd.finalEnergy.hartree).toBeCloseTo(-76.23117843550617, 9);
  });

  it('refuses to call a SAPT interaction energy a total energy', () => {
    const parsed = parsePsi4Output(real('psi4-sapt1.out'));
    expect(parsed.extras.sapt.method).toBe('SAPT0');
    expect(parsed.extras.sapt.totalMha).toBeCloseTo(-2.30683390, 8);
    expect(parsed.extras.sapt.totalKcal).toBeCloseTo(-1.44756019, 8);
    expect(parsed.extras.sapt.electrostaticMha).toBeCloseTo(-3.59915058, 8);
    expect(parsed.extras.sapt.dispersionMha).toBeCloseTo(-1.50542374, 8);
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.finalEnergy.source).toBe('sapt-interaction-energy-not-a-total');
  });

  it('reads an error termination and keeps the module message', () => {
    const parsed = parsePsi4Output(real('psi4-io-error.out'));
    expect(parsed.status).toBe('error');
    expect(parsed.terminationCode).toBe('error');
    expect(parsed.termination).toMatch(/PSIO Error/);
    expect(parsed.extras.errorDetail).toBe('PSIO Error');
  });

  it('does not read a Gaussian or ORCA file as Psi4', () => {
    const gaussianish = ' Entering Gaussian System\n #p B3LYP/6-31G(d)\n Normal termination of Gaussian 16\n';
    const parsed = parsePsi4Output(gaussianish);
    expect(parsed.termination).toBe('Not Psi4 output');
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.complete).toBe(false);

    const orcaish = '                                 * O   R   C   A *\n****ORCA TERMINATED NORMALLY****\n';
    expect(parsePsi4Output(orcaish).extras.reason).toMatch(/looks like ORCA/);
  });
});

describe('Psi4 1.11 — runs produced by the container image', () => {
  const live = (name) => readFileSync(`test/fixtures/psi4-live/${name}`, 'utf8');

  it('reads the 1.11 single point, including its renamed convergence line', () => {
    const parsed = parsePsi4Output(live('water-sp.out'));
    expect(parsed.program.version).toBe('1.11');
    expect(parsed.scf.status).toBe('converged');
    expect(parsed.scf.cycles).toBe(7);
    expect(parsed.extras.reference).toBe('RKS');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.35815199866961, 9);
  });

  it('reads the 1.11 optimisation: bare completion marker and a step table', () => {
    const parsed = parsePsi4Output(live('water-opt.out'));
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.cycles).toBe(3);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.35832576761888, 9);
    expect(parsed.extras.finalGeometry).toHaveLength(3);
  });

  it('reads the 1.11 frequency table instead of the old `#  #` list', () => {
    const parsed = parsePsi4Output(live('water-freq.out'));
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.thermochemistry.zpeHartree).toBeCloseTo(0.02168016, 8);
    expect(parsed.thermochemistry.enthalpyHartree).toBeCloseTo(-76.33269184, 8);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-76.35410402, 8);
    // The well-bottom energy, not the last displaced-point energy.
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.358152, 6);
    expect(parsed.finalEnergy.source).toBe('freq-reference');
  });

  it('reads an open-shell 1.11 run as UKS', () => {
    const parsed = parsePsi4Output(live('uhf.out'));
    expect(parsed.extras.reference).toBe('UKS');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-75.90190402047804, 9);
  });

  it('reads a live SAPT0 table and still refuses to call it a total energy', () => {
    const parsed = parsePsi4Output(live('sapt.out'));
    expect(parsed.extras.sapt.totalMha).toBeCloseTo(-4.15242375, 8);
    expect(parsed.extras.sapt.totalKcal).toBeCloseTo(-2.60568524, 8);
    expect(parsed.extras.sapt.exchangeMha).toBeCloseTo(2.98675228, 8);
    expect(parsed.finalEnergy.hartree).toBeNull();
  });
});

describe('Psi4 termination classifier', () => {
  it('treats a clean exit as normal and an error banner as an error', () => {
    expect(classifyPsi4Termination('*** Psi4 exiting successfully. Buy a developer a beer!', 0))
      .toEqual({ code: 'normal', reason: 'Psi4 exiting successfully' });
    const error = classifyPsi4Termination('Fatal Error: PSIO Error\n*** Psi4 encountered an error. Buy a developer more coffee!', 0);
    expect(error.code).toBe('error');
    expect(error.reason).toMatch(/PSIO Error/);
  });

  it('calls a traceback without a success line an error even on exit 0', () => {
    const result = classifyPsi4Termination('Traceback (most recent call last):\n  File "x", line 1\nRuntimeError: boom', 0);
    expect(result.code).toBe('error');
  });

  it('says "none" when there is no marker and no exit code', () => {
    expect(classifyPsi4Termination('', 0).code).toBe('none');
    expect(classifyPsi4Termination('', 3).code).toBe('error');
  });
});

describe('Psi4 dry-run fixture', () => {
  it('is labelled as a fixture and parses as a completed run', () => {
    const text = makePsi4FixtureOutput({ imaginary: 0 });
    expect(text.startsWith(' FIXTURE OUTPUT')).toBe(true);
    const parsed = parsePsi4Output(text);
    expect(parsed.status).toBe('completed');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.42139511922374, 9);
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-76.421, 6);
  });

  it('carries an imaginary mode when the gate expects one', () => {
    const parsed = parsePsi4Output(makePsi4FixtureOutput({ imaginary: 1 }));
    expect(parsed.frequencies.imaginaryCount).toBe(1);
    expect(parsed.frequencies.minImaginary).toBeCloseTo(-412.31, 2);
  });
});

describe('Psi4 method and basis tables', () => {
  it('lists the methods the builder can actually spell', () => {
    expect(PSI4_METHODS.map((entry) => entry.key)).toEqual([
      'hf', 'b3lyp', 'pbe0', 'm06-2x', 'wb97x-d', 'b97-d', 'mp2', 'ccsd', 'ccsd(t)', 'sapt0',
    ]);
  });
});
