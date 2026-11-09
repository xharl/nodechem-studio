/**
 * QTAIM: bond critical points and bond paths from the checkpoint's density
 * matrix (issue 59, analysis half — the ingest and the orbital surfaces already
 * shipped).
 *
 * ## What this computes, and from what
 *
 * The electron density is the one the file's own density matrix and basis
 * define,
 *
 *   ρ(r) = Σ_μν D_μν χ_μ(r) χ_ν(r),
 *
 * with D the lower triangle of `Total SCF Density` (read by `fchk.js`, indexed
 * by `esp.js`'s `densityMatrix`) and χ the Cartesian Gaussians compiled by
 * `volume.js` through `esp.js`'s `basisFunctions`. The first and second
 * derivatives are taken **analytically**, term by term, from the same primitive
 * monomials — nothing here is differenced on a grid. A basis function is
 *
 *   χ_μ = Σ_t w_t · exp(−α_t |r−C_t|²) · (x−c_x)^i (y−c_y)^j (z−c_z)^k
 *
 * so every derivative is a product rule on one Gaussian factor and one
 * monomial; `densityPropertiesAt` accumulates those into ρ, ∇ρ and the 3×3
 * Hessian in one pass.
 *
 * ## The critical point
 *
 * A bond critical point (BCP) is a (3,−1) critical point: ∇ρ = 0 and the
 * Hessian has exactly one negative eigenvalue (along the bond) and two
 * positive ones (across it). The search is a **Levenberg–Marquardt** iteration
 * on ½|∇ρ|², started at the midpoint of each candidate bond:
 *
 *   (H² + µI) Δp = −H ∇ρ,   p ← p + Δp,
 *
 * where H is the analytic Hessian of ρ. Squaring it makes the system positive
 * semi-definite whatever the signature of H, so the step is always a descent
 * direction for |∇ρ|² and a (3,−1) point is reachable from an indefinite
 * starting Hessian. µ starts at 0 and is raised ×10 when a step fails, the step
 * is capped at 0.4 bohr, and a backtracking line search keeps it only if |∇ρ|
 * falls. Convergence is stated in the result: `GRADIENT_TOLERANCE` (1e-8
 * e/bohr⁴ on |∇ρ|) and `STEP_TOLERANCE` (1e-9 bohr), 200 iterations.
 *
 * **Failure is reported, never patched.** A search that does not converge, that
 * leaves the bond's own neighbourhood, or that lands on a point whose Hessian
 * signature is not (3,−1) is returned as `{found: false, reason}`. No point, no
 * ρ, no Laplacian is invented for it: the table prints the bond with its
 * reason. A candidate bond an element has no covalent radius for is also
 * reported, as not searched.
 *
 * ## Properties at the BCP
 *
 *   - ρ(r_bcp) in e/bohr³ — the density at the critical point;
 *   - ∇²ρ = λ₁+λ₂+λ₃ in e/bohr⁵ — the Laplacian, from the analytic Hessian;
 *   - ellipticity ε = λ₁/λ₂ − 1, with λ₁ ≤ λ₂ < 0 < λ₃ — the anisotropy of the
 *     density across the bond (0 for a cylindrically symmetric bond);
 *   - the bond path length — the two steepest-ascent trajectories of ρ from the
 *     BCP to each of the two nuclei, integrated with RK4 at `BOND_PATH_STEP`
 *     (0.01 bohr) on dr/ds = ∇ρ/|∇ρ| and summed. The path starts 0.02 bohr off
 *     the BCP along the λ₃ eigenvector (where ∇ρ is non-zero) and the 2×0.02
 *     bohr is added back, which is the only approximation in the length and is
 *     stated here and in `bondPath.note`. If a branch does not reach its
 *     nucleus within `BOND_PATH_MAX_STEPS` the length is *not* reported as a
 *     number: `complete: false` and the distance at which it stopped.
 *
 * ## Classification, and the thresholds used
 *
 * The two standard QTAIM criteria are used as written, with the thresholds
 * stated so a reader can disagree with them explicitly:
 *
 *   | ∇²ρ at the BCP | ρ at the BCP | class |
 *   | --- | --- | --- |
 *   | < 0 | ≥ 0.10 e/bohr³ | shared-shell (covalent) |
 *   | > 0 | < 0.10 e/bohr³ | closed-shell (ionic, van der Waals, H-bond) |
 *   | otherwise | | intermediate — ρ and ∇²ρ disagree |
 *
 * The Laplacian sign is Bader's shared/closed-shell criterion (Bader, *Atoms in
 * Molecules: A Quantum Theory*, Clarendon, 1990, ch. 7); the 0.10 e/bohr³
 * density cut is the one used for the closed-shell band in the hydrogen-bond
 * QTAIM literature (Koch & Popelier, *J. Phys. Chem.* 1995, 99, 9747). Both are
 * printed with every result (`criteria`), so a table cannot be read without
 * them.
 */

import { BOHR_TO_ANGSTROM } from './cubeFile.js';
import { BOHR_PER_ANGSTROM, basisFunctions, densityMatrix } from './esp.js';

/** The one-sentence method statement a card, a caption and the guide repeat. */
export const QTAIM_METHOD = 'analytic density from the checkpoint density matrix and basis '
  + '(ρ, ∇ρ and the Hessian differentiated term by term, no grid differencing); '
  + 'BCP by damped Newton on ∇ρ, eigenvalues from a Jacobi decomposition of the analytic Hessian';

/** |∇ρ| at convergence, e/bohr⁴. */
export const GRADIENT_TOLERANCE = 1e-8;

/** |step| at convergence, bohr. */
export const STEP_TOLERANCE = 1e-9;

/** Newton iterations before the search is called failed. */
export const MAX_ITERATIONS = 200;

/** RK4 step along the bond path, bohr. */
export const BOND_PATH_STEP = 0.01;

/** Steps per branch before a path is called incomplete. */
export const BOND_PATH_MAX_STEPS = 1200;

/** Offset from the BCP at which a bond-path branch starts, bohr. */
export const BOND_PATH_OFFSET = 0.02;

/** A candidate bond is a pair closer than this factor times the radii sum. */
export const BOND_FACTOR = 1.3;

/** Density threshold separating shared- from closed-shell, e/bohr³. */
export const SHARED_SHELL_RHO = 0.1;

/**
 * Covalent radii, Å — Cordero et al., *Dalton Trans.* 2008, 2832–2838, the
 * single-bond values. An element outside this table is reported as having no
 * radius rather than guessed at.
 */
export const COVALENT_RADII = Object.freeze({
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66,
  F: 0.57, Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05,
  Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39,
  Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22,
  Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16, Rb: 2.20, Sr: 1.95,
  Y: 1.90, Zr: 1.75, Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42,
  Pd: 1.39, Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38,
  I: 1.39, Xe: 1.40, Cs: 2.44, Ba: 2.15,
});

const ELEMENTS = Object.freeze([
  '', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al',
  'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe',
  'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
]);

export const QTAIM_CRITERIA = Object.freeze({
  sharedShell: 'shared-shell (covalent): ∇²ρ < 0 and ρ ≥ 0.10 e/bohr³',
  closedShell: 'closed-shell (ionic, van der Waals, hydrogen bond): ∇²ρ > 0 and ρ < 0.10 e/bohr³',
  intermediate: 'intermediate: ρ and ∇²ρ disagree about the interaction type',
  source: 'Laplacian sign from Bader, Atoms in Molecules (1990), ch. 7; the 0.10 e/bohr³ band '
    + 'from Koch & Popelier, J. Phys. Chem. 1995, 99, 9747',
});

export class QtaimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QtaimError';
  }
}

export function elementSymbol(atomicNumber) {
  const number = Number(atomicNumber);
  return Number.isInteger(number) && number > 0 && number < ELEMENTS.length ? ELEMENTS[number] : `Z${number}`;
}

/* ── basis compilation and analytic derivatives ───────────────────── */

/** The atoms of a checkpoint in bohr, in file order. */
function atomsInBohr(fchk) {
  const atoms = Array.isArray(fchk?.atoms) ? fchk.atoms : [];
  return atoms.map((atom, index) => {
    const x = Number(atom?.x);
    const y = Number(atom?.y);
    const z = Number(atom?.z);
    if (![x, y, z].every(Number.isFinite)) {
      throw new QtaimError(`atom ${index + 1} has no finite Cartesian position in the checkpoint.`);
    }
    return {
      atomicNumber: Number.isInteger(atom?.atomicNumber) ? atom.atomicNumber : 0,
      symbol: elementSymbol(atom?.atomicNumber),
      x: x * BOHR_PER_ANGSTROM,
      y: y * BOHR_PER_ANGSTROM,
      z: z * BOHR_PER_ANGSTROM,
      xAngstrom: x,
      yAngstrom: y,
      zAngstrom: z,
    };
  });
}

/**
 * The square density matrix and the primitive terms per basis function, in
 * bohr — the one structure every evaluation below walks.
 */
export function compileDensity(fchk) {
  const density = densityMatrix(fchk);
  if (!density.ok) return density;
  let basis;
  try {
    basis = basisFunctions(fchk);
  } catch (error) {
    return { ok: false, reason: 'the checkpoint carries no basis this reader can compile', detail: String(error?.message ?? error) };
  }
  const { functions, count } = basis;
  // Materialised square form: the evaluator touches every (μ,ν) at every point,
  // so the triangular index arithmetic would be the hot path.
  const matrix = new Float64Array(count * count);
  for (let mu = 0; mu < count; mu += 1) {
    for (let nu = 0; nu < count; nu += 1) matrix[mu * count + nu] = density.element(mu, nu);
  }
  // Flat primitive list per function, so the inner loop has no property lookup.
  const terms = functions.map((list) => {
    const flat = new Float64Array(list.length * 8);
    list.forEach((term, at) => {
      flat[at * 8] = term.alpha;
      flat[at * 8 + 1] = term.cx;
      flat[at * 8 + 2] = term.cy;
      flat[at * 8 + 3] = term.cz;
      flat[at * 8 + 4] = term.i;
      flat[at * 8 + 5] = term.j;
      flat[at * 8 + 6] = term.k;
      flat[at * 8 + 7] = term.w;
    });
    return flat;
  });
  let primitiveCount = 0;
  for (const list of functions) primitiveCount += list.length;
  return {
    ok: true,
    count,
    matrix,
    terms,
    primitiveCount,
    densityBlock: density.source,
    atoms: atomsInBohr(fchk),
  };
}

/**
 * ρ, ∇ρ and the Hessian of ρ at one point **in bohr**.
 *
 * `values`, `gradient` and `hessian` are filled into the supplied buffers when
 * given (the grid walks a million points with three allocations, not a million).
 * The Hessian is returned row-major: h[0]=∂²/∂x², h[1]=∂²/∂x∂y, h[2]=∂²/∂x∂z,
 * h[3]=∂²/∂y∂x (equal to h[1]), h[4]=∂²/∂y², h[5]=∂²/∂y∂z, h[6..8] likewise.
 */
export function densityPropertiesAtBohr(compiled, x, y, z, buffers = null) {
  const n = compiled.count;
  const scratch = buffers || {
    value: new Float64Array(n),
    gx: new Float64Array(n),
    gy: new Float64Array(n),
    gz: new Float64Array(n),
    hxx: new Float64Array(n),
    hxy: new Float64Array(n),
    hxz: new Float64Array(n),
    hyy: new Float64Array(n),
    hyz: new Float64Array(n),
    hzz: new Float64Array(n),
    t: new Float64Array(n),
    ux: new Float64Array(n),
    uy: new Float64Array(n),
    uz: new Float64Array(n),
  };
  const {
    value, gx, gy, gz, hxx, hxy, hxz, hyy, hyz, hzz, t, ux, uy, uz,
  } = scratch;

  for (let mu = 0; mu < n; mu += 1) {
    const flat = compiled.terms[mu];
    let v = 0;
    let dxv = 0;
    let dyv = 0;
    let dzv = 0;
    let dxxv = 0;
    let dxyv = 0;
    let dxzv = 0;
    let dyyv = 0;
    let dyzv = 0;
    let dzzv = 0;
    for (let at = 0; at < flat.length; at += 8) {
      const alpha = flat[at];
      const px = x - flat[at + 1];
      const py = y - flat[at + 2];
      const pz = z - flat[at + 3];
      const i = flat[at + 4];
      const j = flat[at + 5];
      const k = flat[at + 6];
      const w = flat[at + 7];
      const r2 = px * px + py * py + pz * pz;
      const e = Math.exp(-alpha * r2);
      const g = w * e;
      // Gaussian factor and its derivatives.
      const gx1 = -2 * alpha * px * g;
      const gy1 = -2 * alpha * py * g;
      const gz1 = -2 * alpha * pz * g;
      const gxx1 = (4 * alpha * alpha * px * px - 2 * alpha) * g;
      const gyy1 = (4 * alpha * alpha * py * py - 2 * alpha) * g;
      const gzz1 = (4 * alpha * alpha * pz * pz - 2 * alpha) * g;
      const gxy1 = 4 * alpha * alpha * px * py * g;
      const gxz1 = 4 * alpha * alpha * px * pz * g;
      const gyz1 = 4 * alpha * alpha * py * pz * g;
      // Monomial factor and its derivatives: p^order, and 0 below the power.
      const mx = px ** i;
      const my = py ** j;
      const mz = pz ** k;
      const mx1 = i === 0 ? 0 : i * px ** (i - 1);
      const my1 = j === 0 ? 0 : j * py ** (j - 1);
      const mz1 = k === 0 ? 0 : k * pz ** (k - 1);
      const mx2 = i < 2 ? 0 : i * (i - 1) * px ** (i - 2);
      const my2 = j < 2 ? 0 : j * (j - 1) * py ** (j - 2);
      const mz2 = k < 2 ? 0 : k * (k - 1) * pz ** (k - 2);
      const m = mx * my * mz;
      const mxv = mx1 * my * mz;
      const myv = mx * my1 * mz;
      const mzv = mx * my * mz1;
      const mxxv = mx2 * my * mz;
      const myyv = mx * my2 * mz;
      const mzzv = mx * my * mz2;
      const mxyv = mx1 * my1 * mz;
      const mxzv = mx1 * my * mz1;
      const myzv = mx * my1 * mz1;

      v += g * m;
      dxv += gx1 * m + g * mxv;
      dyv += gy1 * m + g * myv;
      dzv += gz1 * m + g * mzv;
      dxxv += gxx1 * m + 2 * gx1 * mxv + g * mxxv;
      dyyv += gyy1 * m + 2 * gy1 * myv + g * myyv;
      dzzv += gzz1 * m + 2 * gz1 * mzv + g * mzzv;
      dxyv += gxy1 * m + gx1 * myv + gy1 * mxv + g * mxyv;
      dxzv += gxz1 * m + gx1 * mzv + gz1 * mxv + g * mxzv;
      dyzv += gyz1 * m + gy1 * mzv + gz1 * myv + g * myzv;
    }
    value[mu] = v;
    gx[mu] = dxv;
    gy[mu] = dyv;
    gz[mu] = dzv;
    hxx[mu] = dxxv;
    hxy[mu] = dxyv;
    hxz[mu] = dxzv;
    hyy[mu] = dyyv;
    hyz[mu] = dyzv;
    hzz[mu] = dzzv;
  }

  const D = compiled.matrix;
  // t = D·χ, then u^b = D·(∂χ/∂b) — two matrix-vector products per point.
  for (let mu = 0; mu < n; mu += 1) {
    let tv = 0;
    let uxv = 0;
    let uyv = 0;
    let uzv = 0;
    const row = mu * n;
    for (let nu = 0; nu < n; nu += 1) {
      const d = D[row + nu];
      if (d === 0) continue;
      tv += d * value[nu];
      uxv += d * gx[nu];
      uyv += d * gy[nu];
      uzv += d * gz[nu];
    }
    t[mu] = tv;
    ux[mu] = uxv;
    uy[mu] = uyv;
    uz[mu] = uzv;
  }

  let rho = 0;
  let gradX = 0;
  let gradY = 0;
  let gradZ = 0;
  const hessian = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let mu = 0; mu < n; mu += 1) {
    const chi = value[mu];
    const cgx = gx[mu];
    const cgy = gy[mu];
    const cgz = gz[mu];
    rho += chi * t[mu];
    // ∇ρ = 2 Σ_μ (∂χ_μ) · (D χ)_μ, and likewise for the second derivatives;
    // the factor 2 is the symmetry of D, not an approximation.
    gradX += cgx * t[mu];
    gradY += cgy * t[mu];
    gradZ += cgz * t[mu];
    hessian[0] += hxx[mu] * t[mu] + cgx * ux[mu];
    hessian[1] += hxy[mu] * t[mu] + cgx * uy[mu];
    hessian[2] += hxz[mu] * t[mu] + cgx * uz[mu];
    hessian[4] += hyy[mu] * t[mu] + cgy * uy[mu];
    hessian[5] += hyz[mu] * t[mu] + cgy * uz[mu];
    hessian[8] += hzz[mu] * t[mu] + cgz * uz[mu];
  }
  hessian[3] = hessian[1];
  hessian[6] = hessian[2];
  hessian[7] = hessian[5];
  // The accumulated Hessian is Σ_μ (χ''_μ t_μ + χ'_μ u_μ); the symmetry of D
  // doubles each term, exactly as for the gradient above.
  for (let at = 0; at < 9; at += 1) hessian[at] *= 2;
  return {
    rho,
    gradient: [2 * gradX, 2 * gradY, 2 * gradZ],
    hessian,
  };
}

/* ── symmetric 3×3 eigenproblem ───────────────────────────────────── */

/**
 * Eigenvalues (ascending) and eigenvectors (columns) of a symmetric 3×3 matrix,
 * by cyclic Jacobi rotations. No library: 3×3 closed forms lose precision on
 * the near-degenerate cases a critical point produces, while Jacobi is stable
 * and converges quadratically here.
 */
export function symmetricEigen(matrix) {
  const a = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[3], matrix[4], matrix[5]],
    [matrix[6], matrix[7], matrix[8]],
  ];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const pairs = [[0, 1], [0, 2], [1, 2]];
  for (let sweep = 0; sweep < 60; sweep += 1) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of pairs) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const sign = theta >= 0 ? 1 : -1;
      const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const app = a[p][p];
      const aqq = a[q][q];
      a[p][p] = app - t * apq;
      a[q][q] = aqq + t * apq;
      a[p][q] = 0;
      a[q][p] = 0;
      for (let k = 0; k < 3; k += 1) {
        if (k === p || k === q) continue;
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[p][k] = a[k][p];
        a[k][q] = s * akp + c * akq;
        a[q][k] = a[k][q];
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((left, right) => a[left][left] - a[right][right]);
  return {
    values: order.map((index) => a[index][index]),
    vectors: order.map((index) => [v[0][index], v[1][index], v[2][index]]),
  };
}

/** A·x for a 3×3 row-major matrix and a 3-vector. */
function multiply(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ];
}

function norm3([x, y, z]) {
  return Math.hypot(x, y, z);
}

/**
 * Solve (A) step = −rhs by Cramer's rule on the 3×3 system. A is symmetric
 * positive definite in every call (H² + µI), so the determinant cannot vanish
 * except for µ = 0 on a singular H — which is checked and reported, not
 * propagated as an infinity into a "critical point".
 */
function solve3(m, rhs) {
  const det = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const determinant = det(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const [rx, ry, rz] = rhs;
  const dx = det(rx, m[1], m[2], ry, m[4], m[5], rz, m[7], m[8]) / determinant;
  const dy = det(m[0], rx, m[2], m[3], ry, m[5], m[6], rz, m[8]) / determinant;
  const dz = det(m[0], m[1], rx, m[3], m[4], ry, m[6], m[7], rz) / determinant;
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  return [dx, dy, dz];
}

/** H² for a symmetric 3×3 row-major matrix. */
function square3(m) {
  const out = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += m[row * 3 + k] * m[k * 3 + column];
      out[row * 3 + column] = sum;
    }
  }
  return out;
}

/* ── bond candidates ──────────────────────────────────────────────── */

/**
 * The pairs that get a BCP search: every atom pair closer than
 * `BOND_FACTOR` × (r_cov(A) + r_cov(B)) with the Cordero radii. An element with
 * no tabulated radius makes every pair it belongs to "not searched", by name —
 * guessing a radius would decide the bond list, and the bond list decides which
 * BCPs exist.
 */
export function candidateBonds(atoms) {
  const bonds = [];
  for (let a = 0; a < atoms.length; a += 1) {
    for (let b = a + 1; b < atoms.length; b += 1) {
      const first = atoms[a];
      const second = atoms[b];
      const distance = Math.hypot(
        positionOf(first, 'x') - positionOf(second, 'x'),
        positionOf(first, 'y') - positionOf(second, 'y'),
        positionOf(first, 'z') - positionOf(second, 'z'),
      );
      const r1 = COVALENT_RADII[first.symbol];
      const r2 = COVALENT_RADII[second.symbol];
      if (!Number.isFinite(r1) || !Number.isFinite(r2)) {
        bonds.push({
          atoms: [a, b],
          labels: [labelOf(first, a), labelOf(second, b)],
          distance,
          considered: false,
          reason: `no covalent radius for ${!Number.isFinite(r1) ? first.symbol : second.symbol}`,
        });
        continue;
      }
      if (distance > BOND_FACTOR * (r1 + r2)) continue;
      bonds.push({
        atoms: [a, b],
        labels: [labelOf(first, a), labelOf(second, b)],
        distance,
        considered: true,
      });
    }
  }
  return bonds;
}

function labelOf(atom, index) {
  return `${atom.symbol || `Z${atom.atomicNumber}`}${index + 1}`;
}

/**
 * A Cartesian coordinate in Å, from either the checkpoint-compiled atom
 * (`xAngstrom`, …) or a plain `{x, y, z}` — the two shapes a caller can hand
 * `candidateBonds`. Without this the second shape gives NaN distances and every
 * pair "passes" the radius test, which is how a test caught it.
 */
function positionOf(atom, axis) {
  const value = Number(atom?.[`${axis}Angstrom`] ?? atom?.[axis]);
  if (!Number.isFinite(value)) {
    throw new QtaimError(`an atom has no finite ${axis} in Å, so the bond list cannot be built.`);
  }
  return value;
}

/* ── the BCP search ───────────────────────────────────────────────── */

/**
 * Newton search for ∇ρ = 0 from `start` (bohr), constrained to a trust region of
 * `radius` bohr around it. Returns the point, its properties, the achieved
 * |∇ρ|/step and the iteration count — or `{ok: false, reason, point, gradientNorm}`.
 * The point is returned even on failure, so a caller can say *where* it ended
 * up; its ρ is not used unless `ok`.
 */
export function criticalPointSearch(compiled, start, {
  tolerance = GRADIENT_TOLERANCE,
  stepTolerance = STEP_TOLERANCE,
  maxIterations = MAX_ITERATIONS,
  radius = 0.4,
  trust = 1.5,
} = {}) {
  let point = [...start];
  let properties = densityPropertiesAtBohr(compiled, point[0], point[1], point[2]);
  let gradientNorm = norm3(properties.gradient);
  let iterations = 0;
  let lastStep = 0;
  for (; iterations < maxIterations; iterations += 1) {
    if (gradientNorm < tolerance) break;
    // Levenberg–Marquardt on f = ½|∇ρ|²: the Gauss–Newton normal equations are
    // (H² + µI) Δ = −H∇ρ, with H the Hessian of ρ. H² is positive semi-definite
    // whatever the signature of H at the point, so the direction is always a
    // descent direction for |∇ρ|² and a (3,−1) BCP is reachable from an
    // indefinite starting Hessian — which the plain Newton step is not.
    const hessianSquared = square3(properties.hessian);
    const hg = multiply(properties.hessian, properties.gradient);
    let mu = 0;
    let accepted = false;
    let trialPoint = point;
    let trialProperties = properties;
    let trialNorm = gradientNorm;
    for (let attempt = 0; attempt < 14 && !accepted; attempt += 1) {
      const system = hessianSquared.slice();
      system[0] += mu;
      system[4] += mu;
      system[8] += mu;
      const raw = solve3(system, [-hg[0], -hg[1], -hg[2]]);
      if (!raw) {
        mu = mu === 0 ? 1e-8 : mu * 10;
        continue;
      }
      let length = norm3(raw);
      let step = raw;
      if (length > radius) {
        const scale = radius / length;
        step = raw.map((component) => component * scale);
        length = radius;
      }
      let scale = 1;
      for (let backtrack = 0; backtrack < 30; backtrack += 1) {
        const candidate = [
          point[0] + step[0] * scale,
          point[1] + step[1] * scale,
          point[2] + step[2] * scale,
        ];
        const travelled = Math.hypot(
          candidate[0] - start[0], candidate[1] - start[1], candidate[2] - start[2],
        );
        if (travelled > trust) {
          return {
            ok: false,
            reason: `the search left the bond: it reached ${travelled.toFixed(2)} bohr from the bond midpoint `
              + `(trust radius ${trust} bohr)`,
            point: candidate,
            gradientNorm,
            iterations,
          };
        }
        const trial = densityPropertiesAtBohr(compiled, candidate[0], candidate[1], candidate[2]);
        const trialGradientNorm = norm3(trial.gradient);
        if (trialGradientNorm < gradientNorm) {
          accepted = true;
          trialPoint = candidate;
          trialProperties = trial;
          trialNorm = trialGradientNorm;
          lastStep = length * scale;
          break;
        }
        scale *= 0.5;
      }
      if (!accepted) mu = mu === 0 ? 1e-8 : mu * 10;
    }
    if (!accepted) {
      return {
        ok: false,
        reason: `no step lowered |∇ρ| (stalled at |∇ρ| = ${gradientNorm.toExponential(2)} e/bohr⁴ `
          + `after ${iterations} iterations)`,
        point,
        gradientNorm,
        iterations,
      };
    }
    point = trialPoint;
    properties = trialProperties;
    gradientNorm = trialNorm;
    if (lastStep < stepTolerance) break;
  }
  return {
    ok: gradientNorm <= tolerance,
    reason: gradientNorm <= tolerance
      ? null
      : `no convergence in ${maxIterations} iterations: |∇ρ| = ${gradientNorm.toExponential(2)} e/bohr⁴ `
        + `(tolerance ${tolerance.toExponential(0)})`,
    point,
    properties,
    gradientNorm,
    iterations,
    step: lastStep,
  };
}

/* ── bond path ────────────────────────────────────────────────────── */

/**
 * One branch of the bond path: RK4 on dr/ds = ∇ρ/|∇ρ| from `start`, until the
 * trajectory is `reach` bohr from the nearest nucleus or the step budget runs
 * out. Returns the length in bohr and how it ended — `complete` means the
 * nucleus was reached, and `endDistance` says how close otherwise.
 */
export function ascendBranch(compiled, start, atoms, {
  step = BOND_PATH_STEP,
  maxSteps = BOND_PATH_MAX_STEPS,
  reach = 0.05,
} = {}) {
  const field = (p) => {
    const { gradient } = densityPropertiesAtBohr(compiled, p[0], p[1], p[2]);
    const g = norm3(gradient);
    if (!(g > 0)) return null;
    return [gradient[0] / g, gradient[1] / g, gradient[2] / g];
  };
  let point = [...start];
  let length = 0;
  let nearest = nearestNucleus(point, atoms);
  for (let taken = 0; taken < maxSteps; taken += 1) {
    if (nearest.distance < reach) {
      return { complete: true, lengthBohr: length, steps: taken, endDistance: nearest.distance };
    }
    // Inside one step of the nucleus: the remaining stretch is shorter than the
    // integration step, so it is added as a straight segment rather than
    // integrated — the field there is a cusp and a step would orbit it.
    if (nearest.distance <= step + reach) {
      return {
        complete: true,
        lengthBohr: length + nearest.distance,
        steps: taken,
        endDistance: 0,
        note: `last ${nearest.distance.toFixed(3)} bohr to the nucleus added as a straight segment (shorter than one ${step} bohr step)`,
      };
    }
    const k1 = field(point);
    if (!k1) return { complete: false, lengthBohr: length, steps: taken, endDistance: nearest.distance, reason: 'the gradient vanished before the nucleus was reached' };
    const p2 = [point[0] + (step / 2) * k1[0], point[1] + (step / 2) * k1[1], point[2] + (step / 2) * k1[2]];
    const k2 = field(p2);
    if (!k2) return { complete: false, lengthBohr: length, steps: taken, endDistance: nearest.distance, reason: 'the gradient vanished before the nucleus was reached' };
    const p3 = [point[0] + (step / 2) * k2[0], point[1] + (step / 2) * k2[1], point[2] + (step / 2) * k2[2]];
    const k3 = field(p3);
    if (!k3) return { complete: false, lengthBohr: length, steps: taken, endDistance: nearest.distance, reason: 'the gradient vanished before the nucleus was reached' };
    const p4 = [point[0] + step * k3[0], point[1] + step * k3[1], point[2] + step * k3[2]];
    const k4 = field(p4);
    if (!k4) return { complete: false, lengthBohr: length, steps: taken, endDistance: nearest.distance, reason: 'the gradient vanished before the nucleus was reached' };
    const next = [
      point[0] + (step / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
      point[1] + (step / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
      point[2] + (step / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
    ];
    length += Math.hypot(next[0] - point[0], next[1] - point[1], next[2] - point[2]);
    point = next;
    nearest = nearestNucleus(point, atoms);
  }
  return {
    complete: false,
    lengthBohr: length,
    steps: maxSteps,
    endDistance: nearest.distance,
    reason: `the path did not reach a nucleus in ${maxSteps} steps of ${step} bohr; it ended ${nearest.distance.toFixed(3)} bohr from the nearest one`,
  };
}

function nearestNucleus(point, atoms) {
  let best = { distance: Infinity, index: -1 };
  atoms.forEach((atom, index) => {
    const distance = Math.hypot(point[0] - atom.x, point[1] - atom.y, point[2] - atom.z);
    if (distance < best.distance) best = { distance, index };
  });
  return best;
}

/**
 * Both branches of the bond path from a (3,−1) BCP, starting `offset` bohr along
 * ±the λ₃ eigenvector (the direction in which ρ rises away from the BCP) and
 * adding the two straight offsets back to the length. The approximation is the
 * straight 0.02 bohr stub, and `note` says so in the result.
 */
export function bondPath(compiled, point, eigenvector, atoms, {
  offset = BOND_PATH_OFFSET,
  step = BOND_PATH_STEP,
  maxSteps = BOND_PATH_MAX_STEPS,
} = {}) {
  const branches = [1, -1].map((sign) => {
    const start = point.map((value, axis) => value + sign * offset * eigenvector[axis]);
    return ascendBranch(compiled, start, atoms, { step, maxSteps });
  });
  const complete = branches.every((branch) => branch.complete);
  // Each branch length is measured from its own start; the straight offset from
  // the BCP to that start is added back on both sides.
  const lengthBohr = 2 * offset + branches.reduce((sum, branch) => sum + branch.lengthBohr, 0);
  return {
    lengthBohr,
    lengthAngstrom: lengthBohr * BOHR_TO_ANGSTROM,
    complete,
    branches: branches.map((branch) => ({
      complete: branch.complete,
      lengthBohr: branch.lengthBohr,
      steps: branch.steps,
      endDistanceBohr: branch.endDistance,
      reason: branch.reason ?? null,
    })),
    stepBohr: step,
    offsetBohr: offset,
    note: complete
      ? `RK4 on dr/ds = ∇ρ/|∇ρ| at ${step} bohr, plus the straight ${offset} bohr stub at each end`
      : 'incomplete: at least one branch did not reach its nucleus, so the length is not a bond path length',
  };
}

/* ── public analysis ──────────────────────────────────────────────── */

function classify(rho, laplacian) {
  if (laplacian < 0 && rho >= SHARED_SHELL_RHO) return 'shared-shell';
  if (laplacian > 0 && rho < SHARED_SHELL_RHO) return 'closed-shell';
  return 'intermediate';
}

/**
 * The whole analysis: rho, Laplacian, ellipticity, bond path length and class at
 * every bond critical point in the checkpoint, with every absence named.
 *
 * `bondPath: false` skips the path integration (properties are unaffected), for
 * a card that only needs the numbers and is called on a slider move.
 */
export function qtaimAnalysis({
  fchk = null,
  bonds = null,
  bondPath: withBondPath = true,
  tolerance = GRADIENT_TOLERANCE,
  maxIterations = MAX_ITERATIONS,
} = {}) {
  const compiled = compileDensity(fchk);
  if (!compiled.ok) {
    return {
      ok: false,
      reason: compiled.reason,
      detail: compiled.detail,
    };
  }
  const atoms = compiled.atoms;
  if (atoms.length < 2) {
    return { ok: false, reason: 'the checkpoint carries fewer than two atoms, so there is no bond to search' };
  }
  const candidates = Array.isArray(bonds)
    ? bonds.map(([a, b], index) => {
      const first = atoms[a];
      const second = atoms[b];
      if (!first || !second) {
        throw new QtaimError(`bond ${index + 1} names atom ${!first ? a + 1 : b + 1}, which the checkpoint does not carry.`);
      }
      return {
        atoms: [a, b],
        labels: [labelOf(first, a), labelOf(second, b)],
        distance: Math.hypot(
          positionOf(first, 'x') - positionOf(second, 'x'),
          positionOf(first, 'y') - positionOf(second, 'y'),
          positionOf(first, 'z') - positionOf(second, 'z'),
        ),
        considered: true,
      };
    })
    : candidateBonds(atoms);

  const results = candidates.map((candidate) => {
    const [a, b] = candidate.atoms;
    const base = {
      atoms: [a, b],
      labels: candidate.labels,
      bondLengthAngstrom: candidate.distance,
    };
    if (!candidate.considered) {
      return { ...base, found: false, reason: candidate.reason };
    }
    const first = atoms[a];
    const second = atoms[b];
    const start = [
      (first.x + second.x) / 2,
      (first.y + second.y) / 2,
      (first.z + second.z) / 2,
    ];
    const search = criticalPointSearch(compiled, start, { tolerance, maxIterations });
    if (!search.ok) {
      return { ...base, found: false, reason: search.reason, at: angstromPoint(search.point), gradientNorm: search.gradientNorm };
    }
    const { point, properties } = search;
    // The point must sit on the bond, not at a ring or cage critical point
    // somewhere else that happens to be stationary.
    const axis = [second.x - first.x, second.y - first.y, second.z - first.z];
    const axisLength = norm3(axis);
    const projection = ((point[0] - first.x) * axis[0]
      + (point[1] - first.y) * axis[1]
      + (point[2] - first.z) * axis[2]) / (axisLength * axisLength);
    if (!(projection > -0.05 && projection < 1.05)) {
      return {
        ...base,
        found: false,
        reason: `the critical point converged ${projection.toFixed(2)} of the way along the bond, outside it `
          + '(a critical point that is not between the two atoms is not this bond\'s BCP)',
        at: angstromPoint(point),
        gradientNorm: search.gradientNorm,
      };
    }
    const eigen = symmetricEigen(properties.hessian);
    const [l1, l2, l3] = eigen.values;
    const negatives = [l1, l2, l3].filter((value) => value < 0).length;
    // (3,−1) is QTAIM's signature convention: rank 3, signature −1, i.e. two
    // negative eigenvalues across the bond and one positive along it.
    if (!(negatives === 2 && l3 > 0)) {
      return {
        ...base,
        found: false,
        reason: `the stationary point has ${negatives} negative eigenvalue${negatives === 1 ? '' : 's'} `
          + `(Hessian ${l1.toExponential(3)}, ${l2.toExponential(3)}, ${l3.toExponential(3)} e/bohr⁵), `
          + 'so its signature is not (3,−1) and it is not a bond critical point',
        at: angstromPoint(point),
        gradientNorm: search.gradientNorm,
        eigenvalues: eigen.values,
      };
    }
    const laplacian = l1 + l2 + l3;
    const ellipticity = l1 / l2 - 1;
    const path = withBondPath
      ? bondPath(compiled, point, eigen.vectors[2], atoms)
      : null;
    return {
      ...base,
      found: true,
      at: angstromPoint(point),
      rho: properties.rho,
      laplacian,
      eigenvalues: eigen.values,
      // A near-degenerate Hessian would make the ratio meaningless; the
      // tolerance is stated rather than hidden in a division by ~0.
      ellipticity: Math.abs(l2) > 1e-9 ? ellipticity : null,
      ellipticityNote: Math.abs(l2) > 1e-9 ? null : `λ₂ = ${l2.toExponential(2)} e/bohr⁵ is too close to zero for a ratio`,
      classification: classify(properties.rho, laplacian),
      criteria: QTAIM_CRITERIA,
      gradientNorm: search.gradientNorm,
      iterations: search.iterations,
      bondPath: path,
      unit: { rho: 'e/bohr^3', laplacian: 'e/bohr^5', eigenvalues: 'e/bohr^5' },
    };
  }).filter(Boolean);

  return {
    ok: true,
    method: QTAIM_METHOD,
    densityBlock: compiled.densityBlock,
    basisFunctions: compiled.count,
    primitiveFunctions: compiled.primitiveCount,
    parameters: {
      gradientTolerance: tolerance,
      stepTolerance: STEP_TOLERANCE,
      maxIterations,
      bondFactor: BOND_FACTOR,
      bondPathStepBohr: withBondPath ? BOND_PATH_STEP : null,
      bondPathOffsetBohr: withBondPath ? BOND_PATH_OFFSET : null,
      criteria: QTAIM_CRITERIA,
    },
    bonds: results,
    found: results.filter((bond) => bond.found).length,
    missing: results.filter((bond) => !bond.found).length,
  };
}

function angstromPoint(point) {
  return {
    x: point[0] * BOHR_TO_ANGSTROM,
    y: point[1] * BOHR_TO_ANGSTROM,
    z: point[2] * BOHR_TO_ANGSTROM,
  };
}

/* ── presentation: card rows and the table ────────────────────────── */

/**
 * Rows for the analysis card — the same [term, value] shape `espCardRows`
 * returns, so the viewport's numbers row prints them unchanged. A file without a
 * density block gets the exact words the ESP work uses, `no density in this
 * file`, and no bond rows at all.
 */
export function qtaimCardRows(analysis) {
  if (!analysis || analysis.ok === false) {
    if (analysis?.reason === 'no density in this file') return [['QTAIM', 'no density in this file']];
    return [['QTAIM', `not computable: ${analysis?.reason || 'no analysis was run'}`]];
  }
  const rows = [
    ['QTAIM', `${analysis.found} bond critical point${analysis.found === 1 ? '' : 's'} of `
      + `${analysis.found + analysis.missing} candidate${analysis.found + analysis.missing === 1 ? '' : 's'}`
      + (analysis.missing ? ` · ${analysis.missing} not found` : '')],
  ];
  for (const bond of analysis.bonds) {
    const label = bond.labels.join('–');
    if (!bond.found) {
      rows.push([`QTAIM ${label}`, `no BCP: ${bond.reason}`]);
      continue;
    }
    const parts = [
      `ρ ${bond.rho.toFixed(4)} e/bohr³`,
      `∇²ρ ${bond.laplacian.toFixed(3)} e/bohr⁵`,
      bond.ellipticity === null ? 'ε —' : `ε ${bond.ellipticity.toFixed(3)}`,
      bond.bondPath
        ? (bond.bondPath.complete
          ? `path ${bond.bondPath.lengthAngstrom.toFixed(3)} Å`
          : 'path incomplete')
        : 'path not computed',
      bond.classification,
    ];
    rows.push([`QTAIM ${label}`, parts.join(' · ')]);
  }
  rows.push(['QTAIM method', 'analytic ρ/∇ρ/Hessian; damped Newton on ∇ρ; criteria ρ ≥ 0.10 + ∇²ρ < 0 → shared-shell']);
  return rows;
}

/**
 * The BCP table as data: `{columns, rows, missing}`. Rows carry numbers, so a
 * caller can format them; a bond with no BCP has `null` in every numeric column
 * and its reason in the last one. `missing` lists those bonds so a report can
 * print "not found" rather than a blank.
 */
export function bcpTable(analysis) {
  const columns = ['bond', 'ρ (e/bohr³)', '∇²ρ (e/bohr⁵)', 'λ₁', 'λ₂', 'λ₃', 'ε', 'bond path (Å)', 'class', 'note'];
  if (!analysis || analysis.ok === false) {
    return {
      columns,
      rows: [],
      missing: [],
      reason: analysis?.reason === 'no density in this file' ? 'no density in this file' : (analysis?.reason || 'no analysis was run'),
    };
  }
  const rows = analysis.bonds.map((bond) => {
    if (!bond.found) {
      return [bond.labels.join('–'), null, null, null, null, null, null, null, 'not found', bond.reason];
    }
    return [
      bond.labels.join('–'),
      bond.rho,
      bond.laplacian,
      bond.eigenvalues[0],
      bond.eigenvalues[1],
      bond.eigenvalues[2],
      bond.ellipticity,
      bond.bondPath?.complete ? bond.bondPath.lengthAngstrom : null,
      bond.classification,
      bond.bondPath && !bond.bondPath.complete ? 'bond path incomplete' : '',
    ];
  });
  return {
    columns,
    rows,
    missing: analysis.bonds.filter((bond) => !bond.found).map((bond) => [bond.labels.join('–'), bond.reason]),
    reason: null,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The table as HTML — no script, no style attribute, no external reference, so
 * it drops into the self-contained report. A dash is printed for a null cell
 * (a value that was not computed), never a zero.
 */
export function bcpTableHtml(analysis) {
  const table = bcpTable(analysis);
  if (table.reason) return `<p class="bcp-missing">QTAIM: ${escapeHtml(table.reason)}</p>`;
  const head = table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = table.rows.map((row) => `<tr>${row.map((cell) => {
    if (cell === null || cell === undefined) return '<td>—</td>';
    if (typeof cell === 'number') {
      return `<td>${Number.isFinite(cell) ? cell.toPrecision(4) : '—'}</td>`;
    }
    return `<td>${escapeHtml(cell)}</td>`;
  }).join('')}</tr>`).join('');
  return `<table class="bcp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
