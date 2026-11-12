/**
 * Report figure-set plumbing, shared by `ncs report` and the window's
 * Report… action.
 *
 * The report itself is `workflowReport.js`; this module only decides *which*
 * inputs a figure set gets. Keeping the decision here is what stops the CLI and
 * the desktop app drifting into two different meanings of "basic": both ask for
 * a level from `FIGURE_LEVELS`, and both read the run folder's cube files with
 * the same function, so a slice figure in a window report and a slice figure in
 * a CLI report describe the same file.
 *
 * A cube is read only from the task's own run folder. The report may not reach
 * outside the folder it is documenting, and a volume from somewhere else would
 * be a figure about a different file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { mapConcurrent, yieldToEventLoop } from './concurrency.js';
import { defaultCubeCache, cubeCacheKey } from './cubeCache.js';
import { parseCube } from './cubeFile.js';
import { extractSurface } from './marchingCubes.js';

/** The figure sets `ncs report --figures` accepts, in the order the window lists them. */
export const FIGURE_LEVELS = Object.freeze(['basic', 'surfaces', 'none']);

/**
 * One of `FIGURE_LEVELS`, or `'basic'` for anything unrecognised.
 *
 * The default is the report's own figure set, so a caller that passes nothing
 * (or an old payload) gets exactly the document it got before the choice existed.
 */
export function normaliseFigureLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  return FIGURE_LEVELS.includes(level) ? level : 'basic';
}

/**
 * Parsed cube volumes for the tasks of a queue, keyed by node id.
 *
 * `spacing` is the cube's per-axis step in Å, which is what the slice figure
 * labels the axes with.
 *
 * Reads are pooled: a queue of fifty runs does not open fifty files at once, but
 * it does not wait for each one before starting the next either. A parsed cube
 * is stored in `cache` under its path, mtime and size, so regenerating the same
 * report does not parse an unchanged file twice.
 *
 * `onProgress({ done, total })` counts tasks scanned, including a task with no
 * cube: progress describes the queue, not only the runs that wrote a file.
 * `fsApi` is injectable so cache reuse and the no-read path can be tested
 * without mocking a built-in module.
 */
export async function cubeVolumesFor(queue, {
  cache = defaultCubeCache,
  concurrency,
  onProgress = null,
  fsApi = fs,
} = {}) {
  const tasks = (Array.isArray(queue?.tasks) ? queue.tasks : [])
    .filter((task) => task && typeof task === 'object' && task.runDir && task.nodeId);
  const total = tasks.length;
  let done = 0;
  const volumes = {};
  const results = await mapConcurrent(tasks, async (task) => {
    const volume = await cubeVolumeForTask(task, { cache, fsApi });
    done += 1;
    if (onProgress) onProgress({ done, total });
    return volume;
  }, { concurrency });
  // Insert in task order, as the serial loop did: key order is observable in
  // `Object.entries`, and the report's figure order follows this object.
  tasks.forEach((task, index) => {
    if (results[index]) volumes[task.nodeId] = results[index];
  });
  return volumes;
}

/** One task's cube volume, or null when the folder has no readable cube. */
async function cubeVolumeForTask(task, { cache, fsApi }) {
  let entries;
  try {
    entries = await fsApi.readdir(task.runDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const cube = entries.find((entry) => entry.isFile() && /\.cube$/i.test(entry.name));
  if (!cube) return null;
  const file = path.join(task.runDir, cube.name);
  let stat;
  try {
    stat = await fsApi.stat(file);
  } catch {
    return null;
  }
  try {
    return await cache.load(cubeCacheKey(file, stat), async () => {
      const text = await fsApi.readFile(file, 'utf8');
      const parsedCube = parseCube(text);
      // The figure slices in index space and labels the axes in Å, which is only
      // true when the cube's axes are axis-aligned: a rotated cube is reported
      // rather than drawn as if it were an xy plane.
      const axisAligned = parsedCube.axes.every((vector, index) => vector
        .every((component, componentIndex) => (componentIndex === index ? true : Math.abs(component) < 1e-6)));
      return {
        values: parsedCube.values,
        origin: parsedCube.origin,
        step: parsedCube.spacing,
        counts: parsedCube.dims,
        min: parsedCube.stats?.min ?? 0,
        max: parsedCube.stats?.max ?? 0,
        axisAligned,
        source: cube.name,
      };
    });
  } catch {
    // An unreadable cube is not a figure; the report says the slice is absent.
    return null;
  }
}

/**
 * Isosurfaces for the volumes, when the `surfaces` figure set was asked for.
 *
 * The isovalue is a stated fraction (10 %) of the field's largest absolute value
 * rather than a magic constant, and the two lobes are meshed separately at +iso
 * and −iso so their phases stay apart. A volume too dense to mesh within the cap
 * returns null and the figure says so.
 *
 * Meshing is synchronous arithmetic, so it stays on the caller's thread and is
 * followed by a macrotask turn: a long queue reports progress and lets the
 * window deliver events between two volumes instead of freezing for the set.
 */
export async function surfacesFor(volumes, { onProgress = null } = {}) {
  if (!volumes) return null;
  const entries = Object.entries(volumes);
  const out = {};
  let done = 0;
  for (const [nodeId, volume] of entries) {
    const surface = surfaceForVolume(volume);
    if (surface) out[nodeId] = surface;
    done += 1;
    if (onProgress) onProgress({ done, total: entries.length });
    // eslint-disable-next-line no-await-in-loop
    await yieldToEventLoop();
  }
  return out;
}

/** One volume's ± lobes, or null when the volume cannot be drawn. */
function surfaceForVolume(volume) {
  if (!volume || !Array.isArray(volume.counts) || volume.axisAligned === false) return null;
  const iso = Math.max(Math.abs(volume.min ?? 0), Math.abs(volume.max ?? 0)) * 0.1;
  if (!(iso > 0)) return null;
  const step = Array.isArray(volume.step) ? volume.step : [volume.step, volume.step, volume.step];
  const field = {
    dims: volume.counts,
    origin: volume.origin,
    step: volume.step,
    axes: [[step[0], 0, 0], [0, step[1], 0], [0, 0, step[2]]],
    values: volume.values,
  };
  try {
    const positive = extractSurface(field, iso, { maxTriangles: 20000 });
    const negative = extractSurface(field, -iso, { maxTriangles: 20000 });
    return {
      iso,
      meshes: [
        { positions: positive.positions, normals: positive.normals, sign: 1 },
        { positions: negative.positions, normals: negative.normals, sign: -1 },
      ].filter((mesh) => mesh.positions.length > 0),
    };
  } catch {
    // A field that cannot be meshed is reported by the figure, not thrown here.
    return null;
  }
}

/**
 * The volume and surface inputs a figure level needs, or nulls for `none`.
 *
 * `none` reads nothing: asking for no figures should not parse a cube.
 * `onProgress` is tagged with the phase it belongs to (`cubes`, `surfaces`) so
 * the caller can map the three phases onto one progress bar.
 */
export async function figureInputsFor(queue, level, { onProgress = null, ...options } = {}) {
  const chosen = normaliseFigureLevel(level);
  if (chosen === 'none') return { level: chosen, volumes: null, surfaces: null };
  const volumes = await cubeVolumesFor(queue, {
    ...options,
    onProgress: onProgress ? (progress) => onProgress({ phase: 'cubes', ...progress }) : null,
  });
  const surfaces = chosen === 'surfaces'
    ? await surfacesFor(volumes, {
      onProgress: onProgress ? (progress) => onProgress({ phase: 'surfaces', ...progress }) : null,
    })
    : null;
  return { level: chosen, volumes, surfaces };
}
