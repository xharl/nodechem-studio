import { describe, expect, it } from 'vitest';

import {
  ENGINE_SHORT_LABELS,
  RECENT_LIMIT,
  buildRecentView,
  engineSummary,
  enginesForProject,
  forgetRecent,
  formatRecentModified,
  parentFolder,
  pathKey,
  recordRecent,
  sortRecent,
} from '../src/shared/recentProjects.js';

/**
 * Issue 149 — the pure half of the recent-projects list.
 *
 * These tests pin the behaviour the menu depends on: newest first, one entry
 * per real path (case-folded where the platform folds it), never more than ten,
 * and a file that no longer exists stays visible as missing instead of being
 * silently dropped or opened as if present.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

const entry = (path, openedAt, extra = {}) => ({
  path,
  name: `Project ${path.split('/').pop()}`,
  openedAt,
  engines: ['gaussian'],
  ...extra,
});

describe('recent-projects reducer (issue 149)', () => {
  it('keeps the newest entry first', () => {
    let list = [];
    list = recordRecent(list, entry('/a/one.ncs', 100));
    list = recordRecent(list, entry('/a/two.ncs', 200));
    list = recordRecent(list, entry('/a/three.ncs', 300));
    expect(list.map((item) => item.path)).toEqual(['/a/three.ncs', '/a/two.ncs', '/a/one.ncs']);
  });

  it('de-duplicates by path and refreshes the existing entry', () => {
    let list = recordRecent([], entry('/a/one.ncs', 100, { name: 'Old name' }));
    list = recordRecent(list, entry('/b/two.ncs', 200));
    list = recordRecent(list, entry('/a/one.ncs', 300, { name: 'New name', engines: ['xtb'] }));
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ path: '/a/one.ncs', name: 'New name', engines: ['xtb'], openedAt: 300 });
    expect(list[1].path).toBe('/b/two.ncs');
  });

  it('folds case only on case-insensitive platforms', () => {
    const linux = recordRecent(recordRecent([], entry('/A/One.ncs', 1)), entry('/a/one.ncs', 2));
    expect(linux).toHaveLength(2);
    const windows = recordRecent(recordRecent([], entry('C:\\A\\One.ncs', 1)), entry('c:\\a\\one.ncs', 2), { platform: 'win32' });
    expect(windows).toHaveLength(1);
    expect(pathKey('C:\\A\\One.ncs', 'win32')).toBe(pathKey('c:\\a\\one.ncs', 'win32'));
  });

  it(`caps the list at ${RECENT_LIMIT} entries`, () => {
    let list = [];
    for (let index = 0; index < RECENT_LIMIT + 4; index += 1) {
      list = recordRecent(list, entry(`/a/${index}.ncs`, index));
    }
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].path).toBe(`/a/${RECENT_LIMIT + 3}.ncs`);
    expect(list.at(-1).path).toBe('/a/4.ncs');
  });

  it('ignores entries without a path instead of recording an empty row', () => {
    const list = recordRecent([entry('/a/one.ncs', 1)], { name: 'No path', openedAt: 2 });
    expect(list.map((item) => item.path)).toEqual(['/a/one.ncs']);
  });

  it('removes exactly one path, case-aware on the platform', () => {
    const list = sortRecent([entry('/a/one.ncs', 1), entry('/a/two.ncs', 2)]);
    expect(forgetRecent(list, '/a/one.ncs').map((item) => item.path)).toEqual(['/a/two.ncs']);
    expect(forgetRecent([entry('/A/One.ncs', 1)], '/a/one.ncs')).toHaveLength(1);
    expect(forgetRecent([entry('/A/One.ncs', 1)], '/a/one.ncs', { platform: 'darwin' })).toHaveLength(0);
  });
});

describe('recent-projects view (issue 149)', () => {
  const statFor = (existing) => (target) => (existing.includes(target)
    ? { exists: true, mtimeMs: 1_700_000_000_000 }
    : { exists: false, mtimeMs: 0 });

  it('keeps a missing file and marks it instead of pruning it', () => {
    const entries = [entry('/a/one.ncs', 2), entry('/a/gone.ncs', 1)];
    const rows = buildRecentView(entries, { now: 1_700_000_000_000, stat: statFor(['/a/one.ncs']) });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.path === '/a/gone.ncs')).toMatchObject({ missing: true, exists: false, modifiedAt: 0 });
    expect(rows.find((row) => row.path === '/a/one.ncs')).toMatchObject({ missing: false, exists: true });
  });

  it('derives the folder, engine summary and modified label from the entry and the file', () => {
    const rows = buildRecentView(
      [entry('/home/x/projects/study.ncs', 2, { engines: ['xtb', 'psi4', 'crest'] })],
      { now: 1_700_000_000_000 + 2 * HOUR, stat: () => ({ exists: true, mtimeMs: 1_700_000_000_000 }) },
    );
    expect(rows[0].folder).toBe('/home/x/projects');
    expect(rows[0].engineSummary).toBe('xTB · Psi4 · CREST');
    expect(rows[0].modifiedLabel).toBe('2 h ago');
  });

  it('sorts regardless of the order the file is in', () => {
    const rows = buildRecentView([entry('/a/old.ncs', 1), entry('/a/new.ncs', 9)], { stat: () => ({ exists: true, mtimeMs: 1 }) });
    expect(rows.map((row) => row.path)).toEqual(['/a/new.ncs', '/a/old.ncs']);
  });
});

describe('recent-projects formatting (issue 149)', () => {
  it('names engines in the order the graph uses them', () => {
    expect(engineSummary(['xtb', 'psi4', 'crest'])).toBe('xTB · Psi4 · CREST');
    expect(engineSummary(['gaussian', 'gaussian'])).toBe(ENGINE_SHORT_LABELS.gaussian);
    expect(engineSummary([])).toBe('');
    expect(engineSummary(['mystery'])).toBe('mystery');
  });

  it('reads engines from the blocks, resolving the project default', () => {
    const project = {
      defaults: { engine: 'xtb' },
      nodes: [
        { type: 'calc', settings: { engine: '' } },
        { type: 'calc', settings: { engine: 'psi4' } },
        { type: 'calc', settings: { engine: 'psi4' } },
        { type: 'conformers', settings: { generator: 'crest' } },
        { type: 'conformers', settings: { generator: 'import' } },
        { type: 'note' },
      ],
    };
    expect(enginesForProject(project)).toEqual(['xtb', 'psi4', 'crest']);
    expect(enginesForProject({ defaults: {}, nodes: [] })).toEqual([]);
  });

  it('formats dates relative to the modified time, then absolute', () => {
    const now = new Date(2026, 2, 12, 16, 0, 0).getTime();
    expect(formatRecentModified(now - 30_000, now)).toBe('just now');
    expect(formatRecentModified(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRecentModified(now - 3 * HOUR, now)).toBe('3 h ago');
    expect(formatRecentModified(now - DAY, now)).toBe('yesterday');
    expect(formatRecentModified(now - 3 * DAY, now)).toBe('3 days ago');
    expect(formatRecentModified(new Date(2026, 2, 1, 9, 0, 0).getTime(), now)).toBe('1 Mar 2026');
    expect(formatRecentModified(0, now)).toBe('');
  });

  it('finds the parent folder on both separators', () => {
    expect(parentFolder('/home/x/study.ncs')).toBe('/home/x');
    expect(parentFolder('C:\\Users\\x\\study.ncs')).toBe('C:\\Users\\x');
    expect(parentFolder('C:\\study.ncs')).toBe('C:\\');
    expect(parentFolder('study.ncs')).toBe('');
  });
});
