import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  blockedPendingTasks,
  finalStatus,
  nextReadyTask,
  topologicalOrder,
} from '../../src/shared/workflowGraph.js';
import { conditionFields, evaluateCondition } from '../../src/shared/controlFlow.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_INPUT = /^[A-Za-z0-9._-]+\.(gjf|com)$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const SAFE_CHECKPOINT = /^[A-Za-z0-9._-]{1,124}\.chk$/i;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TASKS = 500;

const TASK_STATUSES = new Set([
  'pending', 'running', 'completed', 'failed', 'needs-review', 'blocked', 'skipped', 'cancelled', 'interrupted',
]);

const TASK_TYPES = new Set(['calc', 'condition', 'loop', 'merge', 'output', 'note']);

function queueIdFor(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, filePath);
}

function oneLine(value, max = 200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function taskRecord(raw, index) {
  const nodeId = String(raw?.nodeId || '');
  if (!SAFE_ID.test(nodeId)) throw new Error(`Task ${index + 1} has an invalid node id.`);
  const executable = Boolean(raw?.executable);
  const inputName = String(raw?.inputName || '');
  const outputName = String(raw?.outputName || '');
  const inputText = String(raw?.inputText || '');
  if (executable) {
    if (!SAFE_INPUT.test(inputName)) throw new Error(`Task "${nodeId}" must have a safe .gjf or .com input name.`);
    if (!SAFE_OUTPUT.test(outputName)) throw new Error(`Task "${nodeId}" must have a safe .out or .log output name.`);
    if (!inputText.trim()) throw new Error(`Task "${nodeId}" has no Gaussian input.`);
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Task "${nodeId}" input is larger than 2 MiB.`);
  }
  const checkpointFrom = raw?.checkpointFrom && SAFE_ID.test(String(raw.checkpointFrom.nodeId))
    ? { nodeId: String(raw.checkpointFrom.nodeId), checkpoint: String(raw.checkpointFrom.checkpoint || '') }
    : null;
  if (checkpointFrom && !SAFE_CHECKPOINT.test(checkpointFrom.checkpoint)) {
    throw new Error(`Task "${nodeId}" hands off a checkpoint with an unsafe name.`);
  }
  const checkpointName = String(raw?.checkpointName || '');
  if (checkpointName && !SAFE_CHECKPOINT.test(checkpointName)) {
    throw new Error(`Task "${nodeId}" has an unsafe checkpoint name.`);
  }
  const type = TASK_TYPES.has(raw?.type) ? raw.type : (executable ? 'calc' : 'note');
  const condition = type === 'condition'
    ? {
      expression: oneLine(raw?.condition?.expression, 4000),
      unknown: ['block-both', 'treat-false', 'treat-true'].includes(raw?.condition?.unknown)
        ? raw.condition.unknown : 'block-both',
    }
    : null;
  const loopTarget = String(raw?.loop?.target || '');
  const loop = type === 'loop'
    ? {
      maxAttempts: Number.isInteger(Number(raw?.loop?.maxAttempts))
        ? Math.min(99, Math.max(1, Number(raw.loop.maxAttempts))) : 3,
      mode: oneLine(raw?.loop?.mode, 32) || 'retry',
      target: SAFE_ID.test(loopTarget) ? loopTarget : '',
    }
    : null;
  const merge = type === 'merge'
    ? { policy: ['all', 'any'].includes(raw?.merge?.policy) ? raw.merge.policy : 'all' }
    : null;
  return {
    nodeId,
    type,
    title: oneLine(raw?.title, 120) || nodeId,
    kind: oneLine(raw?.kind, 32) || 'Calc',
    executable,
    status: 'pending',
    attempts: 0,
    runId: null,
    runDir: null,
    inputName,
    outputName,
    gates: raw?.gates && typeof raw.gates === 'object' ? raw.gates : {},
    checkpointName,
    checkpointFrom,
    condition,
    loop,
    merge,
    loopAttempts: 0,
    conditionResult: null,
    summary: null,
    history: [],
    gateVerdict: null,
    error: null,
    reason: null,
    previousError: null,
    startedAt: null,
    finishedAt: null,
    inputText,
  };
}

function publicTask(task) {
  const { inputText, ...rest } = task;
  return rest;
}

function publicQueue(queue) {
  return { ...queue, tasks: queue.tasks.map(publicTask) };
}

export class QueueManager {
  constructor({ queuesRoot, runManager, emit }) {
    this.queuesRoot = queuesRoot;
    this.runManager = runManager;
    this.emitExternal = emit || (() => {});
    this.queues = new Map();
    this.loops = new Set();
    this.writeChains = new Map();
    this.pendingRuns = new Map();
    this.finishedRuns = new Map();
    this.unsubscribe = this.runManager.onEvent((event) => this.handleRunEvent(event));
  }

  emit(event) {
    this.emitExternal(event);
  }

  publish(queue, eventType = 'queue') {
    this.emit({ type: eventType, queueId: queue.id, queue: publicQueue(queue) });
  }

  handleRunEvent(event) {
    if (event.type === 'done') {
      const resolve = this.pendingRuns.get(event.runId);
      if (resolve) {
        this.pendingRuns.delete(event.runId);
        resolve(event.record);
      } else {
        this.finishedRuns.set(event.runId, event.record);
        if (this.finishedRuns.size > 50) {
          this.finishedRuns.delete(this.finishedRuns.keys().next().value);
        }
      }
      return;
    }
    if (event.type === 'output') {
      for (const queue of this.queues.values()) {
        const task = queue.tasks.find((item) => item.runId === event.runId);
        if (task) {
          this.emit({ type: 'queue-output', queueId: queue.id, nodeId: task.nodeId, runId: event.runId, text: event.text });
          return;
        }
      }
    }
  }

  waitForRun(runId) {
    if (this.finishedRuns.has(runId)) {
      const record = this.finishedRuns.get(runId);
      this.finishedRuns.delete(runId);
      return Promise.resolve(record);
    }
    return new Promise((resolve) => this.pendingRuns.set(runId, resolve));
  }

  queueDir(queueId) {
    return path.join(this.queuesRoot, queueId);
  }

  inputPath(queueId, nodeId) {
    return path.join(this.queueDir(queueId), 'inputs', `${nodeId}.gjf`);
  }

  async persist(queue) {
    queue.updatedAt = new Date().toISOString();
    const snapshot = { ...queue, tasks: queue.tasks.map(publicTask) };
    // Serialize writes per queue so a slow rename cannot be overtaken by a
    // newer snapshot from the run event handler.
    const previous = this.writeChains.get(queue.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(
      () => writeJsonAtomic(path.join(this.queueDir(queue.id), 'queue.json'), snapshot),
    );
    this.writeChains.set(queue.id, next);
    await next;
  }

  /* ── Lifecycle ─────────────────────────────────────────── */

  async init() {
    await fsp.mkdir(this.queuesRoot, { recursive: true });
    const entries = await fsp.readdir(this.queuesRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.queuesRoot, entry.name, 'queue.json');
      let record;
      try {
        record = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        continue; // An unreadable queue must not stop the app.
      }
      if (!record?.id || !Array.isArray(record.tasks)) continue;
      record.tasks = record.tasks.filter((task) => TASK_STATUSES.has(task.status));
      this.queues.set(record.id, record);
      if (record.status === 'running') {
        // The app exited mid-run: never pretend the process completed.
        for (const task of record.tasks) {
          if (task.status === 'running') {
            task.status = 'interrupted';
            task.error = 'The app exited while this task was running. Resume to run it again.';
            task.finishedAt = new Date().toISOString();
          }
        }
        record.status = 'paused';
        record.currentTaskId = null;
        record.reason = 'interrupted';
        await this.persist(record);
      }
    }
  }

  async start(payload = {}) {
    const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    if (rawTasks.length === 0) throw new Error('A queued workflow needs at least one task.');
    if (rawTasks.length > MAX_TASKS) throw new Error(`A queued workflow is limited to ${MAX_TASKS} tasks.`);
    const tasks = rawTasks.map(taskRecord);
    const ids = new Set();
    for (const task of tasks) {
      if (ids.has(task.nodeId)) throw new Error(`Duplicate task id "${task.nodeId}".`);
      ids.add(task.nodeId);
    }
    for (const task of tasks) {
      if (task.checkpointFrom && !ids.has(task.checkpointFrom.nodeId)) {
        throw new Error(`Task "${task.nodeId}" hands off from an unknown task "${task.checkpointFrom.nodeId}".`);
      }
      if (task.checkpointFrom?.nodeId === task.nodeId) {
        throw new Error(`Task "${task.nodeId}" cannot hand off from itself.`);
      }
    }

    const edges = (Array.isArray(payload.edges) ? payload.edges : []).map((edge) => ({
      from: String(edge.from || ''),
      to: String(edge.to || ''),
      type: String(edge.type || 'dependency'),
      ...(edge.branch ? { branch: String(edge.branch) } : {}),
    }));
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        throw new Error(`Connection ${edge.from} -> ${edge.to} references an unknown task.`);
      }
    }

    const { cycle } = topologicalOrder(tasks, edges);
    if (cycle) {
      throw new Error(`The workflow has a dependency cycle: ${cycle.join(' → ')}.`);
    }

    const options = payload.options || {};
    const dryRun = Boolean(options.dryRun);
    const executable = String(options.executable || '').trim();
    const scratchDir = String(options.scratchDir || '').trim();
    if (!dryRun) {
      if (!executable) throw new Error('Choose the licensed Gaussian executable before running the workflow.');
      const stat = await fsp.stat(executable).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Gaussian executable not found: ${executable}`);
    }

    const id = queueIdFor();
    const queue = {
      id,
      projectName: oneLine(payload.projectName, 200) || 'Untitled workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      currentTaskId: null,
      reason: null,
      options: { dryRun, executable: dryRun ? null : executable, scratchDir },
      edges,
      tasks,
    };

    await fsp.mkdir(path.join(this.queueDir(id), 'inputs'), { recursive: true });
    for (const task of tasks) {
      if (!task.executable) continue;
      await fsp.writeFile(this.inputPath(id, task.nodeId), task.inputText, 'utf8');
    }
    this.queues.set(id, queue);
    await this.persist(queue);
    this.publish(queue, 'queue-started');
    this.drain(queue).catch((error) => this.stall(queue, error));
    return publicQueue(queue);
  }

  async drain(queue) {
    if (this.loops.has(queue.id)) return;
    this.loops.add(queue.id);
    try {
      while (queue.status === 'running') {
        const blocked = blockedPendingTasks(queue.tasks, queue.edges);
        for (const item of blocked) {
          const task = queue.tasks.find((entry) => entry.nodeId === item.nodeId);
          if (task && task.status === 'pending') {
            task.status = 'blocked';
            task.reason = item.reason;
            task.finishedAt = new Date().toISOString();
          }
        }
        if (blocked.length > 0) {
          await this.persist(queue);
          this.publish(queue);
        }

        const task = nextReadyTask(queue.tasks, queue.edges);
        if (!task) break;

        if (!task.executable) {
          await this.runControl(queue, task);
          continue;
        }

        await this.runTask(queue, task);
      }

      if (queue.status !== 'running') return;
      const status = finalStatus(queue.tasks);
      if (status) {
        queue.status = status;
        queue.finishedAt = new Date().toISOString();
        queue.currentTaskId = null;
        await this.persist(queue);
        this.publish(queue, 'queue-done');
      } else if (!nextReadyTask(queue.tasks, queue.edges)) {
        this.stall(queue, new Error('The scheduler could not find a runnable task.'));
      }
    } finally {
      this.loops.delete(queue.id);
    }
  }

  async runTask(queue, task) {
    let checkpointHandoff = null;
    if (task.checkpointFrom) {
      const upstream = queue.tasks.find((entry) => entry.nodeId === task.checkpointFrom.nodeId);
      const upstreamCheckpoint = upstream ? (upstream.checkpointName || `${upstream.nodeId}.chk`) : '';
      const problem = !upstream
        ? `Checkpoint source "${task.checkpointFrom.nodeId}" is not part of this workflow.`
        : upstream.status !== 'completed'
          ? `Checkpoint source "${upstream.title}" did not complete (${upstream.status}).`
          : !upstream.runDir
            ? `Checkpoint source "${upstream.title}" has no run folder.`
            : upstreamCheckpoint !== task.checkpointFrom.checkpoint
              ? `Checkpoint mismatch: "${upstream.title}" writes ${upstreamCheckpoint} but this task reads ${task.checkpointFrom.checkpoint}.`
              : null;
      if (problem) {
        task.status = 'failed';
        task.error = problem;
        task.finishedAt = new Date().toISOString();
        await this.persist(queue);
        this.publish(queue);
        return;
      }
      checkpointHandoff = {
        sourceRunDir: upstream.runDir,
        checkpoint: task.checkpointFrom.checkpoint,
        sourceRunId: upstream.runId,
      };
    }

    task.status = 'running';
    task.attempts += 1;
    task.startedAt = new Date().toISOString();
    task.finishedAt = null;
    task.error = null;
    task.reason = null;
    task.runId = null;
    task.runDir = null;
    queue.currentTaskId = task.nodeId;
    await this.persist(queue);
    this.publish(queue);

    try {
      const inputText = await fsp.readFile(this.inputPath(queue.id, task.nodeId), 'utf8');
      const response = await this.runManager.start({
        title: task.title,
        inputText,
        inputName: task.inputName,
        outputName: task.outputName,
        executable: queue.options.executable,
        scratchDir: queue.options.scratchDir,
        dryRun: queue.options.dryRun,
        gates: task.gates,
        checkpointHandoff,
      });
      task.runId = response.runId;
      task.runDir = response.runDir;
      await this.persist(queue);
      this.publish(queue);
      if (queue.status === 'cancelled') {
        // Cancelled while the run manager was still starting this task.
        await this.runManager.cancel(response.runId).catch(() => {});
      }

      const record = await this.waitForRun(response.runId);
      task.gateVerdict = record.gates?.overall || null;
      task.summary = conditionFields(record.parsed, record.gates);
      task.status = record.status === 'completed' ? 'completed'
        : record.status === 'needs-review' ? 'needs-review'
          : record.status === 'cancelled' ? 'cancelled' : 'failed';
      task.error = record.error || null;
      if (task.status === 'needs-review' && !task.error) {
        task.error = 'One or more gates did not pass; review the run output before continuing.';
      }
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      if (error?.runId && error?.runDir) {
        task.runId = error.runId;
        task.runDir = error.runDir;
      }
    } finally {
      task.finishedAt = new Date().toISOString();
      queue.currentTaskId = null;
      await this.persist(queue);
      this.publish(queue);
    }
  }

  /* ── Control-flow nodes ───────────────────────────────── */

  incomingSources(queue, nodeId, edgeType = null) {
    return queue.edges
      .filter((edge) => edge.to === nodeId && edge.type !== 'loop' && (!edgeType || edge.type === edgeType))
      .map((edge) => queue.tasks.find((task) => task.nodeId === edge.from))
      .filter(Boolean);
  }

  upstreamSummary(queue, task) {
    const sources = this.incomingSources(queue, task.nodeId).filter((source) => source.summary);
    if (sources.length === 0) return null;
    sources.sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
    return sources[sources.length - 1].summary;
  }

  setTaskOutcome(task, status, reason) {
    task.status = status;
    task.reason = reason;
    task.finishedAt = status === 'pending' ? null : new Date().toISOString();
  }

  announce(queue, task) {
    this.emit({
      type: 'queue-output',
      queueId: queue.id,
      nodeId: task.nodeId,
      text: `${task.status}${task.reason ? ` — ${task.reason}` : ''}`,
    });
  }

  async runControl(queue, task) {
    if (task.type === 'condition') {
      await this.runCondition(queue, task);
      return;
    }
    if (task.type === 'loop') {
      await this.runLoop(queue, task);
      return;
    }
    if (task.type === 'note') {
      this.setTaskOutcome(task, 'skipped', 'notes are not executed');
    } else if (task.type === 'merge') {
      const inputs = this.incomingSources(queue, task.nodeId).length;
      const policy = task.merge?.policy || 'all';
      this.setTaskOutcome(task, 'completed', `merged ${inputs} input(s), policy ${policy} (readiness waits for all)`);
    } else {
      this.setTaskOutcome(task, 'blocked', 'output bundling is not implemented yet (GN-008)');
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  async runCondition(queue, task) {
    const summary = this.upstreamSummary(queue, task);
    if (!summary) {
      this.setTaskOutcome(task, 'blocked', 'no upstream parsed result to evaluate');
    } else {
      const result = evaluateCondition(task.condition?.expression, summary, {
        unknownPolicy: task.condition?.unknown || 'block-both',
      });
      task.conditionResult = result.value;
      task.reason = result.reason;
      if (result.value === null) {
        this.setTaskOutcome(task, 'blocked', result.reason);
      } else {
        this.setTaskOutcome(task, 'completed', `${result.value ? 'true' : 'false'} — ${result.reason}`);
        const taken = result.value ? 'true' : 'false';
        for (const edge of queue.edges.filter((item) => item.from === task.nodeId && item.type === 'branch')) {
          if (edge.branch !== taken) {
            this.skipSubtree(queue, edge.to, `branch ${edge.branch} not taken (${task.title})`);
          }
        }
      }
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  async runLoop(queue, task) {
    const target = task.loop?.target;
    const maxAttempts = task.loop?.maxAttempts || 3;
    if (!target) {
      this.setTaskOutcome(task, 'blocked', 'loop has no retry target');
    } else {
      task.conditionResult = null;
      if (task.loopAttempts >= maxAttempts) {
        this.setTaskOutcome(task, 'failed', `loop exhausted after ${maxAttempts} attempt(s)`);
      } else {
        task.loopAttempts += 1;
        const reset = this.resetSubtree(queue, target, task.nodeId);
        task.status = 'pending';
        task.finishedAt = null;
        task.runId = null;
        task.runDir = null;
        task.reason = `retry ${task.loopAttempts}/${maxAttempts}: reset ${reset.length} task(s) from ${target}`;
      }
    }
    await this.persist(queue);
    this.publish(queue);
    this.announce(queue, task);
  }

  /** Mark a non-taken branch and everything downstream of it as skipped. */
  skipSubtree(queue, rootId, reason) {
    const seen = new Set();
    const stack = [rootId];
    const skipped = [];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const task = queue.tasks.find((entry) => entry.nodeId === id);
      if (!task) continue;
      if (['pending', 'blocked', 'interrupted'].includes(task.status)) {
        task.status = 'skipped';
        task.reason = reason;
        task.finishedAt = new Date().toISOString();
        skipped.push(id);
      }
      for (const edge of queue.edges) {
        if (edge.from === id && edge.type !== 'loop') stack.push(edge.to);
      }
    }
    return skipped;
  }

  /** Re-open a task and everything downstream so a loop retry recomputes it. */
  resetSubtree(queue, rootId, exceptId) {
    const seen = new Set();
    const stack = [rootId];
    const reset = [];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id) || id === exceptId) continue;
      seen.add(id);
      const task = queue.tasks.find((entry) => entry.nodeId === id);
      if (!task) continue;
      for (const edge of queue.edges) {
        if (edge.from === id && edge.type !== 'loop') stack.push(edge.to);
      }
      if (!['completed', 'failed', 'needs-review', 'blocked', 'skipped', 'interrupted'].includes(task.status)) continue;
      task.history = [
        ...(task.history || []),
        { runId: task.runId, status: task.status, gateVerdict: task.gateVerdict, finishedAt: task.finishedAt },
      ].slice(-20);
      task.status = 'pending';
      task.runId = null;
      task.runDir = null;
      task.gateVerdict = null;
      task.summary = null;
      task.conditionResult = null;
      task.error = null;
      task.reason = null;
      task.startedAt = null;
      task.finishedAt = null;
      reset.push(id);
    }
    return reset;
  }

  stall(queue, error) {
    queue.status = 'needs-review';
    queue.reason = error instanceof Error ? error.message : String(error);
    this.persist(queue).then(() => this.publish(queue, 'queue-done')).catch(() => {});
  }

  /* ── Control ───────────────────────────────────────────── */

  async pause(queueId) {
    const queue = this.queues.get(queueId);
    if (!queue || queue.status !== 'running') return { paused: false };
    queue.status = 'paused';
    queue.reason = 'paused by the user; the running task is allowed to finish';
    await this.persist(queue);
    this.publish(queue);
    return { paused: true };
  }

  async resume(queueId) {
    const queue = this.queues.get(queueId);
    if (!queue) throw new Error('Unknown workflow queue.');
    if (!['paused', 'needs-review'].includes(queue.status)) return { resumed: false };
    for (const task of queue.tasks) {
      if (task.status === 'interrupted') {
        task.previousError = task.error;
        task.status = 'pending';
        task.error = null;
        task.finishedAt = null;
      }
    }
    queue.status = 'running';
    queue.reason = null;
    queue.finishedAt = null;
    await this.persist(queue);
    this.publish(queue);
    this.drain(queue).catch((error) => this.stall(queue, error));
    return { resumed: true };
  }

  async cancel(queueId) {
    const queue = this.queues.get(queueId);
    if (!queue) throw new Error('Unknown workflow queue.');
    queue.status = 'cancelled';
    queue.reason = 'cancelled by the user';
    for (const task of queue.tasks) {
      if (task.status === 'pending' || task.status === 'blocked') {
        task.status = 'cancelled';
        task.finishedAt = new Date().toISOString();
      }
      if (task.status === 'running' && task.runId) {
        await this.runManager.cancel(task.runId).catch(() => {});
      }
    }
    queue.currentTaskId = null;
    await this.persist(queue);
    this.publish(queue, 'queue-done');
    return { cancelled: true };
  }

  async list() {
    return [...this.queues.values()]
      .map(publicQueue)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async get(queueId) {
    const queue = this.queues.get(queueId);
    return queue ? publicQueue(queue) : null;
  }

  dispose() {
    this.unsubscribe?.();
  }
}
