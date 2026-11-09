/**
 * Readers for the three export-only decks: NWChem `.nw`, GAMESS `.inp` and
 * Q-Chem `.qcin`.
 *
 * They exist so an exported deck can be **read back** by the app: the exporters
 * in this directory claim to write a Cartesian geometry, a charge and a
 * multiplicity, and a round-trip test that only re-parsed the writer's own
 * intermediate object would prove nothing. These readers take the file text
 * (the same text a user gets from `ncs export-input`) and produce the record
 * `structureImport.js` already knows how to validate.
 *
 * Each reader reads exactly the section it needs and refuses what it cannot
 * represent:
 *
 * - NWChem: `geometry [units …] … end` with three-number atom lines, top-level
 *   `charge`, and `mult` from the `dft`/`scf` block. A Z-matrix line has fewer
 *   than three numbers and is refused rather than mis-read.
 * - GAMESS: `$DATA` (title, symmetry, `label ZNUC x y z`), `UNITS` and
 *   `ICHARG`/`MULT` from `$CONTRL`. A point group other than C1 means the deck
 *   lists symmetry-unique atoms only, so importing it would drop atoms.
 * - Q-Chem: `$molecule` (`charge multiplicity` then Cartesian atoms).
 *
 * Bohr coordinates are converted with the CODATA 2018 value, and the conversion
 * is reported as a warning: the numbers in the file are not the numbers the app
 * shows.
 */

const BOHR_TO_ANGSTROM = 0.529177210903;

export class DeckImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeckImportError';
  }
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][-+]?\d+)?`;

function numbers(tokens) {
  return tokens.map((token) => Number(String(token).replace(/[Dd]/, 'E')));
}

function isElementLike(value) {
  return /^[A-Z][a-z]?$/.test(String(value || ''));
}

function unitFactor(units) {
  const normalised = String(units || 'angstroms').trim().toLowerCase();
  if (['angstrom', 'angstroms', 'angs', 'ang', 'a'].includes(normalised)) return { factor: 1, bohr: false };
  if (['au', 'bohr', 'bohrs', 'atomic'].includes(normalised)) return { factor: BOHR_TO_ANGSTROM, bohr: true };
  throw new DeckImportError(
    `The geometry is in "${units}", which this reader does not convert. Ångström or Bohr are the units it knows.`,
  );
}

/* ── NWChem ───────────────────────────────────────────────── */

export function parseNwchemInput(text) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const titleMatch = text.match(/^\s*title\s+"?([^"\n]*)"?\s*$/m);
  const chargeMatch = text.match(/^\s*charge\s+(-?\d+)\s*$/m);
  const multMatch = text.match(/^\s*mult\s+(\d+)\s*$/m);

  const start = lines.findIndex((line) => /^\s*geometry\b/i.test(line));
  if (start < 0) throw new DeckImportError('This NWChem input has no `geometry` block.');
  const header = lines[start];
  const unitsMatch = header.match(/\bunits\s+(\w+)/i);
  const { factor, bohr } = unitFactor(unitsMatch ? unitsMatch[1] : 'angstroms');

  const atoms = [];
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*end\b/i.test(line)) {
      end = index;
      break;
    }
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const tokens = line.trim().split(/\s+/);
    const element = tokens[0];
    if (!isElementLike(element)) {
      throw new DeckImportError(
        `NWChem geometry line ${index + 1} ("${line.trim()}") does not start with an element symbol; `
        + 'this reader reads Cartesian geometry blocks only.',
      );
    }
    if (tokens.length < 4 || !new RegExp(`^${NUM}$`).test(tokens[1])) {
      throw new DeckImportError(
        `NWChem geometry line ${index + 1} ("${line.trim()}") is not Cartesian (element x y z). `
        + 'A Z-matrix or fragment reference is not converted here.',
      );
    }
    const [x, y, z] = numbers(tokens.slice(1, 4));
    if (![x, y, z].every((value) => Number.isFinite(value))) {
      throw new DeckImportError(`NWChem geometry line ${index + 1} has a non-finite coordinate.`);
    }
    atoms.push({ element, x: x * factor, y: y * factor, z: z * factor });
  }
  if (end < 0) throw new DeckImportError('The NWChem `geometry` block has no matching `end`.');
  if (atoms.length === 0) throw new DeckImportError('The NWChem `geometry` block contains no atoms.');

  return {
    atoms,
    charge: chargeMatch ? Number(chargeMatch[1]) : 0,
    multiplicity: multMatch ? Number(multMatch[1]) : 1,
    name: titleMatch ? titleMatch[1].trim() : '',
    warnings: [
      ...(bohr ? ['Coordinates were given in Bohr and were converted to Ångström (1 bohr = 0.529177 Å).'] : []),
      ...(chargeMatch ? [] : ['This NWChem input states no `charge`; 0 was assumed.']),
      ...(multMatch ? [] : ['This NWChem input states no `mult`; multiplicity 1 was assumed.']),
    ],
  };
}

/* ── GAMESS ───────────────────────────────────────────────── */

export function parseGamessInput(text) {
  const source = String(text ?? '');
  const dataStart = source.search(/^\s*\$DATA\b/im);
  if (dataStart < 0) throw new DeckImportError('This GAMESS input has no `$DATA` group.');

  const contrl = source.match(/^\s*\$CONTRL\b([\s\S]*?)\$END/im);
  const contrlText = contrl ? contrl[1] : '';
  const keyValue = (key) => {
    const match = contrlText.match(new RegExp(`\\b${key}\\s*=\\s*([^\\s$]+)`, 'i'));
    return match ? match[1] : null;
  };
  const units = keyValue('UNITS');
  const { factor, bohr } = unitFactor(units || 'ANGS');
  const charge = keyValue('ICHARG');
  const mult = keyValue('MULT');
  const coord = keyValue('COORD');
  if (coord && /^ZMT|^UNIQUE|^HINT/i.test(coord)) {
    throw new DeckImportError(
      `This GAMESS deck asks for COORD=${coord}, which is not a full Cartesian atom list. `
      + 'Only COORD=CART (every atom, x y z) is read here.',
    );
  }

  const body = source.slice(dataStart).split(/\r\n|\n|\r/);
  // The first line is ` $DATA`; the next two are the title card and the point group.
  let cursor = 1;
  const title = (body[cursor] || '').trim();
  cursor += 1;
  const symmetry = (body[cursor] || '').trim();
  cursor += 1;
  if (!symmetry) throw new DeckImportError('The GAMESS `$DATA` group has no symmetry line.');
  if (symmetry.toUpperCase() !== 'C1' && symmetry.toUpperCase() !== 'NOSYM') {
    throw new DeckImportError(
      `The GAMESS geometry uses point group ${symmetry}, so \`$DATA\` lists only the symmetry-unique atoms. `
      + 'Importing it would drop atoms; rerun with C1 (NOSYM=1) or import the coordinates from the output.',
    );
  }

  const atoms = [];
  for (; cursor < body.length; cursor += 1) {
    const line = body[cursor];
    if (/^\s*\$/.test(line)) break;
    if (!line.trim()) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5) {
      throw new DeckImportError(
        `GAMESS $DATA line ${cursor + 1} ("${line.trim()}") is not \`label ZNUC x y z\`.`,
      );
    }
    if (!isElementLike(tokens[0])) {
      throw new DeckImportError(
        `GAMESS $DATA line ${cursor + 1} starts with "${tokens[0]}", which is not an element symbol.`,
      );
    }
    const [x, y, z] = numbers(tokens.slice(2, 5));
    if (![x, y, z].every((value) => Number.isFinite(value))) {
      throw new DeckImportError(`GAMESS $DATA line ${cursor + 1} has a non-finite coordinate.`);
    }
    atoms.push({ element: tokens[0], x: x * factor, y: y * factor, z: z * factor });
  }
  if (atoms.length === 0) throw new DeckImportError('The GAMESS `$DATA` group contains no atoms.');

  return {
    atoms,
    charge: charge === null ? 0 : Number(charge),
    multiplicity: mult === null ? 1 : Number(mult),
    name: title,
    warnings: [
      ...(bohr ? ['Coordinates were given in Bohr (`UNITS=BOHR`) and were converted to Ångström.'] : []),
      ...(charge === null ? ['This GAMESS deck states no ICHARG; charge 0 was assumed.'] : []),
      ...(mult === null ? ['This GAMESS deck states no MULT; multiplicity 1 was assumed.'] : []),
    ],
  };
}

/* ── Q-Chem ───────────────────────────────────────────────── */

export function parseQchemInput(text) {
  const source = String(text ?? '');
  const block = source.match(/^\s*\$molecule\b([\s\S]*?)^\s*\$end/im);
  if (!block) throw new DeckImportError('This Q-Chem input has no `$molecule` group.');
  const comment = source.match(/^\s*\$comment\b([\s\S]*?)^\s*\$end/im);

  const body = block[1].split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
  if (body.length === 0) throw new DeckImportError('The Q-Chem `$molecule` group is empty.');
  if (/^read$/i.test(body[0])) {
    throw new DeckImportError(
      'This Q-Chem `$molecule` group says `read`: the geometry is in a separate file, which is not part of this deck.',
    );
  }
  const header = body[0].split(/\s+/);
  const charge = Number(header[0]);
  const multiplicity = Number(header[1]);
  if (!Number.isInteger(charge) || !Number.isInteger(multiplicity)) {
    throw new DeckImportError('The first line of a Q-Chem `$molecule` group must be `charge multiplicity`.');
  }

  const atoms = [];
  for (let index = 1; index < body.length; index += 1) {
    const tokens = body[index].split(/\s+/);
    if (tokens.length < 4 || !isElementLike(tokens[0])) {
      throw new DeckImportError(
        `Q-Chem $molecule line "${body[index]}" is not \`element x y z\`.`,
      );
    }
    const [x, y, z] = numbers(tokens.slice(1, 4));
    if (![x, y, z].every((value) => Number.isFinite(value))) {
      throw new DeckImportError(`Q-Chem $molecule line "${body[index]}" has a non-finite coordinate.`);
    }
    atoms.push({ element: tokens[0], x, y, z });
  }
  if (atoms.length === 0) throw new DeckImportError('The Q-Chem `$molecule` group contains no atoms.');

  return {
    atoms,
    charge,
    multiplicity,
    name: comment ? comment[1].trim() : '',
    warnings: ['Q-Chem coordinates are Ångström unless `$molecule` says otherwise; read as Ångström.'],
  };
}
