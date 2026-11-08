/**
 * Per-record roll-up of a queue (RFC 0001).
 *
 * Pure: the run console renders these rows, so "which record failed, at which
 * block, with which gate" is computed (and tested) outside the DOM. A queue
 * with no `recordId` on any task is the single-molecule path and keeps the
 * existing console untouched.
 */

import { parseTaskId } from '../shared/flows.js';

const SUCCESS = new Set(['completed', 'skipped']);
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled', 'skipped', 'interrupted']);

/** `task.recordId` when the planner set it, otherwise the task-id segment. */
export function recordIdOfTask(task) {
  if (task?.recordId) return String(task.recordId);
  const fromId = parseTaskId(task?.nodeId || task?.id).recordId;
  return fromId || null;
}

function statusForTasks(tasks) {
  const statuses = tasks.map((task) => String(task.status || 'pending'));
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'needs-review')) return 'needs-review';
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'pending')) return 'pending';
  if (statuses.every((status) => status === 'cancelled')) return 'cancelled';
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'interrupted')) return 'interrupted';
  if (statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.every((status) => SUCCESS.has(status))) return 'completed';
  if (statuses.some((status) => SUCCESS.has(status))) return 'partial';
  return statuses[0] || 'pending';
}

function firstError(tasks) {
  const failed = tasks.find((task) => task.error);
  return failed ? String(failed.error) : '';
}

function gateSummary(tasks) {
  const verdicts = [...new Set(tasks
    .map((task) => task.gateVerdict)
    .filter((verdict) => verdict && verdict !== 'unknown'))];
  if (verdicts.length === 0) {
    const unknowns = tasks.some((task) => task.gateVerdict === 'unknown');
    return unknowns ? 'unknown' : '';
  }
  return verdicts.join(', ');
}

/**
 * Group a queue's tasks by record.
 *
 * @returns {{
 *   hasRecords: boolean,
 *   records: Array<{id: string, label: string, status: string, done: boolean,
 *     failed: boolean, gates: string, error: string, taskCount: number,
 *     finished: number}>,
 *   total: number, done: number, failed: number, partial: boolean,
 * }}
 */
export function groupTasksByRecord(tasks = []) {
  const groups = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = recordIdOfTask(task);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(task);
  }

  const records = [...groups.entries()].map(([id, recordTasks]) => {
    const status = statusForTasks(recordTasks);
    const done = recordTasks.every((task) => SUCCESS.has(String(task.status)));
    const failed = recordTasks.some((task) => String(task.status) === 'failed');
    const finished = recordTasks.filter((task) => TERMINAL.has(String(task.status))).length;
    return {
      id,
      label: recordTasks.find((task) => task.record?.label)?.record.label || id,
      status,
      done,
      failed,
      gates: gateSummary(recordTasks),
      error: firstError(recordTasks),
      taskCount: recordTasks.length,
      finished,
    };
  });

  const done = records.filter((record) => record.done).length;
  const failed = records.filter((record) => record.failed).length;
  return {
    hasRecords: records.length > 0,
    records,
    total: records.length,
    done,
    failed,
    partial: failed > 0 && done > 0,
  };
}

/** "3 records · 2 done / 1 failed" — the one-line summary above the table. */
export function recordSummaryLabel(group) {
  if (!group || !group.hasRecords) return '';
  const recordWord = group.total === 1 ? 'record' : 'records';
  const failed = group.failed > 0 ? ` / ${group.failed} failed` : '';
  return `${group.total} ${recordWord} · ${group.done} done${failed}`;
}
