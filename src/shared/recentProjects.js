/**
 * Recent projects (issue issue 149).
 *
 * Two halves live here, and neither imports `node:*`:
 *
 * - the pure ranking/formatting used by the renderer (dedupe by canonical path,
 *   newest first, cap at ten, missing files marked — never dropped), and
 * - `createRecentStore`, the JSON-file store the main process owns. It takes
 *   `fs` as an argument so the module stays importable from the renderer and so
 *   the store can be tested against a temporary directory.
 *
 * The list records what main itself opened or saved. `buildRecentView` never
 * invents metadata: a missing file is reported as missing, and name/engines are
 * either refreshed from the file by the caller or read from the entry that was
 * captured when the file was parsed.
 */

export const RECENT_LIMIT = 10;
export const RECENT_VERSION = 1;

/** Short labels for the menu's engine column, in the order the blocks appear. */
export const ENGINE_SHORT_LABELS = Object.freeze({
  gaussian: 'Gaussian',
  xtb: 'xTB',
  orca: 'ORCA',
  psi4: 'Psi4',
  crest: 'CREST',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Identity for dedupe. Windows and macOS file systems are case-insensitive by
 * default, so two entries that differ only in case are the same project there;
 * a Linux path keeps its case because it is a different file.
 */
export function pathKey(filePath, platform = 'linux') {
  const value = String(filePath ?? '').trim();
  if (!value) return '';
  return platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value;
}

/** Parent folder for the menu's second line, without importing `node:path`. */
export function parentFolder(filePath) {
  const value = String(filePath ?? '');
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (index < 0) return '';
  if (index === 0) return value.slice(0, 1);
  // `C:\file.ncs` — keep the drive as `C:\`, not `C:`.
  if (index === 2 && /^[A-Za-z]:/.test(value)) return value.slice(0, 3);
  return value.slice(0, index);
}

/** File stem, used only when a caller supplies no name. */
export function fileStem(filePath) {
  const value = String(filePath ?? '');
  const base = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The engines a project actually uses: each calculation block's effective
 * engine (its override, else the project default), plus CREST when a conformer
 * block generates with it. First appearance wins, so the summary describes the
 * graph rather than a fixed engine order.
 */
export function enginesForProject(project) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const fallback = typeof project?.defaults?.engine === 'string' && project.defaults.engine
    ? project.defaults.engine
    : 'gaussian';
  const found = [];
  for (const node of nodes) {
    let id = '';
    if (node?.type === 'calculate') id = node?.settings?.engine || fallback;
    else if (node?.type === 'generate' && node?.settings?.generator === 'crest') id = 'crest';
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

/** `['xtb','psi4','crest']` → `xTB · Psi4 · CREST`. Unknown ids stay visible. */
export function engineSummary(engines) {
  const list = Array.isArray(engines) ? engines : [];
  const seen = [];
  for (const id of list) {
    const key = String(id ?? '').trim().toLowerCase();
    if (!key || seen.includes(key)) continue;
    seen.push(key);
  }
  return seen.map((id) => ENGINE_SHORT_LABELS[id] || id).join(' · ');
}

/**
 * A modified label that is stable to test: relative while it is recent, an
 * absolute date after a week. The full timestamp is the row's `title`.
 */
export function formatRecentModified(mtimeMs, now = Date.now()) {
  const value = Number(mtimeMs);
  if (!Number.isFinite(value) || value <= 0) return '';
  const delta = Math.max(0, Number(now) - value);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(value);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Defensive read of one stored entry; anything unusable becomes null. */
export function normalizeRecentEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const filePath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!filePath) return null;
  const engines = Array.isArray(raw.engines)
    ? raw.engines.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()).slice(0, 8)
    : [];
  const openedAt = Number(raw.openedAt);
  return {
    path: filePath,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fileStem(filePath),
    openedAt: Number.isFinite(openedAt) && openedAt > 0 ? openedAt : 0,
    engines,
  };
}

/**
 * Add or refresh one project. Re-opening moves the entry to the top (its
 * `openedAt` is the new time), and the result never exceeds `limit`.
 */
export function recordRecent(entries, entry, { limit = RECENT_LIMIT, platform = 'linux' } = {}) {
  const next = normalizeRecentEntry(entry);
  if (!next) return sortRecent(entries).slice(0, limit);
  const key = pathKey(next.path, platform);
  const rest = sortRecent(entries).filter((item) => pathKey(item.path, platform) !== key);
  return [next, ...rest].slice(0, limit);
}

/** Newest first, without mutating the input. */
export function sortRecent(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeRecentEntry)
    .filter(Boolean)
    .sort((a, b) => b.openedAt - a.openedAt);
}

export function forgetRecent(entries, target, { platform = 'linux' } = {}) {
  const key = pathKey(target, platform);
  if (!key) return sortRecent(entries);
  return sortRecent(entries).filter((item) => pathKey(item.path, platform) !== key);
}

/**
 * What the menu renders. `stat(path)` returns `{ exists, mtimeMs }`; a missing
 * file stays in the list (the user can see what disappeared and remove it),
 * which is why this never filters.
 */
export function buildRecentView(entries, { now = Date.now(), stat } = {}) {
  const rows = [];
  for (const entry of sortRecent(entries)) {
    let info = null;
    if (typeof stat === 'function') {
      try { info = stat(entry.path); } catch { info = null; }
    }
    const exists = info ? info.exists === true : true;
    const modifiedAt = exists && Number.isFinite(Number(info?.mtimeMs)) ? Number(info.mtimeMs) : 0;
    rows.push({
      path: entry.path,
      name: entry.name,
      folder: parentFolder(entry.path),
      engines: [...entry.engines],
      engineSummary: engineSummary(entry.engines),
      openedAt: entry.openedAt,
      modifiedAt,
      modifiedLabel: formatRecentModified(modifiedAt, now),
      exists,
      missing: !exists,
    });
  }
  return rows;
}

/**
 * The JSON file in `userData`. Reads tolerate a missing or corrupt file (the
 * menu still opens); writes go through a temporary file so a crash cannot leave
 * a half-written list.
 *
 * `canonical(path)` is supplied by main (`realpath`, else `resolve`) so this
 * module keeps no `node:path` import. `fs` needs `readFileSync`, `writeFileSync`,
 * `renameSync`, `mkdirSync`, `existsSync` and `statSync`.
 */
export function createRecentStore({
  filePath,
  fs,
  platform = 'linux',
  now = () => Date.now(),
  canonical = (value) => value,
  limit = RECENT_LIMIT,
} = {}) {
  if (!filePath) throw new Error('a recent-projects file path is required');
  if (!fs) throw new Error('an fs implementation is required');

  function readAll() {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      return sortRecent(entries).slice(0, limit);
    } catch {
      // A corrupt list must not stop the app opening; the next record replaces it.
      return [];
    }
  }

  function writeAll(entries) {
    const record = { version: RECENT_VERSION, entries };
    const parent = parentFolder(filePath);
    if (parent) fs.mkdirSync(parent, { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, filePath);
    return entries;
  }

  return {
    entries: readAll,
    record(entry) {
      const raw = typeof entry?.path === 'string' ? entry.path.trim() : '';
      if (!raw) return readAll();
      let resolved = '';
      try { resolved = canonical(raw) || raw; } catch { resolved = raw; }
      const next = recordRecent(readAll(), {
        ...entry,
        path: resolved,
        openedAt: Number.isFinite(Number(entry?.openedAt)) ? Number(entry.openedAt) : now(),
      }, { limit, platform });
      return writeAll(next);
    },
    forget(target) {
      return writeAll(forgetRecent(readAll(), target, { platform }));
    },
    clear() {
      return writeAll([]);
    },
    /**
     * Entries plus existence/mtime. `readProject(path)` may refresh name and
     * engines from the file itself; a throw or a null result keeps the recorded
     * values rather than inventing new ones.
     */
    view({ readProject } = {}) {
      const entries = readAll();
      if (typeof readProject !== 'function') {
        return buildRecentView(entries, { now: now(), stat: statOf });
      }
      const refreshed = entries.map((entry) => {
        try {
          const fresh = readProject(entry.path);
          if (!fresh) return entry;
          return {
            ...entry,
            name: typeof fresh.name === 'string' && fresh.name.trim() ? fresh.name.trim() : entry.name,
            engines: Array.isArray(fresh.engines) ? fresh.engines : entry.engines,
          };
        } catch {
          return entry;
        }
      });
      return buildRecentView(refreshed, { now: now(), stat: statOf });
    },
  };

  function statOf(target) {
    try {
      const stats = fs.statSync(target);
      return { exists: stats.isFile(), mtimeMs: stats.isFile() ? stats.mtimeMs : 0 };
    } catch {
      return { exists: false, mtimeMs: 0 };
    }
  }
}
