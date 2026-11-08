import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';
import { makeXtbFixtureOutput } from '../src/shared/engines/xtb.js';

const roots = [];
const INPUT = '#p B3LYP/6-31G(d) SP\n\ntest\n\n0 1\nO 0.000000 0.000000 0.117300\n';
const XTB_INPUT = '3\nxTB task\nO 0.000000 0.000000 0.117300\nH 0.000000 0.757200 -0.469200\nH 0.000000 -0.757200 -0.469200\n';

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
  const attempts = new Map();
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
      async run({ outputName, inputName, cwd, onOutput }) {
        const attempt = (attempts.get(outputName) || 0) + 1;
        attempts.set(outputName, attempt);
        const plan = behaviour(outputName, { attempt, inputName, cwd }) || {};
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
        if (plan.checkpoint) {
          await fsp.writeFile(path.join(cwd, plan.checkpoint), plan.checkpointBytes ?? 'checkpoint-bytes', 'utf8');
        }
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

// Waiting on a child process chain on a loaded Windows runner is not the same
// budget as waiting in memory: the label in the failure message is what tells
// the next reader which state never landed, so the wait is generous on purpose.
async function waitFor(check, { timeout = 20000, label = 'condition' } = {}) {
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

  it('rejects a second queue while one is active', async () => {
    const { exe, queueManager } = await makeStack({ behaviour: () => ({ delay: 200 }) });
    const tasks = [task('a')];
    const started = await queueManager.start({ projectName: 'first', tasks, options: queueOptions(exe) });
    await expect(queueManager.start({ projectName: 'second', tasks, options: queueOptions(exe) }))
      .rejects.toThrow(/still running/);
    await waitFor(async () => (await queueManager.get(started.id)).status === 'completed', { label: 'first completion' });
  });

  it('serializes concurrent start calls so a double click cannot create two queues', async () => {
    const { exe, queueManager } = await makeStack({ behaviour: () => ({ delay: 200 }) });
    const tasks = [task('a')];
    const [first, second] = await Promise.allSettled([
      queueManager.start({ projectName: 'first', tasks, options: queueOptions(exe) }),
      queueManager.start({ projectName: 'second', tasks, options: queueOptions(exe) }),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const started = first.status === 'fulfilled' ? first.value : second.value;
    await waitFor(async () => (await queueManager.get(started.id)).status === 'completed', { label: 'single queue completion' });
  });

  it('persists validity context in queue.json so a restart can evaluate the same checks', async () => {
    const { exe, queueManager, queuesRoot, runManager } = await makeStack();
    const validity = {
      settings: { jobType: 'Freq', method: 'B3LYP', basis: 'def2-SVP' },
      molecule: { charge: 1, multiplicity: 2, coords: [{ element: 'O', x: 0, y: 0, z: 0 }] },
      upstream: null,
    };
    const started = await queueManager.start({
      projectName: 'validity',
      tasks: [task('a', { validity })],
      options: queueOptions(exe),
    });
    await waitFor(async () => (await queueManager.get(started.id)).status === 'completed', { label: 'validity completion' });
    const persisted = JSON.parse(await fsp.readFile(path.join(queuesRoot, started.id, 'queue.json'), 'utf8'));
    expect(persisted.tasks[0].validity).toMatchObject(validity);
    expect(persisted.tasks[0].inputText).toBeUndefined();

    const reloaded = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await reloaded.init();
    expect(reloaded.queues.get(started.id).tasks[0].validity).toMatchObject(validity);
    reloaded.dispose();
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

  it('skips note nodes and lets their dependents run', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [
      { nodeId: 'note', type: 'note', title: 'note', kind: 'Note', executable: false },
      task('a'),
    ];
    const edges = [{ from: 'note', to: 'a', type: 'dependency' }];
    const started = await queueManager.start({ projectName: 'note', tasks, edges, options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'note settlement' });
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.note.status).toBe('skipped');
    expect(byId.note.reason).toContain('notes are not executed');
    expect(byId.a.status).toBe('completed');
    expect(finished.status).toBe('completed');
  });
});

describe('QueueManager — condition and loop runtime', () => {
  const settle = (finished) => ['completed', 'failed', 'needs-review'].includes(finished.status);
  const waitQueue = async (queueManager, id) => waitFor(async () => {
    const queue = await queueManager.get(id);
    return settle(queue) ? queue : null;
  }, { label: 'control-flow settlement' });

  it('evaluates a condition and releases exactly one branch', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [
      task('a'),
      { nodeId: 'cond', type: 'condition', title: 'cond', kind: 'If', executable: false, condition: { expression: 'imaginaryCount == 0', unknown: 'block-both' } },
      task('b'),
      task('c'),
    ];
    const edges = [
      { from: 'a', to: 'cond', type: 'dependency' },
      { from: 'cond', to: 'b', type: 'branch', branch: 'true' },
      { from: 'cond', to: 'c', type: 'branch', branch: 'false' },
    ];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitQueue(queueManager, started.id);
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.cond.conditionResult).toBe(true);
    expect(byId.b.status).toBe('completed');
    expect(byId.c.status).toBe('skipped');
    expect(byId.c.reason).toContain('branch false not taken');
    expect(finished.status).toBe('completed');
  });

  it('routes a false condition through a retry loop until it passes', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName, { attempt }) => (outputName === 'a.out'
        ? { output: makeFixtureOutput({ imaginary: attempt >= 2 ? 1 : 0 }) }
        : {}),
    });
    const tasks = [
      task('a'),
      { nodeId: 'cond', type: 'condition', title: 'cond', kind: 'If', executable: false, condition: { expression: 'imaginaryCount == 1', unknown: 'block-both' } },
      task('b'),
      { nodeId: 'retry', type: 'loop', title: 'retry', kind: 'Loop', executable: false, loop: { maxAttempts: 2, mode: 'retry', target: 'a' } },
    ];
    const edges = [
      { from: 'a', to: 'cond', type: 'dependency' },
      { from: 'cond', to: 'b', type: 'branch', branch: 'true' },
      { from: 'cond', to: 'retry', type: 'branch', branch: 'false' },
      { from: 'retry', to: 'a', type: 'loop' },
    ];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitQueue(queueManager, started.id);
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));

    expect(finished.status).toBe('completed');
    expect(byId.a.attempts).toBe(2);
    expect(byId.a.history).toHaveLength(1);
    expect(byId.retry.loopAttempts).toBe(1);
    expect(byId.retry.status).toBe('skipped');
    expect(byId.cond.conditionResult).toBe(true);
    expect(byId.b.status).toBe('completed');
  });

  it('stops an exhausted loop with a recorded reason', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { output: makeFixtureOutput({ imaginary: 0 }) } : {}),
    });
    const tasks = [
      task('a'),
      { nodeId: 'cond', type: 'condition', title: 'cond', kind: 'If', executable: false, condition: { expression: 'imaginaryCount == 1', unknown: 'block-both' } },
      { nodeId: 'retry', type: 'loop', title: 'retry', kind: 'Loop', executable: false, loop: { maxAttempts: 2, mode: 'retry', target: 'a' } },
    ];
    const edges = [
      { from: 'a', to: 'cond', type: 'dependency' },
      { from: 'cond', to: 'retry', type: 'branch', branch: 'false' },
      { from: 'retry', to: 'a', type: 'loop' },
    ];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitQueue(queueManager, started.id);
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));

    expect(finished.status).toBe('failed');
    expect(byId.retry.status).toBe('failed');
    expect(byId.retry.reason).toContain('loop exhausted after 2 attempt(s)');
    expect(byId.retry.loopAttempts).toBe(2);
    expect(byId.a.attempts).toBe(3);
  });

  it('blocks both branches when the condition is unknown', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [
      task('a'),
      { nodeId: 'cond', type: 'condition', title: 'cond', kind: 'If', executable: false, condition: { expression: 'magnetization > 0', unknown: 'block-both' } },
      task('b'),
      task('c'),
    ];
    const edges = [
      { from: 'a', to: 'cond', type: 'dependency' },
      { from: 'cond', to: 'b', type: 'branch', branch: 'true' },
      { from: 'cond', to: 'c', type: 'branch', branch: 'false' },
    ];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitQueue(queueManager, started.id);
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.cond.status).toBe('blocked');
    expect(byId.cond.reason).toContain('magnetization');
    expect(byId.b.status).toBe('blocked');
    expect(byId.c.status).toBe('blocked');
    expect(finished.status).toBe('needs-review');
  });

  it('never auto-passes a review gate and blocks its dependents', async () => {
    const noFrequency = [
      ' SCF Done:  E(RB3LYP) =  -76.000000000     A.U. after    8 cycles',
      ' Normal termination of Gaussian 16 at Fri Nov  7 12:00:00 2026.',
      '',
    ].join('\n');
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { output: noFrequency } : {}),
    });
    const tasks = [task('a', { gates: { requireFrequency: true } }), task('b')];
    const edges = [{ from: 'a', to: 'b', type: 'dependency' }];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitQueue(queueManager, started.id);
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.a.status).toBe('needs-review');
    expect(byId.b.status).toBe('blocked');
    expect(finished.status).toBe('needs-review');

    await queueManager.resume(started.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterResume = await queueManager.get(started.id);
    const afterById = Object.fromEntries(afterResume.tasks.map((item) => [item.nodeId, item]));
    expect(afterById.a.status).toBe('needs-review');
    expect(afterById.b.status).toBe('blocked');
    expect(afterResume.status).toBe('needs-review');
  });

  it('completes a merge node and blocks at an output node', async () => {
    const { exe, queueManager } = await makeStack();
    const tasks = [
      task('a'),
      { nodeId: 'join', type: 'merge', title: 'join', kind: 'Merge', executable: false, merge: { policy: 'all' } },
      { nodeId: 'out', type: 'output', title: 'out', kind: 'Output', executable: false },
    ];
    const edges = [
      { from: 'a', to: 'join', type: 'dependency' },
      { from: 'join', to: 'out', type: 'dependency' },
    ];
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitQueue(queueManager, started.id);
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.join.status).toBe('completed');
    expect(byId.join.reason).toContain('policy all');
    expect(byId.out.status).toBe('blocked');
    expect(byId.out.reason).toContain('GN-008');
    expect(finished.status).toBe('needs-review');
  });
});

describe('QueueManager — checkpoint staging', () => {
  const checkpointChain = () => ({
    tasks: [
      task('a', { kind: 'Opt', checkpointName: 'a.chk' }),
      task('b', { checkpointName: 'b.chk', checkpointFrom: { nodeId: 'a', checkpoint: 'a.chk' } }),
      task('c'),
    ],
    edges: [
      { from: 'a', to: 'b', type: 'checkpoint' },
      { from: 'b', to: 'c', type: 'dependency' },
    ],
  });

  it('copies the upstream checkpoint into the downstream run folder', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out'
        ? { checkpoint: 'a.chk', checkpointBytes: 'real-checkpoint-bytes' }
        : {}),
    });
    const { tasks, edges } = checkpointChain();
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'checkpoint chain' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.b.status).toBe('completed');
    expect(await fsp.readFile(path.join(byId.b.runDir, 'a.chk'), 'utf8')).toBe('real-checkpoint-bytes');
    const record = JSON.parse(await fsp.readFile(path.join(byId.b.runDir, 'run.json'), 'utf8'));
    expect(record.checkpointHandoff).toMatchObject({
      kind: 'copy',
      file: 'a.chk',
      sourceRunId: byId.a.runId,
      bytes: Buffer.byteLength('real-checkpoint-bytes'),
    });
  });

  it('fails the downstream task when the upstream checkpoint never appears', async () => {
    const { exe, queueManager } = await makeStack();
    const { tasks, edges } = checkpointChain();
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'missing checkpoint settlement' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.a.status).toBe('completed');
    expect(byId.b.status).toBe('failed');
    expect(byId.b.error).toMatch(/does not exist/);
    expect(byId.c.status).toBe('blocked');
    const record = JSON.parse(await fsp.readFile(path.join(byId.b.runDir, 'run.json'), 'utf8'));
    expect(record.status).toBe('failed');
    expect(record.error).toMatch(/does not exist/);
    expect(finished.status).toBe('failed');
  });

  it('fails on an empty (corrupt) checkpoint', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { checkpoint: 'a.chk', checkpointBytes: '' } : {}),
    });
    const { tasks, edges } = checkpointChain();
    const started = await queueManager.start({ tasks, edges, options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'corrupt checkpoint settlement' });
    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.b.status).toBe('failed');
    expect(byId.b.error).toMatch(/empty \(corrupt checkpoint\)/);
  });

  it('refuses a name mismatch between writer and reader', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { checkpoint: 'a.chk' } : {}),
    });
    const tasks = [
      task('a', { kind: 'Opt', checkpointName: 'a.chk' }),
      task('b', { checkpointName: 'b.chk', checkpointFrom: { nodeId: 'a', checkpoint: 'other.chk' } }),
    ];
    const started = await queueManager.start({ tasks, edges: [{ from: 'a', to: 'b', type: 'checkpoint' }], options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'mismatch settlement' });
    const b = finished.tasks.find((item) => item.nodeId === 'b');
    expect(b.status).toBe('failed');
    expect(b.error).toMatch(/Checkpoint mismatch: "a" writes a\.chk but this task reads other\.chk/);
  });

  it('stages a labelled fixture checkpoint in a dry run', async () => {
    const { queueManager } = await makeStack();
    const tasks = [
      task('a', { kind: 'Opt', checkpointName: 'a.chk' }),
      task('b', { checkpointName: 'b.chk', checkpointFrom: { nodeId: 'a', checkpoint: 'a.chk' } }),
    ];
    const started = await queueManager.start({
      tasks,
      edges: [{ from: 'a', to: 'b', type: 'checkpoint' }],
      options: { dryRun: true, executable: '', scratchDir: '' },
    });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'dry-run checkpoint chain', timeout: 8000 });

    const b = finished.tasks.find((item) => item.nodeId === 'b');
    expect(finished.status).toBe('completed');
    const staged = await fsp.readFile(path.join(b.runDir, 'a.chk'), 'utf8');
    expect(staged.startsWith('FIXTURE CHECKPOINT')).toBe(true);
    const record = JSON.parse(await fsp.readFile(path.join(b.runDir, 'run.json'), 'utf8'));
    expect(record.checkpointHandoff.kind).toBe('fixture');
  });

  it('does not stage a checkpoint for a plain dependency edge', async () => {
    const { exe, queueManager } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { checkpoint: 'a.chk' } : {}),
    });
    const tasks = [task('a', { checkpointName: 'a.chk' }), task('b')];
    const started = await queueManager.start({ tasks, edges: [{ from: 'a', to: 'b', type: 'dependency' }], options: queueOptions(exe) });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'plain dependency settlement' });
    const b = finished.tasks.find((item) => item.nodeId === 'b');
    expect(b.status).toBe('completed');
    const record = JSON.parse(await fsp.readFile(path.join(b.runDir, 'run.json'), 'utf8'));
    expect(record.checkpointHandoff).toBeNull();
    await expect(fsp.access(path.join(b.runDir, 'a.chk'))).rejects.toThrow();
  });

  const xtbTask = (nodeId, overrides = {}) => task(nodeId, {
    engine: 'xtb',
    kind: 'Opt',
    inputName: `${nodeId}.xyz`,
    outputName: `${nodeId}.out`,
    inputText: XTB_INPUT,
    argv: [`${nodeId}.xyz`, '--gfn', '2', '--opt', 'normal'],
    settings: { jobType: 'Opt', xtbMethod: 'gfn2', xtbOptLevel: 'normal' },
    ...overrides,
  });
  const xtbBehaviour = (outputName) => ({
    output: makeXtbFixtureOutput(),
    ...(outputName === 'a.out' ? { checkpoint: 'xtbrestart', checkpointBytes: 'xTB restart bytes' } : {}),
  });

  it('stages the engine-declared xTB restart artifact for a queued edge', async () => {
    const { exe, queueManager, queuesRoot } = await makeStack({ behaviour: xtbBehaviour });
    // The task payload still carries the pre-#40 `.chk` UI names on purpose.
    const tasks = [
      xtbTask('a', { checkpointName: 'a.chk' }),
      xtbTask('b', {
        kind: 'Freq',
        argv: ['b.xyz', '--gfn', '2', '--hess'],
        checkpointName: 'b.chk',
        checkpointFrom: { nodeId: 'a', checkpoint: 'a.chk' },
      }),
    ];
    const started = await queueManager.start({
      tasks,
      edges: [{ from: 'a', to: 'b', type: 'checkpoint' }],
      options: queueOptions(exe),
    });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'xTB checkpoint chain' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.a.status).toBe('completed');
    expect(byId.b.status).toBe('completed');
    expect(finished.status).toBe('completed');

    // The queue resolved both sides of the edge to the engine's artifact.
    const persisted = JSON.parse(await fsp.readFile(path.join(queuesRoot, started.id, 'queue.json'), 'utf8'));
    const persistedById = Object.fromEntries(persisted.tasks.map((item) => [item.nodeId, item]));
    expect(persistedById.a.checkpointName).toBe('xtbrestart');
    expect(persistedById.b.checkpointFrom.checkpoint).toBe('xtbrestart');

    // The downstream run folder holds xtbrestart, not a fabricated .chk.
    expect(await fsp.readFile(path.join(byId.b.runDir, 'xtbrestart'), 'utf8')).toBe('xTB restart bytes');
    await expect(fsp.access(path.join(byId.b.runDir, 'a.chk'))).rejects.toThrow();
    const record = JSON.parse(await fsp.readFile(path.join(byId.b.runDir, 'run.json'), 'utf8'));
    expect(record.checkpointHandoff).toMatchObject({
      kind: 'copy',
      file: 'xtbrestart',
      sourceRunId: byId.a.runId,
      bytes: Buffer.byteLength('xTB restart bytes'),
    });
    // The queued run's provenance also names the xTB method, not a Gaussian route.
    expect(record.provenance.method).toMatchObject({ hamiltonian: 'gfn2', optLevel: null });
  });

  it('names the expected xTB artifact in a mismatch error', async () => {
    const { exe, queueManager } = await makeStack({ behaviour: xtbBehaviour });
    const tasks = [
      xtbTask('a', { checkpointName: 'a.chk' }),
      xtbTask('b', { checkpointFrom: { nodeId: 'a', checkpoint: 'other.restart' } }),
    ];
    const started = await queueManager.start({
      tasks,
      edges: [{ from: 'a', to: 'b', type: 'checkpoint' }],
      options: queueOptions(exe),
    });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'xTB mismatch settlement' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.a.status).toBe('completed');
    expect(byId.b.status).toBe('failed');
    expect(byId.b.error).toMatch(/Checkpoint mismatch: "a" writes xtbrestart but this task reads other\.restart/);
    expect(finished.status).toBe('failed');
  });

  it('keeps the Gaussian .chk artifact name exactly as declared', async () => {
    const { exe, queueManager, queuesRoot } = await makeStack({
      behaviour: (outputName) => (outputName === 'a.out' ? { checkpoint: 'r_opt.chk' } : {}),
    });
    const tasks = [
      task('a', { checkpointName: 'r_opt.chk' }),
      task('b', { checkpointFrom: { nodeId: 'a', checkpoint: 'r_opt.chk' } }),
    ];
    const started = await queueManager.start({
      tasks,
      edges: [{ from: 'a', to: 'b', type: 'checkpoint' }],
      options: queueOptions(exe),
    });
    const finished = await waitFor(async () => {
      const queue = await queueManager.get(started.id);
      return ['completed', 'failed', 'needs-review'].includes(queue.status) ? queue : null;
    }, { label: 'Gaussian checkpoint settlement' });

    const byId = Object.fromEntries(finished.tasks.map((item) => [item.nodeId, item]));
    expect(byId.b.status).toBe('completed');
    const persisted = JSON.parse(await fsp.readFile(path.join(queuesRoot, started.id, 'queue.json'), 'utf8'));
    const persistedById = Object.fromEntries(persisted.tasks.map((item) => [item.nodeId, item]));
    expect(persistedById.a.checkpointName).toBe('r_opt.chk');
    expect(persistedById.b.checkpointFrom.checkpoint).toBe('r_opt.chk');
    expect(await fsp.readFile(path.join(byId.b.runDir, 'r_opt.chk'), 'utf8')).toBe('checkpoint-bytes');
    const record = JSON.parse(await fsp.readFile(path.join(byId.b.runDir, 'run.json'), 'utf8'));
    expect(record.checkpointHandoff).toMatchObject({ file: 'r_opt.chk', kind: 'copy' });
    await expect(fsp.access(path.join(byId.b.runDir, 'xtbrestart'))).rejects.toThrow();
  });
});

describe('QueueManager — durability', () => {
  // Crash recovery writes and re-reads queue files several times and waits on
  // child processes; on a loaded CI runner that legitimately exceeds Vitest's
  // 5 s default, so this test owns its budget.
  it('marks an in-flight task interrupted after a crash and resumes it', async () => {
    const first = await makeStack({ behaviour: (outputName) => (outputName === 'b.out' ? { hang: true } : {}) });
    const tasks = [task('a'), task('b'), task('c')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'dependency' },
    ];
    const started = await first.queueManager.start({ projectName: 'crash', tasks, edges, options: queueOptions(first.exe) });
    // Wait on the *persisted* state, not on the in-memory object: the manager
    // mutates `task.status` before its atomic write lands, so polling `get()`
    // can win the race and hand the next manager a file that still says
    // `pending`. The durability claim is about the file.
    const queueFile = path.join(first.queuesRoot, started.id, 'queue.json');
    const readPersisted = async () => JSON.parse(await fsp.readFile(queueFile, 'utf8'));
    await waitFor(async () => {
      const record = await readPersisted();
      return record.tasks.find((item) => item.nodeId === 'b')?.status === 'running';
    }, { label: 'task b persisted as running' });

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
  }, 30_000);

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
