/**
 * Flow-tab models and graph duplication (RFC 0001).
 *
 * Pure module: the renderer draws what these functions return, so the tab
 * order, the active tab, the ids a new flow may take and the "duplicate a
 * graph without its runs" rule are testable without a DOM.
 */

import {
  activeFlow,
  edgesOfFlow,
  enabledRecords,
  flowsOf,
  nodesOfFlow,
} from '../shared/flows.js';
import { seriesMemberCount } from '../shared/series.js';

/**
 * A flow id has the same grammar as a node id (it never reaches a task id, but
 * it does reach a file and a folder). Lower-case keeps the URL-like ids tidy.
 */
export function slugifyGraphId(value, fallback = 'flow') {
  const ascii = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48);
  if (!slug) slug = fallback;
  if (!/^[a-z0-9]/.test(slug)) slug = `f-${slug}`.slice(0, 48);
  return slug;
}

/** A slug that is not already taken: `barrier`, `barrier-2`, `barrier-3`… */
export function uniqueGraphId(base, existingIds = []) {
  const taken = new Set(existingIds.map((id) => String(id)));
  const seed = slugifyGraphId(base);
  let candidate = seed;
  let suffix = 2;
  while (taken.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${seed.slice(0, 60 - tail.length)}${tail}`;
    suffix += 1;
  }
  return candidate;
}

export function flowIdFromTitle(title, existingIds = []) {
  return uniqueGraphId(String(title || 'flow'), existingIds);
}

/** "Flow 2" / "Flow 3" — a readable default title, not a duplicate title. */
export function nextFlowTitle(flows = []) {
  const used = new Set(flows.map((flow) => String(flow?.title || '')));
  let number = flows.length + 1;
  let title = `Flow ${number}`;
  while (used.has(title)) {
    number += 1;
    title = `Flow ${number}`;
  }
  return title;
}

/**
 * Every tab, in file order, with the counts the bar shows. The record count is
 * the enabled records of the datasets the flow's input blocks name; a flow
 * without an input block has no record count (it runs on the project
 * molecule, as every v1 flow did).
 */
export function flowTabModels(project) {
  const active = activeFlow(project);
  const datasets = Array.isArray(project?.datasets) ? project.datasets : [];
  return flowsOf(project).map((flow) => {
    const nodes = nodesOfFlow(flow);
    const inputs = nodes.filter((node) => node.type === 'input');
    // Issue 169: a series block queues one run per member, not one per unit
    // record, so it contributes its member count to the tab. Plain blocks keep
    // the old rule: a dataset counts once however many blocks name it.
    const seen = new Set();
    let records = 0;
    for (const node of inputs) {
      if (node.input?.series) {
        records += seriesMemberCount(node.input.series);
        continue;
      }
      const id = node.input?.datasetId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const dataset = datasets.find((entry) => entry.id === id);
      records += dataset ? enabledRecords(dataset).length : 0;
    }
    return {
      id: flow.id,
      title: flow.title || flow.id,
      active: Boolean(active && flow.id === active.id),
      nodeCount: nodes.length,
      edgeCount: edgesOfFlow(flow).length,
      recordCount: records,
    };
  });
}

/**
 * Deep-copy a flow's graph for "Duplicate flow".
 *
 * The copy is a design, not a run: calculation and conformer blocks lose
 * `output` (parsed results and artifact references) and `parsed`, and every
 * state returns to `ready`. An output block's `output` is its configuration
 * (kind, path, include, manifest), not a run, so that object is kept — only a
 * recorded artifact is dropped. Edges and node ids are kept, because they
 * describe the copy's own graph.
 */
export function duplicateFlowGraph(flow, { id, title } = {}) {
  const source = flow && typeof flow === 'object' ? flow : {};
  const nodes = JSON.parse(JSON.stringify(Array.isArray(source.nodes) ? source.nodes : []));
  const edges = JSON.parse(JSON.stringify(Array.isArray(source.edges) ? source.edges : []));
  for (const node of nodes) {
    node.state = 'ready';
    delete node.parsed;
    if (node.type === 'output') {
      if (node.output && typeof node.output === 'object') {
        delete node.output.artifact;
        delete node.output.lastArtifact;
        delete node.output.generatedAt;
      }
      continue;
    }
    delete node.output;
  }
  return {
    id: id || slugifyGraphId(title || source.id || 'flow'),
    title: title || `${source.title || source.id || 'Flow'} copy`,
    nodes,
    edges,
  };
}
