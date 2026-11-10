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

/**
 * Rewrite the geometry of the deck an engine actually wrote.
 *
 * Gaussian's route file has a molecule specification; a PySCF deck carries its
 * molecule as base64 JSON, so it needs its own rewrite. An engine with no
 * rewrite (Psi4 today) is left unchanged — the caller still records the
 * hand-off, and the deck keeps the geometry it was planned with.
 */
export function applyGeometryHandoffFor(engineId, inputText, atoms) {
  if (engineId === 'pyscf') return replacePyscfGeometry(inputText, atoms);
  if (engineId === 'gaussian') return applyGeometryHandoff(inputText, atoms);
  return inputText;
}
