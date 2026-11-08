import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { validateQcschemaOutput } from '../src/shared/qcschema.js';

/**
 * `ncs qcschema` is the machine door onto QCSchema. These tests drive the real
 * CLI: an export of a dry run the CLI itself wrote, a read-back of that file,
 * the refusal paths and their machine-readable codes.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'ncs.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'qcschema');

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ncs-qcschema-'));
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

/** The JSON refusal a command writes to stderr, before the human sentence. */
function refusal(stderr) {
  const start = stderr.indexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`no JSON on stderr: ${stderr}`);
  return JSON.parse(stderr.slice(start, end + 1));
}

async function dryRun() {
  const out = await tempDir();
  const result = await ncs(['run', path.join(ROOT, 'examples', 'single-point.ncs'), '--out', out, '--dry-run'], { timeout: 60_000 });
  expect(result.code, result.stderr).toBe(0);
  const runs = await fs.readdir(path.join(out, 'runs'));
  return { out, runId: runs[0], runDir: path.join(out, 'runs', runs[0]) };
}

describe('ncs qcschema export', () => {
  it('exports a dry run as a valid AtomicResult and prints the path', async () => {
    const { runDir } = await dryRun();
    const result = await ncs(['qcschema', 'export', runDir]);
    expect(result.code, result.stderr).toBe(0);
    const out = path.join(runDir, `${path.basename(runDir)}.qcschema.json`);
    expect(result.stdout.trim()).toBe(out);

    const doc = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(doc.schema_name).toBe('qcschema_output');
    expect(doc.molecule.symbols).toEqual(['O', 'H', 'H']);
    expect(doc.molecule.molecular_charge).toBe(0);
    expect(doc.molecule.molecular_multiplicity).toBe(1);
    expect(doc.return_result).toBe(-76);
    expect(doc.extras.nodechem.dry_run).toBe(true);
    expect(validateQcschemaOutput(doc).errors).toEqual([]);
  }, 90_000);

  it('exports a whole output folder and reports what it wrote with --json', async () => {
    const { out } = await dryRun();
    const target = path.join(await tempDir(), 'result.qcschema.json');
    const result = await ncs(['qcschema', 'export', out, '--out', target, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.out).toBe(target);
    expect(summary.schema).toMatch(/qc_schema_output\.schema$/);
    expect(summary.energyHartree).toBe(-76);
    expect(summary.dryRun).toBe(true);
    expect(summary.runId).toMatch(/^\d{8}-\d{6}-[a-z0-9]+$/);
  }, 90_000);

  it('refuses a run that has no final energy, with code qcschema-refused', async () => {
    const { out, runId } = await dryRun();
    const recordFile = path.join(out, 'runs', runId, 'run.json');
    const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    record.parsed.finalEnergy = { hartree: null, source: null };
    record.gates = { overall: 'unknown', gates: [], complete: true };
    await fs.writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    const result = await ncs(['qcschema', 'export', out, '--json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    const payload = refusal(result.stderr);
    expect(payload.code).toBe('qcschema-refused');
    expect(payload.field).toBe('return_result');
  }, 90_000);

  it('refuses a folder with no run.json at all, with code qcschema-no-run', async () => {
    const empty = await tempDir();
    const result = await ncs(['qcschema', 'export', empty, '--json']);
    expect(result.code).toBe(2);
    expect(refusal(result.stderr).code).toBe('qcschema-no-run');
  });

  it('refuses an ambiguous folder — several runs and no --run', async () => {
    const { out, runId } = await dryRun();
    // A second run folder, copied and given its own id (the id is the folder
    // name by contract); the content does not matter here.
    const copyId = '20260101-000000-copy01';
    const copy = path.join(out, 'runs', copyId);
    await fs.cp(path.join(out, 'runs', runId), copy, { recursive: true });
    const copied = JSON.parse(await fs.readFile(path.join(copy, 'run.json'), 'utf8'));
    await fs.writeFile(path.join(copy, 'run.json'), `${JSON.stringify({ ...copied, id: copyId }, null, 2)}\n`, 'utf8');

    const result = await ncs(['qcschema', 'export', out, '--json']);
    expect(result.code).toBe(2);
    const payload = refusal(result.stderr);
    expect(payload.code).toBe('qcschema-ambiguous');
    expect(payload.runs).toContain(copyId);

    const chosen = await ncs(['qcschema', 'export', out, '--run', copyId, '--json']);
    expect(chosen.code, chosen.stderr).toBe(0);
    expect(JSON.parse(chosen.stdout).runId).toBe(copyId);
  }, 90_000);

  it('lets --charge and --multiplicity override the input file, and records the values it used', async () => {
    const { runDir } = await dryRun();
    const result = await ncs(['qcschema', 'export', runDir, '--charge', '1', '--multiplicity', '2', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const doc = JSON.parse(await fs.readFile(JSON.parse(result.stdout).out, 'utf8'));
    expect(doc.molecule.molecular_charge).toBe(1);
    expect(doc.molecule.molecular_multiplicity).toBe(2);
    expect(validateQcschemaOutput(doc).errors).toEqual([]);
  }, 90_000);

  it('refuses an input it cannot read a molecule from, naming the missing field', async () => {
    const { runDir } = await dryRun();
    await fs.writeFile(path.join(runDir, 'sp-energy.gjf'), '#p B3LYP/def2-SVP SP\n\ntitle\n\n', 'utf8');
    const refused = await ncs(['qcschema', 'export', runDir, '--json']);
    expect(refused.code).toBe(2);
    expect(refusal(refused.stderr).field).toBe('molecule.geometry');
  }, 90_000);
});

describe('ncs qcschema import', () => {
  it('reads a valid AtomicResult and prints the app-side payload', async () => {
    const result = await ncs(['qcschema', 'import', path.join(FIXTURES, 'water-energy.qcschema.json'), '--json']);
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.kind).toBe('result');
    expect(payload.energyHartree).toBe(-76);
    expect(payload.molecule.symbols).toEqual(['O', 'H', 'H']);
    expect(payload.atoms[0].z).toBeCloseTo(0.1173, 9);
    expect(payload.model.method).toBe('B3LYP');
  });

  it('refuses a document with no return_result, exit 2 and a named field', async () => {
    const dir = await tempDir();
    const doc = JSON.parse(await fs.readFile(path.join(FIXTURES, 'water-energy.qcschema.json'), 'utf8'));
    delete doc.return_result;
    const file = path.join(dir, 'broken.qcschema.json');
    await fs.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const result = await ncs(['qcschema', 'import', file, '--json']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    const payload = refusal(result.stderr);
    expect(payload.code).toBe('qcschema-invalid');
    expect(payload.field).toBe('return_result');
  });

  it('refuses an unknown schema_name with code qcschema-unsupported', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'other.json');
    await fs.writeFile(file, '{"schema_name":"qcschema_basis","schema_version":2}\n', 'utf8');
    const result = await ncs(['qcschema', 'import', file, '--json']);
    expect(result.code).toBe(2);
    expect(refusal(result.stderr).code).toBe('qcschema-unsupported');
  });

  it('refuses a file that is not JSON at all', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'not.json');
    await fs.writeFile(file, 'not json\n', 'utf8');
    const result = await ncs(['qcschema', 'import', file, '--json']);
    expect(result.code).toBe(2);
    expect(refusal(result.stderr).code).toBe('qcschema-invalid');
  });

  it('writes the structure as XYZ when --out names an .xyz file', async () => {
    const target = path.join(await tempDir(), 'water.xyz');
    const result = await ncs(['qcschema', 'import', path.join(FIXTURES, 'water-energy.qcschema.json'), '--out', target]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(target);
    const text = await fs.readFile(target, 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('3');
    expect(lines[1]).toContain('water');
    expect(lines[2].startsWith('O ')).toBe(true);
  });

  it('writes the JSON payload when --out names a .json file', async () => {
    const target = path.join(await tempDir(), 'water.payload.json');
    const result = await ncs(['qcschema', 'import', path.join(FIXTURES, 'water-input.qcschema.json'), '--out', target]);
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(payload.kind).toBe('input');
    expect(payload.energyHartree).toBeNull();
  });

  it('round-trips its own export: export a dry run, import the file, same energy', async () => {
    const { out } = await dryRun();
    const target = path.join(await tempDir(), 'roundtrip.qcschema.json');
    const exported = await ncs(['qcschema', 'export', out, '--out', target]);
    expect(exported.code, exported.stderr).toBe(0);

    const imported = await ncs(['qcschema', 'import', target, '--json']);
    expect(imported.code, imported.stderr).toBe(0);
    const payload = JSON.parse(imported.stdout);
    expect(payload.energyHartree).toBe(-76);
    expect(payload.dryRun).toBe(true);
  }, 90_000);
});

describe('ncs qcschema usage', () => {
  it('prints usage for the command group when no subcommand is given', async () => {
    const result = await ncs(['qcschema']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ncs qcschema export');
  });

  it('refuses an unknown subcommand', async () => {
    const result = await ncs(['qcschema', 'frobnicate', 'x']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown qcschema subcommand');
  });
});
