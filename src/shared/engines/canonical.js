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
 *     engine: 'gaussian' | 'xtb',
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
    extras: extras && typeof extras === 'object' ? extras : {},
    lineCount: Number.isFinite(lineCount) ? lineCount : 0,
  };
}

/** True when the parsed result carries the fields a gate needs to be judged. */
export function hasEnergy(parsed) {
  return Boolean(parsed && Number.isFinite(parsed.finalEnergy?.hartree));
}
