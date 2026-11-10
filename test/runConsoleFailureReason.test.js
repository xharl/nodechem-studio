import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';

/**
 * Issue 256 — a failed queue row must say why, and the hint line must report
 * the outcome. The reported build kept the reason in a `title` tooltip, logged
 * a bare "Workflow failed", and left the pre-run dry-run hint on screen.
 */

function fakeElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    hidden: false,
    dataset: {},
    children: [],
    attributes: new Map(),
    _text: '',
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
    get textContent() { return this._text; },
    set textContent(value) {
      this._text = String(value ?? '');
      this.children = [];
    },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() {},
    scrollIntoView() {},
  };
  return element;
}

const NO_CONFORMER = '"Conformer search — Open Babel MMFF94, nconf 20" has no selected conformer. '
  + 'Run the ensemble and choose a member before running "Opt Freq — Psi4 ωB97X-D/def2-TZVP".';

describe('a failed queue row says why (issue 256)', () => {
  let app;
  const hintElement = fakeElement('p');

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
      querySelector: (selector) => (selector === '#run-hint' ? hintElement : null),
      querySelectorAll: () => [],
      createElement: (tag) => fakeElement(tag),
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders the reason as row text, not only in the tooltip', () => {
    const task = {
      nodeId: 'opt-freq',
      title: 'Opt Freq — Psi4 ωB97X-D/def2-TZVP',
      status: 'failed',
      runId: 'run-1',
      error: NO_CONFORMER,
    };
    const html = app.queueRowHtml(task, {});

    expect(html).toContain('class="queue-reason"');
    expect(html).toContain('queue-reason-opt-freq');
    expect(html).toMatch(/<span class="queue-reason"[^>]*>[^<]*has no selected conformer/);
    expect(html).toContain('data-action="toggle-queue-reason"');
    expect(html).toContain('data-action="failure-fix"');
    expect(html).toContain('Select conformer…');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="queue-reason-opt-freq"');
    expect(html).toContain('aria-describedby="queue-reason-opt-freq"');
    // The tooltip remains as the secondary, complete copy.
    expect(html).toMatch(/title="[^"]*has no selected conformer/);
  });

  it('names the fix for a missing executable', () => {
    const failure = app.queueFailure({
      status: 'failed',
      tasks: [{
        nodeId: 'opt',
        title: 'Opt Freq',
        status: 'failed',
        engine: 'psi4',
        error: 'Open Babel executable not found: /opt/obabel',
      }],
    });

    expect(failure.kind).toBe('executable');
    expect(failure.action).toMatchObject({
      kind: 'executable',
      label: 'Set Open Babel path…',
      field: '#run-obabel',
    });
    expect(app.failureHint(failure)).toContain('Workflow failed —');
    expect(app.failureHint(failure)).toContain('Opt Freq');
    expect(app.failureDetail(failure)).toContain('Open Babel executable not found');
  });

  it('names the fix for an unselected conformer', () => {
    const failure = app.queueFailure({
      status: 'failed',
      tasks: [{
        nodeId: 'opt-freq',
        title: 'Opt Freq — Psi4',
        status: 'failed',
        error: NO_CONFORMER,
        pendingInput: { conformerId: 'conformer-search', conformerTitle: 'Conformer search — Open Babel MMFF94, nconf 20' },
      }],
    });

    expect(failure.kind).toBe('conformer');
    expect(failure.action).toMatchObject({
      kind: 'conformer',
      label: 'Select conformer…',
      nodeId: 'conformer-search',
      nodeTitle: 'Conformer search — Open Babel MMFF94, nconf 20',
    });
    expect(app.failureHint(failure)).toContain('has no selected conformer');
    expect(app.failureHint(failure)).toContain('Conformer search — Open Babel MMFF94, nconf 20');
  });

  it('names the fix for a failed gate', () => {
    const failure = app.queueFailure({
      status: 'needs-review',
      tasks: [{
        nodeId: 'opt',
        title: 'Opt — Psi4',
        status: 'needs-review',
        gateVerdict: 'fail',
        error: 'One or more gates did not pass; review the run output before continuing.',
      }],
    });

    expect(failure.kind).toBe('gate');
    expect(failure.action).toMatchObject({ kind: 'gate', label: 'Review gate…', taskId: 'opt' });
    expect(app.failureHint(failure, 'needs-review')).toContain('gates did not pass');
  });

  it('replaces the pre-run hint with the outcome and keeps it through a copy refresh', () => {
    const failure = app.queueFailure({
      status: 'failed',
      tasks: [{
        nodeId: 'opt-freq',
        title: 'Opt Freq — Psi4',
        status: 'failed',
        error: NO_CONFORMER,
        pendingInput: { conformerId: 'conformer-search', conformerTitle: 'Conformer search' },
      }],
    });
    const text = app.failureHint(failure);
    app.setRunHint(text, { warn: true, action: failure.action });

    expect(hintElement.textContent).toBe(text);
    expect(hintElement.classList.contains('is-warn')).toBe(true);
    expect(hintElement.children).toHaveLength(1);
    const action = hintElement.children[0];
    expect(action.textContent).toBe('Select conformer…');
    expect(action.dataset.action).toBe('failure-fix');
    expect(action.dataset.fixKind).toBe('conformer');
    expect(action.dataset.fixNode).toBe('conformer-search');

    // Selecting another block refreshes the copy but must not restore the
    // pre-run "Dry run writes…" sentence (#256).
    app.state.project = { name: 'water-cbs', defaults: { engine: 'psi4' }, flows: [{ id: 'main', nodes: [], edges: [] }] };
    app.updateRunConsoleCopy();
    expect(hintElement.textContent).toBe(text);
    expect(hintElement.textContent).not.toContain('Dry run writes');
  });

  it('writes the failure reason to the log and the hint when the queue finishes', () => {
    app.state.project = {
      name: 'water-cbs',
      activeFlowId: 'main',
      flows: [{ id: 'main', title: 'Main', nodes: [], edges: [] }],
      defaults: { engine: 'psi4' },
    };
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };
    app.state.run.output = '';
    app.state.run.hintPinned = false;

    app.handleQueueEvent({
      type: 'queue-done',
      queue: {
        id: 'queue-failed',
        projectName: 'water-cbs',
        flowId: 'main',
        status: 'failed',
        tasks: [{
          nodeId: 'opt-freq',
          title: 'Opt Freq — Psi4',
          status: 'failed',
          error: NO_CONFORMER,
          pendingInput: { conformerId: 'conformer-search', conformerTitle: 'Conformer search' },
        }],
      },
    });

    expect(app.state.run.output).toContain('Workflow failed —');
    expect(app.state.run.output).toContain('Opt Freq — Psi4');
    expect(app.state.run.output).not.toContain('\nWorkflow failed\n');
    expect(hintElement.textContent).toContain('Workflow failed —');
    expect(hintElement.textContent).toContain('has no selected conformer');
    expect(hintElement.children[0].dataset.fixKind).toBe('conformer');
  });

  it('clamps the inline reason to two lines with an expander in the stylesheet', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.queue-item \.queue-reason \{[\s\S]*?-webkit-line-clamp: 2;/);
    expect(css).toContain('.queue-item.is-expanded .queue-reason');
    expect(css).toContain('.run-hint .run-hint-action');
  });
});
