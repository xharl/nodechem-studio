/**
 * Gaussian formatted-checkpoint (`.fchk`) reader, restricted to the fields the
 * results surface can actually use (#59).
 *
 * The format is line-oriented: a label padded to column 43, then a type letter
 * (`I` integer, `R` real) and either a value or `N= <count>` followed by the
 * data, six integers or five reals per line. It is not fixed-width in practice
 * — Gaussian versions and third-party writers pad differently — so labels are
 * matched as text and the remainder is tokenised, which also gets the `N=`
 * header right without counting columns.
 *
 * Contract, because the difference matters:
 * - every field is optional;
 * - a field that is missing is **absent** from the result — never `0`, never an
 *   empty array — and is listed in `missing`;
 * - `found` names every field that was read, so a caller can show what the
 *   record actually contains;
 * - a length that disagrees with `Number of atoms` is an error, not a warning:
 *   it means the reader and the file disagree, and guessing which is right
 *   would produce a chemistry answer from a parsing bug.
 *
 * What is deliberately not read: MO coefficients, shell/basis information,
 * polarisabilities and the (large) two-electron integrals. Orbital *energies*
 * are enough for a HOMO/LUMO gap; rendering an orbital needs the coefficients
 * and a marching-cubes renderer, which is the other half of #59.
 */

import { ELEMENTS } from './elements.js';
import { BOHR_TO_ANGSTROM } from './cubeFile.js';

/** Characters, not bytes: the guard bounds the work on text that is already decoded. */
export const MAX_FCHK_CHARS = 64 * 1024 * 1024;
/** No field in the subset needs more than a few thousand values; this is a guard, not a target. */
export const MAX_FCHK_VALUES = 2_000_000;

export class FchkFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FchkFormatError';
  }
}

const SYMBOL_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;

/**
 * The subset, in the order it is reported. `type` is what the format says the
 * field is; a mismatch is reported rather than trusted.
 */
const FIELDS = Object.freeze([
  { key: 'numberOfAtoms', label: 'Number of atoms', type: 'I', kind: 'integer' },
  { key: 'numberOfBasisFunctions', label: 'Number of basis functions', type: 'I', kind: 'integer' },
  { key: 'numberOfElectrons', label: 'Number of electrons', type: 'I', kind: 'integer' },
  { key: 'charge', label: 'Charge', type: 'I', kind: 'integer' },
  { key: 'multiplicity', label: 'Multiplicity', type: 'I', kind: 'integer' },
  { key: 'numberOfAlphaElectrons', label: 'Number of alpha electrons', type: 'I', kind: 'integer' },
  { key: 'numberOfBetaElectrons', label: 'Number of beta electrons', type: 'I', kind: 'integer' },
  { key: 'atomicNumbers', label: 'Atomic numbers', type: 'I', kind: 'integerArray' },
  { key: 'coordinatesBohr', label: 'Current cartesian coordinates', type: 'R', kind: 'realArray' },
  // Gaussian writes the alpha set as `Alpha Orbital Energies` and the beta set
  // as `Beta Orbital Energies`. Older readers (and some third-party writers)
  // use `Orbital Energies` / `Orbital Energies, spin 2`; both spellings are
  // accepted so a real Gaussian fchk reports its energies instead of going
  // silently missing.
  {
    key: 'orbitalEnergies',
    label: 'Alpha Orbital Energies',
    aliases: ['Orbital Energies'],
    type: 'R',
    kind: 'realArray',
  },
  {
    key: 'orbitalEnergiesBeta',
    label: 'Beta Orbital Energies',
    aliases: ['Orbital Energies, spin 2'],
    type: 'R',
    kind: 'realArray',
  },
  // #111 follow-up: the basis and the molecular orbitals, which the Molden
  // writer needs. A record without them still parses; the writer refuses.
  { key: 'shellTypes', label: 'Shell types', type: 'I', kind: 'integerArray' },
  { key: 'primitivesPerShell', label: 'Number of primitives per shell', type: 'I', kind: 'integerArray' },
  { key: 'shellToAtomMap', label: 'Shell to atom map', type: 'I', kind: 'integerArray' },
  { key: 'primitiveExponents', label: 'Primitive exponents', type: 'R', kind: 'realArray' },
  { key: 'contractionCoefficients', label: 'Contraction coefficients', type: 'R', kind: 'realArray' },
  { key: 'spContractionCoefficients', label: 'P(S=P) Contraction coefficients', type: 'R', kind: 'realArray' },
  { key: 'alphaMOCoefficients', label: 'Alpha MO coefficients', type: 'R', kind: 'realArray' },
  { key: 'betaMOCoefficients', label: 'Beta MO coefficients', type: 'R', kind: 'realArray' },
  { key: 'pureDShells', label: 'Pure/Cartesian d shells', type: 'I', kind: 'integer' },
  { key: 'pureFShells', label: 'Pure/Cartesian f shells', type: 'I', kind: 'integer' },
  { key: 'mullikenCharges', label: 'Mulliken Charges', type: 'R', kind: 'realArray' },
  { key: 'espCharges', label: 'ESP Charges', type: 'R', kind: 'realArray' },
  { key: 'totalEnergyHartree', label: 'Total Energy', type: 'R', kind: 'real' },
  { key: 'virialRatio', label: 'Virial Ratio', type: 'R', kind: 'real' },
]);

function numberToken(token, line, label) {
  const raw = String(token ?? '');
  if (!NUMBER.test(raw)) {
    throw new FchkFormatError(`Line ${line}: field "${label}" has the non-numeric token "${raw}".`);
  }
  const value = Number(raw.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) {
    throw new FchkFormatError(`Line ${line}: field "${label}" has "${raw}", which is outside the range of a double.`);
  }
  return value;
}

function integerToken(token, line, label) {
  const value = numberToken(token, line, label);
  if (!Number.isInteger(value)) {
    throw new FchkFormatError(`Line ${line}: field "${label}" expects an integer, found "${String(token)}".`);
  }
  return value;
}

function tokensOf(line) {
  return String(line ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Locate one field. A label that is a prefix of another (`Orbital Energies` of
 * `Orbital Energies, spin 2`) does not match the longer line, because the
 * remainder there starts with a comma rather than a type letter.
 */
function locate(lines, label) {
  const needle = label.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.length <= needle.length) continue;
    if (line.slice(0, needle.length).toLowerCase() !== needle) continue;
    const rest = line.slice(needle.length);
    if (rest && !/^\s/.test(rest)) continue;
    const trimmed = rest.trim();
    if (!trimmed) continue;
    const array = /^([IR])\s+N\s*=\s*(\d+)$/i.exec(trimmed);
    if (array) {
      return {
        label,
        line: index + 1,
        start: index,
        type: array[1].toUpperCase(),
        count: Number(array[2]),
      };
    }
    const scalar = /^([IR])\s+(\S+)$/i.exec(trimmed);
    if (scalar) {
      return {
        label,
        line: index + 1,
        start: index,
        type: scalar[1].toUpperCase(),
        value: scalar[2],
      };
    }
    // Some other field whose label merely begins with this one.
  }
  return null;
}

function looksLikeFieldHeader(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || trimmed.length < 20) return false;
  return /^[A-Za-z$]/.test(trimmed) && /\s[NICR]\s+(?:N\s*=\s*\d+|-?\d)/.test(` ${trimmed}`);
}

function readArray(lines, located, field) {
  const declared = located.count;
  if (declared > MAX_FCHK_VALUES) {
    throw new FchkFormatError(
      `Field "${field.label}" declares ${declared} values; the limit is ${MAX_FCHK_VALUES}.`,
    );
  }
  const collected = [];
  for (let index = located.start + 1; collected.length < declared && index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (looksLikeFieldHeader(line)) {
      throw new FchkFormatError(
        `Field "${field.label}" declares ${declared} values but stops after ${collected.length} at line ${index + 1}, where another field begins.`,
      );
    }
    for (const token of tokensOf(line)) {
      if (collected.length >= declared) {
        throw new FchkFormatError(
          `Line ${index + 1}: field "${field.label}" declares ${declared} values but the data continues with "${token}".`,
        );
      }
      collected.push(field.kind === 'integerArray'
        ? integerToken(token, index + 1, field.label)
        : numberToken(token, index + 1, field.label));
    }
  }
  if (collected.length < declared) {
    throw new FchkFormatError(
      `Field "${field.label}" declares ${declared} values but the file ends after ${collected.length}.`,
    );
  }
  return collected;
}

/**
 * Parse a formatted checkpoint.
 *
 * @param {string} text
 * @param {{ maxChars?: number }} [options] `maxChars` lets the bound be tested
 *   without a 64 MB fixture; callers should leave it alone.
 */
export function parseFchk(text, { maxChars = MAX_FCHK_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new FchkFormatError('The checkpoint file is empty.');
  }
  if (text.length > maxChars) {
    throw new FchkFormatError(
      `The checkpoint is ${text.length} characters; the limit is ${maxChars}. `
      + 'This reader only needs the summary fields, so trim the file or export it from a smaller job.',
    );
  }

  const lines = text.split(/\r\n|\n|\r/);
  const warnings = [];
  const found = [];
  const missing = [];
  const parsed = { format: 'fchk', found, missing, warnings };

  for (const field of FIELDS) {
    const located = [field.label, ...(field.aliases || [])]
      .map((label) => locate(lines, label))
      .find(Boolean) || null;
    if (!located) {
      missing.push(field.key);
      continue;
    }
    const shown = located.label || field.label;
    if (located.type !== field.type) {
      warnings.push(`Field "${shown}" is written as ${located.type} where the format specifies ${field.type}; it was read as written.`);
    }
    if (field.kind === 'integer' || field.kind === 'real') {
      if (located.count !== undefined) {
        // An `N=` header on a scalar field means the file is not laid out the
        // way the label list says; reading the first value would be a guess.
        throw new FchkFormatError(`Line ${located.line}: field "${shown}" is an array in this file, but the reader expects one value.`);
      }
      parsed[field.key] = field.kind === 'integer'
        ? integerToken(located.value, located.line, shown)
        : numberToken(located.value, located.line, shown);
    } else {
      if (located.count === undefined) {
        throw new FchkFormatError(`Line ${located.line}: field "${shown}" carries one value in this file, but the reader expects an array.`);
      }
      parsed[field.key] = readArray(lines, located, { ...field, label: shown });
    }
    found.push(field.key);
  }

  if (found.length === 0) {
    throw new FchkFormatError(
      'No checkpoint field was recognised, so this is not a formatted checkpoint '
      + '(a binary .chk has to be converted with `formchk` first).',
    );
  }

  const atomCount = parsed.numberOfAtoms ?? null;
  if (atomCount !== null && atomCount < 0) {
    throw new FchkFormatError(`Number of atoms is ${atomCount}; it cannot be negative.`);
  }

  // Cross-checks that catch a misread rather than a bad calculation.
  const chargeCount = (key, label) => {
    const values = parsed[key];
    if (!Array.isArray(values) || atomCount === null) return;
    if (values.length !== atomCount) {
      throw new FchkFormatError(`Field "${label}" has ${values.length} values for ${atomCount} atoms.`);
    }
  };
  chargeCount('atomicNumbers', 'Atomic numbers');
  chargeCount('mullikenCharges', 'Mulliken Charges');
  chargeCount('espCharges', 'ESP Charges');

  if (Array.isArray(parsed.coordinatesBohr) && atomCount !== null && parsed.coordinatesBohr.length !== atomCount * 3) {
    throw new FchkFormatError(
      `"Current cartesian coordinates" has ${parsed.coordinatesBohr.length} values for ${atomCount} atoms (expected ${atomCount * 3}).`,
    );
  }

  // Basis/MO cross-checks: a length that disagrees means the reader and the
  // file disagree about the layout, which is exactly when a Molden export would
  // write coefficients against the wrong shell.
  const shells = parsed.shellTypes;
  if (Array.isArray(shells)) {
    const prims = parsed.primitivesPerShell;
    const map = parsed.shellToAtomMap;
    if (Array.isArray(prims) && prims.length !== shells.length) {
      throw new FchkFormatError(`"Number of primitives per shell" has ${prims.length} entries for ${shells.length} shells.`);
    }
    if (Array.isArray(map) && map.length !== shells.length) {
      throw new FchkFormatError(`"Shell to atom map" has ${map.length} entries for ${shells.length} shells.`);
    }
    const totalPrimitives = Array.isArray(prims) ? prims.reduce((sum, value) => sum + value, 0) : null;
    if (totalPrimitives !== null && Array.isArray(parsed.primitiveExponents)
      && parsed.primitiveExponents.length !== totalPrimitives) {
      throw new FchkFormatError(
        `"Primitive exponents" has ${parsed.primitiveExponents.length} values but the shells need ${totalPrimitives}.`,
      );
    }
    if (totalPrimitives !== null && Array.isArray(parsed.contractionCoefficients)
      && parsed.contractionCoefficients.length !== totalPrimitives) {
      throw new FchkFormatError(
        `"Contraction coefficients" has ${parsed.contractionCoefficients.length} values but the shells need ${totalPrimitives}.`,
      );
    }
    if (Array.isArray(map) && atomCount !== null) {
      for (const index of map) {
        if (index < 1 || index > atomCount) {
          throw new FchkFormatError(`"Shell to atom map" points at atom ${index}; the file has ${atomCount}.`);
        }
      }
    }
  }
  if (Array.isArray(parsed.alphaMOCoefficients) && Number.isInteger(parsed.numberOfBasisFunctions)) {
    const nbf = parsed.numberOfBasisFunctions;
    if (nbf > 0 && parsed.alphaMOCoefficients.length % nbf !== 0) {
      throw new FchkFormatError(
        `"Alpha MO coefficients" has ${parsed.alphaMOCoefficients.length} values, which is not a whole number of ${nbf}-function orbitals.`,
      );
    }
  }

  if (parsed.numberOfAlphaElectrons !== undefined && parsed.numberOfBetaElectrons !== undefined
    && parsed.numberOfElectrons !== undefined
    && parsed.numberOfAlphaElectrons + parsed.numberOfBetaElectrons !== parsed.numberOfElectrons) {
    warnings.push(
      `The alpha (${parsed.numberOfAlphaElectrons}) and beta (${parsed.numberOfBetaElectrons}) counts `
      + `do not add up to Number of electrons (${parsed.numberOfElectrons}).`,
    );
  }
  if (parsed.numberOfAlphaElectrons !== undefined && parsed.numberOfBetaElectrons !== undefined
    && parsed.multiplicity !== undefined) {
    const stated = Math.abs(parsed.numberOfAlphaElectrons - parsed.numberOfBetaElectrons) + 1;
    if (stated !== parsed.multiplicity) {
      warnings.push(`Alpha/beta counts imply multiplicity ${stated}; the file states ${parsed.multiplicity}.`);
    }
  }

  if (Array.isArray(parsed.atomicNumbers) && Array.isArray(parsed.coordinatesBohr)) {
    const atoms = [];
    let ghosts = 0;
    for (let index = 0; index < parsed.atomicNumbers.length; index += 1) {
      const atomicNumber = parsed.atomicNumbers[index];
      if (!Number.isInteger(atomicNumber) || atomicNumber < 0 || atomicNumber > 118) {
        throw new FchkFormatError(`Atomic numbers[${index}] is ${atomicNumber}, which is outside 0–118.`);
      }
      const element = SYMBOL_BY_NUMBER.get(atomicNumber) ?? null;
      if (atomicNumber === 0) ghosts += 1;
      atoms.push({
        atomicNumber,
        element,
        // The file stores bohr; the rest of the app is Å. Converted here once.
        x: parsed.coordinatesBohr[index * 3] * BOHR_TO_ANGSTROM,
        y: parsed.coordinatesBohr[index * 3 + 1] * BOHR_TO_ANGSTROM,
        z: parsed.coordinatesBohr[index * 3 + 2] * BOHR_TO_ANGSTROM,
      });
    }
    if (ghosts > 0) {
      warnings.push(`${ghosts} ghost atom${ghosts === 1 ? '' : 's'} (atomic number 0) kept without an element symbol.`);
    }
    parsed.atoms = atoms;
  }

  parsed.units = { coordinates: 'angstrom', source: 'bohr' };
  return parsed;
}
