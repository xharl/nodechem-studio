import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { QueueManager } from '../electron/runner/queue.js';
import { RunManager } from '../electron/runner/runManager.js';
import { runRow } from '../src/shared/datasetExport.js';
import { conditionFields, evaluateCondition } from '../src/shared/controlFlow.js';
import { rmrf } from './helpers/tempCleanup.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

/**
 * ADR 0003 §3.1 — descriptors through the queue, with a fake sidecar replaying
 * a committed RDKit answer. CI has no RDKit; the chemistry is covered by the
 * live recording, the queue contract by this file.
 */

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/chem/descriptors.json', import.meta.url),
  'utf8',
));

const atoms = [
  { element: 'C', x: 0.0, y: 0.0, z: 0.0 },
  { element: 'C', x: 1.4, y: 0.0, z: 0.0 },
  { element: 'O', x: 2.2, y: 1.0, z: 0.0 },
  { element: 'O', x: 1.4, y: -1.2, z: 0.0 },
];

const roots = [];

async function tempDir() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-chem-queue-'));
  roots.push(base);
  return base;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function stack() {
  const base = await tempDir();
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queuesRoot, queueManager };
}

/** A fake sidecar that replays `answer` and appends one line per spawn. */
async function fakeChem(base, answer) {
  const answerPath = path.join(base, 'answer.json');
  await fsp.writeFile(answerPath, JSON.stringify(answer), 'utf8');
  const spawnPath = path.join(base, 'spawns.log');
  const script = path.join(base, 'fake-chem.js');
  await fsp.writeFile(script, [
    "const fs = require('node:fs');",
    'let request = "";',
    'process.stdin.on("data", (chunk) => { request += chunk; });',
    'process.stdin.on("end", () => {',
    `  fs.appendFileSync(${JSON.stringify(spawnPath)}, "x\\n");`,
    `  fs.writeFileSync(${JSON.stringify(path.join(base, 'seen-request.json'))}, request);`,
    `  process.stdout.write(fs.readFileSync(${JSON.stringify(answerPath)}, "utf8"));`,
    '});',
  ].join('\n'), 'utf8');
  return { script, spawnPath };
}

async function queueFixture(queueManager, base, {
  qid = 'q-chem',
  chemScript = '',
  dryRun = false,
  runRecord = null,
} = {}) {
  const runDir = path.join(base, 'queues', qid, 'runs', 'run~m1');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run.json'), JSON.stringify(runRecord || {
    status: 'completed',
    outputSha256: 'a'.repeat(64),
    parsed: { finalGeometry: { atoms } },
  }), 'utf8');
  return {
    id: qid,
    status: 'running',
    options: { dryRun, chemExecutable: process.execPath, chemScript },
    edges: [{ from: 'run~m1', to: 'chem~m1', type: 'data' }],
    tasks: [{ nodeId: 'run~m1', type: 'calculate', status: 'completed', runDir }],
    currentTaskId: null,
  };
}

function chemTask(nodeId = 'chem~m1') {
  return {
    nodeId,
    type: 'analyse',
    title: 'Descriptors',
    kind: 'Analyse',
    executable: false,
    record: { id: 'm1', label: 'm1', charge: 0, multiplicity: 1 },
    recordId: 'm1',
    analyse: { mode: 'chem', op: 'descriptors', declared: [], sources: ['run~m1'] },
  };
}

const queueDirOf = (base, qid) => path.join(base, 'queues', qid);

async function spawnCount(file) {
  try {
    return (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe('descriptors through the queue (ADR 0003 §3.1)', () => {
  it('writes a derived record with the descriptor set and its provenance', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeChem(base, fixture);
    const queue = await queueFixture(queueManager, base, { chemScript: sidecar.script });
    const task = chemTask();

    await queueManager.runChemAnalyse(queue, task);

    expect(task.status).toBe('completed');
    expect(task.summary).toContain('nodechem-1');
    const record = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
    expect(record.kind).toBe('derived');
    expect(record.analyse.mode).toBe('chem');
    expect(record.analyse.descriptorSet).toBe('nodechem-1');
    expect(record.descriptors.formula).toBe('C9H8O4');
    expect(record.identity.inchiKey).toBe('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
    expect(record.analyse.origin).toMatchObject({ program: 'RDKit', version: '2026.9.1', op: 'descriptors' });
    expect(record.analyse.cache.hit).toBe(false);

    const request = JSON.parse(await fsp.readFile(path.join(base, 'seen-request.json'), 'utf8'));
    expect(request.protocol).toBe('nodechem-chem/1');
    expect(request.op).toBe('descriptors');
    expect(request.molecule.atoms).toHaveLength(atoms.length);
  });

  it('reuses the run-local cache instead of spawning a second sidecar', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeChem(base, fixture);
    const queue = await queueFixture(queueManager, base, { chemScript: sidecar.script });

    const first = chemTask();
    await queueManager.runChemAnalyse(queue, first);
    expect(await spawnCount(sidecar.spawnPath)).toBe(1);

    const second = chemTask();
    await queueManager.runChemAnalyse(queue, second);
    expect(second.status).toBe('completed');
    expect(second.analyse.cache.hit).toBe(true);
    expect(await spawnCount(sidecar.spawnPath)).toBe(1);
  });

  it('caches a refusal and does not retry the same molecule', async () => {
    const { base, queueManager } = await stack();
    const refusal = {
      protocol: 'nodechem-chem/1',
      op: 'descriptors',
      ok: false,
      error: { code: 'coverage-refused', message: 'open-shell molecule refused' },
    };
    const sidecar = await fakeChem(base, refusal);
    const queue = await queueFixture(queueManager, base, { chemScript: sidecar.script });

    const first = chemTask();
    await queueManager.runChemAnalyse(queue, first);
    expect(first.status).toBe('failed');
    expect(first.refusal.code).toBe('coverage-refused');

    const second = chemTask();
    await queueManager.runChemAnalyse(queue, second);
    expect(second.status).toBe('failed');
    expect(await spawnCount(sidecar.spawnPath)).toBe(1);
  });

  it('refuses a dry run instead of fabricating descriptors', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeChem(base, fixture);
    const queue = await queueFixture(queueManager, base, { chemScript: sidecar.script, dryRun: true });
    const task = chemTask();

    await queueManager.runChemAnalyse(queue, task);

    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('chem-dry-run');
    expect(await spawnCount(sidecar.spawnPath)).toBe(0);
  });

  it('names a missing sidecar as rdkit-missing', async () => {
    const { base, queueManager } = await stack();
    const queue = await queueFixture(queueManager, base);
    queue.options.chemExecutable = '';
    const task = chemTask();

    await queueManager.runChemAnalyse(queue, task);

    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('rdkit-missing');
  });

  it('refuses an upstream record with no geometry', async () => {
    const { base, queueManager } = await stack();
    const sidecar = await fakeChem(base, fixture);
    const queue = await queueFixture(queueManager, base, {
      chemScript: sidecar.script,
      runRecord: { status: 'completed', parsed: {} },
    });
    const task = chemTask();

    await queueManager.runChemAnalyse(queue, task);

    expect(task.status).toBe('failed');
    expect(task.refusal.code).toBe('bad-input');
    expect(await spawnCount(sidecar.spawnPath)).toBe(0);
  });
});

describe('descriptor values reach the dataset row and an expression', () => {
  it('exposes the flat columns and reads them with the normal field vocabulary', () => {
    const row = runRow({ descriptors: { formula: 'C9H8O4', tpsa: 63.6, hbd: 1 } });
    expect(row.formula).toBe('C9H8O4');
    expect(row.tpsa).toBe(63.6);
    expect(row.hbd).toBe(1);
    expect(row.qed).toBeNull();

    const fields = conditionFields(null, null, { tpsa: 63.6 });
    expect(fields.tpsa).toBe(63.6);
    const evaluation = evaluateCondition('tpsa > 140', fields);
    expect(evaluation.value).toBe(false);
    expect(evaluateCondition('tpsa > 140', conditionFields(null, null, {})).value).toBeNull();
  });

  it('does not read descriptors from a record that has none', () => {
    const row = runRow({ parsed: { finalEnergy: { hartree: -76.4 } } });
    expect(row.formula).toBeNull();
    expect(row.tpsa).toBeNull();
  });
});

describe('descriptor report section (ADR 0003 §3.1)', () => {
  it('prints the set, the formula and the numbers, with a missing value marked', () => {
    const model = buildWorkflowReport({
      id: 'q-report',
      projectName: 'Descriptors',
      status: 'completed',
      tasks: [{
        nodeId: 'chem~m1',
        type: 'analyse',
        title: 'Descriptors',
        recordId: 'm1',
        record: { label: 'm1' },
        status: 'completed',
        runId: 'chem~m1',
      }],
    }, {
      'chem~m1': {
        kind: 'derived',
        analyse: { mode: 'chem', descriptorSet: 'nodechem-1' },
        identity: { inchiKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N' },
        descriptors: { formula: 'C9H8O4', tpsa: 63.6, qed: null },
      },
    });
    const html = workflowReportHtml(model);
    expect(html).toContain('Descriptors');
    expect(html).toContain('nodechem-1');
    expect(html).toContain('C9H8O4');
    expect(html).toContain('63.600');
    // A descriptor that was not reported is the report's marker, never 0.
    expect(html).toContain('not reported');
  });
});
