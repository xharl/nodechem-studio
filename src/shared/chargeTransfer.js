/**
 * Charge-transfer character of an excited state, from its transition density.
 *
 * Issue 173, route B. Route A (`exciton.js`) couples two point dipoles and says
 * plainly that it cannot describe a charge-transfer band. This module answers the
 * other half: how much of the excitation the engine actually computed moves
 * charge from one fragment to the other.
 *
 * What is partitioned, exactly
 * ----------------------------
 * The object is the one-particle transition density matrix of the state, between
 * the ground state 0 and the excited state I, in the atomic-orbital basis:
 *
 *     D^{0I}_{μν} = Σ_{i∈occ} Σ_{a∈vir} C_{μi} t_{ia} C_{νa}
 *
 * with `t` the Tamm–Dancoff amplitudes the engine printed (Σ t² = 1). Its hole
 * and particle densities are
 *
 *     ρ_hole = D S Dᵀ ,   ρ_part = Dᵀ S D ,   tr(ρ_hole S) = tr(ρ_part S) = 1
 *
 * (`S` is the AO overlap. `D Dᵀ` is not the hole density: that product is taken
 * in the orbital-coefficient metric and does not trace to 1.)
 *
 * The partition is the Plasser–Lischka Ω-matrix [Plasser & Lischka, J. Chem.
 * Theory Comput. 8, 2777 (2012); TheoDORE's `Om_formula`]:
 *
 *     Mulliken (`Om_formula=1`):  Ω_μν = ½[(DS)_μν(SD)_μν + D_μν(SDS)_μν]
 *     Löwdin   (`Om_formula=2`):  Ω_μν = (S^{1/2} D S^{1/2})²_μν
 *
 * Both give Σ_{μν} Ω_μν = 1 for a normalized D. Summed over fragment blocks:
 *
 *     CT fraction = Σ_{A≠B} Ω_AB           (0…1: the share of the excitation
 *                                          whose hole and particle sit on
 *                                          different fragments)
 *     Ω (local)   = Σ_A Ω_AA = 1 − CT      the same number seen from the other
 *                                          side
 *     Λ           = Σ_A √(Ω_AA)            1 = the excitation sits on one
 *                                          fragment, √n_frag = shared equally,
 *                                          → 0 when the hole and the particle
 *                                          are on different fragments. Plasser
 *                                          defines Λ over atoms (libwfa's
 *                                          `LOCa`); it is evaluated over
 *                                          fragments here, because the question
 *                                          is which chromophore carries the
 *                                          excitation.
 *     Δq          = Σ_{μ∈A} (ρ_part − ρ_hole) S_μμ    [e], the net charge moved
 *
 * Two properties of these numbers are part of the answer, not footnotes:
 *
 * - A symmetric dimer delocalised equally over both fragments reads CT = 0.5 and
 *   Δq = 0: half the transition density is inter-fragment because the hole and
 *   the particle are each on both fragments, and no net charge has moved. A
 *   genuine CT state reads CT ≈ 1, |Δq| ≈ 1 and a small Λ. Reporting all four
 *   numbers is what lets a reader tell those apart.
 * - CT character is a property of the transition density at the level of theory
 *   that produced it (here TDA), not a measured quantity.
 *
 * Nothing is inferred. A state without a transition density is refused by name,
 * a run with one fragment is refused with the words `not modelled: no dimer
 * geometry`, and a partition that does not sum to one is refused rather than
 * reported as a fraction.
 */

import { basisFunctions } from './esp.js';
import { overlapMatrix, symmetricPower } from './epr.js';

/** The two partitions, in the order a card reports them. */
export const CT_PARTITIONS = Object.freeze(['lowdin', 'mulliken']);

/**
 * A normalized transition density partitions to 1 under both formulas. This is
 * the tolerance on that identity: it catches a truncated amplitude block or a
 * mis-indexed MO set, and it is far above the rounding of the eight printed
 * decimals (the worst value observed on the committed fixture is 2e-10).
 */
export const CT_NORMALISATION_TOLERANCE = 1e-3;

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function refusal(reason, detail = null) {
  return { modelled: false, reason, ...(detail ? { detail } : {}) };
}

/**
 * The transition-density amplitudes of one state as `{ nocc, nvir, tda, values }`,
 * or `null` when the state carries none.
 *
 * A block of the wrong length throws: "this state has no transition density" and
 * "this state's transition density is malformed" are different failures, and the
 * caller reports them differently.
 */
export function transitionDensityOf(state = {}) {
  const block = state?.transitionDensity;
  if (!block || typeof block !== 'object') return null;
  const nocc = Number(block.nocc);
  const nvir = Number(block.nvir);
  if (!Number.isInteger(nocc) || nocc < 1 || !Number.isInteger(nvir) || nvir < 1) {
    throw new Error('the transition density does not state its occupied and virtual dimensions.');
  }
  const values = block.values;
  if (!values || typeof values.length !== 'number') {
    throw new Error('the transition density carries no amplitudes.');
  }
  if (values.length !== nocc * nvir) {
    throw new Error(`the transition density holds ${values.length} amplitudes for a ${nocc}×${nvir} block.`);
  }
  return { nocc, nvir, tda: block.tda === true, values };
}

/**
 * Column-major molecular-orbital coefficients from a parsed checkpoint.
 *
 * The checkpoint stores the alpha set as one real array, orbital after orbital
 * (column-major): value `j*nbf + i` is coefficient i of orbital j. Occupied
 * orbitals come first, which is the ordering the amplitudes use as well — the
 * recording deck runs in C1 so there is no irrep blocking to undo.
 */
function molecularOrbitals(checkpoint) {
  const nbf = Number(checkpoint?.numberOfBasisFunctions);
  const coefficients = checkpoint?.alphaMOCoefficients;
  if (!Number.isInteger(nbf) || nbf < 1) {
    throw new Error('the checkpoint does not state how many basis functions it has.');
  }
  if (!coefficients || typeof coefficients.length !== 'number' || coefficients.length === 0) {
    throw new Error('the checkpoint carries no "Alpha MO coefficients", so there is no basis in which to '
      + 'expand the transition density.');
  }
  if (coefficients.length % nbf !== 0) {
    throw new Error(`"Alpha MO coefficients" holds ${coefficients.length} values, which is not a whole number `
      + `of ${nbf}-function orbitals.`);
  }
  return {
    nbf,
    nmo: coefficients.length / nbf,
    coefficient: (mu, column) => Number(coefficients[column * nbf + mu]),
  };
}

/**
 * Fragment ownership of every atom: `[{ id, label, atoms }]`, from the per-atom
 * label list the deck printed (`NCS-CTFRAG`).
 *
 * The labels arrive as one number per atom in the molecule's own order, so a
 * complex whose members are interleaved — which the atom-count layout of a
 * `complex` record cannot express — is read correctly here.
 */
export function fragmentOwnership(labels = [], { atomCount = null } = {}) {
  const list = Array.isArray(labels) ? labels : [];
  if (list.length === 0) return null;
  if (atomCount !== null && Number.isInteger(atomCount) && list.length !== atomCount) {
    throw new Error(`the fragment record covers ${list.length} atoms but the geometry has ${atomCount}.`);
  }
  const byId = new Map();
  list.forEach((raw, atom) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) {
      throw new Error(`atom ${atom + 1} carries the fragment label ${JSON.stringify(raw)}, which is not a `
        + 'whole number of at least 1.');
    }
    if (!byId.has(id)) byId.set(id, { id, atoms: [] });
    byId.get(id).atoms.push(atom);
  });
  return [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .map((fragment) => ({ ...fragment, label: `fragment ${fragment.id}` }));
}

/** Σ of every block of an Ω-matrix. */
function matrixTotal(matrix) {
  let sum = 0;
  for (const row of matrix) for (const value of row) sum += value;
  return sum;
}

/** CT, the local fraction and Λ of one Ω-matrix, with the blocks normalised to 1. */
function descriptorsOf(matrix, total) {
  const count = matrix.length;
  let cross = 0;
  let local = 0;
  for (let a = 0; a < count; a += 1) {
    for (let b = 0; b < count; b += 1) {
      if (a === b) local += matrix[a][b];
      else cross += matrix[a][b];
    }
  }
  let lambda = 0;
  if (total !== 0) {
    for (let a = 0; a < count; a += 1) lambda += Math.sqrt(Math.max(0, matrix[a][a] / total));
  }
  return {
    omega: total,
    localFraction: total === 0 ? null : local / total,
    ctFraction: total === 0 ? null : cross / total,
    lambda: total === 0 ? null : lambda,
    // Row A is "the hole on A", column B "the particle on B".
    blocks: matrix.map((row) => Array.from(row, (value) => (total === 0 ? null : value / total))),
  };
}

/**
 * One state: the Ω-matrix blocks in both partitions, the per-basis-function
 * populations of the hole and particle densities, and per-fragment weights.
 *
 * Every product is formed in a factored shape — `D = A t Bᵀ` with `A = C_occ`,
 * `B = C_vir` — so a state costs `O(nbf² (n_occ + n_vir))`, not `O(nbf³)`.
 */
function partitionState({ orbitals, t, overlap, root, fragmentOfFunction, fragmentCount }) {
  const { nbf } = orbitals;
  const { nocc, nvir, values } = t;
  const coef = orbitals.coefficient;

  // S·A, S·B, S^{1/2}·A, S^{1/2}·B — nbf × (nocc|nvir).
  const sa = new Float64Array(nbf * nocc);
  const sb = new Float64Array(nbf * nvir);
  const rootA = new Float64Array(nbf * nocc);
  const rootB = new Float64Array(nbf * nvir);
  for (let mu = 0; mu < nbf; mu += 1) {
    for (let i = 0; i < nocc; i += 1) {
      let sum = 0;
      let rootSum = 0;
      for (let nu = 0; nu < nbf; nu += 1) {
        const c = coef(nu, i);
        if (c === 0) continue;
        sum += overlap[mu * nbf + nu] * c;
        rootSum += root[mu * nbf + nu] * c;
      }
      sa[mu * nocc + i] = sum;
      rootA[mu * nocc + i] = rootSum;
    }
    for (let a = 0; a < nvir; a += 1) {
      let sum = 0;
      let rootSum = 0;
      for (let nu = 0; nu < nbf; nu += 1) {
        const c = coef(nu, nocc + a);
        if (c === 0) continue;
        sum += overlap[mu * nbf + nu] * c;
        rootSum += root[mu * nbf + nu] * c;
      }
      sb[mu * nvir + a] = sum;
      rootB[mu * nvir + a] = rootSum;
    }
  }

  // t·Bᵀ, t·(BᵀS) (nocc×nbf); S·A·t, S^{1/2}·A·t (nbf×nvir).
  const tb = new Float64Array(nocc * nbf);
  const tbs = new Float64Array(nocc * nbf);
  const sat = new Float64Array(nbf * nvir);
  const rootAt = new Float64Array(nbf * nvir);
  for (let i = 0; i < nocc; i += 1) {
    for (let nu = 0; nu < nbf; nu += 1) {
      let sumB = 0;
      let sumBS = 0;
      for (let a = 0; a < nvir; a += 1) {
        const value = values[i * nvir + a];
        if (value === 0) continue;
        sumB += value * coef(nu, nocc + a);
        sumBS += value * sb[nu * nvir + a];
      }
      tb[i * nbf + nu] = sumB;
      tbs[i * nbf + nu] = sumBS;
    }
  }
  for (let mu = 0; mu < nbf; mu += 1) {
    for (let a = 0; a < nvir; a += 1) {
      let sum = 0;
      let rootSum = 0;
      for (let i = 0; i < nocc; i += 1) {
        const value = values[i * nvir + a];
        if (value === 0) continue;
        sum += sa[mu * nocc + i] * value;
        rootSum += rootA[mu * nocc + i] * value;
      }
      sat[mu * nvir + a] = sum;
      rootAt[mu * nvir + a] = rootSum;
    }
  }

  // Gram matrices of the amplitudes: M_h[i][j] = Σ_a t_ia t_ja and
  // M_p[a][b] = Σ_i t_ia t_ib. Both are what the densities are built from.
  const mh = new Float64Array(nocc * nocc);
  for (let i = 0; i < nocc; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = 0;
      for (let a = 0; a < nvir; a += 1) sum += values[i * nvir + a] * values[j * nvir + a];
      mh[i * nocc + j] = sum;
      mh[j * nocc + i] = sum;
    }
  }
  const mp = new Float64Array(nvir * nvir);
  for (let a = 0; a < nvir; a += 1) {
    for (let b = 0; b <= a; b += 1) {
      let sum = 0;
      for (let i = 0; i < nocc; i += 1) sum += values[i * nvir + a] * values[i * nvir + b];
      mp[a * nvir + b] = sum;
      mp[b * nvir + a] = sum;
    }
  }

  // Populations per basis function. Mulliken is diag(ρS); Löwdin is
  // diag(S^{1/2} ρ S^{1/2}), which for ρ = c M cᵀ is a quadratic form in the
  // transformed coefficient block.
  const hole = new Float64Array(nbf);
  const particle = new Float64Array(nbf);
  const holeLowdin = new Float64Array(nbf);
  const particleLowdin = new Float64Array(nbf);
  for (let mu = 0; mu < nbf; mu += 1) {
    let hM = 0;
    let hL = 0;
    for (let i = 0; i < nocc; i += 1) {
      const ci = coef(mu, i);
      const rai = rootA[mu * nocc + i];
      for (let j = 0; j < nocc; j += 1) {
        const weight = mh[i * nocc + j];
        if (weight === 0) continue;
        hM += weight * ci * sa[mu * nocc + j];
        hL += weight * rai * rootA[mu * nocc + j];
      }
    }
    let pM = 0;
    let pL = 0;
    for (let a = 0; a < nvir; a += 1) {
      const ca = coef(mu, nocc + a);
      const rba = rootB[mu * nvir + a];
      for (let b = 0; b < nvir; b += 1) {
        const weight = mp[a * nvir + b];
        if (weight === 0) continue;
        pM += weight * ca * sb[mu * nvir + b];
        pL += weight * rba * rootB[mu * nvir + b];
      }
    }
    hole[mu] = hM;
    particle[mu] = pM;
    holeLowdin[mu] = hL;
    particleLowdin[mu] = pL;
  }

  // Ω blocks: Ω_μν, summed into the fragment block that owns μ and the one that
  // owns ν.
  const mulliken = Array.from({ length: fragmentCount }, () => new Float64Array(fragmentCount));
  const lowdin = Array.from({ length: fragmentCount }, () => new Float64Array(fragmentCount));
  for (let mu = 0; mu < nbf; mu += 1) {
    const from = fragmentOfFunction[mu];
    for (let nu = 0; nu < nbf; nu += 1) {
      let d = 0;
      let ds = 0;
      for (let i = 0; i < nocc; i += 1) {
        const c = coef(mu, i);
        if (c === 0) continue;
        d += c * tb[i * nbf + nu];
        ds += c * tbs[i * nbf + nu];
      }
      let sd = 0;
      let sds = 0;
      let x = 0;
      for (let a = 0; a < nvir; a += 1) {
        sd += sat[mu * nvir + a] * coef(nu, nocc + a);
        sds += sat[mu * nvir + a] * sb[nu * nvir + a];
        x += rootAt[mu * nvir + a] * rootB[nu * nvir + a];
      }
      const to = fragmentOfFunction[nu];
      mulliken[from][to] += 0.5 * (ds * sd + d * sds);
      lowdin[from][to] += x * x;
    }
  }

  const perFragment = (weights) => {
    const out = new Float64Array(fragmentCount);
    for (let mu = 0; mu < nbf; mu += 1) out[fragmentOfFunction[mu]] += weights[mu];
    return Array.from(out);
  };

  return {
    mulliken,
    lowdin,
    hole: { mulliken: perFragment(hole), lowdin: perFragment(holeLowdin) },
    particle: { mulliken: perFragment(particle), lowdin: perFragment(particleLowdin) },
  };
}

/**
 * The whole analysis: one entry per state that carries a transition density, or
 * the reason there is none.
 *
 * @param {object}   options
 * @param {object[]} options.states      parsed excited states (each may carry
 *                                       `transitionDensity` from the log)
 * @param {object}   options.checkpoint  parsed `.fchk` (MO coefficients, basis)
 * @param {number[]} options.fragments   fragment label of each atom, in the
 *                                       molecule's atom order
 * @param {string}   [options.level]     level of theory, for the card
 * @param {object[]} [options.atoms]     the run's atoms (`{ element }`), for the
 *                                       checkpoint cross-check
 */
export function chargeTransferReport({
  states = [], checkpoint = null, fragments = [], level = null, atoms = null,
} = {}) {
  const list = Array.isArray(states) ? states.filter((state) => state && typeof state === 'object') : [];

  if (!checkpoint || typeof checkpoint !== 'object') {
    return refusal('not modelled: no wavefunction (the run has no checkpoint)',
      'The transition density is a matrix over basis functions; without the checkpoint that carries the MO '
      + 'coefficients and the basis, it cannot be summed over atoms.');
  }

  const withDensity = [];
  for (const state of list) {
    let density;
    try {
      density = transitionDensityOf(state);
    } catch (error) {
      return refusal(`not modelled: state ${state?.index ?? '?'}: ${error.message}`,
        'A transition density of the wrong shape is refused, not read as if it were the recorded one.');
    }
    if (density) withDensity.push({ state, density });
  }
  if (withDensity.length === 0) {
    return refusal('not modelled: no transition density was recorded for any state',
      'A CT fraction needs the state\'s transition-density matrix. The run records one only when the block '
      + 'opted in (`recordTransitionDipoles`), and the log carries it in the `NCS-TDMAT` block.');
  }

  let ownership;
  try {
    ownership = fragmentOwnership(fragments, {
      atomCount: Number.isInteger(checkpoint.numberOfAtoms) ? checkpoint.numberOfAtoms : null,
    });
  } catch (error) {
    return refusal(`not modelled: ${error.message}`);
  }
  if (!ownership || ownership.length < 2) {
    // The words a monomer run gets: there is no second fragment to move charge to.
    return refusal('not modelled: no dimer geometry',
      'This run describes one structure and one fragment, so there is no second fragment for charge to move '
      + 'to. A CT fraction needs the fragment labels of a complex.');
  }
  if (ownership.length > 2) {
    return refusal(`not modelled: this analysis is a two-fragment model and the run declares ${ownership.length} fragments`,
      'The Ω-matrix of a many-fragment system is well defined, but the card answers a dimer question; merging '
      + 'fragments would be a different analysis, so it is refused rather than silently reduced.');
  }

  // The checkpoint must describe the geometry the TD run used: a checkpoint from
  // another job would partition the right transition density over the wrong atoms.
  if (Array.isArray(atoms) && atoms.length > 0 && Array.isArray(checkpoint.atoms)) {
    if (atoms.length !== checkpoint.atoms.length) {
      return refusal(`not modelled: the checkpoint describes ${checkpoint.atoms.length} atoms and this run ${atoms.length}`,
        'The transition density is written over the checkpoint\'s basis, so a checkpoint from a different '
        + 'geometry would partition it over the wrong atoms.');
    }
    for (let index = 0; index < atoms.length; index += 1) {
      const expected = String(atoms[index]?.element ?? '');
      const actual = checkpoint.atoms[index]?.element;
      if (expected && actual && expected.toLowerCase() !== String(actual).toLowerCase()) {
        return refusal(`not modelled: atom ${index + 1} is ${expected} in this run and ${actual} in the checkpoint`);
      }
    }
  }

  let basis;
  let orbitals;
  let overlap;
  let root;
  try {
    basis = basisFunctions(checkpoint);
    orbitals = molecularOrbitals(checkpoint);
    if (basis.count !== orbitals.nbf) {
      throw new Error(`the basis describes ${basis.count} functions but the checkpoint states ${orbitals.nbf}.`);
    }
    overlap = overlapMatrix(basis);
    root = symmetricPower(overlap, basis.count, 0.5);
  } catch (error) {
    return refusal(`not modelled: ${error.message}`);
  }

  const fragmentOfFunction = new Int32Array(basis.count).fill(-1);
  for (let mu = 0; mu < basis.count; mu += 1) {
    const atom = basis.atomOfFunction[mu];
    const owner = ownership.findIndex((fragment) => fragment.atoms.includes(atom));
    if (owner >= 0) fragmentOfFunction[mu] = owner;
  }
  if (fragmentOfFunction.some((owner) => owner < 0)) {
    return refusal('not modelled: a basis function belongs to an atom the fragment record does not cover');
  }

  const reported = [];
  for (const { state, density } of withDensity) {
    if (density.nocc + density.nvir > orbitals.nmo) {
      return refusal(`not modelled: state ${state.index ?? '?'} has ${density.nocc} occupied and `
        + `${density.nvir} virtual orbitals, but the checkpoint carries ${orbitals.nmo}`,
        'The amplitudes and the checkpoint describe different orbital spaces.');
    }
    if (!density.tda) {
      return refusal(`not modelled: state ${state.index ?? '?'} records a transition density that is not TDA`,
        'The amplitudes read here are the Tamm–Dancoff ones, where Σ X² = 1 makes the partition '
        + 'normalisable. A random-phase transition density carries de-excitations as well and is a different '
        + 'object.');
    }

    const partitioned = partitionState({
      orbitals,
      t: density,
      overlap,
      root,
      fragmentOfFunction,
      fragmentCount: ownership.length,
    });

    const totalM = matrixTotal(partitioned.mulliken);
    const totalL = matrixTotal(partitioned.lowdin);
    for (const [partition, total] of [['Mulliken', totalM], ['Löwdin', totalL]]) {
      if (!isNum(total) || Math.abs(total - 1) > CT_NORMALISATION_TOLERANCE) {
        return refusal(`not modelled: the ${partition} partition of state ${state.index ?? '?'} sums to `
          + `${isNum(total) ? total.toFixed(6) : 'a non-number'} instead of 1`,
          'A partition that does not account for the whole transition density would give a CT fraction that '
          + 'is not a fraction, so it is refused rather than reported.');
      }
    }

    const mulliken = descriptorsOf(partitioned.mulliken, totalM);
    const lowdin = descriptorsOf(partitioned.lowdin, totalL);
    const deltaQ = {
      lowdin: partitioned.particle.lowdin[0] - partitioned.hole.lowdin[0],
      mulliken: partitioned.particle.mulliken[0] - partitioned.hole.mulliken[0],
    };

    reported.push({
      index: Number.isInteger(Number(state.index)) ? Number(state.index) : null,
      label: [state.spin, state.symmetry ?? state.irrep].filter(Boolean).join('-') || null,
      energyEv: isNum(state.energyEv) ? state.energyEv : null,
      oscillatorStrength: isNum(state.oscillatorStrength) ? state.oscillatorStrength : null,
      // The headline numbers are the Löwdin partition, the one TheoDORE calls
      // "probably the best option in terms of numerical stability".
      partition: 'lowdin',
      ctFraction: lowdin.ctFraction,
      localFraction: lowdin.localFraction,
      lambda: lowdin.lambda,
      deltaQe: deltaQ.lowdin,
      omegaTotal: lowdin.omega,
      fragments: ownership.map((fragment, position) => ({
        fragment: fragment.id,
        hole: partitioned.hole.lowdin[position],
        particle: partitioned.particle.lowdin[position],
      })),
      // Both partitions, because a Mulliken number is basis-set sensitive and a
      // reader is entitled to see whether the conclusion depends on the choice.
      partitions: {
        lowdin: {
          ctFraction: lowdin.ctFraction,
          localFraction: lowdin.localFraction,
          lambda: lowdin.lambda,
          deltaQe: deltaQ.lowdin,
          hole: partitioned.hole.lowdin,
          particle: partitioned.particle.lowdin,
          blocks: lowdin.blocks,
        },
        mulliken: {
          ctFraction: mulliken.ctFraction,
          localFraction: mulliken.localFraction,
          lambda: mulliken.lambda,
          deltaQe: deltaQ.mulliken,
          hole: partitioned.hole.mulliken,
          particle: partitioned.particle.mulliken,
          blocks: mulliken.blocks,
        },
      },
    });
  }

  // How much the reported fraction depends on the partition. Printed on the card
  // so the reader is not handed a single number without its sensitivity.
  const partitionSpread = reported.reduce((worst, state) => Math.max(
    worst,
    Math.abs(state.partitions.lowdin.ctFraction - state.partitions.mulliken.ctFraction),
  ), 0);

  return {
    modelled: true,
    method: 'Plasser–Lischka Ω-matrix partition of the transition density',
    partition: 'lowdin',
    partitions: [...CT_PARTITIONS],
    // What the numbers are, in the module's own words, so a card cannot present
    // them as measured quantities.
    statement: `A property of the transition density at ${level ? `the ${level} level` : 'this level'} of theory `
      + '(Tamm–Dancoff amplitudes over the checkpoint\'s basis), not a measured quantity. '
      + 'The CT fraction, Ω and Λ depend on the partition; the Löwdin and Mulliken partitions are both '
      + 'reported, and the card names the one it quotes.',
    /** Largest difference between the two partitions' CT fraction, over all states. */
    partitionSpread,
    level,
    fragments: ownership.map((fragment) => ({ fragment: fragment.id, label: fragment.label, atoms: fragment.atoms.length })),
    states: reported,
  };
}

/** One state of a report, by index — the lookup the exciton card makes. */
export function chargeTransferOf(report, index) {
  if (!report || report.modelled !== true || !Array.isArray(report.states)) return null;
  const wanted = Number(index);
  return report.states.find((state) => state.index === wanted) || null;
}
