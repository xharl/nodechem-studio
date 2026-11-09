/**
 * EPR properties from an unrestricted spin density (issue 168).
 *
 * ## What this module computes, and from what
 *
 * Everything here is read off the **alpha − beta density** a formatted
 * checkpoint carries in its `Spin SCF Density` block (Gaussian spells the same
 * block `Spin Density`):
 *
 *   D^s_μν = D^α_μν − D^β_μν,        ρ_s(r) = Σ_μν D^s_μν χ_μ(r) χ_ν(r)
 *
 * so a number from this module is a statement about *that* density at *that*
 * level of theory. Nothing is re-derived from the total density and nothing is
 * fitted to experiment.
 *
 * 1. **Spin populations.** Mulliken, P_A = Σ_{μ∈A} (D^s S)_μμ, and Löwdin,
 *    P_A = Σ_{μ∈A} (S^{1/2} D^s S^{1/2})_μμ, with S the AO overlap matrix. The
 *    overlap is built from the checkpoint's own basis through
 *    `esp.js`'s McMurchie–Davidson coefficients — the same expansion the
 *    electrostatic potential uses — so the populations and a potential from one
 *    file cannot disagree about what a basis function is. Both schemes sum to
 *    n_α − n_β (1 for a doublet); that is the internal check, and
 *    `test/epr.test.js` asserts it on a real doublet.
 *
 * 2. **Isotropic hyperfine coupling, Fermi contact.** For a nucleus A with spin
 *    I and nuclear g-factor g_N,
 *
 *      A_iso = (2 μ0 / 3) g_e μ_B g_N μ_N ρ_s(R_A) / h
 *
 *    in frequency (divided by h), and the same number in gauss through
 *    B = h ν / (g_e μ_B). Only the value of the spin density *at the nucleus*
 *    enters; χ_μ(R_A) is zero for a p, d or f function centred on A, so those
 *    shells drop out of the sum by arithmetic, not by a special case.
 *
 *    **This is a density-only estimate.** It omits core polarisation beyond
 *    what the method's own spin density carries (a UHF/UKS spin density has it
 *    at that level only, and it is the part of a Fermi-contact coupling that
 *    converges slowest), spin-orbit contributions to the coupling (which matter
 *    for heavy nuclei and which this module does not compute at all), and
 *    relativistic / finite-nuclear-size corrections. The card and the module say
 *    so; a number here is not a measured-quality coupling constant.
 *
 * 3. **g-tensor: refused by name.** Psi4 does not produce one and ORCA is not
 *    installed in this app, so `gTensorRefusal` returns a refusal that names the
 *    engine and the missing capability. There is no placeholder value, no
 *    "≈2.0023" and no empty cell.
 *
 * ## Constants (CODATA 2018, SI)
 *
 *   μ0    = 1.25663706212e-6 N A⁻²      (vacuum permeability, 4π×10⁻⁷ exact
 *                                        in the pre-2019 SI; the 2018 CODATA
 *                                        value differs in the 10th digit)
 *   g_e   = 2.00231930436256             (free-electron g-factor)
 *   μ_B   = 9.2740100783e-24 J T⁻¹       (Bohr magneton)
 *   μ_N   = 5.0507837461e-27 J T⁻¹       (nuclear magneton)
 *   h     = 6.62607015e-34 J s           (Planck constant, exact)
 *   a0    = 5.29177210903e-11 m          (Bohr radius)
 *
 * A spin density is reported in bohr⁻³, so ρ_s / a0³ is the SI density the
 * formula needs; that conversion is inside `MHZ_PER_BOHR3` and is the only place
 * the unit changes.
 *
 * ## What is deliberately not here
 *
 * No anisotropic (dipolar) hyperfine tensor — that needs the full spin-density
 * matrix in a local frame and a second-order treatment this app does not have.
 * No g-tensor (see above). No relaxation, no line widths, no simulated spectrum:
 * a stick pattern from these couplings is a separate, presentational step.
 */

import { BOHR_PER_ANGSTROM, basisFunctions, densityAtBohrPoints, hermiteCoefficients } from './esp.js';

/* ── physical constants, all SI (see the header) ──────────────────── */

export const MU0 = 1.25663706212e-6;
export const G_ELECTRON = 2.00231930436256;
export const MU_BOHR = 9.2740100783e-24;
export const MU_NUCLEAR = 5.0507837461e-27;
export const PLANCK = 6.62607015e-34;
export const BOHR_METRE = 5.29177210903e-11;

/**
 * MHz per unit spin density per unit g_N: (2μ0/3) g_e μ_B μ_N / (h a0³), with
 * the 10⁶ that turns Hz into MHz folded in. Measured consequence, quoted so a
 * reader can sanity-check it: ρ_s = 1/π bohr⁻³ with the proton's g_N gives
 * 1423 MHz, which is the hydrogen atom's Fermi-contact coupling.
 */
export const MHZ_PER_BOHR3_PER_G = ((2 * MU0 / 3) * G_ELECTRON * MU_BOHR * MU_NUCLEAR)
  / (PLANCK * BOHR_METRE ** 3) / 1e6;

/**
 * Gauss per MHz at the free-electron g-factor: B = h ν / (g_e μ_B), in tesla,
 * times 10⁴. 1 MHz = 0.3567 G, i.e. 2.802 MHz per gauss — the conversion EPR
 * spectroscopy is usually quoted in.
 */
export const GAUSS_PER_MHZ = (PLANCK * 1e6) / (G_ELECTRON * MU_BOHR) * 1e4;

/**
 * Nuclear data for the isotopes that carry a spin: mass number, nuclear spin I,
 * nuclear g-factor g_N = μ/(I μ_N), and whether it is the dominant natural
 * isotope. μ values are the standard tabulated nuclear moments.
 *
 * An element with no entry here is reported as *no table entry*, never as a
 * coupling of zero: a missing g-factor and a vanishing spin density are
 * different statements.
 */
export const NUCLEAR_ISOTOPES = Object.freeze({
  H: Object.freeze({ massNumber: 1, spin: 0.5, gN: 5.5856946893, natural: true }),
  He: Object.freeze({ massNumber: 3, spin: 0.5, gN: -4.2552506, natural: false }),
  Li: Object.freeze({ massNumber: 7, spin: 1.5, gN: 2.170951, natural: true }),
  B: Object.freeze({ massNumber: 11, spin: 1.5, gN: 1.79243, natural: true }),
  C: Object.freeze({ massNumber: 13, spin: 0.5, gN: 1.4048236, natural: false }),
  N: Object.freeze({ massNumber: 14, spin: 1, gN: 0.4037607, natural: true }),
  O: Object.freeze({ massNumber: 17, spin: 2.5, gN: -0.757516, natural: false }),
  F: Object.freeze({ massNumber: 19, spin: 0.5, gN: 5.257736, natural: true }),
  Na: Object.freeze({ massNumber: 23, spin: 1.5, gN: 1.478352, natural: true }),
  P: Object.freeze({ massNumber: 31, spin: 0.5, gN: 2.26320, natural: true }),
  S: Object.freeze({ massNumber: 33, spin: 1.5, gN: 0.429213, natural: false }),
  Cl: Object.freeze({ massNumber: 35, spin: 1.5, gN: 0.547916, natural: true }),
  Cu: Object.freeze({ massNumber: 63, spin: 1.5, gN: 1.4824, natural: true }),
  Mn: Object.freeze({ massNumber: 55, spin: 2.5, gN: 1.3813, natural: true }),
});

/** The one-sentence statement of what a hyperfine number here is. */
export const HYPERFINE_METHOD = 'Fermi contact, (2μ0/3) g_e μ_B g_N μ_N ρ_spin(R_nucleus) / h, '
  + 'from the SCF/DFT spin density at the nucleus — a density-only estimate';

/** The caveat a card prints verbatim under the hyperfine table. */
export const HYPERFINE_CAVEAT = 'Density-only estimate: the value is the spin density this '
  + 'calculation produced at the nucleus. It omits core polarisation beyond what that density '
  + 'already carries, spin-orbit contributions to the coupling, and relativistic or '
  + 'finite-nuclear-size corrections — it is not a measured-quality coupling constant.';

/**
 * The overlap/population sum is O(N²) in basis functions and the symmetric
 * orthogonalisation is O(N³), both with an explicit matrix in memory. 300
 * functions is a few hundred milliseconds here and covers every molecule this
 * app's grid and cube paths already handle; a larger basis is refused by name
 * rather than left to hang a results panel.
 */
export const MAX_POPULATION_BASIS = 300;

/** A doublet's populations must sum to 1; this is how close the test demands. */
export const SPIN_SUM_TOLERANCE = 1e-6;

export class EprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EprError';
  }
}

/* ── the spin density matrix ─────────────────────────────────────── */

/**
 * The alpha − beta density, as the file writes it: a lower triangle of
 * `NBasis(NBasis+1)/2` values, row by row, in the same layout and with the same
 * accessor as `esp.densityMatrix`.
 *
 * Returns `{ ok: false, reason, detail }` when the file carries no spin block —
 * the caller prints the reason. It never returns a matrix of zeros: a
 * closed-shell file legitimately has none, and an open-shell file that lost one
 * is a different (broken) case.
 */
export function spinDensityMatrix(fchk) {
  if (!fchk || typeof fchk !== 'object') {
    return { ok: false, reason: 'there is no parsed checkpoint' };
  }
  const dimension = fchk.numberOfBasisFunctions;
  if (!Number.isInteger(dimension) || dimension < 1) {
    return { ok: false, reason: 'the checkpoint does not state how many basis functions it has' };
  }
  if (!(fchk.spinScfDensity instanceof Float64Array) && !Array.isArray(fchk.spinScfDensity)) {
    return {
      ok: false,
      reason: 'no spin density in this file',
      detail: 'the checkpoint carries no "Spin SCF Density" (or "Spin Density") block, '
        + 'which is where an unrestricted alpha−beta density is written',
    };
  }
  const values = fchk.spinScfDensity;
  const expected = (dimension * (dimension + 1)) / 2;
  if (values.length !== expected) {
    return {
      ok: false,
      reason: 'the spin density block does not match the basis',
      detail: `"Spin SCF Density" holds ${values.length} values; ${dimension} basis functions need ${expected}.`,
    };
  }
  return {
    ok: true,
    dimension,
    values,
    source: 'Spin SCF Density',
    // i ≥ j, row by row — the same contract as the total density.
    element: (i, j) => {
      const row = i >= j ? i : j;
      const column = i >= j ? j : i;
      return values[(row * (row + 1)) / 2 + column];
    },
  };
}

/**
 * The number of unpaired electrons the file describes, or `null` when it says
 * nothing usable. Alpha−beta counts win; a multiplicity is the fallback.
 */
export function unpairedElectrons(fchk) {
  if (!fchk || typeof fchk !== 'object') return null;
  const alpha = fchk.numberOfAlphaElectrons;
  const beta = fchk.numberOfBetaElectrons;
  if (Number.isInteger(alpha) && Number.isInteger(beta) && alpha >= beta) return alpha - beta;
  if (Number.isInteger(fchk.multiplicity) && fchk.multiplicity >= 1) return fchk.multiplicity - 1;
  return null;
}

/* ── overlap matrix ─────────────────────────────────────────────── */

/**
 * S_μν over the checkpoint's basis, in the AO order the density matrix uses.
 *
 * ⟨χ_a|χ_b⟩ for two primitives is the same Hermite expansion the potential is
 * built from, evaluated at t = 0:
 *
 *   ⟨ab⟩ = (π/γ)^{3/2} exp(−αβ/γ |A−B|²) E_x0 E_y0 E_z0,   γ = α + β
 *
 * and a contracted function is exactly the sum over its primitives, so nothing
 * here is approximate beyond floating point. Returned as a flat, symmetric
 * `Float64Array(n²)`.
 */
export function overlapMatrix(basis) {
  const { functions, count } = basis;
  if (!Number.isInteger(count) || count < 1) throw new EprError('the basis has no functions to overlap.');
  if (count > MAX_POPULATION_BASIS) {
    throw new EprError(`a ${count}-function basis is beyond the ${MAX_POPULATION_BASIS}-function limit `
      + 'this population analysis builds an explicit overlap matrix for.');
  }
  const S = new Float64Array(count * count);
  for (let mu = 0; mu < count; mu += 1) {
    for (let nu = mu; nu < count; nu += 1) {
      let sum = 0;
      for (const a of functions[mu]) {
        for (const b of functions[nu]) {
          const gamma = a.alpha + b.alpha;
          const px = (a.alpha * a.cx + b.alpha * b.cx) / gamma;
          const py = (a.alpha * a.cy + b.alpha * b.cy) / gamma;
          const pz = (a.alpha * a.cz + b.alpha * b.cz) / gamma;
          const dx = a.cx - b.cx;
          const dy = a.cy - b.cy;
          const dz = a.cz - b.cz;
          const r2 = dx * dx + dy * dy + dz * dz;
          const exponent = -(a.alpha * b.alpha / gamma) * r2;
          if (exponent < -700) continue;
          const ex = hermiteCoefficients(a.i, b.i, a.cx, b.cx, px, gamma)[0];
          const ey = hermiteCoefficients(a.j, b.j, a.cy, b.cy, py, gamma)[0];
          const ez = hermiteCoefficients(a.k, b.k, a.cz, b.cz, pz, gamma)[0];
          sum += a.w * b.w * Math.exp(exponent) * ex * ey * ez * (Math.PI / gamma) ** 1.5;
        }
      }
      S[mu * count + nu] = sum;
      S[nu * count + mu] = sum;
    }
  }
  return S;
}

/* ── symmetric orthogonalisation (no dependency: Jacobi, cyclic) ──── */

/**
 * Eigen-decomposition of a real symmetric matrix by the cyclic Jacobi method.
 *
 * Chosen over a QR iteration because it is a dozen lines, has no pivoting
 * subtleties, and converges quadratically for the 20–200 function matrices this
 * module sees. Returns eigenvalues (ascending) and eigenvectors as columns.
 */
function jacobiEigen(matrix, n, { tolerance = 1e-10, sweeps = 30 } = {}) {
  const a = Float64Array.from(matrix);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) v[i * n + i] = 1;
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) off += a[i * n + j] ** 2;
    }
    if (off < tolerance) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < tolerance) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = 0.5 * (aqq - app) / apq;
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j]);
  return {
    values: Float64Array.from(order, (i) => a[i * n + i]),
    vectors: order.map((column) => Float64Array.from({ length: n }, (_, row) => v[row * n + column])),
  };
}

/**
 * S^{±1/2} for a symmetric positive-definite S, from its eigen-decomposition.
 *
 * A basis whose overlap has a non-positive eigenvalue is not a basis: the
 * refusal names the smallest eigenvalue rather than taking its square root.
 *
 * Exported (issue 173, route B) because the Löwdin partition of a transition
 * density is taken in exactly this transformed space; the CT analysis and the
 * spin populations must not disagree about what `S^{1/2}` means.
 */
export function symmetricPower(matrix, n, power) {
  const { values, vectors } = jacobiEigen(matrix, n);
  const out = new Float64Array(n * n);
  for (let index = 0; index < n; index += 1) {
    const lambda = values[index];
    if (lambda <= 0) {
      throw new EprError(`the overlap matrix has eigenvalue ${lambda.toExponential(3)}; `
        + 'a basis with non-positive overlap has no Löwdin populations.');
    }
    const scale = lambda ** power;
    const vector = vectors[index];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) out[i * n + j] += scale * vector[i] * vector[j];
    }
  }
  return out;
}

/* ── populations ────────────────────────────────────────────────── */

/**
 * Mulliken and Löwdin spin populations, per atom, from D^s.
 *
 * Mulliken is reported first because it is what Psi4 and Gaussian print and what
 * the literature on organic radicals usually quotes; Löwdin is carried beside it
 * because Mulliken populations depend on the basis-set balance of a molecule and
 * Löwdin's are less so. Both come from the same D^s and the same S, so the table
 * states which density it was built from once.
 */
export function spinPopulations({ fchk } = {}) {
  const density = spinDensityMatrix(fchk);
  if (!density.ok) return density;
  const basis = basisFunctions(fchk);
  if (basis.count !== density.dimension) {
    return {
      ok: false,
      reason: 'the basis and the spin density disagree',
      detail: `the basis describes ${basis.count} functions but the density block is ${density.dimension} wide.`,
    };
  }
  const n = density.dimension;
  const S = overlapMatrix(basis);
  const root = symmetricPower(S, n, 0.5);

  // Löwdin: W = S^{1/2} D^s S^{1/2}, then the diagonal of W in each atom's block.
  const D = new Float64Array(n * n);
  for (let mu = 0; mu < n; mu += 1) {
    for (let nu = 0; nu < n; nu += 1) D[mu * n + nu] = density.element(mu, nu);
  }
  const tmp = new Float64Array(n * n);
  for (let mu = 0; mu < n; mu += 1) {
    for (let nu = 0; nu < n; nu += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum += root[mu * n + k] * D[k * n + nu];
      tmp[mu * n + nu] = sum;
    }
  }

  const mulliken = new Float64Array(basis.atoms.length);
  const lowdin = new Float64Array(basis.atoms.length);
  let mullikenSum = 0;
  let lowdinSum = 0;
  for (let mu = 0; mu < n; mu += 1) {
    const atom = basis.atomOfFunction[mu];
    if (atom < 0) continue;
    let ds = 0;
    let w = 0;
    for (let nu = 0; nu < n; nu += 1) {
      ds += density.element(mu, nu) * S[nu * n + mu];
      w += tmp[mu * n + nu] * root[nu * n + mu];
    }
    mulliken[atom] += ds;
    lowdin[atom] += w;
    mullikenSum += ds;
    lowdinSum += w;
  }

  return {
    ok: true,
    dimension: n,
    source: density.source,
    scheme: 'Mulliken and Löwdin, from the unrestricted alpha−beta density',
    basisFunctions: basis.count,
    mullikenSum,
    lowdinSum,
    populations: basis.atoms.map((atom, index) => ({
      atom: index + 1,
      element: atom.element ?? null,
      atomicNumber: atom.atomicNumber,
      mulliken: mulliken[index],
      lowdin: lowdin[index],
    })),
  };
}

/* ── Fermi contact ──────────────────────────────────────────────── */

/** A_iso in MHz from a spin density in bohr⁻³ and a nuclear g-factor. */
export function fermiContactMhz(rhoBohr3, gN) {
  if (!Number.isFinite(rhoBohr3) || !Number.isFinite(gN)) return null;
  return MHZ_PER_BOHR3_PER_G * gN * rhoBohr3;
}

/** The same coupling in gauss: B = h ν / (g_e μ_B). */
export function mhzToGauss(mhz) {
  return Number.isFinite(mhz) ? mhz * GAUSS_PER_MHZ : null;
}

/**
 * The spin density at every nucleus and the Fermi-contact coupling it implies.
 *
 * ρ_s(R_A) is evaluated from D^s and the basis at the nuclear positions in bohr
 * (the same positions the potential's nuclear term uses). A nucleus with no
 * entry in `NUCLEAR_ISOTOPES` gets a row with `status: 'no nuclear data'` and no
 * numbers — never a zero coupling.
 */
export function hyperfineCouplings({ fchk, spin = null } = {}) {
  const density = spinDensityMatrix(fchk);
  if (!density.ok) return density;
  const basis = basisFunctions(fchk);
  if (basis.count !== density.dimension) {
    return { ok: false, reason: 'the basis and the spin density disagree' };
  }
  const points = basis.atoms.map((atom) => [atom.x, atom.y, atom.z]);
  const rho = densityAtBohrPoints({ density, basis, pointsBohr: points });
  const populations = spin && Array.isArray(spin.populations)
    ? new Map(spin.populations.map((row) => [row.atom, row]))
    : null;

  const couplings = basis.atoms.map((atom, index) => {
    const element = atom.element ?? null;
    const isotope = element ? NUCLEAR_ISOTOPES[element] ?? null : null;
    const row = {
      atom: index + 1,
      element,
      atomicNumber: atom.atomicNumber,
      rhoSpinBohr3: rho[index],
      population: populations ? populations.get(index + 1)?.mulliken ?? null : null,
    };
    if (!isotope) {
      return {
        ...row,
        status: 'no nuclear data',
        note: `this module carries no nuclear g-factor for ${element ?? `Z = ${atom.atomicNumber}`}, `
          + 'so no coupling is reported rather than a zero',
      };
    }
    const mhz = fermiContactMhz(rho[index], isotope.gN);
    return {
      ...row,
      status: 'reported',
      massNumber: isotope.massNumber,
      nuclearSpin: isotope.spin,
      gN: isotope.gN,
      naturalIsotope: isotope.natural,
      aIsoMhz: mhz,
      aIsoGauss: mhzToGauss(mhz),
    };
  });

  return {
    ok: true,
    unit: { frequency: 'MHz', field: 'gauss', density: 'bohr^-3' },
    method: HYPERFINE_METHOD,
    caveat: HYPERFINE_CAVEAT,
    constants: {
      mu0: MU0,
      gElectron: G_ELECTRON,
      muBohr: MU_BOHR,
      muNuclear: MU_NUCLEAR,
      planck: PLANCK,
      bohrMetre: BOHR_METRE,
      mhzPerBohr3PerGN: MHZ_PER_BOHR3_PER_G,
      gaussPerMhz: GAUSS_PER_MHZ,
    },
    couplings,
  };
}

/* ── the g-tensor: a refusal, by name ──────────────────────────── */

/**
 * The g-tensor this app cannot compute, stated as a refusal.
 *
 * Psi4's SCF/DFT/TD module set has no g-tensor (it needs a spin-orbit treatment
 * of the wavefunction — Psi4's `dx`/SOC paths are not wired into this builder),
 * and ORCA, which does compute one, is not installed beside it. A number here
 * would be invented, so the object says which engine was asked and what it
 * cannot do.
 */
export function gTensorRefusal({ engine = 'Psi4', detail = null } = {}) {
  return {
    status: 'refused',
    requested: 'g-tensor',
    engine,
    missingCapability: 'an EPR g-tensor (needs spin-orbit coupling in the wavefunction)',
    message: `${engine} does not produce a g-tensor: the app's ${engine} jobs have no spin-orbit `
      + 'coupling step, and ORCA — the engine that does compute one — is not installed. '
      + 'No value is reported.',
    ...(detail ? { detail: String(detail) } : {}),
  };
}

/* ── the section the record carries ────────────────────────────── */

/**
 * The `epr` block a canonical result carries (and therefore a `run.json`).
 *
 * Three states, and they are different on purpose:
 *
 *   `closed-shell`  the file/caller says there are no unpaired electrons; the
 *                   exact words "no unpaired electrons" are in `message`.
 *   `open-shell`    populations and couplings are present, computed from the
 *                   spin density named in `provenance.spinDensityBlock`.
 *   `unavailable`   the run is open-shell but no spin density reached this
 *                   module; `reason` says what is missing.
 *
 * `gTensor` is present in every state: the refusal is a statement about the
 * engine, not about this molecule.
 */
export function eprBlock({
  fchk = null,
  level = null,
  engine = 'Psi4',
  multiplicity = null,
  unavailableReason = null,
  gTensorDetail = null,
} = {}) {
  const gTensor = gTensorRefusal({ engine, detail: gTensorDetail });
  // The checkpoint states n_alpha and n_beta; a log only states a multiplicity.
  // Both are legitimate evidence for "how many unpaired electrons", and a
  // closed-shell answer must not depend on which one reached this module.
  const unpaired = unpairedElectrons(fchk)
    ?? (Number.isInteger(Number(multiplicity)) ? Number(multiplicity) - 1 : null);

  if (unpaired === 0) {
    return {
      status: 'closed-shell',
      message: 'no unpaired electrons',
      level: level ? String(level) : null,
      electrons: {
        alpha: Number.isInteger(fchk?.numberOfAlphaElectrons) ? fchk.numberOfAlphaElectrons : null,
        beta: Number.isInteger(fchk?.numberOfBetaElectrons) ? fchk.numberOfBetaElectrons : null,
        unpaired: 0,
      },
      populations: [],
      hyperfine: [],
      gTensor,
    };
  }

  if (fchk === null || fchk === undefined) {
    return {
      status: 'unavailable',
      reason: unavailableReason ?? 'no checkpoint (wavefunction file) accompanied this run, so there is no spin density '
        + 'to analyse',
      level: level ? String(level) : null,
      electrons: {
        alpha: Number.isInteger(fchk?.numberOfAlphaElectrons) ? fchk.numberOfAlphaElectrons : null,
        beta: Number.isInteger(fchk?.numberOfBetaElectrons) ? fchk.numberOfBetaElectrons : null,
        unpaired,
      },
      populations: [],
      hyperfine: [],
      gTensor,
    };
  }

  let populations;
  let hyperfine;
  try {
    populations = spinPopulations({ fchk });
    hyperfine = hyperfineCouplings({ fchk, spin: populations.ok ? populations : null });
  } catch (error) {
    return {
      status: 'unavailable',
      reason: String(error?.message ?? error),
      level: level ? String(level) : null,
      electrons: {
        alpha: Number.isInteger(fchk?.numberOfAlphaElectrons) ? fchk.numberOfAlphaElectrons : null,
        beta: Number.isInteger(fchk?.numberOfBetaElectrons) ? fchk.numberOfBetaElectrons : null,
        unpaired,
      },
      populations: [],
      hyperfine: [],
      gTensor,
    };
  }

  if (!populations.ok) {
    return {
      status: 'unavailable',
      reason: populations.reason,
      detail: populations.detail ?? null,
      level: level ? String(level) : null,
      electrons: {
        alpha: Number.isInteger(fchk.numberOfAlphaElectrons) ? fchk.numberOfAlphaElectrons : null,
        beta: Number.isInteger(fchk.numberOfBetaElectrons) ? fchk.numberOfBetaElectrons : null,
        unpaired,
      },
      populations: [],
      hyperfine: [],
      gTensor,
    };
  }

  return {
    status: 'open-shell',
    level: level ? String(level) : null,
    electrons: {
      alpha: Number.isInteger(fchk.numberOfAlphaElectrons) ? fchk.numberOfAlphaElectrons : null,
      beta: Number.isInteger(fchk.numberOfBetaElectrons) ? fchk.numberOfBetaElectrons : null,
      unpaired,
    },
    scheme: populations.scheme,
    populationSum: populations.mullikenSum,
    lowdinSum: populations.lowdinSum,
    populations: populations.populations,
    hyperfine: hyperfine.ok ? hyperfine.couplings : [],
    hyperfineMethod: hyperfine.ok ? hyperfine.method : null,
    hyperfineCaveat: hyperfine.ok ? hyperfine.caveat : null,
    units: { population: 'electrons (alpha − beta)', density: 'bohr^-3', frequency: 'MHz', field: 'gauss' },
    gTensor,
    provenance: {
      engine: String(engine),
      spinDensityBlock: populations.source,
      basisFunctions: populations.basisFunctions,
      constants: hyperfine.ok ? hyperfine.constants : null,
    },
  };
}

/* ── the field the cube/surface machinery can show ─────────────── */

/**
 * The spin density on a grid, shaped exactly like `esp.potentialOnGrid` returns:
 * `{kind, label, dims, origin, axes, step, values}` with values indexed
 * `i + nx*(j + ny*k)` (x fastest). That is the contract `parseCube` produces and
 * a cube writer or the surface mesher already consumes, so an α−β surface needs
 * no new renderer.
 *
 * Unlike the potential, this is a *pointwise* evaluation of ρ_s at each grid
 * point, not a quadrature: there is no integrable singularity here, so sampling
 * the density where it is asked for is exact, and the usual reason to prefer an
 * analytic sum (the 1/r kernel) does not apply. The field is signed, which is
 * what makes a two-lobe spin-density surface possible.
 */
export function spinDensityOnGrid({ fchk, grid } = {}) {
  const density = spinDensityMatrix(fchk);
  if (!density.ok) return density;
  if (!grid || !Array.isArray(grid.counts) || grid.counts.length !== 3) {
    throw new EprError('a grid needs three counts (see volume.gridFor).');
  }
  const [nx, ny, nz] = grid.counts.map(Number);
  const step = Number(grid.step);
  if (![nx, ny, nz].every((count) => Number.isInteger(count) && count > 0)) {
    throw new EprError('the grid counts must be positive integers.');
  }
  if (!Number.isFinite(step) || step <= 0) throw new EprError('the grid needs a positive step in Å.');
  if (!Array.isArray(grid.origin) || grid.origin.length !== 3 || !grid.origin.every(Number.isFinite)) {
    throw new EprError('the grid needs a three-number origin in Å.');
  }
  const basis = basisFunctions(fchk);
  if (basis.count !== density.dimension) return { ok: false, reason: 'the basis and the spin density disagree' };

  const total = nx * ny * nz;
  const points = new Array(total);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        points[i + nx * (j + ny * k)] = [
          (grid.origin[0] + i * step) * BOHR_PER_ANGSTROM,
          (grid.origin[1] + j * step) * BOHR_PER_ANGSTROM,
          (grid.origin[2] + k * step) * BOHR_PER_ANGSTROM,
        ];
      }
    }
  }
  const values = densityAtBohrPoints({ density, basis, pointsBohr: points });
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    ok: true,
    kind: 'spin-density',
    label: 'spin density (alpha − beta)',
    signed: true,
    unit: 'e/bohr^3',
    values,
    dims: [nx, ny, nz],
    origin: [...grid.origin],
    axes: [[step, 0, 0], [0, step, 0], [0, 0, step]],
    step,
    points: total,
    stats: { min, max },
    densityBlock: density.source,
    grid: {
      counts: [nx, ny, nz],
      origin: [...grid.origin],
      step,
      points: total,
      note: `${nx}×${ny}×${nz} = ${total} points at ${step.toFixed(3)} Å`,
    },
  };
}

/* ── the rows a report or a console prints ─────────────────────── */

/**
 * Plain-text rows for the EPR section, in the same `[label, value]` shape the
 * other card-row builders use. The HTML card renders the two tables; these rows
 * carry the statements that must survive as text (the state, the scheme, the
 * refusal) — including the exact words "no unpaired electrons".
 */
export function eprCardRows(epr) {
  if (!epr || typeof epr !== 'object') return [['EPR', 'not computed']];
  const rows = [['EPR state', epr.status === 'closed-shell'
    ? 'no unpaired electrons'
    : epr.status === 'open-shell'
      ? `open shell (${epr.electrons?.unpaired ?? '?'} unpaired electron${epr.electrons?.unpaired === 1 ? '' : 's'})`
      : `not available: ${epr.reason ?? 'unknown reason'}`]];
  if (epr.status === 'open-shell') {
    rows.push(['Spin populations', epr.scheme ?? 'not stated']);
    rows.push(['Population sum', `${Number(epr.populationSum).toFixed(6)} electrons (n_alpha − n_beta)`]);
    rows.push(['Hyperfine', epr.hyperfineMethod ?? 'not computed']);
    const reported = (epr.hyperfine ?? []).filter((row) => row.status === 'reported');
    rows.push(['Hyperfine nuclei', `${reported.length} of ${(epr.hyperfine ?? []).length}`]);
  }
  rows.push(['g-tensor', epr.gTensor?.message ?? 'not requested']);
  return rows;
}
