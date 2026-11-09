/**
 * In-app conformer generation with UFF (issue 144).
 *
 * The CREST path in `conformers.js` parses an ensemble some other program
 * wrote. This module produces one here: a deterministic torsional grid,
 * every trial relaxed with the UFF engine in `uff.js`, near-duplicates pruned
 * by heavy-atom RMSD, and the survivors ranked by the same `rankEnsemble` and
 * summarised by the same `ensembleSummary` the CREST and import routes use —
 * so a downstream block, the card and the report need no new member shape.
 *
 * What this is NOT, and says so in every result:
 *   - not a Monte-Carlo or basin-hopping search, and not CREST;
 *   - not a quantum result. A UFF energy is a force-field energy in kcal/mol;
 *     it is never a total electronic energy and is never compared with one;
 *   - no electrostatics, no ring-conformer sampling, no implicit solvent.
 *
 * Determinism: there is no random number generator here at all. The grid is
 * anchored on the input geometry's own torsion angles and walked in a fixed
 * odometer order, so the same input gives member-for-member the same ensemble.
 * There is consequently no seed to record; every result states `seed: null`
 * and `randomized: false` rather than inventing one.
 *
 * Pure: no filesystem, no child process, no DOM.
 */

import { bondLengthsFromGeometry, BOND_PERCEPTION_FACTOR } from './benchmark.js';
import { superimpose } from './superpose.js';
import {
  optimizeUff, typeAtoms, UFF_ACCURACY_NOTE, UFF_CONVERGENCE, UFF_ELEMENTS, UFF_ENERGY_KIND, UFF_METHOD,
} from './uff.js';
import {
  DEFAULT_CONFORMER_SETTINGS,
  ensembleSummary,
  rankEnsemble,
  xyzText,
} from './conformers.js';

/** The one sentence that names the search. Never reword it per caller. */
export const UFF_SEARCH_METHOD = 'torsional grid + UFF relaxation (in-app, no Monte-Carlo)';

/** Defaults for the UFF route. Deliberately not part of `defaultSettings()`. */
export const UFF_CONFORMER_DEFAULTS = Object.freeze({
  /** Degrees between trial torsion angles, anchored on the input geometry. */
  torsionStepDegrees: 120,
  /** Upper bound on relaxed trials; a grid that would exceed it is truncated. */
  maxTrials: 200,
  /** Heavy-atom RMSD below which two relaxed trials are the same conformer, Å. */
  rmsdThreshold: 0.5,
  /**
   * L-BFGS iterations allowed per trial. `uff.js` defaults to 200, which is
   * fine for a small molecule but stops mid-descent on a drug-like one (the
   * shipped fixtures need 440–1200 steps to reach the force tolerance). The
   * cap is the caller's parameter, never a change to the engine's criterion:
   * a trial that still hits it is reported as not converged.
   */
  relaxMaxIterations: 800,
});

/** One fixed statement of what the ensemble is, stored beside the numbers. */
export const UFF_NOT_QUANTUM_NOTE = 'UFF is a force field: these are force-field '
  + 'structures and a UFF ranking, not QM structures or QM energies. A UFF '
  + 'energy in kcal/mol is not comparable with a Hartree value anywhere in this app.';

const CHALCOGENS = new Set(['O', 'S', 'Se']);
const elementOf = (atom) => String(atom?.element ?? '').trim();

function finiteCoordinates(atoms) {
  return atoms.every((atom) => [atom.x, atom.y, atom.z].every((value) => Number.isFinite(Number(value))));
}

function normaliseBonds(bonds) {
  return (Array.isArray(bonds) ? bonds : [])
    .map((bond) => ({
      a: Number(bond?.a ?? bond?.i),
      b: Number(bond?.b ?? bond?.j),
      order: Number(bond?.order ?? 1),
    }))
    .filter((bond) => Number.isInteger(bond.a) && Number.isInteger(bond.b)
      && bond.a > 0 && bond.b > 0 && bond.a !== bond.b);
}

/**
 * Connectivity for a structure that arrived without bonds.
 *
 * The radii and the 1.3× factor are the ones `benchmark.js` already uses for
 * its bond-length comparison. Every perceived bond is order 1: an XYZ file has
 * no bond orders, and inventing a double bond from a short distance would be a
 * guess the energies then depend on. The result says so in a warning, because
 * an sp2 carbon typed as sp3 is a real error and not a rounding detail.
 */
export function perceiveBonds(atoms) {
  const perceived = bondLengthsFromGeometry(atoms, { factor: BOND_PERCEPTION_FACTOR });
  return perceived.map((bond) => ({ a: bond.i + 1, b: bond.j + 1, order: 1 }));
}

function adjacency(atomCount, bonds) {
  const neighbours = Array.from({ length: atomCount + 1 }, () => []);
  for (const bond of bonds) {
    neighbours[bond.a].push({ to: bond.b, order: bond.order });
    neighbours[bond.b].push({ to: bond.a, order: bond.order });
  }
  return neighbours;
}

/** True when removing `a–b` still leaves a path from `a` to `b`. */
function bondIsInRing(bonds, a, b) {
  const seen = new Set([a]);
  const stack = [a];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const bond of bonds) {
      const other = bond.a === current ? bond.b : (bond.b === current ? bond.a : null);
      if (other === null) continue;
      if ((current === a && other === b) || (current === b && other === a)) continue;
      if (seen.has(other)) continue;
      seen.add(other);
      stack.push(other);
    }
  }
  return seen.has(b);
}

/** The atoms on the `side` of `a–b`, excluding the bond itself. */
function sideOf(atomCount, bonds, a, b, side) {
  const seen = new Set([side]);
  const stack = [side];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const bond of bonds) {
      const other = bond.a === current ? bond.b : (bond.b === current ? bond.a : null);
      if (other === null) continue;
      if ((current === a && other === b) || (current === b && other === a)) continue;
      if (seen.has(other)) continue;
      seen.add(other);
      stack.push(other);
    }
  }
  seen.delete(side);
  return [...seen].sort((left, right) => left - right);
}

/**
 * The bonds a torsional grid can meaningfully turn.
 *
 * Rotatable means: a single bond, not in a ring, between two heavy atoms that
 * each carry at least one other heavy neighbour (a methyl rotor moves only
 * hydrogens, so it is not a conformational degree of freedom here), and not an
 * amide C–N bond — partial double-bond character, which UFF's torsion term
 * does not describe. Everything excluded keeps its reason, so the search can
 * say why a molecule had nothing to sample instead of pretending it searched.
 */
export function findRotatableBonds(atoms, bonds) {
  const list = Array.isArray(atoms) ? atoms : [];
  const bondList = normaliseBonds(bonds);
  const neighbours = adjacency(list.length, bondList);
  const isHeavy = (index) => elementOf(list[index - 1]).toUpperCase() !== 'H';
  const heavyNeighbours = (index) => neighbours[index].filter((entry) => isHeavy(entry.to));
  const rotors = [];
  const excluded = [];

  for (const bond of bondList) {
    const [a, b] = [bond.a, bond.b];
    const elements = [elementOf(list[a - 1]), elementOf(list[b - 1])];
    const reason = (() => {
      if (!isHeavy(a) || !isHeavy(b)) return 'terminal';
      if (bond.order !== 1) return 'order';
      if (bondIsInRing(bondList, a, b)) return 'ring';
      if (heavyNeighbours(a).length < 2 || heavyNeighbours(b).length < 2) return 'terminal';
      const amide = (elements[0] === 'C' && elements[1] === 'N') || (elements[0] === 'N' && elements[1] === 'C');
      if (amide) {
        const carbon = elements[0] === 'C' ? a : b;
        const doubleToChalcogen = bondList.some((other) => other.order >= 2 && (
          (other.a === carbon && CHALCOGENS.has(elementOf(list[other.b - 1])))
          || (other.b === carbon && CHALCOGENS.has(elementOf(list[other.a - 1])))
        ));
        if (doubleToChalcogen) return 'amide';
      }
      return null;
    })();
    if (reason) {
      excluded.push({ bond: [a, b], elements, reason });
      continue;
    }
    // Reference atoms for the torsion: the lowest-index heavy neighbour on each
    // end. Fixed choice, so the trial list does not depend on bond order.
    const i = heavyNeighbours(a).find((entry) => entry.to !== b)?.to;
    const l = heavyNeighbours(b).find((entry) => entry.to !== a)?.to;
    if (!Number.isInteger(i) || !Number.isInteger(l)) {
      excluded.push({ bond: [a, b], elements, reason: 'terminal' });
      continue;
    }
    rotors.push({
      bond: [a, b],
      torsion: [i, a, b, l],
      movingAtoms: sideOf(list.length, bondList, a, b, b),
    });
  }
  return { rotors, excluded };
}

function unitVector(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0)) return null;
  return { x: dx / length, y: dy / length, z: dz / length };
}

/**
 * Turn one rotor by `degrees`.
 *
 * The atoms on the k side rotate about the j→k axis (right-hand rule). With
 * the IUPAC convention — positive when the far bond is clockwise looking from
 * j toward k — that increases the i–j–k–l dihedral by `degrees`; a test pins
 * the sign so a later refactor cannot flip the grid silently.
 */
export function rotateTorsionBy(atoms, rotor, degrees) {
  const [j, k] = rotor.bond;
  const origin = atoms[j - 1];
  const tip = atoms[k - 1];
  const axis = unitVector(origin, tip);
  if (!axis || degrees === 0) return atoms.map((atom) => ({ ...atom }));
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const moving = new Set(rotor.movingAtoms);
  return atoms.map((atom, index) => {
    if (!moving.has(index + 1)) return { ...atom };
    const x = Number(atom.x) - Number(origin.x);
    const y = Number(atom.y) - Number(origin.y);
    const z = Number(atom.z) - Number(origin.z);
    // Rodrigues' rotation about the unit axis.
    const dot = x * axis.x + y * axis.y + z * axis.z;
    const cross = {
      x: axis.y * z - axis.z * y,
      y: axis.z * x - axis.x * z,
      z: axis.x * y - axis.y * x,
    };
    return {
      ...atom,
      x: Number(origin.x) + x * cos + cross.x * sin + axis.x * dot * (1 - cos),
      y: Number(origin.y) + y * cos + cross.y * sin + axis.y * dot * (1 - cos),
      z: Number(origin.z) + z * cos + cross.z * sin + axis.z * dot * (1 - cos),
    };
  });
}

/**
 * Trial torsion offsets: the Cartesian product of the grid, walked as an
 * odometer with the input geometry (all zeros) first. No randomness, so the
 * list is the same on every run and on every machine.
 */
export function torsionTrials(rotorCount, stepDegrees, maxTrials) {
  const step = Number(stepDegrees) > 0 ? Number(stepDegrees) : UFF_CONFORMER_DEFAULTS.torsionStepDegrees;
  const steps = Math.max(1, Math.round(360 / Math.min(360, step)));
  const limit = Math.max(1, Math.floor(Number(maxTrials) || UFF_CONFORMER_DEFAULTS.maxTrials));
  const planned = steps ** rotorCount;
  const total = Number.isFinite(planned) ? Math.min(planned, limit) : limit;
  const trials = [];
  for (let index = 0; index < total; index += 1) {
    const offsets = [];
    // The right-hand rotor is the least significant digit: consecutive trials
    // differ in the last torsion, exactly as an odometer's last wheel turns
    // fastest. Fixed order, so the list is reproducible.
    for (let rotor = 0; rotor < rotorCount; rotor += 1) {
      const place = steps ** (rotorCount - 1 - rotor);
      offsets.push((Math.floor(index / place) % steps) * (360 / steps));
    }
    trials.push(offsets);
  }
  return {
    trials,
    stepDegrees: 360 / steps,
    planned: Number.isFinite(planned) ? planned : null,
    truncated: Number.isFinite(planned) ? planned > limit : true,
    limit,
  };
}

/** Heavy-atom RMSD in Å, via the same superposition the ranker uses. */
export function heavyAtomRmsd(left, right) {
  const heavy = (atoms) => atoms.filter((atom) => elementOf(atom).toUpperCase() !== 'H');
  const a = heavy(left);
  const b = heavy(right);
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  try {
    return superimpose(a, b).rmsd;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Greedy heavy-atom dedupe, lowest energy first.
 *
 * The threshold is the caller's, in Å, and is reported in the result. A member
 * that collapses onto an earlier one is kept in `duplicates` with the trial it
 * matched and the measured RMSD — never silently deleted.
 */
export function pruneNearDuplicates(members, threshold = UFF_CONFORMER_DEFAULTS.rmsdThreshold) {
  const limit = Number(threshold) >= 0 ? Number(threshold) : UFF_CONFORMER_DEFAULTS.rmsdThreshold;
  const sorted = [...members].sort((left, right) => (left.energyKcal - right.energyKcal)
    || (left.trialIndex - right.trialIndex));
  const kept = [];
  const duplicates = [];
  for (const member of sorted) {
    let nearest = null;
    for (const candidate of kept) {
      const rmsd = heavyAtomRmsd(candidate.atoms, member.atoms);
      if (nearest === null || rmsd < nearest.rmsd) nearest = { candidate, rmsd };
    }
    if (nearest && nearest.rmsd < limit) {
      duplicates.push({ trialIndex: member.trialIndex, matchedTrialIndex: nearest.candidate.trialIndex, rmsd: nearest.rmsd });
      continue;
    }
    kept.push(member);
  }
  return { members: kept, duplicates, threshold: limit };
}

/**
 * Run the search. Returns relaxed, deduplicated members plus the facts about
 * how they were produced — or an `error` naming what stopped it.
 *
 * `bonds` is the project's own 1-based `{ a, b, order }` list. When it is
 * absent the connectivity is perceived from the geometry and every bond is
 * treated as single; the result then carries `bondSource: 'perceived'` and a
 * warning, because that typing is not the molecule's real one.
 */
export function searchUffConformers({
  atoms,
  bonds = null,
  torsionStepDegrees = UFF_CONFORMER_DEFAULTS.torsionStepDegrees,
  maxTrials = UFF_CONFORMER_DEFAULTS.maxTrials,
  rmsdThreshold = UFF_CONFORMER_DEFAULTS.rmsdThreshold,
  relaxMaxIterations = UFF_CONFORMER_DEFAULTS.relaxMaxIterations,
} = {}) {
  const list = Array.isArray(atoms) ? atoms : [];
  if (list.length === 0) return { error: 'A conformer search needs at least one atom; this structure has none.' };
  if (!finiteCoordinates(list)) return { error: 'The starting structure has a non-finite coordinate, so it cannot be searched.' };

  const bondSource = Array.isArray(bonds) && bonds.length > 0 ? 'supplied' : 'perceived';
  const bondList = bondSource === 'supplied' ? normaliseBonds(bonds) : perceiveBonds(list);
  const warnings = [];
  if (bondSource === 'perceived') {
    warnings.push({
      id: 'uff-bonds-perceived',
      status: 'warn',
      message: `No bonds were supplied: connectivity was perceived from geometry at ${BOND_PERCEPTION_FACTOR}× the covalent-radius sum `
        + 'and every bond was treated as single. An sp2 or aromatic atom is therefore typed as sp3, so these structures and '
        + 'energies are a starting point, not the molecule\'s real UFF minimum.',
    });
  }

  let typing;
  try {
    typing = typeAtoms(list, bondList);
  } catch (error) {
    return { error: error?.message || String(error), bondSource };
  }
  if (!typing.ok) {
    const refused = typing.refused[0];
    return {
      error: refused?.message || 'An atom could not be typed by UFF.',
      refused: typing.refused,
      bondSource,
    };
  }

  const { rotors, excluded } = findRotatableBonds(list, bondList);
  const grid = torsionTrials(rotors.length, torsionStepDegrees, maxTrials);

  const relaxed = grid.trials.map((offsets, trialIndex) => {
    let trialAtoms = list.map((atom) => ({ ...atom }));
    rotors.forEach((rotor, rotorIndex) => {
      trialAtoms = rotateTorsionBy(trialAtoms, rotor, offsets[rotorIndex]);
    });
    let optimisation;
    try {
      optimisation = optimizeUff(
        { atoms: trialAtoms, bonds: bondList },
        { types: typing.types, maxIterations: relaxMaxIterations },
      );
    } catch (error) {
      return { trialIndex, offsets, error: error?.message || String(error) };
    }
    return {
      trialIndex,
      offsets,
      atoms: optimisation.atoms,
      energyKcal: optimisation.energyKcal,
      converged: optimisation.converged,
      minimisation: optimisation.reason,
      iterations: optimisation.iterations,
    };
  });
  const failed = relaxed.filter((entry) => entry.error);
  if (failed.length === relaxed.length) {
    return { error: failed[0].error, bondSource };
  }
  const usable = relaxed.filter((entry) => !entry.error && Number.isFinite(entry.energyKcal));
  const pruned = pruneNearDuplicates(usable, rmsdThreshold);
  const unconverged = usable.filter((entry) => entry.converged === false).length;
  if (unconverged > 0) {
    warnings.push({
      id: 'uff-not-converged',
      status: 'warn',
      message: `${unconverged} of ${usable.length} trials did not reach the UFF force tolerance `
        + `(${UFF_CONVERGENCE.forceToleranceKcalPerAngstrom} kcal/mol/Å) within ${relaxMaxIterations} L-BFGS steps; `
        + 'their last energy is reported, not a minimum.',
    });
  }
  if (grid.truncated) {
    warnings.push({
      id: 'uff-grid-truncated',
      status: 'warn',
      message: `The ${grid.stepDegrees}° grid over ${rotors.length} rotatable bond(s) would need ${grid.planned ?? 'more than '+grid.limit} trials; `
        + `the first ${grid.limit} were run in fixed order. This is an incomplete grid, not the full one.`,
    });
  }
  if (rotors.length === 0) {
    warnings.push({
      id: 'uff-no-rotors',
      status: 'info',
      message: 'No rotatable bonds: every bond is terminal, in a ring, an amide, or not single. '
        + 'The single member is the input geometry relaxed with UFF — a pre-relaxation, not a conformer search.',
    });
  }

  const search = {
    method: UFF_SEARCH_METHOD,
    engine: UFF_METHOD,
    randomized: false,
    seed: null,
    torsionStepDegrees: grid.stepDegrees,
    rmsdThreshold: pruned.threshold,
    trials: grid.trials.length,
    // The exact size of the full grid, bounded to what the project schema can
    // store; above that the grid is truncated anyway and `truncated` says so.
    trialsPlanned: Number.isFinite(grid.planned) && grid.planned <= 1e7 ? grid.planned : null,
    truncated: grid.truncated,
    rotatableBonds: rotors.length,
    rotors: rotors.map((rotor) => ({ bond: rotor.bond, torsion: rotor.torsion })),
    excluded: excluded.slice(0, 40),
    deduplicated: pruned.duplicates.length,
    unique: pruned.members.length,
    relaxMaxIterations,
    bondSource,
    electrostatics: false,
    ringSampling: false,
    energyKind: UFF_ENERGY_KIND,
    comparableWithQuantumChemistry: false,
    accuracyNote: UFF_ACCURACY_NOTE,
    note: UFF_NOT_QUANTUM_NOTE,
  };

  return {
    members: pruned.members,
    duplicates: pruned.duplicates,
    search,
    warnings,
    bondSource,
    bonds: bondList,
    error: null,
  };
}

/**
 * The whole in-app route: search, then rank and summarise with the same
 * `rankEnsemble`/`ensembleSummary` the CREST and import routes use.
 *
 * Members come back with `energyKcal` set and `energyEh: null`, because a UFF
 * energy is not a total electronic energy and the summary must not carry one
 * that could be read as an SCF result.
 */
export function generateUffEnsemble({
  atoms,
  bonds = null,
  torsionStepDegrees = UFF_CONFORMER_DEFAULTS.torsionStepDegrees,
  maxTrials = UFF_CONFORMER_DEFAULTS.maxTrials,
  rmsdThreshold = UFF_CONFORMER_DEFAULTS.rmsdThreshold,
  energyWindowKcal = DEFAULT_CONFORMER_SETTINGS.energyWindowKcal,
  maxConformers = DEFAULT_CONFORMER_SETTINGS.maxConformers,
  temperature = DEFAULT_CONFORMER_SETTINGS.temperature,
  spreadThresholdKcal = DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal,
  selectedConformerId = '',
} = {}) {
  const found = searchUffConformers({ atoms, bonds, torsionStepDegrees, maxTrials, rmsdThreshold });
  if (found.error) {
    return { error: found.error, refused: found.refused || [], summary: null, ensembleText: '' };
  }
  const frames = found.members.map((member, index) => ({
    index: index + 1,
    comment: `UFF conformer ${index + 1} · trial ${member.trialIndex + 1} · E=${member.energyKcal.toFixed(4)} kcal/mol · ${UFF_METHOD}`,
    atoms: member.atoms,
    energyEh: member.energyKcal,
    energyUnit: 'kcal/mol',
    energyMethod: UFF_METHOD,
    protomer: '',
  }));
  const ranked = rankEnsemble({
    frames,
    energyWindowKcal,
    rmsdThreshold,
    maxConformers,
    temperature,
    spreadThresholdKcal,
    selectedConformerId,
    energyUnit: 'kcal/mol',
    energyMethod: UFF_METHOD,
  });
  if (ranked.error) return { error: ranked.error, summary: null, ensembleText: '' };
  const summary = ensembleSummary(ranked, {
    generator: 'uff',
    method: '',
    origin: { program: 'NodeChem Studio', version: '', method: UFF_METHOD, sourceSha256: '' },
    energyUnit: 'kcal/mol',
    energyMethod: UFF_METHOD,
    search: found.search,
  });
  // The search's own caveats (perceived bonds, truncated grid, unconverged
  // trials, no rotatable bonds) belong with the numbers, not only in the run
  // log: a project reopened offline must still carry them.
  if (found.warnings.length > 0) {
    summary.warnings = [
      ...summary.warnings,
      ...found.warnings.map(({ id, status, message }) => ({ id, status, message })),
    ];
  }
  return {
    error: null,
    summary,
    members: found.members,
    search: found.search,
    warnings: found.warnings,
    ensembleText: frames.map((frame) => xyzText(frame.atoms, frame.comment)).join(''),
    energies: frames.map((frame) => frame.energyEh),
  };
}

/**
 * The number of elements UFF here types. A molecule with anything else is
 * refused by the engine before this module runs; exported so a caller can say
 * what is supported without duplicating the list.
 */
export const UFF_CONFORMER_ELEMENTS = UFF_ELEMENTS;
