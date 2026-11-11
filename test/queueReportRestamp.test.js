import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * Issue 327 — an output block writes its report while the queue is still
 * `running`, so the header said "status running · finished not reported" on a
 * document that describes a finished workflow. The queue restamps the HTML
 * artifacts once it settles; `ncs report` on the same directory builds the same
 * header from `queue.json`, so the two cannot disagree.
 */

const roots = [];
const managers = [];

async function waitFor(check, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    // eslint-disable-next-line no-await-in-loop
    const value = await check();
    if (value) return value;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the queue');
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.flush()));
  await Promise.all(roots.splice(0).map((dir) => rmrf(dir)));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-restamp-'));
  roots.push(base);
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  const artifactsRoot = path.join(base, 'artifacts');
  await fsp.mkdir(runsRoot, { recursive: true });
  // The manager publishes `queue-done` after the artifacts are restamped, so the
  // test waits for that event rather than for a status a poller could see first.
  const events = [];
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({
    queuesRoot, artifactsRoot, runManager, emit: (event) => events.push(event),
  });
  managers.push(queueManager);
  await queueManager.init();
  return { queueManager, artifactsRoot, events };
}

/** One completed calculate task and the output block that reported on it. */
function queueWithReport() {
  const finishedAt = '2026-11-11T01:31:55.668Z';
  return {
    id: 'q-report',
    projectName: 'report restamp',
    status: 'running',
    createdAt: '2026-11-11T01:31:49.764Z',
    finishedAt: null,
    currentTaskId: null,
    flowId: 'flow-1',
    flowTitle: 'Workflow',
    edges: [],
    tasks: [
      {
        nodeId: 'opt',
        type: 'calculate',
        title: 'opt',
        status: 'completed',
        engine: 'xtb',
        runId: 'run-1',
        runDir: null,
        finishedAt,
        gates: {},
      },
      {
        nodeId: 'report',
        type: 'output',
        title: 'report',
        status: 'completed',
        flowId: 'flow-1',
        output: { kind: 'html', path: 'reports/report.html', include: 'records' },
        finishedAt,
      },
    ],
  };
}

describe('a report written inside a workflow is restamped when the queue settles (issue 327)', () => {
  it('rewrites the in-run report with the final status and the queue finish time', async () => {
    const { queueManager, artifactsRoot } = await stack();
    const queue = queueWithReport();
    const task = queue.tasks[1];

    // What the block writes while the queue is still running.
    const [first] = await queueManager.writeOutputArtifacts(queue, task);
    const reportPath = path.join(artifactsRoot, 'reports', 'report.html');
    const inRun = await fsp.readFile(reportPath, 'utf8');
    expect(inRun).toMatch(/status running/);
    expect(inRun).toMatch(/finished not reported/);

    // The queue settles, then restamps.
    queue.status = 'completed';
    queue.finishedAt = '2026-11-11T01:31:56.114Z';
    queue.tasks[0].status = 'completed';
    await queueManager.restampReports(queue);

    const after = await fsp.readFile(reportPath, 'utf8');
    expect(after).toMatch(/status completed/);
    expect(after).toContain(`finished ${queue.finishedAt}`);
    expect(after).not.toContain('finished not reported');

    // One artifact, one manifest entry: the restamp replaced it, not appended.
    const manifest = JSON.parse(await fsp.readFile(path.join(artifactsRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].path).toBe('reports/report.html');
    // The manifest hash is the hash of the bytes now on disk, not the in-run ones.
    expect(manifest[0].sha256).not.toBe(first.sha256);
  });

  it('leaves a queue that is still running alone', async () => {
    const { queueManager, artifactsRoot } = await stack();
    const queue = queueWithReport();
    await queueManager.writeOutputArtifacts(queue, queue.tasks[1]);

    await queueManager.restampReports(queue);
    const report = await fsp.readFile(path.join(artifactsRoot, 'reports', 'report.html'), 'utf8');
    expect(report).toMatch(/status running/);
  });

  it('does not touch an artifact that is not HTML', async () => {
    const { queueManager, artifactsRoot } = await stack();
    const queue = queueWithReport();
    const task = queue.tasks[1];
    task.output = { kind: 'csv', path: 'tables/energies.csv', include: 'records' };
    const [first] = await queueManager.writeOutputArtifacts(queue, task);

    queue.status = 'completed';
    queue.finishedAt = '2026-11-11T01:31:56.114Z';
    await queueManager.restampReports(queue);

    const manifest = JSON.parse(await fsp.readFile(path.join(artifactsRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].sha256).toBe(first.sha256);
  });

  it('restamps the artifact of a real queue run that ends with an output block', async () => {
    const { queueManager, artifactsRoot, events } = await stack();
    const started = await queueManager.start({
      projectName: 'in-run report',
      tasks: [
        {
          nodeId: 'sp',
          type: 'calculate',
          title: 'sp',
          kind: 'SP',
          executable: true,
          engine: 'gaussian',
          inputName: 'sp.gjf',
          outputName: 'sp.out',
          checkpointName: 'sp.chk',
          inputText: 'test\n',
          gates: {},
        },
        {
          nodeId: 'report',
          type: 'output',
          title: 'report',
          output: { kind: 'html', path: 'reports/inrun.html', include: 'records' },
        },
      ],
      edges: [{ from: 'sp', to: 'report', type: 'dependency' }],
      options: { dryRun: true, executable: '', scratchDir: '' },
    });

    await waitFor(() => events.find((event) => event?.type === 'queue-done'));
    const done = await queueManager.get(started.id);
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toBeTruthy();
    expect(done.tasks.find((entry) => entry.nodeId === 'report').status).toBe('completed');

    const html = await fsp.readFile(path.join(artifactsRoot, 'reports', 'inrun.html'), 'utf8');
    expect(html).toMatch(/status completed/);
    expect(html).toContain(`finished ${done.finishedAt}`);
    expect(html).not.toContain('finished not reported');

    const manifest = JSON.parse(await fsp.readFile(path.join(artifactsRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toHaveLength(1);
  });
});
