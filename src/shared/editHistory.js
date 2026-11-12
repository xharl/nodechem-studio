/**
 * Undo/redo history for the project document.
 *
 * The renderer keeps one JSON snapshot per committed edit. This module is the
 * pure bookkeeping: it decides whether a snapshot is a new step, what the undo
 * and redo stacks become, and it never returns a document it did not receive.
 *
 * Why whole-document snapshots rather than inverse operations: the project is
 * a bounded JSON document (a graph the user can see), and an inverse-operation
 * system has to know about every mutation site. A snapshot cannot drift out of
 * sync with the schema, which is the failure mode that loses work.
 *
 * `last` is the snapshot currently on screen. A caller records after a mutation
 * and applies what `undoStep`/`redoStep` return.
 *
 * Retention is bounded by both entry count and bytes. A count-only cap lets a
 * handful of large snapshots hold gigabytes; the byte cap drops the oldest
 * steps first, so the recent work — the part a person actually undoes — stays.
 */

export const DEFAULT_HISTORY_LIMIT = 100;
// 32 MB of UTF-16 code units, which is a close lower bound on the JSON's byte
// size and cheap to measure (string.length is O(1)).
export const DEFAULT_HISTORY_MAX_BYTES = 32 * 1024 * 1024;

export function createHistory(snapshot = null, {
  limit = DEFAULT_HISTORY_LIMIT,
  maxBytes = DEFAULT_HISTORY_MAX_BYTES,
} = {}) {
  return Object.freeze({
    undoStack: Object.freeze([]),
    redoStack: Object.freeze([]),
    last: typeof snapshot === 'string' ? snapshot : null,
    limit: Math.max(1, Math.floor(Number(limit) || DEFAULT_HISTORY_LIMIT)),
    maxBytes: Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_HISTORY_MAX_BYTES)),
  });
}

/** Drop the oldest steps until the stack fits the entry and byte caps. */
function trimUndoStack(stack, limit, maxBytes, lastSize) {
  let start = Math.max(0, stack.length - limit);
  let total = lastSize;
  for (let index = start; index < stack.length; index += 1) total += stack[index].length;
  while (start < stack.length && total > maxBytes) {
    total -= stack[start].length;
    start += 1;
  }
  return start > 0 ? stack.slice(start) : stack;
}

/**
 * Record the state now on screen. Returns the same history object when the
 * snapshot is identical, so a render pass cannot create an empty undo step.
 */
export function recordSnapshot(history, snapshot) {
  if (typeof snapshot !== 'string') return history;
  if (history.last === null) {
    return { ...history, last: snapshot };
  }
  if (snapshot === history.last) return history;
  const undoStack = trimUndoStack(
    [...history.undoStack, history.last],
    history.limit,
    history.maxBytes,
    snapshot.length,
  );
  return { ...history, undoStack, redoStack: [], last: snapshot };
}

/** The snapshot to restore, or `null` when there is nothing to undo. */
export function undoStep(history) {
  if (!history || history.undoStack.length === 0) return { history, snapshot: null };
  const snapshot = history.undoStack[history.undoStack.length - 1];
  const undoStack = history.undoStack.slice(0, -1);
  const redoStack = history.last === null ? history.redoStack : [...history.redoStack, history.last];
  return { history: { ...history, undoStack, redoStack, last: snapshot }, snapshot };
}

/** The snapshot to restore, or `null` when there is nothing to redo. */
export function redoStep(history) {
  if (!history || history.redoStack.length === 0) return { history, snapshot: null };
  const snapshot = history.redoStack[history.redoStack.length - 1];
  const redoStack = history.redoStack.slice(0, -1);
  const undoStack = history.last === null ? history.undoStack : [...history.undoStack, history.last];
  return { history: { ...history, undoStack, redoStack, last: snapshot }, snapshot };
}

export function canUndo(history) {
  return Boolean(history && history.undoStack.length > 0);
}

export function canRedo(history) {
  return Boolean(history && history.redoStack.length > 0);
}

/** Human-readable stack sizes, for the status bar and tests. */
export function historyDepth(history) {
  return {
    undo: history?.undoStack?.length ?? 0,
    redo: history?.redoStack?.length ?? 0,
  };
}
