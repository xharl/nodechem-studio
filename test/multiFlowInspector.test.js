import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * jsdom-free rendering checks for the RFC 0001 inspectors. The HTML string is
 * the contract the browser consumes; asserting it here catches a missing
 * field, a wrong option list or a dataset that never reaches the table. The
 * full visual smoke (canvas, tabs, file picker) is not covered by this file.
 */

describe('dataset and output inspectors', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const inputNode = () => ({
    id: 'in1',
    type: 'input',
    kind: 'Input',
    title: 'Enols',
    state: 'ready',
    x: 0,
    y: 0,
    input: { datasetId: 'enols', recordFilter: { field: '', equals: '' } },
  });

  it('shows the dataset select, the record table and the enabled toggle', () => {
    app.state.project.datasets = [
      {
        id: 'enols',
        title: 'Enol family',
        source: { kind: 'file', path: 'enols.sdf', format: 'sdf' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [
          { id: 'mol1', label: 'Acetylacetone', charge: 0, multiplicity: 1, coords: [{ element: 'H', x: 0, y: 0, z: 0 }], enabled: true },
          { id: 'mol2', label: 'Acetone', charge: -1, multiplicity: 2, coords: [{ element: 'H', x: 0, y: 0, z: 0 }], enabled: false },
        ],
      },
    ];
    const html = app.inputInspector(inputNode());

    expect(html).toContain('data-input-field="datasetId"');
    expect(html).toContain('value="enols" selected');
    expect(html).toContain('data-dataset-record="mol1"');
    expect(html).toMatch(/data-dataset-record="mol1" checked/);
    expect(html).toContain('data-dataset-record="mol2"');
    expect(html).toMatch(/data-dataset-record="mol2"[^>]*aria-label/);
    expect(html).not.toMatch(/data-dataset-record="mol2" checked/);
    expect(html).toContain('1 of 2 enabled');
    expect(html).toContain('data-action="import-dataset"');
    expect(html).toContain('id="dataset-file"');
    expect(html).toContain('id="dataset-paste"');
  });

  it('says plainly when no dataset is bound', () => {
    app.state.project.datasets = [];
    const html = app.inputInspector({ ...inputNode(), input: { datasetId: '', recordFilter: { field: '', equals: '' } } });
    expect(html).toContain('No dataset bound');
    expect(html).toContain('data-action="import-dataset"');
  });

  it('offers html, csv, json and zip for an output block — never pdf', () => {
    const html = app.simpleInspector({
      id: 'out1',
      type: 'output',
      kind: 'Output',
      title: 'Family table',
      state: 'ready',
      x: 0,
      y: 0,
      output: {
        kind: 'csv',
        path: 'reports/family.csv',
        include: 'record',
        bundle: 'project.zip',
        manifest: true,
        notes: '',
      },
    });
    expect(html).toContain('data-output-field="kind"');
    expect(html).toContain('value="csv" selected');
    expect(html).toContain('value="html"');
    expect(html).toContain('value="json"');
    expect(html).toContain('value="zip"');
    expect(html).not.toContain('value="pdf"');
    expect(html).toContain('data-output-field="path"');
    expect(html).toContain('value="reports/family.csv"');
    expect(html).toContain('data-output-field="include"');
    expect(html).toContain('value="record" selected');
    expect(html).toContain('data-output-field="manifest"');
  });

  it('marks an invalid output path in the inspector instead of saving it silently', () => {
    const html = app.simpleInspector({
      id: 'out1',
      type: 'output',
      kind: 'Output',
      title: 'Broken output',
      state: 'ready',
      x: 0,
      y: 0,
      output: { kind: 'html', path: '../escape.html', include: 'records', bundle: 'project.zip', manifest: true, notes: '' },
    });
    expect(html).toContain('is-invalid');
    expect(html).toContain('field-hint is-error');
    expect(html).toContain('aria-invalid="true"');
  });

  it('describes an input block by its dataset and enabled count', () => {
    app.state.project.datasets = [{
      id: 'enols',
      title: 'Enol family',
      source: { kind: 'file', path: 'enols.sdf', format: 'sdf' },
      records: [
        { id: 'mol1', enabled: true },
        { id: 'mol2', enabled: false },
      ],
    }];
    expect(app.nodeDetail(inputNode())).toBe('Enol family · 1 of 2 enabled');
  });

  it('renders one tab per flow and marks the active one', () => {
    app.state.project.flows = [
      { id: 'main', title: 'Workflow', nodes: [], edges: [] },
      { id: 'barrier', title: 'Barrier screen', nodes: [], edges: [] },
    ];
    app.state.project.activeFlowId = 'barrier';
    app.state.project.datasets = [];
    const element = { innerHTML: '' };
    const previous = globalThis.document.querySelector;
    globalThis.document.querySelector = (selector) => (selector === '#flow-tabs' ? element : null);
    try {
      app.renderFlowTabs();
    } finally {
      globalThis.document.querySelector = previous;
    }
    expect(element.innerHTML).toContain('data-flow-id="main"');
    expect(element.innerHTML).toContain('data-flow-id="barrier"');
    expect(element.innerHTML).toMatch(/class="flow-tab is-active[^>]*data-flow-id="barrier"/);
    expect(element.innerHTML).toContain('data-action="add-flow"');
    expect(element.innerHTML).toContain('data-action="duplicate-flow"');
  });

  it('renders the per-record table and a partial banner in the run console', () => {
    const element = { innerHTML: '', hidden: true };
    const previous = globalThis.document.querySelector;
    globalThis.document.querySelector = (selector) => (selector === '#run-records' ? element : null);
    app.state.queue = {
      tasks: [
        { nodeId: 'opt~m1', recordId: 'm1', record: { id: 'm1', label: 'Water' }, status: 'completed', gateVerdict: 'pass' },
        { nodeId: 'opt~m2', recordId: 'm2', record: { id: 'm2', label: 'Ammonia' }, status: 'failed', error: 'SCF did not converge' },
      ],
    };
    try {
      app.renderRecordSummary();
    } finally {
      globalThis.document.querySelector = previous;
    }
    expect(element.hidden).toBe(false);
    expect(element.innerHTML).toContain('2 records · 1 done / 1 failed');
    expect(element.innerHTML).toContain('Partial run.');
    expect(element.innerHTML).toContain('Ammonia');
    expect(element.innerHTML).toContain('SCF did not converge');
    expect(element.innerHTML).toContain('<th>Gates</th>');
    expect(element.innerHTML).toContain('pass');
  });

  it('hides the record panel for a single-molecule queue', () => {
    const element = { innerHTML: 'stale', hidden: false };
    const previous = globalThis.document.querySelector;
    globalThis.document.querySelector = (selector) => (selector === '#run-records' ? element : null);
    app.state.queue = { tasks: [{ nodeId: 'opt', status: 'completed', gateVerdict: 'pass' }] };
    try {
      app.renderRecordSummary();
    } finally {
      globalThis.document.querySelector = previous;
    }
    expect(element.hidden).toBe(true);
    expect(element.innerHTML).toBe('');
  });
});
