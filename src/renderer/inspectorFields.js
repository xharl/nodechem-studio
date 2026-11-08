/**
 * Engine-aware field contract for the calculation inspector.
 *
 * Pure data and predicates only: no DOM, no Node APIs. `src/renderer/app.js`
 * uses the same predicates to decide which controls to render, so the field
 * list below can be tested without a browser and cannot silently drift from
 * the inspector.
 */

import { isOptJob } from '../shared/tsForceConstants.js';
import { isCompositeJobType } from '../shared/routePresets.js';

/**
 * Gaussian Link 0 / resource fields. xTB ignores all of them; a thread count
 * is passed through OMP_NUM_THREADS instead (see `XtbRunner`). The list and the
 * shaping live in `src/shared/engineSettings.js` so the CLI shares them.
 */
export { GAUSSIAN_RESOURCE_KEYS, runSettingsFor } from '../shared/engineSettings.js';

export function showsGaussianResources(engineId) {
  return engineId !== 'xtb';
}

/** Only the engines that write a restart file usable by the next block. */
export function showsCheckpointHandoff(engineId) {
  return engineId === 'gaussian' || engineId === 'orca';
}

export function showsXtbThreads(engineId) {
  return engineId === 'xtb';
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
    // A composite keyword carries its own method, basis and job steps (#77), and
    // the inspector replaces the whole group with a note, so none of these
    // fields exist while one is chosen.
    if (!isCompositeJobType(jobType)) {
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
  }

  // Solvation belongs to both engines; a composite route refuses it.
  if (!isCompositeJobType(jobType)) fields.push('solvation.enabled', 'solvation.model', 'solvation.solvent');

  fields.push('molecule.charge', 'molecule.multiplicity');
  fields.push(...GATE_FIELDS);
  if (engineId !== 'xtb') fields.push('validity.checks');
  fields.push('dependencies.inputs');
  if (showsCheckpointHandoff(engineId)) fields.push('dependencies.checkpointFrom');
  fields.push('output.view');
  if (engineId !== 'xtb') fields.push('keywords.custom');
  return fields;
}
