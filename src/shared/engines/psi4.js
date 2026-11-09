/**
 * Psi4 engine: Psithon input builder, output parser, capability table,
 * termination classifier and provenance block.
 *
 * Psi4 is the first engine in the app whose input is **code** (Psithon, a
 * Python dialect), not a keyword file. That changes what an honest builder can
 * promise:
 *
 * - Every input this module writes is a fixed, reviewed script — the molecule
 *   block, a handful of `set` lines and one call. No setting is interpolated
 *   as a statement, so a project field can never become arbitrary Python.
 * - Anything Psi4 core does not implement (NBO, GIAO NMR, TD-DFT through this
 *   builder) is refused by name instead of approximated.
 *
 * Issue 167: implicit solvation is written, through Psi4's **DDX** addon rather
 * than PCMSolver. The option block, the two-run deck and the log lines the
 * parser reads were taken from Psi4 1.11 with pyddx 1.0.0 installed (see
 * `test/fixtures/psi4-ddx/PROVENANCE.md`): `ddx true`, `ddx_model pcm`,
 * `ddx_solvent water`, and the `DD Solvation Energy =` row Psi4 prints in its
 * `=> Energetics <=` block. DDX-PCM is not PCMSolver's PCM and not SMD; the card
 * and `docs/guide/engines.md` say so, and no ΔG is ever printed.
 *
 * Output shapes below were taken from real Psi4 output files kept in
 * `test/fixtures/real/psi4-*.out` (Psi4 1.1 – 1.4, from the Psi4 test suite,
 * RMG-Py and cclib): the banner `Psi4 1.4a1.dev189`, `@RHF Final Energy:`,
 * `@DF-RKS iter  1:`, `Total Energy =`, `MP2 Total Energy (a.u.)`,
 * `Total CCSD energy`, the SAPT results table, `Optimization is complete! (in N
 * steps)`, `Optimization has failed!`, `#  #` frequency blocks,
 * `Total H, Enthalpy at  298.15 [K]`, `Total G, Free enthalpy at  298.15 [K]`,
 * and the two termination lines.
 *
 * No Psi4 binary was run for this change. The parser is tested against those
 * real files; the runner is tested against a stand-in driver script.
 */

import { canonicalResult, TERMINATION } from './canonical.js';
import { parseFchk } from '../fchk.js';
import { eprBlock } from '../epr.js';
import { chargeTransferReport } from '../chargeTransfer.js';

export const PSI4_ENGINE_ID = 'psi4';

/**
 * Psi4 releases whose output lines this parser was written against.
 *
 * Issue 176: a comment saying "Psi4 changed its banner" does not fail a test, so
 * every version-specific line below names its release here, and
 * `test/fixtureCoverage.test.js` refuses a captured fixture whose PROVENANCE
 * names a release missing from this list. Adding Psi4 1.12 means reading its
 * banner and adding `'1.12'` — not discovering the change from a wrong number.
 *
 * - `1.1`–`1.4`  `MP2 Total Energy (a.u.) :`, `Total CCSD energy (file100) =`,
 *                `#  #` frequency blocks, `Optimization is complete! (in N steps)`
 * - `1.9`+       `* CCSD total energy =`, `Freq [cm^-1]` frequency table,
 *                `Optimizer: Optimization complete!`
 * - `1.11`       `==> DF-MP2 Energies <==` / `DF-SCS-MP2 Energies` banners,
 *                `Freq [cm^-1]` rows with `1234.56i` imaginary markers
 */
export const PSI4_SUPPORTED_VERSIONS = Object.freeze(['1.1', '1.4', '1.9', '1.11']);

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.dat$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?`;
const HARTREE_KCAL = 627.5094740631;
const HARTREE_KJ = 2625.4996394799;

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

/** Last numeric capture of a pattern; a Psi4 log repeats blocks per job. */
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

/**
 * The last `Total Energy =` line that carries no method prefix.
 *
 * Psi4 1.11 prints an MP2 job's canonical total under a `DF-MP2 Energies`
 * banner and a spin-component-scaled total under a `DF-SCS-MP2 Energies` banner
 * whose line also contains the words "Total Energy". A plain last-match on the
 * string therefore reports SCS-MP2 as the result of an MP2 job — a different
 * method's number, 3.8 mEh away on water/def2-SVP and with a basis-dependent
 * sign. Only a bare `Total Energy =` is the canonical one.
 */
function lastUnprefixedTotal(text) {
  let value = null;
  for (const line of text.split('\n')) {
    const match = new RegExp(String.raw`^(.*?)Total Energy\s*=\s*(${NUMBER})`).exec(line.trimStart());
    if (!match) continue;
    if (match[1].trim() !== '') continue;
    const candidate = toNumber(match[2]);
    if (candidate !== null) value = candidate;
  }
  return value;
}

/**
 * The canonical total inside the LAST `<METHOD> Energies` banner.
 *
 * A job that prints several banners (an optimisation prints one per step) is
 * reporting the last one as its result.
 */
function bannerTotal(text, banner) {
  const pattern = new RegExp(banner.source, 'gi');
  let at = -1;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    at = match.index;
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
  }
  if (at === -1) return null;
  for (const line of text.slice(at).split('\n')) {
    const found = new RegExp(String.raw`^\s*Total Energy\s*=\s*(${NUMBER})`).exec(line);
    if (found) {
      const candidate = toNumber(found[1]);
      if (candidate !== null) return candidate;
    }
  }
  return null;
}

/* ── Capabilities ─────────────────────────────────────────── */

/**
 * Methods this builder can spell as one Psi4 energy function.
 *
 * `label` is what the app shows; `fn` is the name Psi4's `energy()` /
 * `optimize()` takes. HF goes through `scf`, which honours `set reference`.
 */
export const PSI4_METHODS = Object.freeze([
  { key: 'hf', label: 'HF', fn: 'scf', kind: 'scf' },
  { key: 'b3lyp', label: 'B3LYP', fn: 'b3lyp', kind: 'dft' },
  { key: 'pbe0', label: 'PBE0', fn: 'pbe0', kind: 'dft' },
  { key: 'm06-2x', label: 'M06-2X', fn: 'm06-2x', kind: 'dft' },
  { key: 'wb97x-d', label: 'ωB97X-D', fn: 'wb97x-d', kind: 'dft' },
  { key: 'b97-d', label: 'B97-D', fn: 'b97-d', kind: 'dft' },
  { key: 'mp2', label: 'MP2', fn: 'mp2', kind: 'correlated' },
  { key: 'ccsd', label: 'CCSD', fn: 'ccsd', kind: 'correlated' },
  { key: 'ccsd(t)', label: 'CCSD(T)', fn: 'ccsd(t)', kind: 'correlated' },
  { key: 'sapt0', label: 'SAPT0', fn: 'sapt0', kind: 'sapt' },
]);

export const PSI4_BASES = Object.freeze([
  { key: 'def2-svp', label: 'def2-SVP', psi4: 'def2-svp' },
  { key: 'def2-tzvp', label: 'def2-TZVP', psi4: 'def2-tzvp' },
  { key: 'def2-qzvp', label: 'def2-QZVP', psi4: 'def2-qzvp' },
  { key: '6-31g(d)', label: '6-31G(d)', psi4: '6-31G*' },
  { key: '6-31g(d,p)', label: '6-31G(d,p)', psi4: '6-31G**' },
  { key: '6-311++g(d,p)', label: '6-311++G(d,p)', psi4: '6-311++G**' },
  { key: 'cc-pvdz', label: 'cc-pVDZ', psi4: 'cc-pvdz' },
  { key: 'cc-pvtz', label: 'cc-pVTZ', psi4: 'cc-pvtz' },
  { key: 'cc-pvqz', label: 'cc-pVQZ', psi4: 'cc-pvqz' },
  { key: 'aug-cc-pvdz', label: 'aug-cc-pVDZ', psi4: 'aug-cc-pvdz' },
]);

export const PSI4_JOB_TYPES = Object.freeze(['SP', 'Opt', 'Freq', 'Opt Freq', 'TD-DFT']);

export const PSI4_UNSUPPORTED_JOB_TYPES = Object.freeze(['Opt=TS', 'IRC', 'Scan', 'NMR']);

/**
 * Implicit solvation through Psi4's **DDX** addon (issue 167).
 *
 * DDX is a continuum-solvation library Psi4 1.11 drives as an addon: it solves
 * a polarizable-continuum (or conductor, or linearised-Poisson–Boltzmann) model
 * on a surface of atomic spheres, through the `ddx` Python module (pyddx).
 * Psi4 core carries the keywords; the module is a separate install, and the
 * `psi4/psi4:1.11` image does **not** include it — measured, see
 * `test/fixtures/psi4-ddx/water-pcm-no-pyddx.out`. The models are told apart by
 * one keyword:
 *
 *     set ddx true
 *     set ddx_model pcm|cosmo|lpb
 *     set ddx_solvent water
 *
 * `PCM` and `COSMO` are what this builder writes. `LPB` is refused by name: it
 * runs only with a positive `ddx_solvent_kappa` (Psi4 1.11 says so itself —
 * `DDX_SOLVENT_KAPPA is required for LPB`), a Psi4 block has no ionic-strength
 * field to carry one, and a made-up κ would be a physical claim this app cannot
 * support. SMD and CPCM are not DDX models at all.
 */
export const PSI4_SOLVATION_MODELS = Object.freeze(['PCM', 'COSMO']);

/**
 * App solvent label → the name `ddx_solvent` takes. Every value was checked
 * against `pyddx.data.solvent_epsilon` **and** by running Psi4 1.11 with it —
 * Psi4 validates the name against that same table, so a name that is not in it
 * aborts the run with `Unknown solvent <name>.` rather than defaulting.
 *
 * A label absent here is refused by name; it is never silently run in water.
 * Labels match the ones the rest of the app uses (`Water`, `THF`, …) so a
 * solvent chosen for an ORCA or xTB block means the same liquid here.
 *
 * `n,n-dimethylformamide` is deliberately absent: Psithon reads `set` values as
 * Python, so the comma turns the name into a tuple (`SyntaxError`, measured),
 * and a quoted value is a syntax error too. It is refused by name like any
 * other solvent this table does not carry.
 */
export const PSI4_DDX_SOLVENTS = Object.freeze({
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

/**
 * The cavity. `uff` with its recommended 1.1 scaling is pyddx's own default for
 * these radii, so writing both lines changes nothing about the calculation but
 * makes the cavity reproducible from the deck alone — the log does not say
 * which radius set built it. `bondi` is the other set DDX ships; a Psi4 block
 * has no field to choose it, so it is not offered and not written.
 */
export const PSI4_DDX_RADII_SET = 'uff';
export const PSI4_DDX_RADII_SCALING = 1.1;

const MODEL_BY_KEY = new Map(PSI4_SOLVATION_MODELS.map((label) => [label.toLowerCase(), label]));

const METHOD_BY_KEY = new Map(PSI4_METHODS.map((entry) => [entry.key, entry]));
const BASIS_BY_KEY = new Map(PSI4_BASES.map((entry) => [entry.key, entry]));
const BASIS_BY_PSI4 = new Map(PSI4_BASES.map((entry) => [entry.psi4.toLowerCase(), entry]));

export const PSI4_CAPABILITIES = Object.freeze({
  id: PSI4_ENGINE_ID,
  label: 'Psi4',
  inputExtension: '.dat',
  outputExtension: '.out',
  /**
   * Psi4 writes its log to stdout; `psi4 job.dat` prints it and leaves nothing
   * in the run folder. The runner captures the stream, as for ORCA and xTB.
   */
  capturesStdout: true,
  writesOptimisedGeometryTo: null,
  restartArtifact: null,
  exitCodes: Object.freeze({ success: 0 }),
  methods: PSI4_METHODS,
  basisSets: PSI4_BASES,
  dispersionSchemes: Object.freeze([]),
  /**
   * Issue 167. These are the models this builder writes, not everything Psi4's
   * DDX library knows: `pcm` and `cosmo` are two `ddx_model` values away from
   * the deck the builder emits, and `lpb` is not offered because it needs a
   * Debye κ no Psi4 block here has a field for.
   */
  solvationModels: PSI4_SOLVATION_MODELS,
  solvents: PSI4_DDX_SOLVENTS,
  /**
   * What a solvated Psi4 block actually is, in one machine-readable place so a
   * card cannot describe it as something else: two single-point SCFs (gas phase,
   * then in solvent) at the same level, solved by DDX on a UFF cavity.
   */
  solvation: Object.freeze({
    provider: 'ddx',
    models: PSI4_SOLVATION_MODELS,
    radiiSet: PSI4_DDX_RADII_SET,
    radiiScaling: PSI4_DDX_RADII_SCALING,
    jobTypes: Object.freeze(['SP']),
    gasPhasePair: true,
    /** The addon the deck needs. Not part of Psi4 core, and not in the reference image. */
    requires: 'the ddx Python module (pyddx) in the Psi4 environment; psi4/psi4:1.11 ships Psi4, not pyddx',
    /** What the numbers under `solvation` in a parsed result are — and are not. */
    quantity: 'electronic energy difference between the solvated and gas-phase single points, plus the DDX solute-solvent interaction; not a solvation free energy',
  }),
  jobTypes: PSI4_JOB_TYPES,
  unsupportedJobTypes: PSI4_UNSUPPORTED_JOB_TYPES,
  unsupportedFeatures: Object.freeze([
    'SMD and CPCM solvation (DDX writes pcm and cosmo; DDX-PCM is not SMD and there is no CPCM keyword)',
    'LPB solvation (it runs only with a positive ddx_solvent_kappa, and a Psi4 block has no ionic-strength field)',
    'solvation free energies (a DDX single point gives an electronic energy difference and the solute-solvent interaction, not a ΔG)',
    'solvation on optimisations, frequencies, TD-DFT and correlated methods (the deck writes the gas-phase/solvated pair for a single-point SCF or DFT)',
    'transition-state search',
    'IRC and relaxed scans',
    'excited-state optimisation (Psi4 prints excitations but cannot relax on an excited surface here)',
    'NMR shieldings',
    'NBO populations (an external NBO program, not Psi4 core)',
    'separate dispersion corrections (choose a D3-carrying functional instead)',
    'Gaussian-style checkpoints and routes',
    'frequency gradients for CCSD/CCSD(T)',
    // Issue 168: named here as well as in the card, so a settings dialog or a
    // capability listing can refuse it without inventing a g-value.
    'EPR g-tensor (needs a spin-orbit treatment Psi4 job blocks here have no step for; ORCA is not installed)',
  ]),
  /**
   * Issue 168: what this engine can say about an open-shell species.
   *
   * `spinPopulations` and `hyperfine` are read from the checkpoint the builder
   * writes for an open-shell single point; both are density-only and the card
   * states that. `gTensor` is false with its reason, which is the whole point of
   * the entry.
   */
  epr: Object.freeze({
    spinPopulations: true,
    hyperfine: 'density-only (Fermi contact, no core polarisation from correlation beyond the method, no spin-orbit)',
    gTensor: false,
    gTensorReason: 'Psi4 has no g-tensor property in the module set this builder writes, and ORCA is not installed',
  }),
});

/* ── Settings refusals ────────────────────────────────────── */

/** The job type a settings object asks for, defaulted the way the builder does. */
function jobTypeOf(settings = {}) {
  return oneLine(settings.jobType, 'SP') || 'SP';
}

/**
 * The core-correlation choice, or null for "whatever Psi4 does by itself".
 *
 * `null` is the default and it writes nothing, so an existing project keeps
 * producing byte-identical input. `true`/`false` are the user asking for frozen
 * core (the literature convention for extrapolations) or an all-electron run,
 * and only then does `set freeze_core` appear.
 */
function freezeCoreChoice(settings = {}) {
  const value = settings.freezeCore;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}


/** Method entry for a settings object, or throw naming the field. */
export function psi4MethodFor(settings = {}) {
  const key = oneLine(settings.method, 'b3lyp').toLowerCase();
  const method = METHOD_BY_KEY.get(key);
  if (!method) {
    throw new Error(`Psi4 cannot run method "${oneLine(settings.method)}". Supported: `
      + `${PSI4_METHODS.map((entry) => entry.label).join(', ')}.`);
  }
  return method;
}

export function psi4BasisFor(settings = {}) {
  const key = oneLine(settings.basis, 'def2-svp').toLowerCase();
  const basis = BASIS_BY_KEY.get(key);
  if (!basis) {
    throw new Error(`Psi4 cannot run basis "${oneLine(settings.basis)}". Supported: `
      + `${PSI4_BASES.map((entry) => entry.label).join(', ')}.`);
  }
  return basis;
}

/**
 * Does this block ask for a solvent?
 *
 * `solvation` is a boolean in the schema, so the guard has to test the value:
 * `String(false)` is "false", which is truthy, and a solvent name is a field the
 * schema always fills ('Water') whether or not solvation was asked for. Testing
 * their text refused every Psi4 block, including the default ones. A legacy file
 * that stored a model name ('PCM') still counts as a request (issue 167).
 */
function solvationRequested(settings = {}) {
  const raw = settings.solvation;
  return raw === true
    || (typeof raw === 'string'
      && raw.trim() !== ''
      && !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase()));
}

/**
 * The three settings a solvated deck writes, or `null` when the block asks for
 * no solvent. Throws, naming the field, when the request cannot be honoured.
 *
 * Exported because the card and the provenance block need the same answer the
 * builder writes; a second table somewhere else is how a capability list drifts
 * away from the deck.
 */
export function psi4SolvationFor(settings = {}) {
  if (!solvationRequested(settings)) return null;
  const fail = (field, message) => {
    const error = new Error(message);
    error.field = field;
    throw error;
  };

  const modelRaw = oneLine(settings.solvationModel, 'PCM').toUpperCase();
  if (modelRaw === 'LPB') {
    fail('solvationModel',
      'Psi4\'s DDX runs LPB only with a positive `ddx_solvent_kappa`, and a Psi4 block '
      + 'has no ionic-strength field to carry one; a made-up κ would be a physical claim '
      + 'this app cannot support. Choose PCM or COSMO.');
  }
  if (modelRaw === 'SMD' || modelRaw === 'CPCM') {
    fail('solvationModel',
      `Psi4 has no ${modelRaw} solvation: its DDX addon writes \`pcm\` and \`cosmo\`, and `
      + `${modelRaw === 'SMD' ? 'SMD needs a cavity and thermodynamic treatment this builder does not write'
        : 'the conductor model DDX implements is COSMO'}. Choose ${modelRaw === 'SMD' ? 'PCM or COSMO' : 'COSMO'}.`);
  }
  const model = MODEL_BY_KEY.get(modelRaw.toLowerCase());
  if (!model) {
    fail('solvationModel',
      `Psi4 solvation models: ${PSI4_SOLVATION_MODELS.join(', ')}. "${oneLine(settings.solvationModel)}" is not one of them.`);
  }

  const solventLabel = oneLine(settings.solvent, 'Water') || 'Water';
  const solvent = PSI4_DDX_SOLVENTS[solventLabel];
  if (!solvent) {
    fail('solvent',
      `Solvent "${solventLabel}" has no DDX name in this builder. Psi4's DDX takes `
      + `${Object.keys(PSI4_DDX_SOLVENTS).join(', ')}; a name it does not know aborts the run `
      + '(`Unknown solvent`), so it is refused here rather than run in water.');
  }

  const jobType = jobTypeOf(settings);
  if (jobType !== 'SP') {
    fail('jobType',
      `A solvated Psi4 block is a gas-phase and a solvated single point at the same level, `
      + `so it must be SP; "${jobType}" has no such pair in this builder.`);
  }

  const method = METHOD_BY_KEY.get(oneLine(settings.method, 'b3lyp').toLowerCase());
  if (method && method.kind !== 'scf' && method.kind !== 'dft') {
    fail('solvation',
      `DDX couples to the SCF in Psi4 1.11, so an ${method.label} solvated energy would be `
      + 'the correlation energy on a solvated reference with no solvent response of its own. '
      + 'Run the solvated single point at HF or a functional.');
  }

  return {
    model,
    solvent,
    solventLabel,
    radiiSet: PSI4_DDX_RADII_SET,
    radiiScaling: PSI4_DDX_RADII_SCALING,
  };
}

/**
 * Settings a Psi4 block cannot honour, each with the reason.
 *
 * The list is deliberately about *this builder*: Psi4 can do more than the
 * builder writes (external solvation, NBO via a separate program). Refusing is
 * the honest answer to "this block asks for something the input will not say".
 */
export function psi4SettingsOffenders(settings = {}) {
  const offenders = [];
  const text = (value) => oneLine(value);

  // Issue 167: solvation is written now, so the offender is no longer the
  // request itself but a model, solvent or job the deck cannot express. The
  // message is the builder's own, so a preflight and a run refuse identically.
  try {
    psi4SolvationFor(settings);
  } catch (error) {
    offenders.push({ field: error?.field || 'solvation', message: String(error?.message ?? error) });
  }
  if (settings.raman === true) {
    offenders.push({
      field: 'raman',
      message: 'Raman intensities are a Gaussian keyword and this builder writes no Psi4 Raman step.',
    });
  }
  if (settings.orbitals === true) {
    offenders.push({
      field: 'orbitals',
      message: 'Frontier-orbital descriptors are Gaussian Pop=Full; this build parses no Psi4 orbital block.',
    });
  }
  if (text(settings.verbosity)) {
    offenders.push({
      field: 'verbosity',
      message: 'Output verbosity is a Gaussian Print keyword; Psi4 prints its own fixed banner.',
    });
  }
  // TD-DFT is a job type here, so the Gaussian-style "excited states" flag is not
  // how it is requested. Asking for it on another job type is a refusal, not a
  // silent extra: a Psi4 `energy('td-…')` runs a different calculation.
  if ((settings.tddft === true || settings.excitedStates || text(settings.td)) && jobTypeOf(settings) !== 'TD-DFT') {
    offenders.push({
      field: 'tddft',
      message: 'Excited states in Psi4 are a job type (TD-DFT), not a keyword on another job: '
        + 'set the block to TD-DFT so the input runs the calculation you asked for.',
    });
  }
  // Freezing the core is a property of a correlated method: HF has no correlation
  // step and SAPT0 does not correlate monomers here, so the keyword would be a
  // no-op that reads as if it had done something.
  const freezeChoice = freezeCoreChoice(settings);
  if (settings.freezeCore !== undefined && settings.freezeCore !== null
      && !['auto', 'true', 'false', true, false].includes(settings.freezeCore)) {
    offenders.push({
      field: 'freezeCore',
      message: 'Core correlation takes auto, frozen or all-electron; '
        + `"${String(settings.freezeCore)}" is not one of them.`,
    });
  } else if (freezeChoice !== null) {
    const chosen = METHOD_BY_KEY.get(oneLine(settings.method, 'b3lyp').toLowerCase());
    if (!chosen || chosen.kind !== 'correlated') {
      offenders.push({
        field: 'freezeCore',
        message: 'Freezing the core means excluding the 1s electrons from the correlation treatment, '
          + `and ${chosen ? chosen.label : 'this method'} has no correlation step. Choose MP2, CCSD or CCSD(T).`,
      });
    }
  }
  if (text(settings.population)) {
    offenders.push({
      field: 'population',
      message: 'Population analysis is not written for Psi4 blocks; NBO is an external program.',
    });
  }
  if (text(settings.dispersion)) {
    offenders.push({
      field: 'dispersion',
      message: 'Psi4 takes dispersion through the functional name; choose ωB97X-D or B97-D instead.',
    });
  }
  if (text(settings.grid)) {
    offenders.push({
      field: 'grid',
      message: 'Psi4 uses its own DFT grid defaults; a Gaussian grid keyword has no equivalent here.',
    });
  }
  if (settings.stableOpt === true) {
    offenders.push({
      field: 'stableOpt',
      message: 'Stable=Opt is a Gaussian keyword; Psi4 has no equivalent in this builder.',
    });
  }
  if (text(settings.customKeywords)) {
    offenders.push({
      field: 'customKeywords',
      message: 'Custom Gaussian route keywords do not map to Psithon, and are not written as code.',
    });
  }
  // Issue 173: the transition-dipole record is a read of the TD wavefunction, so
  // it exists only on a TD-DFT block. Asking for it elsewhere would be a line
  // that never runs.
  if (settings.recordTransitionDipoles === true && jobTypeOf(settings) !== 'TD-DFT') {
    offenders.push({
      field: 'recordTransitionDipoles',
      message: 'Recording transition dipoles reads the TD wavefunction, so it needs a TD-DFT block: '
        + 'set the job type to TD-DFT, or turn the setting off.',
    });
  }
  if (text(settings.jobType) && PSI4_UNSUPPORTED_JOB_TYPES.includes(text(settings.jobType))) {
    offenders.push({
      field: 'jobType',
      message: `${text(settings.jobType)} is not supported for Psi4 blocks in this build.`,
    });
  }
  return offenders;
}

export function assertPsi4Settings(settings = {}) {
  const requestedJob = jobTypeOf(settings);
  if (requestedJob === 'TD-DFT') {
    // Psi4's TD-DFT module starts from a converged SCF reference; SAPT and the
    // coupled-cluster methods have no excited-state path in this builder.
    const methodKey = oneLine(settings.method, 'b3lyp').toLowerCase();
    if (['sapt0', 'sapt', 'ccsd', 'ccsd(t)'].includes(methodKey)) {
      throw new Error(`TD-DFT needs a single-reference SCF method; "${oneLine(settings.method)}" is not one. `
        + 'Choose HF or a functional.');
    }
    const states = Number(settings.tdStates);
    if (!Number.isInteger(states) || states < 1 || states > 50) {
      throw new Error('TD-DFT needs the number of excited states: set States to a whole number '
        + 'from 1 to 50. Psi4 allocates the request across irreducible representations.');
    }
    const root = Number(settings.tdRoot);
    if (Number.isInteger(root) && root > 1) {
      throw new Error('Root selects which excited state to follow, and this build cannot optimise on '
        + 'an excited surface in Psi4 — a TD-DFT block is a single point. Set Root to 1 or 0, or run '
        + 'the excited-state optimisation in Gaussian.');
    }
  }
  const offenders = psi4SettingsOffenders(settings);
  if (offenders.length > 0) {
    throw new Error(offenders[0].message);
  }
}

/* ── Input builder ────────────────────────────────────────── */

/**
 * Issue 173: the reversible record of the TD wavefunction for a TD-DFT block.
 *
 * The TDSCF table Psi4 prints carries energies and oscillator strengths but no
 * transition-dipole *vector* and no transition density: |μ| follows from f, its
 * direction does not, and neither the direction nor the charge-transfer
 * decomposition of route B can be recovered from the oscillator strength. Both
 * objects do exist on the returned wavefunction:
 *
 * - one array per root named
 *   `TD-<method> ROOT 0 (<irrep>) -> ROOT <n> (<irrep>) ELECTRIC TRANSITION DIPOLE
 *   MOMENT (LEN)` (atomic units), which becomes `NCS-TDM ROOT <n> <irrep> x y z a.u.`;
 * - and the Tamm–Dancoff amplitudes as
 *   `... RIGHT EIGENVECTOR ALPHA`, one block per root, which become the
 *   `NCS-TDMAT` block: the transition density in the MO basis, from which
 *   `chargeTransfer.js` builds D^{0I} = C_occ t C_virᵀ.
 *
 * Three measured facts about Psi4 1.11 are baked in, each of which a previous
 * version of this block got wrong:
 *
 * - the accessor is `wfn.array_variable(name)`, not `get_array`;
 * - `print()` goes to the process's standard output, which the runner does not
 *   keep — the record has to go through `psi4.core.print_out` to reach the log;
 * - the same eigenvector is stored under four names (two method aliases, with
 *   and without a `- <irrep> TRANSITION` suffix), so the block is keyed by root
 *   and printed once.
 *
 * `set tdscf_tda true` is written with this block because the amplitudes read
 * here are the Tamm–Dancoff ones, where Σ X² = 1 makes the partition
 * normalisable; the RPA transition density carries de-excitations too and is a
 * different object. The molecule block runs in C1 for the same kind of reason:
 * with symmetry on, both the amplitudes and the checkpoint's MO coefficients are
 * stored as per-irrep blocks, and pairing them would mean re-deriving Psi4's
 * irrep offsets from a text log.
 *
 * The fragment labels are the block's own (`atom.fragment`), written as one
 * number per atom so a complex whose members interleave is read correctly.
 */
function transitionDipoleLines(fn, { fragmentLabels = [], checkpointName = null } = {}) {
  const labels = Array.isArray(fragmentLabels) && fragmentLabels.length > 0 ? fragmentLabels : [1];
  const lines = [
    '# NCS-CT: the fragment label of each atom, in the order the molecule block',
    '# lists them. The transition density is partitioned by these labels.',
    `psi4.core.print_out('NCS-CTFRAG ${labels.length} ${labels.join(' ')}' + "\\n")`,
    `E, wfn = energy('td-${fn}', return_wfn=True)`,
    '# NCS-TDM: the TDSCF table has no transition-dipole vector, so the wavefunction',
    '# is read instead. One line per root, values in atomic units (a.u.).',
    '_ncs_dipoles = {}',
    'for _ncs_name in wfn.array_variables():',
    "    if 'ROOT 0 (' not in _ncs_name or '-> ROOT ' not in _ncs_name or _ncs_name.endswith(' TRANSITION'):",
    '        continue',
    "    if 'ELECTRIC TRANSITION DIPOLE MOMENT (LEN)' not in _ncs_name:",
    '        continue',
    "    _ncs_root = int(_ncs_name.split('-> ROOT ')[-1].split(' ')[0])",
    '    if _ncs_root not in _ncs_dipoles:',
    '        _ncs_dipoles[_ncs_root] = _ncs_name',
    'for _ncs_root in sorted(_ncs_dipoles):',
    '    _ncs_v = wfn.array_variable(_ncs_dipoles[_ncs_root]).to_array().flatten()',
    "    psi4.core.print_out('NCS-TDM ROOT %d %s %.10f %.10f %.10f a.u.\\n' % (",
    "        _ncs_root, _ncs_dipoles[_ncs_root].split('(')[1].split(')')[0],",
    '        float(_ncs_v[0]), float(_ncs_v[1]), float(_ncs_v[2])))',
    '# NCS-TDMAT: the state\'s transition density in the MO basis (TDA amplitudes,',
    '# occupied rows, virtual columns), from which chargeTransfer.js builds the AO',
    '# transition density. Eight decimals of an O(1) amplitude are well inside the',
    '# distance a CT fraction can resolve.',
    '_ncs_eigen = {}',
    'for _ncs_name in wfn.array_variables():',
    "    if 'RIGHT EIGENVECTOR ALPHA' not in _ncs_name:",
    '        continue',
    "    if 'ROOT 0 (' not in _ncs_name or '-> ROOT ' not in _ncs_name or _ncs_name.endswith(' TRANSITION'):",
    '        continue',
    "    _ncs_root = int(_ncs_name.split('-> ROOT ')[-1].split(' ')[0])",
    '    if _ncs_root not in _ncs_eigen:',
    '        _ncs_eigen[_ncs_root] = _ncs_name',
    'for _ncs_root in sorted(_ncs_eigen):',
    '    _ncs_blocks = wfn.array_variable(_ncs_eigen[_ncs_root]).to_array()',
    '    if not isinstance(_ncs_blocks, tuple):',
    '        _ncs_blocks = (_ncs_blocks,)',
    '    _ncs_rows = 0',
    '    _ncs_cols = 0',
    '    _ncs_text = []',
    '    for _ncs_block in _ncs_blocks:',
    "        _ncs_a = __import__('numpy').asarray(_ncs_block)",
    '        if _ncs_a.size == 0:',
    '            continue',
    '        _ncs_rows += _ncs_a.shape[0]',
    '        _ncs_cols = max(_ncs_cols, _ncs_a.shape[1])',
    '        for _ncs_row in _ncs_a:',
    "            _ncs_text.append(' '.join('%.8f' % float(_v) for _v in _ncs_row))",
    "    psi4.core.print_out('NCS-TDMAT ROOT %d %d %d tda\\n' % (_ncs_root, _ncs_rows, _ncs_cols))",
    '    for _ncs_line in _ncs_text:',
    '        psi4.core.print_out(_ncs_line + "\\n")',
    '    psi4.core.print_out(\'NCS-TDMAT END %d\\n\' % _ncs_root)',
  ];
  if (checkpointName) {
    // The MO coefficients and the overlap's basis are what turn the printed
    // amplitudes into a density over atoms; without the file the parser refuses
    // the analysis by name instead of guessing an orbital ordering.
    lines.push(`fchk(wfn, '${checkpointName}')`);
  }
  return lines;
}

function coordinateLine(atom) {
  const element = oneLine(atom?.element);
  if (!element) throw new Error('Every atom needs an element symbol.');
  const x = finiteNumber(atom.x, 'Atom x coordinate');
  const y = finiteNumber(atom.y, 'Atom y coordinate');
  const z = finiteNumber(atom.z, 'Atom z coordinate');
  return `  ${element}  ${x.toFixed(6)}  ${y.toFixed(6)}  ${z.toFixed(6)}`;
}

/**
 * The molecule block. Fragments are separated by `--`, which is how Psithon
 * says "these atoms belong to a different monomer" — required for SAPT and
 * ignored by every other method.
 *
 * `symmetry` is only written when a caller asks for one (issue 173's
 * transition-density record runs in C1, so that the checkpoint's orbital order
 * and the printed amplitudes are the same order); a block that does not ask
 * produces exactly the molecule block it did before.
 */
function moleculeBlock(molecule = {}, { fragments = false, symmetry = null } = {}) {
  const coords = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (coords.length === 0) throw new Error('A molecule with Cartesian coordinates is required.');
  const charge = Number.isInteger(Number(molecule.charge)) ? Number(molecule.charge) : 0;
  const multiplicity = Number.isInteger(Number(molecule.multiplicity)) ? Number(molecule.multiplicity) : 1;

  const lines = [];
  if (symmetry) lines.push(`symmetry ${oneLine(symmetry)}`);
  if (!fragments) {
    lines.push(`${charge} ${multiplicity}`);
    for (const atom of coords) lines.push(coordinateLine(atom));
    return lines;
  }

  const groups = new Map();
  coords.forEach((atom) => {
    const index = Number.isInteger(Number(atom?.fragment)) && Number(atom.fragment) >= 1
      ? Number(atom.fragment) : 1;
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(atom);
  });
  const ordered = [...groups.keys()].sort((a, b) => a - b);
  if (ordered.length < 2) {
    throw new Error('SAPT0 needs at least two fragments, but no atom carries a fragment label. '
      + 'Label each atom with its fragment number in the molecule editor (Fragment column).');
  }
  ordered.forEach((index, position) => {
    if (position > 0) lines.push('--');
    // A fragment charge is not stored per fragment in the project, so every
    // monomer is written neutral and the block's own charge is not used. A
    // charged dimer would need per-fragment charges, which the schema does not
    // carry yet — saying so beats writing a wrong multiplicity.
    lines.push(`${position === 0 ? charge : 0} ${position === 0 ? multiplicity : 1}`);
    for (const atom of groups.get(index)) lines.push(coordinateLine(atom));
  });
  return lines;
}

/**
 * Build one Psi4 input.
 *
 * The script is fixed apart from the molecule block and a closed list of `set`
 * lines. `inputName` arrives as `.gjf` from the existing workflow planner, so
 * the extension is rewritten here; anything else is validated strictly.
 */
export function buildPsi4Input({
  title = 'Psi4 task',
  settings = {},
  molecule = {},
  inputName = 'task.dat',
  oldCheckpoint = '',
} = {}) {
  assertPsi4Settings(settings);
  const requested = oneLine(inputName, 'task.dat');
  const safeName = requested.replace(/\.(gjf|com|inp)$/i, '.dat');
  if (!SAFE_INPUT.test(safeName)) throw new Error('Input name must be a safe .dat basename.');

  const method = psi4MethodFor(settings);
  const basis = psi4BasisFor(settings);
  const jobType = oneLine(settings.jobType, 'SP') || 'SP';
  if (!PSI4_JOB_TYPES.includes(jobType)) {
    throw new Error(`Psi4 jobs: ${PSI4_JOB_TYPES.join(', ')}. "${jobType}" is not one of them.`);
  }
  if (method.kind === 'sapt' && jobType !== 'SP') {
    throw new Error('SAPT0 is an energy method; choose a single point job.');
  }
  if ((method.key === 'ccsd' || method.key === 'ccsd(t)') && (jobType === 'Freq' || jobType === 'Opt Freq')) {
    throw new Error(`${method.label} has no analytic Hessian in Psi4; run the frequency at a DFT or MP2 level.`);
  }

  const memory = Number(settings.memory);
  const memoryUnit = String(settings.memoryUnit || 'GB').toUpperCase();
  const memoryMb = !Number.isFinite(memory) || memory <= 0
    ? null
    : memoryUnit === 'MW' ? memory * 8 : memoryUnit === 'MB' ? memory : memory * 1024;

  const multiplicity = Number.isInteger(Number(molecule.multiplicity)) ? Number(molecule.multiplicity) : 1;
  const reference = settings.reference
    ? oneLine(settings.reference).toLowerCase()
    : multiplicity > 1 ? 'uhf' : 'rhf';

  const lines = [
    '# NodeChem Studio — generated Psi4 input',
    `# ${oneLine(title, 'Psi4 task').slice(0, 200)}`,
    '# Every line below is written by the app; edit and re-run at your own risk.',
    '',
  ];
  // Issue 173, route B: the CT analysis needs the transition density in the MO
  // basis, and the amplitudes Psi4 stores are keyed to the checkpoint's orbital
  // order. Running in C1 is what makes those two orders the same one, and the
  // Tamm–Dancoff amplitudes are what make the partition normalisable.
  const recordsTransitionDensity = jobType === 'TD-DFT' && settings.recordTransitionDipoles === true;
  if (memoryMb) lines.push(`memory ${Math.max(1, Math.round(memoryMb))} mb`);
  lines.push('', 'molecule {', ...moleculeBlock(molecule, {
    fragments: method.kind === 'sapt',
    symmetry: recordsTransitionDensity ? 'c1' : null,
  }), '}', '');
  lines.push(`set basis ${basis.psi4}`);
  if (method.kind !== 'sapt') lines.push(`set reference ${reference}`);
  // Density fitting is Psi4's default for SCF and its fastest reliable path;
  // writing it makes the run reproducible across Psi4 versions.
  lines.push('set scf_type df');
  const freezeChoice = freezeCoreChoice(settings);
  if (freezeChoice !== null && method.kind === 'correlated') {
    // Only written when the user chose it: 'auto' leaves Psi4's own default in
    // place, so an existing MP2 project produces byte-identical input.
    lines.push(`set freeze_core ${freezeChoice ? 'true' : 'false'}`);
  }
  if (oneLine(settings.scf) === 'tight') {
    lines.push('set e_convergence 1.0e-8');
    lines.push('set d_convergence 1.0e-8');
  }
  lines.push('');

  const fn = method.fn;
  // Issue 167: the solvation request, resolved through the same function the
  // preflight uses, so the deck and the refusal can never disagree about which
  // model or solvent is written.
  const solvation = psi4SolvationFor(settings);
  if (solvation && multiplicity > 1) {
    // Issue 167 + 168: the EPR block reads one `Spin SCF Density` from one
    // checkpoint, and a solvated block runs two SCFs. Picking either density
    // would make the populations describe a different calculation than the one
    // the card names, so the combination is refused instead.
    throw new Error('A solvated Psi4 single point runs two SCFs, so it has no single spin density '
      + 'for the open-shell checkpoint the EPR block reads; run the open-shell single point gas-phase, '
      + 'or the solvated one closed-shell.');
  }
  // Issue 168: an open-shell single point on a single-reference SCF/DFT method
  // also writes the checkpoint, because the spin populations and the
  // Fermi-contact couplings are read from `Spin SCF Density` in that file and
  // from nothing else. Restricted to a single point on purpose: for an
  // optimisation the converged density belongs to the last geometry, and Psi4's
  // `optimize()` does not hand back a wavefunction that can be checked against
  // the log's final energy. Correlated methods are excluded too — their
  // `return_wfn` wavefunction is the SCF reference, and a spin density from the
  // reference presented as the correlated one would be a different calculation
  // wearing this one's name.
  const writesSpinCheckpoint = multiplicity > 1 && jobType === 'SP'
    && (method.kind === 'scf' || method.kind === 'dft');
  if (jobType === 'TD-DFT') {
    // Psi4 splits a scalar request across the point group's irreducible
    // representations, one state per irrep in point-group order, so the number
    // written here is the number of states it will seek, not a promise that they
    // are the n lowest. Measured on ethylene (D2h) with 5 states: five dark
    // states and the bright B1u missing; with 2 per irrep it appears at 12.70 eV,
    // f = 0.4183. The card and the docs state this rather than implying a
    // selection the engine did not make. (A transition-density record runs in C1,
    // where there is one irrep, so the whole request lands in it.)
    lines.push(`set tdscf_states ${Number(settings.tdStates)}`);
    if (recordsTransitionDensity) {
      // Issue 173: the dipole vector is not in the table Psi4 prints, and neither
      // is the transition density, so the wavefunction is read instead and both
      // are written back as `NCS-TDM` and `NCS-TDMAT` records.
      lines.push('set tdscf_tda true');
      lines.push(...transitionDipoleLines(fn, {
        fragmentLabels: (Array.isArray(molecule.coords) ? molecule.coords : []).map((atom) => (
          Number.isInteger(Number(atom?.fragment)) && Number(atom.fragment) >= 1 ? Number(atom.fragment) : 1
        )),
        checkpointName: `${safeName.replace(/\.dat$/i, '')}.fchk`,
      }));
    } else {
      lines.push(`energy('td-${fn}')`);
    }
  } else if (jobType === 'SP') {
    if (solvation) {
      // Issue 167. Two single points at one level, in one script, because the
      // number a user needs is the *difference*: Psi4 prints the solvated total
      // and the DDX solute-solvent interaction, but never the gas-phase energy
      // the solvent is acting on. The first run is left `ddx false` explicitly
      // rather than relying on DDX's default being off, and each energy is
      // echoed with a marker the parser reads by name — a bare `@DF-RHF Final
      // Energy:` appears twice in this log and position alone is not a label.
      //
      // Second-run state does not leak out of Psi4: the gas-phase energy below
      // was reproduced to all twelve printed digits by a standalone gas-phase
      // run of the same deck (test/fixtures/psi4-ddx).
      lines.push('set ddx false');
      lines.push(`E_gas = energy('${fn}')`);
      lines.push('core.print_out("NCS gas-phase energy = %.15f\\n" % E_gas)');
      lines.push('');
      lines.push('set ddx true');
      lines.push(`set ddx_model ${solvation.model.toLowerCase()}`);
      lines.push(`set ddx_solvent ${solvation.solvent}`);
      lines.push(`set ddx_radii_set ${solvation.radiiSet}`);
      lines.push(`set ddx_radii_scaling ${solvation.radiiScaling}`);
      lines.push(`E_solv = energy('${fn}')`);
      lines.push('core.print_out("NCS solvated energy = %.15f\\n" % E_solv)');
    } else if (writesSpinCheckpoint) {
      lines.push(`E, wfn = energy('${fn}', return_wfn=True)`);
      lines.push(`fchk(wfn, '${safeName.replace(/\.dat$/i, '')}.fchk')`);
    } else {
      lines.push(`energy('${fn}')`);
    }
  } else if (jobType === 'Opt') lines.push(`optimize('${fn}')`);
  else if (jobType === 'Freq') lines.push(`frequencies('${fn}')`);
  else {
    lines.push(`optimize('${fn}')`);
    lines.push(`frequencies('${fn}')`);
  }
  lines.push('');

  const outputName = safeName.replace(/\.dat$/i, '.out');
  return {
    engine: PSI4_ENGINE_ID,
    inputName: safeName,
    outputName,
    inputText: lines.join('\n'),
    argv: [safeName],
    route: `psi4 ${method.label}/${basis.label}${freezeChoice === null ? ''
      : freezeChoice ? ' (frozen core)' : ' (all-electron)'}${solvation
      ? ` · ${solvation.model}/${solvation.solvent} (DDX)` : ''}${jobType === 'SP' ? ''
      : jobType === 'TD-DFT' ? ` TD-DFT (${Number(settings.tdStates)} states)` : ` ${jobType}`}`,
    // Recorded for the run record; a Psi4 block has no checkpoint to hand off.
    oldCheckpoint: oneLine(oldCheckpoint) || null,
  };
}

export function isSafePsi4InputName(name) {
  return SAFE_INPUT.test(String(name));
}

export function isSafePsi4OutputName(name) {
  return SAFE_OUTPUT.test(String(name));
}

/** Provenance in Psi4 vocabulary, not a Gaussian route. */
export function psi4MethodBlock(settings = {}, { argv = null, jobType = null } = {}) {
  const method = METHOD_BY_KEY.get(oneLine(settings.method, 'b3lyp').toLowerCase()) || null;
  const basis = BASIS_BY_KEY.get(oneLine(settings.basis, 'def2-svp').toLowerCase()) || null;
  return {
    program: 'Psi4',
    method: method ? method.label : null,
    basis: basis ? basis.label : null,
    jobType: oneLine(jobType, '') || oneLine(settings.jobType, 'SP'),
    dispersion: null,
    // Issue 167: the model, the solvent and the cavity, in the words the deck
    // uses, so two runs are only compared when these match. `null` is a vacuum
    // run — including a block whose solvation request was refused, which never
    // reaches a run record because the builder throws first.
    solvation: (() => {
      try {
        const request = psi4SolvationFor(settings);
        return request
          ? `DDX ${request.model}/${request.solventLabel} (${request.radiiSet} radii x${request.radiiScaling})`
          : null;
      } catch {
        return null;
      }
    })(),
    scf: oneLine(settings.scf) || null,
    // Provenance for the one setting that decides whether a correlated number is
    // comparable with the frozen-core literature at all.
    freezeCore: method && method.kind === 'correlated'
      ? (freezeCoreChoice(settings) === null ? 'engine default'
        : freezeCoreChoice(settings) ? 'frozen core' : 'all-electron')
      : null,
    resources: {
      memoryMb: Number.isFinite(Number(settings.memory)) ? Number(settings.memory)
        * (String(settings.memoryUnit || 'GB').toUpperCase() === 'MW' ? 8
          : String(settings.memoryUnit || 'GB').toUpperCase() === 'MB' ? 1 : 1024) : null,
    },
    argv: Array.isArray(argv) && argv.length > 0 ? argv.map(String) : null,
  };
}

/* ── Output parser ────────────────────────────────────────── */

function versionOf(text) {
  const match = new RegExp(String.raw`Psi4\s+(\d+\.\d+[^\s]*)`, 'i').exec(text);
  const git = new RegExp(String.raw`Git:\s*Rev\s*\{([^}]*)\}\s*(\S+)`, 'i').exec(text);
  return { version: match?.[1] || null, revision: git?.[1] || null };
}

const ATOM = String.raw`([A-Z][a-z]?)`;

/** Every `Geometry (in Angstrom), charge = C, multiplicity = M:` table. */
function geometryBlocks(text) {
  const blocks = [];
  const header = /Geometry \(in Angstrom\), charge = (-?\d+), multiplicity = (\d+):/g;
  let match;
  while ((match = header.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const rest = text.slice(start);
    const stop = rest.search(/\n\s*\n\s*\n|Running in |==> |Rotational constants/);
    const body = stop === -1 ? rest.slice(0, 4000) : rest.slice(0, stop);
    const atoms = [];
    const row = new RegExp(String.raw`^\s*${ATOM}\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})(?:\s+(${NUMBER}))?\s*$`, 'gm');
    let line;
    while ((line = row.exec(body)) !== null) {
      atoms.push({
        element: line[1],
        x: toNumber(line[2]),
        y: toNumber(line[3]),
        z: toNumber(line[4]),
        mass: toNumber(line[5]),
      });
    }
    if (atoms.length > 0) {
      blocks.push({ charge: Number(match[1]), multiplicity: Number(match[2]), atoms });
    }
  }
  return blocks;
}

/** The final structure OptKing prints, which has no masses column. */
function finalStructure(text) {
  const marker = /Final \(previous\) structure:\s*\n\s*Cartesian Geometry \(in Angstrom\)\s*\n([\s\S]{0,4000}?)(?:\n\s*\n|Saving final)/.exec(text);
  if (!marker) return null;
  const atoms = [];
  const row = new RegExp(String.raw`^\s*${ATOM}\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*$`, 'gm');
  let line;
  while ((line = row.exec(marker[1])) !== null) {
    atoms.push({ element: line[1], x: toNumber(line[2]), y: toNumber(line[3]), z: toNumber(line[4]), mass: null });
  }
  return atoms.length > 0 ? atoms : null;
}

/**
 * Normal modes. Psi4 prints a `#  #` block per irrep with `N: value` lines and
 * a negative value for an imaginary mode.
 */
function frequencyBlock(text) {
  const scaling = new RegExp(String.raw`Scaling factor for frequencies\s*=\s*(${NUMBER})`, 'i').exec(text);
  const scalingFactor = scaling ? toNumber(scaling[1]) : null;

  // Psi4 1.1–1.4: a `#  #` block with one `N: value` line per mode.
  const index = text.lastIndexOf('#  #');
  if (index !== -1) {
    const tail = text.slice(index, index + 20000);
    const values = [];
    const row = new RegExp(String.raw`^\s*(\d+):\s*(${NUMBER})\s*$`, 'gm');
    let match;
    while ((match = row.exec(tail)) !== null) {
      const value = toNumber(match[2]);
      if (value !== null) values.push(value);
    }
    if (values.length > 0) return { values, scalingFactor };
  }

  // Psi4 1.9+: a table whose `Freq [cm^-1]` row carries the values, and an
  // imaginary mode written `1234.56i` rather than a negative number.
  const values = [];
  const table = /^\s*Freq \[cm\^-1\]\s+(.+)$/gm;
  let row;
  while ((row = table.exec(text)) !== null) {
    for (const token of row[1].trim().split(/\s+/)) {
      const imaginary = /^(-?[\d.]+)i$/i.exec(token);
      const value = imaginary ? -Math.abs(toNumber(imaginary[1]) ?? 0) : toNumber(token);
      if (value !== null && Number.isFinite(value)) values.push(value);
    }
  }
  return { values, scalingFactor };
}

/**
 * The **last** optimisation in the file. A Psi4 log can hold several jobs; the
 * verdict a user needs is the one that just ran, not the first one in the file.
 */
function optimizationSummary(text) {
  const last = (pattern) => {
    const regex = new RegExp(pattern, 'gi');
    let match;
    let found = null;
    while ((match = regex.exec(text)) !== null) found = { index: match.index, cycles: Number(match[1]) };
    return found;
  };
  const complete = last(String.raw`Optimization is complete!\s*\(in (\d+) steps?\)`);
  const failed = last(String.raw`Optimization has failed!\s*\(in (\d+) steps?\)`);
  const stuck = last(String.raw`Could not converge geometry optimization in (\d+) iterations`);
  // Psi4 1.9+ prints `Optimizer: Optimization complete!` with no step count; the
  // count is the last row of the `Step   Total Energy` table.
  const bareComplete = /Optimizer:\s*Optimization complete!/i.exec(text);
  const bareFailed = /Optimizer:\s*Optimization (?:failed|did not converge)/i.exec(text);
  const stepCount = (() => {
    const start = text.lastIndexOf('Total Energy');
    const tail = text.slice(Math.max(0, start - 200), start + 20000);
    const rows = /^\s+(\d+)\s+-?\d+\.\d+/gm;
    let match;
    let max = null;
    while ((match = rows.exec(tail)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && (max === null || value > max)) max = value;
    }
    return max;
  })();
  const attempted = /==> Optimization Summary <==|OPTKING|Optimization is complete!|Optimization has failed!|Could not converge geometry optimization/i.test(text);
  const newest = [complete, failed, stuck].filter(Boolean).sort((a, b) => a.index - b.index).at(-1) || null;
  if (complete && newest === complete) return { completed: true, cycles: complete.cycles, attempted: true };
  if (newest) return { completed: false, cycles: newest.cycles, attempted: true };
  if (bareComplete) return { completed: true, cycles: stepCount, attempted: true };
  if (bareFailed) return { completed: false, cycles: stepCount, attempted: true };
  return { completed: false, cycles: null, attempted: attempted || null };
}

function saptResults(text) {
  const total = new RegExp(String.raw`Total SAPT0\s+(${NUMBER}) \[mEh\]\s+(${NUMBER}) \[kcal/mol\]`, 'i').exec(text);
  if (!total) return null;
  const component = (name) => {
    const match = new RegExp(String.raw`^\s+${name}\s+(${NUMBER}) \[mEh\]`, 'im').exec(text);
    return match ? toNumber(match[1]) : null;
  };
  const totalMha = toNumber(total[1]);
  return {
    method: 'SAPT0',
    electrostaticMha: component('Electrostatics'),
    exchangeMha: component('Exchange'),
    inductionMha: component('Induction'),
    dispersionMha: component('Dispersion'),
    totalMha,
    totalHartree: totalMha === null ? null : totalMha / 1000,
    totalKcal: toNumber(total[2]),
    totalKj: totalMha === null ? null : (totalMha / 1000) * HARTREE_KJ,
  };
}

/**
 * Issue 167: the DDX solvation block, read from a log this builder produced.
 *
 * Psi4 1.11 + pyddx 1.0.0 print, after the SCF converges in solvent:
 *
 *     @DF-RHF Final Energy:   -75.99469281344876
 *
 *      => Energetics <=
 *
 *       Nuclear Repulsion Energy =              9.1895337585934787
 *       One-Electron Energy =                -123.0280105669744302
 *       Two-Electron Energy =                  37.8552986443188715
 *       DD Solvation Energy =                 -0.0115146493866764
 *       Total Energy =                        -75.9946928134487649
 *
 * `DD Solvation Energy` is the solute-solvent interaction at the converged
 * (solvated) density. It is **not** the energy difference a user means by
 * "how much did the solvent change this": that is the solvated total minus the
 * gas-phase total, and Psi4 never prints the gas-phase one in a solvated run —
 * it is a different calculation. The deck this builder writes therefore runs
 * both and echoes each with a marker; a log without the markers reports the
 * difference as `null` rather than deriving it from the interaction term, which
 * is a different quantity (they differ by 0.8 mEh on water/6-31G*).
 *
 * Nothing here is called ΔG, and no field is initialised to zero: a number the
 * log does not print is `null`.
 */
function solvationBlock(body) {
  const ddxRan = /ddsolvation\.github\.io\/ddX/i.test(body) || /Cavity sphere setup/i.test(body);
  const gasMarker = lastNumber(body, String.raw`NCS gas-phase energy\s*=\s*(${NUMBER})`);
  const solvatedMarker = lastNumber(body, String.raw`NCS solvated energy\s*=\s*(${NUMBER})`);
  const interaction = lastNumber(body, String.raw`DD Solvation Energy\s*=\s*(${NUMBER})`);
  if (!ddxRan && gasMarker === null && solvatedMarker === null && interaction === null) return null;

  // The input echo is the only place the log names the model, the solvent and
  // the cavity: pyddx prints the dielectric constant and the sphere radii, but
  // not the labels. Read as text, never reconstructed from ε.
  const echoed = (option) => {
    const match = new RegExp(String.raw`^\s*set\s+${option}\s+(\S+)\s*$`, 'im').exec(body);
    return match ? match[1] : null;
  };
  const radiiScaling = echoed('ddx_radii_scaling');
  const banner = /ddsolvation\.github\.io\/ddX/i.test(body);
  const pyddxVersion = banner
    ? (/ddsolvation\.github\.io\/ddX[\s\S]{0,240}?Version:\s*(\S+)/i.exec(body)?.[1] ?? null)
    : null;

  // A hand-written deck carries no markers. Then the last unprefixed total *is*
  // the solvated energy (it is the one Psi4 printed last), and the gas-phase
  // energy stays unknown rather than being guessed.
  const solvatedHartree = solvatedMarker ?? (ddxRan ? lastUnprefixedTotal(body) : null);
  const deltaHartree = gasMarker !== null && solvatedHartree !== null
    ? solvatedHartree - gasMarker
    : null;

  return {
    provider: 'ddx',
    pyddxVersion,
    model: echoed('ddx_model')?.toLowerCase() ?? null,
    solvent: echoed('ddx_solvent')?.toLowerCase() ?? null,
    radiiSet: echoed('ddx_radii_set')?.toLowerCase() ?? null,
    radiiScaling: radiiScaling === null ? null : toNumber(radiiScaling),
    dielectricConstant: lastNumber(body, String.raw`solvent_epsilon\s*=\s*(${NUMBER})`),
    gasPhaseHartree: gasMarker,
    solvatedHartree,
    deltaHartree,
    deltaKcal: deltaHartree === null ? null : deltaHartree * HARTREE_KCAL,
    interactionHartree: interaction,
    interactionKcal: interaction === null ? null : interaction * HARTREE_KCAL,
  };
}

function methodFromEcho(text) {
  // The input echo is fenced by dashed rules; the first rule follows the header
  // immediately, so it has to be skipped before the body is captured.
  const echo = /==>\s*Input File <==\s*\n\s*-{10,}\n([\s\S]*?)\n\s*-{10,}/.exec(text);
  if (!echo) return { method: null, basis: null };
  const body = echo[1];
  const call = /(?:energy|optimize|frequencies|gradient)\(\s*'([^']+)'/i.exec(body);
  const basisLine = /^\s*set basis\s+(\S+)\s*$/im.exec(body);
  const basis = basisLine ? BASIS_BY_PSI4.get(basisLine[1].toLowerCase()) : null;
  const method = call
    ? PSI4_METHODS.find((entry) => entry.fn === call[1].toLowerCase()) || null
    : null;
  return { method, basis };
}

/**
 * Parse one Psi4 output.
 *
 * A document without Psi4's banner, energy line or a termination marker is
 * reported as `unrecognised` with no energies — never parsed as if it were
 * Psi4. `Psi4 encountered an error` is an error termination even though Psi4
 * still prints the tail of the log after it.
 */
/**
 * The TDSCF excitation table.
 *
 * Psi4 prints one row per state, sorted by energy:
 *
 *      #   Sym: GS->ES (Trans)        au              eV              au          au (length) …
 *      1     Ag->B1g (1 B1g)     0.31247         8.50279        -78.27484        0.0000 …
 *
 * and, above it, how the request was split across the point group's
 * irreducible representations ("==> Requested Excitations <=="). Both are read:
 * the split is the reason a request for n states can come back without the
 * bright one, and the card has to be able to say so.
 */
function parsePsi4Excitations(body, lines) {
  const split = [];
  let insideSplit = false;
  for (const line of lines) {
    if (/==>\s*Requested Excitations\s*<==/.test(line)) { insideSplit = true; continue; }
    if (insideSplit) {
      const match = /^\s*(\d+)\s+(singlet|triplet|doublet|quartet)\s+states?\s+with\s+(\S+)\s+symmetry\s*$/.exec(line);
      if (match) {
        split.push({ spin: match[2], irrep: match[3], count: Number(match[1]) });
        continue;
      }
      if (split.length > 0) insideSplit = false;
    }
  }

  const states = [];
  // Row shape, with the arrow spelling `GS->ES` and the multiplier/irrep in
  // parentheses; the anchors keep the header and the dashed rule out.
  const row = /^\s*(\d+)\s+(\S+)->(\S+)\s+\((\d+)\s+(\S+)\)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/;
  // The composition block under each state: `1b3u  ->  1b2g   -0.996016 (99.205%)`,
  // with de-excitations printed as `<-`. Kept with their sign: a coefficient is a
  // number, and a state whose leading term is negative is a π→π* with a phase,
  // not a mistake to normalise away.
  const transition = /^\s*(\S+)\s+(->|<-)\s+(\S+)\s+(-?[\d.]+)\s+\(\s*([\d.]+)%\)\s*$/;
  // Psi4 prints the table twice over: a summary table, then one block per state
  // ("Excited State 1 (1 B1g):") carrying its composition. The composition is the
  // more useful record, so a block header re-points at the state it describes
  // instead of letting its transitions attach to whatever row came last.
  const header = /^\s*Excited State\s+(\d+)\s+\((\d+)\s+(\S+)\):/;
  let current = null;
  for (const line of lines) {
    const head = header.exec(line);
    if (head) {
      current = states.find((state) => state.index === Number(head[1])) ?? null;
      continue;
    }
    const mix = transition.exec(line);
    if (mix && current) {
      // Kept in the order Psi4 printed it: the arrow's direction is the
      // `direction` field, so nothing is silently re-oriented.
      current.transitions.push({
        from: mix[1],
        to: mix[3],
        direction: mix[2] === '->' ? 'excitation' : 'de-excitation',
        coefficient: toNumber(mix[4]),
        percent: toNumber(mix[5]),
      });
      continue;
    }
    const match = row.exec(line);
    if (!match) continue;
    const energyEv = toNumber(match[7]);
    current = {
      index: Number(match[1]),
      from: match[2],
      to: match[3],
      multiplicity: Number(match[4]),
      irrep: match[5],
      // The results card labels a state `spin-symmetry`, the way a Gaussian row
      // does; the multiplicity Psi4 printed is the honest source for the word.
      spin: ['Singlet', 'Doublet', 'Triplet', 'Quartet'][Number(match[4]) - 1] ?? null,
      symmetry: match[5],
      transitions: [],
      energyHartree: toNumber(match[6]),
      energyEv,
      // Printed by Psi4 as eV/au; the wavelength is derived from that printed
      // energy rather than from a second, differently-rounded number.
      wavelengthNm: energyEv && energyEv > 0 ? 1239.841984 / energyEv : null,
      totalEnergyHartree: toNumber(match[8]),
      // The scalar the rest of the app reads is the length-form strength, which
      // is the number Gaussian prints as `f=`; the velocity form keeps its own
      // field rather than being folded in or dropped.
      oscillatorStrength: toNumber(match[9]),
      oscillatorStrengthVelocity: toNumber(match[10]),
      rotatoryStrength: toNumber(match[11]),
      rotatoryStrengthVelocity: toNumber(match[12]),
    };
    states.push(current);
  }
  if (states.length === 0) return null;

  // Issue 173: the transition-dipole record the builder writes when the block
  // opts in. `NCS-TDM ROOT <n> <irrep> <x> <y> <z> a.u.` — one line per root, in
  // atomic units, which is what the wavefunction holds and what
  // `exciton.transitionDipoleOf` converts (once) to debye. A state with no line
  // gets no `transitionDipoleAu` field at all: absent, not zero, because a zero
  // dipole and an unrecorded one mean different things to a coupling.
  const dipoles = new Map();
  const tdmRow = new RegExp(String.raw`^\s*NCS-TDM\s+ROOT\s+(\d+)\s+(\S+)\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})(?:\s+(\S+))?\s*$`);
  for (const line of lines) {
    const match = tdmRow.exec(line);
    if (!match) continue;
    // A unit token is optional — the builder always writes `a.u.` — but when one
    // is present and is not atomic units, the numbers are not this quantity and
    // are refused rather than converted by guesswork.
    const unit = match[6];
    if (unit && !/^(au|a\.u\.?)$/i.test(unit)) continue;
    const vector = { x: toNumber(match[3]), y: toNumber(match[4]), z: toNumber(match[5]) };
    if (![vector.x, vector.y, vector.z].every((value) => Number.isFinite(value))) continue;
    dipoles.set(Number(match[1]), vector);
  }
  if (dipoles.size > 0) {
    for (const state of states) {
      const vector = dipoles.get(state.index);
      if (vector) state.transitionDipoleAu = { ...vector };
    }
  }

  // Issue 173, route B: the transition-density record.
  //
  //     NCS-TDMAT ROOT <n> <nocc> <nvir> <tda|rpa>
  //     <nocc lines of nvir amplitudes, TDA/right-eigenvector order>
  //     NCS-TDMAT END <n>
  //
  // A root without a block gets no `transitionDensity` field, so the CT analysis
  // refuses that state by name instead of scoring it 0. A block whose body is
  // short of nocc×nvir numbers is a truncated log, and is dropped (with the
  // states it belonged to) rather than read as a density with rows missing.
  const densityBlocks = new Map();
  const tdmHeader = /^NCS-TDMAT ROOT (\d+) (\d+) (\d+) (\S+)$/;
  const tdmEnd = /^NCS-TDMAT END (\d+)$/;
  for (let index = 0; index < lines.length; index += 1) {
    const header = tdmHeader.exec(lines[index]);
    if (!header) continue;
    const root = Number(header[1]);
    const nocc = Number(header[2]);
    const nvir = Number(header[3]);
    const kind = header[4].toLowerCase();
    const values = new Float64Array(nocc * nvir);
    let filled = 0;
    let closed = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const end = tdmEnd.exec(lines[cursor]);
      if (end) {
        closed = Number(end[1]) === root;
        index = cursor;
        break;
      }
      if (tdmHeader.test(lines[cursor])) break; // the next block started: this one is truncated
      for (const token of lines[cursor].trim().split(/\s+/)) {
        if (!token) continue;
        if (filled >= values.length) break;
        const value = toNumber(token);
        if (!Number.isFinite(value)) {
          filled = -1;
          break;
        }
        values[filled] = value;
        filled += 1;
      }
      if (filled < 0) break;
    }
    if (!closed || filled !== values.length) continue;
    // The tcscf kind is recorded, not assumed: `rpa` amplitudes carry
    // de-excitations and are a different object, and the analysis refuses them.
    densityBlocks.set(root, { nocc, nvir, tda: kind === 'tda', kind, values });
  }
  if (densityBlocks.size > 0) {
    for (const state of states) {
      const block = densityBlocks.get(state.index);
      if (block) state.transitionDensity = { ...block };
    }
  }

  // Issue 173: `NCS-CTFRAG <natoms> <label per atom>` — the fragment each atom
  // belongs to, as the block that wrote the input declared it. Parsed here
  // because it qualifies the transition density, not the geometry.
  let fragmentLabels = null;
  const fragmentRow = /^NCS-CTFRAG\s+(\d+)((?:\s+\d+)+)\s*$/;
  for (const line of lines) {
    const match = fragmentRow.exec(line);
    if (!match) continue;
    const labels = match[2].trim().split(/\s+/).map(Number);
    if (labels.length === Number(match[1])) fragmentLabels = labels;
    break;
  }

  return {
    count: states.length,
    requested: split.reduce((sum, entry) => sum + entry.count, 0) || null,
    perIrrep: split,
    states,
    source: 'tdscf',
    // Number of states that carry a recorded dipole vector. Zero is a fact
    // about the run (the block did not opt in), not a parse failure.
    transitionDipoleCount: states.filter((state) => state.transitionDipoleAu).length,
    /** Number of states that carry a transition density block. */
    transitionDensityCount: states.filter((state) => state.transitionDensity).length,
    /** Fragment label of each atom, or null when the log carries none. */
    fragmentLabels,
    // The table is a documented Psi4 layout and these fixtures are real runs, so
    // unlike the Gaussian Opt-TD parser this one is verified.
    verified: true,
  };
}

/**
 * The branches this parser can take when it decides what a Psi4 log says.
 *
 * Issue 176: `test/fixtureCoverage.test.js` reads this list — never a
 * hand-maintained copy — parses every log in `test/fixtures/real/**` and fails
 * when a branch here is reached by no fixture. Adding a branch without a
 * captured log is therefore a red suite, not a habit.
 *
 * `line` names the output line the branch keys on; `versions` lists the
 * releases that print it (see `PSI4_SUPPORTED_VERSIONS`); `taken` reads the
 * resolution the parser itself recorded, so the entry cannot disagree with the
 * code. `fixture` is only set for a branch no committed log can reach, and the
 * coverage test prints it as a named gap instead of a pass.
 */
export const PSI4_PARSE_BRANCHES = Object.freeze([
  {
    id: 'mp2',
    line: '`Total Energy =` inside a `==> DF-MP2 Energies <==` banner (1.11)',
    also: ['`MP2 Total Energy (a.u.) :` (1.1–1.4)', '`* MP2 total energy =` (1.11 summary)'],
    versions: ['1.1', '1.11'],
    taken: (parsed) => parsed.finalEnergy?.source === 'mp2',
  },
  {
    id: 'ccsd',
    line: '`Total CCSD energy (file100) =` (1.9 and earlier)',
    also: ['`* CCSD total energy =` (1.11 summary)'],
    versions: ['1.1', '1.9', '1.11'],
    taken: (parsed) => parsed.finalEnergy?.source === 'ccsd',
  },
  {
    id: 'ccsd(t)',
    line: '`* CCSD(T) total energy =`',
    versions: ['1.11'],
    taken: (parsed) => parsed.finalEnergy?.source === 'ccsd(t)',
  },
  {
    id: 'sapt',
    line: 'the `SAPT Results` table (`Total SAPT0` row)',
    versions: ['1.1'],
    taken: (parsed) => parsed.finalEnergy?.source === 'sapt-interaction-energy-not-a-total',
  },
  {
    id: 'freq-reference',
    line: '`Total E, Electronic energy at well bottom` in the thermochemistry block',
    also: ['`Total Energy =` is a displaced geometry in a frequency job, so it is not the result'],
    versions: ['1.1', '1.11'],
    taken: (parsed) => parsed.finalEnergy?.source === 'freq-reference',
  },
  {
    id: 'total-energy',
    line: 'a bare `Total Energy =` (no method prefix, no correlated total)',
    versions: ['1.1', '1.4'],
    taken: (parsed) => parsed.finalEnergy?.source === 'total-energy',
  },
  {
    id: 'scf-final',
    line: '`@RHF Final Energy:` / `@DF-RKS Final Energy:`, used when the log stops before its `Total Energy =` row',
    versions: ['1.1', '1.11'],
    taken: (parsed) => parsed.finalEnergy?.source === 'scf-final',
  },
  {
    id: 'scs-mp2-only',
    line: '`==> DF-SCS-MP2 Energies <==` with no `DF-MP2 Energies` banner and no `MP2 Total Energy (a.u.) :` line',
    versions: ['1.11'],
    fixture: 'derived: test/fixtureCoverage.test.js deletes the DF-MP2 banner from psi4-1.11-water-mp2/mp2.log; no real run prints SCS without MP2',
    taken: (parsed) => parsed.finalEnergy?.source === 'scs-mp2-only',
  },
]);

export function parsePsi4Output(text, { truncated = false, argv = null, route = null, fchk = null } = {}) {
  // Psi4 on Windows writes CRLF, and several blocks here are matched with
  // whole-text regular expressions that assume `\n`. Parsing a real Windows log
  // without normalising first lost the method and basis (the input-echo regex
  // never matched) while the energies still parsed — a silent half-parse.
  const body = String(text || '').replace(/\r\n?/g, '\n');
  const lines = body.split(/\r\n|\n|\r/);
  const looksOrca = /ORCA TERMINATED NORMALLY|O\s{2,}R\s{2,}C\s{2,}A/i.test(body);
  const banner = /Psi4:\s*An Open-Source Ab Initio Electronic Structure Package|Psi4\s+\d+\.\d+/i.test(body);
  const energyMarker = /@(?:DF-)?(?:R|U|RO)?(?:HF|KS) Final Energy:|Total Energy\s*=/i.test(body);
  const terminated = /Psi4 exiting successfully|Psi4 encountered an error/i.test(body);
  if (!banner && !energyMarker && !terminated) {
    return canonicalResult({
      engine: PSI4_ENGINE_ID,
      program: { name: looksOrca ? 'not Psi4' : null },
      termination: 'Not Psi4 output',
      terminationCode: TERMINATION.NONE,
      complete: false,
      extras: {
        reason: 'the text carries no Psi4 banner, energy line or termination marker'
          + (looksOrca ? '; it looks like ORCA output' : ''),
      },
      lineCount: lines.length,
    });
  }

  // Psi4's own message is the most specific line: `Fatal Error: PSIO Error`
  // beats a bare `RuntimeError:` with an empty remainder.
  const errorMatch = /Fatal Error:\s*([^\r\n]+)/.exec(body)
    || /RuntimeError:\s*([^\r\n]*)/.exec(body)
    // Issue 167: a missing DDX addon fails as a Python `ModuleNotFoundError`
    // before Psi4's own error handler speaks — `Python module ddx not found.`
    // is the whole diagnosis, and it is the one a solvated run needs.
    || /ModuleNotFoundError:\s*([^\r\n]+)/.exec(body);
  const failedHard = /Psi4 encountered an error\. Buy a developer more coffee!/i.test(body);
  const succeeded = /Psi4 exiting successfully\. Buy a developer a beer!/i.test(body);
  const terminationCode = failedHard ? TERMINATION.ERROR
    : succeeded ? TERMINATION.NORMAL : TERMINATION.NONE;
  const termination = failedHard
    ? `Psi4 encountered an error${errorMatch ? `: ${errorMatch[1].trim()}` : ''}`
    : succeeded ? 'Psi4 exiting successfully' : 'No termination marker';

  const version = versionOf(body);
  const echo = methodFromEcho(body);
  // Not every log echoes a `set basis` line (a basis may be passed straight to
  // the energy call), so fall back to the basis Psi4 names when it loads it.
  const namedBasis = new RegExp(String.raw`Basis Set:\s*(\S+)`, 'i').exec(body)?.[1] || null;
  const basisEntry = echo.basis
    || (namedBasis ? BASIS_BY_PSI4.get(namedBasis.toLowerCase()) || null : null);
  const scfEnergy = lastNumber(body, String.raw`@(?:DF-)?(?:R|U|RO)?(?:HF|KS)\s+Final Energy:\s*(${NUMBER})`);
  // The cycle count of the last SCF block: `iter` numbers restart per job, so
  // the largest number after the final `==> Iterations <==` is the honest count.
  const cycles = (() => {
    const start = body.lastIndexOf('==> Iterations <==');
    const slice = start === -1 ? body : body.slice(start);
    const regex = new RegExp(String.raw`@(?:DF-)?(?:R|U|RO)?(?:HF|KS)\s+iter\s+(\d+):`, 'g');
    let match;
    let max = null;
    while ((match = regex.exec(slice)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && (max === null || value > max)) max = value;
    }
    return max;
  })();
  // Psi4 1.1–1.4 print `Energy converged.`; 1.9+ print `Energy and wave function converged.`
  const scfConverged = /Energy(?: and wave function)? converged\./i.test(body);
  const reference = new RegExp(String.raw`@(?:DF-)?((?:RO|U|R)(?:HF|KS))\s+Final Energy:`).exec(body)?.[1] || null;

  const sapt = saptResults(body);
  // Issue 167: the DDX solvation block, when this log ran one.
  const solvation = solvationBlock(body);
  // Three spellings of the same quantity across Psi4 versions: the old
  // `MP2 Total Energy (a.u.) :` line, the 1.11 `DF-MP2 Energies` banner, and —
  // for CCSD — `Total CCSD energy (file100) =`, which the older regex missed
  // because of the parenthesised file tag.
  const mp2 = lastNumber(body, String.raw`MP2 Total Energy \(a\.u\.\)\s*:\s*(${NUMBER})`)
    ?? bannerTotal(body, /=(?:=)+>\s*(?:DF-)?MP2 Energies\s*<=/)
    ?? lastNumber(body, String.raw`^\s*\*\s*MP2\s+total\s+energy\s*=\s*(${NUMBER})`)
    ?? lastNumber(body, String.raw`@(?:DF-)?MP2 Final Energy:\s*(${NUMBER})`);
  const ccsdT = lastNumber(body, String.raw`CCSD\(T\)\s+total\s+energy\s*=\s*(${NUMBER})`);
  // Two spellings, both real: 1.9 prints `Total CCSD energy (file100) =` and
  // 1.11's summary prints `* CCSD total energy =`.
  const ccsd = lastNumber(body, String.raw`(?:Total\s+CCSD\s+energy|\bCCSD\s+total\s+energy)(?:\s*\([^)]*\))?\s*=\s*(${NUMBER})`);
  const total = lastUnprefixedTotal(body);
  // Issue 176 — the #159 guard. Psi4 1.11 prints an MP2 job's canonical total
  // under `==> DF-MP2 Energies <==` and the spin-component-scaled one under
  // `==> DF-SCS-MP2 Energies <==`, whose row also says `Total Energy`. If the
  // canonical banner is absent (a changed banner, a trimmed log) the honest
  // answer is "not parsed", never the SCS number and never the SCF total that
  // happens to sit above it: both are different methods' energies. The parse
  // reports the branch (`scs-mp2-only`) and names the missing line in
  // `extras.finalEnergyError` instead of guessing.
  const scsMp2Only = mp2 === null
    && /={2,}>\s*(?:DF-)?SCS-MP2 Energies\s*<=/.test(body);
  // A frequency job prints `Total Energy =` once per displaced geometry, so the
  // last one is a displaced point, not the reference. The thermochemistry block
  // states the electronic energy at the well bottom; that is the number the job
  // reports as its result.
  const electronicAtBottom = lastNumber(body, String.raw`Total E(?:_e|_0|0)?, Electronic energy at well bottom(?: at 0 \[K\])?\s+(${NUMBER}) \[Eh\]`);

  let finalEnergy = null;
  let finalSource = null;
  if (echo.method?.kind === 'sapt' || sapt) {
    // SAPT reports an interaction energy, not a total for the complex. Putting
    // its mEh value in `finalEnergy` would invite a gate to compare it with a
    // molecular energy.
    finalEnergy = null;
    finalSource = 'sapt-interaction-energy-not-a-total';
  } else if (ccsdT !== null) {
    // A CCSD(T) job prints the CCSD energy too; the result is the one the job
    // was asked for.
    finalEnergy = ccsdT;
    finalSource = 'ccsd(t)';
  } else if (ccsd !== null) {
    finalEnergy = ccsd;
    finalSource = 'ccsd';
  } else if (mp2 !== null) {
    finalEnergy = mp2;
    finalSource = 'mp2';
  } else if (scsMp2Only) {
    // Refused, not guessed: see the comment where `scsMp2Only` is computed.
    finalEnergy = null;
    finalSource = 'scs-mp2-only';
  } else if (electronicAtBottom !== null) {
    finalEnergy = electronicAtBottom;
    finalSource = 'freq-reference';
  } else if (total !== null) {
    finalEnergy = total;
    finalSource = 'total-energy';
  } else if (scfEnergy !== null) {
    finalEnergy = scfEnergy;
    finalSource = 'scf-final';
  }

  const optimization = optimizationSummary(body);
  const geometries = geometryBlocks(body);
  const lastGeometry = finalStructure(body) || geometries[geometries.length - 1]?.atoms || null;
  const frequencies = frequencyBlock(body);
  const enthalpy = lastNumber(body, String.raw`Total H, Enthalpy at\s+${NUMBER} \[K\]\s+(${NUMBER}) \[Eh\]`);
  const gibbs = lastNumber(body, String.raw`Total G,\s*(?:Free enthalpy|Gibbs energy) at\s+${NUMBER} \[K\]\s+(${NUMBER}) \[Eh\]`);
  const zpe = lastNumber(body, String.raw`Vibrational ZP(?:E|VE)\s+[-\d.]+ \[kcal/mol\]\s+[-\d.]+ \[kJ/mol\]\s+(${NUMBER}) \[Eh\]`);
  const temperature = lastNumber(body, String.raw`Temperature:\s+(${NUMBER}) \[K\]`);

  const imaginary = frequencies.values.filter((value) => value < -0.001);
  const charge = geometries[geometries.length - 1]?.charge ?? null;
  const multiplicity = geometries[geometries.length - 1]?.multiplicity ?? null;

  // Issue 168: the EPR block. The log itself carries no spin population and no
  // spin density, so the numbers come from the checkpoint this run wrote
  // (`Spin SCF Density`), read here and computed by `epr.js`. `fchk` may arrive
  // as text or already parsed; a file that fails to parse is reported as the
  // reason the block is unavailable, never as an empty table. With no
  // checkpoint at all, a closed-shell job still answers in words — that answer
  // needs only the multiplicity, and it is the one acceptance criterion a log
  // alone can settle.
  let checkpoint = null;
  let checkpointError = null;
  if (typeof fchk === 'string' && fchk.trim() !== '') {
    try {
      checkpoint = parseFchk(fchk);
    } catch (error) {
      checkpointError = String(error?.message ?? error);
    }
  } else if (fchk && typeof fchk === 'object') {
    checkpoint = fchk;
  }
  // Issue 173: the level the CT numbers belong to. Psi4's own task line carries
  // the method string and the basis it actually ran with —
  //     Compute energy(): method=td-b3lyp, basis=def2-svp
  // — and that is a better answer than the reference plus a label that may be
  // missing from the echo. Asked for by name, because "property of the transition
  // density at this level of theory" is meaningless without the level. The EPR
  // block keeps the level string it has always printed.
  const ranAs = /Compute energy\(\): method=([A-Za-z0-9_-]+), basis=([^\s,\]]+)/.exec(body);
  const ctLevel = ranAs ? `${ranAs[1]}/${ranAs[2]}` : null;
  const epr = eprBlock({
    fchk: checkpoint,
    level: [reference, echo.method?.label, basisEntry?.label ?? namedBasis].filter(Boolean).join(' ') || null,
    engine: 'Psi4',
    multiplicity,
    unavailableReason: checkpointError
      ? `the checkpoint beside this run could not be read: ${checkpointError}`
      : null,
  });

  // Issue 173, route B: the charge-transfer block, computed from the transition
  // density the log recorded and the checkpoint beside it. It is assembled here,
  // where both are in hand, and travels in the canonical result — a card that
  // had to recompute it would need the whole MO coefficient array.
  const excitations = parsePsi4Excitations(body, lines);
  const chargeTransfer = chargeTransferReport({
    states: excitations?.states ?? [],
    checkpoint,
    fragments: excitations?.fragmentLabels ?? [],
    level: ctLevel
      ?? ([reference, echo.method?.label, basisEntry?.label ?? namedBasis].filter(Boolean).join(' ') || null),
    atoms: Array.isArray(lastGeometry) ? lastGeometry : null,
  });

  const result = canonicalResult({
    engine: PSI4_ENGINE_ID,
    program: { name: 'Psi4', version: version.version, revision: version.revision },
    termination,
    terminationCode,
    complete: !truncated,
    scf: {
      status: scfConverged ? 'converged' : scfEnergy !== null ? 'unknown' : 'unknown',
      energyHartree: scfEnergy,
      cycles,
      method: echo.method?.label ?? null,
      applicable: true,
    },
    optimization: {
      completed: optimization.completed,
      stationary: optimization.completed,
      cycles: optimization.cycles,
      attempted: optimization.attempted,
    },
    excitedStates: excitations,
    epr,
    chargeTransfer,
    frequencies: {
      count: frequencies.values.length,
      imaginaryCount: imaginary.length,
      imaginaryValues: imaginary.slice(0, 20),
      minImaginary: imaginary.length > 0 ? Math.min(...imaginary) : null,
      scalingFactor: frequencies.scalingFactor,
    },
    thermochemistry: {
      freeEnergyHartree: gibbs,
      enthalpyHartree: enthalpy,
      zpeHartree: zpe,
      entropyTreatment: null,
    },
    finalEnergy: { hartree: finalEnergy, source: finalSource },
    // SAPT's interaction energy is the result of a SAPT job, so it is a
    // first-class field rather than something only `extras` knows about. It is
    // deliberately not copied into `finalEnergy`: that number is not a total.
    ...(sapt ? { sapt } : {}),
    // Issue 167: what the solvent did, passed through whole — the model, the
    // solvent, the cavity and all three energies. A consumer that shows the
    // difference must also be able to show which model and cavity made it.
    solvation,
    extras: {
      method: echo.method?.label ?? null,
      methodKey: echo.method?.key ?? null,
      basis: basisEntry?.label ?? namedBasis ?? null,
      reference,
      charge,
      multiplicity,
      temperatureK: temperature,
      finalGeometry: lastGeometry,
      geometryCount: geometries.length,
      sapt,
      errorDetail: errorMatch ? errorMatch[1].trim() : null,
      // Issue 176: when the MP2 banner changed shape, say which line went
      // missing instead of returning a number from the wrong banner.
      finalEnergyError: scsMp2Only
        ? 'no `Total Energy =` line under an `==> DF-MP2 Energies <==` banner and no '
          + '`MP2 Total Energy (a.u.) :` line: this log prints only the `DF-SCS-MP2 Energies` '
          + 'banner, whose total is a different method — refusing to report it as the MP2 result'
        : null,
      hfEnergyHartree: lastNumber(body, String.raw`Total HF\s+(${NUMBER}) \[mEh\]`) === null
        ? null
        : lastNumber(body, String.raw`Total HF\s+(${NUMBER}) \[mEh\]`) / 1000,
    },
    lineCount: lines.length,
  });
  if (route !== null && String(route).trim() !== '') result.route = String(route).trim();
  if (Array.isArray(argv)) result.argv = argv.map(String);
  return result;
}

/**
 * Synthetic output for the dry-run path. Labelled FIXTURE and shaped like the
 * documented Psi4 blocks, so the parser and the gates can be exercised without
 * a Psi4 installation. It is not a calculation and says so on line one.
 */
export function makePsi4FixtureOutput({ imaginary = 0 } = {}) {
  const modes = imaginary > 0 ? [-412.31, 1580.22, 3712.44] : [1713.39, 3728.54, 3850.17];
  return [
    ' FIXTURE OUTPUT — synthetic Psi4 run, not a real calculation',
    '',
    '    -----------------------------------------------------------------------',
    '          Psi4: An Open-Source Ab Initio Electronic Structure Package',
    '                               Psi4 1.9 ',
    '                         Git: Rev {HEAD} fixture',
    '    -----------------------------------------------------------------------',
    '',
    '  ==> Input File <==',
    '',
    '--------------------------------------------------------------------------',
    'molecule {',
    '0 1',
    'O 0.000000 0.000000 -0.068516',
    'H 0.000000 -0.790690 0.543701',
    'H 0.000000 0.790690 0.543701',
    '}',
    'set basis def2-svp',
    "energy('b3lyp')",
    '--------------------------------------------------------------------------',
    '',
    '  ==> Geometry <==',
    '',
    '    Geometry (in Angstrom), charge = 0, multiplicity = 1:',
    '',
    '       Center              X                  Y                   Z               Mass       ',
    '    ------------   -----------------  -----------------  -----------------  -----------------',
    '         O            0.000000000000     0.000000000000    -0.068516219310    15.994914619570',
    '         H            0.000000000000    -0.790689573744     0.543701060724     1.007825032230',
    '         H           -0.000000000000     0.790689573744     0.543701060724     1.007825032230',
    '',
    '  ==> Iterations <==',
    '',
    '                           Total Energy        Delta E     RMS |[F,P]|',
    '',
    '   @DF-RKS iter   1:   -76.37421932789123   -7.63742e+01   1.23345e-02 DIIS',
    '   @DF-RKS iter   8:   -76.42139511922374   -3.21093e-06   4.21188e-06 DIIS',
    '',
    '  Energy converged.',
    '',
    '  @RKS Final Energy:   -76.42139511922374',
    '',
    '   => Energetics <=',
    '',
    '    Total Energy =                        -76.4213951192237400',
    '',
    '  ==> Frequencies <==',
    '',
    ' #  #',
    ' Irrep: 1',
    ...modes.map((value, index) => `      ${index + 1}: ${value.toFixed(7)}`),
    '',
    '  ==> Thermochemistry <==',
    '',
    '  Temperature:                       298.15 [K]',
    '    Vibrational ZPE      13.284 [kcal/mol]      55.578 [kJ/mol]      0.02116896 [Eh]        4646.050 [cm^-1]',
    '  Total H, Enthalpy at  298.15 [K]                                 -76.40000000 [Eh]',
    '  Total G, Free enthalpy at  298.15 [K]                            -76.42100000 [Eh]',
    '',
    '*** Psi4 exiting successfully. Buy a developer a beer!',
    '',
  ].join('\n');
}

/* ── Termination classifier ───────────────────────────────── */

/**
 * Classify a finished Psi4 process.
 *
 * Psi4 prints `Psi4 exiting successfully` even when a job inside the run
 * failed and said so (`Could not converge geometry optimization`, a `Traceback`
 * from one module). Normal exit is therefore a statement about the process, not
 * the science; gates judge the optimisation separately. A `Traceback` with no
 * success line is an error even if the exit code is 0.
 */
export function classifyPsi4Termination(text, exitCode) {
  const body = String(text || '');
  if (/Psi4 encountered an error\. Buy a developer more coffee!/i.test(body)) {
    const detail = /Fatal Error:\s*([^\r\n]+)/.exec(body)?.[1]?.trim()
      || /RuntimeError:\s*([^\r\n]+)/.exec(body)?.[1]?.trim() || null;
    return {
      code: TERMINATION.ERROR,
      reason: detail ? `Psi4 encountered an error: ${detail}` : 'Psi4 encountered an error',
    };
  }
  if (/Psi4 exiting successfully\. Buy a developer a beer!/i.test(body)) {
    return { code: TERMINATION.NORMAL, reason: 'Psi4 exiting successfully' };
  }
  if (/Traceback \(most recent call last\)/i.test(body)) {
    return { code: TERMINATION.ERROR, reason: 'Psi4 raised a Python exception without finishing' };
  }
  const code = Number(exitCode);
  if (Number.isFinite(code) && code !== 0) {
    return { code: TERMINATION.ERROR, reason: `Psi4 exited with code ${code} and printed no termination marker` };
  }
  return { code: TERMINATION.NONE, reason: 'no termination marker' };
}
