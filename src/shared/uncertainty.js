/**
 * Measured uncertainty: the error bar the runs produced, never a literature one.
 *
 * Issue #229. Three questions, three measured answers:
 *
 *   1. Method spread — does the number move when the level of theory changes?
 *      Only the rungs that actually ran count. One rung is `not measured`; a
 *      textbook error bar for a functional is never substituted for a rung
 *      that was never computed.
 *   2. Conformer spread — the single lowest member and the Boltzmann-weighted
 *      value are reported side by side. Neither replaces the other: the lowest
 *      is a structure, the weighted value is the ensemble.
 *   3. Barrier to rate — a barrier error recorded with the path is propagated
 *      through the same Eyring expression `reactionPath.eyringRate()` uses, at
 *      the temperature that was used. At 298.15 K one kcal/mol is a factor
 *      5.41 in k; the factor is computed here from the app's constants, never
 *      typed in.
 *
 * What this module does not do: average rungs into a "better" number, estimate
 * the uncertainty of a calculation that never ran, or attach a literature
 * error bar to a computed one. A quantity without a measurement is
 * `not measured`, with the reason, and that is a result.
 *
 * Pure: no DOM, no filesystem, no child process, no clock, no randomness.
 */

import { HARTREE_KCAL, KB_KCAL, boltzmannWeights } from './conformers.js';
import { formatRate, unitsForMolecularity } from './kinetics.js';
import { eyringRate } from './reactionPath.js';
import { STANDARD_STATE_TEMPERATURE_K } from './thermochemistry.js';

/** The words a report prints when a spread was not measured. */
export const NOT_MEASURED = 'not measured';

/** A method spread needs at least two rungs with a parsed energy. */
export const MIN_METHOD_RUNGS = 2;

/**
 * The population at which one conformer is treated as representative; the same
 * rule `boltzmannWeightedObservables()` uses for its `converged` flag.
 */
export const DOMINANT_POPULATION = 0.95;

/** The sentence that says what the section is, printed once above its rows. */
export const UNCERTAINTY_NOTE = 'Every number in this section was measured from the runs in this '
  + 'queue. A quantity that was not measured is printed as “not measured” with the reason: no '
  + 'literature average, textbook error bar or estimate for a calculation that never ran is '
  + 'substituted for it.';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function oneLine(value, max = 80) {
  return text(value).replace(/\s+/g, ' ').slice(0, max);
}

function fixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : null;
}

function finiteOrNull(value) {
  // `Number(null)` and `Number('')` are 0: a missing value must not become a
  // real zero barrier, zero conformer energy or zero population.
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveTemperature(value) {
  const kelvin = finiteOrNull(value);
  return kelvin !== null && kelvin > 0 ? kelvin : null;
}

/**
 * The rung label a reader sees: the label, else `method/basis`, else the id.
 */
function levelLabel(rung) {
  const label = oneLine(rung.label, 60);
  if (label) return label;
  const level = [oneLine(rung.method, 40), oneLine(rung.basis, 40)].filter(Boolean).join('/');
  return level || oneLine(rung.id, 40) || 'unnamed rung';
}

/**
 * Method spread across the rungs that actually ran.
 *
 * `entries` are `{ id, label, method, basis, energyHartree }` — the ladder's
 * entries, or rows built from them. The spread is max − min of the final
 * energies in kcal/mol; no mean is returned, because a mean over rungs is a
 * number no method computed.
 *
 * @param {Array<object>} entries
 * @param {object} [options]
 * @param {string|null} [options.title] what the spread is over
 * @param {number|null} [options.toleranceKcal] the ladder's tolerance, when one
 *   was declared; it turns the spread into a verdict and a headroom
 * @returns {object} `measured` is true only with ≥2 parsed rung energies
 */
export function methodSpread(entries, { title = null, toleranceKcal = null } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => ({
      id: oneLine(entry.id, 40) || `rung-${index + 1}`,
      label: levelLabel(entry),
      method: oneLine(entry.method, 40),
      basis: oneLine(entry.basis, 40),
      energyHartree: finiteOrNull(entry.energyHartree),
    }));
  const present = list.filter((entry) => entry.energyHartree !== null);
  const tolerance = finiteOrNull(toleranceKcal);
  const base = {
    kind: 'method',
    title: oneLine(title, 80) || 'Method spread',
    measured: false,
    spreadKcal: null,
    toleranceKcal: tolerance !== null && tolerance >= 0 ? tolerance : null,
    headroomKcal: null,
    rungs: present.length,
    declaredRungs: list.length,
    entries: list,
    lowest: null,
    highest: null,
    text: '',
    reason: null,
  };

  if (present.length < MIN_METHOD_RUNGS) {
    const reason = list.length >= MIN_METHOD_RUNGS
      ? `${list.length} rungs are declared, but only ${present.length} carried a parsed energy; a method spread needs at least two.`
      : `${present.length} rung${present.length === 1 ? '' : 's'} ran; a method spread needs at least two.`;
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}` };
  }

  const lowest = present.reduce((best, entry) => (entry.energyHartree < best.energyHartree ? entry : best));
  const highest = present.reduce((best, entry) => (entry.energyHartree > best.energyHartree ? entry : best));
  const withRelative = present.map((entry) => ({
    ...entry,
    relativeKcalPerMol: (entry.energyHartree - lowest.energyHartree) * HARTREE_KCAL,
  }));
  const spreadKcal = (highest.energyHartree - lowest.energyHartree) * HARTREE_KCAL;
  const headroomKcal = base.toleranceKcal === null ? null : base.toleranceKcal - spreadKcal;
  const labels = withRelative.map((entry) => entry.label).join(', ');
  const over = present.length < list.length
    ? `${present.length} of ${list.length} rungs (${labels})`
    : `${present.length} rungs (${labels})`;
  const shortfall = present.length < list.length
    ? ` ${present.length} of ${list.length} declared rungs carried an energy; the spread is over those.`
    : '';
  return {
    ...base,
    measured: true,
    spreadKcal,
    headroomKcal,
    entries: withRelative,
    lowest: { id: lowest.id, label: lowest.label, relativeKcalPerMol: 0 },
    highest: { id: highest.id, label: highest.label, relativeKcalPerMol: spreadKcal },
    over,
    text: `measured spread ${fixed(spreadKcal)} kcal/mol over ${over}, `
      + `from ${lowest.label} to ${highest.label}.${shortfall}`,
  };
}

/** True when every member carries a usable population that sums to 1. */
function hasStoredPopulations(members) {
  if (members.length === 0) return false;
  if (members.some((member) => !Number.isFinite(member.population) || member.population <= 0)) return false;
  const total = members.reduce((sum, member) => sum + member.population, 0);
  return Math.abs(total - 1) <= 1e-6;
}

/**
 * Conformer spread, with the lowest member and the Boltzmann-weighted value
 * side by side.
 *
 * `members` are `{ id, relativeKcal, population }`. Populations are the ones
 * the conformer search assigned; a member that has none is never silently
 * re-normalised over the members that do. When *no* member carries a
 * population, weights are recomputed from the relative energies at the stated
 * temperature and `populationSource` says so. When some do and some do not,
 * the comparison is refused: half a population table is not a population.
 *
 * `boltzmann.relativeKcal` is the population-weighted energy *above the lowest
 * member*, so it is directly comparable with `lowest.relativeKcal === 0` and
 * with `spreadKcal`. It is not a replacement for either.
 *
 * @param {Array<object>} members retained ensemble members
 * @param {object} [options]
 * @param {string|null} [options.title]
 * @param {number|null} [options.temperatureK] the temperature the populations
 *   belong to; 298.15 K is used and named as assumed when none is recorded
 * @param {string|null} [options.refusalReason] the caller's reason the ensemble
 *   is not one retained set (e.g. more than one task per member); returned as
 *   `not measured` with that reason and no numbers
 * @returns {object}
 */
export function conformerUncertainty(members, {
  title = null,
  temperatureK = null,
  refusalReason = null,
} = {}) {
  const source = (Array.isArray(members) ? members : [])
    .filter((member) => member && typeof member === 'object')
    .map((member, index) => ({
      id: oneLine(member.id, 40) || `member-${index + 1}`,
      relativeKcal: finiteOrNull(member.relativeKcal),
      population: finiteOrNull(member.population),
    }));
  const list = source.filter((member) => member.relativeKcal !== null);
  const recorded = positiveTemperature(temperatureK);
  const temperatureAssumed = recorded === null;
  const kelvin = recorded ?? STANDARD_STATE_TEMPERATURE_K;
  const base = {
    kind: 'conformer',
    title: oneLine(title, 80) || 'Conformer spread',
    measured: false,
    temperatureK: kelvin,
    temperatureAssumed,
    count: list.length,
    members: list,
    populations: [],
    populationSource: null,
    lowest: null,
    boltzmann: null,
    spreadKcal: null,
    dominant: null,
    dominated: false,
    deltaKcal: null,
    text: '',
    reason: null,
  };

  if (refusalReason) {
    const reason = oneLine(refusalReason, 240);
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}.` };
  }

  if (list.length === 0) {
    const reason = 'no retained conformer carries a relative energy';
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}.` };
  }

  const lowest = list.reduce((best, member) => (member.relativeKcal < best.relativeKcal ? member : best));
  const relative = list.map((member) => ({ ...member, relativeKcal: member.relativeKcal - lowest.relativeKcal }));
  const spreadKcal = Math.max(...relative.map((member) => member.relativeKcal));

  let populations = [];
  let populationSource = null;
  if (hasStoredPopulations(list)) {
    populations = list.map((member) => ({ id: member.id, population: member.population }));
    populationSource = 'stored';
  } else if (list.every((member) => member.population === null)) {
    const weights = boltzmannWeights(relative.map((member) => member.relativeKcal), kelvin);
    if (weights.length === list.length) {
      populations = list.map((member, index) => ({ id: member.id, population: weights[index] }));
      populationSource = 'computed';
    }
  }

  if (populations.length !== list.length) {
    const reason = 'a retained member has no Boltzmann population, and an ensemble that was not '
      + 'retained is never re-normalised over the members that do';
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}.` };
  }

  const boltzmannKcal = list.reduce((sum, member, index) => (
    sum + populations[index].population * relative[index].relativeKcal
  ), 0);
  const dominant = populations.reduce((best, entry) => (entry.population > best.population ? entry : best));
  const dominated = dominant.population >= DOMINANT_POPULATION;
  const deltaKcal = boltzmannKcal;
  const memberWord = list.length === 1 ? 'conformer' : 'conformers';
  const populationNote = populationSource === 'computed'
    ? `; populations recomputed from the relative energies at ${kelvin.toFixed(2)} K`
    : '';
  const text = list.length < MIN_METHOD_RUNGS
    ? `${NOT_MEASURED} — one retained conformer: ${lowest.id} at 0.00 kcal/mol is also the Boltzmann value.`
    : `lowest ${lowest.id} at 0.00 kcal/mol and Boltzmann-weighted ${fixed(boltzmannKcal)} kcal/mol `
      + `above it at ${kelvin.toFixed(2)} K; retained spread ${fixed(spreadKcal)} kcal/mol over `
      + `${list.length} ${memberWord}, largest population ${(dominant.population * 100).toFixed(0)}%`
      + `${populationNote}.`;

  return {
    ...base,
    measured: list.length >= MIN_METHOD_RUNGS,
    members: relative,
    populations,
    populationSource,
    lowest: { id: lowest.id, relativeKcal: 0 },
    boltzmann: { relativeKcal: boltzmannKcal, temperatureK: kelvin },
    // One retained member is a value, not a spread: `measured` is false and
    // the spread stays null rather than being reported as a measured 0.00.
    spreadKcal: list.length >= MIN_METHOD_RUNGS ? spreadKcal : null,
    dominant,
    dominated,
    deltaKcal,
    text,
  };
}

/**
 * The Eyring factor one kcal/mol is worth at a temperature: k(ΔG‡) / k(ΔG‡ + 1).
 *
 * Computed by calling `eyringRate()` twice, so the number is this app's own
 * arithmetic (R = 8.314462618 J mol⁻¹ K⁻¹, 1 kcal = 4184 J) and not a copied
 * constant. At 298.15 K it is 5.4076.
 */
export function eyringFactorPerKcal(temperatureK = STANDARD_STATE_TEMPERATURE_K) {
  const kelvin = positiveTemperature(temperatureK);
  if (kelvin === null) return null;
  const kZero = eyringRate({ deltaGkcal: 0, temperatureKelvin: kelvin });
  const kOne = eyringRate({ deltaGkcal: 1, temperatureKelvin: kelvin });
  if (!Number.isFinite(kZero) || !Number.isFinite(kOne) || kZero <= 0 || kOne <= 0) return null;
  return kZero / kOne;
}

/**
 * Rate uncertainty from a recorded barrier error, through `eyringRate()`.
 *
 * The barrier is the recorded ΔG‡ (or the electronic-energy barrier the run
 * labels as such); `barrierErrorKcal` is the error recorded with it — never a
 * textbook spread. The factor printed is k(barrier − error) / k(barrier),
 * which equals k(barrier) / k(barrier + error) for a symmetric error, so one
 * number covers both directions.
 *
 * @param {object} input
 * @param {number|null} input.barrierKcal the barrier the rate was computed from
 * @param {number|null} input.barrierErrorKcal the error recorded with it
 * @param {number|null} [input.temperatureK]
 * @param {string|null} [input.units] the unit of k, when the molecularity is known
 * @param {number|null} [input.molecularity] 1 or 2, used to derive the unit
 * @param {string|null} [input.title]
 * @param {string|null} [input.errorSource] where the barrier error came from
 * @returns {object}
 */
export function rateUncertainty({
  barrierKcal = null,
  barrierErrorKcal = null,
  temperatureK = null,
  units = null,
  molecularity = null,
  title = null,
  errorSource = null,
} = {}) {
  const barrier = finiteOrNull(barrierKcal);
  const error = finiteOrNull(barrierErrorKcal);
  const recorded = positiveTemperature(temperatureK);
  const temperatureAssumed = recorded === null;
  const kelvin = recorded ?? STANDARD_STATE_TEMPERATURE_K;
  const order = Number(molecularity);
  const unit = oneLine(units, 20)
    || (Number.isInteger(order) ? unitsForMolecularity(order) : null)
    || null;
  const base = {
    kind: 'rate',
    title: oneLine(title, 80) || 'Barrier to rate',
    measured: false,
    barrierKcal: barrier,
    errorKcal: error,
    errorSource: oneLine(errorSource, 80) || null,
    temperatureK: kelvin,
    temperatureAssumed,
    units: unit,
    k: null,
    kFast: null,
    kSlow: null,
    kText: null,
    kFastText: null,
    kSlowText: null,
    factor: null,
    factorText: null,
    text: '',
    reason: null,
  };

  if (barrier === null) {
    const reason = 'the barrier is missing or not a finite number';
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}.` };
  }
  if (error === null || error < 0) {
    const reason = 'no barrier error was recorded with this barrier, so no rate error is stated';
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}.` };
  }

  const k = eyringRate({ deltaGkcal: barrier, temperatureKelvin: kelvin });
  const kFast = eyringRate({ deltaGkcal: barrier - error, temperatureKelvin: kelvin });
  const kSlow = eyringRate({ deltaGkcal: barrier + error, temperatureKelvin: kelvin });
  if (![k, kFast, kSlow].every((value) => Number.isFinite(value) && value > 0)) {
    const reason = `eyringRate() could not convert ΔG‡ = ${barrier} ± ${error} kcal/mol at ${kelvin} K`;
    return { ...base, reason, text: `${NOT_MEASURED} — ${reason}.` };
  }

  const factor = kFast / k;
  const assumedNote = temperatureAssumed
    ? ` (temperature not recorded; the ${kelvin.toFixed(2)} K standard state was used)`
    : '';
  const sourceNote = base.errorSource ? `source: ${base.errorSource}` : '';
  const text = unit
    ? `barrier ${fixed(barrier)} ± ${fixed(error)} kcal/mol at ${kelvin.toFixed(2)} K: `
      + `k = ${formatRate(k)} ${unit}, a factor ${factor.toFixed(2)} in k across the recorded error `
      + `(${formatRate(kFast)} to ${formatRate(kSlow)} ${unit}${sourceNote ? `; ${sourceNote}` : ''})${assumedNote}.`
    : `barrier ${fixed(barrier)} ± ${fixed(error)} kcal/mol at ${kelvin.toFixed(2)} K: `
      + `a factor ${factor.toFixed(2)} in k across the recorded error`
      + `${sourceNote ? ` (${sourceNote})` : ''}${assumedNote}.`;

  return {
    ...base,
    measured: true,
    k,
    kFast,
    kSlow,
    kText: formatRate(k),
    kFastText: formatRate(kFast),
    kSlowText: formatRate(kSlow),
    factor,
    factorText: `${factor.toFixed(2)}×`,
    text,
  };
}

/**
 * What would change the conclusion, one sentence per measured quantity.
 *
 * Each sentence is derived from the number beside it: the ladder's headroom
 * against its tolerance, the population a conformer would need to dominate,
 * or the rate factor the recorded barrier error buys. Nothing here is a
 * generic caveat, and a quantity that was not measured produces the sentence
 * that says what would have to run.
 *
 * @param {Array<object>} rows results of `methodSpread`, `conformerUncertainty`
 *   and `rateUncertainty`
 * @param {object} [options]
 * @param {number|null} [options.temperatureK] used for the kcal→factor note
 * @returns {Array<{key: string, kind: string, text: string}>}
 */
export function whatWouldChange(rows, { temperatureK = null } = {}) {
  const kelvin = positiveTemperature(temperatureK) ?? STANDARD_STATE_TEMPERATURE_K;
  const perKcal = eyringFactorPerKcal(kelvin);
  const factorFor = (kcal) => (perKcal === null ? null : perKcal ** kcal);
  const statements = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const key = `${row.kind}:${row.title}`;
    if (row.kind === 'method') {
      if (!row.measured) {
        statements.push({
          key,
          kind: 'method',
          text: `No method spread was measured for ${row.title} — ${row.reason} A second rung with a parsed `
            + 'energy at a different level of theory is what would make the claim testable, and nothing is '
            + 'assumed in its place.',
        });
        continue;
      }
      if (Number.isFinite(row.toleranceKcal)) {
        const headroom = row.toleranceKcal - row.spreadKcal;
        if (headroom >= 0) {
          statements.push({
            key,
            kind: 'method',
            text: `${row.title} passes with ${fixed(headroom)} kcal/mol of headroom against a `
              + `${fixed(row.toleranceKcal)} kcal/mol tolerance: a rung moving by more than `
              + `${fixed(headroom)} kcal/mol would change the verdict to fail.`,
          });
        } else {
          statements.push({
            key,
            kind: 'method',
            text: `${row.title} fails by ${fixed(-headroom)} kcal/mol against a `
              + `${fixed(row.toleranceKcal)} kcal/mol tolerance: a rung moving `
              + `${fixed(-headroom)} kcal/mol toward the pack would bring the spread inside it.`,
          });
        }
        continue;
      }
      const factor = factorFor(row.spreadKcal);
      statements.push({
        key,
        kind: 'method',
        text: `The rungs span ${fixed(row.spreadKcal)} kcal/mol`
          + `${factor === null ? '' : `, a factor ${factor.toFixed(2)} in k at ${kelvin.toFixed(2)} K`}`
          + ': a conclusion that turns on a smaller energy difference is not resolved by these rungs.',
      });
    } else if (row.kind === 'conformer') {
      if (!row.measured) {
        const why = row.count <= 1
          ? 'one retained conformer, so there is no spread to weigh'
          : `not one retained ensemble — ${row.reason}`;
        statements.push({
          key,
          kind: 'conformer',
          text: `${row.title} has no measured conformer spread (${why}): a single retained ensemble with at `
            + 'least two members is what would make the lowest value versus the ensemble value a measurement.',
        });
        continue;
      }
      statements.push({
        key,
        kind: 'conformer',
        text: `The lowest member holds ${(row.dominant.population * 100).toFixed(0)}% of the population and the `
          + `Boltzmann value is ${fixed(row.deltaKcal)} kcal/mol above it: the single lowest value would be `
          + `representative only if one member held ${(DOMINANT_POPULATION * 100).toFixed(0)}% of the population, `
          + 'so a member gaining that share is what would change which number should be quoted.',
      });
    } else if (row.kind === 'rate') {
      if (!row.measured) {
        statements.push({
          key,
          kind: 'rate',
          text: `${row.title} carries no rate error: recording the barrier's error is what would make the `
            + 'factor computable, and no textbook spread is used instead.',
        });
        continue;
      }
      statements.push({
        key,
        kind: 'rate',
        text: `A barrier error of ±${fixed(row.errorKcal)} kcal/mol is a factor ${row.factor.toFixed(2)} in k at `
          + `${row.temperatureK.toFixed(2)} K: a conclusion that depends on a rate ratio smaller than `
          + `${row.factor.toFixed(2)} is not resolved by this barrier.`,
      });
    }
  }
  return statements;
}
