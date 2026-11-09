/**
 * ORCA engine: simple-input builder, output parser, capability table,
 * termination classifier and provenance block.
 *
 * ORCA is the first non-Gaussian electronic-structure engine in the app. The
 * module deliberately writes only ORCA's *simple input* (`!` keywords plus the
 * `%pal`, `%maxcore` and `%cpcm` blocks); anything that would need a `%geom`,
 * `%irc` or `%elprop` block is refused instead of being approximated by a
 * keyword that would run a different job.
 *
 * Output formats are taken from the ORCA 6.0 manual and tutorials, not from a
 * live binary:
 *
 * - `ORCA TERMINATED NORMALLY` / `ORCA finished by error termination in <module>`
 * - `SCF CONVERGED AFTER  N CYCLES` / `SCF NOT CONVERGED AFTER N CYCLES`
 * - `FINAL SINGLE POINT ENERGY  <Eh>` (printed once per geometry step)
 * - `***********************HURRAY********************` + `THE OPTIMIZATION HAS CONVERGED`
 * - `VIBRATIONAL FREQUENCIES` numbered `N:  value cm**-1`, negatives marked
 *   `***imaginary mode***`
 * - `THERMOCHEMISTRY AT 298.15K`, `Zero point energy`, `Total Enthalpy`,
 *   `Final Gibbs free energy`
 *
 * The single-point, SCF, frequency and thermochemistry shapes are now pinned by two real ORCA 5.0
 * logs (`test/fixtures/real/orca-5.0-water-mp2/`, `.../orca-5.0-dvb-ir/`). The optimisation banner
 * has no captured log (issue 176 prints it as a named gap), so it is still taken from the manual and
 * must not be described as verified against a running ORCA.
 */

import { isElementSymbol, atomicNumber } from '../elements.js';
import { canonicalResult, TERMINATION } from './canonical.js';

export const ORCA_ENGINE_ID = 'orca';

/**
 * ORCA releases whose output lines this parser was written against.
 *
 * Issue 176: `test/fixtureCoverage.test.js` refuses a fixture whose
 * PROVENANCE.md names a release missing here. `5.0` is now pinned by two real
 * cclib captures (`dvb_ir.out`, `water_mp2.out`); `6.0` is the manual the
 * remaining line shapes were taken from and still has no captured log.
 */
export const ORCA_SUPPORTED_VERSIONS = Object.freeze(['5.0', '6.0']);

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.inp$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?`;

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

/** Last numeric capture of a pattern. ORCA repeats blocks per geometry step. */
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

/* ── Capabilities ─────────────────────────────────────────── */

/**
 * Methods this builder can spell as one ORCA keyword.
 *
 * `ωB97X-D` is intentionally absent: ORCA offers `wB97X-D3` and `wB97X-D4`,
 * which are different functionals/dispersion combinations from the Gaussian
 * keyword the app stores. Mapping one to the other would silently change the
 * level of theory, so the builder refuses it and asks for an explicit choice.
 */
export const ORCA_METHODS = Object.freeze([
  { id: 'B3LYP', label: 'B3LYP' },
  { id: 'PBE0', label: 'PBE0' },
  { id: 'M06-2X', label: 'M06-2X' },
  { id: 'MP2', label: 'MP2' },
  { id: 'CCSD(T)', label: 'CCSD(T)' },
  { id: 'HF', label: 'Hartree-Fock' },
]);

const METHOD_BY_KEY = new Map(ORCA_METHODS.map((method) => [method.id.toLowerCase(), method.id]));

/**
 * App basis label → ORCA keyword. ORCA lists the Pople sets with the Gaussian
 * `(d)`/`(d,p)` names; `6-31G(d)` (heavy-atom polarisation only) is ORCA's
 * `6-31G*`. SDD is absent: ORCA's Stuttgart-Dresden sets are selected by a
 * different keyword family, so a Gaussian `SDD` request is refused rather than
 * guessed.
 */
export const ORCA_BASES = Object.freeze([
  { id: 'def2-SVP', label: 'def2-SVP', keyword: 'def2-SVP' },
  { id: 'def2-TZVP', label: 'def2-TZVP', keyword: 'def2-TZVP' },
  { id: 'cc-pVTZ', label: 'cc-pVTZ', keyword: 'cc-pVTZ' },
  { id: '6-31G(d)', label: '6-31G(d)', keyword: '6-31G*' },
  { id: '6-311+G(d,p)', label: '6-311+G(d,p)', keyword: '6-311+G(d,p)' },
]);

const BASIS_BY_KEY = new Map(ORCA_BASES.map((basis) => [basis.id.toLowerCase(), basis]));
const BASIS_BY_KEYWORD = new Map(ORCA_BASES.map((basis) => [basis.keyword.toLowerCase(), basis]));

export const ORCA_DISPERSION_KEYWORDS = Object.freeze({
  GD3BJ: 'D3BJ',
  GD3: 'D3ZERO',
  D4: 'D4',
});

export const ORCA_SOLVATION_MODELS = Object.freeze(['CPCM', 'SMD']);

/** App solvent label → ORCA solvent table name, used by both CPCM and SMD. */
export const ORCA_SOLVENTS = Object.freeze({
  Water: 'WATER',
  Dichloromethane: 'CH2CL2',
  THF: 'THF',
  Toluene: 'TOLUENE',
  Acetonitrile: 'ACETONITRILE',
});

/**
 * Job types the simple-input builder can express. `Freq` is a numerical or
 * analytical Hessian at the input geometry; `Opt Freq` is ORCA's documented
 * compound job (optimise, then compute frequencies at the minimum).
 */
export const ORCA_JOB_KEYWORDS = Object.freeze({
  SP: Object.freeze([]),
  Opt: Object.freeze(['Opt']),
  'Opt Freq': Object.freeze(['Opt', 'Freq']),
  Freq: Object.freeze(['Freq']),
});

export const ORCA_UNSUPPORTED_JOB_TYPES = Object.freeze(['Opt=TS', 'IRC', 'Scan', 'NMR']);

export const ORCA_UNSUPPORTED_JOB_REASONS = Object.freeze({
  'Opt=TS': 'a transition-state search needs an initial Hessian and mode specification written in a %geom block',
  IRC: 'an IRC needs a %irc block naming the transition mode and direction',
  Scan: 'a relaxed PES scan needs a %geom Scan block naming the scanned coordinate',
  NMR: 'NMR shieldings need a %elprop block with an explicit nucleus list',
});

export const ORCA_CAPABILITIES = Object.freeze({
  id: ORCA_ENGINE_ID,
  label: 'ORCA 6',
  inputExtension: '.inp',
  outputExtension: '.out',
  /**
   * ORCA writes its log to stdout; the caller redirects or captures it. This is
   * why the run surface must treat the captured stream as the artifact even
   * though ORCA also leaves `.gbw`, `.xyz` and `.hess` files behind.
   */
  capturesStdout: true,
  writesOptimisedGeometryTo: '<job>.xyz',
  restartArtifact: '.gbw',
  exitCodes: Object.freeze({ success: 0 }),
  methods: ORCA_METHODS,
  basisSets: ORCA_BASES,
  dispersionSchemes: Object.freeze(['D3BJ', 'D3ZERO', 'D4']),
  solvationModels: ORCA_SOLVATION_MODELS,
  solvents: ORCA_SOLVENTS,
  jobTypes: Object.freeze(Object.keys(ORCA_JOB_KEYWORDS)),
  unsupportedJobTypes: ORCA_UNSUPPORTED_JOB_TYPES,
  unsupportedFeatures: Object.freeze([
    'transition-state search (OptTS)',
    'IRC',
    'relaxed PES scan',
    'TD-DFT excited states',
    'NMR shieldings',
    'population analysis (NBO/ESP)',
    'Gaussian-style checkpoint hand-off (%Chk)',
    'Gaussian PCM keyword (ORCA implements CPCM/SMD)',
  ]),
});

/* ── Settings refusals ────────────────────────────────────── */

/**
 * Gaussian-only settings an ORCA block must not carry.
 *
 * The xTB engine refuses the same class of setting through the pre-run
 * validity check. ORCA is not in that registry yet, so the builder performs
 * the refusal itself: a run that cannot honour a setting is stopped with a
 * message naming the field instead of quietly producing a different job.
 */
export function orcaSettingsOffenders(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
  return [
    ['Custom route keywords', text(source.customKeywords)],
    ['TD-DFT states', Number(source.tdStates) > 0 ? String(source.tdStates) : ''],
    ['TD-DFT triplets', Number(source.tdTriplets) > 0 ? String(source.tdTriplets) : ''],
    ['Stable=Opt', source.stableOpt === true ? 'true' : ''],
    ['Raman activities', source.raman === true ? 'true' : ''],
    ['Population analysis', text(source.population)],
  ]
    .filter(([, value]) => value !== '')
    .map(([label, value]) => ({ label, value }));
}

export function assertOrcaSettings(settings = {}) {
  const [offender] = orcaSettingsOffenders(settings);
  if (offender) {
    throw new Error(
      `${offender.label} cannot be used on an ORCA block. `
      + 'Choose the Gaussian engine for this block, or clear the setting.',
    );
  }
}

/* ── Level of theory ──────────────────────────────────────── */

export function orcaMethodFor(settings = {}) {
  const requested = oneLine(settings.method, 'B3LYP');
  const keyword = METHOD_BY_KEY.get(requested.toLowerCase());
  if (!keyword) {
    throw new Error(
      `ORCA has no simple-input keyword for method "${requested}". `
      + `Supported by this builder: ${ORCA_METHODS.map((method) => method.id).join(', ')}.`,
    );
  }
  return keyword;
}

export function orcaBasisFor(settings = {}) {
  const requested = oneLine(settings.basis, 'def2-SVP');
  const basis = BASIS_BY_KEY.get(requested.toLowerCase());
  if (!basis) {
    throw new Error(
      `ORCA has no simple-input keyword for basis "${requested}" in this builder. `
      + `Supported: ${ORCA_BASES.map((item) => item.id).join(', ')}.`,
    );
  }
  return basis;
}

function dispersionKeywordFor(settings = {}) {
  const requested = oneLine(settings.dispersion);
  if (!requested) return null;
  const keyword = ORCA_DISPERSION_KEYWORDS[requested.toUpperCase()];
  if (!keyword) {
    throw new Error(
      `ORCA has no keyword for dispersion "${requested}". `
      + `Supported: ${Object.keys(ORCA_DISPERSION_KEYWORDS).join(', ')}.`,
    );
  }
  return keyword;
}

function scfKeywordFor(settings = {}) {
  const requested = oneLine(settings.scf);
  if (!requested) return null;
  if (requested === 'Tight') return 'TightSCF';
  if (requested === 'VeryTight') return 'VeryTightSCF';
  throw new Error(`ORCA has no SCF keyword for "${requested}". Supported: Tight, VeryTight.`);
}

function gridKeywordFor(settings = {}) {
  const requested = oneLine(settings.grid);
  if (!requested) return null;
  if (requested === 'Fine') return 'DEFGRID2';
  if (requested === 'UltraFine') return 'DEFGRID3';
  throw new Error(`ORCA has no integration-grid keyword for "${requested}". Supported: Fine, UltraFine.`);
}

function optKeywordFor(settings = {}, jobType = 'SP') {
  if (!String(jobType).startsWith('Opt')) return null;
  const requested = oneLine(settings.optConvergence);
  if (!requested) return null;
  if (requested === 'Tight') return 'TightOpt';
  if (requested === 'VeryTight') return 'VeryTightOpt';
  throw new Error(`ORCA has no optimisation keyword for "${requested}". Supported: Tight, VeryTight.`);
}

/* ── Input builder ────────────────────────────────────────── */

function solvationFor(settings = {}) {
  if (!settings.solvation) return null;
  const model = String(settings.solvationModel || 'CPCM').toUpperCase();
  if (!ORCA_SOLVATION_MODELS.includes(model)) {
    throw new Error(
      `ORCA does not implement ${settings.solvationModel}. Choose ${ORCA_SOLVATION_MODELS.join(' or ')}.`,
    );
  }
  const solventLabel = oneLine(settings.solvent, 'Water');
  const solvent = ORCA_SOLVENTS[solventLabel];
  if (!solvent) {
    throw new Error(`Solvent "${solventLabel}" has no ORCA ${model} entry in this builder.`);
  }
  return { model, solvent, label: solventLabel };
}

function resourcesFor(settings = {}) {
  const nprocs = Number(settings.nproc);
  const cores = Number.isInteger(nprocs) && nprocs > 0 ? nprocs : null;
  const memory = Number(settings.memory);
  if (!Number.isFinite(memory) || memory <= 0) return { nprocs: cores, maxcoreMb: null };
  // Gaussian memory is a total; %maxcore is MB per process. MW is 8 bytes.
  const totalMb = String(settings.memoryUnit || 'GB').toUpperCase() === 'MW'
    ? memory * 8
    : String(settings.memoryUnit || 'GB').toUpperCase() === 'MB' ? memory : memory * 1024;
  const perCore = Math.max(1, Math.floor(totalMb / (cores || 1)));
  return { nprocs: cores, maxcoreMb: perCore };
}

/**
 * Build one ORCA simple input.
 *
 * `inputName` may arrive as `.gjf` from the existing workflow planner, which
 * names inputs for the Gaussian branch. ORCA only reads `.inp`, so the
 * extension is rewritten here and the returned `inputName` is the name the
 * runner writes. Anything else is validated strictly.
 */
export function buildOrcaInput({
  title = 'ORCA task',
  settings = {},
  molecule = {},
  inputName = 'task.inp',
  oldCheckpoint = '',
} = {}) {
  const requested = oneLine(inputName, 'task.inp');
  const safeName = requested.replace(/\.(gjf|com)$/i, '.inp');
  if (!SAFE_INPUT.test(safeName)) {
    throw new Error('Input name must be a safe .inp basename.');
  }

  assertOrcaSettings(settings);

  const coords = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (coords.length === 0) throw new Error('A molecule with Cartesian coordinates is required.');

  const charge = finiteNumber(molecule.charge ?? settings.charge ?? 0, 'Charge', { min: -20, max: 20 });
  if (!Number.isInteger(charge)) throw new Error('Charge must be an integer.');
  const multiplicity = finiteNumber(
    molecule.multiplicity ?? settings.multiplicity ?? 1,
    'Multiplicity',
    { min: 1, max: 20 },
  );
  if (!Number.isInteger(multiplicity)) throw new Error('Multiplicity must be an integer.');

  const coordinateLines = coords.map((atom, index) => {
    const element = oneLine(atom.element);
    if (!isElementSymbol(element)) throw new Error(`Atom ${index + 1} has an invalid element symbol.`);
    const x = finiteNumber(atom.x, `Atom ${index + 1} x`);
    const y = finiteNumber(atom.y, `Atom ${index + 1} y`);
    const z = finiteNumber(atom.z, `Atom ${index + 1} z`);
    return `${element.padEnd(2)} ${x.toFixed(6).padStart(12)} ${y.toFixed(6).padStart(12)} ${z.toFixed(6).padStart(12)}`;
  });

  // Electron parity: an even electron count needs an odd multiplicity.
  const electrons = coords.reduce((total, atom) => total + (atomicNumber(oneLine(atom.element)) || 0), 0) - charge;
  const parityOk = electrons % 2 === 0 ? multiplicity % 2 === 1 : multiplicity % 2 === 0;
  if (!parityOk) {
    throw new Error(
      `${electrons} electrons (charge ${charge}) is incompatible with multiplicity ${multiplicity}.`,
    );
  }

  const method = orcaMethodFor(settings);
  const basis = orcaBasisFor(settings);
  const jobType = oneLine(settings.jobType, 'SP');
  const jobKeywords = ORCA_JOB_KEYWORDS[jobType];
  if (!jobKeywords) {
    const reason = ORCA_UNSUPPORTED_JOB_REASONS[jobType];
    throw new Error(
      `ORCA simple input cannot express the "${jobType}" job type`
      + `${reason ? `: ${reason}` : ''}. `
      + `Supported: ${Object.keys(ORCA_JOB_KEYWORDS).join(', ')}.`,
    );
  }

  const keywords = ['!', method, basis.keyword, ...jobKeywords];
  const dispersion = dispersionKeywordFor(settings);
  if (dispersion) keywords.push(dispersion);
  const scf = scfKeywordFor(settings);
  if (scf) keywords.push(scf);
  const grid = gridKeywordFor(settings);
  if (grid) keywords.push(grid);
  const opt = optKeywordFor(settings, jobType);
  if (opt) keywords.push(opt);

  const solvation = solvationFor(settings);
  if (solvation) keywords.push(`CPCM(${solvation.solvent})`);

  const resources = resourcesFor(settings);

  const blocks = [];
  if (resources.nprocs) blocks.push(`%pal nprocs ${resources.nprocs} end`);
  if (resources.maxcoreMb) blocks.push(`%maxcore ${resources.maxcoreMb}`);
  if (oldCheckpoint) {
    const name = oneLine(oldCheckpoint);
    if (!/\.gbw$/i.test(name)) {
      throw new Error('ORCA checkpoint hand-off requires a .gbw file from an ORCA block.');
    }
    blocks.push(`%moinp "${name}"`);
  }
  // SMD is switched on in the %cpcm block; the CPCM keyword above supplies the
  // cavity model and solvent. ORCA 5 and 6 both read this documented form.
  if (solvation && solvation.model === 'SMD') {
    blocks.push('%cpcm', '  smd true', `  smdsolvent "${solvation.solvent}"`, 'end');
  }

  const inputText = [
    keywords.join(' '),
    `# ${oneLine(title, 'ORCA task')}`,
    ...blocks,
    '',
    `* xyz ${charge} ${multiplicity}`,
    ...coordinateLines,
    '*',
    '',
  ].join('\n');

  return {
    engine: ORCA_ENGINE_ID,
    inputName: safeName,
    inputText,
    outputName: safeName.replace(/\.inp$/i, '.out'),
    argv: [safeName],
    captureStdout: true,
    method,
    basis: basis.id,
    basisKeyword: basis.keyword,
    jobType,
    charge,
    multiplicity,
    dispersion,
    solvation: solvation
      ? { model: solvation.model, solvent: solvation.solvent, label: solvation.label }
      : { model: null, solvent: null, label: null },
    resources,
    /** Human-readable simple-input line, for the inspector preview. */
    route: keywords.join(' ').replace(/^!\s*/, ''),
  };
}

export function isSafeOrcaInputName(name) {
  return SAFE_INPUT.test(String(name));
}

export function isSafeOrcaOutputName(name) {
  return SAFE_OUTPUT.test(String(name));
}

/**
 * The provenance block for an ORCA run.
 *
 * It records ORCA vocabulary (functional, basis keyword, dispersion keyword,
 * SCF/grid keywords) rather than a Gaussian route. `run.json` also stores the
 * exact input text and its hash, which is the authoritative record.
 */
export function orcaMethodBlock(settings = {}, { argv = null, jobType = null } = {}) {
  const type = oneLine(jobType, '') || oneLine(settings.jobType, 'SP');
  const basis = BASIS_BY_KEY.get(oneLine(settings.basis, 'def2-SVP').toLowerCase()) || null;
  const solvation = solvationFor(settings);
  return {
    program: 'ORCA',
    method: METHOD_BY_KEY.get(oneLine(settings.method, 'B3LYP').toLowerCase()) || null,
    basis: basis ? basis.keyword : null,
    jobType: type,
    dispersion: dispersionKeywordFor(settings),
    solvation: solvation ? `${solvation.model}/${solvation.solvent}` : null,
    scf: scfKeywordFor(settings),
    grid: gridKeywordFor(settings),
    resources: resourcesFor(settings),
    argv: Array.isArray(argv) && argv.length > 0 ? argv.map(String) : null,
  };
}

/** ORCA restart data lives in `<job>.gbw`; a Gaussian `.chk` name maps to it. */
export function orcaCheckpointArtifact({ checkpointName = '', nodeId = 'task' } = {}) {
  const raw = oneLine(checkpointName) || `${oneLine(nodeId, 'task')}.gbw`;
  if (/\.gbw$/i.test(raw)) return raw;
  if (/\.chk$/i.test(raw)) return raw.replace(/\.chk$/i, '.gbw');
  return `${raw}.gbw`;
}

/* ── Output parser ────────────────────────────────────────── */

/** The `!` line ORCA echoes back near the top of every output. */
function simpleInputLine(text) {
  const lines = [];
  const regex = /^\s*\|\s*\d+>\s*!(.*)$/gm;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const line = match[1].replace(/[\r\n]+/g, ' ').trim();
    if (line) lines.push(line);
  }
  return lines.join(' ').trim();
}

function levelFromEcho(echo) {
  const tokens = String(echo || '').split(/\s+/).map((token) => token.replace(/^!+/, '')).filter(Boolean);
  let method = null;
  let basis = null;
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (!method && METHOD_BY_KEY.has(key)) method = METHOD_BY_KEY.get(key);
    if (!basis && BASIS_BY_KEYWORD.has(key)) basis = BASIS_BY_KEYWORD.get(key).keyword;
  }
  return { method, basis };
}

/** Values from the last vibrational-frequency block, in cm^-1. */
function lastFrequencyBlock(lines) {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*VIBRATIONAL FREQUENCIES\s*$/i.test(lines[index])) start = index;
  }
  if (start === -1) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*VIBRATIONAL FREQUENCIES\s*$/i.test(lines[index])) break;
    const match = new RegExp(String.raw`^\s*\d+:\s+(${NUMBER})\s+cm\*\*-1`, 'i').exec(lines[index]);
    if (match) {
      const value = toNumber(match[1]);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

/**
 * Branches of the ORCA parser, read by `test/fixtureCoverage.test.js` (issue 176).
 *
 * `line` names the printed line the branch keys on, `taken` reads a field the
 * parse already resolved. An entry carrying `fixture` is reported as a named gap
 * instead of a pass.
 */
export const ORCA_PARSE_BRANCHES = Object.freeze([
  {
    id: 'final-single-point',
    line: '`FINAL SINGLE POINT ENERGY      -74.999373814715`',
    versions: ['5.0'],
    taken: (parsed) => parsed.finalEnergy?.source === 'final-single-point',
  },
  {
    id: 'scf',
    line: '`SCF CONVERGED AFTER  10 CYCLES` and its `Total Energy       :` row',
    versions: ['5.0'],
    taken: (parsed) => Number.isFinite(parsed.scf?.energyHartree),
  },
  {
    id: 'frequencies',
    line: '`VIBRATIONAL FREQUENCIES` with `  6:      1580.42 cm**-1` rows',
    versions: ['5.0'],
    taken: (parsed) => (parsed.frequencies?.count ?? 0) > 0,
  },
  {
    id: 'thermochemistry',
    line: '`THERMOCHEMISTRY AT 298.15K` and `Final Gibbs free energy         ...   -381.9 Eh`',
    versions: ['5.0'],
    taken: (parsed) => parsed.thermochemistry?.freeEnergyHartree !== null
      && parsed.thermochemistry?.freeEnergyHartree !== undefined,
  },
  {
    id: 'optimization',
    line: '`THE OPTIMIZATION HAS CONVERGED` under the `HURRAY` banner',
    versions: ['5.0'],
    fixture: 'blocked: no ORCA optimisation log captured; cclib\'s dvb_gopt.out is 514 kB and was not committed',
    taken: (parsed) => parsed.optimization?.completed === true,
  },
]);

/**
 * Parse one ORCA 5/6 output text.
 *
 * A document that does not carry ORCA's banner, version line, termination line
 * or `FINAL SINGLE POINT ENERGY` marker is reported as `unrecognised` with no
 * energies — never parsed as if it were ORCA.
 */
export function parseOrcaOutput(text, { truncated = false, argv = null, route = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('ORCA output must be text.');
  const body = text;
  const lines = body.split(/\r\n|\n|\r/);

  const looksOrca = /Program Version\s+\d+\.\d+[^\r\n]*-\s*(?:RELEASE|BETA|DEV)/i.test(body)
    || /^\s*\*{0,4}\s*ORCA TERMINATED NORMALLY\s*\*{0,4}\s*$/im.test(body)
    || /ORCA finished by error termination/i.test(body)
    || /FINAL SINGLE POINT ENERGY/i.test(body)
    || /^\s*\*\s*O\s+R\s+C\s+A\s*\*\s*$/im.test(body);

  if (!looksOrca) {
    const result = canonicalResult({
      engine: ORCA_ENGINE_ID,
      termination: 'Not ORCA output',
      terminationCode: TERMINATION.NONE,
      complete: !truncated,
      extras: {
        unrecognised: true,
        reason: 'the text carries no ORCA banner, version line, termination marker or final single-point energy',
      },
      lineCount: lines.length,
    });
    if (route !== null && String(route).trim() !== '') result.route = String(route).trim();
    return result;
  }

  const versionMatch = /Program Version\s+([0-9][\w.\-]*)\s+-\s*(RELEASE|BETA|DEV(?:ELOPMENT)?)/i.exec(body);

  const errorModule = /ORCA finished by error termination in\s+([^\r\n]+)/i.exec(body)?.[1]?.trim() || null;
  const errorTermination = Boolean(errorModule)
    || /\.{0,}\s*aborting the run/i.test(body)
    || /FATAL ERROR ENCOUNTERED/i.test(body);
  const normalTermination = /^\s*\*{0,4}\s*ORCA TERMINATED NORMALLY\s*\*{0,4}\s*$/im.test(body);

  const terminationCode = errorTermination
    ? TERMINATION.ERROR
    : normalTermination ? TERMINATION.NORMAL : TERMINATION.NONE;

  // The last SCF banner wins: a step can fail and a restart can converge.
  let scfStatus = 'unknown';
  let scfCycles = null;
  for (const line of lines) {
    const converged = new RegExp(String.raw`SCF CONVERGED AFTER\s+(\d+)\s+CYCLES`, 'i').exec(line);
    const failed = new RegExp(String.raw`SCF NOT CONVERGED AFTER\s+(\d+)\s+CYCLES`, 'i').exec(line);
    if (converged) {
      scfStatus = 'converged';
      scfCycles = Number(converged[1]);
    } else if (failed) {
      scfStatus = 'failed';
      scfCycles = Number(failed[1]);
    }
  }
  // An error termination inside the SCF module is evidence the last SCF did
  // not converge, even when an earlier geometry step printed a success banner.
  if (errorModule && /\bSCF\b/i.test(errorModule)) scfStatus = 'failed';

  const scfEnergy = lastNumber(body, String.raw`Total Energy\s+:\s+(${NUMBER})\s+Eh`);
  // ORCA's last `FINAL SINGLE POINT ENERGY` is the total printed energy and
  // includes the dispersion correction; the SCF total above does not.
  const finalEnergy = lastNumber(body, String.raw`FINAL SINGLE POINT ENERGY\s+(${NUMBER})`);

  const echo = simpleInputLine(body);
  const level = levelFromEcho(echo);
  // "Did this run ask for an optimisation?" must not be true for a Freq-only
  // job: ORCA prints a Hessian for Freq, but no geometry is relaxed.
  const echoOpt = /\bopt\b/i.test(echo) ? true : echo ? false : null;

  const optimizationConverged = /THE OPTIMIZATION HAS CONVERGED/i.test(body);
  const optimizationFailed = /The optimization did not converge but reached the maximum number/i.test(body);
  const optimizationAttempted = optimizationConverged
    || /GEOMETRY OPTIMIZATION RUN|OPTIMIZATION RUN DONE|Geometry convergence/i.test(body)
    || echoOpt === true;
  const optimizationCycles = Number(
    new RegExp(String.raw`FINAL ENERGY EVALUATION AT THE STATIONARY POINT[\s\S]{0,400}?\(AFTER\s+(\d+)\s+CYCLES\)`, 'i').exec(body)?.[1] ?? NaN,
  );

  const frequencies = lastFrequencyBlock(lines);
  const imaginary = frequencies.filter((value) => value < -1e-3);
  const declaredImaginary = (body.match(/\*\*\*imaginary mode\*\*\*/gi) || []).length;

  const freeEnergy = lastNumber(body, String.raw`Final Gibbs free (?:energy|enthalpy)\s*\.{0,}\s*(${NUMBER})\s+Eh`)
    ?? lastNumber(body, String.raw`Final Gibbs free (?:energy|enthalpy)\s+(${NUMBER})\s+Eh`);
  const enthalpy = lastNumber(body, String.raw`Total Enthalpy\s*\.{0,}\s*(${NUMBER})\s+Eh`);
  const zeroPoint = lastNumber(body, String.raw`Zero point energy\s*\.{0,}\s*(${NUMBER})\s+Eh`);
  const scalingFactor = lastNumber(body, String.raw`Scaling factor for frequencies\s*=\s*(${NUMBER})`);
  const temperatureK = toNumber(/THERMOCHEMISTRY AT\s+([\d.]+)\s*K/i.exec(body)?.[1]);
  const entropyTreatment = /Vibrational entropy computed according to the QRRHO/i.test(body)
    ? 'QRRHO'
    : null;

  const jobType = echo ? (/\bopt\b/i.test(echo) && /\bfreq\b/i.test(echo) ? 'Opt Freq'
    : /\bopt\b/i.test(echo) ? 'Opt'
      : /\bfreq\b/i.test(echo) ? 'Freq' : 'SP') : null;

  const result = canonicalResult({
    engine: ORCA_ENGINE_ID,
    program: {
      name: 'ORCA',
      version: versionMatch?.[1] || null,
      revision: versionMatch?.[2] || null,
    },
    termination: errorModule
      ? `ORCA finished by error termination in ${errorModule}`
      : errorTermination ? 'ORCA aborted the run'
        : normalTermination ? 'ORCA TERMINATED NORMALLY'
          : 'No termination marker',
    terminationCode,
    complete: !truncated,
    scf: {
      status: scfStatus,
      energyHartree: scfEnergy,
      cycles: scfCycles,
      method: level.method,
      applicable: true,
    },
    optimization: {
      completed: optimizationConverged,
      stationary: optimizationConverged,
      cycles: Number.isInteger(optimizationCycles) ? optimizationCycles : null,
      attempted: optimizationAttempted ? true : echoOpt === false ? false : null,
    },
    frequencies: {
      count: frequencies.length,
      imaginaryCount: declaredImaginary > 0 ? declaredImaginary : imaginary.length,
      imaginaryValues: imaginary.slice(0, 20),
      minImaginary: imaginary.length > 0 ? Math.min(...imaginary) : null,
      scalingFactor,
      entropyTreatment,
    },
    thermochemistry: {
      freeEnergyHartree: freeEnergy,
      enthalpyHartree: enthalpy,
      zpeHartree: zeroPoint,
      entropyTreatment,
    },
    finalEnergy: {
      hartree: finalEnergy,
      source: finalEnergy !== null ? 'final-single-point' : null,
    },
    extras: {
      simpleInput: echo || null,
      basis: level.basis,
      jobType,
      dispersionCorrectionHartree: lastNumber(body, String.raw`Dispersion correction\s+(${NUMBER})`),
      thermochemistryTemperatureK: temperatureK,
      optimisedGeometryFile: optimizationConverged && Array.isArray(argv) && argv[0]
        ? String(argv[0]).replace(/\.[^.]+$/, '.xyz')
        : null,
      errorModule,
      optimizationFailed,
      scfNotConverged: scfStatus === 'failed',
    },
    lineCount: lines.length,
  });
  if (route !== null && String(route).trim() !== '') result.route = String(route).trim();
  return result;
}

/**
 * Synthetic output for the no-ORCA "dry run" path. Explicitly labelled FIXTURE
 * and shaped like the documented ORCA 6 blocks, so the parser and gates can be
 * exercised without the binary installed.
 */
export function makeOrcaFixtureOutput({ imaginary = 0 } = {}) {
  const modes = imaginary > 0
    ? [0, 0, 0, 0, 0, 0, -83.22, 435.79, 544.50]
    : [0, 0, 0, 0, 0, 0, 435.79, 544.50, 3812.53];
  const modeLines = modes.map((value, index) => {
    const label = value < -1e-3 ? ' ***imaginary mode***' : '';
    return `${String(index).padStart(6)}:  ${value.toFixed(2).padStart(10)} cm**-1${label}`;
  });
  return [
    ' FIXTURE OUTPUT — synthetic ORCA run, not a real calculation',
    '',
    '                                 *****************',
    '                                 * O   R   C   A *',
    '                                 *****************',
    '',
    '                         Program Version 6.0.0  -   RELEASE  -',
    '',
    '|  1> ! B3LYP def2-SVP Opt Freq D3BJ',
    '',
    '               *****************************************************',
    '               *                     SUCCESS                       *',
    '               *           SCF CONVERGED AFTER  10 CYCLES          *',
    '               *****************************************************',
    '',
    '----------------',
    'TOTAL SCF ENERGY',
    '----------------',
    '',
    'Total Energy       :         -76.026648124651 Eh',
    '',
    '-------------------------   --------------------',
    'FINAL SINGLE POINT ENERGY     -76.067231252000',
    '-------------------------   --------------------',
    '',
    '                    ***********************HURRAY********************',
    '                    ***        THE OPTIMIZATION HAS CONVERGED     ***',
    '                    *************************************************',
    '',
    '                  *** FINAL ENERGY EVALUATION AT THE STATIONARY POINT ***',
    '                  ***               (AFTER    8 CYCLES)               ***',
    '',
    '-----------------------',
    'VIBRATIONAL FREQUENCIES',
    '-----------------------',
    '',
    'Scaling factor for frequencies =  1.000000000  (already applied!)',
    '',
    ...modeLines,
    '',
    '--------------------------',
    'THERMOCHEMISTRY AT 298.15K',
    '--------------------------',
    '',
    'Zero point energy                ...      0.02100000 Eh      13.18 kcal/mol',
    'Total Enthalpy                    ...    -76.04500000 Eh',
    '',
    '-------------------',
    'GIBBS FREE ENERGY',
    '-------------------',
    '',
    'Total enthalpy                    ...    -76.04500000 Eh',
    'Final Gibbs free energy         ...    -76.06700000 Eh',
    '',
    'Vibrational entropy computed according to the QRRHO of S. Grimme',
    '',
    '                             ****ORCA TERMINATED NORMALLY****',
    'TOTAL RUN TIME: 0 days 0 hours 0 minutes 12 seconds 345 msec',
    '',
  ].join('\n');
}

/* ── Termination classifier ───────────────────────────────── */

/**
 * Classify a finished ORCA process. ORCA can finish an unconverged
 * optimisation with `ORCA TERMINATED NORMALLY`, so normal termination is a
 * statement about the process, never about the science; gates judge the
 * optimisation separately. A non-zero exit without a marker is still an error.
 */
export function classifyOrcaTermination(text, exitCode) {
  const body = String(text || '');
  const errorModule = /ORCA finished by error termination in\s+([^\r\n]+)/i.exec(body)?.[1]?.trim() || null;
  if (errorModule) {
    return { code: TERMINATION.ERROR, reason: `ORCA finished by error termination in ${errorModule}` };
  }
  if (/\.{0,}\s*aborting the run|FATAL ERROR ENCOUNTERED/i.test(body)) {
    return { code: TERMINATION.ERROR, reason: 'ORCA aborted the run without naming a module' };
  }
  if (/^\s*\*{0,4}\s*ORCA TERMINATED NORMALLY\s*\*{0,4}\s*$/im.test(body)) {
    return { code: TERMINATION.NORMAL, reason: 'ORCA TERMINATED NORMALLY' };
  }
  const code = Number(exitCode);
  if (Number.isFinite(code) && code !== 0) {
    return { code: TERMINATION.ERROR, reason: `ORCA exited with code ${code} and printed no termination marker` };
  }
  return { code: TERMINATION.NONE, reason: 'no termination marker' };
}
