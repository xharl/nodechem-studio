/**
 * Settings shaping shared by the renderer, the queue and the CLI.
 *
 * Gaussian keeps every key exactly as it was. xTB drops the hidden Gaussian
 * resource fields so a run payload cannot imply that memory, cores or a
 * checkpoint file affect an xTB run.
 */

export const GAUSSIAN_RESOURCE_KEYS = Object.freeze([
  'memory',
  'memoryUnit',
  'nproc',
  'checkpoint',
]);

export function runSettingsFor(engineId, settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const next = { ...source };
  if (engineId === 'xtb') {
    for (const key of GAUSSIAN_RESOURCE_KEYS) delete next[key];
  }
  return next;
}
