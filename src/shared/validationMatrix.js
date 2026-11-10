/**
 * Validation matrix: a recorded method ladder across a set of reference cases.
 *
 * This is the offline half of issue #230. The case file carries the energies a
 * run already produced (or the reason a rung was not computed); this module
 * validates that record, computes the per-case spread and the aggregate
 * MAE/RMSE against the reference values, and renders a deterministic table.
 *
 * Pure: no filesystem, no network, no clock. The same case file always produces
 * the same table. A rung with no usable energy stays in the result as
 * `not computed` with its reason; it is never dropped, because dropping it
 * would make the validation look better than it was.
 */

import { HARTREE_TO_KCAL_PER_MOL, LADDER_MIN_RUNGS } from './methodLadder.js';

export const VALIDATION_SCHEMA_VERSION = 1;

export class ValidationFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationFormatError';
  }
}

const oneLine = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationFormatError(`${path} must be an object.`);
  }
  return value;
}

function readReference(value, path) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationFormatError(`${path} must be a finite number.`);
    return { value, unit: 'hartree' };
  }
  const object = requireObject(value, path);
  const unit = oneLine(object.unit || 'hartree', 20).toLowerCase();
  if (unit !== 'hartree') {
    throw new ValidationFormatError(`${path}.unit must be "hartree"; convert other units before validation.`);
  }
  const number = finite(object.value);
  if (number === null) throw new ValidationFormatError(`${path}.value must be a finite number.`);
  return { value: number, unit };
}

function readRung(value, path, index) {
  const rung = requireObject(value, path);
  const label = oneLine(rung.label || rung.method || `Rung ${index + 1}`, 80);
  if (!label) throw new ValidationFormatError(`${path}.label is required.`);
  const energy = rung.energyHartree === undefined || rung.energyHartree === null
    ? null
    : finite(rung.energyHartree);
  const reason = oneLine(rung.reason || '', 160);
  if (rung.energyHartree !== undefined && rung.energyHartree !== null && energy === null) {
    throw new ValidationFormatError(`${path}.energyHartree must be a finite number or null.`);
  }
  return {
    index,
    label,
    method: oneLine(rung.method || '', 60),
    basis: oneLine(rung.basis || '', 60),
    energyHartree: energy,
    reason: energy === null ? (reason || 'not computed') : '',
  };
}

function readCase(value, path, index) {
  const item = requireObject(value, path);
  const id = oneLine(item.id || `case-${index + 1}`, 80);
  if (!id) throw new ValidationFormatError(`${path}.id is required.`);
  const name = oneLine(item.name || id, 120);
  const reference = readReference(item.reference, `${path}.reference`);
  const rungs = Array.isArray(item.rungs) ? item.rungs : null;
  if (!rungs || rungs.length < LADDER_MIN_RUNGS) {
    throw new ValidationFormatError(`${path}.rungs must contain at least ${LADDER_MIN_RUNGS} rungs.`);
  }
  return {
    id,
    name,
    reference,
    // Issue 230 live mode: an optional molecule makes the rung runnable. It is
    // carried through untouched; the live runner refuses a malformed one by
    // name instead of inventing coordinates.
    ...(item.molecule && typeof item.molecule === 'object' && !Array.isArray(item.molecule)
      ? { molecule: item.molecule }
      : {}),
    rungs: rungs.map((rung, rungIndex) => readRung(rung, `${path}.rungs[${rungIndex}]`, rungIndex)),
  };
}

/** Parse and validate a case-set document. Throws ValidationFormatError. */
export function parseValidationCases(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const document = requireObject(parsed, 'validation cases');
  const schemaVersion = document.schemaVersion === undefined ? VALIDATION_SCHEMA_VERSION : Number(document.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion !== VALIDATION_SCHEMA_VERSION) {
    throw new ValidationFormatError(`unsupported validation schemaVersion ${JSON.stringify(document.schemaVersion)}; expected ${VALIDATION_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    throw new ValidationFormatError('cases must be a non-empty array.');
  }
  const seen = new Set();
  const cases = document.cases.map((item, index) => {
    const entry = readCase(item, `cases[${index}]`, index);
    if (seen.has(entry.id)) throw new ValidationFormatError(`duplicate case id "${entry.id}".`);
    seen.add(entry.id);
    return entry;
  });
  return { schemaVersion, cases };
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function aggregate(points) {
  if (points.length === 0) {
    return { n: 0, maeKcal: null, rmseKcal: null, maxAbsKcal: null, meanSignedKcal: null };
  }
  const errors = points.map((point) => point.errorKcal);
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  return {
    n: errors.length,
    maeKcal: round(errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length, 4),
    rmseKcal: round(Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length), 4),
    maxAbsKcal: round(Math.max(...errors.map((value) => Math.abs(value))), 4),
    meanSignedKcal: round(mean, 4),
  };
}

/**
 * Build the per-case spread and the aggregate error table.
 *
 * A case's spread is over the rungs that produced an energy. A case with fewer
 * than two computed rungs has `spreadKcal: null` and a reason; its computed
 * points still contribute to the aggregate error, because the reference value
 * is independent of how many rungs ran.
 */
export function buildValidationMatrix(parsed) {
  const { cases } = parsed;
  const allPoints = [];
  const resultCases = cases.map((entry) => {
    const points = entry.rungs.map((rung) => {
      const energy = rung.energyHartree;
      if (energy === null) {
        return {
          label: rung.label,
          status: 'not computed',
          energyHartree: null,
          errorKcal: null,
          reason: rung.reason || 'not computed',
        };
      }
      return {
        label: rung.label,
        status: 'computed',
        energyHartree: round(energy, 9),
        errorKcal: round((energy - entry.reference.value) * HARTREE_TO_KCAL_PER_MOL, 4),
        reason: '',
      };
    });
    allPoints.push(...points.filter((point) => point.status === 'computed'));
    const energies = points.filter((point) => point.status === 'computed').map((point) => point.energyHartree);
    const spreadKcal = energies.length >= 2
      ? round((Math.max(...energies) - Math.min(...energies)) * HARTREE_TO_KCAL_PER_MOL, 4)
      : null;
    const missing = points.filter((point) => point.status === 'not computed').map((point) => point.label);
    return {
      id: entry.id,
      name: entry.name,
      referenceHartree: entry.reference.value,
      rungs: points,
      computedRungs: energies.length,
      spreadKcal,
      status: spreadKcal === null ? 'not computed' : 'computed',
      reason: spreadKcal === null
        ? `fewer than ${LADDER_MIN_RUNGS} rungs produced an energy`
        : '',
      missing,
    };
  });
  const perRung = {};
  for (const point of allPoints) {
    if (!perRung[point.label]) perRung[point.label] = [];
    perRung[point.label].push(point);
  }
  return {
    schemaVersion: parsed.schemaVersion,
    cases: resultCases,
    aggregate: aggregate(allPoints),
    perRung: Object.entries(perRung)
      .map(([label, points]) => ({ label, ...aggregate(points) }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    missing: resultCases.flatMap((entry) => entry.missing.map((label) => `${entry.id}: ${label}`)),
  };
}

/** Parse and build in one call; throws ValidationFormatError. */
export function validationMatrix(input) {
  return buildValidationMatrix(parseValidationCases(input));
}

function number(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/** Deterministic text table for the CLI and a copy-paste report. */
export function validationMatrixText(matrix) {
  const lines = [];
  lines.push('Validation matrix — recorded method ladder');
  lines.push('');
  lines.push('case\trung\tenergy (Eh)\terror (kcal/mol)\tstatus');
  for (const entry of matrix.cases) {
    for (const rung of entry.rungs) {
      lines.push([
        entry.id,
        rung.label,
        number(rung.energyHartree, 9),
        number(rung.errorKcal, 4),
        rung.status === 'computed' ? 'computed' : `not computed — ${rung.reason}`,
      ].join('\t'));
    }
    lines.push(`  ${entry.id} spread: ${number(entry.spreadKcal, 4)} kcal/mol over ${entry.computedRungs} rung(s)`);
  }
  lines.push('');
  lines.push(`aggregate: n=${matrix.aggregate.n} MAE=${number(matrix.aggregate.maeKcal, 4)} kcal/mol `
    + `RMSE=${number(matrix.aggregate.rmseKcal, 4)} kcal/mol max=${number(matrix.aggregate.maxAbsKcal, 4)} kcal/mol`);
  if (matrix.perRung.length > 0) {
    lines.push('per rung:');
    for (const rung of matrix.perRung) {
      lines.push(`  ${rung.label}: n=${rung.n} MAE=${number(rung.maeKcal, 4)} RMSE=${number(rung.rmseKcal, 4)}`);
    }
  }
  if (matrix.missing.length > 0) {
    lines.push('not computed:');
    for (const entry of matrix.missing) lines.push(`  ${entry}`);
  }
  return `${lines.join('\n')}\n`;
}
