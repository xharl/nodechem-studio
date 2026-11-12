/**
 * ADR 0003 §3.5 — `stereoisomers`, a candidate set of distinct molecules.
 *
 * Parallel to `tautomers.js` on purpose: the contract is the same (labels,
 * SMILES, one geometry per candidate, no energies, fan out one calculation per
 * candidate) but the **geometry policy is not**. `EnumerateStereoisomers` copies
 * the input conformer onto every candidate, so carrying those coordinates
 * forward would label an inverted centre with the original geometry. Only the
 * candidate identical to the input keeps its coordinates; every other candidate
 * is embedded, and `geometry.source` records which happened.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const STEREOISOMER_DEFAULTS = Object.freeze({
  maxCandidates: 16,
  seed: 1,
});

export const STEREOISOMER_MAX_CANDIDATES = 128;

export function normalizeStereoisomerOptions(raw) {
  const provided = raw && typeof raw === 'object' ? raw : {};
  const integer = (key, fallback, min, max) => {
    const value = provided[key] === undefined ? fallback : Number(provided[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ChemError('bad-options', `Option ${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  return {
    maxCandidates: integer('maxCandidates', STEREOISOMER_DEFAULTS.maxCandidates, 1, STEREOISOMER_MAX_CANDIDATES),
    seed: integer('seed', STEREOISOMER_DEFAULTS.seed, 0, 0x7fffffff),
  };
}

export function stereoisomerRequest({ molecule, options = {} } = {}) {
  return chemRequest({ op: 'stereoisomers', molecule, options: normalizeStereoisomerOptions(options) });
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

export function normalizeStereoisomerResult(raw) {
  const answer = normalizeChemResponse(raw, { op: 'stereoisomers' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The stereoisomers answer carries no result.');
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  if (candidates.length === 0) {
    throw new ChemError('bad-response', 'The stereoisomers answer carries no candidates.');
  }
  const seen = new Set();
  const normalized = candidates.map((entry, index) => {
    const smiles = String(entry?.smiles || '').trim();
    if (!smiles) throw new ChemError('bad-response', `Candidate ${index + 1} carries no SMILES.`);
    // Two candidates with one identity are one molecule; the set must not
    // present a duplicate as a second stereoisomer.
    if (seen.has(smiles)) throw new ChemError('bad-response', `Candidate ${index + 1} duplicates an earlier SMILES.`);
    seen.add(smiles);
    const label = String(entry?.label || `s${index + 1}`).trim();
    if (!LABEL.test(label)) throw new ChemError('bad-response', `Candidate ${index + 1} has an invalid label.`);
    const atoms = Array.isArray(entry?.atoms) ? entry.atoms.map((atom) => {
      const element = String(atom?.element || '').trim();
      const x = Number(atom?.x);
      const y = Number(atom?.y);
      const z = Number(atom?.z);
      if (!element || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new ChemError('bad-response', `Candidate ${index + 1} has an incomplete atom.`);
      }
      return { element, x, y, z };
    }) : [];
    if (atoms.length === 0) throw new ChemError('bad-response', `Candidate ${index + 1} carries no geometry.`);
    const source = String(entry?.geometry?.source || '');
    return {
      label,
      smiles,
      formula: String(entry?.formula || ''),
      atoms,
      geometry: { source: source === 'input' ? 'input' : 'etkdgv4' },
    };
  });
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    options: answer.options,
    candidates: normalized,
    truncated: result.truncated === true,
    rejected: Array.isArray(result.rejected) ? result.rejected.length : 0,
    origin: chemOrigin(answer, { method: 'EnumerateStereoisomers' }),
  };
}

export function stereoisomerOrigin(result) {
  return {
    program: result.program || 'RDKit',
    version: result.version || '',
    method: 'EnumerateStereoisomers',
    sourceSha256: '',
  };
}

/**
 * The ensemble summary a stereoisomer block writes. No energies, no
 * populations: these are distinct molecules, and the comparison happens at the
 * target level after each candidate fans out.
 */
export function stereoisomerSummary({ result, group = '', selectedId = '' } = {}) {
  const wanted = /^c\d+$/.test(String(selectedId || '')) ? String(selectedId) : '';
  const members = result.candidates.map((candidate, index) => ({
    id: `c${index + 1}`,
    rank: index + 1,
    // `stereoisomer` is the label field the report prints; `smiles` is the
    // difference a reader compares, never an energy.
    stereoisomer: candidate.label,
    smiles: candidate.smiles,
    formula: candidate.formula,
    energyEh: null,
    energyKcal: null,
    energyUnit: 'hartree',
    energyMethod: '',
    relativeKcal: null,
    population: null,
    rmsdToLowest: null,
    protomer: '',
    kept: true,
    dropped: null,
    geometry: candidate.geometry,
    atoms: candidate.atoms,
  }));
  const selected = members.find((member) => member.id === wanted) || (members.length === 1 ? members[0] : null);
  const warnings = [{
    id: 'stereoisomer-distinct-molecules',
    status: 'warn',
    message: 'These are stereoisomer candidates: distinct molecules, not conformers. No energy window or RMSD '
      + 'prune was applied; each candidate is meant to be run as its own calculation and compared at that level. '
      + 'Only the candidate identical to the input keeps the input coordinates; every other candidate was re-embedded.',
  }];
  if (result.truncated) {
    warnings.push({
      id: 'stereoisomer-truncated',
      status: 'warn',
      message: `RDKit's enumerator reached the ${result.options?.maxCandidates ?? 'configured'} candidate cap, so the set is truncated.`,
    });
  }
  return {
    generator: 'rdkit',
    produces: 'stereoisomers',
    method: '',
    energyUnit: 'hartree',
    energyMethod: '',
    mixedEnergies: false,
    origin: stereoisomerOrigin(result),
    group,
    count: members.length,
    total: members.length,
    spreadKcal: null,
    pruned: { energy: 0, rmsd: 0, count: 0 },
    warnings,
    requiresSelection: members.length > 1 && !selected,
    autoSelected: false,
    protomers: [],
    tautomers: [],
    stereoisomers: members.map((member) => member.stereoisomer),
    truncated: Boolean(result.truncated),
    selectedId: selected?.id || '',
    selected: selected ? {
      id: selected.id,
      rank: selected.rank,
      stereoisomer: selected.stereoisomer,
      smiles: selected.smiles,
      energyEh: null,
      energyKcal: null,
      energyUnit: 'hartree',
      energyMethod: '',
      relativeKcal: null,
      population: null,
      protomer: '',
      atoms: selected.atoms,
      geometry: selected.geometry,
    } : null,
    members,
  };
}
