import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCombinedReportHtml,
  buildProjectReportModel,
  workflowReportHtml,
} from '../src/shared/workflowReport.js';

/**
 * Issue #357: `ncs report` used to write the HTML alone. A report produced in
 * CI could not be re-rendered, diffed or tied to the document it came from.
 * These tests hold the two halves of the contract together:
 *
 *   - `<name>.json` is written beside `<name>.html` and parses to exactly the
 *     model the HTML renders from (re-rendering produces the same bytes);
 *   - the SHA-256 printed to stdout is the hash of that file, and the HTML
 *     carries the same value in `data-model-sha256` and its header line;
 *   - `--no-model` is the old one-file behaviour, and `--out` puts the model
 *     beside the named HTML file;
 *   - the combined report writes one project-report envelope over its flows.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'ncs.js');

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ncs-report-model-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A minimal but real queue + run record. `ncs report` only reads these two
 * files, so the test does not need to run a workflow to exercise the writer.
 */
async function writeQueue(outDir, {
  queueId, flowId, projectName = 'Report model test', createdAt = '2026-11-11T00:00:00.000Z',
}) {
  const runDir = path.join(outDir, 'runs', queueId);
  await fs.mkdir(runDir, { recursive: true });
  const record = {
    id: `${queueId}-run`,
    kind: 'run',
    status: 'completed',
    title: `${flowId} block`,
    dryRun: true,
    engine: 'gaussian',
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    parsed: {
      status: 'completed',
      finalEnergy: { hartree: -76.123456789 },
      frequencies: { imaginaryCount: 0 },
      resources: { elapsedSeconds: 1.5 },
    },
    provenance: {
      method: { functional: 'B3LYP', basis: '6-31G(d)' },
      jobType: 'SP',
    },
  };
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
  const queue = {
    id: queueId,
    projectName,
    status: 'completed',
    createdAt,
    finishedAt: '2026-11-11T00:01:00.000Z',
    flowId,
    tasks: [{
      nodeId: `${flowId}-node`,
      title: `${flowId} block`,
      type: 'calculate',
      kind: 'single',
      flowId,
      status: 'completed',
      gateVerdict: 'pass',
      runId: `${queueId}-run`,
      runDir,
    }],
  };
  const queueDir = path.join(outDir, 'queues', queueId);
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(path.join(queueDir, 'queue.json'), JSON.stringify(queue, null, 2), 'utf8');
  return { queue, record, runDir };
}

async function report(args, options = {}) {
  try {
    const result = await run(process.execPath, [CLI, 'report', ...args], { cwd: ROOT, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

describe('ncs report writes the HTML model beside the document (issue 357)', () => {
  it('writes index.json, prints its SHA-256 and re-renders the same HTML', async () => {
    const outDir = await tempDir();
    const { runDir } = await writeQueue(outDir, { queueId: 'q-one', flowId: 'main' });

    const result = await report([outDir, '--flow', 'main', '--figures', 'none'], { timeout: 60000 });
    expect(result.code).toBe(0);

    const htmlPath = path.join(outDir, 'reports', 'index.html');
    const modelPath = path.join(outDir, 'reports', 'index.json');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(htmlPath);

    const modelText = await fs.readFile(modelPath, 'utf8');
    const model = JSON.parse(modelText);
    const digest = sha256(modelText);

    // The digest line names only the digest: no path is added to stdout.
    expect(lines[1]).toBe(`model sha256 ${digest}`);
    expect(lines[1]).not.toContain(outDir);

    const html = await fs.readFile(htmlPath, 'utf8');
    expect(html).toContain(`data-model-sha256="${digest}"`);
    expect(html).toContain(`model sha256 ${digest}`);

    // The JSON is the model, in the schema the window writes.
    expect(model.kind).toBe('nodechem-studio.workflow-report');
    expect(model.schemaVersion).toBe(1);
    expect(model.queue.id).toBe('q-one');
    expect(model.tasks).toHaveLength(1);
    expect(model.tasks[0].finalEnergyHartree).toBe(-76.123456789);
    // Absolute paths belong in the model, never in the HTML.
    expect(modelText).toContain(runDir);
    expect(html).not.toContain(runDir);

    // Re-rendering the parsed model is byte-identical: the JSON is exactly
    // what the HTML was rendered from, not a summary of it.
    expect(workflowReportHtml(model, { modelDigest: digest })).toBe(html);
  }, 120000);

  it('writes no model and prints no digest under --no-model', async () => {
    const outDir = await tempDir();
    await writeQueue(outDir, { queueId: 'q-plain', flowId: 'main' });

    const result = await report([outDir, '--flow', 'main', '--figures', 'none', '--no-model'], { timeout: 60000 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([path.join(outDir, 'reports', 'index.html')]);
    await expect(fs.readFile(path.join(outDir, 'reports', 'index.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const html = await fs.readFile(path.join(outDir, 'reports', 'index.html'), 'utf8');
    expect(html).not.toContain('data-model-sha256');
    expect(html).not.toContain('model sha256');
  }, 120000);

  it('puts <file>.json beside an explicit --out <file>.html', async () => {
    const outDir = await tempDir();
    await writeQueue(outDir, { queueId: 'q-out', flowId: 'main' });
    const target = path.join(outDir, 'nested', 'custom.html');

    const result = await report([outDir, '--flow', 'main', '--figures', 'none', '--out', target], { timeout: 60000 });
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines[0]).toBe(target);

    const modelText = await fs.readFile(path.join(outDir, 'nested', 'custom.json'), 'utf8');
    const digest = sha256(modelText);
    expect(lines[1]).toBe(`model sha256 ${digest}`);
    const html = await fs.readFile(target, 'utf8');
    expect(html).toContain(`data-model-sha256="${digest}"`);
    expect(workflowReportHtml(JSON.parse(modelText), { modelDigest: digest })).toBe(html);
  }, 120000);

  it('writes one project-report envelope for a combined report and hashes its bytes', async () => {
    const outDir = await tempDir();
    await writeQueue(outDir, { queueId: 'q-alpha', flowId: 'alpha', createdAt: '2026-11-11T00:00:00.000Z' });
    await writeQueue(outDir, { queueId: 'q-beta', flowId: 'beta', createdAt: '2026-11-11T00:02:00.000Z' });

    const result = await report([outDir, '--figures', 'none'], { timeout: 60000 });
    expect(result.code).toBe(0);

    const htmlPath = path.join(outDir, 'reports', 'index.html');
    const modelPath = path.join(outDir, 'reports', 'index.json');
    const modelText = await fs.readFile(modelPath, 'utf8');
    const document = JSON.parse(modelText);
    const digest = sha256(modelText);

    expect(result.stdout.trim().split('\n')).toEqual([htmlPath, `model sha256 ${digest}`]);
    expect(document.kind).toBe('nodechem-studio.project-report');
    expect(document.schemaVersion).toBe(1);
    expect(document.flows).toHaveLength(2);
    expect(document.flows.map((flow) => flow.flow.id)).toEqual(['beta', 'alpha']);
    expect(document.title).toBe('Project report — Report model test');

    const html = await fs.readFile(htmlPath, 'utf8');
    expect(html).toContain(`data-model-sha256="${digest}"`);
    expect(html).toContain(`model sha256 ${digest}`);
    // One digest line for the whole document, not one per flow section.
    expect(html.match(/model sha256 /g)).toHaveLength(1);

    expect(buildCombinedReportHtml(document.flows, {
      title: document.title,
      generatedAt: document.generatedAt,
      modelDigest: digest,
    })).toBe(html);
    expect(buildProjectReportModel(document.flows, {
      title: document.title,
      generatedAt: document.generatedAt,
    })).toEqual(document);
  }, 120000);
});
