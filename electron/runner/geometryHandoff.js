import fsp from 'node:fs/promises';
import path from 'node:path';
import { replaceInputGeometry } from '../../src/shared/gaussianInput.js';
import { replacePyscfGeometry } from '../../src/shared/engines/pyscf.js';

/**
 * The parsed final geometry a finished run leaves in its `run.json`.
 *
 * A cross-engine edge carries a geometry, not a checkpoint: the downstream
 * block must be built from what the upstream engine actually produced, so this
 * reads the run record rather than the project coordinates the block was
 * planned with. Returns null when the record carries none — the caller reports
 * that instead of falling back to the input echo.
 */
export async function readUpstreamGeometry(runDir) {
  const directory = String(runDir || '').trim();
  if (!directory) return null;
  let record;
  try {
    record = JSON.parse(await fsp.readFile(path.join(directory, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
  const atoms = record?.parsed?.finalGeometry?.atoms;
  if (!Array.isArray(atoms) || atoms.length === 0) return null;
  const valid = atoms.every((atom) => atom
    && typeof atom.element === 'string'
    && Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z));
  return valid ? atoms : null;
}

/** Rewrite a Gaussian input's geometry with a handed-over structure. */
export function applyGeometryHandoff(inputText, atoms) {
  return replaceInputGeometry(inputText, atoms);
}

const ELEMENT = /^[A-Z][a-z]?$/;

/**
 * The atoms a rewrite may write, or a refusal naming the first bad one.
 *
 * Issue 326: every engine's deck is rewritten from this list, so the validation
 * happens once instead of once per format.
 */
function checkedAtoms(atoms) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new Error('No atoms were supplied for the geometry hand-off.');
  }
  return atoms.map((atom, index) => {
    const element = String(atom?.element ?? '').trim();
    if (!ELEMENT.test(element)) throw new Error(`Atom ${index + 1} has an invalid element symbol.`);
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isFinite(atom[axis])) throw new Error(`Atom ${index + 1} ${axis} is not a number.`);
    }
    return { element, x: atom.x, y: atom.y, z: atom.z };
  });
}

/** ORCA and xTB write `El` then three 12-wide columns. */
const columnLine = (atom) => `${atom.element.padEnd(2)} ${atom.x.toFixed(6).padStart(12)} `
  + `${atom.y.toFixed(6).padStart(12)} ${atom.z.toFixed(6).padStart(12)}`;

/** Psithon writes two spaces between fields. */
const psi4Line = (atom) => `  ${atom.element}  ${atom.x.toFixed(6)}  ${atom.y.toFixed(6)}  ${atom.z.toFixed(6)}`;

const COORD_ROW = /^\s*[A-Z][a-z]?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s*$/;

/**
 * Replace the atom rows of a block, in place, and nothing else.
 *
 * An optimisation does not reorder atoms, so the Nth handed-over atom goes on
 * the Nth coordinate line and every other line — the charge/multiplicity header,
 * a `--` fragment separator, a `symmetry` line — keeps its position. A block
 * whose atom count disagrees with the geometry is a refusal, not a guess
 * (issue 326).
 */
function replaceRows(body, rows, format) {
  const indices = body
    .map((line, index) => (COORD_ROW.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (indices.length !== rows.length) {
    throw new Error(`The deck has ${indices.length} atom rows and the handed-over geometry has `
      + `${rows.length}; the geometry cannot be placed without guessing.`);
  }
  const out = [...body];
  indices.forEach((index, position) => {
    out[index] = format(rows[position]);
  });
  return out;
}

/**
 * Psi4/Psithon: the coordinates live inside `molecule { … }`, after the
 * charge/multiplicity line and any `symmetry` line (issue 326).
 */
export function replacePsi4Geometry(inputText, atoms) {
  const rows = checkedAtoms(atoms);
  const lines = String(inputText ?? '').split(/\r\n|\n|\r/);
  const open = lines.findIndex((line) => /^\s*molecule\s*\{/.test(line));
  if (open === -1) throw new Error('The Psi4 deck has no `molecule {` block; the geometry cannot be placed.');
  const close = lines.findIndex((line, index) => index > open && /^\s*\}\s*$/.test(line));
  if (close === -1) throw new Error('The Psi4 deck\u2019s `molecule {` block is not closed; the geometry cannot be placed.');
  return [
    ...lines.slice(0, open + 1),
    ...replaceRows(lines.slice(open + 1, close), rows, psi4Line),
    ...lines.slice(close),
  ].join('\n');
}

/** ORCA: `* xyz <charge> <mult>` lines then `*` (issue 326). */
export function replaceOrcaGeometry(inputText, atoms) {
  const rows = checkedAtoms(atoms);
  const lines = String(inputText ?? '').split(/\r\n|\n|\r/);
  const open = lines.findIndex((line) => /^\s*\*\s*xyz\b/i.test(line));
  if (open === -1) throw new Error('The ORCA deck has no `* xyz` block; the geometry cannot be placed.');
  const close = lines.findIndex((line, index) => index > open && /^\s*\*\s*$/.test(line));
  if (close === -1) throw new Error('The ORCA deck\u2019s `* xyz` block is not closed; the geometry cannot be placed.');
  return [
    ...lines.slice(0, open + 1),
    ...replaceRows(lines.slice(open + 1, close), rows, columnLine),
    ...lines.slice(close),
  ].join('\n');
}

/**
 * xTB reads an `.xyz` file, so the hand-off is the whole deck: a fresh frame
 * that keeps the planned comment line (issue 326).
 */
export function replaceXyzGeometry(inputText, atoms) {
  const rows = checkedAtoms(atoms);
  const lines = String(inputText ?? '').split(/\r\n|\n|\r/);
  const comment = lines.length > 1 ? lines[1] : '';
  return [`${rows.length}`, comment, ...rows.map(columnLine)].join('\n') + '\n';
}

/**
 * Rewrite the geometry of the deck an engine actually wrote.
 *
 * Gaussian's route file has a molecule specification, PySCF carries its
 * molecule as base64 JSON, Psi4 has a `molecule {` block, ORCA a `* xyz` block
 * and xTB an `.xyz` file. A deck with no block to rewrite throws instead of
 * being run unchanged, so the queue never records a hand-off that did not
 * happen (issue 326).
 */
export function applyGeometryHandoffFor(engineId, inputText, atoms) {
  if (engineId === 'pyscf') return replacePyscfGeometry(inputText, atoms);
  if (engineId === 'gaussian') return applyGeometryHandoff(inputText, atoms);
  if (engineId === 'psi4') return replacePsi4Geometry(inputText, atoms);
  if (engineId === 'orca') return replaceOrcaGeometry(inputText, atoms);
  if (engineId === 'xtb') return replaceXyzGeometry(inputText, atoms);
  throw new Error(`No geometry rewrite is implemented for engine "${String(engineId)}".`);
}
