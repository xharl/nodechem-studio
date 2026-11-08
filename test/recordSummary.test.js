import { describe, it, expect } from 'vitest';
import { groupTasksByRecord, recordIdOfTask, recordSummaryLabel } from '../src/renderer/recordSummary.js';

const task = (id, status, extra = {}) => ({ nodeId: id, title: id, status, ...extra });

describe('recordIdOfTask', () => {
  it('prefers the planner recordId and falls back to the task-id segment', () => {
    expect(recordIdOfTask({ nodeId: 'opt~m1', recordId: 'm1' })).toBe('m1');
    expect(recordIdOfTask({ nodeId: 'opt~m2' })).toBe('m2');
    expect(recordIdOfTask({ nodeId: 'opt~m3~c1' })).toBe('m3');
    expect(recordIdOfTask({ nodeId: 'opt' })).toBeNull();
  });
});

describe('groupTasksByRecord', () => {
  it('reports no records for the single-molecule queue', () => {
    const group = groupTasksByRecord([task('opt', 'completed'), task('freq', 'running')]);
    expect(group.hasRecords).toBe(false);
    expect(group.records).toEqual([]);
    expect(recordSummaryLabel(group)).toBe('');
  });

  it('rolls a record up to its worst status and first error', () => {
    const group = groupTasksByRecord([
      task('opt~m1', 'completed', { recordId: 'm1', record: { id: 'm1', label: 'Water' }, gateVerdict: 'pass' }),
      task('freq~m1', 'completed', { recordId: 'm1', record: { id: 'm1', label: 'Water' }, gateVerdict: 'pass' }),
      task('opt~m2', 'failed', { recordId: 'm2', record: { id: 'm2', label: 'Ammonia' }, error: 'SCF did not converge' }),
      task('freq~m2', 'blocked', { recordId: 'm2', record: { id: 'm2', label: 'Ammonia' }, error: 'waiting for opt~m2' }),
      task('opt~m3', 'completed', { recordId: 'm3', record: { id: 'm3', label: 'Methane' }, gateVerdict: 'pass' }),
    ]);

    expect(group.hasRecords).toBe(true);
    expect(group.records.map((record) => record.id)).toEqual(['m1', 'm2', 'm3']);
    const water = group.records[0];
    expect(water).toMatchObject({ status: 'completed', done: true, failed: false, gates: 'pass' });
    const ammonia = group.records[1];
    expect(ammonia).toMatchObject({
      status: 'failed',
      done: false,
      failed: true,
      gates: '',
      error: 'SCF did not converge',
      taskCount: 2,
      finished: 2,
    });
    expect(group).toMatchObject({ total: 3, done: 2, failed: 1, partial: true });
    expect(recordSummaryLabel(group)).toBe('3 records · 2 done / 1 failed');
  });

  it('keeps a running record out of done and out of failed', () => {
    const group = groupTasksByRecord([
      task('opt~m1', 'completed', { recordId: 'm1' }),
      task('opt~m2', 'running', { recordId: 'm2' }),
    ]);
    expect(group.records[1].status).toBe('running');
    expect(group).toMatchObject({ done: 1, failed: 0, partial: false });
  });

  it('uses task ids when a queue predates recordId', () => {
    const group = groupTasksByRecord([task('opt~m1', 'completed'), task('freq~m1', 'completed')]);
    expect(group.hasRecords).toBe(true);
    expect(group.records).toHaveLength(1);
    expect(group.records[0]).toMatchObject({ id: 'm1', status: 'completed', done: true });
  });

  it('labels a single record in the singular', () => {
    const group = groupTasksByRecord([task('opt~m1', 'completed')]);
    expect(recordSummaryLabel(group)).toBe('1 record · 1 done');
  });
});
