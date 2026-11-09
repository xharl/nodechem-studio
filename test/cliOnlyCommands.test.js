import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The CLI's command set and the documentation must be the same set.
 *
 * Issue 187 is about five capabilities a user could not find. Three were
 * surfaced in the window; the rest are deliberately CLI-only, and the failure
 * mode this test exists to prevent is the quiet return of that problem: a
 * subcommand ships, nobody documents it, and the window looks like it forgot a
 * feature it never had.
 *
 * So the source of truth is `bin/ncs.js`'s handler table, parsed from the file —
 * not a second list kept by hand, which would drift in exactly the same way.
 * `docs/guide/cli.md` carries one row per subcommand and says where it lives;
 * the About text in the window repeats the CLI-only rows, because a user who
 * never opens a terminal should still be told they exist.
 */

const ROOT = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

const cliSource = read('bin/ncs.js');
const cliDoc = read('docs/guide/cli.md');
const appSource = read('src/renderer/app.js');

/** The keys of `const handlers = { … }` in `bin/ncs.js`. */
function subcommandsFromCli() {
  const start = cliSource.indexOf('const handlers = {');
  expect(start, 'bin/ncs.js no longer declares `const handlers`').toBeGreaterThan(-1);
  const block = cliSource.slice(start, cliSource.indexOf('\n};', start));
  const found = [];
  for (const match of block.matchAll(/^ {2}(?:'([^']+)'|"([^"]+)"|([A-Za-z][\w-]*))\s*:/gm)) {
    found.push(match[1] || match[2] || match[3]);
  }
  return found;
}

/** The rows of the "window and the commands" table in `docs/guide/cli.md`. */
function documentedCommands() {
  const start = cliDoc.indexOf('## The window, and the commands');
  expect(start, 'docs/guide/cli.md lost the window/CLI table').toBeGreaterThan(-1);
  const section = cliDoc.slice(start, cliDoc.indexOf('\n## ', start + 3));
  const rows = [];
  for (const match of section.matchAll(/^\|\s*`ncs\s+([a-z][a-z-]*)`\s*\|([^|]*)\|/gm)) {
    rows.push({ command: match[1], where: match[2].trim() });
  }
  return rows;
}

describe('every CLI subcommand is documented where it lives', () => {
  const documented = documentedCommands();
  const subcommands = subcommandsFromCli();

  it('ships a row for every handler and a handler for every row', () => {
    const docSet = documented.map((row) => row.command).sort();
    const codeSet = [...subcommands].sort();
    expect(docSet).toEqual(codeSet);
  });

  it('documents each subcommand once', () => {
    const names = documented.map((row) => row.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks the pipeline tools CLI-only', () => {
    const cliOnly = documented.filter((row) => /CLI only/i.test(row.where)).map((row) => row.command);
    // The four issue 187 calls out as deliberately out of the window.
    for (const command of ['diff', 'merge', 'qcschema', 'cache']) {
      expect(cliOnly, `${command} must be documented as CLI-only`).toContain(command);
    }
  });

  it('names every CLI-only command in the About text, with its command', () => {
    const cliOnly = documented.filter((row) => /CLI only/i.test(row.where)).map((row) => row.command);
    expect(cliOnly.length).toBeGreaterThan(0);
    const about = appSource.split('\n').find((line) => line.includes("case 'about':"));
    expect(about, "app.js lost the About action").toBeTruthy();
    for (const command of cliOnly) {
      expect(about, `the About text does not name \`ncs ${command}\``).toContain(`ncs ${command}`);
    }
  });

  it('does not claim a window surface for the four CLI-only tools', () => {
    const rows = new Map(documented.map((row) => [row.command, row.where]));
    for (const command of ['diff', 'merge', 'qcschema', 'cache']) {
      expect(rows.get(command)).toMatch(/CLI only/i);
    }
  });
});
