/**
 * Formula, composition and mass for a set of Cartesian atoms.
 *
 * The molecule window and the dataset records table both need the same
 * arithmetic: how many of each element, the Hill-ordered formula, and the
 * molecular mass. Pure functions, no DOM, so they are testable and cannot drift
 * between the two places that show them.
 */

/** Standard atomic weights (IUPAC 2021, abridged to five significant figures). */
const ATOMIC_MASS = Object.freeze({
  H: 1.008, He: 4.0026, Li: 6.94, Be: 9.0122, B: 10.81, C: 12.011, N: 14.007, O: 15.999,
  F: 18.998, Ne: 20.18, Na: 22.99, Mg: 24.305, Al: 26.982, Si: 28.085, P: 30.974, S: 32.06,
  Cl: 35.45, Ar: 39.948, K: 39.098, Ca: 40.078, Sc: 44.956, Ti: 47.867, V: 50.942, Cr: 51.996,
  Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Ga: 69.723, Ge: 72.63,
  As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798, Rb: 85.468, Sr: 87.62, Y: 88.906, Zr: 91.224,
  Nb: 92.906, Mo: 95.95, Tc: 98, Ru: 101.07, Rh: 102.91, Pd: 106.42, Ag: 107.87, Cd: 112.41,
  In: 114.82, Sn: 118.71, Sb: 121.76, Te: 127.6, I: 126.9, Xe: 131.29, Cs: 132.91, Ba: 137.33,
  La: 138.91, Ce: 140.12, Pr: 140.91, Nd: 144.24, Pm: 145, Sm: 150.36, Eu: 151.96, Gd: 157.25,
  Tb: 158.93, Dy: 162.5, Ho: 164.93, Er: 167.26, Tm: 168.93, Yb: 173.05, Lu: 174.97, Hf: 178.49,
  Ta: 180.95, W: 183.84, Re: 186.21, Os: 190.23, Ir: 192.22, Pt: 195.08, Au: 196.97, Hg: 200.59,
  Tl: 204.38, Pb: 207.2, Bi: 208.98, Po: 209, At: 210, Rn: 222, Fr: 223, Ra: 226, Ac: 227,
  Th: 232.04, Pa: 231.04, U: 238.03, Np: 237, Pu: 244, Am: 243, Cm: 247, Bk: 247, Cf: 251,
  Es: 252, Fm: 257, Md: 258, No: 259, Lr: 266, Rf: 267, Db: 268, Sg: 269, Bh: 270, Hs: 269,
  Mt: 278, Ds: 281, Rg: 282, Cn: 285, Nh: 286, Fl: 289, Mc: 290, Lv: 293, Ts: 294, Og: 294,
});

export function atomicMass(symbol) {
  return ATOMIC_MASS[String(symbol)] ?? null;
}

/** Element → count, in first-appearance order. */
export function compositionOf(atoms = []) {
  const counts = new Map();
  for (const atom of Array.isArray(atoms) ? atoms : []) {
    const symbol = String(atom?.element || '');
    if (!symbol) continue;
    counts.set(symbol, (counts.get(symbol) || 0) + 1);
  }
  return counts;
}

/**
 * Hill-order formula: C first, then H, then everything else alphabetically.
 * With no carbon, everything (hydrogen included) is alphabetical — the standard
 * convention for inorganic and organometallic formulas.
 */
export function formulaOf(atoms = []) {
  const counts = compositionOf(atoms);
  if (counts.size === 0) return '';
  const hasCarbon = counts.has('C');
  const symbols = [...counts.keys()].sort((a, b) => {
    if (hasCarbon) {
      if (a === 'C') return -1;
      if (b === 'C') return 1;
      if (a === 'H') return -1;
      if (b === 'H') return 1;
    }
    return a.localeCompare(b);
  });
  return symbols.map((symbol) => {
    const count = counts.get(symbol);
    return count === 1 ? symbol : `${symbol}${count}`;
  }).join('');
}

/** Sum of atomic masses, or null when a symbol has no tabulated mass. */
export function massOf(atoms = []) {
  let total = 0;
  for (const [symbol, count] of compositionOf(atoms)) {
    const mass = atomicMass(symbol);
    if (mass === null) return null;
    total += mass * count;
  }
  return total;
}

/** `C2H6O · 46.07 u` — the one-line description used on cards and rows. */
export function describeAtoms(atoms = []) {
  const formula = formulaOf(atoms);
  const mass = massOf(atoms);
  if (!formula) return 'no atoms';
  return mass === null ? formula : `${formula} · ${mass.toFixed(2)} u`;
}
