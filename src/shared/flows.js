/**
 * Flows, datasets and record iteration (RFC 0001, schema v2).
 *
 * Pure module: no DOM, no filesystem.
 *
 * A project holds one or more **flows**, each a graph of blocks. A flow that
 * starts at an `input` block runs once per **record** of that block's
 * **dataset**; a flow without an input block runs once on the project molecule,
 * which is exactly how every v1 project behaved.
 *
 * Compatibility: `project.nodes` and `project.edges` are kept as enumerable
 * aliases of the active flow's graph so existing code (renderer, planner,
 * queue, tests) keeps reading the same arrays. `stringifyProject` drops the
 * aliases, so the file on disk carries `flows[]` only. Mutations that *replace*
 * a graph must go through `setFlowGraph()`, because assigning `project.nodes =`
 * would leave the flow pointing at the old array.
 */

export const DEFAULT_FLOW_ID = 'main';

/** Same grammar as node ids: what can appear in a task id and a folder name. */
export const GRAPH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A record id becomes a task-id segment, so it keeps the node-id grammar. */
export const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function flowsOf(project) {
  return Array.isArray(project?.flows) ? project.flows : [];
}

export function flowById(project, id) {
  const wanted = String(id || '');
  return flowsOf(project).find((flow) => flow.id === wanted) || null;
}

/** The flow the next plan, save and render act on. */
export function activeFlow(project) {
  const flows = flowsOf(project);
  if (flows.length === 0) return null;
  return flowById(project, project?.activeFlowId) || flows[0];
}

export function activeFlowId(project) {
  return activeFlow(project)?.id || DEFAULT_FLOW_ID;
}

export function nodesOfFlow(flow) {
  return Array.isArray(flow?.nodes) ? flow.nodes : [];
}

export function edgesOfFlow(flow) {
  return Array.isArray(flow?.edges) ? flow.edges : [];
}

/** The active flow's graph — the arrays every caller already reads. */
export function nodesOf(project) {
  return nodesOfFlow(activeFlow(project));
}

export function edgesOf(project) {
  return edgesOfFlow(activeFlow(project));
}

/**
 * Replace the active flow's graph and refresh the aliases.
 *
 * Renderer edits that filter or rebuild a graph must use this: a bare
 * `project.nodes = [...]` leaves `flows[i].nodes` stale and the next save
 * writes the old graph.
 */
export function setFlowGraph(project, { nodes = null, edges = null } = {}) {
  const flow = activeFlow(project);
  if (!flow) return project;
  if (Array.isArray(nodes)) flow.nodes = nodes;
  if (Array.isArray(edges)) flow.edges = edges;
  attachGraphAliases(project);
  return project;
}

/**
 * Point `project.nodes` / `project.edges` at the active flow's arrays.
 *
 * Called after validation and after any history snapshot is parsed back; it is
 * idempotent and cheap.
 */
export function attachGraphAliases(project) {
  if (!isPlainObject(project)) return project;
  const flow = activeFlow(project);
  if (!flow) {
    if (!Array.isArray(project.nodes)) project.nodes = [];
    if (!Array.isArray(project.edges)) project.edges = [];
    return project;
  }
  project.nodes = nodesOfFlow(flow);
  project.edges = edgesOfFlow(flow);
  return project;
}

/**
 * Rebuild the in-memory aliases of a project that came back from JSON (history
 * snapshot, IPC, draft file). It does not validate: callers that need
 * validation use `validateProject`.
 */
export function hydrateProject(raw) {
  if (!isPlainObject(raw)) return raw;
  if (Array.isArray(raw.flows) && raw.flows.length > 0) {
    attachGraphAliases(raw);
    return raw;
  }
  // A legacy project already carries its graph at the top level; wrap it so a
  // snapshot taken before the migration still renders.
  raw.flows = [{
    id: DEFAULT_FLOW_ID,
    title: 'Workflow',
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  }];
  raw.activeFlowId = DEFAULT_FLOW_ID;
  return attachGraphAliases(raw);
}

export function datasetsOf(project) {
  return Array.isArray(project?.datasets) ? project.datasets : [];
}

export function datasetById(project, id) {
  const wanted = String(id || '');
  return datasetsOf(project).find((dataset) => dataset.id === wanted) || null;
}

export function recordsOf(dataset) {
  return Array.isArray(dataset?.records) ? dataset.records : [];
}

/** Records a run includes: a disabled record is kept in the file, not queued. */
export function enabledRecords(dataset) {
  return recordsOf(dataset).filter((record) => record && record.enabled !== false);
}

export function inputNodesOf(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter((node) => node?.type === 'input');
}

/** Edges that order tasks (everything except branch/loop routing). */
export function orderingEdgesOf(edges) {
  return (Array.isArray(edges) ? edges : []).filter((edge) => edge?.type === 'dependency'
    || edge?.type === 'checkpoint'
    || edge?.type === 'barrier');
}

/**
 * The input block that scopes a node, found by walking upstream.
 *
 * Returns `{ input, dataset, records }` when exactly one input feeds the node,
 * `null` when none does (the node runs once on the project molecule), and
 * throws when two different inputs meet at the same block: one block cannot
 * consume two record sets without inventing a pairing.
 */
export function scopeFor(project, nodes, edges, node) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((item) => [item.id, item]));
  const upstream = new Map();
  for (const edge of orderingEdgesOf(edges)) {
    if (!upstream.has(edge.to)) upstream.set(edge.to, []);
    upstream.get(edge.to).push(edge.from);
  }
  const seen = new Set();
  const inputs = new Map();
  const stack = [...(upstream.get(node?.id) || [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const source = byId.get(id);
    if (source?.type === 'input') {
      inputs.set(source.id, source);
      continue;
    }
    for (const next of upstream.get(id) || []) stack.push(next);
  }
  if (inputs.size === 0) return null;
  if (inputs.size > 1) {
    const titles = [...inputs.values()].map((input) => `"${input.title || input.id}"`).join(' and ');
    throw new Error(`"${node.title || node.id}" is fed by two datasets (${titles}).`
      + ' A block cannot run over two record sets; split the flow, or join the branches first.');
  }
  const [input] = inputs.values();
  const dataset = datasetById(project, input.input?.datasetId);
  if (!dataset) {
    throw new Error(`"${input.title || input.id}" references dataset "${input.input?.datasetId || ''}", which is not in this project.`);
  }
  return { input, dataset, records: enabledRecords(dataset) };
}

/**
 * Task id for a block in a scope.
 *
 * Single-record flows keep the bare node id, which is what every v1 project
 * wrote: no migration rewrites task ids, run folders or bundles.
 */
export function taskIdFor(nodeId, recordId = null, memberId = null) {
  const parts = [String(nodeId)];
  if (recordId) parts.push(String(recordId));
  if (memberId) parts.push(String(memberId));
  return parts.join('~');
}

/**
 * Split a task id back into its segments. Node ids, record ids and member ids
 * cannot contain `~`, so the split is unambiguous.
 */
export function parseTaskId(taskId) {
  const parts = String(taskId || '').split('~');
  return { nodeId: parts[0] || '', recordId: parts[1] || null, memberId: parts[2] || null };
}

/** A dataset record's effective charge/multiplicity, defaulting to the project. */
export function recordChemistry(project, record) {
  const molecule = isPlainObject(project?.molecule) ? project.molecule : {};
  const charge = Number.isInteger(record?.charge) ? record.charge : molecule.charge;
  const multiplicity = Number.isInteger(record?.multiplicity) ? record.multiplicity : molecule.multiplicity;
  return { charge, multiplicity };
}
