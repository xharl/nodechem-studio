import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PYSCF_BASES,
  PYSCF_CAPABILITIES,
  PYSCF_JOB_TYPES,
  PYSCF_METHODS,
  PYSCF_SOLVATION_MODELS,
  buildPyscfInput,
  classifyPyscfTermination,
  extractPyscfRecord,
  isSafePyscfInputName,
  makePyscfFixtureOutput,
  parsePyscfOutput,
  pyscfActiveSpaceFor,
  pyscfSettingsOffenders,
  replacePyscfGeometry,
} from '../src/shared/engines/pyscf.js';
import { ENGINES, engineFor, engineOrDefault, isEngineId } from '../src/shared/engines/index.js';
import { defaultSettings } from '../src/shared/projectSchema.js';
import { summarizeLog } from '../src/shared/logImport.js';

const fixture = (name) => readFileSync(`test/fixtures/pyscf/${name}`, 'utf8');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const settings = (overrides = {}) => ({
  jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', ...overrides,
});

const molecule = (overrides = {}) => ({ charge: 0, multiplicity: 1, coords: WATER, ...overrides });

const decodeDeck = (inputText) => {
  const match = /^_DATA = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\.decode\("utf-8"\)\)$/m.exec(inputText);
  if (!match) throw new Error('no data line');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
};

describe('PySCF engine registry', () => {
  it('registers PySCF as the fifth engine', () => {
    expect(Object.keys(ENGINES)).toEqual(['gaussian', 'xtb', 'orca', 'psi4', 'pyscf']);
    expect(isEngineId('pyscf')).toBe(true);
    expect(engineFor('pyscf').id).toBe('pyscf');
    expect(engineOrDefault('pyscf').label).toBe('PySCF');
  });

  it('states the capabilities it actually implements', () => {
    expect(PYSCF_CAPABILITIES.inputExtension).toBe('.py');
    expect(PYSCF_CAPABILITIES.outputExtension).toBe('.out');
    expect(PYSCF_CAPABILITIES.capturesStdout).toBe(true);
    expect(PYSCF_CAPABILITIES.restartArtifact).toBeNull();
    expect(PYSCF_CAPABILITIES.jobTypes).toEqual(['SP', 'Opt', 'Freq', 'Opt Freq', 'TD-DFT']);
    expect(PYSCF_CAPABILITIES.solvationModels).toEqual(['PCM', 'C-PCM']);
    const refused = PYSCF_CAPABILITIES.unsupportedFeatures.join(' ');
    for (const named of ['triplet', 'periodic', 'relativistic', 'QM/MM', 'GPU', 'NMR']) {
      expect(refused).toContain(named);
    }
    expect(refused).toMatch(/CCSD\(T\) Hessian/);
  });

  it('lists exactly the methods and bases the deck can spell', () => {
    expect(PYSCF_METHODS.map((entry) => entry.label)).toEqual([
      'HF', 'B3LYP', 'PBE0', 'M06-2X', 'MP2', 'CCSD', 'CCSD(T)', 'CASSCF',
    ]);
    expect(PYSCF_BASES.map((entry) => entry.label)).toEqual([
      'def2-SVP', 'def2-TZVP', 'cc-pVDZ', 'cc-pVTZ', '6-31G(d)', 'STO-3G',
    ]);
    expect(PYSCF_BASES.find((entry) => entry.key === '6-31g(d)').pyscf).toBe('6-31g*');
    expect(PYSCF_SOLVATION_MODELS).toEqual(['PCM', 'C-PCM']);
  });
});

describe('PySCF input builder', () => {
  it('writes the reviewed deck, with the payload as data and no interpolated code', () => {
    const built = buildPyscfInput({ title: 'hf-sp', settings: settings({ method: 'hf' }), molecule: molecule(), inputName: 'hf-sp.gjf' });
    expect(built.engine).toBe('pyscf');
    expect(built.inputName).toBe('hf-sp.py');
    expect(built.outputName).toBe('hf-sp.out');
    expect(built.argv).toEqual(['hf-sp.py']);
    expect(built.inputText.startsWith('#!/usr/bin/env python3')).toBe(true);
    expect(built.inputText).toContain('NCS-PYSCF-RESULT-BEGIN');
    expect(built.inputText).not.toContain('__NCS_DATA_B64__');
    const data = decodeDeck(built.inputText);
    expect(data.methodKey).toBe('hf');
    expect(data.basis).toBe('def2-svp');
    expect(data.atoms).toEqual(WATER);
    // The fixed script is the fixture deck, byte for byte.
    expect(built.inputText).toBe(fixture('water-hf-def2svp-sp.py'));
  });

  it('never lets a title become Python', () => {
    const built = buildPyscfInput({
      title: "water'); import os; os.system('echo pwned",
      settings: settings(),
      molecule: molecule(),
      inputName: 'x.gjf',
    });
    expect(built.inputText).not.toContain("import os; os.system");
    const data = decodeDeck(built.inputText);
    expect(data.title).toBe("water'); import os; os.system('echo pwned");
  });

  it('rewrites the planner name and refuses anything else', () => {
    expect(buildPyscfInput({ settings: settings(), molecule: molecule(), inputName: 'task.gjf' }).inputName).toBe('task.py');
    expect(buildPyscfInput({ settings: settings(), molecule: molecule(), inputName: 'task.dat' }).inputName).toBe('task.py');
    expect(() => buildPyscfInput({ settings: settings(), molecule: molecule(), inputName: '../x.py' }))
      .toThrow(/safe \.py basename/);
    expect(isSafePyscfInputName('task.py')).toBe(true);
    expect(isSafePyscfInputName('task.out')).toBe(false);
  });

  it('sets the ECP only for a def2 basis and a heavy element', () => {
    const heavy = molecule({
      coords: [{ element: 'I', x: 0, y: 0, z: 0 }, { element: 'H', x: 0, y: 0, z: 1.6 }],
      multiplicity: 1,
    });
    const built = buildPyscfInput({ settings: settings({ method: 'hf' }), molecule: heavy, inputName: 'i.gjf' });
    expect(decodeDeck(built.inputText).ecp).toBe(true);
    const light = buildPyscfInput({ settings: settings({ method: 'hf' }), molecule: molecule(), inputName: 'w.gjf' });
    expect(decodeDeck(light.inputText).ecp).toBe(false);
    const pople = buildPyscfInput({ settings: settings({ basis: '6-31g(d)' }), molecule: heavy, inputName: 'i.gjf' });
    expect(decodeDeck(pople.inputText).ecp).toBe(false);
  });

  it('writes the job type the settings ask for', () => {
    expect(decodeDeck(buildPyscfInput({ settings: settings({ jobType: 'Opt' }), molecule: molecule() }).inputText).jobType).toBe('Opt');
    expect(decodeDeck(buildPyscfInput({ settings: settings({ jobType: 'Freq' }), molecule: molecule() }).inputText).jobType).toBe('Freq');
    expect(decodeDeck(buildPyscfInput({ settings: settings({ jobType: 'Opt Freq' }), molecule: molecule() }).inputText).jobType).toBe('Opt Freq');
    expect(PYSCF_JOB_TYPES).toEqual(['SP', 'Opt', 'Freq', 'Opt Freq', 'TD-DFT']);
  });

  it('writes a TD-DFT job with its root count and refuses what it cannot honour', () => {
    const built = buildPyscfInput({
      settings: settings({ jobType: 'TD-DFT', tdStates: 4 }), molecule: molecule(),
    });
    const data = decodeDeck(built.inputText);
    expect(data.jobType).toBe('TD-DFT');
    expect(data.tdStates).toBe(4);
    expect(built.route).toContain('TD-DFT');

    expect(() => buildPyscfInput({ settings: settings({ jobType: 'TD-DFT' }), molecule: molecule() }))
      .toThrow(/at least one excited state/);
    expect(() => buildPyscfInput({
      settings: settings({ jobType: 'TD-DFT', tdStates: 3, tdTriplets: 2 }), molecule: molecule(),
    })).toThrow(/Triplet roots/);
    expect(() => buildPyscfInput({
      settings: settings({ jobType: 'TD-DFT', tdStates: 3, method: 'MP2' }), molecule: molecule(),
    })).toThrow(/no TD-DFT path/);
    expect(() => buildPyscfInput({ settings: settings({ tdStates: 3 }), molecule: molecule() }))
      .toThrow(/need the TD-DFT job type/);
  });

  it('records the PCM model and the solvent in the payload', () => {
    const built = buildPyscfInput({
      settings: settings({ method: 'hf', basis: '6-31g(d)', solvation: true, solvationModel: 'PCM', solvent: 'Water' }),
      molecule: molecule(),
      inputName: 'pcm.gjf',
    });
    expect(decodeDeck(built.inputText).solvation).toEqual({
      provider: 'pyscf-pcm', model: 'PCM', solvent: 'water', solventLabel: 'Water',
    });
    expect(built.route).toContain('PCM/Water');
  });

  it('serializes an explicit CASSCF active space', () => {
    const built = buildPyscfInput({
      settings: settings({ method: 'casscf', basis: '6-31g(d)', pyscfActiveSpace: '4,4' }),
      molecule: molecule(),
      inputName: 'cas.gjf',
    });
    expect(decodeDeck(built.inputText).activeSpace).toEqual({ electrons: 4, orbitals: 4 });
    expect(pyscfActiveSpaceFor({ pyscfActiveSpace: '2, 2' })).toEqual({ electrons: 2, orbitals: 2 });
    expect(() => pyscfActiveSpaceFor({ pyscfActiveSpace: '2' })).toThrow(/electrons,orbitals/);
    expect(() => pyscfActiveSpaceFor({ pyscfActiveSpace: '9,4' })).toThrow(/impossible/);
  });

  it('refuses a method or basis it cannot spell', () => {
    expect(() => buildPyscfInput({ settings: settings({ method: 'wb97x-d' }), molecule: molecule() }))
      .toThrow(/cannot run method/);
    expect(() => buildPyscfInput({ settings: settings({ basis: 'lanl2dz' }), molecule: molecule() }))
      .toThrow(/cannot run basis/);
  });

  it('refuses every named feature instead of downgrading it', () => {
    const fields = pyscfSettingsOffenders({
      jobType: 'NMR', tddft: true, periodic: true, relativistic: true, qmmm: true, gpu: true,
      nmr: true, customKeywords: 'nosymm', dispersion: 'GD3BJ', grid: 'UltraFine',
      population: 'NBO', verbosity: 'Normal', stableOpt: true, checkpoint: 'x.chk',
    }).map((entry) => entry.field);
    for (const field of ['jobType', 'tddft', 'periodic', 'relativistic', 'qmmm', 'gpu', 'nmr',
      'customKeywords', 'dispersion', 'grid', 'population', 'verbosity', 'stableOpt', 'checkpoint']) {
      expect(fields).toContain(field);
    }
    expect(pyscfSettingsOffenders({ periodic: false, relativistic: '', gpu: false })).toEqual([]);
  });

  it('refuses the job/method combinations the deck does not implement', () => {
    expect(() => buildPyscfInput({ settings: settings({ method: 'ccsd(t)', jobType: 'Freq' }), molecule: molecule() }))
      .toThrow(/single point in this build/);
    expect(() => buildPyscfInput({ settings: settings({ method: 'mp2', jobType: 'Opt' }), molecule: molecule() }))
      .toThrow(/single point in this build/);
    expect(() => buildPyscfInput({ settings: settings({ method: 'casscf', basis: '6-31g(d)', pyscfActiveSpace: '4,4', jobType: 'Opt' }), molecule: molecule() }))
      .toThrow(/CASSCF is a single point/);
    expect(() => buildPyscfInput({ settings: settings({ method: 'casscf', basis: '6-31g(d)' }), molecule: molecule() }))
      .toThrow(/needs an explicit active space/);
  });

  it('refuses solvation where the deck cannot apply it', () => {
    expect(() => buildPyscfInput({
      settings: settings({ jobType: 'Opt', solvation: true, solvationModel: 'PCM', solvent: 'Water' }),
      molecule: molecule(),
    })).toThrow(/must be SP/);
    expect(() => buildPyscfInput({
      settings: settings({ method: 'mp2', solvation: true, solvationModel: 'PCM', solvent: 'Water' }),
      molecule: molecule(),
    })).toThrow(/no solvent response/);
    expect(() => buildPyscfInput({
      settings: settings({ solvation: true, solvationModel: 'SMD', solvent: 'Water' }), molecule: molecule(),
    })).toThrow(/not one of them/);
    expect(() => buildPyscfInput({
      settings: settings({ solvation: true, solvationModel: 'PCM', solvent: 'Not A Solvent' }), molecule: molecule(),
    })).toThrow(/no PySCF name/);
  });

  it('accepts the schema defaults on a PySCF block', () => {
    const defaults = defaultSettings({ engine: 'pyscf', jobType: 'SP', method: 'b3lyp', basis: 'def2-SVP' });
    expect(defaults.dispersion).toBe('');
    expect(pyscfSettingsOffenders(defaults)).toEqual([]);
    expect(() => buildPyscfInput({ settings: defaults, molecule: molecule(), inputName: 'x.gjf' })).not.toThrow();
  });

  it('replaces the geometry of an already-built deck for a hand-off', () => {
    const built = buildPyscfInput({ settings: settings({ method: 'hf' }), molecule: molecule(), inputName: 'x.gjf' });
    const moved = WATER.map((atom) => ({ ...atom, z: atom.z + 0.5 }));
    const rewritten = replacePyscfGeometry(built.inputText, moved);
    expect(decodeDeck(rewritten).atoms).toEqual(moved);
    expect(() => replacePyscfGeometry('no data here', moved)).toThrow(/no data line/);
  });
});

describe('PySCF record parser — recorded fixtures', () => {
  it('reads the recorded HF/def2-SVP single point', () => {
    const parsed = parsePyscfOutput(fixture('water-hf-def2svp-sp.json'));
    expect(parsed.engine).toBe('pyscf');
    expect(parsed.status).toBe('completed');
    expect(parsed.program.name).toBe('PySCF');
    expect(parsed.program.version).toBe('2.15.0');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-75.96092810964097, 12);
    expect(parsed.scf.status).toBe('converged');
    expect(parsed.scf.cycles).toBe(9);
    expect(parsed.extras.method).toBe('HF');
    expect(parsed.extras.basis).toBe('def2-SVP');
    expect(parsed.extras.densityFit).toBe(true);
    expect(parsed.extras.moEnergies).toHaveLength(24);
    expect(parsed.extras.nBasis).toBe(24);
    expect(parsed.finalGeometry.atoms).toHaveLength(3);
  });

  it('reads the recorded B3LYP single point and matches the Psi4 reference', () => {
    const parsed = parsePyscfOutput(fixture('water-b3lyp-def2svp-sp.json'));
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.35815183294746, 12);
    // psi4/psi4:1.11, same geometry, same density-fitted SCF.
    const psi4 = -76.35815199866961;
    expect(Math.abs(parsed.finalEnergy.hartree - psi4)).toBeLessThan(1e-6);
  });

  it('matches the Psi4 HF reference within 1e-6 Eh', () => {
    const parsed = parsePyscfOutput(fixture('water-hf-def2svp-sp.json'));
    const psi4 = -75.96092810958544;
    expect(Math.abs(parsed.finalEnergy.hartree - psi4)).toBeLessThan(1e-6);
  });

  it('returns the optimised geometry from an Opt record', () => {
    const parsed = parsePyscfOutput(fixture('water-b3lyp-def2svp-opt.json'));
    expect(parsed.optimization.attempted).toBe(true);
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.cycles).toBe(4);
    expect(parsed.extras.finalGeometry).toHaveLength(3);
    expect(parsed.finalGeometry.atoms[0].element).toBe('O');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.35832569408352, 12);
  });

  it('returns 3N-6 modes with no imaginary frequency', () => {
    const parsed = parsePyscfOutput(fixture('water-b3lyp-def2svp-freq.json'));
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    expect(parsed.frequencies.minImaginary).toBeNull();
    expect(parsed.extras.frequencyValues).toHaveLength(3);
    expect(parsed.extras.hessian).toHaveLength(81);
    expect(parsed.extras.hessianShape).toEqual([3, 3, 3, 3]);
    expect(parsed.thermochemistry.zpeHartree).toBeCloseTo(0.021678102905261377, 10);
  });

  it('reports Opt Freq with both a converged geometry and 3N-6 modes', () => {
    const parsed = parsePyscfOutput(fixture('water-b3lyp-def2svp-optfreq.json'));
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.cycles).toBe(4);
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
  });

  it('reports the CASSCF energy with its active space', () => {
    const parsed = parsePyscfOutput(fixture('water-casscf-44-631gd-sp.json'));
    expect(parsed.extras.methodKey).toBe('casscf');
    expect(parsed.extras.activeSpace).toEqual({ electrons: 4, orbitals: 4 });
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.0609899309991, 12);
    // Independent direct PySCF CASSCF(4,4) run, same geometry and reference.
    expect(Math.abs(parsed.finalEnergy.hartree - (-76.06098993030339))).toBeLessThan(1e-8);
  });

  it('reports the CH2 CASSCF/STO-3G singlet and triplet records', () => {
    const singlet = parsePyscfOutput(fixture('water-ch2-singlet-casscf-sto3g-sp.json'));
    expect(singlet.extras.basis).toBe('STO-3G');
    expect(singlet.extras.activeSpace).toEqual({ electrons: 2, orbitals: 2 });
    expect(singlet.extras.multiplicity).toBe(1);
    expect(singlet.finalEnergy.hartree).toBeCloseTo(-38.373426122243615, 12);
    // Independent direct PySCF CASSCF(2,2)/STO-3G run, same density-fitted RHF.
    expect(Math.abs(singlet.finalEnergy.hartree - (-38.37342612224362))).toBeLessThan(1e-10);

    const triplet = parsePyscfOutput(fixture('water-ch2-triplet-casscf-sto3g-sp.json'));
    expect(triplet.extras.activeSpace).toEqual({ electrons: 2, orbitals: 2 });
    expect(triplet.extras.multiplicity).toBe(3);
    expect(triplet.extras.reference).toBe('rohf');
    expect(triplet.finalEnergy.hartree).toBeCloseTo(-38.37342612226331, 12);
    expect(Math.abs(triplet.finalEnergy.hartree - (-38.373426122263325))).toBeLessThan(1e-10);
  });

  it('reports the PCM model, solvent and solvated energy', () => {
    const parsed = parsePyscfOutput(fixture('water-hf-631gd-pcm.json'));
    expect(parsed.solvation).toMatchObject({
      provider: 'pyscf-pcm', model: 'PCM', solvent: 'water', solventLabel: 'Water',
    });
    expect(parsed.solvation.solvatedHartree).toBeCloseTo(-76.02057700618754, 12);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.02057700618754, 12);
  });

  it('reads MP2, CCSD and CCSD(T) with their correlation terms', () => {
    const mp2 = parsePyscfOutput(fixture('water-mp2-def2svp-sp.json'));
    expect(mp2.finalEnergy.source).toBe('mp2');
    expect(mp2.extras.correlationEnergy).toBeCloseTo(-0.20359947474952797, 12);
    expect(mp2.finalEnergy.hartree).toBeCloseTo(-76.16452758439047, 12);

    const ccsd = parsePyscfOutput(fixture('water-ccsd-def2svp-sp.json'));
    expect(ccsd.finalEnergy.source).toBe('ccsd');
    expect(ccsd.finalEnergy.hartree).toBeCloseTo(-76.17392974901573, 12);

    const ccsdt = parsePyscfOutput(fixture('water-ccsd(t)-def2svp-sp.json'));
    expect(ccsdt.finalEnergy.source).toBe('ccsd(t)');
    expect(ccsdt.extras.triplesCorrection).toBeCloseTo(-0.0030061060251916237, 12);
    expect(ccsdt.finalEnergy.hartree).toBeCloseTo(-76.17693585504087, 12);
  });

  it('reads singlet roots from a TD-DFT record', () => {
    const parsed = parsePyscfOutput(fixture('water-b3lyp-def2svp-tddft.json'));
    expect(parsed.excitedStates.count).toBe(4);
    expect(parsed.excitedStates.requested).toBe(4);
    expect(parsed.excitedStates.source).toBe('pyscf-tddft');
    expect(parsed.excitedStates.verified).toBe(true);
    const first = parsed.excitedStates.states[0];
    expect(first.energyHartree).toBeCloseTo(0.2792268399882513, 12);
    expect(first.energyEv).toBeCloseTo(7.5981493931669934, 10);
    expect(first.oscillatorStrength).toBeCloseTo(0.018198124703632537, 10);
    expect(first.wavelengthNm).toBeCloseTo(163.1768368643802, 8);
    expect(first.transitionDipoleAu).toHaveLength(3);
    expect(parsed.excitedStates.transitionDipoleCount).toBe(4);
    // The record's energy is the ground-state reference, as in a Gaussian TD log.
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.35815183294753, 10);
  });

  it('reads the ethene pi-pi* root and its oscillator strength', () => {
    const parsed = parsePyscfOutput(fixture('ethene-b3lyp-def2svp-tddft.json'));
    expect(parsed.excitedStates.count).toBe(5);
    const strong = parsed.excitedStates.states[0];
    expect(strong.energyEv).toBeCloseTo(8.139667830267898, 8);
    expect(strong.oscillatorStrength).toBeCloseTo(0.3748052632592823, 10);
    expect(strong.wavelengthNm).toBeCloseTo(152.3209558244582, 8);
    expect(parsed.excitedStates.states[1].oscillatorStrength).toBeLessThan(1e-10);
  });

  it('records a failed SCF as failed, with its iteration count', () => {
    const parsed = parsePyscfOutput(fixture('water-hf-def2svp-sp-failed-scf.json'));
    expect(parsed.status).toBe('error');
    expect(parsed.terminationCode).toBe('error');
    expect(parsed.scf.status).toBe('failed');
    expect(parsed.scf.cycles).toBe(1);
    expect(parsed.scf.energyHartree).toBeCloseTo(-75.92255608563181, 12);
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.extras.errorType).toBe('SCFNotConverged');
    expect(parsed.termination).toMatch(/SCF did not converge after 1 cycles/);
  });

  it('round-trips the record through the marker block a deck prints', () => {
    const record = JSON.parse(fixture('water-b3lyp-def2svp-sp.json'));
    const text = `PySCF 2.15.0\nsome stdout\nNCS-PYSCF-RESULT-BEGIN\n${JSON.stringify(record)}\nNCS-PYSCF-RESULT-END\ntrailing\n`;
    expect(extractPyscfRecord(text)).toMatchObject({ schema: 'nodechem.pyscf.v1', ok: true });
    const parsed = parsePyscfOutput(text);
    expect(parsed.finalEnergy.hartree).toBe(record.energy);
    expect(parsed.extras.recordSource).toBe('json');
  });

  it('does not read another engine as PySCF', () => {
    const gaussianish = ' Entering Gaussian System\n #p B3LYP/6-31G(d)\n Normal termination of Gaussian 16\n';
    const parsed = parsePyscfOutput(gaussianish);
    expect(parsed.termination).toBe('Not PySCF output');
    expect(parsed.complete).toBe(false);
  });

  it('parses a text fallback and says it is a fallback', () => {
    const text = [
      'PySCF 2.15.0',
      'cycle= 1 E= -75.9 deltaE= -75.9',
      'cycle= 8 E= -75.96092810964 deltaE= -1e-10',
      'converged SCF energy = -75.96092810964097',
    ].join('\n');
    const parsed = parsePyscfOutput(text);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-75.96092810964097, 12);
    expect(parsed.scf.cycles).toBe(8);
    expect(parsed.extras.recordSource).toBe('text-fallback');
  });
});

describe('PySCF termination classifier', () => {
  it('treats an ok record as normal and a failed record as an error', () => {
    expect(classifyPyscfTermination(fixture('water-hf-def2svp-sp.json'), 0))
      .toMatchObject({ code: 'normal' });
    const failed = classifyPyscfTermination(fixture('water-hf-def2svp-sp-failed-scf.json'), 1);
    expect(failed.code).toBe('error');
    expect(failed.reason).toMatch(/SCF did not converge after 1 cycles/);
  });

  it('names a missing PySCF module from stderr', () => {
    const result = classifyPyscfTermination('', 1, {
      stderr: "ModuleNotFoundError: No module named 'pyscf'",
    });
    expect(result.code).toBe('error');
    expect(result.reason).toMatch(/No module named 'pyscf'/);
    expect(result.reason).toMatch(/pip install pyscf/);
  });

  it('says none when there is no record and no exit code', () => {
    expect(classifyPyscfTermination('', 0).code).toBe('none');
    expect(classifyPyscfTermination('', 3).code).toBe('error');
  });
});

describe('PySCF dry-run fixture', () => {
  it('is labelled and parses as a completed run', () => {
    const text = makePyscfFixtureOutput();
    expect(text.startsWith('FIXTURE OUTPUT')).toBe(true);
    expect(text).toContain('"fixture": true');
    const parsed = parsePyscfOutput(text);
    expect(parsed.status).toBe('completed');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.35815183294746, 12);
    expect(parsed.extras.moEnergies).toHaveLength(24);
  });

  it('carries an imaginary mode when a gate expects one', () => {
    const parsed = parsePyscfOutput(makePyscfFixtureOutput({ imaginary: 1 }));
    expect(parsed.frequencies.imaginaryCount).toBe(1);
    expect(parsed.frequencies.minImaginary).toBeCloseTo(-412.31, 2);
  });

  it('can present a failed SCF for the failure path', () => {
    const parsed = parsePyscfOutput(makePyscfFixtureOutput({ scfFailed: true }));
    expect(parsed.status).toBe('error');
    expect(parsed.scf.status).toBe('failed');
    expect(parsed.scf.cycles).toBe(50);
  });
});

describe('PySCF log import', () => {
  it('indexes a PySCF record as PySCF', () => {
    const row = summarizeLog(fixture('water-b3lyp-def2svp-sp.json'), { name: 'water.json' });
    expect(row.engine).toBe('pyscf');
    expect(row.status).toBe('completed');
    expect(row.method).toBe('B3LYP');
    expect(row.basis).toBe('def2-SVP');
    expect(row.finalEnergyHartree).toBeCloseTo(-76.35815183294746, 12);
  });
});
