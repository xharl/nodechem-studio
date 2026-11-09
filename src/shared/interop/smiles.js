/**
 * SMILES: a **bond graph**, never a geometry.
 *
 * This reader implements a deliberately small OpenSMILES subset and refuses
 * everything outside it by name, at the character position. It never invents
 * coordinates: a SMILES string says which atoms are bonded to which, and that
 * is all it says. A structure with no coordinates cannot be run (the run
 * builder would fall back to the demo water molecule), so `structureImport.js`
 * uses this reader to *name* what it read and then refuses to turn it into a
 * project geometry — see `docs/guide/converters.md`.
 *
 * Supported (OpenSMILES, Daylight's organic subset and its valence model):
 *
 *   atoms       B C N O P S F Cl Br I, and the aromatic b c n o p s
 *   bonds       - = # (single, double, triple), ':' between aromatic atoms,
 *               and the implied single/aromatic bond between neighbours
 *   topology    branches `( )`, ring closures 1-9 and %nn, '.' components
 *   brackets    [NH4+], [O-], [nH], [CH3] — formal charge ±1 and explicit H
 *   hydrogens   implicit, by Daylight's rule: the smallest tabulated valence
 *               that is at least the sum of the bond orders (B 3, C 4, N 3,
 *               O 2, P 3/5, S 2/4/6, halogens 1)
 *
 * Refused, with the token and its position:
 *
 *   stereochemistry   @ @@ and the cis/trans marks / and \
 *   isotopes          [13C], [2H]
 *   charges > ±1      [Ca++], [S+2]
 *   aromatic B and P  no defensible pi/valence model here — write the Kekulé
 *                     form or the bracket atom
 *   other elements    Na, Fe, Si, ... (outside the organic subset)
 *   SMARTS            * ~ ! & ; , $ and atom-map classes [C:1]
 *
 * Aromatic bonds are carried as order 1.5 — the same value the MOL reader uses
 * for V2000 type 4 — and are **never** Kekulé-ised. A reader that quietly
 * assigns double bonds to a benzene ring is making a chemistry claim it cannot
 * check from six letters, which is the failure this project refuses elsewhere.
 * Implicit hydrogen counts for aromatic atoms use the standard "one electron to
 * the pi system" rule (c: 3, n: 2, o: 2, s: 2; [nH] is the pyrrole type, 3).
 *
 * Reference: OpenSMILES specification (open-smiles.org, revision 1.0) for the
 * grammar and the implicit-hydrogen rule; Daylight's SMILES theory page for the
 * valence table.
 */

import { atomicNumber } from '../elements.js';

export class SmilesError extends Error {
  constructor(message, { position = null, token = '' } = {}) {
    super(message);
    this.name = 'SmilesError';
    this.position = position;
    this.token = token;
  }
}

/** The subset accepted unbracketed. Si, Se and the metals are bracket-only in
 * SMILES and are refused here because a bracket atom that names one cannot be
 * given a valence this reader would defend. */
const ORGANIC_SUBSET = Object.freeze(['B', 'C', 'N', 'O', 'P', 'S', 'F', 'Cl', 'Br', 'I']);
const ORGANIC = new Set(ORGANIC_SUBSET);
const AROMATIC_SUBSET = Object.freeze(['b', 'c', 'n', 'o', 'p', 's']);
const AROMATIC = new Set(AROMATIC_SUBSET);
// Aromatic b and p are in the OpenSMILES grammar but have no single "one pi
// electron, valence minus one" rule this reader can defend (borole's boron
// contributes an empty p orbital, not an electron), so they are refused by name.
const AROMATIC_MODELLED = new Set(['c', 'n', 'o', 's']);

/** Valence list per element, smallest first. Daylight's organic-subset table. */
const VALENCES = Object.freeze({
  B: [3], C: [4], N: [3], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1],
});

/** Charge-adjusted valences for bracket atoms (OpenSMILES default valences). */
const CHARGED_VALENCES = Object.freeze({
  B: { 1: [2], '-1': [4] },
  C: { 1: [3], '-1': [3] },
  N: { 1: [4], '-1': [2] },
  O: { 1: [3], '-1': [1] },
  P: { 1: [4], '-1': [2] },
  S: { 1: [3], '-1': [1] },
});

/** Effective valence for an aromatic atom: the sigma valence, one electron
 * already committed to the pi system. `[nH]` is pyrrole: its lone pair is the
 * pi electron, so the nitrogen keeps all three sigma bonds. */
function aromaticValence(element, explicitHydrogens) {
  if (element === 'C') return 3;
  if (element === 'N') return explicitHydrogens > 0 ? 3 : 2;
  if (element === 'O') return 2;
  return 2; // S — thiophene
}

function describePosition(index) {
  return `at character ${index + 1}`;
}

function unsupported(message, index, token = '') {
  return new SmilesError(`${message} (${describePosition(index)}).`, { position: index, token });
}

/**
 * Read a `[` … `]` atom: isotope, element, chirality, H count, charge, class.
 * Returns the atom and the index just past the closing bracket.
 */
function readBracketAtom(text, start) {
  let index = start + 1;
  const isotopeStart = index;
  while (index < text.length && /[0-9]/.test(text[index])) index += 1;
  if (index > isotopeStart) {
    throw unsupported(
      `Isotopes are not supported: [${text.slice(start + 1, index)}…] would need a mass number this reader does not carry`,
      isotopeStart,
      text.slice(isotopeStart, index),
    );
  }
  if (index >= text.length) throw unsupported('The bracket atom is not closed', start);

  let symbol;
  let aromatic = false;
  if (text[index] === '*') {
    throw unsupported('A wildcard atom (*) is a SMARTS query, not a molecule', index, '*');
  }
  if (/[A-Z]/.test(text[index])) {
    // A full element symbol, not just two letters: Na, Si, Fe must reach the
    // "outside the organic subset" refusal naming the element, not a stray
    // "Unexpected a" that blames the wrong character.
    const symbolStart = index;
    index += 1;
    while (index < text.length && /[a-z]/.test(text[index])) index += 1;
    symbol = text.slice(symbolStart, index);
  } else if (/[a-z]/.test(text[index])) {
    symbol = text[index];
    aromatic = true;
    index += 1;
  } else {
    throw unsupported(`"${text[index]}" is not an atom symbol inside brackets`, index, text[index]);
  }

  if (aromatic) {
    if (!AROMATIC_MODELLED.has(symbol)) {
      throw unsupported(
        `Aromatic "${symbol}" has no valence model in this reader; write the Kekulé form (uppercase atoms with = bonds)`,
        index - 1,
        symbol,
      );
    }
    symbol = symbol.toUpperCase();
  } else if (!ORGANIC.has(symbol)) {
    throw unsupported(
      `"${symbol}" is outside the organic subset this reader supports (${ORGANIC_SUBSET.join(', ')})`,
      index - symbol.length,
      symbol,
    );
  }

  // Chirality: recorded nowhere, so refused here rather than lost silently.
  if (text[index] === '@') {
    const doubled = text.slice(index, index + 2) === '@@';
    throw unsupported(
      doubled
        ? 'Stereochemistry (@@) is not supported: this reader stores no stereo descriptor'
        : 'Stereochemistry (@) is not supported: this reader stores no stereo descriptor',
      index,
      doubled ? '@@' : '@',
    );
  }

  let explicitHydrogens = 0;
  if (text[index] === 'H') {
    index += 1;
    const digitsStart = index;
    while (index < text.length && /[0-9]/.test(text[index])) index += 1;
    explicitHydrogens = index > digitsStart ? Number(text.slice(digitsStart, index)) : 1;
    if (!Number.isInteger(explicitHydrogens) || explicitHydrogens < 1 || explicitHydrogens > 8) {
      throw unsupported(`"H${text.slice(digitsStart, index)}" is not a hydrogen count`, digitsStart);
    }
  }

  let charge = 0;
  if (text[index] === '+' || text[index] === '-') {
    const sign = text[index] === '+' ? 1 : -1;
    const chargeStart = index;
    index += 1;
    let magnitude = 1;
    if (/[0-9]/.test(text[index] || '')) {
      const digitsStart = index;
      while (index < text.length && /[0-9]/.test(text[index])) index += 1;
      magnitude = Number(text.slice(digitsStart, index));
    } else {
      while (text[index] === (sign === 1 ? '+' : '-')) {
        magnitude += 1;
        index += 1;
      }
    }
    if (magnitude > 1) {
      throw unsupported(
        `A formal charge of ${sign === 1 ? '+' : '-'}${magnitude} is outside this reader: it models ±1 only`,
        chargeStart,
        text.slice(chargeStart, index),
      );
    }
    charge = sign * magnitude;
  }

  if (text[index] === ':') {
    throw unsupported('Atom-map classes ([C:1]) belong to reaction SMILES, which this reader does not read', index, ':');
  }
  if (text[index] !== ']') {
    throw unsupported(`Unexpected "${text[index]}" in a bracket atom`, index, text[index]);
  }

  return {
    atom: {
      element: symbol, aromatic, charge, explicitHydrogens, bracket: true, bondSum: explicitHydrogens,
    },
    next: index + 1,
  };
}

/**
 * Parse one SMILES string into a graph. Throws `SmilesError`; never returns a
 * partial molecule.
 */
function parseGraph(smiles) {
  const atoms = [];
  const bonds = [];
  const warnings = [];
  const branch = [];
  const openRings = new Map();
  let previous = null;
  let pendingBond = null;
  let index = 0;

  const bondKeys = new Set();
  const connect = (a, b, symbol, position) => {
    if (a === b) throw unsupported('A ring closure cannot bond an atom to itself', position);
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (bondKeys.has(key)) {
      throw unsupported('Two atoms are bonded twice by the same SMILES string', position);
    }
    bondKeys.add(key);
    const atomA = atoms[a];
    const atomB = atoms[b];
    let order;
    if (symbol === '=') order = 2;
    else if (symbol === '#') order = 3;
    else if (symbol === ':') {
      if (!atomA.aromatic || !atomB.aromatic) {
        throw unsupported('An aromatic bond (:) joins two atoms that are not both aromatic', position, ':');
      }
      order = 1.5;
    } else if (symbol === '-') order = 1;
    else order = atomA.aromatic && atomB.aromatic ? 1.5 : 1;
    bonds.push({ a: a + 1, b: b + 1, order });
    if (order !== 1.5) {
      atomA.bondSum += order;
      atomB.bondSum += order;
    } else {
      // Aromatic bonds count as one sigma bond for the valence model; the pi
      // electron is what `aromaticValence` already removed.
      atomA.bondSum += 1;
      atomB.bondSum += 1;
    }
  };

  while (index < smiles.length) {
    const character = smiles[index];

    if (character === '(') {
      if (previous === null) throw unsupported('A branch opens before any atom', index, '(');
      // A branch holds a sub-path of atoms; an empty one (`C()`) is not SMILES.
      // The parent counts as filled once a child branch opens inside it.
      if (branch.length > 0) branch[branch.length - 1].filled = true;
      branch.push({ atom: previous, filled: false, position: index });
      index += 1;
      continue;
    }
    if (character === ')') {
      if (branch.length === 0) throw unsupported('A branch closes that was never opened', index, ')');
      const closed = branch.pop();
      if (!closed.filled) throw unsupported('A branch contains no atom', index, ')');
      previous = closed.atom;
      index += 1;
      continue;
    }
    if (character === '.') {
      if (previous === null) throw unsupported('A component separator (.) follows no atom', index, '.');
      previous = null;
      pendingBond = null;
      index += 1;
      continue;
    }
    if (character === '-' || character === '=' || character === '#' || character === ':') {
      if (pendingBond !== null) {
        throw unsupported(`"${pendingBond}${character}" is not a bond symbol`, index, character);
      }
      pendingBond = character;
      index += 1;
      continue;
    }
    if (character === '@') {
      const doubled = smiles.slice(index, index + 2) === '@@';
      throw unsupported(
        doubled
          ? 'Stereochemistry (@@) is not supported: this reader stores no stereo descriptor'
          : 'Stereochemistry (@) is not supported: this reader stores no stereo descriptor',
        index,
        doubled ? '@@' : '@',
      );
    }
    if (character === '/' || character === '\\') {
      throw unsupported(
        'Cis/trans bond direction (/ or \\) is not supported: this reader stores no stereo descriptor',
        index,
        character,
      );
    }
    if (character === '*' || '~!&;,$'.includes(character)) {
      throw unsupported(`"${character}" is a SMARTS operator, not a molecule bond or atom`, index, character);
    }
    if (character === '[') {
      const { atom, next } = readBracketAtom(smiles, index);
      const position = index;
      atoms.push(atom);
      if (branch.length > 0) branch[branch.length - 1].filled = true;
      const current = atoms.length - 1;
      if (previous !== null) connect(previous, current, pendingBond, position);
      previous = current;
      pendingBond = null;
      index = next;
      continue;
    }
    if (/[0-9]/.test(character) || character === '%') {
      if (previous === null) throw unsupported('A ring closure follows no atom', index, character);
      let key = character;
      let width = 1;
      if (character === '%') {
        const two = smiles.slice(index + 1, index + 3);
        if (!/^[0-9]{2}$/.test(two)) {
          throw unsupported('A % ring closure needs two digits (%10)', index, '%');
        }
        key = two;
        width = 3;
      }
      const label = key;
      if (openRings.has(label)) {
        const opened = openRings.get(label);
        if (opened.atom === previous) throw unsupported(`Ring closure ${label} bonds an atom to itself`, index, label);
        const symbol = pendingBond || opened.bond || null;
        if (pendingBond && opened.bond && pendingBond !== opened.bond) {
          throw unsupported(`Ring closure ${label} is written with two different bond symbols (${opened.bond} and ${pendingBond})`, index, label);
        }
        connect(opened.atom, previous, symbol, index);
        openRings.delete(label);
      } else {
        openRings.set(label, { atom: previous, bond: pendingBond, position: index });
      }
      pendingBond = null;
      index += width;
      continue;
    }
    if (/[A-Za-z]/.test(character)) {
      let symbol;
      let aromatic = false;
      if (/[A-Z]/.test(character)) {
        // Unbracketed, only Cl and Br are two-letter symbols in the organic
        // subset. Reading `Nc1ccccc1` as the element "Nc" (as a greedy
        // [A-Z][a-z]* would) refuses aniline; SMILES itself says a two-letter
        // element needs brackets, so here "Sc" is S bonded to aromatic c.
        symbol = smiles.slice(index, index + 2) === 'Cl' || smiles.slice(index, index + 2) === 'Br'
          ? smiles.slice(index, index + 2)
          : character;
        if (!ORGANIC.has(symbol)) {
          throw unsupported(
            `"${symbol}" is outside the organic subset this reader supports (${ORGANIC_SUBSET.join(', ')}); a metal or transition element needs an effective core potential, which is a different reader`,
            index,
            symbol,
          );
        }
      } else {
        if (!AROMATIC.has(character)) {
          throw unsupported(`"${character}" is not an atom symbol`, index, character);
        }
        if (!AROMATIC_MODELLED.has(character)) {
          throw unsupported(
            `Aromatic "${character}" has no valence model in this reader; write the Kekulé form (uppercase atoms with = bonds)`,
            index,
            character,
          );
        }
        symbol = character.toUpperCase();
        aromatic = true;
      }
      const position = index;
      if (branch.length > 0) branch[branch.length - 1].filled = true;
      atoms.push({
        element: symbol, aromatic, charge: 0, explicitHydrogens: 0, bracket: false, bondSum: 0,
      });
      const current = atoms.length - 1;
      if (previous !== null) connect(previous, current, pendingBond, position);
      previous = current;
      pendingBond = null;
      index += symbol.length;
      continue;
    }
    throw unsupported(`"${character}" is not part of a SMILES string`, index, character);
  }

  if (pendingBond !== null) throw unsupported(`The string ends with a bond symbol (${pendingBond})`, smiles.length - 1, pendingBond);
  if (branch.length > 0) throw unsupported('A branch is never closed: a "(" has no matching ")"', smiles.length - 1, ')');
  if (openRings.size > 0) {
    const [label, opened] = [...openRings.entries()][0];
    throw unsupported(`Ring closure ${label} is opened but never closed`, opened.position, label);
  }
  if (atoms.length === 0) throw new SmilesError('The SMILES string contains no atoms.');

  // Hydrogen counts and the valence model, now that every bond is known.
  atoms.forEach((atom, position) => {
    const valences = atom.charge === 0
      ? VALENCES[atom.element]
      : (CHARGED_VALENCES[atom.element] || {})[String(atom.charge)];
    if (!valences) {
      throw new SmilesError(
        `A charge of ${atom.charge > 0 ? '+' : '-'}${Math.abs(atom.charge)} on ${atom.element} `
        + `(atom ${position + 1}) has no valence model in this reader.`,
        { position, token: atom.element },
      );
    }
    const maxValence = valences[valences.length - 1];
    if (atom.bondSum > maxValence) {
      throw new SmilesError(
        `${atom.element} (atom ${position + 1}) is written with ${atom.bondSum} `
        + `bond${atom.bondSum === 1 ? '' : 's'}, more than its valence of ${maxValence} allows.`,
        { position, token: atom.element },
      );
    }
    // A bracket atom states its own hydrogen count: OpenSMILES never adds
    // implicit hydrogens there. [nH] is pyrrole's nitrogen, and adding the
    // aromatic model's "one implicit H" on top of the written one would put an
    // extra hydrogen on the ring.
    if (atom.bracket) {
      atom.hydrogens = atom.explicitHydrogens;
      const smallest = valences[0];
      if (!atom.aromatic && atom.bondSum < smallest) {
        warnings.push(
          `${atom.element}${atom.charge === 0 ? '' : (atom.charge > 0 ? '+' : '-')} (atom ${position + 1}) is written `
          + `with ${atom.bondSum} bond${atom.bondSum === 1 ? '' : 's'} and ${atom.hydrogens} H, fewer than its valence of `
          + `${smallest}: it is a radical or a carbene. This reader does not model the unpaired electron, so the `
          + 'multiplicity below is only parity-consistent.',
        );
      }
      return;
    }
    if (atom.aromatic) {
      const valence = aromaticValence(atom.element, atom.explicitHydrogens);
      atom.hydrogens = Math.max(0, valence - atom.bondSum);
      if (atom.bondSum < valence - 1) {
        warnings.push(
          `Aromatic ${atom.element} (atom ${position + 1}) is written with fewer bonds than its valence; `
          + 'the hydrogen count is the smallest one the aromatic model allows.',
        );
      }
      return;
    }
    const valence = valences.find((value) => value >= atom.bondSum);
    atom.hydrogens = valence === undefined ? 0 : valence - atom.bondSum;
  });

  const charge = atoms.reduce((total, atom) => total + atom.charge, 0);
  // Implicit hydrogens are atoms: each contributes one electron. Leaving them
  // out made pyridine look like a radical.
  const electrons = atoms.reduce(
    (total, atom) => total + atomicNumber(atom.element) + atom.hydrogens,
    0,
  ) - charge;
  if (electrons < 0) {
    throw new SmilesError(`The charge ${charge} removes more electrons than the ${atoms.length} atoms carry.`);
  }
  const multiplicity = electrons % 2 === 0 ? 1 : 2;

  return {
    atoms: atoms.map((atom, position) => ({
      index: position + 1,
      element: atom.element,
      aromatic: atom.aromatic,
      charge: atom.charge,
      hydrogens: atom.hydrogens,
      ...(atom.bracket ? { bracket: true } : {}),
    })),
    bonds,
    charge,
    multiplicity,
    electrons,
    formula: hillFormula(atoms),
    warnings,
  };
}

/** Hill order: C, H, then alphabetical. Without carbon, everything alphabetical. */
function hillFormula(atoms) {
  const counts = new Map();
  const add = (element, count) => counts.set(element, (counts.get(element) || 0) + count);
  for (const atom of atoms) {
    add(atom.element, 1);
    if (atom.hydrogens > 0) add('H', atom.hydrogens);
  }
  const keys = [...counts.keys()];
  const order = counts.has('C')
    ? ['C', ...(counts.has('H') ? ['H'] : []), ...keys.filter((key) => key !== 'C' && key !== 'H').sort()]
    : keys.sort();
  return order.map((element) => {
    const count = counts.get(element);
    return count === 1 ? element : `${element}${count}`;
  }).join('');
}

/**
 * One SMILES string in, one graph out.
 *
 * The result has **no coordinates** and no `geometry` field at all: callers
 * that need a geometry must refuse, not guess.
 */
export function parseSmiles(text, { name = '' } = {}) {
  const smiles = String(text ?? '').trim();
  if (!smiles) throw new SmilesError('The SMILES string is empty.');
  const graph = parseGraph(smiles);
  return { ...graph, smiles, name: String(name || '').trim() };
}

/**
 * A `.smi` / `.smiles` file: one `SMILES [name]` per line, `#` comments.
 * A line that does not parse is reported with its line number and does not
 * hide the lines that did.
 */
export function parseSmilesList(text, { name = '' } = {}) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const records = [];
  const warnings = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [smiles, ...rest] = trimmed.split(/\s+/);
    const label = rest.join(' ').trim() || `${name || 'SMILES'} ${records.length + 1}`;
    try {
      records.push({ ...parseSmiles(smiles, { name: label }), line: index + 1 });
    } catch (error) {
      records.push({
        smiles,
        name: label,
        line: index + 1,
        error: `Line ${index + 1}: ${error.message}`,
      });
    }
  });
  if (records.length === 0) throw new SmilesError('The SMILES file contains no SMILES string.');
  return { records, warnings };
}

/** A one-line description used in refusals and in `ncs smiles`. */
export function describeSmilesGraph(graph) {
  return `${graph.formula || '(no formula)'} · ${graph.atoms.length} atoms · ${graph.bonds.length} bonds · charge ${graph.charge}`;
}
