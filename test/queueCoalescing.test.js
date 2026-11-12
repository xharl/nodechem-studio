import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';

/**
 * Issue 374 — the renderer wiring.
 *
 * `app.js` can be imported under vitest with a small DOM stub, so this goes one
 * step beyond the module tests: a burst of queue events must paint the queue
 * list once, the start and finish events must not wait for a frame, and an
 * output burst must reach the log in one append instead of one 60 kB rewrite
 * per chunk.
 */

const source = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

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

/** A `<pre>` of text nodes; counts textContent writes so a rewrite is visible. */
function fakeLog() {
  return {
    tagName: 'PRE',
    scrollTop: 0,
    scrollHeight: 0,
    writes: 0,
    appends: 0,
    nodes: [],
    get childNodes() { return this.nodes; },
    get firstChild() { return this.nodes[0] || null; },
    get textContent() { return this.nodes.map((node) => node.data).join(''); },
    set textContent(value) {
      this.writes += 1;
      this.nodes = String(value ?? '') ? [{ nodeType: 3, data: String(value ?? '') }] : [];
    },
    appendChild(node) {
      this.appends += 1;
      this.nodes.push(node);
      return node;
    },
    removeChild(node) {
      const index = this.nodes.indexOf(node);
      if (index >= 0) this.nodes.splice(index, 1);
      return node;
    },
  };
}

function queueList() {
  const el = fakeElement('ul');
  el.renders = 0;
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (value) => { el.renders += 1; html = String(value); },
  });
  return el;
}

const PROJECT = {
  name: 'perf-screen',
  activeFlowId: 'main',
  flows: [{ id: 'main', title: 'Main', nodes: [], edges: [] }],
  defaults: { engine: 'xtb' },
};

const queue = (status, taskStatus, extra = {}) => ({
  id: 'queue-perf',
  projectName: 'perf-screen',
  flowId: 'main',
  status,
  tasks: [{ nodeId: 'sp-1', title: 'Single point — xTB', status: taskStatus, engine: 'xtb', ...extra }],
});

describe('queue coalescing wiring (issue 374)', () => {
  let app;
  const list = queueList();
  const log = fakeLog();
  const elements = {
    '#queue-list': list,
    '#queue-state': fakeElement('span'),
    '#run-state': fakeElement('span'),
    '#run-progress': fakeElement('span'),
    '#run-last': fakeElement('span'),
    '#run-title': fakeElement('strong'),
    '#run-output': log,
  };
  let frames = [];

  function runFrame() {
    const pending = frames;
    frames = [];
    for (const callback of pending) if (callback) callback();
  }

  beforeAll(async () => {
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => {
      frames[id - 1] = null;
    });
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
      createElement: (tag) => fakeElement(tag),
      createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterEach(() => {
    // Leave no frame behind for the next test (or for afterAll's unstub).
    app.flushQueueEvents();
    app.flushRunOutput();
    frames = [];
    app.state.project = PROJECT;
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };
    app.state.lastForeignQueue = null;
    list.renders = 0;
    app.state.run.output = '';
    log.writes = 0;
    log.appends = 0;
    log.nodes = [];
    log.scrollHeight = 0;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('paints one queue state per frame, and it is the final one', () => {
    app.state.project = PROJECT;
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };

    app.handleQueueEvent({ type: 'queue-started', queue: queue('running', 'queued') });
    app.flushQueueEvents();
    expect(app.state.queue.id).toBe('queue-perf');
    expect(list.renders).toBe(1);

    // A burst of intermediate events must not paint anything yet.
    app.handleQueueEvent({ type: 'queue', queue: queue('running', 'running', { progress: 10 }) });
    app.handleQueueEvent({ type: 'queue', queue: queue('running', 'running', { progress: 80 }) });
    app.handleQueueEvent({ type: 'queue', queue: queue('running', 'completed') });

    expect(app.state.queue.tasks[0].status).toBe('queued');
    expect(list.renders).toBe(1);

    runFrame();
    // One apply for three events, and it carries the last state.
    expect(list.renders).toBe(2);
    expect(app.state.queue.tasks[0].status).toBe('completed');
  });

  it('applies a finish event immediately instead of waiting for a frame', () => {
    app.state.project = PROJECT;
    app.state.queue = { id: 'queue-perf', status: 'running', tasks: [], reason: null, spins: {} };
    app.state.run.hintPinned = false;

    app.handleQueueEvent({ type: 'queue-done', queue: queue('completed', 'completed') });

    expect(app.state.queue.status).toBe('completed');
    // The final line is in the log before the next frame, and the buffer's text
    // is readable even while its chunks are still waiting for a paint.
    expect(app.state.run.output).toContain('Workflow completed');
  });

  it('paints an output burst with one append, not one write per chunk', () => {
    app.state.run.output = '';
    log.textContent = 'Select a calculation block, then run.';
    log.writes = 0;
    log.appends = 0;

    app.appendRunOutput('first line\n');
    app.appendRunOutput('second line\n');

    // Nothing touched the element yet...
    expect(log.writes).toBe(0);
    expect(log.appends).toBe(0);
    // ...but a reader still sees the complete log.
    expect(app.state.run.output).toBe('first line\nsecond line\n');

    runFrame();
    // One placeholder clear, one append.
    expect(log.writes).toBe(1);
    expect(log.appends).toBe(1);
    expect(log.textContent).toBe('first line\nsecond line\n');
  });

  it('keeps the log bounded while appending in small frames', () => {
    app.state.run.output = '';
    const chunk = 'x'.repeat(4000);
    for (let frame = 0; frame < 17; frame += 1) {
      app.appendRunOutput(chunk);
      runFrame();
    }
    expect(log.textContent.length).toBeLessThanOrEqual(60000);
    expect(app.state.run.output.length).toBeLessThanOrEqual(60000);
    expect(log.textContent.endsWith(chunk)).toBe(true);
  });

  it('routes every queue event through the coalescer', () => {
    // Structural proof for the one path a DOM stub cannot observe: the handler
    // no longer calls applyQueue per event, and applyQueue guards the canvas.
    const handler = source.slice(source.indexOf('function handleQueueEvent'));
    const body = handler.slice(0, handler.indexOf('/**\n * Status-bar engine chips'));
    expect(body).toContain('queueEvents.push(event)');
    expect(body).not.toContain('applyQueue(event.queue)');
    expect(body).toContain('queueEvents.flushNow()');
    expect(source).toContain('const graphChanged = reconciled || previousGraph !== queueGraphSignature(queue);');
    expect(source).toContain('if (graphChanged) renderGraph();');
    expect(source).not.toContain('el.textContent = state.run.output');
  });
});
