import { describe, expect, it } from 'vitest';
import {
  changedSince,
  diffProjects,
  edgeKey,
  fingerprint,
  mergeProjects,
  writeGuardDecision,
} from '../src/shared/projectMerge.js';

const node = (id, extra = {}) => ({
  id,
  type: 'calculate',
  kind: 'Opt',
  title: id,
  settings: { jobType: 'Opt', method: 'B3LYP', basis: 'def2-SVP' },
  position: { x: 100, y: 100 },
  ...extra,
});

const edge = (from, to) => ({ from, to, type: 'dependency' });

function project(nodes, edges = []) {
  return {
    schemaVersion: 3,
    name: 'Test project',
    defaults: { engine: 'gaussian' },
    molecule: { charge: 0, multiplicity: 1, coords: [] },
    nodes,
    edges,
  };
}

const base = project([node('a'), node('b')], [edge('a', 'b')]);

describe('diff', () => {
  it('reports nodes added, removed and changed', () => {
    const other = project(
      [node('a', { title: 'renamed' }), node('c')],
      [],
    );
    const diff = diffProjects(base, other);
    expect(diff.nodes.added).toEqual(['c']);
    expect(diff.nodes.removed).toEqual(['b']);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0].id).toBe('a');
    expect(diff.nodes.changed[0].fields[0]).toMatchObject({ field: 'title', before: 'a', after: 'renamed' });
    expect(diff.edges.added).toEqual([]);
    expect(diff.edges.removed).toEqual(['a->b:dependency']);
    expect(diff.empty).toBe(false);
  });

  it('is empty when nothing changed', () => {
    expect(diffProjects(base, JSON.parse(JSON.stringify(base))).empty).toBe(true);
  });

  it('keyes edges by direction, type and branch', () => {
    expect(edgeKey({ from: 'a', to: 'b', type: 'checkpoint', branch: 'yes' }))
      .toBe('a->b:checkpoint:yes');
  });
});

describe('three-way merge', () => {
  it('merges edits to different nodes', () => {
    const ours = project([node('a', { title: 'ours' }), node('b')], [edge('a', 'b')]);
    const theirs = project([node('a'), node('b', { title: 'theirs' })], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.project.nodes.find((n) => n.id === 'a').title).toBe('ours');
    expect(result.project.nodes.find((n) => n.id === 'b').title).toBe('theirs');
  });

  it('merges edits to different fields of the same node', () => {
    const ours = project([node('a', { title: 'ours' }), node('b')], [edge('a', 'b')]);
    const theirs = project([node('a', { settings: { jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP' } }), node('b')], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(true);
    const merged = result.project.nodes.find((n) => n.id === 'a');
    expect(merged.title).toBe('ours');
    expect(merged.settings.jobType).toBe('SP');
  });

  it('refuses two different edits to the same field, naming the path', () => {
    const ours = project([node('a', { title: 'ours' }), node('b')], [edge('a', 'b')]);
    const theirs = project([node('a', { title: 'theirs' }), node('b')], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: 'node-field',
      id: 'a',
      path: 'a.title',
      base: 'a',
      ours: 'ours',
      theirs: 'theirs',
    });
  });

  it('takes an identical change made on both sides', () => {
    const ours = project([node('a', { title: 'same' }), node('b')], [edge('a', 'b')]);
    const theirs = project([node('a', { title: 'same' }), node('b')], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.project.nodes.find((n) => n.id === 'a').title).toBe('same');
  });

  it('keeps a node added on one side', () => {
    const ours = project([node('a'), node('b'), node('c')], [edge('a', 'b')]);
    const theirs = project([node('a'), node('b')], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.project.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('refuses the same id added with different content on both sides', () => {
    const ours = project([node('a'), node('b'), node('c', { title: 'ours' })], [edge('a', 'b')]);
    const theirs = project([node('a'), node('b'), node('c', { title: 'theirs' })], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]).toMatchObject({ kind: 'node-field', path: 'c.title' });
  });

  it('refuses a delete on one side against an edit on the other', () => {
    const ours = project([node('a')], []); // b deleted
    const theirs = project([node('a'), node('b', { title: 'edited' })], [edge('a', 'b')]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts.some((conflict) => conflict.kind === 'node-deleted-by-ours' && conflict.id === 'b')).toBe(true);
  });

  it('merges edges added on different sides', () => {
    const ours = project([node('a'), node('b')], [edge('a', 'b'), { from: 'b', to: 'a', type: 'dependency' }]);
    const theirs = project([node('a'), node('b')], [edge('a', 'b'), { from: 'a', to: 'b', type: 'checkpoint' }]);
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.project.edges.map(edgeKey).sort()).toEqual(['a->b:checkpoint', 'a->b:dependency', 'b->a:dependency']);
  });

  it('merges a top-level field changed on one side only', () => {
    const ours = { ...base, name: 'Renamed' };
    const theirs = JSON.parse(JSON.stringify(base));
    const result = mergeProjects(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.project.name).toBe('Renamed');
  });
});

describe('fingerprint', () => {
  it('is stable for identical text and changes with content', () => {
    const first = fingerprint('{"a":1}');
    expect(fingerprint('{"a":1}')).toEqual(first);
    expect(fingerprint('{"a":2}').sha256).not.toBe(first.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bytes).toBe(7);
  });

  it('allows the first write and refuses a file that moved under us', () => {
    const text = JSON.stringify(base);
    const known = fingerprint(text);
    expect(writeGuardDecision(known, text)).toEqual({ allow: true, reason: 'unchanged' });
    expect(writeGuardDecision(known, 'different')).toEqual({ allow: false, reason: 'changed-on-disk' });
    expect(writeGuardDecision(null, 'anything')).toEqual({ allow: true, reason: 'no-baseline' });
    expect(writeGuardDecision(known, null)).toEqual({ allow: true, reason: 'new-file' });
  });

  it('detects a file that changed since it was read', () => {
    const before = fingerprint(JSON.stringify(base));
    expect(changedSince(before, JSON.stringify(base))).toBe(false);
    expect(changedSince(before, JSON.stringify({ ...base, name: 'Other' }))).toBe(true);
    expect(changedSince(null, 'anything')).toBe(false);
  });
});
