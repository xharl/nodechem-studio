import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { RECORD_SCHEMA_VERSION, recordSchemaPath, recordSchemaVersions, validateRecord } from '../schemas/record-schema.js';

/**
 * `ncs export` is the machine door onto run folders. These tests drive the real
 * CLI: one export over staged records, the refusal paths, and one end-to-end
 * export of a dry run the CLI itself wrote.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'ncs.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'run-record');

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ncs-export-'));
  tempDirs.push(dir);
  return dir;
}

async function ncs(args, options = {}) {
  try {
    const result = await run(process.execPath, [CLI, ...args], { cwd: ROOT, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

/** Copy the record fixtures into `<out>/runs/<id>/run.json`, as a run leaves them. */
async function stageRecords() {
  const out = await tempDir();
  const records = [];
  for (const name of ['gaussian-dry-run.json', 'xtb-dry-run.json']) {
    const record = JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'));
    const dir = path.join(out, 'runs', record.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push(record);
  }
  return { out, records };
}

describe('ncs export', () => {
  it('prints every record in one versioned envelope', async () => {
    const { out, records } = await stageRecords();
    const result = await ncs(['export', out, '--json']);
    expect(result.code).toBe(0);

    const envelope = JSON.parse(result.stdout);
    expect(envelope.kind).toBe('nodechem-studio.records');
    // The default export names the newest contract this build ships. The
    // records themselves still declare the version they were written for.
    expect(envelope.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(envelope.schema).toBe(recordSchemaPath(RECORD_SCHEMA_VERSION));
    expect(envelope.recordCount).toBe(2);
    expect(envelope.records.map((record) => record.id)).toEqual(records.map((record) => record.id).sort());
    // The record is exported unchanged, not reshaped.
    expect(envelope.records).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
    for (const record of envelope.records) {
      expect(validateRecord(record).errors, record.id).toEqual([]);
    }
  });

  it('accepts an explicit known schema version', async () => {
    const { out } = await stageRecords();
    const result = await ncs(['export', out, '--json', '--schema-version', '1']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).schemaVersion).toBe(1);
  });

  it('refuses an unknown schema version and prints the schema path', async () => {
    const { out } = await stageRecords();
    const result = await ncs(['export', out, '--json', '--schema-version', '9']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unsupported run-record schema version "9"');
    expect(result.stderr).toContain(`this build ships version ${recordSchemaVersions().join(', ')}`);
    expect(result.stderr).toContain(recordSchemaPath(RECORD_SCHEMA_VERSION));
  });

  it('refuses a bare --schema-version as a usage error', async () => {
    const { out } = await stageRecords();
    const result = await ncs(['export', out, '--schema-version']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--schema-version needs a version number');
  });

  it('refuses the whole export when one record does not conform', async () => {
    const { out, records } = await stageRecords();
    const broken = { ...records[0], status: 'finished' };
    await fs.writeFile(
      path.join(out, 'runs', broken.id, 'run.json'),
      `${JSON.stringify(broken, null, 2)}\n`,
      'utf8',
    );
    const result = await ncs(['export', out, '--json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    const refusal = JSON.parse(result.stderr.slice(0, result.stderr.lastIndexOf('}') + 1));
    expect(refusal.code).toBe('record-invalid');
    expect(refusal.schema).toBe(recordSchemaPath(RECORD_SCHEMA_VERSION));
    expect(refusal.failures.map((failure) => failure.runId)).toEqual([broken.id]);
    expect(refusal.failures[0].errors.some((error) => error.path === '/status')).toBe(true);
  });

  it('writes the envelope to --out and prints the path', async () => {
    const { out } = await stageRecords();
    const target = path.join(await tempDir(), 'exports', 'records.json');
    const result = await ncs(['export', out, '--out', target]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(target);
    const envelope = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(envelope.recordCount).toBe(2);
  });

  it('refuses a folder with no runs directory', async () => {
    const empty = await tempDir();
    const result = await ncs(['export', empty, '--json']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('there is no runs folder');
  });

  it('exports a dry run the CLI wrote, and the record conforms', async () => {
    const out = await tempDir();
    const ran = await ncs(['run', path.join(ROOT, 'examples', 'single-point.ncs'), '--out', out, '--dry-run'], { timeout: 60_000 });
    expect(ran.code, ran.stderr).toBe(0);

    const result = await ncs(['export', out, '--json', '--schema-version', '1']);
    expect(result.code, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.recordCount).toBe(1);
    const [record] = envelope.records;
    expect(record.schemaVersion).toBe(1);
    expect(record.dryRun).toBe(true);
    expect(record.engine).toBe('gaussian');
    expect(validateRecord(record).errors).toEqual([]);
  }, 60_000);
});
