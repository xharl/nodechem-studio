/**
 * Molden writer.
 *
 * Molden is the one structure-plus-wavefunction format that most quantum-chemistry
 * viewers read (Molden itself, Avogadro, MacMolPlt, Multiwfn via Molden2AIM,
 * Jmol). It is also the only export this project writes that cannot come from a
 * log: it needs the **basis functions** and the **MO coefficients**, which only a
 * formatted checkpoint carries. `moldenFromFchk` therefore takes a parsed fchk
 * and refuses anything it does not actually have rather than writing a file whose
 * orbitals are empty.
 *
 * Format, from the Molden format description:
 *
 *   [Molden Format]
 *   [Atoms] (Angs|AU)     element index atomicNumber x y z
 *   [5D] [7F] [9G]        mark spherical d/f/g (absent means cartesian)
 *   [GTO]                 atom 0, then `shell nprim 1.00`, then primitive lines
 *                         (exponent, coefficient[s]) — all in atomic units
 *   [MO]                  Sym= Ene= Spin= Occup= then `aoIndex coefficient`
 *
 * Two decisions this writer makes:
 *
 * - **Coefficient order is passed through.** Gaussian stores the basis functions
 *   in the same order Molden expects for s/p and for cartesian shells, and for
 *   spherical d/f/g both use the 0,+1,-1,+2,-2… ordering. Reordering would need a
 *   convention map per shell type and would silently corrupt a wavefunction when
 *   one was wrong; the fchk is the authority for the order and it is written as
 *   read.
 * - **An unsupported shell is an error, not a skip.** Molden has labels up to
 *   `g`; a `h` shell in the checkpoint means the file cannot be written
 *   faithfully, so the writer says so instead of dropping six basis functions
 *   and shifting every coefficient after them.
 */

import { ELEMENTS } from '../elements.js';
import { ConversionError } from './xyz.js';

/** Element symbols come from the one table the rest of the app uses. */
const SYMBOL_BY_Z = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));

const SHELLS = Object.freeze({
  0: { label: 's', functions: 1 },
  1: { label: 'p', functions: 3 },
  [-1]: { label: 'sp', functions: 4 },
  2: { label: 'd', functions: 6, pure: 5 },
  [-2]: { label: 'd', functions: 5, pure: 5 },
  3: { label: 'f', functions: 10, pure: 7 },
  [-3]: { label: 'f', functions: 7, pure: 7 },
  4: { label: 'g', functions: 15, pure: 9 },
  [-4]: { label: 'g', functions: 9, pure: 9 },
});

/** Function count for a shell type; `h` and beyond are not expressible. */
export function functionsPerShell(type) {
  const shell = SHELLS[type];
  if (!shell) {
    throw new ConversionError(`Molden cannot express shell type ${type} (it supports s, p, sp, d, f and g).`);
  }
  return shell.functions;
}

function fixed(value, digits = 8) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ConversionError(`Molden cannot write the non-finite number ${value}.`);
  return number.toFixed(digits);
}

function elementOf(atom, index) {
  const symbol = String(atom?.element || '').trim();
  if (!/^[A-Z][a-z]?$/.test(symbol)) {
    throw new ConversionError(`Atom ${index + 1} has no element symbol, so Molden cannot write it.`);
  }
  return symbol;
}

/**
 * Write a Molden file from atoms, decoded shells and orbitals.
 *
 * @param {object} input
 * @param {Array<{element: string, x: number, y: number, z: number}>} input.atoms  Angstrom
 * @param {Array<{atom: number, type: number, primitives: Array<{exponent: number, s: number, p?: number}>}>} input.shells
 *        1-based atom index, fchk shell type (-1 = sp, -2 = pure d, …)
 * @param {Array<{energy: number, occupation: number, spin: 'Alpha'|'Beta', coefficients: number[]}>} input.orbitals
 * @param {{title?: string}} [options]
 */
export function writeMolden({ atoms, shells, orbitals }, { title = '' } = {}) {
  if (!Array.isArray(atoms) || atoms.length === 0) throw new ConversionError('Molden needs atoms.');
  if (!Array.isArray(shells) || shells.length === 0) {
    throw new ConversionError('Molden needs basis functions; this record has no shell table.');
  }
  if (!Array.isArray(orbitals) || orbitals.length === 0) {
    throw new ConversionError('Molden needs molecular orbitals; this record has no MO coefficients.');
  }

  const nbf = shells.reduce((sum, shell) => sum + functionsPerShell(shell.type), 0);
  for (const orbital of orbitals) {
    if (!Array.isArray(orbital.coefficients) || orbital.coefficients.length !== nbf) {
      const got = Array.isArray(orbital.coefficients) ? orbital.coefficients.length : 0;
      throw new ConversionError(
        `An orbital carries ${got} coefficients for a basis of ${nbf} functions; the file would be unreadable.`,
      );
    }
  }

  const pureD = shells.some((shell) => shell.type === -2);
  const pureF = shells.some((shell) => shell.type === -3);
  const pureG = shells.some((shell) => shell.type === -4);
  const cartD = shells.some((shell) => shell.type === 2);
  const cartF = shells.some((shell) => shell.type === 3);
  const cartG = shells.some((shell) => shell.type === 4);
  if ((pureD && cartD) || (pureF && cartF) || (pureG && cartG)) {
    // Molden switches a whole angular momentum with one marker line, so a mixed
    // basis cannot be represented. Guessing which half to convert would corrupt
    // every orbital.
    throw new ConversionError(
      'The basis mixes spherical and Cartesian shells of the same angular momentum, which a Molden file cannot express.',
    );
  }

  const lines = [];
  lines.push('[Molden Format]');
  if (String(title).trim()) {
    lines.push(`[Title]`);
    lines.push(String(title).replace(/[\r\n]+/g, ' ').slice(0, 240));
  }
  lines.push('[Atoms] Angs');
  atoms.forEach((atom, index) => {
    const symbol = elementOf(atom, index);
    const z = [...SYMBOL_BY_Z.entries()].find(([, value]) => value === symbol)?.[0] ?? 0;
    lines.push(`${symbol} ${index + 1} ${z} ${fixed(atom.x, 8)} ${fixed(atom.y, 8)} ${fixed(atom.z, 8)}`);
  });

  if (pureD) lines.push('[5D]');
  if (pureF) lines.push('[7F]');
  if (pureG) lines.push('[9G]');

  lines.push('[GTO]');
  const byAtom = new Map();
  for (const shell of shells) {
    if (!byAtom.has(shell.atom)) byAtom.set(shell.atom, []);
    byAtom.get(shell.atom).push(shell);
  }
  atoms.forEach((_, index) => {
    const atomNumber = index + 1;
    const list = byAtom.get(atomNumber);
    if (!list || list.length === 0) return;
    lines.push(`${atomNumber} 0`);
    for (const shell of list) {
      // An `sp` shell is split into a bare `s` and a bare `p` with the same
      // exponents. The order is unchanged (s, then px/py/pz), and every reader
      // that mishandles a two-coefficient `sp` line — iodata's, for one — reads
      // the same basis instead of silently counting one function per shell.
      if (shell.type === -1) {
        lines.push(`s ${shell.primitives.length} 1.00`);
        for (const primitive of shell.primitives) {
          lines.push(`  ${fixed(primitive.exponent, 10)} ${fixed(primitive.s, 10)}`);
        }
        lines.push(`p ${shell.primitives.length} 1.00`);
        for (const primitive of shell.primitives) {
          lines.push(`  ${fixed(primitive.exponent, 10)} ${fixed(primitive.p ?? 0, 10)}`);
        }
        continue;
      }
      const spec = SHELLS[shell.type];
      lines.push(`${spec.label} ${shell.primitives.length} 1.00`);
      for (const primitive of shell.primitives) {
        lines.push(`  ${fixed(primitive.exponent, 10)} ${fixed(primitive.s, 10)}`);
      }
    }
    lines.push('');
  });

  lines.push('[MO]');
  for (const orbital of orbitals) {
    lines.push(' Sym= A');
    lines.push(` Ene= ${fixed(orbital.energy, 6)}`);
    lines.push(` Spin= ${orbital.spin === 'Beta' ? 'Beta' : 'Alpha'}`);
    lines.push(` Occup= ${fixed(orbital.occupation, 4)}`);
    orbital.coefficients.forEach((coefficient, index) => {
      // A coefficient of exactly zero is meaningful here (symmetry), so it is
      // written, not skipped: Molden needs the full vector.
      lines.push(` ${index + 1} ${fixed(coefficient, 8)}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Decode a parsed fchk into atoms, shells and orbitals.
 *
 * Shell types follow the fchk convention: `0` s, `1` p, `-1` sp, and for d and
 * above the sign says Cartesian (`2`) or spherical (`-2`). The primitive tables
 * are laid out shell by shell, which is the only reading that makes their total
 * equal the shell list.
 */
export function shellsFromFchk(fchk) {
  const types = fchk?.shellTypes;
  const perShell = fchk?.primitivesPerShell;
  const atomMap = fchk?.shellToAtomMap;
  const exponents = fchk?.primitiveExponents;
  const coefficients = fchk?.contractionCoefficients;
  if (!Array.isArray(types) || !Array.isArray(perShell) || !Array.isArray(atomMap)) {
    throw new ConversionError('This checkpoint carries no shell table, so it has no basis to write.');
  }
  if (!Array.isArray(exponents) || !Array.isArray(coefficients)) {
    throw new ConversionError('This checkpoint carries no primitive exponents or contraction coefficients.');
  }
  const spCoefficients = Array.isArray(fchk?.spContractionCoefficients)
    ? fchk.spContractionCoefficients : null;

  const shells = [];
  let cursor = 0;
  for (let index = 0; index < types.length; index += 1) {
    const type = Number(types[index]);
    const nprim = Number(perShell[index]);
    const atom = Number(atomMap[index]);
    if (!Number.isInteger(nprim) || nprim < 1) {
      throw new ConversionError(`Shell ${index + 1} states ${perShell[index]} primitives.`);
    }
    if (!SHELLS[type]) {
      throw new ConversionError(`Shell ${index + 1} has type ${type}, which Molden cannot express (s, p, sp, d, f, g only).`);
    }
    const primitives = [];
    for (let k = 0; k < nprim; k += 1) {
      const exponent = Number(exponents[cursor + k]);
      const s = Number(coefficients[cursor + k]);
      const p = type === -1 && spCoefficients ? Number(spCoefficients[cursor + k]) : undefined;
      if (!Number.isFinite(exponent) || !Number.isFinite(s) || (type === -1 && !Number.isFinite(p))) {
        throw new ConversionError(`Shell ${index + 1} has a primitive with no exponent or coefficient.`);
      }
      primitives.push({ exponent, s, ...(type === -1 ? { p } : {}) });
    }
    cursor += nprim;
    shells.push({ atom, type, primitives });
  }
  if (cursor !== exponents.length) {
    throw new ConversionError(
      `The shell table accounts for ${cursor} primitives but the exponent table has ${exponents.length}.`,
    );
  }
  return shells;
}

function atomsFromFchk(fchk, bohrToAngstrom) {
  const numbers = fchk?.atomicNumbers;
  const coords = fchk?.coordinatesBohr;
  if (!Array.isArray(numbers) || !Array.isArray(coords)) {
    throw new ConversionError('This checkpoint carries no atoms.');
  }
  if (coords.length !== numbers.length * 3) {
    throw new ConversionError(
      `The checkpoint has ${coords.length} coordinates for ${numbers.length} atoms.`,
    );
  }
  return numbers.map((z, index) => {
    const symbol = SYMBOL_BY_Z.get(Number(z));
    if (!symbol) throw new ConversionError(`Atomic number ${z} has no element symbol in this build.`);
    return {
      element: symbol,
      x: Number(coords[index * 3]) * bohrToAngstrom,
      y: Number(coords[index * 3 + 1]) * bohrToAngstrom,
      z: Number(coords[index * 3 + 2]) * bohrToAngstrom,
    };
  });
}

function orbitalsFromFchk(fchk, nbf) {
  const alpha = fchk?.alphaMOCoefficients;
  if (!Array.isArray(alpha) || alpha.length === 0) {
    throw new ConversionError('This checkpoint carries no MO coefficients.');
  }
  if (alpha.length % nbf !== 0) {
    throw new ConversionError(
      `The alpha MO coefficients (${alpha.length}) are not a whole number of ${nbf}-function orbitals.`,
    );
  }
  const alphaEnergies = Array.isArray(fchk?.orbitalEnergies) ? fchk.orbitalEnergies : [];
  const alphaCount = Number.isInteger(fchk?.numberOfAlphaElectrons) ? fchk.numberOfAlphaElectrons
    : Math.floor((Number(fchk?.numberOfElectrons) || 0) / 2);
  const nmo = alpha.length / nbf;
  const orbitals = [];
  for (let index = 0; index < nmo; index += 1) {
    orbitals.push({
      energy: Number.isFinite(alphaEnergies[index]) ? alphaEnergies[index] : 0,
      occupation: index < alphaCount ? (fchk?.betaMOCoefficients ? 1 : 2) : 0,
      spin: 'Alpha',
      coefficients: alpha.slice(index * nbf, (index + 1) * nbf).map(Number),
    });
  }

  const beta = fchk?.betaMOCoefficients;
  if (Array.isArray(beta) && beta.length > 0) {
    if (beta.length % nbf !== 0) {
      throw new ConversionError(
        `The beta MO coefficients (${beta.length}) are not a whole number of ${nbf}-function orbitals.`,
      );
    }
    const betaEnergies = Array.isArray(fchk?.orbitalEnergiesBeta) ? fchk.orbitalEnergiesBeta : [];
    const betaCount = Number.isInteger(fchk?.numberOfBetaElectrons) ? fchk.numberOfBetaElectrons : 0;
    const betaMo = beta.length / nbf;
    for (let index = 0; index < betaMo; index += 1) {
      orbitals.push({
        energy: Number.isFinite(betaEnergies[index]) ? betaEnergies[index] : 0,
        occupation: index < betaCount ? 1 : 0,
        spin: 'Beta',
        coefficients: beta.slice(index * nbf, (index + 1) * nbf).map(Number),
      });
    }
  }
  return orbitals;
}

/** Convert a parsed formatted checkpoint into Molden text. */
export function moldenFromFchk(fchk, { title = '', bohrToAngstrom = 0.529177210903 } = {}) {
  const atoms = atomsFromFchk(fchk, bohrToAngstrom);
  const shells = shellsFromFchk(fchk);
  const nbf = shells.reduce((sum, shell) => sum + functionsPerShell(shell.type), 0);
  if (Number.isInteger(fchk?.numberOfBasisFunctions) && fchk.numberOfBasisFunctions !== nbf) {
    throw new ConversionError(
      `The shell table adds up to ${nbf} functions but the checkpoint states ${fchk.numberOfBasisFunctions}.`,
    );
  }
  const orbitals = orbitalsFromFchk(fchk, nbf);
  const text = writeMolden({ atoms, shells, orbitals }, { title });
  const notes = [
    `${atoms.length} atom(s), ${nbf} basis function(s), ${orbitals.length} orbital(s).`,
    'Coordinates are Angstrom; [GTO] exponents and coefficients are atomic units, as the format requires.',
    'Molden orbitals are written from the checkpoint as read — no reordering, no renormalising.',
    ...(shells.some((shell) => shell.type === -1)
      ? ['`sp` shells are written as a separate `s` and `p` shell (same exponents, same function order), which every reader handles.']
      : []),
  ];
  return { text, notes, atoms: atoms.length, shells: shells.length, orbitals: orbitals.length, basisFunctions: nbf };
}
