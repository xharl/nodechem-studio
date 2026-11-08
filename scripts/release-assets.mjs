#!/usr/bin/env node
/**
 * Build the verification material for a release directory.
 *
 * The 0.x line ships unsigned, so the checksum file is the only thing a
 * downloader can check without trusting the release page. Electron-builder
 * writes the installers into `release/`; this script hashes every installer
 * there, writes `SHA256SUMS` in the GNU coreutils format that `sha256sum -c`
 * reads, and prints a markdown table for the release body.
 *
 * `--verify` reads the file back and re-hashes the artifacts, which is what a
 * downloader does after fetching them. The tests exercise that path against a
 * tampered file, so the check is proven rather than assumed.
 *
 * No dependencies: node:crypto hashes, node:fs/promises reads.
 */
import { createHash } from 'node:crypto';
import { open, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECKSUMS_NAME = 'SHA256SUMS';
export const INSTALLER_EXTENSIONS = ['.exe', '.appimage'];
export const USAGE = `Usage: node scripts/release-assets.mjs [directory] [--verify]

  directory   release output directory (default: release)
  --verify    re-hash every file listed in directory/${CHECKSUMS_NAME} and exit
              non-zero if one is missing or does not match
`;

const CHUNK_SIZE = 1024 * 1024;
// GNU coreutils writes "<hex>  <name>" for text mode and "<hex> *<name>" for
// binary mode. sha256sum -c accepts either; the marker is one character wide.
const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/i;

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export function isInstaller(name) {
  const lower = name.toLowerCase();
  return INSTALLER_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Installer filenames in `dir`, sorted so the output is reproducible. */
export async function findInstallers(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new Error(`release-assets: directory not found: ${dir}`);
    }
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isFile() && isInstaller(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(
      `release-assets: no installer artifacts (*.exe, *.AppImage) in ${dir}. ` +
        'Build the installers first, or point the script at the directory that holds them.',
    );
  }
  return names;
}

export function formatChecksums(rows) {
  return `${rows.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n')}\n`;
}

export function formatMarkdownTable(rows) {
  const lines = ['| Artifact | SHA-256 |', '| --- | --- |'];
  for (const { file, sha256 } of rows) {
    lines.push(`| \`${file.replaceAll('|', '\\|')}\` | \`${sha256}\` |`);
  }
  return lines.join('\n');
}

/**
 * Hash every installer in `dir` and write `dir/SHA256SUMS`. Returns the rows
 * (name and digest) and the markdown table, so a caller can print it without
 * re-reading the file.
 */
export async function buildReleaseAssets(dir = 'release') {
  const files = await findInstallers(dir);
  const rows = [];
  for (const file of files) {
    rows.push({ file, sha256: await hashFile(join(dir, file)) });
  }
  const checksums = formatChecksums(rows);
  await writeFile(join(dir, CHECKSUMS_NAME), checksums, 'utf8');
  return { dir, rows, checksums, table: formatMarkdownTable(rows) };
}

/** Parse GNU coreutils checksum text into rows; throws on a malformed line. */
export function parseChecksums(text, source = CHECKSUMS_NAME) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') continue;
    const match = CHECKSUM_LINE.exec(line);
    if (!match) {
      throw new Error(
        `release-assets: ${source} line ${index + 1} is not in GNU checksum format: ${line}`,
      );
    }
    rows.push({ sha256: match[1].toLowerCase(), file: match[2] });
  }
  if (rows.length === 0) {
    throw new Error(`release-assets: ${source} contains no checksums`);
  }
  return rows;
}

/**
 * Re-hash each file named in `dir/SHA256SUMS`. A missing file and a changed
 * file are both failures; the caller decides how to report them.
 */
export async function verifyChecksums(dir = 'release') {
  const source = join(dir, CHECKSUMS_NAME);
  let text;
  try {
    text = await readFile(source, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `release-assets: no ${CHECKSUMS_NAME} in ${dir}; run without --verify to create it`,
      );
    }
    throw error;
  }
  const rows = parseChecksums(text, source);
  const failures = [];
  for (const row of rows) {
    let actual;
    try {
      actual = await hashFile(join(dir, row.file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      failures.push({ ...row, actual: null, reason: 'missing' });
      continue;
    }
    if (actual !== row.sha256) failures.push({ ...row, actual, reason: 'mismatch' });
  }
  return { checked: rows.length, failures, ok: failures.length === 0 };
}

export async function main(argv = process.argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--verify');
  if (unknown.length > 0) {
    throw new Error(`release-assets: unknown option ${unknown[0]}\n\n${USAGE}`);
  }
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional.length > 1) {
    throw new Error(`release-assets: expected one directory, got ${positional.join(', ')}\n\n${USAGE}`);
  }
  const dir = positional[0] || 'release';

  if (args.includes('--verify')) {
    const result = await verifyChecksums(dir);
    for (const failure of result.failures) {
      const detail =
        failure.reason === 'missing'
          ? 'missing'
          : `expected ${failure.sha256}, got ${failure.actual}`;
      console.error(`\u2717 ${failure.file}: ${detail}`);
    }
    if (!result.ok) {
      console.error(
        `release-assets: ${result.failures.length} of ${result.checked} file(s) failed verification`,
      );
      return 1;
    }
    console.error(`release-assets: ${result.checked} file(s) match ${join(dir, CHECKSUMS_NAME)}`);
    return 0;
  }

  const result = await buildReleaseAssets(dir);
  // stdout stays pure markdown so it can be pasted into a release body.
  process.stdout.write(`${result.table}\n`);
  console.error(
    `release-assets: wrote ${join(dir, CHECKSUMS_NAME)} (${result.rows.length} artifact(s))`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
