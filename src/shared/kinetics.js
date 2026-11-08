/**
 * Eyring kinetics for a computed barrier.
 *
 * `eyringRate()` in `reactionPath.js` answers "what is k for this ΔG‡"; this
 * module answers the questions a reader actually has next: at which
 * temperature, in which units, from which free energy, and with what
 * corrections. A rate is never printed without those four things.
 *
 * Units follow the molecularity of the reaction, which is read from the
 * reactant block's fragment count — never assumed. A unimolecular reaction has
 * k in s⁻¹; a bimolecular one in M⁻¹ s⁻¹, because the transition-state
 * partition function carries one more concentration factor. At the 1 mol L⁻¹
 * standard state the two prefactors are numerically equal, so the number is
 * the same and the unit is what distinguishes them.
 *
 * References:
 * - Eyring, H. J. Chem. Phys. 1935, 3, 107-115 (transition-state theory).
 * - Laidler, K. J. Chemical Kinetics, 3rd ed., 1987, ch. 5 (TST prefactor and
 *   the bimolecular standard-state factor).
 */

import { GAS_CONSTANT_KCAL_PER_MOL_K, STANDARD_STATE_TEMPERATURE_K } from './thermochemistry.js';
import { eyringRate } from './reactionPath.js';

/** Supported reaction orders and the unit each one gives k. */
export const MOLECULARITY_UNITS = Object.freeze({
  1: 's⁻¹',
  2: 'M⁻¹s⁻¹',
});

const SUPERSCRIPTS = Object.freeze({
  '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
});

/** The unit string for a supported molecularity, or null when there is none. */
export function unitsForMolecularity(value) {
  return Object.hasOwn(MOLECULARITY_UNITS, value) ? MOLECULARITY_UNITS[value] : null;
}

/**
 * Fragment count of a project molecule.
 *
 * The declared fragment strings win; without them the per-atom `fragment`
 * labels the counterpoise workflow writes are counted. A molecule with atoms
 * and no labels is one fragment. An empty molecule is `null`: "no atoms" is
 * not "one fragment".
 */
export function fragmentCount(molecule) {
  const detail = fragmentCountDetail(molecule);
  return detail.count;
}

function fragmentCountDetail(molecule) {
  if (!molecule || typeof molecule !== 'object') {
    return { count: null, basis: null };
  }
  if (Array.isArray(molecule.fragments) && molecule.fragments.length > 0) {
    return { count: molecule.fragments.length, basis: 'declared fragments' };
  }
  const labels = Array.isArray(molecule.coords)
    ? [...new Set(molecule.coords
      .map((atom) => Number(atom?.fragment))
      .filter((value) => Number.isInteger(value) && value > 0))]
    : [];
  if (labels.length > 0) return { count: labels.length, basis: 'atom fragment labels' };
  if (Array.isArray(molecule.coords) && molecule.coords.length > 0) {
    return { count: 1, basis: 'atoms with no fragment labels' };
  }
  return { count: null, basis: null };
}

/**
 * Molecularity of the reactant side of a reaction.
 *
 * Only the reactant block decides it. The transition-state block is carried so
 * a caller can state it, but its fragment count is never substituted for the
 * reactant's: a two-fragment TS complex does not make a unimolecular reaction
 * bimolecular, and the reverse mistake would change the unit of k.
 */
export function molecularityOf({ reactant = null, transitionState = null } = {}) {
  if (!reactant) {
    return {
      value: null,
      units: null,
      basis: null,
      reason: 'No reactant block is declared, so the molecularity of the reaction is unknown.',
    };
  }
  const detail = fragmentCountDetail(reactant);
  if (detail.count === null) {
    return {
      value: null,
      units: null,
      basis: null,
      reason: 'The reactant block does not declare how many fragments it contains, so the molecularity is unknown.',
    };
  }
  const units = unitsForMolecularity(detail.count);
  if (!units) {
    return {
      value: null,
      units: null,
      basis: detail.basis,
      fragments: detail.count,
      reason: `The reactant block has ${detail.count} fragments; only unimolecular and bimolecular rates are reported.`,
    };
  }
  return {
    value: detail.count,
    units,
    basis: detail.basis,
    fragments: detail.count,
    transitionStateFragments: transitionState ? fragmentCountDetail(transitionState).count : null,
    reason: null,
  };
}

/** 1.36 × 10⁻² — three significant figures, with the exponent as characters. */
export function formatRate(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const exponent = Math.floor(Math.log10(value));
  const mantissa = value / 10 ** exponent;
  const digits = SUPERSCRIPTS[String(Math.abs(exponent))] ?? '';
  const sign = exponent < 0 ? SUPERSCRIPTS['-'] : '';
  return `${mantissa.toFixed(2)} × 10${sign}${digits}`;
}

function formatHalfLife(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 1e-3) return `${formatRate(seconds)} s`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

function formatTemperature(kelvin) {
  return `${Number(kelvin).toFixed(2)} K`;
}

function orderWord(value) {
  return value === 1 ? 'unimolecular' : value === 2 ? 'bimolecular' : null;
}

/**
 * The rates at a set of temperatures.
 *
 * `temperatures` defaults to 298.15 K and the run temperature, deduplicated. A
 * ΔG‡ computed at one temperature is reused at the others: that assumes ΔH‡
 * and ΔS‡ are constant over the range, which the caption states rather than
 * hides.
 */
export function temperatureTable({
  deltaGkcal = null,
  temperatureK = null,
  temperatures = null,
  molecularity = null,
} = {}) {
  const order = typeof molecularity === 'number' ? { value: molecularity } : (molecularity || {});
  const units = order.units ?? unitsForMolecularity(order.value);
  const requested = Array.isArray(temperatures) && temperatures.length > 0
    ? temperatures
    : [STANDARD_STATE_TEMPERATURE_K, Number.isFinite(temperatureK) ? temperatureK : STANDARD_STATE_TEMPERATURE_K];
  const unique = [];
  for (const value of requested) {
    const kelvin = Number(value);
    if (!Number.isFinite(kelvin) || kelvin <= 0) continue;
    if (!unique.some((entry) => Math.abs(entry - kelvin) < 0.01)) unique.push(kelvin);
  }
  unique.sort((a, b) => a - b);
  return unique.map((kelvin) => {
    const k = units && Number.isFinite(deltaGkcal)
      ? eyringRate({ deltaGkcal, temperatureKelvin: kelvin })
      : null;
    return {
      temperatureK: kelvin,
      k,
      kText: k === null ? 'not reported' : `${formatRate(k)} ${units}`,
      units,
      halfLifeSeconds: k !== null && order.value === 1 ? Math.LN2 / k : null,
      halfLifeText: k === null
        ? 'not reported'
        : order.value === 1
          ? formatHalfLife(Math.LN2 / k)
          : 'not applicable (bimolecular rate depends on concentration)',
    };
  });
}

/**
 * Arrhenius fit of a temperature table: ln k = ln A − Ea/(R T).
 *
 * Refused with fewer than three points or a range under 10 K. For an Eyring
 * rate the fitted A absorbs the T in the TST prefactor, so `lnA` is an
 * effective value and `eaKcalPerMol` is the apparent activation energy.
 */
export function arrheniusFit(table) {
  const rows = (Array.isArray(table) ? table : [])
    .filter((row) => Number.isFinite(row?.temperatureK) && Number.isFinite(row?.k) && row.k > 0);
  if (rows.length < 3) {
    return {
      available: false,
      reason: `An Arrhenius fit needs at least three points; this table has ${rows.length}.`,
      points: rows.length,
    };
  }
  const range = rows[rows.length - 1].temperatureK - rows[0].temperatureK;
  if (range < 10) {
    return {
      available: false,
      reason: `An Arrhenius fit needs a temperature range of at least 10 K; this table spans ${range.toFixed(2)} K.`,
      points: rows.length,
      rangeK: range,
    };
  }
  const xs = rows.map((row) => 1 / row.temperatureK);
  const ys = rows.map((row) => Math.log(row.k));
  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) {
    sxx += (xs[index] - meanX) ** 2;
    sxy += (xs[index] - meanX) * (ys[index] - meanY);
  }
  if (sxx === 0) {
    return { available: false, reason: 'The table has one distinct temperature, so no slope exists.', points: n };
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  let ssTot = 0;
  for (let index = 0; index < n; index += 1) {
    ssRes += (ys[index] - (intercept + slope * xs[index])) ** 2;
    ssTot += (ys[index] - meanY) ** 2;
  }
  return {
    available: true,
    points: n,
    rangeK: range,
    eaKcalPerMol: -slope * GAS_CONSTANT_KCAL_PER_MOL_K,
    lnA: intercept,
    rSquared: ssTot === 0 ? null : 1 - ssRes / ssTot,
    scheme: 'ln k = ln A − Ea/(R T), least squares over the table; A is effective because the TST prefactor carries a factor of T',
  };
}

/**
 * The energetics block for one barrier.
 *
 * `deltaGKind: 'electronic-energy'` is the honest label for a ΔE taken from a
 * 0 K electronic difference: a rate is still offered, but it is an
 * electronic-energy estimate and never called an Eyring rate from ΔG‡.
 */
export function buildKinetics({
  deltaGkcal = null,
  deltaGKind = 'free-energy',
  deltaGLabel = null,
  freeEnergyKey = null,
  zpeIncluded = null,
  thermalIncluded = null,
  temperatureK = null,
  molecularity = null,
  temperatures = null,
  transmissionCoefficient = 1,
  refusalReason = null,
} = {}) {
  const order = typeof molecularity === 'number' ? { value: molecularity } : (molecularity || {});
  const units = order.units ?? unitsForMolecularity(order.value);
  const electronOnly = deltaGKind === 'electronic-energy';
  const assumedTemperature = !Number.isFinite(temperatureK);
  const kelvin = assumedTemperature ? STANDARD_STATE_TEMPERATURE_K : Number(temperatureK);
  const symbol = electronOnly ? 'ΔE' : 'ΔG‡';
  const label = deltaGLabel || (electronOnly ? 'E(TS) − E(reactant)' : 'G(TS) − G(reactant)');

  const warnings = [];
  if (electronOnly) {
    warnings.push('The barrier is an electronic-energy difference; no ZPE or thermal correction is included.');
  }
  if (assumedTemperature) {
    warnings.push(`The run temperature was not recorded; ${STANDARD_STATE_TEMPERATURE_K} K was used and is named as assumed.`);
  }

  const provenance = {
    temperature: {
      kelvin,
      assumed: assumedTemperature,
      statement: assumedTemperature
        ? `Run temperature not recorded; ${STANDARD_STATE_TEMPERATURE_K} K (the standard state) was used.`
        : `Temperature from the thermochemistry block: ${formatTemperature(kelvin)}.`,
    },
    deltaG: {
      kcalPerMol: Number.isFinite(deltaGkcal) ? Number(deltaGkcal) : null,
      kind: deltaGKind,
      label,
      freeEnergyKey: freeEnergyKey || null,
    },
    corrections: {
      zpe: zpeIncluded === null || zpeIncluded === undefined ? null : Boolean(zpeIncluded),
      thermal: thermalIncluded === null || thermalIncluded === undefined ? null : Boolean(thermalIncluded),
      statement: electronOnly
        ? 'No ZPE or thermal correction: the barrier is an electronic-energy difference.'
        : zpeIncluded && thermalIncluded
          ? `ZPE and thermal corrections are included: the free energy comes from ${freeEnergyKey || 'the thermochemistry block'}.`
          : 'Whether ZPE and thermal corrections are included was not recorded with the barrier.',
    },
    molecularity: {
      value: order.value ?? null,
      units,
      basis: order.basis || null,
    },
  };

  const assumptions = electronOnly
    ? [
      `Transition-state-theory prefactor kBT/h with ${symbol} in place of ΔG‡; transmission coefficient ${transmissionCoefficient}.`,
      'No ZPE or thermal correction is included: this is an electronic-energy estimate, not a transition-state-theory rate from ΔG‡.',
    ]
    : [
      `Transition-state theory: k = (kBT/h) exp(−ΔG‡/RT); transmission coefficient ${transmissionCoefficient}.`,
      'ΔG‡ from the same thermochemistry as the barrier, treated as temperature-independent across the table.',
      'Standard-state free energies at 1 mol L⁻¹; a bimolecular prefactor carries (c°)⁻¹, numerically 1 at c° = 1 M.',
    ];

  const base = {
    available: false,
    kind: electronOnly ? 'electronic-estimate' : 'eyring',
    label: electronOnly ? 'electronic-energy estimate' : 'transition-state-theory rate',
    deltaG: provenance.deltaG,
    temperatureK: kelvin,
    molecularity: order.value ?? null,
    units: units || null,
    k: null,
    kText: 'not reported',
    halfLifeSeconds: null,
    halfLifeText: 'not reported',
    table: [],
    fit: { available: false, reason: 'No temperature table was built.' },
    provenance,
    assumptions,
    warnings,
    refusal: null,
    scheme: electronOnly
      ? `k = (kBT/h) exp(−${symbol}/RT) — electronic-energy estimate`
      : 'k = (kBT/h) exp(−ΔG‡/RT)',
  };

  if (!units) {
    return {
      ...base,
      available: false,
      refusal: order.reason
        ? order.reason
        : 'the reaction molecularity is unknown, so the rate has no unit.',
    };
  }
  if (!Number.isFinite(deltaGkcal)) {
    return {
      ...base,
      available: false,
      refusal: refusalReason || `the activation ${symbol} (${label}) is missing or not a finite number.`,
    };
  }

  const k = eyringRate({ deltaGkcal: Number(deltaGkcal), temperatureKelvin: kelvin });
  if (k === null) {
    return {
      ...base,
      available: false,
      refusal: `eyringRate refused ΔG‡ = ${deltaGkcal} kcal mol⁻¹ at ${kelvin} K.`,
    };
  }

  const table = temperatureTable({
    deltaGkcal: Number(deltaGkcal),
    temperatureK: kelvin,
    temperatures,
    molecularity: { value: order.value, units, basis: order.basis || null },
  });
  const halfLife = order.value === 1 ? Math.LN2 / k : null;
  return {
    ...base,
    available: true,
    k,
    kText: `${formatRate(k)} ${units}`,
    halfLifeSeconds: halfLife,
    halfLifeText: halfLife === null
      ? 'not applicable (bimolecular rate depends on concentration)'
      : formatHalfLife(halfLife),
    table,
    fit: arrheniusFit(table),
  };
}

/**
 * One line for a card, a report or a console: k, unit, temperature and the
 * barrier it came from. A refusal prints `not reported` and the reason.
 */
export function kineticsSummaryLine(report) {
  if (!report || report.available !== true) {
    return `k = not reported — ${report?.refusal || 'no rate was computed'}`;
  }
  const word = orderWord(report.molecularity);
  const kind = report.kind === 'electronic-estimate' ? 'electronic-energy estimate' : `${word} TST`;
  return `k = ${report.kText} at ${formatTemperature(report.temperatureK)} — `
    + `ΔG‡ = ${Number(report.deltaG.kcalPerMol).toFixed(2)} kcal mol⁻¹ from ${report.deltaG.label}, ${kind}.`;
}

/** A project molecule for a task, by dataset record id, else the root molecule. */
function moleculeForTask(project, task) {
  const recordId = task?.record?.id;
  if (recordId) {
    for (const dataset of Array.isArray(project?.datasets) ? project.datasets : []) {
      const record = (Array.isArray(dataset?.records) ? dataset.records : []).find((entry) => entry?.id === recordId);
      if (record?.molecule) return record.molecule;
    }
  }
  return project?.molecule || null;
}

/**
 * The `kinetics` section of `ncs run`'s JSON summary.
 *
 * Built from the queue's reaction verdicts, the project's fragment labels (for
 * the unit) and the run records (for the temperature and the free-energy key).
 * A reaction whose verdict is a refusal stays a refusal with the queue's own
 * reason; no number is invented to fill the row.
 */
export function kineticsSummary({ project = null, queue = null, runRecords = {} } = {}) {
  const reactions = queue?.reactions && typeof queue.reactions === 'object' ? queue.reactions : {};
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const byNodeId = new Map(tasks.map((task) => [task.nodeId, task]));
  const entries = [];
  for (const task of tasks) {
    if (!task?.reaction || !Object.hasOwn(reactions, task.nodeId)) continue;
    const reaction = reactions[task.nodeId] || {};
    const tsTask = byNodeId.get(task.reaction.transitionStateNodeId) || null;
    const tsRecord = tsTask ? (runRecords[String(tsTask.runId)] || runRecords[tsTask.nodeId] || null) : null;
    const reactantTask = byNodeId.get(task.reaction.reactantNodeId) || null;
    const reactantMolecule = moleculeForTask(project, reactantTask) || moleculeForTask(project, task);
    const order = molecularityOf({
      reactant: reactantMolecule,
      transitionState: moleculeForTask(project, tsTask),
    });
    // Only a Gaussian thermochemistry record is known to be the
    // `Sum of electronic and thermal Free Energies` line; any other engine
    // keeps the correction fields as "not recorded".
    const gaussianFreeEnergy = tsRecord?.engine === 'gaussian'
      && Number.isFinite(tsRecord?.parsed?.thermochemistry?.freeEnergyHartree);
    const temperatureK = Number.isFinite(reaction.temperatureK)
      ? reaction.temperatureK
      : tsRecord?.parsed?.thermochemistry?.temperatureK;
    const report = buildKinetics({
      deltaGkcal: Number.isFinite(reaction.kcalPerMol) ? reaction.kcalPerMol : null,
      deltaGLabel: 'G(TS) − G(reactant)',
      freeEnergyKey: gaussianFreeEnergy ? 'Sum of electronic and thermal Free Energies' : null,
      zpeIncluded: gaussianFreeEnergy ? true : null,
      thermalIncluded: gaussianFreeEnergy ? true : null,
      temperatureK: Number.isFinite(temperatureK) ? temperatureK : null,
      molecularity: order,
      refusalReason: textOf(reaction.reason),
    });
    entries.push({
      nodeId: task.nodeId,
      transitionStateNodeId: task.reaction.transitionStateNodeId || null,
      reactantNodeId: task.reaction.reactantNodeId || null,
      available: report.available,
      k: report.k,
      kText: report.kText,
      units: report.units,
      molecularity: report.molecularity,
      molecularityBasis: report.provenance.molecularity.basis,
      temperatureK: report.temperatureK,
      halfLifeSeconds: report.halfLifeSeconds,
      deltaG: report.deltaG,
      table: report.table,
      fit: report.fit,
      provenance: report.provenance,
      refusal: reaction.available === false
        ? `${reaction.reason || 'the reaction path has no ΔG‡.'} k is not reported.`
        : report.refusal,
    });
  }
  return entries;
}

/** Trimmed non-empty string, or null. */
function textOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
