/**
 * Issue #371 — the three `runs:list` consumers behave identically on the
 * summary projection:
 *  - `attachQueueParsed` asks `runs:records` for exactly the queue's run ids;
 *  - `refreshHistory`/`historyRowHtml` render from summaries;
 *  - the export menu counts summaries and performs no record reads.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const desktop = {
  listRuns: vi.fn(),
  getRunRecords: vi.fn(),
};

function fakeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    hidden: false,
    textContent: '',
    dataset: {},
    attributes: new Map(),
    classList: {
      values: new Set(),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      contains(name) { return this.values.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !this.values.has(name) : Boolean(force);
        if (on) this.values.add(name); else this.values.delete(name);
        return on;
      },
    },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    toggleAttribute(name, on) { if (on) this.attributes.set(name, ''); else this.attributes.delete(name); },
    focus() {},
    scrollIntoView() {},
  };
}

const SUMMARY = {
  id: 'run-a',
  title: 'Frequency',
  engine: 'gaussian',
  jobType: 'Freq',
  status: 'completed',
  verdict: 'pass',
  startedAt: '2026-11-11T10:00:00.000Z',
  finishedAt: '2026-11-11T10:00:05.000Z',
  elapsedSeconds: 5.5,
  hasParsed: true,
  bytes: 4096,
  dryRun: false,
  kind: null,
  program: null,
  version: null,
};

describe('runs:list consumers (#371)', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => fakeElement(tag),
      createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterEach(() => {
    desktop.listRuns.mockReset();
    desktop.getRunRecords.mockReset();
    app.state.project = { nodes: [], edges: [] };
    app.state.selected = { type: 'project', id: null };
    app.state.run.id = null;
    app.state.run.status = 'idle';
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('asks runs:records for only the current queue run ids', async () => {
    app.state.project = {
      nodes: [
        { id: 'n1', type: 'calculate' },
        { id: 'n2', type: 'calculate' },
      ],
      edges: [],
    };
    // No parsed payload: the function returns without painting, which keeps
    // this test on the request shape rather than the canvas.
    desktop.getRunRecords.mockResolvedValue([]);

    await app.attachQueueParsed({
      tasks: [
        { runId: 'run-a', nodeId: 'n1' },
        { runId: 'run-a', nodeId: 'n1' },
        { runId: 'run-b', nodeId: 'n2' },
        { runId: null, nodeId: 'n3' },
      ],
    });

    expect(desktop.getRunRecords).toHaveBeenCalledTimes(1);
    expect(desktop.getRunRecords).toHaveBeenCalledWith(['run-a', 'run-b']);
    expect(desktop.listRuns).not.toHaveBeenCalled();
  });

  it('opens the export menu from summaries without reading records', async () => {
    desktop.listRuns.mockResolvedValue([SUMMARY, { ...SUMMARY, id: 'run-b' }]);

    const groups = await app.exportMenuGroups();

    expect(groups.flat().some((entry) => entry.label.includes('2 runs'))).toBe(true);
    expect(desktop.listRuns).toHaveBeenCalledTimes(1);
    expect(desktop.getRunRecords).not.toHaveBeenCalled();
  });

  it('renders the history row from the summary projection', () => {
    const rows = app.historyRows([SUMMARY], [], { limit: 6 });
    const html = app.historyRowHtml(rows[0]);

    expect(html).toContain('Frequency');
    expect(html).toContain('completed');
    expect(html).toContain('gates pass');
    expect(html).toContain('Gaussian 16');
    expect(html).not.toContain('undefined');
  });

  it('still renders an imported badge from the summary fields', () => {
    const imported = {
      id: 'imported-1',
      title: 'Foreign energy',
      kind: 'imported',
      program: 'Spartan',
      version: '26',
      status: null,
      engine: null,
      startedAt: null,
    };
    const html = app.historyRowHtml(app.historyRows([imported], [], { limit: 6 })[0]);

    expect(html).toContain('imported, not run here — Spartan 26');
  });
});
