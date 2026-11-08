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
    job: jobKeywordFor(settings),
    functional: oneLine(settings.method, 'B3LYP'),
    basis: oneLine(settings.basis, '6-31G(d)'),
    dispersion: settings.dispersion ? oneLine(settings.dispersion) : null,
    scf: settings.scf ? oneLine(settings.scf) : null,
    // UltraFine is derived, not stored: a DFT optimization at tight convergence
    // gets the grid Gaussian recommends unless the user chose one explicitly.
    grid: gridFor(settings) || null,
    population: settings.population ? oneLine(settings.population) : null,
    verbosity: settings.verbosity ? oneLine(settings.verbosity) : null,
    solvationModel: solvated ? oneLine(settings.solvationModel, 'PCM') : null,
    solvent: solvated ? oneLine(settings.solvent, 'Water') : null,
    td: tdKeywordFor(settings),
    customKeywords: oneLine(settings.customKeywords, ''),
  };
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
  return `TD=(NStates=${states}${suffix})`;
}

export function routeFor(settings = {}) {
  const values = routeValues(settings);
  const tokens = [`#p ${values.functional}/${values.basis} ${values.job}`];
  if (values.dispersion) tokens.push(`EmpiricalDispersion=${values.dispersion}`);
  if (values.scf) tokens.push(`SCF=${values.scf}`);
  if (values.grid) tokens.push(`Integral=${values.grid}`);
  if (values.population) tokens.push(`Pop=${values.population}`);
  if (values.td) tokens.push(values.td);
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
  const coordinateLines = coords.map((atom, index) => {
    const element = oneLine(atom.element);
    if (!/^[A-Z][a-z]?$/.test(element)) throw new Error(`Atom ${index + 1} has an invalid element symbol.`);
    const x = finiteNumber(atom.x, `Atom ${index + 1} x`);
    const y = finiteNumber(atom.y, `Atom ${index + 1} y`);
    const z = finiteNumber(atom.z, `Atom ${index + 1} z`);
    return `${element.padEnd(2)} ${x.toFixed(6).padStart(12)} ${y.toFixed(6).padStart(12)} ${z.toFixed(6).padStart(12)}`;
  });

  const checkpoint = oneLine(settings.checkpoint || inputName.replace(/\.(gjf|com)$/i, '.chk'));
  if (!SAFE_NAME.test(checkpoint) || !/\.chk$/i.test(checkpoint)) {
    throw new Error('Checkpoint name must be a safe .chk basename.');
  }
  // ReadFC has nothing to read without an explicit hand-off; emitting it would
  // build a route that can only fail at run time.
  if (isTsJob(settings.jobType) && forceConstantsFor(settings) === 'ReadFC' && !oldCheckpoint) {
    throw new Error('ReadFC needs a checkpoint hand-off; connect a Freq or Opt=CalcFC block as the checkpoint source, or choose CalcFC.');
  }

  const lines = [
    `%Mem=${memory}${unit}`,
    `%NProcShared=${nproc}`,
    `%Chk=${checkpoint}`,
  ];
  let route = routeFor(settings);
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
  lines.push(oneLine(title, 'NodeChem Studio task'));
  lines.push('');
  lines.push(`${charge} ${multiplicity}`);
  lines.push(...coordinateLines);
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

export function outputNameFor(inputName) {
  return String(inputName).replace(/\.(gjf|com)$/i, '.out');
}
