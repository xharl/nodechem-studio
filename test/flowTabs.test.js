import { describe, it, expect } from 'vitest';
import {
  duplicateFlowGraph,
  flowIdFromTitle,
  flowTabModels,
  nextFlowTitle,
  slugifyGraphId,
  uniqueGraphId,
} from '../src/renderer/flowTabs.js';

const node = (id, overrides = {}) => ({
  id,
  type: 'calculate',
  kind: 'Opt',
  title: id,
  state: 'passed',
  x: 0,
  y: 0,
  settings: { jobType: 'Opt' },
  output: { file: `${id}.log` },
  parsed: { energyEh: -76 },
  ...overrides,
});

function project() {
  const main = { id: 'main', title: 'Workflow', nodes: [node('opt')], edges: [] };
  const family = {
    id: 'family',
    title: 'Family screen',
    nodes: [
      { id: 'in1', type: 'input', kind: 'Input', title: 'Enols', state: 'ready', x: 0, y: 0, input: { datasetId: 'enols' } },
      node('opt2'),
    ],
    edges: [{ from: 'in1', to: 'opt2', type: 'dependency' }],
  };
  return {
    flows: [main, family],
    activeFlowId: 'family',
    datasets: [{
      id: 'enols',
      records: [
        { id: 'm1', enabled: true },
        { id: 'm2', enabled: true },
        { id: 'm3', enabled: false },
      ],
    }],
  };
}

describe('flowTabModels', () => {
  it('lists every flow in file order and marks the active one', () => {
    const tabs = flowTabModels(project());
    expect(tabs.map((tab) => tab.id)).toEqual(['main', 'family']);
    expect(tabs.find((tab) => tab.id === 'family').active).toBe(true);
    expect(tabs.find((tab) => tab.id === 'main').active).toBe(false);
  });

  it('counts blocks and enabled records per flow', () => {
    const [main, family] = flowTabModels(project());
    expect(main).toMatchObject({ nodeCount: 1, edgeCount: 0, recordCount: 0 });
    expect(family).toMatchObject({ nodeCount: 2, edgeCount: 1, recordCount: 2 });
  });

  it('falls back to the first flow when activeFlowId does not resolve', () => {
    const value = project();
    value.activeFlowId = 'missing';
    expect(flowTabModels(value)[0].active).toBe(true);
  });
});

describe('flow ids and titles', () => {
  it('slugs a title into the flow-id grammar', () => {
    expect(slugifyGraphId('Proton transfer barrier')).toBe('proton-transfer-barrier');
    expect(slugifyGraphId('  ')).toBe('flow');
    expect(slugifyGraphId('2 steps')).toBe('2-steps');
  });

  it('makes a new id unique without changing the first one', () => {
    expect(uniqueGraphId('barrier', ['barrier', 'barrier-2'])).toBe('barrier-3');
    expect(flowIdFromTitle('Barrier', ['barrier'])).toBe('barrier-2');
  });

  it('offers the next unused Flow N title', () => {
    expect(nextFlowTitle([{ title: 'Workflow' }])).toBe('Flow 2');
    expect(nextFlowTitle([{ title: 'Flow 2' }, { title: 'Flow 3' }])).toBe('Flow 4');
  });
});

describe('duplicateFlowGraph', () => {
  it('deep-copies the graph and clears run state and outputs', () => {
    const source = project().flows[1];
    const copy = duplicateFlowGraph(source, { id: 'family-2', title: 'Family copy' });

    expect(copy.id).toBe('family-2');
    expect(copy.title).toBe('Family copy');
    expect(copy.nodes.map((item) => item.id)).toEqual(['in1', 'opt2']);
    expect(copy.edges).toEqual(source.edges);
    expect(copy.edges[0]).not.toBe(source.edges[0]);
    expect(copy.nodes[1].output).toBeUndefined();
    expect(copy.nodes[1].parsed).toBeUndefined();
    expect(copy.nodes[1].state).toBe('ready');
    // The source keeps its results: duplication is design-once, not a re-run.
    expect(source.nodes[1].output).toEqual({ file: 'opt2.log' });
    expect(source.nodes[1].state).toBe('passed');
  });

  it('does not share a settings object between the copy and the original', () => {
    const source = project().flows[0];
    const copy = duplicateFlowGraph(source, { id: 'copy', title: 'Copy' });
    copy.nodes[0].settings.jobType = 'Freq';
    expect(source.nodes[0].settings.jobType).toBe('Opt');
  });

  it('keeps an output block configuration while dropping a recorded artifact', () => {
    const flow = {
      id: 'main',
      title: 'Workflow',
      nodes: [{
        id: 'out',
        type: 'output',
        state: 'passed',
        output: {
          kind: 'csv',
          path: 'reports/family.csv',
          include: 'record',
          bundle: 'project.zip',
          manifest: true,
          notes: 'per record',
          artifact: { path: 'reports/family.csv', sha256: 'abc' },
        },
      }],
      edges: [],
    };
    const copy = duplicateFlowGraph(flow, { id: 'copy', title: 'Copy' });
    expect(copy.nodes[0].state).toBe('ready');
    expect(copy.nodes[0].output).toMatchObject({
      kind: 'csv',
      path: 'reports/family.csv',
      include: 'record',
      manifest: true,
      notes: 'per record',
    });
    expect(copy.nodes[0].output.artifact).toBeUndefined();
    expect(flow.nodes[0].output.artifact).toEqual({ path: 'reports/family.csv', sha256: 'abc' });
  });
});
