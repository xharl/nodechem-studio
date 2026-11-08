import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECORD_SCHEMA_VERSION,
  loadRecordSchema,
  recordSchemaPath,
  recordSchemaVersions,
  validateRecord,
} from '../schemas/record-schema.js';

/**
 * The run-record contract is only worth publishing if a real record passes it.
 * These tests validate the two dry-run records in `test/fixtures/run-record/`
 * (one Gaussian, one xTB), then check that the schema declares exactly the
 * top-level fields those records carry -- no invented field, no omitted one.
 *
 * Version 2 adds a second record kind (issue #131). The run branch is v1
 * verbatim, so the field-coverage checks below run against `$defs.runRecord`
 * and every fixture must still validate under both versions.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'run-record');
const PYTHON_FIXTURE = path.join(
  ROOT, 'clients', 'python', 'tests', 'fixtures', 'runs', '20260101-120000-abc123', 'run.json',
);

const fixtureFiles = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).sort();
const fixtures = fixtureFiles.map((name) => ({
  name,
  record: JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')),
}));

const schema = loadRecordSchema(RECORD_SCHEMA_VERSION);
const runSchema = schema.$defs.runRecord;
const v1Schema = loadRecordSchema(1);

/**
 * Fields the writers can emit that neither dry-run fixture happened to
 * produce. Each one is exercised below; anything else missing from a fixture
 * would mean the schema describes a record the app does not write.
 */
const OPTIONAL_TOP_LEVEL = new Set(['conformer']);

describe('run-record schema — publication', () => {
  it('is a draft 2020-12 schema with a version and an id', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toMatch(/run-record\.v2\.schema\.json$/);
    expect(schema['x-nodechem'].schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(schema['x-nodechem'].recordFile).toBe('run.json');
    expect(schema['x-nodechem'].supersedes).toBe(1);
    expect(recordSchemaVersions()).toEqual([1, 2]);
    expect(recordSchemaPath(1)).toBe(path.join(ROOT, 'schemas', 'run-record.v1.schema.json'));
    expect(recordSchemaPath(2)).toBe(path.join(ROOT, 'schemas', 'run-record.v2.schema.json'));
    expect(fs.existsSync(recordSchemaPath(1))).toBe(true);
    expect(fs.existsSync(recordSchemaPath(2))).toBe(true);
  });

  it('leaves v1 as published: no record kind, closed envelope', () => {
    expect(v1Schema.properties.kind).toBeUndefined();
    expect(v1Schema.additionalProperties).toBe(false);
    expect(v1Schema.required).toEqual(runSchema.required);
    expect(v1Schema.properties).toEqual(runSchema.properties);
  });

  it('refuses an unknown version and names the versions it ships', () => {
    expect(recordSchemaPath(3)).toBe(null);
    expect(() => loadRecordSchema(3)).toThrow(/Unknown run-record schema version 3.*version 1, 2/);
    expect(() => validateRecord({}, { version: 7 })).toThrow(/Unknown run-record schema version 7/);
  });
});

describe('run-record schema — real records', () => {
  it('has both engine fixtures', () => {
    expect(fixtureFiles).toEqual(['gaussian-dry-run.json', 'xtb-dry-run.json']);
  });

  for (const { name, record } of fixtures) {
    it(`validates ${name} under v1 and v2`, () => {
      const verdict = validateRecord(record);
      expect(verdict.errors, name).toEqual([]);
      expect(verdict.ok, name).toBe(true);
      expect(validateRecord(record, { version: 1 }).errors, name).toEqual([]);
      // A run is still written to the v1 contract; v2 only adds a branch.
      expect(record.schemaVersion, `${name} declares the run contract`).toBe(1);
      expect(record.dryRun, `${name} is a dry run, not a calculation`).toBe(true);
    });
  }

  it('validates the Python client fixture', () => {
    const record = JSON.parse(fs.readFileSync(PYTHON_FIXTURE, 'utf8'));
    expect(validateRecord(record).errors).toEqual([]);
  });
});

describe('run-record schema — field coverage', () => {
  const declared = new Set(Object.keys(runSchema.properties));
  const observed = new Set();
  for (const { record } of fixtures) {
    for (const key of Object.keys(record)) observed.add(key);
  }

  it('declares every top-level key a record fixture carries', () => {
    const missing = [...observed].filter((key) => !declared.has(key)).sort();
    expect(missing, 'fields run.json writes but the schema omits').toEqual([]);
  });

  it('declares no top-level field that no writer emits', () => {
    const phantom = [...declared]
      .filter((key) => !observed.has(key) && !OPTIONAL_TOP_LEVEL.has(key))
      .sort();
    expect(phantom, 'schema fields no fixture or writer produces').toEqual([]);
  });

  it('validates the optional conformer block the runner can add', () => {
    const record = JSON.parse(JSON.stringify(fixtures[0].record));
    record.conformer = {
      nodeId: 'crest-1',
      title: 'Conformer search',
      generator: 'crest',
      id: 'm001',
      relativeKcal: 0,
      population: 0.62,
      protomer: 'p1',
      spreadKcal: 1.4,
    };
    expect(validateRecord(record).errors).toEqual([]);
    delete record.conformer.spreadKcal;
    expect(validateRecord(record).errors).not.toEqual([]);
  });

  it('requires every envelope field, and accepts a record without schemaVersion', () => {
    for (const key of runSchema.required) {
      const record = JSON.parse(JSON.stringify(fixtures[1].record));
      delete record[key];
      const verdict = validateRecord(record);
      expect(verdict.ok, `a record missing required "${key}" must be refused`).toBe(false);
      expect(verdict.errors.some((error) => error.message.includes(`"${key}"`))).toBe(true);
    }
    // The field is additive: records written before the contract, and cluster
    // imports from older builds, do not carry it.
    const preContract = JSON.parse(JSON.stringify(fixtures[1].record));
    delete preContract.schemaVersion;
    expect(validateRecord(preContract).errors).toEqual([]);
  });
});

describe('run-record schema — refusals', () => {
  const base = () => JSON.parse(JSON.stringify(fixtures[0].record));

  it('refuses an unknown top-level field', () => {
    const record = base();
    record.surprise = 1;
    const verdict = validateRecord(record);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((error) => error.path === '/surprise')).toBe(true);
  });

  it('refuses a wrong status, a non-numeric energy and a bad gate result', () => {
    const status = base();
    status.status = 'done';
    expect(validateRecord(status).errors.some((error) => error.path === '/status')).toBe(true);

    const energy = base();
    energy.parsed.finalEnergy.hartree = '-76';
    expect(validateRecord(energy).errors.some((error) => error.path === '/parsed/finalEnergy/hartree')).toBe(true);

    const gate = base();
    gate.gates.gates[0].result = 'maybe';
    expect(validateRecord(gate).errors.some((error) => error.path.endsWith('/result'))).toBe(true);
  });

  it('refuses a malformed hash and a non-object record', () => {
    const record = base();
    record.inputSha256 = 'not-a-hash';
    expect(validateRecord(record).errors.some((error) => error.path === '/inputSha256')).toBe(true);
    expect(validateRecord([]).ok).toBe(false);
    expect(validateRecord(null).ok).toBe(false);
  });
});
