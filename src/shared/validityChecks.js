/**
 * Validity checks — the computational-chemistry validation protocol encoded as
 * pure project checks (issue #25).
 *
 * Every gate in the runner answers "did the job run?". These checks answer
 * "is the science defensible?" They never touch the filesystem, Electron or the
 * network, and they never turn a missing value into a pass: a check that has no
 * evidence returns `unknown`.
 *
 * Contract
 * --------
 * Each check is a pure function of one context object and returns exactly
 *
 *   { id, status, message, evidence }
 *
 * `status` is one of `pass`, `fail`, `warning`, `unknown`, `skipped`.
 * `severity` is derived from the status and is what a run record reports:
 *
 *   fail    -> error    (pre-run: blocking where metadata says blocking)
 *   warning -> warning  (never blocks a run)
 *   unknown -> info     (no value; never treated as a pass)
 *   pass, skipped -> null
 *
 * Checks run in two phases:
 *
 *   pre   — project validation, before an input is exported or a queue starts.
 *   post  — gate evaluation over a parsed run record.
 *
 * Every check can be disabled per node with `settings.disabledChecks`; a
 * disabled check is omitted from the result entirely, not reported as a pass.
 *
 * Thresholds
 * ----------
 * All numeric limits live in the exported frozen objects below and are
 * deliberate, documented choices rather than magic numbers:
 *
 * - `GEOMETRY_LIMITS.clash` 0.55: two atoms closer than 0.55 x the sum of their
 *   single-bond covalent radii are on top of each other; an SCF on that
 *   geometry is meaningless, so this fails pre-run.
 * - `GEOMETRY_LIMITS.shortBond` 0.75: a contact shorter than 0.75 x the radius
 *   sum is shorter than any real bond order allows (C=C is 0.88, C#C is 0.79),
 *   so it is reported as a suspicious compression, not a hard failure.
 * - `GEOMETRY_LIMITS.longBond` 1.20 / `bond` 1.30: a contact between 1.20 and
 *   1.30 x the radius sum is still bond-like but stretched (C-C at 1.90 A is
 *   1.25); beyond 1.30 the pair is treated as non-bonded and not judged, so
 *   ordinary non-covalent contacts cannot produce a finding.
 * - `GEOMETRY_LIMITS.linearAngleDeg` 170: an O or S centre with two bonds is
 *   bent in every ordinary molecule (water 104.5, ether 112, thioether 100);
 *   a near-linear angle there is the classic collinear starting geometry that
 *   breaks a Berny optimisation. Carbons and nitrogens are excluded because an
 *   alkyne carbon and an azide nitrogen are legitimately linear.
 * - `GEOMETRY_LIMITS.acuteAngleDeg` 40: three atoms in a 40-degree or sharper
 *   arrangement at any centre indicate a collapsed geometry.
 * - `SPIN_CONTAMINATION_LIMITS.warn` 0.10: the usual organic-radical tolerance
 *   for |S**2(after annihilation) - S(S+1)|; `fail` 0.50 means the
 *   single-reference label no longer describes the wavefunction.
 * - `TS_IMAGINARY_FLOOR_CM1` 50: matches the existing `minMagnitude` gate
 *   default; a smaller imaginary mode is usually numerical noise.
 * - Covalent radii are Cordero et al., Dalton Trans. 2008, 2832 (single bonds,
 *   Angstrom). Elements missing from the table make the geometry check
 *   `unknown`, never `pass`.
 */

import { atomicNumber } from './elements.js';
import { hasBuiltinDispersion } from './routePresets.js';

export const CHECK_STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  WARNING: 'warning',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
});

export const CHECK_SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

/**
 * The check registry, in report order. `blocking` applies to the pre-run phase
 * only: a failing blocking check makes the project invalid because the run it
 * would launch cannot produce a meaningful result.
 */
export const VALIDITY_CHECKS = Object.freeze([
  {
    id: 'charge-multiplicity',
    title: 'Charge / multiplicity',
    phases: Object.freeze(['pre', 'post']),
    blocking: true,
    engines: Object.freeze(['gaussian', 'xtb']),
    description: 'The electron count must have the parity the multiplicity implies, and the reference must be compatible with it.',
  },
  {
    id: 'spin-contamination',
    title: 'Spin contamination',
    phases: Object.freeze(['post']),
    blocking: false,
    engines: Object.freeze(['gaussian']),
    description: 'Unrestricted S**2 after annihilation must match S(S+1) for the requested multiplicity.',
  },
  {
    id: 'geometry-sanity',
    title: 'Geometry sanity',
    phases: Object.freeze(['pre']),
    blocking: true,
    engines: Object.freeze(['gaussian', 'xtb']),
    description: 'Atom clashes, implausibly short contacts, stretched bonds and angle anomalies against covalent radii.',
  },
  {
    id: 'imaginary-frequencies',
    title: 'Stationary-point frequencies',
    phases: Object.freeze(['post']),
    blocking: false,
    engines: Object.freeze(['gaussian', 'xtb']),
    description: 'A TS has exactly one imaginary mode; a minimum has none.',
  },
  {
    id: 'method-basis-compatibility',
    title: 'Method / basis compatibility',
    phases: Object.freeze(['pre', 'post']),
    blocking: true,
    engines: Object.freeze(['gaussian']),
    description: 'Heavy elements need a basis that carries an ECP, and built-in dispersion must not be double-counted.',
  },
  {
    id: 'opt-convergence',
    title: 'Optimisation convergence',
    phases: Object.freeze(['pre', 'post']),
    blocking: false,
    engines: Object.freeze(['gaussian', 'xtb']),
    description: 'A frequency job may only claim a minimum when the optimisation it reads completed.',
  },
]);

export const VALIDITY_CHECK_IDS = Object.freeze(VALIDITY_CHECKS.map((check) => check.id));

/** |S**2_after - S(S+1)| thresholds. Documented in the module header. */
export const SPIN_CONTAMINATION_LIMITS = Object.freeze({
  warn: 0.10,
  fail: 0.50,
});

/** Floor below which a single imaginary mode is treated as numerical noise. */
export const TS_IMAGINARY_FLOOR_CM1 = 50;

/** Ratios are distance / (covalent radius_i + covalent radius_j). */
export const GEOMETRY_LIMITS = Object.freeze({
  clash: 0.55,
  shortBond: 0.75,
  longBond: 1.20,
  bond: 1.30,
  linearAngleDeg: 170,
  acuteAngleDeg: 40,
});

/**
 * Single-bond covalent radii in Angstrom (Cordero et al., Dalton Trans. 2008,
 * 2832). Deliberately a data table, not a formula: an element that is not
 * listed makes the geometry check `unknown`.
 */
export const COVALENT_RADII_ANGSTROM = Object.freeze({
  H: 0.31, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02,
  K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39,
  Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20,
  As: 1.19, Se: 1.20, Br: 1.20, Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75,
  Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45,
  Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Cs: 2.44,
  Ba: 2.15, La: 2.07, Hf: 1.75, Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44,
  Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32, Tl: 1.45, Pb: 1.46, Bi: 1.48,
  Th: 2.06, U: 1.96,
});

const BENT_CENTRES = new Set(['O', 'S']);

/** Covalent radius lookup that never walks the prototype chain. */
function covalentRadius(element) {
  return Object.prototype.hasOwnProperty.call(COVALENT_RADII_ANGSTROM, element)
    ? COVALENT_RADII_ANGSTROM[element]
    : null;
}

/**
 * Bases that ship effective core potentials for heavy elements in Gaussian 16.
 * A route that puts a fifth-row or heavier element in an all-electron Pople or
 * correlation-consistent basis has no functions for that atom.
 */
const ECP_BASIS_PREFIXES = Object.freeze([
  'lanl2dz', 'lanl2mb', 'sdd', 'shc', 'def2', 'stuttgart', 'rlc', 'crel',
  'mwb', 'dzvp-dkh', 'cc-pvdz-pp', 'cc-pvtz-pp', 'cc-pvqz-pp',
]);

/** Methods that do not consume a Gaussian basis/ECP at all. */
const SEMIEMPIRICAL_METHODS = Object.freeze([
  'am1', 'pm3', 'pm6', 'pm7', 'mndo', 'mindo', 'indo', 'cndo', 'zindo',
]);

/** Composite methods that fix their own basis and ECP sequence. */
const COMPOSITE_METHODS = Object.freeze([
  'g1', 'g2', 'g3', 'g4', 'cbsqb3', 'cbsapno', 'w1', 'w1bd',
]);

/** First element beyond krypton: all-electron Pople/cc bases stop at Kr. */
const ECP_REQUIRED_FROM_Z = 37;

function oneLine(value, fallback = '') {
  return String(value ?? fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function methodKey(value) {
  return oneLine(value).toLowerCase().replace(/ω/g, 'w').replace(/[^a-z0-9]/g, '');
}

function isEcpBasis(basis) {
  const key = oneLine(basis).toLowerCase().replace(/\s+/g, '');
  return ECP_BASIS_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function toAtomList(molecule) {
  const coords = Array.isArray(molecule?.coords) ? molecule.coords : [];
  return coords
    .filter((atom) => atom && typeof atom === 'object')
    .map((atom) => ({
      element: oneLine(atom.element),
      x: finiteNumber(atom.x),
      y: finiteNumber(atom.y),
      z: finiteNumber(atom.z),
    }));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function angleDegrees(a, centre, b) {
  const v1 = [a.x - centre.x, a.y - centre.y, a.z - centre.z];
  const v2 = [b.x - centre.x, b.y - centre.y, b.z - centre.z];
  const n1 = Math.hypot(...v1);
  const n2 = Math.hypot(...v2);
  if (n1 === 0 || n2 === 0) return null;
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const cosine = Math.max(-1, Math.min(1, dot / (n1 * n2)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function severityOf(status) {
  if (status === CHECK_STATUS.FAIL) return CHECK_SEVERITY.ERROR;
  if (status === CHECK_STATUS.WARNING) return CHECK_SEVERITY.WARNING;
  if (status === CHECK_STATUS.UNKNOWN) return CHECK_SEVERITY.INFO;
  return null;
}

/**
 * The four-key finding contract every check returns. `severity` is attached by
 * `runValidityChecks`, derived from the status, so the record reports both the
 * outcome and its consequence.
 */
function finding(id, status, message, evidence = null) {
  return { id, status, message, evidence };
}

function skipped(id, message) {
  return finding(id, CHECK_STATUS.SKIPPED, message);
}

function unknown(id, message, evidence = null) {
  return finding(id, CHECK_STATUS.UNKNOWN, message, evidence);
}

/* ── Charge / multiplicity ────────────────────────────────── */

/**
 * Electron-count parity. The number of unpaired electrons a multiplicity
 * implies is `multiplicity - 1`; it must have the same parity as the electron
 * count, and it cannot exceed the electron count.
 */
export function checkChargeMultiplicity({ settings = {}, molecule = {}, parsed = null } = {}) {
  const id = 'charge-multiplicity';
  const charge = Number.isInteger(molecule.charge) ? molecule.charge : null;
  const multiplicity = Number.isInteger(molecule.multiplicity) ? molecule.multiplicity : null;
  const atoms = toAtomList(molecule);

  if (charge === null || multiplicity === null) {
    return unknown(id, 'Charge and multiplicity must both be integers before the electron count can be checked.');
  }
  if (atoms.length === 0) {
    return unknown(id, 'No Cartesian geometry is attached, so the electron count cannot be computed.');
  }

  let electrons = 0;
  for (const atom of atoms) {
    const atomic = atomicNumber(atom.element);
    if (atomic === null) {
      return unknown(id, `No atomic number is known for element "${atom.element || '(empty)'}", so the electron count cannot be computed.`);
    }
    electrons += atomic;
  }
  electrons -= charge;

  const evidence = {
    charge,
    multiplicity,
    atoms: atoms.length,
    electrons,
    method: parsed?.scf?.method ?? null,
  };

  if (electrons <= 0) {
    return finding(id, CHECK_STATUS.FAIL,
      `Charge ${charge} removes more electrons than the ${atoms.length} atoms provide (${electrons} electrons).`, evidence);
  }
  if (electrons % 2 !== (multiplicity - 1) % 2) {
    const parity = electrons % 2 === 0 ? 'even' : 'odd';
    const required = electrons % 2 === 0 ? 'odd' : 'even';
    return finding(id, CHECK_STATUS.FAIL,
      `Charge ${charge} leaves ${electrons} electrons (${parity}), so the multiplicity must be ${required}; `
      + `multiplicity ${multiplicity} is impossible (electron-count parity mismatch).`, evidence);
  }
  if (multiplicity > electrons + 1) {
    return finding(id, CHECK_STATUS.FAIL,
      `Multiplicity ${multiplicity} needs ${multiplicity - 1} unpaired electrons, but the system has only ${electrons}.`, evidence);
  }

  const method = oneLine(parsed?.scf?.method);
  // RHF/RMP2 are closed-shell; ROHF/ROMP2 are open-shell but still restricted.
  const closedShellRestricted = /^R/i.test(method) && !/^RO/i.test(method);
  if (method && closedShellRestricted && multiplicity > 1) {
    return finding(id, CHECK_STATUS.FAIL,
      `The output reports a closed-shell restricted reference (${method}) but the project asks for multiplicity `
      + `${multiplicity}; a closed-shell wavefunction cannot represent an open-shell state.`, evidence);
  }

  return finding(id, CHECK_STATUS.PASS,
    `${electrons} electrons with charge ${charge} and multiplicity ${multiplicity}; the parity is consistent.`, evidence);
}

/* ── Spin contamination ───────────────────────────────────── */

/**
 * S**2 before and after annihilation against S(S+1) = (m^2 - 1) / 4.
 * Restricted references are spin eigenfunctions by construction and have no
 * annihilation line; they pass with the expected value named in the evidence.
 */
export function checkSpinContamination({ settings = {}, molecule = {}, parsed = null } = {}) {
  const id = 'spin-contamination';
  if (!parsed) {
    return unknown(id, 'No parsed output; spin contamination can only be read from a finished job.');
  }
  const method = oneLine(parsed.scf?.method);
  if (!method) {
    return unknown(id, 'The output has no SCF method record, so restricted/unrestricted could not be determined.');
  }
  const multiplicity = Number.isInteger(molecule.multiplicity) ? molecule.multiplicity
    : Number.isInteger(settings.multiplicity) ? settings.multiplicity : null;
  if (multiplicity === null || multiplicity < 1) {
    return unknown(id, 'The multiplicity is not an integer, so the expected S**2 cannot be computed.');
  }

  const expected = round(((multiplicity * multiplicity) - 1) / 4, 4);
  const evidence = {
    method,
    multiplicity,
    expected,
    before: finiteNumber(parsed.spinContamination?.before),
    after: finiteNumber(parsed.spinContamination?.after),
    limits: { ...SPIN_CONTAMINATION_LIMITS },
  };

  if (/^R/i.test(method)) {
    return finding(id, CHECK_STATUS.PASS,
      `Restricted reference ${method} is a spin eigenfunction; expected S**2 ${expected} by construction.`, evidence);
  }

  if (evidence.after === null) {
    return unknown(id, evidence.before === null
      ? `The output has no S**2 before/after annihilation line for the unrestricted reference ${method}.`
      : `Only the pre-annihilation S**2 was printed for ${method}; the value after annihilation is required.`, evidence);
  }

  const deviation = round(evidence.after - expected, 4);
  evidence.deviation = deviation;
  const magnitude = Math.abs(deviation);

  if (magnitude > SPIN_CONTAMINATION_LIMITS.fail) {
    return finding(id, CHECK_STATUS.FAIL,
      `S**2 after annihilation ${evidence.after} deviates by ${deviation > 0 ? '+' : ''}${deviation} from `
      + `${expected} expected for multiplicity ${multiplicity} (failure limit ${SPIN_CONTAMINATION_LIMITS.fail}).`, evidence);
  }
  if (magnitude > SPIN_CONTAMINATION_LIMITS.warn) {
    return finding(id, CHECK_STATUS.WARNING,
      `S**2 after annihilation ${evidence.after} deviates by ${deviation > 0 ? '+' : ''}${deviation} from `
      + `${expected} expected for multiplicity ${multiplicity} (warning above ${SPIN_CONTAMINATION_LIMITS.warn}).`, evidence);
  }
  return finding(id, CHECK_STATUS.PASS,
    `S**2 after annihilation ${evidence.after} matches ${expected} expected for multiplicity ${multiplicity} `
    + `(deviation ${deviation > 0 ? '+' : ''}${deviation}).`, evidence);
}

/* ── Geometry sanity ──────────────────────────────────────── */

function geometryIssue(kind, i, j, elements, distanceValue, ratio, limit) {
  return {
    kind,
    atoms: [i + 1, j + 1],
    elements,
    distance: round(distanceValue, 3),
    ratio: round(ratio, 3),
    limit,
  };
}

function describeIssue(issue) {
  const [a, b] = issue.atoms;
  return `${issue.elements[0]}${a}-${issue.elements[1]}${b} ${issue.distance} A `
    + `(${issue.ratio} x the radius sum; limit ${issue.limit})`;
}

/**
 * Covalent-radius geometry sanity. Pairs are judged by
 * `distance / (r_i + r_j)`; only bond-like contacts (ratio <= 1.30) are judged
 * for length, so ordinary non-covalent contacts never create a finding.
 */
export function checkGeometrySanity({ molecule = {} } = {}) {
  const id = 'geometry-sanity';
  const atoms = toAtomList(molecule);

  if (atoms.length < 2) {
    return unknown(id, 'At least two atoms are required before a geometry can be judged.');
  }
  const invalid = atoms.findIndex((atom) => atom.x === null || atom.y === null || atom.z === null);
  if (invalid !== -1) {
    return unknown(id, `Atom ${invalid + 1} has a non-finite coordinate, so the geometry cannot be judged.`);
  }

  const missing = [...new Set(atoms
    .map((atom) => atom.element)
    .filter((element) => covalentRadius(element) === null))];

  const clashes = [];
  const shortBonds = [];
  const longBonds = [];
  const linearAngles = [];
  const acuteAngles = [];
  const neighbours = atoms.map(() => []);
  let pairsChecked = 0;

  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const radiusI = covalentRadius(atoms[i].element);
      const radiusJ = covalentRadius(atoms[j].element);
      if (radiusI === null || radiusJ === null) continue;
      const radiusSum = radiusI + radiusJ;
      if (radiusSum <= 0) continue;
      pairsChecked += 1;
      const separation = distance(atoms[i], atoms[j]);
      const ratio = separation / radiusSum;
      const elements = [atoms[i].element, atoms[j].element];

      if (ratio < GEOMETRY_LIMITS.clash) {
        clashes.push(geometryIssue('clash', i, j, elements, separation, ratio, GEOMETRY_LIMITS.clash));
      } else if (ratio < GEOMETRY_LIMITS.shortBond) {
        shortBonds.push(geometryIssue('short-bond', i, j, elements, separation, ratio, GEOMETRY_LIMITS.shortBond));
      } else if (ratio > GEOMETRY_LIMITS.longBond && ratio <= GEOMETRY_LIMITS.bond) {
        longBonds.push(geometryIssue('long-bond', i, j, elements, separation, ratio, GEOMETRY_LIMITS.longBond));
      }
      if (ratio <= GEOMETRY_LIMITS.bond) {
        neighbours[i].push(j);
        neighbours[j].push(i);
      }
    }
  }

  for (let centre = 0; centre < atoms.length; centre += 1) {
    if (neighbours[centre].length !== 2) continue;
    const [i, k] = neighbours[centre];
    const angle = angleDegrees(atoms[i], atoms[centre], atoms[k]);
    if (angle === null) continue;
    const entry = {
      atoms: [i + 1, centre + 1, k + 1],
      elements: [atoms[i].element, atoms[centre].element, atoms[k].element],
      angle: round(angle, 1),
    };
    if (BENT_CENTRES.has(atoms[centre].element) && angle >= GEOMETRY_LIMITS.linearAngleDeg) {
      linearAngles.push({ ...entry, limit: GEOMETRY_LIMITS.linearAngleDeg });
    }
    if (angle <= GEOMETRY_LIMITS.acuteAngleDeg) {
      acuteAngles.push({ ...entry, limit: GEOMETRY_LIMITS.acuteAngleDeg });
    }
  }

  const evidence = {
    atoms: atoms.length,
    pairsChecked,
    missingElements: missing,
    thresholds: { ...GEOMETRY_LIMITS },
    clashes: clashes.slice(0, 12),
    shortBonds: shortBonds.slice(0, 12),
    longBonds: longBonds.slice(0, 12),
    linearAngles: linearAngles.slice(0, 12),
    acuteAngles: acuteAngles.slice(0, 12),
    counts: {
      clashes: clashes.length,
      shortBonds: shortBonds.length,
      longBonds: longBonds.length,
      linearAngles: linearAngles.length,
      acuteAngles: acuteAngles.length,
    },
  };

  if (clashes.length > 0) {
    return finding(id, CHECK_STATUS.FAIL,
      `${clashes.length} atom clash${clashes.length === 1 ? '' : 'es'} below ${GEOMETRY_LIMITS.clash} x the covalent-radius sum `
      + `(worst: ${describeIssue(clashes[0])}).`, evidence);
  }

  const parts = [];
  if (shortBonds.length > 0) {
    parts.push(`${shortBonds.length} implausibly short contact${shortBonds.length === 1 ? '' : 's'} below `
      + `${GEOMETRY_LIMITS.shortBond} x the radius sum (${describeIssue(shortBonds[0])})`);
  }
  if (longBonds.length > 0) {
    parts.push(`${longBonds.length} bond-length outlier${longBonds.length === 1 ? '' : 's'} above `
      + `${GEOMETRY_LIMITS.longBond} x the radius sum (${describeIssue(longBonds[0])})`);
  }
  if (linearAngles.length > 0) {
    const entry = linearAngles[0];
    parts.push(`${linearAngles.length} near-linear angle at a bent centre `
      + `(${entry.elements[0]}${entry.atoms[0]}-${entry.elements[1]}${entry.atoms[1]}-${entry.elements[2]}${entry.atoms[2]} `
      + `${entry.angle} deg >= ${GEOMETRY_LIMITS.linearAngleDeg})`);
  }
  if (acuteAngles.length > 0) {
    const entry = acuteAngles[0];
    parts.push(`${acuteAngles.length} acute angle${acuteAngles.length === 1 ? '' : 's'} `
      + `(${entry.elements[0]}${entry.atoms[0]}-${entry.elements[1]}${entry.atoms[1]}-${entry.elements[2]}${entry.atoms[2]} `
      + `${entry.angle} deg <= ${GEOMETRY_LIMITS.acuteAngleDeg})`);
  }
  if (parts.length > 0) {
    return finding(id, CHECK_STATUS.WARNING, `${parts.join('; ')}.`, evidence);
  }

  if (missing.length > 0) {
    return unknown(id,
      `No single-bond covalent radius is tabulated for ${missing.join(', ')}, so the geometry could not be checked`
      + (pairsChecked > 0 ? ` (${pairsChecked} pairs were clean).` : '.'), evidence);
  }

  return finding(id, CHECK_STATUS.PASS,
    `${pairsChecked} atom pairs are consistent with covalent radii: no clashes, bond-length outliers or angle anomalies.`, evidence);
}

/* ── Imaginary frequencies ────────────────────────────────── */

/**
 * A transition state has exactly one imaginary mode; a minimum has none. Other
 * job types make no stationary-point claim and are skipped, not passed.
 */
export function checkImaginaryFrequencies({ settings = {}, parsed = null, minMagnitude = null } = {}) {
  const id = 'imaginary-frequencies';
  const jobType = oneLine(settings.jobType);
  const isTs = jobType === 'Opt=TS';
  const claimsMinimum = jobType === 'Freq' || jobType === 'Opt Freq';

  if (!isTs && !claimsMinimum) {
    return skipped(id, `A ${jobType || 'unknown'} job makes no minimum or saddle claim, so imaginary modes were not judged.`);
  }
  if (!parsed) {
    return unknown(id, 'No parsed output; imaginary modes can only be counted from a finished frequency job.');
  }
  if (!parsed.frequencies || parsed.frequencies.count === 0) {
    return unknown(id, 'The output contains no frequency record, so the stationary point cannot be classified.');
  }

  const floorValue = Number(minMagnitude);
  const floor = minMagnitude !== null && minMagnitude !== undefined && minMagnitude !== ''
    && Number.isFinite(floorValue)
    ? floorValue
    : TS_IMAGINARY_FLOOR_CM1;
  const evidence = {
    jobType,
    expectedImaginary: isTs ? 1 : 0,
    imaginaryCount: parsed.frequencies.imaginaryCount,
    imaginaryValues: parsed.frequencies.imaginaryValues || [],
    minImaginary: parsed.frequencies.minImaginary,
    floor,
  };

  if (isTs) {
    if (parsed.frequencies.imaginaryCount !== 1) {
      return finding(id, CHECK_STATUS.FAIL,
        `A transition state needs exactly one imaginary mode; found ${parsed.frequencies.imaginaryCount}.`, evidence);
    }
    const magnitude = Math.abs(parsed.frequencies.minImaginary ?? 0);
    if (magnitude < floor) {
      return finding(id, CHECK_STATUS.WARNING,
        `The single imaginary mode is ${magnitude.toFixed(1)} cm^-1, below the ${floor} cm^-1 floor; `
        + 'it may be numerical noise rather than a saddle.', evidence);
    }
    return finding(id, CHECK_STATUS.PASS,
      `Exactly one imaginary mode at ${magnitude.toFixed(1)} cm^-1 (floor ${floor}); the saddle is verified.`, evidence);
  }

  if (parsed.frequencies.imaginaryCount !== 0) {
    return finding(id, CHECK_STATUS.FAIL,
      `A minimum needs no imaginary modes; found ${parsed.frequencies.imaginaryCount} `
      + `(${(parsed.frequencies.imaginaryValues || []).slice(0, 5).join(', ')} cm^-1).`, evidence);
  }
  return finding(id, CHECK_STATUS.PASS,
    `All ${parsed.frequencies.count} modes are real; the geometry is a minimum at this level.`, evidence);
}

/* ── Method / basis compatibility ─────────────────────────── */

/**
 * Basis/ECP pairing, method/basis families, and dispersion double-counting.
 * Element coverage needs a geometry; without one the check stays `unknown`
 * rather than claiming the pairing is safe.
 */
export function checkMethodBasisCompatibility({ settings = {}, molecule = {} } = {}) {
  const id = 'method-basis-compatibility';
  const method = oneLine(settings.method);
  const basis = oneLine(settings.basis);
  const dispersion = oneLine(settings.dispersion);
  const atoms = toAtomList(molecule);

  if (!method || !basis) {
    return unknown(id, 'The method and basis must both be set before their pairing can be checked.');
  }

  const elements = [...new Set(atoms.map((atom) => atom.element).filter(Boolean))];
  const heavy = elements.filter((element) => (atomicNumber(element) || 0) >= ECP_REQUIRED_FROM_Z);
  const ecpBasis = isEcpBasis(basis);
  const geometryKnown = elements.length > 0;
  const issues = [];
  const evidence = {
    method,
    basis,
    dispersion,
    elements,
    ecpBasis,
    heavyElements: heavy,
    issues,
    geometryChecked: geometryKnown,
  };

  if (heavy.length > 0 && !ecpBasis) {
    issues.push({
      kind: 'ecp-missing',
      severity: CHECK_SEVERITY.ERROR,
      message: `Basis ${basis} has no all-electron definition for ${heavy.join(', ')}; without an ECP the route has no `
        + 'functions for those atoms. Use LANL2DZ, SDD or a def2 basis.',
    });
  }

  const key = methodKey(method);
  if (SEMIEMPIRICAL_METHODS.includes(key)) {
    issues.push({
      kind: 'method-ignores-basis',
      severity: CHECK_SEVERITY.WARNING,
      message: `${method} is semi-empirical and does not consume a Gaussian basis set; ${basis} is ignored, so its ECP `
        + 'cannot apply.',
    });
  } else if (COMPOSITE_METHODS.includes(key)) {
    issues.push({
      kind: 'method-defines-basis',
      severity: CHECK_SEVERITY.WARNING,
      message: `${method} is a composite method that fixes its own basis and ECP sequence; the explicit ${basis} `
        + 'will be overridden.',
    });
  }

  if (dispersion && hasBuiltinDispersion(method)) {
    issues.push({
      kind: 'dispersion-redundant',
      severity: CHECK_SEVERITY.WARNING,
      message: `${method} already includes a dispersion correction; EmpiricalDispersion=${dispersion} would `
        + 'double-count it.',
    });
  }

  const errors = issues.filter((issue) => issue.severity === CHECK_SEVERITY.ERROR);
  if (errors.length > 0) {
    return finding(id, CHECK_STATUS.FAIL, errors.map((issue) => issue.message).join(' '), evidence);
  }
  if (issues.length > 0) {
    return finding(id, CHECK_STATUS.WARNING, issues.map((issue) => issue.message).join(' '), evidence);
  }
  if (!geometryKnown) {
    return unknown(id,
      'No Cartesian geometry is attached, so element coverage of the basis could not be checked.', evidence);
  }
  return finding(id, CHECK_STATUS.PASS,
    `${method}/${basis}${heavy.length > 0 ? ` carries an ECP for ${heavy.join(', ')}` : ''}`
    + `${dispersion ? `, with ${dispersion} as the only dispersion term` : ''}.`, evidence);
}

/* ── Optimisation convergence ─────────────────────────────── */

/**
 * A frequency job may only call its geometry a minimum when the optimisation
 * that produced it reported "Optimization completed". `Opt Freq` carries that
 * record in its own output; a downstream `Freq` needs the upstream evidence.
 */
export function checkOptimizationConvergence({ settings = {}, parsed = null, upstream = null, engine = 'gaussian' } = {}) {
  const id = 'opt-convergence';
  const jobType = oneLine(settings.jobType);

  if (engine === 'xtb') {
    // xTB prints a single banner when its optimisation converged. There is no
    // Gaussian checkpoint chain, and `--ohess` optimises before the Hessian, so
    // both Opt and Opt Freq make the same claim.
    if (jobType !== 'Opt' && jobType !== 'Opt Freq' && jobType !== 'Freq') {
      return skipped(id, `A ${jobType || 'unknown'} job makes no optimisation claim, so convergence was not judged.`);
    }
    if (!parsed) {
      return unknown(id, 'No parsed output; xTB optimisation convergence can only be read from a finished job.');
    }
    const evidence = {
      engine: 'xtb',
      jobType,
      complete: parsed.complete !== false,
      attempted: parsed.optimization?.attempted ?? null,
      completed: parsed.optimization?.completed ?? null,
      cycles: parsed.optimization?.cycles ?? null,
    };
    if (parsed.complete === false) {
      return unknown(id, 'The parse does not cover the whole output, so xTB convergence cannot be confirmed.', evidence);
    }
    if (parsed.optimization?.completed === true) {
      return finding(id, CHECK_STATUS.PASS,
        `xTB reported "GEOMETRY OPTIMIZATION CONVERGED" after ${parsed.optimization.cycles ?? '?'} iterations.`, evidence);
    }
    if (parsed.optimization?.attempted === true) {
      return finding(id, CHECK_STATUS.FAIL,
        'xTB ran an optimisation but printed no convergence banner; the geometry is not a converged stationary point.', evidence);
    }
    return unknown(id, 'The output contains no optimisation record, so convergence was not evaluated.', evidence);
  }

  if (jobType !== 'Freq' && jobType !== 'Opt Freq') {
    return skipped(id, `A ${jobType || 'unknown'} job does not claim a minimum, so optimisation convergence was not judged.`);
  }

  if (jobType === 'Opt Freq') {
    if (!parsed) {
      return unknown(id, 'No parsed output; the optimisation and frequency records cannot be compared.');
    }
    const evidence = {
      jobType,
      source: 'own-output',
      complete: parsed.complete !== false,
      optimizationCompleted: parsed.optimization?.completed === true,
      frequencies: parsed.frequencies?.count ?? 0,
    };
    if (parsed.complete === false) {
      return unknown(id, 'The parse does not cover the whole output, so optimisation convergence cannot be confirmed.', evidence);
    }
    if (parsed.optimization?.completed === true) {
      return finding(id, CHECK_STATUS.PASS,
        'The optimisation completed before the frequency record; the minimum claim is supported.', evidence);
    }
    if ((parsed.frequencies?.count ?? 0) > 0) {
      return finding(id, CHECK_STATUS.FAIL,
        'The output contains frequencies but no "Optimization completed" record; the minimum claim is not supported.',
        evidence);
    }
    return unknown(id, 'The output has neither an optimisation-completion nor a frequency record.', evidence);
  }

  if (!upstream) {
    return unknown(id,
      'No upstream optimisation is linked, so the geometry source cannot be verified as a converged minimum.');
  }

  const upstreamJob = oneLine(upstream.settings?.jobType);
  const title = oneLine(upstream.title) || oneLine(upstream.id) || 'the upstream block';
  const evidence = {
    jobType,
    source: 'upstream',
    upstream: { id: upstream.id ?? null, title, jobType: upstreamJob || null, state: upstream.state ?? null },
    optimizationCompleted: upstream.parsed?.optimization?.completed ?? null,
    complete: upstream.parsed?.complete ?? null,
  };

  if (!/^opt(\s|=|$)/i.test(upstreamJob)) {
    return unknown(id, `The linked source "${title}" is ${upstreamJob || 'not an optimisation'}, not an optimisation.`, evidence);
  }

  if (upstream.parsed) {
    if (upstream.parsed.complete === false) {
      return unknown(id, `The parse of "${title}" is partial, so its optimisation convergence cannot be confirmed.`, evidence);
    }
    if (upstream.parsed.optimization?.completed === true) {
      return finding(id, CHECK_STATUS.PASS,
        `"${title}" reported "Optimization completed"; the frequency geometry is a converged stationary point.`, evidence);
    }
    if (upstream.parsed.optimization?.completed === false) {
      return finding(id, CHECK_STATUS.FAIL,
        `"${title}" did not report "Optimization completed"; its frequency geometry cannot be called a minimum.`, evidence);
    }
    return unknown(id, `"${title}" has no optimisation-completion record in its parsed output.`, evidence);
  }

  if (!upstream.output) {
    return unknown(id, `"${title}" has not produced a parsed output yet, so its convergence is unknown.`, evidence);
  }
  if (upstream.state && upstream.state !== 'passed') {
    return finding(id, CHECK_STATUS.FAIL,
      `"${title}" did not pass its gates (state "${upstream.state}"); a frequency on that geometry cannot claim a minimum.`,
      evidence);
  }
  if (upstream.state === 'passed') {
    return finding(id, CHECK_STATUS.PASS,
      `"${title}" passed its gates, which require "Optimization completed".`, evidence);
  }
  return unknown(id, `"${title}" has no recorded gate verdict, so its convergence is unknown.`, evidence);
}

/* ── Runner ───────────────────────────────────────────────── */

const CHECK_FUNCTIONS = Object.freeze({
  'charge-multiplicity': checkChargeMultiplicity,
  'spin-contamination': checkSpinContamination,
  'geometry-sanity': checkGeometrySanity,
  'imaginary-frequencies': checkImaginaryFrequencies,
  'method-basis-compatibility': checkMethodBasisCompatibility,
  'opt-convergence': checkOptimizationConvergence,
});

function disabledFrom(settings) {
  const value = settings?.disabledChecks;
  return Array.isArray(value) ? value : [];
}

function overallStatus(findings) {
  if (findings.some((entry) => entry.status === CHECK_STATUS.FAIL)) return 'fail';
  if (findings.some((entry) => entry.status === CHECK_STATUS.WARNING)) return 'warning';
  if (findings.some((entry) => entry.status === CHECK_STATUS.UNKNOWN)) return 'unknown';
  if (findings.some((entry) => entry.status === CHECK_STATUS.PASS)) return 'pass';
  // Nothing was evaluated. That is not a pass.
  return 'unknown';
}

/**
 * Run the checks that belong to `phase`. Disabled checks are omitted from the
 * result entirely. `disabled` overrides `settings.disabledChecks` when given.
 *
 * A check that does not apply to the selected engine is reported as `skipped`
 * with `applicability: 'not-applicable'`. That is deliberately different from
 * `unknown` (`applicability: 'not-evaluated'`): the first means the protocol
 * has no question to ask here, the second means a question exists but the
 * evidence does not.
 */
export function runValidityChecks(context = {}, { phase = 'post', disabled = null, engine = 'gaussian' } = {}) {
  const disallowed = new Set(Array.isArray(disabled) ? disabled : disabledFrom(context.settings));
  const findings = [];
  const engineId = String(engine || 'gaussian');
  for (const meta of VALIDITY_CHECKS) {
    if (!meta.phases.includes(phase)) continue;
    if (disallowed.has(meta.id)) continue;
    const engines = Array.isArray(meta.engines) ? meta.engines : ['gaussian'];
    if (!engines.includes(engineId)) {
      findings.push({
        ...skipped(meta.id, `${meta.title} is not applicable to the ${engineId} engine.`),
        applicability: 'not-applicable',
        title: meta.title,
        phase,
      });
      continue;
    }
    let result;
    try {
      result = CHECK_FUNCTIONS[meta.id]({ ...context, engine: engineId });
    } catch (error) {
      result = unknown(meta.id, `could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
    }
    findings.push({
      ...result,
      ...(result.status === CHECK_STATUS.UNKNOWN ? { applicability: 'not-evaluated' } : {}),
      severity: severityOf(result.status),
      title: meta.title,
      phase,
    });
  }
  return { phase, overall: overallStatus(findings), findings, engine: engineId };
}

/**
 * Normalise a serializable validity context (renderer or queue payload) into
 * the shape the checks consume. Everything is bounded and coerced here so a
 * run record cannot be bloated by a hostile payload.
 */
export function normalizeValidityContext(raw = {}) {
  const settingsRaw = raw && typeof raw.settings === 'object' && raw.settings !== null ? raw.settings : {};
  const moleculeRaw = raw && typeof raw.molecule === 'object' && raw.molecule !== null ? raw.molecule : {};
  const coords = Array.isArray(moleculeRaw.coords)
    ? moleculeRaw.coords.slice(0, 1000).map((atom) => ({
      element: oneLine(atom?.element, '').slice(0, 3),
      x: finiteNumber(atom?.x),
      y: finiteNumber(atom?.y),
      z: finiteNumber(atom?.z),
    }))
    : [];
  const disabledChecks = Array.isArray(settingsRaw.disabledChecks)
    ? [...new Set(settingsRaw.disabledChecks.filter((id) => VALIDITY_CHECK_IDS.includes(id)))]
    : [];

  const upstreamRaw = raw && typeof raw.upstream === 'object' && raw.upstream !== null ? raw.upstream : null;
  const upstream = upstreamRaw ? {
    id: oneLine(upstreamRaw.id, '').slice(0, 64) || null,
    title: oneLine(upstreamRaw.title, '').slice(0, 120) || null,
    state: oneLine(upstreamRaw.state, '').slice(0, 32) || null,
    output: upstreamRaw.output ?? null,
    settings: {
      jobType: oneLine(upstreamRaw.settings?.jobType, '').slice(0, 32),
      method: oneLine(upstreamRaw.settings?.method, '').slice(0, 64),
      basis: oneLine(upstreamRaw.settings?.basis, '').slice(0, 64),
      dispersion: oneLine(upstreamRaw.settings?.dispersion, '').slice(0, 16),
    },
    parsed: upstreamRaw.parsed && typeof upstreamRaw.parsed === 'object' ? {
      complete: upstreamRaw.parsed.complete !== false,
      status: oneLine(upstreamRaw.parsed.status, '').slice(0, 32) || null,
      optimization: {
        completed: upstreamRaw.parsed.optimization?.completed === true,
      },
    } : null,
  } : null;

  return {
    settings: {
      jobType: oneLine(settingsRaw.jobType, '').slice(0, 32),
      method: oneLine(settingsRaw.method, '').slice(0, 64),
      basis: oneLine(settingsRaw.basis, '').slice(0, 64),
      dispersion: oneLine(settingsRaw.dispersion, '').slice(0, 16),
      disabledChecks,
    },
    molecule: {
      charge: integerOrNull(moleculeRaw.charge),
      multiplicity: integerOrNull(moleculeRaw.multiplicity),
      coords,
    },
    upstream,
  };
}

/**
 * The report shape stored in `run.json` under `gates.validity`.
 * `overall` is fail > warning > unknown > pass; an empty set is unknown.
 */
export function summarizeValidity(input) {
  const findings = Array.isArray(input) ? input : Array.isArray(input?.findings) ? input.findings : [];
  return {
    overall: overallStatus(findings),
    findings,
    errors: findings.filter((entry) => entry.status === CHECK_STATUS.FAIL),
    warnings: findings.filter((entry) => entry.status === CHECK_STATUS.WARNING),
    unknowns: findings.filter((entry) => entry.status === CHECK_STATUS.UNKNOWN),
  };
}
