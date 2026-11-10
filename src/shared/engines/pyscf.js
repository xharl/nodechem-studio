/**
 * PySCF engine: a fixed Python deck, a machine-readable result record, the
 * parser for that record, the capability table and every refusal this build
 * can name.
 *
 * PySCF is the second engine in the app whose input is **code** (a Python
 * program), and the first whose output is a **record**, not a log. That makes
 * the honest contract different from Psi4's:
 *
 * - The deck is one reviewed script (`./pyscfDeck.js`). Molecule, method,
 *   basis, solvation and active-space settings travel as one base64-encoded
 *   JSON document, decoded at run time. No project field is interpolated as a
 *   statement; a title containing a quote or `import os` stays a string.
 * - The script writes `{"schema": "nodechem.pyscf.v1", ...}` to `<deck>.json`
 *   beside itself and to stdout between `NCS-PYSCF-RESULT-BEGIN` /
 *   `NCS-PYSCF-RESULT-END`. The parser reads that record; PySCF's own text is a
 *   fallback for a user-supplied log only.
 * - Every method, basis, job type, solvation model, solvent, active-space
 *   request and feature this build cannot spell is refused by name. Nothing is
 *   silently downgraded: TD-DFT, periodic (`pyscf.pbc`), relativistic, QM/MM,
 *   GPU and NMR are named in `PYSCF_CAPABILITIES.unsupportedFeatures` and in
 *   `pyscfSettingsOffenders()`.
 *
 * Verified against PySCF 2.15.0 for the recorded fixtures under
 * `test/fixtures/pyscf/`. No PySCF binary or Python environment is bundled.
 */

import { atomicNumber, isElementSymbol } from '../elements.js';
import { canonicalResult, TERMINATION } from './canonical.js';
import { PYSCF_DATA_TOKEN, PYSCF_DECK_TEMPLATE } from './pyscfDeck.js';

export const PYSCF_ENGINE_ID = 'pyscf';

/**
 * Releases the deck and the parser were written against. A record naming a
 * different major version is still parsed (the record is schema-versioned, not
 * text-scraped), and the version is reported in `program.version`.
 */
export const PYSCF_SUPPORTED_VERSIONS = Object.freeze(['2.15']);

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.py$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const SAFE_TITLE = 200;

function oneLine(value, fallback = '') {
  return String(value ?? fallback).replace(/[\r\n\t]+/g, ' ').trim();
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return number;
}

function toNumber(token) {
  if (token === undefined || token === null) return null;
  const value = Number(String(token).replace(/[Dd]/, 'E'));
  return Number.isFinite(value) ? value : null;
}

function lastNumber(text, pattern) {
  const regex = new RegExp(pattern, 'gi');
  let match;
  let value = null;
  while ((match = regex.exec(text)) !== null) {
    const candidate = toNumber(match[1]);
    if (candidate !== null) value = candidate;
  }
  return value;
}

/* ── Method and basis tables ──────────────────────────────── */

/**
 * Methods this deck can spell. `kind` decides the job types it may carry:
 *
 * - `scf` and `dft`: HF, Opt, Freq, Opt Freq.
 * - `correlated`: SP only in v1. An MP2/CCSD gradient exists in PySCF without
 *   density fitting, but the deck runs a density-fitted reference so that its
 *   energies reproduce the Psi4 comparison; mixing the two is not a v1 path.
 * - `multiref`: CASSCF, SP only, with an explicit active space.
 */
export const PYSCF_METHODS = Object.freeze([
  { key: 'hf', label: 'HF', kind: 'scf', xc: null },
  { key: 'b3lyp', label: 'B3LYP', kind: 'dft', xc: 'b3lyp' },
  { key: 'pbe0', label: 'PBE0', kind: 'dft', xc: 'pbe0' },
  { key: 'm06-2x', label: 'M06-2X', kind: 'dft', xc: 'm06-2x' },
  { key: 'mp2', label: 'MP2', kind: 'correlated', xc: null },
  { key: 'ccsd', label: 'CCSD', kind: 'correlated', xc: null },
  { key: 'ccsd(t)', label: 'CCSD(T)', kind: 'correlated', xc: null },
  { key: 'casscf', label: 'CASSCF', kind: 'multiref', xc: null },
]);

/**
 * Bases this deck can spell. `ecp` is true for the def2 sets: PySCF loads the
 * matching ECP when a def2 basis is requested for a heavy element, and the
 * deck writes `ecp=<basis>` only then. `6-31G(d)` is PySCF's `6-31g*`.
 */
export const PYSCF_BASES = Object.freeze([
  { key: 'def2-svp', label: 'def2-SVP', pyscf: 'def2-svp', ecp: true },
  { key: 'def2-tzvp', label: 'def2-TZVP', pyscf: 'def2-tzvp', ecp: true },
  { key: 'cc-pvdz', label: 'cc-pVDZ', pyscf: 'cc-pvdz', ecp: false },
  { key: 'cc-pvtz', label: 'cc-pVTZ', pyscf: 'cc-pvtz', ecp: false },
  { key: '6-31g(d)', label: '6-31G(d)', pyscf: '6-31g*', ecp: false },
]);

export const PYSCF_JOB_TYPES = Object.freeze(['SP', 'Opt', 'Freq', 'Opt Freq']);

export const PYSCF_UNSUPPORTED_JOB_TYPES = Object.freeze([
  'TD-DFT', 'Opt=TS', 'IRC', 'Scan', 'NMR', 'Opt=QST2', 'Opt=QST3',
]);

/** PySCF PCM models this deck writes. `PCM` maps to IEF-PCM, `C-PCM` to C-PCM. */
export const PYSCF_SOLVATION_MODELS = Object.freeze(['PCM', 'C-PCM']);

/**
 * App solvent label → the name PySCF's `solvent.PCM` accepts. Every name was
 * checked against PySCF 2.15.0's `pyscf.solvent.solvent` table; a label absent
 * here is refused by name. The labels match the ones the other engines use.
 */
export const PYSCF_SOLVENTS = Object.freeze({
  Water: 'water',
  Dichloromethane: 'dichloromethane',
  THF: 'tetrahydrofuran',
  Toluene: 'toluene',
  Acetonitrile: 'acetonitrile',
  Methanol: 'methanol',
  Ethanol: 'ethanol',
  Chloroform: 'chloroform',
  Acetone: 'acetone',
  DMSO: 'dimethylsulfoxide',
});

const METHOD_BY_KEY = new Map(PYSCF_METHODS.map((entry) => [entry.key, entry]));
const METHOD_BY_LABEL = new Map(PYSCF_METHODS.map((entry) => [entry.label.toLowerCase(), entry]));
const BASIS_BY_KEY = new Map(PYSCF_BASES.map((entry) => [entry.key, entry]));
const BASIS_BY_LABEL = new Map(PYSCF_BASES.map((entry) => [entry.label.toLowerCase(), entry]));
const BASIS_BY_PYSCF = new Map(PYSCF_BASES.map((entry) => [entry.pyscf.toLowerCase(), entry]));
const SOLVENT_BY_LABEL = new Map(Object.entries(PYSCF_SOLVENTS).map(([label, name]) => [label.toLowerCase(), { label, name }]));
const MODEL_BY_KEY = new Map(PYSCF_SOLVATION_MODELS.map((model) => [model.toLowerCase(), model]));

/**
 * The PySCF release the recorded fixtures were produced with. The deck does not
 * pin a version; it records whatever interpreter it ran under.
 */
export const PYSCF_FIXTURE_VERSION = '2.15.0';

/* ── Capabilities ─────────────────────────────────────────── */

export const PYSCF_CAPABILITIES = Object.freeze({
  id: PYSCF_ENGINE_ID,
  label: 'PySCF',
  inputExtension: '.py',
  outputExtension: '.out',
  /**
   * The deck prints its JSON record to stdout; the runner captures the stream
   * and also keeps the `<deck>.json` file the deck writes beside itself.
   */
  capturesStdout: true,
  writesOptimisedGeometryTo: null,
  restartArtifact: null,
  exitCodes: Object.freeze({ success: 0 }),
  methods: PYSCF_METHODS,
  basisSets: PYSCF_BASES,
  dispersionSchemes: Object.freeze([]),
  solvationModels: PYSCF_SOLVATION_MODELS,
  solvents: PYSCF_SOLVENTS,
  solvation: Object.freeze({
    provider: 'pyscf-pcm',
    models: PYSCF_SOLVATION_MODELS,
    jobTypes: Object.freeze(['SP']),
    /**
     * PySCF's PCM is a dielectric continuum on a surface of spheres. `PCM` is
     * IEF-PCM and `C-PCM` is the conductor-like model; neither is SMD, COSMO
     * or a solvation free energy.
     */
    quantity: 'electronic energy of the solvated wavefunction, not a solvation free energy',
    requires: 'pyscf (pip install pyscf); the deck imports pyscf.solvent',
  }),
  jobTypes: PYSCF_JOB_TYPES,
  unsupportedJobTypes: PYSCF_UNSUPPORTED_JOB_TYPES,
  unsupportedFeatures: Object.freeze([
    'TD-DFT and every excited-state job (PySCF has TDSCF, but this deck does not write it)',
    'periodic calculations (pyscf.pbc)',
    'relativistic Hamiltonians and spin-orbit coupling (X2C, DKH, ZORA)',
    'QM/MM embedding',
    'GPU execution (pyscf.gpu / cupy)',
    'NMR shieldings and spin-spin couplings',
    'transition-state search, IRC and relaxed scans',
    'optimisation and frequencies for MP2, CCSD, CCSD(T) and CASSCF (SP only in v1)',
    'frequencies at MP2, CCSD, CCSD(T) and CASSCF (HF/DFT Hessians only in v1)',
    'CCSD(T) Hessians (no analytic Hessian exists)',
    'solvation on Opt, Freq and Opt Freq (a solvated block is a single point)',
    'solvation with MP2/CCSD/CCSD(T) (the correlation step would have no solvent response)',
    'separate dispersion corrections (PySCF functionals here carry their own; no D3 keyword is written)',
    'Gaussian-style checkpoints and route keywords',
    'NBO populations and EPR g-tensors',
  ]),
  epr: Object.freeze({
    spinPopulations: false,
    hyperfine: false,
    gTensor: false,
    gTensorReason: 'PySCF g-tensors need a relativistic treatment this deck does not write; ORCA is not installed',
  }),
});

/* ── Settings resolution and refusals ─────────────────────── */

function jobTypeOf(settings = {}) {
  return oneLine(settings.jobType, 'SP') || 'SP';
}

export function pyscfMethodFor(settings = {}) {
  const key = oneLine(settings.method, 'b3lyp').toLowerCase().replace(/\s+/g, '');
  const method = METHOD_BY_KEY.get(key) || METHOD_BY_LABEL.get(key);
  if (!method) {
    throw new Error(`PySCF cannot run method "${oneLine(settings.method)}". Supported: `
      + `${PYSCF_METHODS.map((entry) => entry.label).join(', ')}.`);
  }
  return method;
}

export function pyscfBasisFor(settings = {}) {
  const key = oneLine(settings.basis, 'def2-svp').toLowerCase();
  const basis = BASIS_BY_KEY.get(key) || BASIS_BY_LABEL.get(key) || BASIS_BY_PYSCF.get(key);
  if (!basis) {
    throw new Error(`PySCF cannot run basis "${oneLine(settings.basis)}". Supported: `
      + `${PYSCF_BASES.map((entry) => entry.label).join(', ')}.`);
  }
  return basis;
}

/**
 * The explicit active space, or null when the block does not name one.
 *
 * The stored form is `"electrons,orbitals"` — the order used by CAS(e,o) and
 * by this app's inspector. A malformed value is refused with the field named,
 * never rounded into a different active space.
 */
export function pyscfActiveSpaceFor(settings = {}) {
  const raw = oneLine(settings.pyscfActiveSpace);
  if (!raw) return null;
  const match = /^(\d{1,2})\s*,\s*(\d{1,2})$/.exec(raw);
  if (!match) {
    throw new Error('PySCF active space must be written as electrons,orbitals '
      + `(for example 6,6 for CAS(6,6)); "${raw}" is not that form.`);
  }
  const electrons = Number(match[1]);
  const orbitals = Number(match[2]);
  if (electrons < 1 || orbitals < 1) {
    throw new Error('PySCF active space needs at least one electron and one orbital.');
  }
  if (electrons > 2 * orbitals) {
    throw new Error(`PySCF active space ${electrons},${orbitals} is impossible: `
      + `${orbitals} orbitals hold at most ${2 * orbitals} electrons.`);
  }
  if (orbitals > 20) {
    throw new Error('PySCF active space is capped at 20 orbitals in this build; '
      + 'a larger CASSCF is a different calculation, not a bigger v1 block.');
  }
  return { electrons, orbitals };
}

function solvationRequested(settings = {}) {
  const raw = settings.solvation;
  return raw === true
    || (typeof raw === 'string'
      && raw.trim() !== ''
      && !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase()));
}

/**
 * The PCM request, or null when the block asks for no solvent.
 *
 * Throws with `field` set, so preflight, the builder and the inspector refuse
 * with the same sentence.
 */
export function pyscfSolvationFor(settings = {}) {
  if (!solvationRequested(settings)) return null;
  const fail = (field, message) => {
    const error = new Error(message);
    error.field = field;
    throw error;
  };
  const rawModel = oneLine(settings.solvationModel, 'PCM').toUpperCase();
  if (rawModel === 'SMD' || rawModel === 'CPCM' || rawModel === 'COSMO') {
    fail('solvationModel',
      `PySCF writes PCM (IEF-PCM) and C-PCM only; "${rawModel}" is not one of them. `
      + 'Choose PCM or C-PCM.');
  }
  const model = MODEL_BY_KEY.get(rawModel.toLowerCase());
  if (!model) {
    fail('solvationModel',
      `PySCF solvation models: ${PYSCF_SOLVATION_MODELS.join(', ')}. `
      + `"${oneLine(settings.solvationModel)}" is not one of them.`);
  }
  const label = oneLine(settings.solvent, 'Water') || 'Water';
  const solvent = SOLVENT_BY_LABEL.get(label.toLowerCase());
  if (!solvent) {
    fail('solvent',
      `Solvent "${label}" has no PySCF name in this builder. PySCF accepts `
      + `${Object.keys(PYSCF_SOLVENTS).join(', ')}; a name it does not know is refused here `
      + 'rather than run in water.');
  }
  const jobType = jobTypeOf(settings);
  if (jobType !== 'SP') {
    fail('jobType',
      `A solvated PySCF block is a single point in this build, so it must be SP; "${jobType}" `
      + 'is refused by name rather than run without the solvent response it would need.');
  }
  const method = (() => {
    try {
      return pyscfMethodFor(settings);
    } catch {
      return null;
    }
  })();
  if (method && method.kind === 'correlated') {
    fail('solvation',
      `PySCF's PCM is applied to the SCF reference; an ${method.label} energy on top of it has `
      + 'no solvent response in this build, so the combination is refused by name.');
  }
  return { model, solvent: solvent.name, solventLabel: solvent.label };
}

/**
 * Settings a PySCF block cannot honour, each with the field and the reason.
 * A request is refused by name, never dropped.
 */
export function pyscfSettingsOffenders(settings = {}) {
  const offenders = [];
  const text = (value) => oneLine(value);
  // A boolean false or the strings "false"/"off" are not a request. `oneLine`
  // alone would read `false` as a truthy sentence.
  const set = (value) => value === true
    || (typeof value === 'string'
      && value.trim() !== ''
      && !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase()));
  const push = (field, message) => offenders.push({ field, message });

  try {
    pyscfSolvationFor(settings);
  } catch (error) {
    push(error?.field || 'solvation', String(error?.message ?? error));
  }

  const jobType = jobTypeOf(settings);
  if (PYSCF_UNSUPPORTED_JOB_TYPES.includes(jobType)) {
    push('jobType', `${jobType} is not supported for PySCF blocks in this build. `
      + `PySCF job types here: ${PYSCF_JOB_TYPES.join(', ')}.`);
  }
  if (settings.tddft === true || settings.excitedStates || set(settings.td)) {
    push('tddft', 'TD-DFT and excited states are refused by name for PySCF in this build: '
      + 'the deck writes no TDSCF step.');
  }
  if (set(settings.periodic)) {
    push('periodic', 'Periodic calculations (pyscf.pbc) are refused by name; this deck builds a molecule.');
  }
  if (set(settings.relativistic)) {
    push('relativistic', 'Relativistic Hamiltonians and spin-orbit coupling are refused by name; '
      + 'this deck writes a non-relativistic Hamiltonian.');
  }
  if (set(settings.qmmm) || set(settings.qmMm)) {
    push('qmmm', 'QM/MM embedding is refused by name; this deck has no embedding step.');
  }
  if (set(settings.gpu)) {
    push('gpu', 'GPU execution is refused by name; this deck runs the CPU PySCF path.');
  }
  if (jobType === 'NMR' || settings.nmr === true) {
    push('nmr', 'NMR shieldings and spin-spin couplings are refused by name; this deck writes no NMR step.');
  }
  if (text(settings.customKeywords)) {
    push('customKeywords', 'Custom Gaussian route keywords do not map to the PySCF deck and are not written as code.');
  }
  if (text(settings.dispersion)) {
    push('dispersion', 'PySCF takes dispersion through the functional; a separate D3/D4 keyword is not written.');
  }
  if (text(settings.grid)) {
    push('grid', 'The PySCF deck fixes its DFT grid (level 5); a Gaussian grid keyword is not mapped.');
  }
  if (text(settings.population)) {
    push('population', 'Population analysis is not written for PySCF blocks in this build.');
  }
  if (text(settings.verbosity)) {
    push('verbosity', 'Output verbosity is a Gaussian keyword; the PySCF deck prints its own record.');
  }
  if (settings.stableOpt === true) {
    push('stableOpt', 'Stable=Opt is a Gaussian keyword; PySCF has no equivalent here.');
  }
  if (settings.raman === true) push('raman', 'Raman intensities are not written for PySCF blocks.');
  if (settings.vcd === true) push('vcd', 'VCD rotational strengths are not written for PySCF blocks.');
  if (settings.orbitals === true) push('orbitals', 'Frontier-orbital descriptors are not written for PySCF blocks.');
  if (text(settings.checkpoint)) {
    push('checkpoint', 'PySCF blocks have no Gaussian checkpoint; a checkpoint file name is refused.');
  }

  let method = null;
  try {
    method = pyscfMethodFor(settings);
  } catch (error) {
    push('method', String(error?.message ?? error));
  }
  try {
    pyscfBasisFor(settings);
  } catch (error) {
    push('basis', String(error?.message ?? error));
  }

  let activeSpace = null;
  try {
    activeSpace = pyscfActiveSpaceFor(settings);
  } catch (error) {
    push('pyscfActiveSpace', String(error?.message ?? error));
  }
  if (activeSpace && method && method.key !== 'casscf') {
    push('pyscfActiveSpace', `An active space is a CASSCF setting; ${method.label} has no active space to choose.`);
  }
  if (method && method.key === 'casscf' && !activeSpace) {
    push('pyscfActiveSpace', 'CASSCF needs an explicit active space: set Active space to electrons,orbitals '
      + '(for example 2,2 for CAS(2,2)).');
  }
  if (method && method.key === 'casscf' && (jobType === 'Opt' || jobType === 'Opt Freq' || jobType === 'Freq')) {
    push('jobType', 'CASSCF is a single point in this build: Opt, Freq and Opt Freq are refused by name.');
  }
  if (method && method.kind === 'correlated'
    && (jobType === 'Opt' || jobType === 'Opt Freq' || jobType === 'Freq')) {
    push('jobType', `${method.label} is a single point in this build: Opt, Freq and Opt Freq are `
      + 'refused by name because the density-fitted reference used for the Psi4 comparison has '
      + 'no matching gradient path here.');
  }
  return offenders;
}

export function assertPyscfSettings(settings = {}) {
  const offenders = pyscfSettingsOffenders(settings);
  if (offenders.length > 0) {
    const error = new Error(offenders[0].message);
    error.field = offenders[0].field;
    throw error;
  }
}

/* ── Input builder ────────────────────────────────────────── */

/**
 * UTF-8 → base64 without depending on Node's Buffer, so the renderer can build
 * the same deck the CLI and the tests build.
 */
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64DecodeUtf8(text) {
  const binary = atob(String(text));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function coordinateLine(atom, index) {
  const element = oneLine(atom?.element);
  if (!isElementSymbol(element)) {
    throw new Error(`Atom ${index + 1} has an invalid element symbol "${element}".`);
  }
  return {
    element,
    x: finiteNumber(atom.x, `Atom ${index + 1} x`),
    y: finiteNumber(atom.y, `Atom ${index + 1} y`),
    z: finiteNumber(atom.z, `Atom ${index + 1} z`),
  };
}

function ecpRequested(basis, atoms) {
  if (!basis.ecp) return false;
  // PySCF loads an ECP for the elements that have one in the named set. Asking
  // for the def2 ECP on a molecule that has no heavy atom is harmless, but the
  // record should say whether one was actually in play.
  return atoms.some((atom) => {
    const number = atomicNumber(atom.element);
    return Number.isInteger(number) && number > 36;
  });
}

/**
 * Build one PySCF deck.
 *
 * `inputName` arrives as `.gjf` from the existing workflow planner, so the
 * extension is rewritten here; any other unsafe name is refused.
 */
export function buildPyscfInput({
  title = 'PySCF task',
  settings = {},
  molecule = {},
  inputName = 'task.py',
  oldCheckpoint = '',
} = {}) {
  assertPyscfSettings(settings);
  const requested = oneLine(inputName, 'task.py');
  const safeName = requested.replace(/\.(gjf|com|inp|dat)$/i, '.py');
  if (!SAFE_INPUT.test(safeName)) throw new Error('Input name must be a safe .py basename.');

  const method = pyscfMethodFor(settings);
  const basis = pyscfBasisFor(settings);
  const jobType = jobTypeOf(settings);
  if (!PYSCF_JOB_TYPES.includes(jobType)) {
    throw new Error(`PySCF jobs: ${PYSCF_JOB_TYPES.join(', ')}. "${jobType}" is not one of them.`);
  }
  const activeSpace = pyscfActiveSpaceFor(settings);
  const solvation = pyscfSolvationFor(settings);

  const coords = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (coords.length === 0) throw new Error('A molecule with Cartesian coordinates is required.');
  const atoms = coords.map(coordinateLine);
  const charge = Number.isInteger(Number(molecule.charge)) ? Number(molecule.charge) : 0;
  const multiplicity = Number.isInteger(Number(molecule.multiplicity)) ? Number(molecule.multiplicity) : 1;
  if (multiplicity < 1) throw new Error('Multiplicity must be a positive integer.');
  if (multiplicity > 10) throw new Error('PySCF multiplicity is capped at 10 in this build.');
  if (!Number.isInteger(charge) || charge < -10 || charge > 10) {
    throw new Error('Charge must be a whole number between -10 and 10.');
  }
  const electrons = atoms.reduce((total, atom) => total + (atomicNumber(atom.element) || 0), 0) - charge;
  if (electrons < 1) throw new Error('The charge leaves no electrons for PySCF to compute.');
  if ((electrons - (multiplicity - 1)) % 2 !== 0) {
    throw new Error(`Charge ${charge} and multiplicity ${multiplicity} leave ${electrons} electrons, `
      + 'which cannot carry that spin state.');
  }

  const reference = (() => {
    const raw = oneLine(settings.reference).toLowerCase();
    if (['rhf', 'uhf', 'rohf'].includes(raw)) return raw;
    if (raw) throw new Error(`PySCF reference must be rhf, uhf or rohf; "${oneLine(settings.reference)}" is not.`);
    if (method.key === 'casscf' && multiplicity > 1) return 'rohf';
    return multiplicity > 1 ? 'uhf' : 'rhf';
  })();

  const data = {
    schema: 'nodechem.pyscf.v1',
    title: oneLine(title, 'PySCF task').slice(0, SAFE_TITLE),
    methodKey: method.key,
    methodLabel: method.label,
    xc: method.xc,
    basisKey: basis.key,
    basisLabel: basis.label,
    basis: basis.pyscf,
    ecp: ecpRequested(basis, atoms),
    charge,
    multiplicity,
    reference,
    jobType,
    activeSpace,
    solvation: solvation
      ? { provider: 'pyscf-pcm', model: solvation.model, solvent: solvation.solvent, solventLabel: solvation.solventLabel }
      : null,
    densityFit: true,
    gridLevel: method.kind === 'dft' ? 5 : null,
    maxCycle: 100,
    convTol: 1e-10,
    maxSteps: 100,
    hessianMaxAtoms: 60,
    atoms,
  };

  if (PYSCF_DECK_TEMPLATE.split(PYSCF_DATA_TOKEN).length !== 2) {
    throw new Error('The PySCF deck template must contain exactly one data token.');
  }
  const inputText = PYSCF_DECK_TEMPLATE.replace(PYSCF_DATA_TOKEN, base64Utf8(JSON.stringify(data)));
  if (inputText.includes(PYSCF_DATA_TOKEN)) {
    throw new Error('The PySCF deck still contains an unsubstituted data token.');
  }

  return {
    engine: PYSCF_ENGINE_ID,
    inputName: safeName,
    outputName: safeName.replace(/\.py$/i, '.out'),
    inputText,
    // The runner spawns `<executable> <deck.py>`; a python interpreter receives
    // the deck path exactly as a wrapper does.
    argv: [safeName],
    route: `PySCF ${method.label}/${basis.label}${activeSpace
      ? ` CAS(${activeSpace.electrons},${activeSpace.orbitals})` : ''}${solvation
      ? ` · ${solvation.model}/${solvation.solventLabel}` : ''} ${jobType}`,
    oldCheckpoint: oneLine(oldCheckpoint) || null,
    // The decoded payload, for the preflight/record path. Never executable.
    data,
  };
}

export function isSafePyscfInputName(name) {
  return SAFE_INPUT.test(String(name));
}

export function isSafePyscfOutputName(name) {
  return SAFE_OUTPUT.test(String(name));
}

/**
 * Replace the geometry inside an already-built deck, for a geometry hand-off.
 *
 * The deck carries its data as base64 JSON on one line; this rewrites that
 * document and re-encodes it. Every other line is left byte-identical.
 */
export function replacePyscfGeometry(inputText, atoms) {
  const text = String(inputText ?? '');
  const pattern = /^_DATA = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\.decode\("utf-8"\)\)$/m;
  const match = pattern.exec(text);
  if (!match) throw new Error('The PySCF deck has no data line; the geometry cannot be replaced.');
  if (!Array.isArray(atoms) || atoms.length === 0) throw new Error('No atoms were supplied for the geometry hand-off.');
  const data = JSON.parse(base64DecodeUtf8(match[1]));
  data.atoms = atoms.map(coordinateLine);
  const encoded = base64Utf8(JSON.stringify(data));
  return text.replace(pattern, `_DATA = json.loads(base64.b64decode("${encoded}").decode("utf-8"))`);
}

/** Provenance in PySCF vocabulary, not a Gaussian route. */
export function pyscfMethodBlock(settings = {}, { argv = null, jobType = null } = {}) {
  const method = METHOD_BY_KEY.get(oneLine(settings.method, 'b3lyp').toLowerCase()) || null;
  const basis = BASIS_BY_KEY.get(oneLine(settings.basis, 'def2-svp').toLowerCase()) || null;
  let solvation = null;
  try {
    const request = pyscfSolvationFor(settings);
    if (request) solvation = `pyscf-pcm ${request.model}/${request.solventLabel}`;
  } catch {
    solvation = null;
  }
  let activeSpace = null;
  try {
    activeSpace = pyscfActiveSpaceFor(settings);
  } catch {
    activeSpace = null;
  }
  return {
    program: 'PySCF',
    method: method ? method.label : null,
    basis: basis ? basis.label : null,
    jobType: oneLine(jobType, '') || oneLine(settings.jobType, 'SP'),
    dispersion: null,
    solvation,
    scf: oneLine(settings.scf) || null,
    reference: oneLine(settings.reference) || null,
    activeSpace: activeSpace ? `CAS(${activeSpace.electrons},${activeSpace.orbitals})` : null,
    resources: {
      threads: Number.isFinite(Number(settings.nproc)) ? Number(settings.nproc) : null,
    },
    argv: Array.isArray(argv) && argv.length > 0 ? argv.map(String) : null,
  };
}

/* ── Output parser ────────────────────────────────────────── */

const RECORD_BEGIN = 'NCS-PYSCF-RESULT-BEGIN';
const RECORD_END = 'NCS-PYSCF-RESULT-END';

/**
 * The JSON record in a deck's stdout or file. The last complete block wins: a
 * deck writes one, but a concatenated capture or a re-run may carry more.
 */
export function extractPyscfRecord(text) {
  const body = String(text || '').replace(/\r\n?/g, '\n');
  let cursor = -1;
  let record = null;
  for (;;) {
    const begin = body.indexOf(RECORD_BEGIN, cursor + 1);
    if (begin === -1) break;
    const start = begin + RECORD_BEGIN.length;
    const end = body.indexOf(RECORD_END, start);
    if (end === -1) break;
    cursor = end;
    const payload = body.slice(start, end).trim();
    try {
      const candidate = JSON.parse(payload);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) record = candidate;
    } catch {
      // A truncated block is not a record; an earlier complete one still is.
    }
  }
  if (record) return record;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const candidate = JSON.parse(trimmed);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        && (candidate.schema === 'nodechem.pyscf.v1' || candidate.engine === PYSCF_ENGINE_ID)) {
        return candidate;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function recordLooksLikePyscf(record) {
  return Boolean(record && typeof record === 'object'
    && (record.schema === 'nodechem.pyscf.v1' || record.engine === PYSCF_ENGINE_ID));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function canonicalFromRecord(record, { truncated = false, lineCount = 0 } = {}) {
  const error = record.error && typeof record.error === 'object' ? record.error : null;
  const ok = record.ok === true && !error;
  const version = record.pyscfVersion ? String(record.pyscfVersion) : null;
  const jobType = record.jobType ? String(record.jobType) : null;
  const optimizationRecord = record.optimization && typeof record.optimization === 'object'
    ? record.optimization : null;
  const frequencyRecord = record.frequencies && typeof record.frequencies === 'object'
    ? record.frequencies : null;
  const frequencyValues = Array.isArray(frequencyRecord?.values)
    ? frequencyRecord.values.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
  const imaginaryValues = Array.isArray(frequencyRecord?.imaginaryValues)
    ? frequencyRecord.imaginaryValues.filter((value) => Number.isFinite(Number(value))).map(Number)
    : frequencyValues.filter((value) => value < -0.001);
  const thermochemistry = frequencyRecord?.thermochemistry && typeof frequencyRecord.thermochemistry === 'object'
    ? frequencyRecord.thermochemistry
    : (record.thermochemistry && typeof record.thermochemistry === 'object' ? record.thermochemistry : {});
  const geometry = Array.isArray(record.geometry)
    ? record.geometry.filter((atom) => atom && typeof atom.element === 'string'
      && Number.isFinite(Number(atom.x)) && Number.isFinite(Number(atom.y)) && Number.isFinite(Number(atom.z)))
      .map((atom) => ({
        element: String(atom.element), x: Number(atom.x), y: Number(atom.y), z: Number(atom.z),
      }))
    : null;
  const scfStatus = record.scfConverged === true ? 'converged'
    : record.scfConverged === false ? 'failed' : 'unknown';
  const attempted = typeof jobType === 'string' ? /^Opt/.test(jobType) : null;
  const solvation = record.solvation && typeof record.solvation === 'object'
    ? {
      provider: 'pyscf-pcm',
      model: record.solvation.model ?? null,
      solvent: record.solvation.solvent ?? null,
      solventLabel: record.solvation.solventLabel ?? null,
      jobTypes: ['SP'],
      solvatedHartree: finiteOrNull(record.energy),
      quantity: 'electronic energy of the solvated wavefunction, not a solvation free energy',
    }
    : null;

  const result = canonicalResult({
    engine: PYSCF_ENGINE_ID,
    program: { name: 'PySCF', version },
    termination: ok
      ? `PySCF ${version || ''} completed`.trim()
      : (error ? `PySCF failed in ${error.stage || 'run'}: ${error.message || error.type || 'unknown error'}`
        : 'PySCF did not report a result'),
    terminationCode: ok ? TERMINATION.NORMAL : TERMINATION.ERROR,
    complete: !truncated,
    scf: {
      status: scfStatus,
      energyHartree: finiteOrNull(record.scfEnergy),
      cycles: integerOrNull(record.nIter),
      method: record.method ? String(record.method) : null,
      applicable: true,
    },
    optimization: {
      completed: optimizationRecord?.converged === true,
      stationary: optimizationRecord?.converged === true,
      cycles: Number.isInteger(Number(optimizationRecord?.cycles)) ? Number(optimizationRecord.cycles) : null,
      attempted,
    },
    frequencies: {
      count: frequencyValues.length,
      imaginaryCount: imaginaryValues.length,
      imaginaryValues,
      minImaginary: imaginaryValues.length > 0 ? Math.min(...imaginaryValues) : null,
    },
    thermochemistry: {
      zpeHartree: finiteOrNull(thermochemistry.zpeHartree),
      enthalpyHartree: finiteOrNull(thermochemistry.enthalpyHartree),
      freeEnergyHartree: finiteOrNull(thermochemistry.freeEnergyHartree),
    },
    finalEnergy: {
      hartree: finiteOrNull(record.energy),
      source: record.methodKey ? String(record.methodKey) : (ok ? 'pyscf' : 'error'),
    },
    solvation,
    extras: {
      method: record.method ?? null,
      methodKey: record.methodKey ?? null,
      basis: record.basis ?? null,
      basisKey: record.basisKey ?? null,
      reference: record.reference ?? null,
      charge: integerOrNull(record.charge),
      multiplicity: integerOrNull(record.multiplicity),
      jobType,
      finalGeometry: geometry,
      moEnergies: Array.isArray(record.moEnergies)
        ? record.moEnergies.filter((value) => Number.isFinite(Number(value))).map(Number) : null,
      nBasis: integerOrNull(record.nBasis),
      pyscfVersion: version,
      densityFit: record.densityFit === true,
      ecp: record.ecp === true,
      activeSpace: record.activeSpace && typeof record.activeSpace === 'object' ? record.activeSpace : null,
      correlationEnergy: finiteOrNull(record.correlationEnergy),
      triplesCorrection: finiteOrNull(record.triplesCorrection),
      frequencyValues,
      hessian: Array.isArray(frequencyRecord?.hessian) ? frequencyRecord.hessian
        : (Array.isArray(record.hessian) ? record.hessian : null),
      hessianShape: Array.isArray(frequencyRecord?.hessianShape) ? frequencyRecord.hessianShape
        : (Array.isArray(record.hessianShape) ? record.hessianShape : null),
      hessianOmitted: record.hessianOmitted === true,
      thermochemistry: thermochemistry && Object.keys(thermochemistry).length > 0 ? thermochemistry : null,
      errorType: error?.type ?? null,
      errorStage: error?.stage ?? null,
      errorDetail: error?.message ?? null,
      recordSource: 'json',
    },
    lineCount,
  });
  // Geometry hand-off (queue `readUpstreamGeometry`) reads the top-level shape,
  // not `extras`; attach it after the canonical whitelist has run.
  if (geometry && geometry.length > 0) result.finalGeometry = { atoms: geometry };
  return result;
}

function canonicalFromText(body, { truncated = false, lineCount = 0 } = {}) {
  const looksPyscf = /PySCF|pyscf/i.test(body)
    && /(converged SCF energy|SCF not converged|cycle\s*=\s*\d+|NCS-PYSCF-RESULT)/i.test(body);
  const traceback = /Traceback \(most recent call last\)/.test(body);
  const moduleMissing = /ModuleNotFoundError:\s*No module named ['"]?pyscf['"]?/i.test(body);
  if (!looksPyscf && !traceback && !moduleMissing) {
    return canonicalResult({
      engine: PYSCF_ENGINE_ID,
      program: { name: null },
      termination: 'Not PySCF output',
      terminationCode: TERMINATION.NONE,
      complete: false,
      extras: { reason: 'the text carries no PySCF banner, SCF line or result record' },
      lineCount,
    });
  }

  const versionMatch = /(?:PySCF|pyscf)[^\d\n]{0,40}(\d+\.\d+\.\d+[^\s]*)/.exec(body);
  const version = versionMatch ? versionMatch[1] : null;
  const energies = [];
  const energyRow = /converged SCF energy\s*=\s*(-?\d+(?:\.\d+)?(?:[EeDd][-+]?\d+)?)/g;
  let match;
  while ((match = energyRow.exec(body)) !== null) {
    const value = toNumber(match[1]);
    if (value !== null) energies.push(value);
  }
  const converged = energies.length > 0 && !/SCF not converged/i.test(body);
  const cycles = (() => {
    const rows = /cycle\s*=\s*(\d+)/g;
    let max = null;
    let row;
    while ((row = rows.exec(body)) !== null) {
      const value = Number(row[1]);
      if (Number.isFinite(value) && (max === null || value > max)) max = value;
    }
    return max;
  })();
  const failed = moduleMissing || /SCF not converged/i.test(body) || (traceback && !converged);
  const reason = moduleMissing
    ? 'Python could not import pyscf: No module named \'pyscf\''
    : failed
      ? (/SCF not converged/i.test(body) ? 'SCF did not converge' : 'PySCF raised a Python exception without finishing')
      : (converged ? 'PySCF completed (text fallback)' : 'No termination record');
  const result = canonicalResult({
    engine: PYSCF_ENGINE_ID,
    program: { name: 'PySCF', version },
    termination: reason,
    terminationCode: failed ? TERMINATION.ERROR : converged ? TERMINATION.NORMAL : TERMINATION.NONE,
    complete: !truncated,
    scf: {
      status: converged ? 'converged' : (cycles !== null ? 'failed' : 'unknown'),
      energyHartree: energies.length > 0 ? energies[energies.length - 1] : null,
      cycles,
      method: null,
      applicable: true,
    },
    finalEnergy: {
      hartree: energies.length > 0 ? energies[energies.length - 1] : null,
      source: energies.length > 0 ? 'scf-text-fallback' : null,
    },
    extras: {
      errorType: moduleMissing ? 'ModuleNotFoundError' : (traceback ? 'Traceback' : null),
      errorDetail: moduleMissing ? 'No module named \'pyscf\'' : null,
      recordSource: 'text-fallback',
    },
    lineCount,
  });
  return result;
}

/**
 * Parse one PySCF output. The JSON record wins; PySCF's printed text is a
 * fallback for a log a user supplied, and says so (`extras.recordSource`).
 */
export function parsePyscfOutput(text, { truncated = false, recordText = null, argv = null, route = null } = {}) {
  const body = String(text || '').replace(/\r\n?/g, '\n');
  const lines = body.split('\n');
  let record = null;
  if (recordText && typeof recordText === 'object') record = recordText;
  else if (typeof recordText === 'string' && recordText.trim() !== '') record = extractPyscfRecord(recordText);
  if (!recordLooksLikePyscf(record)) record = extractPyscfRecord(body);

  const result = recordLooksLikePyscf(record)
    ? canonicalFromRecord(record, { truncated, lineCount: lines.length })
    : canonicalFromText(body, { truncated, lineCount: lines.length });
  if (route !== null && String(route).trim() !== '') result.route = String(route).trim();
  if (Array.isArray(argv)) result.argv = argv.map(String);
  return result;
}

/**
 * Synthetic output for the dry-run path. The numbers are a **recorded**
 * PySCF 2.15.0 water run (HF/def2-SVP and B3LYP/def2-SVP), replayed; the
 * `fixture` flag says so on line one and in the record.
 */
export function makePyscfFixtureOutput({ imaginary = 0, scfFailed = false, multiplicity = 1 } = {}) {
  const base = {
    schema: 'nodechem.pyscf.v1',
    engine: PYSCF_ENGINE_ID,
    fixture: true,
    provenance: `recorded PySCF ${PYSCF_FIXTURE_VERSION} water record, replayed as a dry-run fixture`,
    method: 'B3LYP',
    methodKey: 'b3lyp',
    basis: 'def2-SVP',
    basisKey: 'def2-svp',
    jobType: 'SP',
    charge: 0,
    multiplicity,
    reference: 'RHF',
    densityFit: true,
    ecp: false,
    activeSpace: null,
    energy: -76.35815183294746,
    scfEnergy: -76.35815183294746,
    correlationEnergy: null,
    triplesCorrection: null,
    converged: true,
    scfConverged: true,
    nIter: 7,
    moEnergies: [
      -19.117671501634405, -0.9824632367659691, -0.5173064995043108, -0.3657912123409788,
      -0.29189234818130005, 0.047041442146974255, 0.12623430847514294, 0.5649142995654715,
      0.6239667058595919, 0.9166255417351863, 0.9208394487834104, 1.006210668023689,
      1.0925962048087654, 1.3452443880717335, 1.4112865909002568, 1.5509533805292706,
      1.78755844672075, 2.222136882762429, 2.263256012761233, 2.961909174596357,
      3.011442192286588, 3.192945797695068, 3.503671378576983, 3.8221664671639455,
    ],
    nBasis: 24,
    geometry: [
      { element: 'O', x: 0, y: 0, z: 0.1173 },
      { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
      { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
    ],
    frequencies: null,
    hessianOmitted: false,
    optimization: null,
    thermochemistry: null,
    pyscfVersion: PYSCF_FIXTURE_VERSION,
    warnings: [],
    error: null,
  };
  if (scfFailed) {
    base.ok = false;
    base.energy = null;
    base.scfEnergy = null;
    base.converged = false;
    base.scfConverged = false;
    base.nIter = 50;
    base.error = {
      stage: 'scf',
      type: 'SCFNotConverged',
      message: 'SCF did not converge after 50 cycles',
    };
  } else {
    base.ok = true;
  }
  if (imaginary > 0) {
    base.jobType = 'Freq';
    base.frequencies = {
      count: 3,
      values: [-412.31, 1580.22, 3712.44],
      imaginaryCount: 1,
      imaginaryValues: [-412.31],
      minImaginary: -412.31,
      fixtureNote: 'the imaginary mode is inserted for gate testing and is not a recorded result',
    };
  }
  return [
    'FIXTURE OUTPUT — synthetic PySCF record, not a real calculation',
    RECORD_BEGIN,
    JSON.stringify(base, null, 2),
    RECORD_END,
    '',
  ].join('\n');
}

/* ── Termination classifier ───────────────────────────────── */

const MISSING_PYSCF = /ModuleNotFoundError:\s*No module named ['"]?pyscf['"]?/i;

function missingPythonReason(stderr) {
  const text = String(stderr || '');
  if (!MISSING_PYSCF.test(text)) return null;
  return 'Python could not import pyscf: No module named \'pyscf\' '
    + '(install it with `pip install pyscf`, or choose the interpreter that has it)';
}

/**
 * Classify a finished PySCF process.
 *
 * A record saying `ok: true` is a normal termination. A record saying
 * `ok: false` — a failed SCF included — is an error with its iteration count
 * intact. Without a record, a Python traceback that names `pyscf` is an error
 * even on exit 0, and a non-zero exit with no marker is an error.
 */
export function classifyPyscfTermination(text, exitCode, { stderr = null } = {}) {
  const record = extractPyscfRecord(String(text || ''));
  if (recordLooksLikePyscf(record)) {
    if (record.ok === false || record.error) {
      const detail = record.error?.message || record.error?.type || 'no detail';
      return { code: TERMINATION.ERROR, reason: `PySCF failed: ${detail}` };
    }
    return {
      code: TERMINATION.NORMAL,
      reason: `PySCF ${record.pyscfVersion || ''} completed`.replace(/\s+/g, ' ').trim(),
    };
  }
  const missing = missingPythonReason(stderr);
  if (missing) return { code: TERMINATION.ERROR, reason: missing };
  if (MISSING_PYSCF.test(String(text || ''))) {
    return { code: TERMINATION.ERROR, reason: missingPythonReason(text) };
  }
  if (/Traceback \(most recent call last\)/i.test(String(text || ''))) {
    return { code: TERMINATION.ERROR, reason: 'PySCF raised a Python exception without finishing' };
  }
  const numeric = Number(exitCode);
  if (Number.isFinite(numeric) && numeric !== 0) {
    return { code: TERMINATION.ERROR, reason: `PySCF exited with code ${numeric} and produced no result record` };
  }
  return { code: TERMINATION.NONE, reason: 'no PySCF result record or termination marker' };
}
