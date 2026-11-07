import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

const roots = [];
const INPUT = '#p B3LYP/6-31G(d) SP\n\ntest\n\n0 1\nO 0.000000 0.000000 0.117300\n';

function task(nodeId, overrides = {}) {
  return {
    nodeId,
    title: nodeId,
    kind: 'SP',
    executable: true,
    inputName: `${nodeId}.gjf`,
    outputName: `${nodeId}.out`,
    inputText: INPUT,
    gates: {},
    ...overrides,
  };
}

/** Fake Gaussian: no process, deterministic output, configurable per input name. */
function fakeRunner(behaviour = () => ({})) {
  return () => {
    const state = { cancelled: false };
    const cancelledResult = (outputPath) => ({
      exitCode: null,
      signal: 'SIGTERM',
      cancelled: true,
      outputPath,
      outputText: '',
      stdout: '',
      stderr: '',
    });
    return {
      cancel() { state.cancelled = true; },
      async run({ outputName, cwd, onOutput }) {
        const plan = behaviour(outputName) || {};
        const outputPath = path.join(cwd, outputName);
        if (plan.hang) return new Promise(() => {});
        if (plan.delay) {
          for (let waited = 0; waited < plan.delay; waited += 5) {
            if (state.cancelled) return cancelledResult(outputPath);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        if (state.cancelled) return cancelledResult(outputPath);
        if (plan.throw) throw new Error(plan.throw);
        const text = plan.output ?? makeFixtureOutput();
        await fsp.writeFile(outputPath, text, 'utf8');
        onOutput({ stream: 'output', text });
        return {
          exitCode: 0,
          signal: null,
          cancelled: false,
          outputPath,
          outputText: text,
          stdout: '',
          stderr: '',
        };
      },
    };
  };
}

async function makeStack({ behaviour, root, withExecutable = true } = {}) {
  const base = root || await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-queue-'));
  if (!root) roots.push(base);
  const runsRoot = path.join(base, 'runs');
  const queuesRoot = path.join(base, 'queues');
  await fsp.mkdir(runsRoot, { recursive: true });
  const exe = path.join(base, 'g16.exe');
  if (withExecutable) await fsp.writeFile(exe, '');
  const events = [];
  const runManager = new RunManager({
    runsRoot,
    emit: (event) => events.push(event),
    createRunner: fakeRunner(behaviour),
  });
  const queueManager = new QueueManager({
    queuesRoot,
    runManager,
    emit: (event) => events.push(event),
  });
  await queueManager.init();
  return { base, runsRoot, queuesRoot, exe, events, runManager, queueManager };
}

async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const queueOptions = (exe, extra = {}) => ({ dryRun: false, executable: exe, scratchDir: '', ...extra });

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('QueueManager — DAG execution', () => {
  it('runs a 4-node chain unattended in dependency order', async () => {
    const { exe, events, queueManager, runsRoot, queuesRoot } = await makeStack();
    const tasks = [task('a'), task('b'), task('c'), task('d')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'checkpoint' },
      { from: 'c', to: 'd', type: 'dependency' },
    ];
    const started = await queueManager.start({ projectName: 'chain', tasks, edges, options: queueOptions(exe) });
    expect(started.status).toBe('running');

    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'queue completion' });

    expect(finished.status).toBe('completed');
    expect(finished.tasks.map((item) => item.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(finished.tasks.every((item) => item.runId)).toBe(true);

    // Each task produced its own immutable run folder with a parsed record.
    const runDirs = (await fsp.readdir(runsRoot)).sort();
    expect(runDirs).toHaveLength(4);
    for (const dir of runDirs) {
      const record = JSON.parse(await fsp.readFile(path.join(runsRoot, dir, 'run.json'), 'utf8'));
      expect(record.status).toBe('completed');
      expect(record.parsed.termination).toMatch(/normal termination/i);
    }

    // Order: task started events follow the graph, not alphabetical luck.
    const titles = events.filter((event) => event.type === 'started').map((event) => event.record.title);
    expect(titles).toEqual(['a', 'b', 'c', 'd']);
    expect(events.some((event) => event.type === 'queue-done')).toBe(true);

    // The persisted queue stores inputs on disk, not inside queue.json.
    const persisted = JSON.parse(await fsp.readFile(path.join(queuesRoot, started.id, 'queue.json'), 'utf8'));
    expect(persisted.tasks?.every((item) => item.inputText === undefined)).toBe(true);
    expect(await fsp.readdir(path.join(queuesRoot, started.id, 'inputs'))).toHaveLength(4);
  });

  it('respects a diamond join', async () => {
    const { exe, events, queueManager } = await makeStack();
    const tasks = [task('a'), task('b'), task('c'), task('d')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'a', to: 'c', type: 'dependency' },
      { from: 'b', to: 'd', type: 'dependency' },
      { from: 'c', to: 'd', type: 'dependency' },
    ];
    const started = await queueManager.start({ projectName: 'diamond', tasks, edges, options: queueOptions(exe) });
    await waitFor(async () => (await queueManager.get(started.id)).status === 'completed', { label: 'diamond completion' });
    const titles = events.filter((event) => event.type === 'started').map((event) => event.record.title);
    expect(titles).toEqual(['a', 'b', 'c', 'd']);
  });

  it('blocks dependents of a failed task and still runs independent work', async () => {
    const errorOutput = ' Error termination via Lnk1e in C:\\G16W\\l1.exe\n';
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'b.out' ? { output: errorOutput } : {}),
    });
    const tasks = [task('a'), task('b'), task('c'), task('d')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'dependency' },
    ];
    const started = await queueManager.start({ projectName: 'failure', tasks, edges, options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'failure settlement' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.a.status).toBe('completed');
    expect(byId.b.status).toBe('failed');
    expect(byId.c.status).toBe('blocked');
    expect(byId.c.reason).toContain('blocked by b');
    expect(byId.d.status).toBe('completed');
    expect(finished.status).toBe('failed');
  });

  it('rejects a dependency cycle before writing anything', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [task('a'), task('b')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'a', type: 'dependency' },
    ];
    await expect(queueManager.start({ tasks, edges, options: queueOptions(exe) }))
      .rejects.toThrow(/dependency cycle/);
  });

  it('marks control-flow nodes blocked instead of guessing', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [
      task('a'),
      { nodeId: 'cond', title: 'condition', kind: 'If', executable: false },
      task('b'),
    ];
    const edges = [
      { from: 'a', to: 'cond', type: 'dependency' },
      { from: 'cond', to: 'b', type: 'branch', branch: 'true' },
    ];
    const started = await queueManager.start({ projectName: 'control', tasks, edges, options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'control-flow settlement' });
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.cond.status).toBe('blocked');
    expect(byId.cond.reason).toContain('GN-005');
    expect(byId.b.status).toBe('blocked');
    expect(finished.status).toBe('needs-review');
  });
});

describe('QueueManager — durability', () => {
  it('marks an in-flight task interrupted after a crash and resumes it', async () => {
    const first = await makeStack({ behaviour: (outputName) => (outputName === 'b.out' ? { hang: true } : {}) });
    const tasks = [task('a'), task('b'), task('c')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'dependency' },
    ];
    const started = await first.queueManager.start({ projectName: 'crash', tasks, edges, options: queueOptions(first.exe) });
    await waitFor(async () => {
      const queue = await first.queueManager.get(started.id);
      return queue.tasks.find((item) => item.nodeId === 'b')?.status === 'running';
    }, { label: 'task b running' });

    // New app start over the same directories: no process exists for task b.
    const second = await makeStack({ root: first.base, withExecutable: false });
    const reconciled = await second.queueManager.get(started.id);
    expect(reconciled.status).toBe('paused');
    expect(reconciled.tasks.find((item) => item.nodeId === 'b').status).toBe('interrupted');
    expect(reconciled.tasks.find((item) => item.nodeId === 'b').error).toMatch(/app exited/i);

    const resumed = await second.queueManager.resume(started.id);
    expect(resumed.resumed).toBe(true);
    const finished = await waitFor(async () => {
      const queue = await second.queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'resumed completion' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.b.status).toBe('completed');
    expect(byId.b.attempts).toBe(2);
    expect(byId.c.status).toBe('completed');
    expect(finished.status).toBe('completed');
  });

  it('pauses after the current task and resumes the rest', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { delay: 60 } : {}),
    });
    const tasks = [task('a'), task('b')];
    const edges = [{ from: 'a', to: 'b', type: 'dependency' }];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    await waitFor(async () => (await queueManager.get(started.id)).tasks[0].status === 'running', { label: 'a running' });

    expect((await queueManager.pause(started.id)).paused).toBe(true);
    await waitFor(async () => (await queueManager.get(started.id)).tasks[0].status === 'completed', { label: 'a finished' });
    const paused = await queueManager.get(started.id);
    expect(paused.status).toBe('paused');
    expect(paused.tasks[1].status).toBe('pending');

    expect((await queueManager.resume(started.id)).resumed).toBe(true);
    await waitFor(async () => (await queueManager.get(started.id)).status === 'completed', { label: 'resumed queue' });
    expect((await queueManager.get(started.id)).tasks[1].status).toBe('completed');
  });

  it('cancels the current run and every pending task', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { delay: 200 } : {}),
    });
    const tasks = [task('a'), task('b'), task('c')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'dependency' },
    ];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    await waitFor(async () => (await queueManager.get(started.id)).tasks[0].status === 'running', { label: 'a running' });
    await queueManager.cancel(started.id);
    const cancelled = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return queue.status === 'cancelled' && queue.tasks[0].status !== 'running' ? queue : null;
    }, { label: 'cancellation' });
    expect(cancelled.tasks.map((item) => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it('lists persisted queues newest first', async () => {
    const { exe, queueManager } = await makeStack();
    const first = await queueManager.start({ projectName: 'one', tasks: [task('a')], edges: [], options: queueOptions(exe) });
    await waitFor(async () => (await queueManager.get(first.id)).status === 'completed', { label: 'first queue' });
    const second = await queueManager.start({ projectName: 'two', tasks: [task('a')], edges: [], options: queueOptions(exe) });
    await waitFor(async () => (await queueManager.get(second.id)).status === 'completed', { label: 'second queue' });

    const list = await queueManager.list();
    expect(list.map((queue) => queue.projectName)).toEqual(['two', 'one']);
    expect(list[0].tasks[0].inputText).toBeUndefined();
  });
});
