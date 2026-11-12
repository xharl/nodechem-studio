/**
 * Spectrum assignment (issue #348): Boltzmann-average one candidate's
 * conformers, compare the result with a measured trace, and rank candidates.
 *
 * The module answers three questions and refuses the fourth:
 *
 *   1. **What spectrum does one candidate have?** A candidate is a set of
 *      conformers of one molecule. Their populations are the weights
 *      `rankEnsemble()` stored on the ensemble — this module never recomputes a
 *      population from an energy, and a member without a stored population is a
 *      refusal, not a reason to renormalise over the members that have one.
 *   2. **How well does it match a measurement?** The computed and measured
 *      curves are broadened onto one common cm⁻¹ window, peak-scaled, and scored
 *      by a stated metric: cosine similarity of the two curves plus a band-wise
 *      positional score. The metric has an id and a version because a number
 *      without them is not reproducible.
 *   3. **Which candidate does the measurement support?** Candidates are ranked;
 *      the leader and its margin over the runner-up are stated.
 *   4. **What is never done?** A tautomer or a stereoisomer is a different
 *      molecule. Candidate spectra are never averaged together, and no
 *      population is shared across candidates. Cross-candidate averaging is
 *      refused by construction: each candidate is scored from its own members.
 *
 * The mode shape is the one `vcd.js`, `raman.js` and the frequency table already
 * produce:
 *
 *   - VCD: `{ wavenumber, rotationalStrength }`
 *   - Raman: `{ wavenumber, ramanActivity }`
 *   - IR: `{ wavenumber, irIntensity }` (from `normalModesMeta.frequencies` and
 *     `.irIntensities`, paired by index)
 *
 * Pure: no DOM, no Node APIs, no clock, no network.
 */

import { scaledModeTable } from './frequencyScaling.js';
import { MEASURED_MIN_POINTS } from './spectrumImport.js';

/**
 * The quantities this module can average and compare. `field` is the mode
 * property the parser already sets; `signed` decides whether a band of the
 * opposite sign can count as a match.
 */
export const ASSIGNMENT_QUANTITIES = Object.freeze({
  ir: Object.freeze({
    key: 'ir',
    label: 'IR',
    field: 'irIntensity',
    strengthLabel: 'IR intensity',
    units: 'km/mol',
    signed: false,
  }),
  vcd: Object.freeze({
    key: 'vcd',
    label: 'VCD',
    field: 'rotationalStrength',
    strengthLabel: 'VCD rotational strength',
    units: '10⁻⁴⁴ esu² cm²',
    signed: true,
  }),
  raman: Object.freeze({
    key: 'raman',
    label: 'Raman',
    field: 'ramanActivity',
    strengthLabel: 'Raman activity',
    units: 'Å⁴/amu',
    signed: false,
  }),
});

/** Candidate kinds this module ranks. None of them is averaged with another. */
export const ASSIGNMENT_CANDIDATE_KINDS = Object.freeze(['conformer-set', 'tautomer', 'stereoisomer']);

/**
 * The metric, versioned. Changing the weights, the band tolerance rule or the
 * sign rule is a new version — a score must say which definition produced it.
 */
export const SPECTRUM_MATCH_METRIC = Object.freeze({
  id: 'ncs-spectrum-match',
  version: 1,
  combined: '0.5 × cosine + 0.5 × bandScore',
  definition: 'Cosine similarity of the computed and measured broadened curves on their common cm⁻¹ '
    + 'window, peak-scaled to the same maximum (weight 0.5), plus a band-wise positional score '
    + '(weight 0.5). Bands are local maxima — maxima and minima for signed VCD — above 5% of the '
    + 'tallest |intensity|. Each measured band '
    + 'scores max(0, 1 − |Δν|/tolerance), weighted by its measured height; an unmatched band scores 0. '
    + 'For signed VCD, a computed band of the opposite sign scores 0.',
});

const DEFAULT_FWHM_CM = 12;
const DEFAULT_TOLERANCE_CM = 30;
const DEFAULT_TEMPERATURE_K = 298.15;
const DEFAULT_POINTS = 600;
const MATCH_POINTS = 400;
const POPULATION_TOLERANCE = 1e-6;
const BAND_THRESHOLD_RATIO = 0.05;
const MAX_BANDS = 40;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** `vcd`, `VCD`, `infrared` → the quantity record; null when unknown. */
export function assignmentQuantity(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'infrared') return ASSIGNMENT_QUANTITIES.ir;
  return ASSIGNMENT_QUANTITIES[key] || null;
}

function refusal(code, reason, extra = {}) {
  return {
    available: false,
    code,
    reason,
    ...extra,
  };
}

/**
 * The modes of one run record for a quantity, in the shape this module reads.
 *
 * A record that printed no such row returns `{ modes: [], reason }` — never an
 * empty success. IR is paired from the printed table by index, exactly as
 * `figures/report.js` pairs them; VCD and Raman are already per-mode arrays.
 */
export function modesFromRecord(record, quantity) {
  const spec = assignmentQuantity(quantity);
  if (!spec) return { modes: [], reason: `“${quantity}” is not a spectrum this module averages` };
  const parsed = isObject(record?.parsed) ? record.parsed : {};
  if (spec.key === 'vcd' || spec.key === 'raman') {
    const modes = Array.isArray(parsed[spec.key]) ? parsed[spec.key] : [];
    return modes.length > 0
      ? { modes }
      : { modes: [], reason: `the record printed no ${spec.label} rows` };
  }
  const meta = isObject(parsed.normalModesMeta) ? parsed.normalModesMeta : null;
  const frequencies = Array.isArray(meta?.frequencies) ? meta.frequencies : [];
  const intensities = Array.isArray(meta?.irIntensities) ? meta.irIntensities : [];
  const count = Math.min(frequencies.length, intensities.length);
  const modes = [];
  for (let index = 0; index < count; index += 1) {
    modes.push({ wavenumber: frequencies[index], irIntensity: intensities[index] });
  }
  return modes.length > 0
    ? { modes }
    : { modes: [], reason: 'the record printed no frequency/IR-intensity table' };
}

/**
 * One run record as a member of a candidate.
 *
 * `population` is read from `record.conformer.population` — the number the
 * ensemble stored when it ranked the member. It is never recomputed here. A
 * record with no conformer block has no population at all; that is recorded as
 * `null`, and a one-member candidate may still use it as weight 1 (there is no
 * average to take), while a multi-member candidate refuses it.
 */
export function memberFromRecord(record, quantity) {
  const spec = assignmentQuantity(quantity);
  const extracted = modesFromRecord(record, quantity);
  const conformer = isObject(record?.conformer) ? record.conformer : null;
  return {
    id: String(conformer?.id || record?.id || '').trim(),
    population: conformer?.population === null || conformer?.population === undefined
      ? null
      : finite(conformer.population),
    modes: extracted.modes,
    ...(extracted.reason ? { reason: extracted.reason } : {}),
    kind: spec?.key || '',
  };
}

/**
 * Boltzmann spectrum of one candidate from its members' stored populations.
 *
 * The curve is the population-weighted sum of each member's Lorentzian stick
 * spectrum. Because broadening is linear, that is exactly the stick sum with
 * every stick multiplied by its member's population; the returned `peaks` carry
 * both the printed strength and the weighted one, so the arithmetic can be
 * checked by hand.
 *
 * @param {Array<{id: string, population: number|null, modes: Array<object>}>} members
 * @param {object} [options]
 * @param {string} [options.quantity] `ir`, `vcd` or `raman`
 * @param {number} [options.fwhmCm] Lorentzian FWHM in cm⁻¹
 * @param {number} [options.points] curve points
 * @param {number} [options.temperatureK] the temperature the stored populations
 *   belong to; printed in provenance, never used to recompute them
 * @param {object|null} [options.scale] a `frequencyScaling.js` resolution
 * @param {string} [options.label] candidate label, echoed into the result
 */
export function boltzmannSpectrum(members, {
  quantity = 'vcd',
  fwhmCm = DEFAULT_FWHM_CM,
  points = DEFAULT_POINTS,
  temperatureK = DEFAULT_TEMPERATURE_K,
  scale = null,
  label = '',
} = {}) {
  const spec = assignmentQuantity(quantity);
  if (!spec) return refusal('unknown-quantity', `“${quantity}” is not a spectrum this module averages`);
  const fwhm = finite(fwhmCm);
  if (fwhm === null || fwhm <= 0) return refusal('bad-fwhm', 'a positive FWHM is required to broaden a spectrum');
  const pointCount = finite(points);
  if (pointCount === null || pointCount < 2) return refusal('bad-points', 'at least two curve points are required');
  const temperature = finite(temperatureK);
  if (temperature === null || temperature <= 0) {
    return refusal('bad-temperature', 'a positive temperature is required to label the stored populations');
  }
  if (!Array.isArray(members) || members.length === 0) {
    return refusal('empty-candidate', 'the candidate has no conformers; nothing is averaged');
  }

  const single = members.length === 1;
  const populations = [];
  const seenIds = new Set();
  for (const member of members) {
    const id = String(member?.id ?? '').trim();
    if (!id) return refusal('member-without-id', 'a member has no id; the population table cannot be built');
    if (seenIds.has(id)) {
      return refusal('duplicate-member-id', `member id ${id} appears twice; a population cannot be assigned to both rows`);
    }
    seenIds.add(id);
    const raw = member?.population;
    if ((raw === null || raw === undefined) && single) {
      populations.push({ id, population: 1, source: 'single member, no population stored' });
      continue;
    }
    const population = finite(raw);
    if (population === null || population <= 0) {
      return refusal(
        'member-without-population',
        `member ${id} has no stored population; an average is never renormalised over the members that have one`,
        { memberId: id },
      );
    }
    populations.push({ id, population, source: 'stored population' });
  }
  const total = populations.reduce((sum, entry) => sum + entry.population, 0);
  if (Math.abs(total - 1) > POPULATION_TOLERANCE) {
    return refusal(
      'populations-do-not-sum',
      `the stored populations of this candidate sum to ${total.toFixed(6)}, not 1; the ensemble was not retained as a set`,
    );
  }

  const prepared = [];
  for (const member of members) {
    const id = String(member?.id ?? '').trim();
    const list = Array.isArray(member?.modes) ? member.modes : [];
    const usable = list.filter((mode) => finite(mode?.wavenumber) !== null
      && finite(mode?.[spec.field]) !== null
      && (spec.signed || finite(mode?.[spec.field]) > 0));
    if (usable.length === 0) {
      return refusal(
        'member-without-strengths',
        `member ${id} carries no ${spec.strengthLabel}; refusing to average only the members that have ${spec.label} strengths`,
        { memberId: id, quantity: spec.key },
      );
    }
    prepared.push({
      id,
      modes: scaledModeTable(usable, scale),
      population: populations.find((entry) => entry.id === id).population,
    });
  }

  const all = prepared.flatMap((member) => member.modes.map((mode) => ({
    memberId: member.id,
    population: member.population,
    wavenumber: finite(mode.wavenumber),
    wavenumberRaw: finite(mode.wavenumberRaw) ?? finite(mode.wavenumber),
    strength: finite(mode[spec.field]),
  }))).filter((peak) => peak.wavenumber !== null && peak.strength !== null);

  const strongest = Math.max(...all.map((peak) => Math.abs(peak.population * peak.strength)));
  if (!Number.isFinite(strongest) || strongest <= 0) {
    return refusal('zero-intensity', `the candidate's ${spec.label} strengths are all zero; there is no curve to compare`);
  }

  const values = all.map((peak) => peak.wavenumber);
  const half = Math.max(fwhm / 2, 0.001);
  const pad = Math.max(6 * half, 20);
  const low = Math.min(...values) - pad;
  const high = Math.max(...values) + pad;
  const span = high - low || 1;
  const step = span / Math.max(pointCount - 1, 1);
  const curve = [];
  for (let index = 0; index < pointCount; index += 1) {
    const x = low + step * index;
    let intensity = 0;
    for (const peak of all) {
      const delta = x - peak.wavenumber;
      intensity += (peak.population * peak.strength * half * half) / (delta * delta + half * half);
    }
    curve.push({ wavenumber: x, intensity: intensity / strongest });
  }

  const peaks = all
    .map((peak) => ({
      memberId: peak.memberId,
      population: peak.population,
      wavenumber: peak.wavenumber,
      wavenumberRaw: peak.wavenumberRaw,
      strength: peak.strength,
      weightedStrength: peak.population * peak.strength,
      ...(spec.signed ? { sign: peak.strength >= 0 ? '+' : '−' } : {}),
    }))
    .sort((a, b) => a.wavenumber - b.wavenumber);

  return {
    available: true,
    code: null,
    reason: null,
    label: String(label || ''),
    quantity: spec.key,
    quantityLabel: spec.label,
    strengthLabel: spec.strengthLabel,
    units: spec.units,
    signed: spec.signed,
    shape: 'lorentzian',
    fwhmCm: fwhm,
    temperatureK: temperature,
    points: curve.length,
    normalisation: `strongest population-weighted |${spec.signed ? 'R' : 'strength'}| = 1.00 (${strongest.toFixed(4)} ${spec.units})`,
    populations,
    members: prepared.map((member) => ({
      id: member.id,
      population: member.population,
      modeCount: member.modes.length,
    })),
    scaling: scale
      ? {
        mode: scale.mode,
        factor: scale.applied ? Number(scale.factor) : 1,
        applied: scale.applied === true,
        key: scale.key ?? null,
        source: scale.source ?? null,
        doi: scale.doi ?? null,
        tableVersion: scale.tableVersion ?? null,
      }
      : null,
    minCm: low,
    maxCm: high,
    peaks,
    curve,
  };
}

/* ── Comparing with a measured trace ─────────────────────────── */

function sortedPoints(points) {
  const list = (Array.isArray(points) ? points : [])
    .map((point) => ({ x: finite(point?.x), y: finite(point?.y) }))
    .filter((point) => point.x !== null && point.y !== null);
  if (list.length < MEASURED_MIN_POINTS) return null;
  const ascending = list.every((point, index) => index === 0 || point.x > list[index - 1].x);
  const descending = list.every((point, index) => index === 0 || point.x < list[index - 1].x);
  if (!ascending && !descending) return null;
  return descending ? list.reverse() : list;
}

function interpolate(points, x) {
  if (x < points[0].x || x > points[points.length - 1].x) return null;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (x <= right.x) {
      const left = points[index - 1];
      const span = right.x - left.x;
      if (span === 0) return left.y;
      const t = (x - left.x) / span;
      return left.y + (right.y - left.y) * t;
    }
  }
  return points[points.length - 1].y;
}

function sampleCurve(curve, x) {
  const points = (Array.isArray(curve) ? curve : [])
    .map((point) => ({ x: finite(point?.wavenumber), y: finite(point?.intensity) }))
    .filter((point) => point.x !== null && point.y !== null);
  return points.length > 0 ? interpolate(points, x) : null;
}

function detectBands(series, { signed = false } = {}) {
  const points = Array.isArray(series) ? series : [];
  const max = Math.max(...points.map((point) => Math.abs(point.y)));
  if (!Number.isFinite(max) || max <= 0 || points.length < 3) return [];
  const bands = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1].y;
    const current = points[index].y;
    const next = points[index + 1].y;
    const isMax = current >= previous && current > next;
    const isMin = current <= previous && current < next;
    if (((signed && (isMax || isMin)) || (!signed && isMax))
      && Math.abs(current) >= BAND_THRESHOLD_RATIO * max) {
      bands.push({ wavenumber: points[index].x, height: current });
    }
  }
  return bands
    .sort((a, b) => Math.abs(b.height) - Math.abs(a.height))
    .slice(0, MAX_BANDS);
}

/**
 * Score one broadened computed spectrum against a measured trace.
 *
 * Both series are sampled on the same grid inside `window`; the measured trace
 * is scaled once, by the ratio of the two maxima, and that factor is returned.
 * The cosine is computed on the scaled curves; the band score matches each
 * measured band to the nearest computed band inside `toleranceCm`.
 *
 * @param {object} computed the object `boltzmannSpectrum()` returned
 * @param {object} measured `{ points, axis, source, sha256, units }`
 * @param {object} [options]
 * @param {number} [options.toleranceCm] band-match tolerance
 * @param {{minCm:number, maxCm:number}|null} [options.window] common window;
 *   when omitted, the computed/measured overlap is used
 */
export function spectrumMatch(computed, measured, {
  toleranceCm = DEFAULT_TOLERANCE_CM,
  window = null,
} = {}) {
  if (!computed?.available) {
    return refusal(computed?.code || 'no-computed-spectrum', computed?.reason || 'there is no computed spectrum to compare');
  }
  const tolerance = finite(toleranceCm);
  if (tolerance === null || tolerance <= 0) return refusal('bad-tolerance', 'a positive band tolerance is required');

  const axis = String(measured?.axis ?? '').trim().toLowerCase();
  if (axis !== 'wavenumber') {
    return refusal(
      'measured-axis',
      `the measured trace is on ${axis ? `a “${axis}”` : 'an undeclared'} x axis; a vibrational assignment compares a cm⁻¹ trace and this build does not convert nm to cm⁻¹`,
    );
  }
  const points = sortedPoints(measured?.points);
  if (!points) {
    return refusal(
      'measured-trace',
      `the measured trace is not a single monotonic series of at least ${MEASURED_MIN_POINTS} finite points`,
    );
  }

  const measuredMin = points[0].x;
  const measuredMax = points[points.length - 1].x;
  const low = window ? finite(window.minCm) : Math.max(computed.minCm, measuredMin);
  const high = window ? finite(window.maxCm) : Math.min(computed.maxCm, measuredMax);
  if (low === null || high === null || high - low <= tolerance) {
    return refusal(
      'window',
      'the computed spectrum and the measured trace share no cm⁻¹ window wide enough to score',
    );
  }

  const computedSeries = [];
  const measuredSeries = [];
  for (let index = 0; index < MATCH_POINTS; index += 1) {
    const x = low + ((high - low) * index) / (MATCH_POINTS - 1);
    const computedY = sampleCurve(computed.curve, x);
    const measuredY = interpolate(points, x);
    if (computedY === null || measuredY === null) {
      return refusal('window', `the measured trace does not cover ${x.toFixed(2)} cm⁻¹ inside the compared window`);
    }
    computedSeries.push({ x, y: computedY });
    measuredSeries.push({ x, y: measuredY });
  }

  const computedPeak = Math.max(...computedSeries.map((point) => Math.abs(point.y)));
  const measuredPeak = Math.max(...measuredSeries.map((point) => Math.abs(point.y)));
  if (computedPeak <= 0) return refusal('zero-intensity', 'the computed curve has no intensity in the compared window');
  if (measuredPeak <= 0) return refusal('zero-intensity', 'the measured trace has no intensity in the compared window');
  const scaleFactor = computedPeak / measuredPeak;
  const scaledMeasured = measuredSeries.map((point) => ({ x: point.x, y: point.y * scaleFactor }));

  let dot = 0;
  let normComputed = 0;
  let normMeasured = 0;
  for (let index = 0; index < computedSeries.length; index += 1) {
    const a = computedSeries[index].y;
    const b = scaledMeasured[index].y;
    dot += a * b;
    normComputed += a * a;
    normMeasured += b * b;
  }
  const cosine = normComputed > 0 && normMeasured > 0
    ? dot / Math.sqrt(normComputed * normMeasured)
    : 0;

  const computedBands = detectBands(computedSeries, { signed: computed.signed === true });
  const measuredBands = detectBands(scaledMeasured, { signed: computed.signed === true });
  const used = new Set();
  let weighted = 0;
  let weightTotal = 0;
  let matched = 0;
  const bands = measuredBands.map((band, bandIndex) => {
    let best = null;
    for (let index = 0; index < computedBands.length; index += 1) {
      if (used.has(index)) continue;
      const delta = Math.abs(computedBands[index].wavenumber - band.wavenumber);
      if (delta > tolerance) continue;
      if (best === null || delta < best.delta) best = { index, delta };
    }
    const weight = Math.abs(band.height);
    weightTotal += weight;
    if (best === null) {
      return {
        index: bandIndex + 1,
        measuredCm: band.wavenumber,
        computedCm: null,
        deltaCm: null,
        measuredHeight: band.height,
        computedHeight: null,
        score: 0,
        signMatch: null,
        matched: false,
      };
    }
    used.add(best.index);
    const computedBand = computedBands[best.index];
    const signMatch = computed.signed
      ? Math.sign(computedBand.height) === Math.sign(band.height)
      : true;
    const score = signMatch ? Math.max(0, 1 - best.delta / tolerance) : 0;
    weighted += weight * score;
    matched += 1;
    return {
      index: bandIndex + 1,
      measuredCm: band.wavenumber,
      computedCm: computedBand.wavenumber,
      deltaCm: computedBand.wavenumber - band.wavenumber,
      measuredHeight: band.height,
      computedHeight: computedBand.height,
      score,
      signMatch,
      matched: true,
    };
  });
  const bandScore = weightTotal > 0 ? weighted / weightTotal : 0;
  const combined = 0.5 * cosine + 0.5 * bandScore;

  return {
    available: true,
    code: null,
    reason: null,
    cosine,
    bandScore,
    combined,
    metric: SPECTRUM_MATCH_METRIC,
    toleranceCm: tolerance,
    window: { minCm: low, maxCm: high, points: MATCH_POINTS },
    scale: {
      mode: 'peak',
      factor: scaleFactor,
      reference: 'measured maximum scaled to the computed maximum in the compared window',
    },
    bandCounts: { computed: computedBands.length, measured: measuredBands.length, matched },
    bands,
    // The two curves the score was computed from, on the common window: the
    // computed one at its own 600-point resolution is in the candidate
    // spectrum; this is the measured trace scaled to that candidate's maximum.
    measuredCurve: scaledMeasured.map((point) => ({ wavenumber: point.x, intensity: point.y })),
  };
}

/* ── Ranking candidates ──────────────────────────────────────── */

/**
 * Rank candidate structures against one measured trace.
 *
 * Each candidate is averaged from its own members only. The comparison window
 * is shared by every candidate (the intersection of all computed ranges and the
 * measured range), because scoring each candidate over a different window would
 * compare each one with a different experiment.
 *
 * @param {object} input
 * @param {Array<{id:string,label?:string,kind?:string,members:Array<object>}>} input.candidates
 * @param {object} input.measured `{ points, axis, source, sha256, units }`
 */
export function rankCandidates({
  candidates = [],
  measured = null,
  quantity = 'vcd',
  fwhmCm = DEFAULT_FWHM_CM,
  toleranceCm = DEFAULT_TOLERANCE_CM,
  temperatureK = DEFAULT_TEMPERATURE_K,
  points = DEFAULT_POINTS,
  scale = null,
} = {}) {
  const spec = assignmentQuantity(quantity);
  if (!spec) return refusal('unknown-quantity', `“${quantity}” is not a spectrum this module averages`);
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return refusal('insufficient-candidates', 'ranking needs at least two candidates; a single candidate is compared, not ranked');
  }
  const measuredAxis = String(measured?.axis ?? '').trim().toLowerCase();
  if (measuredAxis !== 'wavenumber') {
    return refusal(
      'measured-axis',
      `the measured trace is on ${measuredAxis ? `a “${measuredAxis}”` : 'an undeclared'} x axis; a vibrational assignment compares a cm⁻¹ trace and this build does not convert nm to cm⁻¹`,
    );
  }
  const tolerance = finite(toleranceCm);
  if (tolerance === null || tolerance <= 0) return refusal('bad-tolerance', 'a positive band tolerance is required');

  const scored = [];
  const refused = [];
  for (const candidate of candidates) {
    const id = String(candidate?.id ?? '').trim();
    const kind = String(candidate?.kind ?? 'conformer-set').trim().toLowerCase();
    if (!id) {
      refused.push({ id: '', kind, reason: 'a candidate has no id, so it cannot be named in the ranking' });
      continue;
    }
    if (!ASSIGNMENT_CANDIDATE_KINDS.includes(kind)) {
      refused.push({ id, kind, reason: `candidate ${id} declares kind “${kind}”, which is not one of ${ASSIGNMENT_CANDIDATE_KINDS.join(', ')}` });
      continue;
    }
    const spectrum = boltzmannSpectrum(candidate.members, {
      quantity: spec.key,
      fwhmCm,
      points,
      temperatureK,
      scale,
      label: candidate.label || id,
    });
    if (!spectrum.available) {
      refused.push({ id, kind, reason: spectrum.reason, code: spectrum.code });
      continue;
    }
    scored.push({
      id,
      label: String(candidate.label || id),
      kind,
      memberCount: spectrum.members.length,
      populations: spectrum.populations,
      spectrum,
    });
  }
  if (scored.length < 2) {
    return refusal(
      'insufficient-candidates',
      scored.length === 0
        ? `no candidate could be averaged: ${refused.map((entry) => `${entry.id || '(unnamed)'} — ${entry.reason}`).join('; ')}`
        : `only one candidate could be averaged (${scored[0].id}); a ranking needs two${refused.length ? `; refused: ${refused.map((entry) => `${entry.id} — ${entry.reason}`).join('; ')}` : ''}`,
      { refused },
    );
  }

  const measuredPoints = sortedPoints(measured?.points);
  const measuredMin = measuredPoints ? measuredPoints[0].x : null;
  const measuredMax = measuredPoints ? measuredPoints[measuredPoints.length - 1].x : null;
  const low = Math.max(...scored.map((entry) => entry.spectrum.minCm), measuredMin ?? -Infinity);
  const high = Math.min(...scored.map((entry) => entry.spectrum.maxCm), measuredMax ?? Infinity);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high - low <= tolerance) {
    return refusal('window', 'the candidates and the measured trace share no cm⁻¹ window wide enough to rank them', { refused });
  }
  const window = { minCm: low, maxCm: high };

  for (const entry of scored) {
    const comparison = spectrumMatch(entry.spectrum, measured, { toleranceCm: tolerance, window });
    if (!comparison.available) {
      refused.push({ id: entry.id, kind: entry.kind, reason: comparison.reason, code: comparison.code });
      entry.comparison = null;
    } else {
      entry.comparison = comparison;
    }
  }
  const ranked = scored
    .filter((entry) => entry.comparison)
    .sort((a, b) => (b.comparison.combined - a.comparison.combined)
      || (b.comparison.bandScore - a.comparison.bandScore)
      || (b.comparison.cosine - a.comparison.cosine)
      || a.id.localeCompare(b.id));
  if (ranked.length < 2) {
    return refusal('insufficient-candidates', 'fewer than two candidates could be scored against the measured trace', { refused });
  }

  const leader = ranked[0];
  const runnerUp = ranked[1];
  const margin = {
    combined: leader.comparison.combined - runnerUp.comparison.combined,
    cosine: leader.comparison.cosine - runnerUp.comparison.cosine,
    bandScore: leader.comparison.bandScore - runnerUp.comparison.bandScore,
  };

  const result = {
    available: true,
    code: null,
    reason: null,
    quantity: spec.key,
    quantityLabel: spec.label,
    units: spec.units,
    signed: spec.signed,
    metric: SPECTRUM_MATCH_METRIC,
    fwhmCm: finite(fwhmCm),
    toleranceCm: tolerance,
    temperatureK: finite(temperatureK),
    points: Number(points),
    measured: {
      source: String(measured?.source ?? 'measured trace'),
      sha256: String(measured?.sha256 ?? ''),
      axis: 'wavenumber',
      units: String(measured?.units?.x ?? measured?.units ?? 'cm⁻¹'),
      points: measuredPoints?.length ?? 0,
    },
    window,
    averaging: 'Boltzmann-weighted within each candidate only, from the populations the ensemble stored',
    crossCandidateAveraging: 'refused',
    candidates: ranked.map((entry) => ({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      memberCount: entry.memberCount,
      populations: entry.populations,
      spectrum: {
        quantity: entry.spectrum.quantity,
        fwhmCm: entry.spectrum.fwhmCm,
        temperatureK: entry.spectrum.temperatureK,
        normalisation: entry.spectrum.normalisation,
        scaling: entry.spectrum.scaling,
        minCm: entry.spectrum.minCm,
        maxCm: entry.spectrum.maxCm,
        peaks: entry.spectrum.peaks,
        curve: entry.spectrum.curve,
      },
      comparison: entry.comparison,
    })),
    refused,
    ranking: ranked.map((entry) => entry.id),
    leader: { id: leader.id, label: leader.label, kind: leader.kind, comparison: leader.comparison },
    runnerUp: { id: runnerUp.id, label: runnerUp.label, kind: runnerUp.kind, comparison: runnerUp.comparison },
    margin,
  };
  result.provenance = assignmentProvenance(result);
  return result;
}

/**
 * The provenance block a record carries beside the result.
 *
 * It states every input the score depended on: each member's stored population,
 * the FWHM, the band tolerance, each candidate's measured-scale factor, the
 * measured trace's name and digest, and the metric's id, version and definition.
 * It is built from the result, never recomputed from the inputs.
 */
export function assignmentProvenance(result) {
  const base = {
    kind: 'spectrum-assignment',
    metric: result?.metric || SPECTRUM_MATCH_METRIC,
    quantity: result?.quantity ?? null,
    fwhmCm: result?.fwhmCm ?? null,
    toleranceCm: result?.toleranceCm ?? null,
    temperatureK: result?.temperatureK ?? null,
  };
  if (!result?.available) {
    return {
      ...base,
      available: false,
      code: result?.code || 'unavailable',
      reason: result?.reason || 'no assignment was computed',
    };
  }
  return {
    ...base,
    available: true,
    averaging: result.averaging,
    crossCandidateAveraging: result.crossCandidateAveraging,
    measured: result.measured,
    window: result.window,
    populations: result.candidates.map((candidate) => ({
      candidateId: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      members: candidate.populations.map((member) => ({
        id: member.id,
        population: member.population,
        source: member.source,
      })),
    })),
    scaleFactors: result.candidates.map((candidate) => ({
      candidateId: candidate.id,
      mode: candidate.comparison.scale.mode,
      factor: candidate.comparison.scale.factor,
    })),
    ranking: result.ranking,
    leader: result.leader ? { id: result.leader.id, label: result.leader.label } : null,
    margin: result.margin,
  };
}

/**
 * Attach the result and its provenance to a run record.
 *
 * `spectrumAssignment` is the result the card and the report both print;
 * `provenance.spectrumAssignment` is the same provenance block, so a reader of
 * the record alone can see the populations, FWHM, scale factors and metric
 * version the numbers depended on.
 */
export function withSpectrumAssignment(record, result) {
  const provenance = isObject(record?.provenance) ? record.provenance : {};
  return {
    ...(isObject(record) ? record : {}),
    spectrumAssignment: result,
    provenance: {
      ...provenance,
      spectrumAssignment: assignmentProvenance(result),
    },
  };
}

/* ── Rendering: one panel, read by the card and the report ───── */

const MISSING = 'not reported';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(value, digits = null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return MISSING;
  return digits === null ? String(value) : Number(value).toFixed(digits);
}

const escapeText = (value) => escapeHtml(value ?? MISSING);

/**
 * The leader's computed and measured curves on their common window, drawn in
 * the 100 × 60 box the other small figures use. Solid is computed, dashed is
 * measured; a signed VCD curve is drawn about the midline, so the sign is
 * visible without a legend.
 */
function assignmentCurveSvg(candidate, { signed }) {
  const comparison = candidate.comparison;
  const low = comparison.window?.minCm;
  const high = comparison.window?.maxCm;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return '';
  const computed = Array.isArray(candidate.spectrum?.curve) ? candidate.spectrum.curve : [];
  const measured = (comparison.measuredCurve || [])
    .map((point) => ({ x: finite(point?.wavenumber), y: finite(point?.intensity) }))
    .filter((point) => point.x !== null && point.y !== null);
  if (computed.length === 0 || measured.length === 0) return '';

  const width = 100;
  const height = 60;
  const mid = signed ? height / 2 : height;
  const n = 240;
  const computedPoints = [];
  const measuredPoints = [];
  for (let index = 0; index < n; index += 1) {
    const x = low + ((high - low) * index) / (n - 1);
    const computedY = sampleCurve(computed, x);
    const measuredY = interpolate(measured, x);
    if (computedY === null || measuredY === null) continue;
    computedPoints.push({ x, y: computedY });
    measuredPoints.push({ x, y: measuredY });
  }
  if (computedPoints.length === 0) return '';
  const peak = Math.max(1e-9, ...[...computedPoints, ...measuredPoints].map((point) => Math.abs(point.y)));
  const mapY = (value) => mid - (value / peak) * (signed ? height / 2 - 2 : height - 4);
  const polyline = (points) => points
    .map((point) => `${(((point.x - low) / (high - low)) * width).toFixed(2)},${mapY(point.y).toFixed(2)}`)
    .join(' ');

  return '<figure class="results-spectrum" data-field="assignment-curve">'
    + `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="computed and measured ${escapeHtml(candidate.label)} spectrum">`
    + (signed ? `<line x1="0" y1="${mid}" x2="${width}" y2="${mid}" stroke="currentColor" stroke-width="0.4" opacity="0.5"/>` : '')
    + `<polyline points="${polyline(computedPoints)}" fill="none" stroke="currentColor" stroke-width="1"/>`
    + `<polyline points="${polyline(measuredPoints)}" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.75"/>`
    + '</svg>'
    + `<figcaption>Computed (solid) and measured (dashed) · window ${fmt(low, 1)}–${fmt(high, 1)} cm⁻¹ `
    + `· Lorentzian FWHM ${fmt(candidate.spectrum?.fwhmCm, 1)} cm⁻¹ · `
    + `measured ×${fmt(comparison.scale?.factor, 4)}</figcaption>`
    + '</figure>';
}

/**
 * Renders the assignment result once, for both surfaces.
 *
 * The results card and the workflow report call this function with the same
 * `result` object; neither recomputes a score. The `data-field` spans carry the
 * leader's combined score, the margin and the metric id/version verbatim, so a
 * test can compare the two surfaces number for number.
 *
 * @param {object} result the object `rankCandidates()` returned
 * @param {object} [options]
 * @param {string} [options.tableClass] the table class of the host surface
 * @param {string} [options.heading] an `<h4>` label, omitted inside a card
 * @param {boolean} [options.compact] print only the leader's first 12 bands
 */
export function assignmentPanelHtml(result, { tableClass = '', heading = '', compact = false } = {}) {
  const className = tableClass ? ` class="${escapeHtml(tableClass)}"` : '';
  const label = heading ? `<h4 data-field="assignment-entry">${escapeHtml(heading)}</h4>` : '';
  if (!result || typeof result !== 'object') {
    return label + '<p class="warn" data-field="assignment-state">no spectrum assignment was recorded for this block</p>';
  }
  if (result.available !== true) {
    return `${label}<p class="warn" data-field="assignment-refusal">Spectrum assignment not computed — `
      + `${escapeHtml(result.reason || result.code || 'unknown reason')}</p>`;
  }

  const metric = result.metric || SPECTRUM_MATCH_METRIC;
  const metricId = `${metric.id}/${metric.version}`;
  const leader = result.leader || {};
  const runnerUp = result.runnerUp || {};
  const leaderScore = leader.comparison?.combined;
  const margin = result.margin?.combined;

  const rows = result.candidates.map((candidate, index) => {
    const next = result.candidates[index + 1];
    const rowMargin = next
      ? candidate.comparison.combined - next.comparison.combined
      : null;
    return '<tr>'
      + `<td class="num">${index + 1}</td>`
      + `<td><strong>${escapeText(candidate.label)}</strong></td>`
      + `<td>${escapeText(candidate.kind)}</td>`
      + `<td class="num">${escapeText(candidate.memberCount)}</td>`
      + `<td class="num" data-field="assignment-cosine">${escapeText(fmt(candidate.comparison.cosine, 4))}</td>`
      + `<td class="num" data-field="assignment-band-score">${escapeText(fmt(candidate.comparison.bandScore, 4))}</td>`
      + `<td class="num" data-field="assignment-combined">${escapeText(fmt(candidate.comparison.combined, 4))}</td>`
      + `<td class="num" data-field="assignment-row-margin">${escapeText(rowMargin === null ? '—' : fmt(rowMargin, 4))}</td>`
      + `<td class="num" data-field="assignment-scale-factor">${escapeText(fmt(candidate.comparison.scale.factor, 4))}</td>`
      + `<td class="num">${escapeText(candidate.comparison.bandCounts.matched)}/${escapeText(candidate.comparison.bandCounts.measured)}</td>`
      + '</tr>';
  }).join('');
  const table = '<table' + className + ' data-field="assignment-ranking"><thead><tr>'
    + '<th class="num">Rank</th><th>Candidate</th><th>Kind</th><th class="num">Conformers</th>'
    + '<th class="num">Cosine</th><th class="num">Band score</th><th class="num">Combined</th>'
    + '<th class="num">Margin to next</th><th class="num">Scale factor</th><th class="num">Bands</th>'
    + `</tr></thead><tbody>${rows}</tbody></table>`;

  const verdict = leaderScore !== undefined && margin !== undefined
    ? `<p data-field="assignment-verdict"><strong>${escapeText(leader.label)} is supported by the measurement</strong> — `
      + `combined <span data-field="assignment-leader-score">${escapeText(fmt(leaderScore, 4))}</span>, `
      + `margin <span data-field="assignment-margin">${escapeText(fmt(margin, 4))}</span> `
      + `over ${escapeText(runnerUp.label)} (<span data-field="assignment-metric">${escapeHtml(metricId)}</span>).</p>`
    : `<p class="warn" data-field="assignment-verdict">only one candidate could be scored, so no margin is reported `
      + `(<span data-field="assignment-metric">${escapeHtml(metricId)}</span>).</p>`;

  const leaderCandidate = result.candidates[0] || null;
  const curve = leaderCandidate ? assignmentCurveSvg(leaderCandidate, { signed: result.signed === true }) : '';

  const shown = compact ? result.candidates.slice(0, 1) : result.candidates;
  const bandTables = shown.map((candidate) => {
    const bands = Array.isArray(candidate.comparison.bands) ? candidate.comparison.bands : [];
    const limit = compact ? 12 : bands.length;
    const bandRows = bands.slice(0, limit).map((band) => '<tr>'
      + `<td class="num">${escapeText(band.index)}</td>`
      + `<td class="num">${escapeText(fmt(band.computedCm, 1))}</td>`
      + `<td class="num">${escapeText(fmt(band.measuredCm, 1))}</td>`
      + `<td class="num">${escapeText(band.deltaCm === null ? '—' : fmt(band.deltaCm, 1))}</td>`
      + `<td class="num">${escapeText(fmt(band.score, 3))}</td>`
      + `<td>${band.matched ? (band.signMatch === false ? 'sign disagrees' : 'matched') : 'unmatched'}</td>`
      + '</tr>').join('');
    return `<p class="meta" data-field="assignment-bands-label">${escapeText(candidate.label)} — `
      + `${escapeText(candidate.comparison.bandCounts.matched)} of ${escapeText(candidate.comparison.bandCounts.measured)} `
      + `measured bands matched within ${escapeText(fmt(result.toleranceCm, 1))} cm⁻¹.</p>`
      + '<table' + className + ' data-field="assignment-bands"><thead><tr><th class="num">#</th>'
      + '<th class="num">Computed / cm⁻¹</th><th class="num">Measured / cm⁻¹</th>'
      + '<th class="num">Δ / cm⁻¹</th><th class="num">Score</th><th>Match</th></tr></thead>'
      + `<tbody>${bandRows}</tbody></table>`
      + (bands.length > limit ? `<p class="meta">${bands.length - limit} more bands are in the result object but not printed here.</p>` : '');
  }).join('');

  const populations = result.candidates
    .map((candidate) => `${candidate.label} (${candidate.kind}): ${candidate.populations
      .map((member) => `${member.id} ${(member.population * 100).toFixed(1)}%`).join(', ')}`)
    .join('; ');
  const scales = result.provenance?.scaleFactors
    ? result.provenance.scaleFactors.map((entry) => `${entry.candidateId} ×${fmt(entry.factor, 4)}`).join(', ')
    : MISSING;

  return label
    + `<p class="meta" data-field="assignment-terms">${escapeText(result.quantityLabel)} · `
      + `Lorentzian FWHM ${escapeText(fmt(result.fwhmCm, 1))} cm⁻¹ · `
      + `${escapeText(fmt(result.temperatureK, 2))} K · `
      + `band tolerance ${escapeText(fmt(result.toleranceCm, 1))} cm⁻¹ · `
      + `measured ${escapeText(result.measured?.source || 'trace')}`
      + (result.measured?.sha256 ? ` (SHA-256 ${escapeHtml(result.measured.sha256.slice(0, 12))}…)` : '')
      + ` · window ${escapeText(fmt(result.window?.minCm, 1))}–${escapeText(fmt(result.window?.maxCm, 1))} cm⁻¹`
      + ` · metric <span data-field="assignment-metric">${escapeHtml(metricId)}</span></p>`
    + verdict
    + curve
    + table
    + `<p class="meta" data-field="assignment-averaging">${escapeText(result.averaging)}. `
      + '<strong>Candidates are ranked, never merged</strong>: a tautomer or a stereoisomer is a different molecule, '
      + 'so no population and no curve is shared across candidates.</p>'
    + bandTables
    + `<p class="meta" data-field="assignment-provenance">provenance — populations: ${escapeText(populations)}; `
      + `FWHM ${escapeText(fmt(result.fwhmCm, 1))} cm⁻¹; scale factors: ${escapeText(scales)}; `
      + `metric ${escapeHtml(metricId)}: ${escapeText(metric.definition)}</p>`
    + (Array.isArray(result.refused) && result.refused.length > 0
      ? `<p class="warn" data-field="assignment-refused">Refused: ${escapeText(result.refused
        .map((entry) => `${entry.id || '(unnamed)'} — ${entry.reason}`).join('; '))}</p>`
      : '');
}
