import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createCubeCache, defaultCubeCache } from '../src/shared/cubeCache.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { cubeVolumesFor, figureInputsFor, surfacesFor } from '../src/shared/report.js';
import { loadReportInputs, readRunRecords } from '../src/shared/reportInputs.js';
import { parseCube } from '../src/shared/cubeFile.js';

const roots = [];
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function scratch(prefix = 'ncs-report-inputs-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function recordFor(runId, index = 0) {
  return {
    id: runId,
    status: 'completed',
    engine: 'gaussian',
    dryRun: false,
    elapsedSeconds: 12,
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.4 - index * 0.0001 } },
    gates: { overall: 'pass', validity: { overall: 'pass' } },
  };
}

async function queueWithRuns(root, count, { cube = null } = {}) {
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    const runId = `run-${index}`;
    const runDir = path.join(root, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(recordFor(runId, index)));
    if (cube) await fs.copyFile(cube, path.join(runDir, 'field.cube'));
    tasks.push({
      nodeId: `node-${index}`,
      runId,
      runDir,
      title: `Optimise ${index}`,
      type: 'calculate',
      kind: 'Opt',
      status: 'passed',
    });
  }
  return { id: 'q-report-inputs', projectName: 'Inputs', status: 'completed', tasks };
}

describe('report run-record reads', () => {
  it('uses a bounded pool, preserves task order and reports every completion', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 12);
    let active = 0;
    let peak = 0;
    const progress = [];
    const fsApi = {
      readFile: async (file, encoding) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        active -= 1;
        return fs.readFile(file, encoding);
      },
    };

    const records = await readRunRecords(queue.tasks, {
      concurrency: 3,
      fsApi,
      onProgress: (update) => progress.push(update),
    });

    // Bounded: never more than three reads, but more than one in flight.
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(Object.keys(records)).toHaveLength(24);
    expect(records['run-0'].id).toBe('run-0');
    expect(records['node-11'].id).toBe('run-11');
    expect(progress).toHaveLength(12);
    expect(progress.map((update) => update.done).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(progress.every((update) => update.total === 12)).toBe(true);
  });

  it('skips an unreadable record without starving the rest or the progress', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 3);
    await fs.writeFile(path.join(queue.tasks[1].runDir, 'run.json'), '{not json');
    const progress = [];

    const records = await readRunRecords(queue.tasks, {
      concurrency: 2,
      onProgress: (update) => progress.push(update.done),
    });

    expect(records['run-0']).toBeTruthy();
    expect(records['run-1']).toBeUndefined();
    expect(records['node-1']).toBeUndefined();
    expect(records['run-2']).toBeTruthy();
    expect(progress).toEqual([1, 2, 3]);
  });

  it('keeps the caller\'s node-id collision rule', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 2);
    const tasks = [
      { nodeId: 'same', runId: 'first', runDir: queue.tasks[0].runDir },
      { nodeId: 'same', runId: 'second', runDir: queue.tasks[1].runDir },
    ];

    const overwrite = await readRunRecords(tasks);
    expect(overwrite.same.id).toBe('run-1');

    const first = await readRunRecords(tasks, { nodeIdPolicy: 'first' });
    expect(first.same.id).toBe('run-0');
  });
});

describe('report cube cache', () => {
  it('reuses parsed volumes across reports and reparses only when the file identity changes', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 1, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    const cache = createCubeCache();
    let cubeReads = 0;
    const fsApi = {
      readdir: fs.readdir,
      stat: fs.stat,
      readFile: async (file, encoding) => {
        if (/\.cube$/i.test(String(file))) cubeReads += 1;
        return fs.readFile(file, encoding);
      },
    };

    const first = await cubeVolumesFor(queue, { cache, fsApi });
    expect(cubeReads).toBe(1);
    expect(cache.stats).toMatchObject({ hits: 0, misses: 1, size: 1 });
    expect(first['node-0'].values.length).toBeGreaterThan(0);

    const second = await cubeVolumesFor(queue, { cache, fsApi });
    expect(cubeReads).toBe(1);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1 });
    // The same parsed arrays, not a copy: the second report reused the cache.
    expect(second['node-0'].values).toBe(first['node-0'].values);

    // A different file at the same path has a different size (and mtime), so
    // the key changes and the volume is parsed again.
    await fs.copyFile(path.join(FIXTURES, 'multiwfn', 'elf.cube'), path.join(queue.tasks[0].runDir, 'field.cube'));
    const third = await cubeVolumesFor(queue, { cache, fsApi });
    expect(cubeReads).toBe(2);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 2 });
    expect(third['node-0'].values.length).not.toBe(first['node-0'].values.length);
  });

  it('coalesces concurrent requests for the same file and evicts beyond its bound', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 1, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    const cache = createCubeCache({ maxEntries: 1 });
    const fsApi = {
      readdir: fs.readdir,
      stat: fs.stat,
      readFile: async (file, encoding) => {
        // Hold the first parse open long enough for the second caller to join it.
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        return fs.readFile(file, encoding);
      },
    };
    const [a, b] = await Promise.all([
      cubeVolumesFor(queue, { cache, fsApi }),
      cubeVolumesFor(queue, { cache, fsApi }),
    ]);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.coalesced).toBe(1);
    expect(a['node-0'].values).toBe(b['node-0'].values);

    const otherRoot = await scratch();
    const other = await queueWithRuns(otherRoot, 1, { cube: path.join(FIXTURES, 'multiwfn', 'elf.cube') });
    await cubeVolumesFor(other, { cache });
    expect(cache.stats.size).toBe(1);
    expect(cache.stats.evictions).toBeGreaterThan(0);
  });

  it('serves a second build of the same queue from the process-wide cache', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 2, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    defaultCubeCache.clear();
    try {
      const first = await loadReportInputs(queue, 'surfaces');
      expect(defaultCubeCache.stats.misses).toBe(2);
      const second = await loadReportInputs(queue, 'surfaces');
      expect(defaultCubeCache.stats).toMatchObject({ hits: 2, misses: 2 });
      expect(second.figures.volumes['node-0'].values).toBe(first.figures.volumes['node-0'].values);
      expect(second.figures.surfaces['node-0'].iso).toBe(first.figures.surfaces['node-0'].iso);
    } finally {
      defaultCubeCache.clear();
    }
  });
});

describe('report figure inputs and progress', () => {
  it('reads no cube, scans no run folder and stats nothing for figures none', async () => {
    const calls = [];
    const fsApi = {
      readFile: async (file) => {
        calls.push(String(file));
        if (/\.cube$/i.test(String(file))) throw new Error('a cube must not be read for figures none');
        return JSON.stringify(recordFor('run-0'));
      },
      readdir: async () => { throw new Error('a run folder must not be scanned for figures none'); },
      stat: async () => { throw new Error('a cube must not be stat-ed for figures none'); },
    };
    const queue = { id: 'q-none', tasks: [{ nodeId: 'node-0', runId: 'run-0', runDir: '/not/read' }] };

    const before = calls.length;
    const figures = await figureInputsFor(queue, 'none', { fsApi });
    expect(figures).toEqual({ level: 'none', volumes: null, surfaces: null });
    expect(calls).toHaveLength(before);

    const inputs = await loadReportInputs(queue, 'none', { fsApi });
    expect(inputs.figures).toEqual({ level: 'none', volumes: null, surfaces: null });
    expect(inputs.records['run-0'].id).toBe('run-0');
    expect(calls.some((file) => /\.cube$/i.test(file))).toBe(false);
  });

  it('keeps the window\'s basic report free of cube reads', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 2, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    const calls = [];
    const fsApi = {
      readdir: async (...args) => { calls.push(args); return fs.readdir(...args); },
      stat: fs.stat,
      readFile: fs.readFile,
    };

    const inputs = await loadReportInputs(queue, 'basic', { fsApi, loadCubeFigures: false });

    expect(calls).toHaveLength(0);
    expect(inputs.figures).toEqual({ level: 'basic', volumes: null, surfaces: null });
  });

  it('reports records, cubes and surfaces in order with a monotonic fraction', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 2, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    const events = [];
    const inputs = await loadReportInputs(queue, 'surfaces', {
      cache: createCubeCache(),
      onProgress: (update) => events.push(update),
    });

    expect(inputs.figures.level).toBe('surfaces');
    expect(Object.keys(inputs.figures.volumes)).toEqual(['node-0', 'node-1']);
    const phases = new Set(events.map((event) => event.phase));
    expect(phases.has('records')).toBe(true);
    expect(phases.has('cubes')).toBe(true);
    expect(phases.has('surfaces')).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: 'done', fraction: 1 });
    const fractions = events.map((event) => event.fraction);
    expect(fractions.every((value, index) => index === 0 || value >= fractions[index - 1])).toBe(true);
    expect(fractions.every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});

describe('loaded inputs produce the same HTML as the serial path', () => {
  it('matches the serial record/cube loader byte for byte at a fixed generatedAt', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 2, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    const generatedAt = '2026-11-08T12:11:00.000Z';

    // The shape the pre-#372 serial loop built, kept here as the oracle.
    const legacyRecords = {};
    const legacyVolumes = {};
    for (const task of queue.tasks) {
      const record = JSON.parse(await fs.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
      legacyRecords[task.runId] = record;
      legacyRecords[task.nodeId] = record;
      const entries = await fs.readdir(task.runDir, { withFileTypes: true });
      const cube = entries.find((entry) => entry.isFile() && /\.cube$/i.test(entry.name));
      if (!cube) continue;
      const parsed = parseCube(await fs.readFile(path.join(task.runDir, cube.name), 'utf8'));
      const axisAligned = parsed.axes.every((vector, index) => vector
        .every((component, componentIndex) => (componentIndex === index ? true : Math.abs(component) < 1e-6)));
      legacyVolumes[task.nodeId] = {
        values: parsed.values,
        origin: parsed.origin,
        step: parsed.spacing,
        counts: parsed.dims,
        min: parsed.stats?.min ?? 0,
        max: parsed.stats?.max ?? 0,
        axisAligned,
        source: cube.name,
      };
    }
    const legacySurfaces = await surfacesFor(legacyVolumes);

    const inputs = await loadReportInputs(queue, 'surfaces', { cache: createCubeCache() });
    const options = { generatedAt, appVersion: '0.5.1', figureLevel: 'surfaces' };
    const current = buildWorkflowReport(queue, inputs.records, {
      ...options,
      volumes: inputs.figures.volumes,
      surfaces: inputs.figures.surfaces,
    });
    const legacy = buildWorkflowReport(queue, legacyRecords, {
      ...options,
      volumes: legacyVolumes,
      surfaces: legacySurfaces,
    });

    expect(typeof current.then).toBe('undefined');
    expect(workflowReportHtml(current)).toBe(workflowReportHtml(legacy));
  });

  it('matches the window basic document, which never read a cube', async () => {
    const root = await scratch();
    const queue = await queueWithRuns(root, 1, { cube: path.join(FIXTURES, 'esp', 'he-ESP.cube') });
    const generatedAt = '2026-11-08T12:11:00.000Z';
    const legacyRecords = {};
    for (const task of queue.tasks) {
      const record = JSON.parse(await fs.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
      legacyRecords[task.runId] = record;
      legacyRecords[task.nodeId] = record;
    }
    const options = { generatedAt, appVersion: '0.5.1', figureLevel: 'basic' };
    const legacy = buildWorkflowReport(queue, legacyRecords, {
      ...options,
      volumes: null,
      surfaces: null,
    });
    const inputs = await loadReportInputs(queue, 'basic', { loadCubeFigures: false });
    const current = buildWorkflowReport(queue, inputs.records, {
      ...options,
      figureLevel: inputs.figures.level,
      volumes: inputs.figures.volumes,
      surfaces: inputs.figures.surfaces,
    });

    expect(workflowReportHtml(current)).toBe(workflowReportHtml(legacy));
  });
});
