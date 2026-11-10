import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';

/**
 * Issue 255 — the run console must only speak for the project on screen.
 *
 * The reported build painted a completed 16-task queue (engine Psi4) over a
 * freshly opened project whose own queue was failed 5/5. These tests pin the
 * two rules that make the header independent: a queue belongs to a project by
 * name (and flow, when the project has several), and a restored finished queue
 * fills the Queue tab without painting the header.
 */

const project = (name, engine = 'psi4', flows = [{ id: 'main', title: 'Main', nodes: [], edges: [] }]) => ({
  name,
  activeFlowId: flows[0]?.id || 'main',
  flows,
  defaults: { engine },
});

const queue = (id, projectName, status, count, taskStatus, flowId = 'main') => ({
  id,
  projectName,
  flowId,
  status,
  createdAt: '2026-11-09T21:04:00',
  tasks: Array.from({ length: count }, (_, index) => ({
    nodeId: `task-${index}`,
    title: `Block ${index + 1}`,
    status: taskStatus,
    runId: `${id}-run-${index}`,
    startedAt: '2026-11-09T21:04:00',
  })),
});

const PROJECT_A = project('water-cbs');
const PROJECT_B = project('buckyball', 'gaussian');
const QUEUE_A = queue('queue-a', 'water-cbs', 'completed', 16, 'completed');
const QUEUE_B = queue('queue-b', 'buckyball', 'failed', 5, 'failed');

function fakeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    hidden: false,
    innerHTML: '',
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

describe('the run header belongs to the open project (issue 255)', () => {
  let app;
  const elements = {
    '#run-state': fakeElement('span'),
    '#run-title': fakeElement('strong'),
    '#run-progress': fakeElement('span'),
    '#run-last': fakeElement('span'),
    '#queue-state': fakeElement('span'),
    '#queue-list': fakeElement('ul'),
  };

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
      querySelector: (selector) => elements[selector] || null,
      querySelectorAll: () => [],
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a queue whose project name is not the open project', () => {
    expect(app.queueBelongsToProject(QUEUE_A, PROJECT_B)).toBe(false);
    expect(app.queueBelongsToProject(QUEUE_B, PROJECT_A)).toBe(false);
    expect(app.queueBelongsToProject(QUEUE_A, PROJECT_A)).toBe(true);
  });

  it('keeps two projects\u2019 header models independent', () => {
    expect(app.runHeaderFor(QUEUE_A, PROJECT_A)).toMatchObject({
      paint: true,
      status: 'completed',
      progress: '16/16',
    });
    expect(app.runHeaderFor(QUEUE_B, PROJECT_B)).toMatchObject({
      paint: true,
      status: 'failed',
      progress: '5/5',
    });
    // The defect: opening B still showed A's completed 16/16.
    expect(app.runHeaderFor(QUEUE_A, PROJECT_B)).toEqual({
      paint: false,
      status: 'idle',
      label: 'idle',
      progress: '0/0',
    });
  });

  it('ignores a queue event from a project that is not on screen', () => {
    app.state.project = PROJECT_B;
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };
    app.state.lastForeignQueue = null;
    app.resetRunHeader();

    app.applyQueue(QUEUE_A);

    // A's completed 16/16 must not reach B's header or queue list.
    expect(elements['#run-state'].textContent).toBe('idle');
    expect(elements['#run-progress'].textContent).toBe('0/0');
    expect(elements['#queue-list'].innerHTML).not.toContain('Block 1');
    expect(elements['#run-last'].textContent).toBe('last run: water-cbs (other project)');
    expect(elements['#run-last'].hidden).toBe(false);

    // B's own queue is the one that may paint B's header.
    app.applyQueue(QUEUE_B);
    expect(elements['#run-state'].textContent).toBe('failed');
    expect(elements['#run-progress'].textContent).toBe('5/5');
    expect(elements['#queue-list'].innerHTML).toContain('Block 1');
    expect(elements['#run-last'].hidden).toBe(true);
  });

  it('resets the header state to idle 0/0 and no run', () => {
    app.state.run.status = 'completed';
    app.state.run.id = 'old-run';
    app.resetRunHeader();
    expect(app.state.run.status).toBe('idle');
    expect(app.state.run.id).toBeNull();
  });

  it('distinguishes flows only when the project has more than one', () => {
    const twoFlows = project('multi', 'psi4', [
      { id: 'main', title: 'Main', nodes: [], edges: [] },
      { id: 'side', title: 'Side', nodes: [], edges: [] },
    ]);
    const sideQueue = { ...QUEUE_A, projectName: 'multi', flowId: 'side' };
    expect(app.queueBelongsToProject(sideQueue, twoFlows)).toBe(false);
    const mainQueue = { ...QUEUE_A, projectName: 'multi', flowId: 'main' };
    expect(app.queueBelongsToProject(mainQueue, twoFlows)).toBe(true);
  });

  it('names the project and start time in each history row', () => {
    const runs = [
      {
        id: 'queue-a-run-0',
        title: 'Psi4 HF/6-31G* SP',
        status: 'completed',
        engine: 'psi4',
        startedAt: '2026-11-09T21:04:00',
        gates: { overall: 'pass' },
        dryRun: true,
      },
      {
        id: 'single-run',
        title: 'Loose single point',
        status: 'completed',
        engine: 'gaussian',
        startedAt: '2026-11-09T20:00:00',
        gates: { overall: 'pass' },
        dryRun: true,
      },
    ];
    const rows = app.historyRows(runs, [QUEUE_A]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: 'queue-a-run-0',
      queueId: 'queue-a',
      projectName: 'water-cbs',
      date: '09 Nov 21:04',
    });
    // A run with no queue keeps its own time and does not invent a project.
    expect(rows[1].projectName).toBe('');
    expect(rows[1].date).toBe('09 Nov 20:00');

    const html = app.historyRowHtml(rows[0]);
    expect(html).toContain('water-cbs');
    expect(html).toContain('09 Nov 21:04');
    expect(html).toContain('data-queue-id="queue-a"');
    expect(html).toContain('data-run-id="queue-a-run-0"');
    expect(html).toContain('data-action="open-history-queue"');
    expect(html).toContain('tabindex="0"');
  });
});
