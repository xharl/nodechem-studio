/**
 * ADR 0003 §3.1 — `descriptors`, the curated `nodechem-1` set.
 *
 * A versioned set, not the ~420 public entries in `Chem.Descriptors`: every key
 * here is 2D/topological unless its own row says otherwise, so no descriptor is
 * ever mistaken for a calculated property. Adding or redefining one bumps
 * `DESCRIPTOR_SET_ID`, which every record carries; an old report then still
 * says which table produced it.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const DESCRIPTOR_SET_ID = 'nodechem-1';

/**
 * One row per descriptor. `kind` is `number`, `text` or `count`; `unit` is what
 * the value is in (an empty string means dimensionless). `label` is what the
 * report and CSV header print.
 */
export const DESCRIPTORS = Object.freeze([
  { key: 'formula', label: 'Formula', kind: 'text', unit: '' },
  { key: 'exactMass', label: 'Exact mass', kind: 'number', unit: 'Da' },
  { key: 'molWeight', label: 'Molecular weight', kind: 'number', unit: 'Da' },
  { key: 'logP', label: 'logP (Crippen)', kind: 'number', unit: '' },
  { key: 'tpsa', label: 'TPSA', kind: 'number', unit: 'Å²' },
  { key: 'hbd', label: 'H-bond donors', kind: 'count', unit: '' },
  { key: 'hba', label: 'H-bond acceptors', kind: 'count', unit: '' },
  { key: 'rotatableBonds', label: 'Rotatable bonds', kind: 'count', unit: '' },
  { key: 'ringCount', label: 'Rings', kind: 'count', unit: '' },
  { key: 'aromaticRingCount', label: 'Aromatic rings', kind: 'count', unit: '' },
  { key: 'fsp3', label: 'Fsp3', kind: 'number', unit: '' },
  { key: 'qed', label: 'QED', kind: 'number', unit: '' },
  { key: 'formalCharge', label: 'Formal charge', kind: 'count', unit: 'e' },
  { key: 'inchiKey', label: 'InChIKey', kind: 'text', unit: '' },
  { key: 'murckoScaffold', label: 'Murcko scaffold', kind: 'text', unit: '' },
]);

export const DESCRIPTOR_KEYS = Object.freeze(DESCRIPTORS.map((entry) => entry.key));

/** The descriptor definition for a key, or null. */
export function descriptorOf(key) {
  return DESCRIPTORS.find((entry) => entry.key === key) || null;
}

/** Options this set accepts. None change the answer today; the echo is the point. */
export const DEFAULT_DESCRIPTOR_OPTIONS = Object.freeze({});

/**
 * The request for one molecule. One molecule per request in this phase: the
 * queue already runs one analyse task per record, and the run-local cache makes
 * a repeated 2D set cheap. A batch field would be a protocol extension and is
 * deliberately not invented here.
 */
export function descriptorRequest({ molecule, options = null } = {}) {
  return chemRequest({
    op: 'descriptors',
    molecule,
    options: options && typeof options === 'object' ? options : { ...DEFAULT_DESCRIPTOR_OPTIONS },
  });
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Validate the sidecar's `descriptors` answer.
 *
 * A descriptor the sidecar did not report stays `null`, never `0`: a molecule
 * RDKit could not sanitise is a refusal (the whole request fails), while a
 * single missing descriptor is an honest gap. `identity` is required because
 * §2.4 keys the cache on it.
 */
export function normalizeDescriptorResult(raw) {
  const answer = normalizeChemResponse(raw, { op: 'descriptors' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The descriptors answer carries no result.');
  }
  const identityRaw = result.identity && typeof result.identity === 'object' ? result.identity : null;
  if (!identityRaw || !textOrNull(identityRaw.smiles)) {
    throw new ChemError('bad-response', 'The descriptors answer carries no molecule identity.');
  }
  const identity = {
    smiles: String(identityRaw.smiles),
    inchiKey: textOrNull(identityRaw.inchiKey) || '',
    tautomerHash: textOrNull(identityRaw.tautomerHash) || '',
    formula: textOrNull(identityRaw.formula) || '',
    atomCount: numberOrNull(identityRaw.atomCount),
    heavyAtomCount: numberOrNull(identityRaw.heavyAtomCount),
  };
  const provided = result.descriptors && typeof result.descriptors === 'object' ? result.descriptors : {};
  const descriptors = {};
  for (const definition of DESCRIPTORS) {
    const value = provided[definition.key];
    descriptors[definition.key] = definition.kind === 'text'
      ? textOrNull(value)
      : numberOrNull(value);
  }
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    options: answer.options,
    cache: answer.cache,
    identity,
    descriptors,
    origin: chemOrigin(answer, { method: `descriptor set ${DESCRIPTOR_SET_ID}` }),
  };
}

/** Ordered `{key, label, unit, value}` rows for a table. */
export function descriptorRows(descriptors) {
  const source = descriptors && typeof descriptors === 'object' ? descriptors : {};
  return DESCRIPTORS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    kind: definition.kind,
    value: source[definition.key] === undefined ? null : source[definition.key],
  }));
}

/** The one-line summary a card, queue row and report share. */
export function descriptorSummary(result) {
  if (!result || typeof result !== 'object') return 'no descriptors';
  const values = result.descriptors || {};
  const formula = values.formula || result.identity?.formula || '';
  const weight = Number.isFinite(values.molWeight) ? `${values.molWeight.toFixed(2)} Da` : '';
  const tpsa = Number.isFinite(values.tpsa) ? `TPSA ${values.tpsa.toFixed(1)} Å²` : '';
  return ['descriptors', DESCRIPTOR_SET_ID, formula, weight, tpsa].filter(Boolean).join(' · ');
}
