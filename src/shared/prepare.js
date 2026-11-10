/**
 * ADR 0001 §2.9 — `prepare` changes one structure deterministically.
 *
 * Two kinds only, and both are 1→1:
 *
 *   embed3d  SMILES / 2D → one 3D structure, via an Open Babel converter
 *   relax    one structure → one MM-relaxed structure, in-app UFF or Open Babel
 *
 * Enumeration (protonation states, tautomers, conformers) belongs to `generate`,
 * never here. `prepare` has no route, no gates and no method settings: the
 * force field is a tool setting, not a level of theory.
 */

export const PREPARE_KINDS = Object.freeze(['embed3d', 'relax']);
export const PREPARE_CONVERTERS = Object.freeze(['uff', 'openbabel', 'aimnet2']);
export const PREPARE_FORCE_FIELDS = Object.freeze(['UFF', 'MMFF94', 'AIMNet2']);

/**
 * Issue #257: the queue records this exact reason when a dry run carries the
 * geometry forward without spawning the converter. `converged: null` means
 * "never ran", which is a different fact from `false` ("ran, hit the cap").
 */
export const PREPARE_DRY_RUN_REASON = 'dry-run (converter not run)';

export const DEFAULT_PREPARE_SETTINGS = Object.freeze({
  kind: 'relax',
  converter: 'uff',
  forceField: 'UFF',
  // Used by embed3d only. A SMILES with no 3D geometry is the point of the
  // block; a project molecule already carrying coordinates does not need it.
  smiles: '',
  charge: 0,
  multiplicity: 1,
});

/** The converter a kind can actually use, so the inspector and schema agree. */
export function converterFor(kind, requested) {
  if (kind === 'embed3d') return 'openbabel';
  return requested === 'openbabel' || requested === 'aimnet2' ? requested : 'uff';
}

/** Human label for a prepare block's card and inspector. */
export function prepareLabel(settings) {
  const kind = settings?.kind === 'embed3d' ? 'embed3d' : 'relax';
  if (kind === 'embed3d') return '3D embed';
  if (settings?.converter === 'aimnet2') return 'ML relax (AIMNet2)';
  return settings?.converter === 'openbabel' ? 'MM relax (Open Babel)' : 'UFF relax';
}

/** True when this record only says the converter was deliberately not run. */
export function isDryRunPrepareOutput(output) {
  return Boolean(output) && output.reason === PREPARE_DRY_RUN_REASON;
}

/**
 * Issue #257: `converged: null` is not a failed relaxation. A dry run never
 * spawned the converter and must not borrow the vocabulary of an MM run.
 */
export function prepareConvergenceLabel(output) {
  if (!output || output.kind !== 'relax' || isDryRunPrepareOutput(output)) return '';
  if (output.converged === true) return 'converged';
  if (output.converged === false) {
    const steps = Number(output.iterations);
    return Number.isFinite(steps) && steps > 0
      ? `not converged (${steps} steps)`
      : 'not converged';
  }
  return '';
}

/**
 * One-line summary of a `prepare` record, shared by the queue log, the card
 * footer and the inspector header so the three cannot drift apart (#257).
 *
 *   dry run              dry run · converter not run (geometry unchanged)
 *   relaxed, converged   relaxed · openbabel · 0.123 kcal/mol · converged
 *   relaxed, capped      relaxed · openbabel · not converged (500 steps)
 */
export function prepareSummaryLine(output) {
  if (!output || typeof output !== 'object') return '';
  if (isDryRunPrepareOutput(output)) return 'dry run · converter not run (geometry unchanged)';
  const parts = [
    output.kind === 'embed3d' ? '3D embedded' : 'relaxed',
    output.converter,
  ];
  if (Number.isFinite(output.energyKcal)) parts.push(`${output.energyKcal.toFixed(3)} kcal/mol`);
  const convergence = prepareConvergenceLabel(output);
  if (convergence) parts.push(convergence);
  return parts.filter(Boolean).join(' · ');
}

/**
 * The inspector's "Converged" row. Never says yes/no for a dry run: the
 * converter did not execute, so the honest value is "not run".
 */
export function prepareConvergenceText(output) {
  if (!output) return '';
  if (isDryRunPrepareOutput(output)) return 'not run (dry run)';
  if (output.kind !== 'relax') return 'not applicable';
  if (output.converged === true) return 'yes';
  if (output.converged === false) {
    const steps = Number(output.iterations);
    const count = Number.isFinite(steps) && steps > 0 ? `${steps} steps` : '';
    return ['no', count, output.reason].filter(Boolean).join(' · ');
  }
  // A record with no convergence boolean at all: unknown, never "no".
  return 'not reported';
}
