import { describe, expect, it } from 'vitest';

import { applyQueueToProject, nextAction, nodeStatesFromQueue } from '../src/shared/queueReconcile.js';

/**
 * Issue 160: a relaunch restored the queue (twelve completed tasks, badge
 * "12/12") and a canvas where every block read `Ready`, with the Next Action
 * saying "Run the next block: Psi4 HF/cc-pvdz SP has all prerequisites and is
 * ready to export" — for a block that had already produced -76.02676 Eh.
 *
 * The cause was ordering: `restoreQueue()` ran at start up, before any project
 * file existed, so the verdicts had no blocks to land on. On the current tree
 * this module does not exist and the reconciliation never runs after the project
 * loads, so this file fails to import — the behaviour it pins is new.
 *
 * The fixture mirrors the reported project: twelve blocks, twelve completed
 * tasks, one task per block.
 */

const BLOCKS = [
  { id: 'sp-hf-dz', type: 'calc', state: 'ready', title: 'HF/cc-pVDZ SP' },
  { id: 'sp-hf-tz', type: 'calc', state: 'ready', title: 'HF/cc-pVTZ SP' },
  { id: 'mp2-dz', type: 'calc', state: 'ready', title: 'MP2/cc-pVDZ SP' },
  { id: 'mp2-tz', type: 'calc', state: 'ready', title: 'MP2/cc-pVTZ SP' },
  { id: 'ccsd-dz', type: 'calc', state: 'ready', title: 'CCSD/cc-pVDZ SP' },
  { id: 'ccsd-tz', type: 'calc', state: 'ready', title: 'CCSD/cc-pVTZ SP' },
  { id: 'freq-hf', type: 'calc', state: 'ready', title: 'HF/cc-pVDZ Freq' },
  { id: 'opt-hf', type: 'calc', state: 'ready', title: 'HF/cc-pVDZ Opt' },
  { id: 'loop-cbs', type: 'loop', state: 'ready', title: 'CBS loop' },
  { id: 'cond-1', type: 'condition', state: 'ready', title: 'Converged?' },
  { id: 'report', type: 'output', state: 'ready', title: 'Report' },
  { id: 'note-1', type: 'note', state: 'ready', title: 'Notes' },
];

const completed = (id, extra = {}) => ({ nodeId: id, status: 'completed', gateVerdict: 'pass', ...extra });

const project = () => ({ nodes: BLOCKS.map((block) => ({ ...block })) });

describe('restoring block states from the queue', () => {
  it('makes every completed block read passed, not ready', () => {
    const prose = project();
    const tasks = BLOCKS.slice(0, 11).map((block) => completed(block.id));
    const { changed, states } = applyQueueToProject(prose, tasks);

    expect(changed).toBe(true);
    expect(states.size).toBe(11);
    for (const node of prose.nodes.slice(0, 11)) expect(node.state).toBe('passed');
    // The note never ran, so nothing prescribes it.
    expect(prose.nodes[11].state).toBe('ready');
  });

  it('stops pointing the user at work that already ran', () => {
    const prose = project();
    applyQueueToProject(prose, BLOCKS.slice(0, 11).map((block) => completed(block.id)));

    // Nothing is left to run: the Next Action must be silence, not "Run the next
    // block" over a completed flowchart.
    expect(nextAction(prose.nodes)).toBeNull();
  });

  it('still points at the genuinely unrun block when the queue stops short', () => {
    const prose = project();
    applyQueueToProject(prose, BLOCKS.slice(0, 6).map((block) => completed(block.id)));

    const next = nextAction(prose.nodes);
    expect(next?.kind).toBe('ready');
    expect(next?.node.id).toBe('freq-hf');
  });

  it('reports a failed block as review, and review outranks ready', () => {
    const prose = project();
    applyQueueToProject(prose, [
      ...BLOCKS.slice(0, 5).map((block) => completed(block.id)),
      { nodeId: 'ccsd-tz', status: 'failed' },
    ]);

    expect(prose.nodes.find((node) => node.id === 'ccsd-tz').state).toBe('review');
    const next = nextAction(prose.nodes);
    expect(next?.kind).toBe('review');
    expect(next?.node.id).toBe('ccsd-tz');
  });

  it('reports a completed run that failed its gates as review', () => {
    const states = nodeStatesFromQueue([completed('mp2-dz', { gateVerdict: 'fail' })]);
    expect(states.get('mp2-dz')).toBe('review');
  });

  it('leaves a block alone while its work is still running or queued', () => {
    const states = nodeStatesFromQueue([
      { nodeId: 'opt-hf', status: 'running' },
      { nodeId: 'opt-hf~1', status: 'completed', gateVerdict: 'pass' },
    ]);
    expect(states.has('opt-hf')).toBe(false);
  });

  it('counts an untaken branch as a decision only for a control block', () => {
    const skipped = [{ nodeId: 'cond-1', status: 'skipped' }, { nodeId: 'calc-x', status: 'skipped' }];
    const states = nodeStatesFromQueue(skipped, {
      typeOf: (id) => (id === 'cond-1' ? 'condition' : 'calc'),
    });
    expect(states.get('cond-1')).toBe('passed');
    expect(states.has('calc-x')).toBe(false);
  });

  it('marks a blocked block as blocked, and ignores tasks for blocks that are gone', () => {
    const states = nodeStatesFromQueue([
      { nodeId: 'report', status: 'blocked' },
      { nodeId: 'deleted-node', status: 'completed', gateVerdict: 'pass' },
    ]);
    expect(states.get('report')).toBe('blocked');
    expect(states.has('deleted-node')).toBe(true);
    // ...but applying it to a project that no longer has that block changes nothing.
    const prose = project();
    applyQueueToProject(prose, [{ nodeId: 'deleted-node', status: 'completed' }]);
    expect(prose.nodes.every((node) => node.state === 'ready')).toBe(true);
  });

  it('is idempotent: applying the same queue twice changes nothing the second time', () => {
    const prose = project();
    const tasks = BLOCKS.slice(0, 11).map((block) => completed(block.id));
    expect(applyQueueToProject(prose, tasks).changed).toBe(true);
    expect(applyQueueToProject(prose, tasks).changed).toBe(false);
  });
});
