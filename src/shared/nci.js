/**
 * NCI: the reduced density gradient and the s-versus-sign(λ₂)ρ plot (issue 59,
 * analysis half).
 *
 * ## What this computes
 *
 *   s(r) = |∇ρ(r)| / (2 (3π²)^{1/3} ρ(r)^{4/3})
 *
 * — the dimensionless reduced density gradient of Johnson et al. (*J. Am. Chem.
 * Soc.* 2010, 132, 6498) — on a regular grid around the molecule, together with
 *
 *   λ₂(r) = the middle eigenvalue of the Hessian of ρ,
 *
 * so every point can be placed at (sign(λ₂)·ρ, s): the standard NCI scatter
 * plot. The density, its gradient and its Hessian are the **analytic** ones from
 * `qtaim.js` (`densityPropertiesAtBohr`) — the same density and the same
 * derivatives the QTAIM bond critical points come from, not a second
 * implementation and not a finite difference. λ₂ therefore carries no
 * differencing step and no truncation error of its own; it is exact up to
 * floating point, like ρ.
 *
 * ## The three numbers a picture needs
 *
 * A reduced-density-gradient plot is only readable with its parameters stated,
 * so they are part of the result and of the caption:
 *
 *   - the **grid**: spacing (bohr), padding (bohr), counts, origin — default
 *     `NCI_SPACING_BOHR` = 0.2 bohr and `NCI_PADDING_BOHR` = 2.5 bohr;
 *   - the **isosurface value** s = `NCI_S_ISOVALUE` = 0.5 (a.u.), the value at
 *     which an NCI isosurface is normally taken and the line the figure draws;
 *   - the **cutoff**: only points with ρ ≤ `NCI_RHO_CUTOFF` = 0.05 e/bohr³ and
 *     s ≤ `NCI_S_MAX` = 2.0 are plotted, because the plot is about the regions
 *     where the density is weak and the gradient large — not about the bonds
 *     themselves. How many grid points each cutoff removed is reported, so the
 *     picture's density is not mistaken for the grid's.
 *
 * ## What it does not claim
 *
 * This is not an isosurface of s and it is not a "non-covalent interaction
 * found" list: a cluster of points at low s is where NCI analysis *looks*, and
 * whether a feature is an attractive or repulsive contact is read from the sign
 * of λ₂ (negative → attractive, positive → repulsive). The caption says exactly
 * that. No critical point, no interaction energy and no "bond" is reported from
 * this grid.
 */

import { BOHR_TO_ANGSTROM } from './cubeFile.js';
import { compileDensity, densityPropertiesAtBohr, symmetricEigen } from './qtaim.js';

/** (3π²)^{1/3}, the Fermi-gas constant in the reduced gradient. */
export const FERMI_CONSTANT = (3 * Math.PI * Math.PI) ** (1 / 3);

/** Grid spacing, bohr. 0.2 bohr ≈ 0.106 Å. */
export const NCI_SPACING_BOHR = 0.2;

/** Padding around the molecular box, bohr. */
export const NCI_PADDING_BOHR = 2.5;

/** The s value at which an NCI isosurface is taken; the figure draws this line. */
export const NCI_S_ISOVALUE = 0.5;

/** Only densities at or below this are plotted, e/bohr³. */
export const NCI_RHO_CUTOFF = 0.05;

/** Only s at or below this is plotted. */
export const NCI_S_MAX = 2.0;

/** Hard cap on grid points, so a small spacing cannot allocate without bound. */
export const NCI_MAX_POINTS = 600_000;

/** The one-sentence method statement a caption prints verbatim. */
export const NCI_METHOD = 's = |∇ρ| / (2 (3π²)^{1/3} ρ^{4/3}) and sign(λ₂)ρ from the analytic density '
  + '(ρ, ∇ρ and the Hessian differentiated term by term; λ₂ from a Jacobi decomposition, no finite difference)';

export class NciError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NciError';
  }
}

/**
 * s from ρ and |∇ρ|, the definition written once. Exported because the test
 * checks it against the formula evaluated by hand, and because a card that
 * prints s must use this expression rather than a rearrangement of it.
 */
export function reducedDensityGradient(rho, gradientNorm) {
  const density = Number(rho);
  const gradient = Number(gradientNorm);
  if (!(density > 0) || !Number.isFinite(gradient)) return null;
  return gradient / (2 * FERMI_CONSTANT * density ** (4 / 3));
}

/**
 * The grid: a box around the atoms, padded symmetrically, with axis-aligned
 * spacing in bohr. `origin` is in bohr and in Å (a caption states Å, the
 * evaluator needs bohr).
 */
export function nciGrid(atoms, {
  spacingBohr = NCI_SPACING_BOHR,
  paddingBohr = NCI_PADDING_BOHR,
  maxPoints = NCI_MAX_POINTS,
} = {}) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new NciError('an NCI grid needs at least one atom.');
  }
  if (!(spacingBohr > 0) || !Number.isFinite(spacingBohr)) {
    throw new NciError('the NCI grid spacing must be a positive number of bohr.');
  }
  if (!(paddingBohr >= 0) || !Number.isFinite(paddingBohr)) {
    throw new NciError('the NCI grid padding must be zero or more bohr.');
  }
  const lower = [0, 1, 2].map((axis) => Math.min(...atoms.map((atom) => atom[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'])) - paddingBohr);
  const upper = [0, 1, 2].map((axis) => Math.max(...atoms.map((atom) => atom[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'])) + paddingBohr);
  const counts = lower.map((low, axis) => Math.max(1, Math.ceil((upper[axis] - low) / spacingBohr) + 1));
  const points = counts[0] * counts[1] * counts[2];
  if (points > maxPoints) {
    return {
      ok: false,
      reason: `${counts[0]}×${counts[1]}×${counts[2]} = ${points} grid points at ${spacingBohr} bohr exceeds `
        + `the ${maxPoints}-point cap; widen the spacing rather than truncating the box`,
      counts,
      points,
      spacingBohr,
    };
  }
  return {
    ok: true,
    counts,
    points,
    spacingBohr,
    paddingBohr,
    originBohr: lower,
    originAngstrom: lower.map((value) => value * BOHR_TO_ANGSTROM),
    // Counts are exclusive of nothing: the last point is `origin + (count-1)·h`.
    upperBohr: lower.map((low, axis) => low + (counts[axis] - 1) * spacingBohr),
    note: `${counts[0]}×${counts[1]}×${counts[2]} = ${points} points at ${spacingBohr} bohr `
      + `(${(spacingBohr * BOHR_TO_ANGSTROM).toFixed(3)} Å), padding ${paddingBohr} bohr`,
  };
}

/**
 * s and sign(λ₂)ρ over the grid.
 *
 * Returns `{ok: false, reason}` for a file with no density (the same words the
 * ESP work uses) and for a grid above the cap; otherwise the plotted points as
 * two Float64Arrays, the counts that make the cutoffs auditable, and the grid
 * itself.
 */
export function nciAnalysis({
  fchk = null,
  spacingBohr = NCI_SPACING_BOHR,
  paddingBohr = NCI_PADDING_BOHR,
  sMax = NCI_S_MAX,
  rhoCutoff = NCI_RHO_CUTOFF,
  maxPoints = NCI_MAX_POINTS,
} = {}) {
  const compiled = compileDensity(fchk);
  if (!compiled.ok) {
    return { ok: false, reason: compiled.reason, detail: compiled.detail };
  }
  const atoms = compiled.atoms;
  const grid = nciGrid(atoms, { spacingBohr, paddingBohr, maxPoints });
  if (!grid.ok) return grid;

  const xs = [];
  const ss = [];
  let densityInside = 0;
  let attractive = 0;
  let repulsive = 0;
  let nonPositive = 0;
  const [nx, ny, nz] = grid.counts;
  const h = grid.spacingBohr;
  const [ox, oy, oz] = grid.originBohr;
  for (let k = 0; k < nz; k += 1) {
    const z = oz + k * h;
    for (let j = 0; j < ny; j += 1) {
      const y = oy + j * h;
      for (let i = 0; i < nx; i += 1) {
        const x = ox + i * h;
        const properties = densityPropertiesAtBohr(compiled, x, y, z);
        const rho = properties.rho;
        if (!(rho > 0)) {
          nonPositive += 1;
          continue;
        }
        if (rho > rhoCutoff) continue;
        densityInside += 1;
        const gradientNorm = Math.hypot(...properties.gradient);
        const s = reducedDensityGradient(rho, gradientNorm);
        if (s === null || !(s <= sMax)) continue;
        const lambda2 = symmetricEigen(properties.hessian).values[1];
        xs.push(lambda2 < 0 ? -rho : rho);
        ss.push(s);
        if (lambda2 < 0) attractive += 1;
        else repulsive += 1;
      }
    }
  }

  let xMin = 0;
  let xMax = 0;
  let sMin = Infinity;
  let sMinAt = null;
  let belowIsovalue = 0;
  for (let index = 0; index < ss.length; index += 1) {
    const value = xs[index];
    if (value < xMin) xMin = value;
    if (value > xMax) xMax = value;
    if (ss[index] < sMin) {
      sMin = ss[index];
      sMinAt = value;
    }
    if (ss[index] <= NCI_S_ISOVALUE) belowIsovalue += 1;
  }
  return {
    ok: true,
    method: NCI_METHOD,
    densityBlock: compiled.densityBlock,
    basisFunctions: compiled.count,
    grid,
    points: {
      x: Float64Array.from(xs),
      s: Float64Array.from(ss),
      count: xs.length,
    },
    counts: {
      gridPoints: grid.points,
      densityInside,
      plotted: xs.length,
      attractive,
      repulsive,
      nonPositiveDensity: nonPositive,
      excludedByDensity: grid.points - densityInside - nonPositive,
      excludedByGradient: densityInside - xs.length,
      belowIsovalue,
    },
    range: {
      xMin,
      xMax,
      sMin: Number.isFinite(sMin) ? sMin : null,
      sMinAt,
      sMax,
    },
    parameters: {
      spacingBohr,
      paddingBohr,
      sIsovalue: NCI_S_ISOVALUE,
      sMax,
      rhoCutoff,
      lambda2: 'analytic Hessian of ρ (Jacobi eigendecomposition); no finite-difference step',
      fermiConstant: FERMI_CONSTANT,
    },
    // A one-line statement of every parameter the picture depends on.
    note: `${grid.note} · s ≤ ${sMax}, ρ ≤ ${rhoCutoff} e/bohr³ · `
      + `${xs.length} of ${grid.points} grid points plotted`,
    units: { rho: 'e/bohr^3', s: 'dimensionless', lambda2: 'e/bohr^5' },
  };
}

/**
 * Rows for the analysis card, in the [term, value] shape the viewport's numbers
 * row prints. A file without a density block gets the exact words `no density in
 * this file`; nothing else is printed for it.
 */
export function nciCardRows(analysis) {
  if (!analysis || analysis.ok === false) {
    if (analysis?.reason === 'no density in this file') return [['NCI', 'no density in this file']];
    return [['NCI', `not computable: ${analysis?.reason || 'no analysis was run'}`]];
  }
  const { counts, grid } = analysis;
  return [
    ['NCI s / sign(λ₂)ρ', `${counts.plotted} points (${counts.attractive} λ₂<0, ${counts.repulsive} λ₂>0) `
      + `of ${counts.gridPoints} on the grid`],
    ['NCI cutoff', `s ≤ ${analysis.parameters.sMax}, ρ ≤ ${analysis.parameters.rhoCutoff} e/bohr³; `
      + `isosurface s = ${analysis.parameters.sIsovalue}`],
    ['NCI grid', `${grid.note}`],
    ['NCI λ₂', 'analytic Hessian (Jacobi); no finite difference'],
  ];
}
