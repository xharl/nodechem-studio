import fsp from 'node:fs/promises';

/**
 * Remove a temporary tree without losing the run to a cleanup race.
 *
 * Many suites start a queue and delete its folder in `afterAll`. On a loaded
 * runner — and on Windows, where a just-closed handle lingers — the first rmdir
 * finds a directory the queue is still writing to and throws `ENOTEMPTY`/`EBUSY`.
 * That is a cleanup race, not a product failure, so retry briefly instead of
 * turning a green suite red.
 */
export async function rmrf(target) {
  if (!target) return;
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** `rmrf` every path in a list (the `roots` array most suites keep). */
export async function rmrfAll(targets) {
  await Promise.all((targets || []).map((target) => rmrf(target)));
}
