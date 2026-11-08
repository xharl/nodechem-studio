/**
 * Effective-core-potential support.
 *
 * A basis name is not enough for a heavy element: def2-SVP, SDD and LANL2DZ
 * describe only the valence electrons for elements past krypton, and Gaussian
 * needs the matching pseudopotential in the input. Emitting `def2-SVP` for a
 * palladium atom produces an input Gaussian cannot run — the app refuses that
 * instead of writing it.
 *
 * The rule here is deliberately narrow:
 *   - a basis we ship ECP data for (currently def2-SVP) and an element above Kr
 *     means the route becomes `GenECP` and the blocks are appended;
 *   - an element whose ECP is missing is a validation error naming the element;
 *   - a light-element job is untouched, byte for byte.
 */

import { ECP_DATA } from './ecpData.js';
import { ELEMENTS } from './elements.js';

/** def2 basis sets carry an ECP for every element above krypton (Z > 36). */
export const ECP_FIRST_ELEMENT = 37;

/**
 * Bases Gaussian 16 already ships with their effective core potentials.
 *
 * Gaussian's own basis library includes `Def2SVP`, `Def2TZVP`, `Def2QZVP` and
 * the rest of the Ahlrichs def2 family with the matching ECPs for the heavy
 * elements, and `SDD`/`LANL2DZ` likewise (`SDD: D95 up to Ar and
 * Stuttgart/Dresden ECPs on the remainder of the periodic table`). Writing a
 * `GenECP` route for one of those replaces the program's own basis with a
 * second-hand copy and requires an ECP card block that a real Gaussian 16
 * A.03 run rejected at link 301. A route basis keyword is both simpler and
 * the path the program documents.
 */
const NATIVE_ECP_BASES = Object.freeze([
  'def2sv', 'def2svp', 'def2svpp', 'def2tzv', 'def2tzvp', 'def2tzvpp',
  'def2qzv', 'def2qzvp', 'def2qzvpp', 'qzvp',
  'sdd', 'sddall', 'lanl2dz', 'lanl2mb', 'shc', 'cep-4g', 'cep-31g', 'cep-121g',
]);

export function isNativeEcpBasis(basis) {
  const key = String(basis ?? '').toLowerCase().replace(/[\s-]/g, '');
  return NATIVE_ECP_BASES.includes(key);
}

export function ecpBases() {
  return Object.keys(ECP_DATA);
}

export function needsEcp(basis, atomicNumberValue) {
  const numeric = Number(atomicNumberValue);
  if (!Number.isFinite(numeric)) return false;
  return Object.hasOwn(ECP_DATA, String(basis)) && numeric >= ECP_FIRST_ELEMENT;
}

function symbolOf(entry) {
  if (typeof entry === 'number' || /^\d+$/.test(String(entry))) {
    const numeric = Number(entry);
    for (const [symbol, number] of ELEMENTS) if (number === numeric) return symbol;
    return null;
  }
  const symbol = String(entry || '').trim();
  if (!/^[A-Z][a-z]?$/.test(symbol)) return null;
  return ELEMENTS.has(symbol) ? symbol : null;
}

/**
 * What the selected basis needs for this molecule.
 *
 * Returns `needed: false` when the basis has no ECP table or the molecule holds
 * only light elements, so callers can treat the ordinary path as unchanged.
 *
 * @param {{basis?: string, elements?: Array<string|number>}} input
 */
export function ecpRequirement({ basis, elements = [] } = {}) {
  // A basis the program ships with its potentials needs no card block at all.
  if (isNativeEcpBasis(basis)) {
    return { needed: false, native: true, basis: String(basis), symbols: [], missing: [], blocks: '', library: null };
  }
  const table = Object.hasOwn(ECP_DATA, String(basis)) ? ECP_DATA[String(basis)] : null;
  const symbols = [...new Set((Array.isArray(elements) ? elements : []).map(symbolOf).filter(Boolean))];
  if (!table) return { needed: false, basis: basis ?? null, symbols: [], missing: [], blocks: '', library: null };

  const heavy = symbols
    .filter((symbol) => ELEMENTS.get(symbol) >= ECP_FIRST_ELEMENT)
    .sort((a, b) => ELEMENTS.get(a) - ELEMENTS.get(b));
  if (heavy.length === 0) {
    return { needed: false, basis: String(basis), symbols: [], missing: [], blocks: '', library: null };
  }

  const missing = heavy.filter((symbol) => !Object.hasOwn(table.elements, String(ELEMENTS.get(symbol))));
  const present = heavy.filter((symbol) => Object.hasOwn(table.elements, String(ELEMENTS.get(symbol))));
  return {
    needed: true,
    basis: String(basis),
    symbols: heavy,
    present,
    missing,
    blocks: missing.length > 0
      ? ''
      : present.map((symbol) => table.elements[String(ELEMENTS.get(symbol))].trimEnd()).join('\n\n'),
    library: {
      name: 'Basis Set Exchange',
      basis: table.basis,
      version: table.version,
      source: table.source,
      sha256: table.sha256,
      elements: present.map((symbol) => ELEMENTS.get(symbol)),
    },
  };
}

/** `GenECP` when the molecule needs pseudopotentials, otherwise the chosen basis. */
export function basisNameFor(basis, requirement) {
  return requirement?.needed && requirement.missing.length === 0 ? 'GenECP' : basis;
}

/**
 * A failure message that names the elements and says what to do, used by both
 * the input builder and the validity check.
 */
export function ecpMissingMessage(requirement) {
  const missing = requirement?.missing || [];
  if (missing.length === 0) return null;
  const list = missing.join(', ');
  return `${requirement.basis} needs effective-core-potential data for ${list}; `
    + `this build ships ECP data for ${ecpBases().join(', ')} on `
    + `${Object.keys(ECP_DATA[requirement.basis].elements).length} elements only. `
    + 'Choose an all-electron basis for those atoms, or add the ECP block from the Basis Set Exchange.';
}

/**
 * Read back what an input file actually carries. The runner records this rather
 * than what the settings asked for, so run.json describes the file on disk: a
 * `GenECP` route is visible even if someone edited the input.
 */
export function ecpFromInput(inputText) {
  const text = String(inputText || '');
  const symbols = [];
  for (const match of text.matchAll(/^([A-Z]{1,2})-ECP\s+\d+\s+\d+/gm)) {
    const raw = match[1];
    const symbol = raw.charAt(0) + raw.slice(1).toLowerCase();
    if (ELEMENTS.has(symbol) && !symbols.includes(symbol)) symbols.push(symbol);
  }
  if (symbols.length === 0) return null;
  const numbers = symbols.map((symbol) => ELEMENTS.get(symbol));
  const basis = Object.entries(ECP_DATA).find(([, table]) => (
    numbers.every((number) => Object.hasOwn(table.elements, String(number)))
  ));
  return {
    library: 'Basis Set Exchange',
    basis: basis ? basis[0] : null,
    version: basis ? basis[1].version : null,
    sha256: basis ? basis[1].sha256 : null,
    elements: numbers,
    symbols,
  };
}
