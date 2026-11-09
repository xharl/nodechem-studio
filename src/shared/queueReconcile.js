/**
 * Reconcile block states with the queue that actually ran them.
 *
 * A run record and a project are two files. The queue knows what finished; the
 * project file knows what the canvas draws. Nothing used to join them at start
 * up — `restoreQueue()` fired before the project existed, so the canvas came
 * back all `ready` beside a queue of completed tasks (issue 160).
 *
 * These functions are pure: give them the queue's tasks and the project's
 * blocks, and they say what each block's state should be and which block the
 * workbench should point at next. The renderer applies the answer; it does not
 * re-derive it.
 */

/** A control block carries no gates: `completed` is its pass. */
const CONTROL_TYPES = new Set(['loop', 'condition']);

/**
 * The state each block should carry, derived from its tasks.
 *
 * A block with no task in the queue is absent from the map — it has not run, and
 * its state is whatever the project already says.
 *
 * @param {Array<{nodeId?: string, status?: string, gateVerdict?: string|null}>} tasks
 * @param {{typeOf?: (id: string) => string|null}} [options]
 *   `typeOf` answers a block's type, which the tasks do not carry; it decides
 *   whether an all-skipped family is a decision (a control block) or unresolved.
 * @returns {Map<string, 'passed'|'review'|'blocked'>}
 */
export function nodeStatesFromQueue(tasks, { typeOf = () => null } = {}) {
  const states = new Map();
  const byParent = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const parentId = String(task?.nodeId || '').split('~')[0];
    if (!parentId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(task);
  }
  for (const [parentId, family] of byParent) {
    const statuses = family.map((task) => String(task.status || ''));
    // A block with work still queued or running is not decided yet: leave it
    // alone rather than reporting a verdict the queue has not reached.
    if (statuses.some((status) => status === 'running' || status === 'queued')) continue;
    const completed = family.filter((task) => task.status === 'completed');
    const everyCompletedPassed = statuses.every((status) => status === 'completed')
      && completed.every((task) => !task.gateVerdict || task.gateVerdict === 'pass');
    if (statuses.every((status) => status === 'skipped')) {
      // A branch that was not taken is a decision, not pending work: the loop or
      // condition block has done its job. Any other all-skipped block is
      // unresolved and keeps whatever state it had.
      if (CONTROL_TYPES.has(String(typeOf(parentId) || ''))) states.set(parentId, 'passed');
    } else if (statuses.some((status) => status === 'failed')) states.set(parentId, 'review');
    else if (statuses.some((status) => status === 'timed out')) states.set(parentId, 'timed out');
    else if (completed.length > 0 && !everyCompletedPassed) states.set(parentId, 'review');
    else if (everyCompletedPassed) states.set(parentId, 'passed');
    else if (statuses.some((status) => status === 'blocked')) states.set(parentId, 'blocked');
  }
  return states;
}

/**
 * The block the workbench should put in front of the user.
 *
 * `review` outranks `ready`: a block whose output did not pass its gates is a
 * decision the user owes, and pointing at unrelated unrun work instead hides it.
 * A note is never the next action — it has nothing to run.
 *
 * @param {Array<{id: string, type?: string, state?: string}>} nodes
 * @returns {{node: object, kind: 'review'|'ready'}|null}
 */
export function nextAction(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((node) => node?.type !== 'note');
  const review = list.find((node) => node?.state === 'review');
  if (review) return { node: review, kind: 'review' };
  // Issue 177: a block stopped at its wall-clock limit is not something to fix
  // in the method or the code — it has no output to review at all. It outranks
  // unrun work because it has already cost the user a slot, and the decision
  // (raise the limit, or investigate the engine) is theirs.
  const timedOut = list.find((node) => node?.state === 'timed out');
  if (timedOut) return { node: timedOut, kind: 'timeout' };
  const ready = list.find((node) => node?.state === 'ready');
  if (ready) return { node: ready, kind: 'ready' };
  return null;
}

/**
 * Apply a queue's verdicts to a project's blocks, in place.
 *
 * @param {{nodes?: object[]}} project
 * @param {Array} tasks
 * @returns {{changed: boolean, states: Map<string, string>}}
 */
export function applyQueueToProject(project, tasks) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const types = new Map(nodes.map((node) => [String(node?.id ?? ''), node?.type ?? null]));
  const states = nodeStatesFromQueue(tasks, { typeOf: (id) => types.get(id) ?? null });
  let changed = false;
  for (const node of nodes) {
    const next = states.get(String(node?.id ?? ''));
    if (!next || node.state === next) continue;
    node.state = next;
    changed = true;
  }
  return { changed, states };
}
