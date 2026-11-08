/**
 * Spin-state sweeps: enumerate the multiplicities of one system at one level of
 * theory and report which state is lowest.
 *
 * Multiplicity is not a knob on a finished calculation — it defines the
 * electronic state, so a sweep is a set of separate runs (`<nodeId>.m1`,
 * `.m3`, …) over the same geometry. The table is a comparison of what was
 * computed; the ground state is the lowest point and nothing is extrapolated to
 * a multiplicity that did not run.
 */

export const SPIN_SWEEP_MAX = 6;

/** Multiplicities allowed for an electron count, or [] when it cannot be odd. */
export function multiplicitiesFor({ electrons = null, maxMultiplicity = 12 } = {}) {
  if (electrons === null || electrons === undefined || electrons === '') return [];
  const total = Number(electrons);
  if (!Number.isInteger(total) || total < 0) return [];
  const parity = total % 2; // even electrons → odd multiplicity
  const values = [];
  for (let multiplicity = parity === 0 ? 1 : 2; multiplicity <= maxMultiplicity; multiplicity += 2) {
    values.push(multiplicity);
  }
  return values;
}

/** Normalise `settings.spinSweep`; null when the block is not a sweep. */
export function spinSweepFor(settings) {
  const sweep = settings && typeof settings === 'object' ? settings.spinSweep : null;
  if (!sweep || typeof sweep !== 'object' || sweep.enabled !== true) return null;
  const multiplicities = [];
  for (const raw of Array.isArray(sweep.multiplicities) ? sweep.multiplicities : []) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 12) continue;
    if (!multiplicities.includes(value)) multiplicities.push(value);
  }
  if (multiplicities.length < 2) return null;
  return { multiplicities: multiplicities.slice(0, SPIN_SWEEP_MAX) };
}

/**
 * The sweep table. `entries` carry the multiplicity and the parsed numbers; the
 * ground state is the lowest energy among entries that actually report one.
 */
export function spinSweepVerdict(entries, { expected = null } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => ({
    nodeId: entry.nodeId || null,
    multiplicity: Number.isInteger(entry.multiplicity) ? entry.multiplicity : null,
    energyHartree: Number.isFinite(entry.energyHartree) ? entry.energyHartree : null,
    spinSquared: Number.isFinite(entry.spinSquared) ? entry.spinSquared : null,
    spinSquaredSource: entry.spinSquaredSource || null,
  }));
  const withEnergy = rows.filter((row) => row.energyHartree !== null);
  if (withEnergy.length === 0) {
    return {
      available: false,
      rows,
      groundMultiplicity: null,
      reason: 'No state in the sweep reported a final energy.',
    };
  }
  const lowest = Math.min(...withEnergy.map((row) => row.energyHartree));
  const table = rows.map((row) => ({
    ...row,
    relativeKcalPerMol: row.energyHartree === null ? null : (row.energyHartree - lowest) * 627.5094740631,
  }));
  const ground = table.find((row) => row.energyHartree === lowest) || null;
  const missing = expected !== null ? expected - rows.length : 0;
  return {
    available: true,
    rows: table,
    groundMultiplicity: ground ? ground.multiplicity : null,
    groundNodeId: ground ? ground.nodeId : null,
    degenerate: table.filter((row) => row.energyHartree === lowest).length > 1,
    reason: missing > 0
      ? `${rows.length} of ${expected} states ran; the ground state is the lowest of those.`
      : `Ground state: multiplicity ${ground ? ground.multiplicity : 'unknown'}.`,
  };
}
