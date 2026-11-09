/**
 * Spectrum import: one entry point for a measured trace.
 *
 * Two readers live here, and they answer different questions.
 *
 * `importSpectrumText()` (issue 119) reads a JCAMP-DX document or a two-column
 * text dump for the vibrational cards. A spectrum from a spectrometer arrives
 * as JCAMP-DX, so the panel needed a branch — or, better, an import function
 * that answers "what is in this file" once and returns one shape whichever
 * format it found.
 *
 * `importMeasuredSpectrum()` (issue 184) reads the file that goes *beside* the
 * computed sticks: a two-column CSV/TSV with a header naming the x axis and its
 * unit (`wavelength_nm` or `wavenumber_cm-1`). It refuses, by name, everything
 * it must not pretend to do — an image (there is no digitisation in this
 * build), a file with no unit header, a non-monotonic x axis, fewer than five
 * points, a non-numeric cell, two x axes. A refusal is a sentence the caller
 * can print; it is never a silent substitution.
 *
 * The digest is computed here, over the file's bytes, with a dependency-free
 * SHA-256 so the renderer and `ncs report` agree on the same 64 hex characters
 * that `sha256sum` prints.
 */

import { isJcampDx, readJcampDx } from './jcamp.js';
import { parseMeasuredSpectrum } from './overlay.js';

export { isJcampDx, readJcampDx };

/**
 * @param {string} text the file's contents
 * @returns {object|null} a spectrum with `points` in both cases; `null` when a
 *   plain-text dump holds no two-column numeric row
 */
export function importSpectrumText(text) {
  if (isJcampDx(text)) return readJcampDx(text);
  return parseMeasuredSpectrum(text);
}

/* ------------------------------------------------------------------ *
 * SHA-256, over bytes
 * ------------------------------------------------------------------ */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new TextEncoder().encode(String(input ?? ''));
}

const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;

/**
 * SHA-256 of the bytes as given. A string is encoded as UTF-8 first, so
 * `sha256Hex(text)` equals `sha256sum` of a file holding exactly that text.
 *
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {string} 64 lowercase hex characters
 */
export function sha256Hex(input) {
  const bytes = toBytes(input);
  const padded = new Uint8Array((((bytes.length + 9) + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits % 0x100000000);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * The measured-trace import (issue 184)
 * ------------------------------------------------------------------ */

/** Refusals, with a code the caller can key a note on and a sentence it prints. */
export class SpectrumImportError extends Error {
  constructor(message, { code = 'spectrum-import', source = '' } = {}) {
    super(message);
    this.name = 'SpectrumImportError';
    this.code = code;
    this.source = source;
  }
}

/** A trace needs at least this many points before it is drawn. */
export const MEASURED_MIN_POINTS = 5;

/**
 * The most points a trace may carry into the record. The run-record schema
 * bounds `spectrumOverlay.points` at the same number, so a file that would fail
 * `ncs export` is refused here instead of being recorded and refused later.
 */
export const MEASURED_MAX_POINTS = 20000;

/** Names this import maps onto an axis quantity. Normalised: lowercase, alphanumerics only. */
const X_COLUMNS = Object.freeze({
  wavelengthnm: { axis: 'wavelength', units: 'nm' },
  wavelengthnanometernm: { axis: 'wavelength', units: 'nm' },
  lambdanm: { axis: 'wavelength', units: 'nm' },
  wavelengthnanometers: { axis: 'wavelength', units: 'nm' },
  wavelengthnanometres: { axis: 'wavelength', units: 'nm' },
  nm: { axis: 'wavelength', units: 'nm' },
  wavenumbercm1: { axis: 'wavenumber', units: 'cm⁻¹' },
  wavenumbercm: { axis: 'wavenumber', units: 'cm⁻¹' },
  wavenumber: { axis: 'wavenumber', units: 'cm⁻¹' },
  cm1: { axis: 'wavenumber', units: 'cm⁻¹' },
});

/** Header cell → `wavelengthnm`, i.e. `wavelength_nm`, `Wavelength (nm)`… */
export function normaliseColumnName(name) {
  return String(name ?? '').toLowerCase().replace(/⁻¹/g, '1').replace(/[^a-z0-9]/g, '');
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif']);

function extensionOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** Magic bytes of the bitmap formats a spectrometer export is likely to be. */
function imageKindOfBytes(bytes) {
  const head = Array.from(bytes.slice(0, 12));
  const text = head.map((byte) => String.fromCharCode(byte)).join('');
  if (head[0] === 0x89 && text.startsWith('PNG')) return 'PNG';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'JPEG';
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return 'GIF';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'BMP';
  if (text.startsWith('II*') || text.startsWith('MM\u0000*')) return 'TIFF';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'WebP';
  return '';
}

const refuse = (message, code, source) => {
  throw new SpectrumImportError(message, { code, source });
};

/** Quote a file name so a refusal always names the file it is about. */
function named(source) {
  return `“${source || 'this file'}”`;
}

function stripQuotes(cell) {
  const trimmed = String(cell).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',')) return line.split(',');
  if (line.includes(';')) return line.split(';');
  return line.split(/\s+/);
}

function isNumericCell(cell) {
  const value = stripQuotes(cell);
  return value !== '' && Number.isFinite(Number(value));
}

/**
 * Reads a two-column measured spectrum from a CSV/TSV file.
 *
 * @param {{name?: string, bytes?: Uint8Array|ArrayBuffer, text?: string}} file
 *   `bytes` is preferred: the digest is taken over the file's own bytes, not
 *   over a string the caller may have re-encoded.
 * @returns {object} `{ format, source, sha256, columns, units, axis, order,
 *   points, rows, notes }` — `points` ascending, values exactly as written
 */
export function importMeasuredSpectrum(file = {}) {
  const source = String(file.name ?? file.source ?? '').trim();
  const bytes = file.bytes !== undefined && file.bytes !== null ? toBytes(file.bytes) : null;
  const text = bytes ? new TextDecoder('utf-8').decode(bytes) : String(file.text ?? '');

  const ext = extensionOf(source);
  if (IMAGE_EXTENSIONS.has(ext)) {
    refuse(
      `${named(source)} is an image, not a table. This build has no digitisation: it will not turn a `
      + 'picture of a spectrum into numbers and then call the result measured. Export the trace from '
      + 'the instrument software as two columns (wavelength_nm, intensity) and import that.',
      'image',
      source,
    );
  }
  const magic = bytes ? imageKindOfBytes(bytes) : '';
  if (magic) {
    refuse(
      `${named(source)} holds ${magic} image data, not a table. This build has no digitisation: it `
      + 'will not read numbers out of a picture of a spectrum. Export the trace as two columns '
      + '(wavelength_nm, intensity) instead.',
      'image',
      source,
    );
  }
  if (isJcampDx(text)) {
    refuse(
      `${named(source)} is a JCAMP-DX document, not a two-column table. This import reads CSV/TSV; `
      + 'the vibrational cards read JCAMP-DX. Export the trace as two columns, or use that card.',
      'not-tabular',
      source,
    );
  }

  const lines = text.split(/\r\n|\n|\r/);
  const rows = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    rows.push({ line: index + 1, cells: splitLine(trimmed).map(stripQuotes) });
  });
  if (rows.length === 0) {
    refuse(`${named(source)} holds no rows: there is no measured trace in it.`, 'empty', source);
  }

  const header = rows[0];
  if (header.cells.length > 0 && header.cells.every(isNumericCell)) {
    refuse(
      `${named(source)} has no header row, so its x axis names no unit. This import reads the unit `
      + 'from the column name (wavelength_nm or wavenumber_cm-1) and will not guess which axis a '
      + 'bare number is on. Add a header row.',
      'no-header',
      source,
    );
  }

  const columns = header.cells.filter((cell) => cell !== '');
  // Two x axes in one header is a unit question, not a column-count question:
  // answer it before the count, so the refusal names the units.
  const xColumns = columns
    .map((name) => ({ name, x: X_COLUMNS[normaliseColumnName(name)] || null }))
    .filter((entry) => entry.x);
  const axes = new Set(xColumns.map((entry) => entry.x.axis));
  if (axes.size > 1) {
    const first = xColumns[0];
    const second = xColumns[1];
    refuse(
      `${named(source)} declares both ${first.name} (${first.x.units}) and ${second.name} `
      + `(${second.x.units}): the file carries two x axes, and drawing one against the other would `
      + 'mean converting nm to cm⁻¹. That conversion is refused rather than done silently.',
      'mixed-units',
      source,
    );
  }
  if (columns.length < 2) {
    refuse(
      `${named(source)} has ${columns.length} column${columns.length === 1 ? '' : 's'}; a measured `
      + 'spectrum needs two: the x axis in its unit and an intensity.',
      'missing-columns',
      source,
    );
  }
  if (columns.length > 2) {
    refuse(
      `${named(source)} has ${columns.length} columns (${columns.join(', ')}); this import reads `
      + 'exactly two: x in its unit, then intensity.',
      'extra-columns',
      source,
    );
  }

  const xColumn = X_COLUMNS[normaliseColumnName(columns[0])] || null;
  if (!xColumn) {
    refuse(
      `${named(source)} column “${columns[0]}” does not name an x axis this import knows. Use `
      + 'wavelength_nm (nm) or wavenumber_cm-1 (cm⁻¹).',
      'unknown-units',
      source,
    );
  }

  const points = [];
  for (const row of rows.slice(1)) {
    const cells = row.cells;
    if (cells.length < 2) {
      refuse(
        `${named(source)} line ${row.line} has ${cells.length} cell${cells.length === 1 ? '' : 's'}; `
        + `a point needs two: ${columns[0]}, ${columns[1]}.`,
        'missing-columns',
        source,
      );
    }
    if (cells.length > 2 && cells.slice(2).some((cell) => cell !== '')) {
      refuse(
        `${named(source)} line ${row.line} carries ${cells.length} cells; this import reads two `
        + `(${columns[0]}, ${columns[1]}).`,
        'extra-columns',
        source,
      );
    }
    const x = Number(cells[0]);
    const y = Number(cells[1]);
    if (!Number.isFinite(x)) {
      refuse(
        `${named(source)} line ${row.line}: “${cells[0]}” is not a number, but column `
        + `“${columns[0]}” is the x axis.`,
        'non-numeric',
        source,
      );
    }
    if (!Number.isFinite(y)) {
      refuse(
        `${named(source)} line ${row.line}: “${cells[1]}” is not a number, but column `
        + `“${columns[1]}” is the intensity.`,
        'non-numeric',
        source,
      );
    }
    points.push({ x, y, line: row.line });
  }

  if (points.length < MEASURED_MIN_POINTS) {
    refuse(
      `${named(source)} carries ${points.length} point${points.length === 1 ? '' : 's'}; at least `
      + `${MEASURED_MIN_POINTS} are needed before a trace is drawn, so nothing is plotted.`,
      'too-few-points',
      source,
    );
  }
  if (points.length > MEASURED_MAX_POINTS) {
    refuse(
      `${named(source)} carries ${points.length} points; this build records at most `
      + `${MEASURED_MAX_POINTS} per trace, so nothing is plotted rather than a truncated curve.`,
      'too-many-points',
      source,
    );
  }

  // Direction is checked on the file's own order, before any reordering: a
  // trace that turns around is either two concatenated scans or a scrambled
  // export, and neither can be repaired by sorting it.
  let rising = 0;
  let falling = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].x - points[index - 1].x;
    if (delta > 0) rising += 1;
    else if (delta < 0) falling += 1;
    else {
      refuse(
        `${named(source)} lines ${points[index - 1].line} and ${points[index].line} both carry `
        + `x = ${points[index].x}; two intensities at one x cannot be a single trace.`,
        'non-monotonic',
        source,
      );
    }
  }
  if (rising > 0 && falling > 0) {
    const firstTurn = points.findIndex((point, index) => {
      if (index === 0) return false;
      const previous = points[index - 1];
      const earlier = points[Math.max(0, index - 2)];
      return index > 1 && Math.sign(point.x - previous.x) !== Math.sign(previous.x - earlier.x);
    });
    const at = firstTurn > 0 ? points[firstTurn] : points[points.length - 1];
    refuse(
      `${named(source)} line ${at.line}: the x axis both rises and falls (a turn near x = `
      + `${at.x}). A spectrum must run in one direction on its x axis; this import will not reorder `
      + 'or resample a trace to make it fit.',
      'non-monotonic',
      source,
    );
  }

  const order = falling > 0 ? 'descending' : 'ascending';
  const ordered = order === 'ascending' ? points : points.slice().reverse();

  return {
    format: 'csv',
    source,
    sha256: bytes ? sha256Hex(bytes) : sha256Hex(text),
    columns: { x: columns[0], y: columns[1] },
    units: { x: xColumn.units, y: 'not declared' },
    axis: xColumn.axis,
    order,
    points: ordered.map((point) => ({ x: point.x, y: point.y })),
    rows: ordered.length,
    notes: order === 'descending'
      ? [`the file runs from high to low x; the ${ordered.length} points were ordered ascending for plotting, unchanged`]
      : [],
  };
}

/**
 * The run-record field (`spectrumOverlay`) for an imported trace.
 *
 * `points` are the file's own numbers, ordered ascending: the record has to
 * carry them, or a report could name a file it cannot draw.
 */
export function spectrumOverlayField(reference) {
  if (!reference || !Array.isArray(reference.points)) {
    throw new SpectrumImportError('No imported trace to record.', { code: 'no-trace' });
  }
  return {
    source: String(reference.source ?? ''),
    sha256: String(reference.sha256 ?? ''),
    columns: { x: String(reference.columns?.x ?? ''), y: String(reference.columns?.y ?? '') },
    units: { x: String(reference.units?.x ?? ''), y: String(reference.units?.y ?? '') },
    points: reference.points.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
  };
}

/**
 * A record field → the shape `spectrumFigure()` draws. Throws when the field is
 * not one this module wrote; a report must not draw half a trace.
 */
export function overlayFromRecord(field) {
  const points = Array.isArray(field?.points)
    ? field.points
      .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    : [];
  if (points.length < 2) {
    throw new SpectrumImportError('The recorded measured trace carries fewer than two points.', { code: 'record-shape' });
  }
  const units = String(field?.units?.x ?? '');
  return {
    label: String(field?.source ?? 'imported'),
    source: String(field?.source ?? 'imported'),
    sha256: String(field?.sha256 ?? ''),
    units,
    axis: axisQuantity(units),
    points,
  };
}

/**
 * Places a measured trace on a figure's x axis, in that axis's data units.
 *
 * A mismatch is refused, naming both units. The one exception is explicit and
 * labelled: a cm⁻¹ file drawn on an nm axis is plotted as its reciprocal
 * wavelength (λ/nm = 10⁷/ν̄), which is a change of presentation, not a unit
 * conversion of the data — and the caller must pass `allowReciprocal` and print
 * the returned `note`.
 *
 * @param {object} reference an imported trace (`importMeasuredSpectrum()` or
 *   `overlayFromRecord()`)
 * @param {{axis?: 'wavelength'|'wavenumber', allowReciprocal?: boolean}} options
 * @returns {{points: Array<{x:number,y:number}>, note: string}}
 */
export function placeMeasuredOverlay(reference, { axis = 'wavelength', allowReciprocal = false } = {}) {
  const points = Array.isArray(reference?.points) ? reference.points : [];
  const sourceQty = reference?.axis || axisQuantity(reference?.units?.x ?? reference?.units);
  const sourceUnits = reference?.units?.x ?? reference?.units ?? 'an undeclared unit';
  const targetUnits = axis === 'wavenumber' ? 'cm⁻¹' : 'nm';

  if (!sourceQty) {
    throw new SpectrumImportError(
      `${named(reference?.source || reference?.label)} declares “${sourceUnits}” on its x axis, `
      + `and this figure's axis is ${targetUnits}. The axis is unknown, so the trace is not drawn.`,
      { code: 'unit-unknown', source: String(reference?.source ?? '') },
    );
  }

  if (sourceQty === axis) {
    return { points: points.map((point) => ({ x: Number(point.x), y: Number(point.y) })), note: '' };
  }

  if (axis === 'wavelength' && sourceQty === 'wavenumber') {
    if (!allowReciprocal) {
      throw new SpectrumImportError(
        `${named(reference?.source || reference?.label)} is on a cm⁻¹ axis and this figure's axis `
        + 'is nm. Converting cm⁻¹ to nm is refused rather than done silently; pass an explicit '
        + 'reciprocal plot to draw it as λ = 10⁷/ν̄.',
        { code: 'unit-mismatch', source: String(reference?.source ?? '') },
      );
    }
    const converted = points
      .map((point) => ({ x: 1e7 / Number(point.x), y: Number(point.y) }))
      .filter((point) => Number.isFinite(point.x) && point.x > 0)
      .sort((a, b) => a.x - b.x);
    return {
      points: converted,
      note: `the file's cm⁻¹ values were plotted as their reciprocal wavelength (λ = 10⁷/ν̄ nm) `
        + 'on the nm axis; no interpolation was applied',
    };
  }

  throw new SpectrumImportError(
    `${named(reference?.source || reference?.label)} is on a ${sourceUnits} axis and this figure's `
    + `axis is ${targetUnits}. Converting ${sourceUnits} to ${targetUnits} is refused rather than `
    + 'done silently.',
    { code: 'unit-mismatch', source: String(reference?.source ?? '') },
  );
}

/**
 * The axis quantity a unit string names, or `null` when this module does not
 * recognise it. Recognising the quantity — not the spelling — is what lets the
 * panel refuse an nm trace on a cm⁻¹ axis instead of drawing a meaningless
 * overlay.
 */
const AXIS_QUANTITIES = new Map([
  ['1/CM', 'wavenumber'],
  ['CM-1', 'wavenumber'],
  ['CM^-1', 'wavenumber'],
  ['CM**-1', 'wavenumber'],
  ['CM⁻¹', 'wavenumber'],
  ['WAVENUMBER', 'wavenumber'],
  ['NM', 'wavelength'],
  ['NANOMETER', 'wavelength'],
  ['NANOMETERS', 'wavelength'],
  ['NANOMETRE', 'wavelength'],
  ['NANOMETRES', 'wavelength'],
  ['PPM', 'chemical-shift'],
  ['HZ', 'frequency'],
  ['MHZ', 'frequency'],
  ['EV', 'energy'],
]);

export function axisQuantity(units) {
  if (typeof units !== 'string') return null;
  const key = units.trim().toUpperCase().replace(/[\s_]+/g, '').replace(/⁻¹/g, '-1');
  return AXIS_QUANTITIES.get(key) ?? null;
}

/**
 * Whether two axis unit strings name the same quantity.
 *
 * `null` means "cannot tell": either side is missing, or it uses a unit this
 * module does not map. An unknown unit is not treated as a match — the caller
 * has to say that the axis was not declared rather than implying it was
 * checked.
 */
export function sameAxisUnits(a, b) {
  const left = axisQuantity(a);
  const right = axisQuantity(b);
  if (left === null || right === null) return null;
  return left === right;
}
