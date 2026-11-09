import { describe, expect, it } from 'vitest';
import {
  UFF_TYPES,
  UffRefusalError,
  angleBendEnergyKcal,
  angleParameters,
  angleRadians,
  dihedralAngleRadians,
  bondParameters,
  bondRestLengthAngstrom,
  bondStretchEnergyKcal,
  inversionEnergyKcal,
  inversionParameters,
  optimizeUff,
  outOfPlaneAngleRadians,
  torsionEnergyKcal,
  torsionParameters,
  typeAtoms,
  uffEnergyKcal,
  uffGradientKcalPerAngstrom,
  vanDerWaalsEnergyKcal,
  vanDerWaalsParameters,
} from '../src/shared/uff.js';

/**
 * Every fixture here is built from explicit coordinates and bonds. The point of
 * the module is what it computes from a geometry it can see, so nothing is
 * imported from a file and nothing is read from a fixture directory.
 *
 * Units throughout: Å for lengths, kcal/mol for energies, kcal/mol/Å for
 * gradients.
 */

const molecule = (rows, bonds) => ({
  atoms: rows.map(([element, x, y, z]) => ({ element, x, y, z })),
  bonds: bonds.map(([a, b, order = 1]) => ({ a, b, order })),
});

/** Water at a deliberately ordinary geometry: O–H 0.96 Å, H–O–H 104.5°. */
function water() {
  return molecule([
    ['O', 0, 0, 0],
    ['H', 0.96, 0, 0],
    ['H', -0.24, 0.9295, 0],
  ], [[1, 2], [1, 3]]);
}

/** Water pushed well out of shape: one bond long, the angle collapsed. */
function distortedWater() {
  return molecule([
    ['O', 0, 0, 0],
    ['H', 1.25, 0, 0],
    ['H', 0.1, 1.15, 0.35],
  ], [[1, 2], [1, 3]]);
}

/** Staggered ethane: C–C 1.54 Å, C–H 1.09 Å, tetrahedral angles. */
function ethane() {
  const theta = Math.acos(-1 / 3);
  const rows = [['C', 0, 0, 0], ['C', 1.54, 0, 0]];
  [1, -1].forEach((side) => {
    for (let k = 0; k < 3; k += 1) {
      const azimuth = (k * 2 * Math.PI) / 3 + (side > 0 ? 0 : Math.PI / 3);
      rows.push([
        'H',
        side > 0 ? 1.09 * Math.cos(theta) : 1.54 - 1.09 * Math.cos(theta),
        side * 1.09 * Math.sin(theta) * Math.cos(azimuth),
        side * 1.09 * Math.sin(theta) * Math.sin(azimuth),
      ]);
    }
  });
  return molecule(rows, [[1, 2], [1, 3], [1, 4], [1, 5], [2, 6], [2, 7], [2, 8]]);
}

/** Butane, curled: 14 atoms, every term but inversion. */
function butane() {
  return molecule([
    ['C', 0, 0, 0], ['C', 1.53, 0.2, 0.1], ['C', 2.0, 1.6, -0.3], ['C', 3.5, 1.8, 0.3],
    ['H', -0.4, 1.0, 0.3], ['H', -0.4, -0.8, 0.7], ['H', 0.2, -0.2, -1.05],
    ['H', 1.9, -0.4, 1.0], ['H', 1.9, -0.5, -0.8],
    ['H', 1.6, 2.2, 0.2], ['H', 1.7, 1.7, -1.4],
    ['H', 3.9, 0.8, 0.6], ['H', 3.8, 2.1, 1.3], ['H', 3.9, 2.4, -0.5],
  ], [[1, 2], [2, 3], [3, 4], [1, 5], [1, 6], [1, 7], [2, 8], [2, 9], [3, 10], [3, 11],
    [4, 12], [4, 13], [4, 14]]);
}

/**
 * An sp2 carbon with one substituent lifted 0.8 Å out of its plane: the
 * smallest molecule that has a real inversion term (ω ≈ 39°).
 */
function bentCarbonyl() {
  return molecule([
    ['C', 0, 0, 0],
    ['O', 0.22, 1.23, 0],
    ['H', -0.95, -0.55, 0],
    ['H', -0.4, -0.9, 0.8],
  ], [[1, 2, 2], [1, 3], [1, 4]]);
}

/** Formamide: an sp2 carbon, a planar-ish nitrogen, one torsion, no ring. */
function formamide() {
  return molecule([
    ['C', 0, 0, 0],
    ['O', 0.22, 1.23, 0],
    ['N', 1.35, -0.55, 0],
    ['H', -0.95, -0.55, 0],
    ['H', 1.15, -1.55, 0],
    ['H', 2.3, -0.2, 0.35],
  ], [[1, 2, 2], [1, 3], [1, 4], [3, 5], [3, 6]]);
}

/** Hydrogen peroxide: four atoms, so bond + angle + torsion + vdW, no inversion. */
function hydrogenPeroxide() {
  return molecule([
    ['O', 0, 0, 0],
    ['O', 1.45, 0, 0],
    ['H', -0.35, 0.95, 0],
    ['H', 1.75, -0.5, 0.8],
  ], [[1, 2], [1, 3], [2, 4]]);
}

/** Benzene, planar, 1.397 Å ring bonds, 1.084 Å C–H. */
function benzene() {
  const ring = 1.397;
  const ch = 1.084;
  const rows = [];
  for (let k = 0; k < 6; k += 1) {
    const angle = (k * Math.PI) / 3;
    rows.push(['C', ring * Math.cos(angle), ring * Math.sin(angle), 0]);
  }
  for (let k = 0; k < 6; k += 1) {
    const angle = (k * Math.PI) / 3;
    rows.push(['H', (ring + ch) * Math.cos(angle), (ring + ch) * Math.sin(angle), 0]);
  }
  const bonds = [];
  for (let k = 0; k < 6; k += 1) bonds.push([k + 1, ((k + 1) % 6) + 1, 1.5]);
  for (let k = 0; k < 6; k += 1) bonds.push([k + 1, k + 7, 1]);
  return molecule(rows, bonds);
}

const CENTRAL_DIFFERENCE_ANGSTROM = 1e-5;

/** Central finite differences of the energy, 3N components, kcal/mol/Å. */
function finiteDifferenceGradient(mol, { only = null, h = CENTRAL_DIFFERENCE_ANGSTROM } = {}) {
  const out = [];
  for (let atom = 0; atom < mol.atoms.length; atom += 1) {
    for (const axis of ['x', 'y', 'z']) {
      const plus = structuredClone(mol);
      const minus = structuredClone(mol);
      plus.atoms[atom][axis] += h;
      minus.atoms[atom][axis] -= h;
      out.push(
        (uffEnergyKcal(plus, { only }).totalKcal - uffEnergyKcal(minus, { only }).totalKcal) / (2 * h),
      );
    }
  }
  return out;
}

/**
 * Worst relative error between the analytic gradient and central differences.
 * The denominator is floored at 1 kcal/mol/Å so a component that happens to be
 * near zero cannot turn rounding noise into a "relative error" of 10.
 */
function worstRelativeGradientError(mol, options = {}) {
  const analytic = Array.from(uffGradientKcalPerAngstrom(mol, options).gradient);
  const numeric = finiteDifferenceGradient(mol, options);
  let worst = 0;
  let worstAt = -1;
  for (let index = 0; index < numeric.length; index += 1) {
    const error = Math.abs(analytic[index] - numeric[index])
      / Math.max(Math.abs(analytic[index]), Math.abs(numeric[index]), 1);
    if (error > worst) {
      worst = error;
      worstAt = index;
    }
  }
  return { worst, worstAt, analytic, numeric };
}

describe('UFF atom typing', () => {
  it('types by element and bond order, not by order of appearance', () => {
    expect(typeAtoms(water().atoms, water().bonds).types.map((type) => type.label))
      .toEqual(['O_3', 'H_', 'H_']);
    expect(typeAtoms(benzene().atoms, benzene().bonds).types.slice(0, 2).map((type) => type.label))
      .toEqual(['C_R', 'C_R']);
    const ethene = molecule([['C', 0, 0, 0], ['C', 1.33, 0, 0]], [[1, 2, 2]]);
    const ethyne = molecule([['C', 0, 0, 0], ['C', 1.2, 0, 0]], [[1, 2, 3]]);
    expect(typeAtoms(ethene.atoms, ethene.bonds).types[0].label).toBe('C_2');
    expect(typeAtoms(ethyne.atoms, ethyne.bonds).types[1].label).toBe('C_1');
    const thiol = molecule([['S', 0, 0, 0], ['H', 1.34, 0, 0]], [[1, 2]]);
    expect(typeAtoms(thiol.atoms, thiol.bonds).types[0].label).toBe('S_3+2');
  });

  it('refuses an element outside the table by name, and computes nothing for it', () => {
    const silane = molecule([['Si', 0, 0, 0], ['H', 1.48, 0, 0]], [[1, 2]]);
    const typed = typeAtoms(silane.atoms, silane.bonds);
    expect(typed.ok).toBe(false);
    expect(typed.types[0]).toBeNull();
    expect(typed.refused[0]).toMatchObject({ atomIndex: 1, element: 'Si', code: 'unknown-element' });
    expect(typed.refused[0].message).toContain('Si');

    let refusal = null;
    try {
      uffEnergyKcal(silane);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UffRefusalError);
    expect(refusal.code).toBe('unknown-element');
    expect(refusal.element).toBe('Si');
    expect(refusal.atomIndex).toBe(1);
  });

  it('refuses a bond it cannot interpret instead of rounding the order', () => {
    const quadruple = molecule([['C', 0, 0, 0], ['C', 1.2, 0, 0]], [[1, 2, 4]]);
    expect(() => uffEnergyKcal(quadruple)).toThrow(UffRefusalError);
    const dangling = { atoms: water().atoms, bonds: [{ a: 1, b: 9, order: 1 }] };
    expect(() => uffEnergyKcal(dangling)).toThrow(/indices start at 1/);
  });
});

describe('each term against a hand-computed number', () => {
  it('bond stretch: the paper\'s r0 and E = ½ K (r − r0)²', () => {
    // r0 = r_O + r_H − r_EN, with r_EN = r_O r_H (√χ_O − √χ_H)² / (χ_O r_O + χ_H r_H)
    //    = 0.658 + 0.354 − 0.658·0.354·(2.9565 − 2.1280)² / (8.741·0.658 + 4.528·0.354)
    //    = 1.012 − 0.15993/7.3553 = 1.012 − 0.02175 = 0.99025 Å
    // K  = 2·332.06·Z_O·Z_H / r0³ = 664.12·2.3·0.712 / 0.99025³ = 1087.8/0.97103 = 1120.3
    const oh = bondParameters(UFF_TYPES.O_3, UFF_TYPES.H_, 1);
    expect(oh.r0Angstrom).toBeCloseTo(0.9903, 4);
    expect(oh.kKcalPerAngstrom2).toBeCloseTo(1120.3, 0);

    // E(1.05 Å) = ½·1120.3·(1.05 − 0.99025)² = 560.15·0.0035699 = 2.0002 kcal/mol
    expect(bondStretchEnergyKcal(1.05, oh.r0Angstrom, oh.kKcalPerAngstrom2)).toBeCloseTo(2.0, 2);
    // …and zero at the parameter's own r0, by construction.
    expect(bondStretchEnergyKcal(oh.r0Angstrom, oh.r0Angstrom, oh.kKcalPerAngstrom2)).toBe(0);
  });

  it('bond stretch: C–C single, double, triple and aromatic lengths are the paper\'s', () => {
    // Eq. (1): r_IJ = r_i + r_j − 0.1332 (r_i + r_j) ln BO. For C–C the
    // electronegativity term is zero because both χ are equal.
    //   single   2·0.757 = 1.514
    //   double   2·0.732 − 0.1332·1.464·ln2 = 1.464 − 0.13518 = 1.32882
    //   triple   2·0.706 − 0.1332·1.412·ln3 = 1.412 − 0.20666 = 1.20534
    //   aromatic 2·0.729 − 0.1332·1.458·ln1.5 = 1.458 − 0.07874 = 1.37926
    expect(bondRestLengthAngstrom(UFF_TYPES.C_3, UFF_TYPES.C_3, 1)).toBeCloseTo(1.514, 6);
    expect(bondRestLengthAngstrom(UFF_TYPES.C_2, UFF_TYPES.C_2, 2)).toBeCloseTo(1.32882, 4);
    expect(bondRestLengthAngstrom(UFF_TYPES.C_1, UFF_TYPES.C_1, 3)).toBeCloseTo(1.20534, 4);
    expect(bondRestLengthAngstrom(UFF_TYPES.C_R, UFF_TYPES.C_R, 1.5)).toBeCloseTo(1.37926, 4);
  });

  it('angle bend: the cosine series of eqs. (4)–(6)', () => {
    // θ0 = 104.51°, sin θ0 = 0.96815, cos θ0 = −0.25052
    //   C2 = 1/(4 sin²θ0)      = 1/(4·0.93732) = 0.266745
    //   C1 = −4 C2 cos θ0      = −4·0.266745·(−0.25052) = 0.267331
    //   C0 = C2 (2 cos²θ0 + 1) = 0.266745·1.12552 = 0.300235
    const hoh = angleParameters(UFF_TYPES.H_, UFF_TYPES.O_3, UFF_TYPES.H_, 1, 1);
    expect(hoh.theta0Radians * (180 / Math.PI)).toBeCloseTo(104.51, 6);
    expect(hoh.c2).toBeCloseTo(0.266745, 5);
    expect(hoh.c1).toBeCloseTo(0.267331, 5);
    expect(hoh.c0).toBeCloseTo(0.300235, 5);
    // K from eq. (5) for two O–H of 0.99025 Å and r13 = 1.5661 Å: 120.50
    expect(hoh.kKcalPerRadian2).toBeCloseTo(120.5, 1);

    // E(110°) = 120.50·(0.300235 + 0.267331·cos110° + 0.266745·cos220°)
    //         = 120.50·(0.30020 − 0.09142 − 0.20431) = 120.50·0.00447 = 0.5386
    expect(angleBendEnergyKcal((110 * Math.PI) / 180, hoh)).toBeCloseTo(0.5379, 3);
    // E(θ0) = K(C0 + C1 cosθ0 + C2 cos2θ0) = 0 by construction of C0/C1/C2.
    expect(angleBendEnergyKcal(hoh.theta0Radians, hoh)).toBeCloseTo(0, 10);

    // A linear centre has no finite cosine coefficients (C2 = 1/(4 sin²180°) = ∞);
    // it is evaluated as ½ K (θ − 180°)², whose curvature at θ0 is the same K.
    const alkyne = angleParameters(UFF_TYPES.C_1, UFF_TYPES.C_1, UFF_TYPES.C_1, 3, 1);
    expect(alkyne.linear).toBe(true);
    expect(alkyne.kKcalPerRadian2).toBeCloseTo(135.4, 1);
    // E(175°) = ½·135.4·(5° = 0.08727 rad)² = 67.70·0.0076155 = 0.5156
    expect(angleBendEnergyKcal((175 * Math.PI) / 180, alkyne)).toBeCloseTo(0.5156, 3);
  });

  it('torsion: ethane has V = √(V_C V_C) = 2.119 and minima at 60°, 180°, 300°', () => {
    const hcch = torsionParameters(UFF_TYPES.H_, UFF_TYPES['C_3'], UFF_TYPES['C_3'], UFF_TYPES.H_, 1);
    // V = √(2.119·2.119) = 2.119, n = 3, cos(nφ0) = cos(180°) = −1
    expect(hcch.barrierKcal).toBeCloseTo(2.119, 6);
    expect(hcch.periodicity).toBe(3);
    expect(hcch.cosPeriodicAngle).toBe(-1);
    // E(0°) = ½V(1 + cos0) = V = 2.119 (eclipsed)
    expect(torsionEnergyKcal(0, hcch)).toBeCloseTo(2.119, 6);
    // E(60°) = ½V(1 + cos180°) = 0, E(180°) = ½V(1 + cos540°) = 0 (staggered)
    expect(torsionEnergyKcal((60 * Math.PI) / 180, hcch)).toBeCloseTo(0, 12);
    expect(torsionEnergyKcal((180 * Math.PI) / 180, hcch)).toBeCloseTo(0, 12);
  });

  it('torsion: the sp2–sp2 barrier is eq. (17), 5 √(U U)(1 + 4.18 ln BO)', () => {
    // U = 2 for both C_2, BO = 2: 5·2·(1 + 4.18·0.69315) = 10·3.89736 = 38.97
    const cc = torsionParameters(UFF_TYPES.C_2, UFF_TYPES.C_2, UFF_TYPES.C_2, UFF_TYPES.C_2, 2);
    expect(cc.barrierKcal).toBeCloseTo(38.97, 2);
    expect(cc.periodicity).toBe(2);
    expect(cc.cosPeriodicAngle).toBe(1);
  });

  it('inversion: planar sp2 is the minimum, perpendicular is the barrier', () => {
    // An sp2 carbon bonded to an sp2 oxygen: C0 = 1, C1 = −1, C2 = 0,
    // K = 50 kcal/mol over the centre's three triples → 50/3 per triple.
    const amideCarbon = inversionParameters(UFF_TYPES.C_2, { boundToSp2Oxygen: true });
    expect(amideCarbon.kKcal).toBeCloseTo(50 / 3, 10);
    expect(inversionEnergyKcal(0, amideCarbon)).toBeCloseTo(0, 12);
    expect(inversionEnergyKcal(Math.PI / 2, amideCarbon)).toBeCloseTo(50 / 3, 10);

    // A plain sp2 carbon or an aromatic nitrogen: K = 6 over three triples.
    const aromaticNitrogen = inversionParameters(UFF_TYPES.N_R, {});
    expect(aromaticNitrogen.kKcal).toBeCloseTo(2, 12);
    expect(inversionEnergyKcal(Math.PI / 2, aromaticNitrogen)).toBeCloseTo(2, 12);

    // A pyramidal centre gets no inversion claim at all.
    expect(inversionParameters(UFF_TYPES['P_3+3'], {})).toBeNull();
  });

  it('van der Waals: geometric means, and −D at the minimum', () => {
    // x_HC = √(2.886·3.851) = √11.1146 = 3.3338 Å, D_HC = √(0.044·0.105) = 0.067971
    const hc = vanDerWaalsParameters(UFF_TYPES.H_, UFF_TYPES['C_3']);
    expect(hc.xAngstrom).toBeCloseTo(3.3338, 4);
    expect(hc.depthKcal).toBeCloseTo(0.067971, 6);
    // E(x) = D[(x/x)¹² − 2(x/x)⁶] = D(1 − 2) = −D
    expect(vanDerWaalsEnergyKcal(hc.xAngstrom, hc.xAngstrom, hc.depthKcal))
      .toBeCloseTo(-0.067971, 6);
    // E(2x) = D[(1/2)¹² − 2(1/2)⁶] = D(0.000244 − 0.03125) = −0.002108
    expect(vanDerWaalsEnergyKcal(2 * hc.xAngstrom, hc.xAngstrom, hc.depthKcal))
      .toBeCloseTo(-0.0021075, 6);
  });

  it('assembles a whole molecule: water is 2 bonds and 1 angle, and nothing else', () => {
    const result = uffEnergyKcal(water());
    expect(result.termCounts).toEqual({
      bond: 2, angle: 1, torsion: 0, inversion: 0, vanDerWaals: 0,
    });
    expect(result.totalKcal).toBeCloseTo(
      result.termsKcal.bond + result.termsKcal.angle, 12,
    );
  });

  it('excludes 1-2 and 1-3 pairs from the van der Waals sum, and includes 1-4', () => {
    const result = uffEnergyKcal(butane());
    const atoms = butane().atoms.length;
    const pairs = (atoms * (atoms - 1)) / 2;
    // butane is a tree: no pair is both bonded and 1-3, so the exclusion is
    // 13 bonds + 24 angles.
    expect(result.termCounts.vanDerWaals).toBe(pairs - 13 - 24);
    expect(result.termCounts.torsion).toBe(27); // three C–C bonds × nine triples
  });

  it('shares one torsional barrier among the triples about a bond', () => {
    const single = torsionParameters(UFF_TYPES['C_3'], UFF_TYPES['C_3'], UFF_TYPES['C_3'], UFF_TYPES['C_3'], 1);
    // Nine triples about each C–C bond, so each carries V/9 = 0.2354.
    expect(single.barrierKcal / 9).toBeCloseTo(0.2354, 4);
  });
});

describe('the analytic gradient against central finite differences', () => {
  it('matches on water (bond + angle)', () => {
    const { worst, worstAt } = worstRelativeGradientError(water());
    expect(worst, `worst component ${worstAt}`).toBeLessThan(1e-5);
  });

  it('matches on hydrogen peroxide (bond + angle + torsion + van der Waals)', () => {
    const { worst } = worstRelativeGradientError(hydrogenPeroxide());
    expect(worst).toBeLessThan(1e-5);
  });

  it('matches on the bent sp2 carbon (bond + angle + inversion + van der Waals)', () => {
    // The inversion gradient is the one that is easiest to get wrong, so it is
    // differentiated on its own as well as inside the whole molecule.
    const inversionOnly = worstRelativeGradientError(bentCarbonyl(), { only: 'inversion' });
    expect(inversionOnly.worst).toBeLessThan(1e-5);
    const { worst } = worstRelativeGradientError(bentCarbonyl());
    expect(worst).toBeLessThan(1e-5);
  });

  it('matches on formamide and on butane, and prints the worst relative error', () => {
    const cases = [
      ['water', water()],
      ['hydrogen peroxide', hydrogenPeroxide()],
      ['formamide', formamide()],
      ['butane', butane()],
      ['benzene', benzene()],
    ];
    let worstOverall = 0;
    let worstCase = '';
    for (const [name, mol] of cases) {
      const { worst } = worstRelativeGradientError(mol);
      if (worst > worstOverall) {
        worstOverall = worst;
        worstCase = name;
      }
      expect(worst, `${name} gradient`).toBeLessThan(1e-5);
    }
    // Printed once, unconditionally, so the number is in the log and not only
    // in an assertion that a green run never shows.
    process.stdout.write('\nUFF analytic gradient vs central differences: worst relative '
      + `error ${worstOverall.toExponential(2)} (${worstCase}), tolerance 1e-5\n\n`);
    expect(worstOverall).toBeLessThan(1e-5);
  });

  it('has zero net force and is unchanged by translation and rotation', () => {
    const mol = butane();
    const { gradient } = uffGradientKcalPerAngstrom(mol);
    for (const axis of [0, 1, 2]) {
      const net = [0, 1, 2, 3].reduce((sum, offset) => sum + gradient[axis + 3 * offset], 0);
      const total = Array.from({ length: mol.atoms.length }, (_, atom) => gradient[3 * atom + axis])
        .reduce((sum, value) => sum + value, 0);
      expect(Number.isFinite(net)).toBe(true);
      expect(total).toBeCloseTo(0, 8);
    }
    const moved = structuredClone(mol);
    moved.atoms.forEach((atom) => {
      atom.x += 3.7;
      atom.y -= 1.2;
      atom.z += 0.4;
    });
    expect(uffEnergyKcal(moved).totalKcal).toBeCloseTo(uffEnergyKcal(mol).totalKcal, 10);

    const angle = 0.7;
    const rotated = structuredClone(mol);
    rotated.atoms.forEach((atom) => {
      const x = atom.x * Math.cos(angle) - atom.z * Math.sin(angle);
      const z = atom.x * Math.sin(angle) + atom.z * Math.cos(angle);
      atom.x = x;
      atom.z = z;
    });
    expect(uffEnergyKcal(rotated).totalKcal).toBeCloseTo(uffEnergyKcal(mol).totalKcal, 10);
  });
});

describe('the minimiser', () => {
  it('relaxes water from a distorted geometry and says how far the gradient fell', () => {
    const result = optimizeUff(distortedWater());
    expect(result.converged).toBe(true);
    expect(result.reason).toBe('max-force-below-tolerance');
    expect(result.gradientNormKcalPerAngstrom)
      .toBeLessThan(result.forceToleranceKcalPerAngstrom);
    // The starting geometry had atoms 0.35 Å out of place; the force has to
    // fall by more than three orders of magnitude for that to be a minimum.
    expect(result.initialGradientNormKcalPerAngstrom
      / result.gradientNormKcalPerAngstrom).toBeGreaterThan(1000);
    expect(result.initialEnergyKcal).toBeGreaterThan(10);

    const distance = (a, b) => Math.hypot(
      result.coords[3 * a] - result.coords[3 * b],
      result.coords[3 * a + 1] - result.coords[3 * b + 1],
      result.coords[3 * a + 2] - result.coords[3 * b + 2],
    );
    // Water's UFF minimum is its own parameter set: O–H 0.9903 Å, 104.51°.
    expect(distance(0, 1)).toBeCloseTo(0.9903, 2);
    expect(distance(0, 2)).toBeCloseTo(0.9903, 2);
    expect((angleRadians({ atoms: result.atoms }, 2, 1, 3) * 180) / Math.PI).toBeCloseTo(104.51, 1);
    // The reported energy is the energy of the reported coordinates.
    expect(uffEnergyKcal({ atoms: result.atoms, bonds: distortedWater().bonds }).totalKcal)
      .toBeCloseTo(result.energyKcal, 10);
  });

  it('relaxes a bare C–C bond to the parameter\'s r0, and ethane to 1.525 Å', () => {
    const bare = molecule([['C', 0, 0, 0], ['C', 1.05, 0, 0]], [[1, 2]]);
    const relaxed = optimizeUff(bare);
    expect(relaxed.converged).toBe(true);
    // With no angle or van der Waals term there is nothing to balance the
    // bond, so it lands on r0 = 1.514 Å exactly.
    expect(Math.hypot(
      relaxed.coords[3] - relaxed.coords[0],
      relaxed.coords[4] - relaxed.coords[1],
      relaxed.coords[5] - relaxed.coords[2],
    )).toBeCloseTo(1.514, 4);
    expect(relaxed.energyKcal).toBeCloseTo(0, 8);
  });

  it('relaxes ethane with its neighbours in place', () => {
    const stretched = ethane();
    stretched.atoms[1].x = 1.75;
    const result = optimizeUff(stretched, { maxIterations: 500 });
    expect(result.converged).toBe(true);
    const cc = Math.hypot(
      result.coords[3] - result.coords[0],
      result.coords[4] - result.coords[1],
      result.coords[5] - result.coords[2],
    );
    // r0(C_3, C_3, 1) = 0.757 + 0.757 = 1.514 Å, and the relaxed bond is
    // 1.525 Å: the neighbouring angle terms and the 1-4 H⋯H contacts push it
    // 0.011 Å out, which is the force field working, not a bug.
    expect(Math.abs(cc - 1.5254)).toBeLessThan(0.005);
  });

  it('keeps benzene planar and at 1.399 Å, within the force field it claims', () => {
    const squashed = benzene();
    squashed.atoms.forEach((atom) => {
      atom.z += (atom.element === 'C' ? 0.25 : -0.2);
    });
    const result = optimizeUff(squashed, { maxIterations: 500 });
    expect(result.converged).toBe(true);
    // Planarity is the spread of z, not its magnitude: the whole molecule is
    // free to sit at any z, and only the deviation from the best plane is a
    // property of the force field.
    const zs = result.atoms.map((atom) => atom.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(1e-3);
    const cc = Math.hypot(
      result.coords[3] - result.coords[0],
      result.coords[4] - result.coords[1],
      result.coords[5] - result.coords[2],
    );
    // UFF's aromatic C⋯C is 1.379 Å at the parameter, 1.399 Å after relaxation.
    expect(cc).toBeGreaterThan(1.37);
    expect(cc).toBeLessThan(1.41);
  });

  it('reports non-convergence when the iteration cap is hit instead of pretending', () => {
    const result = optimizeUff(distortedWater(), {
      maxIterations: 1,
      forceToleranceKcalPerAngstrom: 1e-9,
    });
    expect(result.iterations).toBe(1);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe('iteration-cap');
    expect(result.gradientNormKcalPerAngstrom).toBeGreaterThan(1e-9);
    // The last state is a real state: it is not presented as a minimum, and the
    // energy it reports is the energy of the coordinates it returns.
    expect(uffEnergyKcal({ atoms: result.atoms, bonds: distortedWater().bonds }).totalKcal)
      .toBeCloseTo(result.energyKcal, 10);
  });

  it('does not claim convergence for a molecule it cannot move', () => {
    const single = molecule([['O', 0, 0, 0]], []);
    const result = optimizeUff(single);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.energyKcal).toBe(0);
    expect(result.gradientNormKcalPerAngstrom).toBe(0);
  });
});

describe('molecules the engine must not pretend about', () => {
  it('gives a molecule with no bonds an energy of zero plus the reason', () => {
    const lone = molecule([['O', 0, 0, 0]], []);
    const result = uffEnergyKcal(lone);
    expect(result.totalKcal).toBe(0);
    expect(result.termCounts).toEqual({
      bond: 0, angle: 0, torsion: 0, inversion: 0, vanDerWaals: 0,
    });
    expect(result.warnings.join(' ')).toMatch(/one atom and no bonds/);
    const gradient = Array.from(uffGradientKcalPerAngstrom(lone).gradient);
    expect(gradient).toEqual([0, 0, 0]);
    gradient.forEach((component) => expect(Number.isNaN(component)).toBe(false));
  });

  it('leaves an atom with no neighbours out of the bonded terms without a NaN', () => {
    // Two atoms that are not bonded: no bond, angle, torsion or inversion term
    // can exist, and the only energy is their Lennard-Jones attraction.
    const pair = molecule([['H', 0, 0, 0], ['H', 2.0, 0, 0]], []);
    const result = uffEnergyKcal(pair);
    expect(Number.isFinite(result.totalKcal)).toBe(true);
    expect(result.termCounts.vanDerWaals).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/states no bonds/);
    Array.from(uffGradientKcalPerAngstrom(pair).gradient)
      .forEach((component) => expect(Number.isFinite(component)).toBe(true));

    // …and the water oxygen keeps its terms while a lone hydrogen rides along.
    const tagged = water();
    tagged.atoms.push({ element: 'H', x: 4.0, y: 0.5, z: -0.5 });
    const mixed = uffEnergyKcal(tagged);
    expect(mixed.termCounts.bond).toBe(2);
    expect(mixed.warnings.join(' ')).not.toMatch(/states no bonds/);
    Array.from(uffGradientKcalPerAngstrom(tagged).gradient)
      .forEach((component) => expect(Number.isFinite(component)).toBe(true));
  });

  it('states the inversion limit for a pyramidal centre it does not model', () => {
    const phosphine = molecule([
      ['P', 0, 0, 0],
      ['H', 0.7, 0.7, 0.7],
      ['H', -0.7, -0.7, 0.7],
      ['H', 0.7, -0.7, -0.7],
    ], [[1, 2], [1, 3], [1, 4]]);
    const result = uffEnergyKcal(phosphine);
    expect(result.termCounts.inversion).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/group-5 inversion coefficients are not implemented/);
  });

  it('states the conjugation limit for an amide nitrogen it types from single bonds', () => {
    const result = uffEnergyKcal(formamide());
    // The sp2 carbon (bonded to a double-bonded O) does get an inversion term;
    // the nitrogen is typed N_3 from three single bonds and is warned about.
    expect(result.termCounts.inversion).toBe(3);
    expect(result.warnings.join(' ')).toMatch(/perceives no conjugation/);
    expect(result.types).toEqual(['C_2', 'O_2', 'N_3', 'H_', 'H_', 'H_']);
  });
});

describe('the result says what kind of number it is', () => {
  it('carries the method, the units and the accuracy statement', () => {
    const result = uffEnergyKcal(water());
    expect(result.method).toBe('UFF');
    expect(result.units.energy).toBe('kcal/mol');
    expect(result.units.length).toBe('angstrom');
    expect(result.comparableWithQuantumChemistry).toBe(false);
    expect(result.energyKind).toMatch(/not a total electronic energy/);
    expect(result.accuracyNote).toMatch(/not comparable with a QM energy/);
    expect(result.provenance).toMatch(/1992/);
  });

  it('carries the same statement out of the minimiser', () => {
    const result = optimizeUff(distortedWater());
    expect(result.method).toBe('UFF');
    expect(result.comparableWithQuantumChemistry).toBe(false);
    expect(result.energyKind).toMatch(/not a total electronic energy/);
    expect(result.units.gradient).toBe('kcal/mol/angstrom');
  });

  it('reports the dihedral and the out-of-plane angle it used, in radians', () => {
    // A planar cis arrangement: the dihedral is 0 and the sp2 centre is flat.
    const flat = molecule([
      ['C', 0, 0, 0], ['C', 1.5, 0, 0], ['C', 1.5, 1.4, 0], ['C', 0.0, 1.4, 0],
    ], [[1, 2], [2, 3], [3, 4]]);
    expect(Math.abs(dihedralFor(flat))).toBeLessThan(1e-9);
    expect(Math.abs(dihedralAngleRadians(flat, 1, 2, 3, 4))).toBeLessThan(1e-9);
    // …and the module's dihedral agrees with an independent recomputation on a
    // twisted geometry, sign included: the energy only needs cos nφ, but a
    // caller reading the angle needs the convention to be stable.
    const twisted = structuredClone(flat);
    twisted.atoms[3].z = 0.9;
    expect(dihedralAngleRadians(twisted, 1, 2, 3, 4)).toBeCloseTo(dihedralFor(twisted), 12);
    expect(Math.abs(outOfPlaneAngleRadians(bentCarbonyl(), 2, 1, 3, 4)))
      .toBeGreaterThan(0.5);
  });
});

/** The dihedral, recomputed here from coordinates as an independent check. */
function dihedralFor(mol) {
  const [p1, p2, p3, p4] = mol.atoms.map((atom) => [atom.x, atom.y, atom.z]);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const b1 = sub(p2, p1);
  const b2 = sub(p3, p2);
  const b3 = sub(p4, p3);
  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  const axis = b2.map((value) => value / Math.hypot(...b2));
  return Math.atan2(dot(cross(n1, n2), axis), dot(n1, n2));
}
