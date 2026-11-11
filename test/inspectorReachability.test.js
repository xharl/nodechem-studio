import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Issue 358: the inspector's empty state painted an `+ Add block` / `Validate`
 * pair below the window, where the canvas received the click and the two
 * buttons still sat in the tab order. Both actions already exist in the canvas
 * HUD, and the pane's footer carries `Add block` as well, so the pair was a
 * duplicate of a duplicate.
 *
 * The pane is a column of head / scroller / footer. Two invariants keep a
 * control reachable: the scroller is the only growing child, and the pane
 * clips whatever the scroller cannot show, so nothing can paint past the
 * viewport while staying focusable.
 */

const ROOT = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

/** The project inspector's template, from its declaration to the next function. */
function projectInspectorSource() {
  const source = read('src/renderer/app.js');
  const start = source.indexOf('function renderProjectInspector()');
  expect(start, 'renderProjectInspector is gone').toBeGreaterThan(-1);
  const end = source.indexOf('function gridOptionsFor(', start);
  expect(end, 'the boundary after renderProjectInspector moved').toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The declarations of one selector, without its descendants' rules. */
function cssBlock(selector) {
  const css = read('src/renderer/styles.css');
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} has no rule`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('the inspector empty state', () => {
  it('carries no action row of its own', () => {
    const summary = projectInspectorSource();
    expect(summary).not.toContain('inspector-actions-row');
    // The two controls it used to duplicate are the HUD's.
    expect(summary).not.toContain('data-action="validate"');
  });

  it('keeps the footer actions and the scroll container the pane is built on', () => {
    const summary = projectInspectorSource();
    expect(summary).toContain('<div class="inspector-scroll">');
    expect(summary).toContain('<div class="inspector-footer">');
    // One `Add block` in the footer: the copy that was unreachable is gone, the
    // reachable one is not.
    expect(summary.match(/data-action="toggle-palette"/g)).toHaveLength(1);
    expect(summary).toContain('data-open-modal="molecule"');
  });

  it('leaves both actions reachable in the canvas HUD', () => {
    const html = read('index.html');
    expect(html).toContain('class="btn add-block" data-action="toggle-palette"');
    expect(html).toContain('class="tool" data-action="validate"');
  });

  it('clips the pane and scrolls its content, so nothing paints past the viewport', () => {
    expect(cssBlock('.inspector')).toContain('overflow: hidden');
    const scroller = cssBlock('.inspector-scroll');
    expect(scroller).toContain('overflow-y: auto');
    expect(scroller).toContain('min-height: 0');
    expect(scroller).toContain('flex: 1');
  });
});
