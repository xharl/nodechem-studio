import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Issue 360: the UI read every label, table cell and queue row at 11 px. These
 * checks pin the decision in source so a later token edit cannot quietly put
 * the app back below the floor, and so the route clamp / port target cannot be
 * removed without a failing test.
 */

const read = (path) => readFileSync(path, 'utf8');
const THEMES = ['current', 'graphite', 'paper'];
const SCALE = ['--text-size-xs', '--text-size-sm', '--text-size-md', '--text-size-lg', '--text-size-xl', '--text-size-2xl'];

function declarations(text) {
  const out = new Map();
  for (const match of text.matchAll(/^\s{2}(--[a-z0-9-]+):\s*(.+);$/gim)) out.set(match[1], match[2].trim());
  return out;
}

/** The declaration body of the first rule with this exact selector. */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'm'));
  return match ? match[1] : '';
}

const styles = read('src/renderer/styles.css');
const results = read('src/renderer/resultsView.js');

describe('type scale floor (#360)', () => {
  it('moves xs to 12 px and sm to 13 px in every theme', () => {
    for (const theme of THEMES) {
      const tokens = declarations(read(`src/renderer/themes/${theme}.css`));
      expect(tokens.get('--text-size-xs'), `${theme} xs`).toBe('12px');
      expect(tokens.get('--text-size-sm'), `${theme} sm`).toBe('13px');
      expect(tokens.get('--text-size-md'), `${theme} md`).toBe('13px');
      expect(tokens.get('--text-size-lg'), `${theme} lg`).toBe('15px');
    }
  });

  it('keeps every scale step at or above the new 12 px floor', () => {
    const tokens = declarations(read('src/renderer/themes/current.css'));
    for (const name of SCALE) {
      const px = Number(tokens.get(name).replace('px', ''));
      expect(px, `${name} is below 12 px`).toBeGreaterThanOrEqual(12);
    }
    expect(SCALE.map((name) => tokens.get(name))).toEqual(['12px', '13px', '13px', '15px', '18px', '22px']);
  });

  it('puts queue rows, results tables and the inspector body on sm', () => {
    expect(ruleBody(styles, '.queue-item')).toMatch(/font-size:\s*var\(--text-size-sm\)/);
    expect(ruleBody(styles, '.inspector-scroll')).toMatch(/font-size:\s*var\(--text-size-sm\)/);
    expect(ruleBody(results, '.results-panel')).toMatch(/font-size:\s*var\(--text-size-sm\)/);
    expect(ruleBody(results, '.results-table')).toMatch(/var\(--text-size-sm\)/);
  });

  it('does not hand the results table header the 22 px display tier', () => {
    const header = ruleBody(results, '.results-table th');
    expect(header).toMatch(/var\(--text-size-sm\)/);
    expect(header).not.toContain('--text-size-2xl');
  });
});

describe('node route and port target (#360)', () => {
  it('clamps the route to two lines instead of one ellipsis', () => {
    const route = ruleBody(styles, '.node-route');
    expect(route).toMatch(/display:\s*-webkit-box/);
    expect(route).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(route).toMatch(/-webkit-line-clamp:\s*2/);
    expect(route).toMatch(/white-space:\s*normal/);
    expect(route).toMatch(/overflow:\s*hidden/);
  });

  it('gives the port a hit target of at least 16 px without growing the dot', () => {
    const port = ruleBody(styles, '.port');
    const dot = Number(port.match(/width:\s*([\d.]+)px/)?.[1]);
    const border = Number(port.match(/border:\s*([\d.]+)px/)?.[1]);
    const inset = Math.abs(Number(ruleBody(styles, '.port::before').match(/inset:\s*(-?[\d.]+)px/)?.[1]));
    expect(dot, 'the drawn dot').toBe(11);
    expect(border, 'the dot border').toBe(2);
    // Inset resolves against the padding box (dot minus both borders).
    const target = dot - border * 2 + inset * 2;
    expect(target, 'pointer target').toBeGreaterThanOrEqual(16);
  });

  it('gives the two-line route room above the result line', () => {
    const card = Number(ruleBody(styles, '.node').match(/height:\s*([\d.]+)px/)?.[1]);
    const result = Number(ruleBody(styles, '.node-result').match(/top:\s*([\d.]+)px/)?.[1]);
    expect(card).toBe(150);
    expect(result).toBe(97);
    // The edge anchors and drag bounds read this constant; it must match the CSS.
    expect(read('src/renderer/app.js')).toMatch(/const H = 150;/);
  });
});
