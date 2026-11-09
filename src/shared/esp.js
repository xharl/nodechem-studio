/**
 * Electrostatic potential from a formatted-checkpoint density matrix (issue 164).
 *
 * ## What this computes
 *
 *   V(r) = Σ_A Z_A/|r − R_A| − ∫ ρ(r′)/|r − r′| d³r′,   ρ(r′) = Σ_μν D_μν χ_μ(r′) χ_ν(r′)
 *
 * in Hartree (a.u. of potential, i.e. Hartree per elementary charge), on any set
 * of points in Å. The density matrix is the one the file carries
 * (`Total SCF Density`, triangular); the basis is the one the same file carries
 * (`Shell types`, `Primitive exponents`, …), compiled by `volume.js`, so the
 * potential and an orbital cube drawn from this checkpoint are on the same
 * footing.
 *
 * ## Method: analytic, not a sampled-density quadrature
 *
 * The electron term is evaluated **analytically over the basis**, not by
 * integrating ρ sampled on a grid. That choice is measured, not stylistic: the
 * density of a Gaussian basis is sharply peaked at the nuclei, and midpoint
 * quadrature on a grid fine enough to be useful for a picture cannot resolve a
 * 1s core. On the committed Psi4 oracle (water, B3LYP/6-31G*, 0.4 bohr grid)
 * `Σ ρ_i h³` comes to 17.7 electrons instead of 10 — the core is counted almost
 * twice — and the resulting potential is wrong by more than 1 Hartree on
 * average and by tens of Hartree near oxygen. Refining the grid does not fix it:
 * a grid point sitting on a nucleus samples ρ ∼ h⁻³, so the quadrature error
 * stays. A grid-free method is therefore the only defensible one here.
 *
 * Each product of two Cartesian Gaussians is expanded in Hermite Gaussians
 * (McMurchie–Davidson coefficients E_t) and the Coulomb operator is applied to
 * each Hermite function, which gives the standard Hermite Coulomb sum
 *
 *   (ab|1/r_C) = K_ab Σ_t E_t^{ab} · (2π/γ) (−1)^|t| ∂_t F₀(γ|P−C|²),
 *
 * where ∂_x F_n = −2γ x F_{n+1} turns each derivative into a short list of
 * monomials times Boys functions F_n, γ = α+β, P the product centre,
 * K_ab = exp(−αβ/γ |A−B|²), and F_n is evaluated by downward recursion from an
 * asymptotic start (stable for every γR² this module sees). The result is
 * exact up to floating point for a basis of s/p/d/f functions, which is every
 * basis this app can evaluate.
 *
 * Consequence, stated because it is a real limitation: the potential is only as
 * good as the density matrix and the basis in the file. A checkpoint that
 * carries no density block cannot be answered at all — see `densityMatrix`,
 * which returns `{ok: false, reason}` rather than a zero field.
 *
 * ## Reference point for the singular nuclear term
 *
 * 1/|r−R_A| is infinite at a nucleus. Points closer than `NEAR_NUCLEUS_BOHR` to
 * a nucleus are still returned (the grid has to be complete to be drawn) but are
 * flagged in `nearNucleus`, because at that distance the number is a statement
 * about quadrature and basis-set completeness, not about chemistry.
 */

import { BOHR_TO_ANGSTROM } from './cubeFile.js';
import { prepareBasis, shellsFromCheckpoint } from './volume.js';

export const BOHR_PER_ANGSTROM = 1 / BOHR_TO_ANGSTROM;

/** CODATA 2018, the same constant the rest of the app converts with. */
export const HARTREE_TO_KCAL = 627.5094740631;

/** Points this close to a nucleus are marked; the 1/|r−R| term dominates there. */
export const NEAR_NUCLEUS_BOHR = 0.25;

export class EspError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EspError';
  }
}

/** The one-sentence method statement a card and a caption print verbatim. */
export const ESP_METHOD = 'analytic basis-function potential (McMurchie–Davidson Hermite expansion, '
  + 'Boys functions), not a sampled-density quadrature';

/**
 * The density matrix, as the file writes it: the lower triangle in
 * `NBasis(NBasis+1)/2` values, row by row.
 *
 * `values` is a Float64Array (see `fchk.js`), and `element(i, j)` indexes it
 * without materialising the square matrix. Returns `{ok: false, reason}` when
 * the file has no density block — the caller must print the reason, not a zero.
 */
export function densityMatrix(fchk) {
  if (!fchk || typeof fchk !== 'object') return { ok: false, reason: 'there is no parsed checkpoint' };
  const dimension = fchk.numberOfBasisFunctions;
  if (!Number.isInteger(dimension) || dimension < 1) {
    return { ok: false, reason: 'the checkpoint does not state how many basis functions it has' };
  }
  const source = Array.isArray(fchk.totalScfDensity) || fchk.totalScfDensity instanceof Float64Array
    ? 'Total SCF Density'
    : (Array.isArray(fchk.totalScdDensity) || fchk.totalScdDensity instanceof Float64Array
      ? 'Total SCD Density'
      : null);
  if (!source) {
    return {
      ok: false,
      reason: 'no density in this file',
      detail: 'the checkpoint carries neither "Total SCF Density" nor "Total SCD Density", '
        + 'so there is no electron density to integrate against',
    };
  }
  const values = fchk.totalScfDensity || fchk.totalScdDensity;
  const expected = (dimension * (dimension + 1)) / 2;
  if (values.length !== expected) {
    return {
      ok: false,
      reason: 'the density block does not match the basis',
      detail: `"${source}" holds ${values.length} values; ${dimension} basis functions need ${expected}.`,
    };
  }
  return {
    ok: true,
    dimension,
    values,
    source,
    // i ≥ j, row by row: D(1,1), D(2,1), D(2,2), D(3,1), …
    element: (i, j) => {
      const row = i >= j ? i : j;
      const column = i >= j ? j : i;
      return values[(row * (row + 1)) / 2 + column];
    },
  };
}

/* ── basis: one list of primitive monomials per basis function ───── */

function atomsInBohr(fchk) {
  const atoms = Array.isArray(fchk?.atoms) ? fchk.atoms : [];
  return atoms.map((atom, index) => {
    const x = Number(atom?.x);
    const y = Number(atom?.y);
    const z = Number(atom?.z);
    if (![x, y, z].every((value) => Number.isFinite(value))) {
      throw new EspError(`atom ${index + 1} has no finite Cartesian position in the checkpoint.`);
    }
    return {
      atomicNumber: Number.isInteger(atom?.atomicNumber) ? atom.atomicNumber : 0,
      x: x * BOHR_PER_ANGSTROM,
      y: y * BOHR_PER_ANGSTROM,
      z: z * BOHR_PER_ANGSTROM,
    };
  });
}

/**
 * Every basis function as a list of `{alpha, centre, i, j, k, w}` primitive
 * monomials, in bohr and bohr⁻². `w` already carries the contraction
 * coefficient and the normalisation (and, for a spherical shell, the coefficient
 * that combines the Cartesian monomials into the pure function), so a basis
 * function is exactly Σ over its entries.
 *
 * The basis is compiled by `volume.js` — the same code that evaluates an
 * orbital — so a potential and an orbital from one checkpoint cannot disagree
 * about the basis.
 */
export function basisFunctions(fchk) {
  if (!Array.isArray(fchk?.shellTypes)) {
    throw new EspError('the checkpoint carries no basis ("Shell types" is absent), so the density matrix cannot be integrated.');
  }
  const described = shellsFromCheckpoint(fchk);
  const prepared = prepareBasis(described.shells);
  const atoms = atomsInBohr(fchk);
  const functions = Array.from({ length: prepared.functionCount }, () => []);
  for (const shell of prepared.shells) {
    const centre = atoms[shell.atom];
    if (!centre) {
      throw new EspError(`a shell is attached to atom ${shell.atom + 1}, which the checkpoint does not carry.`);
    }
    for (const primitiveIndex of shell.primitiveIndices) {
      const primitive = prepared.primitives[primitiveIndex];
      for (const term of primitive.terms) {
        const at = shell.offset + term.component;
        if (!functions[at]) continue;
        functions[at].push({
          alpha: primitive.alpha,
          cx: centre.x,
          cy: centre.y,
          cz: centre.z,
          i: term.i,
          j: term.j,
          k: term.k,
          w: term.w,
        });
      }
    }
  }
  return {
    functions,
    count: prepared.functionCount,
    atoms,
    shells: prepared.shells.length,
    basisFunctions: described.numberOfBasisFunctions,
  };
}

/* ── Boys function ────────────────────────────────────────────────── */

/**
 * F_n(T) = ∫₀¹ u^{2n} e^{−T u²} du for n = 0…order, as an array.
 *
 * Two regimes, both standard: for small T the power series (which has no
 * cancellation), and above it the upward recursion from F₀ = √π·erf(√T)/(2√T).
 * The recursion loses precision only through the e^{−T} subtraction, which is
 * negligible once T ≳ 0.5, and the bases here only need n ≤ 4, so the error
 * stays far below the 1e-9 that a potential in Hartree is reported to.
 */
export function boysFunctions(T, order) {
  const n = Math.max(0, Math.floor(order));
  const F = new Float64Array(n + 1);
  const t = Number.isFinite(T) && T > 0 ? T : 0;
  if (t < 0.5) {
    // F_n(T) = Σ_k (−T)^k/(k! (2n+2k+1)).
    let factorial = 1;
    let power = 1;
    for (let k = 0; k <= 24; k += 1) {
      if (k > 0) {
        factorial *= k;
        power *= -t;
      }
      const term = power / (factorial * (2 * k + 1));
      for (let m = 0; m <= n; m += 1) F[m] += power / (factorial * (2 * m + 2 * k + 1));
      if (k > 0 && Math.abs(term) < 1e-18) break;
    }
    return F;
  }
  F[0] = (Math.sqrt(Math.PI) / (2 * Math.sqrt(t))) * erf(Math.sqrt(t));
  const expNeg = Math.exp(-t);
  for (let k = 0; k < n; k += 1) {
    // F_{k+1} = ((2k+1) F_k − e^{−T}) / (2T)
    F[k + 1] = ((2 * k + 1) * F[k] - expNeg) / (2 * t);
  }
  return F;
}

/**
 * erf and erfc without a dependency: the Maclaurin series below 3 (which loses
 * no digits there) and the asymptotic expansion of erfc above it, where the
 * series has already cancelled itself away. Both are good to ~1e-15 relative
 * over the range the Boys function needs (√T ≤ ~60 for the grids here).
 */
function erf(x) {
  const z = Math.abs(x);
  const sign = x < 0 ? -1 : 1;
  if (z < 3) {
    let sum = z;
    let term = z;
    for (let k = 1; k < 90; k += 1) {
      term *= (-z * z) / k;
      const add = term / (2 * k + 1);
      sum += add;
      if (Math.abs(add) < 1e-18 * Math.abs(sum)) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum * sign;
  }
  return sign * (1 - erfcAsymptotic(z));
}

/** erfc(z) for z ≥ 3: e^{−z²}/(z√π) Σ (−1)^k (2k−1)!!/(2z²)^k. */
function erfcAsymptotic(z) {
  const z2 = z * z;
  const terms = Math.min(12, Math.floor(z2));
  let sum = 1;
  let term = 1;
  for (let k = 1; k <= terms; k += 1) {
    term *= -(2 * k - 1) / (2 * z2);
    sum += term;
  }
  return Math.exp(-z2) * sum / (z * Math.sqrt(Math.PI));
}

/* ── Hermite expansion ────────────────────────────────────────────── */

const E_ZERO = 1e-300;

/** MD coefficients E^{i,j}_t in one dimension, t = 0…i+j. */
function hermiteCoefficients(i, j, ax, bx, p, gamma) {
  const max = i + j;
  const inv2p = 1 / (2 * gamma);
  const xpa = p - ax;
  const xpb = p - bx;
  const raise = (table, delta) => {
    const out = new Float64Array(max + 2);
    for (let t = 0; t <= max; t += 1) {
      const centre = table[t] ?? 0;
      const below = t > 0 ? (table[t - 1] ?? 0) : 0;
      const above = table[t + 1] ?? 0;
      out[t] = inv2p * below + delta * centre + (t + 1) * above;
    }
    return out;
  };
  let table = new Float64Array(max + 2);
  table[0] = 1;
  for (let a = 0; a < i; a += 1) table = raise(table, xpa);
  for (let b = 0; b < j; b += 1) table = raise(table, xpb);
  const out = new Float64Array(max + 1);
  for (let t = 0; t <= max; t += 1) out[t] = table[t];
  return out;
}

/**
 * `(2π/γ)(−1)^|t| ∂_x^{tx} ∂_y^{ty} ∂_z^{tz} F₀(γR²)` as a list of
 * `{mx, my, mz, n, c}` terms: a monomial R_x^mx R_y^my R_z^mz times F_n(γR²).
 *
 * Built with ∂_x F_n = −2γ R_x F_{n+1}, which is exact.
 */
function hermiteCoulombTerms(tx, ty, tz, gamma) {
  let terms = [{ mx: 0, my: 0, mz: 0, n: 0, c: 1 }];
  const differentiate = (list, axis) => {
    const merged = new Map();
    const add = (mx, my, mz, n, c) => {
      if (!c || Math.abs(c) < E_ZERO) return;
      const key = `${mx},${my},${mz},${n}`;
      const entry = merged.get(key);
      if (entry) entry.c += c;
      else merged.set(key, { mx, my, mz, n, c });
    };
    for (const term of list) {
      const power = axis === 'x' ? term.mx : axis === 'y' ? term.my : term.mz;
      if (power > 0) {
        add(
          axis === 'x' ? term.mx - 1 : term.mx,
          axis === 'y' ? term.my - 1 : term.my,
          axis === 'z' ? term.mz - 1 : term.mz,
          term.n,
          term.c * power,
        );
      }
      add(
        term.mx + (axis === 'x' ? 1 : 0),
        term.my + (axis === 'y' ? 1 : 0),
        term.mz + (axis === 'z' ? 1 : 0),
        term.n + 1,
        term.c * -2 * gamma,
      );
    }
    return [...merged.values()];
  };
  for (let step = 0; step < tx; step += 1) terms = differentiate(terms, 'x');
  for (let step = 0; step < ty; step += 1) terms = differentiate(terms, 'y');
  for (let step = 0; step < tz; step += 1) terms = differentiate(terms, 'z');
  const sign = (tx + ty + tz) % 2 === 0 ? 1 : -1;
  const scale = sign * (2 * Math.PI) / gamma;
  for (const term of terms) term.c *= scale;
  return terms;
}

/**
 * One primitive-product entry: a product of two primitive monomials, already
 * multiplied by the density element and the symmetry factor, compiled into a
 * flat list of `(coefficient, mx, my, mz, n)` terms to be evaluated at a point.
 * Everything except the Boys functions and the monomial powers is precomputed,
 * so a point costs one square root, one exponential and one pass over the list.
 */
function productEntry(a, b, coefficient) {
  const gamma = a.alpha + b.alpha;
  const inv = 1 / gamma;
  const p = [
    (a.alpha * a.cx + b.alpha * b.cx) * inv,
    (a.alpha * a.cy + b.alpha * b.cy) * inv,
    (a.alpha * a.cz + b.alpha * b.cz) * inv,
  ];
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  const dz = a.cz - b.cz;
  const exponent = -(a.alpha * b.alpha * inv) * (dx * dx + dy * dy + dz * dz);
  if (exponent < -700) return null;
  // The contraction coefficients and normalisations of both primitive monomials
  // belong to the density: χ_μ χ_ν is a sum of these weighted products.
  const K = a.w * b.w * Math.exp(exponent) * coefficient;
  if (!Number.isFinite(K) || Math.abs(K) < E_ZERO) return null;

  const ex = hermiteCoefficients(a.i, b.i, a.cx, b.cx, p[0], gamma);
  const ey = hermiteCoefficients(a.j, b.j, a.cy, b.cy, p[1], gamma);
  const ez = hermiteCoefficients(a.k, b.k, a.cz, b.cz, p[2], gamma);

  const flat = [];
  let order = 0;
  for (let tx = 0; tx < ex.length; tx += 1) {
    if (!ex[tx]) continue;
    for (let ty = 0; ty < ey.length; ty += 1) {
      if (!ey[ty]) continue;
      for (let tz = 0; tz < ez.length; tz += 1) {
        if (!ez[tz]) continue;
        const weight = K * ex[tx] * ey[ty] * ez[tz];
        if (!Number.isFinite(weight) || Math.abs(weight) < E_ZERO) continue;
        for (const term of hermiteCoulombTerms(tx, ty, tz, gamma)) {
          const c = weight * term.c;
          if (!Number.isFinite(c) || Math.abs(c) < E_ZERO) continue;
          flat.push(c, term.mx, term.my, term.mz, term.n);
          if (term.n > order) order = term.n;
        }
      }
    }
  }
  if (flat.length === 0) return null;
  return {
    px: p[0],
    py: p[1],
    pz: p[2],
    gamma,
    order,
    terms: Float64Array.from(flat),
    termCount: flat.length / 5,
  };
}

/**
 * The compiled electron term, ready to be evaluated at any number of points.
 * `entries` and `termCount` are provenance: a card can state how many
 * primitive products the sum ran over.
 */
export function compileDensityPotential(fchk) {
  const density = densityMatrix(fchk);
  if (!density.ok) return density;
  const basis = basisFunctions(fchk);
  const { functions } = basis;
  const entries = [];
  let skipped = 0;
  let termCount = 0;
  let pairCount = 0;
  for (let mu = 0; mu < functions.length; mu += 1) {
    for (let nu = mu; nu < functions.length; nu += 1) {
      const d = density.element(mu, nu);
      if (d === 0) continue;
      // D is symmetric: off-diagonal elements enter the sum twice.
      const factor = mu === nu ? d : 2 * d;
      pairCount += 1;
      for (const a of functions[mu]) {
        for (const b of functions[nu]) {
          const entry = productEntry(a, b, factor);
          if (!entry) {
            skipped += 1;
            continue;
          }
          entries.push(entry);
          termCount += entry.termCount;
        }
      }
    }
  }
  return {
    ok: true,
    density,
    basis,
    entries,
    pairCount,
    termCount,
    skipped,
    method: ESP_METHOD,
  };
}

/* ── evaluation ───────────────────────────────────────────────────── */

function checkPoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new EspError('a potential needs at least one point as [x, y, z] in Å.');
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Array.isArray(point) || point.length !== 3 || !point.every((value) => Number.isFinite(value))) {
      throw new EspError(`point ${index + 1} is not [x, y, z] in Å.`);
    }
  }
}

/** Nuclear attraction Σ_A Z_A/|r−R_A|, in Hartree, for points in Å. */
export function nuclearPotential(points, atoms) {
  const out = new Float64Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const x = points[index][0] * BOHR_PER_ANGSTROM;
    const y = points[index][1] * BOHR_PER_ANGSTROM;
    const z = points[index][2] * BOHR_PER_ANGSTROM;
    let total = 0;
    for (const atom of atoms) {
      const dx = x - atom.x;
      const dy = y - atom.y;
      const dz = z - atom.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (atom.atomicNumber > 0) total += atom.atomicNumber / distance;
    }
    out[index] = total;
  }
  return out;
}

/**
 * V(r) in Hartree at each point (Å).
 *
 * Returns `{ok: false, reason}` when the file has no density matrix; nothing is
 * filled in with zeros. `values` is a Float64Array in the same order as
 * `points`; `nearNucleus` marks the points within `NEAR_NUCLEUS_BOHR` of a
 * nucleus, where the nuclear term diverges as the point approaches the centre.
 */
export function electrostaticPotential({ fchk, points, includeNuclei = true, compiled = null } = {}) {
  checkPoints(points);
  const potential = compiled ?? compileDensityPotential(fchk);
  if (!potential.ok) return potential;
  const { entries, basis } = potential;
  const atoms = basis.atoms;

  const values = new Float64Array(points.length);
  const nearNucleus = new Uint8Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const x = points[index][0] * BOHR_PER_ANGSTROM;
    const y = points[index][1] * BOHR_PER_ANGSTROM;
    const z = points[index][2] * BOHR_PER_ANGSTROM;
    let electron = 0;
    for (const entry of entries) {
      const dx = x - entry.px;
      const dy = y - entry.py;
      const dz = z - entry.pz;
      const r2 = dx * dx + dy * dy + dz * dz;
      const F = boysFunctions(entry.gamma * r2, entry.order);
      // Powers are built once per entry, not once per term.
      const px = [1, dx, dx * dx, dx * dx * dx, dx * dx * dx * dx];
      const py = [1, dy, dy * dy, dy * dy * dy, dy * dy * dy * dy];
      const pz = [1, dz, dz * dz, dz * dz * dz, dz * dz * dz * dz];
      const { terms } = entry;
      let sum = 0;
      for (let t = 0; t < terms.length; t += 5) {
        sum += terms[t] * px[terms[t + 1]] * py[terms[t + 2]] * pz[terms[t + 3]] * F[terms[t + 4]];
      }
      electron += sum;
    }
    values[index] = -electron;
    if (includeNuclei) {
      let nuclear = 0;
      for (const atom of atoms) {
        const dx = x - atom.x;
        const dy = y - atom.y;
        const dz = z - atom.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (atom.atomicNumber > 0) nuclear += atom.atomicNumber / distance;
        if (distance < NEAR_NUCLEUS_BOHR) nearNucleus[index] = 1;
      }
      values[index] += nuclear;
    } else {
      for (const atom of atoms) {
        const dx = x - atom.x;
        const dy = y - atom.y;
        const dz = z - atom.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < NEAR_NUCLEUS_BOHR) nearNucleus[index] = 1;
      }
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    ok: true,
    values,
    nearNucleus,
    unit: 'hartree',
    method: ESP_METHOD,
    includeNuclei,
    stats: { min, max, mean: values.reduce((sum, value) => sum + value, 0) / values.length },
    atoms,
    provenance: {
      method: ESP_METHOD,
      densityBlock: potential.density.source,
      basisFunctions: basis.count,
      shells: basis.shells,
      pairs: potential.pairCount,
      primitiveProducts: entries.length,
      terms: potential.termCount,
      nearNucleusBohr: NEAR_NUCLEUS_BOHR,
    },
  };
}

/**
 * ρ(r) = Σ_μν D_μν χ_μ χ_ν in e/bohr³ at points in Å.
 *
 * Not needed to colour a surface, but it is the cheapest independent check that
 * the density matrix was read in the right order: one point at a nucleus and one
 * in a bond are enough to catch a transposed triangle.
 */
export function electronDensityAt({ fchk, points } = {}) {
  checkPoints(points);
  const density = densityMatrix(fchk);
  if (!density.ok) return density;
  const basis = basisFunctions(fchk);
  const { functions } = basis;
  const chi = new Float64Array(functions.length);
  const out = new Float64Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const x = points[index][0] * BOHR_PER_ANGSTROM;
    const y = points[index][1] * BOHR_PER_ANGSTROM;
    const z = points[index][2] * BOHR_PER_ANGSTROM;
    for (let mu = 0; mu < functions.length; mu += 1) {
      let sum = 0;
      for (const primitive of functions[mu]) {
        const dx = x - primitive.cx;
        const dy = y - primitive.cy;
        const dz = z - primitive.cz;
        sum += primitive.w
          * Math.exp(-primitive.alpha * (dx * dx + dy * dy + dz * dz))
          * dx ** primitive.i * dy ** primitive.j * dz ** primitive.k;
      }
      chi[mu] = sum;
    }
    let total = 0;
    for (let mu = 0; mu < functions.length; mu += 1) {
      for (let nu = mu; nu < functions.length; nu += 1) {
        const d = density.element(mu, nu);
        if (d === 0) continue;
        total += d * chi[mu] * chi[nu] * (mu === nu ? 1 : 2);
      }
    }
    out[index] = total;
  }
  return {
    ok: true,
    values: out,
    unit: 'e/bohr^3',
    densityBlock: density.source,
    basisFunctions: basis.count,
  };
}

/* ── grids ───────────────────────────────────────────────────────── */

/**
 * The potential on a regular grid — the shape `gridFor` and `parseCube` both
 * describe: `{counts, origin (Å), step (Å)}`, values indexed
 * `i + nx*(j + ny*k)` (x fastest), which is the same contract `volume.js`
 * fields use and the one `parseCube` returns.
 *
 * The grid is returned with the result, and callers are expected to print it:
 * the numbers in a legend mean nothing without the grid they were sampled on.
 */
export function potentialOnGrid({ fchk, grid, includeNuclei = true } = {}) {
  if (!grid || !Array.isArray(grid.counts) || grid.counts.length !== 3) {
    throw new EspError('a grid needs three counts (see volume.gridFor).');
  }
  const [nx, ny, nz] = grid.counts.map(Number);
  const step = Number(grid.step);
  if (!grid.counts.every((count) => Number.isInteger(Number(count)) && Number(count) > 0)) {
    throw new EspError('the grid counts must be positive integers.');
  }
  if (!Number.isFinite(step) || step <= 0) throw new EspError('the grid needs a positive step in Å.');
  if (!Array.isArray(grid.origin) || grid.origin.length !== 3 || !grid.origin.every(Number.isFinite)) {
    throw new EspError('the grid needs a three-number origin in Å.');
  }
  const total = nx * ny * nz;
  const points = new Array(total);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        points[i + nx * (j + ny * k)] = [
          grid.origin[0] + i * step,
          grid.origin[1] + j * step,
          grid.origin[2] + k * step,
        ];
      }
    }
  }
  const potential = electrostaticPotential({ fchk, points, includeNuclei });
  if (!potential.ok) return potential;
  return {
    ...potential,
    kind: 'esp',
    label: 'electrostatic potential',
    dims: [nx, ny, nz],
    origin: [...grid.origin],
    axes: [[step, 0, 0], [0, step, 0], [0, 0, step]],
    step,
    points: total,
    grid: {
      counts: [nx, ny, nz],
      origin: [...grid.origin],
      step,
      points: total,
      // A one-line statement for a card or a caption.
      note: `${nx}×${ny}×${nz} = ${total} points at ${step.toFixed(3)} Å (${(step * BOHR_PER_ANGSTROM).toFixed(3)} bohr)`,
    },
  };
}

/* ── legibility: the range a legend prints ───────────────────────── */

/** Hartree → kcal/mol, the unit a chemist reads a surface colour in. */
export function toKcalMol(value) {
  return Number(value) * HARTREE_TO_KCAL;
}

/**
 * The colour range for a diverging scale, and whether it was scaled to the
 * molecule's own extremes.
 *
 * The default is symmetric about zero and taken from the data (`scaled: true`),
 * because a potential has a sign and a one-sided or clipped scale would show a
 * neutral atom as coloured. `limitHartree` clips the range around zero and says
 * so in `scaledTo`: a clipped scale is printed as clipped, never as the data's
 * own range.
 */
export function potentialRange(values, { limitHartree = null, subject = 'molecule' } = {}) {
  if (!values || typeof values.length !== 'number' || values.length === 0) {
    throw new EspError('a colour range needs at least one potential value.');
  }
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const limit = Number(limitHartree);
  if (Number.isFinite(limit) && limit > 0) {
    min = Math.max(min, -limit);
    max = Math.min(max, limit);
  }
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  const symmetric = { min: -magnitude, max: magnitude };
  return {
    min: symmetric.min,
    max: symmetric.max,
    unit: 'hartree',
    kcal: { min: symmetric.min * HARTREE_TO_KCAL, max: symmetric.max * HARTREE_TO_KCAL },
    scaled: Number.isFinite(limit) && limit > 0 ? 'clipped' : subject,
    scaledTo: !(Number.isFinite(limit) && limit > 0)
      ? `the ${subject}'s own extremes, symmetric about zero`
      : `the ${subject}'s extremes clipped to ±${limit} hartree`,
    dataMin: min,
    dataMax: max,
  };
}

/* ── the potential on an orbital's own grid, and on its surface ──── */

/**
 * A parsed cube's grid as a `gridFor`-shaped grid, or `null` when the axes are
 * not the axis-aligned, equally spaced grid a scalar field is sampled on.
 *
 * The potential is put on *this* grid on purpose: the orbital cube and the ESP
 * then describe the same points, so a picture that superimposes them is not
 * comparing two grids.
 */
export function gridOfCube(cube) {
  if (!cube || !Array.isArray(cube.dims) || !Array.isArray(cube.axes)) return null;
  const axes = cube.axes.map((axis) => axis.map(Number));
  const steps = axes.map((axis) => Math.hypot(axis[0], axis[1], axis[2]));
  if (!steps.every((step) => Number.isFinite(step) && step > 0)) return null;
  const aligned = axes.every((axis, index) => (
    Math.abs(axis[index] - steps[index]) < 1e-9 * steps[index]
    && axis.every((component, at) => at === index || Math.abs(component) < 1e-9 * steps[index])
  ));
  if (!aligned) return null;
  const spread = Math.max(...steps) - Math.min(...steps);
  if (spread > 1e-6 * Math.max(...steps)) return null;
  return {
    counts: cube.dims.map(Number),
    origin: cube.origin.map(Number),
    step: steps[0],
    axes: axes.map((axis, index) => axis.map((value, at) => (at === index ? steps[index] : 0))),
  };
}

/** Trilinear value of a field on its own grid, `null` outside it. */
export function fieldValueAt(field, point) {
  if (!field || !Array.isArray(field.dims)) return null;
  const [nx, ny, nz] = field.dims;
  const fractions = [0, 1, 2].map((axis) => (
    ((point[axis] - field.origin[axis]) / (field.axes?.[axis]?.[axis] ?? field.step ?? 1))
  ));
  const sizes = [nx, ny, nz];
  if (fractions.some((value, axis) => value < -1e-9 || value > sizes[axis] - 1 + 1e-9)) return null;
  const base = fractions.map((value, axis) => Math.max(0, Math.min(sizes[axis] - 1, Math.floor(value))));
  const upper = fractions.map((value, axis) => Math.max(0, Math.min(sizes[axis] - 1, Math.ceil(value))));
  const weight = [0, 1, 2].map((axis) => fractions[axis] - base[axis]);
  let total = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const i = corner & 1 ? upper[0] : base[0];
    const j = corner & 2 ? upper[1] : base[1];
    const k = corner & 4 ? upper[2] : base[2];
    const w = (corner & 1 ? weight[0] : 1 - weight[0])
      * (corner & 2 ? weight[1] : 1 - weight[1])
      * (corner & 4 ? weight[2] : 1 - weight[2]);
    total += w * field.values[i + nx * (j + ny * k)];
  }
  return total;
}

/**
 * The electrostatic potential for colouring an orbital's isosurface.
 *
 * The potential is computed on the cube's own grid (the same points the orbital
 * was drawn on) and interpolated to each triangle's centroid, in the order the
 * meshes were given. `range` is the range of the values that were actually
 * drawn — the surface's own extremes, symmetric about zero — which is what the
 * legend prints; `grid` is the grid the field was computed on, which is what the
 * numbers row prints.
 *
 * Returns `{ok: false, reason}` when the checkpoint has no density block: there
 * is no grey stand-in for an unknown field.
 */
export function espForSurface({ fchk, cube, meshes } = {}) {
  const density = densityMatrix(fchk);
  if (!density.ok) return density;
  const grid = gridOfCube(cube);
  if (!grid) {
    return {
      ok: false,
      reason: 'the cube grid is not axis-aligned and equally spaced, so the potential cannot be sampled on it',
    };
  }
  const field = potentialOnGrid({ fchk, grid });
  if (!field.ok) return field;
  const values = [];
  for (const mesh of Array.isArray(meshes) ? meshes : []) {
    const count = Math.floor((mesh?.positions?.length ?? 0) / 9);
    for (let triangle = 0; triangle < count; triangle += 1) {
      const centroid = [0, 1, 2].map((axis) => (
        (mesh.positions[triangle * 9 + axis]
          + mesh.positions[triangle * 9 + 3 + axis]
          + mesh.positions[triangle * 9 + 6 + axis]) / 3
      ));
      const value = fieldValueAt(field, centroid);
      values.push(value === null ? NaN : value);
    }
  }
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { ok: false, reason: 'no triangle centroid fell inside the cube grid' };
  return {
    ok: true,
    values: Float64Array.from(values),
    range: potentialRange(finite, { subject: 'surface' }),
    grid: field.grid,
    field,
    method: ESP_METHOD,
    provenance: field.provenance,
  };
}

/**
 * The rows a card prints for the potential, or the exact words for a file that
 * has no density — never a silent blank and never a zero.
 *
 * `sampledAt` is where the numbers were evaluated (a grid note, or the surface
 * centroids): the range is meaningless without it, so it has no default that
 * could be wrong.
 */
export function espCardRows({ fchk = null, esp = null, sampledAt = null } = {}) {
  const density = densityMatrix(fchk);
  if (!density.ok) return [['ESP', 'no density in this file']];
  if (!esp || !esp.ok) {
    return [['ESP colour range', esp?.reason || 'not computed yet']];
  }
  const { range } = esp;
  return [
    ['ESP colour range', `${range.kcal.min.toFixed(1)} … ${range.kcal.max.toFixed(1)} kcal/mol `
      + `(${range.min.toFixed(4)} … ${range.max.toFixed(4)} Ha)`],
    ['ESP scale', range.scaledTo],
    ['ESP sampled', sampledAt || esp.grid?.note || '—'],
    ['ESP method', 'analytic basis sum (Hermite/Boys)'],
  ];
}
