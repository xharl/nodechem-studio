import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { processAlive } from '../electron/runner/processTree.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';
import { engineFor } from '../src/shared/engines/index.js';
import { blockedPendingTasks, finalStatus } from '../src/shared/workflowGraph.js';
import { nextAction, nodeStatesFromQueue } from '../src/shared/queueReconcile.js';

/**
 * Issue 177: a hung engine must not hold a queue slot.
 *
 * The limit is a wall clock enforced around the child process. These tests use
 * a stub executable that really sleeps past a 1 s limit — so the kill path is
 * exercised on a live process tree, not simulated — plus an in-process runner
 * whose promise never settles, which is the state a hung wrapper is in.
 *
 * Waits are on real events (the run manager's `done` event, the queue's
 * terminal status) rather than fixed sleeps, because `test/queue.test.js` has a
 * history of async-wait flakes and this file must not add to it.
 */

const roots = [];
const managers = [];

const INPUT = '#p B3LYP/6-31G(d) SP\n\ntest\n\n0 1\nO 0.000000 0.000000 0.117300\n';

async function tempRoot() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-timeout-'));
  roots.push(base);
  return base;
}

async function makeStack({ createRunner } = {}) {
  const base = await tempRoot();
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  await fsp.mkdir(runsRoot, { recursive: true });
  const exe = path.join(base, 'g16.exe');
  await fsp.writeFile(exe, '');
  const events = [];
  const runManager = new RunManager({
    runsRoot,
    emit: (event) => events.push(event),
    ...(createRunner ? { createRunner } : {}),
  });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: (event) => events.push(event) });
  // Subscribe to the run manager before anything can finish and buffer what
  // arrives, so no test can miss a `done` event in a scheduling gap.
  bufferFor(runManager);
  await queueManager.init();
  managers.push(queueManager);
  return { base, runsRoot, queuesRoot, exe, events, runManager, queueManager };
}

/** Poll a condition without a fixed sleep; the label names what never arrived. */
async function waitFor(check, { timeout = 20000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started >= timeout) throw new Error(`Timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The `done` event for a run. The listener is attached once per manager and
 * late subscribers get the buffered record: a fast fixture run can settle
 * before the test reaches its `await`, and a lost event is exactly the kind of
 * flake this file must not have.
 */
const doneBuffers = new WeakMap();

function bufferFor(runManager) {
  let buffer = doneBuffers.get(runManager);
  if (!buffer) {
    buffer = { seen: new Map(), waiters: new Map() };
    doneBuffers.set(runManager, buffer);
    runManager.onEvent((event) => {
      if (event.type !== 'done') return;
      buffer.seen.set(event.runId, event.record);
      const resolve = buffer.waiters.get(event.runId);
      if (resolve) {
        buffer.waiters.delete(event.runId);
        resolve(event.record);
      }
    });
  }
  return buffer;
}

function doneFor(runManager, runId) {
  const buffer = bufferFor(runManager);
  if (buffer.seen.has(runId)) return Promise.resolve(buffer.seen.get(runId));
  return new Promise((resolve) => buffer.waiters.set(runId, resolve));
}

/** A runner that never settles, optionally writing output first. */
function hangingRunner({ lines = [], file = null } = {}) {
  return () => ({
    cancelled: false,
    cancel() {
      this.cancelled = true;
      return undefined;
    },
    async run({ outputName, cwd, onOutput }) {
      for (const line of lines) onOutput({ stream: 'output', text: `${line}\n` });
      if (file) {
        await fsp.writeFile(path.join(cwd, outputName), file, 'utf8');
        // A real runner tails the file; the last line has to travel.
        onOutput({ stream: 'output', file: outputName, text: file });
      }
      return new Promise(() => {});
    },
  });
}

/** A runner that finishes immediately with a clean fixture log. */
function fixtureRunner() {
  return () => ({
    cancel() {},
    async run({ outputName, cwd, onOutput }) {
      const text = makeFixtureOutput();
      await fsp.writeFile(path.join(cwd, outputName), text, 'utf8');
      onOutput({ stream: 'output', text });
      return { exitCode: 0, signal: null, cancelled: false, outputPath: path.join(cwd, outputName), outputText: text, stdout: '', stderr: '' };
    },
  });
}

const runPayload = (executable, overrides = {}) => ({
  engine: 'gaussian',
  title: 'timeout probe',
  inputText: INPUT,
  inputName: 'probe.gjf',
  outputName: 'probe.out',
  executable,
  dryRun: false,
  gates: {},
  ...overrides,
});

const taskPayload = (nodeId, overrides = {}) => ({
  nodeId,
  title: nodeId,
  kind: 'SP',
  executable: true,
  inputName: `${nodeId}.gjf`,
  outputName: `${nodeId}.out`,
  inputText: INPUT,
  gates: {},
  ...overrides,
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.dispose?.();
    await manager.flush?.().catch(() => {});
  }
  for (const root of roots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe('a run stopped at its wall-clock limit (issue 177)', () => {
  it('records `timed out` with the limit, the elapsed seconds and the last output line', async () => {
    const { runManager, exe } = await makeStack({
      createRunner: hangingRunner({ lines: [' #p B3LYP/6-31G(d) SP', ' SCF Done:  E(RB3LYP) =  -76.0267608317'] }),
    });
    const { runId, runDir } = await runManager.start(runPayload(exe, { timeoutSeconds: 1 }));
    const record = await doneFor(runManager, runId);

    expect(record.status).toBe('timed out');
    expect(record.timeout.limitSeconds).toBe(1);
    // Measured, not assumed: the deadline really is a wall clock.
    expect(record.timeout.elapsedSeconds).toBeGreaterThanOrEqual(0.9);
    expect(record.timeout.elapsedSeconds).toBeLessThan(15);
    expect(record.timeout.lastOutput).toBe('SCF Done:  E(RB3LYP) =  -76.0267608317');
    // A partial log is not a result, and no exit code is invented for a kill.
    expect(record.parsed).toBe(null);
    expect(record.gates).toBe(null);
    expect(record.exitCode).toBe(null);
    expect(record.error).toMatch(/wall-clock limit/);
    // What is on disk is what the event carried.
    const onDisk = JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'));
    expect(onDisk.status).toBe('timed out');
    expect(onDisk.timeout).toEqual(record.timeout);
  });

  it('reports a runner that cannot report its kill as unverified, not as stopped', async () => {
    const { runManager, exe } = await makeStack({ createRunner: hangingRunner() });
    const { runId } = await runManager.start(runPayload(exe, { timeoutSeconds: 1 }));
    const record = await doneFor(runManager, runId);
    expect(record.status).toBe('timed out');
    // The fake runner's cancel() returns nothing, so there is no kill report.
    expect(record.timeout.tree).toBe(null);
    expect(record.timeout.lastOutput).toBe(null);
  });

  it('does not parse a log that was truncated mid-block', async () => {
    const full = makeFixtureOutput();
    const cut = full.indexOf(' SCF Done:');
    expect(cut).toBeGreaterThan(0);
    // Cut inside the energy line: no complete final energy, no termination.
    const truncated = full.slice(0, cut + 20);
    const engine = engineFor('gaussian');
    const parsedFragment = engine.parse(truncated);
    expect(parsedFragment.finalEnergy?.hartree ?? null).toBe(null);

    const { runManager, exe } = await makeStack({ createRunner: hangingRunner({ file: truncated }) });
    const { runId } = await runManager.start(runPayload(exe, { timeoutSeconds: 1 }));
    const record = await doneFor(runManager, runId);

    expect(record.status).toBe('timed out');
    expect(record.parsed).toBe(null);
    expect(record.gates).toBe(null);
    // The row can still say where it was when it was stopped.
    expect(record.timeout.lastOutput).toContain('SCF Done:');
  });

  it('leaves a run that finishes inside its limit byte-identical to one with no limit', async () => {
    const { runManager, exe } = await makeStack({ createRunner: fixtureRunner() });
    const without = await runManager.start(runPayload(exe));
    // Subscribe before the second start: a fixture run can settle while the
    // next one is being prepared.
    const plainDone = doneFor(runManager, without.runId);
    const withLimit = await runManager.start(runPayload(exe, { timeoutSeconds: 3600 }));
    const [plain, limited] = await Promise.all([plainDone, doneFor(runManager, withLimit.runId)]);

    expect(plain.status).toBe(limited.status);
    expect(plain.timeout).toBeUndefined();
    expect(limited.timeout).toBeUndefined();
    // Ids, timestamps and the per-run scratch path are the only fields that can
    // differ between two runs of the same input; everything else must be equal.
    const strip = (record) => {
      const copy = JSON.parse(JSON.stringify(record));
      delete copy.id;
      delete copy.startedAt;
      delete copy.finishedAt;
      delete copy.scratchDir;
      return copy;
    };
    expect(JSON.stringify(strip(limited))).toBe(JSON.stringify(strip(plain)));
  });
});

describe('the queue moves on after a timeout (issue 177)', () => {
  /** Hangs on `slow.out`, answers everything else with the fixture. */
  const selective = () => () => ({
    cancel() {
      this.cancelled = true;
    },
    async run({ outputName, cwd, onOutput }) {
      if (outputName === 'slow.out') {
        onOutput({ stream: 'output', text: ' SCF Done:  E(RB3LYP) =  -76.0\n' });
        return new Promise(() => {});
      }
      const text = makeFixtureOutput();
      await fsp.writeFile(path.join(cwd, outputName), text, 'utf8');
      onOutput({ stream: 'output', text });
      return { exitCode: 0, signal: null, cancelled: false, outputPath: path.join(cwd, outputName), outputText: text, stdout: '', stderr: '' };
    },
  });

  it('kills the hung task, records what it carried, and runs the next one', async () => {
    const { exe, queueManager } = await makeStack({ createRunner: selective() });
    const queue = await queueManager.start({
      projectName: 'timeout queue',
      // No edge between them: the point is that the slot is free, so the
      // scheduler starts the next ready task on its own.
      tasks: [taskPayload('slow'), taskPayload('fast')],
      edges: [],
      options: { dryRun: false, executable: exe, scratchDir: '', timeoutSeconds: 1 },
    });

    const settled = await waitFor(async () => {
      const current = await queueManager.get(queue.id);
      return current && ['completed', 'failed', 'needs-review', 'partial'].includes(current.status) ? current : null;
    }, { label: 'the queue to settle' });

    const slow = settled.tasks.find((task) => task.nodeId === 'slow');
    const fast = settled.tasks.find((task) => task.nodeId === 'fast');
    expect(slow.status).toBe('timed out');
    expect(slow.timeout).toMatchObject({ limitSeconds: 1 });
    expect(slow.timeout.elapsedSeconds).toBeGreaterThanOrEqual(0.9);
    expect(slow.timeout.lastOutput).toContain('SCF Done:');
    expect(slow.status).not.toBe('failed');
    // The slot was released: the second task ran and passed its gates.
    expect(fast.status).toBe('completed');
    expect(fast.attempts).toBe(1);
    // A stopped task is not a code failure: the queue asks for a decision.
    expect(settled.status).toBe('needs-review');
    expect(settled.timeoutSeconds).toBe(1);
  });

  it('lets a block override the project limit', async () => {
    const { exe, queueManager } = await makeStack({ createRunner: selective() });
    const queue = await queueManager.start({
      projectName: 'block override',
      tasks: [
        taskPayload('slow', { settings: { timeoutSeconds: 1 } }),
        taskPayload('fast'),
      ],
      edges: [],
      // The generous project default: only the block's own second stops it.
      options: { dryRun: false, executable: exe, scratchDir: '', timeoutSeconds: 3600 },
    });

    const settled = await waitFor(async () => {
      const current = await queueManager.get(queue.id);
      return current && ['completed', 'failed', 'needs-review', 'partial'].includes(current.status) ? current : null;
    }, { label: 'the queue to settle' });

    const slow = settled.tasks.find((task) => task.nodeId === 'slow');
    expect(slow.timeoutSeconds).toBe(1);
    expect(slow.status).toBe('timed out');
    expect(settled.tasks.find((task) => task.nodeId === 'fast').status).toBe('completed');
  });

  it('blocks a dependent instead of running it on the missing result', () => {
    const tasks = [
      { nodeId: 'slow', status: 'timed out', title: 'slow' },
      { nodeId: 'after', status: 'pending', title: 'after' },
    ];
    const blocked = blockedPendingTasks(tasks, [{ from: 'slow', to: 'after', type: 'dependency' }]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].nodeId).toBe('after');
    expect(blocked[0].reason).toContain('timed out');
  });
});

describe('`timed out` is its own state, not a failure (issue 177)', () => {
  it('settles a queue as needs-review, never as completed or failed', () => {
    expect(finalStatus([{ status: 'timed out' }])).toBe('needs-review');
    expect(finalStatus([{ status: 'timed out' }, { status: 'completed' }])).toBe('needs-review');
    expect(finalStatus([{ status: 'failed' }])).toBe('failed');
  });

  it('maps a timed-out family to the block state `timed out`, and the Next Action to `timeout`', () => {
    const states = nodeStatesFromQueue([{ nodeId: 'slow', status: 'timed out' }]);
    expect(states.get('slow')).toBe('timed out');
    const nodes = [
      { id: 'slow', type: 'calculate', state: 'timed out', title: 'slow' },
      { id: 'next', type: 'calculate', state: 'ready', title: 'next' },
    ];
    // A timeout outranks unrun work: it already cost a slot and needs a decision.
    expect(nextAction(nodes)).toMatchObject({ kind: 'timeout', node: { id: 'slow' } });
    // A real failure still outranks it — that is the one to examine.
    nodes.push({ id: 'bad', type: 'calculate', state: 'review', title: 'bad' });
    expect(nextAction(nodes)?.kind).toBe('review');
  });
});

describe('the process tree is what gets stopped (issue 177)', () => {
  /**
   * A stub engine that starts a real inner process, writes its pid down, and
   * then hangs. The limit must reach the inner binary too: a wrapper dying
   * alone would leave the calculation running with no queue slot to show it.
   */
  const STUB = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const inner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
fs.writeFileSync(path.join(__dirname, 'inner.pid'), String(inner.pid));
process.stdout.write(' LINK 9999 starting, inner pid ' + inner.pid + '\\n');
setInterval(() => {}, 1000);
`;

  it.skipIf(process.platform === 'win32')('kills the inner binary as well, and says the tree died', async () => {
    const { base, runManager } = await makeStack();
    const stub = path.join(base, 'stub-engine');
    await fsp.writeFile(stub, STUB, { mode: 0o755 });
    await fsp.chmod(stub, 0o755);

    const { runId, runDir } = await runManager.start(runPayload(stub, { timeoutSeconds: 1 }));
    const record = await doneFor(runManager, runId);

    expect(record.status).toBe('timed out');
    expect(record.timeout.limitSeconds).toBe(1);
    expect(record.timeout.lastOutput).toMatch(/LINK 9999 starting/);
    // The tree kill reported, and it reached the real children.
    expect(record.timeout.tree).toEqual({ escalated: false, survived: false });

    const pidFile = path.join(base, 'inner.pid');
    const innerPid = Number(await waitFor(
      () => fsp.readFile(pidFile, 'utf8').catch(() => ''),
      { label: 'the inner pid file' },
    ));
    expect(Number.isInteger(innerPid)).toBe(true);
    // Not assumed: the pid really is gone, polled rather than slept on.
    await waitFor(
      () => !processAlive(innerPid),
      { label: `inner pid ${innerPid} to die`, timeout: 10000 },
    );
    expect(processAlive(innerPid)).toBe(false);
    // The run folder still holds the record, not a fabricated result.
    const onDisk = JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'));
    expect(onDisk.parsed).toBe(null);
  });
});
