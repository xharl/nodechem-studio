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
const OPTIONAL_TOP_LEVEL = new Set(['conformer', 'record', 'series', 'spectrumOverlay', 'timeout', 'dp4', 'spectrumAssignment', 'wavefunction']);

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

  it('validates the record and series blocks the runner can add, and refuses a null', () => {
    const record = JSON.parse(JSON.stringify(fixtures[0].record));
    record.record = { id: 'm3', label: 'molecule 3', datasetId: 'monomers' };
    record.series = {
      parentId: 'ethene',
      n: 3,
      count: 6,
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [3, 6] },
    };
    expect(validateRecord(record).errors).toEqual([]);
    // A member without a number is not a derivation: n and count are required.
    const bare = JSON.parse(JSON.stringify(record));
    delete bare.series.count;
    expect(validateRecord(bare).errors.some((error) => error.path === '/series/count')).toBe(true);
    // Absent, not null: the writers never emit a null identity.
    const nulled = JSON.parse(JSON.stringify(fixtures[0].record));
    nulled.record = null;
    expect(validateRecord(nulled).ok).toBe(false);
  });

  it('validates a timed-out record and refuses an invented one (issue 177)', () => {
    const record = JSON.parse(JSON.stringify(fixtures[0].record));
    record.status = 'timed out';
    record.parsed = null;
    record.gates = null;
    record.exitCode = null;
    record.timeout = {
      limitSeconds: 60,
      elapsedSeconds: 60.4,
      lastOutput: ' SCF Done:  E(RB3LYP) = -76.0267608317',
      tree: { escalated: false, survived: false },
    };
    expect(validateRecord(record).errors).toEqual([]);
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    // `timed out` must not be read as a failure that carries a result.
    expect(record.parsed).toBe(null);
    // A limit below 1 s, a negative elapsed time, or a missing last output is
    // not a record of a stop: the schema refuses it rather than rounding it.
    for (const mutate of [
      (copy) => { copy.timeout.limitSeconds = 0; },
      (copy) => { copy.timeout.elapsedSeconds = -1; },
      (copy) => { delete copy.timeout.lastOutput; },
    ]) {
      const bad = JSON.parse(JSON.stringify(record));
      mutate(bad);
      expect(validateRecord(bad).ok, JSON.stringify(bad.timeout)).toBe(false);
    }
  });

  it('validates the DP4+ block a compute block records, and refuses an empty one (issue 165)', () => {
    const record = JSON.parse(JSON.stringify(fixtures[0].record));
    record.dp4 = {
      available: true,
      status: 'computed',
      expression: 'DP4+ full (unscaled × scaled) over 27 measured shifts',
      code: null,
      reason: null,
      variant: 'full',
      level: { id: 'mPW1PW91/6-31+G(d,p)', solvation: 'PCM', solvent: 'CHCl3' },
      candidates: [{ id: '01', percent: 99.999203, conformerCount: 15 }],
      excluded: [],
      checks: { sumOfProbabilities: 1 },
    };
    expect(validateRecord(record).errors).toEqual([]);
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    // The block is a table, but `available` is the one thing a reader needs to
    // tell a comparison from an empty object: the schema requires it.
    const empty = JSON.parse(JSON.stringify(record));
    empty.dp4 = {};
    expect(validateRecord(empty).ok).toBe(false);
    expect(validateRecord(empty).errors.some((error) => error.path.startsWith('/dp4'))).toBe(true);
  });

  it('validates the spectrum-assignment block a record carries, and refuses an empty one (issue 348)', () => {
    const record = JSON.parse(JSON.stringify(fixtures[0].record));
    record.spectrumAssignment = {
      available: true,
      quantity: 'vcd',
      fwhmCm: 12,
      metric: { id: 'ncs-spectrum-match', version: 1 },
      candidates: [{ id: 'A', label: 'A', kind: 'conformer-set', memberCount: 2 }],
      ranking: ['A', 'B'],
      margin: { combined: 0.21 },
    };
    record.provenance.spectrumAssignment = { kind: 'spectrum-assignment', available: true };
    expect(validateRecord(record).errors).toEqual([]);
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    // As with DP4+, `available` is what separates a comparison from an empty
    // object; the rest of the result is the procedure's own table.
    const empty = JSON.parse(JSON.stringify(record));
    empty.spectrumAssignment = {};
    expect(validateRecord(empty).ok).toBe(false);
    expect(validateRecord(empty).errors.some((error) => error.path.startsWith('/spectrumAssignment'))).toBe(true);
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

  it('accepts a PySCF record at version 1, because v1 describes every engine this build writes', () => {
    // Issue 335: the v1 description listed gaussian/xtb/orca/psi4 only, so a
    // PySCF record exported with `--schema-version 1` named an engine the contract
    // did not mention.
    const record = base();
    record.engine = 'pyscf';
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    expect(validateRecord(record, { version: 2 }).errors).toEqual([]);
  });

  it('carries the wavefunction block on both versions (issue 334)', () => {
    const record = base();
    record.wavefunction = {
      version: 1,
      artifacts: [{ kind: 'fchk', file: 'he.fchk', sha256: 'a'.repeat(64), bytes: 42 }],
      fchk: { format: 'fchk' },
    };
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    expect(validateRecord(record, { version: 2 }).errors).toEqual([]);

    const broken = base();
    broken.wavefunction = { version: 1, artifacts: [{ kind: 'chk', file: 'x', sha256: 'nope', bytes: 1 }] };
    expect(validateRecord(broken, { version: 1 }).errors.length).toBeGreaterThan(0);
  });
});
