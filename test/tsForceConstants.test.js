import { describe, it, expect } from 'vitest';

/**
 * Schema v2 names the flow in an error path (`flows[0].nodes[1]…`); assert the
 * block-local suffix so the check does not hinge on the flow's position.
 */
const pathEndsWith = (actual, suffix) => typeof actual === 'string'
  && (actual === suffix || actual.endsWith(`.${suffix}`));
import { readFileSync } from 'node:fs';
import { routeFor } from '../src/shared/gaussianInput.js';
import {
  SCHEMA_VERSION,
  defaultGates,
  defaultSettings,
  kindForJob,
  parseProjectText,
  stringifyProject,
  validateProject,
} from '../src/shared/projectSchema.js';
import {
  DEFAULT_TS_FORCE_CONSTANTS,
  OPT_CONVERGENCE_IDS,
  TS_FORCE_CONSTANT_IDS,
  checkTsForceConstants,
  forceConstantsFor,
  freqGeometryWarnings,
  gridFor,
  isOptJob,
  jobKeywordFor,
  optConvergenceFor,
  optConvergenceWarnings,
  requiresUltraFineGrid,
} from '../src/shared/tsForceConstants.js';
import { isDftMethod } from '../src/shared/routePresets.js';

function baseProject(nodes, edges = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'TS force constants',
    molecule: {
      smiles: 'C=CC=C.C=C',
      charge: 0,
      multiplicity: 1,
      fragments: ['C=CC=C', 'C=C'],
      coords: [],
      geometry: { source: 'demo', file: '', format: '' },
    },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4 },
    nodes,
    edges,
  };
}

function calcNode(id, title, settings = {}, extra = {}) {
  return {
    id,
    type: 'calculate',
    kind: kindForJob(settings.jobType || 'Opt'),
    title,
    state: 'ready',
    x: 0,
    y: 0,
    settings: defaultSettings(settings),
    output: null,
    checkpointFrom: null,
    ...extra,
  };
}

const checkpointEdge = (from, to) => ({
  from, to, type: 'checkpoint', fromPort: 'bottom', toPort: 'top',
});

describe('issue #15 — the force-constant options', () => {
  it('defaults to CalcFC and never invents a fifth choice', () => {
    expect(DEFAULT_TS_FORCE_CONSTANTS).toBe('CalcFC');
    expect(TS_FORCE_CONSTANT_IDS).toEqual(['CalcFC', 'CalcAll', 'ReadFC', 'default']);
    expect(defaultSettings().forceConstants).toBe('CalcFC');
    expect(forceConstantsFor({ forceConstants: 'not-a-choice' })).toBe('CalcFC');
  });

  it('maps every choice to exactly one Opt group', () => {
    const expected = {
      CalcFC: 'Opt=(TS,CalcFC,NoEigenTest)',
      CalcAll: 'Opt=(TS,CalcAll)',
      ReadFC: 'Opt=(TS,ReadFC)',
      default: 'Opt=TS',
    };
    for (const choice of TS_FORCE_CONSTANT_IDS) {
      const keyword = jobKeywordFor({ jobType: 'Opt=TS', forceConstants: choice });
      expect(keyword).toBe(expected[choice]);
      expect(keyword.match(/Opt/g)).toHaveLength(1);
    }
  });

  it('does not apply force constants to a non-TS job', () => {
    expect(jobKeywordFor({ jobType: 'Freq', forceConstants: 'CalcFC' })).toBe('Freq');
    expect(jobKeywordFor({ jobType: 'SP', forceConstants: 'CalcAll' })).toBe('SP');
  });
});

describe('issue #15 — ReadFC needs a checkpoint that holds force constants', () => {
  const readFc = (overrides = {}) => defaultSettings({
    jobType: 'Opt=TS', forceConstants: 'ReadFC', ...overrides,
  });

  it('fails with a specific message when the TS block has no checkpoint edge', () => {
    const { errors, warnings } = checkTsForceConstants({ settings: readFc(), upstream: null });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ReadFC/);
    expect(errors[0]).toMatch(/no checkpoint hand-off/);
    expect(errors[0]).toMatch(/Freq or Opt=CalcFC/);
    expect(warnings).toEqual([]);
  });

  it('names the upstream job when it cannot have written force constants', () => {
    const upstream = {
      id: 'r-opt',
      title: 'Reactant optimization',
      settings: defaultSettings({ jobType: 'Opt' }),
    };
    const { errors } = checkTsForceConstants({ settings: readFc(), upstream });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"Reactant optimization"');
    expect(errors[0]).toContain('is Opt and does not write them');
  });

  it('accepts a Freq upstream and an Opt=CalcFC upstream', () => {
    const freq = { id: 'r-freq', title: 'Reactant frequency', settings: defaultSettings({ jobType: 'Freq' }) };
    const optCalcFc = {
      id: 'r-opt',
      title: 'Reactant optimization',
      settings: defaultSettings({ jobType: 'Opt=TS', forceConstants: 'CalcFC' }),
    };
    expect(checkTsForceConstants({ settings: readFc(), upstream: freq }).errors).toEqual([]);
    expect(checkTsForceConstants({ settings: readFc(), upstream: optCalcFc }).errors).toEqual([]);
  });

  it('rejects an upstream that only computes curvature with CalcAll', () => {
    const upstream = {
      id: 'r-opt',
      title: 'Reactant optimization',
      settings: defaultSettings({ jobType: 'Opt=TS', forceConstants: 'CalcAll' }),
    };
    const { errors } = checkTsForceConstants({ settings: readFc(), upstream });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Freq or Opt=CalcFC/);
  });

  it('warns — but never blocks — the estimated-Hessian default', () => {
    const settings = defaultSettings({ jobType: 'Opt=TS', forceConstants: 'default' });
    const { errors, warnings } = checkTsForceConstants({ settings, upstream: null });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/estimated initial Hessian/);
    expect(warnings[0]).toContain('CalcFC is the safe default');
  });

  it('says nothing for CalcFC and CalcAll', () => {
    for (const forceConstants of ['CalcFC', 'CalcAll']) {
      const settings = defaultSettings({ jobType: 'Opt=TS', forceConstants });
      expect(checkTsForceConstants({ settings, upstream: null })).toEqual({ errors: [], warnings: [] });
    }
  });

  it('does not apply TS rules to a non-TS job that stores a force-constant value', () => {
    const settings = defaultSettings({ jobType: 'Freq', forceConstants: 'default' });
    expect(checkTsForceConstants({ settings, upstream: null })).toEqual({ errors: [], warnings: [] });
  });
});

describe('issue #15 — project validation', () => {
  it('fails ReadFC without a checkpoint edge and points at the field', () => {
    const result = validateProject(baseProject([
      calcNode('r-opt', 'Reactant optimization', { jobType: 'Opt', checkpoint: 'r_opt.chk' }),
      calcNode('ts-opt', 'TS guess optimization', {
        jobType: 'Opt=TS', forceConstants: 'ReadFC', checkpoint: 'ts_opt.chk',
      }),
    ], [{ from: 'r-opt', to: 'ts-opt', type: 'dependency', fromPort: 'right', toPort: 'left' }]));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(pathEndsWith(result.errors[0].path, 'nodes[1].settings.forceConstants')).toBe(true);
    expect(result.errors[0].message).toMatch(/no checkpoint hand-off/);
  });

  it('fails ReadFC when the checkpoint edge comes from an Opt block', () => {
    const result = validateProject(baseProject([
      calcNode('r-opt', 'Reactant optimization', { jobType: 'Opt', checkpoint: 'r_opt.chk' }),
      calcNode('ts-opt', 'TS guess optimization', {
        jobType: 'Opt=TS', forceConstants: 'ReadFC', checkpoint: 'ts_opt.chk',
      }),
    ], [checkpointEdge('r-opt', 'ts-opt')]));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(pathEndsWith(result.errors[0].path, 'nodes[1].settings.forceConstants')).toBe(true);
    expect(result.errors[0].message).toContain('"Reactant optimization"');
    expect(result.errors[0].message).toMatch(/Freq or Opt=CalcFC/);
  });

  it('accepts ReadFC when a Freq block is the checkpoint source', () => {
    const result = validateProject(baseProject([
      calcNode('r-freq', 'Reactant frequency', { jobType: 'Freq', checkpoint: 'r_freq.chk' }),
      calcNode('ts-opt', 'TS guess optimization', {
        jobType: 'Opt=TS', forceConstants: 'ReadFC', checkpoint: 'ts_opt.chk',
      }, { checkpointFrom: 'r-freq' }),
    ], [checkpointEdge('r-freq', 'ts-opt')]));

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('warns about Default (unsafe) without failing the project', () => {
    const result = validateProject(baseProject([
      calcNode('ts-opt', 'TS guess optimization', {
        jobType: 'Opt=TS', forceConstants: 'default', checkpoint: 'ts_opt.chk',
      }),
    ]));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(pathEndsWith(result.warnings[0].path, 'nodes[0].settings.forceConstants')).toBe(true);
    expect(result.warnings[0].message).toMatch(/estimated initial Hessian/);
  });

  it('round-trips the choice byte-stably', () => {
    const result = validateProject(baseProject([
      calcNode('r-freq', 'Reactant frequency', { jobType: 'Freq', checkpoint: 'r_freq.chk' }),
      calcNode('ts-opt', 'TS guess optimization', {
        jobType: 'Opt=TS', forceConstants: 'ReadFC', checkpoint: 'ts_opt.chk',
      }, { checkpointFrom: 'r-freq' }),
    ], [checkpointEdge('r-freq', 'ts-opt')]));

    const saved = stringifyProject(result.project);
    expect(saved.ok).toBe(true);
    expect(saved.text).toContain('"forceConstants": "ReadFC"');
    expect(stringifyProject(parseProjectText(saved.text).project).text).toBe(saved.text);
  });

  it('migrates an older TS block that has no stored choice to CalcFC', () => {
    const legacy = {
      schemaVersion: 3,
      name: 'Old TS project',
      molecule: {
        smiles: 'C=CC=C.C=C',
        charge: 0,
        multiplicity: 1,
        fragments: ['C=CC=C', 'C=C'],
        coords: [],
        geometry: { source: 'demo', file: '', format: '' },
      },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: 4 },
      nodes: [{
        id: 'ts-opt',
        type: 'calculate',
        kind: 'TS',
        title: 'TS guess optimization',
        state: 'ready',
        x: 0,
        y: 0,
        settings: {
          jobType: 'Opt=TS',
          method: 'B3LYP',
          basis: '6-31G(d)',
          memory: '4',
          memoryUnit: 'GB',
          nproc: '4',
          checkpoint: 'ts_opt.chk',
          charge: 0,
          multiplicity: 1,
          dispersion: '',
          scf: '',
          grid: '',
          population: '',
          verbosity: '',
          solvation: false,
          solvationModel: 'PCM',
          solvent: 'Water',
          customKeywords: '',
          ircDirection: 'forward',
          gates: defaultGates(),
        },
        output: null,
        checkpointFrom: null,
      }],
      edges: [],
    };

    const result = validateProject(legacy);
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(false);
    const node = result.project.nodes[0];
    expect(node.settings.forceConstants).toBe('CalcFC');
    expect(routeFor(node.settings)).toBe('#p B3LYP/6-31G(d) Opt=(TS,CalcFC,NoEigenTest)');
  });

  it('warns when extra keywords add their own Opt keyword', () => {
    const result = validateProject(baseProject([
      calcNode('ts-opt', 'TS guess optimization', {
        jobType: 'Opt=TS', checkpoint: 'ts_opt.chk', customKeywords: 'Opt=(TS,CalcAll)',
      }),
    ]));

    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => pathEndsWith(warning.path, 'nodes[0].settings.customKeywords'))).toBe(true);
  });
});

describe('issue #15 — seeded Diels–Alder project', () => {
  const source = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

  it('seeds the TS block with the safe force-constant form', () => {
    const block = source.match(/calcNode\('ts-opt'[\s\S]*?\}\),/);
    expect(block).not.toBeNull();
    expect(block[0]).toContain("jobType: 'Opt=TS'");
    expect(block[0]).toContain("forceConstants: 'CalcFC'");
    expect(source).not.toMatch(/forceConstants:\s*'default'/);
  });

  it('emits the safe route for the seeded TS settings', () => {
    const seeded = defaultSettings({
      jobType: 'Opt=TS', forceConstants: 'CalcFC', checkpoint: 'ts_opt.chk',
    });
    expect(routeFor(seeded))
      .toBe('#p B3LYP/def2SVP Opt=(TS,CalcFC,NoEigenTest) EmpiricalDispersion=GD3BJ');
  });
});

describe('issue #15 — documentation', () => {
  // The transition-state rationale lives in the engines page, linked from the README.
  const readme = ['../README.md', '../docs/guide/engines.md']
    .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
    .join('\n');

  it('explains why CalcFC is the transition-state default', () => {
    expect(readme).toContain('Opt=(TS,CalcFC,NoEigenTest)');
    expect(readme).toContain('`CalcFC` (default)');
    expect(readme).toMatch(/default\s+approximate Hessian must always be improved/);
    expect(readme).toContain('`ReadFC` needs an explicit checkpoint edge');
  });
});

describe('issue #16 — optimization convergence options', () => {
  const opt = (overrides = {}) => defaultSettings({ jobType: 'Opt', ...overrides });

  it('offers Default, Tight and VeryTight only', () => {
    expect(OPT_CONVERGENCE_IDS).toEqual(['', 'Tight', 'VeryTight']);
    expect(defaultSettings().optConvergence).toBe('');
    expect(optConvergenceFor({ optConvergence: 'Loose' })).toBe('');
    expect(optConvergenceFor({})).toBe('');
  });

  it('recognises exactly the optimization job types', () => {
    for (const jobType of ['Opt', 'Opt Freq', 'Opt=TS']) expect(isOptJob(jobType)).toBe(true);
    for (const jobType of ['Freq', 'IRC', 'SP', 'Scan']) expect(isOptJob(jobType)).toBe(false);
  });

  it('composes every force-constant choice with both convergence levels into one Opt keyword', () => {
    const expected = {
      CalcFC: {
        Tight: 'Opt=(TS,CalcFC,NoEigenTest,Tight)',
        VeryTight: 'Opt=(TS,CalcFC,NoEigenTest,VeryTight)',
      },
      CalcAll: { Tight: 'Opt=(TS,CalcAll,Tight)', VeryTight: 'Opt=(TS,CalcAll,VeryTight)' },
      ReadFC: { Tight: 'Opt=(TS,ReadFC,Tight)', VeryTight: 'Opt=(TS,ReadFC,VeryTight)' },
      default: { Tight: 'Opt=(TS,Tight)', VeryTight: 'Opt=(TS,VeryTight)' },
    };
    for (const choice of TS_FORCE_CONSTANT_IDS) {
      for (const convergence of ['Tight', 'VeryTight']) {
        const keyword = jobKeywordFor({
          jobType: 'Opt=TS', forceConstants: choice, optConvergence: convergence,
        });
        expect(keyword).toBe(expected[choice][convergence]);
        expect(keyword.match(/Opt/g)).toHaveLength(1);
      }
    }
  });

  it('composes Opt and Opt Freq into one Opt keyword', () => {
    expect(jobKeywordFor({ jobType: 'Opt' })).toBe('Opt');
    expect(jobKeywordFor({ jobType: 'Opt', optConvergence: 'Tight' })).toBe('Opt=Tight');
    expect(jobKeywordFor({ jobType: 'Opt', optConvergence: 'VeryTight' })).toBe('Opt=VeryTight');
    expect(jobKeywordFor({ jobType: 'Opt Freq', optConvergence: 'Tight' })).toBe('Opt=Tight Freq');
    expect(jobKeywordFor({ jobType: 'Opt Freq', optConvergence: 'VeryTight' })).toBe('Opt=VeryTight Freq');
  });
});

describe('issue #16 — UltraFine grid for DFT at tight convergence', () => {
  const dftOpt = (overrides = {}) => defaultSettings({
    jobType: 'Opt', method: 'B3LYP', optConvergence: 'Tight', ...overrides,
  });

  it('classifies methods explicitly, not by name shape', () => {
    expect(isDftMethod('B3LYP')).toBe(true);
    expect(isDftMethod('M06-2X')).toBe(true);
    expect(isDftMethod('ωB97X-D')).toBe(true);
    expect(isDftMethod('MP2')).toBe(false);
    expect(isDftMethod('CCSD(T)')).toBe(false);
    expect(isDftMethod('HF')).toBe(false);
  });

  it('derives UltraFine only for a DFT optimization at tight convergence', () => {
    expect(requiresUltraFineGrid(dftOpt())).toBe(true);
    expect(requiresUltraFineGrid(dftOpt({ optConvergence: 'VeryTight' }))).toBe(true);
    expect(requiresUltraFineGrid(defaultSettings({ jobType: 'Opt', method: 'B3LYP' }))).toBe(false);
    expect(requiresUltraFineGrid(dftOpt({ method: 'MP2' }))).toBe(false);
    expect(requiresUltraFineGrid(dftOpt({ jobType: 'Freq' }))).toBe(false);
    expect(requiresUltraFineGrid(dftOpt({ jobType: 'SP' }))).toBe(false);
  });

  it('writes Integral=UltraFine into the route without a second keyword', () => {
    expect(gridFor(dftOpt())).toBe('UltraFine');
    expect(routeFor(dftOpt()))
      .toBe('#p B3LYP/def2SVP Opt=Tight EmpiricalDispersion=GD3BJ Integral=UltraFine');
    expect(routeFor(dftOpt()).match(/Integral=/g)).toHaveLength(1);
  });

  it('lets an explicit grid win over the default', () => {
    expect(gridFor(dftOpt({ grid: 'Fine' }))).toBe('Fine');
    expect(gridFor(dftOpt({ grid: 'UltraFine' }))).toBe('UltraFine');
    expect(gridFor(dftOpt({ grid: 'Fine' }))).toBe('Fine');
    expect(routeFor(dftOpt({ grid: 'UltraFine' })).match(/Integral=/g)).toHaveLength(1);
  });

  it('keeps the stored grid empty so the default stays derived, not written back', () => {
    const settings = dftOpt();
    expect(settings.grid).toBe('');
    expect(routeFor(settings)).toContain('Integral=UltraFine');
    expect(settings.grid).toBe('');
  });

  it('warns when the DFT grid is overridden, but never blocks', () => {
    const warnings = optConvergenceWarnings(dftOpt({ grid: 'Fine' }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Integral=Fine');
    expect(warnings[0]).toContain('Int=UltraFine');
    expect(warnings[0]).toContain('Tight convergence');
    expect(optConvergenceWarnings(dftOpt())).toEqual([]);
    expect(optConvergenceWarnings(dftOpt({ grid: 'UltraFine' }))).toEqual([]);
    expect(optConvergenceWarnings(defaultSettings({ jobType: 'Opt' }))).toEqual([]);
  });
});

describe('issue #16 — frequency after a default-convergence optimization', () => {
  const upstreamOpt = (settings = {}) => ({
    id: 'opt-1',
    title: 'Reactant optimization',
    settings: defaultSettings({ jobType: 'Opt', ...settings }),
  });

  it('warns and names the upstream block', () => {
    const warnings = freqGeometryWarnings({
      settings: defaultSettings({ jobType: 'Freq' }),
      upstream: upstreamOpt(),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Reactant optimization"');
    expect(warnings[0]).toMatch(/default convergence/);
    expect(warnings[0]).toContain('Opt=Tight');
  });

  it('is quiet once the optimization requests Tight or VeryTight', () => {
    for (const optConvergence of ['Tight', 'VeryTight']) {
      expect(freqGeometryWarnings({
        settings: defaultSettings({ jobType: 'Freq' }),
        upstream: upstreamOpt({ optConvergence }),
      })).toEqual([]);
    }
  });

  it('is quiet without a checkpoint hand-off, for a non-Freq consumer, or a non-Opt upstream', () => {
    expect(freqGeometryWarnings({
      settings: defaultSettings({ jobType: 'Freq' }), upstream: null,
    })).toEqual([]);
    expect(freqGeometryWarnings({
      settings: defaultSettings({ jobType: 'Opt' }), upstream: upstreamOpt(),
    })).toEqual([]);
    expect(freqGeometryWarnings({
      settings: defaultSettings({ jobType: 'Freq' }),
      upstream: { id: 'sp-1', title: 'Single point', settings: defaultSettings({ jobType: 'SP' }) },
    })).toEqual([]);
  });

  it('also warns for a TS optimization left at the default convergence', () => {
    const warnings = freqGeometryWarnings({
      settings: defaultSettings({ jobType: 'Freq' }),
      upstream: {
        id: 'ts-1',
        title: 'TS optimization',
        settings: defaultSettings({ jobType: 'Opt=TS', forceConstants: 'CalcFC' }),
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"TS optimization"');
  });
});

describe('issue #16 — project validation', () => {
  it('accepts and round-trips the convergence choice', () => {
    const result = validateProject(baseProject([
      calcNode('opt-1', 'Reactant optimization', {
        jobType: 'Opt', optConvergence: 'Tight', checkpoint: 'opt.chk',
      }),
    ]));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.project.nodes[0].settings.optConvergence).toBe('Tight');

    const saved = stringifyProject(result.project);
    expect(saved.ok).toBe(true);
    expect(saved.text).toContain('"optConvergence": "Tight"');
    expect(stringifyProject(parseProjectText(saved.text).project).text).toBe(saved.text);
  });

  it('rejects an unknown convergence value at its field path', () => {
    const result = validateProject(baseProject([
      calcNode('opt-1', 'Reactant optimization', { jobType: 'Opt', optConvergence: 'Loose' }),
    ]));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toContain('nodes[0].settings.optConvergence');
    expect(result.errors[0].message).toContain('Tight, VeryTight');
  });

  it('warns when a Freq node reads a default-convergence optimization', () => {
    const result = validateProject(baseProject([
      calcNode('opt-1', 'Reactant optimization', { jobType: 'Opt', checkpoint: 'opt.chk' }),
      calcNode('freq-1', 'Reactant frequency', { jobType: 'Freq', checkpoint: 'freq.chk' }, {
        checkpointFrom: 'opt-1',
      }),
    ], [checkpointEdge('opt-1', 'freq-1')]));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(pathEndsWith(result.warnings[0].path, 'nodes[1].settings.jobType')).toBe(true);
    expect(result.warnings[0].message).toContain('"Reactant optimization"');
    expect(result.warnings[0].message).toMatch(/default convergence/);
  });

  it('does not warn when the same hand-off comes from a Tight optimization', () => {
    const result = validateProject(baseProject([
      calcNode('opt-1', 'Reactant optimization', {
        jobType: 'Opt', optConvergence: 'Tight', checkpoint: 'opt.chk',
      }),
      calcNode('freq-1', 'Reactant frequency', { jobType: 'Freq', checkpoint: 'freq.chk' }, {
        checkpointFrom: 'opt-1',
      }),
    ], [checkpointEdge('opt-1', 'freq-1')]));

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns at the grid field when a DFT Tight optimization overrides UltraFine', () => {
    const result = validateProject(baseProject([
      calcNode('opt-1', 'Reactant optimization', {
        jobType: 'Opt', optConvergence: 'Tight', grid: 'Fine', checkpoint: 'opt.chk',
      }),
    ]));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(pathEndsWith(result.warnings[0].path, 'nodes[0].settings.grid')).toBe(true);
    expect(result.warnings[0].message).toContain('Integral=Fine');
  });

  it('does not warn about the grid when the default UltraFine is in force', () => {
    const result = validateProject(baseProject([
      calcNode('opt-1', 'Reactant optimization', {
        jobType: 'Opt', optConvergence: 'Tight', checkpoint: 'opt.chk',
      }),
    ]));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(routeFor(result.project.nodes[0].settings))
      .toBe('#p B3LYP/def2SVP Opt=Tight EmpiricalDispersion=GD3BJ Integral=UltraFine');
  });
});

describe('issue #16 — inspector wiring', () => {
  const source = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

  it('renders the shared convergence options for optimization jobs', () => {
    expect(source).toContain('OPT_CONVERGENCE_OPTIONS');
    expect(source).toMatch(/selectField\(\s*'Optimization convergence',\s*'optConvergence'/);
    expect(source).toMatch(/isOptJob\(s\.jobType\)/);
    expect(source).toMatch(/optConvergenceIssues\(node\)/);
  });

  it('previews the derived grid by delegating to the builder, not by re-reading settings.grid', () => {
    // The preview used to re-assemble the keyword list, which drifted from the
    // written route (#88 exposed it). It now calls the builder's own
    // `routeFor`, so the grid — explicit or derived — is the same code path.
    expect(source).toContain('routeFor(settings');
    expect(source).not.toMatch(/if \(settings\.grid\) tokens\.push\(`Integral=/);
    expect(source).not.toMatch(/if \(settings\.population\) tokens\.push\(`Pop=/);
  });

  it('seeds the TS block that feeds a frequency job with Tight convergence', () => {
    const block = source.match(/calcNode\('ts-opt'[\s\S]*?\}\),/);
    expect(block).not.toBeNull();
    expect(block[0]).toContain("jobType: 'Opt=TS'");
    expect(block[0]).toContain("optConvergence: 'Tight'");
  });
});
