/**
 * The run-record contract, versions 1 and 2.
 *
 * `run-record.v1.schema.json` is the public description of the `run.json` the
 * runners write; `run-record.v2.schema.json` is the same document plus one
 * record kind that is not a run at all. This module is the one place that knows
 * which schema file belongs to which version, and it carries a small
 * dependency-free validator so the CLI can refuse to export a record that does
 * not conform. The validator implements the JSON Schema keywords the record
 * schemas use — not the whole standard. A schema change that needs a new
 * keyword must extend this file in the same commit.
 *
 * Why v2 rather than an extra field in v1: v1's envelope is closed and carries
 * no `kind`, and its `provenance.kind` enum is closed too, so there is no
 * extension point a second record shape could use. v2 is a tagged union whose
 * run branch is v1 verbatim: the two property maps are the same object, so a
 * document written for one validates against the other.
 *
 * v1 gains only *optional* properties (issue 193 added `record` and `series`),
 * never a new required field and never a changed type, so every document
 * written before that change still validates against the version it was
 * written for.
 *
 * Why not a JSON Schema library: the app has no runtime dependencies, and the
 * test that validates real records must exercise the same code the CLI runs.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The newest record contract this build writes and exports by default. */
export const RECORD_SCHEMA_VERSION = 2;

/** Version → file. A new major adds an entry; old files stay in the tree. */
export const RECORD_SCHEMA_FILES = Object.freeze({
  1: 'run-record.v1.schema.json',
  2: 'run-record.v2.schema.json',
});

export class RecordSchemaError extends Error {
  constructor(message, { version = null, file = null } = {}) {
    super(message);
    this.name = 'RecordSchemaError';
    this.code = 'record-schema-invalid';
    this.version = version;
    this.file = file;
  }
}

/** Absolute path of the schema file for a version, or `null` when unknown. */
export function recordSchemaPath(version = RECORD_SCHEMA_VERSION) {
  const file = RECORD_SCHEMA_FILES[version];
  if (!file) return null;
  return fileURLToPath(new URL(file, import.meta.url));
}

/** Every version this build can export. */
export function recordSchemaVersions() {
  return Object.keys(RECORD_SCHEMA_FILES).map(Number).sort((a, b) => a - b);
}

/** Load and parse a schema version. Throws when the version is unknown. */
export function loadRecordSchema(version = RECORD_SCHEMA_VERSION) {
  const path = recordSchemaPath(version);
  if (!path) {
    const known = recordSchemaVersions().join(', ');
    throw new RecordSchemaError(
      `Unknown run-record schema version ${JSON.stringify(version)}; this build ships version ${known}.`,
      { version, file: null },
    );
  }
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RecordSchemaError(`Cannot read ${path}: ${error.message}`, { version, file: path });
  }
}

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
  if (!ref.startsWith('#/')) throw new RecordSchemaError(`Only local $ref values are supported, got ${ref}.`);
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[key];
  }
  if (node === undefined) throw new RecordSchemaError(`Unresolved $ref ${ref}.`);
  return node;
}

/**
 * Validate one value against a schema. Returns `{ ok, errors }`, where each
 * error is `{ path, message }` and `path` is a JSON pointer into the record.
 */
export function validateAgainstSchema(value, schema, root = schema, path = '') {
  const errors = [];
  const add = (pointerPath, message) => errors.push({ path: pointerPath || '/', message });

  if (schema === true || schema === undefined) return { ok: true, errors };
  if (schema === false) {
    add(path, 'no value is allowed here');
    return { ok: false, errors };
  }

  if (schema.$ref) {
    return validateAgainstSchema(value, resolveRef(schema.$ref, root), root, path);
  }

  if (schema.const !== undefined && value !== schema.const) {
    add(path, `must be ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    add(path, `must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      add(path, `must be ${types.join(' or ')}`);
      // A wrong type makes the rest of this schema's assertions noise.
      return { ok: errors.length === 0, errors };
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) add(path, `must be >= ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) add(path, `must be <= ${schema.maximum}`);
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      add(path, `must be at least ${schema.minLength} characters`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      add(path, `must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      add(path, `must match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      add(path, `must contain at least ${schema.minItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        const result = validateAgainstSchema(entry, schema.items, root, pointer(path, index));
        errors.push(...result.errors);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) add(pointer(path, key), `is missing required property "${key}"`);
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, entry] of Object.entries(value)) {
      const target = pointer(path, key);
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const result = validateAgainstSchema(entry, properties[key], root, target);
        errors.push(...result.errors);
      } else if (schema.additionalProperties === false) {
        add(target, 'is not part of the run-record schema');
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const result = validateAgainstSchema(entry, schema.additionalProperties, root, target);
        errors.push(...result.errors);
      }
    }
  }

  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    errors.push(...validateAgainstSchema(value, branch, root, path).errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((branch) => validateAgainstSchema(value, branch, root, path));
    if (!results.some((result) => result.ok)) {
      add(path, 'must match at least one allowed shape');
      // Keep the finest-grained branch errors: a caller editing a record needs
      // the pointer to the wrong leaf, not just "this object is wrong".
      const closest = results
        .slice()
        .sort((a, b) => a.errors.length - b.errors.length)[0];
      if (closest && closest.errors.length > 0) errors.push(...closest.errors);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((branch) => validateAgainstSchema(value, branch, root, path));
    const matches = results.filter((result) => result.ok);
    if (matches.length !== 1) {
      add(path, `must match exactly one allowed shape (matched ${matches.length})`);
      if (matches.length === 0) {
        const closest = results
          .slice()
          .sort((a, b) => a.errors.length - b.errors.length)[0];
        if (closest && closest.errors.length > 0) errors.push(...closest.errors);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a run record against a published schema version.
 *
 * Returns `{ ok, errors, schemaVersion, schema }` — never throws for an
 * invalid record; a missing schema file is a programming error and throws.
 */
export function validateRecord(record, { version = RECORD_SCHEMA_VERSION } = {}) {
  const schema = loadRecordSchema(version);
  const result = validateAgainstSchema(record, schema);
  return {
    ok: result.ok,
    errors: result.errors,
    schemaVersion: version,
    schema: recordSchemaPath(version),
  };
}
