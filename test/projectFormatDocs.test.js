import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `docs/PROJECT-FORMAT.md` is the reference other people write against, and it
 * says of `calc.settings`: *"accepts exactly these keys — anything else is
 * dropped"*. That sentence is the reason this test exists: four keys merged in
 * one release (`freezeCore`, `timeoutSeconds`, `recordTransitionDipoles`,
 * `nmrSpinSpin`) without reaching the list, so the reference told a reader their
 * setting would be dropped when in fact it was read.
 *
 * `SETTINGS_KEYS` is not exported, so it is parsed out of the module the way
 * `cliOnlyCommands.test.js` parses the CLI's handler table. A key that moves to
 * another file fails here rather than passing silently.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Windows checkouts may carry CRLF (core.autocrlf). The document's structure is
// defined by blank lines; normalise before splitting so the Windows package gate
// reads the same list as Linux instead of treating the whole file as one block.
const normalize = (text) => String(text).replace(/\r\n?/g, '\n');
const schema = normalize(fs.readFileSync(path.join(ROOT, 'src/shared/projectSchema.js'), 'utf8'));
const doc = normalize(fs.readFileSync(path.join(ROOT, 'docs/PROJECT-FORMAT.md'), 'utf8'));

function settingsKeysFromSource() {
  const start = schema.indexOf('const SETTINGS_KEYS = new Set([');
  expect(start).toBeGreaterThan(-1);
  const end = schema.indexOf(']);', start);
  const block = schema.slice(start, end);
  // Strip line comments before reading the quoted names.
  const code = block.replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]);
}

function documentedSettingsKeys() {
  const start = doc.indexOf('`calculate.settings` accepts exactly these keys');
  expect(start).toBeGreaterThan(-1);
  // The sentence ends with a colon and the list is the next paragraph, so read
  // through to the blank line *after* the list rather than stopping at the
  // blank line that introduces it.
  const firstBreak = doc.indexOf('\n\n', start);
  const end = doc.indexOf('\n\n', firstBreak + 2);
  const block = doc.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((m) => m[1]);
}

describe('PROJECT-FORMAT documents the settings the schema reads', () => {
  it('lists every SETTINGS_KEYS member and nothing it does not accept', () => {
    const code = new Set(settingsKeysFromSource());
    const documented = new Set(documentedSettingsKeys().filter((key) => key !== 'calculate'));
    const missing = [...code].filter((key) => !documented.has(key));
    const extra = [...documented].filter((key) => !code.has(key));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('names the per-block time limit on a node, not only on the runner', () => {
    expect(schema).toContain("'timeoutSeconds'");
    expect(doc).toMatch(/A `calculate` block may also carry `timeoutSeconds`/);
    expect(doc).toMatch(/`\{ maxParallel, timeoutSeconds\? \}`/);
  });

  it('lists the block states the schema defines', () => {
    const start = schema.indexOf('export const NODE_STATES = Object.freeze([');
    const block = schema.slice(start, schema.indexOf(']);', start)).replace(/\/\/[^\n]*/g, '');
    const states = [...block.matchAll(/'([a-z][a-z ]*)'/g)].map((m) => m[1]);
    expect(states).toContain('timed out');
    for (const state of states) expect(doc).toContain(`\`${state}\``);
  });

  it('documents both analyse modes, and that the default stays absent', () => {
    expect(schema).toContain("'dp4'");
    expect(doc).toMatch(/`mode` is `expression` \(the default, and absent when never set\) or `dp4`/);
  });
});
