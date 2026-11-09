/**
 * Before a queue starts: an estimate of wall time and core-seconds, with the
 * uncertainty stated rather than hidden (issue 143).
 *
 * Every coefficient in `ENGINE_MODELS` below was derived from a log that is
 * committed to this repository. Nothing here is a guess dressed as a
 * measurement, and nothing returns a single reassuring number.
 *
 * ## What is measured
 *
 * The calibration points are in `MEASUREMENTS`. Each one names its file, the
 * atom count, the basis-function count the program printed, the SCF cycle count
 * (where the log prints one), and the CPU and wall seconds the program reported.
 *
 *   Gaussian 16 (B3LYP)
 *     water, 6-31G(d)   SP          19 bf,  9 cycles,  2.0 CPU s /  1.6 wall s, 4 cores
 *     water, 6-31G(d)   SP (NB O)   19 bf,  9 cycles,  2.0 CPU s /  1.2 wall s, 4 cores
 *     water, 6-31G(d)   Opt         19 bf,  4 steps,   9.0 CPU s /  6.9 wall s, 4 cores
 *     water, 6-31G(d)   Freq        19 bf,             6.0 CPU s /  4.1 wall s, 4 cores
 *     DVB,   STO-3G     SP          60 bf,  1 cycle,   2.2 CPU s /  2.1 wall s, 1 core
 *     DVB,   STO-3G     Opt         60 bf,  5 steps,  50.1 CPU s / 50.1 wall s, 1 core
 *     DVB,   STO-3G     Freq        60 bf,            69.8 CPU s / 70.0 wall s, 1 core
 *     DVB,   STO-3G     TD, 5 states 60 bf,           45.0 CPU s /  6.0 wall s, 8 cores
 *   Psi4 1.11
 *     water, def2-SVP   MP2         24 bf,             0.98 CPU s / 1.43 wall s, 1 thread
 *     water, def2-SVP   CCSD(T)     24 bf,             1.06 CPU s / 1.50 wall s, 1 thread
 *     water, def2-SVP   B3LYP Freq  24 bf,            15.94 CPU s /18.03 wall s, 1 thread
 *   ORCA 5.0 (prints wall time only; core-seconds are taken as wall seconds)
 *     water, STO-3G     MP2          7 bf,                            6.095 wall s, 4 procs
 *     DVB,   STO-3G     Freq        60 bf,                          138.241 wall s, 2 procs
 *   xTB 6.6.1
 *     water             Opt Freq     3 atoms,                          0.211 wall s, 1 core
 *
 * One failed Gaussian log was deliberately left out of the fit:
 * `g16-meoh-scf-error.log` used 45,716 CPU seconds over 22.5 minutes because the
 * SCF never converged. No model of honest jobs predicts a pathological SCF, and
 * averaging that point in would inflate every other estimate.
 *
 * ## What is assumed, not measured
 *
 * - The size exponent. Three SCF-sized jobs span only 19–60 basis functions and
 *   they co-vary with cycle count, so the corpus cannot determine whether cost
 *   grows as N^2, N^3 or N^4. The fit fixes **N^3** (the middle of the
 *   literature range) and records that choice in every task's `basis`. xTB is
 *   semi-empirical and uses N^2; that is an assumption too.
 * - SCF cycles for a new molecule. The water anchor converged in 9 cycles; a
 *   new DFT single point is assumed to do the same. A tighter SCF convergence
 *   setting adds 3 cycles (stated in `basis`).
 * - Optimisation step count. The two measured optimisations took 4 and 5 steps;
 *   a new one is assumed to take 5. `optMaxCycles` is a ceiling, not an
 *   expected value, so it is deliberately not used as the prediction.
 * - Parallel efficiency 0.65, and a 1.0 s process startup floor. The water
 *   single point used 2.0 CPU seconds in 1.6 wall seconds on 4 cores (an
 *   efficiency near 0.3 at that size); the 20-atom frequency job used 69.8 CPU
 *   seconds in 70.0 wall seconds on one core. 0.65 is a middle value, labelled.
 * - A 5 % wall penalty per additional concurrent task, for scheduler and memory
 *   contention. Not measured; it keeps the wall total from pretending that a
 *   queue scales perfectly.
 * - Method adjustment when the requested method class was not the measured one.
 *   Directions are physical (CCSD(T) > MP2 > DFT at the same size) but the
 *   factors are assumptions and widen the range.
 *
 * ## What is refused
 *
 * A composite method (G4, CBS-QB3, …) is a toolchain this model does not
 * describe, so it returns `notEstimated`. So does an unknown engine, an
 * unmeasured job type, a basis whose contracted-function count is not in the
 * table, and a geometry whose element composition is unknown. A refusal is a
 * sentence with a reason, never zero and never a number.
 *
 * ## Calibration hook
 *
 * `timingFromRunRecord()` reads the `startedAt`/`finishedAt` pair that
 * `run.json` has always carried (issue 177 also records a timeout's elapsed
 * time) and returns one observation. It does not write to a run record and adds
 * no schema key: it is the input a later re-fit needs, kept beside the
 * expectations it would replace.
 */

import { isCompositeJobType } from './routePresets.js';

export const MODEL_VERSION = 1;
export const MODEL_DATE = '2026-11-09';
export const OVERNIGHT_SECONDS = 8 * 60 * 60;
export const DEFAULT_CORES = 8;
export const DEFAULT_TIMEOUT_SECONDS = 3600;
export const PARALLEL_EFFICIENCY = 0.65;
export const STARTUP_SECONDS = 1.0;
export const CONCURRENCY_CONTENTION = 0.05;
export const SCF_EXPONENT = 3;
export const XTB_EXPONENT = 2;

/** One row per committed log used to fit the coefficients. */
export const MEASUREMENTS = Object.freeze([
  {
    id: 'g16-water-sp',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: '6-31G(d)',
    jobType: 'SP',
    atoms: 3,
    basisFunctions: 19,
    cycles: 9,
    cores: 4,
    coreSeconds: 2.0,
    wallSeconds: 1.6,
    source: 'test/fixtures/real/g16-a03-water-sp.out',
  },
  {
    id: 'g16-water-hirshfeld',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: '6-31G(d)',
    jobType: 'SP',
    atoms: 3,
    basisFunctions: 19,
    cycles: 9,
    cores: 4,
    coreSeconds: 2.0,
    wallSeconds: 1.2,
    source: 'test/fixtures/real/g16-a03-water-hirshfeld.out',
  },
  {
    id: 'g16-water-opt',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: '6-31G(d)',
    jobType: 'Opt',
    atoms: 3,
    basisFunctions: 19,
    steps: 4,
    cores: 4,
    coreSeconds: 9.0,
    wallSeconds: 6.9,
    source: 'test/fixtures/real/g16-a03-water-optfreq.out',
  },
  {
    id: 'g16-water-freq',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: '6-31G(d)',
    jobType: 'Freq',
    atoms: 3,
    basisFunctions: 19,
    cores: 4,
    coreSeconds: 6.0,
    wallSeconds: 4.1,
    source: 'test/fixtures/real/g16-a03-water-optfreq.out',
  },
  {
    id: 'g16-dvb-sp',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: 'STO-3G',
    jobType: 'SP',
    atoms: 20,
    basisFunctions: 60,
    cycles: 1,
    cores: 1,
    coreSeconds: 2.2,
    wallSeconds: 2.1,
    source: 'test/fixtures/real/g16-dvb-sp.out',
  },
  {
    id: 'g16-dvb-opt',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: 'STO-3G',
    jobType: 'Opt',
    atoms: 20,
    basisFunctions: 60,
    steps: 5,
    cores: 1,
    coreSeconds: 50.1,
    wallSeconds: 50.1,
    source: 'test/fixtures/real/g16-dvb-gopt.out',
  },
  {
    id: 'g16-dvb-freq',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: 'STO-3G',
    jobType: 'Freq',
    atoms: 20,
    basisFunctions: 60,
    cores: 1,
    coreSeconds: 69.8,
    wallSeconds: 70.0,
    source: 'test/fixtures/real/g16-dvb-ir.out',
  },
  {
    id: 'g16-dvb-td5',
    engine: 'gaussian',
    method: 'B3LYP',
    basis: 'STO-3G',
    jobType: 'TD',
    atoms: 20,
    basisFunctions: 60,
    states: 5,
    cores: 8,
    coreSeconds: 45.0,
    wallSeconds: 6.0,
    source: 'test/fixtures/real/g16-dvb-td.out',
  },
  {
    id: 'psi4-water-mp2',
    engine: 'psi4',
    method: 'MP2',
    basis: 'def2-SVP',
    jobType: 'SP',
    atoms: 3,
    basisFunctions: 24,
    cores: 1,
    coreSeconds: 0.98,
    wallSeconds: 1.43,
    source: 'test/fixtures/real/psi4-1.11-water-mp2/mp2.log',
  },
  {
    id: 'psi4-water-ccsdt',
    engine: 'psi4',
    method: 'CCSD(T)',
    basis: 'def2-SVP',
    jobType: 'SP',
    atoms: 3,
    basisFunctions: 24,
    cores: 1,
    coreSeconds: 1.06,
    wallSeconds: 1.50,
    source: 'test/fixtures/real/psi4-1.11-water-ccsdt/ccsdt.log',
  },
  {
    id: 'psi4-water-freq',
    engine: 'psi4',
    method: 'B3LYP',
    basis: 'def2-SVP',
    jobType: 'Freq',
    atoms: 3,
    basisFunctions: 24,
    cores: 1,
    coreSeconds: 15.94,
    wallSeconds: 18.03,
    source: 'test/fixtures/real/psi4-1.11-water-freq/freq.log',
  },
  {
    id: 'orca-water-mp2',
    engine: 'orca',
    method: 'MP2',
    basis: 'STO-3G',
    jobType: 'SP',
    atoms: 3,
    basisFunctions: 7,
    cores: 4,
    coreSeconds: 6.095,
    wallSeconds: 6.095,
    source: 'test/fixtures/real/orca-5.0-water-mp2/water_mp2.out',
  },
  {
    id: 'orca-dvb-ir',
    engine: 'orca',
    method: 'B3LYP',
    basis: 'STO-3G',
    jobType: 'Freq',
    atoms: 20,
    basisFunctions: 60,
    cores: 2,
    coreSeconds: 138.241,
    wallSeconds: 138.241,
    source: 'test/fixtures/real/orca-5.0-dvb-ir/dvb_ir.out',
  },
  {
    id: 'xtb-water-optfreq',
    engine: 'xtb',
    method: 'GFN2-xTB',
    basis: '',
    jobType: 'Opt Freq',
    atoms: 3,
    cores: 1,
    coreSeconds: 0.211,
    wallSeconds: 0.211,
    source: 'test/fixtures/real/xtb-6.6.1-water-optfreq/xtb-water-optfreq.log',
  },
]);

/**
 * Contracted functions per atom, by basis.
 *
 * Provenance: the row counts come from the published contractions of each set,
 * and the ones marked by a fixture check were verified against the `NBasis`
 * lines in this repository:
 *   water, 6-31G(d): O 15 + 2 × H 2 = 19  (g16-a03-water-sp.out NBasis=19)
 *   water, def2-SVP: O 14 + 2 × H 5 = 24  (psi4-1.11-water-freq: 24)
 *   DVB,   STO-3G:   10 × C 5 + 10 × H 1 = 60 (g16-dvb-sp.out NBasis=60)
 *
 * The two conventions are not the same, and the table keeps each program's:
 * Pople rows use Cartesian d/f (Gaussian's 6D/10F default; 6-31G(d) oxygen is
 * 9 + 6 = 15), while def2/cc rows use spherical d/f (Psi4 and ORCA default;
 * def2-SVP oxygen is 9 + 5 = 14). A Gaussian job with a def2 or cc basis
 * therefore prints one more function per d shell than the row gives — a few
 * percent, well inside the estimate's range, and stated rather than corrected
 * with a number this corpus cannot check.
 *
 * The unverified rows (def2-TZVP, cc-pVTZ, and the second-row counts) are the
 * published contractions but no fixture prints their NBasis; the estimate is
 * low confidence for them by construction, not by a separate flag.
 *
 * A basis or element outside this table is a refusal, never an interpolation.
 * ECP bases (SDD, def2 on Rb–Rn) are absent on purpose: their valence-only
 * counts are not comparable to an all-electron job and would make the
 * coefficient look better than it is.
 */
export const BASIS_FUNCTIONS = Object.freeze({
  'sto-3g': Object.freeze({ H: 1, C: 5, N: 5, O: 5, F: 5, P: 9, S: 9, Cl: 9 }),
  '3-21g': Object.freeze({ H: 2, C: 9, N: 9, O: 9, F: 9, P: 13, S: 13, Cl: 13 }),
  '6-31g(d)': Object.freeze({ H: 2, C: 15, N: 15, O: 15, F: 15, P: 19, S: 19, Cl: 19 }),
  '6-311+g(d,p)': Object.freeze({ H: 6, C: 19, N: 19, O: 19, F: 19, P: 23, S: 23, Cl: 23 }),
  'cc-pvdz': Object.freeze({ H: 5, C: 14, N: 14, O: 14, F: 14, P: 18, S: 18, Cl: 18 }),
  'cc-pvtz': Object.freeze({ H: 14, C: 30, N: 30, O: 30, F: 30 }),
  'def2-svp': Object.freeze({ H: 5, C: 14, N: 14, O: 14, F: 14, P: 18, S: 18, Cl: 18 }),
  'def2-tzvp': Object.freeze({ H: 6, C: 31, N: 31, O: 31, F: 31, P: 34, S: 34, Cl: 34 }),
});

const BASIS_ALIASES = new Map([
  ['sto-3g', 'sto-3g'],
  ['sto3g', 'sto-3g'],
  ['3-21g', '3-21g'],
  ['321g', '3-21g'],
  ['6-31g(d)', '6-31g(d)'],
  ['6-31g*', '6-31g(d)'],
  ['6-31gd', '6-31g(d)'],
  ['6-31g(d,p)', '6-31g(d)'],
  ['6-31g**', '6-31g(d)'],
  ['6-311+g(d,p)', '6-311+g(d,p)'],
  ['6-311g(d,p)', '6-311+g(d,p)'],
  ['6-311++g(d,p)', '6-311+g(d,p)'],
  ['6-311+g**', '6-311+g(d,p)'],
  ['6-311g**', '6-311+g(d,p)'],
  ['cc-pvdz', 'cc-pvdz'],
  ['ccpvdz', 'cc-pvdz'],
  ['cc-pvtz', 'cc-pvtz'],
  ['ccpvtz', 'cc-pvtz'],
  ['def2-svp', 'def2-svp'],
  ['def2svp', 'def2-svp'],
  ['def2-tzvp', 'def2-tzvp'],
  ['def2tzvp', 'def2-tzvp'],
]);

/**
 * Coefficients, in core-seconds per basis function^exponent.
 *
 * `low` and `high` are the measured spread where two anchors exist; otherwise
 * they are `likely ×0.3` / `likely ×3`, the low-confidence widening the issue
 * asks for. `likely` is the geometric mean of the per-anchor coefficients, so
 * neither anchor is privileged.
 */
export const ENGINE_MODELS = Object.freeze({
  gaussian: Object.freeze({
    label: 'Gaussian 16',
    exponent: SCF_EXPONENT,
    methods: Object.freeze(['B3LYP']),
    sp: Object.freeze({
      perCyclePerNbf3: Object.freeze({ low: 1.0185185185185186e-5, likely: 1.8165518836181158e-5, high: 3.239863277769678e-5 }),
      assumedCycles: 9,
      points: 3,
      methods: Object.freeze(['B3LYP']),
    }),
    opt: Object.freeze({
      perStepPerNbf3: Object.freeze({ low: 4.638888888888889e-5, likely: 1.2335814862737872e-4, high: 3.2803615687418e-4 }),
      assumedSteps: 5,
      points: 2,
      methods: Object.freeze(['B3LYP']),
    }),
    freq: Object.freeze({
      perNbf3: Object.freeze({ low: 3.2314814814814814e-4, likely: 5.316747793392164e-4, high: 8.747630849978131e-4 }),
      points: 2,
      methods: Object.freeze(['B3LYP']),
    }),
    td: Object.freeze({
      perStatePerNbf3: Object.freeze({ low: 1.1888888888888888e-5, likely: 3.9629629629629626e-5, high: 1.1888888888888888e-4 }),
      points: 1,
      methods: Object.freeze(['B3LYP']),
    }),
    // Priced job types. Anything else is refused with a reason rather than
    // given a coefficient from a neighbouring job.
    priced: Object.freeze(['SP', 'SP+TD', 'TD', 'Opt', 'Freq', 'Opt Freq']),
  }),
  psi4: Object.freeze({
    label: 'Psi4',
    exponent: SCF_EXPONENT,
    methods: Object.freeze(['MP2', 'CCSD(T)', 'B3LYP']),
    sp: Object.freeze({
      perNbf3: Object.freeze({ low: 7.089120370370371e-5, likely: 7.372796473519044e-5, high: 7.667824074074075e-5 }),
      points: 2,
      methods: Object.freeze(['MP2', 'CCSD(T)']),
    }),
    freq: Object.freeze({
      perNbf3: Object.freeze({ low: 3.4592013888888886e-4, likely: 1.1530671296296295e-3, high: 3.4592013888888886e-3 }),
      points: 1,
      methods: Object.freeze(['B3LYP']),
    }),
    td: Object.freeze({
      // No Psi4 TD-DFT run is committed. The fallback is not a coefficient at
      // all: it scales the smallest measured Psi4 job by atom count only and
      // says so in `basis`.
      perStateFactor: 0.2,
      points: 0,
    }),
    priced: Object.freeze(['SP', 'Freq', 'TD-DFT']),
    fallbackJobTypes: Object.freeze(['TD-DFT']),
  }),
  orca: Object.freeze({
    label: 'ORCA',
    exponent: SCF_EXPONENT,
    methods: Object.freeze(['MP2', 'B3LYP']),
    sp: Object.freeze({
      perNbf3: Object.freeze({ low: 5.3309037900874635e-3, likely: 1.7769679300291545e-2, high: 5.3309037900874635e-2 }),
      points: 1,
      methods: Object.freeze(['MP2']),
    }),
    freq: Object.freeze({
      perNbf3: Object.freeze({ low: 1.9200138888888888e-4, likely: 6.400046296296297e-4, high: 1.9200138888888888e-3 }),
      points: 1,
      methods: Object.freeze(['B3LYP']),
    }),
    priced: Object.freeze(['SP', 'Freq']),
  }),
  xtb: Object.freeze({
    label: 'xTB',
    exponent: XTB_EXPONENT,
    methods: Object.freeze(['GFN2-xTB', 'GFN1-xTB', 'GFN-FF']),
    optFreq: Object.freeze({
      perAtomSquared: Object.freeze({ low: 0.007033333333333333, likely: 0.023444444444444445, high: 0.07033333333333333 }),
      points: 1,
      methods: Object.freeze(['GFN2-xTB']),
    }),
    // One Opt+Freq run is the only xTB timing in the corpus. Other xTB job
    // types are refused instead of inheriting a number measured on a different
    // job shape.
    priced: Object.freeze(['Opt Freq']),
  }),
});

const METHOD_FACTOR = Object.freeze({ dft: 1, hf: 0.85, mp2: 2.2, ccsd: 3.5 });
const CONFIDENCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

/** Normalise an engine id to one this model has measurements for. */
function engineKey(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (id === 'g16' || id === 'gaussian16' || id === 'gaussian-16') return 'gaussian';
  return id;
}

/** Normalise a basis spelling to a table key, or `''` when unrecognised. */
export function basisKey(basis) {
  const raw = String(basis ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return BASIS_ALIASES.get(raw) || '';
}

/** Capitalise an element symbol the way the table stores it. */
function elementSymbol(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * Contracted-function count for a basis and an element list.
 *
 * `count` is `null` when any element is outside the table; `missing` names
 * those elements. The caller must refuse rather than fill the gap.
 */
export function basisFunctionsFor(basis, atoms = [], { exact = null } = {}) {
  const elements = Array.isArray(atoms)
    ? atoms.map((atom) => elementSymbol(typeof atom === 'string' ? atom : atom?.element))
    : [];
  if (Number.isInteger(exact) && exact > 0) {
    return {
      count: exact,
      exact: true,
      source: 'caller-supplied count',
      key: basisKey(basis),
      missing: [],
      elements,
    };
  }
  const key = basisKey(basis);
  const row = key ? BASIS_FUNCTIONS[key] : null;
  if (!row) {
    return {
      count: null,
      exact: false,
      source: key ? `no row for ${key}` : `no basis-size row for "${String(basis ?? '')}"`,
      key,
      missing: [],
      elements,
    };
  }
  if (elements.length === 0) {
    return { count: null, exact: false, source: 'no element composition', key, missing: [], elements };
  }
  let count = 0;
  const missing = [];
  for (const element of elements) {
    const value = row[element];
    if (Number.isInteger(value)) count += value;
    else if (!missing.includes(element)) missing.push(element);
  }
  if (missing.length > 0) {
    return {
      count: null,
      exact: false,
      source: `no ${key} row for ${missing.join(', ')}`,
      key,
      missing,
      elements,
    };
  }
  return { count, exact: true, source: `${key} table`, key, missing: [], elements };
}

/** Atom list from a plan task, a project, or either one's molecule. */
function atomsOf(task, project) {
  const candidates = [
    task?.validity?.molecule?.coords,
    task?.molecule?.coords,
    task?.input?.molecule?.coords,
    project?.molecule?.coords,
  ];
  for (const coords of candidates) {
    if (Array.isArray(coords) && coords.length > 0) return coords;
  }
  return [];
}

function explicitAtomCount(task) {
  for (const value of [task?.validity?.molecule?.atoms, task?.atoms, task?.input?.atoms]) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function methodClass(method) {
  const text = String(method ?? '').toUpperCase();
  if (!text) return 'dft';
  if (text.includes('CCSD')) return 'ccsd';
  if (text.includes('MP2')) return 'mp2';
  if (text === 'HF' || text === 'RHF' || text === 'UHF' || text === 'ROHF' || text.includes('HARTREE-FOCK')) return 'hf';
  if (text.includes('GFN') || text.includes('XTB')) return 'semi';
  return 'dft';
}

/** Normalise the job-type spelling each engine used into one class. */
function jobClass(jobType, settings = {}, engine = '') {
  const text = String(jobType ?? '').trim();
  const states = Number(settings.tdStates);
  if (engine === 'psi4') {
    if (text === 'TD-DFT') return 'TD-DFT';
    if (text === 'Opt Freq') return 'Opt Freq';
    return text;
  }
  if (text === 'Opt Freq') return 'Opt Freq';
  // A transition-state search and a QST walk are their own job shapes. They are
  // not an optimisation with a different name, so they stay unpriced.
  if (text === 'Opt') return states > 0 ? 'Opt+TD' : 'Opt';
  if (text === 'Opt=TS' || text.startsWith('Opt=QST')) return text;
  if (text === 'Freq') return 'Freq';
  if (text === 'SP') return states > 0 ? 'SP+TD' : 'SP';
  return text;
}

function timeoutForTask(task, project, optionTimeout) {
  const own = Number(task?.settings?.timeoutSeconds);
  if (Number.isInteger(own) && own >= 1) return Math.min(own, 86400);
  const option = Number(optionTimeout);
  if (Number.isInteger(option) && option >= 1) return Math.min(option, 86400);
  const stored = Number(project?.runner?.timeoutSeconds);
  if (Number.isInteger(stored) && stored >= 1) return Math.min(stored, 86400);
  return DEFAULT_TIMEOUT_SECONDS;
}

function maxParallelOf(project, override) {
  const value = Number(override ?? project?.runner?.maxParallel);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 64) : 1;
}

function procsOf(task, project, engine) {
  if (engine === 'gaussian' || engine === 'orca') {
    const own = Number(task?.settings?.nproc);
    if (Number.isInteger(own) && own >= 1) return Math.min(own, 256);
    const fallback = Number(project?.defaults?.nproc);
    if (Number.isInteger(fallback) && fallback >= 1) return Math.min(fallback, 256);
    return 4;
  }
  return 1;
}

function confidenceFor(points) {
  if (points >= 20) return 'high';
  if (points >= 5) return 'medium';
  return 'low';
}

function roundSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Keep two significant digits: an estimate does not deserve six.
  const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Number((Math.round(value / magnitude) * magnitude).toPrecision(2));
}

function rangeOf(low, likely, high) {
  const clean = (value) => roundSeconds(Math.max(0, Number(value) || 0));
  const l = clean(low);
  const h = Math.max(l, clean(high));
  return { low: l, likely: Math.min(h, Math.max(l, clean(likely))), high: h };
}

/** Measured points for one engine and job class. */
function pointsFor(engine, job) {
  return MEASUREMENTS.filter((point) => point.engine === engine
    && (point.jobType === job
      || (job === 'SP' && point.jobType === 'SP')
      || (job === 'SP+TD' && point.jobType === 'TD')));
}

/**
 * The coefficient envelope for an engine and job class, in core-seconds per
 * Nbf^exponent (SP carries a cycle count, Opt a step count).
 */
function coefficientFor(model, job) {
  if (job === 'SP') return model.sp ? { ...model.sp, kind: 'sp' } : null;
  if (job === 'SP+TD') return model.sp ? { ...model.sp, kind: 'sp' } : null;
  if (job === 'Opt') return model.opt ? { ...model.opt, kind: 'opt' } : null;
  if (job === 'Freq') return model.freq ? { ...model.freq, kind: 'freq' } : null;
  if (job === 'Opt Freq') {
    if (!model.opt || !model.freq) return null;
    return { opt: model.opt, freq: model.freq, kind: 'optfreq' };
  }
  if (job === 'TD') return model.td ? { ...model.td, kind: 'td' } : null;
  if (job === 'TD-DFT') return model.td ? { ...model.td, kind: 'td-fallback' } : null;
  return null;
}

function methodAdjustment(model, method, coefficient = null) {
  const requested = methodClass(method);
  const declared = coefficient?.methods ?? model.methods ?? [];
  const measured = Array.isArray(declared) ? declared.map(methodClass) : [];
  if (measured.length === 0) {
    return { factor: 1, assumed: false, low: 1, high: 1, requested, measured, note: null };
  }
  const exact = declared.some((name) => String(name).toUpperCase() === String(method ?? '').toUpperCase());
  if (measured.includes(requested)) {
    return {
      factor: 1,
      assumed: false,
      low: 1,
      high: 1,
      requested,
      measured,
      note: exact
        ? null
        : `method ${method || '(unset)'} was not measured on ${model.label};`
          + ` the ${declared.join('/')} coefficient is used at the same method class`,
    };
  }
  const meanMeasured = measured.reduce((sum, key) => sum + (METHOD_FACTOR[key] ?? 1), 0) / measured.length;
  const factor = (METHOD_FACTOR[requested] ?? 1) / meanMeasured;
  return {
    factor,
    assumed: true,
    low: factor * 0.5,
    high: factor * 2,
    requested,
    measured,
    note: null,
  };
}

function tdStates(settings) {
  const states = Number(settings?.tdStates);
  return Number.isInteger(states) && states > 0 ? states : 0;
}

/**
 * Core-seconds for one task.
 *
 * Returns `{ coreSeconds, basis, points, measured }` or `{ refusal }`.
 */
function coreForTask(task, project, options) {
  const settings = task?.settings && typeof task.settings === 'object' ? task.settings : {};
  const engine = engineKey(task?.engine ?? project?.defaults?.engine ?? 'gaussian');
  const model = ENGINE_MODELS[engine];
  const method = String(settings.method ?? project?.defaults?.method ?? '').trim();
  const basis = String(settings.basis ?? project?.defaults?.basis ?? '').trim();
  const job = jobClass(settings.jobType ?? task?.jobType, settings, engine);
  const states = tdStates(settings);

  if (!model) {
    return { refusal: `unknown engine "${String(task?.engine ?? '')}"; no timing measurement covers it` };
  }
  if (isCompositeJobType(job)) {
    return { refusal: `${job} is a composite method: its cost is a toolchain of links this model does not describe` };
  }
  if (!model.priced.includes(job) && !(model.fallbackJobTypes || []).includes(job)) {
    return { refusal: `no measurement for ${model.label} ${job}; priced types are ${model.priced.join(', ')}` };
  }
  const coefficient = engine === 'xtb'
    ? { perAtomSquared: model.optFreq.perAtomSquared, kind: 'xtb', points: model.optFreq.points, methods: model.optFreq.methods }
    : coefficientFor(model, job);
  if (!coefficient) {
    return { refusal: `no measurement for ${model.label} ${job}` };
  }

  const coords = atomsOf(task, project);
  const elements = coords.map((atom) => elementSymbol(atom?.element));
  let atoms = elements.length;
  if (atoms === 0) atoms = explicitAtomCount(task) || 0;
  if (atoms === 0) return { refusal: 'the task carries no geometry, so its size is unknown' };

  const basisInfo = engine === 'xtb'
    ? { count: null, exact: false, source: 'xTB has no basis set', key: '', missing: [], elements }
    : basisFunctionsFor(basis, coords, { exact: Number(task?.basisFunctions) || null });
  if (engine !== 'xtb' && job !== 'TD-DFT' && !Number.isInteger(basisInfo.count)) {
    return { refusal: `cannot size the basis: ${basisInfo.source}` };
  }
  const nbf = basisInfo.count;
  const exponent = model.exponent;
  const methodInfo = methodAdjustment(model, method, coefficient);
  const basisList = [];

  if (methodInfo.assumed) {
    basisList.push(`method ${method || '(unset)'} was not measured on ${model.label};`
      + ` the ${methodInfo.measured.join('/')} coefficient is adjusted by ×${methodInfo.factor.toFixed(2)} (assumed)`);
  } else if (methodInfo.note) {
    basisList.push(methodInfo.note);
  }
  if (engine === 'xtb') {
    basisList.push(`xTB anchored on one Opt+Freq run: 0.211 s at 3 atoms (${MEASUREMENTS.find((p) => p.engine === 'xtb').source})`);
    basisList.push('xTB cost grows with atom count squared (assumed for a semi-empirical method)');
  } else if (job === 'TD-DFT') {
    basisList.push('the basis size is not used by this fallback: the range comes from atom count alone');
  } else {
    basisList.push(`${nbf} basis functions (${basisInfo.source})`
      + `${basisInfo.exact ? '' : ' (no per-element count available)'}`);
    if (engine === 'gaussian' && /^(def2|cc-)/.test(basisInfo.key || '')) {
      basisList.push('spherical d/f count; Gaussian\'s 6D default prints one more function per d shell'
        + ' (a few percent, inside the range)');
    }
    basisList.push(`cost scales as Nbf^${exponent} (assumed; the corpus cannot determine the exponent)`);
  }

  const per = (range) => ({
    low: range.low * methodInfo.low,
    likely: range.likely * methodInfo.factor,
    high: range.high * methodInfo.high,
  });

  if (engine === 'xtb') {
    const rate = per(coefficient.perAtomSquared);
    const scale = atoms ** exponent;
    return {
      coreSeconds: rangeOf(rate.low * scale, rate.likely * scale, rate.high * scale),
      basis: basisList,
      points: coefficient.points ?? 0,
      measured: true,
      atoms,
      basisFunctions: null,
      basisSource: basisInfo.source,
      method: method || null,
      methodClass: methodInfo.requested,
      job,
      engine,
      model,
      coefficient,
    };
  }

  let core;
  let points = coefficient.points ?? 0;
  let measured = points > 0;

  if (job === 'SP' && coefficient.perNbf3) {
    // Psi4 and ORCA anchors are single points without a printed cycle count;
    // their coefficient already includes the whole job.
    const rate = per(coefficient.perNbf3);
    const scale = nbf ** exponent;
    core = { low: rate.low * scale, likely: rate.likely * scale, high: rate.high * scale };
    basisList.push(`${model.label} SP calibrated on ${points} committed log${points === 1 ? '' : 's'}`);
  } else if (job === 'SP' || (job === 'SP+TD' && states === 0)) {
    const cycles = coefficient.assumedCycles
      + (String(settings.scf ?? '').toLowerCase().includes('tight') ? 3 : 0);
    const rate = per(coefficient.perCyclePerNbf3);
    const scale = cycles * nbf ** exponent;
    core = { low: rate.low * scale, likely: rate.likely * scale, high: rate.high * scale };
    basisList.push(`${cycles} SCF cycles assumed (the water anchor converged in 9);`
      + ' a tighter SCF limit adds 3');
    basisList.push(`${model.label} SP calibrated on ${points} committed logs (water/6-31G(d), DVB/STO-3G)`);
  } else if (job === 'SP+TD' || job === 'TD') {
    const cycles = coefficient.assumedCycles ?? 9;
    const rate = per(coefficient.perCyclePerNbf3);
    const scale = cycles * nbf ** exponent;
    const spCore = { low: rate.low * scale, likely: rate.likely * scale, high: rate.high * scale };
    const tdRate = per(ENGINE_MODELS.gaussian.td.perStatePerNbf3);
    const tdScale = states * nbf ** exponent;
    core = {
      low: spCore.low + tdRate.low * tdScale,
      likely: spCore.likely + tdRate.likely * tdScale,
      high: spCore.high + tdRate.high * tdScale,
    };
    points = Math.min(points || ENGINE_MODELS.gaussian.td.points, ENGINE_MODELS.gaussian.td.points);
    basisList.push(`TD adds ${ENGINE_MODELS.gaussian.td.points} measured point (${states} states at 60 basis functions);`
      + ' the per-state cost is assumed linear in state count');
  } else if (job === 'Opt') {
    const steps = coefficient.assumedSteps ?? 5;
    const rate = per(coefficient.perStepPerNbf3);
    const scale = steps * nbf ** exponent;
    core = { low: rate.low * scale, likely: rate.likely * scale, high: rate.high * scale };
    basisList.push(`${steps} optimisation steps assumed; the measured jobs took 4 and 5`);
    basisList.push('the two measured optimisations differ by 7× per step, so the range is the measured spread');
  } else if (job === 'Freq') {
    const rate = per(coefficient.perNbf3);
    const scale = nbf ** exponent;
    core = { low: rate.low * scale, likely: rate.likely * scale, high: rate.high * scale };
    basisList.push(`frequency calibrated on ${points} committed log${points === 1 ? '' : 's'}`);
  } else if (job === 'Opt Freq') {
    const optRate = per(coefficient.opt.perStepPerNbf3);
    const freqRate = per(coefficient.freq.perNbf3);
    const optScale = (coefficient.opt.assumedSteps ?? 5) * nbf ** exponent;
    const freqScale = nbf ** exponent;
    core = {
      low: optRate.low * optScale + freqRate.low * freqScale,
      likely: optRate.likely * optScale + freqRate.likely * freqScale,
      high: optRate.high * optScale + freqRate.high * freqScale,
    };
    points = Math.min(coefficient.opt.points ?? 0, coefficient.freq.points ?? 0);
    basisList.push('Opt+Freq is the sum of the measured Opt and Freq components');
    basisList.push('the measured optimisations took 4 and 5 steps; 5 is assumed');
  } else if (job === 'TD-DFT') {
    // No Psi4 TD-DFT run exists. Scale Psi4's smallest measured job by atom
    // count only; the per-state factor is an assumption, and `basis` says so
    // in the words the issue asks for.
    const anchor = MEASUREMENTS.find((point) => point.id === 'psi4-water-mp2');
    const unit = anchor.coreSeconds / anchor.atoms ** exponent;
    const stateFactor = 1 + states * (model.td?.perStateFactor ?? 0.2);
    const likely = unit * atoms ** exponent * stateFactor;
    core = { low: likely * 0.3, likely, high: likely * 3 };
    points = 0;
    measured = false;
    basisList.push(`no measurement for Psi4 TD-DFT; range from atom count only (${atoms} atoms, ${states} states)`);
    basisList.push(`${stateFactor.toFixed(1)}× the ground-state cost for ${states} states (assumed, not measured)`);
  } else {
    return { refusal: `no measurement for ${model.label} ${job}` };
  }

  if (!core || !Number.isFinite(core.likely)) {
    return { refusal: `the ${model.label} ${job} model produced no finite estimate` };
  }
  return {
    coreSeconds: rangeOf(core.low, core.likely, core.high),
    basis: basisList,
    points,
    measured,
    atoms,
    basisFunctions: job === 'TD-DFT' ? null : nbf,
    basisSource: basisInfo.source,
    method: method || null,
    methodClass: methodInfo.requested,
    job,
    engine,
    model,
    coefficient,
  };
}

/** Wall seconds for a core-seconds range under a queue of `concurrency` tasks. */
function wallForRange(coreRange, { procs, cores, concurrency }) {
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, cores));
  const share = Math.max(1, Math.floor(cores / effectiveConcurrency));
  const usable = Math.max(1, Math.min(procs, share));
  const contention = 1 + CONCURRENCY_CONTENTION * (effectiveConcurrency - 1);
  const wall = (value) => STARTUP_SECONDS + (value / (usable * PARALLEL_EFFICIENCY)) * contention;
  return {
    low: wall(coreRange.low),
    likely: wall(coreRange.likely),
    high: wall(coreRange.high),
    procs: usable,
    contention,
  };
}

/** Dependency levels for a plan; a cycle is treated as one level. */
export function dependencyLevels(tasks, edges = []) {
  const keyOf = (task, index) => String(task?.key ?? task?.taskId ?? task?.nodeId ?? index);
  const ids = tasks.map((task, index) => keyOf(task, index));
  const idSet = new Set(ids);
  const deps = new Map(ids.map((id) => [id, new Set()]));
  for (const edge of edges) {
    const from = edge?.from;
    const to = edge?.to;
    if (!idSet.has(from) || !idSet.has(to) || from === to) continue;
    deps.get(to).add(from);
  }
  const levelOf = new Map();
  const remaining = new Set(ids);
  let level = 0;
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => [...deps.get(id)].every((dep) => levelOf.has(dep)));
    if (ready.length === 0) {
      // A cycle is the queue's refusal, not the estimator's: put the rest on
      // one level rather than loop forever.
      for (const id of remaining) levelOf.set(id, level);
      break;
    }
    for (const id of ready) levelOf.set(id, level);
    for (const id of ready) remaining.delete(id);
    level += 1;
  }
  const levels = [];
  for (const id of ids) {
    const index = levelOf.get(id) ?? 0;
    if (!levels[index]) levels[index] = [];
    levels[index].push(id);
  }
  return levels.filter(Boolean);
}

/** Total wall from the levels: waves of tasks, with the slowest task as a floor. */
function scheduleTotal(entriesByKey, levels, rangeKey, { cores, concurrency, procsOf }) {
  let total = 0;
  for (const level of levels) {
    const walls = level.map((key) => {
      const entry = entriesByKey.get(key);
      return wallForRange(entry.coreSeconds, {
        procs: procsOf(entry),
        cores,
        concurrency,
      })[rangeKey];
    });
    if (walls.length === 0) continue;
    const mean = walls.reduce((sum, value) => sum + value, 0) / walls.length;
    total += Math.max(Math.max(...walls), (walls.length / Math.max(1, concurrency)) * mean);
  }
  return total;
}

/**
 * Estimate a plan.
 *
 * @param {object} project the project (for `runner.maxParallel`,
 *   `runner.timeoutSeconds`, defaults and the molecule)
 * @param {{tasks: object[], edges?: object[]}|object[]} plan the plan from
 *   `buildWorkflowPlan()`, or a bare task array
 * @param {{cores?: number, maxParallel?: number, timeoutSeconds?: number}} options
 * @returns {object} per-task and total ranges, or `notEstimated` on the total
 */
export function estimateCost(project, plan, options = {}) {
  const cores = Number.isInteger(Number(options.cores)) && Number(options.cores) > 0
    ? Math.min(Number(options.cores), 256)
    : DEFAULT_CORES;
  const maxParallel = maxParallelOf(project, options.maxParallel);
  const tasks = (Array.isArray(plan) ? plan : (Array.isArray(plan?.tasks) ? plan.tasks : []))
    .map((task, index) => ({ ...task, key: String(task?.taskId ?? task?.nodeId ?? `task-${index}`) }))
    .filter((task) => task && (task.type === 'calculate' || task.type === undefined));
  const edges = Array.isArray(plan?.edges) ? plan.edges : [];

  if (tasks.length === 0) {
    return {
      ok: true,
      modelVersion: MODEL_VERSION,
      cores,
      maxParallel,
      tasks: [],
      total: {
        status: 'not estimated',
        notEstimated: 'the plan has no calculation tasks to price',
        reason: 'the plan has no calculation tasks to price',
      },
    };
  }

  const totalTimeout = Number(options.timeoutSeconds);
  const entries = tasks.map((task) => {
    const engine = engineKey(task.engine ?? project?.defaults?.engine ?? 'gaussian');
    const settings = task.settings && typeof task.settings === 'object' ? task.settings : {};
    const job = jobClass(settings.jobType ?? task.jobType, settings, engine);
    const title = String(task.title ?? task.nodeId ?? task.taskId ?? 'task');
    const base = {
      taskId: task.key,
      nodeId: task.nodeId ?? task.key,
      title,
      engine,
      jobType: String(settings.jobType ?? job),
      method: String(settings.method ?? ''),
      basis: String(settings.basis ?? ''),
    };
    const result = coreForTask(task, project, options);
    if (result.refusal) {
      return {
        ...base,
        status: 'not estimated',
        notEstimated: result.refusal,
        reason: result.refusal,
        basis: [result.refusal],
      };
    }
    const procs = procsOf(task, project, result.engine);
    const wall = wallForRange(result.coreSeconds, { procs, cores, concurrency: maxParallel });
    const limit = timeoutForTask(task, project, Number.isInteger(totalTimeout) && totalTimeout >= 1 ? totalTimeout : null);
    const exceeds = wall.likely > limit;
    const certain = wall.low > limit;
    return {
      ...base,
      status: 'estimated',
      atoms: result.atoms,
      basisFunctions: result.basisFunctions,
      basisSource: result.basisSource,
      procs: wall.procs,
      coreSeconds: result.coreSeconds,
      wallSeconds: rangeOf(wall.low, wall.likely, wall.high),
      confidence: confidenceFor(result.points),
      calibrationPoints: result.points,
      measured: result.measured,
      timeout: { limitSeconds: limit, exceeds, certain },
      exceedsOvernight: wall.likely > OVERNIGHT_SECONDS,
      basis: [
        ...result.basis,
        `wall assumes ${cores} logical cores, ${PARALLEL_EFFICIENCY} efficiency and a ${STARTUP_SECONDS.toFixed(1)} s startup floor`,
        `${maxParallel} task${maxParallel === 1 ? '' : 's'} at a time; ${wall.procs} process${wall.procs === 1 ? '' : 'es'} per task`,
      ],
    };
  });

  const priced = entries.filter((entry) => !entry.notEstimated);
  if (priced.length === 0) {
    const reasons = [...new Set(entries.map((entry) => entry.notEstimated))];
    return {
      ok: true,
      modelVersion: MODEL_VERSION,
      cores,
      maxParallel,
      tasks: entries,
      total: {
        status: 'not estimated',
        notEstimated: reasons.join('; ') || 'no task could be priced',
        reason: reasons.join('; ') || 'no task could be priced',
        basis: reasons,
      },
    };
  }

  const entriesByKey = new Map(priced.map((entry) => [entry.taskId, entry]));
  const pricedTasks = tasks.filter((task) => entriesByKey.has(task.key));
  const levels = dependencyLevels(pricedTasks, edges);
  const procsFor = (entry) => entry.procs;
  const wall = {
    low: scheduleTotal(entriesByKey, levels, 'low', { cores, concurrency: maxParallel, procsOf: procsFor }),
    likely: scheduleTotal(entriesByKey, levels, 'likely', { cores, concurrency: maxParallel, procsOf: procsFor }),
    high: scheduleTotal(entriesByKey, levels, 'high', { cores, concurrency: maxParallel, procsOf: procsFor }),
  };
  const core = {
    low: priced.reduce((sum, entry) => sum + entry.coreSeconds.low, 0),
    likely: priced.reduce((sum, entry) => sum + entry.coreSeconds.likely, 0),
    high: priced.reduce((sum, entry) => sum + entry.coreSeconds.high, 0),
  };
  const worstConfidence = priced
    .map((entry) => entry.confidence)
    .sort((a, b) => CONFIDENCE_RANK[a] - CONFIDENCE_RANK[b])[0] || 'low';
  const points = Math.min(...priced.map((entry) => entry.calibrationPoints));
  const exceeding = priced
    .filter((entry) => entry.timeout.exceeds)
    .map((entry) => ({
      taskId: entry.taskId,
      title: entry.title,
      limitSeconds: entry.timeout.limitSeconds,
      certain: entry.timeout.certain,
    }));
  const totalBasis = [
    `${priced.length} of ${entries.length} calculation task${entries.length === 1 ? '' : 's'} priced`
      + `${entries.length > priced.length ? `; ${entries.length - priced.length} refused (see each reason)` : ''}`,
    `wall total is the sum over dependency levels, ${maxParallel} at a time;`
      + ' it ignores stragglers beyond the per-level slowest task and queue startup',
    `wall assumes ${cores} logical cores and ${PARALLEL_EFFICIENCY} parallel efficiency (assumption)`,
  ];
  if (exceeding.length > 0) {
    totalBasis.push(`${exceeding.length} task${exceeding.length === 1 ? '' : 's'} is estimated to exceed its wall-clock limit`);
  }
  return {
    ok: true,
    modelVersion: MODEL_VERSION,
    modelDate: MODEL_DATE,
    cores,
    maxParallel,
    tasks: entries,
    total: {
      status: 'estimated',
      wallSeconds: rangeOf(wall.low, wall.likely, wall.high),
      coreSeconds: rangeOf(core.low, core.likely, core.high),
      confidence: worstConfidence,
      calibrationPoints: Number.isFinite(points) ? points : 0,
      estimatedTasks: priced.length,
      unestimatedTasks: entries.length - priced.length,
      exceedsOvernight: wall.likely > OVERNIGHT_SECONDS,
      exceedsAnyTimeout: exceeding.length > 0,
      exceedingTasks: exceeding,
      timeout: exceeding.length > 0
        ? {
          exceeds: true,
          certain: exceeding.some((entry) => entry.certain),
          limitSeconds: Math.min(...exceeding.map((entry) => entry.limitSeconds)),
        }
        : null,
      basis: totalBasis,
    },
  };
}

/**
 * One observation from a finished `run.json`.
 *
 * Wall seconds only: `run.json` records `startedAt`/`finishedAt` (and, for a
 * timed-out task, `timeout.elapsedSeconds`), not CPU time. That is still the
 * measurement a re-fit needs; it is returned, never written back.
 */
export function timingFromRunRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const started = Date.parse(record.startedAt);
  const finished = Date.parse(record.finishedAt);
  let wallSeconds = null;
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
    wallSeconds = (finished - started) / 1000;
  } else if (Number.isFinite(Number(record?.timeout?.elapsedSeconds))) {
    wallSeconds = Number(record.timeout.elapsedSeconds);
  }
  if (!Number.isFinite(wallSeconds)) return null;
  // `provenance.method` is the engine's method block, not a string: a Gaussian
  // run stores `{ method, basis, dispersion, ... }` there while xTB stores its
  // Hamiltonian. Read both shapes without pretending one is the other.
  const methodBlock = record?.provenance?.method;
  const method = typeof methodBlock === 'string'
    ? methodBlock
    : String(methodBlock?.method ?? '');
  const basis = typeof methodBlock === 'string'
    ? ''
    : String(methodBlock?.basis ?? '');
  const resources = record?.parsed?.resources || {};
  return {
    runId: record.runId ?? record.id ?? null,
    engine: engineKey(record.engine ?? record?.provenance?.engine ?? ''),
    jobType: String(record?.provenance?.jobType ?? record?.jobType ?? ''),
    method,
    basis,
    atoms: Number(record?.molecule?.atoms) || null,
    basisFunctions: Number(resources.basisFunctions ?? resources.nBasis) || null,
    cores: Number(resources.processors ?? record?.provenance?.nproc ?? record?.settings?.nproc) || null,
    wallSeconds: Math.round(wallSeconds * 10) / 10,
    timedOut: record?.status === 'timed out' || Boolean(record?.timeout),
    source: record.runId || record.id ? `run.json:${record.runId ?? record.id}` : 'run.json',
  };
}

/**
 * Compare one estimate with one observation. Returns the ratio and whether the
 * measured wall sits inside the estimated range; an estimate without a range is
 * never called correct.
 */
export function compareEstimate(taskEstimate, observation) {
  const measured = Number(observation?.wallSeconds);
  const low = Number(taskEstimate?.wallSeconds?.low);
  const high = Number(taskEstimate?.wallSeconds?.high);
  if (!Number.isFinite(measured) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return { withinRange: null, ratio: null, reason: 'estimate or measurement missing' };
  }
  return {
    withinRange: measured >= low && measured <= high,
    ratio: Math.round((measured / Number(taskEstimate.wallSeconds.likely)) * 100) / 100,
    reason: null,
  };
}
