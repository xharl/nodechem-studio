import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RECENT_LIMIT, createRecentStore } from '../src/shared/recentProjects.js';

/**
 * Issue 149 — the store behind `project:recent`.
 *
 * The IPC handler in `electron/main.js` is a thin wrapper over this factory, so
 * the persistence contract is tested here against a real temporary directory:
 * a restart reads the same list, a missing file stays in the JSON (the view marks
 * it, nothing prunes it), and a corrupt file costs the list but not the app.
 */

const temporaryDirs = [];

function newStore(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncs-recent-'));
  temporaryDirs.push(dir);
  const filePath = path.join(dir, 'recent-projects.json');
  const store = createRecentStore({
    filePath,
    fs,
    platform: 'linux',
    now: () => 1_000,
    canonical: (value) => value,
    ...overrides,
  });
  return { dir, filePath, store };
}

function writeProject(dir, name, body = '{}') {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

describe('recent-projects store (issue 149)', () => {
  it('persists entries and reads them back after a restart', () => {
    const { dir, filePath, store } = newStore({ now: () => 5_000 });
    const first = writeProject(dir, 'one.ncs');
    const second = writeProject(dir, 'two.ncs');

    store.record({ path: first, name: 'One', engines: ['gaussian'] });
    store.record({ path: second, name: 'Two', engines: ['xtb'] });

    const reopened = createRecentStore({ filePath, fs, now: () => 9_000, canonical: (value) => value });
    expect(reopened.entries().map((item) => item.path)).toEqual([second, first]);
    expect(reopened.entries()[0]).toMatchObject({ name: 'Two', engines: ['xtb'], openedAt: 5_000 });
  });

  it('de-duplicates and caps what it writes to disk', () => {
    const { dir, filePath, store } = newStore();
    let latest = '';
    for (let index = 0; index < RECENT_LIMIT + 3; index += 1) {
      latest = writeProject(dir, `${index}.ncs`);
      store.record({ path: latest, name: `Project ${index}`, engines: [] });
    }
    // Re-recording the newest file must move it, not duplicate it.
    store.record({ path: latest, name: 'Renamed', engines: ['psi4'] });

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.entries).toHaveLength(RECENT_LIMIT);
    expect(saved.entries[0]).toMatchObject({ path: latest, name: 'Renamed', engines: ['psi4'] });
    expect(saved.entries.filter((item) => item.path === latest)).toHaveLength(1);
  });

  it('keeps a missing file in the list and reports it as missing', () => {
    const { dir, store } = newStore();
    const kept = writeProject(dir, 'kept.ncs');
    const gone = path.join(dir, 'gone.ncs');
    store.record({ path: gone, name: 'Gone', engines: ['orca'] });
    store.record({ path: kept, name: 'Kept', engines: [] });

    const rows = store.view();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.path === gone)).toMatchObject({ missing: true, exists: false });
    expect(rows.find((row) => row.path === kept)).toMatchObject({ missing: false, exists: true });
    // Viewing is not a mutation: the entry is still there for the next session.
    expect(store.entries().map((item) => item.path)).toContain(gone);
  });

  it('refreshes name and engines from the file when the caller can read it', () => {
    const { dir, store } = newStore();
    const project = writeProject(dir, 'study.ncs');
    store.record({ path: project, name: 'Stale name', engines: ['gaussian'] });

    const rows = store.view({ readProject: () => ({ name: 'Fresh name', engines: ['xtb', 'crest'] }) });
    expect(rows[0]).toMatchObject({ name: 'Fresh name', engines: ['xtb', 'crest'], engineSummary: 'xTB · CREST' });
    // A failed refresh keeps the recorded values rather than inventing any.
    const fallback = store.view({ readProject: () => { throw new Error('unreadable'); } });
    expect(fallback[0]).toMatchObject({ name: 'Stale name', engines: ['gaussian'] });
  });

  it('forgets one entry and clears the rest without touching project files', () => {
    const { dir, filePath, store } = newStore();
    const one = writeProject(dir, 'one.ncs');
    const two = writeProject(dir, 'two.ncs');
    store.record({ path: one, name: 'One', engines: [] });
    store.record({ path: two, name: 'Two', engines: [] });

    store.forget(one);
    expect(store.entries().map((item) => item.path)).toEqual([two]);
    expect(fs.existsSync(one)).toBe(true);

    store.clear();
    expect(store.entries()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, entries: [] });
  });

  it('applies the canonical path before de-duplicating', () => {
    const { store } = newStore({ canonical: (value) => `/real${value}` });
    store.record({ path: '/a/one.ncs', name: 'One', engines: [] });
    store.record({ path: '/a/one.ncs', name: 'One again', engines: [] });
    expect(store.entries()).toHaveLength(1);
    expect(store.entries()[0]).toMatchObject({ path: '/real/a/one.ncs', name: 'One again' });
  });

  it('survives a corrupt list instead of refusing to open the menu', () => {
    const { filePath, store } = newStore();
    fs.writeFileSync(filePath, '{ this is not json', 'utf8');
    expect(store.entries()).toEqual([]);
    expect(store.view()).toEqual([]);
    store.record({ path: '/a/one.ncs', name: 'One', engines: [] });
    expect(store.entries()).toHaveLength(1);
  });
});
