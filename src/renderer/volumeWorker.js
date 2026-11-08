/**
 * The grid-evaluation worker.
 *
 * Evaluating a 4e6-point orbital is seconds of arithmetic on the main thread,
 * and seconds on the main thread is a frozen window: no orbit, no scroll, no
 * cancel. This module worker takes one job at a time, reports progress at most
 * every 100 ms, and posts typed arrays back by transfer so the result is not
 * copied.
 *
 * Message in:
 *
 *   { id, type: 'evaluate', kind: 'orbital' | 'density',
 *     shells, cartesianOrder, precision: 'f32' | 'f64',
 *     coefficients?, coefficientsByMo?, occupations?,
 *     grid: { origin, counts, step, atoms },
 *     mesh: { iso } | null }
 *
 * Messages out:
 *
 *   { id, type: 'progress', done, total }        (throttled to 100 ms)
 *   { id, type: 'result', values, mesh, ms, grid }
 *   { id, type: 'error', message, name }
 *
 * `mesh` is `{ positive, negative }` when the job asked for one: the two lobes
 * of a signed field, or only `positive` for a density (a density has no
 * negative lobe, and drawing an empty second mesh would imply one).
 *
 * The worker holds no state between jobs. A cache keyed by (shells, orbital,
 * spacing) would be the next step and is deliberately not here: a stale grid
 * that no longer matches the record is worse than a recomputation.
 */

import { extractSurface } from '../shared/marchingCubes.js';
import { evaluateDensity, evaluateOrbital } from '../shared/volume.js';

const PROGRESS_INTERVAL_MS = 100;

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => {
    const job = event?.data;
    if (!job || job.type !== 'evaluate') return;
    const { id } = job;
    const started = Date.now();
    let lastReport = 0;
    const onProgress = (done, total) => {
      const now = Date.now();
      if (now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      self.postMessage({ id, type: 'progress', done, total });
    };

    try {
      const { grid, shells, cartesianOrder = 'gaussian', precision = 'f32' } = job;
      if (!grid || !Array.isArray(grid.counts) || !Array.isArray(grid.atoms)) {
        throw new Error('the worker needs a grid with counts and atoms.');
      }
      const values = job.kind === 'density'
        ? evaluateDensity({
          shells,
          coefficientsByMo: job.coefficientsByMo,
          occupations: job.occupations,
          grid,
          cartesianOrder,
          precision,
          onProgress,
        })
        : evaluateOrbital({
          shells,
          coefficients: job.coefficients,
          grid,
          cartesianOrder,
          precision,
          onProgress,
        });

      const field = {
        values,
        dims: grid.counts,
        origin: grid.origin,
        step: grid.step,
        signed: job.kind !== 'density',
      };

      let mesh = null;
      if (job.mesh && Number.isFinite(job.mesh.iso) && job.mesh.iso !== 0) {
        const iso = Math.abs(job.mesh.iso);
        mesh = {
          positive: extractSurface(field, iso, { maxTriangles: job.maxTriangles }),
          negative: field.signed
            ? extractSurface(field, -iso, { maxTriangles: job.maxTriangles })
            : null,
        };
      }

      const transfers = [values.buffer];
      if (mesh) {
        transfers.push(mesh.positive.positions.buffer, mesh.positive.normals.buffer);
        if (mesh.negative) transfers.push(mesh.negative.positions.buffer, mesh.negative.normals.buffer);
      }
      self.postMessage({
        id,
        type: 'result',
        values,
        mesh,
        ms: Date.now() - started,
        grid: { counts: grid.counts, origin: grid.origin, step: grid.step },
      }, transfers);
    } catch (error) {
      self.postMessage({
        id,
        type: 'error',
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error),
      });
    }
  };
}
