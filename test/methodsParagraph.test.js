import { describe, it, expect } from 'vitest';
import {
  METHODS_FORMS,
  NOT_RECORDED,
  isFixtureRun,
  methodsParagraphFor,
} from '../src/shared/methodsParagraph.js';

const METHOD = Object.freeze({
  functional: 'PBE0',
  basis: 'def2-TZVP',
  dispersion: 'GD3BJ',
  solvation: 'SMD/THF',
  grid: 'UltraFine',
  scf: 'VeryTight',
});

function gaussianRecord(overrides = {}) {
  return {
    id: '20261107-120000-abc123',
    status: 'completed',
    engine: 'gaussian',
    dryRun: false,
    title: 'Synthetic methods fixture',
    inputName: 'water.gjf',
    outputName: 'water.out',
    outputFile: 'water.out',
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    app: { version: '0.1.0', commit: 'deadbee' },
    provenance: {
      kind: 'calculation',
      jobType: 'Opt Freq',
      method: { ...METHOD },
    },
    parsed: {
      program: { name: 'Gaussian', version: '16', revision: 'C.01' },
      route: '#p PBE0/def2TZVP Opt Freq EmpiricalDispersion=GD3BJ SCF=VeryTight Integral=UltraFine SCRF=(SMD,Solvent=THF)',
      scf: { cycles: 8, status: 'converged' },
      thermochemistry: {
        freeEnergyHartree: -76.02,
        temperatureK: 298.15,
        pressureAtm: 1,
      },
    },
    ...overrides,
  };
}

function xtbRecord(overrides = {}) {
  return {
    id: '20261107-130000-xtb001',
    status: 'completed',
    engine: 'xtb',
    dryRun: false,
    inputName: 'water.xyz',
    outputName: 'water.out',
    outputFile: 'water.out',
    app: { version: '0.1.0', commit: 'deadbee' },
    argv: ['water.xyz', '--gfn', '2', '--opt', 'tight', '--alpb', 'water'],
    provenance: {
      kind: 'calculation',
      jobType: 'Opt',
      // A Gaussian-shaped block may be present for an xTB record; it must not
      // leak into xTB prose.
      method: { functional: 'B3LYP', basis: '6-31G(d)', dispersion: 'GD3BJ', solvation: 'PCM/Water', grid: 'UltraFine', scf: null },
    },
    parsed: {
      program: { name: 'xtb', version: '6.8.0', revision: 'deadbee' },
      route: null,
      scf: { method: 'GFN2-xTB', status: 'converged', cycles: 8 },
      frequencies: { entropyTreatment: 'mRRHO' },
      thermochemistry: { freeEnergyHartree: -5.068048760159, entropyTreatment: 'mRRHO' },
    },
    ...overrides,
  };
}

describe('methods paragraph — Gaussian', () => {
  it('renders every recorded method field in full form and a Markdown variant', () => {
    const result = methodsParagraphFor(gaussianRecord());

    expect(result.ok).toBe(true);
    expect(result.refused).toBe(false);
    expect(result.engine).toBe('gaussian');
    expect(result.form).toBe('full');

    expect(result.plain).toContain('Gaussian 16, revision C.01');
    expect(result.plain).toContain('PBE0/def2-TZVP');
    expect(result.plain).toContain('GD3BJ');
    expect(result.plain).toContain('SMD');
    expect(result.plain).toContain('THF');
    expect(result.plain).toContain('UltraFine');
    expect(result.plain).toContain('VeryTight');
    expect(result.plain).toContain('a geometry optimization followed by a harmonic frequency calculation');
    expect(result.plain).toContain('298.150 K');
    expect(result.plain).toContain('1.000 atm');
    expect(result.plain).toContain('quasi-RRHO');
    expect(result.plain).toContain('1 atm -> 1 M');
    expect(result.plain).toContain('as recorded in run.json');
    expect(result.plain).toContain('the geometry source is not recorded in run.json');
    expect(result.plain).toContain('provenance kind calculation');
    expect(result.plain).toContain('NodeChem Studio 0.1.0 (commit deadbee)');

    expect(result.markdown).toContain('## Computational methods');
    expect(result.markdown).toContain('**Program and version:**');
    expect(result.markdown).toContain('**Level of theory:**');
    expect(result.markdown).toContain('PBE0/def2-TZVP');
    expect(result.markdown).not.toBe(result.plain);

    // Deterministic: same record, same bytes.
    expect(methodsParagraphFor(gaussianRecord())).toEqual(result);
  });

  it('renders a short form of three sentences that still names every field', () => {
    const result = methodsParagraphFor(gaussianRecord(), { form: 'short' });

    expect(result.ok).toBe(true);
    expect(result.form).toBe('short');
    expect(result.plain).not.toContain('\n');
    // Three sentences: exactly two sentence separators.
    expect((result.plain.match(/\. /g) || [])).toHaveLength(2);
    expect(result.plain).toContain('Gaussian 16, revision C.01');
    expect(result.plain).toContain('PBE0/def2-TZVP');
    expect(result.plain).toContain('GD3BJ');
    expect(result.plain).toContain('SMD');
    expect(result.plain).toContain('UltraFine');
    expect(result.plain).toContain('VeryTight');
    expect(result.plain).toContain('quasi-RRHO');
    expect(result.plain).toContain('the geometry source is not recorded in run.json');
    expect(result.markdown.startsWith('## Computational methods')).toBe(true);
  });

  it.each([
    ['Opt', 'a geometry optimization'],
    ['Opt Freq', 'a geometry optimization followed by a harmonic frequency calculation'],
    ['Opt=TS', 'a transition-state search'],
    ['Freq', 'a harmonic frequency calculation'],
    ['IRC', 'an intrinsic reaction coordinate (IRC) calculation'],
    ['SP', 'a single-point energy calculation'],
    ['Scan', 'a relaxed potential-energy surface scan'],
  ])('names the job type %s', (jobType, phrase) => {
    const record = gaussianRecord();
    record.provenance.jobType = jobType;
    record.parsed.route = `#p PBE0/def2TZVP ${jobType}`;
    const result = methodsParagraphFor(record);
    expect(result.ok).toBe(true);
    expect(result.plain).toContain(phrase);
  });

  it('derives a missing job type from the route but labels it as derived', () => {
    const record = gaussianRecord();
    delete record.provenance.jobType;
    record.parsed.route = '#p PBE0/def2TZVP Opt=TS CalcFC';

    const result = methodsParagraphFor(record);
    expect(result.plain).toContain('a transition-state search');
    expect(result.plain).toContain('derived from the route recorded in run.json');
    expect(result.missing).not.toContain('jobType');
  });

  it('reports missing fields instead of filling in defaults', () => {
    const record = {
      id: 'minimal-gaussian',
      engine: 'gaussian',
      dryRun: false,
      app: null,
      provenance: {
        kind: 'calculation',
        method: {
          functional: 'B3LYP',
          basis: '6-31G(d)',
          dispersion: null,
          solvation: null,
          grid: null,
          scf: null,
        },
      },
      parsed: null,
    };

    const result = methodsParagraphFor(record);
    expect(result.ok).toBe(true);
    expect(result.plain).toContain(`version ${NOT_RECORDED}`);
    expect(result.plain).toContain(`The job type is ${NOT_RECORDED}`);
    expect(result.plain).toContain('No empirical dispersion correction is recorded in run.json');
    expect(result.plain).toContain('gas phase');
    expect(result.plain).toContain('No integration-grid (Integral) or SCF-convergence (SCF) keyword is recorded in run.json');
    expect(result.plain).toContain(`a quasi-RRHO cutoff and a 1 atm -> 1 M standard-state correction are ${NOT_RECORDED}`);
    expect(result.plain).toContain('Version not recorded'.toLowerCase());
    expect(result.missing).toEqual(expect.arrayContaining([
      'program.version',
      'jobType',
      'provenance.method.dispersion',
      'provenance.method.solvation',
      'provenance.method.grid',
      'parsed.thermochemistry',
    ]));
  });

  it('never invents a level of theory when the method block is absent', () => {
    const record = {
      id: 'no-method',
      engine: 'gaussian',
      dryRun: false,
      provenance: { kind: 'calculation' },
      parsed: { program: { name: 'Gaussian', version: '16', revision: 'C.01' } },
    };

    const result = methodsParagraphFor(record);
    expect(result.ok).toBe(true);
    expect(result.plain).toContain('No method block is recorded in run.json');
    expect(result.plain).toContain(`The dispersion treatment is ${NOT_RECORDED}`);
    expect(result.plain).toContain(`The solvation treatment is ${NOT_RECORDED}`);
    expect(result.plain).not.toContain('B3LYP');
    expect(result.plain).not.toContain('6-31G(d)');
    expect(result.plain).not.toContain('PBE0');
  });

  it('rejects a record that is not an object', () => {
    for (const value of [null, undefined, 'run.json', []]) {
      const result = methodsParagraphFor(value);
      expect(result.ok).toBe(false);
      expect(result.refused).toBe(false);
      expect(result.reason).toBe('missing-record');
    }
  });
});

describe('methods paragraph — xTB', () => {
  it('uses xTB wording and ignores a Gaussian-shaped method block', () => {
    const result = methodsParagraphFor(xtbRecord());

    expect(result.ok).toBe(true);
    expect(result.engine).toBe('xtb');
    expect(result.plain).toContain('xTB 6.8.0 (revision deadbee)');
    expect(result.plain).toContain('GFN2-xTB Hamiltonian');
    expect(result.plain).toContain('ALPB');
    expect(result.plain).toContain('water');
    expect(result.plain).toContain('a geometry optimization');
    expect(result.plain).toContain('not applicable to xTB');
    expect(result.plain).toContain('mRRHO');
    expect(result.plain).toContain('1 atm -> 1 M');
    expect(result.plain).not.toContain('B3LYP');
    expect(result.plain).not.toContain('6-31G(d)');
    expect(result.plain).not.toContain('PCM');
    expect(result.plain).not.toContain('UltraFine');
  });

  it.each([
    [['water.xyz'], 'a single-point energy calculation'],
    [['water.xyz', '--opt', 'normal'], 'a geometry optimization'],
    [['water.xyz', '--ohess', 'tight'], 'a geometry optimization followed by a harmonic frequency calculation'],
    [['water.xyz', '--hess'], 'a harmonic frequency calculation'],
  ])('derives the xTB job type from argv %j', (argv, phrase) => {
    const record = xtbRecord();
    record.argv = argv;
    delete record.provenance.jobType;
    const result = methodsParagraphFor(record);
    expect(result.ok).toBe(true);
    expect(result.plain).toContain(phrase);
    expect(result.plain).toContain('derived from the argv recorded in run.json');
  });

  it('says the Hamiltonian is not recorded when neither the summary nor argv names it', () => {
    const record = xtbRecord();
    record.argv = ['water.xyz'];
    record.parsed = {
      program: { name: 'xtb', version: '6.8.0', revision: null },
      scf: {},
      thermochemistry: {},
    };
    const result = methodsParagraphFor(record);
    expect(result.plain).toContain(`an xTB Hamiltonian that is ${NOT_RECORDED}`);
    expect(result.plain).not.toContain('GFN2-xTB');
  });

  it('reports the dispersion recorded in an engine-owned xTB method block', () => {
    const record = xtbRecord();
    record.provenance.method = {
      hamiltonian: 'gfn2',
      optLevel: 'tight',
      dispersion: 'D4 (built in)',
      solvation: 'ALPB/water',
      argv: record.argv,
    };
    const result = methodsParagraphFor(record);
    expect(result.ok).toBe(true);
    expect(result.plain).toContain('D4 (built in)');
    expect(result.plain).not.toContain('not itemised in the record');
  });
});

describe('methods paragraph — fixture refusal', () => {
  it('refuses a fixture even when the method fields look real', () => {
    const record = gaussianRecord();
    record.dryRun = true;
    record.provenance = { ...record.provenance, kind: 'fixture' };

    const result = methodsParagraphFor(record);
    expect(result.ok).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.reason).toBe('fixture');
    expect(result.message).toContain('provenance.kind is "fixture"');
    expect(result.message).toContain('not a real calculation');
    expect(result.message).not.toContain('PBE0');
    expect(result.plain).toBe('');
    expect(result.markdown).toBe('');
    expect(isFixtureRun(record)).toBe(true);
  });

  it('treats a dryRun flag or a fixture output source as a fixture', () => {
    const dryRunOnly = gaussianRecord();
    dryRunOnly.dryRun = true;
    expect(methodsParagraphFor(dryRunOnly).refused).toBe(true);

    const sourceOnly = gaussianRecord();
    sourceOnly.outputSource = 'fixture';
    expect(methodsParagraphFor(sourceOnly).refused).toBe(true);

    expect(isFixtureRun(gaussianRecord())).toBe(false);
  });
});

describe('methods paragraph — forms', () => {
  it('exposes short and full as the only documented forms', () => {
    expect(METHODS_FORMS).toEqual(['short', 'full']);
    expect(methodsParagraphFor(gaussianRecord(), { form: 'unknown' }).form).toBe('full');
  });
});
