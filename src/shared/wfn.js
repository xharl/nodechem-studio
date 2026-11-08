/**
 * WFN reader — the traditional AIM wavefunction file (Bader/AIMPAC lineage,
 * written by Gaussian's `output=wfn`, GAMESS, Q-Chem, ORCA, Molden2AIM and
 * others).
 *
 * The checkpoint reader (`fchk.js`) is the shape every wavefunction consumer
 * in this app already speaks. This module produces that shape from a `.wfn`
 * file, so the orbital-gap, spin and basis code needs no WFN branch.
 *
 * ## What the header can say, and how it is decided
 *
 * A WFN file opens with a variable-length title block, then one count line:
 *
 *     GAUSSIAN   <nmo> MOL ORBITALS <nprim> PRIMITIVES <nnuc> NUCLEI
 *
 * The label is not always `GAUSSIAN` (GAMESS, MOLPRO, ADF and TONTO files carry
 * their own), and the title block is not always one line — real archived files
 * begin with a mail header several dozen lines long. The reader therefore
 * **finds the count line** rather than assuming line 2, and records the label
 * and the number of title lines it skipped.
 *
 * Two header forms are accepted, and the form is decided from the header's own
 * contents, never by trying one parse and falling back to another:
 *
 * - **3-line header**: title, count line, then the first nucleus row. There is
 *   no electrostatic-potential data.
 * - **5-line header**: title, count line, a `MEP` row and its values, then the
 *   first nucleus row. The `MEP` block is the molecular electrostatic
 *   potential at the nuclei, in hartree/e; it is carried in `mep.values` and
 *   **nothing is derived from it**. A file without it is read normally and
 *   says MEP is absent.
 *
 * ## The two basis tables, and why only one of them can be reordered safely
 *
 * - **Gaussian ordering** (`basisOrdering: 'gaussian'`): `CENTRE ASSIGNMENTS`,
 *   `TYPE ASSIGNMENTS` and `EXPONENTS`, one entry per **primitive function**
 *   (each Cartesian component of each primitive). Type codes 1-56 are the AIM
 *   order, which is the Cartesian order this app uses. The table is
 *   decontracted into one shell per primitive (see `aimBasis.js`), and the MO
 *   coefficients are permuted from component-major to shell-major order.
 * - **Labelled ordering** (`basisOrdering: 'non-gaussian'`): a shell table of
 *   the older form, `'<label>' <centre>` followed by `exponent coefficient`
 *   rows. For `s`, `p` and `sp` the component order is unambiguous and the
 *   shells are mapped onto the checkpoint order. A `d`, `f` or higher shell is
 *   **refused**: a one-letter label does not state the component order, and
 *   guessing it would attach coefficients to the wrong function.
 *
 * ## Honesty rules
 *
 * - A missing field is **absent** and named in `missing`; it is never zero.
 * - No gradient, Hessian or other derivative is invented: WFN does not carry
 *   one.
 * - Occupations are carried as written. Natural-orbital occupations such as
 *   1.63 are not rounded; only the derived electron counts, which are integers
 *   by definition, are rounded and only when the file's data supports them.
 * - A count that disagrees with the data is an error naming **both** numbers,
 *   because reading past it would attach a coefficient to the wrong function.
 *
 * Coordinates are bohr and are converted to Å once, for `atoms`; the bohr
 * values stay in `coordinatesBohr`.
 */

import { ELEMENTS } from './elements.js';
import {
  AIM_SPHERICAL,
  LABELLED_SHELLS,
  angstromOf,
  groupAimPrimitives,
} from './aimBasis.js';

/** Characters, not bytes: the guard bounds work on text that is already decoded. */
export const MAX_WFN_CHARS = 64 * 1024 * 1024;

export class WfnFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WfnFormatError';
  }
}

const SYMBOL_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
/** A float inside a fixed-width line; adjacent values may touch (`1.0-2.0`). */
const EMBEDDED_NUMBER = /[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eEdD][-+]?\d+)?/g;

const COUNTS_LINE = /^\s*([A-Za-z][A-Za-z0-9_.+-]*)\s+(\d+)\s+MOL\s+ORBITALS\s+(\d+)\s+PRIMITIVES\s+(\d+)\s+NUCLEI\s*(.*)$/i;
const NUCLEUS_LINE = /^\s*(\S+)\s+(\d+)\s+\(\s*CENTRE\s+(\d+)\s*\)\s*(.*?)\s*CHARGE\s*=\s*([+-]?\d+(?:\.\d*)?)\s*$/i;
const MO_LINE = /^\s*MO\s+(\d+)\s+(?:MO\s+\S+\s+)?OCC\s*NO\s*=\s*(\S+)\s+ORB\.\s*ENERGY\s*=\s*(\S+)/i;
const OLD_MO_LINE = /^\s*'?MO'?\s+(\d+)\s+(\S+)\s+(\S+)\s*$/i;

function tokensOf(line) {
  return String(line ?? '').trim().split(/\s+/).filter(Boolean);
}

function numberToken(raw, where) {
  const text = String(raw ?? '');
  if (!NUMBER.test(text)) {
    throw new WfnFormatError(`${where} has the non-numeric token "${text}".`);
  }
  const value = Number(text.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) {
    throw new WfnFormatError(`${where} has "${text}", which is outside the range of a double.`);
  }
  return value;
}

function integerToken(raw, where) {
  const value = numberToken(raw, where);
  if (!Number.isInteger(value)) {
    throw new WfnFormatError(`${where} expects an integer, found "${String(raw)}".`);
  }
  return value;
}

function numbersIn(text, where, expected) {
  const found = String(text).match(EMBEDDED_NUMBER) || [];
  const values = found.map((token) => numberToken(token, where));
  if (expected !== undefined && values.length !== expected) {
    throw new WfnFormatError(`${where} has ${values.length} numeric field${values.length === 1 ? '' : 's'}; expected ${expected}.`);
  }
  return values;
}

/** Element from a WFN label such as `O`, `Cl` or TONTO's `O1`. */
function elementOfLabel(label) {
  const text = String(label ?? '').replace(/[^A-Za-z]/g, '');
  if (!text) return { symbol: null, atomicNumber: 0 };
  if (/^Bq/i.test(text)) return { symbol: 'Bq', atomicNumber: 0 };
  const two = text.slice(0, 2);
  if (two.length === 2 && ELEMENTS.has(two)) return { symbol: two, atomicNumber: ELEMENTS.get(two) };
  const one = text.slice(0, 1).toUpperCase();
  if (ELEMENTS.has(one)) return { symbol: one, atomicNumber: ELEMENTS.get(one) };
  return { symbol: text.slice(0, 2), atomicNumber: 0 };
}

function findCounts(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = COUNTS_LINE.exec(lines[index]);
    if (match) {
      return {
        index,
        program: match[1],
        nmo: Number(match[2]),
        nprim: Number(match[3]),
        nnuc: Number(match[4]),
        trailing: match[5].trim(),
      };
    }
  }
  return null;
}

function readMep(lines, start, nnuc) {
  const tokens = tokensOf(lines[start]).slice(1);
  const values = [];
  let declared = null;
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    declared = Number(tokens[0]);
  } else {
    for (const token of tokens) values.push(numberToken(token, `MEP table line ${start + 1}`));
  }
  let index = start + 1;
  while (values.length < nnuc && index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (NUCLEUS_LINE.test(line) || /^\s*(CENTRE|TYPE)\s+ASSIGNMENTS/i.test(line)) break;
    for (const token of tokensOf(line)) {
      if (!NUMBER.test(token)) {
        throw new WfnFormatError(
          `MEP table line ${index + 1} has the non-numeric token "${token}"; the block must hold ${nnuc} numeric values.`,
        );
      }
      values.push(numberToken(token, `MEP table line ${index + 1}`));
    }
    index += 1;
  }
  if (declared !== null && declared !== nnuc) {
    throw new WfnFormatError(
      `The MEP block declares ${declared} value${declared === 1 ? '' : 's'} but the count line says ${nnuc} nuclei.`,
    );
  }
  if (values.length < nnuc) {
    throw new WfnFormatError(
      `The MEP block carries ${values.length} value${values.length === 1 ? '' : 's'} for ${nnuc} nuclei; a partial MEP table is refused.`,
    );
  }
  if (values.length > nnuc) {
    throw new WfnFormatError(
      `The MEP block carries ${values.length} values for ${nnuc} nuclei; the extra values mean the block and the nucleus table disagree.`,
    );
  }
  return { values, next: index };
}

function readNuclei(lines, start, nnuc, warnings) {
  const atoms = [];
  const atomicNumbers = [];
  const coordinatesBohr = [];
  const nuclearCharges = [];
  const names = [];
  let index = start;
  while (atoms.length < nnuc) {
    if (index >= lines.length) {
      throw new WfnFormatError(
        `The nucleus table ends after ${atoms.length} row${atoms.length === 1 ? '' : 's'} but the count line says ${nnuc} nuclei.`,
      );
    }
    const raw = lines[index];
    if (!raw.trim()) { index += 1; continue; }
    const match = NUCLEUS_LINE.exec(raw);
    if (!match) {
      if (/^(CENTRE\s+ASSIGNMENTS|TYPE\s+ASSIGNMENTS|EXPONENTS)\b/i.test(raw.trim())
        || LABELLED_ROW.test(raw.trim()) || /^END\s+DATA\b/i.test(raw.trim())
        || MO_LINE.test(raw.trim()) || OLD_MO_LINE.test(raw.trim())) {
        throw new WfnFormatError(
          `The nucleus table ends after ${atoms.length} row${atoms.length === 1 ? '' : 's'} `
          + `but the count line says ${nnuc} nuclei.`,
        );
      }
      throw new WfnFormatError(
        `Nucleus row ${atoms.length + 1} (line ${index + 1}) is not of the form `
        + `"<label> <index> (CENTRE <n>) <x> <y> <z> CHARGE = <z>"; found "${raw.trim()}".`,
      );
    }
    const label = match[1];
    const row = integerToken(match[2], `nucleus row ${atoms.length + 1}`);
    const centre = integerToken(match[3], `nucleus row ${atoms.length + 1}`);
    const expected = atoms.length + 1;
    if (row !== expected || centre !== expected) {
      throw new WfnFormatError(
        `Nucleus row ${index + 1} is labelled ${row} with centre ${centre}; row ${expected} was expected. `
        + 'Rows out of order would put the coordinates on the wrong atom.',
      );
    }
    const xyz = numbersIn(match[4], `nucleus row ${atoms.length + 1} (line ${index + 1})`, 3);
    const charge = numberToken(match[5], `nucleus row ${atoms.length + 1}`);
    const { symbol, atomicNumber } = elementOfLabel(label);
    if (atomicNumber === 0 && symbol !== 'Bq') {
      warnings.push(`Nucleus ${expected} is labelled "${label}", which is not an element symbol this build knows; atomic number 0 was used.`);
    }
    names.push(String(label).trim());
    atomicNumbers.push(atomicNumber);
    nuclearCharges.push(charge);
    coordinatesBohr.push(...xyz);
    atoms.push({
      atomicNumber,
      element: atomicNumber === 0 ? null : SYMBOL_BY_NUMBER.get(atomicNumber) ?? symbol,
      x: angstromOf(xyz[0]),
      y: angstromOf(xyz[1]),
      z: angstromOf(xyz[2]),
    });
    index += 1;
  }
  return { atoms, atomicNumbers, coordinatesBohr, nuclearCharges, names, next: index };
}

/**
 * Read `CENTRE ASSIGNMENTS` / `TYPE ASSIGNMENTS` / `EXPONENTS`. Each label is
 * followed by one integer or real per primitive function, wrapped at 20 / 5
 * values per line; the reader counts values, not lines.
 */
function readAssignmentTable(lines, start, nprim) {
  const tables = [];
  let index = start;
  for (const label of ['CENTRE ASSIGNMENTS', 'TYPE ASSIGNMENTS', 'EXPONENTS']) {
    const values = [];
    let current = null;
    while (values.length < nprim) {
      if (index >= lines.length) {
        throw new WfnFormatError(
          `The ${label} table ends after ${values.length} of ${nprim} values.`,
        );
      }
      const raw = lines[index];
      const trimmed = raw.trim();
      const labelMatch = /^(CENTRE\s+ASSIGNMENTS|TYPE\s+ASSIGNMENTS|EXPONENTS)\b/i.exec(trimmed);
      if (labelMatch) {
        const foundLabel = labelMatch[1].toUpperCase().replace(/\s+/g, ' ');
        if (foundLabel !== label) {
          throw new WfnFormatError(
            `The ${label} table ends after ${values.length} of ${nprim} values, where "${trimmed.slice(0, 40)}" begins another table.`,
          );
        }
        current = true;
        for (const token of tokensOf(trimmed.slice(labelMatch[0].length))) {
          if (values.length >= nprim) {
            throw new WfnFormatError(
              `The ${label} table declares ${nprim} values but continues with "${token}" on line ${index + 1}.`,
            );
          }
          values.push(numberToken(token, `${label} line ${index + 1}`));
        }
      } else if (trimmed) {
        if (!current) {
          throw new WfnFormatError(`The ${label} table does not start with its own label (line ${index + 1}).`);
        }
        for (const token of tokensOf(trimmed)) {
          if (values.length >= nprim) {
            throw new WfnFormatError(
              `The ${label} table declares ${nprim} values but continues with "${token}" on line ${index + 1}.`,
            );
          }
          values.push(numberToken(token, `${label} line ${index + 1}`));
        }
      }
      index += 1;
    }
    tables.push(values);
  }
  const [centres, types, exponents] = tables;
  for (let position = 0; position < nprim; position += 1) {
    if (!Number.isInteger(centres[position]) || centres[position] < 1) {
      throw new WfnFormatError(
        `CENTRE ASSIGNMENTS value ${position + 1} is ${centres[position]}; centres are 1-based integers.`,
      );
    }
    if (!Number.isInteger(types[position])) {
      throw new WfnFormatError(`TYPE ASSIGNMENTS value ${position + 1} is ${types[position]}; type codes are integers.`);
    }
  }
  return { centres, types, exponents, next: index };
}

const LABELLED_ROW = /^\s*'?([A-Za-z0-9]+)'?\s+(\d+)\s+'?([A-Za-z]{1,2})'?\s*$/;

/**
 * Read the labelled shell table of the older ordering: a row naming a shell,
 * then its `exponent [coefficient]` rows. `d` and above are refused by name.
 */
function readLabelledShells(lines, start, atomCount, declaredPrimitives, warnings) {
  const shells = [];
  const primitiveRows = [];
  let index = start;
  let current = null;
  while (index < lines.length) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed) { index += 1; continue; }
    if (/^END\s+DATA\b/i.test(trimmed) || MO_LINE.test(trimmed) || OLD_MO_LINE.test(trimmed)) break;
    const header = LABELLED_ROW.exec(trimmed);
    if (header) {
      const label = header[3].toLowerCase();
      if (!LABELLED_SHELLS[label]) {
        throw new WfnFormatError(
          `The shell table lists a "${header[3]}" shell on atom ${header[2]} (line ${index + 1}); `
          + 'this reader can map s, p and sp shells onto the checkpoint order. '
          + 'A d or higher one-letter label does not state its component order, so it is refused rather than guessed.',
        );
      }
      const atom = integerToken(header[2], `shell table line ${index + 1}`);
      if (atom < 1 || atom > atomCount) {
        throw new WfnFormatError(
          `The shell table points at atom ${atom} (line ${index + 1}); the file has ${atomCount} nuclei.`,
        );
      }
      current = { atom, label, line: index + 1, primitives: [] };
      shells.push(current);
      index += 1;
      continue;
    }
    if (!current) {
      throw new WfnFormatError(`Shell table line ${index + 1} is a primitive before any shell row.`);
    }
    const tokens = tokensOf(trimmed);
    const expected = LABELLED_SHELLS[current.label].coefficients + 1;
    if (tokens.length !== expected) {
      throw new WfnFormatError(
        `Shell table line ${index + 1}: the ${current.label} shell on atom ${current.atom} needs `
        + `${expected - 1} coefficient${expected === 2 ? '' : 's'} per primitive, found ${tokens.length - 1}.`,
      );
    }
    current.primitives.push({
      exponent: numberToken(tokens[0], `shell table line ${index + 1}`),
      coefficients: tokens.slice(1).map((token) => numberToken(token, `shell table line ${index + 1}`)),
    });
    primitiveRows.push(index);
    index += 1;
  }
  if (shells.length === 0) {
    throw new WfnFormatError('The labelled shell table has no shells.');
  }
  for (const shell of shells) {
    if (shell.primitives.length === 0) {
      throw new WfnFormatError(`The ${shell.label} shell on atom ${shell.atom} (line ${shell.line}) has no primitives.`);
    }
  }
  const primitiveCount = primitiveRows.length;
  if (declaredPrimitives !== primitiveCount && declaredPrimitives !== shells.reduce(
    (sum, shell) => sum + shell.primitives.length * LABELLED_SHELLS[shell.label].functions,
    0,
  )) {
    warnings.push(
      `The count line says ${declaredPrimitives} primitives; the labelled shell table has ${primitiveCount} primitive rows. `
      + 'The table is authoritative for the basis.',
    );
  }
  return { shells, primitiveCount, next: index };
}

function labelledBasis(shells) {
  const shellTypes = [];
  const primitivesPerShell = [];
  const shellToAtomMap = [];
  const primitiveExponents = [];
  const contractionCoefficients = [];
  const spContractionCoefficients = [];
  const hasSp = shells.some((shell) => shell.label === 'sp');
  let numberOfBasisFunctions = 0;
  for (const shell of shells) {
    const info = LABELLED_SHELLS[shell.label];
    shellTypes.push(info.type);
    primitivesPerShell.push(shell.primitives.length);
    shellToAtomMap.push(shell.atom);
    numberOfBasisFunctions += info.functions;
    for (const primitive of shell.primitives) {
      primitiveExponents.push(primitive.exponent);
      contractionCoefficients.push(primitive.coefficients[0]);
      if (hasSp) spContractionCoefficients.push(shell.label === 'sp' ? primitive.coefficients[1] : 0);
    }
  }
  return {
    shells: shells.map((shell) => ({
      atom: shell.atom,
      type: LABELLED_SHELLS[shell.label].type,
      label: shell.label,
      primitives: shell.primitives.map((primitive) => ({
        exponent: primitive.exponent,
        s: primitive.coefficients[0],
        ...(shell.label === 'sp' ? { p: primitive.coefficients[1] } : {}),
      })),
    })),
    shellTypes,
    primitivesPerShell,
    shellToAtomMap,
    primitiveExponents,
    contractionCoefficients,
    spContractionCoefficients: hasSp ? spContractionCoefficients : undefined,
    numberOfBasisFunctions,
    permutation: null,
  };
}

/** Electron counts from occupations and optional spin codes. */
function electronCountsOf(orbitals, warnings) {
  const alpha = orbitals.filter((orbital) => orbital.spin === 'Alpha' || orbital.spin === 'Alpha and Beta');
  const beta = orbitals.filter((orbital) => orbital.spin === 'Beta');
  const sum = (list) => list.reduce((total, orbital) => total + orbital.occupation, 0);
  const whole = (value) => Math.abs(value - Math.round(value)) < 1e-6;
  const spinKnown = orbitals.some((orbital) => orbital.spin);

  if (spinKnown) {
    const alphaElectrons = Math.round(sum(alpha));
    const betaElectrons = Math.round(sum(beta));
    const exact = whole(sum(alpha)) && whole(sum(beta));
    if (!exact) {
      warnings.push(
        `The MO occupations sum to ${sum(alpha).toFixed(4)} alpha and ${sum(beta).toFixed(4)} beta electrons; `
        + 'the integer counts were rounded for the gap and spin views, and the occupations themselves are unchanged.',
      );
    }
    return {
      alphaElectrons,
      betaElectrons,
      electrons: alphaElectrons + betaElectrons,
    };
  }

  const allZeroOrTwo = orbitals.every((orbital) => Math.abs(orbital.occupation) < 1e-6 || Math.abs(orbital.occupation - 2) < 1e-6);
  const allZeroOrOne = orbitals.every((orbital) => Math.abs(orbital.occupation) < 1e-6 || Math.abs(orbital.occupation - 1) < 1e-6);
  const total = sum(orbitals);
  if (allZeroOrTwo) {
    const occupied = orbitals.filter((orbital) => orbital.occupation > 1).length;
    return { alphaElectrons: occupied, betaElectrons: occupied, electrons: 2 * occupied };
  }
  if (allZeroOrOne) {
    warnings.push(
      'The MO occupations are all 0 or 1 but the file states no spin; each orbital holds at most one electron, '
      + 'so the total is reported and the alpha/beta split is left absent rather than assigned by convention.',
    );
    return { alphaElectrons: null, betaElectrons: null, electrons: Math.round(total) };
  }
  if (whole(total)) {
    warnings.push(
      'The MO occupations are neither all 0/2 nor all 0/1, and the file states no spin; '
      + 'only the total electron count is reported, because the alpha/beta split cannot be derived from occupations alone.',
    );
    return { alphaElectrons: null, betaElectrons: null, electrons: Math.round(total) };
  }
  warnings.push(
    `The MO occupations sum to ${total.toFixed(4)} electrons, which is not an integer; `
    + 'the occupations are carried as fractions and no electron count is reported.',
  );
  return { alphaElectrons: null, betaElectrons: null, electrons: null };
}

function parseMoBlocks(lines, start, nprim, warnings) {
  const orbitals = [];
  let current = null;
  let index = start;

  const finalize = () => {
    if (!current) return;
    if (current.coefficients.length !== nprim) {
      throw new WfnFormatError(
        `MO ${current.number} has ${current.coefficients.length} coefficient${current.coefficients.length === 1 ? '' : 's'} `
        + `but the basis has ${nprim} primitive function${nprim === 1 ? '' : 's'}; the coefficient block is truncated or overlong.`,
      );
    }
  };

  while (index < lines.length) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed) { index += 1; continue; }
    if (/^END\s+DATA\b/i.test(trimmed)) break;

    const header = MO_LINE.exec(trimmed) || OLD_MO_LINE.exec(trimmed);
    if (header && (MO_LINE.test(trimmed) || /^\s*'?MO'?\b/i.test(trimmed))) {
      finalize();
      const number = integerToken(header[1], `MO header line ${index + 1}`);
      if (number !== orbitals.length + 1) {
        throw new WfnFormatError(
          `MO ${number} follows MO ${orbitals.length}; orbitals must be numbered 1..N in order.`,
        );
      }
      current = {
        number,
        occupation: numberToken(header[2], `MO ${number} header`),
        energy: numberToken(header[3], `MO ${number} header`),
        spin: null,
        coefficients: [],
        line: index + 1,
      };
      orbitals.push(current);
      index += 1;
      continue;
    }

    if (!current) {
      throw new WfnFormatError(`Line ${index + 1} is a coefficient before any MO header: "${trimmed.slice(0, 60)}".`);
    }
    for (const token of tokensOf(trimmed)) {
      current.coefficients.push(numberToken(token, `MO ${current.number} coefficients (line ${index + 1})`));
    }
    index += 1;
  }
  finalize();
  if (orbitals.length === 0) {
    throw new WfnFormatError('The file has no MO blocks; a wavefunction needs at least one orbital.');
  }
  return { orbitals, endIndex: index };
}

function readEndData(lines, start, warnings) {
  const result = { totalEnergyHartree: undefined, virialRatio: undefined };
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/END\s+DATA/i.test(line)) continue;
    const energy = /ENERGY\s*=\s*([-+0-9.eEdD]+)/i.exec(line);
    if (energy && result.totalEnergyHartree === undefined) {
      result.totalEnergyHartree = numberToken(energy[1], `energy line ${index + 1}`);
      const virial = /VIRIAL\s*\(\s*-?\s*V\s*\/\s*T\s*\)\s*=\s*([-+0-9.eEdD]+)/i.exec(line);
      if (virial) result.virialRatio = numberToken(virial[1], `energy line ${index + 1}`);
      continue;
    }
    if (/\$MOSPIN/i.test(line)) break;
  }
  if (result.totalEnergyHartree === undefined) {
    warnings.push('The file has no "END DATA" energy line, so the total energy is absent.');
  }
  return result;
}

function readMoSpin(lines, start, count) {
  let index = start;
  while (index < lines.length && !/\$MOSPIN/i.test(lines[index])) index += 1;
  if (index >= lines.length) return null;
  const codes = [];
  index += 1;
  while (index < lines.length && codes.length < count) {
    const trimmed = lines[index].trim();
    if (!trimmed) { index += 1; continue; }
    for (const token of tokensOf(trimmed)) {
      if (!/^\d+$/.test(token)) {
        throw new WfnFormatError(`The $MOSPIN block has the non-integer token "${token}" (line ${index + 1}).`);
      }
      const code = Number(token);
      if (code !== 1 && code !== 2 && code !== 3) {
        throw new WfnFormatError(
          `The $MOSPIN block uses code ${code} on line ${index + 1}; Multiwfn defines 1 (alpha), 2 (beta) and 3 (alpha and beta).`,
        );
      }
      codes.push(code);
    }
    index += 1;
  }
  if (codes.length !== count) {
    throw new WfnFormatError(
      `The $MOSPIN block lists ${codes.length} spin code${codes.length === 1 ? '' : 's'} for ${count} orbitals.`,
    );
  }
  return codes;
}

/**
 * Parse a WFN file.
 *
 * @param {string} text
 * @param {{ maxChars?: number }} [options] `maxChars` lets the bound be tested
 *   without a 64 MB fixture; callers should leave it alone.
 */
export function parseWfn(text, { maxChars = MAX_WFN_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new WfnFormatError('The WFN file is empty.');
  }
  if (text.length > maxChars) {
    throw new WfnFormatError(
      `The WFN file is ${text.length} characters; the limit is ${maxChars}. `
      + 'This reader needs the atoms, basis and MO blocks, so trim the file or export it from a smaller job.',
    );
  }

  const lines = text.split(/\r\n|\n|\r/);
  const warnings = [];
  const found = [];
  const missing = [];

  const counts = findCounts(lines);
  if (!counts) {
    throw new WfnFormatError(
      'No WFN count line was found. A WFN file has a line of the form '
      + '"GAUSSIAN <nmo> MOL ORBITALS <nprim> PRIMITIVES <nnuc> NUCLEI" (the label may be another program name).',
    );
  }
  const { nmo, nprim, nnuc } = counts;
  if (nnuc < 1) throw new WfnFormatError(`The count line says ${nnuc} nuclei; a wavefunction needs at least one.`);
  if (nmo < 1) throw new WfnFormatError(`The count line says ${nmo} molecular orbitals; a wavefunction needs at least one.`);
  if (nprim < 1) throw new WfnFormatError(`The count line says ${nprim} primitives; a wavefunction needs at least one.`);

  const title = lines.slice(0, counts.index)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 500);

  let index = counts.index + 1;
  while (index < lines.length && !lines[index].trim()) index += 1;

  let headerForm = '3-line';
  let mep = {
    present: false,
    reason: 'the header has no MEP block, so the file carries no electrostatic-potential data',
  };
  if (/^\s*MEP\b/i.test(lines[index] ?? '')) {
    const block = readMep(lines, index, nnuc);
    mep = {
      present: true,
      values: block.values,
      unit: 'hartree/e',
      meaning: 'molecular electrostatic potential at each nucleus, as written in the file',
    };
    headerForm = '5-line';
    index = block.next;
  } else {
    warnings.push('The WFN header has no MEP block; the file is read without electrostatic-potential data (none is invented).');
  }
  while (index < lines.length && !lines[index].trim()) index += 1;

  const nucleusData = readNuclei(lines, index, nnuc, warnings);
  index = nucleusData.next;
  while (index < lines.length && !lines[index].trim()) index += 1;

  let basis;
  let basisOrdering;
  const nextLine = (lines[index] ?? '').trim();
  if (/^CENTRE\s+ASSIGNMENTS\b/i.test(nextLine)) {
    basisOrdering = 'gaussian';
    const table = readAssignmentTable(lines, index, nprim);
    index = table.next;
    const grouped = groupAimPrimitives({
      centres: table.centres,
      types: table.types,
      exponents: table.exponents,
      where: 'the CENTRE/TYPE/EXPONENTS table',
      atomCount: nnuc,
    });
    basis = grouped;
  } else if (LABELLED_ROW.test(nextLine)) {
    basisOrdering = 'non-gaussian';
    const table = readLabelledShells(lines, index, nnuc, nprim, warnings);
    index = table.next;
    basis = labelledBasis(table.shells);
  } else {
    throw new WfnFormatError(
      'The basis table was not recognised: expected "CENTRE ASSIGNMENTS" (Gaussian ordering) '
      + 'or a labelled shell row such as "1  1  \'S\'" (older ordering). '
      + `The line found is "${nextLine.slice(0, 60)}".`,
    );
  }

  const moData = parseMoBlocks(lines, index, basis.numberOfBasisFunctions, warnings);
  index = moData.endIndex;

  const endData = readEndData(lines, index, warnings);
  const spinCodes = readMoSpin(lines, index, nmo);
  if (spinCodes) {
    for (let position = 0; position < moData.orbitals.length; position += 1) {
      if (position >= spinCodes.length) break;
      moData.orbitals[position].spin = spinCodes[position] === 1
        ? 'Alpha' : spinCodes[position] === 2 ? 'Beta' : 'Alpha and Beta';
    }
  } else if (moData.orbitals.length > 0) {
    warnings.push('The file has no $MOSPIN block, so no orbital carries a spin label; the electron counts are derived from the occupations.');
  }

  // Apply the decontraction permutation to every coefficient run. For the
  // labelled ordering `permutation` is null and the run is already in shell
  // order (s/p only, where that order is the checkpoint order).
  if (basis.permutation) {
    for (const orbital of moData.orbitals) {
      orbital.coefficients = orbital.coefficients.map((_, position) => orbital.coefficients[basis.permutation[position]]);
    }
  }

  const orbitals = moData.orbitals;
  const countsOf = electronCountsOf(orbitals, warnings);

  const parsed = {
    format: 'wfn',
    title,
    found,
    missing,
    warnings,
    units: { coordinates: 'angstrom', source: 'bohr' },
    spherical: AIM_SPHERICAL,
    header: {
      form: headerForm,
      program: counts.program,
      countsLine: counts.index + 1,
      titleLines: counts.index,
      basisOrdering,
      ...(counts.trailing ? { note: counts.trailing } : {}),
    },
    basisOrdering,
    mep,
    numberOfAtoms: nucleusData.atoms.length,
    atoms: nucleusData.atoms,
    atomicNumbers: nucleusData.atomicNumbers,
    nuclearNames: nucleusData.names,
    nuclearCharges: nucleusData.nuclearCharges,
    coordinatesBohr: nucleusData.coordinatesBohr,
    numberOfPrimitives: nprim,
    numberOfBasisFunctions: basis.numberOfBasisFunctions,
    shellTypes: basis.shellTypes,
    primitivesPerShell: basis.primitivesPerShell,
    shellToAtomMap: basis.shellToAtomMap,
    primitiveExponents: basis.primitiveExponents,
    contractionCoefficients: basis.contractionCoefficients,
    shells: basis.shells,
    orbitals,
    occupations: orbitals.map((orbital) => orbital.occupation),
    orbitalEnergies: orbitals.filter((orbital) => orbital.spin !== 'Beta').map((orbital) => orbital.energy),
    numberOfMolecularOrbitals: nmo,
  };
  if (basis.spContractionCoefficients) parsed.spContractionCoefficients = basis.spContractionCoefficients;

  found.push(
    'numberOfAtoms', 'atoms', 'atomicNumbers', 'coordinatesBohr',
    'numberOfPrimitives', 'numberOfBasisFunctions', 'shellTypes', 'primitivesPerShell',
    'shellToAtomMap', 'primitiveExponents', 'contractionCoefficients',
    'orbitals', 'occupations', 'orbitalEnergies',
  );
  if (basis.spContractionCoefficients) found.push('spContractionCoefficients');
  else missing.push('spContractionCoefficients');

  const alphaOrbitals = orbitals.filter((orbital) => orbital.spin !== 'Beta');
  const betaOrbitals = orbitals.filter((orbital) => orbital.spin === 'Beta');
  if (alphaOrbitals.length && betaOrbitals.length) {
    parsed.alphaMOCoefficients = alphaOrbitals.flatMap((orbital) => orbital.coefficients);
    parsed.betaMOCoefficients = betaOrbitals.flatMap((orbital) => orbital.coefficients);
    parsed.orbitalEnergiesBeta = betaOrbitals.map((orbital) => orbital.energy);
    found.push('alphaMOCoefficients', 'betaMOCoefficients', 'orbitalEnergiesBeta');
  } else {
    parsed.alphaMOCoefficients = orbitals.flatMap((orbital) => orbital.coefficients);
    found.push('alphaMOCoefficients');
    missing.push('betaMOCoefficients', 'orbitalEnergiesBeta');
  }

  if (countsOf.alphaElectrons !== null) {
    parsed.numberOfAlphaElectrons = countsOf.alphaElectrons;
    found.push('numberOfAlphaElectrons');
  } else missing.push('numberOfAlphaElectrons');
  if (countsOf.betaElectrons !== null) {
    parsed.numberOfBetaElectrons = countsOf.betaElectrons;
    found.push('numberOfBetaElectrons');
  } else missing.push('numberOfBetaElectrons');
  if (countsOf.electrons !== null) {
    parsed.numberOfElectrons = countsOf.electrons;
    found.push('numberOfElectrons');
  } else missing.push('numberOfElectrons');

  if (endData.totalEnergyHartree !== undefined) {
    parsed.totalEnergyHartree = endData.totalEnergyHartree;
    found.push('totalEnergyHartree');
  } else missing.push('totalEnergyHartree');
  if (endData.virialRatio !== undefined) {
    parsed.virialRatio = endData.virialRatio;
    found.push('virialRatio');
  } else missing.push('virialRatio');

  // Fields no WFN carries. Named so a caller can tell "absent" from "zero".
  missing.push('charge', 'multiplicity', 'mullikenCharges', 'espCharges');

  if (orbitals.length !== nmo) {
    throw new WfnFormatError(
      `The count line says ${nmo} molecular orbitals but the file has ${orbitals.length} MO blocks.`,
    );
  }

  return parsed;
}

