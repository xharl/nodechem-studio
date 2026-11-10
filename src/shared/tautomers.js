/**
 * Tautomer / protomer enumeration (issue #226).
 *
 * ADR 0001 left tautomers as an open question — `generate` with
 * `produces: "conformers" | "tautomers"`. This module is the shared half of
 * that answer: the sidecar protocol, the one place its JSON is validated, and
 * the ensemble summary a tautomer block writes.
 *
 * It is deliberately *not* `conformers.js`. A tautomer candidate is a
 * different molecule, not a different geometry of the same one, so:
 *
 *   - no energy window and no RMSD prune: those would delete candidates the
 *     question is about;
 *   - no Boltzmann population and no ensemble average: a tautomer distribution
 *     is a chemical equilibrium this app does not model, and the ADR forbids
 *     averaging across distinct molecules;
 *   - the spread is reported at the *target* level, from the calculate runs
 *     the candidates fan out into, never from a force field.
 *
 * Pure: no filesystem, no child process, no DOM. The runner feeds it JSON.
 */

/** The wire protocol this build speaks. A sidecar that answers another one is refused. */
export const TAUTOMER_PROTOCOL = 'nodechem-tautomers/1';

/** The only program role that enumerates tautomers here. Open Babel has no tautomer enumerator. */
export const TAUTOMER_GENERATOR = 'rdkit';

/**
 * The ruleset id recorded in `origin.ruleset`. RDKit's `TautomerEnumerator`
 * ships one transform set; naming it lets a second ruleset (or a pinned older
 * one) appear later without any stored file changing meaning.
 */
export const TAUTOMER_RULESETS = Object.freeze(['rdkit-default']);
export const DEFAULT_TAUTOMER_RULESET = 'rdkit-default';

/**
 * Options sent to the sidecar and echoed back into `origin.options`. The pH is
 * absent on purpose: protonation-state enumeration (Epik, Dimorphite-DL) is
 * out of scope, and a `pH` field would promise it.
 */
export const DEFAULT_TAUTOMER_OPTIONS = Object.freeze({
  ruleset: DEFAULT_TAUTOMER_RULESET,
  maxCandidates: 16,
  maxTransforms: 1000,
  relaxGeometry: true,
  removeSp3Stereo: false,
  removeBondStereo: false,
});

/** A candidate label is a short token: it is printed in titles and table rows. */
const TAUTOMER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
/** The schema's atom ceiling, repeated here so this module imports nothing. */
const MAX_ATOMS = 200;
const MAX_CANDIDATES = 200;

/** A refusal with a machine-readable code; the queue records both halves. */
export class TautomerEnumerationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'TautomerEnumerationError';
    this.code = String(code || 'tautomer-failed');
    this.detail = detail === null ? null : String(detail);
  }
}

/** Normalise one option set, filling defaults and refusing an unknown ruleset. */
export function normalizeTautomerOptions(raw) {
  const provided = raw && typeof raw === 'object' ? raw : {};
  const ruleset = String(provided.ruleset ?? DEFAULT_TAUTOMER_OPTIONS.ruleset);
  if (!TAUTOMER_RULESETS.includes(ruleset)) {
    throw new TautomerEnumerationError(
      'unknown-ruleset',
      `Ruleset "${ruleset}" is not implemented; this build offers ${TAUTOMER_RULESETS.join(', ')}.`,
    );
  }
  const integer = (key, min, max) => {
    const value = provided[key] === undefined ? DEFAULT_TAUTOMER_OPTIONS[key] : Number(provided[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TautomerEnumerationError('bad-options', `Option ${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const flag = (key) => {
    const value = provided[key] === undefined ? DEFAULT_TAUTOMER_OPTIONS[key] : provided[key];
    if (typeof value !== 'boolean') {
      throw new TautomerEnumerationError('bad-options', `Option ${key} must be true or false.`);
    }
    return value;
  };
  return {
    ruleset,
    maxCandidates: integer('maxCandidates', 1, MAX_CANDIDATES),
    maxTransforms: integer('maxTransforms', 1, 100000),
    relaxGeometry: flag('relaxGeometry'),
    removeSp3Stereo: flag('removeSp3Stereo'),
    removeBondStereo: flag('removeBondStereo'),
  };
}

/** The JSON object the runner writes to the sidecar's stdin. */
export function tautomerRequest({
  title = '',
  charge = 0,
  multiplicity = 1,
  atoms = [],
  options = null,
} = {}) {
  const normalized = normalizeTautomerOptions(options);
  const list = Array.isArray(atoms) ? atoms : [];
  if (list.length === 0) throw new TautomerEnumerationError('no-atoms', 'The tautomer request has no atoms.');
  if (list.length > MAX_ATOMS) {
    throw new TautomerEnumerationError('too-many-atoms', `The tautomer request has ${list.length} atoms; the limit is ${MAX_ATOMS}.`);
  }
  return {
    protocol: TAUTOMER_PROTOCOL,
    title: String(title || ''),
    charge: Number.isInteger(Number(charge)) ? Number(charge) : 0,
    multiplicity: Number.isInteger(Number(multiplicity)) ? Number(multiplicity) : 1,
    atoms: list.map((atom) => ({
      element: String(atom.element),
      x: Number(atom.x),
      y: Number(atom.y),
      z: Number(atom.z),
    })),
    options: normalized,
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number);
}

function readAtoms(candidate, index) {
  const atoms = candidate?.atoms;
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new TautomerEnumerationError('bad-candidate', `Candidate ${index + 1} carries no atoms.`);
  }
  if (atoms.length > MAX_ATOMS) {
    throw new TautomerEnumerationError('bad-candidate', `Candidate ${index + 1} has ${atoms.length} atoms; the limit is ${MAX_ATOMS}.`);
  }
  return atoms.map((atom, atomIndex) => {
    if (!atom || typeof atom.element !== 'string' || atom.element.trim() === '') {
      throw new TautomerEnumerationError('bad-candidate', `Candidate ${index + 1}, atom ${atomIndex + 1}: no element symbol.`);
    }
    if (!finite(atom.x) || !finite(atom.y) || !finite(atom.z)) {
      throw new TautomerEnumerationError('bad-candidate', `Candidate ${index + 1}, atom ${atomIndex + 1}: non-finite coordinate.`);
    }
    return { element: atom.element.trim(), x: Number(atom.x), y: Number(atom.y), z: Number(atom.z) };
  });
}

/**
 * Validate the sidecar's answer.
 *
 * Every failure here is loud: an enumeration that produced nothing, spoke
 * another protocol, or returned candidates that cannot be told apart is a
 * refusal, never an empty ensemble that the block could pass off as "the input
 * is the only tautomer".
 */
export function normalizeTautomerResponse(raw, { maxCandidates = DEFAULT_TAUTOMER_OPTIONS.maxCandidates } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new TautomerEnumerationError('bad-response', 'The tautomer sidecar did not return a JSON object.');
  }
  if (raw.protocol !== TAUTOMER_PROTOCOL) {
    throw new TautomerEnumerationError(
      'protocol-mismatch',
      `The tautomer sidecar answered protocol "${String(raw.protocol ?? '')}"; this build speaks ${TAUTOMER_PROTOCOL}.`,
    );
  }
  if (raw.ok === false) {
    const code = String(raw.error?.code || 'sidecar-refused');
    const message = String(raw.error?.message || 'The tautomer sidecar refused the request.');
    throw new TautomerEnumerationError(code, message, raw.error?.detail ?? null);
  }
  if (raw.ok !== true) {
    throw new TautomerEnumerationError('bad-response', 'The tautomer sidecar answer is neither ok nor a refusal.');
  }
  const ruleset = String(raw.ruleset ?? '');
  if (!TAUTOMER_RULESETS.includes(ruleset)) {
    throw new TautomerEnumerationError(
      'unknown-ruleset',
      `The sidecar used ruleset "${ruleset || 'unstated'}", which this build cannot reproduce; it offers ${TAUTOMER_RULESETS.join(', ')}.`,
    );
  }
  const candidates = raw.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TautomerEnumerationError(
      'no-candidates',
      'The tautomer sidecar returned zero candidates. A structure with one tautomer still returns that structure; '
      + 'an empty set means the enumeration failed, so it is refused rather than replaced by the input geometry.',
    );
  }
  if (candidates.length > Math.min(maxCandidates, MAX_CANDIDATES)) {
    throw new TautomerEnumerationError(
      'cap-exceeded',
      `The tautomer sidecar returned ${candidates.length} candidates against a cap of ${maxCandidates}; `
      + 'refusing rather than truncating a set whose order is the enumerator\'s.',
    );
  }
  const labels = new Set();
  const smilesSeen = new Set();
  const normalized = candidates.map((candidate, index) => {
    const label = String(candidate?.label ?? candidate?.id ?? `t${index + 1}`);
    if (!TAUTOMER_LABEL.test(label)) {
      throw new TautomerEnumerationError('bad-candidate', `Candidate ${index + 1} has label "${label}", which is not a short token.`);
    }
    if (labels.has(label)) {
      throw new TautomerEnumerationError('duplicate-label', `Two tautomer candidates carry the label "${label}"; they would be indistinguishable.`);
    }
    labels.add(label);
    const smiles = String(candidate?.smiles ?? '').trim();
    // A repeated canonical SMILES is the same molecule twice: keeping both
    // would double-count it in every downstream energy table.
    if (smiles && smilesSeen.has(smiles)) {
      throw new TautomerEnumerationError('duplicate-candidate', `Two tautomer candidates are the same molecule (${smiles}).`);
    }
    if (smiles) smilesSeen.add(smiles);
    return {
      label,
      rank: index + 1,
      smiles,
      formula: String(candidate?.formula ?? '').trim(),
      atoms: readAtoms(candidate, index),
      geometry: candidate?.geometry && typeof candidate.geometry === 'object'
        ? {
          source: String(candidate.geometry.source ?? ''),
          hydrogens: String(candidate.geometry.hydrogens ?? ''),
          relaxation: String(candidate.geometry.relaxation ?? ''),
          converged: candidate.geometry.converged === true ? true
            : (candidate.geometry.converged === false ? false : null),
        }
        : null,
      notes: Array.isArray(candidate?.notes) ? candidate.notes.map((note) => String(note)).filter(Boolean).slice(0, 8) : [],
    };
  });
  const atomCounts = new Set(normalized.map((candidate) => candidate.atoms.length));
  if (atomCounts.size > 1) {
    throw new TautomerEnumerationError(
      'atom-count-mismatch',
      `The candidates do not share one atom count (${[...atomCounts].join(', ')}); tautomers of one structure must, `
      + 'so the enumerator changed the molecule rather than its tautomeric form.',
    );
  }
  return {
    program: String(raw.program || 'RDKit'),
    version: String(raw.version || '').trim(),
    ruleset,
    options: raw.options && typeof raw.options === 'object' ? raw.options : null,
    input: raw.input && typeof raw.input === 'object' ? {
      title: String(raw.input.title || ''),
      charge: Number.isInteger(Number(raw.input.charge)) ? Number(raw.input.charge) : 0,
      multiplicity: Number.isInteger(Number(raw.input.multiplicity)) ? Number(raw.input.multiplicity) : 1,
      atomCount: Number.isInteger(Number(raw.input.atomCount)) ? Number(raw.input.atomCount) : null,
      formula: String(raw.input.formula || ''),
      smiles: String(raw.input.smiles || ''),
    } : null,
    truncated: raw.truncated === true,
    candidates: normalized,
    rejected: Array.isArray(raw.rejected) ? raw.rejected.slice(0, 50).map((entry) => ({
      smiles: String(entry?.smiles || ''),
      reason: String(entry?.reason || ''),
    })) : [],
  };
}

/**
 * The `origin` a tautomer ensemble records: which enumerator ran, its version,
 * the ruleset and every option that changes the set. `method` keeps the shape
 * the rest of the app reads; `ruleset`/`options`/`protocol` are the extra
 * facts a reader needs to reproduce the set, and they are absent from every
 * non-tautomer origin so older files keep their bytes.
 */
export function tautomerOrigin(result, { sourceSha256 = '' } = {}) {
  return {
    program: result.program || 'RDKit',
    version: result.version || '',
    method: `TautomerEnumerator · ${result.ruleset}`,
    sourceSha256: String(sourceSha256 || ''),
    ruleset: result.ruleset,
    protocol: TAUTOMER_PROTOCOL,
    options: {
      maxCandidates: Number(result.options?.maxCandidates ?? DEFAULT_TAUTOMER_OPTIONS.maxCandidates),
      maxTransforms: Number(result.options?.maxTransforms ?? DEFAULT_TAUTOMER_OPTIONS.maxTransforms),
      relaxGeometry: result.options?.relaxGeometry !== false,
      removeSp3Stereo: result.options?.removeSp3Stereo === true,
      removeBondStereo: result.options?.removeBondStereo === true,
    },
  };
}

/** The label a member prints: its tautomer id, or the protomer label it inherited. */
export function tautomerMemberLabel(member) {
  return String(member?.tautomer || member?.protomer || '').trim();
}

/**
 * The ensemble a tautomer block stores.
 *
 * Shaped like a conformer summary — same keys, same member rows — because the
 * queue, the fan-out and the report read one ensemble contract. What differs
 * is what it claims: `produces: "tautomers"`, no energies, no populations, no
 * pruning, and one warning that says so.
 */
export function tautomerSummary({
  result,
  group = '',
  selectedId = '',
  sourceSha256 = '',
} = {}) {
  const origin = tautomerOrigin(result, { sourceSha256 });
  const wanted = /^c\d+$/.test(String(selectedId || '')) ? String(selectedId) : '';
  const members = result.candidates.map((candidate, index) => ({
    id: `c${index + 1}`,
    rank: candidate.rank,
    tautomer: candidate.label,
    smiles: candidate.smiles,
    formula: candidate.formula,
    // A tautomer candidate arrives without an energy. Leaving the field null is
    // the honest answer: a force-field number here would invite comparing it
    // with the target-level energies the fan-out produces.
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
  const selected = members.find((member) => member.id === wanted)
    || (members.length === 1 ? members[0] : null);
  const warnings = [{
    id: 'tautomer-distinct-molecules',
    status: 'warn',
    message: 'These are tautomer candidates: distinct molecules, not conformers. No energy window or RMSD '
      + 'prune was applied and no Boltzmann population is reported; each candidate is meant to be run as its '
      + 'own calculation and compared at that level.',
  }];
  if (result.truncated) {
    warnings.push({
      id: 'tautomer-truncated',
      status: 'warn',
      message: `RDKit's enumerator reached the ${origin.options.maxCandidates}-candidate cap, so the set is `
        + 'truncated: more tautomers exist than are listed. Raise the candidate cap to see them.',
    });
  }
  if (result.rejected.length > 0) {
    warnings.push({
      id: 'tautomer-rejected',
      status: 'warn',
      message: `${result.rejected.length} enumerated form(s) were dropped as duplicates of an earlier candidate.`,
    });
  }
  return {
    generator: TAUTOMER_GENERATOR,
    produces: 'tautomers',
    // No xTB method applies: a tautomer set is not a conformer search.
    method: '',
    energyUnit: 'hartree',
    energyMethod: '',
    mixedEnergies: false,
    origin,
    group,
    count: members.length,
    total: members.length,
    // The generate stage has no energies, so it has no spread. The report
    // computes the spread across the candidates' target-level runs.
    spreadKcal: null,
    pruned: { energy: 0, rmsd: 0, count: 0 },
    warnings,
    // A single run needs an explicit choice; a fanned-out one compares the set.
    requiresSelection: members.length > 1 && !selected,
    autoSelected: false,
    protomers: [],
    tautomers: members.map((member) => member.tautomer),
    // Provenance for a reader of conformers.json alone: the set really was
    // enumerated, and whether the enumerator's cap cut it short.
    truncated: Boolean(result.truncated),
    selectedId: selected?.id || '',
    selected: selected ? {
      id: selected.id,
      rank: selected.rank,
      tautomer: selected.tautomer,
      smiles: selected.smiles,
      energyEh: null,
      energyKcal: null,
      energyUnit: 'hartree',
      energyMethod: '',
      relativeKcal: null,
      population: null,
      protomer: '',
      atoms: selected.atoms,
    } : null,
    members,
  };
}

/**
 * The spread across a candidate set, computed from the target-level energies
 * the report already collected. Returns `{ available: false, reason }` when a
 * member has no energy: a spread over the subset that happened to finish would
 * understate it.
 */
export function tautomerSpread(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) {
    return { available: false, count: list.length, kcal: null, reason: 'fewer than two candidates were run, so there is no spread to report' };
  }
  const missing = list.find((row) => !Number.isFinite(row?.energyHartree));
  if (missing) {
    return {
      available: false,
      count: list.length,
      kcal: null,
      reason: `candidate ${missing.memberId || missing.nodeId || ''} has no final energy, so the spread is not reported`,
    };
  }
  const energies = list.map((row) => Number(row.energyHartree));
  const lowest = Math.min(...energies);
  const highest = Math.max(...energies);
  const lowRow = list[energies.indexOf(lowest)];
  const highRow = list[energies.indexOf(highest)];
  return {
    available: true,
    count: list.length,
    kcal: (highest - lowest) * 627.5094740631,
    lowestMemberId: String(lowRow?.memberId || ''),
    highestMemberId: String(highRow?.memberId || ''),
    reason: null,
  };
}
