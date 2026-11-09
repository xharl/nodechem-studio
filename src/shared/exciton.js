/**
 * Excitonic coupling between two chromophores — point-dipole (Kasha) form.
 *
 * Issue 173, route A. The geometry of the coupling is a pure vector computation:
 * two transition dipole moments and the vector between the chromophores. Nothing
 * here touches an engine, and nothing here invents a dipole — a state without a
 * recorded transition dipole is refused by name, because |μ| can be recovered from
 * the oscillator strength but its *direction* cannot, and the direction is what
 * the coupling is made of.
 *
 * Units are explicit in every name and every return value. The prefactor is the
 * standard conversion for μ in debye and r in ångström:
 *
 *     J = 5030.0 · (μ̂₁·μ̂₂ − 3(μ̂₁·r̂)(μ̂₂·r̂)) · |μ₁||μ₂| / r³      [cm⁻¹]
 *
 * `5030.0` is the point-dipole constant in cm⁻¹ per D²·Å⁻³.
 */

import { centreOfMass } from './complex.js';

/** cm⁻¹ per (debye² · ångström⁻³) — the Kasha point-dipole constant. */
export const POINT_DIPOLE_PREFACTOR_CM = 5030.0;

/** 1 a.u. of electric dipole moment = 2.541746473 D (CODATA). */
export const DIPOLE_AU_TO_DEBYE = 2.541746473;

/**
 * Below this chromophore-separation / chromophore-extent ratio the point-dipole
 * approximation is not meaningful — the monomers overlap and the multipole
 * expansion has no small parameter. The value is stated, not tuned: Kasha's
 * treatment assumes r ≫ the molecular dimensions, and at r ≈ 2× the extent the
 * next multipole term is already of the same order.
 */
export const POINT_DIPOLE_MIN_RATIO = 3.0;

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function vector(value, field, unit) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${field} must be a 3-vector { x, y, z } in ${unit}.`);
  }
  const { x, y, z } = value;
  if (![x, y, z].every(isNum)) {
    throw new Error(`${field} must carry three finite numbers (x, y, z) in ${unit}.`);
  }
  return { x, y, z };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => Math.sqrt(dot(a, a));
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });

/**
 * The transition dipole of one excited state, in debye.
 *
 * Accepts either a vector already in debye (`transitionDipoleDebye`) or one in
 * atomic units as Psi4 stores it (`transitionDipoleAu`), converting explicitly.
 * A state with neither is refused: an oscillator strength is not a substitute.
 */
export function transitionDipoleOf(state = {}) {
  const name = state?.label ? `state ${state.label}` : 'this state';
  // A bare { x, y, z } is a dipole in debye: that is the only unit this module
  // accepts without being told, and every other shape must name its unit.
  const looksLikeVector = state && typeof state === 'object'
    && ('x' in state || 'y' in state || 'z' in state);
  if (looksLikeVector && !state.transitionDipoleDebye && !state.transitionDipoleAu) {
    const vectorDebye = vector(state, `${name}: transition dipole`, 'debye');
    const magnitude = norm(vectorDebye);
    if (!(magnitude > 0)) throw new Error(`${name} has a zero transition dipole; it cannot couple.`);
    return { vectorDebye, magnitudeDebye: magnitude, source: 'recorded' };
  }
  if (state?.transitionDipoleDebye) {
    const vectorDebye = vector(state.transitionDipoleDebye, `${name}: transitionDipoleDebye`, 'debye');
    const magnitude = norm(vectorDebye);
    if (!(magnitude > 0)) throw new Error(`${name} has a zero transition dipole; it cannot couple.`);
    return { vectorDebye, magnitudeDebye: magnitude, source: 'recorded' };
  }
  if (state?.transitionDipoleAu) {
    const au = vector(state.transitionDipoleAu, `${name}: transitionDipoleAu`, 'a.u.');
    const vectorDebye = scale(au, DIPOLE_AU_TO_DEBYE);
    const magnitude = norm(vectorDebye);
    if (!(magnitude > 0)) throw new Error(`${name} has a zero transition dipole; it cannot couple.`);
    return { vectorDebye, magnitudeDebye: magnitude, source: 'recorded (a.u. converted)' };
  }
  throw new Error(`no transition dipole is recorded for ${name}: point-dipole coupling needs the dipole `
    + 'vector, and its direction cannot be recovered from the oscillator strength. '
    + 'Record transition dipoles with the TD job, then couple.');
}

/**
 * Kasha point-dipole coupling between two transition dipoles.
 *
 * `separationAngstrom` is the vector from chromophore 1 to chromophore 2, in the
 * same frame as the dipoles.
 */
export function pointDipoleCoupling({ dipole1, dipole2, separationAngstrom } = {}) {
  const mu1 = transitionDipoleOf(dipole1);
  const mu2 = transitionDipoleOf(dipole2);
  const r = vector(separationAngstrom, 'separationAngstrom', 'ångström');
  const distance = norm(r);
  if (!(distance > 0)) {
    throw new Error('the two chromophores are at the same point: coupling is undefined (r = 0).');
  }
  const unitR = scale(r, 1 / distance);
  const unitMu1 = scale(mu1.vectorDebye, 1 / mu1.magnitudeDebye);
  const unitMu2 = scale(mu2.vectorDebye, 1 / mu2.magnitudeDebye);

  // κ = μ̂₁·μ̂₂ − 3(μ̂₁·r̂)(μ̂₂·r̂): −2 for parallel dipoles head to tail,
  // +1 for parallel dipoles stacked side by side, 0 for perpendicular ones.
  // The sign is kept, not normalised away — which component of the Davydov pair
  // sits lower is the physically meaningful half of the answer.
  const orientationFactor = dot(unitMu1, unitMu2) - 3 * dot(unitMu1, unitR) * dot(unitMu2, unitR);
  const couplingCm = POINT_DIPOLE_PREFACTOR_CM * orientationFactor
    * mu1.magnitudeDebye * mu2.magnitudeDebye / distance ** 3;

  return {
    couplingCm,
    orientationFactor,
    distanceAngstrom: distance,
    dipolesDebye: [mu1.magnitudeDebye, mu2.magnitudeDebye],
    method: 'point-dipole (Kasha)',
    units: { coupling: 'cm^-1', distance: 'angstrom', dipole: 'debye' },
  };
}

/**
 * Davydov splitting for two equivalent chromophores: the two dimer states sit at
 * ±J, so the split is 2|J| and the sign of J decides which component is lower.
 * Reported as a signed shift as well, because which component is red-shifted is
 * the physically meaningful half of the answer.
 */
export function davydovSplit(couplingCm) {
  if (!isNum(couplingCm)) throw new Error('davydovSplit needs a coupling in cm^-1.');
  return {
    splitCm: 2 * Math.abs(couplingCm),
    shiftCm: couplingCm,
    lowerComponentCm: -Math.abs(couplingCm),
    upperComponentCm: Math.abs(couplingCm),
  };
}

/**
 * Whether the point-dipole number is worth printing at all.
 *
 * The extent must be supplied by the caller (a molecular diameter, or the
 * distance between the outermost atoms of the chromophore) — guessing it from
 * the atom count would make the validity check itself a fabrication.
 */
export function pointDipoleValidity({ distanceAngstrom, extentAngstrom } = {}) {
  if (!isNum(distanceAngstrom) || distanceAngstrom <= 0) {
    throw new Error('validity needs a positive centre-to-centre distance in ångström.');
  }
  if (!isNum(extentAngstrom) || extentAngstrom <= 0) {
    throw new Error('validity needs the chromophore extent (its largest dimension) in ångström; '
      + 'it cannot be inferred from the atom count.');
  }
  const ratio = distanceAngstrom / extentAngstrom;
  return {
    ratio,
    threshold: POINT_DIPOLE_MIN_RATIO,
    valid: ratio >= POINT_DIPOLE_MIN_RATIO,
    note: ratio >= POINT_DIPOLE_MIN_RATIO
      ? `r/extent = ${ratio.toFixed(2)} ≥ ${POINT_DIPOLE_MIN_RATIO}: point-dipole coupling is defensible.`
      : `r/extent = ${ratio.toFixed(2)} < ${POINT_DIPOLE_MIN_RATIO}: the chromophores are not small compared `
        + 'with their separation, so the point-dipole number is an order-of-magnitude estimate only. '
        + 'A supersystem (transition-density) treatment is the honest route.',
  };
}

/**
 * One coupling report for a pair of states, refused when the geometry is not
 * justified — the card prints `not modelled` rather than a number with a caveat
 * that a reader will skip.
 */
export function excitonCoupling({ state1, state2, separationAngstrom, extent1Angstrom = null, extent2Angstrom = null } = {}) {
  const coupling = pointDipoleCoupling({
    dipole1: state1?.transitionDipoleDebye || state1,
    dipole2: state2?.transitionDipoleDebye || state2,
    separationAngstrom,
  });
  const split = davydovSplit(coupling.couplingCm);
  const extents = [extent1Angstrom, extent2Angstrom].filter(isNum);
  const validity = extents.length === 2
    ? pointDipoleValidity({
      distanceAngstrom: coupling.distanceAngstrom,
      extentAngstrom: Math.max(...extents),
    })
    : null;
  return {
    ...coupling,
    ...split,
    validity,
    // Stated so a report cannot present this as the only possible answer.
    approximation: 'point-dipole; valid only when the chromophore separation is much larger than '
      + 'the chromophore extent. Charge-transfer character is not described by this model.',
  };
}

/**
 * Issue 173: the two chromophores of a `complex` record, as geometry.
 *
 * A complex record labels its atoms with `fragment = member index + 1`, and
 * places them contiguously in member order (`complex.js`), so `members[i]` owns
 * the next `atomCount` atoms of `coords`. Each fragment's centre of mass is the
 * anchor of its point dipole, and its extent — the largest distance between two
 * of its own atoms — is what the validity ratio is measured against. Nothing is
 * inferred from the atom count, and a member whose atoms are not all there is
 * refused rather than shifted.
 *
 * Returns `null` when there is no complex geometry to read at all (a monomer
 * run); throws only when a complex is present but internally inconsistent, so a
 * caller can tell "not a dimer" from "this dimer is malformed".
 */
export function complexFragments({ complex = null, coords = null } = {}) {
  const members = Array.isArray(complex?.members) ? complex.members : [];
  const atoms = Array.isArray(coords) ? coords : [];
  if (members.length < 2 || atoms.length === 0) return null;
  const counts = members.map((member) => Number(member?.atomCount));
  if (!counts.every((count) => Number.isInteger(count) && count > 0)) {
    throw new Error('the complex does not record how many atoms each member has, so its fragments '
      + 'cannot be separated without guessing.');
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total !== atoms.length) {
    throw new Error(`the complex records ${total} atoms across its members but the geometry carries `
      + `${atoms.length}: the two do not describe the same system.`);
  }
  const fragments = [];
  let offset = 0;
  members.forEach((member, position) => {
    const owned = atoms.slice(offset, offset + counts[position]);
    offset += counts[position];
    let extent = 0;
    for (let a = 0; a < owned.length; a += 1) {
      for (let b = a + 1; b < owned.length; b += 1) {
        const distance = Math.hypot(
          Number(owned[a].x) - Number(owned[b].x),
          Number(owned[a].y) - Number(owned[b].y),
          Number(owned[a].z) - Number(owned[b].z),
        );
        if (Number.isFinite(distance) && distance > extent) extent = distance;
      }
    }
    const label = member?.label ? String(member.label) : (member?.id ? String(member.id) : `member ${position + 1}`);
    // Mass-weighted, through the same `centreOfMass` the complex block places
    // members with: the separation vector must be the one the geometry was
    // built on, and an element with no tabulated mass is refused there rather
    // than weighted as zero.
    const centre = centreOfMass(owned, label);
    fragments.push({
      fragment: Number.isInteger(Number(member?.fragment)) ? Number(member.fragment) : position + 1,
      id: member?.id ? String(member.id) : null,
      label,
      atomCount: owned.length,
      centreAngstrom: { x: centre.x, y: centre.y, z: centre.z },
      extentAngstrom: extent,
    });
  });
  return fragments;
}

/**
 * Issue 173: the exciton analysis of a dimer record, or the reason there is none.
 *
 * Two chromophores are coupled through their transition dipoles. The states fed
 * here are the ones the run recorded; only states that carry **both** a recorded
 * dipole vector and a non-zero oscillator strength can take part, because a dark
 * state has no transition to couple and a state without a vector has no
 * direction. The two leading such states are paired and named in the report —
 * a selection rule stated on the card, not one hidden in the code.
 *
 * `pair` ({ state1, state2 } state indices) overrides that choice when a caller
 * already knows which two states are the chromophore transitions.
 *
 * Returns `{ modelled: true, ... }` or `{ modelled: false, reason }`, where
 * `reason` is the sentence a card prints. It never returns a number from one
 * chromophore, from a dark state, or from a geometry that is not a dimer.
 */
export function excitonReport({
  states = [], complex = null, coords = null, pair = null, levelOfTheory = null,
} = {}) {
  const list = Array.isArray(states) ? states.filter((state) => state && typeof state === 'object') : [];
  let fragments;
  try {
    fragments = complexFragments({ complex, coords });
  } catch (error) {
    return { modelled: false, reason: `not modelled: ${error.message}`, levelOfTheory };
  }
  if (!fragments) {
    // A plain monomer run: one chromophore, so there is no separation vector and
    // nothing to couple. No number is produced from the single molecule.
    return {
      modelled: false,
      reason: 'not modelled: no dimer geometry',
      detail: 'This run has one structure and no complex record, so there is no second chromophore '
        + 'and no separation vector. Coupling needs two chromophores and the geometry that places them.',
      levelOfTheory,
    };
  }

  const usable = list.filter((state) => isNum(state.oscillatorStrength)
    && state.oscillatorStrength > 0
    && (state.transitionDipoleAu || state.transitionDipoleDebye));
  let state1 = null;
  let state2 = null;
  if (pair && isNum(pair.state1) && isNum(pair.state2)) {
    state1 = list.find((state) => Number(state.index) === Number(pair.state1)) || null;
    state2 = list.find((state) => Number(state.index) === Number(pair.state2)) || null;
  } else {
    [state1, state2] = usable;
  }
  if (!state1 || !state2) {
    const bright = usable.length;
    return {
      modelled: false,
      reason: 'not modelled: fewer than two states carry a recorded transition dipole and a non-zero '
        + 'oscillator strength',
      detail: `${bright} state${bright === 1 ? '' : 's'} of ${list.length} in this record could couple. `
        + 'A dark state (f = 0) has no transition to couple, and a state without a dipole vector has no '
        + 'direction; neither is reconstructed from the oscillator strength.',
      chromophores: fragments.length,
      levelOfTheory,
    };
  }

  const separation = {
    x: fragments[1].centreAngstrom.x - fragments[0].centreAngstrom.x,
    y: fragments[1].centreAngstrom.y - fragments[0].centreAngstrom.y,
    z: fragments[1].centreAngstrom.z - fragments[0].centreAngstrom.z,
  };
  let coupling;
  try {
    coupling = excitonCoupling({
      state1,
      state2,
      separationAngstrom: separation,
      extent1Angstrom: fragments[0].extentAngstrom,
      extent2Angstrom: fragments[1].extentAngstrom,
    });
  } catch (error) {
    return {
      modelled: false,
      reason: `not modelled: ${error.message}`,
      chromophores: fragments.length,
      levelOfTheory,
    };
  }

  const describe = (state, fragment) => {
    const dipole = transitionDipoleOf(state);
    return {
      index: Number(state.index),
      label: [state.spin, state.symmetry ?? state.irrep].filter(Boolean).join('-') || null,
      energyEv: isNum(state.energyEv) ? state.energyEv : null,
      oscillatorStrength: isNum(state.oscillatorStrength) ? state.oscillatorStrength : null,
      magnitudeDebye: dipole.magnitudeDebye,
      fragment: fragment.fragment,
      fragmentLabel: fragment.label,
    };
  };

  return {
    modelled: true,
    state1: describe(state1, fragments[0]),
    state2: describe(state2, fragments[1]),
    fragments: fragments.map((fragment) => ({
      fragment: fragment.fragment,
      label: fragment.label,
      centreAngstrom: fragment.centreAngstrom,
      extentAngstrom: fragment.extentAngstrom,
    })),
    membersNotCoupled: fragments.length > 2 ? fragments.slice(2).map((fragment) => fragment.label) : [],
    separationAngstrom: separation,
    ...coupling,
    levelOfTheory,
  };
}
