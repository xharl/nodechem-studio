/**
 * ADR 0001 §2.9 — `prepare` changes one structure deterministically.
 *
 * Four kinds, all 1→1:
 *
 *   embed3d     SMILES / 2D → one 3D structure, via an Open Babel converter
 *   relax       one structure → one MM-relaxed structure, in-app UFF or Open Babel
 *   solvate     one structure → one explicit solvent cluster, deterministic placement
 *   standardize one structure → one cleaned structure, RDKit's standardiser
 *
 * Enumeration (protonation states, tautomers, conformers) belongs to `generate`,
 * never here. `prepare` has no route, no gates and no method settings: the
 * force field is a tool setting, not a level of theory.
 */

export const PREPARE_KINDS = Object.freeze(['embed3d', 'relax', 'solvate', 'standardize']);
export const PREPARE_CONVERTERS = Object.freeze(['uff', 'openbabel', 'aimnet2', 'geometric', 'rdkit']);
export const PREPARE_FORCE_FIELDS = Object.freeze(['UFF', 'MMFF94', 'AIMNet2', 'none']);

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
  // Issue 228: explicit cluster placement. Water is the default because it is
  // the solvent most often used as a micro-solvation probe; the other templates
  // are listed in `explicitSolvation.js`.
  solvent: 'water',
  solventCount: 10,
  seed: 1,
  shellAngstrom: 3.5,
  // ADR 0003 §3.2: a standardise block's cleanup steps. Every step is a
  // deliberate choice; turning one off is recorded in the answer's options.
  normalize: true,
  disconnectMetals: true,
  removeFragments: true,
  chargeParent: true,
});

/** The converter a kind can actually use, so the inspector and schema agree. */
export function converterFor(kind, requested) {
  if (kind === 'embed3d') return 'openbabel';
  if (kind === 'solvate') return 'geometric';
  if (kind === 'standardize') return 'rdkit';
  return requested === 'openbabel' || requested === 'aimnet2' ? requested : 'uff';
}

/** Human label for a prepare block's card and inspector. */
export function prepareLabel(settings) {
  const kind = PREPARE_KINDS.includes(settings?.kind) ? settings.kind : 'relax';
  if (kind === 'embed3d') return '3D embed';
  if (kind === 'standardize') return 'Standardise (RDKit)';
  if (kind === 'solvate') return `Solvate (${settings?.solvent || 'water'} ×${settings?.solventCount ?? 10})`;
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
  if (output.kind === 'standardize') {
    const before = output.before || {};
    const after = output.after || {};
    const parts = ['standardised', after.formula || '', `${after.atomCount ?? '?'} atoms`];
    if (output.fragmentsRemoved?.length) parts.push(`${output.fragmentsRemoved.length} fragment(s) removed`);
    if (before.charge !== after.charge) parts.push(`charge ${before.charge ?? '?'} → ${after.charge ?? '?'}`);
    if (output.geometry?.source === 'etkdgv3') parts.push('geometry re-embedded (ETKDGv3)');
    return parts.filter(Boolean).join(' · ');
  }
  if (output.kind === 'solvate') {
    const composition = output.composition || {};
    return [
      'explicit cluster',
      `${output.solvent?.label || 'solvent'} ×${output.count ?? composition.solventCount ?? '?'}`,
      `${output.atomCount ?? composition.totalAtoms ?? '?'} atoms`,
      `seed ${output.seed ?? '?'}`,
      'not bulk, not equilibrated',
    ].filter(Boolean).join(' · ');
  }
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
  if (output.kind === 'solvate') return 'not applicable (placement, not relaxation)';
  if (output.kind === 'standardize') return 'not applicable (deterministic cleanup)';
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
