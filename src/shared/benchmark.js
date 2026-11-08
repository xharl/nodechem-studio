/**
 * Benchmark comparison against a shipped, cited reference dataset.
 *
 * The first dataset is experimental equilibrium bond lengths from the NIST
 * CCCBDB. A computed geometry is reduced to its perceived bonds and each bond
 * is compared with the cited reference value; the summary reports the mean
 * signed error (systematic bias), MAE, RMSE, maximum absolute error and the
 * spread of the signed errors, per property and per level of theory.
 *
 * A reference entry the tool cannot compute is kept in the result as
 * `not computed` with a reason. It is never dropped: dropping it would make
 * the reported error look better than the comparison actually was.
 *
 * Pure: no filesystem, no network. The reference data ships with the module.
 */

import { COVALENT_RADII_ANGSTROM } from './validityChecks.js';
import { BENCHMARK_DATASETS, EXPERIMENTAL_BOND_LENGTHS } from './referenceData/experimentalBondLengths.js';

export { BENCHMARK_DATASETS, EXPERIMENTAL_BOND_LENGTHS };

/** A bond is perceived when the distance is at most this × the covalent-radius sum. */
export const BOND_PERCEPTION_FACTOR = 1.3;

export const BENCHMARK_DEFAULT_DATASET = 'experimental-bond-lengths';

function oneLine(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normaliseElement(value) {
  const raw = oneLine(value, 3);
  if (!raw) return '';
  return raw[0].toUpperCase() + raw.slice(1).toLowerCase();
}

/** `H`, `O`, `H` → `{ H: 2, O: 1 }`. */
export function compositionOf(atoms) {
  const counts = {};
  for (const atom of Array.isArray(atoms) ? atoms : []) {
    const element = normaliseElement(atom?.element);
    if (!element) continue;
    counts[element] = (counts[element] || 0) + 1;
  }
  return counts;
}

function sameComposition(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] || 0) !== (b[key] || 0)) return false;
  return true;
}

function compositionText(counts) {
  return Object.entries(counts || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([element, count]) => `${element}${count === 1 ? '' : count}`)
    .join('');
}

function bondKey(elements) {
  return [...elements].sort().join('-');
}

/**
 * Perceive bonds from a geometry and return every bond length.
 *
 * Uses the Cordero single-bond covalent radii already shipped for the geometry
 * validity check. An element outside that table is skipped rather than given a
 * guessed radius.
 */
export function bondLengthsFromGeometry(atoms, { factor = BOND_PERCEPTION_FACTOR } = {}) {
  const list = Array.isArray(atoms) ? atoms : [];
  const bonds = [];
  for (let i = 0; i < list.length; i += 1) {
    const left = list[i];
    const leftElement = normaliseElement(left?.element);
    const leftRadius = COVALENT_RADII_ANGSTROM[leftElement];
    if (!Number.isFinite(leftRadius)) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const right = list[j];
      const rightElement = normaliseElement(right?.element);
      const rightRadius = COVALENT_RADII_ANGSTROM[rightElement];
      if (!Number.isFinite(rightRadius)) continue;
      const dx = Number(left.x) - Number(right.x);
      const dy = Number(left.y) - Number(right.y);
      const dz = Number(left.z) - Number(right.z);
      if (![dx, dy, dz].every(Number.isFinite)) continue;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!Number.isFinite(length) || length <= 0) continue;
      if (length <= factor * (leftRadius + rightRadius)) {
        bonds.push({
          i,
          j,
          elements: [leftElement, rightElement].sort(),
          length,
        });
      }
    }
  }
  return bonds;
}

function notComputed(entry, reason, extra = {}) {
  return {
    entryId: entry.id,
    name: entry.name,
    formula: entry.formula,
    property: entry.property || 'bond_length',
    unit: entry.units,
    level: entry.level,
    status: 'not computed',
    computed: null,
    reference: null,
    error: null,
    reason,
    ...extra,
  };
}

/**
 * Compare one reference entry with one computed geometry.
 *
 * Returns one point per reference bond; a composition mismatch, a wrong bond
 * count or an unperceivable geometry produces a single `not computed` point
 * with the reason.
 */
export function compareEntry(entry, geometry) {
  const atoms = Array.isArray(geometry?.atoms) ? geometry.atoms : [];
  const computedComposition = compositionOf(atoms);
  if (!sameComposition(computedComposition, entry.composition || {})) {
    return [notComputed(
      entry,
      `composition ${compositionText(computedComposition) || '(none)'} does not match ${entry.formula}`,
      { runId: geometry?.id ?? null, runLabel: geometry?.label ?? null },
    )];
  }
  const bonds = bondLengthsFromGeometry(atoms);
  const points = [];
  for (const spec of entry.bonds) {
    const key = bondKey(spec.elements);
    const matching = bonds.filter((bond) => bondKey(bond.elements) === key);
    if (matching.length !== spec.count) {
      points.push(notComputed(
        entry,
        `expected ${spec.count} ${spec.label} bond${spec.count === 1 ? '' : 's'}, found ${matching.length}`,
        { runId: geometry?.id ?? null, runLabel: geometry?.label ?? null },
      ));
      continue;
    }
    for (const bond of matching) {
      const error = bond.length - spec.length;
      points.push({
        entryId: entry.id,
        name: entry.name,
        formula: entry.formula,
        property: 'bond_length',
        bond: spec.label,
        unit: entry.units,
        level: entry.level,
        source: entry.source,
        citation: entry.citation,
        runId: geometry?.id ?? null,
        runLabel: geometry?.label ?? geometry?.level ?? null,
        status: 'computed',
        computed: bond.length,
        reference: spec.length,
        error,
        absError: Math.abs(error),
        reason: null,
      });
    }
  }
  return points;
}

function emptySummary() {
  return {
    n: 0,
    mae: null,
    rmse: null,
    maxAbsError: null,
    meanSignedError: null,
    minSignedError: null,
    maxSignedError: null,
    spread: null,
    stdDev: null,
    unit: null,
  };
}

/** MAE / RMSE / maximum error / systematic bias / spread over computed points. */
export function summarizePoints(points) {
  const computed = (Array.isArray(points) ? points : []).filter((point) => point.status === 'computed'
    && Number.isFinite(point.error));
  if (computed.length === 0) return emptySummary();
  const errors = computed.map((point) => point.error);
  const n = errors.length;
  const meanSignedError = errors.reduce((sum, value) => sum + value, 0) / n;
  const mae = errors.reduce((sum, value) => sum + Math.abs(value), 0) / n;
  const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / n);
  const maxAbsError = Math.max(...errors.map((value) => Math.abs(value)));
  const minSignedError = Math.min(...errors);
  const maxSignedError = Math.max(...errors);
  const stdDev = Math.sqrt(errors.reduce((sum, value) => sum + (value - meanSignedError) ** 2, 0) / n);
  return {
    n,
    mae,
    rmse,
    maxAbsError,
    meanSignedError,
    minSignedError,
    maxSignedError,
    spread: maxSignedError - minSignedError,
    stdDev,
    unit: computed[0].unit || null,
  };
}

function resolveDataset(dataset) {
  if (dataset && typeof dataset === 'object' && Array.isArray(dataset.entries)) return dataset;
  const name = typeof dataset === 'string' && dataset ? dataset : BENCHMARK_DEFAULT_DATASET;
  return BENCHMARK_DATASETS[name] || null;
}

/** Look up a shipped dataset by name. */
export function benchmarkDataset(name = BENCHMARK_DEFAULT_DATASET) {
  return BENCHMARK_DATASETS[name] || null;
}

/**
 * Run the benchmark over supplied computed geometries.
 *
 * @param {string|object} dataset shipped dataset name or the dataset object
 * @param {Array<object>} geometries `{ id, label, level, atoms }`; each is
 *   matched to a reference entry by composition (not by atom order)
 * @returns {object} points, missing points (kept, never dropped), per-property
 *   and per-level summaries, and the entry/geometry counts
 */
export function runBenchmark(dataset, geometries = []) {
  const resolved = resolveDataset(dataset);
  if (!resolved) {
    return {
      available: false,
      reason: `unknown benchmark dataset "${dataset}"; shipped datasets: ${Object.keys(BENCHMARK_DATASETS).join(', ')}`,
      dataset: null,
      points: [],
      missing: [],
      summary: {},
      byLevel: {},
    };
  }
  const runs = (Array.isArray(geometries) ? geometries : []).filter((geometry) => (
    Array.isArray(geometry?.atoms) && geometry.atoms.length > 0
  ));
  const points = [];
  const missing = [];
  for (const entry of resolved.entries) {
    const candidates = runs.filter((geometry) => sameComposition(compositionOf(geometry.atoms), entry.composition || {}));
    if (candidates.length === 0) {
      missing.push(notComputed(entry, `no computed geometry with composition ${entry.formula} was supplied`));
      continue;
    }
    for (const candidate of candidates) {
      for (const point of compareEntry(entry, candidate)) {
        if (point.status === 'computed') points.push(point);
        else missing.push({ ...point, runLabel: candidate.label || candidate.id || null });
      }
    }
  }

  const summary = {
    bond_length: summarizePoints(points),
  };
  const levels = [...new Set(points.map((point) => point.runLabel).filter(Boolean))];
  const byLevel = {};
  for (const level of levels) {
    byLevel[level] = {
      bond_length: summarizePoints(points.filter((point) => point.runLabel === level)),
    };
  }

  return {
    available: true,
    reason: null,
    dataset: {
      id: resolved.id,
      title: resolved.title,
      source: resolved.source,
      url: resolved.url,
      units: resolved.units,
    },
    entriesConsidered: resolved.entries.length,
    geometriesConsidered: runs.length,
    points,
    // Kept in the result on purpose: a missing point is data about coverage.
    missing,
    summary,
    byLevel,
    levels,
  };
}

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return 'not reported';
  const fixed = value.toFixed(digits);
  return /^-0\.0+$/.test(fixed) ? fixed.slice(1) : fixed;
}

/**
 * A plain-text summary: per property, the point count, MAE, RMSE, maximum
 * error, systematic bias and spread, plus how many reference entries could not
 * be computed.
 */
export function benchmarkSummaryText(result) {
  if (!result || result.available === false) return result?.reason || 'benchmark not available';
  const lines = [];
  for (const [property, summary] of Object.entries(result.summary || {})) {
    if (!summary.n) {
      lines.push(`${property}: n = 0 (nothing computed)`);
      continue;
    }
    lines.push(`${property}: n = ${summary.n} · MAE ${formatNumber(summary.mae)} · `
      + `RMSE ${formatNumber(summary.rmse)} · max ${formatNumber(summary.maxAbsError)} · `
      + `bias ${summary.meanSignedError >= 0 ? '+' : ''}${formatNumber(summary.meanSignedError)} · `
      + `spread ${formatNumber(summary.spread)} ${summary.unit || ''}`.trim());
  }
  const missing = Array.isArray(result.missing) ? result.missing.length : 0;
  if (missing > 0) lines.push(`${missing} reference point(s) not computed (kept in the result, not dropped)`);
  return lines.join('\n');
}
