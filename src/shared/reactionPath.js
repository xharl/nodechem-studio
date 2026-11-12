/**
 * Reaction-path and scan records.
 *
 * Both are read from blocks Gaussian prints at the end of the job, so the
 * numbers here are the program's own, not a re-integration of the steps:
 *
 *   Energies reported relative to the TS energy of        -797.920071
 *    Summary of reaction path following
 *                         Energy    RxCoord
 *    1                   -0.00005  -1.23078
 *
 *   Summary of Optimized Potential Surface Scan
 *                            1         2
 *        Eigenvalues --  -187.49666-187.49909
 *              R1           1.10000   1.10100
 *
 *   Summary of the potential surface scan:
 *      N      D7          SCF
 *    ----  ---------  -----------
 *       1  -180.0000   -382.29428
 *
 * A block that is not present yields null: "no IRC in this job" is not the same
 * as "IRC with zero points".
 */

import { HARTREE_TO_KCAL_PER_MOL } from './runCompare.js';
import { toLines, toText } from './lines.js';
import { PK_UNIT_KCAL_PER_MOL } from './thermochemistry.js';

const NUMBER = /-?\d+\.\d+/g;
const DASHES = /^[\s-]+$/;

function numbersIn(line) {
  return (line.match(NUMBER) || []).map(Number).filter((value) => Number.isFinite(value));
}

/**
 * Parse the IRC summary table.
 *
 * `Energy` in that table is relative to the transition state, so the absolute
 * value is recovered from the header line and both are returned. The reference
 * energy is null when Gaussian does not print it, and then `energyHartree` is
 * null rather than pretending the relative number is absolute.
 */
export function parseIrcSummary(source) {
  const lines = toLines(source);
  const text = toText(source);
  const start = lines.findIndex((line) => /Summary of reaction path following/i.test(line));
  if (start === -1) return null;

  let referenceHartree = null;
  for (let index = start - 1; index >= 0 && index >= start - 6; index -= 1) {
    const match = /Energies reported relative to the TS energy of\s+(-?\d+\.\d+)/i.exec(lines[index]);
    if (match) {
      referenceHartree = Number(match[1]);
      break;
    }
  }

  const points = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (DASHES.test(line) && points.length > 0) break;
    const match = /^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/.exec(line);
    if (!match) continue;
    const relativeHartree = Number(match[2]);
    points.push({
      point: Number(match[1]),
      relativeHartree,
      energyHartree: referenceHartree === null ? null : referenceHartree + relativeHartree,
      rxCoord: Number(match[3]),
    });
  }
  if (points.length === 0) return null;

  const total = (label) => {
    const match = new RegExp(`${label}:\\s*(\\d+)`, 'i').exec(text);
    return match ? Number(match[1]) : null;
  };

  return {
    kind: 'irc',
    referenceHartree,
    points,
    pointCount: total('Total number of points') ?? points.length,
    gradientCalculations: total('Total number of gradient calculations'),
    hessianCalculations: total('Total number of Hessian calculations'),
  };
}

/**
 * Parse a PES scan summary, relaxed or unrelaxed.
 *
 * Relaxed scans print in column groups of five with an `Eigenvalues --` line per
 * group (absolute hartree); unrelaxed scans print one numbered row per point
 * with the SCF energy in the last column.
 */
export function parseScanSummary(source) {
  const lines = toLines(source);
  const text = toText(source);
  const relaxedStart = lines.findIndex((line) => /Summary of Optimized Potential Surface Scan/i.test(line));
  if (relaxedStart !== -1) return parseRelaxedScan(lines, relaxedStart, text);
  const unrelaxedStart = lines.findIndex((line) => /Summary of the potential surface scan:/i.test(line));
  if (unrelaxedStart !== -1) return parseUnrelaxedScan(lines, unrelaxedStart, text);
  return null;
}

function parseRelaxedScan(lines, start, text) {
  const points = new Map();
  const parameterNames = new Set();
  let group = [];

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      if (points.size > 0) break;
      continue;
    }
    const header = /^\s+((?:\d+\s*)+)$/.exec(line);
    if (header && !line.includes('.')) {
      group = header[1].trim().split(/\s+/).map(Number);
      for (const point of group) if (!points.has(point)) points.set(point, { parameters: {} });
      continue;
    }
    if (/^\s*Eigenvalues\s*--/i.test(line)) {
      const energies = numbersIn(line.slice(line.indexOf('--') + 2));
      energies.slice(0, group.length).forEach((energy, offset) => {
        const point = group[offset];
        if (point !== undefined && points.has(point)) points.get(point).energyHartree = energy;
      });
      continue;
    }
    const param = /^\s{2,}([A-Za-z][\w()]*)\s+(-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?)*)\s*$/.exec(line);
    if (param && group.length > 0) {
      const name = param[1];
      parameterNames.add(name);
      const values = param[2].trim().split(/\s+/).map(Number);
      values.slice(0, group.length).forEach((value, offset) => {
        const point = group[offset];
        const entry = points.get(point);
        if (entry && Number.isFinite(value)) entry.parameters[name] = value;
      });
      continue;
    }
    if (DASHES.test(line) && points.size > 0) break;
  }

  const ordered = [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([point, value]) => ({
      point,
      energyHartree: Number.isFinite(value.energyHartree) ? value.energyHartree : null,
      parameters: value.parameters,
    }))
    .filter((entry) => entry.energyHartree !== null);
  if (ordered.length === 0) return null;

  return {
    kind: 'relaxed',
    parameterNames: [...parameterNames],
    points: ordered,
    pointCount: scanLength(text) ?? ordered.length,
  };
}

function parseUnrelaxedScan(lines, start, text) {
  let index = start + 1;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  const header = lines[index];
  if (!header) return null;
  const names = header.trim().split(/\s+/);
  index += 1;
  if (index < lines.length && DASHES.test(lines[index])) index += 1;

  const points = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') break;
    const values = line.trim().split(/\s+/).map(Number);
    if (values.some((value) => !Number.isFinite(value))) break;
    if (values.length < 3) break;
    const point = values[0];
    const energyHartree = values[values.length - 1];
    const parameters = {};
    names.slice(1, -1).forEach((name, offset) => {
      parameters[name] = values[offset + 1];
    });
    points.push({ point, energyHartree, parameters });
  }
  if (points.length === 0) return null;

  return {
    kind: 'unrelaxed',
    parameterNames: names.length > 2 ? names.slice(1, -1) : [],
    points,
    pointCount: scanLength(text) ?? points.length,
  };
}

function scanLength(text) {
  const match = /Number of optimizations in scan\s*[:=]?\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Energies relative to the lowest point, in kcal/mol, plus the same array for
 * the IRC table (whose `rxCoord` orders the path).
 */
export function profilePoints(record) {
  if (!record || !Array.isArray(record.points) || record.points.length === 0) return [];
  const values = record.points.map((point) => point.energyHartree);
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return [];
  const lowest = Math.min(...usable);
  return record.points.map((point, index) => ({
    point: point.point,
    label: record.kind === 'irc' ? point.rxCoord : point.parameters?.[Object.keys(point.parameters)[0]] ?? index + 1,
    rxCoord: point.rxCoord ?? null,
    energyHartree: point.energyHartree,
    relativeKcal: Number.isFinite(point.energyHartree)
      ? (point.energyHartree - lowest) * HARTREE_TO_KCAL_PER_MOL
      : null,
    parameters: point.parameters ?? {},
  }));
}

/**
 * Where the path sits highest, and by how much over the lowest point.
 * This is a barrier on the computed path only: it is not ΔG‡ and the record
 * says so (`kind: 'potential-energy'`). The level of theory and the
 * thermochemical treatment are attached so a barrier is never printed on its
 * own; both are `null` when the run did not record them.
 */
export function pathBarrier(record, { levelOfTheory = null, thermochemicalTreatment = null } = {}) {
  const points = profilePoints(record);
  if (points.length === 0) return null;
  let highest = points[0];
  for (const point of points) {
    if (point.relativeKcal !== null && highest.relativeKcal !== null
      && point.relativeKcal > highest.relativeKcal) highest = point;
  }
  return {
    kind: 'potential-energy',
    maxKcal: highest.relativeKcal,
    point: highest.point,
    label: highest.label,
    rxCoord: highest.rxCoord,
    points: points.length,
    levelOfTheory: levelOfTheory || null,
    thermochemicalTreatment: thermochemicalTreatment || null,
  };
}

/** Eyring rate constant at T, from an activation free energy in kcal/mol. */
export function eyringRate({ deltaGkcal, temperatureKelvin = 298.15 }) {
  const kB = 1.380649e-23;
  const h = 6.62607015e-34;
  const R = 8.314462618;
  const T = Number(temperatureKelvin);
  // `Number(null)` is 0, so a missing barrier must be rejected before coercion:
  // a null ΔG‡ is not a barrierless reaction.
  if (deltaGkcal === null || deltaGkcal === undefined) return null;
  const dG = Number(deltaGkcal);
  if (!Number.isFinite(T) || T <= 0 || !Number.isFinite(dG)) return null;
  const prefactor = (kB * T) / h;
  return prefactor * Math.exp(-(dG * 4184) / (R * T));
}

/**
 * Self-contained SVG for a path profile. Same contract as the spectrum figure:
 * a polyline over the computed points, the highest point marked, no scripts.
 */
export function profileSvg(record, { width = 560, height = 190 } = {}) {
  const points = profilePoints(record);
  if (points.length < 2) return '';
  const values = points.map((point) => point.relativeKcal ?? 0);
  const max = Math.max(...values, 0.5);
  const pad = { left: 44, right: 12, top: 12, bottom: 26 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (points.length === 1 ? 0 : (index / (points.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - (value / max) * innerH;
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(point.relativeKcal ?? 0).toFixed(2)}`).join(' ');
  const highestIndex = values.indexOf(Math.max(...values));
  const highest = points[highestIndex];
  const zeroY = y(0).toFixed(2);
  const ticks = [0, max / 2, max].map((value) => (
    `<text x="${pad.left - 6}" y="${(y(value) + 3).toFixed(2)}" text-anchor="end" class="spectrum-label">${value.toFixed(0)}</text>`
  )).join('');
  return `<figure class="results-spectrum" data-field="reaction-profile">`
    + `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Reaction path profile">`
    + `<line x1="${pad.left}" y1="${zeroY}" x2="${width - pad.right}" y2="${zeroY}" class="spectrum-axis"/>`
    + `${ticks}`
    + `<path d="${path}" class="spectrum-curve"/>`
    + `<circle cx="${x(highestIndex).toFixed(2)}" cy="${y(highest.relativeKcal ?? 0).toFixed(2)}" r="3" class="profile-peak"/>`
    + `<text x="${width - pad.right}" y="${height - 6}" text-anchor="end" class="spectrum-label">points 1–${points.length}</text>`
    + `<text x="${pad.left}" y="${height - 6}" class="spectrum-label">kcal mol⁻¹</text>`
    + '</svg>'
    + '</figure>';
}

/**
 * The located extremum of a scan.
 *
 * A one-dimensional scan gets a parabolic fit through the highest point and its
 * two neighbours, which is what identifies a maximum between grid points; a
 * boundary maximum cannot be fitted and is reported as such. A two-dimensional
 * scan has no single coordinate, so the highest grid node is reported and
 * nothing is interpolated.
 */
export function scanExtremum(record) {
  const points = profilePoints(record);
  if (points.length === 0) return null;
  const declared = Array.isArray(record?.parameterNames) ? record.parameterNames : [];
  // Only a parameter that actually takes different values was scanned; the
  // others are printed alongside it (bond lengths next to angles, say).
  const parameters = declared.filter((name) => new Set(
    points.map((point) => point.parameters?.[name]).filter((value) => value !== undefined),
  ).size > 1);
  const highest = points.reduce((best, point) => (
    point.relativeKcal !== null && (best === null || point.relativeKcal > best.relativeKcal) ? point : best
  ), null);
  if (!highest) return null;
  const index = points.indexOf(highest);
  const base = {
    energyHartree: highest.energyHartree,
    relativeKcal: highest.relativeKcal,
    point: highest.point,
    parameters: highest.parameters,
  };
  if (parameters.length > 1) {
    return { ...base, dimension: 2, method: 'grid-node', interpolated: false, note: 'Highest grid node of a two-dimensional scan; no interpolation between nodes.' };
  }
  const previous = points[index - 1];
  const next = points[index + 1];
  const xAt = (point) => {
    if (!point) return null;
    const value = parameters.length === 1 ? point.parameters?.[parameters[0]] : point.rxCoord ?? point.label;
    return Number.isFinite(value) ? value : null;
  };
  const x0 = xAt(previous);
  const x1 = xAt(highest);
  const x2 = xAt(next);
  if (x0 === null || x1 === null || x2 === null) {
    return { ...base, dimension: 1, method: 'grid-node', interpolated: false, note: 'The maximum sits on the boundary of the computed range, so it cannot be interpolated.' };
  }
  const y0 = previous.relativeKcal;
  const y1 = highest.relativeKcal;
  const y2 = next.relativeKcal;
  const denominator = (x0 - x1) * (x0 - x2) * (x1 - x2);
  if (!Number.isFinite(denominator) || denominator === 0 || y0 === null || y2 === null) {
    return { ...base, dimension: 1, method: 'grid-node', interpolated: false, note: 'Three distinct points were not available for a parabolic fit.' };
  }
  const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / denominator;
  const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / denominator;
  if (!Number.isFinite(a) || a >= 0) {
    return { ...base, dimension: 1, method: 'grid-node', interpolated: false, note: 'The neighbours do not form a concave maximum, so no vertex was fitted.' };
  }
  const vertexX = -b / (2 * a);
  // Same parabola, evaluated through a known point so the constant is exact.
  const vertexY = y1 + a * (vertexX * vertexX - x1 * x1) + b * (vertexX - x1);
  return {
    ...base,
    dimension: 1,
    method: 'parabolic-fit',
    interpolated: true,
    coordinate: parameters.length === 1 ? parameters[0] : null,
    vertexX,
    vertexKcal: vertexY,
    neighbours: [
      { x: x0, kcal: y0 },
      { x: x1, kcal: y1 },
      { x: x2, kcal: y2 },
    ],
  };
}

const TERMINAL = new Set(['completed']);

/**
 * The IRC gate: did the path actually run, rise once, and come back down on
 * both sides of the maximum?
 *
 * The endpoint *identity* (a minimum, and which one) cannot be established from
 * an IRC summary alone — that needs a frequency job at each endpoint — so that
 * check is reported as `unknown` rather than passed.
 */
export function ircGate(record) {
  if (!record || !Array.isArray(record.points) || record.points.length === 0) {
    return {
      status: 'unknown',
      checks: [{ id: 'path-present', status: 'unknown', detail: 'This output carries no IRC summary.' }],
      reason: 'No IRC path in this output.',
    };
  }
  const points = profilePoints(record);
  const energies = points.map((point) => point.relativeKcal).filter((value) => value !== null);
  const max = Math.max(...energies);
  // IRC points sit on a plateau near the top (the summary prints five
  // decimals), so a maximum is a *run* of highest points, not a single index.
  const nearTop = new Set(points
    .map((point, index) => (point.relativeKcal !== null && max - point.relativeKcal <= 0.01 ? index : -1))
    .filter((index) => index >= 0));
  let plateaus = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (!nearTop.has(index)) continue;
    if (!nearTop.has(index - 1)) plateaus += 1;
  }
  const maxInInterior = !nearTop.has(0) && !nearTop.has(points.length - 1);
  const interiorMaxima = plateaus;
  const endpoints = [points[0], points[points.length - 1]].filter(Boolean);
  const endpointsBelow = endpoints.every((point) => point.relativeKcal !== null && point.relativeKcal < max);
  const coords = points.map((point) => point.rxCoord).filter((value) => Number.isFinite(value));
  const directions = new Set(coords.map((value) => (value < 0 ? 'reverse' : 'forward')));
  const checks = [
    { id: 'path-present', status: 'pass', detail: `${points.length} points on the path.` },
    {
      id: 'single-maximum',
      status: interiorMaxima === 1 ? 'pass' : 'fail',
      detail: interiorMaxima === 1
        ? 'One interior maximum, consistent with a single barrier.'
        : `${interiorMaxima} interior maxima were found; a reaction path should cross one barrier.`,
    },
    {
      id: 'endpoints-below-maximum',
      status: endpointsBelow ? 'pass' : 'fail',
      detail: endpointsBelow
        ? 'Both ends of the path lie below the maximum, so the path descends on each side.'
        : 'At least one end of the path does not lie below the maximum.',
    },
    {
      id: 'maximum-in-interior',
      status: maxInInterior ? 'pass' : 'unknown',
      detail: maxInInterior
        ? 'The maximum is not on either endpoint.'
        : 'The maximum sits on an endpoint; the path may be truncated.',
    },
    {
      id: 'endpoint-is-a-minimum',
      status: 'unknown',
      detail: 'An IRC summary cannot show that an endpoint is a minimum: that needs a frequency job at the endpoint.',
    },
  ];
  const failed = checks.some((check) => check.status === 'fail');
  return {
    status: failed ? 'fail' : 'pass',
    checks,
    points: points.length,
    directions: [...directions],
    reason: failed
      ? 'The path does not cross a single barrier with both ends below it.'
      : 'The path crosses one barrier and descends on both sides. Endpoint identities are not verified.',
  };
}

/**
 * ΔG‡ from two thermochemistry records at the same level of theory.
 *
 * Nothing is derived if either free energy is missing, and the scheme is named
 * in the result so a number quoted from it cannot lose its meaning.
 */
export function deltaGDoubleDagger({ transitionState = null, reactant = null } = {}) {
  const ts = transitionState?.thermochemistry?.freeEnergyHartree;
  const r = reactant?.thermochemistry?.freeEnergyHartree;
  if (!Number.isFinite(ts) || !Number.isFinite(r)) {
    return {
      available: false,
      reason: `A ΔG‡ needs a free energy for both the transition state and the reactant; ${Number.isFinite(ts) ? 'the reactant' : 'the transition state'} has none.`,
    };
  }
  return {
    available: true,
    kcalPerMol: (ts - r) * HARTREE_TO_KCAL_PER_MOL,
    scheme: 'ΔG‡ = G(TS) − G(reactant), both from frequency calculations at the same level of theory',
    transitionStateFreeEnergyHartree: ts,
    reactantFreeEnergyHartree: r,
    temperatureK: transitionState?.thermochemistry?.temperatureK ?? null,
  };
}

/**
 * pKa from an isodesmic cycle against a reference acid, using the unit already
 * defined for the thermochemistry module. The solvent, the standard state and
 * the reference are required inputs: without them the number is not a pKa, it is
 * a free-energy difference with a decimal point moved.
 */
export function pKaFromCycle({
  deltaGDeprotonationKcal = null,
  deltaGReferenceKcal = null,
  referencePKa = null,
  solvent = null,
  standardStateK = 298.15,
  standardStateAtm = 1,
} = {}) {
  const missing = [];
  if (!Number.isFinite(deltaGDeprotonationKcal)) missing.push('the deprotonation free energy');
  if (!Number.isFinite(deltaGReferenceKcal)) missing.push('the reference free energy');
  if (!Number.isFinite(referencePKa)) missing.push('the reference pKa');
  if (!solvent) missing.push('the solvent');
  if (missing.length > 0) {
    return { available: false, missing, reason: `A pKa needs ${missing.join(', ')}.` };
  }
  const delta = deltaGDeprotonationKcal - deltaGReferenceKcal;
  return {
    available: true,
    pKa: referencePKa + delta / PK_UNIT_KCAL_PER_MOL,
    deltaKcalPerMol: delta,
    unitKcalPerMol: PK_UNIT_KCAL_PER_MOL,
    solvent,
    standardState: { temperatureK: standardStateK, pressureAtm: standardStateAtm },
    reference: { pKa: referencePKa, deltaGReferenceKcal },
    scheme: 'pKa = pKa(reference) + [ΔG(sample) − ΔG(reference)] / 1.364 kcal mol⁻¹, isodesmic cycle at the stated standard state',
  };
}

/**
 * A two-dimensional scan as a heatmap: one cell per computed node, coloured by
 * relative energy, with the located extremum marked. Nodes that did not run are
 * left as holes rather than filled in.
 */
export function scanSurfaceSvg(record, { cell = 22, pad = { left: 46, right: 12, top: 12, bottom: 30 } } = {}) {
  const points = profilePoints(record);
  const declared = Array.isArray(record?.parameterNames) ? record.parameterNames : [];
  const varying = declared.filter((name) => new Set(
    points.map((point) => point.parameters?.[name]).filter((value) => value !== undefined),
  ).size > 1);
  if (points.length < 4 || varying.length !== 2) return '';
  const [xName, yName] = varying;
  const xs = [...new Set(points.map((point) => point.parameters?.[xName]))].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const ys = [...new Set(points.map((point) => point.parameters?.[yName]))].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2) return '';
  const values = points.map((point) => point.relativeKcal).filter((value) => value !== null);
  const max = Math.max(...values, 0.0001);
  const cellAt = new Map(points.map((point) => [
    `${point.parameters?.[xName]}|${point.parameters?.[yName]}`,
    point.relativeKcal,
  ]));
  const extremum = scanExtremum(record);
  const width = pad.left + xs.length * cell + pad.right;
  const height = pad.top + ys.length * cell + pad.bottom;
  const heat = (value) => {
    const fraction = Math.max(0, Math.min(1, value / max));
    const lightness = 82 - Math.round(fraction * 46);
    return `hsl(212 24% ${lightness}%)`;
  };
  const cells = ys.map((yValue, row) => xs.map((xValue, column) => {
    const key = `${xValue}|${yValue}`;
    if (!cellAt.has(key) || cellAt.get(key) === null) return '';
    const value = cellAt.get(key);
    const x = pad.left + column * cell;
    const y = pad.top + (ys.length - 1 - row) * cell;
    const isPeak = extremum && extremum.parameters?.[xName] === xValue && extremum.parameters?.[yName] === yValue;
    return `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="${heat(value)}"${isPeak ? ' stroke="#fbbf24" stroke-width="1.5"' : ''}><title>${xName}=${xValue}, ${yName}=${yValue}: ${value.toFixed(2)} kcal/mol</title></rect>`;
  }).join('')).join('');
  const axisLabels = `<text x="${pad.left - 8}" y="${pad.top + (ys.length * cell) / 2}" text-anchor="middle" transform="rotate(-90 ${pad.left - 8} ${pad.top + (ys.length * cell) / 2})" class="spectrum-label">${yName}</text>`
    + `<text x="${pad.left + (xs.length * cell) / 2}" y="${height - 8}" text-anchor="middle" class="spectrum-label">${xName}</text>`;
  return `<figure class="results-spectrum" data-field="scan-surface">`
    + `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Potential-energy surface scan">`
    + `${cells}${axisLabels}`
    + '</svg>'
    + `<figcaption>${xs.length} × ${ys.length} grid, ${points.length} computed nodes, relative energies in kcal mol⁻¹`
    + `${extremum ? ` · highest node ${extremum.relativeKcal.toFixed(2)} kcal mol⁻¹` : ''}</figcaption>`
    + '</figure>';
}
