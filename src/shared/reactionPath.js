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
  const lines = String(source ?? '').split(/\r\n|\n|\r/);
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
    const match = new RegExp(`${label}:\\s*(\\d+)`, 'i').exec(String(source));
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
  const text = String(source ?? '');
  const lines = text.split(/\r\n|\n|\r/);
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
 * says so (`kind: 'potential-energy'`).
 */
export function pathBarrier(record) {
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
  };
}

/** Eyring rate constant at T, from an activation free energy in kcal/mol. */
export function eyringRate({ deltaGkcal, temperatureKelvin = 298.15 }) {
  const kB = 1.380649e-23;
  const h = 6.62607015e-34;
  const R = 8.314462618;
  const T = Number(temperatureKelvin);
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
