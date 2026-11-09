/**
 * ADR 0001 §2.10 — minimise one structure with a scorer's energy and forces.
 *
 * This is L-BFGS with an Armijo backtracking line search, a per-step
 * displacement cap and an explicit convergence statement. The scorer supplies
 * energy (eV) and forces (eV/Å); the gradient is `-forces`. Nothing here assumes
 * a functional form, so the caller can put AIMNet2 or any other scorer behind
 * `evaluate`.
 */

import { EV_TO_HARTREE, EV_TO_KCAL } from './scorer.js';

export const ML_RELAX_CONVERGENCE = Object.freeze({
  forceToleranceEvPerAngstrom: 0.03,
  maxIterations: 120,
  maxStepAngstrom: 0.15,
  memory: 8,
});

export async function relaxWithForces({
  atoms,
  charge = 0,
  multiplicity = 1,
  evaluate,
  forceToleranceEvPerAngstrom = ML_RELAX_CONVERGENCE.forceToleranceEvPerAngstrom,
  maxIterations = ML_RELAX_CONVERGENCE.maxIterations,
  maxStepAngstrom = ML_RELAX_CONVERGENCE.maxStepAngstrom,
  memory = ML_RELAX_CONVERGENCE.memory,
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(atoms) || atoms.length === 0) {
    return { error: 'The scorer relaxation has no atoms.' };
  }
  if (typeof evaluate !== 'function') {
    return { error: 'The scorer relaxation has no energy/force function.' };
  }
  const positionCount = atoms.length * 3;
  let positions = Float64Array.from(atoms.flatMap((atom) => [atom.x, atom.y, atom.z]));
  const atomsAt = (coords) => atoms.map((atom, index) => ({
    ...atom,
    x: coords[3 * index],
    y: coords[3 * index + 1],
    z: coords[3 * index + 2],
  }));
  const evaluateAt = async (coords) => {
    const result = await evaluate(atomsAt(coords));
    const forces = Array.isArray(result?.forces) ? result.forces : null;
    if (!forces || forces.length !== atoms.length) {
      throw new Error(`The scorer returned no forces for ${atoms.length} atom(s); an ML relaxation needs them.`);
    }
    const gradient = new Float64Array(positionCount);
    forces.forEach((force, index) => {
      gradient[3 * index] = -Number(force[0]);
      gradient[3 * index + 1] = -Number(force[1]);
      gradient[3 * index + 2] = -Number(force[2]);
    });
    return {
      energyEv: Number(result.energyEv),
      energyKcal: Number(result.energyEv) * EV_TO_KCAL,
      energyHartree: Number(result.energyEv) * EV_TO_HARTREE,
      gradient,
      raw: result,
    };
  };

  let state = await evaluateAt(positions);
  if (!Number.isFinite(state.energyEv)) return { error: 'The scorer returned no finite energy.' };
  const initialEnergyEv = state.energyEv;
  const history = [];
  let iterations = 0;
  let reason = 'max-force-below-tolerance';
  onProgress({ iteration: 0, ...state });

  while (maxAbs(state.gradient) > forceToleranceEvPerAngstrom) {
    if (iterations >= maxIterations) { reason = 'iteration-cap'; break; }
    const direction = searchDirection(state.gradient, history);
    for (let axis = 0; axis < 3; axis += 1) {
      let mean = 0;
      for (let atom = 0; atom < atoms.length; atom += 1) mean += direction[3 * atom + axis];
      mean /= atoms.length;
      for (let atom = 0; atom < atoms.length; atom += 1) direction[3 * atom + axis] -= mean;
    }
    const largest = maxAbs(direction);
    const scale = largest > maxStepAngstrom ? maxStepAngstrom / largest : 1;
    for (let index = 0; index < positionCount; index += 1) direction[index] *= scale;
    const slope = dot(state.gradient, direction);
    if (!(slope < 0)) { reason = 'not-a-descent-direction'; break; }

    let step = 1;
    let candidate = null;
    let candidateState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const trial = Float64Array.from(positions, (value, index) => value + step * direction[index]);
      const evaluated = await evaluateAt(trial);
      if (Number.isFinite(evaluated.energyEv) && evaluated.energyEv <= state.energyEv + 1e-4 * step * slope) {
        candidate = trial;
        candidateState = evaluated;
        break;
      }
      step *= 0.5;
    }
    if (!candidateState) { reason = 'line-search-failed'; break; }
    const s = Float64Array.from({ length: positionCount }, (_, index) => candidate[index] - positions[index]);
    const y = Float64Array.from({ length: positionCount }, (_, index) => candidateState.gradient[index] - state.gradient[index]);
    const curvature = dot(s, y);
    if (curvature > 1e-10) {
      history.push({ s, y, inverseCurvature: 1 / curvature });
      if (history.length > memory) history.shift();
    }
    positions = candidate;
    state = candidateState;
    iterations += 1;
    onProgress({ iteration: iterations, ...state });
  }

  const converged = maxAbs(state.gradient) <= forceToleranceEvPerAngstrom;
  if (converged) reason = 'max-force-below-tolerance';
  return {
    error: null,
    atoms: atomsAt(positions),
    energyEv: state.energyEv,
    energyKcal: state.energyKcal,
    energyHartree: state.energyHartree,
    initialEnergyEv,
    iterations,
    converged,
    reason,
    forceToleranceEvPerAngstrom,
    maxIterations,
    maxStepAngstrom,
    provenance: state.raw?.provenance || null,
  };
}

function searchDirection(gradient, history) {
  const count = gradient.length;
  const q = Float64Array.from(gradient);
  const alphas = [];
  for (let entry = history.length - 1; entry >= 0; entry -= 1) {
    const { s, y, inverseCurvature } = history[entry];
    const alpha = inverseCurvature * dot(s, q);
    alphas[entry] = alpha;
    for (let index = 0; index < count; index += 1) q[index] -= alpha * y[index];
  }
  const newest = history[history.length - 1];
  let scale = 1;
  if (newest) {
    const yy = dot(newest.y, newest.y);
    if (yy > 1e-12) scale = dot(newest.s, newest.y) / yy;
  }
  for (let index = 0; index < count; index += 1) q[index] *= scale;
  for (let entry = 0; entry < history.length; entry += 1) {
    const { s, y, inverseCurvature } = history[entry];
    const beta = inverseCurvature * dot(y, q);
    const alpha = alphas[entry] || 0;
    for (let index = 0; index < count; index += 1) q[index] += (alpha - beta) * s[index];
  }
  return Float64Array.from(q, (value) => -value);
}

function dot(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

function maxAbs(values) {
  let max = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Math.abs(values[index]);
    if (value > max) max = value;
  }
  return max;
}
