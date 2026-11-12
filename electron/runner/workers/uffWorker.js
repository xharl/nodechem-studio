/**
 * The worker that runs an in-app UFF job off the Electron main thread.
 *
 * One job per worker: `runInWorker` in `../uffJob.js` starts it, hands the job
 * and a shared cancel flag through `workerData`, and terminates it when the
 * result has arrived. The worker imports the same `src/shared` engine the main
 * process imports, so a worker relaxation is the same arithmetic, statement for
 * statement — the tests compare its output byte for byte with `optimizeUff`.
 *
 * Cancellation is a `SharedArrayBuffer` integer rather than a posted message:
 * the minimiser runs a tight synchronous loop, so it would not read a message
 * until the whole job ended. `Atomics.load` is checked once per iteration,
 * which is what bounds cancellation to one iteration batch.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { generateUffEnsemble } from '../../../src/shared/uffConformers.js';
import { isUffCancelled, optimizeUff, uffCancelledError } from '../../../src/shared/uff.js';

const { job, cancelBuffer, progressEvery = 10 } = workerData;
const cancelView = new Int32Array(cancelBuffer);
const cancelled = () => Atomics.load(cancelView, 0) !== 0;
const post = (message) => parentPort.postMessage(message);

/** Progress is a sample, not a transcript: a trial's end, its first iteration,
 *  and every Nth one in between. */
function reportProgress(event) {
  if (event.phase === 'trial' || event.iteration === 1 || event.iteration % progressEvery === 0) {
    post({ type: 'progress', ...event });
  }
}

try {
  post({ type: 'ready' });
  if (job?.kind === 'relax') {
    const result = optimizeUff(job.molecule, {
      ...job.options,
      onIteration: (event) => {
        if (cancelled()) throw uffCancelledError('The UFF relaxation was cancelled by the user.');
        reportProgress({
          phase: 'relax',
          maxIterations: job.options?.maxIterations ?? null,
          ...event,
        });
      },
    });
    post({ type: 'done', result });
  } else if (job?.kind === 'search') {
    const result = generateUffEnsemble({
      ...job.input,
      shouldCancel: cancelled,
      onProgress: (event) => {
        if (cancelled()) throw uffCancelledError('The UFF search was cancelled by the user.');
        reportProgress(event);
      },
    });
    post({ type: 'done', result });
  } else {
    throw new Error(`Unknown UFF job kind "${job?.kind ?? ''}".`);
  }
} catch (error) {
  if (isUffCancelled(error)) {
    post({ type: 'cancelled' });
  } else {
    post({ type: 'error', message: error?.message || String(error), code: error?.code || '' });
  }
}
