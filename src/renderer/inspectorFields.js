/**
 * Engine-aware field contract for the calculation inspector.
 *
 * Pure data and predicates only: no DOM, no Node APIs. `src/renderer/app.js`
 * uses the same predicates to decide which controls to render, so the field
 * list below can be tested without a browser and cannot silently drift from
 * the inspector.
 */

import { isOptJob } from '../shared/tsForceConstants.js';

/**
 * Gaussian Link 0 / resource fields. xTB ignores all of them; a thread count
 * is passed through OMP_NUM_THREADS instead (see `XtbRunner`).
 */
export const GAUSSIAN_RESOURCE_KEYS = Object.freeze([
  'memory',
  'memoryUnit',
  'nproc',
  'checkpoint',
]);

export function showsGaussianResources(engineId) {
  return engineId !== 'xtb';
}

/** Checkpoint hand-off is Gaussian-only until the queue handles xtbrestart. */
export function showsCheckpointHandoff(engineId) {
  return engineId !== 'xtb';
}

export function showsXtbThreads(engineId) {
  return engineId === 'xtb';
}

/**
 * Build the settings object sent to a run. Gaussian keeps every key exactly as
 * it was; xTB drops the hidden Gaussian resource fields so the payload cannot
 * imply that memory, cores or a checkpoint file affect the run.
 */
export function runSettingsFor(engineId, settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const next = { ...source };
  if (engineId === 'xtb') {
    for (const key of GAUSSIAN_RESOURCE_KEYS) delete next[key];
  }
  return next;
}

const GATE_FIELDS = Object.freeze([
  'gates.termination',
  'gates.scf',
  'gates.imaginary',
  'gates.minMagnitude',
  'gates.thermo',
  'gates.finalEnergy',
]);

/**
 * Ordered field ids rendered by the calculation inspector for an engine.
 * Conditional Gaussian route fields are included only when the job type would
 * render them. IDs are stable labels, not DOM selectors.
 */
export function calcInspectorFieldIds(engineId, settings = {}) {
  const jobType = String(settings?.jobType || 'Opt');
  const fields = ['job.title', 'job.jobType'];

  if (engineId === 'xtb') {
    fields.push('xtb.hamiltonian', 'xtb.optLevel');
    if (showsXtbThreads(engineId)) fields.push('xtb.threads');
  } else {
    if (jobType === 'IRC') fields.push('job.ircDirection');
    if (isOptJob(jobType)) fields.push('job.optConvergence');
    if (jobType === 'Opt=TS') fields.push('job.forceConstants');
    fields.push('job.memory', 'job.memoryUnit', 'job.nproc', 'job.checkpoint');
    fields.push(
      'method.routePreset',
      'method.method',
      'method.basis',
      'method.dispersion',
      'method.scf',
      'method.grid',
      'method.population',
      'method.verbosity',
      'method.tdStates',
      'method.tdTriplets',
    );
  }

  fields.push('solvation.enabled', 'solvation.model', 'solvation.solvent');
  fields.push('molecule.charge', 'molecule.multiplicity');
  fields.push(...GATE_FIELDS);
  if (engineId !== 'xtb') fields.push('validity.checks');
  fields.push('dependencies.inputs');
  if (showsCheckpointHandoff(engineId)) fields.push('dependencies.checkpointFrom');
  fields.push('output.view');
  if (engineId !== 'xtb') fields.push('keywords.custom');
  return fields;
}
