import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  createHistory,
  historyDepth,
  recordSnapshot,
  redoStep,
  undoStep,
} from '../src/shared/editHistory.js';

describe('edit history', () => {
  it('seeds the first snapshot without creating an undo step', () => {
    const history = createHistory('{"a":1}');
    expect(history.last).toBe('{"a":1}');
    expect(canUndo(history)).toBe(false);
    expect(historyDepth(history)).toEqual({ undo: 0, redo: 0 });
  });

  it('records a changed document as one undo step', () => {
    let history = createHistory('one');
    history = recordSnapshot(history, 'two');
    expect(canUndo(history)).toBe(true);
    expect(history.undoStack).toEqual(['one']);
  });

  it('does not record a render that changed nothing', () => {
    let history = createHistory('one');
    const before = history;
    history = recordSnapshot(history, 'one');
    expect(history).toBe(before);
    expect(canUndo(history)).toBe(false);
  });

  it('walks back and forward through several edits', () => {
    let history = createHistory('v1');
    history = recordSnapshot(history, 'v2');
    history = recordSnapshot(history, 'v3');

    const first = undoStep(history);
    expect(first.snapshot).toBe('v2');
    history = first.history;
    expect(history.last).toBe('v2');

    const second = undoStep(history);
    expect(second.snapshot).toBe('v1');
    history = second.history;
    expect(canUndo(history)).toBe(false);

    const forward = redoStep(history);
    expect(forward.snapshot).toBe('v2');
    history = forward.history;
    expect(canRedo(history)).toBe(true);
  });

  it('drops the redo stack as soon as a new edit is recorded', () => {
    let history = createHistory('v1');
    history = recordSnapshot(history, 'v2');
    history = undoStep(history).history;
    expect(canRedo(history)).toBe(true);
    history = recordSnapshot(history, 'v3');
    expect(canRedo(history)).toBe(false);
    expect(history.undoStack).toEqual(['v1']);
  });

  it('returns null instead of a snapshot when there is nothing to undo or redo', () => {
    const history = createHistory('one');
    expect(undoStep(history).snapshot).toBeNull();
    expect(redoStep(history).snapshot).toBeNull();
    expect(undoStep(null).snapshot).toBeNull();
    expect(redoStep(undefined).snapshot).toBeNull();
  });

  it('keeps the stack bounded', () => {
    let history = createHistory('v0', { limit: 3 });
    for (let index = 1; index <= 10; index += 1) {
      history = recordSnapshot(history, `v${index}`);
    }
    expect(history.undoStack).toHaveLength(3);
    expect(history.undoStack[2]).toBe('v9');
    expect(history.last).toBe('v10');
  });

  it('bounds retention by bytes, dropping the oldest steps first', () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    const cap = 3 * 1024 * 1024;
    let history = createHistory(`v0${megabyte}`, { limit: 100, maxBytes: cap });
    for (let index = 1; index <= 6; index += 1) {
      history = recordSnapshot(history, `v${index}${megabyte}`);
    }

    const total = history.last.length
      + history.undoStack.reduce((sum, snapshot) => sum + snapshot.length, 0);
    expect(total).toBeLessThanOrEqual(cap);
    // The recent steps survive; the oldest ones are the ones dropped.
    expect(history.undoStack.at(-1)).toBe(`v5${megabyte}`);
    expect(history.undoStack).not.toContain(`v0${megabyte}`);
    expect(history.maxBytes).toBe(cap);
  });

  it('ignores non-string snapshots', () => {
    const history = createHistory('one');
    expect(recordSnapshot(history, null)).toBe(history);
    expect(recordSnapshot(history, 42)).toBe(history);
  });
});
