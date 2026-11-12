/**
 * NMR shieldings, spin-spin couplings and a simulated spectrum.
 *
 * Gaussian prints an absolute isotropic shielding per atom (ppm) in a GIAO
 * block. That number is not a chemical shift: a shift needs a reference
 * shielding computed at the same level of theory. This module keeps the two
 * apart — the parser never subtracts anything, and `nmrShifts` only produces
 * shifts when the caller supplies a reference. The convention is printed with
 * the numbers in the results panel, never implied.
 *
 * A `NMR=(GIAO,SpinSpin)` job additionally prints lower-triangular coupling
 * tables. `parseCouplings` reads the two totals (reduced K and J in Hz) and
 * keeps only the pairs the log actually prints: an unprinted pair is NaN in the
 * matrix, never a zero, because a zero would claim a computed value the run
 * never produced.
 */

import { toLines } from './lines.js';

const NUCLEUS_ELEMENTS = Object.freeze({
  '1H': 'H',
  H: 'H',
  '13C': 'C',
  C: 'C',
  '15N': 'N',
  N: 'N',
  '19F': 'F',
  F: 'F',
  '31P': 'P',
  P: 'P',
  '29Si': 'Si',
  Si: 'Si',
});

/** Which element a nucleus label refers to, e.g. `13C` → `C`. */
export function elementForNucleus(nucleus) {
  const key = String(nucleus || '').trim();
  return NUCLEUS_ELEMENTS[key] || null;
}

/**
 * Parse the shielding block:
 *
 *   SCF GIAO Magnetic shielding tensor (ppm):
 *         1  C    Isotropic =   114.0880   Anisotropy =   147.6438
 *      XX=    57.6159   YX=   -13.4888   ZX=     0.0000
 *      ...
 *      Eigenvalues:    48.6622    81.0847   212.5172
 *
 * A job with no NMR block returns null; a block with no atoms returns null.
 */
export function parseShieldings(source) {
  const lines = toLines(source);
  const start = lines.findIndex((line) => /Magnetic shielding tensor\s*\(ppm\)/i.test(line));
  if (start === -1) return null;

  const header = lines[start];
  const gauge = /GIAO/i.test(header) ? 'GIAO' : (/CSGT/i.test(header) ? 'CSGT' : null);
  const methodMatch = /^\s*([A-Z0-9]+)\s+(?:GIAO|CSGT)?\s*Magnetic shielding tensor/i.exec(header.trim());
  const method = methodMatch ? methodMatch[1] : null;

  const atoms = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (atoms.length > 0 && line.trim() === '') break;
    const atomMatch = /^\s*(\d+)\s+([A-Z][a-z]?)\s+Isotropic\s*=\s*(-?\d+\.\d+)\s+Anisotropy\s*=\s*(-?\d+\.\d+)/.exec(line);
    if (atomMatch) {
      current = {
        index: Number(atomMatch[1]),
        element: atomMatch[2],
        isotropic: Number(atomMatch[3]),
        anisotropy: Number(atomMatch[4]),
        eigenvalues: null,
      };
      atoms.push(current);
      continue;
    }
    const eigen = /^\s*Eigenvalues:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line);
    if (eigen && current) {
      current.eigenvalues = [Number(eigen[1]), Number(eigen[2]), Number(eigen[3])];
      continue;
    }
    if (!/^\s*(?:XX|YX|ZX|XY|YY|ZY|XZ|YZ|ZZ)=/.test(line) && !/Magnetic shielding/i.test(line)) {
      if (atoms.length > 0) break;
    }
  }
  if (atoms.length === 0) return null;

  return { gauge, method, count: atoms.length, atoms };
}

/**
 * Shift = σ_reference − σ_isotropic, the IUPAC convention. `referencePpm` must
 * come from the same level of theory; nothing is assumed when it is absent.
 */
export function nmrShifts(atoms, { referencePpm = null } = {}) {
  // Number(null) is 0, which would silently turn every shielding into a shift
  // against a reference of zero.
  const usable = referencePpm !== null && referencePpm !== undefined
    && String(referencePpm).trim() !== '' && Number.isFinite(Number(referencePpm));
  const reference = usable ? Number(referencePpm) : null;
  return (Array.isArray(atoms) ? atoms : []).map((atom) => ({
    ...atom,
    shiftPpm: usable ? reference - atom.isotropic : null,
  }));
}

/**
 * A Lorentzian stick spectrum over the shifts (or absolute shieldings when no
 * reference is supplied). Peaks are per atom; degenerate atoms stack.
 */
export function nmrSpectrum({
  atoms = [],
  nucleus = '1H',
  referencePpm = null,
  fwhmPpm = 0.1,
  points = 600,
} = {}) {
  const element = elementForNucleus(nucleus);
  const shifted = nmrShifts(atoms, { referencePpm });
  const selected = shifted.filter((atom) => (element ? atom.element === element : true)
    && Number.isFinite(atom.shiftPpm ?? atom.isotropic));
  if (selected.length === 0) return null;

  const values = selected.map((atom) => (atom.shiftPpm ?? atom.isotropic));
  const half = Math.max(Number(fwhmPpm) / 2, 0.001);
  const pad = Math.max(5 * half, 0.5);
  const low = Math.min(...values) - pad;
  const high = Math.max(...values) + pad;
  const span = high - low || 1;
  const step = span / Math.max(points - 1, 1);

  const curve = [];
  for (let index = 0; index < points; index += 1) {
    const ppm = low + step * index;
    let intensity = 0;
    for (const value of values) {
      const delta = ppm - value;
      intensity += (half * half) / (delta * delta + half * half);
    }
    curve.push({ ppm, intensity });
  }
  const max = Math.max(...curve.map((point) => point.intensity));

  const hasReference = referencePpm !== null && referencePpm !== undefined
    && String(referencePpm).trim() !== '' && Number.isFinite(Number(referencePpm));
  return {
    nucleus,
    element,
    referencePpm: hasReference ? Number(referencePpm) : null,
    fwhmPpm: Number(fwhmPpm),
    shape: 'lorentzian',
    units: hasReference ? 'ppm shift' : 'ppm shielding (absolute)',
    minPpm: low,
    maxPpm: high,
    peaks: selected.map((atom) => ({
      atom: atom.index,
      element: atom.element,
      isotropic: atom.isotropic,
      shiftPpm: atom.shiftPpm,
      value: atom.shiftPpm ?? atom.isotropic,
    })).sort((a, b) => a.value - b.value),
    curve: curve.map((point) => ({ ppm: point.ppm, intensity: max > 0 ? point.intensity / max : 0 })),
  };
}

/** SVG polyline in the same 0–100 × 0–100 box the other spectrum figures use. */
export function nmrPolyline(spectrum, { width = 100, height = 100 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return '';
  const span = spectrum.maxPpm - spectrum.minPpm || 1;
  return spectrum.curve.map((point, index) => {
    const x = ((point.ppm - spectrum.minPpm) / span) * width;
    const y = height - point.intensity * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

/** Gaussian's Fortran double, e.g. `0.926067D+01` or `-0.137253D-01`. */
const GAUSSIAN_REAL = /^[-+]?\d+\.\d+D[-+]?\d+$/i;

/** `0.926067D+01` → 9.26067. Trailing digits are kept as printed. */
function gaussianNumber(token) {
  return Number(String(token).replace(/D/i, 'E'));
}

/** `Total nuclear spin-spin coupling K (Hz):` — K is reduced, J is in Hz. */
const COUPLING_HEADER = /Total\s+(?:nuclear\s+)?spin-spin\s+coupling\s+([KJ])\s*\(\s*Hz\s*\)/i;

/**
 * Read one lower-triangular Gaussian coupling table.
 *
 * The table is printed in chunks of five columns. Each chunk opens with a
 * column-label line (`1 2 3 4 5`, then `6 7 8 9 10`, …) and then one row per
 * nucleus, row *i* printing only the columns in that chunk that are ≤ *i*:
 * in the first chunk row 7 prints five values, row 3 prints three, and in the
 * chunk that starts at column 6 row 7 prints two. The diagonal is printed as
 * `0.000000D+00`; nothing above the diagonal is printed at all.
 *
 * Values are keyed `"i,j"` exactly where the log printed them. No symmetry
 * fill happens here — that is the matrix build, from these printed values only.
 */
function readCouplingBlock(lines, start) {
  const values = new Map();
  const problems = [];
  let columns = null;
  let atoms = 0;
  let rows = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      if (rows === 0) continue;
      break;
    }
    const tokens = line.trim().split(/\s+/);
    if (tokens.every((token) => /^\d+$/.test(token))) {
      columns = tokens.map(Number);
      continue;
    }
    const isRow = /^\d+$/.test(tokens[0])
      && tokens.length > 1
      && tokens.slice(1).every((token) => GAUSSIAN_REAL.test(token));
    if (!isRow) break;
    if (!columns) {
      problems.push(`row ${tokens[0]} appears before a column header`);
      break;
    }
    const row = Number(tokens[0]);
    const first = columns[0];
    const last = columns[columns.length - 1];
    const expected = Math.min(row, last) - first + 1;
    const printed = tokens.slice(1).map(gaussianNumber);
    if (row < first) {
      problems.push(`row ${row} printed in the chunk that starts at column ${first}`);
    }
    if (printed.length !== expected) {
      problems.push(`row ${row} printed ${printed.length} values where its header allows ${expected}`);
    }
    printed.forEach((value, offset) => {
      const column = first + offset;
      if (column > row) {
        problems.push(`row ${row} printed a value above the diagonal (column ${column})`);
        return;
      }
      values.set(`${row},${column}`, value);
    });
    atoms = Math.max(atoms, row);
    rows += 1;
  }
  return { values, atoms, rows, problems };
}

/**
 * Spin-spin couplings from a `NMR=(GIAO,SpinSpin)` job.
 *
 * Both totals Gaussian prints are read: `Total nuclear spin-spin coupling
 * K (Hz)` (the reduced constant) and `... J (Hz)`. A job without either table
 * returns null — "unknown", not an empty matrix. When only one table is
 * present (a truncated log, a block Gaussian did not print) the other quantity
 * is `null` on every pair and its matrix is `null`; nothing is zero-filled.
 *
 * `matrix` is the J matrix in Hz, `kMatrix` the K matrix, both `atoms × atoms`
 * and row-major, filled symmetrically from the printed lower triangle. A pair
 * the log did not print is `NaN` (a Float64Array cannot hold `null`) —
 * `couplingAt()` maps that back to `null`. The diagonal is 0 only because the
 * log prints it as 0.
 *
 * `verified` means the table's own structure held: every row's value count
 * matches its column header, no value sits above the diagonal, and every
 * printed diagonal is exactly zero. `complete` means the J matrix covers every
 * pair and every diagonal — a log can be internally consistent and still
 * incomplete.
 */
export function parseCouplings(source) {
  const lines = toLines(source);
  const blocks = { K: null, J: null };
  for (let index = 0; index < lines.length; index += 1) {
    const header = COUPLING_HEADER.exec(lines[index]);
    if (!header) continue;
    const letter = header[1].toUpperCase();
    if (blocks[letter]) continue;
    blocks[letter] = readCouplingBlock(lines, index);
    blocks[letter].header = lines[index].trim();
  }
  if (!blocks.K && !blocks.J) return null;

  const atoms = Math.max(blocks.K?.atoms ?? 0, blocks.J?.atoms ?? 0);
  if (atoms === 0) return null;

  const problems = [...(blocks.K?.problems ?? []), ...(blocks.J?.problems ?? [])];
  if (blocks.K && blocks.J && blocks.K.atoms !== blocks.J.atoms) {
    problems.push(`the K table covers ${blocks.K.atoms} nuclei and the J table ${blocks.J.atoms}`);
  }

  const diagonals = { J: new Map(), K: new Map() };
  const byPair = new Map();
  for (const quantity of ['J', 'K']) {
    const block = blocks[quantity];
    if (!block) continue;
    for (const [key, value] of block.values) {
      const [row, column] = key.split(',').map(Number);
      if (row === column) {
        diagonals[quantity].set(row, value);
        if (value !== 0) problems.push(`the printed diagonal for nucleus ${row} is ${value}, not 0`);
        continue;
      }
      const pair = byPair.get(key) ?? { i: row, j: column, hz: null, k: null };
      if (quantity === 'J') pair.hz = value;
      else pair.k = value;
      byPair.set(key, pair);
    }
  }

  // A row with any printed value but no diagonal is a table that was cut, and a
  // nucleus missing from the middle of a table is a hole rather than an absence.
  for (const quantity of ['J', 'K']) {
    const block = blocks[quantity];
    if (!block) continue;
    const rows = new Set([...block.values.keys()].map((key) => Number(key.split(',')[0])));
    for (let row = 1; row <= atoms; row += 1) {
      if (!rows.has(row)) problems.push(`the ${quantity} table has no row for nucleus ${row}`);
    }
    for (const row of rows) {
      if (!diagonals[quantity].has(row)) problems.push(`the ${quantity} diagonal for nucleus ${row} is not printed`);
    }
  }

  const pairs = [...byPair.values()].sort((a, b) => (a.i - b.i) || (a.j - b.j));

  const buildMatrix = (letter) => {
    if (!blocks[letter]) return null;
    const matrix = new Float64Array(atoms * atoms).fill(Number.NaN);
    for (const pair of pairs) {
      const value = letter === 'J' ? pair.hz : pair.k;
      if (value === null) continue;
      matrix[(pair.i - 1) * atoms + (pair.j - 1)] = value;
      matrix[(pair.j - 1) * atoms + (pair.i - 1)] = value;
    }
    for (const [row, value] of diagonals[letter]) {
      matrix[(row - 1) * atoms + (row - 1)] = value;
    }
    return matrix;
  };

  const offDiagonal = (atoms * (atoms - 1)) / 2;
  const jComplete = Boolean(blocks.J)
    && pairs.filter((pair) => pair.hz !== null).length === offDiagonal
    && diagonals.J.size === atoms;

  return {
    pairs,
    matrix: buildMatrix('J'),
    kMatrix: buildMatrix('K'),
    atoms,
    units: 'Hz',
    kUnits: 'reduced K as printed (Gaussian labels the K table "(Hz)"; it is not a frequency)',
    convention: 'total J_ij as printed by Gaussian after its FC, SD, PSO and DSO contributions; '
      + 'sign as printed, never normalised; the diagonal is printed as 0 and a pair the log does '
      + 'not print is absent, not 0',
    verified: problems.length === 0,
    complete: jComplete,
    problems,
    printed: { pairs: pairs.filter((pair) => pair.hz !== null || pair.k !== null).length, atoms },
  };
}

/** One J value by 1-based atom indices, or null when the log did not print it. */
export function couplingAt(couplings, i, j) {
  const matrix = couplings?.matrix;
  const atoms = Number(couplings?.atoms);
  if (!(matrix instanceof Float64Array) || !Number.isInteger(atoms)) return null;
  const row = Number(i);
  const column = Number(j);
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
  if (row < 1 || row > atoms || column < 1 || column > atoms) return null;
  const value = matrix[(row - 1) * atoms + (column - 1)];
  return Number.isFinite(value) ? value : null;
}

/**
 * How the table's atom numbers line up with the record's atoms.
 *
 * Gaussian numbers nuclei from 1 in the order they appear in the input
 * geometry (its `Input orientation`/`Standard orientation` tables). The run
 * record's `finalGeometry.atoms[]` is 0-based, and each entry carries the same
 * 1-based number in `center`, so table nucleus *n* is `atoms[n - 1]`.
 */
export const COUPLING_ATOM_INDEXING = 'Gaussian numbers nuclei from 1 in input order; the record geometry '
  + 'atoms[] is 0-based and each entry\'s `center` is the same number, so nucleus n here is '
  + 'geometry.atoms[n − 1]. Nucleus labels in the tables are element + that number.';

/** `NaN` → `null`, so an unprinted pair stays absent across JSON. */
const jsonNumber = (value) => (Number.isFinite(value) ? value : null);

/** A string that survives JSON; null stays null rather than becoming "null". */
const jsonString = (value) => (value === null || value === undefined ? null : String(value));

/**
 * The JSON-safe form of a coupling result, for `run.json` and the report.
 *
 * A `Float64Array` serialises to an object keyed by index, so the record keeps
 * plain arrays: `matrix` and `kMatrix` are row-major `atoms × atoms` with
 * `null` where the log printed nothing. Nothing is zero-filled, and the
 * indexing note travels with the numbers.
 */
export function couplingSummary(couplings) {
  if (!couplings || !Number.isInteger(couplings.atoms) || couplings.atoms < 1) return null;
  const flatten = (matrix) => (matrix instanceof Float64Array
    ? Array.from(matrix, jsonNumber)
    : null);
  return {
    atoms: couplings.atoms,
    units: couplings.units,
    kUnits: couplings.kUnits,
    convention: couplings.convention,
    // ORCA numbers nuclei from 0; Gaussian from 1. The parser that read the
    // table owns this sentence, and it travels with the numbers so a consumer
    // cannot assume the Gaussian convention and shift every pair by one.
    indexing: couplings.indexing ?? COUPLING_ATOM_INDEXING,
    verified: couplings.verified === true,
    complete: couplings.complete === true,
    problems: Array.isArray(couplings.problems) ? [...couplings.problems] : [],
    printed: couplings.printed ?? null,
    // Optional provenance the ORCA reader carries beside the numbers. A
    // Gaussian table has none of these and the keys are simply absent.
    ...(couplings.source ? { source: String(couplings.source) } : {}),
    ...(couplings.note ? { note: String(couplings.note) } : {}),
    ...(Array.isArray(couplings.elements) ? { elements: couplings.elements.map(jsonString) } : {}),
    ...(couplings.verification && typeof couplings.verification === 'object'
      ? { verification: couplings.verification }
      : {}),
    pairs: couplings.pairs.map((pair) => ({
      i: pair.i,
      j: pair.j,
      hz: jsonNumber(pair.hz),
      k: jsonNumber(pair.k),
    })),
    matrix: flatten(couplings.matrix),
    kMatrix: flatten(couplings.kMatrix),
    matrixOrder: 'row-major, atoms × atoms, J in Hz',
  };
}
