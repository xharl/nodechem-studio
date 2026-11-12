import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { parseProjectText, projectSnapshotView, stringifyProject } from '../src/shared/projectSchema.js';
import { attachGraphAliases, hydrateProject } from '../src/shared/flows.js';

/**
 * Issue 366 — the edit path serializes the authored project once.
 *
 * The renderer used to call `JSON.stringify(state.project)` twice per committed
 * edit: once for the dirty comparison and once for the undo step. After #367
 * one of those was removed, but the two `refreshDirty()` calls a field edit
 * makes (`updateNodeCard`, then `renderInspector`) still serialized twice. On
 * top of that, the string carried both the `nodes`/`edges` aliases and the
 * parsed run records attached to calculation blocks.
 *
 * These tests count the serializations at the module boundary
 * (`state.snapshotCount` and a wrapped `JSON.stringify`) and drive the real
 * delegated handlers through the DOM stub. They fail on the pre-#366 path with
 * 2 calls per edit, and on a project with a big frequency record they fail on
 * cost.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fakeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    hidden: false,
    textContent: '',
    dataset: {},
    attributes: new Map(),
    style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    remove: () => {},
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

function container(tag = 'div') {
  const el = fakeElement(tag);
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get: () => html,
    set: (value) => { html = String(value); },
  });
  return el;
}

function exampleProject(file) {
  const parsed = parseProjectText(fs.readFileSync(`${ROOT}/examples/${file}`, 'utf8'));
  expect(parsed.errors, JSON.stringify(parsed.errors)).toEqual([]);
  return parsed.project;
}

/** A run record the size of a real frequency parse, attached where the app attaches it. */
function bigParsedRecord() {
  const modes = Array.from({ length: 1200 }, (_, index) => ({
    index: index + 1,
    symmetry: 'A1',
    frequencyCm: 1000 + index / 100,
    reducedMass: 1.2,
    forceConstant: 0.4,
    displacement: Array.from({ length: 60 }, (_, atom) => Math.sin(atom + index)),
  }));
  return {
    geometry: { final: { atoms: Array.from({ length: 60 }, () => ({ element: 'C', x: 0, y: 0, z: 0 })) } },
    frequencies: { modes, imaginary: [], raw: 'x'.repeat(20000) },
    thermochemistry: { freeEnergyHartree: -123.456, zeroPointHartree: 0.123 },
  };
}

const projectShape = (value) => Boolean(value)
  && typeof value === 'object'
  && Array.isArray(value.flows)
  && typeof value.name === 'string';

/** A form control the delegated listeners see. */
function fieldTarget(dataset, value, type = 'text') {
  return {
    dataset,
    value,
    type,
    id: '',
    checked: false,
    matches: () => false,
    closest: () => null,
  };
}

describe('renderer edit serialization (issue 366)', () => {
  let app;
  let nodesLayer;
  let inspector;
  let savePill;

  beforeAll(async () => {
    nodesLayer = container('div');
    inspector = container('div');
    savePill = container('span');
    const edgeLayer = container('div');
    const flowTabs = container('div');
    const canvasCount = container('span');
    const statusLeft = container('div');
    const statusMessage = container('span');

    vi.stubGlobal('requestAnimationFrame', (callback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', { desktop: null, innerWidth: 1440, innerHeight: 900, addEventListener: () => {} });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: (selector) => {
        if (selector === '#nodes') return nodesLayer;
        if (selector === '#edge-layer') return edgeLayer;
        if (selector === '#inspector') return inspector;
        if (selector === '#flow-tabs') return flowTabs;
        if (selector === '#save-pill') return savePill;
        if (selector === '#canvas-count') return canvasCount;
        if (selector === '#status-left') return statusLeft;
        if (selector === '#status-message') return statusMessage;
        return null;
      },
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: (tag) => fakeElement(tag),
      createElementNS: (_ns, tag) => fakeElement(tag),
      createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed({ withRecord = true } = {}) {
    const project = exampleProject('opt-freq.ncs');
    attachGraphAliases(project);
    app.state.runRecords.clear();
    const node = project.nodes.find((entry) => entry.type === 'calculate');
    if (withRecord) {
      node.parsed = bigParsedRecord();
      app.state.runRecords.set(node.id, node.parsed);
    }
    app.state.project = project;
    app.state.selected = { type: 'node', id: node.id };
    app.state.history = null;
    app.state.savedSnapshot = app.serializeProjectSnapshot();
    app.state.planSnapshot = app.state.savedSnapshot;
    app.state.draftBaseline = app.state.savedSnapshot;
    app.state.dirty = false;
    app.state.snapshotQueued = false;
    app.state.snapshotCount = 0;
    app.invalidateGraphIndex();
    app.invalidatePlanCache();
    app.renderGraph();
    // The render itself is not part of what the next edit pays for.
    app.flushDirtyCheck();
    app.state.snapshotCount = 0;
    return { project, node };
  }

  /** Let the end-of-task check (or an explicit flush) run exactly once. */
  function settle() {
    if (app.state.snapshotQueued) app.flushDirtyCheck();
  }

  it('serializes the project once for one committed field edit', async () => {
    const { project, node } = seed();
    const realStringify = JSON.stringify;
    let projectCalls = 0;
    JSON.stringify = function countingStringify(value, ...rest) {
      if (projectShape(value)) projectCalls += 1;
      return realStringify.call(JSON, value, ...rest);
    };
    try {
      app.onDocumentChange({
        target: fieldTarget({ nodeField: 'title' }, 'Renamed for the serializer test'),
      });
      settle();

      expect(node.title).toBe('Renamed for the serializer test');
      // One call in refreshDirty for the dirty check + history step. The old
      // path called JSON.stringify(state.project) twice (and each call carried
      // the aliases and the parsed record).
      expect(projectCalls).toBe(1);
      expect(app.state.snapshotCount).toBe(1);
      expect(project.nodes).toBe(project.flows[0].nodes);
    } finally {
      JSON.stringify = realStringify;
    }
  });

  it('does not serialize the parsed run record or the graph aliases in a snapshot', () => {
    const { project, node } = seed();
    const view = projectSnapshotView(project);
    const snapshot = JSON.stringify(view);

    expect(view.nodes).toBeUndefined();
    expect(view.edges).toBeUndefined();
    expect(view.flows[0].nodes[0].parsed).toBeUndefined();
    // The view is a copy; the live project still carries both.
    expect(project.nodes).toBe(project.flows[0].nodes);
    expect(node.parsed).toBeTruthy();

    // A round trip through hydrateProject is a complete project: the aliases
    // point at the active flow again and every authored node is present.
    const restored = hydrateProject(JSON.parse(snapshot));
    expect(restored.nodes).toBe(restored.flows[0].nodes);
    expect(restored.nodes.map((entry) => entry.id)).toEqual(project.nodes.map((entry) => entry.id));
    expect(restored.nodes.some((entry) => 'parsed' in entry)).toBe(false);

    // The snapshot is proportional to what was authored, not to the run.
    const full = JSON.stringify(project);
    expect(snapshot.length * 5).toBeLessThan(full.length);
    expect(view.name).toBe(project.name);
  });

  it('keeps saved .ncs bytes independent of an attached run record', () => {
    const { project, node } = seed();
    const withRecord = stringifyProject(project);
    expect(withRecord.ok).toBe(true);
    expect(withRecord.text).not.toContain('frequencies');

    delete node.parsed;
    const withoutRecord = stringifyProject(project);
    expect(withoutRecord.text).toBe(withRecord.text);
  });

  it('keeps dirty, undo and repaint semantics unchanged', () => {
    const { project, node } = seed();
    settle();
    expect(app.state.dirty).toBe(false);
    expect(app.state.history.undoStack).toHaveLength(0);

    // A repaint that changes nothing is not a history step.
    app.renderInspector();
    settle();
    expect(app.state.history.undoStack).toHaveLength(0);
    expect(app.state.dirty).toBe(false);

    // A committed edit is dirty and one undo step.
    app.onDocumentChange({
      target: fieldTarget({ nodeField: 'title' }, 'Edited title'),
    });
    settle();
    expect(app.state.dirty).toBe(true);
    expect(app.hasUnsavedChanges()).toBe(true);
    expect(app.state.history.undoStack).toHaveLength(1);

    // Undo goes back to the saved document: clean again, and the run record
    // (which is derived and outside the snapshot) is still attached.
    app.undoEdit();
    settle();
    const restored = app.state.project.nodes.find((entry) => entry.id === node.id);
    expect(restored.title).not.toBe('Edited title');
    expect(app.state.dirty).toBe(false);
    expect(app.hasUnsavedChanges()).toBe(false);
    expect(app.state.history.undoStack).toHaveLength(0);
    expect(restored.parsed).toBe(app.state.runRecords.get(node.id));

    // Undo itself is not recorded as a new edit.
    app.renderInspector();
    settle();
    expect(app.state.history.undoStack).toHaveLength(0);
    expect(app.state.dirty).toBe(false);
  });

  it('performs no serialization while an ensemble field is being typed', () => {
    const { project } = seed({ withRecord: false });
    const node = {
      id: 'ens-input',
      type: 'input',
      kind: 'Input',
      title: 'Ensemble',
      state: 'ready',
      x: 10,
      y: 10,
      input: {
        kind: 'ensemble',
        path: '',
        format: 'xyz',
        energyUnit: 'hartree',
        energyMethod: '',
        origin: {},
      },
      output: null,
    };
    project.flows[0].nodes.push(node);
    attachGraphAliases(project);
    app.invalidateGraphIndex();
    app.state.selected = { type: 'node', id: node.id };
    app.state.snapshotCount = 0;

    vi.useFakeTimers();
    const field = (value) => ({ dataset: { ensembleField: 'path' }, value, type: 'text' });
    app.onDocumentInput({ target: field('con') });
    app.onDocumentInput({ target: field('conformers') });
    app.onDocumentInput({ target: field('conformers.xyz') });
    settle();
    expect(node.input.path).toBe('');
    expect(app.state.snapshotCount).toBe(0);

    vi.advanceTimersByTime(149);
    settle();
    expect(node.input.path).toBe('');
    expect(app.state.snapshotCount).toBe(0);

    // The 150 ms pause is one committed edit: one snapshot, one undo step.
    vi.advanceTimersByTime(1);
    settle();
    expect(node.input.path).toBe('conformers.xyz');
    expect(app.state.snapshotCount).toBe(1);
    expect(app.state.history.undoStack).toHaveLength(1);
  });
});
