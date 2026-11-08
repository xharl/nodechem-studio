import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  blockedPendingTasks,
  finalStatus,
  nextReadyTask,
  topologicalOrder,
} from '../../src/shared/workflowGraph.js';
import { conditionFields, evaluateCondition } from '../../src/shared/controlFlow.js';
import { engineFor } from '../../src/shared/engines/index.js';
import { ladderVerdict } from '../../src/shared/methodLadder.js';
import { spinSweepVerdict } from '../../src/shared/spinSweep.js';
import { deltaGDoubleDagger } from '../../src/shared/reactionPath.js';
import { normalizeValidityContext } from '../../src/shared/validityChecks.js';
import { applyGeometryHandoff, readUpstreamGeometry } from './geometryHandoff.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_CHECKPOINT = /^[A-Za-z0-9._-]{1,124}\.chk$/i;
// xTB's restart artifact is a plain filename (`xtbrestart`); it is not a
// Gaussian checkpoint and must not be forced through the `.chk` pattern.
// The first character is alphanumeric so `.`/`..` can never escape targetDir.
const SAFE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;
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

const ROUTE_SETTING_KEYS = [
  'jobType', 'method', 'basis', 'dispersion', 'scf', 'grid', 'optConvergence',
  'solvationModel', 'solvent',
  // xTB's method vocabulary; without these a queued run cannot record the
  // Hamiltonian or optimisation level it actually used (#39).
  'xtbMethod', 'xtbOptLevel',
  // Thread count is xTB's only resource setting; carry it so a queued run does
  // not silently fall back to the default OMP_NUM_THREADS (#41).
  'xtbThreads',
];

/**
 * The file a checkpoint edge transfers for an engine.
 *
 * Gaussian writes the task's own `%Chk` name. xTB always writes its declared
 * restart artifact (`xtbrestart`) in the working directory, whatever `.chk`
 * name the old UI may have put on the edge.
 */
function checkpointArtifactFor(engine, task = {}) {
  if (typeof engine.checkpointArtifact === 'function') {
    return engine.checkpointArtifact({
      checkpointName: String(task.checkpointName || ''),
      nodeId: String(task.nodeId || 'task'),
    });
  }
  return String(task.checkpointName || `${task.nodeId || 'task'}.chk`);
}

/**
 * What a downstream task declares it reads. An xTB edge may still carry the
 * pre-#40 UI default `something.chk`; xTB has one restart artifact, so that
 * placeholder resolves to it instead of failing after the upstream has run.
 */
function declaredCheckpointFor(engine, declared) {
  const name = String(declared || '');
  if (engine.id !== 'xtb') return name;
  if (!name || /\.chk$/i.test(name) || name === engine.capabilities.restartArtifact) {
    return engine.capabilities.restartArtifact;
  }
  return name;
}

function isSafeCheckpointName(engine, name) {
  return engine.id === 'xtb' ? SAFE_ARTIFACT.test(String(name)) : SAFE_CHECKPOINT.test(String(name));
}

/**
 * Keep only the route fields the provenance manifest needs. The renderer
 * supplies them, so coerce and length-limit them before they are persisted or
 * copied into a run record.
 */
function routeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of ROUTE_SETTING_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    out[key] = oneLine(raw[key], 64);
  }
  if ('solvation' in raw) out.solvation = Boolean(raw.solvation);
  return Object.keys(out).length > 0 ? out : null;
}

function taskRecord(raw, index) {
  const nodeId = String(raw?.nodeId || '');
  if (!SAFE_ID.test(nodeId)) throw new Error(`Task ${index + 1} has an invalid node id.`);
  const executable = Boolean(raw?.executable);
  const engineId = String(raw?.engine || 'gaussian');
  const engine = engineFor(engineId);
  const argv = Array.isArray(raw?.argv) ? raw.argv.map(String) : null;
  const inputName = String(raw?.inputName || '');
  const outputName = String(raw?.outputName || '');
  const inputText = String(raw?.inputText || '');
  if (executable) {
    if (!engine.acceptsInputName(inputName)) {
      throw new Error(`Task "${nodeId}" must have a safe ${engine.capabilities.inputExtension} input name for ${engine.label}.`);
    }
    if (!engine.acceptsOutputName(outputName)) throw new Error(`Task "${nodeId}" must have a safe .out or .log output name.`);
    if (!inputText.trim()) throw new Error(`Task "${nodeId}" has no ${engine.label} input.`);
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) throw new Error(`Task "${nodeId}" input is larger than 2 MiB.`);
  }
  let checkpointFrom = null;
  if (raw?.checkpointFrom && SAFE_ID.test(String(raw.checkpointFrom.nodeId))) {
    // A cross-engine edge hands over a parsed geometry, not a file: there is no
    // checkpoint name to validate.
    const geometryOnly = raw.checkpointFrom.geometryOnly === true;
    checkpointFrom = {
      nodeId: String(raw.checkpointFrom.nodeId),
      checkpoint: geometryOnly ? '' : declaredCheckpointFor(engine, raw.checkpointFrom.checkpoint),
      ...(geometryOnly ? { geometryOnly: true } : {}),
    };
  }
  if (checkpointFrom && !checkpointFrom.geometryOnly && !isSafeCheckpointName(engine, checkpointFrom.checkpoint)) {
    throw new Error(`Task "${nodeId}" hands off a checkpoint with an unsafe name.`);
  }
  const checkpointName = checkpointArtifactFor(engine, {
    checkpointName: raw?.checkpointName,
    nodeId,
  });
  if (!isSafeCheckpointName(engine, checkpointName)) {
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
  const rawReaction = raw?.reaction && typeof raw.reaction === 'object' ? raw.reaction : null;
  const reaction = rawReaction
    ? {
      transitionStateNodeId: String(rawReaction.transitionStateNodeId || '') || null,
      reactantNodeId: String(rawReaction.reactantNodeId || '') || null,
    }
    : null;
  const rawSpin = raw?.spin && typeof raw.spin === 'object' ? raw.spin : null;
  const spinId = rawSpin ? String(rawSpin.id || '') : '';
  const spin = rawSpin && SAFE_ID.test(spinId)
    ? {
      id: spinId,
      index: Number.isInteger(Number(rawSpin.index)) ? Number(rawSpin.index) : 0,
      multiplicity: Number.isInteger(Number(rawSpin.multiplicity)) ? Number(rawSpin.multiplicity) : null,
      count: Number.isInteger(Number(rawSpin.count)) ? Number(rawSpin.count) : null,
    }
    : null;
  const rawLadder = raw?.ladder && typeof raw.ladder === 'object' ? raw.ladder : null;
  const ladderId = rawLadder ? String(rawLadder.id || '') : '';
  const ladder = rawLadder && SAFE_ID.test(ladderId)
    ? {
      id: ladderId,
      index: Number.isInteger(Number(rawLadder.index)) ? Number(rawLadder.index) : 0,
      label: oneLine(rawLadder.label, 40) || `Rung ${Number(rawLadder.index) + 1}`,
      count: Number.isInteger(Number(rawLadder.count)) ? Number(rawLadder.count) : null,
      toleranceKcal: Number.isFinite(Number(rawLadder.toleranceKcal)) ? Number(rawLadder.toleranceKcal) : 3,
    }
    : null;
  return {
    nodeId,
    type,
    title: oneLine(raw?.title, 120) || nodeId,
    kind: oneLine(raw?.kind, 32) || 'Calc',
    executable,
    engine: engine.id,
    argv,
    route: oneLine(raw?.route, 2000) || null,
    status: 'pending',
    attempts: 0,
    runId: null,
    runDir: null,
    inputName,
    outputName,
    settings: routeSettings(raw?.settings),
    gates: raw?.gates && typeof raw.gates === 'object' ? raw.gates : {},
    // Issue #25: a bounded, serializable validity context travels with the
    // task so the run record can report scientific checks next to the gates.
    validity: normalizeValidityContext(raw?.validity),
    checkpointName,
    checkpointFrom,
    condition,
    loop,
    merge,
    ladder,
    spin,
    reaction,
    loopAttempts: 0,
    conditionResult: null,
    summary: null,
    history: [],
    gateVerdict: null,
    parsedSummary: null,
    error: null,
    reason: null,
    previousError: null,
    startedAt: null,
    finishedAt: null,
    inputText,
  };
}

function publicTask(task) {
  // The validity context can carry the whole molecule; the queue panel does
  // not need it, so keep it out of every published queue event.
  const { inputText, validity, ...rest } = task;
  return rest;
}

/**
 * The disk projection keeps the validity context: a resumed task must be able
 * to evaluate the same checks as the task that was interrupted. Only the
 * input text is omitted because it already lives in `inputs/<node>.gjf`.
 */
function storedTask(task) {
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
    this.starting = false;
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
    const snapshot = { ...queue, tasks: queue.tasks.map(storedTask) };
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

  /**
   * Only one queue may be active at a time. A paused or needs-review queue is
   * still unfinished: starting a second queue would run two engine processes
   * side by side and make the queue panel disagree with the queue on disk.
   */
  activeQueueExcept(queueId = null) {
    for (const queue of this.queues.values()) {
      if (queue.id === queueId) continue;
      if (['running', 'paused', 'needs-review'].includes(queue.status)) return queue;
    }
    return null;
  }

  async start(payload = {}) {
    if (this.starting) throw new Error('A workflow queue is already starting.');
    const active = this.activeQueueExcept();
    if (active) {
      throw new Error(`Workflow queue "${active.projectName}" is still ${active.status}. Finish or cancel it before starting another.`);
    }
    this.starting = true;
    try {
      return await this.startUnlocked(payload);
    } finally {
      this.starting = false;
    }
  }

  async startUnlocked(payload = {}) {
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
      if (!executable) throw new Error('Choose the calculation executable before running the workflow.');
      const stat = await fsp.stat(executable).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Calculation executable not found: ${executable}`);
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
      // Method ladders: one verdict per ladder group, evaluated when every rung
      // of that group has finished.
      ladders: {},
      // Spin-state sweeps: the table and the ground state, per swept block.
      spins: {},
      // ΔG‡ for a reaction path, when both blocks it names have free energies.
      reactions: {},
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

  /**
   * One gate per method ladder. A group is judged only once every rung has
   * finished; a rung that never ran leaves the verdict `unknown`, never a pass
   * over the rungs that did run.
   */
  async evaluateLadders(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted']);
    const groups = new Map();
    for (const task of queue.tasks) {
      if (!task.ladder?.id) continue;
      if (!groups.has(task.ladder.id)) groups.set(task.ladder.id, []);
      groups.get(task.ladder.id).push(task);
    }
    let changed = false;
    for (const [id, group] of groups) {
      if (!group.every((task) => finished.has(String(task.status)))) continue;
      const entries = [...group]
        .sort((a, b) => (a.ladder.index || 0) - (b.ladder.index || 0))
        .map((task) => ({
          id: task.nodeId,
          label: task.ladder.label,
          energyHartree: Number.isFinite(task.parsedSummary?.energyHartree) ? task.parsedSummary.energyHartree : null,
        }));
      const verdict = ladderVerdict(entries, {
        toleranceKcal: group[0].ladder.toleranceKcal,
        expected: group[0].ladder.count ?? group.length,
      });
      queue.ladders = queue.ladders || {};
      queue.ladders[id] = { ...verdict, evaluatedAt: new Date().toISOString() };
      changed = true;
      if (verdict.status === 'fail') {
        const reason = `Method ladder "${id}" spread ${verdict.spreadKcal.toFixed(2)} kcal/mol exceeds the ${verdict.toleranceKcal} kcal/mol tolerance.`;
        for (const task of group) {
          if (task.status === 'completed') {
            task.status = 'needs-review';
            task.reason = reason;
            task.finishedAt = task.finishedAt || new Date().toISOString();
          }
        }
      }
    }
    return changed;
  }

  /**
   * One table per spin-state sweep, once every state has finished. The ground
   * state is the lowest computed state; a state that did not run is named
   * rather than assumed to be higher.
   */
  async evaluateSpins(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted']);
    const groups = new Map();
    for (const task of queue.tasks) {
      if (!task.spin?.id) continue;
      if (!groups.has(task.spin.id)) groups.set(task.spin.id, []);
      groups.get(task.spin.id).push(task);
    }
    let changed = false;
    for (const [id, group] of groups) {
      if (!group.every((task) => finished.has(String(task.status)))) continue;
      const entries = [...group]
        .sort((a, b) => (a.spin.multiplicity || 0) - (b.spin.multiplicity || 0))
        .map((task) => ({
          nodeId: task.nodeId,
          multiplicity: task.spin.multiplicity,
          energyHartree: Number.isFinite(task.parsedSummary?.energyHartree) ? task.parsedSummary.energyHartree : null,
          spinSquared: Number.isFinite(task.parsedSummary?.spinSquared) ? task.parsedSummary.spinSquared : null,
          spinSquaredSource: task.parsedSummary?.spinSquaredSource || null,
        }));
      queue.spins = queue.spins || {};
      queue.spins[id] = {
        ...spinSweepVerdict(entries, { expected: group[0].spin.count ?? group.length }),
        evaluatedAt: new Date().toISOString(),
      };
      changed = true;
    }
    return changed;
  }

  /**
   * ΔG‡ for each reaction path that declared its transition state and reactant.
   * Both free energies come from the runs themselves; when either is missing the
   * entry says which one, and no number is written.
   */
  async evaluateReactions(queue) {
    const finished = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'blocked', 'skipped', 'interrupted']);
    const byNodeId = new Map(queue.tasks.map((task) => [task.nodeId, task]));
    let changed = false;
    for (const task of queue.tasks) {
      if (!task.reaction || !finished.has(String(task.status))) continue;
      const tsTask = byNodeId.get(task.reaction.transitionStateNodeId);
      const reactantTask = byNodeId.get(task.reaction.reactantNodeId);
      if (!tsTask || (reactantTask && !finished.has(String(reactantTask.status)))) continue;
      const verdict = deltaGDoubleDagger({
        transitionState: { thermochemistry: { freeEnergyHartree: tsTask.parsedSummary?.freeEnergyHartree ?? null } },
        reactant: reactantTask
          ? { thermochemistry: { freeEnergyHartree: reactantTask.parsedSummary?.freeEnergyHartree ?? null } }
          : null,
      });
      queue.reactions = queue.reactions || {};
      // Where the path ends, checked against the block declared as the reactant.
      // An IRC summary cannot show that an endpoint is a minimum, but it can show
      // whether the endpoint sits at the energy of the block that is supposed to
      // be there — and that is the part a gate can decide.
      const endpoints = task.parsedSummary?.irc || null;
      let endpointCheck = {
        status: 'unknown',
        detail: 'This output carries no IRC path with two endpoints.',
      };
      if (endpoints && reactantTask) {
        const reactantEnergy = reactantTask.parsedSummary?.energyHartree ?? null;
        const candidates = [
          { end: 'first', energy: endpoints.firstEnergyHartree },
          { end: 'last', energy: endpoints.lastEnergyHartree },
        ].filter((entry) => Number.isFinite(entry.energy) && Number.isFinite(reactantEnergy));
        if (candidates.length === 0) {
          endpointCheck = { status: 'unknown', detail: 'The path or the reactant block has no final energy to compare.' };
        } else {
          const best = candidates
            .map((entry) => ({ ...entry, deltaKcal: Math.abs(entry.energy - reactantEnergy) * 627.5094740631 }))
            .sort((a, b) => a.deltaKcal - b.deltaKcal)[0];
          endpointCheck = {
            status: best.deltaKcal <= 2 ? 'pass' : 'fail',
            end: best.end,
            deltaKcal: best.deltaKcal,
            toleranceKcal: 2,
            detail: `The ${best.end} end of the path is ${best.deltaKcal.toFixed(2)} kcal/mol from the declared reactant `
              + `(tolerance ${2} kcal/mol).`,
          };
        }
      } else if (!reactantTask) {
        endpointCheck = {
          status: 'unknown',
          detail: 'No reactant block is declared, so the path ends were not checked against one.',
        };
      }
      queue.reactions[task.nodeId] = {
        ...verdict,
        endpointCheck,
        transitionStateNodeId: task.reaction.transitionStateNodeId,
        reactantNodeId: task.reaction.reactantNodeId,
        evaluatedAt: new Date().toISOString(),
      };
      changed = true;
    }
    return changed;
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
        const spinChanged = await this.evaluateSpins(queue);
        const reactionChanged = await this.evaluateReactions(queue);
        if (await this.evaluateLadders(queue) || spinChanged || reactionChanged) {
          await this.persist(queue);
          this.publish(queue);
        }
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
    if (task.checkpointFrom && !task.checkpointFrom.geometryOnly) {
      const upstream = queue.tasks.find((entry) => entry.nodeId === task.checkpointFrom.nodeId);
      const upstreamEngine = upstream ? engineFor(upstream.engine || 'gaussian') : null;
      const upstreamCheckpoint = upstream && upstreamEngine ? checkpointArtifactFor(upstreamEngine, upstream) : '';
      // Old queues and old UI payloads can still carry a `.chk` placeholder on
      // an xTB edge; resolve it the same way taskRecord does before comparing.
      const declaredCheckpoint = declaredCheckpointFor(
        engineFor(task.engine || 'gaussian'),
        task.checkpointFrom.checkpoint,
      );
      const problem = !upstream
        ? `Checkpoint source "${task.checkpointFrom.nodeId}" is not part of this workflow.`
        : upstream.status !== 'completed'
          ? `Checkpoint source "${upstream.title}" did not complete (${upstream.status}).`
          : !upstream.runDir
            ? `Checkpoint source "${upstream.title}" has no run folder.`
            : upstreamCheckpoint !== declaredCheckpoint
              ? `Checkpoint mismatch: "${upstream.title}" writes ${upstreamCheckpoint} but this task reads ${declaredCheckpoint}.`
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
        checkpoint: upstreamCheckpoint,
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
      let inputText = await fsp.readFile(this.inputPath(queue.id, task.nodeId), 'utf8');
      const upstreamTask = task.checkpointFrom
        ? queue.tasks.find((entry) => entry.nodeId === task.checkpointFrom.nodeId) || null
        : null;
      // Cross-engine hand-off: an xTB block leaves no Gaussian checkpoint, so the
      // downstream Gaussian block takes the *parsed* final geometry of the run
      // that finished instead of the geometry it was planned with.
      const upstreamEngineId = upstreamTask ? String(upstreamTask.engine || 'gaussian') : null;
      if (upstreamTask && upstreamTask.runDir && upstreamEngineId !== task.engine) {
        const atoms = await readUpstreamGeometry(upstreamTask.runDir);
        if (!atoms) {
          task.status = 'failed';
          task.error = `"${upstreamTask.title}" finished but its run record carries no parsed final geometry to hand over.`;
          task.finishedAt = new Date().toISOString();
          await this.persist(queue);
          this.publish(queue);
          return;
        }
        if (task.engine === 'gaussian') {
          inputText = applyGeometryHandoff(inputText, atoms);
        }
        task.geometryHandoff = {
          from: upstreamTask.nodeId,
          fromEngine: upstreamEngineId,
          toEngine: task.engine,
          atoms: atoms.length,
        };
      }
      // Issue #25: give the run the upstream optimisation evidence it needs to
      // decide whether a downstream frequency may call its geometry a minimum.
      const validity = {
        ...(task.validity || {}),
        upstream: upstreamTask ? {
          id: upstreamTask.nodeId,
          title: upstreamTask.title,
          state: upstreamTask.status,
          output: upstreamTask.outputName || null,
          settings: upstreamTask.validity?.settings || null,
          parsed: upstreamTask.parsedSummary || null,
        } : null,
      };
      const response = await this.runManager.start({
        title: task.title,
        engine: task.engine,
        argv: task.argv,
        route: task.route || null,
        inputText,
        inputName: task.inputName,
        outputName: task.outputName,
        settings: task.settings,
        executable: queue.options.executable,
        scratchDir: queue.options.scratchDir,
        dryRun: queue.options.dryRun,
        gates: task.gates,
        validity,
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
      // Keep only the records a downstream validity check needs; the full
      // parsed output stays in the run folder.
      task.parsedSummary = record.parsed ? {
        complete: record.parsed.complete !== false,
        status: record.parsed.status || null,
        optimization: { completed: record.parsed.optimization?.completed === true },
        // The one number every rung of a method ladder has in common.
        energyHartree: Number.isFinite(record.parsed.finalEnergy?.hartree) ? record.parsed.finalEnergy.hartree : null,
        // ⟨S²⟩ of the converged wavefunction, with the source recorded so a
        // value read from the annihilation line is not mistaken for a raw one.
        spinSquared: Number.isFinite(record.parsed.spinSquared?.value) ? record.parsed.spinSquared.value : null,
        spinSquaredSource: record.parsed.spinSquared?.source || null,
        freeEnergyHartree: Number.isFinite(record.parsed.thermochemistry?.freeEnergyHartree)
          ? record.parsed.thermochemistry.freeEnergyHartree : null,
        // The ends of an IRC path, so a reaction check can compare them with the
        // blocks that are supposed to be the reactant and the product.
        irc: Array.isArray(record.parsed.reactionPath?.points) && record.parsed.reactionPath.points.length > 1
          ? {
            firstEnergyHartree: record.parsed.reactionPath.points[0].energyHartree ?? null,
            lastEnergyHartree: record.parsed.reactionPath.points[record.parsed.reactionPath.points.length - 1].energyHartree ?? null,
            points: record.parsed.reactionPath.points.length,
          }
          : null,
      } : null;
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
    if (this.starting) throw new Error('A workflow queue is already starting.');
    const active = this.activeQueueExcept(queueId);
    if (active) {
      throw new Error(`Workflow queue "${active.projectName}" is still ${active.status}. Finish or cancel it before resuming another.`);
    }
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
