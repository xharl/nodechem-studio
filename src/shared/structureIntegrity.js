/**
 * ADR 0003 §3.6 — `integrity`, the post-run identity gate.
 *
 * A calculation returns coordinates, not a molecule: what the run "is" has to be
 * perceived from the final geometry. That perception can fail, so this module
 * keeps three separate comparisons (composition, constitution, configuration)
 * and treats `inconclusive` as a real answer — never as a pass.
 *
 * The gate never fails a run by default. A block may opt into `integrity:"fail"`,
 * and only a lost/gained atom or a changed connectivity is eligible: a proton
 * transfer or an inverted centre can be the chemistry the user asked for.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const INTEGRITY_STATUSES = Object.freeze([
  'match',
  'tautomer-changed',
  'stereo-changed',
  'connectivity-changed',
  'composition-changed',
  'inconclusive',
  'not-applicable',
]);

/** Statuses that may block a run when the block opted in. */
export const INTEGRITY_BLOCKING_STATUSES = Object.freeze(['composition-changed', 'connectivity-changed']);

export const INTEGRITY_POLICIES = Object.freeze(['warn', 'fail']);

/** The reasons an answer can be `inconclusive`, and the sentence a card prints. */
export const INTEGRITY_INCONCLUSIVE_REASONS = Object.freeze({
  'perception-failed': 'RDKit could not perceive bonds from the final geometry.',
  'open-shell': 'The record is open-shell; bond perception assumes a closed shell.',
  'multi-fragment': 'The geometry has more than one fragment; identity is ambiguous.',
  'partial-geometry': 'The parsed geometry is not the whole molecule (QM region or link atoms).',
  'rdkit-missing': 'No chemistry sidecar is configured, so the final geometry could not be perceived.',
  'empty-geometry': 'The record carries no final geometry to compare.',
  'bad-response': 'The integrity answer could not be read.',
});

export function normalizeIntegrityPolicy(raw) {
  const value = raw === undefined || raw === null || raw === '' ? 'warn' : String(raw);
  if (!INTEGRITY_POLICIES.includes(value)) {
    throw new ChemError('bad-options', `integrity must be "warn" or "fail"; received ${JSON.stringify(value)}.`);
  }
  return value;
}

export function integrityRequest({ molecule, finalAtoms, policy = 'warn' } = {}) {
  if (!Array.isArray(finalAtoms) || finalAtoms.length === 0) {
    throw new ChemError('bad-input', 'An integrity request needs the final geometry atoms.');
  }
  return chemRequest({
    op: 'integrity',
    molecule,
    options: { policy: normalizeIntegrityPolicy(policy), finalAtoms },
  });
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stateOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    formula: textOrNull(source.formula),
    atomCount: numberOrNull(source.atomCount),
    heavyAtomCount: numberOrNull(source.heavyAtomCount),
    charge: numberOrNull(source.charge),
    fragments: numberOrNull(source.fragments),
    smiles: textOrNull(source.smiles),
    isomericSmiles: textOrNull(source.isomericSmiles),
    inchiKey: textOrNull(source.inchiKey),
    fixedHInchiKey: textOrNull(source.fixedHInchiKey),
    tautomerHash: textOrNull(source.tautomerHash),
    connectivityHash: textOrNull(source.connectivityHash),
  };
}

/**
 * Compare two identities in the ADR's order: composition, then connectivity,
 * then tautomer, then configuration. The first difference names the status,
 * because "a tautomer also moved a proton" must not be reported as a lost atom.
 */
export function compareStructureIdentities(before, after) {
  const a = stateOf(before);
  const b = stateOf(after);
  if (!a.formula && !b.formula) {
    return { status: 'inconclusive', reason: 'bad-response', comparisons: {} };
  }
  const composition = a.formula === b.formula
    && a.atomCount === b.atomCount
    && a.heavyAtomCount === b.heavyAtomCount;
  const connectivity = Boolean(a.connectivityHash && b.connectivityHash)
    && a.connectivityHash === b.connectivityHash;
  const constitution = Boolean(a.tautomerHash && b.tautomerHash)
    && a.tautomerHash === b.tautomerHash;
  const configuration = Boolean(a.inchiKey && b.inchiKey) && a.inchiKey === b.inchiKey;
  const comparisons = { composition, connectivity, tautomer: constitution, configuration };
  let status = 'match';
  if (!composition) status = 'composition-changed';
  else if (!connectivity) status = 'connectivity-changed';
  else if (!constitution) status = 'tautomer-changed';
  else if (!configuration) status = 'stereo-changed';
  return { status, reason: null, comparisons };
}

/**
 * Validate an `integrity` answer.
 *
 * The answer may say `inconclusive` with a reason; it may not invent a status.
 * `not-applicable` is the caller's verdict (an ONIOM record), not the sidecar's.
 */
export function normalizeIntegrityResult(raw, { policy = 'warn' } = {}) {
  const answer = normalizeChemResponse(raw, { op: 'integrity' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The integrity answer carries no result.');
  }
  const before = stateOf(result.before);
  const after = stateOf(result.after);
  let status = textOrNull(result.status) || '';
  if (!INTEGRITY_STATUSES.includes(status) || status === 'not-applicable') {
    status = 'inconclusive';
  }
  const reason = textOrNull(result.reason);
  if (status === 'inconclusive') {
    return {
      program: answer.program,
      version: answer.version,
      op: answer.op,
      policy: normalizeIntegrityPolicy(policy),
      status,
      reason: Object.keys(INTEGRITY_INCONCLUSIVE_REASONS).includes(reason) ? reason : 'bad-response',
      reasonText: INTEGRITY_INCONCLUSIVE_REASONS[reason] || INTEGRITY_INCONCLUSIVE_REASONS['bad-response'],
      before,
      after,
      origin: chemOrigin(answer, { method: 'rdDetermineBonds + identity comparison' }),
    };
  }
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    policy: normalizeIntegrityPolicy(policy),
    status,
    reason: null,
    reasonText: null,
    before,
    after,
    comparisons: result.comparisons && typeof result.comparisons === 'object' ? {
      composition: result.comparisons.composition === true,
      connectivity: result.comparisons.connectivity === true,
      tautomer: result.comparisons.tautomer === true,
      configuration: result.comparisons.configuration === true,
    } : {},
    origin: chemOrigin(answer, { method: 'rdDetermineBonds + identity comparison' }),
  };
}

/** The validity verdict: only an opted-in block can block, and only on two statuses. */
export function integrityVerdict(integrity) {
  if (!integrity || typeof integrity !== 'object') {
    return { status: 'unknown', blocking: false, message: '' };
  }
  if (integrity.status === 'not-applicable') {
    return { status: 'pass', blocking: false, message: 'Structure integrity is not applicable to this record.' };
  }
  if (integrity.status === 'inconclusive') {
    return {
      status: 'warning',
      blocking: false,
      message: `Structure integrity is inconclusive: ${integrity.reasonText || 'the sidecar gave no reason'}. Not a pass.`,
    };
  }
  if (integrity.status === 'match') {
    return { status: 'pass', blocking: false, message: 'The final geometry has the same composition, connectivity and configuration.' };
  }
  const blocking = integrity.policy === 'fail' && INTEGRITY_BLOCKING_STATUSES.includes(integrity.status);
  return {
    status: blocking ? 'fail' : 'warning',
    blocking,
    message: `Structure integrity: ${integrity.status}. ${integrity.policy === 'fail' ? 'The block asked for refusal on this status.' : 'Recorded as a warning; the run is not refused.'}`,
  };
}

/** One line for a card, report summary and validity row. */
export function integritySummary(integrity) {
  if (!integrity || typeof integrity !== 'object') return '';
  if (integrity.status === 'inconclusive') {
    return `inconclusive · ${integrity.reasonText || 'no reason given'}`;
  }
  if (integrity.status === 'not-applicable') return 'not applicable';
  if (integrity.status === 'match') {
    return `match · ${integrity.after?.formula || 'formula not reported'}`;
  }
  const before = integrity.before?.formula || '?';
  const after = integrity.after?.formula || '?';
  return `${integrity.status} · ${before} → ${after}`;
}
