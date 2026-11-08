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
 * - Anything Psi4 core does not implement (implicit solvation, NBO, GIAO NMR,
 *   TD-DFT through this builder) is refused by name instead of approximated.
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

export const PSI4_ENGINE_ID = 'psi4';

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

export const PSI4_JOB_TYPES = Object.freeze(['SP', 'Opt', 'Freq', 'Opt Freq']);

export const PSI4_UNSUPPORTED_JOB_TYPES = Object.freeze(['Opt=TS', 'IRC', 'Scan', 'NMR']);

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
  solvationModels: Object.freeze([]),
  jobTypes: PSI4_JOB_TYPES,
  unsupportedJobTypes: PSI4_UNSUPPORTED_JOB_TYPES,
  unsupportedFeatures: Object.freeze([
    'implicit solvation (Psi4 core has no PCM/SMD; that needs PCMSolver)',
    'transition-state search',
    'IRC and relaxed scans',
    'TD-DFT excited states through this builder',
    'NMR shieldings',
    'NBO populations (an external NBO program, not Psi4 core)',
    'separate dispersion corrections (choose a D3-carrying functional instead)',
    'Gaussian-style checkpoints and routes',
    'frequency gradients for CCSD/CCSD(T)',
  ]),
});

/* ── Settings refusals ────────────────────────────────────── */

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
 * Settings a Psi4 block cannot honour, each with the reason.
 *
 * The list is deliberately about *this builder*: Psi4 can do more than the
 * builder writes (external solvation, NBO via a separate program). Refusing is
 * the honest answer to "this block asks for something the input will not say".
 */
export function psi4SettingsOffenders(settings = {}) {
  const offenders = [];
  const text = (value) => oneLine(value);

  // `solvation` is a boolean in the schema, so the guard has to test the value:
  // `String(false)` is "false", which is truthy, and a solvent name is a field
  // the schema always fills ('Water') whether or not solvation was asked for.
  // Testing their text refused every Psi4 block, including the default ones.
  // A legacy file that stored a model name ('PCM') still counts as a request.
  const solvationRaw = settings.solvation;
  const solvationOn = solvationRaw === true
    || (typeof solvationRaw === 'string'
      && solvationRaw.trim() !== ''
      && !['false', '0', 'off', 'no'].includes(solvationRaw.trim().toLowerCase()));
  if (solvationOn) {
    offenders.push({
      field: 'solvation',
      message: 'Psi4 core has no implicit solvation model; this builder cannot write PCM/SMD.',
    });
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
  if (settings.tddft === true || settings.excitedStates || text(settings.td)) {
    offenders.push({
      field: 'tddft',
      message: 'TD-DFT is not wired for Psi4 in this build; the input would run a different job.',
    });
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
  if (text(settings.jobType) && PSI4_UNSUPPORTED_JOB_TYPES.includes(text(settings.jobType))) {
    offenders.push({
      field: 'jobType',
      message: `${text(settings.jobType)} is not supported for Psi4 blocks in this build.`,
    });
  }
  return offenders;
}

export function assertPsi4Settings(settings = {}) {
  const offenders = psi4SettingsOffenders(settings);
  if (offenders.length > 0) {
    throw new Error(offenders[0].message);
  }
}

/* ── Input builder ────────────────────────────────────────── */

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
 */
function moleculeBlock(molecule = {}, { fragments = false } = {}) {
  const coords = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (coords.length === 0) throw new Error('A molecule with Cartesian coordinates is required.');
  const charge = Number.isInteger(Number(molecule.charge)) ? Number(molecule.charge) : 0;
  const multiplicity = Number.isInteger(Number(molecule.multiplicity)) ? Number(molecule.multiplicity) : 1;

  const lines = [];
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
  if (memoryMb) lines.push(`memory ${Math.max(1, Math.round(memoryMb))} mb`);
  lines.push('', 'molecule {', ...moleculeBlock(molecule, { fragments: method.kind === 'sapt' }), '}', '');
  lines.push(`set basis ${basis.psi4}`);
  if (method.kind !== 'sapt') lines.push(`set reference ${reference}`);
  // Density fitting is Psi4's default for SCF and its fastest reliable path;
  // writing it makes the run reproducible across Psi4 versions.
  lines.push('set scf_type df');
  if (oneLine(settings.scf) === 'tight') {
    lines.push('set e_convergence 1.0e-8');
    lines.push('set d_convergence 1.0e-8');
  }
  lines.push('');

  const fn = method.fn;
  if (jobType === 'SP') lines.push(`energy('${fn}')`);
  else if (jobType === 'Opt') lines.push(`optimize('${fn}')`);
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
    route: `psi4 ${method.label}/${basis.label}${jobType === 'SP' ? '' : ` ${jobType}`}`,
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
    solvation: null,
    scf: oneLine(settings.scf) || null,
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
export function parsePsi4Output(text, { truncated = false, argv = null, route = null } = {}) {
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
    || /RuntimeError:\s*([^\r\n]*)/.exec(body);
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
  const mp2 = lastNumber(body, String.raw`MP2 Total Energy \(a\.u\.\)\s*:\s*(${NUMBER})`);
  const ccsd = lastNumber(body, String.raw`Total\s+CCSD\s+energy\s*=\s*(${NUMBER})`);
  const total = lastNumber(body, String.raw`Total Energy\s*=\s*(${NUMBER})`);
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
  } else if (ccsd !== null) {
    finalEnergy = ccsd;
    finalSource = 'ccsd';
  } else if (mp2 !== null) {
    finalEnergy = mp2;
    finalSource = 'mp2';
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
