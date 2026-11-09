/**
 * UFF — the Universal Force Field (issue 144), as a pure engine: atom typing,
 * energies in kcal/mol, analytic gradients in kcal/mol/Å, and a guarded
 * minimiser. No UI, no worker, no schema keys, no CREST replacement: this file
 * is the force field and nothing else.
 *
 * What this is
 * ------------
 *
 * Rappé, Casewit, Colwell, Goddard and Skiff, *J. Am. Chem. Soc.* 1992, 114,
 * 10024 ("UFF"), with the five terms the paper defines:
 *
 *   bond stretch      E = ½ K_IJ (r − r_IJ)²                       eqs. (1)–(3)
 *   angle bend        E = K_IJK (C0 + C1 cos θ + C2 cos 2θ)        eqs. (4)–(6)
 *   torsion           E = ½ V_φ (1 − cos(nφ0) cos(nφ))             eqs. (11)–(13)
 *   inversion         E = K_IJKL (C0 + C1 cos ω + C2 cos 2ω)       eqs. (7)–(9)
 *   van der Waals     E = D_IJ [(x_IJ/r)¹² − 2(x_IJ/r)⁶]           eq. (20)
 *
 * **The units are kcal/mol and Å throughout.** Every exported function that
 * returns an energy says `Kcal` in its name; every one that returns a gradient
 * says `KcalPerAngstrom`; every length is `…Angstrom`. Nothing here converts
 * from Hartree, kJ/mol or bohr, and nothing here accepts them: a caller with a
 * number in another unit must convert before it arrives.
 *
 * Accuracy, stated where the numbers are produced
 * ----------------------------------------------
 *
 * UFF is a **fast, general, low-accuracy** force field: one parameter table,
 * published for the whole periodic table, fitted to a broad spread of molecules
 * rather than to any one of them. (This engine types ten of those elements —
 * see the limits below.) It is not MMFF94, it is not a semi-empirical method
 * and it is not a quantum-chemistry method. A UFF geometry is a *starting
 * point* for a real calculation, and a UFF energy is **not comparable with a QM
 * energy** — not by subtraction, not by ratio, not as a "relative stability"
 * across methods. Every result this module returns carries `method`,
 * `energyKind` and `comparableWithQuantumChemistry: false` so a card cannot
 * present a force-field number as a computed total energy.
 *
 * Known limits, all of them deliberate and all of them reported:
 *
 *   - Electrostatics are **off**. UFF's nonbonded term here is Lennard-Jones
 *     only; formal charges do not interact. Polar molecules, zwitterions and
 *     salts are therefore under-ranked by anything built on this engine.
 *   - Elements: H, C, N, O, F, P, S, Cl, Br, I. An atom of any other element
 *     is refused **by name** — no radius, well depth or angle is invented for
 *     it.
 *   - 3- and 4-membered ring angle corrections from the paper are not
 *     implemented, so such rings come out strained in a way UFF would relieve.
 *   - Hybridisation comes from bond orders only. A conjugated single bond — an
 *     amide C–N, an ester C–O, an aniline C–N — is typed from its single bonds,
 *     so that centre relaxes pyramidal here where UFF's planar type would keep
 *     it flat. `warnings` names every such atom: nothing in this module
 *     perceives conjugation, and pretending otherwise would be the silent
 *     fallback this app refuses elsewhere.
 *   - The group-5 inversion coefficients (P, As, Sb, Bi) are not implemented:
 *     a pyramidal P centre gets its shape from the angle term alone and **no
 *     inversion barrier is claimed** for it. `warnings` says so per atom. The
 *     paper gives those coefficients against the in-plane bisector of i–j–k
 *     (ω0 = 84.4339° for P, which for PH3 at H–P–H 93.8° is the same geometry
 *     as 5.57° out of the plane), while ω here is the angle against the plane;
 *     a barrier that cannot be checked against its own definition is worse than
 *     an absent one, so the term is absent and named.
 *   - A linear centre (θ0 = 180°, e.g. an sp carbon) cannot use the paper's
 *     cosine series — C2 = 1/(4 sin²θ0) diverges there. The term is evaluated
 *     as its harmonic limit ½ K (θ − θ0)², whose curvature at θ0 is exactly
 *     the K the series gives through eq. (5). `warnings` names the centre.
 *   - Van der Waals pairs are all atom pairs at least three bonds apart, with
 *     **no distance cutoff**: far-apart fragments still attract slightly
 *     (the LJ tail is not truncated, so the gradient stays continuous).
 *
 * Parameters
 * ----------
 *
 * `UFF_TYPES` is transcribed from the paper's Table 1. It was checked row by
 * row against RDKit's transcription of the same table
 * (`Code/ForceField/UFF/Params.cpp`, BSD-3); the numbers are identical. The
 * paper also tabulates a vdW scaling exponent ζ and a QEq hardness/radius per
 * element; the standard 12–6 form used here does not consume them, so they are
 * not carried — a parameter that no term uses is a parameter that can silently
 * disagree with a term that does.
 *
 * These are UFF's *effective bond radii* (`r1`), not the Cordero covalent
 * radii used by `validityChecks.js` and `derivative.js`. The two tables are
 * different models of the same molecule and are never interchangeable.
 *
 * Refusals
 * --------
 *
 * A molecule this engine cannot describe is refused, never approximated:
 *
 *   unknown-element   an element outside H, C, N, O, F, P, S, Cl, Br, I
 *   not-an-atom       atoms[i] has no finite x/y/z
 *   bad-bond          a bond that does not name two different atoms in range,
 *                     or an order other than 1, 1.5, 2 or 3
 *   untyped-atom      a `types` array supplied by the caller with a hole in it
 *
 * A refusal is an `UffRefusalError` with `code`, `atomIndex` and `element`, so
 * a caller can say which atom of which molecule stopped it.
 */

/** The one string that names the method in a result. Never reword it here. */
export const UFF_METHOD = 'UFF';

/** Where the numbers come from. Returned with every result. */
export const UFF_PROVENANCE = 'Rappé, Casewit, Colwell, Goddard & Skiff, '
  + 'J. Am. Chem. Soc. 1992, 114, 10024 (UFF), Table 1 parameters';

/**
 * The sentence every result carries. A force-field energy is a different kind
 * of number from a total electronic energy and the difference is not a scale
 * factor.
 */
export const UFF_ACCURACY_NOTE = 'UFF is a fast, general, low-accuracy force '
  + 'field. A UFF geometry is a starting point for a real calculation, and a UFF '
  + 'energy is not comparable with a QM energy: do not subtract or rank the two '
  + 'against each other.';

/** What kind of number `uffEnergyKcal().totalKcal` is. */
export const UFF_ENERGY_KIND = 'force-field energy (kcal/mol), not a total electronic energy';

/** The units, in one place, because they are part of the API. */
export const UFF_UNITS = Object.freeze({
  energy: 'kcal/mol',
  length: 'angstrom',
  gradient: 'kcal/mol/angstrom',
  angle: 'radian',
});

/** λ in eq. (1): the bond-order correction scale, Å. */
export const UFF_BOND_ORDER_SCALE = 0.1332;
/** G in eq. (2): the bond force-constant prefactor, kcal·Å⁻¹·mol⁻¹. */
export const UFF_FORCE_PREFACTOR = 332.06;

/**
 * The elements this engine types. An element outside this list is refused by
 * name rather than given a borrowed radius.
 */
export const UFF_ELEMENTS = Object.freeze(['H', 'C', 'N', 'O', 'F', 'P', 'S', 'Cl', 'Br', 'I']);

const degrees = (value) => (value * Math.PI) / 180;

/**
 * UFF atom types: the paper's Table 1 columns this engine's five terms use.
 *
 *   bondRadiusAngstrom     r1, the effective bond radius of eq. (1)
 *   theta0Degrees          θ0, the equilibrium angle of eq. (4)
 *   vdwRadiusAngstrom      x1, half the LJ equilibrium distance (eq. 20)
 *   vdwDepthKcal           D1, the LJ well depth
 *   effectiveCharge        Z1, the bond/angle force-constant charge (eq. 2)
 *   torsionBarrierKcal     V1, the sp3 torsional barrier (eq. 12)
 *   inversionBarrierKcal   U1, used by eq. (17) for sp2–sp2 torsions
 *   electronegativity      χ, used by the Pauling/electronegativity correction
 *                          to the bond length
 *   hybrid                 what the torsion and inversion rules classify by
 */
export const UFF_TYPES = Object.freeze({
  H_: Object.freeze({
    label: 'H_', element: 'H', hybrid: 'sp3',
    bondRadiusAngstrom: 0.354, theta0Degrees: 180,    vdwRadiusAngstrom: 2.886,
    vdwDepthKcal: 0.044, effectiveCharge: 0.712, torsionBarrierKcal: 0,
    inversionBarrierKcal: 0, electronegativity: 4.528,
  }),
  'C_3': Object.freeze({
    label: 'C_3', element: 'C', hybrid: 'sp3',
    bondRadiusAngstrom: 0.757, theta0Degrees: 109.47, vdwRadiusAngstrom: 3.851,
    vdwDepthKcal: 0.105, effectiveCharge: 1.912, torsionBarrierKcal: 2.119,
    inversionBarrierKcal: 2, electronegativity: 5.343,
  }),
  C_R: Object.freeze({
    label: 'C_R', element: 'C', hybrid: 'sp2',
    bondRadiusAngstrom: 0.729, theta0Degrees: 120, vdwRadiusAngstrom: 3.851,
    vdwDepthKcal: 0.105, effectiveCharge: 1.912, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 5.343,
  }),
  'C_2': Object.freeze({
    label: 'C_2', element: 'C', hybrid: 'sp2',
    bondRadiusAngstrom: 0.732, theta0Degrees: 120, vdwRadiusAngstrom: 3.851,
    vdwDepthKcal: 0.105, effectiveCharge: 1.912, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 5.343,
  }),
  'C_1': Object.freeze({
    label: 'C_1', element: 'C', hybrid: 'sp1',
    bondRadiusAngstrom: 0.706, theta0Degrees: 180, vdwRadiusAngstrom: 3.851,
    vdwDepthKcal: 0.105, effectiveCharge: 1.912, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 5.343,
  }),
  'N_3': Object.freeze({
    label: 'N_3', element: 'N', hybrid: 'sp3',
    bondRadiusAngstrom: 0.7, theta0Degrees: 106.7, vdwRadiusAngstrom: 3.66,
    vdwDepthKcal: 0.069, effectiveCharge: 2.544, torsionBarrierKcal: 0.45,
    inversionBarrierKcal: 2, electronegativity: 6.899,
  }),
  N_R: Object.freeze({
    label: 'N_R', element: 'N', hybrid: 'sp2',
    bondRadiusAngstrom: 0.699, theta0Degrees: 120, vdwRadiusAngstrom: 3.66,
    vdwDepthKcal: 0.069, effectiveCharge: 2.544, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 6.899,
  }),
  'N_2': Object.freeze({
    label: 'N_2', element: 'N', hybrid: 'sp2',
    bondRadiusAngstrom: 0.685, theta0Degrees: 111.2, vdwRadiusAngstrom: 3.66,
    vdwDepthKcal: 0.069, effectiveCharge: 2.544, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 6.899,
  }),
  'N_1': Object.freeze({
    label: 'N_1', element: 'N', hybrid: 'sp1',
    bondRadiusAngstrom: 0.656, theta0Degrees: 180, vdwRadiusAngstrom: 3.66,
    vdwDepthKcal: 0.069, effectiveCharge: 2.544, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 6.899,
  }),
  'O_3': Object.freeze({
    label: 'O_3', element: 'O', hybrid: 'sp3',
    bondRadiusAngstrom: 0.658, theta0Degrees: 104.51, vdwRadiusAngstrom: 3.5,
    vdwDepthKcal: 0.06, effectiveCharge: 2.3, torsionBarrierKcal: 0.018,
    inversionBarrierKcal: 2, electronegativity: 8.741,
  }),
  O_R: Object.freeze({
    label: 'O_R', element: 'O', hybrid: 'sp2',
    bondRadiusAngstrom: 0.68, theta0Degrees: 110, vdwRadiusAngstrom: 3.5,
    vdwDepthKcal: 0.06, effectiveCharge: 2.3, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 8.741,
  }),
  'O_2': Object.freeze({
    label: 'O_2', element: 'O', hybrid: 'sp2',
    bondRadiusAngstrom: 0.634, theta0Degrees: 120, vdwRadiusAngstrom: 3.5,
    vdwDepthKcal: 0.06, effectiveCharge: 2.3, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 8.741,
  }),
  'O_1': Object.freeze({
    label: 'O_1', element: 'O', hybrid: 'sp1',
    bondRadiusAngstrom: 0.639, theta0Degrees: 180, vdwRadiusAngstrom: 3.5,
    vdwDepthKcal: 0.06, effectiveCharge: 2.3, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 8.741,
  }),
  F_: Object.freeze({
    label: 'F_', element: 'F', hybrid: 'sp3',
    bondRadiusAngstrom: 0.668, theta0Degrees: 180, vdwRadiusAngstrom: 3.364,
    vdwDepthKcal: 0.05, effectiveCharge: 1.735, torsionBarrierKcal: 0,
    inversionBarrierKcal: 2, electronegativity: 10.874,
  }),
  'P_3+3': Object.freeze({
    label: 'P_3+3', element: 'P', hybrid: 'sp3',
    bondRadiusAngstrom: 1.101, theta0Degrees: 93.8, vdwRadiusAngstrom: 4.147,
    vdwDepthKcal: 0.305, effectiveCharge: 2.863, torsionBarrierKcal: 2.4,
    inversionBarrierKcal: 1.25, electronegativity: 5.463,
  }),
  'P_3+5': Object.freeze({
    label: 'P_3+5', element: 'P', hybrid: 'other',
    bondRadiusAngstrom: 1.056, theta0Degrees: 109.47, vdwRadiusAngstrom: 4.147,
    vdwDepthKcal: 0.305, effectiveCharge: 2.863, torsionBarrierKcal: 2.4,
    inversionBarrierKcal: 1.25, electronegativity: 5.463,
  }),
  'S_3+2': Object.freeze({
    label: 'S_3+2', element: 'S', hybrid: 'sp3',
    bondRadiusAngstrom: 1.064, theta0Degrees: 92.1, vdwRadiusAngstrom: 4.035,
    vdwDepthKcal: 0.274, effectiveCharge: 2.703, torsionBarrierKcal: 0.484,
    inversionBarrierKcal: 1.25, electronegativity: 6.928,
  }),
  'S_3+4': Object.freeze({
    label: 'S_3+4', element: 'S', hybrid: 'sp3',
    bondRadiusAngstrom: 1.049, theta0Degrees: 103.2, vdwRadiusAngstrom: 4.035,
    vdwDepthKcal: 0.274, effectiveCharge: 2.703, torsionBarrierKcal: 0.484,
    inversionBarrierKcal: 1.25, electronegativity: 6.928,
  }),
  'S_3+6': Object.freeze({
    label: 'S_3+6', element: 'S', hybrid: 'sp3',
    bondRadiusAngstrom: 1.027, theta0Degrees: 109.47, vdwRadiusAngstrom: 4.035,
    vdwDepthKcal: 0.274, effectiveCharge: 2.703, torsionBarrierKcal: 0.484,
    inversionBarrierKcal: 1.25, electronegativity: 6.928,
  }),
  S_R: Object.freeze({
    label: 'S_R', element: 'S', hybrid: 'sp2',
    bondRadiusAngstrom: 1.077, theta0Degrees: 92.2, vdwRadiusAngstrom: 4.035,
    vdwDepthKcal: 0.274, effectiveCharge: 2.703, torsionBarrierKcal: 0,
    inversionBarrierKcal: 1.25, electronegativity: 6.928,
  }),
  'S_2': Object.freeze({
    label: 'S_2', element: 'S', hybrid: 'sp2',
    bondRadiusAngstrom: 0.854, theta0Degrees: 120, vdwRadiusAngstrom: 4.035,
    vdwDepthKcal: 0.274, effectiveCharge: 2.703, torsionBarrierKcal: 0,
    inversionBarrierKcal: 1.25, electronegativity: 6.928,
  }),
  Cl: Object.freeze({
    label: 'Cl', element: 'Cl', hybrid: 'sp3',
    bondRadiusAngstrom: 1.044, theta0Degrees: 180, vdwRadiusAngstrom: 3.947,
    vdwDepthKcal: 0.227, effectiveCharge: 2.348, torsionBarrierKcal: 0,
    inversionBarrierKcal: 1.25, electronegativity: 8.564,
  }),
  Br: Object.freeze({
    label: 'Br', element: 'Br', hybrid: 'sp3',
    bondRadiusAngstrom: 1.192, theta0Degrees: 180, vdwRadiusAngstrom: 4.189,
    vdwDepthKcal: 0.251, effectiveCharge: 2.519, torsionBarrierKcal: 0,
    inversionBarrierKcal: 0.7, electronegativity: 7.79,
  }),
  I_: Object.freeze({
    label: 'I_', element: 'I', hybrid: 'sp3',
    bondRadiusAngstrom: 1.382, theta0Degrees: 180, vdwRadiusAngstrom: 4.5,
    vdwDepthKcal: 0.339, effectiveCharge: 2.65, torsionBarrierKcal: 0,
    inversionBarrierKcal: 0.2, electronegativity: 6.822,
  }),
});

/** A refused molecule. `code`, `atomIndex` and `element` are for the caller. */
export class UffRefusalError extends Error {
  constructor(message, { code = 'uff', atomIndex = null, element = null } = {}) {
    super(message);
    this.name = 'UffRefusalError';
    this.code = code;
    this.atomIndex = atomIndex;
    this.element = element;
  }
}

function refuse(message, code, { atomIndex = null, element = null } = {}) {
  throw new UffRefusalError(message, { code, atomIndex, element });
}

function own(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

/* ── atom typing ──────────────────────────────────────────── */

/**
 * UFF types for a molecule. `bonds` uses the project's numbering: 1-based
 * indices into `atoms`, `order` one of 1, 1.5 (aromatic), 2, 3.
 *
 * The type is element + connectivity only: hybridisation comes from the
 * highest bond order an atom carries, and an aromatic bond makes the atom an
 * `_R` type. Nothing is guessed — an element outside `UFF_ELEMENTS` gets
 * `types[i] === null` and an entry in `refused`, and the caller decides whether
 * to refuse the whole molecule (the energy and gradient functions do).
 */
export function typeAtoms(atoms, bonds = []) {
  const list = Array.isArray(atoms) ? atoms : [];
  const bondList = readBonds(bonds, list.length);
  const neighbours = neighboursOf(list.length, bondList);
  const refused = [];
  const types = list.map((atom, index) => {
    const element = String(atom?.element ?? '').trim();
    if (!UFF_ELEMENTS.includes(element)) {
      const message = `Atom ${index + 1} is ${element || '(no element)'}, which UFF here does not `
        + `type: the supported elements are ${UFF_ELEMENTS.join(', ')}. No radius or well depth `
        + 'is invented for it.';
      refused.push({ atomIndex: index + 1, element: element || null, code: 'unknown-element', message });
      return null;
    }
    const bondsHere = neighbours[index];
    const orders = bondsHere.map((bond) => bond.order);
    const type = typeOf(element, orders, bondsHere.length);
    if (!type) {
      refused.push({
        atomIndex: index + 1,
        element,
        code: 'untyped-atom',
        message: `Atom ${index + 1} (${element}) has a connectivity this typer cannot place `
          + `(${bondsHere.length} bonds of order ${orders.join(', ') || 'none'}).`,
      });
      return null;
    }
    return type;
  });
  return { types, refused, ok: refused.length === 0 };
}

function typeOf(element, orders, bondCount) {
  const aromatic = orders.some((order) => order === 1.5);
  const highest = orders.reduce((max, order) => Math.max(max, order), 0);
  switch (element) {
    case 'H': return own(UFF_TYPES, 'H_');
    case 'F': return own(UFF_TYPES, 'F_');
    case 'Cl': return own(UFF_TYPES, 'Cl');
    case 'Br': return own(UFF_TYPES, 'Br');
    case 'I': return own(UFF_TYPES, 'I_');
    case 'C':
      if (aromatic) return own(UFF_TYPES, 'C_R');
      if (highest >= 2.5) return own(UFF_TYPES, 'C_1');
      if (highest >= 1.5) return own(UFF_TYPES, 'C_2');
      return own(UFF_TYPES, 'C_3');
    case 'N':
      if (aromatic) return own(UFF_TYPES, 'N_R');
      if (highest >= 2.5) return own(UFF_TYPES, 'N_1');
      if (highest >= 1.5) return own(UFF_TYPES, 'N_2');
      return own(UFF_TYPES, 'N_3');
    case 'O':
      if (aromatic) return own(UFF_TYPES, 'O_R');
      if (highest >= 2.5) return own(UFF_TYPES, 'O_1');
      if (highest >= 1.5) return own(UFF_TYPES, 'O_2');
      return own(UFF_TYPES, 'O_3');
    case 'S':
      if (aromatic) return own(UFF_TYPES, 'S_R');
      if (highest >= 1.5) return own(UFF_TYPES, 'S_2');
      if (bondCount <= 2) return own(UFF_TYPES, 'S_3+2');
      if (bondCount <= 4) return own(UFF_TYPES, 'S_3+4');
      return own(UFF_TYPES, 'S_3+6');
    case 'P':
      if (highest >= 2.5) return null;
      return own(UFF_TYPES, bondCount >= 4 ? 'P_3+5' : 'P_3+3');
    default:
      return null;
  }
}

/* ── reading a molecule ───────────────────────────────────── */

function readAtoms(atoms) {
  const list = Array.isArray(atoms) ? atoms : null;
  if (!list || list.length === 0) {
    refuse('A UFF calculation needs at least one atom; this molecule has none.', 'no-atoms');
  }
  return list.map((atom, index) => {
    const x = Number(atom?.x);
    const y = Number(atom?.y);
    const z = Number(atom?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      refuse(
        `Atom ${index + 1} (${atom?.element ?? 'unknown'}) has a non-finite coordinate; UFF needs `
        + 'a complete geometry in Å.',
        'not-an-atom', { atomIndex: index + 1, element: atom?.element ?? null },
      );
    }
    return { element: String(atom.element ?? '').trim(), x, y, z };
  });
}

function readBonds(bonds, atomCount) {
  if (bonds === undefined || bonds === null) return [];
  if (!Array.isArray(bonds)) {
    refuse('`bonds` must be an array of { a, b, order } entries; it is not.', 'bad-bond');
  }
  const seen = new Set();
  const out = [];
  for (const [index, entry] of bonds.entries()) {
    const a = Number(entry?.a);
    const b = Number(entry?.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
      refuse(`Bond ${index + 1} does not name two different atoms.`, 'bad-bond');
    }
    if (a < 1 || b < 1 || a > atomCount || b > atomCount) {
      refuse(
        `Bond ${index + 1} joins atoms ${a} and ${b}; the structure has ${atomCount} atoms `
        + '(indices start at 1).',
        'bad-bond',
      );
    }
    const order = Number(entry?.order ?? 1);
    if (![1, 1.5, 2, 3].includes(order)) {
      refuse(
        `Bond ${index + 1} (${a}–${b}) has order ${entry?.order}; UFF here takes 1, 1.5 (aromatic), `
        + '2 and 3.',
        'bad-bond',
      );
    }
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: Math.min(a, b) - 1, b: Math.max(a, b) - 1, order });
  }
  return out;
}

/** Adjacency as 0-based neighbour lists, each entry `{ partner, order }`. */
function neighboursOf(atomCount, bonds) {
  const lists = Array.from({ length: atomCount }, () => []);
  for (const bond of bonds) {
    lists[bond.a].push({ partner: bond.b, order: bond.order });
    lists[bond.b].push({ partner: bond.a, order: bond.order });
  }
  return lists;
}

function resolveTypes(atoms, bonds, supplied) {
  if (supplied) {
    const types = atoms.map((atom, index) => {
      const entry = supplied[index];
      if (!entry || typeof entry !== 'object' || !entry.label) {
        refuse(
          `The supplied type list has no UFF type for atom ${index + 1} `
          + `(${atom.element}); UFF will not substitute a default type.`,
          'untyped-atom', { atomIndex: index + 1, element: atom.element },
        );
      }
      return entry;
    });
    return types;
  }
  const typed = typeAtoms(atoms.map((atom) => ({ ...atom })), rebaseBonds(bonds));
  if (!typed.ok) {
    const [first] = typed.refused;
    refuse(first.message, first.code, { atomIndex: first.atomIndex, element: first.element });
  }
  return typed.types;
}

/** `typeAtoms` takes the file's 1-based bonds; internal bonds are 0-based. */
function rebaseBonds(bonds) {
  return bonds.map((bond) => ({ a: bond.a + 1, b: bond.b + 1, order: bond.order }));
}

/* ── parameters ───────────────────────────────────────────── */

/**
 * Eq. (1) plus the Pauling and O'Keefe–Breese corrections:
 *
 *   r_IJ = r_i + r_j − λ (r_i + r_j) ln BO − r_EN
 *   r_EN = r_i r_j (√χ_i − √χ_j)² / (χ_i r_i + χ_j r_j)
 *
 * For C–C single bonds this gives 1.514 Å, C=C 1.329 Å, C≡C 1.205 Å and an
 * aromatic C⋯C 1.379 Å — the paper's own values for those bonds.
 */
export function bondRestLengthAngstrom(typeA, typeB, bondOrder) {
  const ri = typeA.bondRadiusAngstrom;
  const rj = typeB.bondRadiusAngstrom;
  const rBO = -UFF_BOND_ORDER_SCALE * (ri + rj) * Math.log(bondOrder);
  const xi = typeA.electronegativity;
  const xj = typeB.electronegativity;
  const rootDifference = Math.sqrt(xi) - Math.sqrt(xj);
  const rEN = (ri * rj * rootDifference * rootDifference) / (xi * ri + xj * rj);
  return ri + rj + rBO - rEN;
}

/** Bond parameters: the rest length of eq. (1) and K of eq. (2)/(3). */
export function bondParameters(typeA, typeB, bondOrder = 1) {
  const r0 = bondRestLengthAngstrom(typeA, typeB, bondOrder);
  const k = (2 * UFF_FORCE_PREFACTOR * typeA.effectiveCharge * typeB.effectiveCharge)
    / (r0 * r0 * r0);
  return Object.freeze({
    r0Angstrom: r0,
    kKcalPerAngstrom2: k,
    bondOrder,
  });
}

/** E = ½ K (r − r0)², kcal/mol for r and r0 in Å and K in kcal/mol/Å². */
export function bondStretchEnergyKcal(rAngstrom, r0Angstrom, kKcalPerAngstrom2) {
  const delta = rAngstrom - r0Angstrom;
  return 0.5 * kKcalPerAngstrom2 * delta * delta;
}

/**
 * Angle parameters from eqs. (4)–(6):
 *
 *   C2 = 1 / (4 sin²θ0),  C1 = −4 C2 cos θ0,  C0 = C2 (2 cos²θ0 + 1)
 *   K  = (β Z_i Z_k / r13⁵) r12 r23 [3 r12 r23 (1 − cos²θ0) − r13² cos θ0]
 *
 * with β = 2G/(r12 r23). For θ0 = 180° the series has no finite coefficients,
 * so `linear` is set and the term is the harmonic limit of the same curvature.
 */
export function angleParameters(typeI, typeJ, typeK, orderIJ = 1, orderJK = 1) {
  const theta0 = degrees(typeJ.theta0Degrees);
  const r12 = bondRestLengthAngstrom(typeI, typeJ, orderIJ);
  const r23 = bondRestLengthAngstrom(typeK, typeJ, orderJK);
  const cosTheta0 = Math.cos(theta0);
  const r13 = Math.sqrt(Math.max(
    0,
    r12 * r12 + r23 * r23 - 2 * r12 * r23 * cosTheta0,
  ));
  const beta = (2 * UFF_FORCE_PREFACTOR) / (r12 * r23);
  const r13To5 = r13 ** 5;
  const k = (beta * typeI.effectiveCharge * typeK.effectiveCharge / r13To5)
    * r12 * r23
    * (3 * r12 * r23 * (1 - cosTheta0 * cosTheta0) - r13 * r13 * cosTheta0);
  const linear = Math.abs(typeJ.theta0Degrees - 180) < 1e-9;
  const sinTheta0 = Math.sin(theta0);
  const c2 = linear ? 0 : 1 / (4 * Math.max(sinTheta0 * sinTheta0, 1e-12));
  const c1 = linear ? 0 : -4 * c2 * cosTheta0;
  const c0 = linear ? 0 : c2 * (2 * cosTheta0 * cosTheta0 + 1);
  return Object.freeze({
    theta0Radians: theta0,
    kKcalPerRadian2: k,
    c0,
    c1,
    c2,
    linear,
    r12Angstrom: r12,
    r23Angstrom: r23,
    r13Angstrom: r13,
  });
}

/** E_θ in kcal/mol for an angle in radians. */
export function angleBendEnergyKcal(angleRadians, parameters) {
  if (parameters.linear) {
    const delta = angleRadians - parameters.theta0Radians;
    return 0.5 * parameters.kKcalPerRadian2 * delta * delta;
  }
  return parameters.kKcalPerRadian2 * (
    parameters.c0
    + parameters.c1 * Math.cos(angleRadians)
    + parameters.c2 * Math.cos(2 * angleRadians)
  );
}

/** dE_θ/dθ, kcal/mol/rad. */
export function angleBendDerivativeKcalPerRadian(angleRadians, parameters) {
  if (parameters.linear) return parameters.kKcalPerRadian2 * (angleRadians - parameters.theta0Radians);
  return -parameters.kKcalPerRadian2 * (
    parameters.c1 * Math.sin(angleRadians)
    + 2 * parameters.c2 * Math.sin(2 * angleRadians)
  );
}

const GROUP6 = new Set(['O', 'S']);
const GROUP6_BARRIER_KCAL = Object.freeze({ O: 2.0, S: 6.8 });

/**
 * Eq. (17): the sp2–sp2 torsional barrier, 5 √(U_i U_j) (1 + 4.18 ln BO).
 */
export function sp2TorsionBarrierKcal(typeJ, typeK, bondOrder) {
  return 5 * Math.sqrt(typeJ.inversionBarrierKcal * typeK.inversionBarrierKcal)
    * (1 + 4.18 * Math.log(bondOrder));
}

/**
 * Torsion parameters, chosen by the hybridisation of the two central atoms the
 * way the paper's rules (and eqs. 12–17) read:
 *
 *   sp3–sp3      V = √(V_i V_j), n = 3, φ0 = 60°
 *     …single bond between two group-6 atoms: V = √(V_i V_j) with 6.8 for S and
 *      2.0 for O, n = 2, φ0 = 90°
 *   sp2–sp2      V = eq. (17), n = 2, φ0 = 180°
 *   sp2–sp3      V = 1, n = 6, φ0 = 0°
 *     …single bond, one sp3 group-6 end: V = eq. (17), n = 2, φ0 = 90°
 *     …sp3–sp2–sp2 (an sp2 neighbour on the far side): V = 2, n = 3, φ0 = 180°
 *
 * `cosPeriodicAngle` is cos(nφ0), which is what the energy needs; it is ±1 in
 * every case the paper defines.
 */
export function torsionParameters(typeI, typeJ, typeK, typeL, bondOrder, { endAtomIsSp2 = false } = {}) {
  const hybridJ = typeJ.hybrid;
  const hybridK = typeK.hybrid;
  if (hybridJ === 'sp1' || hybridK === 'sp1' || hybridJ === 'other' || hybridK === 'other') {
    return null;
  }
  const group6J = GROUP6.has(typeJ.element);
  const group6K = GROUP6.has(typeK.element);
  let barrierKcal;
  let periodicity;
  let cosPeriodicAngle;
  let rule;
  if (hybridJ === 'sp3' && hybridK === 'sp3') {
    barrierKcal = Math.sqrt(typeJ.torsionBarrierKcal * typeK.torsionBarrierKcal);
    periodicity = 3;
    cosPeriodicAngle = -1;
    rule = 'sp3-sp3';
    if (bondOrder === 1 && group6J && group6K) {
      barrierKcal = Math.sqrt(
        (GROUP6_BARRIER_KCAL[typeJ.element] ?? 6.8) * (GROUP6_BARRIER_KCAL[typeK.element] ?? 6.8),
      );
      periodicity = 2;
      cosPeriodicAngle = -1;
      rule = 'sp3-sp3-group6';
    }
  } else if (hybridJ === 'sp2' && hybridK === 'sp2') {
    barrierKcal = sp2TorsionBarrierKcal(typeJ, typeK, bondOrder);
    periodicity = 2;
    cosPeriodicAngle = 1;
    rule = 'sp2-sp2';
  } else {
    barrierKcal = 1;
    periodicity = 6;
    cosPeriodicAngle = 1;
    rule = 'sp2-sp3';
    if (bondOrder === 1 && ((hybridJ === 'sp3' && group6J && !group6K)
      || (hybridK === 'sp3' && group6K && !group6J))) {
      barrierKcal = sp2TorsionBarrierKcal(typeJ, typeK, bondOrder);
      periodicity = 2;
      cosPeriodicAngle = -1;
      rule = 'sp2-sp3-group6';
    } else if (endAtomIsSp2) {
      barrierKcal = 2;
      periodicity = 3;
      cosPeriodicAngle = -1;
      rule = 'sp2-sp3-sp2';
    }
  }
  return Object.freeze({ barrierKcal, periodicity, cosPeriodicAngle, rule });
}

/** E_φ = ½ V (1 − cos(nφ0) cos nφ), kcal/mol for φ in radians. */
export function torsionEnergyKcal(phiRadians, parameters) {
  return 0.5 * parameters.barrierKcal * (
    1 - parameters.cosPeriodicAngle * Math.cos(parameters.periodicity * phiRadians)
  );
}

/** dE_φ/dφ, kcal/mol/rad. */
export function torsionDerivativeKcalPerRadian(phiRadians, parameters) {
  return 0.5 * parameters.barrierKcal * parameters.cosPeriodicAngle
    * parameters.periodicity * Math.sin(parameters.periodicity * phiRadians);
}

/**
 * Inversion parameters for an sp2 centre of C, N or O:
 *
 *   C0 = 1, C1 = −1, C2 = 0,  K = 6 kcal/mol (50 for an sp2 carbon bonded to
 *   an sp2 oxygen — an amide, ester or carboxyl carbon)
 *
 * `kKcal` is K/3 because the term is summed over the centre's three
 * neighbours (three triples), and the paper's K is the barrier for the whole
 * centre. ω is the out-of-plane angle of the j→l bond against the i–j–k plane,
 * so E is zero for a planar centre and K at 90° out of plane — the paper's
 * barrier, for a symmetric centre, under either reading of its ω. Anything
 * other than an sp2 C/N/O centre returns null: the paper's group-5
 * coefficients are not implemented here and no barrier is claimed.
 */
export function inversionParameters(typeJ, { boundToSp2Oxygen = false } = {}) {
  if (typeJ.hybrid !== 'sp2') return null;
  if (!['C', 'N', 'O'].includes(typeJ.element)) return null;
  const barrierKcal = typeJ.element === 'C' && boundToSp2Oxygen ? 50 : 6;
  return Object.freeze({
    barrierKcal,
    kKcal: barrierKcal / 3,
    c0: 1,
    c1: -1,
    c2: 0,
  });
}

/** E_ω = K (C0 + C1 cos ω + C2 cos 2ω), kcal/mol for ω in radians. */
export function inversionEnergyKcal(omegaRadians, parameters) {
  return parameters.kKcal * (
    parameters.c0
    + parameters.c1 * Math.cos(omegaRadians)
    + parameters.c2 * Math.cos(2 * omegaRadians)
  );
}

/** dE_ω/dω, kcal/mol/rad. */
export function inversionDerivativeKcalPerRadian(omegaRadians, parameters) {
  return -parameters.kKcal * (
    parameters.c1 * Math.sin(omegaRadians)
    + 2 * parameters.c2 * Math.sin(2 * omegaRadians)
  );
}

/** x_IJ = √(x_i x_j), D_IJ = √(D_i D_j) — eq. (20)'s geometric means. */
export function vanDerWaalsParameters(typeA, typeB) {
  return Object.freeze({
    xAngstrom: Math.sqrt(typeA.vdwRadiusAngstrom * typeB.vdwRadiusAngstrom),
    depthKcal: Math.sqrt(typeA.vdwDepthKcal * typeB.vdwDepthKcal),
  });
}

/** E_vdW = D [(x/r)¹² − 2(x/r)⁶], kcal/mol; the minimum is −D at r = x. */
export function vanDerWaalsEnergyKcal(rAngstrom, xAngstrom, depthKcal) {
  const ratio = xAngstrom / rAngstrom;
  const r6 = ratio ** 6;
  return depthKcal * (r6 * r6 - 2 * r6);
}

/* ── term list ────────────────────────────────────────────── */

/**
 * Every term the molecule has, with its parameters resolved. Exported because
 * the counts and the warnings are part of the result: a caller that reports
 * "5 torsions" should be reporting the terms that were actually evaluated.
 */
export function uffTerms(atoms, bonds, types, { includeVanDerWaals = true } = {}) {
  const neighbours = neighboursOf(atoms.length, bonds);
  const terms = [];
  const warnings = new Set();

  for (let index = 0; index < atoms.length; index += 1) {
    if (!types[index]) {
      refuse(
        `Atom ${index + 1} (${atoms[index]?.element ?? 'unknown'}) has no UFF type; no term is `
        + 'built for a molecule with an untyped atom.',
        'untyped-atom', { atomIndex: index + 1, element: atoms[index]?.element ?? null },
      );
    }
  }

  for (const bond of bonds) {
    const typeA = types[bond.a];
    const typeB = types[bond.b];
    terms.push({
      kind: 'bond',
      indices: [bond.a, bond.b],
      parameters: bondParameters(typeA, typeB, bond.order),
    });
  }

  for (let j = 0; j < atoms.length; j += 1) {
    const ring = neighbours[j];
    for (let a = 0; a < ring.length; a += 1) {
      for (let b = a + 1; b < ring.length; b += 1) {
        const i = ring[a].partner;
        const k = ring[b].partner;
        const parameters = angleParameters(types[i], types[j], types[k], ring[a].order, ring[b].order);
        terms.push({ kind: 'angle', indices: [i, j, k], parameters });
        if (parameters.linear) {
          warnings.add(`Atom ${j + 1} is a linear centre (θ0 = 180°): its angle term is the `
            + 'harmonic limit ½K(θ−θ0)², because the paper\'s cosine series diverges at 180°.');
        }
      }
    }
  }

  for (const bond of bonds) {
    const j = bond.a;
    const k = bond.b;
    const typeJ = types[j];
    const typeK = types[k];
    if (!typeJ || !typeK) continue;
    if (typeJ.hybrid === 'sp1' || typeK.hybrid === 'sp1') continue;
    if (typeJ.hybrid === 'other' || typeK.hybrid === 'other') continue;
    const endsJ = neighbours[j].filter((entry) => entry.partner !== k);
    const endsK = neighbours[k].filter((entry) => entry.partner !== j);
    const triples = [];
    for (const endJ of endsJ) {
      for (const endK of endsK) {
        if (endJ.partner === endK.partner) continue; // a three-membered ring
        triples.push({ i: endJ.partner, l: endK.partner });
      }
    }
    if (triples.length === 0) continue;
    for (const triple of triples) {
      const endAtomIsSp2 = types[triple.i]?.hybrid === 'sp2' || types[triple.l]?.hybrid === 'sp2';
      const parameters = torsionParameters(
        types[triple.i], typeJ, typeK, types[triple.l], bond.order, { endAtomIsSp2 },
      );
      if (!parameters) continue;
      // The barrier V belongs to the bond; it is shared by the triples about
      // it, so three staggered rotamers do not pay the barrier three times.
      terms.push({
        kind: 'torsion',
        indices: [triple.i, j, k, triple.l],
        parameters: Object.freeze({
          ...parameters,
          barrierKcal: parameters.barrierKcal / triples.length,
        }),
      });
    }
  }

  for (let j = 0; j < atoms.length; j += 1) {
    const ring = neighbours[j];
    if (ring.length !== 3) continue;
    const boundToSp2Oxygen = ring.some((entry) => {
      const partner = types[entry.partner];
      return partner?.element === 'O' && entry.order >= 1.5;
    });
    const parameters = inversionParameters(types[j], { boundToSp2Oxygen });
    if (!parameters) {
      if (types[j]?.element === 'P') {
        warnings.add(`Atom ${j + 1} (P) is a pyramidal centre: the group-5 inversion `
          + 'coefficients are not implemented, so no inversion barrier is claimed for it.');
      }
      continue;
    }
    // Three triples per centre, each carrying K/3: the same averaging RDKit
    // does, and the paper's K stays the barrier of the whole centre.
    for (let out = 0; out < 3; out += 1) {
      const others = ring.filter((_, position) => position !== out).map((entry) => entry.partner);
      terms.push({
        kind: 'inversion',
        indices: [others[0], j, others[1], ring[out].partner],
        parameters,
      });
    }
  }

  if (includeVanDerWaals) {
    const close = withinTwoBonds(atoms.length, neighbours);
    for (let i = 0; i < atoms.length; i += 1) {
      for (let j = i + 1; j < atoms.length; j += 1) {
        if (close[i][j]) continue;
        terms.push({
          kind: 'vanDerWaals',
          indices: [i, j],
          parameters: vanDerWaalsParameters(types[i], types[j]),
        });
      }
    }
  }

  // A three-coordinate N or a two-coordinate O next to an sp2 carbon is an
  // amide, ester or aniline centre: UFF's planar N_2/O_2 type is the right one
  // there, but hybridisation here comes from bond orders alone, so the atom is
  // typed from its single bonds and will relax pyramidal. Saying so is the
  // difference between a documented limit and a wrong prediction.
  for (let j = 0; j < atoms.length; j += 1) {
    const type = types[j];
    if (!type || type.hybrid !== 'sp3') continue;
    if (type.element !== 'N' && type.element !== 'O') continue;
    const conjugated = neighbours[j].some((entry) => {
      if (types[entry.partner]?.hybrid !== 'sp2') return false;
      return neighbours[entry.partner].some((second) => second.order >= 1.5
        && types[second.partner]?.element === 'O');
    });
    if (conjugated) {
      warnings.add(`Atom ${j + 1} (${type.element}) is typed ${type.label} from its single `
        + 'bonds, but it is bonded to an sp2 carbon with a multiple bond to oxygen: if that is '
        + 'a conjugated centre (amide, ester, aniline) it should be planar, and this engine '
        + 'perceives no conjugation, so it will relax pyramidal here.');
    }
  }

  if (bonds.length === 0 && atoms.length > 1) {
    warnings.add('The molecule states no bonds: no bond, angle, torsion or inversion term '
      + 'exists, and the only energy is the van der Waals attraction between the atoms.');
  }
  if (bonds.length === 0 && atoms.length === 1) {
    warnings.add('The molecule has one atom and no bonds: every term is zero, so the energy '
      + 'is zero and the gradient is zero.');
  }

  return { terms, warnings: [...warnings] };
}

/** `close[i][j]` true when i and j are bonded or share a neighbour (1-2, 1-3). */
function withinTwoBonds(atomCount, neighbours) {
  const close = Array.from({ length: atomCount }, () => new Array(atomCount).fill(false));
  for (let i = 0; i < atomCount; i += 1) {
    for (const entry of neighbours[i]) {
      close[i][entry.partner] = true;
      close[entry.partner][i] = true;
      for (const second of neighbours[entry.partner]) {
        close[i][second.partner] = true;
        close[second.partner][i] = true;
      }
    }
  }
  return close;
}

/* ── energies and gradients ───────────────────────────────── */

function emptyTermsKcal() {
  return { bond: 0, angle: 0, torsion: 0, inversion: 0, vanDerWaals: 0 };
}

function emptyCounts() {
  return { bond: 0, angle: 0, torsion: 0, inversion: 0, vanDerWaals: 0 };
}

/** Distance and unit vector between two positions in a flat 3N array. */
function displacement(positions, i, j) {
  const dx = positions[3 * i] - positions[3 * j];
  const dy = positions[3 * i + 1] - positions[3 * j + 1];
  const dz = positions[3 * i + 2] - positions[3 * j + 2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { dx, dy, dz, distance };
}

function angleRadiansAt(positions, i, j, k) {
  const u = displacement(positions, i, j);
  const v = displacement(positions, k, j);
  if (!(u.distance > 0) || !(v.distance > 0)) return null;
  const cosine = (u.dx * v.dx + u.dy * v.dy + u.dz * v.dz) / (u.distance * v.distance);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/**
 * The signed dihedral i–j–k–l and, when asked, ∂φ/∂r for all four atoms.
 *
 * φ comes from atan2(ŷ, x) with x = n1·n2, ŷ = (n1×n2)·b̂2 and n1 = b1×b2,
 * n2 = b2×b3. The derivative is the chain rule on that expression, not a
 * memorised formula, which is why the finite-difference test can be an
 * independent check rather than a restatement.
 */
function dihedralAngle(positions, i, j, k, l, gradientOut = null) {
  const b1x = positions[3 * j] - positions[3 * i];
  const b1y = positions[3 * j + 1] - positions[3 * i + 1];
  const b1z = positions[3 * j + 2] - positions[3 * i + 2];
  const b2x = positions[3 * k] - positions[3 * j];
  const b2y = positions[3 * k + 1] - positions[3 * j + 1];
  const b2z = positions[3 * k + 2] - positions[3 * j + 2];
  const b3x = positions[3 * l] - positions[3 * k];
  const b3y = positions[3 * l + 1] - positions[3 * k + 1];
  const b3z = positions[3 * l + 2] - positions[3 * k + 2];
  // n1 = b1 × b2, n2 = b2 × b3
  const n1x = b1y * b2z - b1z * b2y;
  const n1y = b1z * b2x - b1x * b2z;
  const n1z = b1x * b2y - b1y * b2x;
  const n2x = b2y * b3z - b2z * b3y;
  const n2y = b2z * b3x - b2x * b3z;
  const n2z = b2x * b3y - b2y * b3x;
  const length2 = Math.sqrt(b2x * b2x + b2y * b2y + b2z * b2z);
  if (!(length2 > 0)) return null;
  const ex = b2x / length2;
  const ey = b2y / length2;
  const ez = b2z / length2;
  const x = n1x * n2x + n1y * n2y + n1z * n2z;
  const crx = n1y * n2z - n1z * n2y;
  const cry = n1z * n2x - n1x * n2z;
  const crz = n1x * n2y - n1y * n2x;
  const y = crx * ex + cry * ey + crz * ez;
  const denominator = x * x + y * y;
  if (!(denominator > 1e-18)) return null;
  const phi = Math.atan2(y, x);
  if (!gradientOut) return { phi };

  // Per-atom 3x3 matrices of ∂n1/∂r and ∂n2/∂r, as row-major 9-arrays.
  const m1 = [skewOf(b2x, b2y, b2z), null, skewOf(b1x, b1y, b1z), ZERO3];
  m1[1] = negate3(add3(m1[0], m1[2]));
  const m2 = [ZERO3, skewOf(b3x, b3y, b3z), null, skewOf(b2x, b2y, b2z)];
  m2[2] = negate3(add3(m2[1], m2[3]));
  // ∂y needs these two constant vectors:
  const n2CrossE = cross3(n2x, n2y, n2z, ex, ey, ez);
  const n1CrossE = cross3(n1x, n1y, n1z, ex, ey, ez);
  const curvature = 1 / length2;
  for (let atom = 0; atom < 4; atom += 1) {
    const a = m1[atom];
    const b = m2[atom];
    // ∂x/∂r = M1ᵀ n2 + M2ᵀ n1
    const dx1 = vectorApplyTranspose(a, n2x, n2y, n2z);
    const dx2 = vectorApplyTranspose(b, n1x, n1y, n1z);
    const gx = [dx1[0] + dx2[0], dx1[1] + dx2[1], dx1[2] + dx2[2]];
    // ∂y/∂r = M1ᵀ(n2×ê) − M2ᵀ(n1×ê) + (n1×n2)·∂ê/∂r
    const dy1 = vectorApplyTranspose(a, n2CrossE[0], n2CrossE[1], n2CrossE[2]);
    const dy2 = vectorApplyTranspose(b, n1CrossE[0], n1CrossE[1], n1CrossE[2]);
    const gy = [dy1[0] - dy2[0], dy1[1] - dy2[1], dy1[2] - dy2[2]];
    if (atom === 1) {
      gy[0] += -(crx - y * ex) * curvature;
      gy[1] += -(cry - y * ey) * curvature;
      gy[2] += -(crz - y * ez) * curvature;
    } else if (atom === 2) {
      gy[0] += (crx - y * ex) * curvature;
      gy[1] += (cry - y * ey) * curvature;
      gy[2] += (crz - y * ez) * curvature;
    }
    gradientOut[atom] = [
      (x * gy[0] - y * gx[0]) / denominator,
      (x * gy[1] - y * gx[1]) / denominator,
      (x * gy[2] - y * gx[2]) / denominator,
    ];
  }
  return { phi };
}

const ZERO3 = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0]);

function skewOf(x, y, z) {
  return [0, -z, y, z, 0, -x, -y, x, 0];
}

function negate3(m) {
  return m.map((value) => -value);
}

function add3(a, b) {
  return a.map((value, index) => value + b[index]);
}

function cross3(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function vectorApplyTranspose(m, x, y, z) {
  return [
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z,
  ];
}

/**
 * The out-of-plane angle ω at a centre: 0 when the j→l bond lies in the
 * i–j–k plane, 90° when it is perpendicular to it. Returns null when the
 * geometry is degenerate (the plane or the bond has no direction).
 */
function outOfPlaneAngle(positions, i, j, k, l) {
  const ax = positions[3 * i] - positions[3 * j];
  const ay = positions[3 * i + 1] - positions[3 * j + 1];
  const az = positions[3 * i + 2] - positions[3 * j + 2];
  const bx = positions[3 * k] - positions[3 * j];
  const by = positions[3 * k + 1] - positions[3 * j + 1];
  const bz = positions[3 * k + 2] - positions[3 * j + 2];
  const ux = positions[3 * l] - positions[3 * j];
  const uy = positions[3 * l + 1] - positions[3 * j + 1];
  const uz = positions[3 * l + 2] - positions[3 * j + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const normal = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const length = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(normal > 1e-12) || !(length > 1e-12)) return null;
  const sine = (cx * ux + cy * uy + cz * uz) / (normal * length);
  const clamped = Math.min(1, Math.max(-1, sine));
  return Math.asin(clamped);
}

/** ∂ω/∂r for i, j, k, l, or null at the perpendicular barrier top (cos ω = 0). */
function outOfPlaneGradient(positions, i, j, k, l) {
  const ax = positions[3 * i] - positions[3 * j];
  const ay = positions[3 * i + 1] - positions[3 * j + 1];
  const az = positions[3 * i + 2] - positions[3 * j + 2];
  const bx = positions[3 * k] - positions[3 * j];
  const by = positions[3 * k + 1] - positions[3 * j + 1];
  const bz = positions[3 * k + 2] - positions[3 * j + 2];
  const ux = positions[3 * l] - positions[3 * j];
  const uy = positions[3 * l + 1] - positions[3 * j + 1];
  const uz = positions[3 * l + 2] - positions[3 * j + 2];
  const c = cross3(ax, ay, az, bx, by, bz);
  const normal = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
  const length = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(normal > 1e-12) || !(length > 1e-12)) return null;
  const cx = c[0] / normal;
  const cy = c[1] / normal;
  const cz = c[2] / normal;
  const sine = (cx * ux + cy * uy + cz * uz) / length;
  const cosine = Math.sqrt(Math.max(0, 1 - sine * sine));
  if (!(cosine > 1e-6)) return null; // ω = 90°: the barrier top, no gradient claimed
  // dω/dx = (1/cos ω) d(sin ω)/dx, so this returns ∂ω/∂r and the caller
  // multiplies by dE/dω = K sin ω.
  const scale = 1 / cosine;
  // d(sin ω)/d u = (ĉ − sin ω û)/|u|
  const fu = [
    (cx - sine * (ux / length)) / length,
    (cy - sine * (uy / length)) / length,
    (cz - sine * (uz / length)) / length,
  ];
  // d(sin ω)/d a = (b×u)/(N|u|) − sin ω (b×ĉ)/N
  const bCrossU = cross3(bx, by, bz, ux, uy, uz);
  const bCrossC = cross3(bx, by, bz, cx, cy, cz);
  const fa = [
    bCrossU[0] / (normal * length) - (sine * bCrossC[0]) / normal,
    bCrossU[1] / (normal * length) - (sine * bCrossC[1]) / normal,
    bCrossU[2] / (normal * length) - (sine * bCrossC[2]) / normal,
  ];
  // d(sin ω)/d b = (u×a)/(N|u|) − sin ω (ĉ×a)/N
  const uCrossA = cross3(ux, uy, uz, ax, ay, az);
  const cCrossA = cross3(cx, cy, cz, ax, ay, az);
  const fb = [
    uCrossA[0] / (normal * length) - (sine * cCrossA[0]) / normal,
    uCrossA[1] / (normal * length) - (sine * cCrossA[1]) / normal,
    uCrossA[2] / (normal * length) - (sine * cCrossA[2]) / normal,
  ];
  const gi = fa.map((value) => scale * value);
  const gk = fb.map((value) => scale * value);
  const gl = fu.map((value) => scale * value);
  const gj = [-gi[0] - gk[0] - gl[0], -gi[1] - gk[1] - gl[1], -gi[2] - gk[2] - gl[2]];
  return [gi, gj, gk, gl];
}

function positionsOf(atoms) {
  const positions = new Float64Array(atoms.length * 3);
  atoms.forEach((atom, index) => {
    positions[3 * index] = atom.x;
    positions[3 * index + 1] = atom.y;
    positions[3 * index + 2] = atom.z;
  });
  return positions;
}

/**
 * Every term evaluated at one geometry. `gradient` is 3N in kcal/mol/Å when
 * asked for, otherwise null. `only` restricts the evaluation to one term kind,
 * which is how a term is checked in isolation and how a caller reports one
 * without re-deriving the list.
 */
function evaluateAtoms(atoms, bonds, types, positions, {
  withGradient = false, only = null, includeVanDerWaals = true,
} = {}) {
  const { terms, warnings } = uffTerms(atoms, bonds, types, { includeVanDerWaals });
  const termsKcal = emptyTermsKcal();
  const counts = emptyCounts();
  const gradient = withGradient ? new Float64Array(atoms.length * 3) : null;

  for (const term of terms) {
    if (only && term.kind !== only) continue;
    const [i, ...rest] = term.indices;
    if (term.kind === 'bond') {
      const j = rest[0];
      const { distance } = displacement(positions, i, j);
      counts.bond += 1;
      const energy = bondStretchEnergyKcal(distance, term.parameters.r0Angstrom, term.parameters.kKcalPerAngstrom2);
      termsKcal.bond += energy;
      if (gradient) {
        const force = term.parameters.kKcalPerAngstrom2 * (distance - term.parameters.r0Angstrom);
        for (let axis = 0; axis < 3; axis += 1) {
          const component = distance > 0
            ? (force * (positions[3 * i + axis] - positions[3 * j + axis])) / distance
            : 0;
          gradient[3 * i + axis] += component;
          gradient[3 * j + axis] -= component;
        }
      }
      continue;
    }
    if (term.kind === 'angle') {
      const [j, k] = rest;
      const parameters = term.parameters;
      const angle = angleRadiansAt(positions, i, j, k);
      if (angle === null) continue;
      counts.angle += 1;
      termsKcal.angle += angleBendEnergyKcal(angle, parameters);
      if (!gradient) continue;
      const u = displacement(positions, i, j);
      const v = displacement(positions, k, j);
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const derivative = angleBendDerivativeKcalPerRadian(angle, parameters);
      // At exactly 0° or 180° the bend direction is undefined and the term's
      // own derivative is zero, so the force is zero rather than a 0/0.
      const coefficient = Math.abs(sine) < 1e-9 ? 0 : derivative / -sine;
      const du = [u.dx / u.distance, u.dy / u.distance, u.dz / u.distance];
      const dv = [v.dx / v.distance, v.dy / v.distance, v.dz / v.distance];
      const gu = [0, 1, 2].map((axis) => (coefficient * (dv[axis] - cosine * du[axis])) / u.distance);
      const gv = [0, 1, 2].map((axis) => (coefficient * (du[axis] - cosine * dv[axis])) / v.distance);
      for (let axis = 0; axis < 3; axis += 1) {
        gradient[3 * i + axis] += gu[axis];
        gradient[3 * k + axis] += gv[axis];
        gradient[3 * j + axis] -= gu[axis] + gv[axis];
      }
      continue;
    }
    if (term.kind === 'torsion') {
      const [j, k, l] = rest;
      const gradientOut = gradient ? [null, null, null, null] : null;
      const result = dihedralAngle(positions, i, j, k, l, gradient ? gradientOut : null);
      if (!result) continue;
      counts.torsion += 1;
      termsKcal.torsion += torsionEnergyKcal(result.phi, term.parameters);
      if (!gradient) continue;
      const derivative = torsionDerivativeKcalPerRadian(result.phi, term.parameters);
      gradientOut.forEach((perAtom, atomIndex) => {
        const target = term.indices[atomIndex];
        for (let axis = 0; axis < 3; axis += 1) {
          gradient[3 * target + axis] += derivative * perAtom[axis];
        }
      });
      continue;
    }
    if (term.kind === 'inversion') {
      const [j, k, l] = rest;
      const omega = outOfPlaneAngle(positions, i, j, k, l);
      if (omega === null) continue;
      counts.inversion += 1;
      termsKcal.inversion += inversionEnergyKcal(omega, term.parameters);
      if (!gradient) continue;
      const perAtom = outOfPlaneGradient(positions, i, j, k, l);
      if (!perAtom) continue; // perpendicular: the barrier top has no derivative
      const derivative = inversionDerivativeKcalPerRadian(omega, term.parameters);
      perAtom.forEach((vector, atomIndex) => {
        const target = term.indices[atomIndex];
        for (let axis = 0; axis < 3; axis += 1) {
          gradient[3 * target + axis] += derivative * vector[axis];
        }
      });
      continue;
    }
    if (term.kind === 'vanDerWaals') {
      const j = rest[0];
      const { distance } = displacement(positions, i, j);
      if (!(distance > 0)) continue;
      counts.vanDerWaals += 1;
      const { xAngstrom, depthKcal } = term.parameters;
      termsKcal.vanDerWaals += vanDerWaalsEnergyKcal(distance, xAngstrom, depthKcal);
      if (!gradient) continue;
      const ratio = xAngstrom / distance;
      const r6 = ratio ** 6;
      const force = (12 * depthKcal) / distance * (r6 - r6 * r6);
      for (let axis = 0; axis < 3; axis += 1) {
        const component = (force * (positions[3 * i + axis] - positions[3 * j + axis])) / distance;
        gradient[3 * i + axis] += component;
        gradient[3 * j + axis] -= component;
      }
    }
  }

  const totalKcal = termsKcal.bond + termsKcal.angle + termsKcal.torsion
    + termsKcal.inversion + termsKcal.vanDerWaals;
  return { totalKcal, termsKcal, counts, gradient, warnings };
}

/** Total energy in kcal/mol, with its terms, counts and honesty fields. */
export function uffEnergyKcal(molecule, {
  types: suppliedTypes = null,
  includeVanDerWaals = true,
  only = null,
} = {}) {
  const atoms = readAtoms(molecule?.atoms);
  const bonds = readBonds(molecule?.bonds, atoms.length);
  const types = resolveTypes(atoms, bonds, suppliedTypes);
  const positions = positionsOf(atoms);
  const result = evaluateAtoms(atoms, bonds, types, positions, {
    includeVanDerWaals, withGradient: false, only,
  });
  return {
    totalKcal: result.totalKcal,
    termsKcal: result.termsKcal,
    termCounts: result.counts,
    warnings: result.warnings,
    units: UFF_UNITS,
    method: UFF_METHOD,
    provenance: UFF_PROVENANCE,
    energyKind: UFF_ENERGY_KIND,
    comparableWithQuantumChemistry: false,
    accuracyNote: UFF_ACCURACY_NOTE,
    types: types.map((type) => type.label),
  };
}

/**
 * Analytic gradient, 3N in kcal/mol/Å, ordered x,y,z per atom, the same order
 * as `molecule.atoms`. Also returns the energy it came from, so a caller never
 * has to evaluate the geometry twice.
 */
export function uffGradientKcalPerAngstrom(molecule, {
  types: suppliedTypes = null,
  includeVanDerWaals = true,
  only = null,
} = {}) {
  const atoms = readAtoms(molecule?.atoms);
  const bonds = readBonds(molecule?.bonds, atoms.length);
  const types = resolveTypes(atoms, bonds, suppliedTypes);
  const positions = positionsOf(atoms);
  const result = evaluateAtoms(atoms, bonds, types, positions, {
    includeVanDerWaals, withGradient: true, only,
  });
  return {
    gradient: result.gradient,
    energyKcal: result.totalKcal,
    termsKcal: result.termsKcal,
    termCounts: result.counts,
    warnings: result.warnings,
    units: UFF_UNITS,
    method: UFF_METHOD,
    provenance: UFF_PROVENANCE,
    energyKind: UFF_ENERGY_KIND,
    comparableWithQuantumChemistry: false,
  };
}

/* ── geometry helpers ─────────────────────────────────────── */

/** The dihedral angle itself, in radians, with the sign convention the energy uses. */
export function dihedralAngleRadians(molecule, i, j, k, l) {
  const atoms = readAtoms(molecule?.atoms);
  const positions = positionsOf(atoms);
  const result = dihedralAngle(positions, i - 1, j - 1, k - 1, l - 1);
  return result ? result.phi : null;
}

/** The inversion (out-of-plane) angle, in radians; 0 means i, j, k, l are coplanar. */
export function outOfPlaneAngleRadians(molecule, i, j, k, l) {
  const atoms = readAtoms(molecule?.atoms);
  const positions = positionsOf(atoms);
  return outOfPlaneAngle(positions, i - 1, j - 1, k - 1, l - 1);
}

/** The angle i–j–k in radians. */
export function angleRadians(molecule, i, j, k) {
  const atoms = readAtoms(molecule?.atoms);
  const positions = positionsOf(atoms);
  return angleRadiansAt(positions, i - 1, j - 1, k - 1);
}

/* ── optimisation ─────────────────────────────────────────── */

export const UFF_CONVERGENCE = Object.freeze({
  /** Max |∂E/∂x| component, kcal/mol/Å. The one criterion this module claims. */
  forceToleranceKcalPerAngstrom: 0.05,
  maxIterations: 200,
  /** No atom moves further than this in one step, Å. */
  maxStepAngstrom: 0.2,
  memory: 8,
});

/**
 * Minimise the UFF energy. L-BFGS with an Armijo backtracking line search, a
 * per-step displacement cap, and an explicit statement of what happened:
 *
 *   converged: true   every gradient component below `forceToleranceKcalPerAngstrom`
 *   converged: false  the iteration cap was hit, or the line search could not
 *                     find a lower energy — the last state is returned with
 *                     `reason` naming which, never as a "minimum"
 *
 * The returned `energyKcal` is the energy of the returned `coords`, so a caller
 * that reports it is reporting something that was actually evaluated.
 */
export function optimizeUff(molecule, {
  types: suppliedTypes = null,
  includeVanDerWaals = true,
  forceToleranceKcalPerAngstrom = UFF_CONVERGENCE.forceToleranceKcalPerAngstrom,
  maxIterations = UFF_CONVERGENCE.maxIterations,
  maxStepAngstrom = UFF_CONVERGENCE.maxStepAngstrom,
  memory = UFF_CONVERGENCE.memory,
} = {}) {
  const atoms = readAtoms(molecule?.atoms);
  const bonds = readBonds(molecule?.bonds, atoms.length);
  const types = resolveTypes(atoms, bonds, suppliedTypes);
  const positionCount = atoms.length * 3;
  let positions = positionsOf(atoms);
  let state = evaluateAtoms(atoms, bonds, types, positions, {
    includeVanDerWaals, withGradient: true,
  });
  const initialEnergyKcal = state.totalKcal;
  const initialMaxForce = maxAbs(state.gradient);
  const history = [];
  let iterations = 0;
  let reason = 'max-force-below-tolerance';

  const evaluate = (candidate) => evaluateAtoms(
    atoms, bonds, types, candidate, { includeVanDerWaals, withGradient: true },
  );

  while (maxAbs(state.gradient) > forceToleranceKcalPerAngstrom) {
    if (iterations >= maxIterations) {
      reason = 'iteration-cap';
      break;
    }
    const direction = searchDirection(state.gradient, history);
    // A rigid translation has zero gradient and therefore zero force; remove
    // its numerical residue from the step so the molecule cannot drift while
    // it relaxes.
    for (let axis = 0; axis < 3; axis += 1) {
      let mean = 0;
      for (let atom = 0; atom < atoms.length; atom += 1) mean += direction[3 * atom + axis];
      mean /= atoms.length;
      for (let atom = 0; atom < atoms.length; atom += 1) direction[3 * atom + axis] -= mean;
    }
    // Never move an atom further than the cap in one step.
    const largest = maxAbs(direction);
    const scale = largest > maxStepAngstrom ? maxStepAngstrom / largest : 1;
    for (let index = 0; index < positionCount; index += 1) direction[index] *= scale;

    const directionalDerivative = dot(state.gradient, direction);
    if (!(directionalDerivative < 0)) {
      reason = 'not-a-descent-direction';
      break;
    }
    let step = 1;
    let candidate = null;
    let candidateState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      candidate = Float64Array.from(positions, (value, index) => value + step * direction[index]);
      const evaluated = evaluate(candidate);
      if (Number.isFinite(evaluated.totalKcal)
        && evaluated.totalKcal <= state.totalKcal + 1e-4 * step * directionalDerivative) {
        candidateState = evaluated;
        break;
      }
      step *= 0.5;
    }
    if (!candidateState) {
      reason = 'line-search-failed';
      break;
    }
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
  }

  const converged = maxAbs(state.gradient) <= forceToleranceKcalPerAngstrom;
  if (converged) reason = 'max-force-below-tolerance';
  const resultAtoms = atoms.map((atom, index) => ({
    ...(molecule.atoms[index] ?? {}),
    element: atom.element,
    x: positions[3 * index],
    y: positions[3 * index + 1],
    z: positions[3 * index + 2],
  }));

  return {
    coords: positions,
    atoms: resultAtoms,
    energyKcal: state.totalKcal,
    initialEnergyKcal,
    termsKcal: state.termsKcal,
    termCounts: state.counts,
    warnings: state.warnings,
    iterations,
    converged,
    reason,
    gradientNormKcalPerAngstrom: maxAbs(state.gradient),
    initialGradientNormKcalPerAngstrom: initialMaxForce,
    rmsGradientKcalPerAngstrom: rms(state.gradient),
    forceToleranceKcalPerAngstrom,
    maxIterations,
    units: UFF_UNITS,
    method: UFF_METHOD,
    provenance: UFF_PROVENANCE,
    energyKind: UFF_ENERGY_KIND,
    comparableWithQuantumChemistry: false,
    accuracyNote: UFF_ACCURACY_NOTE,
  };
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

function rms(values) {
  if (values.length === 0) return 0;
  return Math.sqrt(dot(values, values) / values.length);
}

/** L-BFGS two-loop recursion; history is oldest first. */
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
  const last = history[history.length - 1];
  const scale = last ? last.inverseCurvature * dot(last.s, last.y) : 1 / Math.max(1, maxAbs(gradient));
  for (let index = 0; index < count; index += 1) q[index] *= scale;
  for (let entry = 0; entry < history.length; entry += 1) {
    const { s, y, inverseCurvature } = history[entry];
    const beta = inverseCurvature * dot(y, q);
    const alpha = alphas[entry];
    for (let index = 0; index < count; index += 1) q[index] += s[index] * (alpha - beta);
  }
  const direction = new Float64Array(count);
  for (let index = 0; index < count; index += 1) direction[index] = -q[index];
  return direction;
}
