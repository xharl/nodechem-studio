/**
 * Packaging guard.
 *
 * The app is shipped as an asar, and `build.files` decides what goes into it.
 * A static import that resolves outside those globs is invisible to every
 * test that runs from the repository and fatal in the packaged app: issue
 * #299 shipped a 0.5 build that could not start because
 * `src/shared/nmrReferences.js` imports `../data/nmrReferences.json` and
 * `src/data/**` was not in the file list.
 *
 * This test resolves every relative import under `electron/` and `src/shared/`
 * and asserts the target is both on disk and matched by a packaged glob. It
 * deliberately reads the globs from `package.json`, so changing the file list
 * without changing the imports (or the reverse) fails here rather than at
 * launch time.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PACKAGED = pkg.build?.files ?? [];

/** `dist/**\/*` → a regexp over repository-relative POSIX paths. */
function globToRegExp(glob) {
  const pattern = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/\*/g, '(?:.*/)?[^/]*')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${pattern}$`);
}

const PACKAGED_PATTERNS = PACKAGED.map(globToRegExp);

function isPackaged(repoPath) {
  const posix = repoPath.split(sep).join('/');
  return PACKAGED_PATTERNS.some((pattern) => pattern.test(posix));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const repoPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...walk(repoPath));
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(repoPath);
    }
  }
  return out;
}

/**
 * Static and literal dynamic imports. `import x from '…'`, `import '…'`,
 * `export … from '…'`, `import('…')` — the forms the bundler and Node resolve
 * at load time, which is when a missing file becomes a crash.
 */
const SPECIFIER = /(?:^|[\s;{(])(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[\s;{(])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function relativeSpecifiers(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const found = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith('.')) found.push(specifier);
  }
  return found;
}

function resolveImport(file, specifier) {
  const base = normalize(join(dirname(file), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')];
  return candidates.find((candidate) => existsSync(join(ROOT, candidate))) ?? null;
}

describe('packaged file list', () => {
  const files = [...walk('electron'), ...walk('src/shared')];

  it('covers every relative import the main process can load', () => {
    const unpackaged = [];
    const unresolved = [];
    for (const file of files) {
      for (const specifier of relativeSpecifiers(file)) {
        const target = resolveImport(file, specifier);
        if (!target) {
          unresolved.push(`${file} → ${specifier}`);
          continue;
        }
        if (!isPackaged(target)) unpackaged.push(`${file} → ${specifier} (${target})`);
      }
    }
    expect(unresolved).toEqual([]);
    expect(unpackaged).toEqual([]);
  });

  it('ships the reference datasets imported as JSON', () => {
    for (const dataFile of [
      'src/data/nmrReferences.json',
      'src/data/pkaReferences.json',
      'src/data/redoxReferences.json',
    ]) {
      expect(existsSync(join(ROOT, dataFile))).toBe(true);
      expect(isPackaged(dataFile)).toBe(true);
    }
  });

  it('ships the entry point and the build output', () => {
    expect(isPackaged(pkg.main)).toBe(true);
    expect(isPackaged('dist/index.html')).toBe(true);
  });
});
