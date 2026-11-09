/**
 * Volumetric wavefunction values: an orbital, a density or a cube, sampled on
 * a uniform grid of Å, in atomic units.
 *
 * Why this module exists: the app already parses the basis (shells, exponents,
 * contraction coefficients) and the MO coefficients, and then draws nothing.
 * Everything needed to turn those numbers into a picture is here, and nothing
 * that needs a canvas is: the renderers take the `field` object this module
 * builds.
 *
 * ## Units — the one thing that silently ruins a picture
 *
 * Gaussian basis exponents are in bohr⁻². Coordinates in this app are Å.
 * The evaluator therefore converts each point to bohr before it touches an
 * exponent, and every value it returns is in atomic units:
 *
 *   orbital amplitude   a.u.        (bohr^-3/2)
 *   density             e/bohr³     (Σ_i occ_i |ψ_i|²)
 *
 * The grid geometry stays in Å because that is what the viewer and the atom
 * list speak; `grid.cellVolumeBohr3` is provided so an integral over the grid
 * is `Σ values × cellVolumeBohr3` electrons, with no unit slip at the call
 * site.
 *
 * ## The angular contract (a wrong normalisation is a wrong picture)
 *
 * A shell contributes these basis functions, in this order — the order the
 * Molden specification and Gaussian's formatted checkpoint both use, which is
 * also the order the MO coefficients are stored in:
 *
 *   0   s     1      s
 *   1   p     3      x, y, z
 *  -1   sp    4      s, x, y, z          (s from `contractionCoefficients`,
 *                                         p from `spContractionCoefficients`)
 *   2   d     6      xx, yy, zz, xy, xz, yz
 *  -2   d     5      3z²−r², xz, yz, x²−y², xy
 *   3   f    10      xxx, yyy, zzz, xyy, xxy, xxz, xzz, yzz, yyz, xyz
 *  -3   f     7      z(5z²−3r²), x(5z²−r²), y(5z²−r²), z(x²−y²), xyz,
 *                    x(x²−3y²), y(3x²−y²)
 *   4   g    15      see CARTESIAN['gaussian'].g
 *  -4   g     9      REFUSED — see below
 *
 * A negative shell type means *pure* (spherical) functions for d, f and g;
 * a positive type means Cartesian. s and p have no spherical form.
 *
 * **Normalisation.** Every primitive is a normalised Cartesian Gaussian:
 *
 *   N(i,j,k; α) = (2α/π)^{3/4} √[ (4α)^l / ((2i−1)!! (2j−1)!! (2k−1)!!) ],
 *   l = i+j+k, (−1)!! = 1
 *
 * and a contraction coefficient multiplies *normalised* primitives, which is
 * the Gaussian/Molden convention. Nothing is renormalised afterwards: a
 * contracted AO whose coefficients came from a basis set is what the file says
 * it is, and renormalising it would move every coefficient relative to the
 * others.
 *
 * **Pure (spherical) components** are the standard real solid harmonics,
 * expressed as fixed linear combinations of the raw Cartesian monomials
 * (x^i y^j z^k e^{−αr²}) and scaled so that each has unit self-overlap. The
 * scale is computed from the exact monomial overlap metric (`monomialMetric`),
 * not from a table of magic numbers, and it is exponent-independent because
 * every monomial of a fixed total degree carries the same α-power.
 * `test/volume.test.js` checks the result (each pure function integrates to 1
 * on a grid), the shapes (the addition theorem: Σ_m Y_m(dir)² is the same in
 * every direction) and orthonormality (the 5×5 and 7×7 overlap matrices are the
 * identity), which together pin the shapes and the scale.
 *
 * **Refusals.** A shell this module cannot evaluate correctly is refused by
 * name, before a single grid point is touched — never zero-filled:
 *
 *   h and above                 "the h shell (shell type 5) is not implemented"
 *   spherical g (9 functions)   "the spherical g shell (shell type -4, 9
 *                                 functions) is not implemented"
 *
 * The spherical g set is refused on purpose: the nine-component ordering is
 * not the same across writers, and guessing it would attach a coefficient to
 * the wrong angular function with no visible symptom. Cartesian 15G *is*
 * evaluated, because that ordering is documented in `aimBasis.js` and matches
 * Gaussian's.
 *
 * **Cartesian f/g ordering.** Two orderings exist in the wild and they are not
 * the same for f (positions 4–9). `cartesianOrder` selects one:
 *
 *   'gaussian' (default)  xxx yyy zzz xyy xxy xxz xzz yzz yyz xyz   (Molden,
 *                         Gaussian, and the app's Molden reader)
 *   'aim'                 xxx yyy zzz xxy xxz yyz xyy xzz yzz xyz   (WFN/WFX,
 *                         see `aimBasis.js`)
 *
 * d and g are identical in both, so this only matters once an f shell is
 * present. A shell list that mixes provenances cannot be expressed, which is
 * why the choice is per call and not per shell.
 *
 * ## What is deliberately not here
 *
 * No rendering, no DOM, no worker: those are `volumeWorker.js`,
 * `sliceView.js` and `surfaceViewer.js`. No ESP, no QTAIM, no time dependence.
 */

import { BOHR_TO_ANGSTROM } from './cubeFile.js';

const ANGSTROM_PER_BOHR = BOHR_TO_ANGSTROM;
const BOHR_PER_ANGSTROM = 1 / BOHR_TO_ANGSTROM;

/** Å. 0.3 Å ≈ 0.57 bohr: an isosurface at this spacing is blocky but legible. */
export const DEFAULT_SPACING = 0.3;
/** Å added on every side of the atom bounding box. */
export const DEFAULT_PADDING = 3.5;
/**
 * Hard ceiling on grid points. 4e6 points is 32 MB of Float64 — the largest
 * grid a laptop should evaluate on the main thread inside a second or two.
 */
export const MAX_GRID_POINTS = 4_000_000;

export class VolumeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VolumeError';
  }
}

export class UnsupportedShellError extends VolumeError {
  constructor(message, { shellType, label = null } = {}) {
    super(message);
    this.name = 'UnsupportedShellError';
    this.shellType = shellType;
    this.label = label;
  }
}

/* ── angular components ───────────────────────────────────── */

const SHELL_LETTERS = 'spdfgh';

/** Basis functions per shell type, in the signed checkpoint convention. */
export const SHELL_FUNCTIONS = Object.freeze({
  0: 1,
  1: 3,
  '-1': 4,
  2: 6,
  '-2': 5,
  3: 10,
  '-3': 7,
  4: 15,
  '-4': 9,
});

/** Powers (i, j, k) for the Cartesian functions, in each writer's order. */
export const CARTESIAN = Object.freeze({
  gaussian: Object.freeze({
    s: [[0, 0, 0]],
    p: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    d: [[2, 0, 0], [0, 2, 0], [0, 0, 2], [1, 1, 0], [1, 0, 1], [0, 1, 1]],
    f: [
      [3, 0, 0], [0, 3, 0], [0, 0, 3], [1, 2, 0], [2, 1, 0],
      [2, 0, 1], [1, 0, 2], [0, 1, 2], [0, 2, 1], [1, 1, 1],
    ],
    g: [
      [4, 0, 0], [0, 4, 0], [0, 0, 4], [3, 1, 0], [3, 0, 1],
      [1, 3, 0], [0, 3, 1], [1, 0, 3], [0, 1, 3], [2, 2, 0],
      [2, 0, 2], [0, 2, 2], [2, 1, 1], [1, 2, 1], [1, 1, 2],
    ],
  }),
  aim: Object.freeze({
    s: [[0, 0, 0]],
    p: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    d: [[2, 0, 0], [0, 2, 0], [0, 0, 2], [1, 1, 0], [1, 0, 1], [0, 1, 1]],
    f: [
      [3, 0, 0], [0, 3, 0], [0, 0, 3], [2, 1, 0], [2, 0, 1],
      [0, 2, 1], [1, 2, 0], [1, 0, 2], [0, 1, 2], [1, 1, 1],
    ],
    g: [
      [4, 0, 0], [0, 4, 0], [0, 0, 4], [3, 1, 0], [3, 0, 1],
      [1, 3, 0], [0, 3, 1], [1, 0, 3], [0, 1, 3], [2, 2, 0],
      [2, 0, 2], [0, 2, 2], [2, 1, 1], [1, 2, 1], [1, 1, 2],
    ],
  }),
});

/**
 * Pure components as linear combinations of Cartesian monomials, in the
 * Molden/Gaussian order. Each entry is `[i, j, k, coefficient]`; the shapes are
 * the standard real solid harmonics, and the scale of each component is fixed
 * later by `gramMatrix` (so the coefficients below are proportional to the
 * published ones, and the normalisation makes the constant right).
 */
const PURE_COMBINATIONS = Object.freeze({
  2: Object.freeze([
    // 3z² − r²
    Object.freeze([[0, 0, 2, 2], [2, 0, 0, -1], [0, 2, 0, -1]]),
    // xz
    Object.freeze([[1, 0, 1, 1]]),
    // yz
    Object.freeze([[0, 1, 1, 1]]),
    // x² − y²
    Object.freeze([[2, 0, 0, 1], [0, 2, 0, -1]]),
    // xy
    Object.freeze([[1, 1, 0, 1]]),
  ]),
  3: Object.freeze([
    // z(5z² − 3r²) = 2zzz − 3zxx − 3zyy
    Object.freeze([[0, 0, 3, 2], [2, 0, 1, -3], [0, 2, 1, -3]]),
    // x(5z² − r²) = 4xz² − xxx − xyy
    Object.freeze([[1, 0, 2, 4], [3, 0, 0, -1], [1, 2, 0, -1]]),
    // y(5z² − r²) = 4yz² − yyy − yxx
    Object.freeze([[0, 1, 2, 4], [0, 3, 0, -1], [2, 1, 0, -1]]),
    // z(x² − y²)
    Object.freeze([[2, 0, 1, 1], [0, 2, 1, -1]]),
    // xyz
    Object.freeze([[1, 1, 1, 1]]),
    // x(x² − 3y²)
    Object.freeze([[3, 0, 0, 1], [1, 2, 0, -3]]),
    // y(3x² − y²)
    Object.freeze([[2, 1, 0, 3], [0, 3, 0, -1]]),
  ]),
});

/**
 * ∫ t^n e^{−2t²} dt for even n at α = 1, i.e. with the exponent 2α of the
 * product of two unit Gaussians. `(2m−1)!!/4^m · √(π/2)` — the 4^m is the
 * (2β)^m of the standard moment, with β = 2 here, and getting it wrong scales
 * every pure component by 2^{l/2} while the Cartesian set stays correct.
 */
const MOMENTS = (() => {
  const base = Math.sqrt(Math.PI / 2);
  return [1, null, 1 / 4, null, 3 / 16, null, 15 / 64, null, 105 / 256].map((factor) => (
    factor === null || factor === undefined ? null : factor * base
  ));
})();

/** (2n−1)!! with (−1)!! = 1. */
function oddFactorial(n) {
  let value = 1;
  for (let step = 1; step <= n; step += 1) value *= 2 * step - 1;
  return value;
}

/** Normalisation constant of a normalised Cartesian Gaussian. */
function cartesianNormalisation(alpha, i, j, k) {
  const l = i + j + k;
  const denominator = oddFactorial(i) * oddFactorial(j) * oddFactorial(k);
  return ((2 * alpha) / Math.PI) ** 0.75 * Math.sqrt((4 * alpha) ** l / denominator);
}

/**
 * The exact overlap metric of the *raw monomials* of degree `l`, at α = 1:
 * `M[i][j] = ∫ m_i m_j e^{−2r²} dτ`. Every monomial of a fixed total degree
 * carries the same α-power, so M(α) is this matrix times a common scalar and
 * the normalisation below is exponent-independent.
 *
 * This is the metric in which the pure components are orthogonal, which is why
 * it is the one used here: the *normalised* Cartesian set is a diagonal
 * rescaling of the monomials, so orthogonality of two combinations does not
 * survive that rescaling (a basis-independent zero does, but only if the
 * combination coefficients are converted with the same 1/N factor).
 *
 * Exported so the tests can assert its properties instead of trusting this
 * comment.
 */
export function monomialMetric(l, order = 'gaussian') {
  const monomials = CARTESIAN[order][SHELL_LETTERS[l]];
  return monomials.map((a) => monomials.map((b) => {
    let integral = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const power = a[axis] + b[axis];
      if (power % 2 === 1) return 0;
      integral *= MOMENTS[power];
    }
    return integral;
  }));
}

/**
 * The pure components of a d or f shell: `[{ i, j, k, coefficient }]` per
 * monomial, scaled so that the combination has unit self-overlap in the exact
 * metric. The coefficients act on raw monomials (times e^{−αr²}), not on
 * normalised Cartesian primitives, so they are the same at every exponent.
 */
export function pureComponents(l) {
  const combinations = PURE_COMBINATIONS[l];
  if (!combinations) {
    throw new UnsupportedShellError(
      `no pure component set is defined for l=${l}; only d (5) and f (7) are implemented.`,
      { shellType: -l, label: SHELL_LETTERS[l] ?? '?' },
    );
  }
  const monomials = CARTESIAN.gaussian[SHELL_LETTERS[l]];
  const index = new Map(monomials.map((powers, position) => [powers.join(','), position]));
  const metric = monomialMetric(l);
  return combinations.map((combination) => {
    const vector = new Array(monomials.length).fill(0);
    for (const [i, j, k, coefficient] of combination) {
      const at = index.get([i, j, k].join(','));
      if (at === undefined) {
        throw new VolumeError(`the pure-${SHELL_LETTERS[l]} table names ${i},${j},${k}, which is not a Cartesian component.`);
      }
      vector[at] += coefficient;
    }
    // norm² = vᵀ M v in the monomial metric.
    let normSquared = 0;
    for (let row = 0; row < vector.length; row += 1) {
      if (vector[row] === 0) continue;
      for (let column = 0; column < vector.length; column += 1) {
        if (vector[column] === 0) continue;
        normSquared += vector[row] * metric[row][column] * vector[column];
      }
    }
    const scale = Math.sqrt(normSquared);
    return monomials
      .map(([i, j, k], position) => ({ i, j, k, coefficient: vector[position] / scale }))
      .filter((term) => term.coefficient !== 0);
  });
}

/** Cached pure component tables, per l and Cartesian ordering. */
const PURE_CACHE = new Map();
function pureComponentsCached(l, order) {
  const key = `${l}:${order}`;
  if (!PURE_CACHE.has(key)) {
    // The pure shapes are defined on the Gaussian monomial list; the ordering
    // only matters for which monomial a component sits on, and d/f pure sets
    // are the same functions either way because their Cartesian partners are
    // identical in both orderings. Rebuild against the requested order for
    // clarity rather than assuming it.
    if (order === 'gaussian') {
      PURE_CACHE.set(key, pureComponents(l));
    } else {
      const components = pureComponents(l);
      const monomials = CARTESIAN[order][SHELL_LETTERS[l]];
      const gaussianMonomials = CARTESIAN.gaussian[SHELL_LETTERS[l]];
      const same = monomials.every((powers, at) => powers.join(',') === gaussianMonomials[at].join(','));
      if (!same) {
        throw new VolumeError(`the pure ${SHELL_LETTERS[l]} set is not defined for the "${order}" Cartesian order.`);
      }
      PURE_CACHE.set(key, components);
    }
  }
  return PURE_CACHE.get(key);
}

/* ── the grid ─────────────────────────────────────────────── */

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function atomsOf(input) {
  const list = Array.isArray(input) ? input : input?.atoms;
  if (!Array.isArray(list) || list.length === 0) {
    throw new VolumeError('a volume needs at least one atom (or a geometry with atoms).');
  }
  return list.map((atom, index) => {
    const x = Number(atom?.x);
    const y = Number(atom?.y);
    const z = Number(atom?.z);
    if (![x, y, z].every(finiteNumber)) {
      throw new VolumeError(`atom ${index + 1} has a missing or non-finite coordinate.`);
    }
    return { x, y, z };
  });
}

/**
 * A uniform, cubic-cell grid around the atoms.
 *
 * The box is the atom bounding box grown by `padding` on every side, sampled
 * with one `spacing` for all three axes. If that would need more than
 * `maxPoints` points, the spacing is coarsened until it fits, and the result
 * says so (`capped`, `requestedSpacing`, `note`) rather than quietly returning
 * a different resolution than the caller asked for.
 *
 * @returns {{origin: number[], counts: number[], step: number, spacing: number,
 *   points: number, capped: boolean, requestedSpacing: number, note: string,
 *   atoms: object[], cellVolumeAngstrom3: number, cellVolumeBohr3: number,
 *   cellVolumeLitre: number, units: object}}
 */
export function gridFor(atoms, {
  spacing = DEFAULT_SPACING,
  padding = DEFAULT_PADDING,
  maxPoints = MAX_GRID_POINTS,
} = {}) {
  const list = atomsOf(atoms);
  const requested = Number(spacing);
  if (!finiteNumber(requested) || requested <= 0) {
    throw new VolumeError(`the grid spacing must be a positive number of Å; got ${spacing}.`);
  }
  const pad = Number(padding);
  if (!finiteNumber(pad) || pad < 0) {
    throw new VolumeError(`the grid padding must be zero or more Å; got ${padding}.`);
  }
  const limit = Number(maxPoints);
  if (!finiteNumber(limit) || limit < 8) {
    throw new VolumeError(`the grid point limit must be at least 8; got ${maxPoints}.`);
  }

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const atom of list) {
    min = [Math.min(min[0], atom.x), Math.min(min[1], atom.y), Math.min(min[2], atom.z)];
    max = [Math.max(max[0], atom.x), Math.max(max[1], atom.y), Math.max(max[2], atom.z)];
  }
  // A single atom (or a perfectly flat molecule) still needs a box with three
  // extents; padding alone supplies the missing ones but the arithmetic is
  // clearer with an explicit floor.
  const extents = [0, 1, 2].map((axis) => Math.max(max[axis] - min[axis], 0) + 2 * pad);
  const countsFor = (step) => extents.map((extent) => Math.max(2, Math.ceil(extent / step) + 1));

  let step = requested;
  let counts = countsFor(step);
  let points = counts[0] * counts[1] * counts[2];
  const estimated = Math.max(1, MAX_GRID_POINTS);
  const cap = Math.min(limit, estimated);
  while (points > cap) {
    // Grow the step by exactly the factor the point count needs; the loop
    // repeats because `ceil` does not scale linearly.
    step *= Math.max(1.02, (points / cap) ** (1 / 3) * 1.001);
    counts = countsFor(step);
    points = counts[0] * counts[1] * counts[2];
  }
  const capped = step > requested * (1 + 1e-12);
  const origin = [0, 1, 2].map((axis) => min[axis] - pad);

  return {
    origin,
    counts,
    step,
    spacing: step,
    points,
    capped,
    requestedSpacing: requested,
    padding: pad,
    note: capped
      ? `grid coarsened from ${requested.toFixed(3)} Å to ${step.toFixed(3)} Å to stay under ${cap} points `
        + `(${counts.join('×')} = ${points} points)`
      : `${counts.join('×')} = ${points} points at ${step.toFixed(3)} Å`,
    atoms: list,
    // Axes are per-index vectors in Å; orthogonal, axis-aligned, one step each.
    axes: [[step, 0, 0], [0, step, 0], [0, 0, step]],
    cellVolumeAngstrom3: step ** 3,
    cellVolumeBohr3: (step * BOHR_PER_ANGSTROM) ** 3,
    cellVolumeLitre: (step * BOHR_PER_ANGSTROM * 5.29177210903e-11) ** 3 * 1e27,
    units: { coordinates: 'angstrom', values: 'a.u.' },
  };
}

/* ── shells ───────────────────────────────────────────────── */

function isCheckpointLike(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.shellTypes);
}

/**
 * Normalise the two shapes the app has into one shell list:
 *
 *   `[{ atom, type, primitives: [{ exponent, s, p? }] }]`   (Molden, AIM)
 *
 * from either that list itself, a parsed Molden file (`.shells`), or a parsed
 * checkpoint's flat parallel arrays. The signed shell types carry the
 * spherical/Cartesian choice; `Pure/Cartesian d shells` and the f equivalent
 * are used as a fallback only where the type is positive, because a per-shell
 * type cannot be overridden by one file-wide flag without guessing which one
 * the writer meant.
 *
 * The function count is checked against `numberOfBasisFunctions` when the
 * record carries it. A disagreement is an error, not a warning: it means this
 * reader and the file disagree about how many functions each shell has, and
 * every MO coefficient after that point would sit on the wrong shell.
 *
 * @param {object|Array} source
 * @param {{cartesianOrder?: 'gaussian'|'aim'}} [options]
 */
export function shellsFromCheckpoint(source, { cartesianOrder = 'gaussian' } = {}) {
  if (!source) throw new VolumeError('there is no base to read shells from.');
  if (!CARTESIAN[cartesianOrder]) {
    throw new VolumeError(`unknown Cartesian ordering "${cartesianOrder}"; use "gaussian" or "aim".`);
  }

  let shells = null;
  let statedCount = null;

  if (Array.isArray(source)) {
    shells = source.map((shell, index) => normaliseShell(shell, index));
  } else if (Array.isArray(source.shells)) {
    shells = source.shells.map((shell, index) => normaliseShell(shell, index));
    statedCount = Number.isInteger(source.numberOfBasisFunctions) ? source.numberOfBasisFunctions : null;
  } else if (isCheckpointLike(source)) {
    shells = shellsFromFlatArrays(source);
    statedCount = Number.isInteger(source.numberOfBasisFunctions) ? source.numberOfBasisFunctions : null;
  } else {
    throw new VolumeError(
      'this record has no basis: it carries neither a "shells" list nor the checkpoint arrays '
      + '("Shell types", "Number of primitives per shell", "Primitive exponents").',
    );
  }

  if (shells.length === 0) throw new VolumeError('the basis has no shells.');

  const summary = shells.reduce((total, shell) => total + shell.functions, 0);
  if (statedCount !== null && statedCount !== summary) {
    throw new VolumeError(
      `the basis describes ${summary} basis functions but the record states ${statedCount}; `
      + 'the shell types and the MO coefficients disagree, so an orbital would be drawn on the wrong shells.',
    );
  }

  return {
    shells,
    numberOfBasisFunctions: summary,
    cartesianOrder,
    spherical: {
      d: shells.some((shell) => shell.type === -2),
      f: shells.some((shell) => shell.type === -3),
      g: shells.some((shell) => shell.type === -4),
    },
  };
}

function normaliseShell(shell, index) {
  if (!shell || typeof shell !== 'object') {
    throw new VolumeError(`shell ${index + 1} is not an object.`);
  }
  const type = Number(shell.type);
  const label = SHELL_FUNCTIONS[String(type)] === undefined ? (shell.label ?? '?') : SHELL_LETTERS[Math.abs(type)];
  const primitives = (Array.isArray(shell.primitives) ? shell.primitives : []).map((primitive, at) => {
    const exponent = Number(primitive?.exponent);
    if (!finiteNumber(exponent) || exponent <= 0) {
      throw new VolumeError(`shell ${index + 1} primitive ${at + 1} has exponent ${primitive?.exponent}; it must be positive.`);
    }
    const s = Number(primitive?.s ?? primitive?.coefficient ?? 0);
    const p = primitive?.p === undefined ? null : Number(primitive.p);
    if (!finiteNumber(s)) {
      throw new VolumeError(`shell ${index + 1} primitive ${at + 1} has a non-finite contraction coefficient.`);
    }
    return { exponent, s, p };
  });
  if (primitives.length === 0) {
    throw new VolumeError(`shell ${index + 1} (${label}) has no primitives.`);
  }
  const atom = Number(shell.atom ?? shell.atomIndex);
  if (!Number.isInteger(atom) || atom < 1) {
    throw new VolumeError(`shell ${index + 1} is not attached to an atom (atom index ${shell.atom}).`);
  }
  if (type === -1 && primitives.some((primitive) => !finiteNumber(primitive.p))) {
    throw new VolumeError(
      `shell ${index + 1} is an sp shell but has no p contraction coefficients; `
      + 'an sp shell needs one s and one p coefficient per primitive.',
    );
  }
  // Refuse before any allocation. `describeShell` produces the exact string.
  const functions = shellFunctionCount(type, index);
  return { atom, type, label, primitives, functions, spherical: type < 0 && type !== -1, index };
}

function shellFunctionCount(type, index = null) {
  const key = String(type);
  if (SHELL_FUNCTIONS[key] === undefined) {
    const where = index === null ? '' : ` (shell ${index + 1})`;
    const letter = Number.isInteger(type) && type !== 0 ? SHELL_LETTERS[Math.abs(type)] ?? '?' : '?';
    throw new UnsupportedShellError(
      `the ${letter} shell (shell type ${type}) is not implemented${where}; `
      + 'only s, p, sp, d, f and Cartesian g shells are evaluated.',
      { shellType: type, label: letter },
    );
  }
  if (type === -4) {
    const where = index === null ? '' : ` (shell ${index + 1})`;
    throw new UnsupportedShellError(
      `the spherical g shell (shell type -4, 9 functions) is not implemented${where}; `
      + 'the nine-component order is not verified across writers, so it is refused rather than guessed. '
      + 'A Cartesian g shell (15 functions) is evaluated.',
      { shellType: type, label: 'g' },
    );
  }
  return SHELL_FUNCTIONS[key];
}

function shellsFromFlatArrays(checkpoint) {
  const types = checkpoint.shellTypes;
  const counts = checkpoint.primitivesPerShell;
  const map = checkpoint.shellToAtomMap;
  const exponents = checkpoint.primitiveExponents;
  const contraction = checkpoint.contractionCoefficients;
  const spContraction = checkpoint.spContractionCoefficients;
  if (!Array.isArray(counts) || counts.length !== types.length) {
    throw new VolumeError('"Number of primitives per shell" does not match "Shell types".');
  }
  if (!Array.isArray(map) || map.length !== types.length) {
    throw new VolumeError('"Shell to atom map" does not match "Shell types".');
  }
  if (!Array.isArray(exponents) || !Array.isArray(contraction)) {
    throw new VolumeError('the basis has no primitive exponents or no contraction coefficients.');
  }
  const totalPrimitives = counts.reduce((total, count) => total + Number(count), 0);
  if (exponents.length !== totalPrimitives || contraction.length !== totalPrimitives) {
    throw new VolumeError(
      `the shells declare ${totalPrimitives} primitives but the file has ${exponents.length} exponents `
      + `and ${contraction.length} contraction coefficients.`,
    );
  }
  if (Array.isArray(spContraction) && spContraction.length !== totalPrimitives) {
    throw new VolumeError(
      `"P(S=P) Contraction coefficients" has ${spContraction.length} values for ${totalPrimitives} primitives.`,
    );
  }

  const pureD = checkpoint.pureDShells === 1;
  const pureF = checkpoint.pureFShells === 1;

  const build = (dAsPure, fAsPure) => {
    const shells = [];
    let offset = 0;
    for (let index = 0; index < types.length; index += 1) {
      let type = Number(types[index]);
      if (type === 2 && dAsPure) type = -2;
      if (type === 3 && fAsPure) type = -3;
      const count = Number(counts[index]);
      const primitives = [];
      for (let at = 0; at < count; at += 1) {
        primitives.push({
          exponent: Number(exponents[offset + at]),
          s: Number(contraction[offset + at]),
          p: type === -1 ? Number(spContraction?.[offset + at]) : null,
        });
      }
      offset += count;
      shells.push(normaliseShell({ atom: Number(map[index]), type, primitives }, index));
    }
    return shells;
  };
  const shellList = build(pureD, pureF);

  // Issue 168: the two writers that emit these flat arrays do not agree on the
  // sign of "Pure/Cartesian d shells". Psi4 1.11 writes `0` for a pure d shell
  // (cc-pVDZ, 5 functions) and `1` for a Cartesian one (6-31G*, 6 functions);
  // Gaussian's formatted checkpoint writes the opposite. A wrong guess silently
  // shifts every function after the first d shell, so the file's own
  // `Number of basis functions` decides: the reading whose function count
  // matches the stated count wins, and a file where neither matches still falls
  // through to the count check in `shellsFromCheckpoint`, which refuses it.
  const statedCount = Number.isInteger(checkpoint.numberOfBasisFunctions) ? checkpoint.numberOfBasisFunctions : null;
  if (statedCount !== null) {
    const total = shellList.reduce((sum, shell) => sum + shell.functions, 0);
    if (total !== statedCount) {
      const flipped = build(!pureD, !pureF);
      const flippedTotal = flipped.reduce((sum, shell) => sum + shell.functions, 0);
      if (flippedTotal === statedCount) return flipped;
    }
  }
  return shellList;
}

/* ── orbitals ─────────────────────────────────────────────── */

/**
 * Compile a shell list into the flat structure the evaluator walks.
 *
 * Every basis function becomes one entry of `functions`; every primitive of
 * every shell becomes one entry of `primitives` with a list of weighted
 * `(component, monomial)` terms. Nothing per-point is allocated at run time.
 */
export function prepareBasis(shellsInput, { cartesianOrder = 'gaussian' } = {}) {
  if (!Array.isArray(shellsInput)) throw new VolumeError('prepareBasis needs an array of shells.');
  if (!CARTESIAN[cartesianOrder]) {
    throw new VolumeError(`unknown Cartesian ordering "${cartesianOrder}"; use "gaussian" or "aim".`);
  }
  const list = shellsInput.map((shell, index) => normaliseShell(shell, index));

  const shells = [];
  const primitives = [];
  let functionCount = 0;

  for (const shell of list) {
    const l = shell.type < 0 ? Math.abs(shell.type) : shell.type;
    const kind = shell.type === -1 ? 'sp' : SHELL_LETTERS[l];
    // Each entry: the angular function, the monomial terms it is built from,
    // and which contraction coefficient (s or p) multiplies them.
    const components = [];

    if (shell.type === 0 || shell.type === 1) {
      for (const [i, j, k] of CARTESIAN[cartesianOrder][SHELL_LETTERS[shell.type]]) {
        components.push({ cartesian: true, from: 's', terms: [{ i, j, k, w: 1 }] });
      }
    } else if (shell.type === -1) {
      // s first, then px, py, pz — Molden and Gaussian both store sp this way.
      components.push({ cartesian: true, from: 's', terms: [{ i: 0, j: 0, k: 0, w: 1 }] });
      for (const [i, j, k] of CARTESIAN[cartesianOrder].p) {
        components.push({ cartesian: true, from: 'p', terms: [{ i, j, k, w: 1 }] });
      }
    } else if (shell.type > 0) {
      for (const [i, j, k] of CARTESIAN[cartesianOrder][SHELL_LETTERS[l]]) {
        components.push({ cartesian: true, from: 's', terms: [{ i, j, k, w: 1 }] });
      }
    } else {
      for (const combination of pureComponentsCached(l, cartesianOrder)) {
        components.push({
          cartesian: false,
          from: 's',
          // Already in monomial space and already normalised: no Cartesian
          // normalisation constant is applied to these terms.
          terms: combination.map(({ i, j, k, coefficient }) => ({ i, j, k, w: coefficient })),
        });
      }
    }

    const primitiveBase = primitives.length;
    for (const primitive of shell.primitives) {
      primitives.push({ atom: shell.atom - 1, alpha: primitive.exponent, terms: [] });
    }

    for (let at = 0; at < shell.primitives.length; at += 1) {
      const primitive = shell.primitives[at];
      const primitiveIndex = primitiveBase + at;
      components.forEach((component, position) => {
        const contractionCoefficient = component.from === 'p' ? primitive.p : primitive.s;
        if (!Number.isFinite(contractionCoefficient)) {
          throw new VolumeError(
            `shell ${shell.index + 1} is an sp shell with a primitive that has no p coefficient.`,
          );
        }
        if (contractionCoefficient === 0) return;
        for (const term of component.terms) {
          // A Cartesian component multiplies a *normalised* primitive; a pure
          // component is a normalised combination of raw monomials, and its
          // unit-norm scale carries α^{(3+2l)/4} because the monomial metric
          // scales as α^{-(3+2l)/2} while the table is written at α = 1.
          const scale = component.cartesian
            ? cartesianNormalisation(primitive.exponent, term.i, term.j, term.k)
            : primitive.exponent ** ((3 + 2 * l) / 4);
          primitives[primitiveIndex].terms.push({
            component: position,
            i: term.i,
            j: term.j,
            k: term.k,
            w: contractionCoefficient * scale * term.w,
          });
        }
      });
    }

    const offset = functionCount;
    functionCount += components.length;
    shells.push({
      index: shell.index,
      atom: shell.atom - 1,
      type: shell.type,
      kind,
      l,
      spherical: shell.spherical,
      components,
      offset,
      functions: components.length,
      primitiveIndices: shell.primitives.map((_, at) => primitiveBase + at),
      accumulator: new Float64Array(components.length),
    });
  }

  return { shells, primitives, functionCount, cartesianOrder };
}

function coefficientsOf(coefficients, functionCount, label = 'the orbital') {
  let values = coefficients;
  if (ArrayBuffer.isView(values)) values = Array.from(values);
  if (!Array.isArray(values)) {
    throw new VolumeError(`${label} needs an array of ${functionCount} MO coefficients.`);
  }
  if (values.length !== functionCount) {
    throw new VolumeError(
      `${label} has ${values.length} coefficients but the basis has ${functionCount} functions.`,
    );
  }
  for (const value of values) {
    if (!finiteNumber(value)) throw new VolumeError(`${label} has a non-finite MO coefficient.`);
  }
  return Float64Array.from(values);
}

/**
 * Walk the grid once, filling `chi` with the basis-function values at each
 * point and handing it to `onPoint`. The exponentials are evaluated once per
 * primitive per point, not once per component, and the monomial powers are
 * built by multiplication once per shell per point — `dx ** i` in the inner
 * loop is roughly five times slower than indexing a small power table, which is
 * the difference between a three-second grid and a fifteen-second one.
 */
function walkGrid(prepared, grid, { onProgress = null, onPoint = null } = {}) {
  const counts = grid.counts;
  const [nx, ny, nz] = counts;
  const origin = grid.origin;
  const step = grid.step;
  const centres = grid.atoms.map((atom) => [
    atom.x * BOHR_PER_ANGSTROM,
    atom.y * BOHR_PER_ANGSTROM,
    atom.z * BOHR_PER_ANGSTROM,
  ]);
  const xs = new Float64Array(nx);
  const ys = new Float64Array(ny);
  const zs = new Float64Array(nz);
  for (let i = 0; i < nx; i += 1) xs[i] = (origin[0] + i * step) * BOHR_PER_ANGSTROM;
  for (let j = 0; j < ny; j += 1) ys[j] = (origin[1] + j * step) * BOHR_PER_ANGSTROM;
  for (let k = 0; k < nz; k += 1) zs[k] = (origin[2] + k * step) * BOHR_PER_ANGSTROM;

  const chi = new Float64Array(prepared.functionCount);
  const { shells, primitives } = prepared;
  // Highest monomial power any component carries (4 for a Cartesian g shell).
  const xPower = new Float64Array(5);
  const yPower = new Float64Array(5);
  const zPower = new Float64Array(5);
  const powers = [xPower, yPower, zPower];

  for (let k = 0; k < nz; k += 1) {
    const z = zs[k];
    for (let j = 0; j < ny; j += 1) {
      const y = ys[j];
      for (let i = 0; i < nx; i += 1) {
        const x = xs[i];
        chi.fill(0);
        for (const shell of shells) {
          const centre = centres[shell.atom];
          if (!centre) {
            throw new VolumeError(`a shell is attached to atom ${shell.atom + 1}, which the grid does not carry.`);
          }
          const dx = x - centre[0];
          const dy = y - centre[1];
          const dz = z - centre[2];
          const r2 = dx * dx + dy * dy + dz * dz;
          xPower[0] = 1;
          xPower[1] = dx;
          xPower[2] = dx * dx;
          xPower[3] = xPower[2] * dx;
          xPower[4] = xPower[3] * dx;
          yPower[0] = 1;
          yPower[1] = dy;
          yPower[2] = dy * dy;
          yPower[3] = yPower[2] * dy;
          yPower[4] = yPower[3] * dy;
          zPower[0] = 1;
          zPower[1] = dz;
          zPower[2] = dz * dz;
          zPower[3] = zPower[2] * dz;
          zPower[4] = zPower[3] * dz;
          const accumulator = shell.accumulator;
          accumulator.fill(0);
          for (const primitiveIndex of shell.primitiveIndices) {
            const primitive = primitives[primitiveIndex];
            const exponential = Math.exp(-primitive.alpha * r2);
            if (exponential === 0) continue;
            const terms = primitive.terms;
            for (let at = 0; at < terms.length; at += 1) {
              const term = terms[at];
              accumulator[term.component] += term.w * exponential
                * powers[0][term.i] * powers[1][term.j] * powers[2][term.k];
            }
          }
          const base = shell.offset;
          for (let at = 0; at < accumulator.length; at += 1) chi[base + at] = accumulator[at];
        }
        onPoint(chi, i + nx * (j + ny * k));
      }
    }
    if (onProgress) onProgress(k + 1, nz);
  }
  return counts;
}

function gridOf(grid, atoms) {
  if (!grid || !Array.isArray(grid.counts) || grid.counts.length !== 3) {
    throw new VolumeError('a grid from gridFor() is required (it carries origin, counts and step).');
  }
  if (![grid.step].every(finiteNumber) || !grid.counts.every((count) => Number.isInteger(count) && count > 1)) {
    throw new VolumeError('the grid has a non-numeric step or a count that is not an integer above 1.');
  }
  if (!Array.isArray(grid.origin) || !grid.origin.every(finiteNumber)) {
    throw new VolumeError('the grid has no finite origin.');
  }
  const inGrid = Array.isArray(grid.atoms) && grid.atoms.length ? grid.atoms : null;
  if (inGrid) return inGrid;
  if (Array.isArray(atoms) && atoms.length > 0) return atomsOf(atoms);
  throw new VolumeError('the grid does not carry atoms, so the shells cannot be placed; pass `atoms`.');
}

function conditionedBasis(shells, cartesianOrder) {
  const list = Array.isArray(shells)
    ? shells
    : (Array.isArray(shells?.shells) ? shells.shells : shellsFromCheckpoint(shells, { cartesianOrder }).shells);
  return prepareBasis(list, { cartesianOrder });
}

function allocation(grid, precision) {
  const points = grid.counts[0] * grid.counts[1] * grid.counts[2];
  if (precision === 'f32') return new Float32Array(points);
  if (precision !== 'f64') throw new VolumeError(`unknown precision "${precision}"; use "f32" or "f64".`);
  return new Float64Array(points);
}

/**
 * Evaluate one MO on the grid.
 *
 * @param {object} options
 * @param {Array|object} options.shells shell list, parsed Molden/checkpoint
 * @param {ArrayLike<number>} options.coefficients MO coefficients, one per
 *   basis function, in the file's order
 * @param {object} options.grid result of `gridFor`
 * @param {'gaussian'|'aim'} [options.cartesianOrder]
 * @param {number[]|object} [options.atoms] required when `grid` has no atoms
 * @param {'f64'|'f32'} [options.precision] `f64` (default) for values that will
 *   be integrated or differenced, `f32` for a field that will only be drawn
 * @param {(done: number, total: number) => void} [options.onProgress] called
 *   once per z-slab
 * @returns {Float64Array|Float32Array} ψ in a.u., index = i + nx*(j + ny*k)
 */
export function evaluateOrbital({
  shells,
  coefficients,
  grid,
  cartesianOrder = 'gaussian',
  atoms = null,
  precision = 'f64',
  onProgress = null,
} = {}) {
  const list = gridOf(grid, atoms);
  const basis = conditionedBasis(shells, cartesianOrder);
  const coefficientsArray = coefficientsOf(coefficients, basis.functionCount);
  const values = allocation(grid, precision);

  walkGrid(
    basis,
    { ...grid, atoms: list },
    {
      onProgress,
      onPoint: (chi, index) => {
        let total = 0;
        for (let at = 0; at < chi.length; at += 1) total += coefficientsArray[at] * chi[at];
        values[index] = total;
      },
    },
  );
  return values;
}

/**
 * Evaluate a density: Σ_i occ_i |ψ_i|², in e/bohr³.
 *
 * `coefficientsByMo` is one array per MO (the same layout `evaluateOrbital`
 * takes) and `occupations` one number per MO. Occupations may be fractional;
 * they are used as given, because a Mulliken-smeared occupation is still the
 * occupation the file states.
 *
 * @returns {Float64Array|Float32Array}
 */
export function evaluateDensity({
  shells,
  coefficientsByMo,
  occupations,
  grid,
  cartesianOrder = 'gaussian',
  atoms = null,
  precision = 'f64',
  onProgress = null,
} = {}) {
  const list = gridOf(grid, atoms);
  const basis = conditionedBasis(shells, cartesianOrder);
  if (!Array.isArray(coefficientsByMo) || coefficientsByMo.length === 0) {
    throw new VolumeError('a density needs at least one orbital (coefficientsByMo).');
  }
  if (!Array.isArray(occupations) || occupations.length !== coefficientsByMo.length) {
    throw new VolumeError(
      `a density needs one occupation per orbital: ${coefficientsByMo.length} orbitals, `
      + `${Array.isArray(occupations) ? occupations.length : 0} occupations.`,
    );
  }
  const orbitals = coefficientsByMo.map((coefficients, index) => ({
    coefficients: coefficientsOf(coefficients, basis.functionCount, `orbital ${index + 1}`),
    occupation: Number(occupations[index]),
  }));
  for (const orbital of orbitals) {
    if (!finiteNumber(orbital.occupation)) {
      throw new VolumeError('an occupation is not a finite number.');
    }
  }
  const values = allocation(grid, precision);

  walkGrid(
    basis,
    { ...grid, atoms: list },
    {
      onProgress,
      onPoint: (chi, index) => {
        let density = 0;
        for (const orbital of orbitals) {
          let psi = 0;
          for (let at = 0; at < chi.length; at += 1) psi += orbital.coefficients[at] * chi[at];
          density += orbital.occupation * psi * psi;
        }
        values[index] = density;
      },
    },
  );
  return values;
}

/* ── fields: values plus the geometry a renderer needs ────── */

/**
 * The uniform contract every renderer here consumes:
 *
 *   { kind, label, dims, origin, axes, step, values, signed, unit,
 *     stats, cellVolumeAngstrom3, cellVolumeBohr3 }
 *
 * `origin` and `axes` are Å; `values` is index = i + nx*(j + ny*k) with x
 * fastest, the same order `parseCube` returns and `cubeSlice` reads.
 */
export function fieldOfValues({
  kind = 'orbital',
  label = '',
  grid,
  values,
  signed = false,
  unit = 'a.u.',
  provenance = null,
}) {
  if (!grid || !Array.isArray(grid.counts)) throw new VolumeError('a field needs a grid.');
  const expected = grid.counts[0] * grid.counts[1] * grid.counts[2];
  if (values.length !== expected) {
    throw new VolumeError(`the field holds ${values.length} values for a ${grid.counts.join('×')} grid (${expected}).`);
  }
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const absMax = Math.max(Math.abs(min), Math.abs(max));
  return {
    kind,
    label,
    dims: [...grid.counts],
    origin: [...grid.origin],
    axes: grid.axes.map((axis) => [...axis]),
    step: grid.step,
    values,
    signed,
    unit,
    stats: { min, max, absMax },
    cellVolumeAngstrom3: grid.cellVolumeAngstrom3,
    cellVolumeBohr3: grid.cellVolumeBohr3,
    points: expected,
    provenance,
    units: { coordinates: 'angstrom', values: unit },
  };
}

/** Evaluate an orbital and return it as a renderable field. */
export function fieldFromOrbital(options) {
  const values = evaluateOrbital(options);
  const { grid, atoms, label, shells, coefficients, precision, ...rest } = options;
  const list = gridOf(grid, atoms);
  const meta = describeBasisShape(shells, rest.cartesianOrder ?? 'gaussian');
  return fieldOfValues({
    kind: 'orbital',
    label: label ?? 'orbital',
    grid: { ...grid, atoms: list },
    values,
    signed: true,
    unit: 'a.u.',
    provenance: { ...meta, coefficients: coefficients.length, precision: precision ?? 'f64' },
  });
}

/** Evaluate a density and return it as a renderable field. */
export function fieldFromDensity(options) {
  const values = evaluateDensity(options);
  const { grid, atoms, label, shells, coefficientsByMo, occupations, precision, ...rest } = options;
  const list = gridOf(grid, atoms);
  const meta = describeBasisShape(shells, rest.cartesianOrder ?? 'gaussian');
  return fieldOfValues({
    kind: 'density',
    label: label ?? 'electron density',
    grid: { ...grid, atoms: list },
    values,
    signed: false,
    unit: 'e/bohr^3',
    provenance: {
      ...meta,
      orbitals: coefficientsByMo.length,
      electrons: occupations.reduce((total, value) => total + Number(value), 0),
      precision: precision ?? 'f64',
    },
  });
}

function describeBasisShape(shells, cartesianOrder) {
  if (Array.isArray(shells)) {
    return { shells: shells.length, cartesianOrder };
  }
  const described = shellsFromCheckpoint(shells, { cartesianOrder });
  return {
    shells: described.shells.length,
    functions: described.numberOfBasisFunctions,
    spherical: described.spherical,
    cartesianOrder,
  };
}

/**
 * A parsed cube as the same field contract, so a user-supplied `.cube` goes
 * through the identical slice and surface path as a computed orbital.
 *
 * The cube's own values are kept (no rescaling); `signed` is read from the
 * data, because a cube of an orbital has both phases and a cube of a density
 * does not.
 */
export function fieldFromCube(cube, { label = null } = {}) {
  if (!cube || !Array.isArray(cube.dims) || !cube.values) {
    throw new VolumeError('fieldFromCube needs a parsed cube (see cubeFile.js).');
  }
  const [nx, ny, nz] = cube.dims.map(Number);
  const values = cube.values;
  if (values.length !== nx * ny * nz) {
    throw new VolumeError(`the cube declares ${nx}×${ny}×${nz} but holds ${values.length} values.`);
  }
  const axes = (cube.axes ?? [[cube.spacing ?? 1, 0, 0], [0, cube.spacing ?? 1, 0], [0, 0, cube.spacing ?? 1]])
    .map((axis) => axis.map(Number));
  const step = Math.hypot(...axes[0]);
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const volume = Math.abs(
    axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1])
    - axes[0][1] * (axes[1][0] * axes[2][2] - axes[1][2] * axes[2][0])
    + axes[0][2] * (axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]),
  );
  return {
    kind: 'cube',
    label: label ?? (cube.title ? String(cube.title).trim() : 'cube'),
    dims: [nx, ny, nz],
    origin: (cube.origin ?? [0, 0, 0]).map(Number),
    axes,
    step,
    values,
    signed: min < 0,
    unit: 'file units',
    stats: { min, max, absMax: Math.max(Math.abs(min), Math.abs(max)) },
    cellVolumeAngstrom3: volume,
    cellVolumeBohr3: volume * BOHR_PER_ANGSTROM ** 3,
    points: values.length,
    provenance: { source: 'cube', file: cube.title ?? null },
    units: { coordinates: 'angstrom', values: 'file units' },
    atoms: cube.atoms ?? [],
  };
}

/**
 * ∫ f dV in bohr³ — electrons when `f` is a density, and a normalisation check
 * when it is an orbital (pass `{square: true}` for ∫|ψ|², which is ≈1 for an
 * occupied MO and is the number the viewport prints). The grid's own volume
 * element is used, so the answer is as good as the box: a small box loses the
 * tail and says so through the number, not through a claim.
 */
export function integrateField(field, { square = false } = {}) {
  if (!field || !field.values) throw new VolumeError('integrateField needs a field.');
  let total = 0;
  const { values } = field;
  if (square) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      total += value * value;
    }
  } else {
    for (let index = 0; index < values.length; index += 1) total += values[index];
  }
  return total * field.cellVolumeBohr3;
}

/* ── slices ───────────────────────────────────────────────── */

const PLANE_AXES = Object.freeze({
  xy: { normal: 2, u: 0, v: 1 },
  xz: { normal: 1, u: 0, v: 2 },
  yz: { normal: 0, u: 1, v: 2 },
});

export const PLANES = Object.freeze(Object.keys(PLANE_AXES));

/**
 * One plane of a field, as rows of a rectangle: `values[row * width + column]`
 * with `column` along `axes[0]` and `row` along `axes[1]`, row 0 at the
 * *lowest* coordinate of the second axis.
 *
 * `offset` is a fraction of the grid along the normal (0 = the first point,
 * 1 = the last), because a slider cannot know the index count in advance.
 *
 * @returns {{plane: string, index: number, offset: number, width: number,
 *   height: number, values: Float64Array, axes: number[][], origin: number[],
 *   min: number, max: number, normal: number[]}}
 */
export function sliceOfField(field, { plane = 'xy', offset = 0.5 } = {}) {
  const spec = PLANE_AXES[plane];
  if (!spec) throw new VolumeError(`unknown slice plane "${plane}"; use ${PLANES.join(', ')}.`);
  const [nx, ny, nz] = field.dims;
  const sizes = [nx, ny, nz];
  const fraction = Math.min(1, Math.max(0, Number(offset)));
  if (!Number.isFinite(fraction)) throw new VolumeError('the slice offset must be a number from 0 to 1.');
  const index = Math.round(fraction * (sizes[spec.normal] - 1));
  const width = sizes[spec.u];
  const height = sizes[spec.v];
  const values = new Float64Array(width * height);
  const valuesAt = field.values;
  let min = Infinity;
  let max = -Infinity;
  const cell = [0, 0, 0];
  cell[spec.normal] = index;
  for (let row = 0; row < height; row += 1) {
    cell[spec.v] = row;
    for (let column = 0; column < width; column += 1) {
      cell[spec.u] = column;
      const value = valuesAt[cell[0] + nx * (cell[1] + ny * cell[2])];
      values[row * width + column] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const { origin, axes } = field;
  return {
    plane,
    index,
    offset: sizes[spec.normal] > 1 ? index / (sizes[spec.normal] - 1) : 0,
    width,
    height,
    values,
    min,
    max,
    normal: axes[spec.normal].slice(),
    axes: [axes[spec.u], axes[spec.v]],
    origin: [0, 1, 2].map((component) => origin[component] + axes[spec.normal][component] * index),
    units: field.units,
    label: field.label,
    signed: field.signed,
    unit: field.unit,
  };
}

/**
 * The plane through three atoms, as a normal and a point, plus the fraction
 * along the grid normal that comes closest to it. Three collinear atoms do not
 * define a plane and are refused rather than given an arbitrary one.
 */
export function planeThroughAtoms(atoms, [a, b, c] = []) {
  const list = Array.isArray(atoms) ? atoms : atoms?.atoms;
  if (!Array.isArray(list)) throw new VolumeError('planeThroughAtoms needs an atom list.');
  const at = (index) => {
    const atom = list[index];
    if (!atom) throw new VolumeError(`atom ${index + 1} does not exist; the geometry has ${list.length}.`);
    return [Number(atom.x), Number(atom.y), Number(atom.z)];
  };
  const p = at(a);
  const q = at(b);
  const r = at(c);
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const normal = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(...normal);
  if (!(length > 1e-8)) {
    throw new VolumeError(`atoms ${a + 1}, ${b + 1} and ${c + 1} are collinear, so they do not define a plane.`);
  }
  return {
    normal: normal.map((value) => value / length),
    point: [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3],
    atoms: [a, b, c],
    collinear: false,
  };
}

/**
 * The closest grid plane to an arbitrary plane, chosen by aligning the plane
 * normal with the nearest grid axis and taking the offset that puts the plane's
 * point on it. Returned with the distance from the requested plane, so the
 * viewport can say "nearest grid plane, 0.14 Å away" instead of implying the
 * slice is exactly through the atoms.
 */
export function nearestGridPlane(field, plane) {
  if (!plane || !Array.isArray(plane.normal)) throw new VolumeError('nearestGridPlane needs a plane from planeThroughAtoms.');
  const axis = plane.normal.reduce((best, value, index) => (
    Math.abs(value) > Math.abs(plane.normal[best]) ? index : best
  ), 0);
  const name = ['yz', 'xz', 'xy'][axis];
  const spec = PLANE_AXES[name];
  const { origin, axes, dims } = field;
  const sizes = dims;
  // Position of the plane's point along the grid normal, in index units.
  const offsetVector = [0, 1, 2].map((component) => plane.point[component] - origin[component]);
  const stepLength = Math.hypot(...axes[spec.normal]) || 1;
  const distance = (offsetVector[0] * axes[spec.normal][0]
    + offsetVector[1] * axes[spec.normal][1]
    + offsetVector[2] * axes[spec.normal][2]) / stepLength ** 2;
  const index = Math.min(sizes[spec.normal] - 1, Math.max(0, Math.round(distance)));
  const planeOrigin = [0, 1, 2].map((component) => origin[component] + axes[spec.normal][component] * index);
  const separation = Math.abs(
    (plane.point[0] - planeOrigin[0]) * plane.normal[0]
    + (plane.point[1] - planeOrigin[1]) * plane.normal[1]
    + (plane.point[2] - planeOrigin[2]) * plane.normal[2],
  );
  return {
    plane: name,
    index,
    offset: sizes[spec.normal] > 1 ? index / (sizes[spec.normal] - 1) : 0,
    separationAngstrom: separation,
    normal: axes[spec.normal].slice(),
  };
}
