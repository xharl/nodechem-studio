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
export const PREPARE_CONVERTERS = Object.freeze(['uff', 'openbabel']);
export const PREPARE_FORCE_FIELDS = Object.freeze(['UFF', 'MMFF94']);

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
  return requested === 'openbabel' ? 'openbabel' : 'uff';
}

/** Human label for a prepare block's card and inspector. */
export function prepareLabel(settings) {
  const kind = settings?.kind === 'embed3d' ? 'embed3d' : 'relax';
  if (kind === 'embed3d') return '3D embed';
  return settings?.converter === 'openbabel' ? 'MM relax (Open Babel)' : 'UFF relax';
}
