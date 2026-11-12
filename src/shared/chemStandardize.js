/**
 * ADR 0003 §3.2 — `standardize`, a deterministic 1→1 cleanup.
 *
 * Normalise, disconnect metals, drop salts/counterions and pick the charge
 * parent. The record states what changed — formula and atom count before and
 * after, the fragments removed, the charge before and after — because a cleanup
 * that silently deleted a fragment would be indistinguishable from one that did
 * nothing. A stereo audit runs in the same answer: unassigned stereocentres and
 * double bonds are reported before a calculation ever sees the structure.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const STANDARDIZE_DEFAULTS = Object.freeze({
  normalize: true,
  disconnectMetals: true,
  removeFragments: true,
  chargeParent: true,
});

export function normalizeStandardizeOptions(raw) {
  const provided = raw && typeof raw === 'object' ? raw : {};
  const options = {};
  for (const [key, fallback] of Object.entries(STANDARDIZE_DEFAULTS)) {
    const value = provided[key] === undefined ? fallback : provided[key];
    if (typeof value !== 'boolean') {
      throw new ChemError('bad-options', `Option ${key} must be true or false.`);
    }
    options[key] = value;
  }
  return options;
}

export function standardizeRequest({ molecule, options = null } = {}) {
  return chemRequest({ op: 'standardize', molecule, options: normalizeStandardizeOptions(options) });
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

function stateOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    formula: textOrNull(source.formula) || '',
    atomCount: numberOrNull(source.atomCount),
    heavyAtomCount: numberOrNull(source.heavyAtomCount),
    charge: numberOrNull(source.charge),
    fragments: numberOrNull(source.fragments),
    smiles: textOrNull(source.smiles) || '',
  };
}

/**
 * Validate the `standardize` answer.
 *
 * `atoms` is required: a prepare block must write a structure downstream. When
 * RDKit had to rebuild the geometry (`geometry.source: 'etkdgv3'`), the record
 * says so instead of claiming the input coordinates survived.
 */
export function normalizeStandardizeResult(raw) {
  const answer = normalizeChemResponse(raw, { op: 'standardize' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The standardize answer carries no result.');
  }
  const before = stateOf(result.before);
  const after = stateOf(result.after);
  if (!after.formula || after.atomCount === null || after.atomCount < 1) {
    throw new ChemError('bad-response', 'The standardize answer carries no usable "after" structure.');
  }
  const atoms = Array.isArray(result.atoms) ? result.atoms : [];
  if (atoms.length === 0) {
    throw new ChemError('bad-response', 'The standardize answer carries no atoms to hand downstream.');
  }
  const normalizedAtoms = atoms.map((atom, index) => {
    const element = textOrNull(atom?.element);
    const x = numberOrNull(atom?.x);
    const y = numberOrNull(atom?.y);
    const z = numberOrNull(atom?.z);
    if (!element || x === null || y === null || z === null) {
      throw new ChemError('bad-response', `Standardized atom ${index + 1} is incomplete.`);
    }
    return { element, x, y, z };
  });
  const removed = Array.isArray(result.fragmentsRemoved)
    ? result.fragmentsRemoved.slice(0, 32).map((entry) => ({
      smiles: textOrNull(entry?.smiles) || '',
      formula: textOrNull(entry?.formula) || '',
      atomCount: numberOrNull(entry?.atomCount),
    }))
    : [];
  const auditRaw = result.stereoAudit && typeof result.stereoAudit === 'object' ? result.stereoAudit : {};
  const stereoAudit = {
    unassignedStereocentres: Array.isArray(auditRaw.unassignedStereocentres)
      ? auditRaw.unassignedStereocentres.map((entry) => ({
        atomIndex: numberOrNull(entry?.atomIndex),
        element: textOrNull(entry?.element) || '',
      })).slice(0, 200)
      : [],
    unassignedDoubleBonds: Array.isArray(auditRaw.unassignedDoubleBonds)
      ? auditRaw.unassignedDoubleBonds.map((entry) => ({
        beginAtomIndex: numberOrNull(entry?.beginAtomIndex),
        endAtomIndex: numberOrNull(entry?.endAtomIndex),
      })).slice(0, 200)
      : [],
  };
  const geometry = result.geometry && typeof result.geometry === 'object'
    ? { source: textOrNull(result.geometry.source) || '' }
    : { source: '' };
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    options: answer.options,
    cache: answer.cache,
    before,
    after,
    removed,
    stereoAudit,
    geometry,
    atoms: normalizedAtoms,
    identity: result.identity && typeof result.identity === 'object' ? result.identity : null,
    origin: chemOrigin(answer, { method: 'rdMolStandardize.Cleanup' }),
  };
}

/** The warnings the inspector, queue log and report print. */
export function stereoAuditWarnings(audit) {
  const source = audit && typeof audit === 'object' ? audit : {};
  const warnings = [];
  const centres = Array.isArray(source.unassignedStereocentres) ? source.unassignedStereocentres : [];
  const bonds = Array.isArray(source.unassignedDoubleBonds) ? source.unassignedDoubleBonds : [];
  if (centres.length > 0) {
    warnings.push(`${centres.length} unassigned stereocentre(s): atom `
      + `${centres.map((entry) => entry.atomIndex).filter((index) => index !== null).join(', ')}`
      + '. A calculation on this structure cannot say which configuration it ran.');
  }
  if (bonds.length > 0) {
    warnings.push(`${bonds.length} unassigned double bond(s): `
      + `${bonds.map((entry) => `${entry.beginAtomIndex}=${entry.endAtomIndex}`).join(', ')}.`);
  }
  return warnings;
}

/** The one-line summary a card, queue row and report share. */
export function standardizeSummary(result) {
  if (!result || typeof result !== 'object') return 'not standardised';
  const before = result.before || {};
  const after = result.after || {};
  const parts = ['standardised', after.formula || '', `${after.atomCount ?? '?'} atoms`];
  if (result.removed?.length) parts.push(`${result.removed.length} fragment(s) removed`);
  if (before.charge !== after.charge) parts.push(`charge ${before.charge ?? '?'} → ${after.charge ?? '?'}`);
  if (before.atomCount !== after.atomCount && !result.removed?.length) {
    parts.push(`${before.atomCount ?? '?'} → ${after.atomCount ?? '?'} atoms`);
  }
  if (result.geometry?.source === 'etkdgv3') parts.push('geometry re-embedded (ETKDGv3)');
  return parts.filter(Boolean).join(' · ');
}
