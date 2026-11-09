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
 *   H₃PO₄, …) computed at the same method and basis as the sample. A `single`
 *   reference may also be passed in by the caller as an explicit
 *   `{ ppm, provenance }` value — the σ_ref a user states for this run. The
 *   provenance is mandatory: a σ_ref with no stated calculation or citation is
 *   a borrowed number, and `shiftFor` refuses it by name.
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
 * Check one caller-supplied reference value: `{ ppm, provenance, level?,
 * citation? }`. The provenance is what makes the number usable — which
 * calculation produced it (method/basis/solvent) or which publication states
 * it. Returns `{ ok, error, ppm, provenance, level, citation }`; `error` names
 * the missing part so the card can print the refusal.
 */
export function explicitReference(reference) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    return { ok: false, error: 'the reference is not an object' };
  }
  const ppm = measurement(reference.ppm);
  if (ppm === null) {
    return { ok: false, error: 'the reference has no finite σ_ref' };
  }
  const provenance = typeof reference.provenance === 'string' ? reference.provenance.trim() : '';
  if (!provenance) {
    return {
      ok: false,
      error: 'the reference has no stated provenance — σ_ref must name the calculation '
        + '(method, basis, solvent) or the cited experiment that produced it',
    };
  }
  const citation = typeof reference.citation === 'string' && reference.citation.trim()
    ? reference.citation.trim()
    : null;
  return { ok: true, error: null, ppm, provenance, level: levelLabel(reference.level), citation };
}

/** How one reference is named in a shift's `source`, for the table column. */
export function referenceSource(entry) {
  const level = levelLabel(entry?.level);
  const at = level ? ` at ${level}` : '';
  if (entry?.mode === 'linear') {
    return `reference: δ = ${entry.a}·σ + ${entry.b}${at} — ${entry.citation}`;
  }
  return `reference: σ_ref = ${entry.sigmaRef} ppm${at} — ${entry.citation}`;
}

/**
 * δ for one shielding, with the provenance that produced it.
 *
 * Returns `{ delta, mode, citation, reason, source }`. `reason` is null only
 * when a shift was computed; otherwise `delta` is null and the reason names what
 * is missing — `no reference for <method>/<basis>` when the dataset has no entry
 * at that level, the missing shielding, or the missing provenance on an
 * explicit reference. `source` is the line the table prints beside the number
 * (`reference: σ_ref = … — …`); it is null exactly when `delta` is null.
 *
 * `reference` is the caller's own σ_ref, `{ ppm, provenance, level? }`, used for
 * the `single` mode. When it names a level, that level must be the run's level:
 * a reference computed elsewhere is refused rather than subtracted. There is no
 * path here that subtracts a default reference.
 */
export function shiftFor({
  level,
  nucleus = null,
  sigma,
  reference = null,
  references = SHIPPED_REFERENCES,
} = {}) {
  const label = levelLabel(level);
  const nucleusLabel = String(nucleus ?? '').trim();
  if (!label) {
    return { delta: null, mode: null, citation: null, reason: 'no level of theory given', source: null };
  }
  const value = measurement(sigma);
  if (value === null) {
    return {
      delta: null,
      mode: null,
      citation: null,
      reason: `no shielding for ${nucleusLabel || 'the nucleus'} at ${label}`,
      source: null,
    };
  }
  if (reference !== null && reference !== undefined) {
    const stated = explicitReference(reference);
    if (!stated.ok) {
      return { delta: null, mode: null, citation: null, reason: stated.error, source: null };
    }
    if (stated.level && normalizeToken(stated.level) !== normalizeToken(label)) {
      return {
        delta: null,
        mode: null,
        citation: null,
        reason: `the reference is at ${stated.level}, the run is at ${label}`,
        source: null,
      };
    }
    const at = stated.level ? ` at ${stated.level}` : '';
    return {
      delta: stated.ppm - value,
      mode: 'single',
      citation: stated.citation || stated.provenance,
      reason: null,
      source: `reference: σ_ref = ${stated.ppm} ppm${at} — ${stated.provenance}`,
      level: label,
      nucleus: nucleusLabel || null,
      entry: stated,
    };
  }
  const entry = lookupReference({ level, nucleus, references });
  if (!entry) {
    return { delta: null, mode: null, citation: null, reason: `no reference for ${label}`, source: null };
  }
  const delta = entry.mode === 'single'
    ? entry.sigmaRef - value
    : (entry.a * value) + entry.b;
  return {
    delta,
    mode: entry.mode,
    citation: entry.citation,
    reason: null,
    source: referenceSource(entry),
    level: label,
    nucleus: entry.nucleus,
    entry,
  };
}
