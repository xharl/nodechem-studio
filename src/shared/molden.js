/**
 * Molden reader.
 *
 * The checkpoint reader (`fchk.js`) is the shape every wavefunction consumer in
 * this app already speaks: a flat list of shells, primitive exponents and
 * contraction coefficients, one coefficient matrix per spin, orbital energies
 * and the electron counts. This module produces that shape from a `.molden`
 * file, so the orbital-gap, spin and shell code needs no branch for the format.
 *
 * What Molden adds is the thing the checkpoint cannot say on its own: whether a
 * `d`, `f` or `g` shell is spherical or Cartesian. That is carried by the
 * `[5D]`, `[7F]`, `[9G]` and compound `[5D10F]` markers, and it changes both the
 * shell type (`-2` vs `2`, in the checkpoint convention) and the number of
 * basis functions. The markers are therefore parsed before the `[GTO]` and
 * `[MO]` blocks, not ignored.
 *
 * Contract, matching `fchk.js`:
 * - every field is optional;
 * - a field Molden cannot carry (charge, multiplicity, partial charges, total
 *   energy, a density matrix) is **absent**, never zero-filled, and is named in
 *   `missing`;
 * - a length that disagrees with the basis is an error, not a warning, because
 *   reading past it would attach coefficients to the wrong shell.
 *
 * Deliberately not read: `[FREQ]`, `[FR-COORD]`, `[INT]`, `[GEOMETRIES]` and
 * `[STO]`. The first four are vibrational/geometry data the app takes from its
 * own parsers; the last is a Slater basis this reader cannot expand and refuses
 * by name.
 */

import { BOHR_TO_ANGSTROM } from './cubeFile.js';
import { ELEMENTS } from './elements.js';

/** Characters, not bytes: the guard bounds work on text that is already decoded. */
export const MAX_MOLDEN_CHARS = 64 * 1024 * 1024;

export class MoldenFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoldenFormatError';
  }
}

const SYMBOL_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;

/**
 * The shell labels Molden defines. `type` is the signed checkpoint convention
 * the rest of the app uses: `-1` is a combined sp shell, and for d/f/g the
 * negative type is the spherical set. The marker decides which one is used.
 */
const SHELLS = Object.freeze({
  s: { type: 0, functions: 1 },
  p: { type: 1, functions: 3 },
  sp: { type: -1, functions: 4 },
  d: { type: 2, pureType: -2, functions: 6 },
  f: { type: 3, pureType: -3, functions: 10 },
  g: { type: 4, pureType: -4, functions: 15 },
});

function tokensOf(line) {
  return String(line ?? '').trim().split(/\s+/).filter(Boolean);
}

function numberToken(raw, where) {
  const text = String(raw ?? '');
  if (!NUMBER.test(text)) {
    throw new MoldenFormatError(`${where} has the non-numeric token "${text}".`);
  }
  const value = Number(text.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) {
    throw new MoldenFormatError(`${where} has "${text}", which is outside the range of a double.`);
  }
  return value;
}

function integerToken(raw, where) {
  const value = numberToken(raw, where);
  if (!Number.isInteger(value)) {
    throw new MoldenFormatError(`${where} expects an integer, found "${String(raw)}".`);
  }
  return value;
}

/**
 * Split the text into `[section]` blocks. A header line keeps its arguments
 * (`[Atoms] Angs`), because the unit is part of the header in Molden.
 */
function splitSections(text) {
  const sections = [];
  const preface = [];
  let current = null;
  const lines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = index === 0 ? lines[index].replace(/^\uFEFF/, '') : lines[index];
    const trimmed = raw.trim();
    const header = /^\[([^\]]*)\]\s*(.*)$/.exec(trimmed);
    if (header) {
      current = {
        name: header[1].trim().toLowerCase(),
        args: header[2].trim(),
        header: trimmed,
        line: index + 1,
        lines: [],
      };
      sections.push(current);
    } else if (current) {
      current.lines.push({ text: raw, line: index + 1 });
    } else {
      preface.push({ text: raw, line: index + 1 });
    }
  }
  return { sections, preface };
}

function sectionOf(sections, name) {
  return sections.find((section) => section.name === name) || null;
}

function titleOf(sections) {
  const titled = sectionOf(sections, 'title');
  const titledLines = titled
    ? titled.lines.map((line) => line.text.trim()).filter(Boolean)
    : [];
  const lines = titledLines.length > 0
    ? titledLines
    : sections[0].lines.map((line) => line.text.trim()).filter(Boolean);
  return lines.join(' ').slice(0, 500);
}

/**
 * Read the spherical/Cartesian markers.
 *
 * The Molden specification defines `[5D]` as five d *and* seven f functions,
 * while `[7F]` is six d and seven f. The compound forms exist precisely to
 * express a mixed basis: `[5D10F]` is spherical d with Cartesian f, and
 * `[5D7F]` is the same as `[5D]`. The reader therefore treats `5D` as an
 * explicit d choice plus an *implied* f choice, and lets an explicit `10F`
 * override the implication whichever order the tokens appear in.
 */
function markersOf(sections) {
  const explicit = { d: null, f: null, g: null };
  const origin = { d: null, f: null, g: null };
  let impliedF = null;

  const set = (key, value, section) => {
    if (explicit[key] !== null && explicit[key] !== value) {
      throw new MoldenFormatError(
        `The ${origin[key]} marker and the ${section.header} marker disagree about ${key} functions `
        + `(${explicit[key]} vs ${value}).`,
      );
    }
    explicit[key] = value;
    origin[key] = section.header;
  };

  for (const section of sections) {
    // `[5D10F]` is two tokens in one header; `[5D]` is one.
    for (const match of section.header.toUpperCase().matchAll(/(\d+)\s*([DFG])/g)) {
      const count = Number(match[1]);
      const letter = match[2].toLowerCase();
      if (letter === 'd') {
        if (count !== 5 && count !== 6) {
          throw new MoldenFormatError(
            `The ${section.header} marker asks for ${count} d functions; d is 5 (spherical) or 6 (Cartesian).`,
          );
        }
        set('d', count, section);
        if (count === 5) impliedF = 7;
      } else if (letter === 'f') {
        if (count !== 7 && count !== 10) {
          throw new MoldenFormatError(
            `The ${section.header} marker asks for ${count} f functions; f is 7 (spherical) or 10 (Cartesian).`,
          );
        }
        set('f', count, section);
      } else {
        if (count !== 9 && count !== 15) {
          throw new MoldenFormatError(
            `The ${section.header} marker asks for ${count} g functions; g is 9 (spherical) or 15 (Cartesian).`,
          );
        }
        set('g', count, section);
      }
    }
  }

  const d = explicit.d ?? 6;
  const f = explicit.f ?? impliedF ?? 10;
  const g = explicit.g ?? 15;
  return {
    d,
    f,
    g,
    spherical: { d: d === 5, f: f === 7, g: g === 9 },
  };
}

function functionCountOf(label, markers) {
  if (label === 'd') return markers.d;
  if (label === 'f') return markers.f;
  if (label === 'g') return markers.g;
  return SHELLS[label].functions;
}

function shellTypeOf(label, markers) {
  if (label === 'd') return markers.d === 5 ? SHELLS.d.pureType : SHELLS.d.type;
  if (label === 'f') return markers.f === 7 ? SHELLS.f.pureType : SHELLS.f.type;
  if (label === 'g') return markers.g === 9 ? SHELLS.g.pureType : SHELLS.g.type;
  return SHELLS[label].type;
}

function parseAtoms(section, warnings) {
  if (!section) throw new MoldenFormatError('The file has no [Atoms] section.');
  const args = section.args.toLowerCase();
  const unit = /\bangs?\b|\bangstrom/.test(args) ? 'angs'
    : /\bau\b|\bbohr/.test(args) ? 'bohr' : null;
  if (!unit) {
    throw new MoldenFormatError(
      `The [Atoms] section does not say Angs or AU; its header is "${section.header}".`,
    );
  }

  const byIndex = new Map();
  let last = 0;
  for (const { text, line } of section.lines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const tokens = tokensOf(trimmed);
    if (tokens.length !== 6) {
      throw new MoldenFormatError(
        `[Atoms] line ${line} has ${tokens.length} fields; expected element index atomic-number x y z.`,
      );
    }
    const [, indexToken, numberTokenText, xToken, yToken, zToken] = tokens;
    const index = integerToken(indexToken, `[Atoms] line ${line}`);
    if (index < 1) {
      throw new MoldenFormatError(`[Atoms] atom index ${index} is invalid; indices start at 1.`);
    }
    const atomicNumber = integerToken(numberTokenText, `[Atoms] line ${line}`);
    if (atomicNumber < 0 || atomicNumber > 118) {
      throw new MoldenFormatError(`[Atoms] atomic number ${atomicNumber} is outside 0-118 (line ${line}).`);
    }
    if (byIndex.has(index)) {
      throw new MoldenFormatError(`[Atoms] atom index ${index} is repeated (line ${line}).`);
    }
    const element = SYMBOL_BY_NUMBER.get(atomicNumber) ?? null;
    if (!element && atomicNumber !== 0) {
      throw new MoldenFormatError(`[Atoms] atomic number ${atomicNumber} has no element symbol in this build.`);
    }
    const symbol = tokens[0];
    if (element && /^[A-Za-z]{1,3}$/.test(symbol) && symbol.toLowerCase() !== element.toLowerCase()) {
      warnings.push(`[Atoms] line ${line} names ${symbol} for atomic number ${atomicNumber} (${element}); the atomic number wins.`);
    }
    byIndex.set(index, {
      atomicNumber,
      element,
      x: numberToken(xToken, `[Atoms] line ${line}`),
      y: numberToken(yToken, `[Atoms] line ${line}`),
      z: numberToken(zToken, `[Atoms] line ${line}`),
    });
    if (index > last) last = index;
  }

  if (last === 0) throw new MoldenFormatError('The [Atoms] section has no atoms.');
  const rawAtoms = [];
  for (let index = 1; index <= last; index += 1) {
    const atom = byIndex.get(index);
    if (!atom) {
      throw new MoldenFormatError(`[Atoms] atom index ${index} is missing; the section has indices up to ${last}.`);
    }
    rawAtoms.push(atom);
  }

  const toAngstrom = unit === 'angs' ? (value) => value : (value) => value * BOHR_TO_ANGSTROM;
  const toBohr = unit === 'angs' ? (value) => value / BOHR_TO_ANGSTROM : (value) => value;
  return {
    unit,
    atoms: rawAtoms.map((atom) => ({
      atomicNumber: atom.atomicNumber,
      element: atom.element,
      x: toAngstrom(atom.x),
      y: toAngstrom(atom.y),
      z: toAngstrom(atom.z),
    })),
    atomicNumbers: rawAtoms.map((atom) => atom.atomicNumber),
    coordinatesBohr: rawAtoms.flatMap((atom) => [toBohr(atom.x), toBohr(atom.y), toBohr(atom.z)]),
  };
}

function sameExponents(left, right) {
  if (left.length !== right.length) return false;
  return left.every((primitive, index) => {
    const other = right[index];
    const scale = Math.max(1, Math.abs(primitive.exponent), Math.abs(other.exponent));
    return Math.abs(primitive.exponent - other.exponent) <= 1e-9 * scale;
  });
}

/**
 * Read `[GTO]` into signed shells. A bare `s` followed by a bare `p` with the
 * same exponents is recombined into an `sp`: that is exactly how this
 * repository's writer emits a combined shell, and the function order is
 * unchanged, so the recombination does not move a coefficient.
 */
function parseGto(section, atomCount, markers) {
  const blocks = [];
  let current = null;
  let shellNumber = 0;

  for (const { text, line } of section.lines) {
    const trimmed = text.trim();
    if (!trimmed) {
      current = null;
      continue;
    }
    const tokens = tokensOf(trimmed);
    // The specification puts a blank line between atom blocks, but not every
    // writer does. An atom header is `n` or `n 0`, and it is safe to recognise
    // one without the blank line only once every shell of the current block has
    // its declared primitives — otherwise `1 0` could be a primitive.
    const atomHeader = /^\d+$/.test(tokens[0])
      && (tokens.length === 1 || (tokens.length === 2 && tokens[1] === '0'))
      && (!current || current.shells.every((shell) => shell.primitives.length === shell.nprim));

    if (atomHeader) {
      const atom = Number(tokens[0]);
      if (atom < 1 || atom > atomCount) {
        throw new MoldenFormatError(
          `[GTO] atom ${atom} is out of range; the [Atoms] section defines ${atomCount} atom${atomCount === 1 ? '' : 's'}.`,
        );
      }
      current = { atom, line, shells: [] };
      blocks.push(current);
      continue;
    }

    if (!current) {
      throw new MoldenFormatError(`[GTO] line ${line} appears before any atom header.`);
    }

    if (/^[A-Za-z]/.test(tokens[0])) {
      const label = tokens[0].toLowerCase();
      if (!SHELLS[label]) {
        throw new MoldenFormatError(
          `[GTO] shell ${shellNumber + 1} on atom ${current.atom} has shell type "${tokens[0]}"; `
          + 'this reader supports s, p, sp, d, f and g.',
        );
      }
      if (tokens.length < 2) {
        throw new MoldenFormatError(`[GTO] line ${line}: the ${label} shell has no primitive count.`);
      }
      const nprim = integerToken(tokens[1], `[GTO] line ${line}`);
      if (nprim < 1) {
        throw new MoldenFormatError(`[GTO] line ${line}: the ${label} shell declares ${nprim} primitives.`);
      }
      // The optional third field is the Molden scale factor, which the format
      // description calls non-functional; it is accepted and ignored.
      shellNumber += 1;
      current.shells.push({
        label, nprim, line, primitives: [],
      });
      continue;
    }

    if (current.shells.length === 0) {
      throw new MoldenFormatError(`[GTO] line ${line} is a primitive before any shell header on atom ${current.atom}.`);
    }
    const shell = current.shells[current.shells.length - 1];
    const expected = shell.label === 'sp' ? 2 : 1;
    if (tokens.length !== expected + 1) {
      throw new MoldenFormatError(
        `[GTO] line ${line}: the ${shell.label} shell on atom ${current.atom} needs ${expected} `
        + `contraction coefficient${expected === 1 ? '' : 's'} per primitive, found ${tokens.length - 1}.`,
      );
    }
    shell.primitives.push({
      exponent: numberToken(tokens[0], `[GTO] line ${line}`),
      coefficients: tokens.slice(1).map((token) => numberToken(token, `[GTO] line ${line}`)),
    });
  }

  let index = 0;
  for (const block of blocks) {
    for (const shell of block.shells) {
      index += 1;
      if (shell.primitives.length !== shell.nprim) {
        throw new MoldenFormatError(
          `[GTO] shell ${index} (${shell.label}) on atom ${block.atom} declares ${shell.nprim} `
          + `primitive${shell.nprim === 1 ? '' : 's'} but has ${shell.primitives.length}.`,
        );
      }
    }
  }

  const shells = [];
  for (const block of blocks) {
    for (let shellIndex = 0; shellIndex < block.shells.length; shellIndex += 1) {
      const shell = block.shells[shellIndex];
      const next = block.shells[shellIndex + 1];
      if (shell.label === 's' && next && next.label === 'p'
        && sameExponents(shell.primitives, next.primitives)) {
        shells.push({
          atom: block.atom,
          type: -1,
          label: 'sp',
          primitives: shell.primitives.map((primitive, primitiveIndex) => ({
            exponent: primitive.exponent,
            s: primitive.coefficients[0],
            p: next.primitives[primitiveIndex].coefficients[0],
          })),
        });
        shellIndex += 1;
        continue;
      }
      shells.push({
        atom: block.atom,
        type: shellTypeOf(shell.label, markers),
        label: shell.label,
        primitives: shell.primitives.map((primitive) => ({
          exponent: primitive.exponent,
          s: primitive.coefficients[0],
          ...(shell.label === 'sp' ? { p: primitive.coefficients[1] } : {}),
        })),
      });
    }
  }

  const shellTypes = [];
  const primitivesPerShell = [];
  const shellToAtomMap = [];
  const primitiveExponents = [];
  const contractionCoefficients = [];
  const hasSp = shells.some((shell) => shell.type === -1);
  const spContractionCoefficients = hasSp ? [] : undefined;
  for (const shell of shells) {
    shellTypes.push(shell.type);
    primitivesPerShell.push(shell.primitives.length);
    shellToAtomMap.push(shell.atom);
    for (const primitive of shell.primitives) {
      primitiveExponents.push(primitive.exponent);
      contractionCoefficients.push(primitive.s);
      if (spContractionCoefficients) {
        // A Gaussian checkpoint writes a zero in the P(S=P) array for a shell
        // that is not sp; this keeps `shellsFromFchk` reading the same layout.
        spContractionCoefficients.push(shell.type === -1 ? primitive.p : 0);
      }
    }
  }

  return {
    shells,
    shellTypes,
    primitivesPerShell,
    shellToAtomMap,
    primitiveExponents,
    contractionCoefficients,
    spContractionCoefficients,
    numberOfBasisFunctions: shells.reduce((sum, shell) => sum + functionCountOf(shell.label, markers), 0),
  };
}

function markerDescription(markers) {
  const labels = [];
  if (markers.d === 5) labels.push('[5D]');
  if (markers.f === 7) labels.push('[7F]');
  if (markers.g === 9) labels.push('[9G]');
  return labels.length ? labels.join(' ') : 'no [5D]/[7F]/[9G] marker, so d/f/g are Cartesian';
}

function parseMo(section, nbf, markers) {
  if (!section) return null;
  const nonEmpty = section.lines.filter((line) => line.text.trim());
  if (nbf === 0) {
    if (nonEmpty.length === 0) return [];
    throw new MoldenFormatError(
      `[MO] has ${nonEmpty.length} non-empty line${nonEmpty.length === 1 ? '' : 's'} `
      + 'but the file has no [GTO] basis to attach them to.',
    );
  }
  if (nonEmpty.length === 0) return [];

  const orbitals = [];
  let current = null;

  const finalize = () => {
    if (!current) return;
    const label = `[MO] orbital ${current.number}${current.symmetry ? ` (Sym= ${current.symmetry})` : ''}`;
    if (!Number.isFinite(current.energy)) {
      throw new MoldenFormatError(`${label} has no Ene= line.`);
    }
    if (!Number.isFinite(current.occupation)) {
      throw new MoldenFormatError(`${label} has no Occup= line.`);
    }
    if (current.coefficients.size !== nbf) {
      throw new MoldenFormatError(
        `${label} has ${current.coefficients.size} coefficient${current.coefficients.size === 1 ? '' : 's'} `
        + `but the basis has ${nbf} function${nbf === 1 ? '' : 's'} (${markerDescription(markers)}).`,
      );
    }
    for (const basisIndex of current.coefficients.keys()) {
      if (basisIndex < 1 || basisIndex > nbf) {
        throw new MoldenFormatError(
          `${label} has coefficient index ${basisIndex}; the basis has ${nbf} function${nbf === 1 ? '' : 's'}.`,
        );
      }
    }
    current.coefficients = Array.from({ length: nbf }, (_, index) => current.coefficients.get(index + 1));
    if (!current.spin) current.spin = 'Alpha';
  };

  for (const { text, line } of section.lines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const header = /^(Sym|Ene|Spin|Occup)\s*=\s*(.*)$/i.exec(trimmed);
    if (header) {
      const key = header[1].toLowerCase();
      const value = header[2].trim();
      if (key === 'sym') {
        finalize();
        current = {
          number: orbitals.length + 1,
          symmetry: value,
          energy: Number.NaN,
          spin: null,
          occupation: Number.NaN,
          coefficients: new Map(),
        };
        orbitals.push(current);
        continue;
      }
      if (!current || (key === 'ene' && Number.isFinite(current.energy))) {
        finalize();
        current = {
          number: orbitals.length + 1,
          symmetry: '',
          energy: Number.NaN,
          spin: null,
          occupation: Number.NaN,
          coefficients: new Map(),
        };
        orbitals.push(current);
      }
      if (key === 'ene') {
        current.energy = numberToken(value, `[MO] line ${line}`);
      } else if (key === 'occup') {
        current.occupation = numberToken(value, `[MO] line ${line}`);
      } else {
        const spin = value.toLowerCase();
        if (spin !== 'alpha' && spin !== 'beta') {
          throw new MoldenFormatError(
            `[MO] orbital ${current.number} has Spin= "${value}"; only Alpha and Beta are defined.`,
          );
        }
        current.spin = spin === 'alpha' ? 'Alpha' : 'Beta';
      }
      continue;
    }

    if (!current) {
      throw new MoldenFormatError(`[MO] line ${line} is a coefficient before any orbital header.`);
    }
    const tokens = tokensOf(trimmed);
    if (tokens.length !== 2) {
      throw new MoldenFormatError(
        `[MO] line ${line} has ${tokens.length} fields; expected a coefficient index and a value.`,
      );
    }
    const basisIndex = integerToken(tokens[0], `[MO] line ${line}`);
    if (current.coefficients.has(basisIndex)) {
      throw new MoldenFormatError(`[MO] orbital ${current.number} repeats coefficient index ${basisIndex}.`);
    }
    current.coefficients.set(basisIndex, numberToken(tokens[1], `[MO] line ${line}`));
  }
  finalize();
  return orbitals;
}

function isZero(value) {
  return Math.abs(value) < 1e-6;
}

function isTwo(value) {
  return Math.abs(value - 2) < 1e-6;
}

/**
 * The checkpoint's electron counts from Molden occupations.
 *
 * Molden writes a restricted closed-shell orbital once with `Occup= 2`, but a
 * checkpoint counts one alpha electron in each doubly occupied spatial orbital,
 * so the alpha count is the number of occupied alpha orbitals, not the sum of
 * their occupations. For an unrestricted file the two manifolds are separate
 * and each orbital contributes at most one electron. If there is no beta block
 * and an occupation is neither 0 nor 2, the beta count cannot be derived and is
 * left absent rather than guessed.
 */
function electronCountsOf(orbitals, warnings) {
  const alpha = orbitals.filter((orbital) => orbital.spin === 'Alpha');
  const beta = orbitals.filter((orbital) => orbital.spin === 'Beta');
  const whole = (value) => isZero(value) || isTwo(value) || Math.abs(value - 1) < 1e-6;
  if (orbitals.some((orbital) => !whole(orbital.occupation))) {
    warnings.push(
      'The [MO] occupations include values other than 0, 1 or 2; the electron counts are rounded from them.',
    );
  }
  const alphaElectrons = alpha.length
    ? Math.round(alpha.reduce((sum, orbital) => sum + Math.min(Math.max(orbital.occupation, 0), 1), 0))
    : null;
  let betaElectrons = null;
  let electrons = null;
  if (beta.length > 0) {
    betaElectrons = Math.round(beta.reduce((sum, orbital) => sum + Math.min(Math.max(orbital.occupation, 0), 1), 0));
    electrons = (alphaElectrons ?? 0) + betaElectrons;
  } else if (alpha.length > 0 && alpha.every((orbital) => isZero(orbital.occupation) || isTwo(orbital.occupation))) {
    betaElectrons = alphaElectrons;
    electrons = alphaElectrons === null ? null : 2 * alphaElectrons;
  } else if (alpha.length > 0) {
    warnings.push(
      'The [MO] block has no Beta orbitals and includes occupations other than 0 or 2, '
      + 'so the beta electron count and multiplicity cannot be derived.',
    );
  }
  return { alphaElectrons, betaElectrons, electrons };
}

/**
 * Parse a Molden file.
 *
 * @param {string} text
 * @param {{ maxChars?: number }} [options] `maxChars` lets the bound be tested
 *   without a 64 MB fixture; callers should leave it alone.
 */
export function parseMolden(text, { maxChars = MAX_MOLDEN_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new MoldenFormatError('The Molden file is empty.');
  }
  if (text.length > maxChars) {
    throw new MoldenFormatError(
      `The Molden file is ${text.length} characters; the limit is ${maxChars}. `
      + 'This reader needs the atoms, basis and MO block, so trim the file or export it from a smaller job.',
    );
  }

  const { sections, preface } = splitSections(text);
  const firstLine = preface.find((line) => line.text.trim());
  if (firstLine) {
    throw new MoldenFormatError(
      `This file does not start with [Molden Format]; the first line is "${firstLine.text.trim()}".`,
    );
  }
  if (!sections.length || sections[0].name !== 'molden format') {
    throw new MoldenFormatError(
      'This file does not start with [Molden Format]; a Molden file begins with that header.',
    );
  }

  if (sectionOf(sections, 'sto')) {
    throw new MoldenFormatError(
      'The [STO] section (Slater orbitals) is not supported; only [GTO] Gaussian basis sets can be read.',
    );
  }

  const warnings = [];
  const atomsSection = sectionOf(sections, 'atoms');
  const atomData = parseAtoms(atomsSection, warnings);
  const markers = markersOf(sections);
  const gtoSection = sectionOf(sections, 'gto');
  const basis = gtoSection ? parseGto(gtoSection, atomData.atoms.length, markers) : null;
  const moSection = sectionOf(sections, 'mo');
  const orbitals = parseMo(moSection, basis ? basis.numberOfBasisFunctions : 0, markers);

  const parsed = {
    format: 'molden',
    title: titleOf(sections),
    found: [],
    missing: [],
    warnings,
    units: { coordinates: 'angstrom', source: atomData.unit },
    spherical: markers.spherical,
    numberOfAtoms: atomData.atoms.length,
    atoms: atomData.atoms,
    atomicNumbers: atomData.atomicNumbers,
    coordinatesBohr: atomData.coordinatesBohr,
  };

  parsed.found.push(
    'numberOfAtoms', 'atoms', 'atomicNumbers', 'coordinatesBohr',
  );
  parsed.missing.push(
    'charge', 'multiplicity', 'totalEnergyHartree', 'virialRatio', 'mullikenCharges', 'espCharges',
  );

  if (basis) {
    Object.assign(parsed, {
      shells: basis.shells,
      shellTypes: basis.shellTypes,
      primitivesPerShell: basis.primitivesPerShell,
      shellToAtomMap: basis.shellToAtomMap,
      primitiveExponents: basis.primitiveExponents,
      contractionCoefficients: basis.contractionCoefficients,
      numberOfBasisFunctions: basis.numberOfBasisFunctions,
    });
    parsed.found.push(
      'shellTypes', 'primitivesPerShell', 'shellToAtomMap',
      'primitiveExponents', 'contractionCoefficients', 'numberOfBasisFunctions',
    );
    if (basis.spContractionCoefficients) {
      parsed.spContractionCoefficients = basis.spContractionCoefficients;
      parsed.found.push('spContractionCoefficients');
    } else {
      parsed.missing.push('spContractionCoefficients');
    }
  } else {
    parsed.missing.push(
      'shellTypes', 'primitivesPerShell', 'shellToAtomMap',
      'primitiveExponents', 'contractionCoefficients', 'spContractionCoefficients', 'numberOfBasisFunctions',
    );
  }

  if (orbitals && orbitals.length > 0) {
    parsed.orbitals = orbitals;
    const alpha = orbitals.filter((orbital) => orbital.spin === 'Alpha');
    const beta = orbitals.filter((orbital) => orbital.spin === 'Beta');
    if (alpha.length > 0) {
      parsed.alphaMOCoefficients = alpha.flatMap((orbital) => orbital.coefficients);
      parsed.orbitalEnergies = alpha.map((orbital) => orbital.energy);
      parsed.found.push('alphaMOCoefficients', 'orbitalEnergies');
    }
    if (beta.length > 0) {
      parsed.betaMOCoefficients = beta.flatMap((orbital) => orbital.coefficients);
      parsed.orbitalEnergiesBeta = beta.map((orbital) => orbital.energy);
      parsed.found.push('betaMOCoefficients', 'orbitalEnergiesBeta');
    }

    const counts = electronCountsOf(orbitals, warnings);
    if (counts.alphaElectrons !== null) {
      parsed.numberOfAlphaElectrons = counts.alphaElectrons;
      parsed.found.push('numberOfAlphaElectrons');
    }
    if (counts.betaElectrons !== null) {
      parsed.numberOfBetaElectrons = counts.betaElectrons;
      parsed.found.push('numberOfBetaElectrons');
    }
    if (counts.electrons !== null) {
      parsed.numberOfElectrons = counts.electrons;
      parsed.found.push('numberOfElectrons');
    }
    if (counts.alphaElectrons === null) parsed.missing.push('numberOfAlphaElectrons');
    if (counts.betaElectrons === null) parsed.missing.push('numberOfBetaElectrons');
    if (counts.electrons === null) parsed.missing.push('numberOfElectrons');
  }

  if (!orbitals || orbitals.length === 0) {
    parsed.missing.push(
      'alphaMOCoefficients', 'betaMOCoefficients', 'orbitalEnergies', 'orbitalEnergiesBeta',
      'numberOfAlphaElectrons', 'numberOfBetaElectrons', 'numberOfElectrons',
    );
  }

  return parsed;
}
