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
 */
export async function cubeVolumesFor(queue) {
  const volumes = {};
  for (const task of Array.isArray(queue?.tasks) ? queue.tasks : []) {
    if (!task?.runDir || !task.nodeId) continue;
    let entries;
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await fs.readdir(task.runDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const cube = entries.find((entry) => entry.isFile() && /\.cube$/i.test(entry.name));
    if (!cube) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fs.readFile(path.join(task.runDir, cube.name), 'utf8');
      const parsedCube = parseCube(text);
      // The figure slices in index space and labels the axes in Å, which is only
      // true when the cube's axes are axis-aligned: a rotated cube is reported
      // rather than drawn as if it were an xy plane.
      const axisAligned = parsedCube.axes.every((vector, index) => vector
        .every((component, componentIndex) => (componentIndex === index ? true : Math.abs(component) < 1e-6)));
      volumes[task.nodeId] = {
        values: parsedCube.values,
        origin: parsedCube.origin,
        step: parsedCube.spacing,
        counts: parsedCube.dims,
        min: parsedCube.stats?.min ?? 0,
        max: parsedCube.stats?.max ?? 0,
        axisAligned,
        source: cube.name,
      };
    } catch {
      // An unreadable cube is not a figure; the report says the slice is absent.
    }
  }
  return volumes;
}

/**
 * Isosurfaces for the volumes, when the `surfaces` figure set was asked for.
 *
 * The isovalue is a stated fraction (10 %) of the field's largest absolute value
 * rather than a magic constant, and the two lobes are meshed separately at +iso
 * and −iso so their phases stay apart. A volume too dense to mesh within the cap
 * returns null and the figure says so.
 */
export async function surfacesFor(volumes) {
  if (!volumes) return null;
  const out = {};
  for (const [nodeId, volume] of Object.entries(volumes)) {
    if (!volume || !Array.isArray(volume.counts) || volume.axisAligned === false) continue;
    const iso = Math.max(Math.abs(volume.min ?? 0), Math.abs(volume.max ?? 0)) * 0.1;
    if (!(iso > 0)) continue;
    const step = Array.isArray(volume.step) ? volume.step : [volume.step, volume.step, volume.step];
    const field = {
      dims: volume.counts,
      origin: volume.origin,
      step: volume.step,
      axes: [[step[0], 0, 0], [0, step[1], 0], [0, 0, step[2]]],
      values: volume.values,
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      const positive = extractSurface(field, iso, { maxTriangles: 20000 });
      // eslint-disable-next-line no-await-in-loop
      const negative = extractSurface(field, -iso, { maxTriangles: 20000 });
      out[nodeId] = {
        iso,
        meshes: [
          { positions: positive.positions, normals: positive.normals, sign: 1 },
          { positions: negative.positions, normals: negative.normals, sign: -1 },
        ].filter((mesh) => mesh.positions.length > 0),
      };
    } catch {
      // A field that cannot be meshed is reported by the figure, not thrown here.
    }
  }
  return out;
}

/**
 * The volume and surface inputs a figure level needs, or nulls for `none`.
 *
 * `none` reads nothing: asking for no figures should not parse a cube.
 */
export async function figureInputsFor(queue, level) {
  const chosen = normaliseFigureLevel(level);
  if (chosen === 'none') return { level: chosen, volumes: null, surfaces: null };
  const volumes = await cubeVolumesFor(queue);
  const surfaces = chosen === 'surfaces' ? await surfacesFor(volumes) : null;
  return { level: chosen, volumes, surfaces };
}
