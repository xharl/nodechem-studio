/**
 * Method ladders: one block, several levels of theory, one verdict.
 *
 * A ladder answers "does the number move if I change the method?" — it runs the
 * same system at two to four levels and reports the spread. The verdict is a
 * single gate over the group:
 *
 *   spread ≤ tolerance  → pass
 *   spread > tolerance  → fail
 *   any rung missing    → unknown (never pass)
 *
 * The spread is computed from each rung's final energy, which is the only
 * quantity every level has in common. Nothing here averages the rungs into a
 * "better" number: a ladder measures sensitivity, it does not manufacture one
 * value out of three.
 */

export const HARTREE_TO_KCAL_PER_MOL = 627.5094740631;
export const LADDER_MIN_RUNGS = 2;
export const LADDER_MAX_RUNGS = 4;
export const DEFAULT_LADDER_TOLERANCE_KCAL = 3;

const oneLine = (value, max = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Normalise `settings.ladder`. Returns `null` when the node is not a ladder,
 * and throws nothing: a malformed ladder is reported by the schema, not patched
 * here.
 */
export function ladderRungs(settings) {
  const ladder = settings && typeof settings === 'object' ? settings.ladder : null;
  if (!ladder || typeof ladder !== 'object' || ladder.enabled !== true) return null;
  const rungs = Array.isArray(ladder.rungs) ? ladder.rungs : [];
  const normalised = rungs
    .map((rung, index) => ({
      index,
      label: oneLine(rung?.label, 40) || `Rung ${index + 1}`,
      method: oneLine(rung?.method, 40) || '',
      basis: oneLine(rung?.basis, 40) || '',
      dispersion: oneLine(rung?.dispersion, 40) || '',
    }))
    .filter((rung) => rung.method);
  if (normalised.length < LADDER_MIN_RUNGS) return null;
  return {
    toleranceKcal: Number.isFinite(Number(ladder.toleranceKcal)) && Number(ladder.toleranceKcal) >= 0
      ? Number(ladder.toleranceKcal) : DEFAULT_LADDER_TOLERANCE_KCAL,
    rungs: normalised,
  };
}

/** Relative energies in kcal/mol against the lowest rung, plus min/max/mean. */
export function ladderSpread(entries) {
  const energies = entries
    .map((entry) => (Number.isFinite(entry.energyHartree) ? entry.energyHartree : null));
  const present = energies.filter((value) => value !== null);
  if (present.length === 0) return { entries: [], min: null, max: null, spreadKcal: null, mean: null };
  const min = Math.min(...present);
  const max = Math.max(...present);
  return {
    entries: entries.map((entry) => ({
      ...entry,
      energyHartree: Number.isFinite(entry.energyHartree) ? entry.energyHartree : null,
      relativeKcalPerMol: Number.isFinite(entry.energyHartree)
        ? (entry.energyHartree - min) * HARTREE_TO_KCAL_PER_MOL : null,
    })),
    min,
    max,
    spreadKcal: (max - min) * HARTREE_TO_KCAL_PER_MOL,
    mean: present.reduce((sum, value) => sum + value, 0) / present.length,
  };
}

/**
 * The ladder gate. `expected` is the number of rungs the plan asked for; a rung
 * that never ran is 'unknown', not a pass over the rungs that did.
 */
export function ladderVerdict(entries, { toleranceKcal = DEFAULT_LADDER_TOLERANCE_KCAL, expected = null } = {}) {
  const tolerance = Number.isFinite(Number(toleranceKcal)) && Number(toleranceKcal) >= 0
    ? Number(toleranceKcal) : DEFAULT_LADDER_TOLERANCE_KCAL;
  const spread = ladderSpread(entries || []);
  const missing = spread.entries.filter((entry) => entry.energyHartree === null).map((entry) => entry.label);
  if (expected !== null && spread.entries.length < expected) {
    return {
      status: 'unknown',
      toleranceKcal: tolerance,
      spreadKcal: spread.spreadKcal,
      entries: spread.entries,
      reason: `${spread.entries.length} of ${expected} rungs ran; the spread is not known.`,
      missing,
    };
  }
  if (missing.length > 0) {
    return {
      status: 'unknown',
      toleranceKcal: tolerance,
      spreadKcal: spread.spreadKcal,
      entries: spread.entries,
      reason: `No final energy for ${missing.join(', ')}; the spread is not known.`,
      missing,
    };
  }
  if (spread.entries.length < LADDER_MIN_RUNGS || spread.spreadKcal === null) {
    return {
      status: 'unknown',
      toleranceKcal: tolerance,
      spreadKcal: null,
      entries: spread.entries,
      reason: 'A ladder needs at least two rungs with a parsed energy.',
      missing,
    };
  }
  const pass = spread.spreadKcal <= tolerance + 1e-9;
  return {
    status: pass ? 'pass' : 'fail',
    toleranceKcal: tolerance,
    spreadKcal: spread.spreadKcal,
    entries: spread.entries,
    reason: `Spread ${spread.spreadKcal.toFixed(2)} kcal/mol is ${pass ? 'within' : 'above'} the ${tolerance} kcal/mol tolerance.`,
    missing,
  };
}
