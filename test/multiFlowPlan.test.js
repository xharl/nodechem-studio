import { describe, it, expect } from 'vitest';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

/**
 * RFC 0001: an input block turns a flow into a map over a dataset. These tests
 * pin the expansion rules — task ids, record pairing, barrier edges and the
 * record's own chemistry — because a wrong pairing here is a silent chemistry
 * error, not a crash.
 */

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const calc = (id, title, jobType, extra = {}) => ({
  id,
  type: 'calculate',
  kind: 'Opt',
  title,
  state: 'ready',
  x: 0,
  y: 0,
  settings: defaultSettings({ jobType, ...extra }),
  output: null,
  checkpointFrom: null,
});

const dataset = (overrides = {}) => ({
  id: 'family',
  title: 'Family',
  source: { kind: 'inline', path: '', format: 'sdf' },
  fields: { label: '', charge: '', multiplicity: '' },
  records: [
    { id: 'm1', label: 'one', charge: 0, multiplicity: 1, coords: water, enabled: true },
    { id: 'm2', label: 'two', charge: -1, multiplicity: 2, coords: water, enabled: true },
    { id: 'm3', label: 'three', charge: 0, multiplicity: 1, coords: water, enabled: false },
  ],
  notes: '',
  ...overrides,
});

function project({ nodes, edges, datasets = [dataset()], runner = { maxParallel: 1 } }) {
  const result = validateProject({
    schemaVersion: 3,
    name: 'RFC 0001 fixture',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner,
    datasets,
    flows: [{ id: 'barrier', title: 'Barrier', nodes, edges }],
    reports: [],
    activeFlowId: 'barrier',
  });
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

const input = (id = 'in1') => ({
  id, type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0,
  input: { datasetId: 'family', recordFilter: { field: '', equals: '' } },
});

describe('RFC 0001 — a dataset expands into one task per enabled record', () => {
  it('suffixes the task id with the record id and skips disabled records', () => {
    const p = project({
      nodes: [input(), calc('opt', 'Optimise', 'Opt'), calc('freq', 'Frequencies', 'Freq')],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'dependency' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    const ids = plan.tasks.filter((task) => task.executable).map((task) => task.nodeId);
    // Blocks are planned one after another across the family, so a run can
    // fan the same stage over every record before moving on.
    expect(ids).toEqual(['opt~m1', 'opt~m2', 'freq~m1', 'freq~m2']);
    expect(plan.tasks.some((task) => task.nodeId.includes('m3'))).toBe(false);
  });

  it('pairs a dependency record to record, never across records', () => {
    const p = project({
      nodes: [input(), calc('opt', 'Optimise', 'Opt'), calc('freq', 'Frequencies', 'Freq')],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'dependency' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    const pairs = plan.edges
      .filter((edge) => edge.from.startsWith('opt~') && edge.to.startsWith('freq~'))
      .map((edge) => `${edge.from}->${edge.to}`);
    expect(pairs).toEqual(['opt~m1->freq~m1', 'opt~m2->freq~m2']);
  });

  it("runs each record on its own geometry, charge and multiplicity", () => {
    const p = project({
      nodes: [input(), calc('sp', 'Single point', 'SP')],
      edges: [{ from: 'in1', to: 'sp', type: 'dependency' }],
    });
    const plan = buildWorkflowPlan(p);
    const m2 = plan.tasks.find((task) => task.nodeId === 'sp~m2');
    expect(m2.record).toEqual({ id: 'm2', label: 'two', charge: -1, multiplicity: 2 });
    // The Gaussian molecule block is the bare "charge multiplicity" line.
    expect(m2.inputText).toMatch(/^-1 2$/m);
    const m1 = plan.tasks.find((task) => task.nodeId === 'sp~m1');
    expect(m1.inputText).toMatch(/^0 1$/m);
    // ... and the geometry is the record's, not the project's.
    expect(m2.inputText).toContain('O      0.000000');
  });

  it('keeps bare ids when the flow has no input block (v1 shape)', () => {
    const p = project({
      nodes: [calc('opt', 'Optimise', 'Opt')],
      edges: [],
      datasets: [],
    });
    const plan = buildWorkflowPlan(p);
    expect(plan.tasks.map((task) => task.nodeId)).toEqual(['opt']);
    expect(plan.tasks[0].record).toBeUndefined();
  });

  it('plans an output block once and lets it collect every record', () => {
    const p = project({
      nodes: [
        input(),
        calc('opt', 'Optimise', 'Opt'),
        { id: 'out1', type: 'output', kind: 'Output', title: 'Report', state: 'ready', x: 0, y: 0,
          output: { kind: 'html', path: 'reports/report.html', include: 'records', bundle: 'project.zip', manifest: true, notes: '' } },
      ],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'out1', type: 'dependency' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    const outputs = plan.tasks.filter((task) => task.type === 'output');
    expect(outputs).toHaveLength(1);
    const intoOutput = plan.edges.filter((edge) => edge.to === 'out1').map((edge) => edge.from).sort();
    expect(intoOutput).toEqual(['opt~m1', 'opt~m2']);
  });
});

describe('RFC 0001 — the barrier edge is the stage fence', () => {
  it('waits for every record of the source block', () => {
    const p = project({
      nodes: [input(), calc('opt', 'Optimise', 'Opt'), calc('freq', 'Freq', 'Freq'), calc('sp', 'High level', 'SP')],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'opt', to: 'freq', type: 'dependency' },
        { from: 'freq', to: 'sp', type: 'barrier' },
      ],
    });
    const plan = buildWorkflowPlan(p);
    const fence = plan.edges.filter((edge) => edge.type === 'barrier').map((edge) => `${edge.from}->${edge.to}`).sort();
    expect(fence).toEqual([
      'freq~m1->sp~m1', 'freq~m1->sp~m2',
      'freq~m2->sp~m1', 'freq~m2->sp~m2',
    ]);
  });

  it('a single-record barrier is a plain ordering edge', () => {
    const p = project({
      nodes: [calc('opt', 'Optimise', 'Opt'), calc('sp', 'High level', 'SP')],
      edges: [{ from: 'opt', to: 'sp', type: 'barrier' }],
      datasets: [],
    });
    const plan = buildWorkflowPlan(p);
    expect(plan.edges).toEqual([{ from: 'opt', to: 'sp', type: 'barrier' }]);
  });
});

describe('RFC 0001 — refusals', () => {
  it('refuses a block fed by two datasets instead of pairing records', () => {
    const second = dataset({ id: 'other', title: 'Other', records: [
      { id: 'x1', label: 'x', charge: 0, multiplicity: 1, coords: water, enabled: true },
    ] });
    const p = project({
      datasets: [dataset(), second],
      nodes: [
        input(),
        { ...input('in2'), input: { datasetId: 'other', recordFilter: { field: '', equals: '' } } },
        calc('opt', 'Optimise', 'Opt'),
      ],
      edges: [
        { from: 'in1', to: 'opt', type: 'dependency' },
        { from: 'in2', to: 'opt', type: 'dependency' },
      ],
    });
    expect(() => buildWorkflowPlan(p)).toThrow(/fed by two datasets/);
  });

  it('iterates only the records an input filter names', () => {
    // `recordFilter` is the JSON-level way to run one member of a family without
    // editing the dataset; an empty filter (the default) must still mean "all".
    const filtered = project({
      nodes: [
        { ...input(), input: { datasetId: 'family', recordFilter: { field: 'label', equals: 'two' } } },
        calc('opt', 'Optimise', 'Opt'),
      ],
      edges: [{ from: 'in1', to: 'opt', type: 'dependency' }],
    });
    expect(buildWorkflowPlan(filtered).tasks.filter((task) => task.type === 'calculate').map((task) => task.nodeId))
      .toEqual(['opt~m2']);

    const byCharge = project({
      nodes: [
        { ...input(), input: { datasetId: 'family', recordFilter: { field: 'charge', equals: '-1' } } },
        calc('opt', 'Optimise', 'Opt'),
      ],
      edges: [{ from: 'in1', to: 'opt', type: 'dependency' }],
    });
    expect(buildWorkflowPlan(byCharge).tasks.filter((task) => task.type === 'calculate').map((task) => task.nodeId))
      .toEqual(['opt~m2']);

    const all = project({
      nodes: [input(), calc('opt', 'Optimise', 'Opt')],
      edges: [{ from: 'in1', to: 'opt', type: 'dependency' }],
    });
    expect(buildWorkflowPlan(all).tasks.filter((task) => task.type === 'calculate').map((task) => task.nodeId))
      .toEqual(['opt~m1', 'opt~m2']);
  });

  it('refuses a filter on a field a record does not have', () => {
    const bad = project({
      nodes: [
        { ...input(), input: { datasetId: 'family', recordFilter: { field: 'smiles', equals: 'CCO' } } },
        calc('opt', 'Optimise', 'Opt'),
      ],
      edges: [{ from: 'in1', to: 'opt', type: 'dependency' }],
    });
    expect(() => buildWorkflowPlan(bad)).toThrow(/cannot use "smiles"/);
  });

  it('refuses a plan above the task ceiling and names the product', () => {
    const records = Array.from({ length: 60 }, (_, index) => ({
      id: `r${index}`, label: `r${index}`, charge: 0, multiplicity: 1, coords: water, enabled: true,
    }));
    const nodes = [input(), ...Array.from({ length: 90 }, (_, index) => calc(`c${index}`, `Block ${index}`, 'SP'))];
    const edges = nodes.slice(1).map((node) => ({ from: 'in1', to: node.id, type: 'dependency' }));
    const p = project({ nodes, edges, datasets: [dataset({ records })] });
    expect(() => buildWorkflowPlan(p)).toThrow(/expands to 5401 tasks.*60 records/s);
  });
});
