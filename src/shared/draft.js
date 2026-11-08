/**
 * Crash-safe draft autosave: the shape, the identity and the acceptance rules
 * for the unsaved-work copy the renderer keeps beside the project file.
 *
 * WHY a separate pure module: the draft is a promise that work survives a
 * crash, so the rules that decide whether a stored draft may be trusted have to
 * be testable without a browser. Nothing here touches `window`, `localStorage`
 * or the DOM — the renderer owns storage and hands the raw string in.
 */

/** Bumped only when the stored shape changes incompatibly. */
export const DRAFT_VERSION = 1;

/** localStorage key. Versioned in the name so an old build cannot misread it. */
export const DRAFT_KEY = 'ncs.draft.v1';

/**
 * Upper bound on the serialised draft, in UTF-8 bytes. A draft is a recovery
 * copy, not a second project store: past roughly a megabyte the quota cost and
 * the synchronous write hurt more than the recovery is worth, so the renderer
 * simply keeps no draft for that project.
 */
export const MAX_DRAFT_BYTES = 1_000_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (value) => String(value).padStart(2, '0');

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Order-independent serialisation, used only to compare two projects. A draft
 * written by a build that ordered keys differently is still the same work, so
 * comparing with `JSON.stringify` directly would offer a pointless restore.
 */
function stableKey(value) {
  if (!value || typeof value !== 'object') return String(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`;
}

/**
 * Turn whatever came out of storage into a draft this build can trust, or
 * `null`. Corrupt JSON, a different draft version and a draft without a project
 * are all rejected rather than repaired: guessing at half-parsed work would put
 * an invalid project into the editor.
 *
 * `updatedAt` and `filePath` are normalised instead of rejected — a draft that
 * lost its timestamp is still the user's work.
 */
export function normalizeDraft(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(value)) return null;
  if (value.version !== DRAFT_VERSION) return null;
  if (!isPlainObject(value.project)) return null;
  const updatedAt = Number(value.updatedAt);
  return {
    version: DRAFT_VERSION,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    filePath: typeof value.filePath === 'string' && value.filePath.trim() ? value.filePath : null,
    project: value.project,
  };
}

/**
 * True when the draft holds something the project on screen does not. Restoring
 * an identical draft would be a no-op that looks like data loss recovery, so
 * the bar stays hidden in that case.
 */
export function draftIsRestorable(draft, currentProject) {
  const value = normalizeDraft(draft);
  if (!value) return false;
  return stableKey(value.project) !== stableKey(currentProject ?? null);
}

/**
 * How to describe the draft's timestamp after "Unsaved draft from …". Local
 * clock time, with just enough date context to disambiguate: "14:05",
 * "yesterday at 23:41", "Mar 3 at 09:07", "2025-12-31 at 23:00".
 */
export function draftAgeLabel(updatedAt, now = Date.now()) {
  const stamp = Number(updatedAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return 'an unknown time';
  const then = new Date(stamp);
  if (Number.isNaN(then.getTime())) return 'an unknown time';
  const current = Number.isFinite(Number(now)) ? new Date(Number(now)) : new Date();

  const clock = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  const sameDay = then.getFullYear() === current.getFullYear()
    && then.getMonth() === current.getMonth()
    && then.getDate() === current.getDate();
  if (sameDay) return clock;

  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  const wasYesterday = then.getFullYear() === yesterday.getFullYear()
    && then.getMonth() === yesterday.getMonth()
    && then.getDate() === yesterday.getDate();
  if (wasYesterday) return `yesterday at ${clock}`;

  if (then.getFullYear() === current.getFullYear()) {
    return `${MONTHS[then.getMonth()]} ${then.getDate()} at ${clock}`;
  }
  return `${then.getFullYear()}-${pad2(then.getMonth() + 1)}-${pad2(then.getDate())} at ${clock}`;
}
