import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `ncs record import` followed by `ncs report` is the whole promise of #131: a
 * number another program computed, in the same machine-readable place as a run,
 * never mistakable for one. The record is written under runs/, which belongs to
 * no queue — a report that only read queues/ silently dropped it.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'ncs.js');
const SOURCE = path.join(ROOT, 'test', 'fixtures', 'imported', 'spartan-wb97xd3.json');

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ncs-imported-report-'));
  tempDirs.push(dir);
  return dir;
}

async function importRecord(outDir, extra = []) {
  return run(process.execPath, [
    CLI, 'record', 'import',
    '--program', "Spartan '26", '--version', '26.0.1',
    '--method', 'wB97X-D3', '--basis', 'def2-TZVP',
    '--energy', '-2107.7761757', '--source', SOURCE,
    '--out', outDir, ...extra,
  ], { cwd: ROOT });
}

describe('an imported record reaches the report without a queue', () => {
  it('lists the record and withholds its number by default', async () => {
    const outDir = await tempDir();
    await importRecord(outDir);
    const target = path.join(outDir, 'report.html');
    await run(process.execPath, [CLI, 'report', outDir, '--out', target], { cwd: ROOT });

    const html = await fs.readFile(target, 'utf8');
    expect(html).toContain('imported, not run here — Spartan &#39;26 26.0.1');
    // The number is shown in the imported table — that is the whole point of
    // recording it — but never in an energy column beside computed results.
    expect(html).toContain('not reported (imported)');
    expect(html).toContain('data-field="imported-result"');
    expect(html).toContain('not included');
    expect(html).toContain('The source hash proves which file the number was read from; it does not prove the calculation.');
  });

  it('prints the number, labelled, when asked', async () => {
    const outDir = await tempDir();
    await importRecord(outDir);
    const target = path.join(outDir, 'report-imported.html');
    await run(process.execPath, [CLI, 'report', outDir, '--include-imported', '--out', target], { cwd: ROOT });

    const html = await fs.readFile(target, 'utf8');
    expect(html).toContain('2107.77617570');
    expect(html).toContain('imported, not run here');
  });

  it('still refuses a folder that holds nothing at all', async () => {
    const outDir = await tempDir();
    await expect(run(process.execPath, [CLI, 'report', outDir, '--out', path.join(outDir, 'r.html')], { cwd: ROOT }))
      .rejects.toMatchObject({ code: 2 });
  });
});
