import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  XTB_CAPABILITIES,
  XTB_SOLVENTS,
  buildXtbInput,
  classifyXtbTermination,
  makeXtbFixtureOutput,
  parseXtbGeometry,
  parseXtbOutput,
  xtbMethodBlock,
} from '../../src/shared/engines/xtb.js';
import { terminationCodeOf, canonicalResult } from '../../src/shared/engines/canonical.js';
import { evaluateGates } from '../../src/shared/gaussianOutput.js';
import { ENGINES, engineFor, engineOrDefault, isEngineId } from '../../src/shared/engines/index.js';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'xtb', name), 'utf8');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const molecule = (overrides = {}) => ({ charge: 0, multiplicity: 1, coords: WATER, ...overrides });

describe('xTB engine registry', () => {
  it('registers every engine and falls back to Gaussian for an unknown id', () => {
    expect(Object.keys(ENGINES)).toEqual(['gaussian', 'xtb', 'orca']);
    expect(isEngineId('xtb')).toBe(true);
    expect(engineOrDefault('pyscf').id).toBe('gaussian');
    expect(() => engineFor('pyscf')).toThrow(/Unknown engine/);
  });

  it('exposes the verified xTB capabilities', () => {
    expect(XTB_CAPABILITIES.exitCodes).toEqual({ success: 0, failure: 128 });
    expect(XTB_CAPABILITIES.capturesStdout).toBe(true);
    expect(XTB_CAPABILITIES.restartArtifact).toBe('xtbrestart');
    expect(XTB_CAPABILITIES.unsupportedJobTypes).toContain('Opt=TS');
    expect(Object.keys(XTB_CAPABILITIES.jobFlags)).toEqual(['SP', 'Opt', 'Opt Freq', 'Freq']);
  });

  it('maps every app solvent to an xTB identifier for both models', () => {
    for (const solvent of ['Water', 'Dichloromethane', 'THF', 'Toluene', 'Acetonitrile']) {
      expect(XTB_SOLVENTS.ALPB[solvent]).toBeTruthy();
      expect(XTB_SOLVENTS.GBSA[solvent]).toBeTruthy();
    }
  });
});

describe('xTB input builder', () => {
  it('writes an XYZ file and the argv for a single point', () => {
    const built = buildXtbInput({ title: 'water sp', settings: { jobType: 'SP' }, molecule: molecule(), inputName: 'sp.xyz' });
    expect(built.inputName).toBe('sp.xyz');
    expect(built.outputName).toBe('sp.out');
    expect(built.captureStdout).toBe(true);
    expect(built.argv).toEqual(['sp.xyz', '--gfn', '2']);
    const lines = built.inputText.split('\n');
    expect(lines[0]).toBe('3');
    expect(lines[1]).toBe('water sp');
    expect(lines[2]).toMatch(/^O\s+-?0\.000000/);
  });

  it('maps each job type to its flag and honours the optimisation level', () => {
    const build = (jobType, extra = {}) => buildXtbInput({
      settings: { jobType, xtbOptLevel: 'tight', ...extra },
      molecule: molecule(),
      inputName: 'task.xyz',
    }).argv.join(' ');
    expect(build('Opt')).toBe('task.xyz --gfn 2 --opt tight');
    expect(build('Opt Freq')).toBe('task.xyz --gfn 2 --ohess tight');
    expect(build('Freq')).toBe('task.xyz --gfn 2 --hess');
  });

  it('selects the Hamiltonian and passes charge and unpaired electrons explicitly', () => {
    const built = buildXtbInput({
      settings: { jobType: 'SP', xtbMethod: 'gfn1' },
      molecule: molecule({ charge: 1, multiplicity: 2 }),
      inputName: 'cat.xyz',
    });
    expect(built.argv).toEqual(['cat.xyz', '--gfn', '1', '--chrg', '1', '--uhf', '1']);
  });

  it('uses --gfnff for the force-field model', () => {
    const built = buildXtbInput({
      settings: { jobType: 'SP', xtbMethod: 'gfnff' },
      molecule: molecule(),
      inputName: 'ff.xyz',
    });
    expect(built.argv).toEqual(['ff.xyz', '--gfnff']);
  });

  it('passes the implicit-solvation model and solvent identifier', () => {
    const built = buildXtbInput({
      settings: { jobType: 'Opt', solvation: true, solvationModel: 'ALPB', solvent: 'Dichloromethane' },
      molecule: molecule(),
      inputName: 'solv.xyz',
    });
    expect(built.argv).toContain('--alpb');
    expect(built.argv).toContain('ch2cl2');
    expect(built.solvation).toEqual({ model: 'ALPB', solvent: 'ch2cl2', state: 'default (gsolv)' });
  });

  it('refuses job types xTB cannot run instead of degrading them', () => {
    for (const jobType of ['Opt=TS', 'IRC', 'Scan']) {
      expect(() => buildXtbInput({ settings: { jobType }, molecule: molecule(), inputName: 't.xyz' }))
        .toThrow(/xTB cannot run/);
    }
  });

  it('refuses a Gaussian-only solvation model rather than pretending PCM is ALPB', () => {
    expect(() => buildXtbInput({
      settings: { jobType: 'SP', solvation: true, solvationModel: 'PCM', solvent: 'Water' },
      molecule: molecule(),
      inputName: 't.xyz',
    })).toThrow(/does not implement PCM/);
  });

  it('rejects a charge/multiplicity parity mismatch', () => {
    expect(() => buildXtbInput({
      settings: { jobType: 'SP' },
      molecule: molecule({ charge: 0, multiplicity: 2 }),
      inputName: 't.xyz',
    })).toThrow(/incompatible with multiplicity/);
  });

  it('rejects an unsafe input name and an invalid element', () => {
    expect(() => buildXtbInput({ settings: {}, molecule: molecule(), inputName: 'bad name.xyz' })).toThrow(/safe \.xyz/);
    expect(() => buildXtbInput({
      settings: {},
      molecule: molecule({ coords: [{ element: 'Xx', x: 0, y: 0, z: 0 }] }),
      inputName: 't.xyz',
    })).toThrow(/invalid element/);
  });
});

describe('xTB provenance method block', () => {
  const build = (jobType, extra = {}) => {
    const settings = { jobType, xtbMethod: 'gfn1', xtbOptLevel: 'tight', ...extra };
    return { settings, built: buildXtbInput({ settings, molecule: molecule(), inputName: 'task.xyz' }) };
  };

  it('records the Hamiltonian and opt level each job type actually runs', () => {
    const cases = [
      ['SP', null],
      ['Opt', 'tight'],
      ['Freq', null],
      ['Opt Freq', 'tight'],
    ];
    for (const [jobType, expectedOptLevel] of cases) {
      const { settings, built } = build(jobType);
      const block = xtbMethodBlock(settings, { argv: built.argv, jobType });
      expect(block.hamiltonian).toBe('gfn1');
      expect(block.optLevel).toBe(expectedOptLevel);
      expect(block.argv).toEqual(built.argv);
      // No Gaussian route vocabulary may leak into an xTB method record.
      expect(block).not.toHaveProperty('functional');
      expect(block).not.toHaveProperty('basis');
      expect(block).not.toHaveProperty('grid');
      expect(block).not.toHaveProperty('scf');
    }
  });

  it('reads the argv that ran instead of stale settings', () => {
    const block = xtbMethodBlock(
      { jobType: 'Opt', xtbMethod: 'gfn2', xtbOptLevel: 'normal' },
      { argv: ['r.xyz', '--gfnff', '--hess'] },
    );
    expect(block.hamiltonian).toBe('gfnff');
    expect(block.optLevel).toBeNull();
  });

  it('records solvation from argv and never the Gaussian dispersion keyword', () => {
    const { settings, built } = build('SP', {
      method: 'B3LYP',
      basis: 'def2-SVP',
      dispersion: 'GD3BJ',
      solvation: true,
      solvationModel: 'ALPB',
      solvent: 'THF',
    });
    const block = xtbMethodBlock(settings, { argv: built.argv });
    expect(block.solvation).toBe('ALPB/thf');
    expect(block.dispersion).toBe('D3(BJ) (built in)');
    const serialized = JSON.stringify(block);
    expect(serialized).not.toContain('B3LYP');
    expect(serialized).not.toContain('def2-SVP');
    expect(serialized).not.toContain('GD3BJ');
  });

  it('falls back to settings only when there is no argv to read', () => {
    const block = xtbMethodBlock({ jobType: 'Opt', xtbMethod: 'gfn0', xtbOptLevel: 'loose' });
    expect(block).toMatchObject({ hamiltonian: 'gfn0', optLevel: 'loose', argv: null });
  });
});

describe('engine checkpoint artifacts', () => {
  it('resolves the file a checkpoint edge transfers per engine', () => {
    expect(ENGINES.xtb.checkpointArtifact({ checkpointName: 'a.chk', nodeId: 'a' })).toBe('xtbrestart');
    expect(ENGINES.gaussian.checkpointArtifact({ checkpointName: 'a.chk', nodeId: 'a' })).toBe('a.chk');
    expect(ENGINES.gaussian.checkpointArtifact({ nodeId: 'a' })).toBe('a.chk');
  });
});

describe('xTB output parser — real 6.8.0 output', () => {
  it('parses a single point that prints no explicit termination marker', () => {
    const parsed = parseXtbOutput(fixture('water-sp.out'));
    expect(parsed.status).toBe('completed');
    expect(parsed.terminationCode).toBe('normal');
    expect(parsed.termination).toMatch(/timing footer/);
    expect(parsed.program).toEqual({ name: 'xtb', version: '6.8.0', revision: expect.stringMatching(/^[0-9a-f]{7,}$/) });
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-5.070370764545, 9);
    expect(parsed.scf.method).toBe('GFN2-xTB');
    expect(parsed.scf.status).toBe('converged');
    expect(parsed.scf.cycles).toBe(8);
    expect(parsed.thermochemistry.freeEnergyHartree).toBeNull();
    expect(parsed.extras.homoLumoGapEv).toBeCloseTo(14.629674472571, 6);
  });

  it('parses an optimisation: convergence, cycles and final energy', () => {
    const parsed = parseXtbOutput(fixture('water-opt-tight.out'));
    expect(parsed.status).toBe('completed');
    expect(parsed.optimization.completed).toBe(true);
    expect(parsed.optimization.cycles).toBe(5);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-5.070544442589, 9);
    expect(parsed.extras.optimisedGeometryFile).toBe('xtbopt.xyz');
  });

  it('parses thermochemistry and frequency counters from --ohess', () => {
    const parsed = parseXtbOutput(fixture('water-ohess.out'));
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
    // The six translations/rotations are printed as -0.00 and must not count.
    expect(parsed.frequencies.imaginaryValues).toEqual([]);
    expect(parsed.frequencies.minImaginary).toBeNull();
    expect(parsed.frequencies.scalingFactor).toBe(1);
    expect(parsed.frequencies.entropyTreatment).toBe('mRRHO');
    expect(parsed.thermochemistry.freeEnergyHartree).toBeCloseTo(-5.068048760159, 9);
    expect(parsed.thermochemistry.enthalpyHartree).toBeCloseTo(-5.046642479269, 9);
    expect(parsed.thermochemistry.zpeHartree).toBeCloseTo(0.020120983614, 9);
  });

  it('reports an abnormal termination as an error with no energy', () => {
    for (const name of ['failure-missing-input.out', 'failure-bad-element.out']) {
      const parsed = parseXtbOutput(fixture(name));
      expect(parsed.status).toBe('error');
      expect(parsed.terminationCode).toBe('error');
      expect(parsed.finalEnergy.hartree).toBeNull();
    }
  });

  it('never reports a truncated parse as complete', () => {
    const parsed = parseXtbOutput(fixture('water-sp.out'), { truncated: true });
    expect(parsed.complete).toBe(false);
  });

  it('reads the optimised geometry from xtbopt.xyz', () => {
    const geometry = parseXtbGeometry(fixture('water-xtbopt.xyz'));
    expect(geometry.source).toBe('xtbopt.xyz');
    expect(geometry.atoms).toHaveLength(3);
    expect(geometry.atoms[0].element).toBe('O');
    expect(geometry.atoms[2].element).toBe('H');
  });

  it('parses the dry-run fixture through the same path', () => {
    const parsed = parseXtbOutput(makeXtbFixtureOutput({ imaginary: 1 }));
    expect(parsed.frequencies.imaginaryCount).toBe(1);
    expect(parsed.frequencies.minImaginary).toBeLessThan(0);
    expect(parsed.thermochemistry.freeEnergyHartree).not.toBeNull();
  });

  it('labels a GFN-FF energy as a force-field result, not an SCC result', () => {
    const parsed = parseXtbOutput(fixture('water-gfnff.out'), {
      argv: ['water.xyz', '--gfnff', '--ohess', 'tight'],
      route: 'GFN-FF Opt Freq',
    });
    expect(parsed.status).toBe('completed');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-0.327655963434, 9);
    expect(parsed.finalEnergy.source).toBe('force-field');
    expect(parsed.scf.applicable).toBe(false);
    expect(parsed.scf.status).toBe('unknown');
    expect(parsed.scf.energyHartree).toBeNull();
    expect(parsed.scf.cycles).toBeNull();
    expect(parsed.route).toBe('GFN-FF Opt Freq');

    const gates = evaluateGates(parsed, { requireFrequency: true, requireThermochemistry: true, requireFinalEnergy: true });
    const scfGate = gates.gates.find((gate) => gate.name === 'SCF record');
    expect(scfGate.result).toBe('pass');
    expect(scfGate.detail).toMatch(/not applicable/i);
  });

  it('marks an xTB runtime exception as an error even when xTB also prints normal termination', () => {
    const parsed = parseXtbOutput(fixture('water-gfnff-runtime-exception.out'), {
      argv: ['water.xyz', '--gfnff', '--ohess', 'tight'],
    });
    expect(parsed.status).toBe('error');
    expect(parsed.terminationCode).toBe('error');
    expect(parsed.termination).toMatch(/runtime exception/i);
    expect(parsed.extras.runtimeException).toBe(true);
    expect(parsed.finalEnergy.source).toBe('force-field');

    const gates = evaluateGates(parsed, { requireFrequency: true, requireThermochemistry: true, requireFinalEnergy: true });
    expect(gates.overall).toBe('fail');
    expect(gates.gates.find((gate) => gate.name === 'Normal termination').result).toBe('fail');
  });
});

describe('xTB termination classifier', () => {
  it('treats a completed single point as normal', () => {
    expect(classifyXtbTermination(fixture('water-sp.out'), 0).code).toBe('normal');
  });

  it('treats exit 128 as a failure, not a signal', () => {
    const classified = classifyXtbTermination(fixture('failure-bad-element.out'), 128);
    expect(classified.code).toBe('error');
    expect(classified.reason).toMatch(/abnormal termination|fatal error/);
  });

  it('treats an unexplained non-zero exit as an error', () => {
    expect(classifyXtbTermination('nothing useful', 128).code).toBe('error');
  });

  it('treats a runtime exception as an error even when xTB prints normal termination', () => {
    const classified = classifyXtbTermination(fixture('water-gfnff-runtime-exception.out'), 0);
    expect(classified.code).toBe('error');
    expect(classified.reason).toMatch(/runtime exception|topology/i);
  });

  it('leaves an empty run unknown rather than guessing', () => {
    expect(classifyXtbTermination('', 0).code).toBe('none');
  });
});

describe('canonical result contract', () => {
  it('reads termination from legacy Gaussian strings', () => {
    expect(terminationCodeOf({ termination: 'Normal termination of Gaussian' })).toBe('normal');
    expect(terminationCodeOf({ termination: 'Error termination' })).toBe('error');
    expect(terminationCodeOf({ termination: 'No termination marker' })).toBe('none');
  });

  it('prefers an explicit terminationCode over the display string', () => {
    expect(terminationCodeOf({ terminationCode: 'normal', termination: 'weird text' })).toBe('normal');
  });

  it('turns missing sections into nulls instead of zeros', () => {
    const result = canonicalResult({ engine: 'xtb' });
    expect(result.scf.energyHartree).toBeNull();
    expect(result.finalEnergy.hartree).toBeNull();
    expect(result.thermochemistry.freeEnergyHartree).toBeNull();
    expect(result.status).toBe('incomplete');
    expect(result.engine).toBe('xtb');
  });
});
