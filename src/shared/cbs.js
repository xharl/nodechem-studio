/**
 * Complete-basis-set (CBS) extrapolation from a method ladder.
 *
 * The form implemented here is the Helgaker two-point correlation
 * extrapolation:
 *
 *   E_corr(X) = E_corr,CBS + A · X^(-3)
 *
 * where X is the cardinal number of the correlation-consistent basis set
 * (D = 2, T = 3, Q = 4, …). The exponent belongs to the correlation energy
 * only: the SCF energy converges differently (Helgaker et al. fit it with an
 * exponential, which two points cannot determine), so the SCF component is
 * taken from the largest rung and the result says so. It is never a single
 * X^-3 fit to the total energy.
 *
 * A two-point extrapolation is only an estimate. The module refuses rather
 * than guesses: one rung, two rungs at the same cardinal number, rungs from
 * different basis families, rungs at different levels of theory, a method with
 * no tabulated correlation exponent, or a rung without an SCF energy all
 * produce `available: false` with the missing input named.
 *
 * References:
 *   T. Helgaker, W. Klopper, H. Koch, J. Noga, "Basis-set convergence of
 *   correlated calculations on water", J. Chem. Phys. 106, 9639 (1997),
 *   doi:10.1063/1.473863 (correlation energy E_corr = a + b X^-3).
 *   A. Halkier, T. Helgaker, P. Jørgensen, W. Klopper, H. Koch, J. Olsen,
 *   A. K. Wilson, "Basis-set convergence in correlated calculations on Ne,
 *   N2, and H2O", Chem. Phys. Lett. 286, 243 (1998), doi:10.1016/S0009-2614(98)00111-0
 *   (two-point X^-3 correlation extrapolation).
 */

/** Hartree → kcal/mol, CODATA-2018 (the constant the ladder module uses). */
export const HARTREE_TO_KCAL_PER_MOL = 627.5094740631;

/**
 * Correlation exponent per correlation method. The table is deliberately
 * explicit: an unknown method is refused rather than given the default.
 */
export const CORRELATION_EXPONENTS = Object.freeze({
  mp2: 3,
  mp3: 3,
  mp4: 3,
  ccsd: 3,
  'ccsd(t)': 3,
  qcisd: 3,
  'qcisd(t)': 3,
});

export const CBS_FORM = 'Helgaker two-point correlation extrapolation '
  + '(E_corr(X) = E_corr,CBS + A·X^-3; SCF taken from the largest rung, not extrapolated)';

export const CBS_CITATION = 'Helgaker et al., J. Chem. Phys. 106, 9639 (1997); '
  + 'Halkier et al., Chem. Phys. Lett. 286, 243 (1998)';

const SUPPORTED_FAMILIES = 'cc-pVXZ, aug-cc-pVXZ and def2-XZVP';
const SUPPORTED_METHODS = 'MP2, MP3, MP4, CCSD, CCSD(T), QCISD and QCISD(T)';

function oneLine(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Cardinal number and family of a basis set.
 *
 * Only families with a documented cardinal hierarchy are accepted. A Pople
 * basis such as 6-311G(d,p) is a triple-zeta set in spirit but not in the
 * correlation-consistent sense the extrapolation assumes, so it returns null
 * instead of being assigned a made-up X.
 */
export function basisCardinality(basis) {
  const raw = oneLine(basis);
  if (!raw) return null;
  const name = raw.toLowerCase().replace(/\s+/g, '');
  const cc = name.match(/^(aug-)?cc-pv([dtq56])z$/);
  if (cc) {
    const x = { d: 2, t: 3, q: 4, 5: 5, 6: 6 }[cc[2]];
    return { family: cc[1] ? 'aug-cc-pVXZ' : 'cc-pVXZ', x, basis: raw };
  }
  const def2 = name.match(/^def2-?(sv|tzv|qzv)(?:p{1,2}|\(p\))?$/);
  if (def2) {
    const x = { sv: 2, tzv: 3, qzv: 4 }[def2[1]];
    return { family: 'def2', x, basis: raw };
  }
  return null;
}

function methodKey(method) {
  return oneLine(method, 40).toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^ccsd-t$/, 'ccsd(t)')
    .replace(/^qcisd-t$/, 'qcisd(t)');
}

function unavailable(reason, extra = {}) {
  return {
    available: false,
    reason,
    form: CBS_FORM,
    citation: CBS_CITATION,
    method: null,
    exponents: null,
    pair: null,
    scfHartree: null,
    scfSource: null,
    correlationCbsHartree: null,
    energyHartree: null,
    spread: null,
    ...extra,
  };
}

/** Two-point X^-alpha extrapolation of one component. */
function twoPoint(lower, upper, alpha) {
  const denominator = upper.x ** alpha - lower.x ** alpha;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
  return (upper.energy * upper.x ** alpha - lower.energy * lower.x ** alpha) / denominator;
}

/**
 * Extrapolate a ladder to the complete-basis-set limit.
 *
 * @param {Array<object>} rungs entries with `label`, `method`, `basis`,
 *   `energyHartree` (the total final energy) and `scfEnergyHartree` (the SCF
 *   reference energy the correlation energy is measured against)
 * @param {object} [options]
 * @param {number|null} [options.correlationExponent] override the tabulated
 *   exponent for an approved method; the name stays in `form` via `exponents`
 * @returns {object} `available` plus, when reported, the pair, the SCF source,
 *   the extrapolated correlation energy, the CBS total and the ladder spread
 */
export function cbsExtrapolate(rungs, { correlationExponent = null } = {}) {
  const entries = (Array.isArray(rungs) ? rungs : []).map((rung, index) => ({
    index,
    label: oneLine(rung?.label, 60) || `Rung ${index + 1}`,
    method: oneLine(rung?.method, 40),
    basis: oneLine(rung?.basis, 40),
    energyHartree: Number.isFinite(Number(rung?.energyHartree)) ? Number(rung.energyHartree) : null,
    scfEnergyHartree: Number.isFinite(Number(rung?.scfEnergyHartree)) ? Number(rung.scfEnergyHartree) : null,
  }));

  if (entries.length === 0) {
    return unavailable('a second rung is required; no rungs were supplied');
  }
  if (entries.length < 2) {
    const only = entries[0];
    return unavailable(`a second rung is required; only ${only.label} (${only.basis || 'no basis'}) was supplied`);
  }

  for (const entry of entries) {
    if (entry.energyHartree === null) {
      return unavailable(`${entry.label} (${entry.basis || 'no basis'}) has no final energy; a CBS estimate needs a total energy at every rung`);
    }
  }

  const methods = [...new Set(entries.map((entry) => entry.method).filter(Boolean))];
  if (methods.length > 1) {
    return unavailable(`the rungs are at different methods (${methods.join(', ')}); a CBS extrapolation needs one level of theory across the basis pair`);
  }
  if (methods.length === 0) {
    return unavailable('the rungs do not name a method, so no correlation exponent can be chosen');
  }
  const method = methods[0];
  const key = methodKey(method);
  const tabulated = Object.prototype.hasOwnProperty.call(CORRELATION_EXPONENTS, key)
    ? CORRELATION_EXPONENTS[key] : null;
  if (tabulated === null) {
    return unavailable(`no correlation exponent is defined for method "${method}"; CBS extrapolation is limited to ${SUPPORTED_METHODS}`);
  }
  const exponent = Number.isFinite(Number(correlationExponent)) && Number(correlationExponent) > 0
    ? Number(correlationExponent) : tabulated;

  for (const entry of entries) {
    if (!basisCardinality(entry.basis)) {
      return unavailable(`${entry.label} (${entry.basis || 'no basis'}) has no recognised cardinal number; supported families are ${SUPPORTED_FAMILIES}`);
    }
  }

  const families = [...new Set(entries.map((entry) => basisCardinality(entry.basis).family))];
  if (families.length > 1) {
    const named = entries.map((entry) => entry.basis).join(' and ');
    return unavailable(`${named} belong to different basis families (${families.join(', ')}); a CBS pair must come from one family`);
  }

  const sorted = entries
    .map((entry) => ({ ...entry, ...basisCardinality(entry.basis) }))
    .sort((a, b) => (a.x - b.x) || (a.index - b.index));
  const distinctX = [...new Set(sorted.map((entry) => entry.x))];
  if (distinctX.length < 2) {
    return unavailable(`${sorted[0].basis} and ${sorted[1].basis} have the same cardinal number (X=${sorted[0].x}); a CBS pair needs two different basis sets`);
  }

  const upper = sorted[sorted.length - 1];
  let lowerIndex = sorted.length - 2;
  while (lowerIndex >= 0 && sorted[lowerIndex].x === upper.x) lowerIndex -= 1;
  const lower = sorted[lowerIndex];
  if (!lower || lower.x === upper.x) {
    return unavailable(`two distinct cardinal numbers are required; only X=${upper.x} is present`);
  }

  for (const entry of [lower, upper]) {
    if (entry.scfEnergyHartree === null) {
      return unavailable(`${entry.label} (${entry.basis}) has no SCF energy, so its correlation energy cannot be separated`);
    }
  }

  const lowerCorr = lower.energyHartree - lower.scfEnergyHartree;
  const upperCorr = upper.energyHartree - upper.scfEnergyHartree;
  const correlationCbsHartree = twoPoint(
    { x: lower.x, energy: lowerCorr },
    { x: upper.x, energy: upperCorr },
    exponent,
  );
  if (correlationCbsHartree === null || !Number.isFinite(correlationCbsHartree)) {
    return unavailable('the two rungs do not define a finite extrapolation');
  }

  const ladderEnergies = entries.filter((entry) => entry.energyHartree !== null);
  const min = Math.min(...ladderEnergies.map((entry) => entry.energyHartree));
  const max = Math.max(...ladderEnergies.map((entry) => entry.energyHartree));
  const pair = (entry) => ({
    label: entry.label,
    method: entry.method,
    basis: entry.basis,
    x: entry.x,
    energyHartree: entry.energyHartree,
    scfEnergyHartree: entry.scfEnergyHartree,
    correlationHartree: entry.energyHartree - entry.scfEnergyHartree,
  });

  return {
    available: true,
    reason: null,
    form: CBS_FORM,
    citation: CBS_CITATION,
    method,
    exponents: { correlation: exponent },
    family: families[0],
    pair: { lower: pair(lower), upper: pair(upper) },
    // SCF is not extrapolated: no two-point power law is justified for it.
    scfHartree: upper.scfEnergyHartree,
    scfSource: `largest rung (${upper.basis}), not extrapolated`,
    correlationCbsHartree,
    energyHartree: upper.scfEnergyHartree + correlationCbsHartree,
    spread: {
      kcal: (max - min) * HARTREE_TO_KCAL_PER_MOL,
      over: `${ladderEnergies.length} rungs (${ladderEnergies.map((entry) => entry.basis).join(', ')})`,
      kind: 'ladder spread',
    },
  };
}
