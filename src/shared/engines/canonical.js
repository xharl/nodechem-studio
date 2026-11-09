/**
 * Canonical calculation result — the engine-neutral contract.
 *
 * Every engine parser returns this shape and every consumer (gates, condition
 * fields, the run record) reads only this shape. Nothing downstream may look at
 * an engine's raw text or regexes, so adding an engine never touches the
 * validation layer.
 *
 * Shape (version 1):
 *
 *   {
 *     canonicalVersion: 1,
 *     engine: 'gaussian' | 'xtb' | 'orca',
 *     program: { name, version, revision },      // provenance
 *     status: 'completed' | 'error' | 'incomplete',
 *     terminationCode: 'normal' | 'error' | 'none',
 *     termination: <engine's own phrase, for display only>,
 *     complete: boolean,                          // false when the parse is partial
 *     scf: { status: 'converged'|'failed'|'unknown', energyHartree, cycles, method,
 *            applicable: boolean },
 *     optimization: { completed, stationary, cycles },
 *     frequencies: { count, imaginaryCount, imaginaryValues, minImaginary },
 *     thermochemistry: { freeEnergyHartree, enthalpyHartree, zpeHartree, entropyTreatment },
 *     finalEnergy: { hartree, source },
 *     excitedStates: { count, requested, perIrrep, states, source, verified,
 *                      transitionDipoleCount } | absent,
 *     epr: { status: 'open-shell'|'closed-shell'|'unavailable', populations,
 *            hyperfine, gTensor } | absent,   // issue 168
 *     solvation: { provider, model, solvent, radiiSet, gasPhaseHartree,
 *                  solvatedHartree, deltaHartree, deltaKcal,
 *                  interactionHartree } | absent,  // issue 167, DDX only
 *     extras: { ... },                            // engine-specific evidence
 *     lineCount
 *   }
 *
 * Fields an engine cannot report stay `null` — never 0, never guessed. A gate
 * that needs a null field must return `unknown`, which never passes.
 */

export const CANONICAL_VERSION = 1;

export const TERMINATION = Object.freeze({
  NORMAL: 'normal',
  ERROR: 'error',
  NONE: 'none',
});

/**
 * Derive the termination code from either the canonical field or the legacy
 * display string. The string fallback keeps Gaussian records written before
 * this contract readable.
 */
export function terminationCodeOf(parsed) {
  if (!parsed) return TERMINATION.NONE;
  if (parsed.terminationCode === TERMINATION.NORMAL || parsed.terminationCode === TERMINATION.ERROR) {
    return parsed.terminationCode;
  }
  const text = String(parsed.termination || '');
  if (/^normal termination/i.test(text) || /terminated normally/i.test(text)) return TERMINATION.NORMAL;
  if (/^error termination/i.test(text) || /^abnormal termination/i.test(text)) return TERMINATION.ERROR;
  return TERMINATION.NONE;
}

export function statusForTermination(code) {
  if (code === TERMINATION.NORMAL) return 'completed';
  if (code === TERMINATION.ERROR) return 'error';
  return 'incomplete';
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const integerOrNull = (value) => (Number.isInteger(value) ? value : null);

/**
 * Normalise a parser's output into the canonical shape. Missing or malformed
 * sections become nulls rather than throwing, so a partly-written engine can
 * never crash the runner.
 */
export function canonicalResult({
  engine,
  program = {},
  termination = 'No termination marker',
  terminationCode = null,
  complete = true,
  scf = {},
  optimization = {},
  frequencies = {},
  thermochemistry = {},
  finalEnergy = {},
  // SAPT's interaction-energy table, when the engine produced one. Kept out of
  // `finalEnergy` on purpose: it is not a total energy for the complex.
  sapt = null,
  // Issue 167: the DDX solvation block (model, solvent, cavity, the gas-phase
  // and solvated energies and their difference). Passed through whole for the
  // same reason as `epr`: a difference without the model and the cavity that
  // produced it is a number nobody can check. Absent on a vacuum run.
  solvation = null,
  // An excitation table, when the engine computed one. Present only for a job
  // that asked for excited states; absent otherwise, so a Gaussian log without a
  // TD section and a Psi4 single point look the same to every consumer.
  excitedStates = null,
  // Issue 168: the EPR block (spin populations, Fermi-contact couplings, and the
  // g-tensor refusal). Present whenever an engine reported one — including the
  // closed-shell case, whose block says "no unpaired electrons" in words. It is
  // passed through whole rather than field-by-field because a consumer that
  // reads a population must also be able to read the scheme and the caveat that
  // qualify it, and a half-copied section is how a table ends up on a card with
  // no statement of where it came from.
  epr = null,
  // Issue 173, route B: the charge-transfer analysis of a TD run. Passed through
  // whole, like `epr`, because a fraction is meaningless without the partition
  // that produced it, the level of theory it was computed at, and the per-state
  // detail it came from — a consumer that copies `ctFraction` alone would present
  // a number with none of those. Absent when the engine computed no transition
  // density, so a run that never opted in carries no key.
  chargeTransfer = null,
  extras = {},
  lineCount = 0,
} = {}) {
  const code = terminationCode === TERMINATION.NORMAL || terminationCode === TERMINATION.ERROR
    ? terminationCode
    : terminationCodeOf({ termination });

  const imaginaryValues = Array.isArray(frequencies.imaginaryValues)
    ? frequencies.imaginaryValues.filter((value) => Number.isFinite(value))
    : [];

  return {
    canonicalVersion: CANONICAL_VERSION,
    engine: String(engine || 'unknown'),
    program: {
      name: program.name ? String(program.name) : null,
      version: program.version ? String(program.version) : null,
      revision: program.revision ? String(program.revision) : null,
    },
    status: statusForTermination(code),
    terminationCode: code,
    termination: String(termination || 'No termination marker'),
    complete: Boolean(complete),
    scf: {
      status: ['converged', 'failed', 'unknown'].includes(scf.status) ? scf.status : 'unknown',
      energyHartree: finiteOrNull(scf.energyHartree),
      cycles: integerOrNull(scf.cycles),
      method: scf.method ? String(scf.method) : null,
      /** False for a force-field result that has a final energy but no SCF loop. */
      applicable: scf.applicable !== false,
    },
    optimization: {
      completed: Boolean(optimization.completed),
      stationary: Boolean(optimization.stationary),
      cycles: integerOrNull(optimization.cycles),
      /**
       * Whether the run actually attempted an optimisation. `null` means the
       * engine did not say (Gaussian's parser reports only completion), `false`
       * is evidence that no optimisation record exists, which is different from
       * an optimisation that failed to converge.
       */
      attempted: optimization.attempted === true
        ? true
        : optimization.attempted === false ? false : null,
    },
    frequencies: {
      count: Number.isFinite(frequencies.count) ? frequencies.count : 0,
      imaginaryCount: Number.isInteger(frequencies.imaginaryCount) ? frequencies.imaginaryCount : 0,
      imaginaryValues: imaginaryValues.slice(0, 20),
      minImaginary: finiteOrNull(frequencies.minImaginary),
      scalingFactor: finiteOrNull(frequencies.scalingFactor),
      entropyTreatment: frequencies.entropyTreatment ? String(frequencies.entropyTreatment) : null,
    },
    thermochemistry: {
      freeEnergyHartree: finiteOrNull(thermochemistry.freeEnergyHartree),
      enthalpyHartree: finiteOrNull(thermochemistry.enthalpyHartree),
      zpeHartree: finiteOrNull(thermochemistry.zpeHartree),
      entropyTreatment: thermochemistry.entropyTreatment ? String(thermochemistry.entropyTreatment) : null,
    },
    finalEnergy: {
      hartree: finiteOrNull(finalEnergy.hartree),
      source: finalEnergy.source ? String(finalEnergy.source) : null,
    },
    ...(sapt && typeof sapt === 'object' ? { sapt } : {}),
    // Issue 167: a block without a `provider` is not a solvation section and is
    // dropped rather than passed on as an empty one.
    ...(solvation && typeof solvation === 'object'
      && typeof solvation.provider === 'string' ? { solvation } : {}),
    ...(excitedStates && Array.isArray(excitedStates.states) && excitedStates.states.length > 0
      ? {
        excitedStates: {
          count: Number.isFinite(excitedStates.count) ? excitedStates.count : excitedStates.states.length,
          requested: integerOrNull(excitedStates.requested),
          perIrrep: Array.isArray(excitedStates.perIrrep) ? excitedStates.perIrrep : [],
          states: excitedStates.states,
          source: excitedStates.source ? String(excitedStates.source) : null,
          /** True only when a real log of this layout was parsed (not a guess). */
          verified: excitedStates.verified === true,
          /**
           * Issue 173: how many states carry a recorded transition-dipole vector
           * (`transitionDipoleAu`, atomic units, on each state). The states are
           * passed through as the engine produced them, so the vector survives
           * this whitelist; the count is carried beside it because a consumer
           * deciding whether a coupling is possible must not infer it from the
           * oscillator strengths.
           */
          transitionDipoleCount: integerOrNull(excitedStates.transitionDipoleCount),
          /**
           * Issue 173, route B: how many states carry a transition-density block,
           * and the fragment label of each atom as the deck declared it. Kept
           * beside the states for the same reason as the dipole count: the CT
           * analysis starts from those two facts and a consumer must not have to
           * infer either from the log's text.
           */
          transitionDensityCount: integerOrNull(excitedStates.transitionDensityCount),
          fragmentLabels: Array.isArray(excitedStates.fragmentLabels)
            ? excitedStates.fragmentLabels.map((label) => (Number.isInteger(label) ? label : null))
            : null,
        },
      }
      : {}),
    ...(epr && typeof epr === 'object' && typeof epr.status === 'string' ? { epr } : {}),
    // Issue 173: a boolean `modelled` is the minimum a consumer can act on; a
    // block without it is not a CT analysis and is dropped rather than passed on
    // as an empty section.
    ...(chargeTransfer && typeof chargeTransfer === 'object'
      && typeof chargeTransfer.modelled === 'boolean' ? { chargeTransfer } : {}),
    extras: extras && typeof extras === 'object' ? extras : {},
    lineCount: Number.isFinite(lineCount) ? lineCount : 0,
  };
}

/** True when the parsed result carries the fields a gate needs to be judged. */
export function hasEnergy(parsed) {
  return Boolean(parsed && Number.isFinite(parsed.finalEnergy?.hartree));
}
