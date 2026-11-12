import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadArtifactsManifest } from '../src/shared/report.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

/**
 * Issue #354: the workflow report prints the artifacts the workflow wrote,
 * read from the queue's `<queueDir>/artifacts/manifest.json`.
 *
 * The report is a document a reader who never saw the app can check, so these
 * tests assert the printed form (one row per manifest entry, the queue-relative
 * path, the byte count, the digest prefix, the manifest's own digest) and the
 * rules that keep it safe: no absolute path, no `<script>`, no network, and a
 * missing manifest says `not recorded` instead of printing an empty table.
 */

const roots = [];

async function scratch(prefix = 'ncs-report-artifacts-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const QUEUE = {
  id: 'q-20261112-0354',
  projectName: 'Artifacts and hashes',
  status: 'completed',
  createdAt: '2026-11-12T03:00:00.000Z',
  finishedAt: '2026-11-12T03:10:00.000Z',
  tasks: [{
    nodeId: 'out1',
    title: 'Write report',
    type: 'output',
    status: 'completed',
    gateVerdict: 'pass',
  }],
};

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Write one artifact under the queue's artifact root and return its entry. */
async function writeArtifact(root, relative, body, { kind = 'html', flowId = 'barrier' } = {}) {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  return {
    path: relative,
    sha256: sha256(body),
    bytes: Buffer.byteLength(body, 'utf8'),
    kind,
    flowId,
    generatedAt: '2026-11-12T03:09:00.000Z',
  };
}

async function writeManifest(queueDir, entries, root = path.join(queueDir, 'artifacts')) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/** A finished-looking queue folder with no artifacts written. */
async function emptyQueueDir() {
  const dir = await scratch();
  await fs.mkdir(path.join(dir, 'queue'), { recursive: true });
  return path.join(dir, 'queue');
}

function rendered(artifacts) {
  return workflowReportHtml(buildWorkflowReport(QUEUE, {}, {
    generatedAt: '2026-11-12T03:11:00.000Z',
    appVersion: '0.5.1',
    artifacts,
  }));
}

function rowCount(html) {
  return (html.match(/data-field="artifact"/g) || []).length;
}

describe('artifacts manifest loader', () => {
  it('reads the entries, the totals and the manifest digest from the queue folder', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const entries = [
      await writeArtifact(root, 'reports/barrier.html', '<html>report</html>'),
      await writeArtifact(root, 'reports/barrier.csv', 'step,E\n0,-76.4\n', { kind: 'csv' }),
      await writeArtifact(root, 'bundles/barrier.zip', 'PK\u0003\u0004', { kind: 'zip' }),
    ];
    await writeManifest(queueDir, entries);

    const manifest = await loadArtifactsManifest(queueDir);

    expect(manifest.recorded).toBe(true);
    expect(manifest.source).toBe('artifacts/manifest.json');
    expect(manifest.count).toBe(3);
    expect(manifest.totalBytes).toBe(entries.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(manifest.missingOnDisk).toBe(0);
    expect(manifest.skipped).toBe(0);
    // The digest is of the manifest file's own bytes, so it can be checked with
    // `sha256sum artifacts/manifest.json`.
    const bytes = await fs.readFile(path.join(root, 'manifest.json'));
    expect(manifest.manifestSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(manifest.manifestBytes).toBe(bytes.length);
    // Paths are made relative to the queue folder, never absolute.
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      'artifacts/reports/barrier.html',
      'artifacts/reports/barrier.csv',
      'artifacts/bundles/barrier.zip',
    ]);
  });

  it('marks an entry whose file is gone instead of dropping it', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const entry = await writeArtifact(root, 'reports/deleted.html', 'gone soon');
    await writeManifest(queueDir, [entry]);
    await fs.rm(path.join(root, 'reports', 'deleted.html'));

    const manifest = await loadArtifactsManifest(queueDir);

    expect(manifest.recorded).toBe(true);
    expect(manifest.count).toBe(1);
    expect(manifest.missingOnDisk).toBe(1);
    expect(manifest.entries[0].missingOnDisk).toBe(true);
  });

  it('refuses a path that leaves the artifact root and counts it', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const good = await writeArtifact(root, 'reports/kept.html', 'kept');
    await writeManifest(queueDir, [
      good,
      { path: '../../secrets.txt', sha256: 'c'.repeat(64), bytes: 12, kind: 'html', flowId: null },
      { path: '/etc/passwd', sha256: 'd'.repeat(64), bytes: 12, kind: 'html', flowId: null },
    ]);

    const manifest = await loadArtifactsManifest(queueDir);

    expect(manifest.count).toBe(1);
    expect(manifest.skipped).toBe(2);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['artifacts/reports/kept.html']);
  });

  it('reports a queue with no manifest as not recorded, with a relative reason', async () => {
    const queueDir = await emptyQueueDir();

    const manifest = await loadArtifactsManifest(queueDir);

    expect(manifest.recorded).toBe(false);
    expect(manifest.entries).toEqual([]);
    expect(manifest.reason).toContain('artifacts/manifest.json');
    expect(manifest.reason).not.toContain(queueDir);
  });

  it('treats an unreadable manifest as not recorded rather than failing the report', async () => {
    const queueDir = await emptyQueueDir();
    await writeManifest(queueDir, []);
    await fs.writeFile(path.join(queueDir, 'artifacts', 'manifest.json'), '{ this is not json', 'utf8');

    const manifest = await loadArtifactsManifest(queueDir);

    expect(manifest.recorded).toBe(false);
    expect(manifest.reason).toContain('not valid JSON');
  });

  it('reads a manifest beside `--out` and says the folder is outside the queue', async () => {
    const base = await scratch();
    const queueDir = path.join(base, 'queues', 'q-354');
    await fs.mkdir(queueDir, { recursive: true });
    const entry = await writeArtifact(base, 'reports/barrier.html', 'out');
    await writeManifest(queueDir, [entry], base);

    const manifest = await loadArtifactsManifest(queueDir, { artifactsRoot: base });

    expect(manifest.recorded).toBe(true);
    expect(manifest.outsideQueue).toBe(true);
    expect(manifest.source).toBe('manifest.json');
    expect(manifest.entries[0].path).toBe('reports/barrier.html');
  });
});

describe('artifacts section in the report', () => {
  it('renders one row per manifest entry with kind, path, bytes and a hash prefix', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const entries = [
      await writeArtifact(root, 'reports/barrier.html', '<html>report</html>'),
      await writeArtifact(root, 'reports/barrier.csv', 'step,E\n0,-76.4\n', { kind: 'csv' }),
      await writeArtifact(root, 'bundles/barrier.zip', 'PK\u0003\u0004', { kind: 'zip' }),
    ];
    await writeManifest(queueDir, entries);
    const manifest = await loadArtifactsManifest(queueDir);

    const html = rendered(manifest);
    const model = buildWorkflowReport(QUEUE, {}, { artifacts: manifest });

    expect(rowCount(html)).toBe(3);
    expect(model.artifacts.count).toBe(3);
    expect(model.artifacts.totalBytes).toBe(manifest.totalBytes);
    expect(html).toContain('Artifacts written');
    for (const entry of entries) {
      expect(html).toContain(entry.path);
      expect(html).toContain(entry.sha256.slice(0, 16));
    }
    // Kind, byte count and the queue-relative path are each printed once per row.
    expect(html).toContain('<td>csv</td>');
    expect(html).toContain(`<td class="num">${entries[0].bytes}</td>`);
    expect(html).toContain('artifacts/reports/barrier.html');
    // The manifest's own digest and size are part of the section's summary.
    expect(html).toContain(manifest.manifestSha256.slice(0, 16));
    expect(html).toContain(`${manifest.manifestBytes} B`);
    expect(html).toContain(`${manifest.totalBytes} B recorded`);
  });

  it('prints `not recorded` when the queue has no manifest', async () => {
    const queueDir = await emptyQueueDir();
    const manifest = await loadArtifactsManifest(queueDir);

    const html = rendered(manifest);

    expect(html).toContain('data-field="artifacts-not-recorded"');
    expect(html).toContain('not recorded');
    expect(html).toContain('Artifacts written');
    expect(rowCount(html)).toBe(0);
    // Not an empty table: the section says the manifest was absent.
    expect(html).not.toContain('<table data-field="artifacts">');
  });

  it('does not print a manifest path that is absolute or outside the queue', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const good = await writeArtifact(root, 'reports/kept.html', 'kept');
    await writeManifest(queueDir, [
      good,
      { path: '../../secrets.txt', sha256: 'c'.repeat(64), bytes: 12, kind: 'html', flowId: null },
      { path: '/etc/passwd', sha256: 'd'.repeat(64), bytes: 12, kind: 'html', flowId: null },
    ]);
    const manifest = await loadArtifactsManifest(queueDir);

    const html = rendered(manifest);

    expect(rowCount(html)).toBe(1);
    expect(html).toContain('artifacts/reports/kept.html');
    for (const leaked of ['secrets.txt', 'passwd', '/etc/', '../../']) {
      expect(html).not.toContain(leaked);
    }
    // The count is stated; the refused names are not.
    expect(html).toContain('2 manifest entries were not printed');
  });

  it('marks a row whose file is missing on disk and still prints it', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const entry = await writeArtifact(root, 'reports/deleted.html', 'gone');
    await writeManifest(queueDir, [entry]);
    await fs.rm(path.join(root, 'reports', 'deleted.html'));
    const manifest = await loadArtifactsManifest(queueDir);

    const html = rendered(manifest);

    expect(rowCount(html)).toBe(1);
    expect(html).toContain('data-missing="true"');
    expect(html).toContain('missing on disk');
    expect(html).toContain('1 recorded file is missing on disk');
  });

  it('stays script-free, network-free and free of absolute paths', async () => {
    const queueDir = await emptyQueueDir();
    const root = path.join(queueDir, 'artifacts');
    const entries = [
      await writeArtifact(root, 'reports/barrier.html', '<html>report</html>'),
      await writeArtifact(root, 'reports/barrier.csv', 'step,E\n0,-76.4\n', { kind: 'csv' }),
      await writeArtifact(root, 'bundles/barrier.zip', 'PK\u0003\u0004', { kind: 'zip' }),
    ];
    await writeManifest(queueDir, entries);

    const html = rendered(await loadArtifactsManifest(queueDir));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain(' src=');
    // No absolute user path reaches the HTML, including the queue folder itself.
    expect(html).not.toContain(queueDir);
    expect(html).not.toContain(tmpdir());
    // Same inputs, same bytes.
    expect(rendered(await loadArtifactsManifest(queueDir))).toBe(html);
  });

  it('omits the section when the caller never asked, keeping the old document', () => {
    const html = workflowReportHtml(buildWorkflowReport(QUEUE, {}, { appVersion: '0.5.1' }));

    expect(html).not.toContain('Artifacts written');
    expect(html).not.toContain('artifacts-not-recorded');
  });
});
