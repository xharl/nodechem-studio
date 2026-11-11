import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * Issue #231: every engine names its restart artifact differently. The queue
 * must ask the engine, not assume a Gaussian `.chk`, or ORCA can never start.
 */

const roots = [];
const managers = [];

async function waitFor(check, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the queue');
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.flush()));
  await Promise.all(roots.splice(0).map((dir) => rmrf(dir)));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-artifacts-'));
  roots.push(base);
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  managers.push(queueManager);
  await queueManager.init();
  return { queueManager };
}

const task = (nodeId, engine, inputName, checkpointName) => ({
  nodeId,
  type: 'calculate',
  title: nodeId,
  kind: 'SP',
  executable: true,
  engine,
  inputName,
  outputName: `${nodeId}.out`,
  inputText: 'test\n',
  gates: {},
  ...(checkpointName ? { checkpointName } : {}),
});

describe('queue restart artifacts (#231)', () => {
  it('accepts each registered engine with its own restart artifact', async () => {
    const { queueManager } = await stack();
    const tasks = [
      task('g', 'gaussian', 'g.gjf', 'g.chk'),
      task('o', 'orca', 'o.inp', 'o.gbw'),
      task('x', 'xtb', 'x.xyz'),
      task('p', 'psi4', 'p.dat'),
    ];
    const started = await queueManager.start({
      projectName: 'artifacts',
      tasks,
      edges: [],
      options: { dryRun: true, executable: '', scratchDir: '' },
    });
    expect(started.tasks.map((entry) => entry.nodeId)).toEqual(['g', 'o', 'x', 'p']);
    // Let the dry-run fixtures settle before the temp tree is removed; a
    // teardown that races a run write is the ENOTEMPTY flake CI caught.
    await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return queue && !['idle', 'running'].includes(queue.status) ? queue : null;
    });
    await queueManager.flush();
  });

  it('names the expected artifact when the extension is wrong', async () => {
    const { queueManager } = await stack();
    await expect(queueManager.start({
      projectName: 'wrong-gaussian',
      tasks: [task('g', 'gaussian', 'g.gjf', 'g.gbw')],
      edges: [],
      options: { dryRun: true, executable: '', scratchDir: '' },
    })).rejects.toThrow(/must match \.chk/);
    await expect(queueManager.start({
      projectName: 'wrong-orca',
      tasks: [task('o', 'orca', 'o.inp', '../o.gbw')],
      edges: [],
      options: { dryRun: true, executable: '', scratchDir: '' },
    })).rejects.toThrow(/must match \.gbw/);
  });
});
