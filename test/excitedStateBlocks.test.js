/**
 * Excited-state blocks (#146): the Root field's route, the vertical-emission
 * block, and the two-job NTO chain.
 *
 * The route strings here are asserted exactly. The NTO *table* is deliberately
 * not parsed anywhere — no real NTO log exists — so these tests cover the chain
 * and its refusals, not an assumed print layout.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGaussianInput,
  densityKeywordFor,
  routeFor,
  tdKeywordFor,
} from '../src/shared/gaussianInput.js';
import {
  defaultSettings,
  kindForJob,
  validateProject,
} from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const molecule = { charge: 0, multiplicity: 1, coords: WATER };

function settings(overrides = {}) {
  return { ...defaultSettings({ dispersion: '', method: 'B3LYP', basis: '6-31G(d)', ...overrides }) };
}

function calc(id, overrides = {}) {
  return {
    id,
    type: 'calc',
    kind: kindForJob(overrides.jobType || 'Opt'),
    title: id,
    state: 'ready',
    x: 0,
    y: 0,
    settings: settings(overrides),
    output: null,
    checkpointFrom: null,
  };
}

function rawProject(nodes, edges = []) {
  return {
    schemaVersion: 2,
    name: 'Excited-state blocks',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: ['H2O'],
      coords: WATER,
      geometry: { source: 'demo', file: '', format: '' },
    },
    defaults: {
      engine: 'gaussian', method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4',
    },
    activeFlowId: 'main',
    flows: [{ id: 'main', title: 'Main', nodes, edges }],
  };
}

const messages = (result) => result.errors.map((error) => error.message).join('\n');
const blockingMessages = (result) => result.validity.blocking.map((finding) => finding.message).join('\n');

describe('root selection in the route', () => {
  it('emits the typed root and never clamps it to NStates', () => {
    expect(tdKeywordFor({ tdStates: 2, tdRoot: 5 })).toBe('TD=(NStates=2,Root=5)');
    // The builder refuses Root > States rather than rewriting it.
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'Opt', tdStates: 2, tdRoot: 5 }),
      molecule,
      inputName: 'es.gjf',
    })).toThrow(/tdRoot is 5 but tdStates is 2/);
  });

  it('refuses an Opt with excited states and no root', () => {
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'Opt', tdStates: 3, tdRoot: 0 }),
      molecule,
      inputName: 'es.gjf',
    })).toThrow(/tdStates is 3 but tdRoot is not set[\s\S]*ground state/);
  });

  it('refuses a root with no states at all', () => {
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'SP', tdStates: 0, tdRoot: 2 }),
      molecule,
      inputName: 'es.gjf',
    })).toThrow(/tdRoot is 2 but tdStates is 0/);
  });
});

describe('vertical-emission block', () => {
  it('runs SP with TD=(NStates=n,Root=1)', () => {
    const routed = routeFor(settings({ jobType: 'SP', tdStates: 3, tdRoot: 1, emission: true }));
    expect(routed).toBe('#p B3LYP/6-31G(d) SP TD=(NStates=3,Root=1)');
  });

  it('pins Root=1 even when the stored root is 0', () => {
    expect(tdKeywordFor({ tdStates: 2, tdRoot: 0, emission: true })).toBe('TD=(NStates=2,Root=1)');
  });

  it('refuses another root instead of silently reporting Root=1', () => {
    expect(() => tdKeywordFor({ tdStates: 2, tdRoot: 2, emission: true })).toThrow(/tdRoot=2/);
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'SP', tdStates: 2, tdRoot: 2, emission: true }),
      molecule,
      inputName: 'em.gjf',
    })).toThrow(/tdRoot=2/);
  });

  it('refuses a non-SP job and a block with no states', () => {
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'Opt', tdStates: 1, tdRoot: 1, emission: true }),
      molecule,
      inputName: 'em.gjf',
    })).toThrow(/single point/);
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'SP', tdStates: 0, emission: true }),
      molecule,
      inputName: 'em.gjf',
    })).toThrow(/needs TD excited states/);
  });

  it('labels the task as vertical emission from the optimised excited state', () => {
    const project = validateProject(rawProject([
      calc('s1-opt', { jobType: 'Opt', method: 'B3LYP', basis: '6-31G(d)', tdStates: 1, tdRoot: 1 }),
      calc('emit', { jobType: 'SP', method: 'B3LYP', basis: '6-31G(d)', tdStates: 1, tdRoot: 1, emission: true }),
    ], [{ from: 's1-opt', to: 'emit', type: 'dependency' }])).project;
    const plan = buildWorkflowPlan(project);
    const emission = plan.tasks.find((task) => task.nodeId === 'emit');
    expect(emission.emission).toMatchObject({
      block: 'emission',
      sourceNodeId: 's1-opt',
      root: 1,
      quantity: 'vertical emission from the optimised excited state',
      geometryHandoff: 'block-input',
      sourceIsExcitedStateOptimization: true,
    });
    expect(emission.inputText).toContain('SP TD=(NStates=1,Root=1)');
  });

  it('records when no excited-state optimisation is connected', () => {
    const project = validateProject(rawProject([
      calc('emit', { jobType: 'SP', method: 'B3LYP', basis: '6-31G(d)', tdStates: 1, tdRoot: 1, emission: true }),
    ])).project;
    const task = buildWorkflowPlan(project).tasks.find((entry) => entry.nodeId === 'emit');
    expect(task.emission.sourceNodeId).toBeNull();
    expect(task.emission.sourceIsExcitedStateOptimization).toBe(false);
  });
});

describe('NTO two-job chain', () => {
  it('writes Density=(Check,Transition=k) on the TD job', () => {
    expect(routeFor(settings({ jobType: 'SP', tdStates: 3, ntoTransition: 1 })))
      .toBe('#p B3LYP/6-31G(d) SP TD=(NStates=3) Density=(Check,Transition=1)');
  });

  it('refuses a transition above the state count rather than clamping', () => {
    expect(() => densityKeywordFor({ tdStates: 2, ntoTransition: 3 }))
      .toThrow(/above tdStates=2/);
    expect(() => densityKeywordFor({ tdStates: 0, ntoTransition: 1 }))
      .toThrow(/needs TD excited states/);
  });

  it('writes Guess=Only Pop=NTO on the second job', () => {
    expect(routeFor(settings({ jobType: 'SP', nto: true })))
      .toBe('#p B3LYP/6-31G(d) Guess=Only Pop=NTO');
  });

  it('refuses Pop=NTO without a checkpoint edge, naming the edge', () => {
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'SP', nto: true }),
      molecule,
      inputName: 'nto.gjf',
    })).toThrow(/checkpoint edge/);
  });

  it('reads the checkpoint and carries no coordinates', () => {
    const text = buildGaussianInput({
      settings: settings({ jobType: 'SP', nto: true }),
      molecule,
      inputName: 'nto.gjf',
      oldCheckpoint: 'td_job.chk',
    });
    expect(text).toContain('%OldChk=td_job.chk');
    expect(text).toContain('#p B3LYP/6-31G(d) Guess=Only Pop=NTO Geom=Check');
    // Geometry comes from the checkpoint: no atom rows are written.
    expect(text).not.toMatch(/^\s*O\s+-?\d+\.\d+/m);
  });

  it('refuses TD on the NTO job itself', () => {
    expect(() => buildGaussianInput({
      settings: settings({ jobType: 'SP', nto: true, tdStates: 2, tdRoot: 1 }),
      molecule,
      inputName: 'nto.gjf',
      oldCheckpoint: 'td_job.chk',
    })).toThrow(/does not run TD itself/);
  });

  it('plans the two jobs and refuses a source without a TD record', () => {
    const chain = rawProject([
      calc('td', { jobType: 'SP', tdStates: 3, ntoTransition: 1 }),
      calc('nto', { jobType: 'SP', nto: true }),
    ], [{ from: 'td', to: 'nto', type: 'checkpoint' }]);
    const result = validateProject(chain);
    expect(result.validity.blocking).toEqual([]);
    const plan = buildWorkflowPlan(result.project);
    const nto = plan.tasks.find((task) => task.nodeId === 'nto');
    // Gaussian tasks carry the route inside the written input, not `route`.
    expect(nto.inputText).toContain('#p B3LYP/6-31G(d) Guess=Only Pop=NTO');
    expect(nto.nto).toMatchObject({ sourceNodeId: 'td', transition: 1, states: 3 });

    const noTd = validateProject(rawProject([
      calc('sp', { jobType: 'SP' }),
      calc('nto', { jobType: 'SP', nto: true }),
    ], [{ from: 'sp', to: 'nto', type: 'checkpoint' }]));
    expect(blockingMessages(noTd)).toMatch(/no TD record/);
  });

  it('refuses Pop=NTO with no checkpoint edge at validation time', () => {
    const result = validateProject(rawProject([
      calc('td', { jobType: 'SP', tdStates: 3, ntoTransition: 1 }),
      calc('nto', { jobType: 'SP', nto: true }),
    ], [{ from: 'td', to: 'nto', type: 'dependency' }]));
    expect(blockingMessages(result)).toMatch(/checkpoint edge/);
  });
});

describe('validity errors for the root', () => {
  it('blocks an Opt with states and no root, naming both fields', () => {
    const result = validateProject(rawProject([
      calc('es-opt', { jobType: 'Opt', tdStates: 3, tdRoot: 0 }),
    ]));
    const text = blockingMessages(result);
    expect(text).toMatch(/tdStates is 3 but tdRoot is not set/);
    expect(text).toMatch(/ground state/);
    // A blocking validity finding, not a schema error: an existing project
    // still opens so the field can be fixed instead of the file being rejected.
    expect(result.ok).toBe(true);
    expect(result.project).toBeTruthy();
  });

  it('blocks a root above the state count', () => {
    const result = validateProject(rawProject([
      calc('es-opt', { jobType: 'Opt', tdStates: 2, tdRoot: 3 }),
    ]));
    expect(blockingMessages(result)).toMatch(/tdRoot is 3 but tdStates is 2/);
  });

  it('refuses to plan the bad block while the project stays open', () => {
    const result = validateProject(rawProject([
      calc('es-opt', { jobType: 'Opt', tdStates: 3, tdRoot: 0 }),
    ]));
    expect(result.ok).toBe(true);
    expect(() => buildWorkflowPlan(result.project)).toThrow(/tdRoot/);
  });

  it('accepts a configured S1 optimisation', () => {
    const result = validateProject(rawProject([
      calc('es-opt', { jobType: 'Opt', tdStates: 3, tdRoot: 1 }),
    ]));
    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(result.validity.blocking).toEqual([]);
    expect(result.project.flows[0].nodes[0].settings).toMatchObject({ tdRoot: 1, emission: false, nto: false });
  });
});
