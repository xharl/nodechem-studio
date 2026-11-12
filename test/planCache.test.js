import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { parseProjectText } from '../src/shared/projectSchema.js';
import { attachGraphAliases } from '../src/shared/flows.js';

/**
 * Issue 367 — the renderer builds one plan per project change.
 *
 * The inspector, the run console's tool seeding, the cost estimate and
 * preflight each used to call `buildWorkflowPlan` on every paint. This file
 * counts the calls at the module boundary (`vi.mock` wraps the real function)
 * and drives the renderer through the DOM stub the graph-index test uses.
 *
 * On the pre-#367 app every `updateRunConsoleCopy()` built the plan twice
 * (`renderRunHint` and the companion seeding); this test asserts one build for
 * an unchanged project and one more after a project change — not per paint.
 */

const counters = vi.hoisted(() => ({ plans: 0 }));

vi.mock('../src/shared/workflowTasks.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildWorkflowPlan: (...args) => {
      counters.plans += 1;
      return actual.buildWorkflowPlan(...args);
    },
  };
});

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

describe('renderer workflow-plan cache (issue 367)', () => {
  let app;
  const inspector = container('div');

  beforeAll(async () => {
    vi.stubGlobal('requestAnimationFrame', (callback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', { desktop: null, innerWidth: 1440, innerHeight: 900, addEventListener: () => {} });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: (selector) => (selector === '#inspector' ? inspector : null),
      querySelectorAll: () => [],
      createElement: (tag) => fakeElement(tag),
      createElementNS: (_ns, tag) => fakeElement(tag),
      createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  beforeEach(() => {
    const project = exampleProject('opt-freq.ncs');
    app.state.project = project;
    app.state.savedSnapshot = JSON.stringify(project);
    app.state.planSnapshot = JSON.stringify(project);
    app.state.projectRevision = 1;
    app.state.selected = { type: 'project', id: null };
    app.invalidatePlanCache();
    app.planCache.builds = 0;
    counters.plans = 0;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('builds the plan once across repeated console and inspector paints', () => {
    app.updateRunConsoleCopy();
    app.renderInspector();
    for (let index = 0; index < 20; index += 1) {
      app.updateRunConsoleCopy();
      app.renderInspector();
    }

    expect(counters.plans).toBe(1);
    expect(app.planCache.builds).toBe(1);
    // The console seeding and the hint read the same object, not a copy.
    expect(app.planCache.plan.flowId).toBe('main');
  });

  it('rebuilds exactly once after a project change, then holds', () => {
    app.updateRunConsoleCopy();
    expect(counters.plans).toBe(1);

    // A real edit path ends in `renderInspector`, which funnels `refreshDirty`.
    // Mutating the project directly is the same change to the serializer.
    app.state.project.name = 'Renamed project';
    app.renderInspector();
    const afterEdit = counters.plans;

    app.updateRunConsoleCopy();
    app.updateRunConsoleCopy();
    app.renderInspector();
    app.updateRunConsoleCopy();

    expect(counters.plans).toBe(afterEdit + 1);
    expect(app.planCache.builds).toBe(2);
  });

  it('notices a flow switch without being told explicitly', () => {
    app.updateRunConsoleCopy();
    const project = app.state.project;

    // `switchFlow` replaces the aliases the plan reads; the cache key holds
    // them by identity, so even a caller that forgets to invalidate misses.
    project.flows.push({ id: 'second', title: 'Second', nodes: [], edges: [] });
    project.activeFlowId = 'second';
    attachGraphAliases(project);

    app.updateRunConsoleCopy();
    expect(app.planCache.builds).toBe(2);
  });

  it('drops the plan when the graph index is invalidated', () => {
    app.updateRunConsoleCopy();
    app.invalidateGraphIndex();
    app.updateRunConsoleCopy();
    expect(app.planCache.builds).toBe(2);
  });

  it('does not retry an unbuildable plan on every paint', () => {
    const project = app.state.project;
    project.flows = [{ id: 'main', title: 'Empty', nodes: [], edges: [] }];
    project.activeFlowId = 'main';
    project.nodes = project.flows[0].nodes;
    project.edges = project.flows[0].edges;
    app.state.planSnapshot = null;
    app.invalidatePlanCache();

    app.updateRunConsoleCopy(); // the plan throws; the console reports nothing
    const builds = app.planCache.builds;
    app.updateRunConsoleCopy();
    app.updateRunConsoleCopy();

    expect(app.planCache.builds).toBe(builds);
    expect(app.planCache.error).toBeTruthy();
  });
});
