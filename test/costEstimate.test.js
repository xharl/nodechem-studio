/**
 * Issue 143 — an estimate is a range with a measurement behind it.
 *
 * These tests do not assert that the model is right (three committed logs
 * cannot make it right). They assert the properties that make it honest:
 * a measured water job is inside its own range, growth with size and states is
 * monotonic, concurrency helps but sub-linearly, and anything the corpus cannot
 * price is refused with a reason rather than returned as zero.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MEASUREMENTS,
  OVERNIGHT_SECONDS,
  basisFunctionsFor,
  compareEstimate,
  dependencyLevels,
  estimateCost,
  timingFromRunRecord,
} from '../src/shared/costEstimate.js';
import {
  defaultSettings,
  parseProjectText,
  stringifyProject,
} from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

const water = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const chain = (atoms) => Array.from({ length: atoms }, (_, index) => ({
  element: index % 4 === 0 ? 'O' : (index % 4 === 1 ? 'C' : 'H'),
}));

function task(overrides = {}) {
  const { settings = {}, molecule = water, ...rest } = overrides;
  return {
    taskId: 'calculate',
    nodeId: 'calculate',
    type: 'calculate',
    title: 'Calc',
    engine: 'gaussian',
    validity: { molecule: { coords: molecule } },
    settings: {
      jobType: 'SP',
      method: 'B3LYP',
      basis: '6-31G(d)',
      nproc: 4,
      tdStates: 0,
      ...settings,
    },
    ...rest,
  };
}

const project = (runner = {}) => ({ runner, defaults: { nproc: 4 } });

describe('basis-size table', () => {
  it('reproduces the NBasis lines in the committed logs', () => {
    expect(basisFunctionsFor('6-31G(d)', water).count).toBe(19);
    expect(basisFunctionsFor('def2-SVP', water).count).toBe(24);
    // DVB is C10H10 in STO-3G: 10 x 5 + 10 x 1.
    const dvb = Array.from({ length: 20 }, (_, index) => ({ element: index < 10 ? 'C' : 'H' }));
    expect(basisFunctionsFor('STO-3G', dvb).count).toBe(60);
  });

  it('takes an exact caller-supplied count over the table', () => {
    const result = basisFunctionsFor('6-31G(d)', water, { exact: 21 });
    expect(result).toMatchObject({ count: 21, exact: true, source: 'caller-supplied count' });
  });

  it('refuses an element outside the row instead of interpolating', () => {
    const withIodine = [...water, { element: 'I' }];
    const result = basisFunctionsFor('6-31G(d)', withIodine);
    expect(result.count).toBeNull();
    expect(result.missing).toEqual(['I']);
  });

  it('refuses an ECP basis it has no comparable row for', () => {
    const result = basisFunctionsFor('SDD', water);
    expect(result.count).toBeNull();
    expect(result.source).toContain('SDD');
  });
});

describe('estimation from measured points', () => {
  it('has a measured baseline for every engine it prices', () => {
    const engines = new Set(MEASUREMENTS.map((point) => point.engine));
    expect([...engines].sort()).toEqual(['gaussian', 'orca', 'psi4', 'xtb']);
    for (const point of MEASUREMENTS) {
      expect(point.source).toMatch(/^test\/fixtures\/real\//);
      expect(point.coreSeconds).toBeGreaterThan(0);
      expect(point.basisFunctions ?? point.atoms).toBeGreaterThan(0);
    }
  });

  it('wraps the measured water single point in its own range', () => {
    const result = estimateCost(project(), { tasks: [task()] }, { cores: 4 });
    const only = result.tasks[0];
    const measuredCores = MEASUREMENTS.find((point) => point.id === 'g16-water-sp').coreSeconds;
    const measuredWall = MEASUREMENTS.find((point) => point.id === 'g16-water-sp').wallSeconds;
    expect(only.notEstimated).toBeUndefined();
    expect(only.coreSeconds.low).toBeLessThanOrEqual(measuredCores);
    expect(only.coreSeconds.high).toBeGreaterThanOrEqual(measuredCores);
    expect(only.wallSeconds.low).toBeLessThanOrEqual(measuredWall);
    expect(only.wallSeconds.high).toBeGreaterThanOrEqual(measuredWall);
    expect(only.wallSeconds.low).toBeLessThan(only.wallSeconds.high);
  });

  it('grows with the number of atoms and the number of states', () => {
    const small = estimateCost(project(), { tasks: [task({ settings: { basis: 'def2-SVP' } })] }, { cores: 8 });
    const large = estimateCost(project(), {
      tasks: [task({ molecule: chain(40), settings: { basis: 'def2-SVP' } })],
    }, { cores: 8 });
    expect(large.tasks[0].coreSeconds.likely).toBeGreaterThan(small.tasks[0].coreSeconds.likely);

    const few = estimateCost(project(), {
      tasks: [task({ settings: { jobType: 'SP', tdStates: 5, basis: 'def2-SVP' } })],
    }, { cores: 8 });
    const many = estimateCost(project(), {
      tasks: [task({ settings: { jobType: 'SP', tdStates: 15, basis: 'def2-SVP' } })],
    }, { cores: 8 });
    expect(many.tasks[0].coreSeconds.likely).toBeGreaterThan(few.tasks[0].coreSeconds.likely);
  });

  it('reports low confidence with the number of points that produced it', () => {
    const result = estimateCost(project(), { tasks: [task()] }, { cores: 4 });
    expect(result.tasks[0].confidence).toBe('low');
    expect(result.tasks[0].calibrationPoints).toBeGreaterThan(0);
    expect(result.tasks[0].confidence === 'low').toBe(result.tasks[0].calibrationPoints < 5);
  });

  it('never prices a task at a bare single number', () => {
    const result = estimateCost(project(), { tasks: [task()] }, { cores: 4 });
    expect(result.tasks[0].wallSeconds).toHaveProperty('low');
    expect(result.tasks[0].wallSeconds).toHaveProperty('likely');
    expect(result.tasks[0].wallSeconds).toHaveProperty('high');
    expect(result.total.wallSeconds.low).toBeLessThanOrEqual(result.total.wallSeconds.high);
  });
});

describe('concurrency', () => {
  const fanOut = () => {
    const coords = chain(40);
    return {
      tasks: Array.from({ length: 8 }, (_, index) => task({
        taskId: `td-${index}`,
        nodeId: `td-${index}`,
        title: `TD-DFT ${index + 1}`,
        engine: 'psi4',
        molecule: coords,
        settings: { jobType: 'TD-DFT', method: 'B3LYP', basis: 'def2-TZVP', tdStates: 10, nproc: 1 },
      })),
      edges: [],
    };
  };

  it('grows with concurrency 1 to 4, but not linearly', () => {
    const one = estimateCost(project({ maxParallel: 1 }), fanOut(), { cores: 8 });
    const four = estimateCost(project({ maxParallel: 4 }), fanOut(), { cores: 8 });
    expect(one.total.wallSeconds.likely).toBeGreaterThan(four.total.wallSeconds.likely);
    const ratio = one.total.wallSeconds.likely / four.total.wallSeconds.likely;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(4);
    // Core-seconds do not depend on concurrency; only the wall clock does.
    expect(one.total.coreSeconds.likely).toBe(four.total.coreSeconds.likely);
  });

  it('shows the basis that explains the wide range', () => {
    const result = estimateCost(project({ maxParallel: 1 }), fanOut(), { cores: 8 });
    expect(result.tasks[0].basis.join(' ')).toContain('no measurement for Psi4 TD-DFT');
    expect(result.tasks[0].basis.join(' ')).toContain('range from atom count only');
    expect(result.tasks[0].confidence).toBe('low');
  });

  it('sums dependent tasks instead of running them together', () => {
    const plan = {
      tasks: [
        task({ taskId: 'a', nodeId: 'a' }),
        task({ taskId: 'b', nodeId: 'b' }),
      ],
      edges: [{ from: 'a', to: 'b', type: 'dependency' }],
    };
    expect(dependencyLevels(plan.tasks, plan.edges)).toEqual([['a'], ['b']]);
    const serial = estimateCost(project({ maxParallel: 8 }), plan, { cores: 8 });
    const independent = estimateCost(project({ maxParallel: 8 }), { ...plan, edges: [] }, { cores: 8 });
    expect(serial.total.wallSeconds.likely).toBeGreaterThan(independent.total.wallSeconds.likely);
  });
});

describe('refusals and warnings', () => {
  it('refuses an unknown engine with a reason, not a number', () => {
    const result = estimateCost(project(), {
      tasks: [task({ engine: 'mopac', settings: { method: 'PM7', basis: '' } })],
    });
    expect(result.tasks[0].notEstimated).toContain('unknown engine');
    expect(result.tasks[0].notEstimated).toContain('mopac');
    expect(result.tasks[0].wallSeconds).toBeUndefined();
    expect(result.total.notEstimated).toContain('unknown engine');
    expect(result.total.wallSeconds).toBeUndefined();
  });

  it('refuses a job type it has no measurement for', () => {
    const result = estimateCost(project(), {
      tasks: [task({ settings: { jobType: 'IRC' } })],
    });
    expect(result.tasks[0].notEstimated).toContain('no measurement for Gaussian 16 IRC');
  });

  it('refuses a composite method, whose cost is a toolchain of links', () => {
    const result = estimateCost(project(), {
      tasks: [task({ settings: { jobType: 'G4', method: '', basis: '' } })],
    });
    expect(result.tasks[0].notEstimated).toContain('composite method');
  });

  it('flags a task the project limit will stop, and says which limit', () => {
    const result = estimateCost(project({ maxParallel: 1, timeoutSeconds: 60 }), {
      tasks: [task({ molecule: chain(40), settings: { basis: 'def2-TZVP' } })],
    }, { cores: 8 });
    const only = result.tasks[0];
    expect(only.timeout).toMatchObject({ limitSeconds: 60, exceeds: true });
    expect(result.total.exceedsAnyTimeout).toBe(true);
    expect(result.total.exceedingTasks[0].limitSeconds).toBe(60);
  });

  it('honours a block limit over the project limit', () => {
    const result = estimateCost(project({ timeoutSeconds: 60 }), {
      tasks: [task({ settings: { timeoutSeconds: 7200 } })],
    }, { cores: 4 });
    expect(result.tasks[0].timeout).toMatchObject({ limitSeconds: 7200, exceeds: false });
  });

  it('flags an estimate longer than an overnight run', () => {
    const result = estimateCost(project({ maxParallel: 1 }), {
      tasks: [task({
        molecule: chain(84),
        settings: { jobType: 'Opt Freq', method: 'ωB97X-D', basis: 'def2-TZVP', nproc: 8 },
      })],
    }, { cores: 8 });
    expect(result.tasks[0].wallSeconds.likely).toBeGreaterThan(OVERNIGHT_SECONDS);
    expect(result.tasks[0].exceedsOvernight).toBe(true);
    expect(result.total.exceedsOvernight).toBe(true);
    // The case that motivated issue 143: even the optimistic bound is over
    // half a day for an 84-atom Opt+Freq, not a reassurance.
    expect(result.tasks[0].wallSeconds.low).toBeGreaterThan(12 * 3600);
  });
});

describe('project file is untouched', () => {
  it('adds no settings key and serialises an existing project byte-identically', () => {
    const keys = Object.keys(defaultSettings());
    expect(keys.filter((key) => /cost|estimate|wall/i.test(key))).toEqual([]);
    const text = readFileSync(new URL('../examples/opt-freq.ncs', import.meta.url), 'utf8');
    const { project: parsed } = parseProjectText(text);
    const before = stringifyProject(parsed).text;
    estimateCost(parsed, buildWorkflowPlan(parsed), { cores: 8 });
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(parseProjectText(before).project));
    expect(stringifyProject(parsed).text).toBe(before);
  });
});

describe('calibration hook', () => {
  it('reads wall time from run.json without inventing core-seconds', () => {
    const observation = timingFromRunRecord({
      id: 'run-1',
      engine: 'gaussian',
      startedAt: '2026-11-08T10:00:00.000Z',
      finishedAt: '2026-11-08T10:00:07.500Z',
      provenance: { jobType: 'SP', method: { method: 'B3LYP', basis: '6-31G(d)' } },
      parsed: { resources: { nBasis: 19, processors: 4 } },
    });
    expect(observation).toMatchObject({
      runId: 'run-1',
      engine: 'gaussian',
      jobType: 'SP',
      method: 'B3LYP',
      basis: '6-31G(d)',
      basisFunctions: 19,
      cores: 4,
      wallSeconds: 7.5,
    });
    expect(observation.coreSeconds).toBeUndefined();
  });

  it('falls back to the timeout record when finishedAt is absent', () => {
    const observation = timingFromRunRecord({
      id: 'run-2',
      status: 'timed out',
      startedAt: '2026-11-08T10:00:00.000Z',
      timeout: { elapsedSeconds: 3600 },
    });
    expect(observation.wallSeconds).toBe(3600);
    expect(observation.timedOut).toBe(true);
  });

  it('compares an observation with a range and never calls a point estimate correct', () => {
    expect(compareEstimate({ wallSeconds: { low: 1, likely: 2, high: 3 } }, { wallSeconds: 2.5 }))
      .toMatchObject({ withinRange: true, ratio: 1.25 });
    expect(compareEstimate({ wallSeconds: { low: 1, high: 3 } }, { wallSeconds: 9 }))
      .toMatchObject({ withinRange: false });
    expect(compareEstimate({}, { wallSeconds: 9 })).toMatchObject({ withinRange: null, ratio: null });
  });
});
