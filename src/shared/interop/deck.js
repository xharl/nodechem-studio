/**
 * Shared machinery for the three **export-only** decks (NWChem, GAMESS, Q-Chem).
 *
 * These engines are not runners in this build: nothing here builds argv, stages
 * a file or parses output. An exporter takes the same settings and molecule a
 * Gaussian task would use and writes the text another program reads — or
 * refuses, by name, naming the field it cannot spell. That is the rule the ORCA
 * builder already follows for `ωB97X-D`, applied to three more vocabularies:
 * a plausible-looking deck that quietly means something else is worse than a
 * refusal, because the user finds out after paying for the calculation.
 *
 * What is checked before any engine-specific code runs:
 *
 * - **geometry**: a non-empty atom list, finite coordinates, known symbols, and
 *   not a 2D drawing. A ChemDraw depiction is page units with z = 0; optimising
 *   it would minimise the drawing. A structure whose every atom sits at one
 *   point is a placeholder, not a geometry, and is refused as such.
 * - **elements**: hydrogen through krypton. The three exporters write no
 *   effective core potential, so an element that needs one is refused rather
 *   than run all-electron with a basis the library does not carry.
 * - **settings this build cannot translate**: Gaussian route syntax
 *   (`customKeywords`, `scf`, `grid`, `population`, `integral`), solvation
 *   models, TD-DFT, constraints, QST, IRC, scans, composite methods, dispersion
 *   and per-engine job types. Each refusal names the field and the remedy.
 */

import { atomicNumber, isElementSymbol } from '../elements.js';

/** Hydrogen through krypton: beyond this a basis set needs an ECP. */
export const MAX_Z = 36;

/** A refusal object, shaped so a caller can print `.refused` and stop. */
export function refusal(message) {
  return { ok: false, refused: message };
}

/**
 * A coordinate as the decks print it: eight decimals, no exponent, no trailing
 * zero noise. `1e-7` would be legal in two of the three grammars and a parse
 * risk in the third; fixed point is not.
 */
export function coordinate(value) {
  const fixed = Number(value).toFixed(8);
  return fixed.replace(/0+$/, '').replace(/\.$/, '.0');
}

function oneLine(value, fallback = '') {
  return String(value ?? fallback).replace(/[\r\n]+/g, ' ').trim();
}

/** A `start`/job-name token: letters, digits and underscore. */
export function jobToken(value, fallback = 'ncs') {
  const cleaned = oneLine(value, fallback).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/** The title, stripped to one line and to characters all three grammars accept. */
export function deckTitle(value) {
  return oneLine(value, 'NodeChem Studio export').slice(0, 120) || 'NodeChem Studio export';
}

/**
 * Check the molecule every deck writes into its geometry section. Returns
 * `{ ok: true, atoms, charge, multiplicity }` or a refusal naming the problem.
 */
export function prepareMolecule({ molecule = {}, geometry = null } = {}) {
  const geometryRecord = geometry && typeof geometry === 'object' ? geometry : {};
  const coords = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (coords.length === 0) {
    return refusal('This block has no coordinates. A deck needs a geometry; import a structure first '
      + '(a .xyz, .mol, .sdf, .mol2, .pdb, .cjson or a Gaussian .log) or pick a conformer.');
  }
  // The ChemDraw decision, applied here: a 2D drawing is a depiction. Optimising
  // it minimises the drawing, and every number afterwards describes the drawing.
  if (geometryRecord.dimension === '2d') {
    return refusal('The project geometry is a 2D drawing (from a ChemDraw file): page-unit coordinates with z = 0. '
      + 'A 2D drawing is a depiction, not a structure — the deck would optimise the drawing. Import a 3D geometry '
      + '(or optimise this one in Gaussian first) and export again.');
  }
  const atoms = [];
  for (let index = 0; index < coords.length; index += 1) {
    const atom = coords[index] || {};
    const element = String(atom.element ?? '').trim();
    if (!isElementSymbol(element)) {
      return refusal(`Atom ${index + 1} has an unknown element symbol "${element}".`);
    }
    const x = Number(atom.x);
    const y = Number(atom.y);
    const z = Number(atom.z);
    if (![x, y, z].every((value) => Number.isFinite(value))) {
      return refusal(`Atom ${index + 1} (${element}) has a non-finite coordinate; a deck cannot carry it.`);
    }
    const atomic = atomicNumber(element);
    if (atomic === null) return refusal(`Atom ${index + 1} has an unknown element symbol "${element}".`);
    if (atomic > MAX_Z) {
      return refusal(`Atom ${index + 1} is ${element} (Z = ${atomic}). These exporters write no effective core potential, `
        + 'so they cover H–Kr only; a heavier element needs an ECP deck written by hand.');
    }
    atoms.push({ element, x, y, z });
  }
  // Every atom at one point is the shape a geometry-less structure would take if
  // it were padded with zeros. It is refused instead of being optimised as a
  // superposition of atoms.
  if (atoms.length > 1 && atoms.every((atom) => atom.x === atoms[0].x && atom.y === atoms[0].y && atom.z === atoms[0].z)) {
    return refusal('Every atom sits at the same point. That is a placeholder, not a geometry — these exporters do not '
      + 'invent coordinates, so import a structure with a 3D geometry first.');
  }
  const charge = Number(molecule.charge ?? 0);
  const multiplicity = Number(molecule.multiplicity ?? 1);
  if (!Number.isInteger(charge) || charge < -10 || charge > 10) {
    return refusal(`The charge (${molecule.charge}) must be an integer between -10 and 10.`);
  }
  if (!Number.isInteger(multiplicity) || multiplicity < 1 || multiplicity > 10) {
    return refusal(`The multiplicity (${molecule.multiplicity}) must be an integer between 1 and 10.`);
  }
  const electrons = atoms.reduce((total, atom) => total + atomicNumber(atom.element), 0) - charge;
  if ((electrons - (multiplicity - 1)) % 2 !== 0) {
    return refusal(`Charge ${charge} and multiplicity ${multiplicity} are inconsistent with ${electrons} electrons. `
      + 'Fix the block\'s charge or multiplicity before exporting.');
  }
  return { ok: true, atoms, charge, multiplicity, electrons };
}

/**
 * Settings that mean Gaussian route syntax, or a feature no exporter here
 * writes. `engine` names the target in the message. Returns a refusal or null.
 */
export function refuseUntranslatable(settings = {}, engine = 'this exporter') {
  const text = (value) => oneLine(value);
  if (text(settings.customKeywords)) {
    return refusal(`The block has custom route keywords ("${text(settings.customKeywords).slice(0, 60)}"). `
      + `Custom keywords are Gaussian syntax; ${engine} reads a different grammar, so they cannot be translated. `
      + 'Clear the field and add the equivalent keyword to the deck by hand.');
  }
  if (settings.solvation === true) {
    return refusal(`The block requests solvation (${text(settings.solvationModel) || 'PCM'}, ${text(settings.solvent) || 'solvent unnamed'}). `
      + `${engine} needs its own solvation group for that, which this exporter does not write. `
      + 'Export the gas-phase deck and add the solvation section by hand.');
  }
  if (Number(settings.tdStates) > 0 || settings.emission === true || settings.nto === true) {
    return refusal(`The block requests excited states (TD-DFT, ${Number(settings.tdStates) || 0} states). `
      + `${engine} spells excited states differently and this exporter does not write them. `
      + 'Export the ground-state deck and add the excited-state section by hand.');
  }
  if (Array.isArray(settings.constraints) && settings.constraints.length > 0) {
    return refusal(`The block carries ${settings.constraints.length} constraint${settings.constraints.length === 1 ? '' : 's'}. `
      + `Constraints are written as a Gaussian ModRedundant section; ${engine} has a different syntax that this `
      + 'exporter does not write.');
  }
  if (settings.qst) {
    return refusal(`The block is a QST${settings.qst?.kind === 'QST3' ? '3' : '2'} search. That is a Gaussian keyword; `
      + `${engine} has no equivalent this exporter can write.`);
  }
  if (settings.ladder) {
    return refusal('The block is a method ladder. A ladder is a chain of Gaussian jobs this exporter does not expand.');
  }
  if (settings.spinSweep) {
    return refusal('The block is a spin-state sweep. A sweep is several decks with different multiplicities; '
      + 'this exporter writes one.');
  }
  if (Number(settings.counterpoise) > 0) {
    return refusal('The block is a counterpoise correction. That needs fragment labels and a ghost-atom section '
      + `this exporter does not write for ${engine}.`);
  }
  if (settings.stableOpt === true) {
    return refusal('The block requests a stable wavefunction check (Stable=Opt). That is a Gaussian route; '
      + `${engine} spells it differently.`);
  }
  if (settings.raman === true || settings.vcd === true) {
    return refusal(`The block requests ${settings.raman === true ? 'Raman activities' : 'VCD'} on its frequency job. `
      + `${engine} prints those from its own keywords, which this exporter does not write.`);
  }
  if (settings.orbitals === true) {
    return refusal('The block requests orbital output. Orbital printing is a Gaussian keyword; '
      + `${engine} writes orbitals from its own section, which this exporter does not write.`);
  }
  for (const [key, label] of [
    ['scf', 'an SCF convergence keyword'],
    ['grid', 'an integration grid keyword'],
    ['population', 'a population-analysis keyword'],
    ['verbosity', 'a print-verbosity keyword'],
  ]) {
    if (text(settings[key])) {
      return refusal(`The block sets ${label} ("${text(settings[key])}"). That is Gaussian route syntax; `
        + `${engine} has its own spelling, which this exporter does not translate.`);
    }
  }
  if (text(settings.optConvergence)) {
    return refusal(`The block asks for ${text(settings.optConvergence)} optimisation convergence. `
      + 'That is a Gaussian Opt flag; the convergence criteria of the target program are its own keywords, '
      + 'which this exporter does not write.');
  }
  return null;
}
