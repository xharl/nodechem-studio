/**
 * Structural diff and three-way merge for `.ncs` project files.
 *
 * A `.ncs` document is JSON with stable identifiers per node, so a merge can be
 * keyed by node id instead of by text: adding a block on one side and editing
 * another block on the other side is not a conflict, while editing the same
 * block on both sides is. Nothing here guesses — an overlapping change is
 * reported and the merge refuses, rather than silently picking a side.
 */

import { createHash } from 'node:crypto';

const NODE_FIELDS = Object.freeze(['type', 'kind', 'title', 'settings', 'condition', 'loop', 'merge', 'position']);
const META_FIELDS = Object.freeze(['name', 'defaults', 'molecule']);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const same = (a, b) => stable(a) === stable(b);

export function edgeKey(edge) {
  return `${edge.from}->${edge.to}:${edge.type || 'dependency'}${edge.branch ? `:${edge.branch}` : ''}`;
}

function nodeMap(project) {
  const map = new Map();
  for (const node of Array.isArray(project?.nodes) ? project.nodes : []) {
    if (node && node.id) map.set(String(node.id), node);
  }
  return map;
}

function edgeMap(project) {
  const map = new Map();
  for (const edge of Array.isArray(project?.edges) ? project.edges : []) {
    if (edge && edge.from && edge.to) map.set(edgeKey(edge), edge);
  }
  return map;
}

/** Field-level differences between two versions of one object. */
function changedFields(before, after) {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const field of fields) {
    if (!same(before?.[field], after?.[field])) {
      out.push({ field, before: before?.[field] ?? null, after: after?.[field] ?? null });
    }
  }
  return out;
}

/**
 * `diffProjects(base, other)` describes what `other` changed relative to
 * `base`. Passing `null` as the base treats every node as added.
 */
export function diffProjects(base, other) {
  const baseNodes = nodeMap(base);
  const otherNodes = nodeMap(other);
  const baseEdges = edgeMap(base);
  const otherEdges = edgeMap(other);

  const added = [];
  const removed = [];
  const changed = [];
  for (const id of otherNodes.keys()) {
    if (!baseNodes.has(id)) {
      added.push(id);
      continue;
    }
    const fields = changedFields(baseNodes.get(id), otherNodes.get(id)).filter((entry) => NODE_FIELDS.includes(entry.field));
    if (fields.length > 0) changed.push({ id, fields });
  }
  for (const id of baseNodes.keys()) if (!otherNodes.has(id)) removed.push(id);

  const edgesAdded = [...otherEdges.keys()].filter((key) => !baseEdges.has(key));
  const edgesRemoved = [...baseEdges.keys()].filter((key) => !otherEdges.has(key));

  const meta = META_FIELDS.map((field) => ({ field, base: base?.[field] ?? null, other: other?.[field] ?? null }))
    .filter((entry) => !same(entry.base, entry.other));

  return {
    nodes: { added, removed, changed },
    edges: { added: edgesAdded, removed: edgesRemoved },
    meta,
    empty: added.length === 0 && removed.length === 0 && changed.length === 0
      && edgesAdded.length === 0 && edgesRemoved.length === 0 && meta.length === 0,
  };
}

/** Merge one value three ways. Returns `{ value }` or `{ conflict }`. */
function mergeValue(base, ours, theirs) {
  if (same(ours, theirs)) return { value: ours };
  if (same(base, ours)) return { value: theirs };
  if (same(base, theirs)) return { value: ours };
  return { conflict: { base: base ?? null, ours: ours ?? null, theirs: theirs ?? null } };
}

/**
 * `mergeProjects(base, ours, theirs)` returns `{ ok: true, project }` when the
 * two sides changed different things, or `{ ok: false, conflicts }` with one
 * entry per node, edge or top-level field that both sides changed differently.
 */
export function mergeProjects(base, ours, theirs) {
  const conflicts = [];
  const baseNodes = nodeMap(base);
  const ourNodes = nodeMap(ours);
  const theirNodes = nodeMap(theirs);

  const ids = new Set([...baseNodes.keys(), ...ourNodes.keys(), ...theirNodes.keys()]);
  const mergedNodes = [];
  for (const id of ids) {
    const b = baseNodes.get(id) || null;
    const o = ourNodes.get(id) || null;
    const t = theirNodes.get(id) || null;

    // A node present on one side only is an add or a delete, not a field edit.
    if (!o || !t) {
      const result = mergeValue(b, o, t);
      if (result.conflict) {
        conflicts.push({ kind: o ? 'node-deleted-by-theirs' : 'node-deleted-by-ours', id, ...result.conflict });
        continue;
      }
      if (result.value) mergedNodes.push(result.value);
      continue;
    }

    // Both sides kept the node: merge field by field, so an edit to `title` on
    // one side and to `settings` on the other is not a conflict.
    const fields = new Set([...Object.keys(b || {}), ...Object.keys(o), ...Object.keys(t)]);
    const merged = {};
    let nodeConflicts = 0;
    for (const field of fields) {
      const result = mergeValue(b?.[field], o[field], t[field]);
      if (result.conflict) {
        nodeConflicts += 1;
        conflicts.push({ kind: 'node-field', id, path: `${id}.${field}`, ...result.conflict });
        continue;
      }
      if (result.value !== undefined) merged[field] = result.value;
    }
    if (nodeConflicts === 0) mergedNodes.push(merged);
  }

  const baseEdges = edgeMap(base);
  const ourEdges = edgeMap(ours);
  const theirEdges = edgeMap(theirs);
  const edgeKeys = new Set([...baseEdges.keys(), ...ourEdges.keys(), ...theirEdges.keys()]);
  const mergedEdges = [];
  for (const key of edgeKeys) {
    const result = mergeValue(baseEdges.get(key) || null, ourEdges.get(key) || null, theirEdges.get(key) || null);
    if (result.conflict) {
      conflicts.push({ kind: 'edge', id: key, ...result.conflict });
      continue;
    }
    if (result.value) mergedEdges.push(result.value);
  }

  const merged = { ...(ours || {}) };
  for (const field of META_FIELDS) {
    const result = mergeValue(base?.[field], ours?.[field], theirs?.[field]);
    if (result.conflict) {
      conflicts.push({ kind: 'field', id: field, ...result.conflict });
      continue;
    }
    if (result.value === undefined || result.value === null) delete merged[field];
    else merged[field] = result.value;
  }

  // Keep the order the two sides already agree on: ours first, then anything
  // that only theirs contains, so a merge does not shuffle the canvas.
  const ordered = [];
  const seen = new Set();
  for (const node of [...(ours?.nodes || []), ...(theirs?.nodes || [])]) {
    if (!node?.id || seen.has(node.id)) continue;
    if (mergedNodes.some((entry) => entry.id === node.id)) {
      ordered.push(mergedNodes.find((entry) => entry.id === node.id));
      seen.add(node.id);
    }
  }
  for (const node of mergedNodes) if (!seen.has(node.id)) ordered.push(node);

  merged.nodes = ordered;
  merged.edges = mergedEdges;
  if (conflicts.length > 0) return { ok: false, conflicts, project: null };
  return { ok: true, conflicts: [], project: merged };
}

/**
 * Content fingerprint used to detect a file that changed underneath us on a
 * network share. The hash is of the exact bytes written, so an mtime-only
 * touch is not reported as a concurrent edit.
 */
export function fingerprint(text) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
  };
}

/** True when `currentText` no longer matches the fingerprint taken earlier. */
export function changedSince(expected, currentText) {
  if (!expected || !expected.sha256) return false;
  return fingerprint(currentText).sha256 !== expected.sha256;
}

/**
 * The decision the app makes before overwriting a project file it did not
 * necessarily still own. `known` is the fingerprint of the bytes this process
 * last read or wrote; `currentText` is what is on disk now (null when there is
 * no file yet). The I/O stays in the caller so this rule is testable.
 */
export function writeGuardDecision(known, currentText) {
  if (!known || !known.sha256) return { allow: true, reason: 'no-baseline' };
  if (currentText === null || currentText === undefined) return { allow: true, reason: 'new-file' };
  if (!changedSince(known, currentText)) return { allow: true, reason: 'unchanged' };
  return { allow: false, reason: 'changed-on-disk' };
}
