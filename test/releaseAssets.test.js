import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildReleaseAssets,
  findInstallers,
  formatChecksums,
  parseChecksums,
  verifyChecksums,
} from '../scripts/release-assets.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/release-assets.mjs', import.meta.url));

/** Independent digest, so the test does not trust the code under test. */
const digest = (content) => createHash('sha256').update(content).digest('hex');

describe('release assets', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ncs-release-assets-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function installer(name, content) {
    await writeFile(join(dir, name), content);
    return join(dir, name);
  }

  it('finds only installer artifacts, sorted by name', async () => {
    await installer('z.AppImage', 'linux');
    await installer('a.exe', 'windows');
    await writeFile(join(dir, 'notes.txt'), 'not an artifact');
    await writeFile(join(dir, 'latest.yml'), 'channel metadata');

    await expect(findInstallers(dir)).resolves.toEqual(['a.exe', 'z.AppImage']);
  });

  it('hashes file contents with SHA-256 and writes the GNU two-space format', async () => {
    await installer('a.exe', 'installer bytes');
    const result = await buildReleaseAssets(dir);

    expect(result.rows).toEqual([{ file: 'a.exe', sha256: digest('installer bytes') }]);
    await expect(readFile(join(dir, 'SHA256SUMS'), 'utf8')).resolves.toBe(
      `${digest('installer bytes')}  a.exe\n`,
    );
  });

  it('writes a SHA256SUMS file that parses back to the same rows', async () => {
    await installer('a.exe', 'windows bytes');
    await installer('b.AppImage', 'linux bytes');
    const result = await buildReleaseAssets(dir);
    const text = await readFile(join(dir, 'SHA256SUMS'), 'utf8');

    for (const line of text.trimEnd().split('\n')) {
      expect(line).toMatch(/^[0-9a-f]{64}  \S+$/);
    }
    expect(parseChecksums(text)).toEqual(result.rows);
  });

  it('prints a markdown table with a row per artifact', async () => {
    await installer('a.exe', 'one');
    await installer('b.AppImage', 'two');
    const result = await buildReleaseAssets(dir);

    expect(result.table.split('\n')).toEqual([
      '| Artifact | SHA-256 |',
      '| --- | --- |',
      `| \`a.exe\` | \`${digest('one')}\` |`,
      `| \`b.AppImage\` | \`${digest('two')}\` |`,
    ]);
  });

  it('verifies an intact directory', async () => {
    await installer('a.exe', 'one');
    await installer('b.AppImage', 'two');
    await buildReleaseAssets(dir);

    await expect(verifyChecksums(dir)).resolves.toEqual({
      checked: 2,
      failures: [],
      ok: true,
    });
  });

  it('fails verification when a file has been tampered with', async () => {
    const file = await installer('a.exe', 'original bytes');
    await buildReleaseAssets(dir);
    await writeFile(file, 'original bytes plus a payload');

    const result = await verifyChecksums(dir);

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      file: 'a.exe',
      sha256: digest('original bytes'),
      actual: digest('original bytes plus a payload'),
      reason: 'mismatch',
    });
    expect(result.failures[0].actual).not.toBe(result.failures[0].sha256);
  });

  it('fails verification when a listed file is missing', async () => {
    await installer('a.exe', 'one');
    await installer('b.AppImage', 'two');
    await buildReleaseAssets(dir);
    await unlink(join(dir, 'b.AppImage'));

    const result = await verifyChecksums(dir);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      { file: 'b.AppImage', sha256: digest('two'), actual: null, reason: 'missing' },
    ]);
  });

  it('refuses an empty directory and writes no checksum file', async () => {
    await expect(buildReleaseAssets(dir)).rejects.toThrow(/no installer artifacts/i);
    await expect(readFile(join(dir, 'SHA256SUMS'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a directory that has files but no installers', async () => {
    await writeFile(join(dir, 'notes.txt'), 'not an artifact');
    await writeFile(join(dir, 'latest.yml'), 'channel metadata');

    await expect(buildReleaseAssets(dir)).rejects.toThrow(/no installer artifacts/i);
  });

  it('reports a missing directory clearly', async () => {
    await expect(findInstallers(join(dir, 'does-not-exist'))).rejects.toThrow(
      /directory not found/i,
    );
  });

  it('parses both GNU markers and rejects malformed lines', () => {
    const hex = 'a'.repeat(64);
    expect(parseChecksums(`${hex}  app.exe\n${hex} *app.AppImage\n`)).toEqual([
      { sha256: hex, file: 'app.exe' },
      { sha256: hex, file: 'app.AppImage' },
    ]);
    expect(() => parseChecksums('not a checksum line\n')).toThrow(/GNU checksum format/);
    expect(() => parseChecksums('\n')).toThrow(/contains no checksums/);
  });

  it('formats rows deterministically', () => {
    expect(
      formatChecksums([
        { file: 'a.exe', sha256: '1'.repeat(64) },
        { file: 'b.AppImage', sha256: '2'.repeat(64) },
      ]),
    ).toBe(`${'1'.repeat(64)}  a.exe\n${'2'.repeat(64)}  b.AppImage\n`);
  });

  it('runs as a command and prints the table to stdout', async () => {
    await installer('a.exe', 'installer bytes');

    const { stdout } = await run(process.execPath, [SCRIPT, dir]);

    expect(stdout).toContain('| Artifact | SHA-256 |');
    expect(stdout).toContain(`| \`a.exe\` | \`${digest('installer bytes')}\` |`);
    await expect(readFile(join(dir, 'SHA256SUMS'), 'utf8')).resolves.toBe(
      `${digest('installer bytes')}  a.exe\n`,
    );
  });

  it('exits non-zero from --verify when a file no longer matches', async () => {
    const file = await installer('a.exe', 'original bytes');
    await run(process.execPath, [SCRIPT, dir]);
    await writeFile(file, 'changed after the checksum was written');

    const failure = await run(process.execPath, [SCRIPT, dir, '--verify']).then(
      () => null,
      (error) => error,
    );

    expect(failure).not.toBeNull();
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('a.exe: expected');
    expect(failure.stderr).toContain('failed verification');
  });

  it('exits non-zero with a clear message when the directory is empty', async () => {
    const failure = await run(process.execPath, [SCRIPT, dir]).then(
      () => null,
      (error) => error,
    );

    expect(failure).not.toBeNull();
    expect(failure.code).toBe(1);
    expect(failure.stderr).toMatch(/no installer artifacts/i);
  });
});
