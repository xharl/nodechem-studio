/**
 * Parsed cube cache, keyed by `(path, mtimeMs, size)`.
 *
 * A workflow report is usually regenerated for the same queue more than once —
 * after a note changes, or with a larger figure set — and the `.cube` files in
 * the run folders have not changed. Parsing a 1.4 MB cube is ~37 ms; fifty of
 * them is seconds of work that produces the same arrays. The key is the file's
 * identity on disk, not its name: an edited cube gets a new mtime or size, and
 * a stale volume is worse than a second parse.
 *
 * The cache stores the volume the report needs (values, origin, step, counts,
 * range), not the raw text. Concurrent requests for the same key share one
 * parse. It is bounded by entry count and bytes and evicts least-recently-used
 * first, so a folder of very large cubes cannot grow it without limit.
 */

import path from 'node:path';

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** The cache key for a cube file with a known `fs.stat` result. */
export function cubeCacheKey(file, stat) {
  return `${path.resolve(file)}\u0000${stat?.mtimeMs}\u0000${stat?.size}`;
}

function volumeBytes(volume) {
  const values = volume?.values;
  return (values && typeof values.byteLength === 'number' ? values.byteLength : 0) + 256;
}

/**
 * A bounded LRU cache with in-flight coalescing.
 *
 * `stats` is a snapshot for tests and diagnostics: `hits` are loads served from
 * a stored volume, `misses` are parses, `coalesced` are loads that waited on a
 * parse already running for the same key, and `evictions` are entries dropped
 * to stay inside the bounds.
 */
export function createCubeCache({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const entryLimit = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES));
  const byteLimit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
  const entries = new Map();
  const pending = new Map();
  const counts = { hits: 0, misses: 0, coalesced: 0, evictions: 0 };
  let bytes = 0;

  const evict = () => {
    while (entries.size > entryLimit || bytes > byteLimit) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      bytes -= oldest.bytes;
      counts.evictions += 1;
    }
  };

  return {
    get stats() {
      return { ...counts, size: entries.size, bytes };
    },

    has(key) {
      return entries.has(key);
    },

    /** Return the cached volume, or run `produce()` once and store its value. */
    async load(key, produce) {
      const hit = entries.get(key);
      if (hit) {
        counts.hits += 1;
        // Refresh recency: delete and re-insert moves the key to the end.
        entries.delete(key);
        entries.set(key, hit);
        return hit.value;
      }
      const running = pending.get(key);
      if (running) {
        counts.coalesced += 1;
        return running;
      }
      counts.misses += 1;
      const parse = (async () => {
        const value = await produce();
        const entry = { value, bytes: volumeBytes(value) };
        entries.set(key, entry);
        bytes += entry.bytes;
        evict();
        return value;
      })();
      pending.set(key, parse);
      try {
        return await parse;
      } finally {
        pending.delete(key);
      }
    },

    clear() {
      entries.clear();
      pending.clear();
      bytes = 0;
      counts.hits = 0;
      counts.misses = 0;
      counts.coalesced = 0;
      counts.evictions = 0;
    },
  };
}

/** The cache every report in this process shares. */
export const defaultCubeCache = createCubeCache();
