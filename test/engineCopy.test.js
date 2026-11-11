import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_PREVIEW_RUN_MESSAGE,
  checkpointHandoffNote,
  dryRunHintFor,
  engineListText,
  executableLabelFor,
  executablePlaceholderFor,
  planRunHint,
  runEngineLabel,
} from '../src/renderer/engineCopy.js';

/**
 * Issue #43 — the product has two engines, and the copy must say so.
 *
 * The unit assertions pin the engine-aware helpers; the source scan is the
 * drift guard. Each string in `STALE_CLAIMS` is a specific sentence the
 * Gaussian-only product shipped, so restoring any of them fails this file
 * rather than quietly misleading an xTB user again.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function rendererFiles(relDir = 'src/renderer') {
  const absolute = path.join(ROOT, relDir);
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.posix.join(relDir, entry.name));
}

const README = read('README.md');
const HTML = read('index.html');
const RENDERER = rendererFiles().map((rel) => ({ rel, text: read(rel) }));

/** Every user-facing document. The guide is part of the product's copy. */
function docsFiles(relDir = 'docs/guide') {
  const absolute = path.join(ROOT, relDir);
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.posix.join(relDir, entry.name));
}

const DOCS = [{ rel: 'README.md', text: README }, ...docsFiles().map((rel) => ({ rel, text: read(rel) }))];
const CORPUS = DOCS.map(({ text }) => text).join('\n');

/** Exact sentences removed in issue #43. Any one of them is a regression. */
const STALE_CLAIMS = [
  'Open the desktop app to start a local Gaussian run.',
  'Dry run writes a synthetic log and evaluates the parser. Uncheck to launch the licensed Gaussian installation.',
  'Preview project · choose a calculation block to run the local Gaussian slice',
  'no Gaussian job has been run',
  'the runner builds real Gaussian input',
  'Gaussian run console',
  'Validation found a blocking issue in a transition-state block.',
  '<label for="run-exe">Gaussian executable</label>',
];

describe('issue #43 — stale Gaussian-only copy cannot drift back', () => {
  it('keeps every removed sentence out of the documentation, the renderer shell and src/renderer', () => {
    const surfaces = [...DOCS, { rel: 'index.html', text: HTML }, ...RENDERER];
    for (const claim of STALE_CLAIMS) {
      const offenders = surfaces.filter(({ text }) => text.includes(claim)).map(({ rel }) => rel);
      expect(offenders, `stale copy: "${claim}"`).toEqual([]);
    }
  });

  it('describes the dry run as a fixture, never as a Gaussian log', () => {
    expect(HTML).toContain('Dry run (fixture output)');
    expect(HTML).toContain('synthetic fixture log');
    expect(CORPUS).toContain('A dry run is a fixture for every engine');
    expect(CORPUS).toContain('FIXTURE OUTPUT');
  });

  it('keeps the executable field label addressable so it can name the engine', () => {
    expect(HTML).toContain('id="run-exe-label"');
  });
});

describe('issue #43 — the documentation covers both engines', () => {
  it('has an Engines section that names both engines and every xTB method', () => {
    expect(CORPUS).toMatch(/^#{1,2} Engines$/m);
    expect(CORPUS).toContain('Gaussian 16');
    expect(CORPUS).toContain('GFN0-xTB');
    expect(CORPUS).toContain('GFN1-xTB');
    expect(CORPUS).toContain('GFN2-xTB');
    expect(CORPUS).toContain('GFN-FF');
  });

  it('explains what each engine cannot do and that xTB is not a Gaussian substitute', () => {
    expect(CORPUS).toContain('An xTB run is not a substitute for a Gaussian result');
    expect(CORPUS).toContain('No transition-state search (`Opt=TS`), no IRC and no PES scan');
    expect(CORPUS).toContain('No Gaussian-route checks');
    expect(CORPUS).toContain('not applicable');
    expect(CORPUS).toContain('licensed separately by Gaussian, Inc.');
    // Issue #40 made the restart hand-off real, so the docs must describe it
    // rather than repeating the old "not implemented" claim.
    expect(CORPUS).toContain('xtbrestart');
    expect(CORPUS).toContain('Restart hand-off');
  });

  it('documents the xTB setup path end to end', () => {
    expect(CORPUS).toContain('### Setting up xTB');
    expect(CORPUS).toContain('share/xtb');
    expect(CORPUS).toContain('XTBPATH');
    expect(CORPUS).toContain('xtb.exe');
    expect(CORPUS).toContain('xTB executable');
    expect(CORPUS).toContain('`<input>.out`');
    expect(CORPUS).toContain('`xtbopt.xyz`');
  });

  it('has a settings-ownership table for the two engines', () => {
    expect(CORPUS).toMatch(/^#{2,3} Which settings belong to which engine$/m);
    expect(CORPUS).toContain('| Setting | Gaussian 16 | xTB |');
    // Issue #42 made xTB solvation reachable from the inspector; the docs must
    // not still call it builder-only. Issue #40 made the restart hand-off real,
    // so the table's checkpoint row describes the copy instead of "Not supported".
    expect(CORPUS).toContain('ALPB / GBSA');
    expect(CORPUS).not.toContain('builder only');
    expect(CORPUS).toContain('Copies `xtbrestart` into the downstream run folder');
  });
});

describe('issue #43 — engine-aware helper copy', () => {
  it('names xTB, not Gaussian, in the xTB dry-run hint', () => {
    const hint = dryRunHintFor('xtb');
    expect(hint).toContain('xTB');
    expect(hint).toContain('fixture');
    expect(hint).not.toMatch(/Gaussian/i);
  });

  it('keeps the licence wording for a Gaussian dry run', () => {
    const hint = dryRunHintFor('gaussian');
    expect(hint).toContain('fixture');
    expect(hint).toContain('licensed Gaussian 16 installation');
  });

  it('makes the browser-preview message engine-neutral', () => {
    expect(BROWSER_PREVIEW_RUN_MESSAGE).toBe('Open the desktop app to start a local run.');
    expect(BROWSER_PREVIEW_RUN_MESSAGE).not.toMatch(/Gaussian|xTB/i);
  });

  it('labels the executable field with the engine that will run', () => {
    expect(executableLabelFor('xtb')).toBe('xTB executable');
    expect(executableLabelFor('gaussian')).toBe('Gaussian 16 executable');
  });

  it('reports the run engine instead of assuming Gaussian', () => {
    expect(runEngineLabel('xtb')).toBe('xTB (GFN-xTB)');
    expect(runEngineLabel('gaussian')).toBe('Gaussian 16');
    expect(runEngineLabel('xtb', { dryRun: true })).toBe('dry run');
  });

  it('names ORCA, not Gaussian, in the ORCA run console', () => {
    expect(executableLabelFor('orca')).toBe('ORCA executable');
    expect(dryRunHintFor('orca')).toContain('ORCA');
    expect(dryRunHintFor('orca')).not.toMatch(/Gaussian/i);
    expect(runEngineLabel('orca')).toBe('ORCA 6');
  });

  it('does not promise Gaussian checkpoint keywords to an ORCA or xTB block', () => {
    const orca = checkpointHandoffNote('orca');
    expect(orca).toContain('.gbw');
    expect(orca).not.toContain('%OldChk');
  });

  it('does not promise Gaussian checkpoint keywords to an xTB block', () => {
    expect(checkpointHandoffNote('gaussian')).toContain('%OldChk');
    const xtb = checkpointHandoffNote('xtb');
    expect(xtb).toContain('xtbrestart');
    expect(xtb).not.toContain('%OldChk');
  });
});

/**
 * Issue 361 — the run console described the project's default engine, not the
 * plan. A project whose default was Psi4 with an xTB block read "Psi4
 * executable" and "Uncheck to run the Psi4 interpreter", then failed preflight
 * on xTB; on Linux the field also offered a Windows example path.
 */
describe('issue 361 — the console describes the plan, not the default engine', () => {
  it('says when the field holds the project default', () => {
    expect(executableLabelFor('psi4', { projectDefault: true })).toBe('project default: Psi4');
    expect(executableLabelFor('xtb', { projectDefault: true })).toBe('project default: xTB (GFN-xTB)');
    // A selected block keeps the plain label.
    expect(executableLabelFor('xtb')).toBe('xTB executable');
    expect(executableLabelFor('xtb', { projectDefault: false })).toBe('xTB executable');
  });

  it('offers this platform\'s path, not a foreign one', () => {
    const linux = executablePlaceholderFor('gaussian', 'linux');
    expect(linux).not.toContain('\\');
    expect(linux).not.toMatch(/^[A-Za-z]:/);
    expect(executablePlaceholderFor('gaussian', 'win32')).toBe('C:\\G16W\\g16.exe');
    expect(executablePlaceholderFor('psi4', 'darwin')).not.toContain('\\');
    // An unknown engine still gets a usable example.
    expect(executablePlaceholderFor('nope', 'linux')).not.toContain('\\');
  });

  it('names the engines a plan launches', () => {
    expect(engineListText([])).toBe('');
    expect(engineListText(['xtb'])).toBe('xTB (GFN-xTB)');
    expect(engineListText(['xtb', 'psi4'])).toBe('xTB (GFN-xTB) and Psi4');
    expect(engineListText(['xtb', 'psi4', 'orca'])).toBe('xTB (GFN-xTB), Psi4 and ORCA 6');
    // A repeated engine is named once.
    expect(engineListText(['xtb', 'xtb'])).toBe('xTB (GFN-xTB)');
  });

  it('hints at the plan\'s engines and tools, not the default engine', () => {
    const hint = planRunHint({ engines: ['xtb'], tools: [], dryRun: true });
    expect(hint).toContain('This flow runs xTB (GFN-xTB)');
    expect(hint).toContain('uncheck to launch it');
    expect(hint).not.toMatch(/Psi4/);
    expect(hint).toContain('fixture');

    const mixed = planRunHint({ engines: ['xtb', 'psi4'], tools: ['multiwfn'], dryRun: true });
    expect(mixed).toContain('xTB (GFN-xTB) and Psi4, plus Multiwfn');
    expect(mixed).toContain('uncheck to launch them');

    const real = planRunHint({ engines: ['xtb'], tools: [], dryRun: false });
    expect(real).not.toContain('uncheck');
    expect(real).toContain('This flow runs');
  });

  it('falls back to the engine hint when the plan launches nothing', () => {
    const hint = planRunHint({ engines: [], tools: [], dryRun: true });
    expect(hint).toContain('fixture');
    expect(hint).not.toContain('This flow runs');
  });
});

/** The wiring: the console asks the plan, not the project default. */
describe('issue 361 — the run console is wired to the plan', () => {
  const APP = read('src/renderer/app.js');

  it('labels the field when it holds the project default', () => {
    expect(APP).toContain('executableLabelFor(engineId, { projectDefault })');
  });

  it('asks the placeholder for this platform', () => {
    expect(APP).toContain('executablePlaceholderFor(engineId, rendererPlatform())');
  });

  it('builds the default hint from the plan\'s engines and tools', () => {
    expect(APP).toContain('planRunHint({ engines: needs.engines, tools: needs.tools, dryRun })');
    expect(APP).toContain('shared.planToolNeeds(tasks)');
  });

  it('seeds a companion field only for a tool the plan spawns', () => {
    expect(APP).toContain('const needed = new Set(planNeedsForConsole().tools);');
    expect(APP).toContain('if (required && !input.value.trim()');
    expect(APP).toContain('const missing = required && Boolean(status)');
  });

  it('hardcodes no Windows example path in the static markup', () => {
    expect(HTML).not.toContain('C:\\G16W\\g16.exe');
  });
});
