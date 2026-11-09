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

import { expandSeries, seriesUnitRecord } from './series.js';
import { DerivativeEditError, applyEdits } from './derivative.js';
import { expandComplex } from './complex.js';

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

/** The record fields an input block may filter on; everything else is refused. */
export const RECORD_FILTER_FIELDS = Object.freeze(['id', 'label', 'charge', 'multiplicity']);

/**
 * Does a record pass an input block's `recordFilter`?
 *
 * An empty filter (`field` or `equals` blank) passes everything: that is the
 * default every block is created with, and treating it as "match nothing" would
 * silently run an empty family. `charge` and `multiplicity` compare as numbers,
 * so `"1"` matches `1`; `id` and `label` compare as trimmed strings. An unknown
 * field is an error rather than a filter that matches nothing.
 */
export function recordMatchesFilter(record, filter) {
  const field = String(filter?.field ?? '').trim();
  const equals = String(filter?.equals ?? '').trim();
  if (!field || equals === '') return true;
  if (!RECORD_FILTER_FIELDS.includes(field)) {
    throw new Error(`A record filter cannot use "${field}"; it filters on ${RECORD_FILTER_FIELDS.join(', ')}.`);
  }
  if (field === 'charge' || field === 'multiplicity') {
    const wanted = Number(equals);
    if (!Number.isFinite(wanted)) return false;
    return Number(record?.[field]) === wanted;
  }
  return String(record?.[field] ?? '').trim() === equals;
}

/* ── derivative blocks (issue 189) ────────────────────────── */

/**
 * The six graph edits `derivative.js` implements, in the order the inspector
 * offers them. The list is the single source of truth: the schema enum and the
 * renderer's select both read it, so a new op cannot be accepted by one and
 * refused by the other.
 */
export const DERIVATIVE_OPS = Object.freeze([
  'substitute', 'add', 'remove', 'isotope', 'protonate', 'deprotonate',
]);

/**
 * A scan is capped at 32 variants. Every edit multiplies every downstream block
 * and the plan is capped at 5 000 tasks, so a larger list is a queue nobody can
 * finish; a real substituent scan is a handful of analogues.
 */
export const DERIVATIVE_MAX_EDITS = 32;

/** Short op names for a record id: `<parent>-sub3-F`, `<parent>-iso1-2`. */
const DERIVATIVE_OP_CODES = Object.freeze({
  substitute: 'sub', add: 'add', remove: 'rm', isotope: 'iso', protonate: 'prot', deprotonate: 'deprot',
});

/** A record id is a task-id segment, so it keeps the same 64-character cap. */
const DERIVATIVE_ID_MAX = 64;

function derivativeRefusal(message, { code = 'derivative', atomIndex = null, element = null } = {}) {
  return new DerivativeEditError(message, { code, atomIndex, element });
}

/** The edit as the refusal text names it, before any structure is built. */
function describeEdit(edit) {
  const op = String(edit?.op ?? 'edit');
  const atom = edit?.atom === undefined ? '' : ` atom ${edit.atom}`;
  return `${op}${atom}`;
}

/**
 * Record id of one derivative: parent, op and the argument that tells two edits
 * of the same op apart (the element for substitute/add, the mass for isotope).
 *
 * Stable by construction — the same project always writes the same ids — and it
 * carries no position, so inserting an edit does not rename the others.
 */
function derivativeIdOf(parentId, edit) {
  const op = String(edit?.op ?? 'edit');
  const atom = String(edit?.atom ?? '');
  const suffix = op === 'substitute' || op === 'add'
    ? (edit?.element ? `-${String(edit.element).trim()}` : '')
    : op === 'isotope'
      ? (edit?.mass === undefined || edit?.mass === null ? '' : `-${Number(edit.mass)}`)
      : '';
  return `${String(parentId || 'parent')}-${DERIVATIVE_OP_CODES[op] || op}${atom}${suffix}`;
}

/** The one-line provenance the card, the label and the queue row share. */
function derivativeSummaryOf(operation) {
  const atom = operation.atomIndex;
  switch (operation.op) {
    case 'substitute': return `${operation.before?.element ?? ''}${atom} → ${operation.element}`;
    case 'add': return `+${operation.element} on atom ${atom}`;
    case 'remove': return `−${operation.element}${atom}`;
    case 'isotope': return `${operation.element}${atom} mass ${operation.after?.isotope}`;
    case 'protonate': return `+H on atom ${atom} (charge ${operation.charge}, multiplicity ${operation.multiplicity})`;
    case 'deprotonate': return `−H${atom} (charge ${operation.charge}, multiplicity ${operation.multiplicity})`;
    default: return `${operation.op} atom ${atom}`;
  }
}

/**
 * The parent records a derivative block edits.
 *
 * A named `recordId` is one parent. Without one the block fans out over every
 * enabled record: there is no linkage axis or atom to guess here (the edits name
 * their own atoms), so a whole dataset of parents is a well-defined scan rather
 * than the ambiguity a series refuses.
 */
export function derivativeParents(records, recordId = '') {
  const list = (Array.isArray(records) ? records : []).filter((record) => record && record.enabled !== false);
  const wanted = String(recordId || '');
  if (wanted) {
    const found = list.find((record) => String(record.id) === wanted);
    if (found) return [found];
    const known = list.map((record) => record.id).join(', ') || 'none';
    throw derivativeRefusal(`The derivative parent record "${wanted}" is not an enabled record of this block's dataset (enabled: ${known}).`,
      { code: 'unknown-parent' });
  }
  if (list.length === 0) {
    throw derivativeRefusal('The derivative block has no enabled record to edit; enable one record or import a parent structure.',
      { code: 'no-parent' });
  }
  return list;
}

/** Two records with the same atoms, bonds and spin state leave nothing to compare. */
function derivativeSignatureOf(atoms, bonds, charge, multiplicity) {
  return JSON.stringify({
    atoms: atoms.map((atom) => [atom.element, atom.isotope ?? null, atom.x, atom.y, atom.z]),
    bonds: bonds.map((bond) => [bond.a, bond.b, bond.order]),
    charge,
    multiplicity,
  });
}

/**
 * Expand a derivative block into ordinary records — one per edit, each applied
 * to its parent on its own (issue 189).
 *
 * `edits` is the block's list `[{ op, atom, element?, mass?, charge?,
 * multiplicity? }]`. Each entry is an independent variant of the parent, which
 * is what makes one block a substituent scan (H → F, Cl, OMe) or a
 * protonated/deprotonated pair. The composed form — several edits building one
 * molecule — is `applyEdits()` in `derivative.js`, and it stays available to a
 * caller that wants it; a block is a scan, so its edits do not chain.
 *
 * Every refusal comes from `applyEdits()` itself: no bonds on the parent, a
 * valence overrun, an index out of range, a dangling bond, an unknown isotope,
 * a missing charge or multiplicity. Nothing here restates those rules; the
 * message is prefixed with the parent and the edit it belongs to and otherwise
 * passed through verbatim.
 */
export function expandDerivative(records, edits, recordId = '') {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw derivativeRefusal('An edit list needs at least one edit; an empty list has no structure to build.',
      { code: 'no-edits' });
  }
  const parents = derivativeParents(records, recordId);
  const generated = [];
  const seen = new Map();

  for (const parent of parents) {
    if (!Array.isArray(parent.coords) || parent.coords.length === 0) {
      throw derivativeRefusal(`The parent record "${parent.id}" has no 3D coordinates, so there is nothing to edit.`
        + ' A record without a geometry would otherwise be built as the demo water molecule.',
      { code: 'no-coordinates' });
    }
    // The topology must be stated by the record. `applyEdits()` refuses a
    // molecule without bonds rather than perceiving one from distances, because
    // a valence check built on a perception guess is not a check.
    const molecule = {
      recordId: String(parent.id),
      atoms: parent.coords,
      ...(Array.isArray(parent.bonds) ? { bonds: parent.bonds } : {}),
      charge: parent.charge,
      multiplicity: parent.multiplicity,
    };

    edits.forEach((edit, position) => {
      let result;
      try {
        result = applyEdits(molecule, [edit]);
      } catch (error) {
        if (!(error instanceof DerivativeEditError)) throw error;
        throw new DerivativeEditError(`"${parent.id}" ${describeEdit(edit)}: ${error.message}`, {
          code: error.code, atomIndex: error.atomIndex, element: error.element,
        });
      }
      const id = derivativeIdOf(parent.id, edit);
      if (id.length > DERIVATIVE_ID_MAX) {
        throw derivativeRefusal(`The derivative id "${id}" is ${id.length} characters; record ids stop at ${DERIVATIVE_ID_MAX}.`
          + ` Shorten the parent record id "${parent.id}".`,
        { code: 'id-too-long' });
      }
      const signature = derivativeSignatureOf(result.atoms, result.bonds, result.charge, result.multiplicity);
      const previous = seen.get(signature);
      if (previous) {
        throw derivativeRefusal(previous.parentId === parent.id
          ? `Edits ${previous.position} and ${position + 1} of "${parent.id}" produce the same structure ("${id}");`
            + ' two identical records leave nothing to compare.'
          : `"${previous.id}" (from "${previous.parentId}") and "${id}" (from "${parent.id}") are the same structure;`
            + ' two identical records leave nothing to compare.',
        { code: 'duplicate-record' });
      }
      seen.set(signature, { id, position: position + 1, parentId: String(parent.id) });
      const summary = derivativeSummaryOf(result.provenance.operations[0]);
      generated.push({
        id,
        label: `${parent.label || parent.id} · ${summary}`,
        charge: result.charge,
        multiplicity: result.multiplicity,
        coords: result.atoms.map((atom) => ({
          element: atom.element,
          x: atom.x,
          y: atom.y,
          z: atom.z,
          ...(Number.isInteger(atom.isotope) && atom.isotope > 0 ? { isotope: atom.isotope } : {}),
          ...(Number.isInteger(atom.fragment) && atom.fragment > 0 ? { fragment: atom.fragment } : {}),
        })),
        bonds: result.bonds.map((bond) => ({ a: bond.a, b: bond.b, order: bond.order })),
        enabled: true,
        // Provenance #193 will copy into `run.json`: which parent, which edits,
        // and the numbering the atom indices in them use.
        derivative: {
          parentId: String(parent.id),
          operations: result.provenance.operations,
          atomIndexBase: result.provenance.atomIndexBase,
          formula: result.formula,
          summary,
          geometryStatus: result.geometryStatus,
          geometryNote: result.geometryNote,
        },
      });
    });
  }
  return generated;
}

/**
 * The records an input block iterates: enabled, then filtered, then expanded.
 *
 * `options.datasets` is the project's dataset list, needed only by a complex
 * block whose members may name a dataset other than the bound one. Callers that
 * pass nothing still work when every member lives in the bound dataset.
 */
export function recordsForInput(input, dataset, { datasets = null } = {}) {
  const filter = input?.input?.recordFilter;
  const records = enabledRecords(dataset).filter((record) => recordMatchesFilter(record, filter));
  // Issue 188: a complex block is a structure block whose members are separate
  // records and whose output is one system. The expansion happens here, at plan
  // time, so every consumer of a record set keeps working unchanged.
  const complex = input?.input?.complex;
  if (complex) {
    return expandComplex(complex, { dataset, datasets }).records;
  }
  const series = input?.input?.series;
  if (!series) {
    const edits = input?.input?.edits;
    if (!Array.isArray(edits) || edits.length === 0) return records;
    // Issue 189: a derivative block is a structure block whose output is one
    // edited record per edit. Expanding here keeps every consumer of a record
    // set unchanged, and every guard runs before a single input file exists.
    return expandDerivative(records, edits, input?.input?.recordId);
  }
  // Issue 169: a series block is a structure block whose unit is one record and
  // whose output is N generated ones. The expansion happens here, at plan time,
  // so every consumer of a record set keeps working unchanged. A linkage that
  // cannot be built throws with the atoms named — never a guessed geometry.
  return expandSeries(seriesUnitRecord(records, input?.input?.recordId), series).records;
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
  return { input, dataset, records: recordsForInput(input, dataset, { datasets: datasetsOf(project) }) };
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
