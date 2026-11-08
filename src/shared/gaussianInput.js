/**
 * Build one Gaussian 16 input file from the node-first UI settings.
 * Pure function: no DOM, no filesystem. The Electron runner writes the result.
 */

import {
  forceConstantsFor,
  gridFor,
  hasOptKeyword,
  isTsJob,
  jobKeywordFor,
} from './tsForceConstants.js';
import {
  hasConstraints,
  modRedundantSection,
  qstKindFor,
  qstStructuresFor,
  validateConstraints,
  validateQst,
} from './constraints.js';
import { basisNameFor, ecpMissingMessage, ecpRequirement } from './ecp.js';
import {
  compositeMethodFor,
  compositeSettingConflicts,
  counterpoiseCount,
  counterpoiseFragmentIssues,
  isCompositeMethodName,
} from './routePresets.js';

export const DEMO_WATER = [
  { element: 'O', x: 0.000000, y: 0.000000, z: 0.117300 },
  { element: 'H', x: 0.000000, y: 0.757200, z: -0.469200 },
  { element: 'H', x: 0.000000, y: -0.757200, z: -0.469200 },
];

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function oneLine(value, fallback = '') {
  return String(value ?? fallback).replace(/[\r\n]+/g, ' ').trim();
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return number;
}

/**
 * Split an `Opt` job keyword into its base, its parenthesised flags and any
 * trailing tokens (`Freq`, `Freq=Raman`), so a flag can be added without ever
 * emitting a second `Opt` keyword.
 */
function splitOptKeyword(keyword) {
  const [head, ...rest] = String(keyword).split(' ');
  const equals = head.indexOf('=');
  const base = equals === -1 ? head : head.slice(0, equals);
  let flags = [];
  if (equals !== -1) {
    const value = head.slice(equals + 1);
    if (value.startsWith('(') && value.endsWith(')')) {
      flags = value.slice(1, -1).split(',').map((flag) => flag.trim()).filter(Boolean);
    } else if (value) {
      flags = [value];
    }
  }
  return { base, flags, rest };
}

/** Add flags to an existing Opt keyword, preserving its own flags and order. */
function withOptFlags(keyword, flags) {
  const { base, flags: existing, rest } = splitOptKeyword(keyword);
  const merged = [...existing];
  flags.forEach((flag) => { if (!merged.includes(flag)) merged.push(flag); });
  const opt = merged.length === 1 ? `${base}=${merged[0]}` : `${base}=(${merged.join(',')})`;
  return [opt, ...rest].join(' ');
}

/**
 * The route's job keyword including constraint and QST requirements (#93).
 *
 * `ModRedundant` is what makes Gaussian read the section written after the
 * geometry: without it the constraint lines are ignored, which is the failure
 * mode this keyword prevents. A constrained Berny optimisation also computes a
 * Hessian when CalcFC/CalcAll/ReadFC is chosen, which is what makes the block a
 * legitimate force-constant source for a downstream `Opt=TS ReadFC` (#93).
 *
 * QST2/QST3 carry only their own flag: STQN starts from its own empirical
 * Hessian, and Gaussian documents that `TS` must not be combined with them.
 */
export function jobKeywordWithConstraints(settings = {}) {
  const base = jobKeywordFor(settings);
  const jobType = oneLine(settings.jobType, 'Opt');
  const flags = [];
  const constrainedOpt = hasConstraints(settings) && (jobType === 'Opt' || jobType === 'Opt Freq');
  if (constrainedOpt) {
    const choice = forceConstantsFor(settings);
    if (choice === 'CalcFC' || choice === 'CalcAll' || choice === 'ReadFC') flags.push(choice);
  }
  // Only a job that reads a ModRedundant section may ask for one; the builder
  // refuses the other job types before the route is written.
  const readsModRedundant = jobType === 'Opt=TS' || jobType === 'Scan'
    || qstKindFor(jobType) !== null || constrainedOpt;
  if (hasConstraints(settings) && readsModRedundant) flags.push('ModRedundant');
  return flags.length > 0 ? withOptFlags(base, flags) : base;
}

/**
 * Normalise the route settings once. `routeFor` renders from this object and
 * `methodBlockFor` reports from it, so the provenance manifest and the input
 * file can never disagree about method, basis, dispersion, solvation, grid or
 * SCF convergence.
 */
function routeValues(settings = {}) {
  const solvated = Boolean(settings.solvation);
  return {
    // One job keyword, composed in one place: a TS job and its force constants
    // must never produce a second `Opt`.
    job: jobKeywordWithConstraints(settings),
    functional: oneLine(settings.method, 'B3LYP'),
    basis: oneLine(settings.basis, '6-31G(d)'),
    dispersion: settings.dispersion ? oneLine(settings.dispersion) : null,
    scf: settings.scf ? oneLine(settings.scf) : null,
    // UltraFine is derived, not stored: a DFT optimization at tight convergence
    // gets the grid Gaussian recommends unless the user chose one explicitly.
    grid: gridFor(settings) || null,
    // Frontier-orbital descriptors need the eigenvalue print, which is
    // `Pop=Full`. A block that also asks for NBO/Hirshfeld/MK charges cannot
    // have both in one keyword set, so it is refused below rather than
    // silently dropping one of the two analyses.
    population: orbitalsPopulation(settings),
    verbosity: settings.verbosity ? oneLine(settings.verbosity) : null,
    solvationModel: solvated ? oneLine(settings.solvationModel, 'PCM') : null,
    solvent: solvated ? oneLine(settings.solvent, 'Water') : null,
    td: tdKeywordFor(settings),
    // `Stable=Opt` re-optimises the geometry if the wavefunction is unstable,
    // so it needs a job that optimises. On a single point it asks Gaussian to
    // optimise with no coordinate system and l108 stops with "No variables in
    // Z-matrix." Refuse it here rather than write the route.
    stable: (() => {
      if (settings.stableOpt !== true) return null;
      const job = oneLine(settings.jobType, 'Opt');
      if (!/\bopt\b/i.test(job) || /qst/i.test(job)) {
        throw new Error('Stable=Opt re-optimises the geometry, so it only applies to an Opt job; '
          + `this block is ${job}. Use Stable (without =Opt) for a wavefunction stability check, or change the job type.`);
      }
      return 'Stable=Opt';
    })(),
    customKeywords: oneLine(settings.customKeywords, ''),
  };
}

/**
 * The population keyword the route must carry. `orbitals: true` means the user
 * wants frontier-orbital descriptors, which only `Pop=Full` prints; asking for
 * another population analysis at the same time is a conflict, not a preference,
 * so it throws with the two ways out instead of emitting an invented
 * combined syntax.
 */
export function orbitalsPopulation(settings = {}) {
  const requested = settings.population ? oneLine(settings.population) : null;
  if (settings.orbitals !== true) return requested;
  if (requested && requested.toLowerCase() !== 'full') {
    throw new Error(`Frontier-orbital descriptors need Pop=Full, but this block also asks for Pop=${requested}. `
      + 'Run the orbital analysis in its own block, or clear the population analysis on this one.');
  }
  return 'Full';
}

/**
 * The TD keyword for a TD-DFT/CIS job, or `null` when excited states were not
 * requested. `tdTriplets` chooses singlets only (default), triplets only, or a
 * 50/50 run, which is Gaussian's own vocabulary rather than a paraphrase.
 */
export function tdKeywordFor(settings = {}) {
  const raw = Number(settings.tdStates ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const states = Math.max(1, Math.min(200, Math.floor(raw)));
  const mode = String(settings.tdTriplets || '');
  const suffix = mode === 'triplets' ? ',Triplets' : mode === 'both' ? ',50-50' : '';
  // Root selects which state an accompanying Opt follows (#75). Zero means
  // "not stated", so the keyword stays exactly as before for existing blocks.
  const root = Math.floor(Number(settings.tdRoot ?? 0));
  const rootSuffix = Number.isFinite(root) && root > 0 ? `,Root=${Math.min(root, states)}` : '';
  return `TD=(NStates=${states}${suffix}${rootSuffix})`;
}

/**
 * Route for a first-class composite method: `#p G4`, `#p CBS-QB3`,
 * `#p G4MP2`. No method/basis pair and no `Opt` job keyword — the composite
 * keyword expands into its documented links by itself. `SCF`, `Integral` and
 * `Output` remain ordinary route options.
 */
function compositeRouteFor(settings, method) {
  const conflicts = compositeSettingConflicts(settings);
  if (conflicts.length > 0) {
    throw new Error(`${method.id} is a composite method that supplies its own method, basis and`
      + ` job steps; remove the conflicting ${conflicts.join(', ')} setting${conflicts.length === 1 ? '' : 's'}`
      + ` instead of having it silently ignored.`);
  }
  const tokens = [`#p ${method.keyword}`];
  const scf = oneLine(settings.scf);
  if (scf) tokens.push(`SCF=${scf}`);
  const grid = gridFor(settings) || '';
  if (grid) tokens.push(`Integral=${grid}`);
  const verbosity = oneLine(settings.verbosity);
  if (verbosity) tokens.push(`Output=${verbosity}`);
  return tokens.join(' ');
}

/**
 * The app's basis ids are written the way chemists write them (`def2-SVP`), but
 * Gaussian route keywords have no hyphen: a real G16 A.03 run rejects
 * `B3LYP/def2-SVP` with `QPErr --- A syntax error was detected in the input
 * line` while `B3LYP/def2SVP` runs normally. The mapping belongs to the Gaussian
 * route only — ORCA and Psi4 keep the hyphenated spelling.
 */
const GAUSSIAN_BASIS_KEYWORD = Object.freeze({
  'def2-svp': 'def2SVP',
  'def2-tzvp': 'def2TZVP',
  'def2-qzvp': 'def2QZVP',
  'def2-tzvpp': 'def2TZVPP',
  'def2-qzvpp': 'def2QZVPP',
});

// Gaussian spells a few functionals without the hyphen chemists write, and it has no
// Greek omega: `ωB97X-D` in a route is a QPErr. The app's ids stay readable; the
// route gets the keyword Gaussian actually accepts (verified against G16 A.03).
const GAUSSIAN_METHOD_KEYWORD = Object.freeze({
  'ωb97x-d': 'wB97XD',
  'wb97x-d': 'wB97XD',
  'ωb97x-d3': 'wB97XD3',
  'wb97x-d3': 'wB97XD3',
  'ωb97x-v': 'wB97XV',
  'wb97x-v': 'wB97XV',
  'ωb97m-v': 'wB97MV',
  'wb97m-v': 'wB97MV',
  'b97-d': 'B97D',
  'b97-d3': 'B97D3',
});

/**
 * Functionals Gaussian 16 **A.03** rejects outright, verified on a real route
 * (`wB97XD3/def2TZVP` → QPErr, Link 1). A build that knows the functional is a
 * separate fact this app cannot observe, so the check warns rather than refuses:
 * the route is spelled correctly, the program is what may not understand it.
 */
export const GAUSSIAN_A03_UNKNOWN_METHODS = Object.freeze(['wB97XD3']);

/** The functional as Gaussian must read it: ASCII, official spelling. */
export function gaussianMethodKeyword(method) {
  const name = String(method ?? '').trim();
  if (!name) return name;
  return GAUSSIAN_METHOD_KEYWORD[name.toLowerCase()] || name;
}

export function gaussianBasisKeyword(basis) {
  const name = String(basis ?? '').trim();
  if (!name) return name;
  // `Gen`/`GenECP` name a user-supplied block, not a basis in the route.
  if (/^gen(?:ecp)?$/i.test(name)) return name;
  return GAUSSIAN_BASIS_KEYWORD[name.toLowerCase()] || name;
}

export function routeFor(settings = {}, { basisName = null } = {}) {
  const composite = compositeMethodFor(settings.jobType);
  if (composite) return compositeRouteFor(settings, composite);

  const values = routeValues(settings);
  // The old free-text workaround put the composite keyword in the method
  // field, producing `G4/6-31G(d)`, which Gaussian refuses. Point at the job
  // type instead of writing an invalid route.
  const compositeName = compositeMethodFor(values.functional);
  if (compositeName) {
    throw new Error(`${values.functional} is a composite method and takes no separate method/basis pair;`
      + ' choose it as the job type instead of typing it into the method field.');
  }
  if (isCompositeMethodName(values.functional)) {
    throw new Error(`${values.functional} is a composite method this build does not support yet;`
      + ' it cannot be written as an ordinary method/basis route.');
  }
  const basis = gaussianBasisKeyword(basisName || values.basis);
  const functional = gaussianMethodKeyword(values.functional);
  const tokens = [`#p ${functional}/${basis} ${values.job}`];
  const counterpoise = counterpoiseCount(settings);
  if (counterpoise === null) throw new Error('Counterpoise must be an integer between 2 and 10, or off.');
  if (counterpoise > 0) tokens.push(`Counterpoise=${counterpoise}`);
  if (values.dispersion) tokens.push(`EmpiricalDispersion=${values.dispersion}`);
  if (values.scf) tokens.push(`SCF=${values.scf}`);
  if (values.grid) tokens.push(`Integral=${values.grid}`);
  if (values.population) tokens.push(`Pop=${values.population}`);
  if (values.td) tokens.push(values.td);
  if (values.stable) tokens.push(values.stable);
  if (values.verbosity) tokens.push(`Output=${values.verbosity}`);
  if (values.solvationModel) {
    tokens.push(`SCRF=(${values.solvationModel},Solvent=${values.solvent})`);
  }
  if (values.customKeywords) {
    // The job keyword above already owns `Opt`; a second one is ambiguous in
    // the route section and silently drops one of the two.
    if (hasOptKeyword(values.job) && hasOptKeyword(values.customKeywords)) {
      throw new Error('Extra keywords must not add a second Opt keyword; set the job type and force constants instead.');
    }
    tokens.push(values.customKeywords);
  }
  return tokens.join(' ');
}

/**
 * The method block written into the provenance manifest. It comes from the
 * same normalisation `routeFor` uses, so it describes the route in the written
 * `.gjf` rather than a second, hand-copied interpretation of the settings.
 * `null` means the route carries no keyword for that field.
 */
export function methodBlockFor(settings = {}) {
  const composite = compositeMethodFor(settings.jobType);
  if (composite) {
    // The existing provenance/methods-text fields are a method/basis pair, so
    // a composite method fills them with its own name and an explicit
    // "method-defined" basis instead of a fake functional or an empty string.
    return {
      functional: composite.id,
      basis: 'method-defined',
      dispersion: null,
      solvation: null,
      grid: gridFor(settings) || null,
      scf: oneLine(settings.scf) || null,
      td: null,
      composite: composite.id,
      compositeKeyword: composite.keyword,
    };
  }
  const values = routeValues(settings);
  return {
    functional: values.functional,
    basis: values.basis,
    dispersion: values.dispersion,
    solvation: values.solvationModel ? `${values.solvationModel}/${values.solvent}` : null,
    grid: values.grid,
    scf: values.scf,
    td: values.td,
  };
}

/**
 * Replace the molecule specification of a Gaussian input with new Cartesian
 * coordinates, keeping the route and everything after the geometry (basis and
 * ECP blocks) intact.
 *
 * This is how a geometry crosses an engine boundary: an xTB optimisation
 * produces no checkpoint, so the downstream Gaussian block is built from the
 * project geometry and its coordinates are swapped for the *parsed* final
 * geometry of the run that finished. Throws when the input has no recognisable
 * molecule specification, rather than guessing where to write.
 */
export function replaceInputGeometry(inputText, atoms) {
  const lines = String(inputText ?? '').split(/\r\n|\n|\r/);
  if (!Array.isArray(atoms) || atoms.length === 0) throw new Error('No atoms were supplied for the geometry hand-off.');
  const atomLine = /^[A-Z][a-z]?\s+-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+\s*$/;
  const chargeLine = /^\s*-?\d+\s+\d+\s*$/;
  // The molecule specification starts at the first charge/multiplicity line
  // that is followed by atom rows.
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!chargeLine.test(lines[index])) continue;
    if (index + 1 < lines.length && atomLine.test(lines[index + 1])) { start = index; break; }
  }
  if (start === -1) throw new Error('The input has no charge/multiplicity line followed by atoms; the geometry cannot be replaced.');
  let end = start + 1;
  while (end < lines.length && atomLine.test(lines[end])) end += 1;
  const replacement = atoms.map((atom, index) => {
    const element = oneLine(atom.element);
    if (!/^[A-Z][a-z]?$/.test(element)) throw new Error(`Atom ${index + 1} has an invalid element symbol.`);
    const x = finiteNumber(atom.x, `Atom ${index + 1} x`);
    const y = finiteNumber(atom.y, `Atom ${index + 1} y`);
    const z = finiteNumber(atom.z, `Atom ${index + 1} z`);
    return `${element.padEnd(2)} ${x.toFixed(6).padStart(12)} ${y.toFixed(6).padStart(12)} ${z.toFixed(6).padStart(12)}`;
  });
  return [...lines.slice(0, start + 1), ...replacement, ...lines.slice(end)].join('\n');
}

export function buildGaussianInput({
  title = 'NodeChem Studio task',
  settings = {},
  molecule = {},
  inputName = 'task.gjf',
  oldCheckpoint = '',
} = {}) {
  if (!SAFE_NAME.test(String(inputName)) || !/\.(gjf|com)$/i.test(inputName)) {
    throw new Error('Input name must be a safe .gjf or .com basename.');
  }

  const memory = finiteNumber(settings.memory ?? 4, 'Memory', { min: 1, max: 1048576 });
  const unit = String(settings.memoryUnit || 'GB').toUpperCase();
  if (!['MB', 'GB', 'MW'].includes(unit)) throw new Error('Memory unit must be MB, GB, or MW.');
  const nproc = finiteNumber(settings.nproc ?? 1, 'Core count', { min: 1, max: 1024 });
  if (!Number.isInteger(nproc)) throw new Error('Core count must be an integer.');

  // TD is a route keyword on top of a wavefunction job. Gaussian does not
  // combine it with a frequency, a saddle search, an IRC or a scan, so the
  // builder refuses those combinations instead of writing a route that fails.
  if (tdKeywordFor(settings) && !['SP', 'Opt'].includes(String(settings.jobType || 'Opt'))) {
    throw new Error('Excited states (TD) are available for SP and Opt jobs only; '
      + `${settings.jobType} cannot carry a TD keyword.`);
  }

  // Raman activities ride on the frequency keyword, so a job without a
  // frequency has nowhere to put them (#76).
  if (settings.raman === true && !/Freq/i.test(String(settings.jobType || 'Opt'))) {
    throw new Error('Raman activities need a frequency job: choose Freq or Opt Freq, or turn Raman off. '
      + `${settings.jobType || 'Opt'} would silently drop the keyword.`);
  }

  // VCD rides the same frequency keyword, so it has the same requirement (#78).
  if (settings.vcd === true && !/Freq/i.test(String(settings.jobType || 'Opt'))) {
    throw new Error('VCD rotational strengths need a frequency job: choose Freq or Opt Freq, or turn VCD off. '
      + `${settings.jobType || 'Opt'} would silently drop the keyword.`);
  }

  // Counterpoise (#77): the fragment count is explicit, and every atom must
  // carry a matching fragment label. A mismatch is refused here rather than
  // written into an input Gaussian cannot interpret.
  const counterpoise = counterpoiseCount(settings);
  if (counterpoise === null) {
    throw new Error('Counterpoise must be an integer between 2 and 10, or off.');
  }
  if (counterpoise > 0) {
    const jobType = String(settings.jobType || 'Opt');
    if (compositeMethodFor(jobType)) {
      throw new Error('Counterpoise cannot be combined with a composite method;'
        + ' run the complex and the fragments at the composite level as separate blocks.');
    }
    if (!['SP', 'Opt', 'Freq', 'Opt Freq'].includes(jobType)) {
      throw new Error(`Counterpoise is available for SP, Opt, Freq and Opt Freq jobs; ${jobType} `
        + 'cannot carry it.');
    }
    if (settings.solvation) {
      throw new Error('Counterpoise cannot be combined with SCRF solvation; Gaussian documents the two as incompatible.');
    }
    if (Number(settings.tdStates) > 0 || oneLine(settings.population) || settings.orbitals === true || settings.stableOpt === true) {
      throw new Error('Counterpoise calculations cannot produce molecular orbitals; remove TD, population, frontier orbitals or Stable=Opt from this block.');
    }
    const issues = counterpoiseFragmentIssues({
      settings,
      molecule: { ...molecule, charge: molecule.charge ?? settings.charge },
    });
    if (issues.length > 0) throw new Error(issues.join(' '));
  }

  const charge = finiteNumber(molecule.charge ?? settings.charge ?? 0, 'Charge', { min: -10, max: 10 });
  if (!Number.isInteger(charge)) throw new Error('Charge must be an integer.');
  const multiplicity = finiteNumber(
    molecule.multiplicity ?? settings.multiplicity ?? 1,
    'Multiplicity',
    { min: 1, max: 10 },
  );
  if (!Number.isInteger(multiplicity)) throw new Error('Multiplicity must be an integer.');

  const coords = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (coords.length === 0) throw new Error('A molecule with Cartesian coordinates is required.');

  // Issue #93: constraints and QST structures are checked against the geometry
  // this input actually writes — a dataset record's coordinates replace the
  // project geometry (RFC 0001), so their indices must be 1..N of *this* list.
  const qstKind = qstKindFor(settings.jobType);
  if (counterpoise > 0 && qstKind) {
    throw new Error('Counterpoise and QST2/QST3 cannot share a route: fragment labels belong to one molecule '
      + 'specification, and QST reads two or three. Run them as separate blocks.');
  }
  if (qstKind && oldCheckpoint) {
    throw new Error(`${settings.jobType} reads its reactant and product from the input file, but this block has a `
      + 'checkpoint hand-off, which adds Geom=Check and would replace the first structure. Remove the hand-off '
      + 'or use Opt=TS.');
  }
  const constraintCheck = validateConstraints({
    constraints: settings.constraints,
    atoms: coords,
    jobType: settings.jobType || 'Opt',
    forceConstants: forceConstantsFor(settings),
  });
  if (constraintCheck.errors.length > 0) throw new Error(constraintCheck.errors.join(' '));
  const qstCheck = validateQst({ qst: settings.qst, atoms: coords, jobType: settings.jobType || 'Opt' });
  if (qstCheck.errors.length > 0) throw new Error(qstCheck.errors.join(' '));

  const ecp = ecpRequirement({ basis: settings.basis, elements: coords.map((atom) => atom.element) });
  if (ecp.missing.length > 0) throw new Error(ecpMissingMessage(ecp));

  /**
   * Atom rows for one molecule specification. Counterpoise fragment membership
   * is Gaussian's documented atom label, `O(Fragment=1)`; every other input
   * keeps its byte-identical two-character element column.
   */
  const coordinateLinesFor = (atoms, prefix = 'Atom') => atoms.map((atom, index) => {
    const element = oneLine(atom?.element);
    if (!/^[A-Z][a-z]?$/.test(element)) throw new Error(`${prefix} ${index + 1} has an invalid element symbol.`);
    const x = finiteNumber(atom.x, `${prefix} ${index + 1} x`);
    const y = finiteNumber(atom.y, `${prefix} ${index + 1} y`);
    const z = finiteNumber(atom.z, `${prefix} ${index + 1} z`);
    const label = counterpoise > 0
      ? `${element}(Fragment=${Number(atom.fragment)})`
      : element.padEnd(2);
    return `${label} ${x.toFixed(6).padStart(12)} ${y.toFixed(6).padStart(12)} ${z.toFixed(6).padStart(12)}`;
  });
  const coordinateLines = coordinateLinesFor(coords);
  // One ModRedundant line per constraint, in the order the inspector lists
  // them. Gaussian freezes each coordinate at its value in the geometry.
  const constraintLines = modRedundantSection(settings.constraints);

  const checkpoint = oneLine(settings.checkpoint || inputName.replace(/\.(gjf|com)$/i, '.chk'));
  if (!SAFE_NAME.test(checkpoint) || !/\.chk$/i.test(checkpoint)) {
    throw new Error('Checkpoint name must be a safe .chk basename.');
  }
  // ReadFC has nothing to read without an explicit hand-off; emitting it would
  // build a route that can only fail at run time. A constrained optimisation
  // that computes force constants is a legitimate ReadFC source (#93), so the
  // same rule applies to it as to a saddle search.
  const readsForceConstants = isTsJob(settings.jobType)
    || (hasConstraints(settings) && (settings.jobType === 'Opt' || settings.jobType === 'Opt Freq'));
  if (readsForceConstants && forceConstantsFor(settings) === 'ReadFC' && !oldCheckpoint) {
    throw new Error('ReadFC needs a checkpoint hand-off; connect a Freq or Opt=CalcFC block as the checkpoint source, or choose CalcFC.');
  }

  const lines = [
    `%Mem=${memory}${unit}`,
    `%NProcShared=${nproc}`,
    `%Chk=${checkpoint}`,
  ];
  let route = routeFor(settings, { basisName: basisNameFor(settings.basis, ecp) });
  if (oldCheckpoint) {
    if (!SAFE_NAME.test(oldCheckpoint) || !/\.chk$/i.test(oldCheckpoint)) {
      throw new Error('Checkpoint hand-off must be a safe .chk basename.');
    }
    lines.push(`%OldChk=${oldCheckpoint}`);
    // %OldChk copies the file; Geom=Check/Guess=Read actually consume it.
    const additions = [];
    if (!/\bGeom\s*=/i.test(route)) additions.push('Geom=Check');
    if (!/\bGuess\s*=/i.test(route)) additions.push('Guess=Read');
    if (additions.length > 0) route = `${route} ${additions.join(' ')}`;
  }
  lines.push(route);
  lines.push('');
  const titleLine = oneLine(title, 'NodeChem Studio task');
  lines.push(titleLine);
  lines.push('');
  const fragmentStates = counterpoise > 0 && Array.isArray(settings.counterpoiseChargeStates)
    ? settings.counterpoiseChargeStates
    : [];
  if (fragmentStates.length > 0) {
    // Gaussian's documented counterpoise charge line: whole system first, then
    // one charge/spin pair per fragment in fragment-number order.
    lines.push([
      charge,
      multiplicity,
      ...fragmentStates.flatMap((state) => [Number(state.charge), Number(state.multiplicity)]),
    ].join(' '));
  } else {
    lines.push(`${charge} ${multiplicity}`);
  }
  // `Geom=Check` tells Gaussian to take the geometry from the checkpoint, so a
  // molecule specification after the charge line is rejected outright
  // (`Atom specifications unexpectedly found in input stream`, l101). The
  // charge/multiplicity line stays: a real run with it and no atom lines was
  // accepted and reproduced the optimised geometry exactly.
  const geometryFromCheckpoint = /\bGeom\s*=\s*Check\b/i.test(route);
  if (!geometryFromCheckpoint) lines.push(...coordinateLines);
  if (constraintLines.length > 0) {
    // The molecule specification ends at a blank line; the ModRedundant section
    // follows it and is terminated by another blank line.
    lines.push('');
    lines.push(...constraintLines);
  }
  // QST2/QST3: each further structure is its own title + molecule specification
  // (and, with constraints, its own ModRedundant section), in Gaussian's
  // reactant, product, TS-guess order. The atom order is checked above and is
  // never rewritten here.
  qstStructuresFor(settings).forEach((structure, index) => {
    const label = oneLine(structure?.label) || (index === 0 ? 'product' : 'TS guess');
    lines.push('');
    lines.push(`${titleLine} — structure ${index + 2} (${label})`);
    lines.push('');
    lines.push(`${charge} ${multiplicity}`);
    lines.push(...coordinateLinesFor(
      Array.isArray(structure?.atoms) ? structure.atoms : [],
      `Structure ${index + 2} atom`,
    ));
    if (constraintLines.length > 0) {
      lines.push('');
      lines.push(...constraintLines);
    }
  });
  lines.push('');
  lines.push('');
  // The basis and ECP blocks follow the last molecule specification, in the
  // Gaussian94 layout the Basis Set Exchange exports.
  if (ecp.needed) {
    lines.push(ecp.blocks);
    lines.push('');
  }
  return lines.join('\n');
}

export function outputNameFor(inputName) {
  return String(inputName).replace(/\.(gjf|com)$/i, '.out');
}
