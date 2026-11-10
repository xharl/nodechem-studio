import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ORCA_BASES,
  ORCA_METHODS,
  ORCA_PNO_THRESHOLDS,
  buildOrcaInput,
  orcaMethodBlock,
  orcaPnoThresholdLabel,
  parseOrcaOutput,
} from '../src/shared/engines/orca.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildRunInput } from '../src/shared/workflowTasks.js';

/**
 * Issue 227 — ORCA DLPNO-CCSD(T) single points.
 *
 * The fixture is a verbatim ORCA 6.1.1 water log (see its PROVENANCE.md). It
 * pins the DLPNO header, the printed `TCutPNO` and the correlation/triples
 * energies; none of the numbers below are written into the test by hand.
 */
const FIXTURE = path.join(
  import.meta.dirname,
  'fixtures',
  'real',
  'orca-6.1-water-dlpno',
  'water_dlpno.out',
);

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const molecule = () => ({ charge: 0, multiplicity: 1, coords: WATER });

const settings = (overrides = {}) => defaultSettings({
  jobType: 'SP',
  method: 'DLPNO-CCSD(T)',
  basis: 'def2-TZVP(PP)',
  dispersion: '',
  ...overrides,
});

const build = (overrides = {}) => buildOrcaInput({
  title: 'water',
  settings: settings(overrides),
  molecule: molecule(),
  inputName: 'task.inp',
});

describe('ORCA DLPNO-CCSD(T) builder', () => {
  it('writes the method, PNO preset and the RI/auxiliary defaults explicitly', () => {
    const built = build({ pnoThreshold: 'TightPNO', scf: 'Tight' });
    const route = built.inputText.split('\n')[0];
    expect(route).toBe('! DLPNO-CCSD(T) def2-TZVP def2/J def2-TZVP/C RIJCOSX TightPNO TightSCF');
    expect(built.route).toContain('DLPNO-CCSD(T)');
    expect(built.route).toContain('TightPNO');
    expect(built.route).toContain('RIJCOSX');
    expect(built.method).toBe('DLPNO-CCSD(T)');
    expect(built.basis).toBe('def2-TZVP(PP)');
    expect(built.basisKeyword).toBe('def2-TZVP');
    expect(built.pnoThreshold).toBe('TightPNO');
    expect(built.tCutPNO).toBeCloseTo(1e-7, 12);
    expect(built.auxiliaryBasis).toBe('def2-TZVP/C');
    expect(built.coulombBasis).toBe('def2/J');
    expect(built.riApproximation).toBe('RIJCOSX');
    expect(built.jobType).toBe('SP');
  });

  it('defaults to NormalPNO and states it in the route instead of omitting it', () => {
    const built = build({ basis: 'def2-SVP' });
    expect(built.inputText.split('\n')[0])
      .toBe('! DLPNO-CCSD(T) def2-SVP def2/J def2-SVP/C RIJCOSX NormalPNO');
    expect(built.pnoThreshold).toBe('NormalPNO');
  });

  it('offers the PP basis and records it without changing the ORCA keyword', () => {
    expect(ORCA_METHODS.map((entry) => entry.id)).toContain('DLPNO-CCSD(T)');
    const pp = ORCA_BASES.find((entry) => entry.id === 'def2-TZVP(PP)');
    expect(pp.keyword).toBe('def2-TZVP');
    expect(pp.auxiliary).toBe('def2-TZVP/C');
    expect(ORCA_PNO_THRESHOLDS.map((entry) => entry.id)).toEqual(['NormalPNO', 'TightPNO']);
  });

  it('records the threshold in the provenance block', () => {
    const block = orcaMethodBlock(settings({ pnoThreshold: 'TightPNO' }), { argv: ['task.inp'], jobType: 'SP' });
    expect(block).toMatchObject({
      program: 'ORCA',
      method: 'DLPNO-CCSD(T)',
      basis: 'def2-TZVP(PP)',
      basisKeyword: 'def2-TZVP',
      pnoThreshold: 'TightPNO',
      tCutPNO: 1e-7,
      auxiliaryBasis: 'def2-TZVP/C',
      coulombBasis: 'def2/J',
      riApproximation: 'RIJCOSX',
      jobType: 'SP',
    });
  });

  it('builds through the production buildRunInput path', () => {
    const project = validateProject({
      schemaVersion: 3,
      name: 'dlpno',
      defaults: { engine: 'orca', method: 'DLPNO-CCSD(T)', basis: 'def2-TZVP(PP)', memory: '4', memoryUnit: 'GB', nproc: 4 },
      molecule: { charge: 0, multiplicity: 1, coords: WATER, fragments: [], geometry: { kind: 'manual' } },
      nodes: [{
        id: 'sp',
        type: 'calculate',
        title: 'water dlpno',
        x: 0,
        y: 0,
        settings: settings({ jobType: 'SP', pnoThreshold: 'TightPNO' }),
      }],
      edges: [],
    }).project;
    const built = buildRunInput(project, project.nodes[0]);
    expect(built.inputName).toBe('sp.inp');
    expect(built.inputText.split('\n')[0]).toContain('DLPNO-CCSD(T)');
    expect(built.inputText.split('\n')[0]).toContain('TightPNO');
    expect(built.route).toContain('RIJCOSX');
    expect(built.pnoThreshold).toBe('TightPNO');
  });
});

describe('ORCA DLPNO-CCSD(T) refusals', () => {
  it('refuses analytical frequencies by name', () => {
    expect(() => build({ jobType: 'Freq' }))
      .toThrow(/DLPNO-CCSD\(T\) is a single-point method.*analytical frequencies/);
  });

  it('refuses an optimisation because there is no analytic gradient', () => {
    expect(() => build({ jobType: 'Opt' }))
      .toThrow(/DLPNO-CCSD\(T\) is a single-point method.*analytic gradient/);
    expect(() => build({ jobType: 'Opt Freq' }))
      .toThrow(/analytic gradient.*analytical frequencies/);
  });

  it('refuses a basis with no correlation-fitting auxiliary set', () => {
    expect(() => build({ basis: '6-31G(d)' }))
      .toThrow(/needs a correlation-fitting auxiliary basis/);
    expect(() => build({ basis: '6-311+G(d,p)' }))
      .toThrow(/def2-TZVP\(PP\) is the documented production choice/);
  });

  it('refuses a PNO threshold on a method that has none', () => {
    expect(() => build({ method: 'B3LYP', basis: 'def2-SVP', pnoThreshold: 'TightPNO' }))
      .toThrow(/PNO threshold .* applies only to DLPNO-CCSD\(T\)/);
  });

  it('refuses an unknown PNO threshold rather than silently using NormalPNO', () => {
    expect(() => build({ pnoThreshold: 'LoosePNO' }))
      .toThrow(/PNO threshold "LoosePNO" is not available. Choose NormalPNO or TightPNO/);
  });
});

describe('ORCA DLPNO-CCSD(T) parser — real ORCA 6.1.1 log', () => {
  const parsed = parseOrcaOutput(fs.readFileSync(FIXTURE, 'utf8'));

  it('identifies the program and normal termination', () => {
    expect(parsed.program).toEqual({ name: 'ORCA', version: '6.1.1', revision: 'RELEASE' });
    expect(parsed.terminationCode).toBe('normal');
    expect(parsed.termination).toBe('ORCA TERMINATED NORMALLY');
  });

  it('records the DLPNO method, PNO threshold and both basis sets', () => {
    expect(parsed.dlpno.method).toBe('DLPNO-CCSD(T)');
    expect(parsed.dlpno.pnoThreshold).toBe('NormalPNO');
    expect(parsed.dlpno.tCutPNO).toBeCloseTo(3.330e-7, 12);
    expect(parsed.dlpno.tCutPairs).toBeCloseTo(1e-4, 12);
    expect(parsed.dlpno.tCutMKN).toBeCloseTo(1e-3, 12);
    expect(parsed.dlpno.basis).toBe('cc-pVTZ');
    expect(parsed.dlpno.auxiliaryBasis).toBe('cc-pVTZ/C');
    expect(parsed.dlpno.triplesHeader).toBe(true);
    // The log leaves RI to ORCA, so the parser says so instead of inventing a
    // keyword; it does record what ORCA printed for K(C).
    expect(parsed.dlpno.riApproximation).toBeNull();
    expect(parsed.dlpno.kCFormation).toBe('RI-DLPNO');
  });

  it('records the correlation and triples energies, not just the final energy', () => {
    expect(parsed.dlpno.correlationEnergyHartree).toBeCloseTo(-0.275822870, 9);
    expect(parsed.dlpno.triplesCorrectionHartree).toBeCloseTo(-0.007477978, 9);
    expect(parsed.dlpno.ccsdEnergyHartree).toBeCloseTo(-76.324481361, 9);
    expect(parsed.dlpno.eCcsdTHartree).toBeCloseTo(-76.331959339, 9);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.331959339263, 9);
    expect(parsed.finalEnergy.source).toBe('final-single-point');
  });

  it('records where in the log each fact came from', () => {
    expect(parsed.dlpno.provenance).toEqual({
      source: 'orca-output',
      programVersion: '6.1.1',
      inputLine: 226,
      settingsLine: 1011,
      triplesHeaderLine: 1385,
      energyLine: 1468,
    });
  });

  it('maps the printed TCutPNO, not the input keyword, to the preset', () => {
    expect(orcaPnoThresholdLabel(3.33e-7)).toBe('NormalPNO');
    expect(orcaPnoThresholdLabel(1e-7)).toBe('TightPNO');
    expect(orcaPnoThresholdLabel(2e-8)).toBe('custom');
    expect(orcaPnoThresholdLabel(null)).toBeNull();
  });

  it('leaves a non-DLPNO log without a DLPNO section', () => {
    const plain = parseOrcaOutput(fs.readFileSync(path.join(
      import.meta.dirname,
      'fixtures',
      'orca',
      'water-sp.out',
    ), 'utf8'));
    expect(plain.dlpno).toBeUndefined();
    // Real ORCA logs name "DLPNO-CCSD(T)" in the contributor banner; that is
    // not evidence the job used it.
    const real = parseOrcaOutput(fs.readFileSync(path.join(
      import.meta.dirname,
      'fixtures',
      'real',
      'orca-5.0-water-mp2',
      'water_mp2.out',
    ), 'utf8'));
    expect(real.dlpno).toBeUndefined();
  });
});

describe('pnoThreshold settings round-trip', () => {
  const projectWith = (settings) => ({
    schemaVersion: 3,
    name: 'pno settings',
    molecule: {
      smiles: '',
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords: WATER,
      geometry: { source: 'demo', file: '', format: '' },
    },
    defaults: { engine: 'orca', method: 'DLPNO-CCSD(T)', basis: 'def2-TZVP(PP)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{
      id: 'main',
      title: 'pno',
      nodes: [{
        id: 'sp',
        type: 'calculate',
        kind: 'SP',
        title: 'Single point',
        state: 'ready',
        x: 0,
        y: 0,
        settings,
        output: null,
        checkpointFrom: null,
      }],
      edges: [],
    }],
    reports: [],
    activeFlowId: 'main',
  });

  const roundTrip = (overrides) => {
    const result = validateProject(projectWith({
      ...defaultSettings({ jobType: 'SP', method: 'DLPNO-CCSD(T)', basis: 'def2-TZVP(PP)' }),
      ...overrides,
    }));
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    return result.project.nodes[0].settings;
  };

  it('keeps the threshold across save and reload', () => {
    expect(roundTrip({ pnoThreshold: 'TightPNO' }).pnoThreshold).toBe('TightPNO');
    expect(roundTrip({ pnoThreshold: 'NormalPNO' }).pnoThreshold).toBe('NormalPNO');
  });

  it('writes no key when the caller never set one', () => {
    expect('pnoThreshold' in roundTrip({})).toBe(false);
  });

  it('refuses a value outside the two presets', () => {
    const bad = validateProject(projectWith({
      ...defaultSettings({ jobType: 'SP', method: 'DLPNO-CCSD(T)', basis: 'def2-TZVP(PP)' }),
      pnoThreshold: 'LoosePNO',
    }));
    expect(bad.errors.some((error) => error.path.endsWith('settings.pnoThreshold'))).toBe(true);
  });
});
