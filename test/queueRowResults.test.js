/**
 * Issue #154 — clicking a finished queue row must show its results.
 *
 * The app is an Electron renderer, so this test drives the real
 * `installResultsView()` wiring against a small fake DOM: the same listener
 * registrations, the same `data-pane` attribute and the same tab classes the
 * app shell uses. It fails against a tree where a row click renders the panel
 * but never switches the console to `results`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installResultsView } from '../src/renderer/resultsView.js';

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : Boolean(force);
    if (on) this.values.add(name); else this.values.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.doc = doc;
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
    this.id = '';
    this.title = '';
    this.handlers = new Map();
    doc.register(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) { this.attributes.delete(name); }

  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  /** Await the handlers, because `openRun` is async. A real DOM would not. */
  dispatch(type, event = {}) {
    const handlers = this.handlers.get(type) || [];
    const payload = { type, target: this, preventDefault() {}, ...event };
    return Promise.all(handlers.map((handler) => handler(payload)));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) { children.forEach((child) => this.appendChild(child)); }

  focus() { this.doc.activeElement = this; }

  matches(selector) { return this.doc.matches(this, selector); }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) { return this.doc.querySelector(selector, this); }

  querySelectorAll(selector) { return this.doc.querySelectorAll(selector, this); }

  get className() { return this.getAttribute('class') || ''; }

  set className(value) {
    this.setAttribute('class', value);
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }
}

class FakeDocument {
  constructor() {
    this.elements = [];
    this.head = this.createElement('head');
    this.activeElement = null;
  }

  register(element) { this.elements.push(element); }

  createElement(tag) { return new FakeElement(tag, this); }

  getElementById(id) { return this.elements.find((element) => element.id === String(id)) || null; }

  /** One simple compound selector: tag, #id, .class or [attr] / [attr="v"]. */
  matches(element, selector) {
    const token = String(selector).trim();
    const id = token.match(/^#([\w-]+)$/);
    if (id) return element.id === id[1];
    const cls = token.match(/^\.([\w-]+)$/);
    if (cls) return element.classList.contains(cls[1]);
    const attr = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const value = attr[1] === 'id' ? element.id : (element.getAttribute(attr[1]) ?? undefined);
      return attr[2] === undefined ? value !== undefined && value !== null : value === attr[2];
    }
    if (token.includes('#') || token.includes('.') || token.startsWith('[')) {
      // Compound such as `aside.run-console` or `li.queue-item`.
      const tag = token.match(/^([a-zA-Z][\w-]*)/);
      if (tag && element.tagName !== tag[1].toUpperCase()) return false;
      const classes = [...token.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      const attributes = [...token.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
      const ids = [...token.matchAll(/#([\w-]+)/g)].map((match) => match[1]);
      return ids.every((value) => element.id === value)
        && classes.every((value) => element.classList.contains(value))
        && attributes.every(([, name, value]) => (value === undefined
          ? element.getAttribute(name) !== null || (name === 'id' && element.id !== '')
          : (name === 'id' ? element.id : element.getAttribute(name)) === value));
    }
    return element.tagName === token.toUpperCase();
  }

  /** Descendant selectors (`#run-tabs [data-run-tab]`) match the final token. */
  selectAll(selector, root = null) {
    const scoped = root ? this.elements.filter((element) => {
      let node = element;
      while (node) { if (node === root) return true; node = node.parentNode; }
      return false;
    }) : this.elements;
    return String(selector).split(',').flatMap((part) => {
      const tokens = part.trim().split(/\s+/);
      const last = tokens[tokens.length - 1];
      return scoped.filter((element) => {
        if (!this.matches(element, last)) return false;
        const ancestors = tokens.slice(0, -1);
        if (ancestors.length === 0) return true;
        let node = element.parentNode;
        while (node) {
          if (ancestors.every((token) => this.matches(node, token))) return true;
          node = node.parentNode;
        }
        return false;
      });
    }).filter((element, index, all) => all.indexOf(element) === index);
  }

  querySelector(selector, root = null) { return this.selectAll(selector, root)[0] || null; }

  querySelectorAll(selector, root = null) { return this.selectAll(selector, root); }
}

function buildConsole(doc, runIds) {
  const consoleEl = doc.createElement('aside');
  consoleEl.id = 'run-console';
  consoleEl.className = 'run-console';
  consoleEl.dataset.pane = 'queue';

  const results = doc.createElement('section');
  results.id = 'run-results';
  results.hidden = true;
  consoleEl.appendChild(results);

  const tabs = doc.createElement('nav');
  tabs.id = 'run-tabs';
  const tabFor = (pane) => {
    const tab = doc.createElement('button');
    tab.dataset.runTab = pane;
    tab.setAttribute('data-run-tab', pane);
    tab.setAttribute('aria-selected', String(pane === 'queue'));
    if (pane === 'queue') tab.classList.add('is-active');
    tabs.appendChild(tab);
    return tab;
  };
  tabFor('setup');
  tabFor('queue');
  const resultsTab = tabFor('results');
  resultsTab.classList.add('is-disabled');
  resultsTab.setAttribute('aria-disabled', 'true');
  consoleEl.appendChild(tabs);

  const dot = doc.createElement('span');
  dot.id = 'run-tab-results-dot';
  dot.hidden = true;
  consoleEl.appendChild(dot);

  const queueState = doc.createElement('span');
  queueState.id = 'queue-state';
  queueState.className = 'run-state is-completed';
  consoleEl.appendChild(queueState);

  const queueList = doc.createElement('ol');
  queueList.id = 'queue-list';
  const rows = runIds.map((runId) => {
    const row = doc.createElement('li');
    row.className = 'queue-item is-completed';
    row.setAttribute('data-run-id', runId);
    row.setAttribute('tabindex', '0');
    row.setAttribute('role', 'button');
    queueList.appendChild(row);
    return row;
  });
  consoleEl.appendChild(queueList);

  const history = doc.createElement('ul');
  history.id = 'run-history';
  consoleEl.appendChild(history);

  return { consoleEl, results, resultsTab, dot, rows, queueList };
}

const RECORD = {
  id: 'run-finished',
  status: 'completed',
  engine: 'gaussian',
  title: 'Finished optimisation',
  parsed: {},
  gates: { overall: 'pass', gates: [] },
};

/** A desktop bridge whose summary list and `runs:records` agree. */
function desktopFor(records) {
  return {
    listRuns: async () => records,
    getRunRecords: async (ids) => records.filter((record) => ids.includes(record.id)),
  };
}

describe('queue row opens the Results section (#154)', () => {
  it('switches the console to results and marks the row selected', async () => {
    const doc = new FakeDocument();
    const ui = buildConsole(doc, ['run-finished']);
    const view = installResultsView({ desktop: desktopFor([RECORD]), doc });
    expect(view).toBeTruthy();

    await ui.queueList.dispatch('click', { target: ui.rows[0] });

    expect(ui.consoleEl.dataset.pane).toBe('results');
    expect(ui.results.hidden).toBe(false);
    expect(ui.results.innerHTML).toContain('Finished optimisation');
    expect(ui.rows[0].classList.contains('is-selected')).toBe(true);
    expect(ui.rows[0].getAttribute('aria-current')).toBe('true');
    // The row is reachable and activatable from the keyboard.
    expect(ui.rows[0].getAttribute('tabindex')).toBe('0');
  });

  it('enables the Results tab in the same gesture', async () => {
    const doc = new FakeDocument();
    const ui = buildConsole(doc, ['run-finished']);
    installResultsView({ desktop: desktopFor([RECORD]), doc });

    expect(ui.resultsTab.classList.contains('is-disabled')).toBe(true);
    await ui.queueList.dispatch('click', { target: ui.rows[0] });

    expect(ui.resultsTab.classList.contains('is-disabled')).toBe(false);
    expect(ui.resultsTab.getAttribute('aria-disabled')).toBe('false');
    expect(ui.resultsTab.getAttribute('aria-selected')).toBe('true');
    expect(ui.dot.hidden).toBe(false);
  });

  it('activates a focused row with Enter', async () => {
    const doc = new FakeDocument();
    const ui = buildConsole(doc, ['run-finished']);
    installResultsView({ desktop: desktopFor([RECORD]), doc });

    ui.rows[0].focus();
    expect(doc.activeElement).toBe(ui.rows[0]);
    await ui.queueList.dispatch('keydown', { key: 'Enter', target: doc.activeElement });

    expect(ui.consoleEl.dataset.pane).toBe('results');
    expect(ui.results.hidden).toBe(false);
  });

  it('still leaves the console on results when the row cannot be loaded', async () => {
    const doc = new FakeDocument();
    const ui = buildConsole(doc, ['run-missing']);
    installResultsView({ desktop: desktopFor([]), doc });

    await ui.queueList.dispatch('click', { target: ui.rows[0] });

    expect(ui.consoleEl.dataset.pane).toBe('results');
    expect(ui.results.innerHTML).toContain('could not be loaded');
  });

  it('keeps keyboard reachability in both rendered row templates', () => {
    const app = readFileSync(
      fileURLToPath(new URL('../src/renderer/app.js', import.meta.url)),
      'utf8',
    );
    const rowTemplates = [...app.matchAll(/<li class="queue-item[^`]*?<\/li>`/g)].map((match) => match[0]);
    expect(rowTemplates.length).toBeGreaterThanOrEqual(2);
    for (const template of rowTemplates) {
      expect(template).toContain('${interactive}');
    }
    // The attribute block both templates interpolate.
    const interactive = app.match(/const interactive = runId\s*\n?\s*\? `([^`]*)`/);
    expect(interactive).toBeTruthy();
    expect(interactive[1]).toContain('tabindex="0"');
    expect(interactive[1]).toContain('role="button"');
  });
});
