/**
 * ADR 0003 §2.1–§2.4 — the `nodechem-chem/1` wire contract.
 *
 * One protocol for every chemistry op. This module owns the request shape, the
 * molecule normalisation, the refusal vocabulary and the response envelope, so
 * no op can invent a second wire. It is pure: no filesystem, no child process,
 * no DOM. Per-op result shapes live in their own modules (`chemDescriptors.js`,
 * `chemStandardize.js`, …).
 *
 * A sidecar refusal is a typed answer, never an empty success: the queue records
 * the code and the sentence, and no op may substitute a fallback geometry, an
 * empty table or a silently dropped fragment.
 */

export const CHEM_PROTOCOL = 'nodechem-chem/1';

/**
 * Every op the protocol admits. `CHEM_IMPLEMENTED_OPS` names the ones this
 * build can actually run; a request for any other op is refused here, before a
 * process is spawned, so a half-built phase cannot look like a missing RDKit.
 */
export const CHEM_OPS = Object.freeze([
  'probe',
  'descriptors',
  'standardize',
  'embed3d',
  'conformers',
  'stereoisomers',
  'integrity',
  'depict',
  'similarity',
]);

export const CHEM_IMPLEMENTED_OPS = Object.freeze([
  'probe',
  'descriptors',
  'standardize',
]);

/** The sidecar's own atom ceiling, repeated here so this module imports nothing. */
export const MAX_CHEM_ATOMS = 1000;

/** A refusal with a machine-readable code; the queue records both halves. */
export class ChemError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ChemError';
    this.code = String(code || 'chem-failed');
    this.detail = detail === null ? null : String(detail);
  }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number);
}

/**
 * One molecule on the wire: a title, a charge and multiplicity, explicit atoms
 * and optionally a SMILES. The sidecar builds from the SMILES when one is given
 * and otherwise perceives bonds from the geometry, exactly as the tautomer
 * script does.
 */
export function normalizeChemMolecule(raw, { path = 'molecule', required = true } = {}) {
  if (!raw || typeof raw !== 'object') {
    if (!required && (raw === undefined || raw === null)) return null;
    throw new ChemError('bad-molecule', `${path} must be one object carrying atoms.`);
  }
  const atoms = raw.atoms;
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new ChemError('bad-molecule', `${path} carries no atoms.`);
  }
  if (atoms.length > MAX_CHEM_ATOMS) {
    throw new ChemError('bad-molecule', `${path} has ${atoms.length} atoms; the limit is ${MAX_CHEM_ATOMS}.`);
  }
  const normalizedAtoms = atoms.map((atom, index) => {
    if (!atom || typeof atom.element !== 'string' || atom.element.trim() === '') {
      throw new ChemError('bad-molecule', `${path}, atom ${index + 1}: no element symbol.`);
    }
    if (!finite(atom.x) || !finite(atom.y) || !finite(atom.z)) {
      throw new ChemError('bad-molecule', `${path}, atom ${index + 1}: non-finite coordinate.`);
    }
    return {
      element: atom.element.trim(),
      x: Number(atom.x),
      y: Number(atom.y),
      z: Number(atom.z),
    };
  });
  const charge = raw.charge === undefined ? 0 : Number(raw.charge);
  if (!Number.isInteger(charge) || Math.abs(charge) > 10) {
    throw new ChemError('bad-molecule', `${path}.charge must be an integer between -10 and 10.`);
  }
  const multiplicity = raw.multiplicity === undefined ? 1 : Number(raw.multiplicity);
  if (!Number.isInteger(multiplicity) || multiplicity < 1 || multiplicity > 10) {
    throw new ChemError('bad-molecule', `${path}.multiplicity must be an integer between 1 and 10.`);
  }
  const smiles = raw.smiles === undefined || raw.smiles === null ? '' : String(raw.smiles).trim();
  return {
    title: String(raw.title || ''),
    charge,
    multiplicity,
    atoms: normalizedAtoms,
    smiles,
  };
}

/**
 * The JSON object the runner writes to the sidecar's stdin.
 *
 * `options` is op-specific and validated by the op's module; here it only has
 * to be a plain object. `probe` needs no molecule.
 */
export function chemRequest({ op, molecule = null, options = null } = {}) {
  const name = String(op || '').trim();
  if (!CHEM_OPS.includes(name)) {
    throw new ChemError('bad-op', `"${name || 'unstated'}" is not a chemistry op this protocol admits.`);
  }
  if (!CHEM_IMPLEMENTED_OPS.includes(name)) {
    throw new ChemError(
      'op-not-implemented',
      `The "${name}" op is not implemented in this build; it offers ${CHEM_IMPLEMENTED_OPS.join(', ')}.`,
    );
  }
  if (options !== null && (typeof options !== 'object' || Array.isArray(options))) {
    throw new ChemError('bad-options', 'options must be one object.');
  }
  const request = { protocol: CHEM_PROTOCOL, op: name };
  if (name !== 'probe') {
    request.molecule = normalizeChemMolecule(molecule);
  } else if (molecule) {
    request.molecule = normalizeChemMolecule(molecule, { required: false });
  }
  request.options = options && typeof options === 'object' ? options : {};
  return request;
}

/** The probe request: no molecule, no options, one answer with capability flags. */
export function probeRequest() {
  return { protocol: CHEM_PROTOCOL, op: 'probe', options: {} };
}

/**
 * Validate the sidecar's answer. Every failure here is loud: a protocol
 * mismatch, a refusal for another op, or an answer that is neither ok nor a
 * refusal is a `ChemError`, never a value the caller can mistake for a result.
 */
export function normalizeChemResponse(raw, { op } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new ChemError('bad-response', 'The chemistry sidecar did not return a JSON object.');
  }
  if (raw.protocol !== CHEM_PROTOCOL) {
    throw new ChemError(
      'protocol-mismatch',
      `The chemistry sidecar answered protocol "${String(raw.protocol ?? '')}"; this build speaks ${CHEM_PROTOCOL}.`,
    );
  }
  const expected = String(op || '').trim();
  if (expected && String(raw.op || '') !== expected) {
    throw new ChemError(
      'bad-response',
      `The chemistry sidecar answered op "${String(raw.op ?? '')}" for a "${expected}" request.`,
    );
  }
  if (raw.ok === false) {
    const code = String(raw.error?.code || 'op-failed');
    const message = String(raw.error?.message || 'The chemistry sidecar refused the request.');
    throw new ChemError(code, message, raw.error?.detail ?? null);
  }
  if (raw.ok !== true) {
    throw new ChemError('bad-response', 'The chemistry sidecar answer is neither ok nor a refusal.');
  }
  const program = String(raw.program || '').trim();
  if (!program) {
    throw new ChemError('bad-response', 'The chemistry sidecar did not name the program that produced the answer.');
  }
  return {
    program,
    // A source build reports no distribution; "unreported" is an honest version.
    version: String(raw.version ?? '').trim() || 'unreported',
    op: String(raw.op || expected),
    options: raw.options && typeof raw.options === 'object' ? raw.options : null,
    capabilities: raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : null,
    cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : null,
    result: raw.result && typeof raw.result === 'object' ? raw.result : null,
  };
}

/**
 * The `origin` every chemistry record carries. `method` is the op-specific
 * sentence ("TautomerEnumerator · rdkit-default", "ETKDGv4 + MMFF94"); the
 * protocol and op are always present so a reader can reproduce the call.
 */
export function chemOrigin(result, { method = '', sourceSha256 = '', extra = null } = {}) {
  return {
    program: result?.program || 'RDKit',
    version: result?.version || 'unreported',
    method: String(method || result?.op || ''),
    op: String(result?.op || ''),
    protocol: CHEM_PROTOCOL,
    sourceSha256: String(sourceSha256 || ''),
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}
