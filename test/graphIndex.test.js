import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';

/**
 * Issue 370 — the renderer's graph paths.
 *
 * `app.js` imports under vitest with a small DOM stub (the pattern
 * `queueCoalescing.test.js` established). The stub counts what the real DOM
 * would do: one `innerHTML` write on `#nodes` paints every card, one
 * `outerHTML` write on a card paints one. That is enough to hold the issue's
 * acceptance criteria:
 *
 * 1. an edit on a 200-node graph re-renders one card, not all of them;
 * 2. a drag move repaints only the edges incident to the dragged block, and the
 *    full edge pass happens once, at the end;
 * 3. `nodeById` is indexed, and the index is rebuilt only on a structural
 *    change — not on a render, not on a lookup;
 * 4. ensemble typing is debounced at 150 ms, while `change` commits immediately.
 *
 * These tests were run against the pre-#370 path (`renderGraph()` on every
 * field edit, `renderEdges()` on every mousemove) and fail there: see the PR's
 * "the test bites" note.
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

/** An element whose `innerHTML` write is the render being counted. */
function container(tag = 'div') {
  const el = fakeElement(tag);
  el.renders = 0;
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get: () => html,
    set: (value) => { el.renders += 1; html = String(value); },
  });
  return el;
}

/** The stub sees markup, not a parser: undo the attribute escaping by hand. */
const decodeEntities = (value) => String(value)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const nodeIds = (html) => [...html.matchAll(/data-node-id="([^"]+)"/g)].map((match) => decodeEntities(match[1]));
const edgeGroupIds = (html) => [...html.matchAll(/data-edge-group="([^"]+)"/g)].map((match) => decodeEntities(match[1]));

/** A form control the way the delegated listeners see one. */
const fieldTarget = (dataset, value, type = 'text') => ({
  dataset,
  value,
  type,
  id: '',
  checked: false,
  matches: () => false,
  closest: () => null,
});

const NODE_COUNT = 200;
const CHAIN_END = 40;

/**
 * 200 blocks: one ensemble input (`n0`) and 199 notes, plus a 40-edge chain that
 * `n0` sits in the middle of. `n0` therefore has two incident edges out of 41 —
 * a drag that touched every edge would be visible in the counters.
 */
function bigProject() {
  const nodes = [];
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const id = `n${index}`;
    if (index === 0) {
      nodes.push({
        id, type: 'input', kind: 'Ensemble input', title: 'Ensemble input', state: 'ready',
        x: 300, y: 220,
        input: { kind: 'ensemble', path: '', format: 'xyz', energyUnit: 'hartree', energyMethod: '', origin: {} },
        output: null,
      });
      continue;
    }
    nodes.push({
      id, type: 'note', kind: 'Note', title: `Note ${index}`, state: 'ready',
      x: 10 + (index % 8) * 260, y: 40 + Math.floor(index / 8) * 150,
      note: { text: `annotation ${index}` },
    });
  }
  const edges = [];
  for (let index = 0; index < CHAIN_END; index += 1) {
    edges.push({ from: `n${index + 1}`, to: `n${index + 2}`, type: 'dependency', branch: null });
  }
  edges.push({ from: 'n0', to: 'n1', type: 'dependency', branch: null });
  edges.push({ from: 'n2', to: 'n0', type: 'dependency', branch: null });
  return {
    name: 'perf-200',
    activeFlowId: 'main',
    flows: [{ id: 'main', title: 'Main', nodes, edges }],
    nodes,
    edges,
    defaults: { engine: 'xtb' },
    molecule: { charge: 0, multiplicity: 1, coords: [], fragments: [] },
    datasets: [],
  };
}

describe('graph index and targeted repaints (issue 370)', () => {
  let app;
  const nodesLayer = container('div');
  const edgeLayer = container('svg');
  const inspector = container('div');
  const flowTabs = container('div');
  const savePill = container('span');
  const cards = new Map();
  const groups = new Map();
  let cardsPainted = 0;

  function cardFor(id) {
    if (!cards.has(id)) {
      const card = fakeElement('article');
      card.dataset.nodeId = id;
      card.writes = 0;
      let html = '';
      Object.defineProperty(card, 'outerHTML', {
        get: () => html,
        set: (value) => { card.writes += 1; html = String(value); },
      });
      cards.set(id, card);
    }
    return cards.get(id);
  }

  function groupFor(id) {
    if (!groups.has(id)) {
      const group = fakeElement('g');
      group.writes = 0;
      let html = '';
      Object.defineProperty(group, 'innerHTML', {
        get: () => html,
        set: (value) => { group.writes += 1; html = String(value); },
      });
      group.remove = () => { groups.delete(id); };
      groups.set(id, group);
    }
    return groups.get(id);
  }

  // A full paint is the container's `innerHTML`; the stub rebuilds the card and
  // group handles from the markup, exactly as the browser would.
  Object.defineProperty(nodesLayer, 'innerHTML', {
    get: () => '',
    set: (value) => {
      nodesLayer.renders += 1;
      const html = String(value);
      cards.clear();
      const ids = nodeIds(html);
      cardsPainted += ids.length;
      ids.forEach((id) => cardFor(id));
    },
  });
  Object.defineProperty(edgeLayer, 'innerHTML', {
    get: () => '',
    set: (value) => {
      edgeLayer.renders += 1;
      const html = String(value);
      groups.clear();
      edgeGroupIds(html).forEach((id) => groupFor(id));
    },
  });

  function resetCounters() {
    nodesLayer.renders = 0;
    edgeLayer.renders = 0;
    cardsPainted = 0;
    inspector.renders = 0;
    cards.forEach((card) => { card.writes = 0; });
    groups.forEach((group) => { group.writes = 0; });
  }

  beforeAll(async () => {
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: (selector) => {
        if (selector === '#nodes') return nodesLayer;
        if (selector === '#edge-layer') return edgeLayer;
        if (selector === '#inspector') return inspector;
        if (selector === '#flow-tabs') return flowTabs;
        if (selector === '#save-pill') return savePill;
        const node = /^\.node\[data-node-id="(.*)"\]$/.exec(selector);
        if (node) return cards.get(node[1]) || null;
        const group = /^\[data-edge-group="(.*)"\]$/.exec(selector);
        if (group) return groups.get(group[1]) || null;
        return null;
      },
      querySelectorAll: () => [],
      createElement: (tag) => fakeElement(tag),
      createElementNS: (_ns, tag) => fakeElement(tag),
      createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterEach(() => {
    app.state.project = bigProject();
    app.state.selected = { type: 'project', id: null };
    app.state.drag = null;
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };
    app.flushEnsembleEdit();
    app.invalidateGraphIndex();
    resetCounters();
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('answers nodeById from an index that survives lookups and renders', () => {
    app.state.project = bigProject();
    app.renderGraph();
    resetCounters();

    app.invalidateGraphIndex();
    const before = app.graphIndex.builds;
    const node = app.state.project.nodes[42];

    for (let index = 0; index < 5000; index += 1) {
      expect(app.nodeById('n42')).toBe(node);
    }
    expect(app.graphIndex.builds - before).toBe(1);

    // A render reads the index; it does not rebuild it.
    app.renderGraph();
    expect(app.graphIndex.builds - before).toBe(1);
    expect(nodesLayer.renders).toBe(1);
    expect(cardsPainted).toBe(NODE_COUNT);
  });

  it('rebuilds the index on a structural change, not on a field edit', () => {
    app.state.project = bigProject();
    app.renderGraph();
    const before = app.graphIndex.builds;

    app.state.selected = { type: 'node', id: 'n5' };
    app.onDocumentChange({ target: fieldTarget({ nodeField: 'title' }, 'Renamed') });
    expect(app.nodeById('n5').title).toBe('Renamed');
    expect(app.graphIndex.builds).toBe(before);

    // An added block is a structural change: it must be found at once.
    app.addBlock('note');
    expect(app.graphIndex.builds).toBe(before + 1);
    const added = app.state.project.nodes[app.state.project.nodes.length - 1];
    expect(app.nodeById(added.id)).toBe(added);

    // So is a removal, which replaces the array.
    app.removeNode(added.id);
    expect(app.nodeById(added.id)).toBeNull();
    expect(app.graphIndex.builds).toBe(before + 2);
  });

  it('re-renders one card on a field edit, not all 200', () => {
    app.state.project = bigProject();
    app.renderGraph();
    resetCounters();
    expect(cardsPainted).toBe(0);

    app.state.selected = { type: 'node', id: 'n5' };
    app.onDocumentChange({ target: fieldTarget({ nodeField: 'title' }, 'Renamed block') });

    // One card repainted in place...
    expect(cardFor('n5').writes).toBe(1);
    expect(cards.get('n5').outerHTML).toContain('Renamed block');
    // ...and nothing else: no full card paint, no edge repaint.
    expect(nodesLayer.renders).toBe(0);
    expect(cardsPainted).toBe(0);
    expect(edgeLayer.renders).toBe(0);
    // A different block's card was not touched.
    expect(cardFor('n6').writes).toBe(0);
    // The inspector still refreshes on commit: the value is in the model.
    expect(inspector.renders).toBe(1);
  });

  it('repaints only the incident edges while a block is dragged', () => {
    app.state.project = bigProject();
    app.renderGraph();
    resetCounters();

    const node = app.nodeById('n0');
    app.state.drag = { id: 'n0', startX: 100, startY: 100, x: node.x, y: node.y, moved: false };
    app.updateNodeDrag({ clientX: 160, clientY: 190 });

    expect(app.state.drag.moved).toBe(true);
    // The edge layer was not rebuilt...
    expect(edgeLayer.renders).toBe(0);
    // ...and exactly the two edges that touch n0 were repainted.
    expect(groupFor('n0->n1:dependency').writes).toBe(1);
    expect(groupFor('n2->n0:dependency').writes).toBe(1);
    expect(groupFor('n5->n6:dependency').writes).toBe(0);
    expect(groupFor('n30->n31:dependency').writes).toBe(0);

    // A second move touches them again, and still nothing else.
    resetCounters();
    app.updateNodeDrag({ clientX: 200, clientY: 230 });
    expect(edgeLayer.renders).toBe(0);
    expect(groupFor('n0->n1:dependency').writes).toBe(1);
    expect(groupFor('n2->n0:dependency').writes).toBe(1);
    expect(groupFor('n5->n6:dependency').writes).toBe(0);

    // The full pass happens once, at the end.
    resetCounters();
    app.endNodeDrag();
    expect(edgeLayer.renders).toBe(1);
  });

  it('debounces ensemble typing at 150 ms and commits a change immediately', () => {
    app.state.project = bigProject();
    app.renderGraph();
    resetCounters();
    app.state.selected = { type: 'node', id: 'n0' };
    const node = app.nodeById('n0');

    vi.useFakeTimers();
    const field = (value) => fieldTarget({ ensembleField: 'path' }, value);

    app.onDocumentInput({ target: field('con') });
    app.onDocumentInput({ target: field('conformers') });
    app.onDocumentInput({ target: field('conformers.xyz') });

    // Nothing is written or painted until the pause.
    expect(node.input.path).toBe('');
    expect(cardFor('n0').writes).toBe(0);
    // In particular the inspector is not rebuilt under the caret.
    expect(inspector.renders).toBe(0);

    vi.advanceTimersByTime(149);
    expect(node.input.path).toBe('');
    expect(inspector.renders).toBe(0);

    vi.advanceTimersByTime(1);
    expect(node.input.path).toBe('conformers.xyz');
    expect(cardFor('n0').writes).toBe(1);
    expect(inspector.renders).toBe(0);
    expect(nodesLayer.renders).toBe(0);

    // A `change` commits at once, without waiting for the 150 ms.
    resetCounters();
    app.onDocumentInput({ target: field('conformers-final.xyz') });
    app.onDocumentChange({ target: field('conformers-final.xyz') });
    expect(node.input.path).toBe('conformers-final.xyz');
    // One card paint and one inspector paint for the commit — not two of each.
    expect(cardFor('n0').writes).toBe(1);
    expect(inspector.renders).toBe(1);

    // The pending debounce was flushed, not left to fire again.
    resetCounters();
    vi.advanceTimersByTime(500);
    expect(node.input.path).toBe('conformers-final.xyz');
    expect(cardFor('n0').writes).toBe(0);
  });

  it('routes the field paths through the targeted helpers, not the full rebuild', () => {
    // The DOM stub cannot see which function a handler called; this is the
    // structural half of the same claim. A regression to `renderGraph()` here
    // would show up as a missing counter in the tests above *and* here.
    const field = source.slice(source.indexOf("if (target.dataset.nodeField) {"), source.indexOf("if (target.dataset.nodeGate) {"));
    expect(field).toContain('updateNodeCard(node.id');
    expect(field).not.toContain('renderGraph()');

    const drag = source.slice(source.indexOf('function updateNodeDrag'), source.indexOf('function endNodeDrag'));
    expect(drag).toContain('renderIncidentEdges(node.id)');
    expect(drag).not.toContain('\n  renderEdges();');

    const end = source.slice(source.indexOf('function endNodeDrag'), source.indexOf('function startPan'));
    expect(end).toContain('renderEdges();');

    // The ensemble `input` path schedules; the `change` path flushes.
    const inputHandler = source.slice(source.indexOf('function onDocumentInput'), source.indexOf('/* ── Draggable modal windows'));
    expect(inputHandler).toContain('scheduleEnsembleEdit(target)');
    expect(inputHandler).not.toContain('applyEnsembleInputField(target)');
  });
});
