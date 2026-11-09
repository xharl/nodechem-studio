import { describe, it, expect } from 'vitest';
import {
  blockedPendingTasks,
  finalStatus,
  nextReadyTask,
  topologicalOrder,
} from '../src/shared/workflowGraph.js';

const task = (nodeId, status = 'pending') => ({ nodeId, title: nodeId, status });

describe('topologicalOrder', () => {
  it('orders a chain and ignores loop edges', () => {
    const tasks = [task('a'), task('b'), task('c')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'checkpoint' },
      { from: 'c', to: 'a', type: 'loop' },
    ];
    const result = topologicalOrder(tasks, edges);
    expect(result.cycle).toBeNull();
    expect(result.order).toEqual(['a', 'b', 'c']);
  });

  it('is stable for independent tasks (task array order wins)', () => {
    const tasks = [task('second'), task('first')];
    expect(topologicalOrder(tasks, []).order).toEqual(['second', 'first']);
  });

  it('reports a cycle in ordering edges', () => {
    const tasks = [task('a'), task('b')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'a', type: 'dependency' },
    ];
    const result = topologicalOrder(tasks, edges);
    expect(result.cycle).not.toBeNull();
    expect(result.cycle).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

describe('nextReadyTask', () => {
  it('starts a diamond only after both parents completed', () => {
    const tasks = [task('a'), task('b'), task('c'), task('d')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'a', to: 'c', type: 'dependency' },
      { from: 'b', to: 'd', type: 'dependency' },
      { from: 'c', to: 'd', type: 'dependency' },
    ];
    expect(nextReadyTask(tasks, edges).nodeId).toBe('a');
    tasks[0].status = 'completed';
    expect(nextReadyTask(tasks, edges).nodeId).toBe('b');
    tasks[1].status = 'completed';
    expect(nextReadyTask(tasks, edges).nodeId).toBe('c');
    tasks[2].status = 'completed';
    expect(nextReadyTask(tasks, edges).nodeId).toBe('d');
  });

  it('treats skipped notes as satisfied', () => {
    const tasks = [task('note', 'skipped'), task('calculate')];
    const edges = [{ from: 'note', to: 'calculate', type: 'dependency' }];
    expect(nextReadyTask(tasks, edges).nodeId).toBe('calculate');
  });

  it('does not release a task whose parent failed', () => {
    const tasks = [task('a', 'failed'), task('b')];
    const edges = [{ from: 'a', to: 'b', type: 'dependency' }];
    expect(nextReadyTask(tasks, edges)).toBeNull();
    expect(blockedPendingTasks(tasks, edges)).toEqual([
      { nodeId: 'b', reason: 'blocked by a (failed)' },
    ]);
  });
});

describe('finalStatus', () => {
  it('is null while pending work remains', () => {
    expect(finalStatus([task('a', 'completed'), task('b')])).toBeNull();
  });

  it('reports completed when every task completed or skipped', () => {
    expect(finalStatus([task('a', 'completed'), task('b', 'skipped')])).toBe('completed');
  });

  it('reports failed over needs-review and completed', () => {
    expect(finalStatus([task('a', 'completed'), task('b', 'failed')])).toBe('failed');
  });

  it('reports needs-review for failed gates or blocked control nodes', () => {
    expect(finalStatus([task('a', 'completed'), task('b', 'needs-review')])).toBe('needs-review');
    expect(finalStatus([task('a', 'blocked')])).toBe('needs-review');
  });

  it('reports cancelled when nothing failed', () => {
    expect(finalStatus([task('a', 'cancelled'), task('b', 'completed')])).toBe('cancelled');
  });
});
