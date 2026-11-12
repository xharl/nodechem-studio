/**
 * Coalesce a burst of renderer events into one paint (issue 374).
 *
 * A queue emits one event per task transition and, while a task runs, one per
 * output chunk. Applying each event as it arrived rebuilt the queue list and
 * the whole canvas for every line of an xTB banner, so a four-molecule screen
 * held about 90 % of one core for three seconds after the chemistry itself had
 * finished.
 *
 * The contract here is narrow on purpose: the latest value wins, the handler
 * runs at most once per frame, and a scheduled flush still runs when the window
 * is hidden and animation frames are throttled. Nothing is dropped silently —
 * every push either joins the pending batch or starts a new frame.
 */

/** Longest wait before a throttled animation frame is replaced by a timer. */
export const FRAME_FALLBACK_MS = 50;

/**
 * Run `callback` on the next animation frame, or after `delay` ms when frames
 * are throttled or unavailable (a hidden window is the common case).
 *
 * @param {() => void} callback
 * @param {object} [options]
 * @param {number} [options.delay] Timer fallback in milliseconds.
 * @param {((run: () => void) => unknown)|null} [options.requestFrame]
 * @param {((id: unknown) => void)|null} [options.cancelFrame]
 * @param {(run: () => void, delay: number) => unknown} [options.setTimer]
 * @param {(id: unknown) => void} [options.clearTimer]
 * @returns {() => void} Cancels the pending run.
 */
export function frameSchedule(callback, {
  delay = FRAME_FALLBACK_MS,
  requestFrame = typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : null,
  cancelFrame = typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : null,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  let settled = false;
  let frameId = null;
  let timerId = null;

  const fire = () => {
    if (settled) return;
    settled = true;
    if (frameId !== null && cancelFrame) cancelFrame(frameId);
    if (timerId !== null) clearTimer(timerId);
    callback();
  };

  if (requestFrame) frameId = requestFrame(fire);
  // The timer is not only a fallback for a missing animation frame: Electron
  // pauses requestAnimationFrame in a hidden or minimised window, and a queue
  // that finishes there must still reach the console. Whichever fires first
  // cancels the other.
  timerId = setTimer(fire, delay);

  return () => {
    if (settled) return;
    settled = true;
    if (frameId !== null && cancelFrame) cancelFrame(frameId);
    if (timerId !== null) clearTimer(timerId);
  };
}

/**
 * Keep only the latest pushed value and hand it to `handle` once per frame.
 *
 * @template T
 * @param {(value: T) => void} handle
 * @param {{schedule?: (run: () => void) => (() => void)}} [options]
 */
export function createFrameCoalescer(handle, { schedule = frameSchedule } = {}) {
  let latest;
  let hasLatest = false;
  let cancel = null;

  const flush = () => {
    cancel = null;
    if (!hasLatest) return false;
    const value = latest;
    latest = undefined;
    hasLatest = false;
    handle(value);
    return true;
  };

  return {
    push(value) {
      latest = value;
      hasLatest = true;
      if (!cancel) cancel = schedule(flush);
    },
    /** Apply the pending value now; returns whether one was waiting. */
    flushNow() {
      if (cancel) {
        cancel();
        cancel = null;
      }
      return flush();
    },
    get pending() {
      return hasLatest;
    },
  };
}

/**
 * A queue batch is the latest queue snapshot plus the one-shot event types a
 * frame happened to contain. `queue-started` and `queue-done` keep their flag
 * even when a later event arrives in the same frame, so the console's start and
 * end side effects are never skipped by coalescing.
 */
export function createQueueBatch() {
  return { queue: null, type: null, started: false, done: false, count: 0 };
}

/**
 * Fold one queue event into a batch. The queue snapshot is replaced by the
 * newest one; flags are sticky; `count` records how many events the batch
 * represents, which is what the caller reports as "not dropped".
 *
 * @param {ReturnType<typeof createQueueBatch>|null} batch
 * @param {{type?: string, queue?: object}} event
 */
export function mergeQueueEvent(batch, event) {
  if (!event || typeof event !== 'object') return batch;
  const next = batch || createQueueBatch();
  next.count += 1;
  if (event.queue) {
    next.queue = event.queue;
    next.type = typeof event.type === 'string' ? event.type : next.type;
  }
  if (event.type === 'queue-started') next.started = true;
  if (event.type === 'queue-done') next.done = true;
  return next;
}

/**
 * Coalesce queue events into one `apply(batch)` per frame.
 *
 * The batch is cleared *before* `apply` runs, so an event pushed from inside
 * the handler starts a fresh frame instead of being lost.
 *
 * @param {(batch: ReturnType<typeof createQueueBatch>) => void} apply
 * @param {{schedule?: (run: () => void) => (() => void)}} [options]
 */
export function createQueueEventCoalescer(apply, { schedule = frameSchedule } = {}) {
  let batch = null;
  let cancel = null;

  const flush = () => {
    cancel = null;
    if (!batch) return false;
    const value = batch;
    batch = null;
    apply(value);
    return true;
  };

  return {
    push(event) {
      if (!event) return;
      batch = mergeQueueEvent(batch, event);
      if (!cancel) cancel = schedule(flush);
    },
    /** Apply the pending batch now; returns whether one was waiting. */
    flushNow() {
      if (cancel) {
        cancel();
        cancel = null;
      }
      return flush();
    },
    get pending() {
      return batch !== null;
    },
  };
}

/**
 * What the canvas reads from the queue, for deciding whether a queue update
 * needs `renderGraph()`.
 *
 * `syncNodeStatesFromQueue` only reports a change when a block becomes decided
 * (`passed`, `review`, `blocked`, `timed out`). A card also follows a task's
 * live status and gate verdict, and a flow tab follows the queue's own status;
 * those change a handful of times per run, while progress ticks and output
 * chunks change them not at all. Comparing this signature lets the renderer
 * keep the live rail honest and still skip the canvas rebuild for the ticks.
 *
 * @param {{status?: string, tasks?: Array<{nodeId?: string, status?: string, gateVerdict?: string|null, timeout?: object}>}|null} queue
 */
export function queueGraphSignature(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  let signature = String(queue?.status ?? '');
  for (const task of tasks) {
    // `~` separates the fields because a node id is validated against
    // [A-Za-z0-9._-] and a status is a fixed word; neither can contain it.
    signature += `\n${task?.nodeId ?? ''}~${task?.status ?? ''}~${task?.gateVerdict ?? ''}~${task?.timeout ? '1' : ''}`;
  }
  return signature;
}
