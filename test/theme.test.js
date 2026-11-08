import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const THEMES = ['current', 'graphite', 'paper'];
const CONTRACT = [
  '--surface-canvas', '--surface-panel', '--surface-raised', '--surface-well', '--surface-scrim',
  '--border-subtle', '--border-strong',
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-inverse',
  '--action', '--action-hover', '--action-press', '--action-tint', '--focus-ring',
  '--state-passed', '--state-passed-tint', '--state-review', '--state-review-tint',
  '--state-ready', '--state-ready-tint', '--state-blocked', '--state-blocked-tint',
  '--state-idle', '--state-idle-tint',
  '--kind-calc', '--kind-condition', '--kind-loop', '--kind-merge', '--kind-output', '--kind-note',
  '--font-display', '--font-ui', '--font-mono',
  '--radius-sm', '--radius-md', '--radius-lg',
  '--shadow-raised', '--shadow-panel', '--shadow-popover',
  '--canvas-grid-image', '--canvas-grid-size', '--motion-fast', '--motion-ease',
];
const SCALE = ['--text-size-xs', '--text-size-sm', '--text-size-md', '--text-size-lg', '--text-size-xl', '--text-size-2xl'];

const read = (path) => readFileSync(path, 'utf8');

/** Every `--name: value;` declaration in a theme file. */
function declarations(text) {
  const out = new Map();
  for (const match of text.matchAll(/^\s{2}(--[a-z0-9-]+):\s*(.+);$/gim)) out.set(match[1], match[2].trim());
  return out;
}

const themes = Object.fromEntries(THEMES.map((theme) => [theme, declarations(read(`src/renderer/themes/${theme}.css`))]));

const parseColour = (value) => {
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => Number(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
};

/** Composite a possibly translucent colour onto an opaque background. */
const over = (colour, background) => ({
  r: colour.r * colour.a + background.r * (1 - colour.a),
  g: colour.g * colour.a + background.g * (1 - colour.a),
  b: colour.b * colour.a + background.b * (1 - colour.a),
  a: 1,
});

const luminance = ({ r, g, b }) => {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a, b) => {
  const la = luminance(a); const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const colourOf = (theme, name) => {
  const raw = themes[theme].get(name);
  expect(raw, `${theme} is missing ${name}`).toBeDefined();
  const parsed = parseColour(raw);
  expect(parsed, `${name} in ${theme} is not a colour: ${raw}`).not.toBeNull();
  return parsed;
};

describe('theme contract', () => {
  it('defines the same key set in every theme', () => {
    const reference = [...themes.current.keys()].sort();
    for (const theme of THEMES) {
      expect([...themes[theme].keys()].sort(), `${theme} key set`).toEqual(reference);
    }
  });

  it('answers every contract name plus the fixed type scale', () => {
    for (const theme of THEMES) {
      for (const name of [...CONTRACT, ...SCALE]) {
        expect(themes[theme].has(name), `${theme} is missing ${name}`).toBe(true);
      }
    }
  });

  it('keeps type sizes out of the themes: the scale is identical everywhere', () => {
    for (const name of SCALE) {
      const values = THEMES.map((theme) => themes[theme].get(name));
      expect(new Set(values).size, `${name} differs between themes`).toBe(1);
    }
    expect(SCALE.map((name) => themes.current.get(name))).toEqual(['11px', '12px', '13px', '15px', '18px', '22px']);
  });
});

describe('contrast floors (WCAG 2.1)', () => {
  const floors = [
    ['--text-primary', '--surface-panel', 7.0],
    ['--text-secondary', '--surface-panel', 4.5],
    ['--text-tertiary', '--surface-panel', 4.5],
    ['--state-passed', '--surface-panel', 4.5],
    ['--state-review', '--surface-panel', 4.5],
    ['--state-blocked', '--surface-panel', 4.5],
    ['--text-inverse', '--action', 4.5],
    ['--action', '--surface-panel', 3.0],
  ];
  for (const theme of THEMES) {
    for (const [foreground, background, floor] of floors) {
      it(`${theme}: ${foreground} on ${background} ≥ ${floor}`, () => {
        const panel = colourOf(theme, background);
        const base = panel.a < 1 ? over(panel, colourOf(theme, '--surface-canvas')) : panel;
        const ink = colourOf(theme, foreground);
        const ratio = contrast(ink.a < 1 ? over(ink, base) : ink, base.a < 1 ? over(base, colourOf(theme, '--surface-canvas')) : base);
        expect(ratio, `${theme} ${foreground} on ${background} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});

describe('no literals outside the theme files', () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
  const files = [
    'src/renderer/styles.css',
    'index.html',
    ...readdirSync('src/renderer').filter((name) => name.endsWith('.js')).map((name) => `src/renderer/${name}`),
  ];

  // structureViewer.js carries the CPK element table: those are chemistry
  // conventions (carbon grey, oxygen red), not theme colours, so no theme may
  // recolour them. They are exempt by name rather than by loosening the rule.
  const EXEMPT = ['src/renderer/structureViewer.js'];
  for (const file of files) {
    if (EXEMPT.includes(file)) continue;
    it(`${file} carries no colour literal`, () => {
      // index.html is markup, so its inline SVG attributes are allowed to
      // inherit `currentColor`; anything else is a literal.
      const text = read(file)
        .split('\n')
        .filter((line) => !/currentColor|stroke-linecap|viewBox/.test(line))
        .join('\n');
      const found = text.match(LITERAL) || [];
      expect(found, `${file} still carries: ${[...new Set(found)].join(' ')}`).toEqual([]);
    });
  }
});

describe('type scale', () => {
  it('has no size below 11 px and no size outside the scale', () => {
    const sources = [
      'src/renderer/styles.css',
      'index.html',
      ...readdirSync('src/renderer').filter((name) => name.endsWith('.js')).map((name) => `src/renderer/${name}`),
    ];
    const sizes = [];
    const shorthand = [];
    for (const file of sources) {
      const text = read(file);
      for (const match of text.matchAll(/font-size:\s*([^;'"]+)/g)) sizes.push(match[1].trim());
      for (const match of text.matchAll(/font:\s*([^;'"]+)/g)) shorthand.push(match[1].trim());
    }
    for (const value of [...sizes, ...shorthand]) {
      const px = value.match(/([\d.]+)px/);
      expect(px, `literal size in "${value}"`).toBeNull();
    }
    for (const value of sizes) {
      expect(value, `"${value}" is not on the scale`).toMatch(/^var\(--text-size-(xs|sm|md|lg|xl|2xl)\)$/);
    }
  });
});

describe('theme boot', () => {
  it('runs before the stylesheet and is a classic script', () => {
    const html = read('index.html');
    const script = html.indexOf('theme-boot.js');
    const css = html.indexOf('styles.css');
    expect(script).toBeGreaterThan(-1);
    expect(css).toBeGreaterThan(-1);
    expect(script).toBeLessThan(css);
    expect(html.slice(script - 60, script)).not.toContain('type="module"');
  });

  it('makes no network call', () => {
    const boot = read('public/theme-boot.js');
    expect(boot).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https?:\/\//);
  });

  it('sets the theme attribute before the renderer paints', () => {
    const boot = read('public/theme-boot.js');
    expect(boot).toContain("setAttribute('data-theme'");
    expect(boot).toContain('colorScheme');
  });
});
