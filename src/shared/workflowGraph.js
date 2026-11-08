/**
 * Durable queue planning for NodeChem Studio.
 *
 * Pure functions over a task list and the project's edges. No filesystem, no
 * Electron: the queue manager persists state, these functions decide order.
 *
 * Rules that matter chemically:
 *   - `loop` edges are control flow, not an ordering constraint. Treating them
 *     as dependencies would make every retry graph cyclic.
 *   - `branch` edges are ordering constraints until the condition runtime
 *     releases exactly one of them (GN-005).
 *   - A task never starts before every ordering predecessor completed. A note
 *     is skipped, which counts as satisfied. A failed or blocked predecessor
 *     blocks dependents instead of letting them run on stale inputs.
 */

/**
 * `barrier` orders across records (RFC 0001): the plan already expanded it to
 * every source-record → consumer pair, so here it is an ordinary predecessor.
 */
export const ORDERING_EDGE_TYPES = Object.freeze(['dependency', 'checkpoint', 'branch', 'barrier']);

export const TERMINAL_STATUSES = Object.freeze([
  'completed', 'failed', 'needs-review', 'blocked', 'skipped', 'cancelled', 'interrupted',
]);

export const FAILED_STATUSES = Object.freeze(['failed', 'cancelled', 'interrupted']);

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);
const isSatisfied = (status) => status === 'completed' || status === 'skipped';

function orderingEdges(edges) {
  return (Array.isArray(edges) ? edges : []).filter((edge) => ORDERING_EDGE_TYPES.includes(edge.type));
}

/**
 * Deterministic Kahn topological order. Task array order is the tie-breaker,
 * so the order is stable across app restarts and platforms.
 * Returns { order: [nodeId...], cycle: [nodeId...] | null }.
 */
export function topologicalOrder(tasks, edges) {
  const ids = tasks.map((task) => task.nodeId);
  const index = new Map(ids.map((id, position) => [id, position]));
  const incoming = new Map(ids.map((id) => [id, []]));
  const outgoing = new Map(ids.map((id) => [id, []]));

  for (const edge of orderingEdges(edges)) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue;
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }

  const remaining = new Map(ids.map((id) => [id, incoming.get(id).length]));
  const ready = ids.filter((id) => remaining.get(id) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => index.get(a) - index.get(b));
    const id = ready.shift();
    order.push(id);
    for (const next of outgoing.get(id)) {
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) ready.push(next);
    }
  }

  if (order.length === ids.length) return { order, cycle: null };

  // Report the smallest remaining cycle by walking unresolved nodes.
  const unresolved = ids.filter((id) => !order.includes(id));
  return { order, cycle: findCycle(unresolved, incoming, outgoing) || unresolved };
}

function findCycle(candidates, incoming, outgoing) {
  const allowed = new Set(candidates);
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      return stack.slice(start >= 0 ? start : 0).concat(id);
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of outgoing.get(id)) {
      if (!allowed.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of candidates) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Next task that may start now, in stable task order. Null when none is ready.
 *
 * `skip` holds task ids already started but not yet marked running (RFC 0001:
 * a parallel drain launches several tasks before any of them has woken up).
 * Skipping them here — rather than filtering the task list — keeps their
 * successors correctly blocked until they finish.
 */
export function nextReadyTask(tasks, edges, skip = null) {
  const byId = new Map(tasks.map((task) => [task.nodeId, task]));
  const prerequisites = new Map(tasks.map((task) => [task.nodeId, []]));
  for (const edge of orderingEdges(edges)) {
    if (prerequisites.has(edge.to) && byId.has(edge.from)) prerequisites.get(edge.to).push(edge.from);
  }
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (skip && skip.has(task.nodeId)) continue;
    const ready = prerequisites.get(task.nodeId).every((id) => isSatisfied(byId.get(id).status));
    if (ready) return task;
  }
  return null;
}

/**
 * Pending tasks whose prerequisites can never be satisfied, with the reason.
 * Used to mark dependents blocked instead of leaving the queue spinning.
 */
export function blockedPendingTasks(tasks, edges) {
  const byId = new Map(tasks.map((task) => [task.nodeId, task]));
  const prerequisites = new Map(tasks.map((task) => [task.nodeId, []]));
  for (const edge of orderingEdges(edges)) {
    if (prerequisites.has(edge.to) && byId.has(edge.from)) prerequisites.get(edge.to).push(edge.from);
  }
  const blocked = [];
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    for (const id of prerequisites.get(task.nodeId)) {
      const source = byId.get(id);
      if (source.status === 'blocked' || source.status === 'needs-review' || FAILED_STATUSES.includes(source.status)) {
        blocked.push({ nodeId: task.nodeId, reason: `blocked by ${source.title || source.nodeId} (${source.status})` });
        break;
      }
    }
  }
  return blocked;
}

/**
 * Queue status once nothing is runnable:
 *   null          → work remains that is neither runnable nor blocked (keep running)
 *   completed     → every task completed or skipped
 *   partial       → some records finished and some failed (RFC 0001)
 *   failed        → at least one task failed and nothing succeeded
 *   needs-review  → gates failed or control-flow nodes blocked
 *   cancelled     → cancelled with no failures
 *
 * `partial` exists because a family run that lost three records of two hundred
 * is neither a pass nor a failure, and collapsing it into either would misreport
 * the chemistry that did compute.
 */
export function finalStatus(tasks) {
  const statuses = tasks.map((task) => task.status);
  if (statuses.length === 0) return 'completed';
  if (statuses.some((status) => !isTerminal(status))) return null;
  const succeeded = statuses.filter((status) => status === 'completed').length;
  // `cancelled` is its own verdict; only a real failure (or an interrupted
  // run, which the old contract also reported as failed) makes a queue fail.
  const recordScoped = tasks.some((task) => task && task.recordId);
  // In a family run a gate failure is one record's outcome, so it feeds the same
  // partial/failed decision as a crash. In a single-molecule graph it stays
  // needs-review, exactly as before.
  const failed = statuses.filter((status) => status === 'failed' || status === 'interrupted'
    || (recordScoped && status === 'needs-review')).length;
  // `partial` is a record-family verdict: a graph that lost one block and ran
  // another is still a failed graph. A dataset run that lost three records of
  // two hundred is neither a pass nor a failure.
  if (failed > 0) return recordScoped && succeeded > 0 ? 'partial' : 'failed';
  if (statuses.includes('needs-review') || statuses.includes('blocked')) return 'needs-review';
  if (statuses.includes('cancelled')) return 'cancelled';
  return 'completed';
}
