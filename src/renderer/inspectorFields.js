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
import { qstKindFor } from '../shared/constraints.js';

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

/** Job types whose Gaussian input reads a ModRedundant section (#93). */
const MODREDUNDANT_JOB_TYPES = Object.freeze(['Opt', 'Opt Freq', 'Opt=TS', 'Opt=QST2', 'Opt=QST3']);

/**
 * Ordered field ids rendered by the calculation inspector for an engine.
 * Conditional Gaussian route fields are included only when the job type would
 * render them. IDs are stable labels, not DOM selectors.
 */
export function calcInspectorFieldIds(engineId, settings = {}) {
  const jobType = String(settings?.jobType || 'Opt');
  const fields = ['job.title', 'job.jobType'];

  if (engineId === 'psi4') {
    // Psi4 has its own method, basis and job list, no checkpoint, no solvation,
    // no Gaussian route keywords. What the builder writes is what is offered.
    fields.push('job.reference', 'job.memory', 'job.memoryUnit', 'job.nproc');
    fields.push('method.method', 'method.basis');
    fields.push('molecule.charge', 'molecule.multiplicity');
    fields.push(...GATE_FIELDS);
    fields.push('validity.checks', 'dependencies.inputs', 'output.view');
    return fields;
  }

  if (engineId === 'xtb') {
    fields.push('xtb.hamiltonian', 'xtb.optLevel');
    if (showsXtbThreads(engineId)) fields.push('xtb.threads');
  } else {
    if (jobType === 'IRC') fields.push('job.ircDirection');
    if (isOptJob(jobType)) fields.push('job.optConvergence');
    if (jobType === 'Opt=TS') fields.push('job.forceConstants');
    // Issue #93: a ModRedundant section needs an optimisation job and a
    // Gaussian block; QST structures exist only for an STQN job type.
    if (engineId === 'gaussian' && MODREDUNDANT_JOB_TYPES.includes(jobType)) fields.push('job.constraints');
    if (engineId === 'gaussian' && qstKindFor(jobType)) fields.push('job.qst');
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
        'method.tdRoot',
        'method.ntoTransition',
        'method.nto',
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
