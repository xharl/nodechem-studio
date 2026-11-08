import { describe, it, expect } from 'vitest';
import { buildGaussianInput, DEMO_WATER, methodBlockFor, routeFor, outputNameFor } from '../src/shared/gaussianInput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';

const baseSettings = {
  jobType: 'Opt',
  method: 'B3LYP',
  basis: '6-31G(d)',
  memory: '4',
  memoryUnit: 'GB',
  nproc: '4',
  checkpoint: 'task.chk',
  charge: 0,
  multiplicity: 1,
  dispersion: '',
  scf: '',
  grid: '',
  population: '',
  verbosity: '',
  solvation: false,
  customKeywords: '',
};

const molecule = { charge: 0, multiplicity: 1, coords: DEMO_WATER };

describe('Gaussian input builder', () => {
  it('emits link0, route, title, charge and Cartesian coordinates', () => {
    const text = buildGaussianInput({
      title: 'Water optimization',
      settings: baseSettings,
      molecule,
      inputName: 'water_opt.gjf',
    });
    expect(text).toContain('%Mem=4GB');
    expect(text).toContain('%NProcShared=4');
    expect(text).toContain('%Chk=task.chk');
    expect(text).toContain('#p B3LYP/6-31G(d) Opt');
    expect(text).toContain('Water optimization');
    expect(text).toContain('0 1');
    expect(text).toContain('O');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('adds solvation, dispersion and custom route keywords', () => {
    const text = buildGaussianInput({
      settings: {
        ...baseSettings,
        dispersion: 'GD3BJ',
        solvation: true,
        solvationModel: 'SMD',
        solvent: 'Water',
        customKeywords: 'Nosymm',
      },
      molecule,
      inputName: 'water.gjf',
    });
    expect(text).toContain('EmpiricalDispersion=GD3BJ');
    expect(text).toContain('SCRF=(SMD,Solvent=Water)');
    expect(text).toContain('Nosymm');
  });

  it('supports an explicit checkpoint hand-off', () => {
    const text = buildGaussianInput({
      settings: { ...baseSettings, checkpoint: 'ts_freq.chk' },
      molecule,
      inputName: 'ts_freq.gjf',
      oldCheckpoint: 'ts_opt.chk',
    });
    expect(text).toContain('%OldChk=ts_opt.chk');
    expect(text).toContain('%Chk=ts_freq.chk');
    expect(text).toContain('Geom=Check');
    expect(text).toContain('Guess=Read');
  });

  it('does not duplicate Geom or Guess when the route already sets them', () => {
    const text = buildGaussianInput({
      settings: { ...baseSettings, customKeywords: 'Geom=AllCheck Guess=Read' },
      molecule,
      inputName: 'continue.gjf',
      oldCheckpoint: 'previous.chk',
    });
    expect(text.match(/Geom=/g)).toHaveLength(1);
    expect(text.match(/Guess=/g)).toHaveLength(1);
  });

  it('rejects an input name that could escape the run directory', () => {
    expect(() => buildGaussianInput({
      settings: baseSettings,
      molecule,
      inputName: '../escape.gjf',
    })).toThrow(/safe/);
  });

  it('rejects a molecule without coordinates', () => {
    expect(() => buildGaussianInput({
      settings: baseSettings,
      molecule: { coords: [] },
      inputName: 'empty.gjf',
    })).toThrow(/coordinates/);
  });

  it('builds an IRC route with both directions', () => {
    expect(routeFor({ ...baseSettings, jobType: 'IRC', ircDirection: 'both' }))
      .toContain('IRC(forward,reverse)');
  });

  it('maps input names to Gaussian output names', () => {
    expect(outputNameFor('water_opt.gjf')).toBe('water_opt.out');
    expect(outputNameFor('water.com')).toBe('water.out');
  });
});

describe('issue #15 — transition-state force constants', () => {
  const tsSettings = (overrides = {}) => ({ ...baseSettings, jobType: 'Opt=TS', ...overrides });
  const routeOf = (overrides = {}) => routeFor(tsSettings(overrides));

  it('gives a new TS block Opt=(TS,CalcFC,NoEigenTest)', () => {
    const settings = defaultSettings({ jobType: 'Opt=TS', checkpoint: 'ts_opt.chk' });
    expect(routeFor(settings)).toBe('#p B3LYP/def2SVP Opt=(TS,CalcFC,NoEigenTest) EmpiricalDispersion=GD3BJ');

    const text = buildGaussianInput({ settings, molecule, inputName: 'ts_opt.gjf' });
    expect(text.split('\n')).toContain('#p B3LYP/def2SVP Opt=(TS,CalcFC,NoEigenTest) EmpiricalDispersion=GD3BJ');
  });

  it('covers all four force-constant choices', () => {
    expect(routeOf({ forceConstants: 'CalcFC' })).toBe('#p B3LYP/6-31G(d) Opt=(TS,CalcFC,NoEigenTest)');
    expect(routeOf({ forceConstants: 'CalcAll' })).toBe('#p B3LYP/6-31G(d) Opt=(TS,CalcAll)');
    expect(routeOf({ forceConstants: 'ReadFC' })).toBe('#p B3LYP/6-31G(d) Opt=(TS,ReadFC)');
    expect(routeOf({ forceConstants: 'default' })).toBe('#p B3LYP/6-31G(d) Opt=TS');
  });

  it('falls back to the safe CalcFC form for an unknown choice', () => {
    expect(routeOf({ forceConstants: 'CalcEveryPoint' })).toBe('#p B3LYP/6-31G(d) Opt=(TS,CalcFC,NoEigenTest)');
    expect(routeOf({ forceConstants: undefined })).toBe('#p B3LYP/6-31G(d) Opt=(TS,CalcFC,NoEigenTest)');
  });

  it('leaves a non-TS job untouched by the force-constant choice', () => {
    expect(routeFor({ ...baseSettings, forceConstants: 'CalcAll' })).toBe('#p B3LYP/6-31G(d) Opt');
    expect(routeFor({ ...baseSettings, jobType: 'Freq', forceConstants: 'CalcAll' })).toBe('#p B3LYP/6-31G(d) Freq');
  });

  it('never emits two Opt keywords when other route options are composed in', () => {
    const settings = tsSettings({
      forceConstants: 'ReadFC',
      dispersion: 'GD3BJ',
      scf: 'Tight',
      grid: 'UltraFine',
      solvation: true,
      solvationModel: 'SMD',
      solvent: 'Water',
      customKeywords: 'Nosymm',
      checkpoint: 'ts_opt.chk',
    });
    const route = routeFor(settings);
    expect(route.match(/Opt=/g)).toHaveLength(1);
    expect(route).toContain('Opt=(TS,ReadFC)');

    const text = buildGaussianInput({
      settings,
      molecule,
      inputName: 'ts_opt.gjf',
      oldCheckpoint: 'r_freq.chk',
    });
    const routeLine = text.split('\n').find((line) => line.startsWith('#p'));
    expect(routeLine.match(/Opt=/g)).toHaveLength(1);
    expect(text).toContain('%OldChk=r_freq.chk');
    expect(text).toContain('Geom=Check Guess=Read');
  });

  it('rejects extra keywords that would add a second Opt keyword', () => {
    expect(() => routeOf({ customKeywords: 'Opt=(TS,CalcAll)' })).toThrow(/second Opt keyword/);
    expect(() => routeOf({ forceConstants: 'default', customKeywords: 'Opt' })).toThrow(/second Opt keyword/);
  });

  it('refuses ReadFC when no checkpoint hand-off exists', () => {
    expect(() => buildGaussianInput({
      settings: tsSettings({ forceConstants: 'ReadFC' }),
      molecule,
      inputName: 'ts_opt.gjf',
    })).toThrow(/ReadFC needs a checkpoint hand-off/);
  });
});

describe('issue #16 — optimization convergence', () => {
  const opt = (overrides = {}) => ({ ...baseSettings, jobType: 'Opt', ...overrides });
  const routeOf = (overrides = {}) => routeFor(opt(overrides));

  it('emits a bare Opt when the convergence is left at Default', () => {
    expect(routeOf()).toBe('#p B3LYP/6-31G(d) Opt');
    expect(routeOf({ optConvergence: '' })).toBe('#p B3LYP/6-31G(d) Opt');
    expect(routeOf({ optConvergence: 'Loose' })).toBe('#p B3LYP/6-31G(d) Opt');
  });

  it('emits Opt=Tight and Opt=VeryTight as a single job keyword', () => {
    expect(routeOf({ method: 'MP2', optConvergence: 'Tight' }))
      .toBe('#p MP2/6-31G(d) Opt=Tight');
    expect(routeOf({ method: 'MP2', optConvergence: 'VeryTight' }))
      .toBe('#p MP2/6-31G(d) Opt=VeryTight');
  });

  it('still emits Opt=TS when the convergence is left at Default', () => {
    expect(routeOf({ jobType: 'Opt=TS', forceConstants: 'default' }))
      .toBe('#p B3LYP/6-31G(d) Opt=TS');
    expect(routeOf({ jobType: 'Opt=TS', forceConstants: 'default', optConvergence: 'Tight' }))
      .toBe('#p B3LYP/6-31G(d) Opt=(TS,Tight) Integral=UltraFine');
  });

  it('composes CalcFC force constants with Tight into one Opt= keyword', () => {
    const route = routeOf({
      method: 'MP2', jobType: 'Opt=TS', forceConstants: 'CalcFC', optConvergence: 'Tight',
    });
    expect(route).toBe('#p MP2/6-31G(d) Opt=(TS,CalcFC,NoEigenTest,Tight)');
    expect(route.match(/Opt=/g)).toHaveLength(1);

    const text = buildGaussianInput({
      settings: opt({
        method: 'MP2', jobType: 'Opt=TS', forceConstants: 'CalcFC', optConvergence: 'Tight',
        checkpoint: 'ts_opt.chk',
      }),
      molecule,
      inputName: 'ts_opt.gjf',
    });
    expect(text.split('\n').find((line) => line.startsWith('#p')))
      .toBe('#p MP2/6-31G(d) Opt=(TS,CalcFC,NoEigenTest,Tight)');
  });

  it('composes CalcFC with VeryTight into one Opt= keyword', () => {
    const route = routeOf({
      method: 'MP2', jobType: 'Opt=TS', forceConstants: 'CalcFC', optConvergence: 'VeryTight',
    });
    expect(route).toBe('#p MP2/6-31G(d) Opt=(TS,CalcFC,NoEigenTest,VeryTight)');
    expect(route.match(/Opt=/g)).toHaveLength(1);
  });

  it('composes the convergence into Opt Freq without a second Opt keyword', () => {
    const route = routeOf({ jobType: 'Opt Freq', method: 'MP2', optConvergence: 'Tight' });
    expect(route).toBe('#p MP2/6-31G(d) Opt=Tight Freq');
    expect(route.match(/Opt/g)).toHaveLength(1);
  });

  it('ignores the convergence choice for a job that does not optimize', () => {
    expect(routeOf({ jobType: 'Freq', optConvergence: 'Tight' })).toBe('#p B3LYP/6-31G(d) Freq');
    expect(routeOf({ jobType: 'SP', optConvergence: 'VeryTight' })).toBe('#p B3LYP/6-31G(d) SP');
  });

  it('defaults a DFT optimization at Tight convergence to UltraFine', () => {
    expect(routeOf({ optConvergence: 'Tight' }))
      .toBe('#p B3LYP/6-31G(d) Opt=Tight Integral=UltraFine');
    expect(routeOf({ optConvergence: 'VeryTight' }))
      .toBe('#p B3LYP/6-31G(d) Opt=VeryTight Integral=UltraFine');
    expect(methodBlockFor(opt({ optConvergence: 'Tight' })).grid).toBe('UltraFine');

    const text = buildGaussianInput({
      settings: opt({ optConvergence: 'Tight', checkpoint: 'opt.chk' }),
      molecule,
      inputName: 'opt.gjf',
    });
    expect(text.split('\n')).toContain('#p B3LYP/6-31G(d) Opt=Tight Integral=UltraFine');
  });

  it('keeps an explicit grid instead of the UltraFine default', () => {
    expect(routeOf({ optConvergence: 'Tight', grid: 'Fine' }))
      .toBe('#p B3LYP/6-31G(d) Opt=Tight Integral=Fine');
    const explicit = routeOf({ optConvergence: 'Tight', grid: 'UltraFine' });
    expect(explicit).toBe('#p B3LYP/6-31G(d) Opt=Tight Integral=UltraFine');
    expect(explicit.match(/Integral=/g)).toHaveLength(1);
  });

  it('does not default the grid for a non-DFT method', () => {
    expect(routeOf({ method: 'MP2', optConvergence: 'Tight' }))
      .toBe('#p MP2/6-31G(d) Opt=Tight');
    expect(methodBlockFor(opt({ method: 'MP2', optConvergence: 'Tight' })).grid).toBeNull();
  });

  it('still rejects extra keywords that would add a second Opt keyword', () => {
    expect(() => routeOf({ optConvergence: 'Tight', customKeywords: 'Opt=(Tight)' }))
      .toThrow(/second Opt keyword/);
  });
});

describe('imported geometry', () => {
  const coords = [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
    { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
  ];

  it('is byte-deterministic and uses the supplied coordinates', () => {
    const build = () => buildGaussianInput({
      title: 'imported water',
      settings: baseSettings,
      molecule: { charge: 0, multiplicity: 1, coords },
      inputName: 'water.gjf',
    });
    const first = build();
    expect(build()).toBe(first);
    expect(first).toMatch(/O\s+0\.000000\s+0\.000000\s+0\.117300/);
    expect(first).toMatch(/H\s+0\.000000\s+-0\.757200\s+-0\.469200/);
  });

  it('reflects a different imported geometry', () => {
    const other = [{ element: 'C', x: 0, y: 0, z: 0 }, { element: 'O', x: 1.2, y: 0, z: 0 }];
    const text = buildGaussianInput({
      title: 'CO',
      settings: baseSettings,
      molecule: { charge: 0, multiplicity: 1, coords: other },
      inputName: 'co.gjf',
    });
    expect(text).toMatch(/C\s+0\.000000\s+0\.000000\s+0\.000000/);
    expect(text).toMatch(/O\s+1\.200000\s+0\.000000\s+0\.000000/);
  });
});

/* Issue #77: composite methods are complete routes, not a method/basis pair. */
describe('issue #77 — composite method routes', () => {
  it('writes only the composite keyword, with no method/basis pair and no Opt', () => {
    expect(routeFor(defaultSettings({ jobType: 'CBS-QB3' }))).toBe('#p CBS-QB3');
    expect(routeFor(defaultSettings({ jobType: 'G4' }))).toBe('#p G4');
    expect(routeFor(defaultSettings({ jobType: 'G4(MP2)' }))).toBe('#p G4MP2');
    expect(routeFor(defaultSettings({ jobType: 'CBS-4M' }))).toBe('#p CBS-4M');
  });

  it('does not plant B3LYP/def2-SVP defaults on a composite job', () => {
    const settings = defaultSettings({ jobType: 'G4' });
    expect(settings.method).toBe('');
    expect(settings.basis).toBe('');
    expect(settings.dispersion).toBe('');
  });

  it('allows ordinary SCF and grid options on the composite route', () => {
    expect(routeFor(defaultSettings({ jobType: 'G4', scf: 'Tight', grid: 'UltraFine' })))
      .toBe('#p G4 SCF=Tight Integral=UltraFine');
  });

  it('refuses a leftover method or basis instead of silently ignoring it', () => {
    expect(() => routeFor({ ...defaultSettings({ jobType: 'G4' }), method: 'B3LYP' }))
      .toThrow(/method "B3LYP"/);
    expect(() => routeFor({ ...defaultSettings({ jobType: 'G4' }), basis: '6-31G(d)' }))
      .toThrow(/basis "6-31G\(d\)"/);
    expect(() => routeFor({ ...defaultSettings({ jobType: 'G4' }), dispersion: 'GD3BJ' }))
      .toThrow(/dispersion/);
    expect(() => routeFor({ ...defaultSettings({ jobType: 'G4' }), orbitals: true }))
      .toThrow(/frontier-orbital/);
  });

  it('refuses a composite keyword typed into the method field', () => {
    expect(() => routeFor({ ...baseSettings, method: 'G4' }))
      .toThrow(/choose it as the job type/);
  });

  it('records the composite method in the provenance block', () => {
    expect(methodBlockFor(defaultSettings({ jobType: 'G4(MP2)' }))).toMatchObject({
      functional: 'G4(MP2)',
      basis: 'method-defined',
      composite: 'G4(MP2)',
      compositeKeyword: 'G4MP2',
    });
  });
});

/* Issue #77: Counterpoise=N input with fragment labels. */
const WATER_DIMER = [
  { element: 'O', x: 0.00, y: 0.00, z: 0.00, fragment: 1 },
  { element: 'H', x: 0.49, y: 0.76, z: -0.29, fragment: 1 },
  { element: 'H', x: 0.49, y: -0.76, z: -0.29, fragment: 1 },
  { element: 'O', x: 0.00, y: 0.00, z: 2.98, fragment: 2 },
  { element: 'H', x: -0.91, y: 0.00, z: 3.24, fragment: 2 },
  { element: 'H', x: -0.01, y: 0.00, z: 2.03, fragment: 2 },
];

function counterpoiseSettings(overrides = {}) {
  return {
    ...defaultSettings({ jobType: 'SP' }),
    method: 'B3LYP',
    basis: '6-31G(d)',
    checkpoint: 'dimer.chk',
    dispersion: '',
    counterpoise: 2,
    ...overrides,
  };
}

describe('issue #77 — counterpoise input', () => {
  it('writes Counterpoise=N and a fragment label on every atom', () => {
    const text = buildGaussianInput({
      settings: counterpoiseSettings(),
      molecule: { charge: 0, multiplicity: 1, fragments: ['O', 'O'], coords: WATER_DIMER },
      inputName: 'dimer.gjf',
    });
    expect(text).toContain('#p B3LYP/6-31G(d) SP Counterpoise=2');
    expect(text).toContain('O(Fragment=1)');
    expect(text).toContain('O(Fragment=2)');
    expect(text).toContain('H(Fragment=2)');
  });

  it('writes the whole-system and per-fragment charge/spin line when given', () => {
    const text = buildGaussianInput({
      settings: counterpoiseSettings({
        charge: 1,
        counterpoiseChargeStates: [
          { charge: 1, multiplicity: 2 },
          { charge: 0, multiplicity: 1 },
        ],
      }),
      molecule: { charge: 1, multiplicity: 2, fragments: ['O', 'O'], coords: WATER_DIMER },
      inputName: 'dimer.gjf',
    });
    expect(text).toContain('1 2 1 2 0 1');
  });

  it('refuses when the labels do not cover fragments 1..N', () => {
    const wrong = WATER_DIMER.map((atom, index) => (index === 5 ? { ...atom, fragment: 3 } : atom));
    expect(() => buildGaussianInput({
      settings: counterpoiseSettings(),
      molecule: { charge: 0, multiplicity: 1, fragments: ['O', 'O'], coords: wrong },
      inputName: 'dimer.gjf',
    })).toThrow(/consecutively|exceed/);
  });

  it('refuses when the molecule fragment strings disagree with Counterpoise=N', () => {
    expect(() => buildGaussianInput({
      settings: counterpoiseSettings(),
      molecule: { charge: 0, multiplicity: 1, fragments: ['O'], coords: WATER_DIMER },
      inputName: 'dimer.gjf',
    })).toThrow(/declares 1 fragment/);
  });

  it('refuses a counterpoise combination Gaussian cannot run', () => {
    expect(() => buildGaussianInput({
      settings: counterpoiseSettings({ jobType: 'IRC' }),
      molecule: { charge: 0, multiplicity: 1, fragments: ['O', 'O'], coords: WATER_DIMER },
      inputName: 'dimer.gjf',
    })).toThrow(/Counterpoise is available/);
    expect(() => buildGaussianInput({
      settings: counterpoiseSettings({ solvation: true }),
      molecule: { charge: 0, multiplicity: 1, fragments: ['O', 'O'], coords: WATER_DIMER },
      inputName: 'dimer.gjf',
    })).toThrow(/SCRF/);
  });
});
