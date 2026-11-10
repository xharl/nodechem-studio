/**
 * Gaussian formatted-checkpoint (`.fchk`) reader, restricted to the fields the
 * results surface can actually use (#59).
 *
 * The format is line-oriented: a label padded to column 43, then a type letter
 * (`I` integer, `R` real, `C` character) and either a value or `N= <count>`
 * followed by the data — six integers, five reals or five 12-character strings
 * per line. It is not fixed-width in practice — Gaussian versions and
 * third-party writers pad differently — so labels are matched as text and the
 * numeric remainder is tokenised, which also gets the `N=` header right without
 * counting columns. Character blocks are the exception: their elements are
 * fixed-width strings, so they are sliced, not tokenised (#245).
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

/**
 * Characters, not bytes: the guard bounds the work on text that is already
 * decoded. It is sized from the largest legitimate file this app is expected to
 * read, not from the subset's own small fields (#243): a 2000-basis-function
 * open-shell fchk carries alpha and beta MO blocks of 4,000,000 values each
 * plus a 2,001,000-value density triangle. Gaussian writes five 16-character
 * reals per line, which is about 160 MB for that file; the old 64 MiB cap
 * refused it. A caller with more memory can raise the bound through
 * `parseFchk`'s `maxChars`, and a file beyond this ceiling is refused with that
 * remedy rather than told to trim a line-oriented format it cannot trim.
 */
export const MAX_FCHK_CHARS = 256 * 1024 * 1024;
/**
 * Values per field. The largest legitimate block is `NBasis²` (an MO
 * coefficient set): 4,000,000 at 2000 functions, 16,000,000 at 4000. The guard
 * is a ceiling, not a target, and `parseFchk` lets a caller raise it.
 */
export const MAX_FCHK_VALUES = 16_000_000;

export class FchkFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FchkFormatError';
  }
}

/**
 * `Job Status`, the fchk twin of `GAUSSIAN SCALARS` entry 61 documented on
 * gaussian.com/interfacing. It is completion evidence, not a number to show:
 * 1 and 2 mean the job (or a step of it) finished, 3 means Link 9999 recorded
 * an error, and -1/0 mean the file cannot prove completion (#244).
 */
const JOB_STATUS = Object.freeze({
  [-1]: 'in progress',
  0: 'undefined or old checkpoint file',
  1: 'finished successfully',
  2: 'step in a multi-step job completed successfully',
  3: 'error termination in Link 9999',
});

/** The documented meaning of a `Job Status` value, or `null` if it is not one. */
export function jobStatusLabel(status) {
  return Object.hasOwn(JOB_STATUS, status) ? JOB_STATUS[status] : null;
}

const SYMBOL_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;

/**
 * The subset, in the order it is reported. `type` is what the format says the
 * field is; a mismatch is reported rather than trusted.
 */
const FIELDS = Object.freeze([
  { key: 'fullTitle', label: 'Full Title', type: 'C', kind: 'charArray' },
  { key: 'route', label: 'Route', type: 'C', kind: 'charArray' },
  { key: 'numberOfAtoms', label: 'Number of atoms', type: 'I', kind: 'integer' },
  { key: 'numberOfBasisFunctions', label: 'Number of basis functions', type: 'I', kind: 'integer' },
  // `NBsUse`: the number of linearly independent functions after the linear
  // dependence of the basis has been removed. The MO coefficient block is
  // `NBasis × NBsUse`, so it is also the check that a truncated block would
  // otherwise pass when its length happens to be divisible by NBasis (#246).
  {
    key: 'numberOfIndependentFunctions',
    label: 'Number of independent functions',
    // Older writers, and the matrix-element documentation, spell it with an
    // `a`: `independant`. Both name the same integer.
    aliases: ['Number of independant functions'],
    type: 'I',
    kind: 'integer',
  },
  { key: 'numberOfElectrons', label: 'Number of electrons', type: 'I', kind: 'integer' },
  { key: 'charge', label: 'Charge', type: 'I', kind: 'integer' },
  { key: 'multiplicity', label: 'Multiplicity', type: 'I', kind: 'integer' },
  // Closed/open-shell flag: 0 is closed shell, >= 1 is an open-shell (two-spin)
  // file, and -1 means the writer did not specify. It is cross-checked against
  // the beta and spin-density blocks below (#246).
  { key: 'iopcl', label: 'IOpCl', type: 'I', kind: 'integer' },
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
  // issue 164: the density matrix, which the electrostatic potential needs. It
  // is written as the lower triangle in `NBasis(NBasis+1)/2` values, five per
  // line — the same shape as the MO coefficient block but half as long. It is
  // kept as a Float64Array because it is integrated against, not printed.
  {
    key: 'totalScfDensity',
    label: 'Total SCF Density',
    type: 'R',
    kind: 'realArray',
    triangular: true,
  },
  {
    // Psi4 and some Gaussian versions spell the same block `Total SCD Density`.
    // It is a separate field, never merged: a file that carries both is read
    // from `Total SCF Density`, and one that carries only this is still readable.
    key: 'totalScdDensity',
    label: 'Total SCD Density',
    type: 'R',
    kind: 'realArray',
    triangular: true,
  },
  // issue 168: the unrestricted alpha−beta density (Psi4 writes `Spin SCF
  // Density`, Gaussian `Spin Density`), same triangular layout as the total.
  // Absent for a closed-shell file, and absent is the honest answer there: the
  // spin density of a closed-shell wavefunction is zero by construction, so no
  // reader should treat a missing block as a block of zeros.
  {
    key: 'spinScfDensity',
    label: 'Spin SCF Density',
    aliases: ['Spin Density'],
    type: 'R',
    kind: 'realArray',
    triangular: true,
  },
  { key: 'mullikenCharges', label: 'Mulliken Charges', type: 'R', kind: 'realArray' },
  { key: 'espCharges', label: 'ESP Charges', type: 'R', kind: 'realArray' },
  { key: 'totalEnergyHartree', label: 'Total Energy', type: 'R', kind: 'real' },
  { key: 'virialRatio', label: 'Virial Ratio', type: 'R', kind: 'real' },
  // #244: completion evidence. Absent is a legitimate answer (not every writer
  // emits it), so the reader must not synthesise 0 — which would flag every
  // third-party file as an "undefined/old checkpoint".
  { key: 'jobStatus', label: 'Job Status', type: 'I', kind: 'integer' },
  // #245: the program that wrote the checkpoint. Gaussian writes this as a
  // character array (`C N= 2` for `ES64L-G16RevA.03`), not a scalar.
  { key: 'version', label: 'Gaussian Version', type: 'C', kind: 'charArray' },
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
 *
 * `C` is accepted for character arrays (`C N= k`) and character scalars
 * (`C value`). The character value of a scalar keeps its spaces; the array
 * elements are read by `readCharBlock`, which slices them rather than
 * tokenising them (#245).
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
    const array = /^([IRC])\s+N\s*=\s*(\d+)$/i.exec(trimmed);
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
    const character = /^C\s+(.*)$/i.exec(trimmed);
    if (character) {
      return {
        label,
        line: index + 1,
        start: index,
        type: 'C',
        value: character[1].trim(),
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

/**
 * The same question for a character block. A title is arbitrary text, so a
 * single space before a letter is not enough to call the line a field header
 * (a title may legitimately contain `C 1`); Gaussian pads the label to column
 * 43, which leaves at least two spaces before the type letter.
 */
function looksLikeCharacterFieldHeader(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed || trimmed.length < 20) return false;
  return /^[A-Za-z$]/.test(trimmed) && /\s{2,}[NICR]\s+(?:N\s*=\s*\d+|-?\d|[A-Za-z])/.test(` ${trimmed}`);
}

function readArray(lines, located, field, maxValues) {
  const declared = located.count;
  if (declared > maxValues) {
    throw new FchkFormatError(
      `Field "${field.label}" declares ${declared} values; the limit is ${maxValues}. `
      + 'That ceiling bounds memory, not the format: the block is legitimate. Raise it with '
      + '`parseFchk(text, { maxValues })` when the host has the room, or convert the checkpoint '
      + 'with `formchk -matrix`, which keeps the same data in the binary matrix-element file.',
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

/** One character element, from the documented `5A12` layout. */
const CHARACTER_WIDTH = 12;
/** At most five 12-character elements are written per line. */
const CHARACTERS_PER_LINE = 5;

/**
 * Read a `C N= k` block.
 *
 * Unlike the integer and real arrays, this cannot tokenise: a title contains
 * spaces and a 12-character element may begin or end with one. Gaussian writes
 * five 12-character elements per line (`5A12` on gaussian.com/interfacing), and
 * the fixture's `Gaussian Version C N= 2` is 24 characters, not two 64-character
 * lines. The elements are sliced and concatenated, then the result is
 * right-trimmed: the padding is not part of the string, but a space between two
 * elements is. A zero-count block is an empty field, not a one-line value.
 */
function readCharBlock(lines, located, field, maxValues) {
  const declared = located.count;
  if (declared === 0) return '';
  if (declared > maxValues) {
    throw new FchkFormatError(
      `Field "${field.label}" declares ${declared} character elements; the limit is ${maxValues}. `,
    );
  }
  let collected = 0;
  let text = '';
  for (let index = located.start + 1; collected < declared && index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (looksLikeCharacterFieldHeader(line)) {
      throw new FchkFormatError(
        `Field "${field.label}" declares ${declared} character elements but stops after ${collected} at line ${index + 1}, where another field begins.`,
      );
    }
    const remaining = declared - collected;
    const onThisLine = Math.min(CHARACTERS_PER_LINE, remaining);
    // The documented field is 12 characters. A writer that uses a wider fixed
    // field (the older notes describe 64-character lines) still writes its
    // elements contiguously, so a line longer than `onThisLine * 12` is divided
    // evenly rather than truncated.
    const width = line.length > onThisLine * CHARACTER_WIDTH && line.length % onThisLine === 0
      ? line.length / onThisLine
      : CHARACTER_WIDTH;
    for (let offset = 0; offset < line.length && collected < declared; offset += width) {
      text += line.slice(offset, offset + width);
      collected += 1;
    }
  }
  if (collected < declared) {
    throw new FchkFormatError(
      `Field "${field.label}" declares ${declared} character elements but the file ends after ${collected}.`,
    );
  }
  return text.replace(/\s+$/, '');
}

/**
 * The largest count a field can legitimately declare, given the basis the file
 * itself states, or `null` when the field's length is not fixed by `NBasis`.
 *
 * This is the early half of the shape checks at the bottom of `parseFchk`: an
 * `N=` that no `NBasis`-function basis could produce is a disagreement between
 * the header and the block, and reporting it as such is more useful — and much
 * cheaper — than collecting millions of values and then discovering that the
 * block is not a matrix (#243). Gaussian writes `NBasis × NBsUse` MO
 * coefficients, which is at most `NBasis²` because `NBsUse ≤ NBasis`.
 */
function basisShapeLimit(field, parsed) {
  const nbf = parsed.numberOfBasisFunctions;
  if (!Number.isInteger(nbf) || nbf <= 0) return null;
  if (field.key === 'alphaMOCoefficients' || field.key === 'betaMOCoefficients') {
    const nbsUse = parsed.numberOfIndependentFunctions;
    // When the file states a usable NBsUse, the block is exactly
    // `NBasis × NBsUse`, which is tighter than the `NBasis²` ceiling (#246).
    if (Number.isInteger(nbsUse) && nbsUse >= 1 && nbsUse <= nbf) return nbf * nbsUse;
    return nbf * nbf;
  }
  if (field.triangular) return (nbf * (nbf + 1)) / 2;
  return null;
}

/**
 * Parse a formatted checkpoint.
 *
 * @param {string} text
 * @param {{ maxChars?: number, maxValues?: number }} [options] `maxChars` and
 *   `maxValues` let the guards be tested without a 160 MB fixture, and let an
 *   embedding with more memory raise the ceiling for a large basis. Callers
 *   should leave them alone unless they mean it.
 */
export function parseFchk(text, { maxChars = MAX_FCHK_CHARS, maxValues = MAX_FCHK_VALUES } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new FchkFormatError('The checkpoint file is empty.');
  }
  if (text.length > maxChars) {
    throw new FchkFormatError(
      `The checkpoint is ${text.length} characters; the limit is ${maxChars}. `
      + 'That ceiling bounds memory, not the format: a large basis is legitimate and this file may be valid. '
      + 'Raise the limit with `parseFchk(text, { maxChars })` when the host has the room, or convert the '
      + 'checkpoint with `formchk -matrix`, which keeps the same data in the binary matrix-element file.',
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
    if (field.kind === 'charArray') {
      if (located.count === undefined) {
        if (located.type !== 'C' || !located.value) {
          throw new FchkFormatError(`Line ${located.line}: field "${shown}" carries one value in this file, but the reader expects an array.`);
        }
        parsed[field.key] = String(located.value).trim();
        found.push(field.key);
        continue;
      }
      if (located.count === 0) {
        // A zero-count character block is how some writers spell an empty
        // string. It is not a value: report the field as absent rather than
        // storing `''`, and do not consume the next field as its data.
        missing.push(field.key);
        continue;
      }
      const value = readCharBlock(lines, located, { ...field, label: shown }, maxValues);
      if (value === '') {
        missing.push(field.key);
        continue;
      }
      parsed[field.key] = value;
      found.push(field.key);
      continue;
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
      // #243: fail on a declared count that the file's own NBasis cannot
      // produce before collecting the block. Checking after the read would
      // allocate millions of values for a shape that is already known to be
      // wrong.
      const shapeLimit = basisShapeLimit(field, parsed);
      if (shapeLimit !== null && located.count > shapeLimit) {
        const nbsUse = parsed.numberOfIndependentFunctions;
        const stated = Number.isInteger(parsed.numberOfBasisFunctions)
          && Number.isInteger(nbsUse) && nbsUse >= 1 && nbsUse <= parsed.numberOfBasisFunctions;
        const allowed = stated
          ? `${parsed.numberOfBasisFunctions} basis functions × ${nbsUse} independent functions = ${shapeLimit}`
          : `a ${parsed.numberOfBasisFunctions}-function basis allows at most ${shapeLimit}`;
        throw new FchkFormatError(
          `Field "${shown}" declares ${located.count} values, but ${allowed}. `
          + 'The declared count and the basis dimensions disagree, '
          + 'so the block is not a matrix over this basis.',
        );
      }
      parsed[field.key] = field.triangular
        ? Float64Array.from(readArray(lines, located, { ...field, label: shown }, maxValues))
        : readArray(lines, located, { ...field, label: shown }, maxValues);
    }
    found.push(field.key);
  }

  if (found.length === 0) {
    throw new FchkFormatError(
      'No checkpoint field was recognised, so this is not a formatted checkpoint '
      + '(a binary .chk has to be converted with `formchk -3` first: bare `formchk` writes only '
      + 'the backward-compatibility subset, and `-3` is the flag that emits the full v3 layout).',
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
  // #246: NBsUse is the number of linearly independent functions, and the MO
  // coefficient block is exactly `NBasis × NBsUse`. The old check only asked
  // whether the length was divisible by NBasis, so a block with one orbital
  // dropped still passed. Where the file states NBsUse, the exact product is
  // checked and the disagreement names both dimensions.
  const nbf = parsed.numberOfBasisFunctions;
  const nbsUse = parsed.numberOfIndependentFunctions;
  if (Number.isInteger(nbsUse)) {
    if (Number.isInteger(nbf) && nbf > 0 && (nbsUse < 1 || nbsUse > nbf)) {
      throw new FchkFormatError(
        `"Number of independent functions" is ${nbsUse}, but the file states ${nbf} basis functions; `
        + 'it must be between 1 and NBasis.',
      );
    }
    if (Number.isInteger(nbf) && nbf > 0) {
      const expected = nbf * nbsUse;
      for (const [key, label] of [
        ['alphaMOCoefficients', 'Alpha MO coefficients'],
        ['betaMOCoefficients', 'Beta MO coefficients'],
      ]) {
        const block = parsed[key];
        if (!Array.isArray(block)) continue;
        if (block.length !== expected) {
          throw new FchkFormatError(
            `"${label}" has ${block.length} values, but ${nbf} basis functions × ${nbsUse} independent `
            + `functions = ${expected}. The MO block is not NBasis × NBsUse over this basis.`,
          );
        }
      }
    }
  }
  if (Array.isArray(parsed.alphaMOCoefficients) && Number.isInteger(nbf)) {
    if (nbf > 0 && parsed.alphaMOCoefficients.length % nbf !== 0) {
      throw new FchkFormatError(
        `"Alpha MO coefficients" has ${parsed.alphaMOCoefficients.length} values, which is not a whole number of ${nbf}-function orbitals.`,
      );
    }
  }

  // #246: the spin case and the blocks must tell the same story. `IOpCl = 0`
  // with a beta manifold (MO coefficients or a spin density) is a closed-shell
  // label on an open-shell file; `IOpCl >= 1` with no beta MO block is the
  // reverse. -1 means unspecified, so no conclusion is drawn from it.
  const hasBetaMOs = Array.isArray(parsed.betaMOCoefficients) && parsed.betaMOCoefficients.length > 0;
  const hasSpinDensity = (Array.isArray(parsed.spinScfDensity) || parsed.spinScfDensity instanceof Float64Array)
    && parsed.spinScfDensity.length > 0;
  if (parsed.iopcl === 0) {
    const contradictory = [
      hasBetaMOs ? '"Beta MO coefficients"' : '',
      hasSpinDensity ? '"Spin SCF Density"' : '',
    ].filter(Boolean);
    if (contradictory.length > 0) {
      warnings.push(
        `IOpCl is 0 (closed shell), but the checkpoint carries ${contradictory.join(' and ')}. `
        + 'The spin label and the wavefunction blocks disagree.',
      );
    }
  } else if (Number.isInteger(parsed.iopcl) && parsed.iopcl >= 1 && !hasBetaMOs) {
    warnings.push(
      `IOpCl is ${parsed.iopcl} (open shell), but the checkpoint carries no "Beta MO coefficients". `
      + 'The beta manifold is missing or was not written.',
    );
  }

  // #244: completion evidence. 1 and 2 are the normal values; -1, 0 and 3 mean
  // the file cannot stand as a finished result. Absent stays absent: not every
  // writer emits `Job Status`, and inventing 0 would flag every one of them.
  if (parsed.jobStatus === 3) {
    warnings.push(
      'Job Status is 3 (error termination in Link 9999): this checkpoint records a failed job, '
      + 'so its density and orbitals are not a completed result.',
    );
  } else if (parsed.jobStatus === -1) {
    warnings.push('Job Status is -1 (in progress): this checkpoint was written before the job finished.');
  } else if (parsed.jobStatus === 0) {
    warnings.push(
      'Job Status is 0 (undefined or old checkpoint file): completion cannot be confirmed from this file.',
    );
  }

  // issue 164: a density matrix is a lower triangle, so its length is fixed by
  // the basis. A block shorter than that is the shape a truncated write leaves
  // behind, and reading it as "the density" would produce a potential from a
  // matrix with rows missing — so it is refused by the name the file uses.
  for (const key of ['totalScfDensity', 'totalScdDensity', 'spinScfDensity']) {
    const block = parsed[key];
    if (!block || !Number.isInteger(parsed.numberOfBasisFunctions)) continue;
    const nbf = parsed.numberOfBasisFunctions;
    const expected = (nbf * (nbf + 1)) / 2;
    if (block.length !== expected) {
      const label = key === 'totalScfDensity' ? 'Total SCF Density'
        : key === 'totalScdDensity' ? 'Total SCD Density' : 'Spin SCF Density';
      throw new FchkFormatError(
        `Field "${label}" holds ${block.length} values but a ${nbf}-function basis needs `
        + `${nbf}×(${nbf}+1)/2 = ${expected}; the triangular block is truncated or the wrong length, `
        + 'so it cannot be read as a density matrix.',
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
