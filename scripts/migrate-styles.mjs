#!/usr/bin/env node
/**
 * One-off migration: drain every colour literal and every legacy custom
 * property out of `src/renderer/styles.css`, leaving it reading only the theme
 * contract and the generated palette tokens.
 *
 * The replacement is literal-for-token, so `current.css` reproduces the old
 * values exactly: this step changes how the stylesheet refers to a colour, not
 * which colour it paints.
 *
 *   node scripts/migrate-styles.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const tokens = JSON.parse(readFileSync('src/renderer/themes/tokens.json', 'utf8')).tokens;

const LEGACY = {
  '--bg': '--surface-canvas',
  '--input': '--surface-well',
  '--panel': '--surface-panel',
  '--text': '--text-primary',
  '--muted': '--text-secondary',
  '--faint': '--text-tertiary',
  '--accent': '--action',
  '--accent-soft': '--action-tint',
  '--green': '--state-passed',
  '--red': '--state-review',
  '--slate': '--state-idle',
  '--violet': '--kind-loop',
  '--blue': '--kind-merge',
  '--teal': '--kind-output',
  '--amber': '--kind-condition',
  '--sans': '--font-ui',
  '--mono': '--font-mono',
  '--shadow': '--shadow-panel',
};

let css = readFileSync('src/renderer/styles.css', 'utf8');

// 1. Drop the flat :root block; the theme files now answer every name.
const rootStart = css.indexOf(':root {');
if (rootStart !== -1) {
  const rootEnd = css.indexOf('\n}', rootStart);
  const block = css.slice(rootStart, rootEnd + 2);
  // Keep a record of anything that is not a colour, as a safety net.
  // Font stacks move into the theme files, which own --font-ui/--font-mono.
  const moved = new Set(['--sans', '--mono']);
  const leftovers = block.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('--')) return false;
    if (moved.has(trimmed.split(':')[0])) return false;
    return !/#|rgba?\(|hsla?\(/.test(trimmed);
  });
  if (leftovers.length) {
    throw new Error(`:root carries non-colour definitions that must move to a theme first:\n${leftovers.join('\n')}`);
  }
  css = css.slice(0, rootStart) + css.slice(rootEnd + 2);
}

// 2. Legacy custom-property names → contract names (single pass, no chains).
for (const [legacy, next] of Object.entries(LEGACY)) {
  css = css.split(`var(${legacy})`).join(`var(${next})`);
}

// 3. Remaining literals → generated palette tokens.
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const missing = new Set();
css = css.replace(LITERAL, (literal) => {
  const token = tokens[literal.toLowerCase()];
  if (!token) { missing.add(literal); return literal; }
  return `var(${token})`;
});

// 4. Legacy names that were only used as declarations inside the sheet.
css = css.split('var(--panel-2)').join(`var(${tokens['#101722'] || '--surface-raised'})`);
css = css.split('var(--panel-3)').join(`var(${tokens['#141c29'] || '--surface-raised'})`);
css = css.split('var(--line)').join(`var(${tokens['rgba(148, 163, 184, .12)']})`);
css = css.split('var(--line-2)').join(`var(${tokens['rgba(148, 163, 184, .22)']})`);
css = css.split('var(--bg-deep)').join(`var(${tokens['#05070a']})`);

const leftoverVars = [...css.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]);
const legacyLeft = [...new Set(leftoverVars.filter((name) => name in LEGACY || ['--panel-2', '--panel-3', '--line', '--line-2', '--bg-deep'].includes(name)))];

writeFileSync('src/renderer/styles.css', css, 'utf8');
console.log(`literals unmatched: ${missing.size}`);
if (missing.size) console.log([...missing].join(' '));
console.log(`legacy names left: ${legacyLeft.length ? legacyLeft.join(' ') : 'none'}`);
