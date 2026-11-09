/**
 * Reference data for turning an absolute shielding into a chemical shift.
 *
 * The rule comes before the data: a shift exists only when a reference for that
 * exact level of theory exists. `shiftFor` returns the shift together with the
 * mode and the citation that produced it, or `delta: null` and a reason naming
 * the level that had no reference — never a shift against an assumed reference.
 *
 * Two modes, both explicit:
 *
 * - `single`: δ = σ_ref − σ, with σ_ref the reference nucleus (TMS, CFCl₃,
 *   H₃PO₄, …) computed at the same method and basis as the sample.
 * - `linear`: δ = a·σ + b, with `a`, `b` fitted at the level they are stored
 *   with. The fit is only valid for that level; nothing is extrapolated.
 *
 * The shipped dataset (`src/data/nmrReferences.json`) is empty on purpose. A
 * reference shielding is a computation per level, not a universal constant, and
 * a number borrowed from another level or from a paper that does not state the
 * level is exactly the fabricated quantity this project refuses. Adding an
 * entry requires a citation; `loadNmrReferences` refuses one without it, by
 * name.
 *
 * None of this is a prediction model: both modes are arithmetic on a shielding
 * the run computed, anchored to a reference the entry states.
 */

import nmrReferenceData from '../data/nmrReferences.json' with { type: 'json' };
import { elementForNucleus } from './nmr.js';

/** The two supported ways to reference a shielding. */
export const REFERENCE_MODES = Object.freeze(['single', 'linear']);

const MODE_SET = new Set(REFERENCE_MODES);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeToken = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** `{ method, basis }` → `ωB97X-D/def2-TZVP`, or null when either part is missing. */
export function levelLabel(level) {
  const method = String(level?.method ?? '').trim();
  const basis = String(level?.basis ?? '').trim();
  if (!method || !basis) return null;
  return `${method}/${basis}`;
}

/**
 * The nucleus a label names, reduced to its element (`13C` → `C`), or null when
 * this app does not read that nucleus. Isotopologues share a shielding, so a
 * `13C` entry is the reference for a carbon shielding whichever label asks.
 */
function nucleusElement(nucleus) {
  const label = String(nucleus ?? '').trim();
  if (!label) return null;
  return elementForNucleus(label) || null;
}

/** A finite JSON number. Numeric strings are refused: the dataset is data, not input. */
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** A caller-supplied measurement; `null`, `''` and `' '` are absent, not 0. */
function measurement(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** How to name an entry in a refusal the user has to act on. */
function referenceName(entry, index) {
  const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
  if (id) return `"${id}"`;
  const level = levelLabel(entry?.level);
  const nucleus = String(entry?.nucleus ?? '').trim();
  if (level && nucleus) return `"${nucleus} at ${level}"`;
  if (level) return `"the entry at ${level}"`;
  return `entry ${index + 1}`;
}

/**
 * Check one reference entry. Returns `{ ok, errors }`; `errors` names every
 * field that is missing or unusable, so a refusal can say what to fix rather
 * than just "invalid".
 */
export function validateReference(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, errors: ['not an object'] };
  }
  const level = levelLabel(entry.level);
  if (!level) errors.push('missing level.method or level.basis');
  const element = nucleusElement(entry.nucleus);
  if (!String(entry.nucleus ?? '').trim()) errors.push('missing nucleus');
  else if (!element) errors.push(`nucleus "${String(entry.nucleus).trim()}" is not one this app reads (1H, 13C, 15N, 19F, 31P, 29Si)`);
  if (!MODE_SET.has(entry.mode)) {
    errors.push(`mode "${String(entry.mode ?? '')}" is not one of ${REFERENCE_MODES.join(', ')}`);
  } else if (entry.mode === 'single') {
    if (!finiteNumber(entry.sigmaRef)) errors.push('single mode needs a finite sigmaRef');
  } else {
    if (!finiteNumber(entry.a)) errors.push('linear mode needs a finite a');
    if (!finiteNumber(entry.b)) errors.push('linear mode needs a finite b');
  }
  if (typeof entry.citation !== 'string' || entry.citation.trim() === '') {
    errors.push('missing citation');
  }
  if (typeof entry.retrievedAt !== 'string' || !ISO_DATE.test(entry.retrievedAt.trim())
    || Number.isNaN(Date.parse(entry.retrievedAt.trim()))) {
    errors.push('missing retrievedAt (an ISO date, YYYY-MM-DD)');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a dataset and freeze it. Accepts the shipped dataset object
 * (`{ entries: [] }`) or a bare array. Throws — naming every offending entry —
 * rather than loading a table that would let a shift appear without a source.
 */
export function loadNmrReferences(dataset) {
  const entries = Array.isArray(dataset) ? dataset : dataset?.entries;
  if (!Array.isArray(entries)) {
    throw new Error('NMR reference data refused — the dataset has no entries[] array');
  }
  const problems = [];
  const seen = new Map();
  entries.forEach((entry, index) => {
    const name = referenceName(entry, index);
    const check = validateReference(entry);
    for (const error of check.errors) problems.push(`${name}: ${error}`);
    if (!check.ok) return;
    const key = `${normalizeToken(levelLabel(entry.level))}|${nucleusElement(entry.nucleus)}`;
    if (seen.has(key)) {
      problems.push(`${name}: duplicate reference for ${String(entry.nucleus).trim()} at `
        + `${levelLabel(entry.level)} (already ${seen.get(key)})`);
      return;
    }
    seen.set(key, name);
  });
  if (problems.length > 0) {
    throw new Error(`NMR reference data refused — ${problems.join('; ')}`);
  }
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze({
      ...entry,
      level: Object.freeze({ method: entry.level.method, basis: entry.level.basis }),
    }))),
  });
}

/**
 * The dataset shipped with the app. Empty by design; see the module comment and
 * the `$comment` in `src/data/nmrReferences.json`.
 */
export const SHIPPED_REFERENCES = loadNmrReferences(nmrReferenceData);

/** The entry list of a loaded dataset, a raw dataset object, or a bare array. */
function entriesOf(references) {
  if (Array.isArray(references)) return references;
  if (Array.isArray(references?.entries)) return references.entries;
  return [];
}

/**
 * The reference for one nucleus at one level, or null when the dataset has no
 * entry for that exact level. Matching ignores case and surrounding whitespace
 * in the method and basis names, and treats isotopologues of one element as the
 * same nucleus; it never falls back to another level or another nucleus.
 */
export function lookupReference({ level, nucleus, references = SHIPPED_REFERENCES } = {}) {
  const wantedLevel = levelLabel(level);
  const wantedElement = nucleusElement(nucleus);
  if (!wantedLevel || !wantedElement) return null;
  const key = normalizeToken(wantedLevel);
  for (const entry of entriesOf(references)) {
    if (normalizeToken(levelLabel(entry.level)) !== key) continue;
    if (nucleusElement(entry.nucleus) !== wantedElement) continue;
    return entry;
  }
  return null;
}

/**
 * δ for one shielding, with the provenance that produced it.
 *
 * Returns `{ delta, mode, citation, reason }`. `reason` is null only when a
 * shift was computed; otherwise `delta` is null and the reason names what is
 * missing — `no reference for <method>/<basis>` when the dataset has no entry
 * at that level, or the missing shielding. There is no path here that subtracts
 * a default reference.
 */
export function shiftFor({ level, nucleus = null, sigma, references = SHIPPED_REFERENCES } = {}) {
  const label = levelLabel(level);
  const nucleusLabel = String(nucleus ?? '').trim();
  if (!label) {
    return { delta: null, mode: null, citation: null, reason: 'no level of theory given' };
  }
  const value = measurement(sigma);
  if (value === null) {
    return {
      delta: null,
      mode: null,
      citation: null,
      reason: `no shielding for ${nucleusLabel || 'the nucleus'} at ${label}`,
    };
  }
  const entry = lookupReference({ level, nucleus, references });
  if (!entry) {
    return { delta: null, mode: null, citation: null, reason: `no reference for ${label}` };
  }
  const delta = entry.mode === 'single'
    ? entry.sigmaRef - value
    : (entry.a * value) + entry.b;
  return {
    delta,
    mode: entry.mode,
    citation: entry.citation,
    reason: null,
    level: label,
    nucleus: entry.nucleus,
    entry,
  };
}
