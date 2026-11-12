/**
 * Off-main-thread execution of the in-app UFF work (issue #369).
 *
 * The queue used to call `optimizeUff`/`generateUffEnsemble` synchronously from
 * the Electron main process. A 48-atom structure takes up to a second per
 * relaxation and a conformer block may relax 200 of them, so the window could
 * answer no IPC, show no progress and accept no cancel for minutes.
 *
 * This module is the one place that decides where the force field runs:
 *
 *   worker  a `worker_threads` worker (`workers/uffWorker.js`). The default:
 *           the main thread only relays progress and cancellation.
 *   yield   `generateUffEnsembleAsync`/`optimizeUffAsync` on this thread,
 *           yielding to the event loop every 25 iterations. The fallback when
 *           a worker cannot be started (a packaged asar path is the one case
 *           this container cannot exercise), and selectable explicitly.
 *   auto    worker, falling back to yield if the worker cannot even load.
 *   sync    the old synchronous call. Test/diagnostic only: it exists so the
 *           responsiveness test can prove it would catch a regression.
 *
 * Results are cached in a small LRU keyed by a SHA-256 of the atoms, bonds and
 * every option that changes the answer. A queue retry therefore costs a lookup,
 * not another search. The hash is also cheap to log, so a cached run can say
 * which input it reused.
 */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  generateUffEnsemble,
  generateUffEnsembleAsync,
} from '../../src/shared/uffConformers.js';
import {
  isUffCancelled,
  optimizeUff,
  optimizeUffAsync,
  UFF_CONVERGENCE,
} from '../../src/shared/uff.js';

/** The modes `NCS_UFF_EXECUTION` and `new UffJobExecutor({ mode })` accept. */
export const UFF_EXECUTION_MODES = Object.freeze(['auto', 'worker', 'yield', 'sync']);

/** Resolve a mode from an explicit value or `NCS_UFF_EXECUTION`. */
export function resolveUffExecutionMode(value = process.env.NCS_UFF_EXECUTION) {
  const token = String(value ?? '').trim().toLowerCase();
  if (token === 'worker' || token === 'on' || token === 'thread') return 'worker';
  if (token === 'yield' || token === 'off' || token === 'inline') return 'yield';
  if (token === 'sync') return 'sync';
  return 'auto';
}

/** A number that round-trips JSON without conflating NaN with null. */
function canonicalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : String(number);
}

/** Atom fields `optimizeUff` carries through untouched, for the cache key. */
function canonicalExtras(atom) {
  const keys = Object.keys(atom ?? {})
    .filter((key) => key !== 'element' && key !== 'x' && key !== 'y' && key !== 'z')
    .sort();
  if (keys.length === 0) return null;
  const extras = {};
  for (const key of keys) {
    const value = atom[key];
    if (typeof value === 'number') extras[key] = canonicalNumber(value);
    else if (typeof value === 'string' || typeof value === 'boolean' || value === null) extras[key] = value;
    else extras[key] = String(value);
  }
  return extras;
}

function canonicalAtoms(atoms) {
  return (Array.isArray(atoms) ? atoms : []).map((atom) => [
    String(atom?.element ?? ''),
    canonicalNumber(atom?.x),
    canonicalNumber(atom?.y),
    canonicalNumber(atom?.z),
    canonicalExtras(atom),
  ]);
}

function canonicalBonds(bonds) {
  return (Array.isArray(bonds) ? bonds : []).map((bond) => [
    Number(bond?.a),
    Number(bond?.b),
    Number(bond?.order ?? 1),
  ]);
}

const RELAX_OPTION_KEYS = Object.freeze([
  'maxIterations', 'forceToleranceKcalPerAngstrom', 'maxStepAngstrom', 'memory', 'includeVanDerWaals',
]);
const SEARCH_OPTION_KEYS = Object.freeze([
  'torsionStepDegrees', 'maxTrials', 'rmsdThreshold', 'relaxMaxIterations',
  'energyWindowKcal', 'maxConformers', 'temperature', 'spreadThresholdKcal',
  'selectedConformerId',
]);

function canonicalOptions(options, keys) {
  const out = {};
  for (const key of keys) {
    const value = options?.[key];
    out[key] = typeof value === 'number' ? canonicalNumber(value) : (value ?? null);
  }
  return out;
}

/**
 * The cache key: atoms (element and coordinates), bonds (indices and order),
 * and the options that change the numbers. Deliberately not `JSON.stringify` of
 * the caller's object — key order and extra renderer fields must not split one
 * input into two cache entries.
 */
export function uffInputHash(job) {
  const payload = job?.kind === 'search'
    ? {
      version: 1,
      kind: 'search',
      atoms: canonicalAtoms(job.input?.atoms),
      bonds: canonicalBonds(job.input?.bonds),
      options: canonicalOptions(job.input, SEARCH_OPTION_KEYS),
    }
    : {
      version: 1,
      kind: 'relax',
      atoms: canonicalAtoms(job?.molecule?.atoms),
      bonds: canonicalBonds(job?.molecule?.bonds),
      options: canonicalOptions(job?.options, RELAX_OPTION_KEYS),
      types: Array.isArray(job?.options?.types) ? job.options.types.map(String) : null,
    };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Small insertion-ordered LRU; a retry should evict the least recently used. */
class UffResultCache {
  constructor(limit = 8) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 8;
    this.entries = new Map();
  }

  get(key) {
    if (!this.entries.has(key)) return null;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/** `structuredClone` keeps Float64 coordinates bit-identical and detaches callers. */
function cloneResult(result) {
  try {
    return structuredClone(result);
  } catch {
    return result;
  }
}

/**
 * Runs UFF jobs either in a worker or on this thread, with progress,
 * cancellation and the input-hash LRU. One instance is owned by `QueueManager`,
 * so the cache survives a task retry.
 */
export class UffJobExecutor {
  constructor({
    mode,
    cacheSize = 8,
    workerUrl = new URL('./workers/uffWorker.js', import.meta.url),
    progressEvery = 10,
    yieldEvery = UFF_CONVERGENCE.yieldEvery,
  } = {}) {
    this.mode = resolveUffExecutionMode(mode);
    this.workerUrl = workerUrl;
    this.progressEvery = Number.isInteger(progressEvery) && progressEvery > 0 ? progressEvery : 10;
    this.yieldEvery = Number.isInteger(yieldEvery) && yieldEvery > 0 ? yieldEvery : UFF_CONVERGENCE.yieldEvery;
    this.cache = new UffResultCache(cacheSize);
    this.active = new Map();
    this.stats = {
      workerRuns: 0,
      yieldRuns: 0,
      syncRuns: 0,
      cacheHits: 0,
      cacheMisses: 0,
      workerFallbacks: 0,
      cancelled: 0,
    };
  }

  get cacheSize() {
    return this.cache.size;
  }

  /**
   * Run one job.
   *
   * Returns `{ result, cacheHit, mode }`. `result` is exactly what the
   * in-process function returns, or `{ cancelled: true }` when `cancel()` was
   * honoured. `jobId` names this run so a queue can cancel this job without
   * touching another task's relaxation.
   */
  async run(job, {
    jobId = 'uff-job',
    onProgress = null,
    onFallback = null,
    mode = null,
  } = {}) {
    const key = uffInputHash(job);
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.cacheHits += 1;
      return { result: cloneResult(cached), cacheHit: true, mode: 'cache' };
    }
    this.stats.cacheMisses += 1;

    const chosen = resolveUffExecutionMode(mode ?? this.mode);
    let outcome;
    if (chosen === 'sync') {
      this.stats.syncRuns += 1;
      outcome = { result: this.#runSync(job, onProgress), cancelled: false };
    } else if (chosen === 'yield') {
      this.stats.yieldRuns += 1;
      outcome = await this.#runYield(job, { jobId, onProgress });
    } else {
      try {
        this.stats.workerRuns += 1;
        outcome = await this.#runWorker(job, { jobId, onProgress });
      } catch (error) {
        if (chosen !== 'auto' || !error?.workerUnavailable) throw error;
        this.stats.workerFallbacks += 1;
        onFallback?.(error);
        this.stats.yieldRuns += 1;
        outcome = await this.#runYield(job, { jobId, onProgress });
      }
    }

    if (outcome.cancelled) {
      this.stats.cancelled += 1;
      return { result: { cancelled: true }, cacheHit: false, mode: chosen };
    }
    this.cache.set(key, outcome.result);
    return { result: outcome.result, cacheHit: false, mode: chosen };
  }

  /** Stop the job with this id, if it is still running. */
  cancel(jobId) {
    const entry = this.active.get(jobId);
    if (!entry) return false;
    entry.cancel();
    return true;
  }

  /** Stop every active job; used by `dispose()` and queue abandonment. */
  cancelAll() {
    for (const entry of [...this.active.values()]) entry.cancel();
    this.active.clear();
  }

  #runSync(job, onProgress) {
    if (job?.kind === 'relax') {
      return optimizeUff(job.molecule, {
        ...job.options,
        onIteration: (event) => onProgress?.({
          phase: 'relax', maxIterations: job.options?.maxIterations ?? null, ...event,
        }),
      });
    }
    return generateUffEnsemble({ ...job.input, onProgress });
  }

  async #runYield(job, { jobId, onProgress }) {
    let cancelled = false;
    this.active.set(jobId, { cancel: () => { cancelled = true; } });
    const shouldCancel = () => cancelled;
    try {
      const result = job?.kind === 'relax'
        ? await optimizeUffAsync(job.molecule, {
          ...job.options,
          yieldEvery: this.yieldEvery,
          shouldCancel,
          onIteration: (event) => onProgress?.({
            phase: 'relax', maxIterations: job.options?.maxIterations ?? null, ...event,
          }),
        })
        : await generateUffEnsembleAsync({
          ...job.input,
          yieldEvery: this.yieldEvery,
          shouldCancel,
          onProgress,
        });
      return cancelled ? { result: null, cancelled: true } : { result, cancelled: false };
    } catch (error) {
      if (isUffCancelled(error) || cancelled) return { result: null, cancelled: true };
      throw error;
    } finally {
      this.active.delete(jobId);
    }
  }

  #runWorker(job, { jobId, onProgress }) {
    return new Promise((resolve, reject) => {
      const cancelBuffer = new SharedArrayBuffer(4);
      const cancelView = new Int32Array(cancelBuffer);
      let settled = false;
      let ready = false;
      let cancelRequested = false;
      let worker;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        this.active.delete(jobId);
        fn(value);
        worker?.terminate().catch(() => {});
      };
      const fail = (error) => {
        if (!ready) error.workerUnavailable = true;
        settle(reject, error);
      };

      try {
        worker = new Worker(this.workerUrl, {
          workerData: { job, cancelBuffer, progressEvery: this.progressEvery },
          name: `uff-${jobId}`.slice(0, 64),
        });
      } catch (error) {
        fail(error);
        return;
      }

      this.active.set(jobId, {
        cancel: () => {
          cancelRequested = true;
          Atomics.store(cancelView, 0, 1);
          Atomics.notify(cancelView, 0);
          // If the worker cannot reach its next iteration (a hung import, a
          // platform fault), still stop it rather than leave a thread behind.
          const timer = setTimeout(() => {
            if (!settled) worker.terminate().catch(() => {});
          }, 5000);
          timer.unref?.();
        },
      });

      worker.on('message', (message) => {
        if (message?.type === 'ready') {
          ready = true;
          return;
        }
        if (message?.type === 'progress') {
          onProgress?.(message);
          return;
        }
        if (message?.type === 'done') {
          if (cancelRequested) settle(resolve, { result: null, cancelled: true });
          else settle(resolve, { result: message.result, cancelled: false });
          return;
        }
        if (message?.type === 'cancelled') {
          settle(resolve, { result: null, cancelled: true });
          return;
        }
        if (message?.type === 'error') {
          const error = new Error(message.message || 'The UFF worker failed.');
          if (message.code) error.code = message.code;
          settle(reject, error);
        }
      });
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (settled) return;
        if (cancelRequested) {
          settle(resolve, { result: null, cancelled: true });
          return;
        }
        const error = new Error(`The UFF worker exited with code ${code}.`);
        if (!ready) error.workerUnavailable = true;
        settle(reject, error);
      });
    });
  }
}
