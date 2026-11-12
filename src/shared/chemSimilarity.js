/**
 * ADR 0003 §3.7 — `similarity`: which of these records are the same kind of
 * molecule.
 *
 * One analyse block reads every wired record, fingerprints the structures,
 * computes a Tanimoto matrix, clusters at a stated cutoff and reports Murcko
 * scaffolds plus the maximum common substructure. The matrix is the evidence a
 * reader checks; a cluster id alone would be a verdict nobody can inspect.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const SIMILARITY_DEFAULTS = Object.freeze({
  fingerprint: 'morgan',
  radius: 2,
  nBits: 2048,
  metric: 'tanimoto',
  clusterCutoff: 0.6,
  mcsTimeoutSeconds: 10,
  maxRecords: 200,
});

export const SIMILARITY_FINGERPRINTS = Object.freeze(['morgan', 'rdkit', 'maccs']);
export const SIMILARITY_METRICS = Object.freeze(['tanimoto']);
export const SIMILARITY_MAX_RECORDS = 200;

export function normalizeSimilarityOptions(raw) {
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
  const fingerprint = String(provided.fingerprint || SIMILARITY_DEFAULTS.fingerprint);
  if (!SIMILARITY_FINGERPRINTS.includes(fingerprint)) {
    throw new ChemError('bad-options', `fingerprint must be one of: ${SIMILARITY_FINGERPRINTS.join(', ')}.`);
  }
  const metric = String(provided.metric || SIMILARITY_DEFAULTS.metric);
  if (!SIMILARITY_METRICS.includes(metric)) {
    throw new ChemError('bad-options', `metric must be ${SIMILARITY_METRICS.join(', ')}.`);
  }
  return {
    fingerprint,
    radius: integer('radius', SIMILARITY_DEFAULTS.radius, 1, 4),
    nBits: integer('nBits', SIMILARITY_DEFAULTS.nBits, 512, 8192),
    metric,
    clusterCutoff: number('clusterCutoff', SIMILARITY_DEFAULTS.clusterCutoff, 0, 1),
    mcsTimeoutSeconds: integer('mcsTimeoutSeconds', SIMILARITY_DEFAULTS.mcsTimeoutSeconds, 1, 60),
    maxRecords: integer('maxRecords', SIMILARITY_DEFAULTS.maxRecords, 2, SIMILARITY_MAX_RECORDS),
  };
}

export function similarityRequest({ molecules = [], options = {} } = {}) {
  const resolved = normalizeSimilarityOptions(options);
  const list = Array.isArray(molecules) ? molecules : [];
  if (list.length < 2) {
    throw new ChemError('bad-input', 'A similarity request needs at least two molecules.');
  }
  if (list.length > resolved.maxRecords) {
    throw new ChemError('size-refused',
      `This block received ${list.length} molecules; the similarity cap is ${resolved.maxRecords}.`);
  }
  const request = chemRequest({ op: 'similarity', molecule: list[0].molecule || list[0], options: resolved });
  request.molecules = list;
  delete request.molecule;
  return request;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeSimilarityResult(raw) {
  const answer = normalizeChemResponse(raw, { op: 'similarity' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The similarity answer carries no result.');
  }
  const molecules = Array.isArray(result.molecules) ? result.molecules : [];
  if (molecules.length < 2) {
    throw new ChemError('bad-response', 'The similarity answer carries fewer than two molecules.');
  }
  const normalizedMolecules = molecules.map((entry, index) => ({
    id: String(entry?.id || `m${index + 1}`).slice(0, 64),
    label: String(entry?.label || entry?.id || `m${index + 1}`).slice(0, 120),
    smiles: String(entry?.smiles || ''),
    formula: String(entry?.formula || ''),
    scaffold: String(entry?.scaffold || ''),
  }));
  const n = normalizedMolecules.length;
  const matrixRaw = Array.isArray(result.matrix) ? result.matrix : [];
  if (matrixRaw.length !== n) {
    throw new ChemError('bad-response', 'The similarity matrix does not match the molecule count.');
  }
  const matrix = matrixRaw.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) {
      throw new ChemError('bad-response', `Similarity row ${i + 1} does not match the molecule count.`);
    }
    return row.map((value) => {
      const number = finite(value);
      if (number === null || number < 0 || number > 1) {
        throw new ChemError('bad-response', `Similarity row ${i + 1} carries a value outside 0..1.`);
      }
      return number;
    });
  });
  const clusters = Array.isArray(result.clusters) ? result.clusters.slice(0, n).map((entry, index) => ({
    id: String(entry?.id || `k${index + 1}`),
    members: Array.isArray(entry?.members)
      ? entry.members.map((member) => Number(member)).filter((member) => Number.isInteger(member) && member >= 0 && member < n)
      : [],
  })) : [];
  const mcs = result.mcs && typeof result.mcs === 'object' ? {
    smarts: String(result.mcs.smarts || ''),
    atoms: finite(result.mcs.atoms),
    bonds: finite(result.mcs.bonds),
    timedOut: result.mcs.timedOut === true,
  } : null;
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    options: answer.options,
    molecules: normalizedMolecules,
    matrix,
    clusters,
    mcs,
    pairs: Array.isArray(result.pairs) ? result.pairs.slice(0, n * n).map((entry) => ({
      i: Number(entry?.i),
      j: Number(entry?.j),
      similarity: finite(entry?.similarity),
    })).filter((entry) => Number.isInteger(entry.i) && Number.isInteger(entry.j)
      && entry.i >= 0 && entry.i < n && entry.j >= 0 && entry.j < n && entry.similarity !== null) : [],
    origin: chemOrigin(answer, { method: `${answer.options?.fingerprint || 'morgan'} fingerprint · Tanimoto · Butina` }),
  };
}

/** One line for the card and report caption. */
export function similaritySummary(result) {
  if (!result || typeof result !== 'object') return '';
  const count = result.molecules?.length ?? 0;
  const clusters = result.clusters?.length ?? 0;
  return `${count} molecules · ${clusters} cluster${clusters === 1 ? '' : 's'} at ${result.options?.clusterCutoff ?? '?'} · `
    + `${result.options?.fingerprint || 'morgan'} ${result.options?.nBits || ''} bits`;
}
