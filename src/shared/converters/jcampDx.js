/**
 * JCAMP-DX 5.00, the exchange format for spectra.
 *
 * A spectrum written as a `.txt` two-column dump is readable by a human and by
 * nothing else; a PNG is viewable and unprocessable. JCAMP-DX is the format
 * spectroscopy software actually imports — origin, units, axis limits and the
 * points travel together, and the file says what produced it.
 *
 * This writer uses the `##XYPOINTS= (XY..XY)` pair form rather than the
 * compressed `X++(Y..Y)` form. Pairs cost more characters but cannot be
 * misread when the grid is not perfectly uniform, which a broadened spectrum
 * sampled in wavelength is not.
 *
 * Units are declared, never assumed: a wavenumber axis is `1/CM`, a UV axis is
 * `NM`, and the intensity is `ARBITRARY UNITS` because a broadened spectrum is
 * normalised, not measured.
 */

import { ConversionError } from './xyz.js';

const MAX_LINE = 76;

function number(value, what) {
  const parsed = (value === null || value === undefined || value === '') ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConversionError(`${what} is not a finite number (${JSON.stringify(value)}).`);
  }
  return parsed;
}

/**
 * Short, exact-enough rendering of a number. Trailing zeros are dropped only
 * after a decimal point, so `1800` never becomes `18`.
 */
function fmt(value, digits) {
  const text = Number(value).toPrecision(digits);
  if (text.includes('e') || text.includes('E')) return text;
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function pairs(points) {
  const seen = new Set();
  const list = points.map((point, index) => {
    const x = number(point?.x, `point ${index + 1} x`);
    const y = number(point?.y, `point ${index + 1} y`);
    const key = x.toPrecision(12);
    if (seen.has(key)) throw new ConversionError(`two points share x = ${x}; a JCAMP axis must be strictly increasing.`);
    seen.add(key);
    return { x, y };
  }).sort((a, b) => a.x - b.x);
  if (list.length < 2) {
    throw new ConversionError(`a spectrum needs at least two points; this one has ${list.length}.`);
  }
  return list;
}

function body(list) {
  const entries = list.map(({ x, y }) => `${fmt(x, 10)}, ${fmt(y, 8)}`);
  const lines = [];
  let current = '';
  entries.forEach((entry, index) => {
    const piece = index === entries.length - 1 ? entry : `${entry}; `;
    if (current && current.length + piece.length > MAX_LINE) {
      lines.push(current.trimEnd());
      current = '';
    }
    current += piece;
  });
  if (current) lines.push(current.trimEnd());
  return lines;
}

/**
 * @param {{title: string, dataType: string, xUnits: string, yUnits: string,
 *          points: Array<{x: number, y: number}>, origin?: string, owner?: string,
 *          date?: Date|string, xFactor?: number, yFactor?: number}} spectrum
 * @returns {string}
 */
export function writeJcampDx({
  title,
  dataType,
  xUnits,
  yUnits,
  points,
  origin = 'NodeChem Studio',
  owner = '',
  date = null,
  xFactor = 1,
  yFactor = 1,
} = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new ConversionError('there is no spectrum to write.');
  }
  for (const [name, value] of Object.entries({ title, dataType, xUnits, yUnits })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConversionError(`JCAMP-DX needs ${name}; it was not given.`);
    }
  }
  const list = pairs(points);
  const when = date instanceof Date ? date : (date ? new Date(date) : null);
  const stamp = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : null;
  const header = [
    `##TITLE=${title}`,
    '##JCAMP-DX=5.00',
    `##DATA TYPE=${dataType}`,
    `##ORIGIN=${origin}`,
    ...(owner ? [`##OWNER=${owner}`] : []),
    ...(stamp ? [`##DATE=${stamp}`] : []),
    `##XUNITS=${xUnits}`,
    `##YUNITS=${yUnits}`,
    `##XFACTOR=${xFactor}`,
    `##YFACTOR=${yFactor}`,
    `##NPOINTS=${list.length}`,
    `##FIRSTX=${fmt(list[0].x, 10)}`,
    `##LASTX=${fmt(list[list.length - 1].x, 10)}`,
    '##XYPOINTS= (XY..XY)',
  ];
  return `${[...header, ...body(list), '##END='].join('\n')}\n`;
}
