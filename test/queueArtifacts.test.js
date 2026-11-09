import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

/**
 * Issue #231: every engine names its restart artifact differently. The queue
 * must ask the engine, not assume a Gaussian `.chk`, or ORCA can never start.
 */

const roots = [];
const managers = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.flush()));
  await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
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
    await queueManager.cancel(started.id);
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
