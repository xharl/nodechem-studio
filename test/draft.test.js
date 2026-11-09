import { describe, expect, it } from 'vitest';
import {
  DRAFT_KEY,
  DRAFT_VERSION,
  MAX_DRAFT_BYTES,
  draftAgeLabel,
  draftIsRestorable,
  normalizeDraft,
} from '../src/shared/draft.js';

/** A minimal project: the draft layer only checks shape, never chemistry. */
const project = {
  schemaVersion: 3,
  name: 'Diels-Alder TS',
  defaults: { method: 'B3LYP', basis: 'def2-SVP' },
  nodes: [
    { id: 'r-opt', type: 'calculate', title: 'Optimize', x: 40, y: 80 },
    { id: 'r-freq', type: 'calculate', title: 'Frequencies', x: 320, y: 80 },
  ],
  edges: [{ from: 'r-opt', to: 'r-freq', type: 'dependency' }],
};

const draftOf = (overrides = {}) => ({
  version: DRAFT_VERSION,
  updatedAt: new Date(2026, 10, 7, 14, 5).getTime(),
  filePath: '/home/x/projects/diels-alder.ncs',
  project,
  ...overrides,
});

/** Local wall-clock timestamps, so the expectations do not depend on the TZ. */
const local = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute).getTime();

describe('draft identity', () => {
  it('pins one key and one version so an older build cannot misread it', () => {
    expect(DRAFT_KEY).toBe('ncs.draft.v1');
    expect(DRAFT_VERSION).toBe(1);
  });

  it('caps the draft at about a megabyte', () => {
    expect(MAX_DRAFT_BYTES).toBe(1_000_000);
  });
});

describe('normalizeDraft', () => {
  it('accepts the serialized draft the renderer writes', () => {
    const draft = draftOf();
    const parsed = normalizeDraft(JSON.stringify(draft));
    expect(parsed).toEqual(draft);
    expect(parsed.project).toEqual(project);
  });

  it('accepts an already-parsed draft object', () => {
    expect(normalizeDraft(draftOf())).toEqual(draftOf());
  });

  it('rejects corrupt JSON instead of repairing it', () => {
    expect(normalizeDraft('{"version":1,"project":')).toBeNull();
    expect(normalizeDraft('')).toBeNull();
    expect(normalizeDraft('null')).toBeNull();
    expect(normalizeDraft('[]')).toBeNull();
  });

  it('rejects a draft written for another version', () => {
    expect(normalizeDraft(draftOf({ version: 2 }))).toBeNull();
    expect(normalizeDraft(draftOf({ version: 0 }))).toBeNull();
    expect(normalizeDraft(draftOf({ version: '1' }))).toBeNull();
    expect(normalizeDraft({ updatedAt: 1, project })).toBeNull();
  });

  it('rejects a draft with no usable project', () => {
    expect(normalizeDraft({ ...draftOf(), project: undefined })).toBeNull();
    expect(normalizeDraft(draftOf({ project: null }))).toBeNull();
    expect(normalizeDraft(draftOf({ project: [] }))).toBeNull();
    expect(normalizeDraft(draftOf({ project: 'project' }))).toBeNull();
  });

  it('rejects values that are not drafts at all', () => {
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft(undefined)).toBeNull();
    expect(normalizeDraft(42)).toBeNull();
  });

  it('keeps a draft that lost its timestamp or path', () => {
    expect(normalizeDraft(draftOf({ updatedAt: 'yesterday' }))).toMatchObject({ updatedAt: 0, project });
    expect(normalizeDraft(draftOf({ updatedAt: 0 }))).toMatchObject({ updatedAt: 0 });
    expect(normalizeDraft(draftOf({ filePath: '' }))).toMatchObject({ filePath: null });
    expect(normalizeDraft(draftOf({ filePath: 7 }))).toMatchObject({ filePath: null });
    expect(normalizeDraft({ version: DRAFT_VERSION, project })).toMatchObject({
      updatedAt: 0,
      filePath: null,
      project,
    });
  });
});

describe('draftIsRestorable', () => {
  it('offers work that differs from the project on screen', () => {
    const edited = { ...project, name: 'Diels-Alder TS (rerun)' };
    expect(draftIsRestorable(draftOf({ project: edited }), project)).toBe(true);
  });

  it('stays quiet when the draft is the project already loaded', () => {
    expect(draftIsRestorable(draftOf(), project)).toBe(false);
  });

  it('compares by content, not by key order', () => {
    const reordered = {
      edges: project.edges,
      nodes: project.nodes,
      defaults: { basis: 'def2-SVP', method: 'B3LYP' },
      name: project.name,
      schemaVersion: 3,
    };
    expect(draftIsRestorable(draftOf({ project: reordered }), project)).toBe(false);
  });

  it('notices a change buried in a node', () => {
    const edited = {
      ...project,
      nodes: [{ ...project.nodes[0], x: 41 }, project.nodes[1]],
    };
    expect(draftIsRestorable(draftOf({ project: edited }), project)).toBe(true);
  });

  it('offers a draft when no project was loaded at all', () => {
    expect(draftIsRestorable(draftOf(), null)).toBe(true);
    expect(draftIsRestorable(draftOf(), undefined)).toBe(true);
  });

  it('ignores corrupt drafts', () => {
    expect(draftIsRestorable(null, project)).toBe(false);
    expect(draftIsRestorable('{', project)).toBe(false);
    expect(draftIsRestorable(draftOf({ version: 9 }), project)).toBe(false);
  });

  it('accepts the raw string the renderer reads back out of storage', () => {
    expect(draftIsRestorable(JSON.stringify(draftOf({ project: { ...project, name: 'other' } })), project)).toBe(true);
  });
});

describe('draftAgeLabel', () => {
  const now = local(2026, 11, 7, 18, 0);

  it('shows the local clock time for a draft from today', () => {
    expect(draftAgeLabel(local(2026, 11, 7, 14, 5), now)).toBe('14:05');
    expect(draftAgeLabel(local(2026, 11, 7, 9, 7), now)).toBe('09:07');
  });

  it('says yesterday, including across a month boundary', () => {
    expect(draftAgeLabel(local(2026, 11, 6, 23, 41), now)).toBe('yesterday at 23:41');
    expect(draftAgeLabel(local(2026, 10, 31, 22, 5), local(2026, 11, 1, 0, 10))).toBe('yesterday at 22:05');
  });

  it('adds the month and day within the same year', () => {
    expect(draftAgeLabel(local(2026, 3, 3, 9, 7), now)).toBe('Mar 3 at 09:07');
  });

  it('adds the full date from an earlier year', () => {
    expect(draftAgeLabel(local(2025, 12, 31, 23, 0), local(2026, 1, 2, 8, 0))).toBe('2025-12-31 at 23:00');
  });

  it('degrades to a readable phrase without a timestamp', () => {
    expect(draftAgeLabel(0, now)).toBe('an unknown time');
    expect(draftAgeLabel(-1, now)).toBe('an unknown time');
    expect(draftAgeLabel(Number.NaN, now)).toBe('an unknown time');
    expect(draftAgeLabel('not a date', now)).toBe('an unknown time');
    expect(draftAgeLabel(undefined, now)).toBe('an unknown time');
  });

  it('defaults to now when the caller has no clock', () => {
    expect(typeof draftAgeLabel(Date.now())).toBe('string');
  });
});
