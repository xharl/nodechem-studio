import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProjectText } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, checkpointSourceNode } from '../src/shared/workflowTasks.js';
import { flowIndex, planIndex, scopeFor, scopeIn } from '../src/shared/flows.js';

/**
 * Issue 367 — the planner builds its indexes once per plan.
 *
 * Two properties are held here:
 *
 * 1. the plan is unchanged. `test/fixtures/plans/` was generated from the
 *    commit before this refactor for every shipped example; the full plan is
 *    compared deep-equal and then byte for byte, so task ids, order, input
 *    text and hashes all have to match.
 * 2. the index is built once. A counting `filter`/`find` on the edges array
 *    proves the number of full edge passes is a constant, not one per block —
 *    on the pre-#367 path a 40-node chain filtered the edge list 40 times.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLES = path.join(ROOT, 'examples');
const PLANS = path.join(ROOT, 'test/fixtures/plans');

const exampleFiles = fs.readdirSync(EXAMPLES)
  .filter((file) => file.endsWith('.ncs'))
  .sort();

function parseExample(file) {
  const parsed = parseProjectText(fs.readFileSync(path.join(EXAMPLES, file), 'utf8'));
  expect(parsed.errors, JSON.stringify(parsed.errors)).toEqual([]);
  return parsed.project;
}

/** A chain of `count` calculate blocks, one dependency edge between each pair. */
function chainProject(count) {
  const nodes = [];
  const edges = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `c${index}`,
      type: 'calculate',
      kind: 'SP',
      title: `Block ${index}`,
      state: 'ready',
      x: 10,
      y: 10,
      settings: { jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', checkpoint: `c${index}.chk` },
    });
    if (index > 0) edges.push({ from: `c${index - 1}`, to: `c${index}`, type: 'dependency', branch: null });
  }
  return {
    schemaVersion: 3,
    name: `chain-${count}`,
    activeFlowId: 'main',
    flows: [{ id: 'main', title: 'Main', nodes, edges }],
    nodes,
    edges,
    defaults: { engine: 'gaussian', method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4 },
    molecule: { charge: 0, multiplicity: 1, coords: [], fragments: [] },
    datasets: [],
  };
}

/**
 * The same edges, with the two whole-array reads counted.
 *
 * `orderingEdgesOf` filters, and the old per-block scans found. A planner that
 * builds one index per plan touches the list a fixed number of times; one that
 * rebuilds it per block touches it once per block.
 */
function countingEdges(edges) {
  const stats = { filters: 0, finds: 0 };
  const list = edges.slice();
  Object.defineProperty(list, 'filter', {
    value(...args) { stats.filters += 1; return Array.prototype.filter.apply(this, args); },
  });
  Object.defineProperty(list, 'find', {
    value(...args) { stats.finds += 1; return Array.prototype.find.apply(this, args); },
  });
  return { list, stats };
}

function chainWithCountingEdges(count) {
  const project = chainProject(count);
  const counted = countingEdges(project.edges);
  project.edges = counted.list;
  project.flows[0].edges = counted.list;
  return { project, stats: counted.stats };
}

describe('buildWorkflowPlan output is unchanged (issue 367)', () => {
  for (const file of exampleFiles) {
    it(`${file} matches the pre-refactor plan byte for byte`, () => {
      const project = parseExample(file);
      const expected = fs.readFileSync(path.join(PLANS, file.replace(/\.ncs$/, '.json')), 'utf8');
      const plan = buildWorkflowPlan(project);

      expect(plan).toEqual(JSON.parse(expected));
      expect(`${JSON.stringify(plan, null, 2)}\n`).toBe(expected);
    });
  }
});

describe('the plan builds its indexes once, not per block (issue 367)', () => {
  it('touches the edge list a constant number of times on a 40-block chain', () => {
    const { project, stats } = chainWithCountingEdges(40);
    const plan = buildWorkflowPlan(project);

    expect(plan.tasks).toHaveLength(40);
    // One pass for the flow index (scopes + prepare edge) and one for the
    // project index (node lookup + checkpoint adjacency). The pre-#367 planner
    // filtered the list once per block: 40 here, 120 on the chain below.
    expect(stats.filters).toBe(2);
    // A checkpoint hand-off is answered from the adjacency, never a full find.
    expect(stats.finds).toBe(0);
  });

  it('does not grow with the number of blocks', () => {
    const small = chainWithCountingEdges(40);
    const large = chainWithCountingEdges(120);
    buildWorkflowPlan(small.project);
    buildWorkflowPlan(large.project);

    expect(large.stats.filters).toBe(small.stats.filters);
    expect(large.stats.finds).toBe(0);
  });

  it('keeps the standalone helpers identical to the indexed paths', () => {
    const project = parseExample('apn-fluorescence.ncs');
    const nodes = project.nodes;
    const edges = project.edges;
    const index = flowIndex(nodes, edges);
    const projectWide = planIndex(project);

    for (const node of nodes) {
      expect(scopeIn(index, project, node)).toEqual(scopeFor(project, nodes, edges, node));
      expect(checkpointSourceNode(project, node, projectWide)).toEqual(checkpointSourceNode(project, node));
    }
  });
});
