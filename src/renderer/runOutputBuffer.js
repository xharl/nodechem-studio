/**
 * Bounded append buffer for the run log (issue 374).
 *
 * `appendRunOutput` used to rebuild the whole 60 kB string and reassign
 * `textContent` for every chunk. A single xTB banner is 2–4 kB per task, so a
 * screen run rewrote the log dozens of times for output the user cannot read
 * that fast.
 *
 * This buffer keeps appends cheap: chunks wait in an array until the next
 * frame, and `flush()` returns only the new text plus the number of leading
 * characters the limit dropped. The caller removes those characters from the
 * oldest text node instead of replacing the element, so one frame costs one
 * append rather than one 60 kB rewrite.
 */

/** Characters the run console keeps; matches the old `slice(-60000)`. */
export const DEFAULT_RUN_OUTPUT_LIMIT = 60000;

/**
 * @param {{limit?: number}} [options]
 */
export function createRunOutputBuffer({ limit = DEFAULT_RUN_OUTPUT_LIMIT } = {}) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RUN_OUTPUT_LIMIT;
  let retained = '';
  let pending = [];
  let pendingLength = 0;

  return {
    /** Queue a chunk; no copying happens until `flush()`. */
    append(chunk) {
      if (chunk === null || chunk === undefined) return;
      const value = String(chunk);
      if (!value) return;
      pending.push(value);
      pendingLength += value.length;
    },
    /**
     * Commit the pending chunks and report what the DOM must do.
     *
     * `append` is the surviving new text (empty when everything was over the
     * limit), `dropped` is how many characters to remove from the front of the
     * element before appending.
     *
     * @returns {{append: string, dropped: number}}
     */
    flush() {
      if (pendingLength === 0) return { append: '', dropped: 0 };
      let append = pending.join('');
      pending = [];
      pendingLength = 0;
      const overflow = Math.max(0, retained.length + append.length - max);
      let dropped = 0;
      if (overflow > 0) {
        dropped = Math.min(overflow, retained.length);
        retained = retained.slice(dropped);
        const fromAppend = overflow - dropped;
        if (fromAppend > 0) append = append.slice(fromAppend);
      }
      retained += append;
      return { append, dropped };
    },
    /** Discard pending and retained text; returns the retained value. */
    reset(value = '') {
      retained = String(value ?? '').slice(-max);
      pending = [];
      pendingLength = 0;
      return retained;
    },
    /** Characters currently retained plus characters waiting for a flush. */
    get length() {
      return retained.length + pendingLength;
    },
    /** Characters already committed to the element (excludes pending chunks). */
    get retainedLength() {
      return retained.length;
    },
    /** The full log as text. Reads are O(n) on pending chunks only. */
    get text() {
      return pendingLength === 0 ? retained : retained + pending.join('');
    },
  };
}
