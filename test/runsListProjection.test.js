/**
 * Issue #371 — `runs:list` is a summary projection, `runs:records(ids)` is the
 * only channel that reads full records, and the summary cache is validated by
 * (path, mtimeMs, size).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { rmrf } from './helpers/tempCleanup.js';

const roots = [];

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-studio-runs-list-'));
  roots.push(root);
  return root;
}

async function writeRun(root, id, record) {
  const dir = path.join(root, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return dir;
}

function recordFor(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    title: `Run ${id}`,
    engine: 'gaussian',
    status: 'completed',
    dryRun: false,
    startedAt: '2026-11-11T10:00:00.000Z',
    finishedAt: '2026-11-11T10:00:05.000Z',
    provenance: { kind: 'calculation', jobType: 'Freq' },
    gates: { overall: 'pass' },
    outputBytes: { size: 4096, bytesRead: 4096 },
    parsed: {
      termination: 'Normal termination of Gaussian',
      resources: { elapsedSeconds: 5.5 },
      // A frequency record's parsed block is the bulk of the file.
      frequencies: { modes: Array.from({ length: 200 }, (_, index) => index) },
    },
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

describe('runs:list summary projection (#371)', () => {
  it('carries the summary fields and no parsed payload', async () => {
    const root = await makeRoot();
    await writeRun(root, 'run-a', recordFor('run-a'));
    const manager = new RunManager({ runsRoot: root, emit: () => {} });

    const [summary] = await manager.list();

    expect(summary).toMatchObject({
      id: 'run-a',
      title: 'Run run-a',
      engine: 'gaussian',
      jobType: 'Freq',
      status: 'completed',
      verdict: 'pass',
      startedAt: '2026-11-11T10:00:00.000Z',
      finishedAt: '2026-11-11T10:00:05.000Z',
      elapsedSeconds: 5.5,
      hasParsed: true,
      bytes: 4096,
      dryRun: false,
    });
    expect(summary).not.toHaveProperty('parsed');
    expect(summary).not.toHaveProperty('gates');
    // The full record is still available on the explicit channel.
    const [record] = await manager.records(['run-a']);
    expect(record.parsed.frequencies.modes).toHaveLength(200);
  });

  it('reads only the requested run ids and refuses unsafe ids', async () => {
    const root = await makeRoot();
    await writeRun(root, 'run-a', recordFor('run-a'));
    await writeRun(root, 'run-b', recordFor('run-b'));
    await writeRun(root, 'run-c', recordFor('run-c'));
    const manager = new RunManager({ runsRoot: root, emit: () => {} });
    const read = vi.spyOn(fsp, 'readFile');

    const records = await manager.records(['run-a', '../run-b', 'run-c']);

    expect(records.map((record) => record.id).sort()).toEqual(['run-a', 'run-c']);
    const files = read.mock.calls.map(([file]) => path.basename(path.dirname(String(file))));
    expect(files.sort()).toEqual(['run-a', 'run-c']);
    expect(files).not.toContain('run-b');
  });

  it('serves an unchanged run from the cache without reading or parsing it again', async () => {
    const root = await makeRoot();
    await writeRun(root, 'run-a', recordFor('run-a'));
    await writeRun(root, 'run-b', recordFor('run-b'));
    const manager = new RunManager({ runsRoot: root, emit: () => {} });

    const first = await manager.list();
    expect(first).toHaveLength(2);

    const read = vi.spyOn(fsp, 'readFile');
    const parse = vi.spyOn(JSON, 'parse');
    const second = await manager.list();

    expect(second).toEqual(first);
    expect(read).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    // The cache is keyed by path and validated with stat, not by re-reading.
    expect(manager.summaryCache.size).toBe(2);
  });

  it('re-reads a record whose size changed', async () => {
    const root = await makeRoot();
    const dir = await writeRun(root, 'run-a', recordFor('run-a'));
    const manager = new RunManager({ runsRoot: root, emit: () => {} });
    expect((await manager.list())[0].status).toBe('completed');

    const changed = recordFor('run-a', {
      status: 'failed',
      error: 'the engine stopped before the SCF converged',
      gates: { overall: 'fail' },
    });
    await fsp.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(changed, null, 2)}\n`, 'utf8');

    const [summary] = await manager.list();
    expect(summary.status).toBe('failed');
    expect(summary.verdict).toBe('fail');
  });
});
