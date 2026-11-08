/**
 * QCSchema (MolSSI) interop — an AtomicResult out of a finished run, and back.
 *
 * `qcschema_output` is the interchange document other quantum-chemistry tools
 * already speak. This module is the only place that knows its field names:
 * `ncs qcschema export` and `ncs qcschema import` are thin wrappers, and the
 * tests validate what it writes against the published MolSSI schema that is
 * vendored under `schemas/qcschema/v2/` — not against our own idea of it.
 *
 * Two rules drive the shape:
 *
 * 1. **Nothing invented.** A value the run does not carry is absent, never 0 and
 *    never a placeholder. A field the document needs but the run cannot supply
 *    is a refusal that names the field (`QCSchemaError.field`).
 * 2. **Atomic units, converted explicitly.** QCSchema stores the geometry in
 *    bohr; the app stores angstrom. `ANGSTROM_PER_BOHR` is the single conversion
 *    factor in either direction. Energies are already hartree in the run record
 *    and are copied unchanged; nothing is ever written into a hartree field in
 *    kcal/mol.
 *
 * Fields this writer emits, and what it deliberately omits:
 *
 * | Field | Behaviour |
 * | --- | --- |
 * | `molecule` | symbols, bohr geometry, charge, multiplicity; fragments and name when known. |
 * | `driver` | `energy`, or `gradient`/`hessian` when the caller supplies one. |
 * | `return_result` | the energy, or the derivative when the driver says so. |
 * | `properties.return_energy` | the run's final energy. Nothing else: `properties` is closed by the published schema, so a gradient never goes here. |
 * | `model` | method and basis from provenance; `dispersion` when the engine reported one. |
 * | `keywords` | `{}` — the app does not record program parameters in a QCSchema vocabulary. |
 * | `provenance` | creator, version, routine, engine, method, basis, run id. |
 * | `success` / `error` | `success` from the parsed status; `error` only when the failure maps onto the schema's three error classes. |
 * | `extras` | the run id, dry-run flag, engine, job type, termination, frequencies and thermochemistry (hartree). |
 * | `wavefunction` | **omitted** — none of the four parsers produces MOs, so none is synthesised. |
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ENGINE_IDS } from './engines/index.js';

/** `schema_name` of a finished calculation. */
export const QCSCHEMA_SCHEMA_NAME = 'qcschema_output';
/** `schema_version` this build writes. */
export const QCSCHEMA_SCHEMA_VERSION = 2;
/** `schema_name` of the molecule object inside a result. */
export const QCSCHEMA_MOLECULE_SCHEMA_NAME = 'qcschema_molecule';
/** `schema_version` of the molecule object this build writes. */
export const QCSCHEMA_MOLECULE_SCHEMA_VERSION = 2;

/**
 * Bohr radius in angstrom (CODATA 2018). QCSchema geometry is in bohr; every
 * conversion in this module multiplies or divides by exactly this constant.
 */
export const ANGSTROM_PER_BOHR = 0.529177210903;
/** Angstrom per bohr, the reciprocal used when writing. */
export const BOHR_PER_ANGSTROM = 1 / ANGSTROM_PER_BOHR;

/** Bohr coordinates are written with this many decimals (6-decimal angstrom in, ~1e-10 out). */
const BOHR_DECIMALS = 10;
/** Angstrom coordinates are read back with this many decimals, one more than any engine prints. */
const ANGSTROM_DECIMALS = 10;

const SCHEMA_FILES = Object.freeze({
  output: 'schemas/qcschema/v2/qc_schema_output.schema',
  molecule: 'schemas/qcschema/v2/qc_schema_molecule.schema',
});

/** A refusal from the writer or the reader. `field` is a JSON pointer. */
export class QCSchemaError extends Error {
  constructor(message, { code = 'qcschema-refused', field = null, errors = [], details = null } = {}) {
    super(message);
    this.name = 'QCSchemaError';
    this.code = code;
    this.field = field;
    this.errors = errors;
    /** Extra machine-readable context (e.g. the run ids of an ambiguous folder). */
    this.details = details;
  }
}

/* ── Published schema ────────────────────────────────────────── */

/** Absolute path of a vendored published schema (`output` or `molecule`). */
export function qcschemaSchemaPath(which = 'output') {
  const file = SCHEMA_FILES[String(which)];
  if (!file) throw new QCSchemaError(`unknown QCSchema schema "${which}".`, { field: 'schema' });
  return fileURLToPath(new URL(`../../${file}`, import.meta.url));
}

const schemaCache = new Map();

/** Load a vendored published schema. Throws when the file is missing or unreadable. */
export function loadQcschemaSchema(which = 'output') {
  const key = String(which);
  if (schemaCache.has(key)) return schemaCache.get(key);
  const file = qcschemaSchemaPath(key);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new QCSchemaError(`cannot read the QCSchema schema ${file}: ${error.message}`, {
      code: 'qcschema-schema-missing', field: 'schema',
    });
  }
  schemaCache.set(key, parsed);
  return parsed;
}

/* ── A JSON Schema subset, driven by the published file ─────── */

/*
 * The record contract has its own validator (`schemas/record-schema.js`) for
 * `run.json`. This one exists because the published QCSchema file uses
 * `multipleOf`, `maxItems` and `uniqueItems`, which that validator does not
 * implement, and because a refusal here has to talk about QCSchema fields, not
 * about run-record ones. It implements the keywords that file actually uses.
 */

function typeMatches(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

function pointer(base, segment) {
  return `${base}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function resolveRef(ref, root) {
  if (!String(ref).startsWith('#/')) throw new QCSchemaError(`only local $ref values are supported, got ${ref}.`, { field: 'schema' });
  let node = root;
  for (const raw of String(ref).slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[key];
  }
  if (node === undefined) throw new QCSchemaError(`unresolved $ref ${ref}.`, { field: 'schema' });
  return node;
}

function validateNode(value, schema, root, path, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path: path || '/', message: 'no value is allowed here' });
    return;
  }
  if (schema.$ref !== undefined) validateNode(value, resolveRef(schema.$ref, root), root, path, errors);

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path: path || '/', message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    errors.push({ path: path || '/', message: `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}` });
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push({ path: path || '/', message: `must be ${types.join(' or ')}, got ${JSON.stringify(value)}` });
      return;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push({ path: path || '/', message: `must be >= ${schema.minimum}` });
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push({ path: path || '/', message: `must be <= ${schema.maximum}` });
    }
    if (Number.isFinite(schema.multipleOf) && schema.multipleOf !== 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        errors.push({ path: path || '/', message: `must be a multiple of ${schema.multipleOf}` });
      }
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push({ path: path || '/', message: `must be at least ${schema.minLength} characters` });
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push({ path: path || '/', message: `must be at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push({ path: path || '/', message: `must match ${schema.pattern}` });
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push({ path: path || '/', message: `must contain at least ${schema.minItems} items` });
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push({ path: path || '/', message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const entry of value) {
        const key = JSON.stringify(entry);
        if (seen.has(key)) {
          errors.push({ path: path || '/', message: 'must not contain duplicate items' });
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => validateNode(entry, schema.items, root, pointer(path, index), errors));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path: path || '/', message: `is missing required property "${key}"` });
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, entry] of Object.entries(value)) {
      const target = pointer(path, key);
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(entry, properties[key], root, target, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: target, message: 'is not part of the qcschema_output schema' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(entry, schema.additionalProperties, root, target, errors);
      }
    }
  }

  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    validateNode(value, branch, root, path, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch) => {
      const collected = [];
      validateNode(value, branch, root, path, collected);
      return collected;
    });
    if (!branches.some((collected) => collected.length === 0)) {
      const closest = branches.slice().sort((a, b) => a.length - b.length)[0];
      errors.push(...closest);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => {
      const collected = [];
      validateNode(value, branch, root, path, collected);
      return collected;
    });
    const matches = branches.filter((collected) => collected.length === 0).length;
    if (matches !== 1) {
      errors.push({ path: path || '/', message: `must match exactly one allowed shape (matched ${matches})` });
    }
  }
}

/** Validate a document against the published `qcschema_output` schema. */
export function validateQcschemaOutput(doc) {
  return validateAgainst(doc, 'output');
}

/** Validate a molecule object against the published `qcschema_molecule` schema. */
export function validateQcschemaMolecule(molecule) {
  return validateAgainst(molecule, 'molecule');
}

function validateAgainst(value, which) {
  const schema = loadQcschemaSchema(which);
  const errors = [];
  validateNode(value, schema, schema, '', errors);
  return { ok: errors.length === 0, errors, schema: qcschemaSchemaPath(which) };
}

/* ── Writing ────────────────────────────────────────────────── */

const round = (value, decimals) => Number(value.toFixed(decimals));

function titleCaseElement(element) {
  const text = String(element ?? '').trim();
  if (!/^[A-Za-z]{1,3}$/.test(text)) return null;
  return text[0].toUpperCase() + text.slice(1).toLowerCase();
}

function finiteCoords(atom) {
  return atom && [atom.x, atom.y, atom.z].every((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * The atoms a run record carries, newest geometry first: the parsed final
 * geometry, then the standard orientation, then the input orientation. A record
 * that only has a single point never printed one of those, so the caller falls
 * back to the input file.
 */
export function atomsFromRun(record) {
  const parsed = record?.parsed;
  const candidates = [
    ['finalGeometry', parsed?.finalGeometry],
    ['geometry.standard', parsed?.geometry?.standard],
    ['geometry.input', parsed?.geometry?.input],
  ];
  for (const [source, geometry] of candidates) {
    const atoms = Array.isArray(geometry?.atoms) ? geometry.atoms : null;
    if (!atoms || atoms.length === 0) continue;
    if (!atoms.every((atom) => finiteCoords(atom) && titleCaseElement(atom.element))) continue;
    return {
      source,
      atoms: atoms.map((atom) => ({
        element: titleCaseElement(atom.element), x: atom.x, y: atom.y, z: atom.z,
      })),
    };
  }
  return null;
}

/**
 * Read charge, multiplicity and the atoms out of a Gaussian job specification —
 * the input that actually ran, when the run record itself has no geometry (a
 * single point prints no orientation table, and a dry run prints none at all).
 *
 * Returns `null` for anything that is not a readable Gaussian input, rather
 * than guessing: a wrong charge is worse than a refusal.
 */
export function gaussianInputMolecule(text) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const atomRow = /^\s*([A-Z][a-z]?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s|$)/;
  const chargeRow = /^\s*(-?\d+)\s+(\d+)\s*$/;
  for (let index = 0; index < lines.length; index += 1) {
    const charge = lines[index].match(chargeRow);
    if (!charge) continue;
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === '') next += 1;
    if (next >= lines.length || !atomRow.test(lines[next])) continue;

    const atoms = [];
    for (let cursor = next; cursor < lines.length; cursor += 1) {
      const row = lines[cursor].match(atomRow);
      if (!row) break;
      const element = titleCaseElement(row[1]);
      if (!element) break;
      atoms.push({ element, x: Number(row[2]), y: Number(row[3]), z: Number(row[4]) });
    }
    if (atoms.length === 0) continue;

    // The title is the last non-blank line before the charge row (Gaussian puts
    // it between two blank lines), so an input with no title has no name.
    let titleIndex = index - 1;
    while (titleIndex >= 0 && lines[titleIndex].trim() === '') titleIndex -= 1;
    const title = titleIndex >= 0 ? lines[titleIndex].trim() : '';
    const looksLikeRoute = /^[#%]/.test(title);

    return {
      atoms,
      charge: Number(charge[1]),
      multiplicity: Number(charge[2]),
      name: title && !looksLikeRoute ? title : null,
      sourceLine: index + 1,
    };
  }
  return null;
}

function requireInteger(value, field, label) {
  if (!Number.isInteger(value)) {
    throw new QCSchemaError(`${label} is required for a QCSchema molecule and the run does not carry one.`, { field });
  }
  return value;
}

function normalizeAtoms(atoms) {
  const list = Array.isArray(atoms) ? atoms : [];
  if (list.length === 0) {
    throw new QCSchemaError('a QCSchema molecule needs at least one atom geometry, and this run carries none.', {
      field: 'molecule.geometry',
    });
  }
  return list.map((atom, index) => {
    if (!finiteCoords(atom)) {
      throw new QCSchemaError(`atom ${index + 1} has no finite x/y/z coordinates.`, { field: 'molecule.geometry' });
    }
    const element = titleCaseElement(atom.element);
    if (!element) {
      throw new QCSchemaError(`atom ${index + 1} has no element symbol.`, { field: 'molecule.symbols' });
    }
    return { element, x: atom.x, y: atom.y, z: atom.z };
  });
}

/**
 * Build the app-side molecule for an export: atoms, charge and multiplicity.
 * Atoms default to what the record parsed; charge and multiplicity have no
 * default on purpose — a missing one is a refusal, not a zero.
 */
export function moleculeFromRun(record, {
  atoms = null, charge = null, multiplicity = null, name = null,
  fragments = null, fragmentCharges = null, fragmentMultiplicities = null,
} = {}) {
  const list = normalizeAtoms(atoms ?? atomsFromRun(record)?.atoms ?? []);
  const molecule = {
    atoms: list,
    charge: requireInteger(charge, 'molecule.molecular_charge', 'the molecular charge'),
    multiplicity: requireInteger(multiplicity, 'molecule.molecular_multiplicity', 'the molecular multiplicity'),
  };
  if (name) molecule.name = String(name);
  if (fragments) molecule.fragments = fragments;
  if (fragmentCharges) molecule.fragmentCharges = fragmentCharges;
  if (fragmentMultiplicities) molecule.fragmentMultiplicities = fragmentMultiplicities;
  return molecule;
}

function moleculeBlock(molecule) {
  if (!molecule || typeof molecule !== 'object') {
    throw new QCSchemaError('the export needs a molecule (atoms, charge, multiplicity).', { field: 'molecule' });
  }
  const atoms = normalizeAtoms(molecule.atoms);
  const charge = requireInteger(molecule.charge, 'molecule.molecular_charge', 'the molecular charge');
  const multiplicity = requireInteger(molecule.multiplicity, 'molecule.molecular_multiplicity', 'the molecular multiplicity');
  if (multiplicity < 1) {
    throw new QCSchemaError('the molecular multiplicity must be at least 1.', { field: 'molecule.molecular_multiplicity' });
  }

  const geometry = [];
  for (const atom of atoms) {
    geometry.push(round(atom.x * BOHR_PER_ANGSTROM, BOHR_DECIMALS));
    geometry.push(round(atom.y * BOHR_PER_ANGSTROM, BOHR_DECIMALS));
    geometry.push(round(atom.z * BOHR_PER_ANGSTROM, BOHR_DECIMALS));
  }

  const block = {
    schema_name: QCSCHEMA_MOLECULE_SCHEMA_NAME,
    schema_version: QCSCHEMA_MOLECULE_SCHEMA_VERSION,
    symbols: atoms.map((atom) => atom.element),
    geometry,
    molecular_charge: charge,
    molecular_multiplicity: multiplicity,
  };
  if (molecule.name) block.name = String(molecule.name);
  if (molecule.comment) block.comment = String(molecule.comment);
  if (molecule.fragments !== undefined && molecule.fragments !== null) {
    const fragments = molecule.fragments;
    if (!Array.isArray(fragments) || !fragments.every((fragment) => Array.isArray(fragment)
      && fragment.every((index) => Number.isInteger(index) && index >= 0 && index < atoms.length))) {
      throw new QCSchemaError('fragments must be 0-based atom index lists that stay inside the molecule.', {
        field: 'molecule.fragments',
      });
    }
    block.fragments = fragments.map((fragment) => [...fragment]);
    if (Array.isArray(molecule.fragmentCharges)) {
      if (molecule.fragmentCharges.length !== fragments.length) {
        throw new QCSchemaError('fragment_charges must have one entry per fragment.', { field: 'molecule.fragment_charges' });
      }
      block.fragment_charges = molecule.fragmentCharges.map((value) => requireInteger(value, 'molecule.fragment_charges', 'a fragment charge'));
    }
    if (Array.isArray(molecule.fragmentMultiplicities)) {
      if (molecule.fragmentMultiplicities.length !== fragments.length) {
        throw new QCSchemaError('fragment_multiplicities must have one entry per fragment.', { field: 'molecule.fragment_multiplicities' });
      }
      block.fragment_multiplicities = molecule.fragmentMultiplicities
        .map((value) => requireInteger(value, 'molecule.fragment_multiplicities', 'a fragment multiplicity'));
    }
  }
  return block;
}

function methodBlockOf(record) {
  const block = record?.provenance?.method;
  return block && typeof block === 'object' && !Array.isArray(block) ? block : null;
}

const nonEmptyString = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * The model a run ran: method and basis from the engine's provenance block.
 * xTB names its method `hamiltonian`; a method with no separate basis (xTB,
 * composite methods) says `method-defined`, which is the sentinel the app's own
 * provenance uses — never a made-up basis-set name.
 */
function modelFor(record) {
  const block = methodBlockOf(record);
  const method = nonEmptyString(block?.functional) || nonEmptyString(block?.method) || nonEmptyString(block?.hamiltonian);
  if (!method) {
    throw new QCSchemaError('the run records no method, so model.method cannot be filled in honestly.', {
      field: 'model.method',
    });
  }
  const model = { method, basis: nonEmptyString(block?.basis) || 'method-defined' };
  const dispersion = nonEmptyString(block?.dispersion);
  if (dispersion) model.dispersion = dispersion;
  return model;
}

/**
 * QCSchema's `error` object only names three failure classes. A failure that is
 * none of them is left out rather than mislabelled.
 */
function errorBlockFor(record) {
  const text = [
    record?.parsed?.errorTermination?.message,
    record?.parsed?.errorTermination,
    record?.parsed?.termination,
    record?.error,
  ].filter((value) => typeof value === 'string').join(' ');
  const errorType = /converg/i.test(text) ? 'convergence_error'
    : /memory|alloc/i.test(text) ? 'memory_error'
      : /file|read|write|open/i.test(text) ? 'file_error'
        : null;
  if (!errorType) return null;
  return { error_type: errorType, error_message: text.trim().slice(0, 500) || 'the run did not complete' };
}

function extrasFor(record, { methodBlock = null } = {}) {
  const parsed = record?.parsed ?? {};
  const nodechem = {};
  if (record?.id !== undefined && record.id !== null) nodechem.run_id = String(record.id);
  if (typeof record?.engine === 'string' && record.engine) nodechem.engine = record.engine;
  if (record?.dryRun === true) nodechem.dry_run = true;
  if (typeof record?.provenance?.jobType === 'string' && record.provenance.jobType) {
    nodechem.job_type = record.provenance.jobType;
  }
  if (typeof parsed.termination === 'string' && parsed.termination) nodechem.termination = parsed.termination;
  if (typeof parsed.program?.name === 'string' && parsed.program.name) nodechem.program = parsed.program.name;
  if (record?.app?.commit) nodechem.app_commit = String(record.app.commit);
  if (record?.app?.version) nodechem.app_version = String(record.app.version);
  // The engine's solvation label is provenance, not a QCSchema field: keep it
  // in the open `extras` block instead of inventing a model key.
  if (typeof methodBlock?.solvation === 'string' && methodBlock.solvation) nodechem.solvation = methodBlock.solvation;

  const frequencies = parsed.frequencies;
  if (frequencies && Number.isInteger(frequencies.count) && frequencies.count > 0) {
    nodechem.frequencies = { count: frequencies.count };
    if (Number.isInteger(frequencies.imaginaryCount)) nodechem.frequencies.imaginary_count = frequencies.imaginaryCount;
  }

  const thermo = parsed.thermochemistry;
  if (thermo && typeof thermo === 'object') {
    const block = {};
    if (Number.isFinite(thermo.freeEnergyHartree)) block.free_energy_hartree = thermo.freeEnergyHartree;
    if (Number.isFinite(thermo.enthalpyHartree)) block.enthalpy_hartree = thermo.enthalpyHartree;
    if (Number.isFinite(thermo.zpeHartree)) block.zero_point_hartree = thermo.zpeHartree;
    if (Object.keys(block).length > 0) nodechem.thermochemistry = block;
  }

  return Object.keys(nodechem).length > 0 ? { nodechem } : {};
}

/**
 * Build a `qcschema_output` document from a finished run record.
 *
 * @param {object} record a `run.json`, as the runner and the cluster importer write it
 * @param {object} options
 * @param {object} options.molecule `{ atoms, charge, multiplicity, name?, fragments? }` (atoms in angstrom)
 * @param {number[]|null} [options.gradient] flat 3N gradient in Eh/bohr
 * @param {number[]|null} [options.hessian] flat (3N)² Hessian in Eh/bohr²
 * @param {object|null} [options.wavefunction] passed through only when the run really has one
 * @param {string|null} [options.version] creator version; defaults to the build that wrote the run
 * @param {string} [options.routine] what produced the document
 * @throws {QCSchemaError} `qcschema-refused` naming the missing field, or `qcschema-invalid`
 *   when the assembled document would not conform to the published schema
 */
export function atomicResultFromRun(record, {
  molecule = null,
  gradient = null,
  hessian = null,
  wavefunction = null,
  version = null,
  routine = 'ncs qcschema export',
} = {}) {
  if (!record || typeof record !== 'object' || !record.parsed || typeof record.parsed !== 'object') {
    throw new QCSchemaError('the export needs a run record (its `parsed` block is missing).', { field: 'record' });
  }

  const energy = record.parsed?.finalEnergy?.hartree;
  if (typeof energy !== 'number' || !Number.isFinite(energy)) {
    throw new QCSchemaError(
      'the run has no final energy, so QCSchema return_result cannot be filled in honestly.',
      { field: 'return_result' },
    );
  }

  const model = modelFor(record);
  const moleculeObject = moleculeBlock(molecule);

  if (gradient && hessian) {
    throw new QCSchemaError(
      'QCSchema has one return_result slot: pass a gradient or a hessian, not both.',
      { field: 'return_result' },
    );
  }

  const count = moleculeObject.symbols.length;
  let driver = 'energy';
  let returnResult = energy;
  if (gradient) {
    if (!Array.isArray(gradient) || gradient.length !== count * 3 || !gradient.every(Number.isFinite)) {
      throw new QCSchemaError(`a gradient must be a flat array of ${count * 3} numbers (3N, Eh/bohr).`, {
        field: 'return_result',
      });
    }
    driver = 'gradient';
    returnResult = [...gradient];
  }
  if (hessian) {
    if (!Array.isArray(hessian) || hessian.length !== (count * 3) ** 2 || !hessian.every(Number.isFinite)) {
      throw new QCSchemaError(`a hessian must be a flat array of ${(count * 3) ** 2} numbers ((3N)², Eh/bohr²).`, {
        field: 'return_result',
      });
    }
    driver = 'hessian';
    returnResult = [...hessian];
  }

  const success = record.parsed?.status === 'completed';
  // A dry run is a labelled fixture, not a calculation: say so where a consumer
  // reads provenance, not only in `extras`.
  const label = nonEmptyString(routine) || 'ncs qcschema export';
  const provenance = {
    creator: 'NodeChem Studio',
    version: nonEmptyString(version) || nonEmptyString(record.app?.version) || 'unknown',
    routine: record.dryRun === true ? `${label} (dry run)` : label,
    engine: nonEmptyString(record.engine) || 'unknown',
    method: model.method,
    basis: model.basis,
    run_id: record.id === undefined || record.id === null ? '' : String(record.id),
  };
  if (model.dispersion) provenance.dispersion = model.dispersion;

  const doc = {
    schema_name: QCSCHEMA_SCHEMA_NAME,
    schema_version: QCSCHEMA_SCHEMA_VERSION,
    molecule: moleculeObject,
    driver,
    model,
    keywords: {},
    provenance,
    properties: { return_energy: energy },
    success,
    return_result: returnResult,
  };

  const errorBlock = success ? null : errorBlockFor(record);
  if (errorBlock) doc.error = errorBlock;
  if (wavefunction) doc.wavefunction = wavefunction;
  const extras = extrasFor(record, { methodBlock: methodBlockOf(record) });
  if (Object.keys(extras).length > 0) doc.extras = extras;

  const verdict = validateQcschemaOutput(doc);
  if (!verdict.ok) {
    const [first] = verdict.errors;
    throw new QCSchemaError(
      `the document does not conform to the published qcschema_output schema: ${first.path} ${first.message}`,
      { code: 'qcschema-invalid', field: first.path, errors: verdict.errors },
    );
  }
  return doc;
}

/** Serialise an AtomicResult the way the CLI writes it. */
export function stringifyQcschema(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* ── Reading ────────────────────────────────────────────────── */

function refusal(code, field, message, extra = {}) {
  return { ok: false, code, field, message, ...extra };
}

function moleculeFromDocument(doc) {
  const molecule = doc?.molecule;
  if (!molecule || typeof molecule !== 'object' || Array.isArray(molecule)) {
    return { error: refusal('qcschema-invalid', 'molecule', 'the document has no molecule object') };
  }
  const symbols = molecule.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { error: refusal('qcschema-invalid', 'molecule.symbols', 'the molecule has no symbols') };
  }
  const geometry = molecule.geometry;
  if (!Array.isArray(geometry) || geometry.length !== symbols.length * 3
    || !geometry.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return {
      error: refusal('qcschema-invalid', 'molecule.geometry',
        `the molecule geometry must be a flat array of ${symbols.length * 3} bohr coordinates`),
    };
  }
  if (!Number.isInteger(molecule.molecular_charge)) {
    return {
      error: refusal('qcschema-invalid', 'molecule.molecular_charge',
        'the molecule states no molecular_charge; QCSchema defaults it to 0, but the app will not assume a charge'),
    };
  }
  if (!Number.isInteger(molecule.molecular_multiplicity)) {
    return {
      error: refusal('qcschema-invalid', 'molecule.molecular_multiplicity',
        'the molecule states no molecular_multiplicity; QCSchema defaults it to 1, but the app will not assume one'),
    };
  }

  const atoms = symbols.map((symbol, index) => {
    const element = titleCaseElement(symbol);
    return {
      element: element || String(symbol),
      x: round(geometry[index * 3] * ANGSTROM_PER_BOHR, ANGSTROM_DECIMALS),
      y: round(geometry[index * 3 + 1] * ANGSTROM_PER_BOHR, ANGSTROM_DECIMALS),
      z: round(geometry[index * 3 + 2] * ANGSTROM_PER_BOHR, ANGSTROM_DECIMALS),
    };
  });

  const info = {
    symbols: symbols.map(String),
    geometryBohr: [...geometry],
    charge: molecule.molecular_charge,
    multiplicity: molecule.molecular_multiplicity,
    atoms,
  };
  if (molecule.name) info.name = String(molecule.name);
  if (Array.isArray(molecule.fragments)) info.fragments = molecule.fragments.map((fragment) => (Array.isArray(fragment) ? [...fragment] : []));
  if (Array.isArray(molecule.fragment_charges)) info.fragmentCharges = [...molecule.fragment_charges];
  if (Array.isArray(molecule.fragment_multiplicities)) info.fragmentMultiplicities = [...molecule.fragment_multiplicities];
  return { molecule: info };
}

function modelFromDocument(doc) {
  const model = doc?.model;
  const method = nonEmptyString(model?.method);
  if (!method) {
    return { error: refusal('qcschema-invalid', 'model.method', 'the document states no model.method') };
  }
  const basis = nonEmptyString(model?.basis);
  const result = { method };
  if (basis) result.basis = basis;
  const dispersion = nonEmptyString(model?.dispersion);
  if (dispersion) result.dispersion = dispersion;
  return { model: result };
}

function readResult(doc) {
  const molecule = moleculeFromDocument(doc);
  if (molecule.error) return molecule.error;

  const model = modelFromDocument(doc);
  if (model.error) return model.error;

  if (!Object.prototype.hasOwnProperty.call(doc, 'return_result')) {
    return refusal('qcschema-invalid', 'return_result', 'the document has no return_result');
  }
  if (typeof doc.success !== 'boolean') {
    return refusal('qcschema-invalid', 'success', 'the document states no success flag');
  }
  const driver = doc.driver;
  if (!['energy', 'gradient', 'hessian'].includes(driver)) {
    return refusal('qcschema-invalid', 'driver', `driver ${JSON.stringify(driver)} is not energy, gradient or hessian`);
  }

  // The structural checks above name the field; the published schema then
  // catches everything else (wrong types, fields it forbids, bad patterns).
  const verdict = validateQcschemaOutput(doc);
  if (!verdict.ok) {
    const [first] = verdict.errors;
    return refusal('qcschema-invalid', first.path === '/' ? 'document' : first.path,
      `${first.path} ${first.message}`, { errors: verdict.errors });
  }

  const count = molecule.molecule.symbols.length;
  const warnings = [];
  let gradient = null;
  let hessian = null;
  if (driver === 'gradient') {
    const values = doc.return_result;
    if (!Array.isArray(values) || values.length !== count * 3) {
      return refusal('qcschema-invalid', 'return_result',
        `a gradient return_result must hold ${count * 3} numbers (3N) for this molecule`);
    }
    gradient = { units: 'Eh/bohr', values: [...values], shape: [count * 3] };
    warnings.push('return_result is the gradient in Eh/bohr, not an energy; properties.return_energy carries the energy.');
  }
  if (driver === 'hessian') {
    const values = doc.return_result;
    if (!Array.isArray(values) || values.length !== (count * 3) ** 2) {
      return refusal('qcschema-invalid', 'return_result',
        `a hessian return_result must hold ${(count * 3) ** 2} numbers ((3N)²) for this molecule`);
    }
    hessian = { units: 'Eh/bohr^2', values: [...values], shape: [count * 3, count * 3] };
    warnings.push('return_result is the Hessian in Eh/bohr², not an energy; properties.return_energy carries the energy.');
  }

  const properties = doc.properties && typeof doc.properties === 'object' ? doc.properties : {};
  const returnEnergy = properties.return_energy;
  const energyHartree = typeof returnEnergy === 'number' && Number.isFinite(returnEnergy) ? returnEnergy
    : driver === 'energy' && typeof doc.return_result === 'number' && Number.isFinite(doc.return_result)
      ? doc.return_result
      : null;
  if (energyHartree === null) {
    warnings.push('the document carries no energy: properties.return_energy is absent and return_result is not a number.');
  }
  if (doc.success === false) warnings.push('the document says success: false.');

  const nodechem = doc.extras?.nodechem && typeof doc.extras.nodechem === 'object' ? doc.extras.nodechem : null;
  const dryRun = nodechem?.dry_run === true;
  if (dryRun) warnings.push('this document was written from a dry run: it is a labelled fixture, not a calculation.');
  // The run id lives in provenance when this app wrote the file, and in extras
  // when an older writer put it there; either is evidence, neither is guessed.
  const runId = nonEmptyString(doc.provenance?.run_id)
    || (nodechem && typeof nodechem.run_id === 'string' ? nodechem.run_id : null);

  return {
    ok: true,
    kind: 'result',
    schemaName: doc.schema_name,
    schemaVersion: doc.schema_version,
    driver,
    success: doc.success,
    molecule: molecule.molecule,
    atoms: molecule.molecule.atoms,
    model: model.model,
    energyHartree,
    gradient,
    hessian,
    properties,
    provenance: doc.provenance && typeof doc.provenance === 'object' ? doc.provenance : null,
    extras: doc.extras && typeof doc.extras === 'object' ? doc.extras : null,
    wavefunction: doc.wavefunction ?? null,
    hasWavefunction: Boolean(doc.wavefunction),
    dryRun,
    runId,
    warnings,
  };
}

function readInput(doc) {
  const molecule = moleculeFromDocument(doc);
  if (molecule.error) return molecule.error;
  const model = modelFromDocument(doc);
  if (model.error) return model.error;
  const keywordVerdict = validateQcschemaMolecule(doc.molecule);
  if (!keywordVerdict.ok) {
    const [first] = keywordVerdict.errors;
    return refusal('qcschema-invalid', first.path === '/' ? 'molecule' : first.path,
      `${first.path} ${first.message}`, { errors: keywordVerdict.errors });
  }
  const warnings = ['a qcschema_input carries no result: no energy, gradient or Hessian was read.'];
  return {
    ok: true,
    kind: 'input',
    schemaName: doc.schema_name,
    schemaVersion: doc.schema_version,
    driver: typeof doc.driver === 'string' ? doc.driver : null,
    success: null,
    molecule: molecule.molecule,
    atoms: molecule.molecule.atoms,
    model: model.model,
    energyHartree: null,
    gradient: null,
    hessian: null,
    properties: doc.properties && typeof doc.properties === 'object' ? doc.properties : {},
    provenance: doc.provenance && typeof doc.provenance === 'object' ? doc.provenance : null,
    extras: doc.extras && typeof doc.extras === 'object' ? doc.extras : null,
    wavefunction: null,
    hasWavefunction: false,
    dryRun: false,
    runId: null,
    warnings,
  };
}

/**
 * Read a QCSchema document into the app's vocabulary.
 *
 * `qcschema_output` becomes a result (molecule in angstrom, energy in hartree,
 * derivatives labelled with their units); `qcschema_input` becomes its molecule
 * and nothing else. Never throws for a bad document: the refusal says which
 * field and why, so a CLI can print it and a caller can decide.
 */
export function readQcschema(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return refusal('qcschema-invalid', 'document', 'the file is not a JSON object');
  }
  const name = doc.schema_name;
  if (name === QCSCHEMA_SCHEMA_NAME || name === 'qc_schema_output') return readResult(doc);
  if (name === 'qcschema_input' || name === 'qc_schema_input') return readInput(doc);
  return refusal('qcschema-unsupported', 'schema_name',
    `schema_name ${JSON.stringify(name)} is not qcschema_output or qcschema_input`);
}

/**
 * The structure record the viewer, the structure importer and the converters
 * already consume: atoms in angstrom, charge, multiplicity, a name.
 */
export function structureFromQcschema(verdict) {
  if (!verdict?.ok) {
    throw new QCSchemaError(`there is no readable QCSchema structure: ${verdict?.message || 'unknown refusal'}.`, {
      code: verdict?.code || 'qcschema-invalid', field: verdict?.field || null,
    });
  }
  const structure = {
    format: 'qcschema',
    name: verdict.molecule.name || verdict.runId || 'QCSchema structure',
    atoms: verdict.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z })),
    charge: verdict.molecule.charge,
    multiplicity: verdict.molecule.multiplicity,
    warnings: [],
  };
  return structure;
}

/**
 * The run-record fields a QCSchema result can fill, and only those. This is a
 * patch, not a record: the record contract needs runner evidence a document
 * does not carry, and nothing here is defaulted to make a record look complete.
 */
export function recordPatchFromQcschema(verdict) {
  if (!verdict?.ok) {
    throw new QCSchemaError(`there is no readable QCSchema result: ${verdict?.message || 'unknown refusal'}.`, {
      code: verdict?.code || 'qcschema-invalid', field: verdict?.field || null,
    });
  }
  const patch = {
    provenance: {
      // A dry-run document says so in its own extras; carrying that through is
      // the difference between "this is a calculation" and "this is a fixture".
      kind: verdict.dryRun ? 'fixture' : 'calculation',
      method: {
        functional: verdict.model.method,
        ...(verdict.model.basis ? { basis: verdict.model.basis } : {}),
        ...(verdict.model.dispersion ? { dispersion: verdict.model.dispersion } : {}),
      },
    },
  };
  const engine = nonEmptyString(verdict.provenance?.engine);
  if (engine && ENGINE_IDS.includes(engine)) patch.engine = engine;
  if (verdict.kind === 'result' && verdict.energyHartree !== null) {
    patch.parsed = { finalEnergy: { hartree: verdict.energyHartree, source: 'qcschema' } };
  }
  return patch;
}
