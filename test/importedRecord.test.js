import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  IMPORTED_BADGE_TEXT,
  ImportedRecordError,
  buildImportedRecord,
  importedBadgeLabel,
  importedSummary,
  isImportedRecord,
  validateImportedRecord,
} from '../src/shared/importedRecord.js';
import {
  RECORD_SCHEMA_VERSION,
  loadRecordSchema,
  recordSchemaPath,
  recordSchemaVersions,
  validateRecord,
} from '../schemas/record-schema.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

/**
 * Issue #131: a number another program computed, kept in the same place as a
 * run without ever being read as one. These tests drive the shared builder, the
 * published schema, the CLI that writes the record, both consumers that could
 * mix it with a computed series, and the badge on every surface.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'ncs.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'run-record');
const IMPORTED_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'imported', 'spartan-wb97xd3.json');

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ncs-imported-'));
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

/** A refusal is one JSON object on stderr; the CLI may append a sentence after it. */
function refusal(stderr) {
  return JSON.parse(stderr.slice(0, stderr.lastIndexOf('}') + 1));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const SPARTAN = Object.freeze({
  id: 'spartan-x',
  program: "Spartan '26",
  version: '26.0.1',
  method: 'ωB97X-D3',
  basis: 'def2-TZVP',
  energy: -2107.7761757,
  sourceSha256: 'c'.repeat(64),
});

describe('imported record — construction', () => {
  it('builds the record the issue asks for, and refuses to guess a unit', () => {
    const record = buildImportedRecord(SPARTAN);
    expect(record.kind).toBe('imported');
    expect(record.schemaVersion).toBe(2);
    expect(record.program).toBe("Spartan '26");
    expect(record.version).toBe('26.0.1');
    expect(record.method).toBe('ωB97X-D3');
    expect(record.basis).toBe('def2-TZVP');
    expect(record.energy).toBeCloseTo(-2107.7761757, 10);
    expect(record.sourceSha256).toBe('c'.repeat(64));
    // The record is deliberately not run-shaped: no status, no output, no gates.
    expect(record).not.toHaveProperty('status');
    expect(record).not.toHaveProperty('outputName');
    expect(record).not.toHaveProperty('gates');
    expect(record).not.toHaveProperty('parsed');
    expect(isImportedRecord(record)).toBe(true);
    expect(validateImportedRecord(record).errors).toEqual([]);
  });

  it('defaults only the two facts it knows without being told', () => {
    const record = buildImportedRecord({ ...SPARTAN, importedAt: undefined, sourceName: undefined });
    expect(new Date(record.importedAt).toString()).not.toBe('Invalid Date');
    expect(record).not.toHaveProperty('sourceName');
  });

  it('labels the badge with the program and its version', () => {
    const label = importedBadgeLabel(buildImportedRecord(SPARTAN));
    expect(label).toBe("imported, not run here — Spartan '26 26.0.1");
    expect(label.startsWith(IMPORTED_BADGE_TEXT)).toBe(true);
    // A record that lost its version still says what it is.
    const defaced = { ...buildImportedRecord(SPARTAN), version: null };
    expect(importedBadgeLabel(defaced)).toContain(IMPORTED_BADGE_TEXT);
    expect(importedBadgeLabel(defaced)).toContain("Spartan '26");
  });
});

describe('imported record — refusals', () => {
  it('refuses a record with no program', () => {
    const { program, ...rest } = SPARTAN;
    expect(() => buildImportedRecord(rest)).toThrow(ImportedRecordError);
    try {
      buildImportedRecord(rest);
    } catch (error) {
      expect(error.field).toBe('program');
      expect(error.code).toBe('imported-invalid');
    }
    const record = { ...buildImportedRecord(SPARTAN) };
    delete record.program;
    const verdict = validateRecord(record);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((error) => error.path === '/program')).toBe(true);
    expect(validateImportedRecord(record).errors.some((error) => error.path === '/program')).toBe(true);
  });

  it('refuses a record with no source hash, or a malformed one', () => {
    const { sourceSha256, ...rest } = SPARTAN;
    expect(() => buildImportedRecord(rest)).toThrow(/sourceSha256/);
    try {
      buildImportedRecord({ ...SPARTAN, sourceSha256: 'C'.repeat(64) });
    } catch (error) {
      expect(error.field).toBe('sourceSha256');
    }
    const record = { ...buildImportedRecord(SPARTAN), sourceSha256: 'not-a-hash' };
    expect(validateRecord(record).errors.some((error) => error.path === '/sourceSha256')).toBe(true);
  });

  it('refuses an energy that is not a finite number', () => {
    expect(() => buildImportedRecord({ ...SPARTAN, energy: 'minus two thousand' })).toThrow(/energy/);
    expect(() => buildImportedRecord({ ...SPARTAN, energy: Number.NaN })).toThrow(/energy/);
  });

  it('refuses an id that could not also be a folder name', () => {
    expect(() => buildImportedRecord({ ...SPARTAN, id: 'spartan x' })).toThrow(/id/);
  });
});

describe('imported record — the published contract', () => {
  it('ships v2 beside an untouched v1', () => {
    expect(RECORD_SCHEMA_VERSION).toBe(2);
    expect(recordSchemaVersions()).toEqual([1, 2]);
    expect(recordSchemaPath(2)).toBe(path.join(ROOT, 'schemas', 'run-record.v2.schema.json'));
    const v1 = loadRecordSchema(1);
    // v1 is the published contract: it still knows no record kind.
    expect(v1.properties.kind).toBeUndefined();
    expect(v1.additionalProperties).toBe(false);
    expect(recordSchemaPath(3)).toBe(null);
    expect(() => loadRecordSchema(3)).toThrow(/Unknown run-record schema version 3/);
  });

  it('validates every v1 record under v1 and under v2, unchanged', async () => {
    for (const name of ['gaussian-dry-run.json', 'xtb-dry-run.json']) {
      const record = JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'));
      expect(validateRecord(record, { version: 1 }).errors, name).toEqual([]);
      expect(validateRecord(record, { version: 2 }).errors, name).toEqual([]);
    }
  });

  it('accepts the imported fixture at v2 and refuses it at v1', async () => {
    const record = JSON.parse(await fs.readFile(IMPORTED_FIXTURE, 'utf8'));
    expect(validateRecord(record, { version: 2 }).errors).toEqual([]);
    const atV1 = validateRecord(record, { version: 1 });
    expect(atV1.ok).toBe(false);
    // v1 refuses the kind rather than dropping it.
    expect(atV1.errors.some((error) => error.path.startsWith('/kind'))).toBe(true);
  });

  it('refuses an imported record that kept a run field', () => {
    const record = { ...buildImportedRecord(SPARTAN), exitCode: 0 };
    expect(validateRecord(record).errors.some((error) => error.path === '/exitCode')).toBe(true);
  });
});

describe('ncs record import', () => {
  it('writes the record into a run folder and reads it back through ncs export', async () => {
    const out = await tempDir();
    const sourceFile = path.join(out, 'spartan.out');
    const sourceText = 'Spartan output: E = -2107.7761757 hartree\n';
    await fs.writeFile(sourceFile, sourceText, 'utf8');

    const written = await ncs([
      'record', 'import',
      '--id', 'spartan-x',
      '--program', "Spartan '26",
      '--version', '26.0.1',
      '--method', 'ωB97X-D3',
      '--basis', 'def2-TZVP',
      '--energy', '-2107.7761757',
      '--source', sourceFile,
      '--out', out,
      '--json',
    ]);
    expect(written.code, written.stderr).toBe(0);
    const payload = JSON.parse(written.stdout);
    const file = path.join(out, 'runs', 'spartan-x', 'run.json');
    expect(payload.file).toBe(file);
    expect(payload.record.kind).toBe('imported');
    expect(payload.record.sourceSha256).toBe(sha256(sourceText));
    expect(payload.badge).toContain('imported, not run here');

    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(record).toEqual(payload.record);
    expect(validateRecord(record).errors).toEqual([]);
    expect(record.sourceSha256).toBe(sha256(sourceText));
    expect(record.sourceName).toBe('spartan.out');

    const exported = await ncs(['export', out, '--json']);
    expect(exported.code, exported.stderr).toBe(0);
    const envelope = JSON.parse(exported.stdout);
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.schema).toBe(recordSchemaPath(2));
    expect(envelope.recordCount).toBe(1);
    expect(envelope.records[0]).toEqual(record);
    expect(importedSummary(envelope.records[0]).energyHartree).toBeCloseTo(-2107.7761757, 10);
  });

  it('writes a standalone results file when --out names one', async () => {
    const out = await tempDir();
    const target = path.join(out, 'results', 'spartan.json');
    const written = await ncs([
      'record', 'import',
      '--id', 'spartan-y',
      '--program', "Spartan '26",
      '--version', '26.0.1',
      '--method', 'ωB97X-D3',
      '--basis', 'def2-TZVP',
      '--energy', '-2107.7761757',
      '--source-sha256', 'd'.repeat(64),
      '--out', target,
    ]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout.trim()).toBe(target);
    const record = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(record.sourceSha256).toBe('d'.repeat(64));
    expect(record).not.toHaveProperty('sourceName');
    expect(validateRecord(record).errors).toEqual([]);
  });

  it('refuses a record missing --program and writes nothing', async () => {
    const out = await tempDir();
    const result = await ncs([
      'record', 'import',
      '--id', 'no-program',
      '--version', '26.0.1',
      '--method', 'ωB97X-D3',
      '--basis', 'def2-TZVP',
      '--energy', '-2107.7',
      '--source-sha256', 'e'.repeat(64),
      '--out', out,
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    const refused = refusal(result.stderr);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('imported-invalid');
    expect(refused.field).toBe('program');
    await expect(fs.stat(path.join(out, 'runs', 'no-program', 'run.json'))).rejects.toThrow(/ENOENT/);
  });

  it('refuses a record with no hash and one that names two sources', async () => {
    const out = await tempDir();
    const base = [
      'record', 'import',
      '--id', 'no-hash',
      '--program', 'Gaussian',
      '--version', '16.C.01',
      '--method', 'B3LYP',
      '--basis', '6-31G(d)',
      '--energy', '-76.4',
      '--out', out,
    ];
    const noHash = await ncs(base);
    expect(noHash.code).toBe(2);
    expect(refusal(noHash.stderr).field).toBe('sourceSha256');

    const sourceFile = path.join(out, 'a.log');
    await fs.writeFile(sourceFile, 'x\n', 'utf8');
    const both = await ncs([...base, '--source', sourceFile, '--source-sha256', 'f'.repeat(64)]);
    expect(both.code).toBe(2);
    expect(refusal(both.stderr).field).toBe('sourceSha256');
  });

  it('refuses to overwrite an existing record', async () => {
    const out = await tempDir();
    const args = [
      'record', 'import',
      '--id', 'twice',
      '--program', "Spartan '26",
      '--version', '26.0.1',
      '--method', 'ωB97X-D3',
      '--basis', 'def2-TZVP',
      '--energy', '-2107.7761757',
      '--source-sha256', 'a'.repeat(64),
      '--out', out,
    ];
    expect((await ncs(args)).code, 'first write').toBe(0);
    const second = await ncs(args);
    expect(second.code).toBe(2);
    expect(refusal(second.stderr).code).toBe('imported-exists');
  });
});

describe('ncs export at v1', () => {
  async function stageV1Records() {
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

  it('still produces the v1 envelope for records written under v1', async () => {
    const { out, records } = await stageV1Records();
    const result = await ncs(['export', out, '--json', '--schema-version', '1']);
    expect(result.code, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.schema).toBe(recordSchemaPath(1));
    expect(envelope.records).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
    for (const record of envelope.records) expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
  });

  it('refuses an imported record at v1 instead of downgrading it', async () => {
    const out = await tempDir();
    const record = JSON.parse(await fs.readFile(IMPORTED_FIXTURE, 'utf8'));
    const dir = path.join(out, 'runs', record.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    const atV1 = await ncs(['export', out, '--json', '--schema-version', '1']);
    expect(atV1.code).toBe(2);
    expect(atV1.stdout).toBe('');
    const refused = refusal(atV1.stderr);
    expect(refused.code).toBe('record-invalid');
    expect(refused.schema).toBe(recordSchemaPath(1));

    const atV2 = await ncs(['export', out, '--json', '--schema-version', '2']);
    expect(atV2.code, atV2.stderr).toBe(0);
    expect(JSON.parse(atV2.stdout).records[0].kind).toBe('imported');
  });
});

describe('the badge on every surface', () => {
  const importedRecord = () => buildImportedRecord(SPARTAN);

  const QUEUE = Object.freeze({
    id: 'q-imported',
    projectName: 'Spartan study',
    status: 'completed',
    createdAt: '2026-11-08T01:00:00.000Z',
    finishedAt: '2026-11-08T01:12:00.000Z',
    tasks: [
      {
        nodeId: 'sp',
        title: 'Converged single point (Spartan)',
        type: 'calc',
        kind: 'SP',
        status: 'completed',
        attempts: 1,
        runId: 'spartan-x',
        runDir: '/runs/spartan-x',
      },
    ],
  });

  it('is in the renderer markup, with the program and version', () => {
    const html = resultsPanelHtml(importedRecord());
    expect(html).toContain('imported, not run here');
    expect(html).toContain("Spartan &#39;26");
    expect(html).toContain('26.0.1');
    expect(html).toContain('data-role="imported-badge"');
    expect(html).toContain('-2107.7761757');
    // Nothing may present the imported number with the run treatment.
    expect(html).not.toContain('data-role="run-status"');
  });

  it('is in the report output, on the row and in the provenance list', () => {
    const records = { 'spartan-x': importedRecord() };
    const model = buildWorkflowReport(QUEUE, records, { includeImported: true });
    const html = workflowReportHtml(model);
    expect(html).toContain('imported, not run here');
    // The program name is HTML-escaped in the document; the version is not.
    expect(html).toContain('Spartan');
    expect(html).toContain('26.0.1');
    expect(html).toContain('data-field="imported-result"');
    expect(html).toContain('c'.repeat(16));
    // The number appears in the report, and only next to its label.
    expect(html).toContain('-2107.77617570');
  });

  it('keeps the imported energy out of the report when it was not asked for', () => {
    const model = buildWorkflowReport(QUEUE, { 'spartan-x': importedRecord() });
    const row = model.tasks.find((task) => task.nodeId === 'sp');
    expect(row.imported).toBeTruthy();
    expect(row.finalEnergyHartree).toBe(null);
    expect(model.imported).toHaveLength(1);
    expect(model.imported[0].included).toBe(false);
    const html = workflowReportHtml(model);
    expect(html).toContain('imported, not run here');
    // The imported number is listed once, in its own labelled table; it never
    // lands in the task table's energy column.
    expect(html.match(/-2107\.77617570/g) || []).toHaveLength(1);
    expect(html).toContain('not reported (imported)');
  });
});

describe('a mixed series is labelled, never averaged', () => {
  const importedRecord = () => buildImportedRecord(SPARTAN);

  const computed = {
    id: 'run-opt',
    kind: undefined,
    engine: 'gaussian',
    dryRun: false,
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    provenance: { jobType: 'SP', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.4 } },
    gates: { overall: 'pass' },
  };

  it('keeps the imported value out of the record baseline and ΔE', () => {
    const queue = {
      id: 'q-mixed',
      projectName: 'Mixed',
      status: 'completed',
      createdAt: '2026-11-08T01:00:00.000Z',
      finishedAt: '2026-11-08T01:12:00.000Z',
      tasks: [
        { nodeId: 'a', title: 'Opt', type: 'calc', kind: 'Opt', status: 'completed', recordId: 'r1', runId: 'run-opt' },
        { nodeId: 'b', title: 'Spartan SP', type: 'calc', kind: 'SP', status: 'completed', recordId: 'r1', runId: 'spartan-x' },
        { nodeId: 'c', title: 'Freq', type: 'calc', kind: 'Freq', status: 'completed', recordId: 'r2', runId: 'run-freq' },
      ],
    };
    const records = {
      'run-opt': computed,
      'spartan-x': importedRecord(),
      'run-freq': {
        ...computed,
        id: 'run-freq',
        parsed: { finalEnergy: { hartree: -76.5 } },
      },
    };
    const model = buildWorkflowReport(queue, records, { includeImported: true });
    const importedRow = model.tasks.find((task) => task.nodeId === 'b');
    expect(importedRow.imported.badge).toContain('imported, not run here');
    expect(importedRow.finalEnergyHartree).toBeCloseTo(-2107.7761757, 10);

    const r1 = model.records.find((record) => record.id === 'r1');
    expect(r1.imported).toBeTruthy();
    // The record's own final energy is the computed one; it is not superseded.
    expect(r1.finalEnergyHartree).toBeCloseTo(-76.4, 10);
    // Nothing is compared against a number this app did not compute.
    expect(r1.relativeKcal).toBe(null);

    const r2 = model.records.find((record) => record.id === 'r2');
    expect(r2.relativeKcal).toBeCloseTo((-76.5 + 76.4) * 627.5094740631, 6);

    const html = workflowReportHtml(model);
    expect(html).toContain('imported, not run here');
    expect(html).toContain('not compared');
    expect(html).not.toContain(`-2107.77617570</td><td class="num">0.00`);
  });

  it('refuses to Boltzmann-average a conformer group whose member was imported', () => {
    const queue = {
      id: 'q-conf',
      projectName: 'Conformers',
      status: 'completed',
      createdAt: '2026-11-08T01:00:00.000Z',
      finishedAt: '2026-11-08T01:12:00.000Z',
      tasks: [
        {
          nodeId: 'c1', title: 'Member 1', type: 'calc', kind: 'SP', status: 'completed', runId: 'run-m1',
          fanOut: { conformerId: 'conf', memberId: 'm1' },
          conformer: { nodeId: 'conf', title: 'Conformers', generator: 'crest', id: 'm1', relativeKcal: 0, population: 0.6, protomer: 'p1' },
        },
        {
          nodeId: 'c2', title: 'Member 2 (imported)', type: 'calc', kind: 'SP', status: 'completed', runId: 'spartan-x',
          fanOut: { conformerId: 'conf', memberId: 'm2' },
          conformer: { nodeId: 'conf', title: 'Conformers', generator: 'crest', id: 'm2', relativeKcal: 1.2, population: 0.4, protomer: 'p1' },
        },
        { nodeId: 'conf', title: 'Conformers', type: 'conformers', status: 'completed', conformers: { temperature: 298.15 } },
      ],
    };
    const model = buildWorkflowReport(queue, {
      'run-m1': { ...computed, id: 'run-m1' },
      'spartan-x': importedRecord(),
    }, { includeImported: true });
    expect(model.conformers).toHaveLength(1);
    const ensemble = model.conformers[0].ensemble;
    expect(ensemble.available).toBe(false);
    expect(String(ensemble.reason)).toContain('imported');
    const html = workflowReportHtml(model);
    expect(html).toContain('imported, not run here');
    expect(html).not.toContain('data-field="ensemble-value"');
  });
});

describe('solution energetics', () => {
  it('shows an imported result only when asked, and never as a computed cycle', () => {
    const imported = importedRecordForEnergetics();
    const request = { includeImported: true, imported: [imported] };
    const html = resultsPanelHtml(buildImportedRecord(SPARTAN), request);
    expect(html).toContain('data-field="imported-energetics"');
    expect(html).toContain('imported, not run here');
    expect(html).not.toContain('data-field="pka-cycle"');

    const without = resultsPanelHtml(buildImportedRecord(SPARTAN));
    expect(without).not.toContain('data-field="imported-energetics"');
  });
});

function importedRecordForEnergetics() {
  return {
    ...buildImportedRecord(SPARTAN),
    id: 'spartan-reference',
  };
}

describe('the shared check and the published schema agree', () => {
  it('refuses the same field the schema refuses', () => {
    const record = buildImportedRecord(SPARTAN);
    expect(validateImportedRecord(record).ok).toBe(true);
    expect(validateRecord(record).ok).toBe(true);
    for (const field of ['kind', 'id', 'program', 'version', 'method', 'basis', 'energy', 'sourceSha256', 'importedAt']) {
      const broken = { ...record };
      delete broken[field];
      const local = validateImportedRecord(broken);
      const published = validateRecord(broken);
      expect(local.ok, `${field} must be refused by the module`).toBe(false);
      expect(published.ok, `${field} must be refused by the schema`).toBe(false);
      expect(local.errors[0].path, field).toBe(`/${field}`);
      expect(published.errors.some((error) => error.path === `/${field}`), field).toBe(true);
    }
  });
});

describe('ncs report --include-imported', () => {
  it('writes the imported number into the report only when asked', async () => {
    const out = await tempDir();
    const runDir = path.join(out, 'runs', 'spartan-x');
    await fs.mkdir(runDir, { recursive: true });
    const record = buildImportedRecord(SPARTAN);
    await fs.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const queue = {
      id: 'q-1',
      projectName: 'Spartan study',
      status: 'completed',
      createdAt: '2026-11-08T01:00:00.000Z',
      finishedAt: '2026-11-08T01:12:00.000Z',
      tasks: [{
        nodeId: 'sp', title: 'Spartan single point', type: 'calc', kind: 'SP',
        status: 'completed', runId: 'spartan-x', runDir,
      }],
    };
    await fs.mkdir(path.join(out, 'queues', 'q-1'), { recursive: true });
    await fs.writeFile(path.join(out, 'queues', 'q-1', 'queue.json'), `${JSON.stringify(queue, null, 2)}\n`, 'utf8');

    const plainFile = path.join(out, 'plain.html');
    const plain = await ncs(['report', out, '--out', plainFile]);
    expect(plain.code, plain.stderr).toBe(0);
    const plainHtml = await fs.readFile(plainFile, 'utf8');
    expect(plainHtml).toContain('imported, not run here');
    expect(plainHtml).toContain('data-field="imported-result"');
    expect((plainHtml.match(/-2107\.77617570/g) || [])).toHaveLength(1);

    const askedFile = path.join(out, 'asked.html');
    const asked = await ncs(['report', out, '--include-imported', '--out', askedFile]);
    expect(asked.code, asked.stderr).toBe(0);
    const askedHtml = await fs.readFile(askedFile, 'utf8');
    expect(askedHtml).toContain('imported, not run here');
    // Once in the imported table, once in the task row, both labelled.
    expect((askedHtml.match(/-2107\.77617570/g) || [])).toHaveLength(2);
    expect(askedHtml).toContain('shown, labelled');
  });
});
