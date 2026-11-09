import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LADDER_TOLERANCE_KCAL,
  HARTREE_TO_KCAL_PER_MOL,
  ladderRungs,
  ladderSpread,
  ladderVerdict,
} from '../src/shared/methodLadder.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { validateProject } from '../src/shared/projectSchema.js';
import { QueueManager } from '../electron/runner/queue.js';

const H = (kcal) => kcal / HARTREE_TO_KCAL_PER_MOL; // kcal offset expressed in hartree

/** A complete, schema-valid project, so the schema cases are not testing my fixture. */
function exampleProject() {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL('../examples/single-point.ncs', import.meta.url)),
    'utf8',
  ));
}

function withLadder(settings) {
  const project = exampleProject();
  const calc = project.flows[0].nodes.find((node) => node.type === 'calculate');
  calc.settings = { ...calc.settings, ...settings };
  return project;
}

function project(overrides = {}) {
  const calc = {
    id: 'sp',
    type: 'calculate',
    kind: 'SP',
    title: 'Single point',
    settings: { jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' },
    ...overrides,
  };
  return {
    schemaVersion: 3,
    name: 'Ladder',
    defaults: { engine: 'gaussian' },
    molecule: { charge: 0, multiplicity: 1, coords: [] },
    nodes: [calc, { id: 'sp2', type: 'calculate', kind: 'SP', title: 'Downstream', settings: { jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP' } }],
    edges: [{ from: 'sp', to: 'sp2', type: 'dependency' }],
  };
}

const ladderSettings = (rungs = ['B3LYP', 'PBE0', 'M06-2X'], toleranceKcal = 3) => ({
  jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ',
  ladder: {
    enabled: true,
    toleranceKcal,
    rungs: rungs.map((method, index) => ({ label: `Rung ${index + 1}`, method, basis: 'def2-SVP' })),
  },
});

describe('ladder configuration', () => {
  it('is null unless enabled', () => {
    expect(ladderRungs({})).toBeNull();
    expect(ladderRungs({ ladder: { enabled: false, rungs: [{ method: 'B3LYP' }, { method: 'PBE0' }] } })).toBeNull();
  });

  it('normalises rungs and falls back to the default tolerance', () => {
    const ladder = ladderRungs(ladderSettings());
    expect(ladder.toleranceKcal).toBe(3);
    expect(ladder.rungs.map((rung) => rung.method)).toEqual(['B3LYP', 'PBE0', 'M06-2X']);
    expect(ladder.rungs[0].label).toBe('Rung 1');
  });

  it('ignores a ladder with fewer than two methods', () => {
    expect(ladderRungs({ ladder: { enabled: true, rungs: [{ method: 'B3LYP' }] } })).toBeNull();
  });

  it('keeps the default tolerance constant explicit', () => {
    expect(DEFAULT_LADDER_TOLERANCE_KCAL).toBe(3);
  });
});

describe('spread and verdict', () => {
  const entries = (values) => values.map((kcal, index) => ({
    id: `sp.r${index + 1}`,
    label: `Rung ${index + 1}`,
    energyHartree: kcal === null ? null : H(-1000 + kcal),
  }));

  it('computes relative energies against the lowest rung', () => {
    const spread = ladderSpread(entries([0, 2.5, -1]));
    expect(spread.spreadKcal).toBeCloseTo(3.5, 9);
    expect(spread.entries.map((entry) => Math.round(entry.relativeKcalPerMol * 1000) / 1000)).toEqual([1, 3.5, 0]);
  });

  it('passes within tolerance and fails above it', () => {
    expect(ladderVerdict(entries([0, 1, 2]), { toleranceKcal: 3 }).status).toBe('pass');
    expect(ladderVerdict(entries([0, 1, 2]), { toleranceKcal: 1.5 }).status).toBe('fail');
    const failed = ladderVerdict(entries([0, 4]), { toleranceKcal: 3 });
    expect(failed.status).toBe('fail');
    expect(failed.reason).toMatch(/4\.00 kcal\/mol is above the 3 kcal\/mol tolerance/);
  });

  it('is unknown, never pass, when a rung is missing or has no energy', () => {
    const short = ladderVerdict(entries([0, 1]), { expected: 3, toleranceKcal: 3 });
    expect(short.status).toBe('unknown');
    expect(short.reason).toMatch(/2 of 3 rungs ran/);

    const noEnergy = ladderVerdict(entries([0, null, 2]), { expected: 3, toleranceKcal: 3 });
    expect(noEnergy.status).toBe('unknown');
    expect(noEnergy.reason).toMatch(/No final energy for Rung 2/);
  });

  it('is unknown with fewer than two usable rungs', () => {
    expect(ladderVerdict(entries([0]), { toleranceKcal: 3 }).status).toBe('unknown');
    expect(ladderVerdict([], { toleranceKcal: 3 }).status).toBe('unknown');
  });
});

describe('plan expansion', () => {
  it('turns one ladder block into one task per rung', () => {
    const plan = buildWorkflowPlan(project({ settings: ladderSettings() }));
    const rungs = plan.tasks.filter((task) => task.ladder);
    expect(rungs.map((task) => task.nodeId)).toEqual(['sp.r1', 'sp.r2', 'sp.r3']);
    expect(rungs.map((task) => task.settings.method)).toEqual(['B3LYP', 'PBE0', 'M06-2X']);
    expect(rungs[1].title).toBe('Single point — Rung 2');
    expect(rungs.every((task) => task.executable)).toBe(true);
    expect(rungs[0].ladder).toMatchObject({ id: 'sp', index: 0, count: 3, toleranceKcal: 3 });
    // The expansion must not leave the unexpanded node behind as a second task.
    expect(plan.tasks.some((task) => task.nodeId === 'sp')).toBe(false);
  });

  it('writes a distinct input file and route per rung', () => {
    const plan = buildWorkflowPlan(project({ settings: ladderSettings() }));
    const rungs = plan.tasks.filter((task) => task.ladder);
    expect(new Set(rungs.map((task) => task.inputName)).size).toBe(3);
    const routes = rungs.map((task) => task.inputText.split('\n').find((line) => line.startsWith('#')).split(' ')[1]);
    expect(routes).toEqual(['B3LYP/def2SVP', 'PBE0/def2SVP', 'M06-2X/def2SVP']);
  });

  it('expands dependencies to every rung and keeps checkpoints on the primary', () => {
    const source = project({ settings: ladderSettings() });
    source.edges = [
      { from: 'sp', to: 'sp2', type: 'dependency' },
      { from: 'sp', to: 'sp2', type: 'checkpoint' },
    ];
    const plan = buildWorkflowPlan(source);
    const dependency = plan.edges.filter((edge) => edge.type === 'dependency').map((edge) => edge.from).sort();
    expect(dependency).toEqual(['sp.r1', 'sp.r2', 'sp.r3']);
    const checkpoints = plan.edges.filter((edge) => edge.type === 'checkpoint');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].from).toBe('sp.r1');
    const downstream = plan.tasks.find((task) => task.nodeId === 'sp2');
    expect(downstream.checkpointFrom).toMatchObject({ nodeId: 'sp.r1', ladderPrimary: true });
  });

  it('leaves a block without a ladder untouched', () => {
    const plan = buildWorkflowPlan(project());
    expect(plan.tasks.map((task) => task.nodeId)).toEqual(['sp', 'sp2']);
    expect(plan.edges).toEqual([{ from: 'sp', to: 'sp2', type: 'dependency' }]);
  });
});

describe('schema', () => {
  it('accepts a well-formed ladder', () => {
    const result = validateProject(withLadder(ladderSettings()));
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.ladder.rungs).toHaveLength(3);
  });

  it('rejects a one-rung ladder and a rung without a method', () => {
    const oneRung = validateProject(withLadder(ladderSettings(['B3LYP'])));
    expect(oneRung.ok).toBe(false);
    expect(oneRung.errors.some((error) => /between 2 and 4 rungs/.test(error.message))).toBe(true);

    const noMethod = validateProject(withLadder({
      ...ladderSettings(),
      ladder: { enabled: true, rungs: [{ method: 'B3LYP' }, { method: '' }] },
    }));
    expect(noMethod.ok).toBe(false);
    expect(noMethod.errors.some((error) => /is required for an enabled rung/.test(error.message))).toBe(true);
  });
});

describe('the queue gate', () => {
  const ladderTask = (index, energyHartree, count = 3) => ({
    nodeId: `sp.r${index + 1}`,
    status: 'completed',
    ladder: { id: 'sp', index, label: `Rung ${index + 1}`, count, toleranceKcal: 2 },
    parsedSummary: energyHartree === null ? null : { energyHartree },
  });
  const manager = () => new QueueManager({
    queuesRoot: '/tmp/ncs-ladder-test',
    runManager: { onEvent: () => () => {} },
    emit: () => {},
  });

  it('fails the group, and the runs in it, when the spread is over tolerance', async () => {
    const queue = { id: 'q1', ladders: {}, tasks: [ladderTask(0, -76), ladderTask(1, -76.02), ladderTask(2, -76.01)] };
    await manager().evaluateLadders(queue);
    expect(queue.ladders.sp.status).toBe('fail');
    expect(queue.ladders.sp.spreadKcal).toBeCloseTo(12.55, 1);
    expect(queue.tasks.map((task) => task.status)).toEqual(['needs-review', 'needs-review', 'needs-review']);
    expect(queue.tasks[0].reason).toMatch(/spread 12\.55 kcal\/mol exceeds/);
  });

  it('passes within tolerance', async () => {
    const queue = { id: 'q2', ladders: {}, tasks: [ladderTask(0, -76), ladderTask(1, -76.001), ladderTask(2, -76.002)] };
    await manager().evaluateLadders(queue);
    expect(queue.ladders.sp.status).toBe('pass');
    expect(queue.tasks.every((task) => task.status === 'completed')).toBe(true);
  });

  it('stays unknown when a rung ran without a parsed energy', async () => {
    const queue = { id: 'q3', ladders: {}, tasks: [ladderTask(0, -76), ladderTask(1, null), ladderTask(2, -76.001)] };
    await manager().evaluateLadders(queue);
    expect(queue.ladders.sp.status).toBe('unknown');
    expect(queue.ladders.sp.reason).toMatch(/No final energy/);
  });

  it('does not judge a group while a rung is still running', async () => {
    const queue = { id: 'q4', ladders: {}, tasks: [ladderTask(0, -76), { ...ladderTask(1, -76.001), status: 'running' }, ladderTask(2, -76)] };
    const changed = await manager().evaluateLadders(queue);
    expect(changed).toBe(false);
    expect(queue.ladders.sp).toBeUndefined();
  });
});
