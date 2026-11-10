/**
 * The `ncs run` watch clock (issue 305).
 *
 * Two different limits exist and only one of them belongs to the watcher:
 *
 *   - `runner.timeoutSeconds` is a **per-task** budget, enforced inside the
 *     queue around each engine process. A project that allows 12 hours for an
 *     `Opt Freq` says so here.
 *   - `--timeout` is how long the CLI waits for the whole queue to finish.
 *
 * Deriving the second from nothing but a 3600 s default made the first
 * unenforceable: a healthy 84-atom SCF was killed at one hour and the message
 * blamed the queue. The watcher therefore has **no deadline unless `--timeout`
 * is given**; the task budgets are the queue's job, and a stopped wait is
 * reported as exactly that.
 */

/**
 * Resolve the watcher's limit.
 *
 * Returns `seconds: null` when nothing should stop the wait — which is the
 * normal case, because the queue enforces its own per-task limits.
 */
export function watchLimitFor({
  explicitTimeoutSeconds = null,
  projectTimeoutSeconds = null,
  taskCount = 0,
} = {}) {
  const project = Number(projectTimeoutSeconds);
  const context = {
    projectTimeoutSeconds: Number.isFinite(project) && project > 0 ? project : null,
    taskCount: Number.isInteger(taskCount) && taskCount > 0 ? taskCount : 0,
  };
  const raw = explicitTimeoutSeconds;
  if (raw === null || raw === undefined || raw === '') {
    return { seconds: null, source: 'none', ...context };
  }
  // `--timeout` with no value arrives as `true`; Number(true) is 1, which would
  // silently become a one-second deadline.
  const seconds = typeof raw === 'boolean' ? Number.NaN : Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error('--timeout must be a positive whole number of seconds.');
  }
  return { seconds, source: 'flag', ...context };
}

/**
 * The message a stopped wait leaves behind.
 *
 * It names the clock that fired, which block was in flight, and — when the
 * project declares a budget — the exact re-run that would let the job finish.
 * "The queue did not finish" was the old text: true, unhelpful, and it blamed
 * the queue for a decision the watcher made.
 */
export function watchExpiryMessage({
  seconds,
  runningTask = null,
  taskIndex = null,
  projectTimeoutSeconds = null,
} = {}) {
  const where = runningTask
    ? `while block ${taskIndex} (${runningTask}) was running`
    : 'with no block running';
  const budget = Number(projectTimeoutSeconds);
  const hint = Number.isFinite(budget) && budget > 0
    ? ` Re-run with --timeout ${budget} (the project's runner.timeoutSeconds) to let it finish.`
    : '';
  return `--timeout ${seconds} elapsed ${where}; the queue was stopped and the task is recorded as interrupted.${hint}`;
}
