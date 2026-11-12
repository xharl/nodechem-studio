/**
 * The I/O a workflow report needs before `buildWorkflowReport()` can run.
 *
 * `buildWorkflowReport()` is deliberately pure and synchronous: it receives the
 * queue, the run records and the figure inputs, and returns the model. This
 * module is the other half — read every task's `run.json`, then the cube files
 * the chosen figure set needs — with two properties the serial version did not
 * have:
 *
 * - reads run in a bounded pool, so twenty runs do not become twenty open
 *   descriptors and the disk is not idle between one read and the next;
 * - progress is reported per phase, tagged `records`, `cubes` or `surfaces`, so
 *   the window can show what the report is doing instead of freezing.
 *
 * `--figures none` stops after the records: no run folder is scanned and no
 * cube is read. That is the acceptance contract, not an optimisation detail.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { mapConcurrent } from './concurrency.js';
import { figureInputsFor, normaliseFigureLevel } from './report.js';

/** The phases a report build passes through, in order. */
export const REPORT_PHASES = Object.freeze(['records', 'cubes', 'surfaces']);

const PHASE_LABEL = Object.freeze({
  records: 'reading run records',
  cubes: 'reading cube files',
  surfaces: 'meshing surfaces',
  done: 'done',
});

// Weights are a guess at relative cost, not a measurement: reading records is
// small JSON, cube parse + mesh dominates a surfaces report. They only make the
// bar move smoothly; the final event is always 1.
const PHASE_WEIGHTS = Object.freeze({
  surfaces: { records: 0.25, cubes: 0.45, surfaces: 0.3 },
  basic: { records: 0.15, cubes: 0.85 },
  none: { records: 1 },
});

/**
 * One progress callback over the three phases.
 *
 * `emit(phase, {done,total})` advances the base past any phases already behind
 * it, so a phase with nothing to do does not leave the bar stuck.
 */
function createPhaseProgress(level, onProgress) {
  if (typeof onProgress !== 'function') return { emit() {}, finish() {} };
  const weights = PHASE_WEIGHTS[level] || PHASE_WEIGHTS.basic;
  let current = REPORT_PHASES[0];
  let base = 0;
  return {
    emit(phase, { done = 0, total = 0 } = {}) {
      const index = REPORT_PHASES.indexOf(phase);
      if (index < 0) return;
      while (REPORT_PHASES.indexOf(current) < index) {
        base += weights[current] || 0;
        current = REPORT_PHASES[REPORT_PHASES.indexOf(current) + 1];
      }
      const part = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      onProgress({
        phase,
        label: PHASE_LABEL[phase],
        done,
        total,
        fraction: Math.min(1, base + (weights[phase] || 0) * part),
      });
    },
    finish() {
      onProgress({ phase: 'done', label: PHASE_LABEL.done, done: 1, total: 1, fraction: 1 });
    },
  };
}

/**
 * Read every task's `run.json` and map it under the run id and node id, as the
 * report expects.
 *
 * `nodeIdPolicy` preserves the caller's historical behaviour: the window
 * overwrites a node-id entry when a later task names the same one, while
 * `ncs report` keeps the first. That collision is rare, but changing it would
 * change the document a user already has.
 *
 * `fsApi` is injectable so bounded concurrency and progress can be tested with
 * controlled reads; it defaults to the real filesystem.
 */
export async function readRunRecords(tasks, {
  concurrency,
  onProgress = null,
  fsApi = fs,
  nodeIdPolicy = 'overwrite',
} = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const eligible = list.filter((task) => task && typeof task === 'object' && task.runDir);
  const total = eligible.length;
  let done = 0;
  const results = await mapConcurrent(eligible, async (task) => {
    let record = null;
    try {
      record = JSON.parse(await fsApi.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
    } catch {
      // A task whose run.json is unreadable stays "not reported" in the report.
    }
    done += 1;
    if (onProgress) onProgress({ done, total });
    return record;
  }, { concurrency });

  const records = {};
  eligible.forEach((task, index) => {
    const record = results[index];
    if (!record) return;
    if (task.runId) records[task.runId] = record;
    if (task.nodeId && (nodeIdPolicy !== 'first' || !records[task.nodeId])) {
      records[task.nodeId] = record;
    }
  });
  return records;
}

/**
 * Every input `buildWorkflowReport()` needs for one queue and figure level.
 *
 * Returns `{ records, figures }`; `figures` is the same shape
 * `figureInputsFor()` returns, and for `none` both volume and surface maps are
 * null. `onProgress` receives `{ phase, label, done, total, fraction }`.
 *
 * `loadCubeFigures: false` keeps the *window's* `basic` document: that report
 * has never read cube files, while `ncs report --figures basic` has. The level
 * still reaches the model unchanged; only the cube read is skipped.
 */
export async function loadReportInputs(queue, level, {
  concurrency,
  onProgress = null,
  fsApi = fs,
  cache,
  nodeIdPolicy = 'overwrite',
  loadCubeFigures = true,
} = {}) {
  const chosen = normaliseFigureLevel(level);
  const readsCubes = chosen !== 'none' && loadCubeFigures;
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const eligible = tasks.filter((task) => task && typeof task === 'object' && task.runDir).length;
  const progress = createPhaseProgress(readsCubes ? chosen : 'none', onProgress);
  progress.emit('records', { done: 0, total: eligible });
  const records = await readRunRecords(tasks, {
    concurrency,
    fsApi,
    nodeIdPolicy,
    onProgress: (update) => progress.emit('records', update),
  });
  const figures = readsCubes
    ? await figureInputsFor(queue, chosen, {
      cache,
      concurrency,
      fsApi,
      onProgress: (update) => progress.emit(update.phase, update),
    })
    : { level: chosen, volumes: null, surfaces: null };
  progress.finish();
  return { records, figures };
}
