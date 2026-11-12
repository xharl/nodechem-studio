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

import { createHash } from 'node:crypto';
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

/* ── Artifacts manifest (issue #354) ─────────────────────── */

/** The manifest an output block appends to, relative to the queue folder. */
export const ARTIFACTS_MANIFEST_NAME = 'manifest.json';
export const ARTIFACTS_DIR = 'artifacts';

/** `a/b` → `a/b`, `a\b` → `a/b`, anything absolute or escaping the root → null. */
function safeArtifactPath(value) {
  const raw = typeof value === 'string' ? value.replace(/\\/g, '/').trim() : '';
  if (!raw) return null;
  // An absolute path is not an artifact name: the manifest stores paths
  // relative to the artifact root. A drive letter is absolute even on POSIX.
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

/** POSIX-style path of `target` inside `root`, `''` for the root itself, else null. */
function relativeInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return '';
  if (path.isAbsolute(relative)) return null;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || relative.startsWith('../')) return null;
  return relative.split(path.sep).join('/');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The artifacts manifest the queue's output blocks wrote, read for the report
 * (issue #354).
 *
 * An output block appends `{ path, kind, flowId, bytes, sha256, generatedAt }`
 * to `<artifactRoot>/manifest.json` (see `appendArtifactEntry()` in
 * `electron/runner/queue.js`), so the folder already answers "what did this
 * workflow write, how big is it, and is it the file the manifest names". The
 * report reads it here, outside `buildWorkflowReport()`, so the builder stays
 * pure and deterministic: it receives this object and never touches a disk.
 *
 * Returns `{ recorded: false, reason, … }` when there is no manifest or it
 * cannot be read — the report prints `not recorded` rather than an empty
 * table, because "nothing was recorded" and "nothing was written" are
 * different facts. When it is readable:
 *
 *   - `entries[]` is one object per file, with `path` made relative to the
 *     queue folder (never an absolute path, which must not reach the HTML) and
 *     `missingOnDisk` set when the manifest names a file the folder no longer
 *     holds;
 *   - `manifestSha256`/`manifestBytes` are the digest and size of the manifest
 *     file itself, so a reader can check the index as well as the files;
 *   - `skipped` counts entries not printed because their path is absolute or
 *     climbs out of the artifact root. A manifest entry is data from a file on
 *     disk, not a path the report may follow: the report prints what it can
 *     prove stays inside the folder it documents.
 *
 * `artifactsRoot` is the folder the queue wrote to; the app's default is
 * `<queueDir>/artifacts`, while `ncs run --out <dir>` writes `manifest.json`
 * at the named folder. `fsApi` is injectable for tests, like `cubeVolumesFor`.
 */
export async function loadArtifactsManifest(queueDir, { fsApi = fs, artifactsRoot = null } = {}) {
  const queueRoot = path.resolve(String(queueDir || '.'));
  const root = typeof artifactsRoot === 'string' && artifactsRoot.trim()
    ? path.resolve(artifactsRoot)
    : path.join(queueRoot, ARTIFACTS_DIR);
  // Only the relative location is ever printed: this string can reach the HTML.
  const relativeRoot = relativeInside(queueRoot, root);
  const source = relativeRoot === null
    ? ARTIFACTS_MANIFEST_NAME
    : (relativeRoot ? `${relativeRoot}/${ARTIFACTS_MANIFEST_NAME}` : ARTIFACTS_MANIFEST_NAME);
  const base = {
    recorded: false,
    source,
    outsideQueue: relativeRoot === null,
    manifestSha256: null,
    manifestBytes: null,
    generatedAt: null,
    entries: [],
    count: 0,
    totalBytes: null,
    missingOnDisk: 0,
    skipped: 0,
  };

  let bytes;
  try {
    bytes = await fsApi.readFile(path.join(root, ARTIFACTS_MANIFEST_NAME));
  } catch (error) {
    return {
      ...base,
      reason: error?.code === 'ENOENT'
        ? `no ${source} in this folder`
        : `${source} could not be read${error?.code ? ` (${error.code})` : ''}`,
    };
  }
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const digest = sha256Hex(raw);

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ...base, manifestSha256: digest, manifestBytes: raw.length, reason: `${source} is not valid JSON` };
  }
  // `appendArtifactEntry()` reads both shapes; a legacy writer may have wrapped
  // the list in `{ artifacts: [...] }`.
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.artifacts) ? parsed.artifacts : null);
  if (!list) {
    return { ...base, manifestSha256: digest, manifestBytes: raw.length, reason: `${source} is not a list of artifacts` };
  }

  const entries = [];
  let skipped = 0;
  let missingOnDisk = 0;
  for (const item of list) {
    // eslint-disable-next-line no-await-in-loop
    const entry = await artifactEntryFor(item, { root, relativeRoot, fsApi });
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (entry.missingOnDisk) missingOnDisk += 1;
    entries.push(entry);
  }
  const sizes = entries.map((entry) => entry.bytes).filter((size) => size !== null);
  return {
    ...base,
    recorded: true,
    reason: null,
    manifestSha256: digest,
    manifestBytes: raw.length,
    generatedAt: entries.map((entry) => entry.generatedAt).filter(Boolean).sort().at(-1) || null,
    entries,
    count: entries.length,
    totalBytes: sizes.length === 0 ? null : sizes.reduce((sum, size) => sum + size, 0),
    missingOnDisk,
    skipped,
  };
}

/**
 * One manifest entry, or null when its path is not a name the report may print.
 * `path` is the queue-relative label: `<artifacts dir>/<path>` when the root is
 * inside the queue folder, and the root-relative path when it is not.
 */
async function artifactEntryFor(item, { root, relativeRoot, fsApi }) {
  if (!item || typeof item !== 'object') return null;
  const relative = safeArtifactPath(item.path);
  if (!relative) return null;
  const target = path.join(root, ...relative.split('/'));
  // Belt and braces: the segment check above already refuses `..`, but the
  // resolved path must still be inside the root before it is printed or read.
  if (relativeInside(root, target) !== relative) return null;
  let missingOnDisk = false;
  try {
    const stat = await fsApi.stat(target);
    missingOnDisk = typeof stat?.isFile === 'function' ? !stat.isFile() : false;
  } catch {
    // An entry whose file is gone is the fact a reader most needs: it is
    // printed, with the row marked, rather than dropped from the table.
    missingOnDisk = true;
  }
  const size = Number(item.bytes);
  return {
    path: relativeRoot === null || relativeRoot === '' ? relative : `${relativeRoot}/${relative}`,
    kind: typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : null,
    flowId: typeof item.flowId === 'string' && item.flowId.trim() ? item.flowId.trim() : null,
    bytes: Number.isFinite(size) && size >= 0 ? Math.trunc(size) : null,
    sha256: typeof item.sha256 === 'string' && item.sha256.trim() ? item.sha256.trim() : null,
    generatedAt: typeof item.generatedAt === 'string' && item.generatedAt.trim() ? item.generatedAt.trim() : null,
    missingOnDisk,
  };
}
