import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_KINDS, defaultSettings } from '../src/shared/projectSchema.js';
import { DEFAULT_CONFORMER_SETTINGS } from '../src/shared/conformers.js';

/**
 * Public-documentation guards.
 *
 * Three failure modes matter for a release the outside world will read:
 *
 * 1. a relative link that does not resolve (a reader hits a 404 on the first
 *    page they try),
 * 2. a guide page that exists but is not reachable from the index,
 * 3. UI copy that advertises a version the package no longer is.
 *
 * The prose itself cannot be tested. These checks make sure the structure that
 * carries it cannot rot silently.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));

function markdownFiles(relDir) {
  const absolute = path.join(ROOT, relDir);
  const found = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(rel);
  }
  return found;
}

const DOC_FILES = ['README.md', ...markdownFiles('docs')];

/** Relative link targets in a markdown file, excluding anchors and URLs. */
function relativeTargets(text) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  let match = pattern.exec(text);
  while (match) {
    const target = match[1];
    if (!target.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      targets.push(target.split('#')[0]);
    }
    match = pattern.exec(text);
  }
  return targets;
}

describe('public documentation — links', () => {
  it('resolves every relative link and image in the README and docs', () => {
    const missing = [];
    for (const rel of DOC_FILES) {
      const fromDir = path.posix.dirname(rel);
      for (const target of relativeTargets(read(rel))) {
        const resolved = path.posix.normalize(path.posix.join(fromDir, target));
        if (!fs.existsSync(path.join(ROOT, resolved))) missing.push(`${rel} → ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('links every guide page from the guide index', () => {
    const index = read('docs/guide/README.md');
    const linked = new Set(relativeTargets(index).map((target) => path.posix.basename(target)));
    const pages = markdownFiles('docs/guide')
      .map((rel) => path.posix.basename(rel))
      .filter((name) => name !== 'README.md');
    expect(pages.length).toBeGreaterThanOrEqual(8);
    const unlinked = pages.filter((name) => !linked.has(name));
    expect(unlinked, 'guide pages not linked from docs/guide/README.md').toEqual([]);
  });

  it('gives every guide page a top-level heading and a Next or Back link', () => {
    for (const rel of markdownFiles('docs/guide')) {
      if (path.posix.basename(rel) === 'README.md') continue;
      const text = read(rel);
      expect(text, `${rel} needs an H1`).toMatch(/^# \S/m);
      expect(text, `${rel} needs navigation`).toMatch(/## Next|Back to the documentation index/);
    }
  });

  it('references every image in docs/images from a document', () => {
    const dir = path.join(ROOT, 'docs/images');
    const images = fs.readdirSync(dir).filter((name) => /\.(png|jpg|jpeg|svg|gif)$/i.test(name));
    const corpus = DOC_FILES.map(read).join('\n');
    const unlinked = images.filter((name) => !corpus.includes(`images/${name}`));
    expect(unlinked, 'unreferenced images rot and keep stale branding alive').toEqual([]);
  });
});

describe('public documentation — copy consistency', () => {
  it('renders the packaged version in the shell at runtime, not a hard-coded chip', () => {
    const html = read('index.html');
    // The chip used to hard-code "v0.1" and went stale at every release. It is
    // now filled from the build-time version and corrected from app:info.
    expect(html).not.toMatch(/v\d+\.\d+/);
    expect(html).toContain('id="app-version-chip"');
    expect(html).toContain('id="app-version-status"');
    expect(read('vite.config.js')).toContain('__APP_VERSION__: JSON.stringify(pkg.version)');
    const app = read('src/renderer/app.js');
    expect(app).toContain('typeof __APP_VERSION__');
    expect(app).toContain('info?.version');
  });

  it('does not repeat the xTB claims that issues #40 and #42 made false', () => {
    const corpus = DOC_FILES.map(read).join('\n');
    const retired = [
      'xTB checkpoint/restart hand-off is not implemented',
      'xTB solvation is builder-only',
      'not in the current inspector',
      'the app does not stage that file between blocks',
    ];
    const offenders = retired.filter((claim) => corpus.includes(claim));
    expect(offenders).toEqual([]);
  });

  it('states plainly what the release is, and is not', () => {
    const readme = read('README.md');
    expect(readme).toContain('early preview');
    // The release note has to keep saying, in some form, that a real run is
    // unproven — the exact sentence may change as evidence arrives.
    expect(readme).toMatch(/What has \*not\* been proven is a run driven by this app|What has \*not\* been proven is a real run/);
    expect(readme).toContain('GN-001');
  });

  it('ships exactly one outbound call, in the main process, on user request', () => {
    // The privacy page states one outbound request and its trigger (#82).
    // Prove it: no module may contain a network client, and the single
    // exception must be the release check — bounded, user-triggered, and far
    // away from the pure comparison module.
    const sources = [];
    for (const dir of ['src', 'electron']) {
      const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
          const next = path.posix.join(rel, entry.name);
          if (entry.isDirectory()) walk(next);
          else if (/\.(js|cjs|mjs)$/.test(entry.name)) sources.push({ rel: next, text: read(next) });
        }
      };
      walk(dir);
    }
    // Two benign hits are expected and excluded: the SVG namespace URI and the
    // local Vite dev-server URL used by `loadURL` in development. Neither is an
    // outbound client, and both are pinned to w3.org / localhost.
    const benign = /https?:\/\/(www\.w3\.org|127\.0\.0\.1|localhost)[^'"\s]*/gi;
    const pattern = /\bfetch\s*\(|XMLHttpRequest|['"]node:https?['"]|['"]https?['"]\s*\)|https?:\/\/[a-z0-9]/i;
    const offenders = sources
      .map(({ rel, text }) => ({ rel, text: text.replace(benign, 'BENIGN_URL') }))
      .filter(({ rel, text }) => rel !== 'electron/main.js' && pattern.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);

    const main = read('electron/main.js');
    expect(main.match(/\bfetch\s*\(/g) ?? []).toHaveLength(1);
    // Exactly three literals: the local dev URL (already excluded as benign),
    // the API endpoint, and the release-page fallback for a URL-less release.
    expect([...main.matchAll(/https?:\/\/[^\s'"`]+/g)].map((match) => match[0])).toEqual([
      'http://127.0.0.1:5173',
      'https://api.github.com/repos/xharl/nodechem-studio/releases?per_page=20',
      'https://github.com/xharl/nodechem-studio/releases/tag/',
    ]);
    expect(main).toContain("'User-Agent'");
    expect(main).toContain('AbortController');
    expect(main).toContain('UPDATE_CHECK_TIMEOUT_MS = 10_000');
    expect(main).toContain("ipcMain.handle('updates:check'");

    // The comparison itself is pure: no network primitive, no URL, no clock.
    const pure = read('src/shared/updateCheck.js');
    expect(pure).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https?:\/\//);
  });
});

describe('project-format coverage', () => {
  // A new setting that never reaches the reference page is a setting nobody can
  // discover. `fanOut` shipped in #80 and only reached PROJECT-FORMAT later, so
  // the key space is now checked instead of remembered.
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

  it('documents every calculation and conformer setting key', () => {
    const doc = read('docs/PROJECT-FORMAT.md');
    const keys = new Set([
      ...Object.keys(defaultSettings()),
      ...Object.keys(DEFAULT_CONFORMER_SETTINGS),
    ]);
    const missing = [...keys].filter((key) => !doc.includes('`' + key + '`'));
    expect(missing).toEqual([]);
  });

  it('documents the schema-v2 containers and every output kind', () => {
    // RFC 0001 added containers an outside reader must know about: a file that
    // carries flows[] and datasets[] is not readable from the old prose alone.
    const doc = read('docs/PROJECT-FORMAT.md');
    const containers = ['flows[]', 'datasets[]', 'runner', 'reports[]', 'activeFlowId', 'records[]'];
    const missingContainers = containers.filter((key) => !doc.includes('`' + key + '`'));
    expect(missingContainers).toEqual([]);
    const missingKinds = OUTPUT_KINDS.filter((kind) => !doc.includes('`' + kind + '`'));
    expect(missingKinds).toEqual([]);
    // The one thing the format deliberately cannot do.
    expect(doc).toContain('no PDF');
  });

  it('indexes every guide page it ships', () => {
    const index = read('docs/guide/README.md');
    const pages = fs.readdirSync(path.join(ROOT, 'docs/guide')).filter((name) => name.endsWith('.md'));
    const missing = pages
      .filter((name) => name !== 'README.md')
      .filter((name) => !index.includes('(' + name + ')'));
    expect(missing).toEqual([]);
  });

  it('documents every CLI command the binary dispatches', () => {
    // `convert` and `cache` shipped without a line on the CLI page, so a reader
    // could not discover them from the docs. The dispatch table is the source of
    // truth; the page has to name every command it hands out.
    const source = read('bin/ncs.js');
    const table = source.match(/const handlers = \{([\s\S]*?)\n\};/);
    expect(table).not.toBeNull();
    const commands = [...table[1].matchAll(/^\s{2}'?([a-z-]+)'?:/gm)].map((match) => match[1]);
    expect(commands.length).toBeGreaterThanOrEqual(6);
    const page = read('docs/guide/cli.md');
    const missing = commands.filter((name) => !page.includes('ncs ' + name));
    expect(missing).toEqual([]);
  });
});
