import { describe, it, expect } from 'vitest';
import { watchExpiryMessage, watchLimitFor } from '../src/shared/watchLimit.js';

/**
 * Issue 305: the `ncs run` watch clock must not be derived from a 3600 s
 * default. A project's `runner.timeoutSeconds` is a per-task budget the queue
 * enforces itself; the watcher only stops when `--timeout` says so.
 */
describe('the ncs run watch clock (issue 305)', () => {
  it('waits indefinitely when no --timeout is given, whatever the project budget is', () => {
    for (const projectTimeoutSeconds of [null, 0, 3600, 43200]) {
      const watch = watchLimitFor({ projectTimeoutSeconds });
      expect(watch.seconds).toBe(null);
      expect(watch.source).toBe('none');
    }
    // The project budget travels for the message, never as a deadline.
    expect(watchLimitFor({ projectTimeoutSeconds: 43200 }).projectTimeoutSeconds).toBe(43200);
  });

  it('lets an explicit --timeout win', () => {
    const watch = watchLimitFor({ explicitTimeoutSeconds: 120, projectTimeoutSeconds: 43200 });
    expect(watch.seconds).toBe(120);
    expect(watch.source).toBe('flag');
  });

  it('refuses a --timeout that is not a positive whole number of seconds', () => {
    for (const bad of [0, -5, 1.5, 'soon', true]) {
      expect(() => watchLimitFor({ explicitTimeoutSeconds: bad }))
        .toThrow(/positive whole number of seconds/);
    }
  });

  it('names the flag, the block in flight and the re-run that would let it finish', () => {
    const message = watchExpiryMessage({
      seconds: 3600,
      runningTask: 'Opt Freq',
      taskIndex: 4,
      projectTimeoutSeconds: 43200,
    });
    expect(message).toContain('--timeout 3600');
    expect(message).toContain('block 4 (Opt Freq)');
    expect(message).toContain('interrupted');
    expect(message).toContain('Re-run with --timeout 43200');
    expect(message).toContain("runner.timeoutSeconds");
    // It must not blame the queue for a decision the watcher made.
    expect(message).not.toMatch(/the queue did not finish/);
  });

  it('says so when nothing was running and there is no project budget', () => {
    const message = watchExpiryMessage({ seconds: 60 });
    expect(message).toContain('with no block running');
    expect(message).not.toContain('Re-run with');
  });
});
