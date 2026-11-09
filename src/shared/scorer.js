/**
 * ADR 0001 §2.10 — machine-learned potentials are scorers, not engines.
 *
 * A scorer returns energy (and optionally forces) for a geometry. It has no
 * route, no termination record and no canonical log, so it can never satisfy
 * the engine contract. This module is the role's shared vocabulary: the model
 * card, the domain guard, the explicit unit conversions, and the provenance a
 * result must carry before any caller is allowed to use it.
 *
 * Nothing here spawns a process. The sidecar contract is deliberately typed
 * argv in, JSON out; `electron/runner/scorerRunner.js` owns the spawn.
 */

/** One eV in kcal/mol (CODATA 2018). */
export const EV_TO_KCAL = 23.060548867;
/** One eV in Hartree (CODATA 2018). */
export const EV_TO_HARTREE = 0.03674932217565499;

/**
 * Model cards. The element list is a refusal list: a scorer that extrapolates
 * outside its training set is worse than no scorer, so the guard names the
 * first unsupported element before anything is spawned.
 */
export const SCORER_MODELS = Object.freeze({
  aimnet2: Object.freeze({
    id: 'aimnet2',
    label: 'AIMNet2',
    license: 'MIT (code and weights)',
    elements: Object.freeze(['H', 'B', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'As', 'Se', 'Br', 'I']),
    chargeRange: Object.freeze([-2, 2]),
    // AIMNet2 is charge-aware and closed-shell in the default model card.
    spin: 'restricted',
    note: 'A ranking and refinement layer. Its eV output is converted explicitly to kcal/mol and Hartree; it is never a QM total energy and never comparable with one.',
  }),
});

export const SCORER_SPECS = Object.freeze(Object.keys(SCORER_MODELS).map((id) => `ml:${id}`));

/** `ml:aimnet2` → the model card, or null for an empty/unknown spec. */
export function scorerModel(spec) {
  const text = String(spec ?? '').trim();
  if (!text) return null;
  const match = /^ml:([a-z0-9-]+)$/.exec(text);
  if (!match) return null;
  return SCORER_MODELS[match[1]] || null;
}

/**
 * The domain guard, by name, before spawn. Returns `{ errors, warnings }` with
 * messages that name the element/charge, never a silent extrapolation.
 */
export function scorerDomainFindings({ spec, atoms = [], charge = 0, multiplicity = 1 } = {}) {
  const errors = [];
  const warnings = [];
  const model = scorerModel(spec);
  if (!model) {
    errors.push(`"${spec || ''}" is not a known scorer; use one of ${SCORER_SPECS.join(', ')}.`);
    return { errors, warnings, model: null };
  }
  const allowed = new Set(model.elements);
  const bad = [...new Set(atoms.map((atom) => String(atom?.element || '')).filter((element) => element && !allowed.has(element)))];
  if (bad.length > 0) {
    errors.push(`${model.label} does not cover ${bad.join(', ')}; its model card lists ${model.elements.join(', ')}.`);
  }
  const [minCharge, maxCharge] = model.chargeRange;
  if (!Number.isInteger(charge) || charge < minCharge || charge > maxCharge) {
    errors.push(`${model.label} supports net charge ${minCharge}…${maxCharge}; this structure has ${charge}.`);
  }
  if (multiplicity !== 1) {
    errors.push(`${model.label} is a closed-shell scorer in this build; multiplicity ${multiplicity} is refused rather than approximated.`);
  }
  if (atoms.length > 300) {
    warnings.push(`${model.label} on ${atoms.length} atoms: large systems are outside the benchmarked range and may be slow.`);
  }
  return { errors, warnings, model };
}

/**
 * Validate and convert one sidecar result. The sidecar must return:
 *
 *   { model, version, weightsSha256, dtype, device, cutoffAngstrom,
 *     charge, multiplicity, results: [{ id, energyEv, forces? }] }
 *
 * Missing provenance is a refusal, not an empty string: a number whose model
 * and weights cannot be named is not a result.
 */
export function normalizeScorerResult(raw, { spec, frameIds = [] } = {}) {
  const model = scorerModel(spec);
  if (!model) return { error: `"${spec || ''}" is not a known scorer.` };
  if (!raw || typeof raw !== 'object') return { error: 'The scorer returned no JSON object.' };
  const missing = ['version', 'weightsSha256', 'dtype', 'device', 'cutoffAngstrom']
    .filter((key) => raw[key] === undefined || raw[key] === null || raw[key] === '');
  if (missing.length > 0) {
    return { error: `The scorer result is missing provenance: ${missing.join(', ')}.` };
  }
  const results = Array.isArray(raw.results) ? raw.results : [];
  if (results.length !== frameIds.length) {
    return { error: `The scorer returned ${results.length} result(s) for ${frameIds.length} structure(s).` };
  }
  const byId = new Map(results.map((entry) => [String(entry?.id ?? ''), entry]));
  const converted = [];
  for (const id of frameIds) {
    const entry = byId.get(String(id));
    if (!entry || !Number.isFinite(Number(entry.energyEv))) {
      return { error: `The scorer result for "${id}" has no finite energyEv.` };
    }
    const energyEv = Number(entry.energyEv);
    converted.push({
      id: String(id),
      energyEv,
      energyKcal: energyEv * EV_TO_KCAL,
      energyHartree: energyEv * EV_TO_HARTREE,
      ...(Array.isArray(entry.forces) ? { forces: entry.forces } : {}),
    });
  }
  return {
    error: null,
    model,
    provenance: {
      model: model.id,
      label: model.label,
      version: String(raw.version),
      weightsSha256: String(raw.weightsSha256),
      dtype: String(raw.dtype),
      device: String(raw.device),
      cutoffAngstrom: Number(raw.cutoffAngstrom),
      charge: Number.isInteger(Number(raw.charge)) ? Number(raw.charge) : null,
      multiplicity: Number.isInteger(Number(raw.multiplicity)) ? Number(raw.multiplicity) : null,
      // The one statement every consumer repeats: this is not QM.
      energyKind: 'ML potential energy (eV converted explicitly)',
      comparableWithQuantumChemistry: false,
    },
    results: converted,
  };
}

/**
 * Turn scored frames into the shape `rankEnsemble()` already understands.
 *
 * The ML energy is put in `energyEh` in **Hartree after conversion** and the
 * original eV/kcal values ride along in `scorer`. The summary records the model
 * as `energyMethod`, so no reader can mistake the number for an SCF total.
 */
export function framesForScorerRanking(frames, scored) {
  const byId = new Map(scored.results.map((entry) => [entry.id, entry]));
  return frames.map((frame, index) => {
    const id = String(frame.id ?? frame.scorerId ?? index + 1);
    const entry = byId.get(id);
    return {
      ...frame,
      energyEh: entry.energyHartree,
      energyUnit: 'hartree',
      energyMethod: scored.provenance.label,
      scorer: {
        id,
        model: scored.provenance.model,
        label: scored.provenance.label,
        energyEv: entry.energyEv,
        energyKcal: entry.energyKcal,
        energyHartree: entry.energyHartree,
        version: scored.provenance.version,
        weightsSha256: scored.provenance.weightsSha256,
        dtype: scored.provenance.dtype,
        device: scored.provenance.device,
        cutoffAngstrom: scored.provenance.cutoffAngstrom,
        energyKind: scored.provenance.energyKind,
        comparableWithQuantumChemistry: false,
      },
    };
  });
}

/**
 * Kendall's tau on two orderings, used by the reordering benchmark. It is kept
 * here, beside the role, so a benchmark cannot quietly use a different metric
 * from the one the ADR names.
 */
export function kendallTau(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length || a.length < 2) return null;
  const rank = new Map(b.map((id, index) => [id, index]));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j < a.length; j += 1) {
      const ai = rank.get(a[i]);
      const aj = rank.get(a[j]);
      if (ai === undefined || aj === undefined) return null;
      if ((ai - aj) < 0) concordant += 1;
      else if ((ai - aj) > 0) discordant += 1;
    }
  }
  const total = concordant + discordant;
  return total === 0 ? null : (concordant - discordant) / total;
}
