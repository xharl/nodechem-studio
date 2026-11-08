import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { multiplicitiesFor, spinSweepFor, spinSweepVerdict } from '../src/shared/spinSweep.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { QueueManager } from '../electron/runner/queue.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8');
const H = (kcal) => kcal / 627.5094740631;

function exampleProject() {
  const project = JSON.parse(readFileSync(
    fileURLToPath(new URL('../examples/single-point.ncs', import.meta.url)), 'utf8',
  ));
  return project;
}

function sweptProject() {
  const project = exampleProject();
  const calc = project.nodes.find((node) => node.type === 'calc');
  calc.settings = { ...calc.settings, multiplicity: 3, spinSweep: { enabled: true, multiplicities: [1, 3, 5] } };
  return project;
}

describe('allowed multiplicities', () => {
  it('follows the parity of the electron count', () => {
    expect(multiplicitiesFor({ electrons: 10, maxMultiplicity: 5 })).toEqual([1, 3, 5]);
    expect(multiplicitiesFor({ electrons: 9, maxMultiplicity: 6 })).toEqual([2, 4, 6]);
    expect(multiplicitiesFor({ electrons: null })).toEqual([]);
  });
});

describe('spin-state sweep configuration', () => {
  it('is null unless enabled with two states', () => {
    expect(spinSweepFor({})).toBeNull();
    expect(spinSweepFor({ spinSweep: { enabled: false, multiplicities: [1, 3] } })).toBeNull();
    expect(spinSweepFor({ spinSweep: { enabled: true, multiplicities: [3] } })).toBeNull();
  });

  it('deduplicates and caps the list', () => {
    const sweep = spinSweepFor({ spinSweep: { enabled: true, multiplicities: [1, 1, 3, 5, 7, 9, 11, 2] } });
    expect(sweep.multiplicities).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it('rejects an invalid multiplicity in the schema', () => {
    const project = exampleProject();
    const calc = project.nodes.find((node) => node.type === 'calc');
    calc.settings = { ...calc.settings, spinSweep: { enabled: true, multiplicities: [1, 0] } };
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /multiplicity between 1 and 12/.test(error.message))).toBe(true);
  });
});

describe('plan expansion', () => {
  it('creates one task per multiplicity with that multiplicity in its settings', () => {
    const plan = buildWorkflowPlan(sweptProject());
    const states = plan.tasks.filter((task) => task.spin);
    expect(states.map((task) => task.nodeId)).toEqual(['sp-energy.m1', 'sp-energy.m3', 'sp-energy.m5']);
    expect(states.map((task) => task.settings.multiplicity)).toEqual([1, 3, 5]);
    expect(states.map((task) => task.title)).toEqual([
      'Single-point energy — multiplicity 1', 'Single-point energy — multiplicity 3', 'Single-point energy — multiplicity 5',
    ]);
    expect(states[0].spin).toMatchObject({ id: 'sp-energy', index: 0, multiplicity: 1, count: 3 });
    expect(plan.tasks.some((task) => task.nodeId === 'sp-energy')).toBe(false);
  });

  it('writes the multiplicity into the input it will run', () => {
    const plan = buildWorkflowPlan(sweptProject());
    const states = plan.tasks.filter((task) => task.spin);
    const multiplicities = states.map((task) => {
      const line = task.inputText.split('\n').find((text) => /^\s*-?\d+\s+\d+\s*$/.test(text));
      return line.trim().split(/\s+/)[1];
    });
    expect(multiplicities).toEqual(['1', '3', '5']);
  });

  it('refuses a block that is both a ladder and a sweep', () => {
    const project = sweptProject();
    const calc = project.nodes.find((node) => node.type === 'calc');
    calc.settings = {
      ...calc.settings,
      ladder: { enabled: true, toleranceKcal: 3, rungs: [{ method: 'B3LYP' }, { method: 'PBE0' }] },
    };
    expect(() => buildWorkflowPlan(project)).toThrow(/ladder and a spin-state sweep/);
  });
});

describe('the sweep table', () => {
  const entries = [
    { nodeId: 'a.m1', multiplicity: 1, energyHartree: -76 + H(12), spinSquared: 0 },
    { nodeId: 'a.m3', multiplicity: 3, energyHartree: -76, spinSquared: 2.0123 },
    { nodeId: 'a.m5', multiplicity: 5, energyHartree: -76 + H(35), spinSquared: 6.04 },
  ];

  it('identifies the ground state and relative energies', () => {
    const verdict = spinSweepVerdict(entries, { expected: 3 });
    expect(verdict.available).toBe(true);
    expect(verdict.groundMultiplicity).toBe(3);
    expect(verdict.degenerate).toBe(false);
    expect(verdict.rows.find((row) => row.multiplicity === 1).relativeKcalPerMol).toBeCloseTo(12, 6);
    expect(verdict.reason).toMatch(/Ground state: multiplicity 3/);
  });

  it('marks a degeneracy rather than picking one', () => {
    const verdict = spinSweepVerdict([
      { multiplicity: 1, energyHartree: -76 },
      { multiplicity: 3, energyHartree: -76 },
    ]);
    expect(verdict.degenerate).toBe(true);
    expect(verdict.groundMultiplicity).toBe(1);
  });

  it('keeps a state that failed in the table without inventing an energy', () => {
    const verdict = spinSweepVerdict([entries[1], { nodeId: 'a.m5', multiplicity: 5, energyHartree: null }], { expected: 3 });
    expect(verdict.rows.map((row) => row.energyHartree)).toEqual([-76, null]);
    expect(verdict.reason).toMatch(/2 of 3 states ran/);
  });

  it('says so when nothing ran', () => {
    expect(spinSweepVerdict([], {}).available).toBe(false);
  });
});

describe('⟨S²⟩ from a real unrestricted log', () => {
  it('reads the annihilated value and keeps the raw one', () => {
    const parsed = parseGaussianOutput(fixture('g09-dvb-un-sp.log'));
    expect(parsed.spinContamination).toEqual({ before: 0.7778, after: 0.7504 });
    expect(parsed.spinSquared).toMatchObject({ value: 0.7504, source: 'after-annihilation' });
  });

  it('reports null, not zero, for a restricted reference', () => {
    const parsed = parseGaussianOutput(fixture('g09-dvb-sp.out'));
    expect(parsed.spinSquared).toEqual({ value: null, source: null, s: null });
  });
});

describe('the queue and the report', () => {
  const manager = () => new QueueManager({
    queuesRoot: '/tmp/ncs-spin-test',
    runManager: { onEvent: () => () => {} },
    emit: () => {},
  });
  const task = (multiplicity, energyHartree, spinSquared, status = 'completed') => ({
    nodeId: `a.m${multiplicity}`,
    status,
    spin: { id: 'a', index: 0, multiplicity, count: 3 },
    parsedSummary: energyHartree === null ? null : { energyHartree, spinSquared, spinSquaredSource: 'after-annihilation' },
  });

  it('writes the sweep after every state finishes', async () => {
    const queue = { id: 'q', spins: {}, tasks: [task(1, -76 + H(12), 0), task(3, -76, 2.0123), task(5, -76 + H(35), 6.04)] };
    await manager().evaluateSpins(queue);
    expect(queue.spins.a.groundMultiplicity).toBe(3);
    expect(queue.spins.a.rows.map((row) => row.spinSquared)).toEqual([0, 2.0123, 6.04]);
  });

  it('waits while a state is still running', async () => {
    const queue = { id: 'q', spins: {}, tasks: [task(1, -76, 0), task(3, null, null, 'running'), task(5, -76 + H(35), 6.04)] };
    expect(await manager().evaluateSpins(queue)).toBe(false);
    expect(queue.spins.a).toBeUndefined();
  });

  it('renders the table with the ground state marked', () => {
    const model = buildWorkflowReport({
      id: 'q-spin',
      projectName: 'Spin',
      status: 'completed',
      tasks: [{ nodeId: 'a.m3', title: 'SP — m3', status: 'completed' }],
      spins: {
        a: {
          groundMultiplicity: 3,
          reason: 'Ground state: multiplicity 3.',
          rows: [
            { multiplicity: 1, energyHartree: -75.98, relativeKcalPerMol: 12, spinSquared: 0 },
            { multiplicity: 3, energyHartree: -76, relativeKcalPerMol: 0, spinSquared: 2.0123 },
          ],
        },
      },
    }, {});
    const html = workflowReportHtml(model);
    expect(html).toContain('Spin-state sweep — a');
    expect(html).toContain('ground');
    expect(html).toContain('2.0123');
    expect(html).toContain('12.00');
  });
});
