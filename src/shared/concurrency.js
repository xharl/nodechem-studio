/**
 * A small bounded-concurrency map, and the yield that keeps a long report from
 * owning the main process.
 *
 * The report loaders read one `run.json` and maybe one `.cube` per task. An
 * unbounded `Promise.all` would start every file read at once (a hundred open
 * descriptors and a burst of memory for the largest cube); a serial `for await`
 * leaves the disk idle between reads. This runs at most `concurrency` mappers
 * at a time and preserves input order in the result, so the caller can attach
 * the results to tasks in the same order a serial loop would.
 *
 * Every mapper is followed by a macrotask turn. File reads already yield, but
 * `JSON.parse` and `parseCube` are synchronous and would otherwise run back to
 * back for seconds: a yield lets Electron deliver window events and progress
 * IPC between items, at a cost of one turn per task.
 */

import os from 'node:os';

/** Reads are I/O, not work: enough to keep the disk busy, not enough to flood it. */
export const DEFAULT_CONCURRENCY = Math.max(
  2,
  Math.min(8, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length),
);

/** One macrotask turn, so pending timers, IPC and resize events run. */
export function yieldToEventLoop() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * Map `items` with at most `concurrency` calls in flight, preserving order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R> | R} mapper
 * @param {{concurrency?: number, yieldBetween?: boolean}} [options]
 * @returns {Promise<R[]>}
 */
export async function mapConcurrent(items, mapper, { concurrency = DEFAULT_CONCURRENCY, yieldBetween = true } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const requested = Number(concurrency);
  const width = Math.max(
    1,
    Math.min(
      list.length,
      Number.isFinite(requested) ? Math.floor(requested) : list.length,
    ),
  );
  const results = new Array(list.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
      if (yieldBetween) await yieldToEventLoop();
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
