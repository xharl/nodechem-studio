/**
 * ADR 0003 §3.4 — RDKit conformer search for a `generate` block.
 *
 * ETKDGv4 embedding, MMFF94 or UFF optimisation, then the app's own curation
 * (energy window, RMSD prune, retention cap, fan-out). The sidecar returns
 * candidate geometries and energies; it never decides what is kept, so a
 * search here is pruned by the same code as CREST and Open Babel.
 *
 * The cap is a refusal (`size-refused`), not a warning: an open-ended
 * force-field search on a flexible molecule is not offered.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const RDKIT_CONFORMER_DEFAULTS = Object.freeze({
  nconf: 50,
  seed: 1,
  pruneRms: 0.5,
  forceField: 'MMFF94',
  maxHeavyAtoms: 60,
  threads: 1,
});

export const RDKIT_MAX_CONFORMERS = 200;
export const RDKIT_MAX_HEAVY_ATOMS = 100;
export const RDKIT_MAX_THREADS = 8;
export const RDKIT_FORCE_FIELDS = Object.freeze(['MMFF94', 'UFF']);

export function normalizeRdkitConformerOptions(raw) {
  const provided = raw && typeof raw === 'object' ? raw : {};
  const integer = (key, fallback, min, max) => {
    const value = provided[key] === undefined ? fallback : Number(provided[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ChemError('bad-options', `Option ${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const number = (key, fallback, min, max) => {
    const value = provided[key] === undefined ? fallback : Number(provided[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new ChemError('bad-options', `Option ${key} must be a number between ${min} and ${max}.`);
    }
    return value;
  };
  const forceField = String(provided.forceField || RDKIT_CONFORMER_DEFAULTS.forceField).trim();
  if (!RDKIT_FORCE_FIELDS.includes(forceField)) {
    throw new ChemError('bad-options', `forceField must be one of: ${RDKIT_FORCE_FIELDS.join(', ')}.`);
  }
  return {
    nconf: integer('nconf', RDKIT_CONFORMER_DEFAULTS.nconf, 1, RDKIT_MAX_CONFORMERS),
    seed: integer('seed', RDKIT_CONFORMER_DEFAULTS.seed, 0, 0x7fffffff),
    pruneRms: number('pruneRms', RDKIT_CONFORMER_DEFAULTS.pruneRms, 0, 5),
    forceField,
    maxHeavyAtoms: integer('maxHeavyAtoms', RDKIT_CONFORMER_DEFAULTS.maxHeavyAtoms, 1, RDKIT_MAX_HEAVY_ATOMS),
    threads: integer('threads', RDKIT_CONFORMER_DEFAULTS.threads, 1, RDKIT_MAX_THREADS),
  };
}

export function rdkitConformerRequest({ molecule, options = {} } = {}) {
  return chemRequest({
    op: 'conformers',
    molecule,
    options: normalizeRdkitConformerOptions(options),
  });
}

function atomOf(raw, index) {
  const element = raw?.element === undefined ? '' : String(raw.element).trim();
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (!element || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new ChemError('bad-response', `Conformer atom ${index + 1} is incomplete.`);
  }
  return { element, x, y, z };
}

export function normalizeRdkitConformerResult(raw) {
  const answer = normalizeChemResponse(raw, { op: 'conformers' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The conformers answer carries no result.');
  }
  const conformers = Array.isArray(result.conformers) ? result.conformers : [];
  if (conformers.length === 0) {
    throw new ChemError('bad-response', 'The conformers answer carries no geometries.');
  }
  const normalized = conformers.map((entry, index) => {
    const atoms = Array.isArray(entry?.atoms) ? entry.atoms.map(atomOf) : [];
    if (atoms.length === 0) {
      throw new ChemError('bad-response', `Conformer ${index + 1} carries no atoms.`);
    }
    const energyKcal = Number(entry?.energyKcal);
    if (!Number.isFinite(energyKcal)) {
      throw new ChemError('bad-response', `Conformer ${index + 1} carries no finite energy.`);
    }
    return {
      atoms,
      energyKcal,
      converged: entry?.converged !== false,
    };
  });
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    options: answer.options,
    conformers: normalized,
    forceField: String(result.forceField || answer.options?.forceField || ''),
    embedding: String(result.embedding || 'ETKDGv4'),
    seed: Number.isInteger(result.seed) ? result.seed : null,
    threads: Number.isInteger(result.threads) ? result.threads : null,
    heavyAtomCount: Number.isInteger(result.heavyAtomCount) ? result.heavyAtomCount : null,
    requested: Number.isInteger(result.requested) ? result.requested : normalized.length,
    convergedCount: Number.isInteger(result.convergedCount)
      ? result.convergedCount
      : normalized.filter((entry) => entry.converged).length,
    fallback: String(result.fallback || ''),
    warnings: Array.isArray(result.warnings) ? result.warnings.map((entry) => String(entry).slice(0, 400)) : [],
    origin: chemOrigin(answer, { method: `${result.embedding || 'ETKDGv4'} + ${result.forceField || 'force field'}` }),
  };
}

/** The ensemble's provenance line: embedding version and the force field that ran. */
export function rdkitConformerOrigin(result) {
  const forceField = result?.forceField || 'force field';
  return {
    program: result?.program || 'RDKit',
    version: result?.version || '',
    method: `${result?.embedding || 'ETKDGv4'} + ${forceField}`,
    sourceSha256: '',
  };
}

/** Caveats a reader must see beside the numbers. */
export function rdkitConformerWarnings(result) {
  const warnings = [...(Array.isArray(result?.warnings) ? result.warnings : [])];
  if (result?.fallback === 'uff') {
    warnings.push('MMFF94 has no parameters for this molecule; the search used UFF. The energies are UFF kcal/mol.');
  }
  if (result?.convergedCount < result?.requested) {
    warnings.push(`${result.requested - result.convergedCount} of ${result.requested} geometries did not converge in the force field.`);
  }
  warnings.push('This is a force-field search, not a CREST/xTB search, and not a QM result.');
  return warnings;
}
