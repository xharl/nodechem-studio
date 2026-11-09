/**
 * DP4+ probabilities over candidate structures (issue 165).
 *
 * What this module is
 * -------------------
 * Given two or more candidate structures, a set of NMR shieldings computed for
 * each of them at *one* level of theory, and one list of experimental shifts
 * with an atom assignment, it returns the probability of each candidate.
 *
 * The procedure is the published DP4+ one (Grimblat, Zanardi, Sarotti,
 * *J. Org. Chem.* 2015, 80 (24), 12526–12534), implemented from the error tables of
 * the reference implementation rather than from remembered coefficients:
 *
 *   1. each conformer's shieldings are Boltzmann-averaged at a stated
 *      temperature, using the populations the conformer block already stored
 *      (or the energies, when no population was stored);
 *   2. the *unscaled* shift of a nucleus is δ = σ_standard − σ_calculated;
 *   3. the *scaled* shift is δ corrected by the linear fit of δ against the
 *      experimental shift of that same candidate — one fit for C, one for H,
 *      as the reference does, not one fit for the whole molecule;
 *   4. every nucleus gets a probability from a Student-t tail with the
 *      per-level, per-nucleus-class (df, mean, scale) fit from the bank;
 *   5. the per-nucleus probabilities are multiplied into an absolute
 *      probability per candidate and normalised across candidates.
 *
 * Three variants exist, and the app reports which one it produced:
 *
 * | `variant` | Uses | Is it classic DP4? |
 * | --- | --- | --- |
 * | `uns` | unscaled δ only, sp2/sp3 classes | no — DP4+'s unscaled half |
 * | `sca` | scaled δ only, one class per element | no |
 * | `full` (default) | both halves multiplied | no |
 *
 * Classic DP4 (Smith & Goodman 2010) is **not** implemented and is refused by
 * name: its parameter set is a different fit that this bank does not carry.
 * A level the bank does not carry does not exist here — it is refused, never
 * approximated with another level's numbers.
 *
 * What it is not
 * --------------
 * No parameter is computed, interpolated, or defaulted. Every number comes
 * from `data/dp4plus-qm.json`, whose provenance (package, version, license,
 * archive hash) is recorded beside the result and in that directory's
 * PROVENANCE.md. A missing nucleus does not become zero: the candidate that
 * lacks one is excluded from the comparison and named with the reason, because
 * comparing candidates over different nuclei would score a different
 * experiment for each of them.
 *
 * Pure: no filesystem, no network, no clock.
 */

import bankJson from './data/dp4plus-qm.json' with { type: 'json' };
import { HARTREE_KCAL, KB_KCAL, DEFAULT_CONFORMER_SETTINGS, boltzmannWeights } from './conformers.js';
import { elementForNucleus } from './nmr.js';

/** The bank this module reads, as recorded in the data file itself. */
export const DP4_BANK = Object.freeze({
  id: `dp4plus-qm@${bankJson.source.version}`,
  package: bankJson.source.package,
  version: bankJson.source.version,
  license: bankJson.source.license,
  repository: bankJson.source.repository,
  workbook: bankJson.source.workbook,
  workbookSha256: bankJson.source.workbookSha256,
  archive: bankJson.source.archive,
  archiveSha256: bankJson.source.archiveSha256,
});

/** The citation printed with every probability this module produces. */
export const DP4_CITATION = Object.freeze({
  short: 'DP4+ — Grimblat, Zanardi, Sarotti, J. Org. Chem. 2015, 80 (24), 12526–12534',
  doi: '10.1021/acs.joc.5b02396',
  parameters: `t-fits from ${bankJson.source.package} ${bankJson.source.version} (${bankJson.source.license})`,
});

/** The variants this module computes, and the label each one must be shown under. */
export const DP4_VARIANTS = Object.freeze(['uns', 'sca', 'full']);

export const DP4_VARIANT_LABELS = Object.freeze({
  uns: 'DP4+ unscaled (not classic DP4)',
  sca: 'DP4+ scaled',
  full: 'DP4+ full (unscaled × scaled)',
});

/**
 * The nucleus classes the bank carries a fit for. `sp2` is a property of the
 * *experimental* nucleus: the reference reads it from the assignment table, and
 * so does this module. `sca` classes ignore it — the scaled fit is per element.
 */
export const DP4_PARAMETER_CLASSES = Object.freeze(['Csp2', 'Csp3', 'Hsp2', 'Hsp3', 'Csca', 'Hsca']);

export const DP4_DEFAULT_TEMPERATURE = DEFAULT_CONFORMER_SETTINGS.temperature;

const CLASS_LABELS = Object.freeze({
  Csp2: 'C sp²', Csp3: 'C sp³', Hsp2: 'H on sp² C', Hsp3: 'H on sp³ C', Csca: 'C, scaled', Hsca: 'H, scaled',
});

/** The class label a report prints for a bank key. */
export function dp4ClassLabel(key) {
  return CLASS_LABELS[key] || String(key ?? '');
}

/* ── Level lookup ───────────────────────────────────────────── */

/** `mPW1PW91` and `mpw1pw91` are the same functional; a basis is compared as written. */
function normaliseMethod(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normaliseBasis(value) {
  return String(value ?? '').trim();
}

function normaliseSolvation(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const lowered = raw.toLowerCase();
  if (lowered === 'gas' || lowered === 'gas-phase' || lowered === 'gas phase' || lowered === 'none') return 'gas';
  if (lowered === 'pcm' || lowered === 'scrpcm' || lowered === 'cpcm') return 'PCM';
  return raw;
}

/**
 * Every level in the bank, one entry per (method/basis, solvation) pair, with
 * the solvents that pair can be referenced in. Sorted so a picker is stable.
 */
export function dp4Levels() {
  const out = [];
  for (const [id, entry] of Object.entries(bankJson.levels)) {
    for (const [solvation, variant] of Object.entries(entry.variants)) {
      out.push({
        id,
        method: entry.method,
        basis: entry.basis,
        solvation,
        label: `${id}${solvation === 'gas' ? ' (gas phase)' : ` (${solvation})`}`,
        solvents: Object.keys(variant.standards),
        parameters: variant.parameters,
        sourceSheet: variant.sourceSheet,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.solvation.localeCompare(b.solvation));
}

/** The ids only, for a message that lists what is available. */
export function dp4LevelIds() {
  return [...new Set(Object.keys(bankJson.levels))].sort();
}

/**
 * Resolve one level of theory against the bank.
 *
 * @param {object} request
 * @param {string|object} request.level `mPW1PW91/6-31+G(d,p)` or `{ method, basis }`
 * @param {string} request.solvation `gas` or `PCM`. Required: a gas-phase fit
 *   and a PCM fit of the same functional/basis are different tables, and
 *   guessing one for the other would report probabilities for a calculation
 *   nobody ran.
 * @param {string} [request.solvent] the solvent of the standard's shielding;
 *   required when `solvation` is not `gas`.
 * @returns {{ok: true, level: object} | {ok: false, code: string, reason: string}}
 */
export function dp4Level({ level, solvation, solvent } = {}) {
  const wanted = typeof level === 'string' ? { method: level.split('/')[0], basis: level.split('/').slice(1).join('/') } : (level || {});
  const method = normaliseMethod(wanted.method);
  const basis = normaliseBasis(wanted.basis);
  if (!method || !basis) {
    return {
      ok: false,
      code: 'level-name-incomplete',
      reason: 'a level of theory needs both a method and a basis (e.g. mPW1PW91/6-31+G(d,p)); the bank is keyed by both',
    };
  }
  const solvationKey = normaliseSolvation(solvation);
  if (!solvationKey) {
    return {
      ok: false,
      code: 'solvation-missing',
      reason: `the solvation model of the ${method}/${basis} calculation must be stated (gas or PCM): the bank carries a different t-fit for each`,
    };
  }
  const entry = Object.entries(bankJson.levels).find(([id, value]) => {
    const [entryMethod, ...rest] = id.split('/');
    return normaliseMethod(entryMethod) === method && normaliseBasis(rest.join('/')) === basis;
  });
  if (!entry) {
    return {
      ok: false,
      code: 'level-not-in-bank',
      reason: `the bank has no ${String(wanted.method ?? '').trim()}/${String(wanted.basis ?? '').trim()} level; it carries ${dp4LevelIds().length} levels (${dp4LevelIds().join(', ')}) and a level it does not carry is not estimated`,
    };
  }
  const [id, value] = entry;
  const variant = value.variants[solvationKey];
  if (!variant) {
    return {
      ok: false,
      code: 'level-not-in-bank',
      reason: `the bank has no ${solvationKey} fit for ${id}; it carries ${Object.keys(value.variants).join(' and ')}`,
    };
  }
  const solvents = Object.keys(variant.standards);
  const solventKey = String(solvent ?? '').trim();
  if (solvationKey !== 'gas') {
    if (!solventKey) {
      return {
        ok: false,
        code: 'solvent-missing',
        reason: `a ${solvationKey} level needs its solvent (${solvents.join(', ')}): the standard's shielding is a property of the solvent`,
      };
    }
    const match = solvents.find((name) => name.toLowerCase() === solventKey.toLowerCase() || (solventKey.toLowerCase() === 'gas' && name.toLowerCase() === 'gas'));
    if (!match) {
      return {
        ok: false,
        code: 'solvent-not-in-bank',
        reason: `the bank has no ${solventKey} standard for ${id} ${solvationKey}; it carries ${solvents.join(', ')}`,
      };
    }
    return {
      ok: true,
      level: {
        id,
        method: value.method,
        basis: value.basis,
        solvation: solvationKey,
        solvent: match,
        label: `${id} ${solvationKey}/${match}`,
        parameters: variant.parameters,
        standard: variant.standards[match],
        sourceSheet: variant.sourceSheet,
        standardSheet: match,
      },
    };
  }
  const gasKey = solvents.find((name) => name.toLowerCase() === 'gas') || solvents[0];
  if (!gasKey) {
    return { ok: false, code: 'standard-not-in-bank', reason: `the bank has no gas-phase standard for ${id}` };
  }
  return {
    ok: true,
    level: {
      id,
      method: value.method,
      basis: value.basis,
      solvation: 'gas',
      solvent: null,
      label: `${id} (gas phase)`,
      parameters: variant.parameters,
      standard: variant.standards[gasKey],
      sourceSheet: variant.sourceSheet,
      standardSheet: gasKey,
    },
  };
}

/* ── Student t ──────────────────────────────────────────────── */

/** ln Γ(x), Lanczos approximation (g=7, n=9), good to ~1e-15 for x > 0. */
function lnGamma(x) {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection, so the series is only ever evaluated where it converges.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  let sum = coefficients[0];
  for (let index = 1; index < 9; index += 1) sum += coefficients[index] / (z + index);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * The regularised incomplete beta I_x(a, b), by the continued fraction of
 * Numerical Recipes (betacf), which converges fast for the a, b of a t tail.
 */
function incompleteBeta(a, b, x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  const epsilon = 3e-16;
  const tiny = 1e-300;
  const maxIterations = 300;
  const betacf = (aa, bb, value) => {
    const qab = aa + bb;
    const qap = aa + 1;
    const qam = aa - 1;
    let c = 1;
    let d = 1 - (qab * value) / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIterations; m += 1) {
      const m2 = 2 * m;
      let coefficient = (m * (bb - m) * value) / ((qam + m2) * (aa + m2));
      d = 1 + coefficient * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + coefficient / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      coefficient = (-(aa + m) * (qab + m) * value) / ((aa + m2) * (qap + m2));
      d = 1 + coefficient * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + coefficient / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < epsilon) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** P(T ≤ t) for a Student t with `df` degrees of freedom. */
export function studentTCdf(t, df) {
  const value = Number(t);
  const degrees = Number(df);
  if (!Number.isFinite(value) || !Number.isFinite(degrees) || degrees <= 0) return null;
  const tail = 0.5 * incompleteBeta(degrees / 2, 0.5, degrees / (degrees + value * value));
  return value > 0 ? 1 - tail : tail;
}

/**
 * The per-nucleus probability DP4 and DP4+ use: P(|T| ≥ |x|) for a Student t
 * with the class's degrees of freedom. A nucleus with zero standardised error
 * scores exactly 0.5 — the most any single nucleus can score — so a candidate
 * with no error on every nucleus dominates without any one nucleus being
 * privileged over another.
 */
export function studentTProbability(standardised, df) {
  const cdf = studentTCdf(Math.abs(Number(standardised)), df);
  return cdf === null ? null : 1 - cdf;
}

/** The probability the bank's fit assigns to one error for one class. */
export function dp4NucleusProbability(error, parameters) {
  const mean = Number(parameters?.mean);
  const scale = Number(parameters?.scale);
  const df = Number(parameters?.df);
  if (!Number.isFinite(error) || !Number.isFinite(mean) || !Number.isFinite(scale) || !(scale > 0) || !(df > 0)) return null;
  return studentTProbability((error - mean) / scale, df);
}

/** The class a nucleus uses in the unscaled half: sp2/sp3 × element. */
export function dp4UnscaledClass(element, sp2) {
  if (element === 'C') return sp2 ? 'Csp2' : 'Csp3';
  if (element === 'H') return sp2 ? 'Hsp2' : 'Hsp3';
  return null;
}

/** The class a nucleus uses in the scaled half: one per element. */
export function dp4ScaledClass(element) {
  if (element === 'C') return 'Csca';
  if (element === 'H') return 'Hsca';
  return null;
}

/* ── The candidates ─────────────────────────────────────────── */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The Boltzmann weight of every conformer of one candidate, and where the
 * weights came from.
 *
 * A conformer block that already ranked its ensemble stored `population`; that
 * number is used as-is, at the temperature the caller states, because
 * re-deriving it from energies the block may not have kept would be a second,
 * different claim. Only when no member carries a population are the energies
 * weighted here, and that path needs every member's energy.
 */
function candidateWeights(candidate, temperature) {
  const conformers = Array.isArray(candidate?.conformers) ? candidate.conformers : [];
  if (conformers.length === 0) {
    return { ok: false, reason: `candidate ${candidate?.id ?? '?'} has no conformers; a shift without an ensemble is not a DP4 input` };
  }
  const stored = conformers.every((conformer) => finite(conformer?.population) && conformer.population > 0);
  if (stored) {
    const total = conformers.reduce((sum, conformer) => sum + conformer.population, 0);
    if (Math.abs(total - 1) > 1e-6) {
      return {
        ok: false,
        reason: `candidate ${candidate.id}: the stored populations sum to ${total.toFixed(6)}, not 1; an ensemble that was not retained is never re-normalised`,
      };
    }
    return {
      ok: true,
      source: 'stored',
      temperatureK: temperature,
      weights: conformers.map((conformer) => conformer.population),
    };
  }
  // `boltzmannWeights` takes relative energies in kcal/mol, so a Hartree
  // energy is converted first — passing Hartree numbers straight in would make
  // every exponent ~600× too small and silently return a flat average.
  const hartree = conformers.map((conformer) => conformer?.energyHartree);
  const kcal = conformers.map((conformer) => conformer?.energyKcal);
  const energies = hartree.every(finite)
    ? hartree.map((value) => value * HARTREE_KCAL)
    : (kcal.every(finite) ? kcal : null);
  if (!energies) {
    return {
      ok: false,
      reason: `candidate ${candidate.id}: neither a retained population nor an energy for every conformer; shifts cannot be Boltzmann-weighted`,
    };
  }
  const weights = boltzmannWeights(energies, temperature);
  if (weights.length !== conformers.length) {
    return { ok: false, reason: `candidate ${candidate.id}: a positive temperature is required to form Boltzmann weights` };
  }
  return { ok: true, source: 'computed', temperatureK: temperature, weights };
}

/**
 * Atom number → isotropic shielding, for one conformer.
 *
 * Two shapes are accepted: the object `{ index, element, isotropic }` that
 * `parseShieldings` already returns, and a plain array of numbers, whose
 * position is the atom number (1-based). The second is what a compact fixture
 * or a CSV-derived ensemble looks like, and it means the same thing.
 */
function shieldingIndex(conformer) {
  const map = new Map();
  const list = Array.isArray(conformer?.shieldings) ? conformer.shieldings : [];
  for (const [position, atom] of list.entries()) {
    if (typeof atom === 'number') {
      if (finite(atom)) map.set(position + 1, atom);
      continue;
    }
    const key = Number(atom?.index);
    if (Number.isFinite(key) && finite(atom?.isotropic)) map.set(key, atom.isotropic);
  }
  return map;
}

/**
 * The Boltzmann-averaged shielding of one assigned group of atoms, or a refusal
 * that names the candidate and the atom.
 *
 * `index` values are the atom numbers the log printed (1-based), which is what
 * `parseShieldings` keeps, so an assignment can be read straight off the output.
 */
function averagedShielding(conformers, weights, indices) {
  let total = 0;
  for (const [position, conformer] of conformers.entries()) {
    const map = shieldingIndex(conformer);
    let sum = 0;
    let count = 0;
    for (const index of indices) {
      if (!map.has(index)) {
        return { ok: false, missing: index };
      }
      sum += map.get(index);
      count += 1;
    }
    total += weights[position] * (sum / count);
  }
  return { ok: true, value: total };
}

/** One-feature ordinary least squares; null when the predictors do not vary. */
function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) {
    sxx += (xs[index] - meanX) ** 2;
    sxy += (xs[index] - meanX) * (ys[index] - meanY);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: meanY - slope * meanX };
}

/* ── The calculation ────────────────────────────────────────── */

function refusal(code, reason, extra = {}) {
  return { available: false, code, reason, ...extra };
}

/**
 * DP4+/DP4 probabilities over candidate structures.
 *
 * @param {object} input
 * @param {Array<object>} input.candidates at least two, each
 *   `{ id, title?, level?, conformers: [{ energyHartree?, energyKcal?,
 *   population?, shieldings }], assignments? }`, where `shieldings` is either
 *   `[{ index, element, isotropic }]` (what `parseShieldings` returns) or a
 *   plain array of isotropic values whose position is the atom number.
 *   `assignments` is one entry per experimental row, each an array of atom
 *   indices (1-based, as printed) whose shieldings are averaged — the way a
 *   methyl's three protons or a symmetry-equivalent pair are handled.
 * @param {Array<object>} input.experimental one row per measured shift:
 *   `{ index?, nucleus: '13C'|'C'|'1H'|'H', shift, sp2?: boolean, exchange? }`.
 *   `sp2` defaults to false, which is what an unmarked assignment means in the
 *   reference workflow: sp³ unless the table says otherwise.
 * @param {Array<Array<number>>} [input.assignments] the assignment, when every
 *   candidate shares it.
 * @param {object|string} input.level the level of theory, see `dp4Level`.
 * @param {string} input.solvation
 * @param {string} [input.solvent]
 * @param {'uns'|'sca'|'full'} [input.variant]
 * @param {number} [input.temperature] the temperature the populations are at
 * @returns {object} `{available: true, ...}` or `{available: false, code, reason}`
 */
export function dp4Probabilities({
  candidates = [],
  experimental = [],
  assignments = null,
  level = null,
  solvation = '',
  solvent = '',
  variant = 'full',
  temperature = DP4_DEFAULT_TEMPERATURE,
} = {}) {
  const chosen = String(variant ?? 'full').trim().toLowerCase();
  if (chosen === 'dp4' || chosen === 'classic' || chosen === 'dp4-classic') {
    return refusal(
      'classic-dp4-not-in-bank',
      'classic DP4 (Smith & Goodman 2010) is not implemented: its t-parameters are a different fit that this bank does not carry, and a DP4+ number is never reported as DP4. Use variant uns, sca or full',
    );
  }
  if (!DP4_VARIANTS.includes(chosen)) {
    return refusal('unknown-variant', `unknown DP4 variant “${variant}”; this module computes ${DP4_VARIANTS.join(', ')}`);
  }
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return refusal('fewer-than-two-candidates', `DP4 needs at least two candidate structures; ${Array.isArray(candidates) ? candidates.length : 0} given`);
  }
  const ids = new Set();
  for (const candidate of candidates) {
    const id = String(candidate?.id ?? '').trim();
    if (!id) return refusal('candidate-without-id', 'every candidate needs an id; a probability table without a row label cannot be read');
    if (ids.has(id)) return refusal('duplicate-candidate-id', `two candidates share the id “${id}”`);
    ids.add(id);
  }
  const resolved = dp4Level({ level, solvation, solvent });
  if (!resolved.ok) return refusal(resolved.code, resolved.reason);

  for (const candidate of candidates) {
    const declared = typeof candidate.level === 'string' ? candidate.level : null;
    if (declared && declared.replace(/\s+/g, '') !== resolved.level.id.replace(/\s+/g, '')) {
      return refusal(
        'differing-levels',
        `candidate ${candidate.id} declares ${declared} but the comparison is at ${resolved.level.id}; shifts from different levels are not one experiment`,
      );
    }
  }

  const rows = [];
  for (const [position, row] of (Array.isArray(experimental) ? experimental : []).entries()) {
    const element = elementForNucleus(row?.nucleus);
    const shift = Number(row?.shift);
    if (!element) {
      return refusal('unknown-nucleus', `experimental row ${position + 1}: “${row?.nucleus ?? ''}” is not a nucleus this app reads (1H, 13C)`);
    }
    if (element !== 'C' && element !== 'H') {
      return refusal('unknown-nucleus', `experimental row ${position + 1}: DP4+ in this bank is fitted for C and H only, not ${row?.nucleus}`);
    }
    if (!Number.isFinite(shift)) {
      return refusal('experimental-shift-missing', `experimental row ${position + 1} has no finite shift`);
    }
    rows.push({
      position,
      index: Number(row?.index) || position + 1,
      element,
      nucleus: String(row.nucleus).trim(),
      shift,
      sp2: row?.sp2 === true || row?.sp2 === 1 || row?.sp2 === 'x' || row?.sp2 === 'X',
      exchange: String(row?.exchange ?? '').trim() || null,
    });
  }
  if (rows.length === 0) {
    return refusal('no-experimental-data', 'no experimental shifts were given; DP4 compares a calculation with a measurement');
  }
  // A list of protons only, or of carbons only, is allowed: DP4+ then scores
  // the candidates on that one element (the empty product is 1, exactly as the
  // reference's per-element product behaves). The card prints the count of each
  // element, so a reader can see that carbon took no part.

  const temperatureK = Number(temperature);
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) {
    return refusal('temperature-invalid', 'the Boltzmann weights need a positive temperature in kelvin');
  }

  const shared = Array.isArray(assignments) ? assignments : null;
  const scored = [];
  const excluded = [];

  for (const candidate of candidates) {
    const weights = candidateWeights(candidate, temperatureK);
    if (!weights.ok) return refusal('weights-unavailable', weights.reason);

    const table = Array.isArray(candidate.assignments) ? candidate.assignments : shared;
    if (!table) {
      return refusal(
        'assignment-missing',
        `no atom assignment was given for candidate ${candidate.id}; a computed shift is only comparable to a measured one through an assignment`,
      );
    }
    if (table.length !== rows.length) {
      return refusal(
        'assignment-incomplete',
        `candidate ${candidate.id}: ${table.length} assignment rows for ${rows.length} experimental shifts; the map is not one-to-one`,
      );
    }
    const seen = new Map();
    let missing = null;
    const computed = [];
    for (const [position, row] of rows.entries()) {
      const indices = (Array.isArray(table[position]) ? table[position] : [table[position]])
        .map(Number)
        .filter((value) => Number.isFinite(value));
      if (indices.length === 0) {
        return refusal(
          'assignment-incomplete',
          `candidate ${candidate.id}: experimental row ${row.index} (${row.nucleus} ${row.shift}) has no assigned atom`,
        );
      }
      if (new Set(indices).size !== indices.length) {
        return refusal(
          'assignment-duplicated-atom',
          `candidate ${candidate.id}: experimental row ${row.index} lists the same atom twice; equivalent atoms are averaged once each`,
        );
      }
      for (const index of indices) {
        if (seen.has(index)) {
          return refusal(
            'assignment-not-one-to-one',
            `candidate ${candidate.id}: atom ${index} is assigned to experimental rows ${seen.get(index)} and ${row.index}; list it once, with its equivalent atoms`,
          );
        }
        seen.set(index, row.index);
      }
      const averaged = averagedShielding(candidate.conformers, weights.weights, indices);
      if (!averaged.ok) {
        missing = { index: averaged.missing, row };
        break;
      }
      computed.push({ ...row, indices, shielding: averaged.value });
    }
    if (missing) {
      // The documented rule: the candidate is excluded, not scored on fewer
      // nuclei than its rivals. Dropping the nucleus instead would compare each
      // candidate against a different experiment.
      excluded.push({
        candidateId: String(candidate.id),
        title: String(candidate.title ?? '') || String(candidate.id),
        code: 'missing-nucleus',
        reason: `atom ${missing.index} (experimental row ${missing.row.index}, ${missing.row.nucleus} ${missing.row.shift}) is not in this candidate's shieldings`,
      });
      continue;
    }

    // Diastereotopic pairs (two experimental rows sharing an `exchange` label)
    // are ordered so the larger measured shift takes the *smaller* computed
    // shielding, because a shift and a shielding run in opposite directions.
    // This is the reference's `diasterotopic` step; two rows that share a label
    // are one resonance reported twice, and which of the two computed nuclei
    // belongs to which side is not decided by the calculation.
    const pairs = new Map();
    for (const entry of computed) {
      const label = rows[entry.position]?.exchange;
      if (!label) continue;
      if (!pairs.has(label)) pairs.set(label, []);
      pairs.get(label).push(entry);
    }
    const reordered = [];
    for (const [label, group] of pairs) {
      if (group.length !== 2) continue;
      const values = group.map((entry) => entry.shielding).sort((a, b) => a - b);
      const [larger, smaller] = group[0].shift >= group[1].shift ? group : [group[1], group[0]];
      larger.shielding = values[0];
      smaller.shielding = values[1];
      reordered.push(label);
    }

    // Unscaled shifts, then the per-element linear fit the reference calls
    // "scaled". A fit with fewer than two points, or a flat fit, falls back to
    // the unscaled shift exactly as the reference does — and says so.
    const standard = resolved.level.standard;
    const unscaled = computed.map((row) => standard[row.element] - row.shielding);
    const scaled = new Array(unscaled.length);
    const fits = {};
    for (const element of ['C', 'H']) {
      const positions = computed.map((row, index) => (row.element === element ? index : -1)).filter((index) => index >= 0);
      const fit = positions.length > 1
        ? linearFit(positions.map((index) => computed[index].shift), positions.map((index) => unscaled[index]))
        : null;
      const usable = fit && Math.abs(fit.slope) > 1e-10;
      fits[element] = usable
        ? { slope: fit.slope, intercept: fit.intercept, points: positions.length, used: 'fit' }
        : { slope: null, intercept: null, points: positions.length, used: 'unscaled' };
      for (const index of positions) {
        scaled[index] = usable ? (unscaled[index] - fit.intercept) / fit.slope : unscaled[index];
      }
    }

    const nuclei = computed.map((row, index) => {
      const unscaledClass = dp4UnscaledClass(row.element, row.sp2);
      const scaledClass = dp4ScaledClass(row.element);
      const unscaledError = unscaled[index] - row.shift;
      const scaledError = scaled[index] - row.shift;
      return {
        index: row.index,
        nucleus: row.nucleus,
        element: row.element,
        sp2: row.sp2,
        exchange: row.exchange,
        experimental: row.shift,
        atoms: row.indices,
        shielding: row.shielding,
        computed: unscaled[index],
        computedScaled: scaled[index],
        unscaledError,
        scaledError,
        unscaledClass,
        scaledClass,
        unscaledProbability: dp4NucleusProbability(unscaledError, resolved.level.parameters[unscaledClass]),
        scaledProbability: dp4NucleusProbability(scaledError, resolved.level.parameters[scaledClass]),
      };
    });

    scored.push({
      id: String(candidate.id),
      title: String(candidate.title ?? '') || String(candidate.id),
      conformerCount: candidate.conformers.length,
      weights: {
        source: weights.source,
        temperatureK,
        sum: weights.weights.reduce((sum, value) => sum + value, 0),
        members: weights.weights,
      },
      fits,
      diastereotopicLabels: reordered.sort(),
      nuclei,
    });
  }

  if (scored.length < 2) {
    return refusal(
      'fewer-than-two-scorable-candidates',
      `only ${scored.length} candidate(s) could be scored; ${excluded.map((entry) => `${entry.candidateId} lacks ${entry.reason}`).join('; ')}`,
      { excluded },
    );
  }

  // Absolute probability of a candidate = product of its per-nucleus
  // probabilities, split into the halves DP4+ multiplies together. Summed in
  // log space so 27 nuclei with small probabilities cannot underflow to zero on
  // the way to a percentage; the exponentiated value is still the product.
  for (const candidate of scored) {
    const product = (predicate, key) => {
      let sum = 0;
      for (const nucleus of candidate.nuclei) {
        if (!predicate(nucleus)) continue;
        const probability = nucleus[key];
        if (!Number.isFinite(probability) || probability <= 0) return Number.NEGATIVE_INFINITY;
        sum += Math.log(probability);
      }
      return sum;
    };
    const carbon = (nucleus) => nucleus.element === 'C';
    const hydrogen = (nucleus) => nucleus.element === 'H';
    candidate.logComponents = {
      C_uns: product(carbon, 'unscaledProbability'),
      C_sca: product(carbon, 'scaledProbability'),
      H_uns: product(hydrogen, 'unscaledProbability'),
      H_sca: product(hydrogen, 'scaledProbability'),
    };
    candidate.logComponents.C_full = candidate.logComponents.C_uns + candidate.logComponents.C_sca;
    candidate.logComponents.H_full = candidate.logComponents.H_uns + candidate.logComponents.H_sca;
    candidate.logComponents.Uns = candidate.logComponents.C_uns + candidate.logComponents.H_uns;
    candidate.logComponents.Sca = candidate.logComponents.C_sca + candidate.logComponents.H_sca;
    candidate.logComponents.Full = candidate.logComponents.C_full + candidate.logComponents.H_full;
  }

  const rowKey = { uns: 'Uns', sca: 'Sca', full: 'Full' }[chosen];
  const logs = scored.map((candidate) => candidate.logComponents[rowKey]);
  const best = Math.max(...logs);
  const weightsFor = (key) => {
    const values = scored.map((candidate) => candidate.logComponents[key]);
    const top = Math.max(...values);
    if (!Number.isFinite(top)) return values.map(() => 0);
    const exponents = values.map((value) => (Number.isFinite(value) ? Math.exp(value - top) : 0));
    const total = exponents.reduce((sum, value) => sum + value, 0);
    return exponents.map((value) => (total > 0 ? value / total : 0));
  };
  const normalised = {
    uns: weightsFor('Uns'),
    sca: weightsFor('Sca'),
    full: weightsFor('Full'),
  };

  for (const [position, candidate] of scored.entries()) {
    // `logProbability` is the product's log: the probability itself underflows
    // for twenty-odd nuclei, so the log is what a reader can compare across
    // candidates when every printed percentage is 0.00.
    candidate.logProbability = candidate.logComponents[rowKey];
    candidate.relativeToBest = Number.isFinite(best) ? Math.exp(candidate.logComponents[rowKey] - best) : 0;
    candidate.probability = normalised[chosen][position];
    candidate.percent = 100 * candidate.probability;
    candidate.percentages = {
      uns: 100 * normalised.uns[position],
      sca: 100 * normalised.sca[position],
      full: 100 * normalised.full[position],
    };
    candidate.components = {
      C: { unscaled: candidate.logComponents.C_uns, scaled: candidate.logComponents.C_sca },
      H: { unscaled: candidate.logComponents.H_uns, scaled: candidate.logComponents.H_sca },
    };
  }
  const ranking = [...scored].sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));

  const carbonRows = rows.filter((row) => row.element === 'C').length;
  const hydrogenRows = rows.filter((row) => row.element === 'H').length;
  return {
    available: true,
    code: null,
    reason: null,
    variant: chosen,
    variantLabel: DP4_VARIANT_LABELS[chosen],
    variants: { ...DP4_VARIANT_LABELS },
    citation: { ...DP4_CITATION },
    bank: { ...DP4_BANK },
    level: {
      id: resolved.level.id,
      label: resolved.level.label,
      method: resolved.level.method,
      basis: resolved.level.basis,
      solvation: resolved.level.solvation,
      solvent: resolved.level.solvent,
      standard: { ...resolved.level.standard },
      sourceSheet: resolved.level.sourceSheet,
      standardSheet: resolved.level.standardSheet,
    },
    errorDistribution: {
      family: 'student-t',
      statistic: 'P(|T| ≥ |(error − mean) / scale|)',
      classes: Object.fromEntries(DP4_PARAMETER_CLASSES.map((key) => [key, {
        ...resolved.level.parameters[key],
        label: dp4ClassLabel(key),
      }])),
    },
    temperatureK,
    experimental: {
      count: rows.length,
      carbon: carbonRows,
      hydrogen: hydrogenRows,
      shifts: rows.map((row) => ({
        index: row.index, nucleus: row.nucleus, element: row.element, shift: row.shift, sp2: row.sp2,
      })),
    },
    candidateCount: scored.length,
    candidates: ranking,
    excluded,
    nucleiCompared: rows.length * scored.length,
    checks: {
      sumOfProbabilities: scored.reduce((sum, candidate) => sum + candidate.probability, 0),
      nucleiPerCandidate: rows.length,
    },
  };
}

/**
 * The one-line verdict the card and the report both print:
 * `c1 — 87.3 % (DP4+ full)`. A drawn comparison is not hidden: two candidates
 * within 5 percentage points are called close rather than given a winner.
 */
export function dp4Verdict(result, { closePercent = 5 } = {}) {
  if (!result || result.available !== true) return null;
  const [first, second] = result.candidates;
  if (!first) return null;
  const margin = first.percent - (second ? second.percent : 0);
  return {
    id: first.id,
    title: first.title,
    percent: first.percent,
    margin,
    close: Boolean(second) && margin <= closePercent,
    text: second && margin <= closePercent
      ? `${first.title} ${first.percent.toFixed(2)} % and ${second.title} ${second.percent.toFixed(2)} % are within ${closePercent} points: the data do not separate these two`
      : `${first.title} ${first.percent.toFixed(2)} % (${result.variantLabel})` +
        (second ? `, ${margin.toFixed(2)} points ahead of ${second.title}` : ''),
  };
}

/** The Boltzmann-constant the conformer module uses, re-exported for the card's arithmetic note. */
export const DP4_KB_KCAL = KB_KCAL;
