/**
 * Settings shaping shared by the renderer, the queue and the CLI.
 *
 * Gaussian keeps every key exactly as it was. xTB drops the hidden Gaussian
 * resource fields so a run payload cannot imply that memory, cores or a
 * checkpoint file affect an xTB run. PySCF uses `nproc` as its thread count
 * (through OMP_NUM_THREADS) but has no memory keyword and no checkpoint file,
 * so those are dropped too.
 */

export const GAUSSIAN_RESOURCE_KEYS = Object.freeze([
  'memory',
  'memoryUnit',
  'nproc',
  'checkpoint',
]);

/** Keys that would be a false promise on a PySCF block. `nproc` is kept. */
export const PYSCF_HIDDEN_KEYS = Object.freeze([
  'memory',
  'memoryUnit',
  'checkpoint',
]);

export function runSettingsFor(engineId, settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const next = { ...source };
  if (engineId === 'xtb') {
    for (const key of GAUSSIAN_RESOURCE_KEYS) delete next[key];
  } else if (engineId === 'pyscf') {
    for (const key of PYSCF_HIDDEN_KEYS) delete next[key];
  }
  return next;
}
