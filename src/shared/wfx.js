/**
 * WFX reader — the AIM Extended Wavefunction file defined by AIMAll
 * (`aim.tkgristmill.com/wfxformat.html`, specification 1.0.4c).
 *
 * WFX is a tag-per-line text format, XML-like but deliberately not XML: tags
 * stand alone on their own lines, spaces are allowed inside tag names, and the
 * order of sections is not fixed. The reader therefore indexes the sections and
 * looks each one up by name (case-insensitively); it does not assume an order.
 *
 * The decoded object is the same shape `fchk.js` produces: atoms in Å,
 * `coordinatesBohr`, shell tables, orbital energies and occupations, and one
 * coefficient matrix per spin channel. The orbital and density views need no
 * WFX branch.
 *
 * What is read: title, keywords, version when stated, nuclei (names, atomic
 * numbers, charges, coordinates), the primitive table (centres, types,
 * exponents), the MO block (occupations, energies, spin types, primitive
 * coefficients), net charge, electron counts, multiplicity, total energy and
 * virial ratio.
 *
 * What is **not** read: the `Additional Electron Density Function (EDF)`
 * sections. An EDF models ECP core density; ignoring it means a density
 * reconstructed from this record would be missing those core electrons, so the
 * record says `edf: { present: true, used: false }` rather than pretending the
 * density is complete. Gradients are not read either — nothing here invents a
 * derivative.
 *
 * Occupations are carried as written. Post-SCF natural orbitals can have
 * occupations such as 1.63, and rounding them would change the density; the
 * electron counts come from the file's own explicit sections.
 *
 * A version outside 1.x is refused by name. A file that does not say which
 * version it is, is accepted as 1.x — every WFX in circulation predates any
 * second major version, and the specification has been 1.0.x since 2010.
 */

import { ELEMENTS } from './elements.js';
import {
  AimFormatError,
  AIM_SPHERICAL,
  angstromOf,
  groupAimPrimitives,
} from './aimBasis.js';

export const MAX_WFX_CHARS = 64 * 1024 * 1024;
/** The specification this reader implements. */
export const SUPPORTED_WFX_MAJOR = 1;

export class WfxFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WfxFormatError';
  }
}

const SYMBOL_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const OPEN_TAG = /^<\s*([^>]+?)\s*>$/;
const CLOSE_TAG = /^<\/\s*([^>]+?)\s*>$/;

function tokensOf(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

function numberToken(raw, where) {
  const text = String(raw ?? '');
  if (!NUMBER.test(text)) {
    throw new WfxFormatError(`${where} has the non-numeric token "${text}".`);
  }
  const value = Number(text.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) {
    throw new WfxFormatError(`${where} has "${text}", which is outside the range of a double.`);
  }
  return value;
}

function integerToken(raw, where) {
  const value = numberToken(raw, where);
  if (!Number.isInteger(value)) {
    throw new WfxFormatError(`${where} expects an integer, found "${String(raw)}".`);
  }
  return value;
}

/**
 * Index the tag tree. Every section keeps its own text lines and its child
 * sections, so a nested `<MO Number>` inside the coefficient block is both
 * addressable and ordered.
 */
function indexSections(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const roots = [];
  const stack = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    const close = CLOSE_TAG.exec(trimmed);
    if (close) {
      const node = stack.pop();
      if (!node) {
        throw new WfxFormatError(`Line ${index + 1} closes </${close[1].trim()}> with no open section.`);
      }
      if (node.name.toLowerCase() !== close[1].trim().toLowerCase()) {
        throw new WfxFormatError(
          `Line ${index + 1} closes </${close[1].trim()}> but the open section is <${node.name}>.`,
        );
      }
      node.endLine = index + 1;
      continue;
    }
    const open = OPEN_TAG.exec(trimmed);
    if (open) {
      const node = {
        name: open[1].trim(),
        line: index + 1,
        body: [],
        children: [],
      };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      stack.push(node);
      continue;
    }
    if (stack.length) stack[stack.length - 1].body.push({ text: lines[index], line: index + 1 });
  }
  if (stack.length) {
    throw new WfxFormatError(`The section <${stack[stack.length - 1].name}> is never closed.`);
  }
  return { roots, lines };
}

function findSection(roots, name) {
  const needle = name.toLowerCase();
  const queue = [...roots];
  while (queue.length) {
    const node = queue.shift();
    if (node.name.toLowerCase() === needle) return node;
    queue.push(...node.children);
  }
  return null;
}

function bodyText(section) {
  return section.body.map((line) => line.text.trim()).filter(Boolean).join('\n');
}

function integersOf(section, where) {
  return tokensOf(bodyText(section)).map((token) => integerToken(token, where));
}

function realsOf(section, where) {
  return tokensOf(bodyText(section)).map((token) => numberToken(token, where));
}

function singleInteger(roots, name) {
  const section = findSection(roots, name);
  if (!section) return { present: false };
  const tokens = tokensOf(bodyText(section));
  if (tokens.length !== 1) {
    throw new WfxFormatError(`<${name}> carries ${tokens.length} value${tokens.length === 1 ? '' : 's'}; expected one integer.`);
  }
  return { present: true, value: integerToken(tokens[0], `<${name}>`) };
}

function singleReal(roots, name) {
  const section = findSection(roots, name);
  if (!section) return { present: false };
  const tokens = tokensOf(bodyText(section));
  if (tokens.length !== 1) {
    throw new WfxFormatError(`<${name}> carries ${tokens.length} value${tokens.length === 1 ? '' : 's'}; expected one number.`);
  }
  return { present: true, value: numberToken(tokens[0], `<${name}>`) };
}

function multiInteger(roots, name, where) {
  const section = findSection(roots, name);
  if (!section) return null;
  return integersOf(section, where);
}

function multiReal(roots, name, where) {
  const section = findSection(roots, name);
  if (!section) return null;
  return realsOf(section, where);
}

function namesOf(section) {
  const names = [];
  for (const line of section.body) {
    const trimmed = line.text.trim();
    if (!trimmed) continue;
    const tokens = tokensOf(trimmed);
    if (tokens.length !== 1) {
      throw new WfxFormatError(
        `<Nuclear Names> line ${line.line} has ${tokens.length} fields; each nucleus name must be alone on its line.`,
      );
    }
    names.push(tokens[0]);
  }
  return names;
}

/** Element from a WFX nuclear name such as `O1`, `H2`, `Bq12` or `NNA8`. */
function elementOfName(name) {
  const text = String(name ?? '');
  if (/^Bq/i.test(text) || /^NNA/i.test(text)) return { symbol: 'Bq', atomicNumber: 0 };
  const two = text.slice(0, 2);
  if (two.length === 2 && ELEMENTS.has(two)) return { symbol: two, atomicNumber: ELEMENTS.get(two) };
  const one = text.slice(0, 1).toUpperCase();
  if (ELEMENTS.has(one)) return { symbol: one, atomicNumber: ELEMENTS.get(one) };
  return { symbol: text.slice(0, 2), atomicNumber: 0 };
}

function checkVersion(roots) {
  for (const name of ['Version', 'WFX Version', 'Format Version']) {
    const section = findSection(roots, name);
    if (!section) continue;
    const text = bodyText(section);
    const match = /^(\d+)(?:\.(\d+))?/.exec(text);
    if (!match) {
      throw new WfxFormatError(`<${name}> states "${text}", which is not a version number.`);
    }
    const major = Number(match[1]);
    if (major !== SUPPORTED_WFX_MAJOR) {
      throw new WfxFormatError(
        `This file states WFX version ${text}; this reader supports ${SUPPORTED_WFX_MAJOR}.x only. `
        + 'A different major version may store the coefficients differently, so it is refused instead of read as 1.x.',
      );
    }
    return text;
  }
  return null;
}

/**
 * Read the `<Molecular Orbital Primitive Coefficients>` block.
 *
 * Each MO is ` <MO Number> n </MO Number>` followed by its coefficient run.
 * The number of values is checked against `<Number of Primitives>` for every
 * orbital; a short or long run is refused with both numbers.
 */
function readCoefficients(roots, lines, nprim, nmo) {
  const section = findSection(roots, 'Molecular Orbital Primitive Coefficients');
  if (!section) return null;
  const blocks = [];
  let current = null;
  let inNumber = false;
  for (let index = section.line; index < section.endLine - 1; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    if (/^<\s*MO\s*Number\s*>$/i.test(trimmed)) {
      current = { number: null, values: [] };
      blocks.push(current);
      inNumber = true;
      continue;
    }
    if (/^<\/\s*MO\s*Number\s*>$/i.test(trimmed)) {
      inNumber = false;
      continue;
    }
    if (!current) {
      throw new WfxFormatError(
        `Line ${index + 1} of <Molecular Orbital Primitive Coefficients> carries data before any <MO Number>.`,
      );
    }
    const tokens = tokensOf(trimmed);
    if (inNumber) {
      if (current.number !== null) {
        throw new WfxFormatError(`<MO Number> near line ${index + 1} carries more than one number.`);
      }
      if (tokens.length !== 1) {
        throw new WfxFormatError(`<MO Number> line ${index + 1} has ${tokens.length} fields; expected one integer.`);
      }
      current.number = integerToken(tokens[0], `<MO Number> line ${index + 1}`);
      continue;
    }
    for (const token of tokens) {
      current.values.push(numberToken(token, `MO ${current.number ?? '?'} coefficients (line ${index + 1})`));
    }
  }

  if (blocks.length !== nmo) {
    throw new WfxFormatError(
      `The coefficient block has ${blocks.length} <MO Number> section${blocks.length === 1 ? '' : 's'} `
      + `but <Number of Occupied Molecular Orbitals> says ${nmo}.`,
    );
  }
  for (let position = 0; position < blocks.length; position += 1) {
    const block = blocks[position];
    if (block.number === null) {
      throw new WfxFormatError(`The coefficient block for MO ${position + 1} has no <MO Number>.`);
    }
    if (block.values.length !== nprim) {
      throw new WfxFormatError(
        `MO ${block.number} has ${block.values.length} coefficient${block.values.length === 1 ? '' : 's'} `
        + `but <Number of Primitives> says ${nprim}; the coefficient block is truncated or overlong.`,
      );
    }
  }
  return blocks;
}

function readSpinTypes(roots, nmo) {
  const section = findSection(roots, 'Molecular Orbital Spin Types');
  if (!section) return null;
  const spins = [];
  for (const line of section.body) {
    const trimmed = line.text.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (normalized === 'alpha and beta') spins.push('Alpha and Beta');
    else if (normalized === 'alpha') spins.push('Alpha');
    else if (normalized === 'beta') spins.push('Beta');
    else {
      throw new WfxFormatError(
        `<Molecular Orbital Spin Types> line ${line.line} says "${trimmed}"; the specification defines `
        + '"Alpha and Beta", "Alpha" and "Beta".',
      );
    }
  }
  if (spins.length !== nmo) {
    throw new WfxFormatError(
      `<Molecular Orbital Spin Types> has ${spins.length} entr${spins.length === 1 ? 'y' : 'ies'} for ${nmo} orbitals.`,
    );
  }
  return spins;
}

/**
 * Parse a WFX file.
 *
 * @param {string} text
 * @param {{ maxChars?: number }} [options] `maxChars` lets the bound be tested
 *   without a 64 MB fixture; callers should leave it alone.
 */
export function parseWfx(text, { maxChars = MAX_WFX_CHARS } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new WfxFormatError('The WFX file is empty.');
  }
  if (text.length > maxChars) {
    throw new WfxFormatError(
      `The WFX file is ${text.length} characters; the limit is ${maxChars}. `
      + 'This reader needs the nuclei, basis and MO blocks, so trim the file or export it from a smaller job.',
    );
  }

  const { roots, lines } = indexSections(text);
  const warnings = [];
  const found = [];
  const missing = [];

  const version = checkVersion(roots);

  const keywordsSection = findSection(roots, 'Keywords');
  let keywords = null;
  if (keywordsSection) {
    keywords = tokensOf(bodyText(keywordsSection)).map((token) => token.toUpperCase());
    if (!keywords.includes('GTO')) {
      throw new WfxFormatError(
        `<Keywords> says "${bodyText(keywordsSection)}"; this reader supports GTO (Cartesian Gaussian) primitives only.`,
      );
    }
  }

  const nuclei = singleInteger(roots, 'Number of Nuclei');
  if (!nuclei.present) throw new WfxFormatError('The file has no <Number of Nuclei> section.');
  const nnuc = nuclei.value;
  if (nnuc < 1) throw new WfxFormatError(`<Number of Nuclei> is ${nnuc}; a wavefunction needs at least one nucleus.`);

  const primitives = singleInteger(roots, 'Number of Primitives');
  if (!primitives.present) throw new WfxFormatError('The file has no <Number of Primitives> section.');
  const nprim = primitives.value;
  if (nprim < 1) throw new WfxFormatError(`<Number of Primitives> is ${nprim}; a wavefunction needs at least one primitive.`);

  const orbitalsCount = singleInteger(roots, 'Number of Occupied Molecular Orbitals');
  if (!orbitalsCount.present) throw new WfxFormatError('The file has no <Number of Occupied Molecular Orbitals> section.');
  const nmo = orbitalsCount.value;
  if (nmo < 1) throw new WfxFormatError(`<Number of Occupied Molecular Orbitals> is ${nmo}; a wavefunction needs at least one orbital.`);

  const chargesSection = findSection(roots, 'Nuclear Charges');
  if (!chargesSection) throw new WfxFormatError('The file has no <Nuclear Charges> section.');
  const nuclearCharges = realsOf(chargesSection, '<Nuclear Charges>');
  if (nuclearCharges.length !== nnuc) {
    throw new WfxFormatError(`<Nuclear Charges> has ${nuclearCharges.length} values for ${nnuc} nuclei.`);
  }

  const coordinatesSection = findSection(roots, 'Nuclear Cartesian Coordinates');
  if (!coordinatesSection) throw new WfxFormatError('The file has no <Nuclear Cartesian Coordinates> section.');
  const coordinatesBohr = realsOf(coordinatesSection, '<Nuclear Cartesian Coordinates>');
  if (coordinatesBohr.length !== nnuc * 3) {
    throw new WfxFormatError(
      `<Nuclear Cartesian Coordinates> has ${coordinatesBohr.length} values for ${nnuc} nuclei (expected ${nnuc * 3}).`,
    );
  }

  const namesSection = findSection(roots, 'Nuclear Names');
  const nuclearNames = namesSection ? namesOf(namesSection) : null;
  if (nuclearNames && nuclearNames.length !== nnuc) {
    throw new WfxFormatError(`<Nuclear Names> has ${nuclearNames.length} names for ${nnuc} nuclei.`);
  }

  let atomicNumbers = multiInteger(roots, 'Atomic Numbers', '<Atomic Numbers>');
  if (atomicNumbers && atomicNumbers.length !== nnuc) {
    throw new WfxFormatError(`<Atomic Numbers> has ${atomicNumbers.length} values for ${nnuc} nuclei.`);
  }
  if (!atomicNumbers) {
    atomicNumbers = [];
    for (let index = 0; index < nnuc; index += 1) {
      const name = nuclearNames ? nuclearNames[index] : null;
      const { atomicNumber } = name ? elementOfName(name) : { atomicNumber: 0 };
      atomicNumbers.push(atomicNumber);
    }
    warnings.push('<Atomic Numbers> is absent; the atomic numbers were taken from the nuclear names.');
  }

  const atoms = [];
  for (let index = 0; index < nnuc; index += 1) {
    const atomicNumber = atomicNumbers[index];
    if (!Number.isInteger(atomicNumber) || atomicNumber < 0 || atomicNumber > 118) {
      throw new WfxFormatError(`Atomic number ${atomicNumber} for nucleus ${index + 1} is outside 0-118.`);
    }
    if (atomicNumber === 0 && nuclearCharges[index] !== 0) {
      warnings.push(`Nucleus ${index + 1} has atomic number 0 and nuclear charge ${nuclearCharges[index]}; it is kept as a ghost.`);
    }
    atoms.push({
      atomicNumber,
      element: atomicNumber === 0 ? null : SYMBOL_BY_NUMBER.get(atomicNumber) ?? null,
      x: angstromOf(coordinatesBohr[index * 3]),
      y: angstromOf(coordinatesBohr[index * 3 + 1]),
      z: angstromOf(coordinatesBohr[index * 3 + 2]),
    });
  }

  const centres = multiInteger(roots, 'Primitive Centers', '<Primitive Centers>');
  const types = multiInteger(roots, 'Primitive Types', '<Primitive Types>');
  const exponents = multiReal(roots, 'Primitive Exponents', '<Primitive Exponents>');
  if (!centres) throw new WfxFormatError('The file has no <Primitive Centers> section.');
  if (!types) throw new WfxFormatError('The file has no <Primitive Types> section.');
  if (!exponents) throw new WfxFormatError('The file has no <Primitive Exponents> section.');
  for (const [name, values] of [['<Primitive Centers>', centres], ['<Primitive Types>', types], ['<Primitive Exponents>', exponents]]) {
    if (values.length !== nprim) {
      throw new WfxFormatError(`${name} has ${values.length} values but <Number of Primitives> says ${nprim}.`);
    }
  }
  let basis;
  try {
    basis = groupAimPrimitives({
      centres,
      types,
      exponents,
      where: 'the WFX primitive table',
      atomCount: nnuc,
    });
  } catch (error) {
    if (error instanceof AimFormatError) throw new WfxFormatError(error.message);
    throw error;
  }

  const occupations = multiReal(roots, 'Molecular Orbital Occupation Numbers', '<Molecular Orbital Occupation Numbers>');
  const energies = multiReal(roots, 'Molecular Orbital Energies', '<Molecular Orbital Energies>');
  if (occupations && occupations.length !== nmo) {
    throw new WfxFormatError(`<Molecular Orbital Occupation Numbers> has ${occupations.length} values for ${nmo} orbitals.`);
  }
  if (energies && energies.length !== nmo) {
    throw new WfxFormatError(`<Molecular Orbital Energies> has ${energies.length} values for ${nmo} orbitals.`);
  }

  const spins = readSpinTypes(roots, nmo);
  if (!spins) {
    warnings.push(
      '<Molecular Orbital Spin Types> is absent; every orbital is treated as "Alpha and Beta" for the alpha coefficient matrix. '
      + 'The file\'s explicit electron counts are used for the spin state.',
    );
  }

  const blocks = readCoefficients(roots, lines, nprim, nmo);
  if (!blocks) {
    throw new WfxFormatError('The file has no <Molecular Orbital Primitive Coefficients> section.');
  }

  const orbitals = blocks.map((block, position) => {
    const spin = spins ? spins[position] : 'Alpha and Beta';
    const coefficients = block.values.map((_, index) => block.values[basis.permutation[index]]);
    return {
      number: block.number,
      energy: energies ? energies[position] : Number.NaN,
      occupation: occupations ? occupations[position] : Number.NaN,
      spin,
      coefficients,
    };
  });
  if (!energies) warnings.push('The file has no <Molecular Orbital Energies> section; orbital energies are absent.');
  if (!occupations) warnings.push('The file has no <Molecular Orbital Occupation Numbers> section; occupations are absent.');

  const parsed = {
    format: 'wfx',
    title: (() => {
      const section = findSection(roots, 'Title');
      return section ? bodyText(section).replace(/\s+/g, ' ').slice(0, 500) : '';
    })(),
    version: version ?? '1.x (not stated in the file)',
    keywords,
    found,
    missing,
    warnings,
    units: { coordinates: 'angstrom', source: 'bohr' },
    spherical: AIM_SPHERICAL,
    numberOfAtoms: nnuc,
    atoms,
    atomicNumbers,
    nuclearNames: nuclearNames ?? atoms.map((atom, index) => `${atom.element ?? 'Bq'}${index + 1}`),
    nuclearCharges,
    coordinatesBohr,
    numberOfPrimitives: nprim,
    numberOfBasisFunctions: basis.numberOfBasisFunctions,
    shellTypes: basis.shellTypes,
    primitivesPerShell: basis.primitivesPerShell,
    shellToAtomMap: basis.shellToAtomMap,
    primitiveExponents: basis.primitiveExponents,
    contractionCoefficients: basis.contractionCoefficients,
    shells: basis.shells,
    orbitals,
    occupations: occupations ?? undefined,
    numberOfMolecularOrbitals: nmo,
    edf: {
      present: Boolean(findSection(roots, 'Additional Electron Density Function (EDF)')),
      used: false,
      meaning: 'ECP core-density data; this reader does not apply it, so a density rebuilt from this record would omit it',
    },
  };

  found.push(
    'numberOfAtoms', 'atoms', 'atomicNumbers', 'coordinatesBohr', 'nuclearCharges',
    'numberOfPrimitives', 'numberOfBasisFunctions', 'shellTypes', 'primitivesPerShell',
    'shellToAtomMap', 'primitiveExponents', 'contractionCoefficients', 'orbitals', 'numberOfMolecularOrbitals',
  );
  missing.push('spContractionCoefficients', 'mullikenCharges', 'espCharges');

  const alphaOrbitals = orbitals.filter((orbital) => orbital.spin !== 'Beta');
  const betaOrbitals = orbitals.filter((orbital) => orbital.spin === 'Beta');
  if (energies) {
    parsed.orbitalEnergies = alphaOrbitals.map((orbital) => orbital.energy);
    found.push('orbitalEnergies');
    if (betaOrbitals.length) {
      parsed.orbitalEnergiesBeta = betaOrbitals.map((orbital) => orbital.energy);
      found.push('orbitalEnergiesBeta');
    } else missing.push('orbitalEnergiesBeta');
  } else {
    missing.push('orbitalEnergies', 'orbitalEnergiesBeta');
  }
  if (occupations) {
    parsed.found.push('occupations');
  }
  parsed.alphaMOCoefficients = alphaOrbitals.flatMap((orbital) => orbital.coefficients);
  found.push('alphaMOCoefficients');
  if (betaOrbitals.length) {
    parsed.betaMOCoefficients = betaOrbitals.flatMap((orbital) => orbital.coefficients);
    found.push('betaMOCoefficients');
  } else missing.push('betaMOCoefficients');

  const netCharge = singleReal(roots, 'Net Charge');
  if (netCharge.present) {
    parsed.charge = netCharge.value;
    found.push('charge');
  } else missing.push('charge');

  for (const [sectionName, key] of [
    ['Number of Electrons', 'numberOfElectrons'],
    ['Number of Alpha Electrons', 'numberOfAlphaElectrons'],
    ['Number of Beta Electrons', 'numberOfBetaElectrons'],
    ['Electronic Spin Multiplicity', 'multiplicity'],
    ['Number of Core Electrons', 'numberOfCoreElectrons'],
  ]) {
    const value = singleInteger(roots, sectionName);
    if (value.present) {
      parsed[key] = value.value;
      found.push(key);
    } else missing.push(key);
  }

  const energySection = roots.find((node) => /^energy\b/i.test(node.name) && !/gradient/i.test(node.name));
  if (energySection) {
    const values = realsOf(energySection, `<${energySection.name}>`);
    if (values.length !== 1) {
      throw new WfxFormatError(`<${energySection.name}> carries ${values.length} values; expected the total energy only.`);
    }
    parsed.totalEnergyHartree = values[0];
    found.push('totalEnergyHartree');
  } else missing.push('totalEnergyHartree');

  const virialSection = roots.find((node) => /^virial\s+ratio/i.test(node.name));
  if (virialSection) {
    const values = realsOf(virialSection, `<${virialSection.name}>`);
    if (values.length !== 1) {
      throw new WfxFormatError(`<${virialSection.name}> carries ${values.length} values; expected one number.`);
    }
    parsed.virialRatio = values[0];
    found.push('virialRatio');
  } else missing.push('virialRatio');

  if (parsed.numberOfAlphaElectrons !== undefined && parsed.numberOfBetaElectrons !== undefined
    && parsed.numberOfElectrons !== undefined
    && parsed.numberOfAlphaElectrons + parsed.numberOfBetaElectrons !== parsed.numberOfElectrons) {
    warnings.push(
      `The alpha (${parsed.numberOfAlphaElectrons}) and beta (${parsed.numberOfBetaElectrons}) counts `
      + `do not add up to <Number of Electrons> (${parsed.numberOfElectrons}).`,
    );
  }

  return parsed;
}

export { AimFormatError };
