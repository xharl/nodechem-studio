/**
 * xTB engine: input builder, output parser, capability table, termination
 * classifier and restart-artifact description.
 *
 * Verified against xtb 6.8.0 on Linux x86_64. Facts that shaped this module:
 *
 * - Output goes to **stdout**; xTB writes no result file. The runner must
 *   capture stdout into the run's output artifact.
 * - Exit status is `0` on success and `128` on any error stop.
 * - `xtbrestart` is read automatically from the working directory, so every run
 *   needs its own directory (the run manager already guarantees this).
 * - The optimised geometry is written to `xtbopt.xyz`, not into the output.
 * - Free energy already uses mRRHO (modified rigid-rotor-harmonic-oscillator),
 *   so no quasi-harmonic correction may be applied on top of it.
 */

import { isElementSymbol, atomicNumber } from '../elements.js';
import { canonicalResult, TERMINATION } from './canonical.js';

export const XTB_ENGINE_ID = 'xtb';

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.xyz$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;

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

/* ── Capabilities ─────────────────────────────────────────── */

export const XTB_METHODS = Object.freeze([
  { id: 'gfn2', label: 'GFN2-xTB' },
  { id: 'gfn1', label: 'GFN1-xTB' },
  { id: 'gfn0', label: 'GFN0-xTB' },
  { id: 'gfnff', label: 'GFN-FF' },
]);

export const XTB_OPT_LEVELS = Object.freeze([
  'crude', 'sloppy', 'loose', 'lax', 'normal', 'tight', 'vtight', 'extreme',
]);

export const XTB_SOLVATION_MODELS = Object.freeze(['ALPB', 'GBSA']);

/** App solvent label → xTB identifier, per model. xTB identifiers are lower-case. */
export const XTB_SOLVENTS = Object.freeze({
  ALPB: Object.freeze({
    Water: 'water',
    Dichloromethane: 'ch2cl2',
    THF: 'thf',
    Toluene: 'toluene',
    Acetonitrile: 'acetonitrile',
  }),
  GBSA: Object.freeze({
    Water: 'h2o',
    Dichloromethane: 'ch2cl2',
    THF: 'thf',
    Toluene: 'toluene',
    Acetonitrile: 'acetonitrile',
  }),
});

/**
 * Job types xTB can honour and the flags each maps to. Anything absent here is
 * refused by the builder rather than silently degraded to a single point.
 */
export const XTB_JOB_FLAGS = Object.freeze({
  SP: () => [],
  Opt: (level) => ['--opt', level],
  'Opt Freq': (level) => ['--ohess', level],
  Freq: () => ['--hess'],
});

export const XTB_UNSUPPORTED_JOB_TYPES = Object.freeze([
  'Opt=TS', 'IRC', 'Scan',
]);

export const XTB_CAPABILITIES = Object.freeze({
  id: XTB_ENGINE_ID,
  label: 'xTB (GFN-xTB)',
  inputExtension: '.xyz',
  outputExtension: '.out',
  capturesStdout: true,
  writesOptimisedGeometryTo: 'xtbopt.xyz',
  restartArtifact: 'xtbrestart',
  exitCodes: Object.freeze({ success: 0, failure: 128 }),
  methods: XTB_METHODS,
  optLevels: XTB_OPT_LEVELS,
  solvationModels: XTB_SOLVATION_MODELS,
  solvents: XTB_SOLVENTS,
  /** GFN2-xTB carries D4 dispersion by default; never add a second correction. */
  builtInDispersion: 'D4',
  jobFlags: XTB_JOB_FLAGS,
  unsupportedJobTypes: XTB_UNSUPPORTED_JOB_TYPES,
  unsupportedFeatures: Object.freeze([
    'transition-state search',
    'IRC',
    'scan / relaxed surface',
    'TD-DFT excited states',
    'NMR shielding',
    'population analysis (NBO/ESP)',
    'basis-set selection',
  ]),
});

/* ── Input builder ────────────────────────────────────────── */

export function xtbMethodFor(settings = {}) {
  const explicit = String(settings.xtbMethod || '').toLowerCase();
  if (XTB_METHODS.some((method) => method.id === explicit)) return explicit;
  return 'gfn2';
}

export function xtbOptLevelFor(settings = {}) {
  const level = String(settings.xtbOptLevel || '').toLowerCase();
  return XTB_OPT_LEVELS.includes(level) ? level : 'normal';
}

/**
 * Dispersion is part of each xTB parameterisation, not a route keyword the
 * user can switch on or off. Recording which model is built into the selected
 * Hamiltonian keeps the manifest from claiming a Gaussian-style `GD3BJ`.
 */
export const XTB_DISPERSION = Object.freeze({
  gfn0: 'D4 (built in)',
  gfn1: 'D3(BJ) (built in)',
  gfn2: 'D4 (built in)',
  gfnff: 'force field (built in)',
});

function argvValue(argv, flag) {
  if (!Array.isArray(argv)) return null;
  const index = argv.indexOf(flag);
  if (index === -1 || argv[index + 1] === undefined) return null;
  const value = oneLine(argv[index + 1]);
  return value && !value.startsWith('--') ? value : null;
}

function hamiltonianFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.includes('--gfnff')) return 'gfnff';
  const value = argvValue(argv, '--gfn');
  if (!value) return null;
  const id = `gfn${value.toLowerCase()}`;
  return XTB_METHODS.some((method) => method.id === id) ? id : null;
}

function jobTypeFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.includes('--ohess')) return 'Opt Freq';
  if (argv.includes('--opt')) return 'Opt';
  if (argv.includes('--hess')) return 'Freq';
  return 'SP';
}

function solvationFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const [flag, model] of [['--alpb', 'ALPB'], ['--gbsa', 'GBSA']]) {
    const solvent = argvValue(argv, flag);
    if (solvent) return `${model}/${solvent}`;
  }
  return null;
}

/**
 * The provenance method block for an xTB run.
 *
 * xTB has no Gaussian route: the Hamiltonian, job flag and solvation model are
 * the argv, and dispersion is part of the parameterisation. When the runner
 * supplies the argv that actually ran, the block is read back from it so the
 * manifest cannot drift from the invocation; `settings` is only the fallback
 * for callers that have not built an argv yet.
 */
export function xtbMethodBlock(settings = {}, { argv = null, jobType = null } = {}) {
  const args = Array.isArray(argv) && argv.length > 0 ? argv.map(String) : null;
  const hamiltonian = hamiltonianFromArgv(args) || xtbMethodFor(settings);
  const type = jobTypeFromArgv(args) || oneLine(jobType, '') || oneLine(settings.jobType, 'SP');
  const isOpt = type === 'Opt' || type === 'Opt Freq';
  const optLevel = isOpt
    ? (args ? argvValue(args, type === 'Opt' ? '--opt' : '--ohess') : xtbOptLevelFor(settings))
    : null;

  let solvation = null;
  if (args) {
    solvation = solvationFromArgv(args);
  } else if (settings.solvation) {
    const model = String(settings.solvationModel || 'ALPB').toUpperCase();
    const solventLabel = oneLine(settings.solvent, 'Water');
    solvation = `${model}/${XTB_SOLVENTS[model]?.[solventLabel] || solventLabel}`;
  }

  return {
    hamiltonian,
    optLevel,
    dispersion: XTB_DISPERSION[hamiltonian] || null,
    solvation,
    argv: args ? [...args] : null,
  };
}

/**
 * Build one xTB input: an XYZ file plus the argv that consumes it.
 *
 * `method`/`basis` from the Gaussian settings are ignored — xTB selects its
 * Hamiltonian with `--gfn`, and honouring a Gaussian basis keyword here would
 * be a lie. The builder refuses job types xTB cannot do instead of downgrading
 * them to a single point.
 */
export function buildXtbInput({
  title = 'xTB task',
  settings = {},
  molecule = {},
  inputName = 'task.xyz',
} = {}) {
  if (!SAFE_INPUT.test(String(inputName))) {
    throw new Error('Input name must be a safe .xyz basename.');
  }

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

  const method = xtbMethodFor(settings);
  const jobType = oneLine(settings.jobType, 'SP');
  const flagBuilder = XTB_JOB_FLAGS[jobType];
  if (!flagBuilder) {
    throw new Error(
      `xTB cannot run "${jobType}". Supported: ${Object.keys(XTB_JOB_FLAGS).join(', ')}. `
      + `Unsupported by this engine: ${XTB_UNSUPPORTED_JOB_TYPES.join(', ')}.`,
    );
  }

  const argv = [inputName];
  if (method === 'gfnff') argv.push('--gfnff');
  else argv.push('--gfn', method.replace('gfn', ''));

  argv.push(...flagBuilder(xtbOptLevelFor(settings)));

  if (charge !== 0) argv.push('--chrg', String(charge));
  if (multiplicity > 1) argv.push('--uhf', String(multiplicity - 1));

  const solventMeta = { model: null, solvent: null, state: 'default (gsolv)' };
  if (settings.solvation) {
    const model = String(settings.solvationModel || 'ALPB').toUpperCase();
    if (!XTB_SOLVATION_MODELS.includes(model)) {
      throw new Error(
        `xTB does not implement ${settings.solvationModel}. Choose ${XTB_SOLVATION_MODELS.join(' or ')}.`,
      );
    }
    const solventLabel = oneLine(settings.solvent, 'Water');
    const solvent = XTB_SOLVENTS[model][solventLabel];
    if (!solvent) {
      throw new Error(`Solvent "${solventLabel}" has no ${model} parameter in xTB.`);
    }
    argv.push(model === 'GBSA' ? '--gbsa' : '--alpb', solvent);
    solventMeta.model = model;
    solventMeta.solvent = solvent;
  }

  const inputText = [
    String(coords.length),
    oneLine(title, 'xTB task'),
    ...coordinateLines,
    '',
  ].join('\n');

  return {
    engine: XTB_ENGINE_ID,
    inputName,
    inputText,
    outputName: String(inputName).replace(/\.xyz$/i, '.out'),
    argv,
    captureStdout: true,
    method,
    jobType,
    charge,
    multiplicity,
    solvation: solventMeta,
    /** Human-readable route, for the inspector preview. */
    route: `${XTB_METHODS.find((item) => item.id === method)?.label || method} ${jobType}`
      + `${settings.solvation && solventMeta.solvent ? ` · ${solventMeta.model} ${solventMeta.solvent}` : ''}`,
  };
}

export function isSafeXtbInputName(name) {
  return SAFE_INPUT.test(String(name));
}

/**
 * Read the solvation choice back from the argv that actually ran. The argv is
 * the authoritative record: it is what xTB consumed and what run.json stores,
 * so provenance cannot disagree with the invocation.
 */
export function xtbSolvationFromArgv(argv = []) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  for (const [flag, model] of [['--alpb', 'ALPB'], ['--gbsa', 'GBSA']]) {
    const index = args.indexOf(flag);
    if (index === -1) continue;
    const solvent = String(args[index + 1] ?? '').trim();
    if (solvent && !solvent.startsWith('--')) return { model, solvent, flag };
  }
  return null;
}

export function isSafeXtbOutputName(name) {
  return SAFE_OUTPUT.test(String(name));
}

/* ── Output parser ────────────────────────────────────────── */

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?`;

function toNumber(token) {
  if (token === undefined || token === null) return null;
  const value = Number(String(token).replace(/[Dd]/, 'E'));
  return Number.isFinite(value) ? value : null;
}

/** Last numeric match of a pattern; xTB prints one summary block per step. */
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

function firstInteger(text, pattern) {
  const match = new RegExp(pattern, 'i').exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Vibrational eigenvalues from the last frequency block. xTB prints all 3N
 * values, including 5–6 near-zero translations/rotations, so callers must not
 * count negatives here — the `# imaginary freq.` counter is authoritative.
 */
function lastFrequencyBlock(lines) {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/projected vibrational frequencies/i.test(lines[index])) start = index;
  }
  if (start === -1) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^\s*eigval\s*:\s*(.+)$/i.exec(line);
    if (!match) {
      if (values.length > 0) break;
      continue;
    }
    for (const token of match[1].trim().split(/\s+/)) {
      const value = toNumber(token);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

function methodIdFor(label) {
  const token = String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (token.includes('gfnff')) return 'gfnff';
  const match = /gfn([012])/.exec(token);
  return match ? `gfn${match[1]}` : null;
}

/**
 * Parse one xTB output text.
 *
 * `truncated` mirrors the Gaussian parser: a partial read can never be
 * reported as complete. `argv` and `route` are the invocation that produced
 * the text; GFN-FF has no Hamiltonian line in its summary, so the argv is the
 * authoritative signal that the result is a force-field energy rather than an
 * SCC result.
 */
export function parseXtbOutput(text, { truncated = false, argv = null, route = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('xTB output must be text.');
  const lines = text.split(/\r\n|\n|\r/);

  const normalTermination = /^normal termination of xtb\b/im.test(text);
  const abnormalTermination = /^abnormal termination of xtb\b/im.test(text);
  const fatalError = /Program stopped due to fatal error|^\s*-1-\s*Error:/im.test(text);
  const runtimeException = /\[WARNING\]\s*Runtime exception occurred|gfnff_setup:\s*Could not read topology file/i.test(text);
  const runtimeExceptionDetail = runtimeException
    ? (/-1-\s*gfnff_setup:[^\r\n]*/i.exec(text)?.[0] || 'xTB runtime exception')
    : null;
  // A plain single point never prints "normal termination of xtb"; it ends with
  // the timing footer. Only optimisations and frequency runs emit the marker.
  const completedFooter = /\*\s*finished run on\s+\d{4}\//i.test(text);

  const terminationCode = (runtimeException || abnormalTermination || fatalError)
    ? TERMINATION.ERROR
    : normalTermination ? TERMINATION.NORMAL
      : completedFooter ? TERMINATION.NORMAL : TERMINATION.NONE;

  const versionMatch = /xtb version\s+([\w.\-]+)\s*\(([0-9a-f]+)\)/i.exec(text);

  const convergenceIterations = firstInteger(text, String.raw`convergence criteria satisfied after\s+(\d+)\s+iterations`);
  const scfFailed = /SCC\s+did\s+not\s+converge|SCC convergence failed|SCF failed/i.test(text);

  const optCycles = firstInteger(text, String.raw`GEOMETRY OPTIMIZATION CONVERGED AFTER\s+(\d+)\s+ITERATIONS`);
  const optimizationCompleted = optCycles !== null;

  const declaredCount = firstInteger(text, String.raw`#\s*frequencies\s+(\d+)`);
  const declaredImaginary = firstInteger(text, String.raw`#\s*imaginary freq\.?\s+(\d+)`);
  const eigenvalues = lastFrequencyBlock(lines);
  const genuineImaginary = eigenvalues.filter((value) => value < -1e-3);

  const imaginaryCount = declaredImaginary !== null
    ? declaredImaginary
    : genuineImaginary.length;
  const minImaginary = imaginaryCount > 0 && genuineImaginary.length > 0
    ? Math.min(...genuineImaginary)
    : null;

  const totalEnergy = lastNumber(text, String.raw`::\s*total energy\s+(${NUMBER})\s+Eh`)
    ?? lastNumber(text, String.raw`\|\s*TOTAL ENERGY\s+(${NUMBER})\s+Eh`);

  const freeEnergy = lastNumber(text, String.raw`\|\s*TOTAL FREE ENERGY\s+(${NUMBER})\s+Eh`)
    ?? lastNumber(text, String.raw`::\s*total free energy\s+(${NUMBER})\s+Eh`);
  const enthalpy = lastNumber(text, String.raw`\|\s*TOTAL ENTHALPY\s+(${NUMBER})\s+Eh`);
  const zeroPoint = lastNumber(text, String.raw`::\s*zero point energy\s+(${NUMBER})\s+Eh`);
  const entropyTreatment = /entropy treatment\s+(\S+)/i.exec(text)?.[1] || null;
  const scalingFactor = lastNumber(text, String.raw`scaling factor\s+(${NUMBER})`);
  const homoLumoGap = lastNumber(text, String.raw`HOMO-LUMO gap\s+(${NUMBER})\s+eV`);
  const gradientNorm = lastNumber(text, String.raw`gradient norm\s+(${NUMBER})\s+Eh`);
  // The summary table reports the Hamiltonian explicitly: `:  Hamiltonian  GFN2-xTB  :`
  const hamiltonian = /^\s*:\s*Hamiltonian\s+(\S+)\s*:/im.exec(text)?.[1] || null;
  const methodId = hamiltonianFromArgv(argv) || methodIdFor(hamiltonian);
  const forceField = methodId === 'gfnff';
  const scfStatus = runtimeException ? 'failed'
    : forceField ? 'unknown'
      : scfFailed ? 'failed'
        : (convergenceIterations !== null || terminationCode === TERMINATION.NORMAL) ? 'converged'
          : 'unknown';

  const result = canonicalResult({
    engine: XTB_ENGINE_ID,
    program: {
      name: 'xtb',
      version: versionMatch?.[1] || null,
      revision: versionMatch?.[2] || null,
    },
    termination: runtimeException
      ? 'normal termination of xtb (runtime exception)'
      : normalTermination ? 'normal termination of xtb'
        : abnormalTermination ? 'abnormal termination of xtb'
          : completedFooter ? 'completed (timing footer, no explicit marker)'
            : 'No termination marker',
    terminationCode,
    complete: !truncated,
    scf: {
      status: scfStatus,
      energyHartree: forceField ? null : totalEnergy,
      cycles: forceField ? null : convergenceIterations,
      method: hamiltonian || (forceField ? 'GFN-FF' : null),
      applicable: !forceField,
    },
    optimization: {
      completed: optimizationCompleted,
      stationary: optimizationCompleted,
      cycles: optCycles,
    },
    frequencies: {
      count: declaredCount ?? eigenvalues.length,
      imaginaryCount,
      imaginaryValues: genuineImaginary.slice(0, 20),
      minImaginary,
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
      hartree: totalEnergy,
      source: totalEnergy !== null ? (forceField ? 'force-field' : 'scc') : null,
    },
    extras: {
      homoLumoGapEv: homoLumoGap,
      gradientNorm,
      optimisedGeometryFile: /optimized geometry written to:\s*(\S+)/i.exec(text)?.[1] || null,
      runtimeException,
      runtimeExceptionDetail,
    },
    lineCount: lines.length,
  });
  if (route !== null && String(route).trim() !== '') result.route = String(route).trim();
  return result;
}

/**
 * Synthetic output for the no-xTB "dry run" path. Explicitly labelled FIXTURE
 * and shaped like a real xTB single point, so the full parser and gate path can
 * be exercised without the binary installed.
 */
export function makeXtbFixtureOutput({ imaginary = 0 } = {}) {
  const modes = imaginary > 0 ? [0, 0, 0, 0, 0, 0, -420.0, 610.0, 1580.0] : [0, 0, 0, 0, 0, 0, 610.0, 1580.0, 3650.0];
  const eigvalLines = [];
  for (let index = 0; index < modes.length; index += 6) {
    eigvalLines.push(`eigval : ${modes.slice(index, index + 6).map((value) => value.toFixed(2).padStart(10)).join('')}`);
  }
  const lines = [
    ' FIXTURE OUTPUT — synthetic xTB run, not a real calculation',
    '',
    '   * xtb version 6.8.0 (fixture) compiled by fixture',
    '',
    ':                      SETUP                      :',
    `:  # frequencies                           ${Math.max(modes.length - 6, 0)}      :`,
    `:  # imaginary freq.                        ${imaginary}      :`,
    ':  entropy treatment                   mRRHO      :',
    '',
    '          :  Hamiltonian                  GFN2-xTB          :',
    '',
    '   *** convergence criteria satisfied after 8 iterations ***',
    '',
    '         ::                     SUMMARY                     ::',
    '         :: total energy              -5.070370764545 Eh    ::',
    '         :: HOMO-LUMO gap             14.629674472571 eV    ::',
    '',
    ' projected vibrational frequencies (cm⁻¹)',
    ...eigvalLines,
    '',
  ];
  if (imaginary > 0 || modes.length > 6) {
    lines.push(
      '         :::::::::::::::::::::::::::::::::::::::::::::::::::::',
      '         ::                  THERMODYNAMIC                  ::',
      '         :::::::::::::::::::::::::::::::::::::::::::::::::::::',
      '         :: total free energy          -5.068048760159 Eh   ::',
      '         :: zero point energy           0.020120983614 Eh   ::',
      '',
      '           -------------------------------------------------',
      '          | TOTAL ENERGY               -5.070544442589 Eh   |',
      '          | TOTAL ENTHALPY             -5.046642479269 Eh   |',
      '          | TOTAL FREE ENERGY          -5.068048760159 Eh   |',
      '           -------------------------------------------------',
      '',
      ' *** GEOMETRY OPTIMIZATION CONVERGED AFTER 5 ITERATIONS ***',
    );
  }
  lines.push('', 'normal termination of xtb', '');
  return lines.join('\n');
}

/** Parse `xtbopt.xyz` into the canonical geometry block. */
export function parseXtbGeometry(xyzText) {
  const lines = String(xyzText || '').split(/\r\n|\n|\r/);
  const count = Number(lines[0]);
  if (!Number.isInteger(count) || count <= 0) return null;
  const atoms = [];
  for (let index = 0; index < count; index += 1) {
    const line = lines[index + 2];
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return null;
    const [element, x, y, z] = parts;
    if (!isElementSymbol(element)) return null;
    atoms.push({ element, x: Number(x), y: Number(y), z: Number(z) });
  }
  return { source: 'xtbopt.xyz', atoms };
}

/* ── Termination classifier ───────────────────────────────── */

/**
 * Classify a finished xTB process. Both signals are required: the exit code
 * alone is not a verdict (exit 128 is an error stop, but a crashed or killed
 * process may carry any code), and the text alone cannot distinguish a killed
 * run from a clean one.
 */
export function classifyXtbTermination(text, exitCode) {
  const code = Number(exitCode);
  const body = String(text || '');
  const normal = /^normal termination of xtb\b/im.test(body);
  const abnormal = /^abnormal termination of xtb\b/im.test(body);
  const fatal = /Program stopped due to fatal error|^\s*-1-\s*Error:/im.test(body);
  const runtime = /\[WARNING\]\s*Runtime exception occurred|gfnff_setup:\s*Could not read topology file/i.test(body);
  const completedFooter = /\*\s*finished run on\s+\d{4}\//i.test(body);

  if (runtime) {
    const detail = /-1-\s*gfnff_setup:[^\r\n]*/i.exec(body)?.[0] || 'xTB runtime exception';
    return { code: TERMINATION.ERROR, reason: detail };
  }
  if (normal) return { code: TERMINATION.NORMAL, reason: 'normal termination of xtb' };
  if (abnormal || fatal) {
    return {
      code: TERMINATION.ERROR,
      reason: abnormal ? 'abnormal termination of xtb' : 'fatal error without termination marker',
    };
  }
  if (completedFooter && (!Number.isFinite(code) || code === 0)) {
    return { code: TERMINATION.NORMAL, reason: 'completed (single point prints no termination marker)' };
  }
  if (Number.isFinite(code) && code !== 0) {
    return { code: TERMINATION.ERROR, reason: `xTB exited with code ${code} and printed no termination marker` };
  }
  return { code: TERMINATION.NONE, reason: 'no termination marker' };
}
