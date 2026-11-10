import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const RECORD_BEGIN = 'NCS-PYSCF-RESULT-BEGIN';
const RECORD_END = 'NCS-PYSCF-RESULT-END';

/**
 * Spawn one PySCF deck and capture its result.
 *
 * The executable is a **Python interpreter** (`python3`, `python`, a
 * version-suffixed name) or a `pyscf-runner` wrapper; either way the deck path
 * is argv[0], exactly as it is written in the built input. The deck prints a
 * JSON record between markers and also writes `<deck-stem>.json` beside itself.
 * Both are returned: `outputText` is what the run folder keeps as the `.out`
 * artifact, and `recordText` is handed to the parser so a large or truncated
 * stdout capture cannot lose the result.
 *
 * A Python that cannot import pyscf fails inside the deck, which catches the
 * exception and writes an error record; a Python that cannot start at all
 * surfaces as a spawn error. Neither is reported as `unknown`.
 */
export class PyscfRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
  }

  /**
   * Threads come from the environment: PySCF uses BLAS/OpenMP, and the deck
   * itself sets no thread count. `nproc` on the block is the app's thread
   * setting, as it is for Psi4.
   */
  static environmentFor({ threads = null, env = process.env } = {}) {
    const configured = String(threads ?? '').trim();
    let count = null;
    if (configured !== '') {
      const parsed = Number(configured);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 256) {
        throw new Error('PySCF thread count must be an integer between 1 and 256.');
      }
      count = parsed;
    }
    const inherited = Number(env.OMP_NUM_THREADS);
    const resolved = count ?? (Number.isInteger(inherited) && inherited > 0 ? inherited : null);
    const next = {
      ...env,
      // Keep the record arriving as it is written, not at interpreter exit.
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    if (resolved) {
      for (const key of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) {
        next[key] = String(resolved);
      }
    }
    return next;
  }

  async run({
    executable,
    argv = [],
    cwd,
    outputName,
    onOutput = () => {},
    timeoutMs = 0,
    threads = null,
  }) {
    const args = Array.isArray(argv) && argv.length > 0 ? argv.map(String) : [];
    if (args.length === 0) throw new Error('PySCF run has no arguments (the deck path is argv[0]).');
    if (!executable) throw new Error('PySCF run has no executable.');

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, args, treeSpawnOptions({
      cwd,
      env: PyscfRunner.environmentFor({ threads }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    this.child = child;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += text;
        if (stdout.length >= MAX_OUTPUT_BYTES) truncated = true;
      }
      onOutput({ stream: 'stdout', text });
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += text;
      onOutput({ stream: 'stderr', text });
    });

    if (timeoutMs > 0) timeout = setTimeout(() => this.cancel(), timeoutMs);

    const exit = await new Promise((resolve, reject) => {
      child.once('error', (error) => {
        const hint = error.code === 'ENOENT'
          ? `PySCF could not start ${executable}: the executable was not found.`
          : `PySCF could not start ${executable}: ${error.message}`;
        reject(new Error(hint));
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });

    // The deck names its record after itself (`<stem>.json`). Read it even when
    // stdout already carries the markers: it is the full record, and a capture
    // truncated at 32 MiB still leaves a parseable file.
    const deckName = args.find((argument) => /\.py$/i.test(argument)) || args[0];
    const recordFile = deckName ? `${deckName.replace(/\.py$/i, '')}.json` : null;
    let recordText = '';
    if (recordFile) {
      const absolute = path.join(cwd, recordFile);
      const stat = await fsp.stat(absolute).catch(() => null);
      if (stat?.isFile() && stat.size > 0 && stat.size <= MAX_OUTPUT_BYTES) {
        recordText = await fsp.readFile(absolute, 'utf8').catch(() => '');
      }
    }

    let text = stdout;
    // A capture that lost the markers (truncated head, a wrapper that swallowed
    // stdout) is completed from the file, so the artifact and the parser agree.
    if (recordText && !text.includes(RECORD_BEGIN)) {
      text += `\n${RECORD_BEGIN}\n${recordText.trim()}\n${RECORD_END}\n`;
    }
    if (text.length > MAX_OUTPUT_BYTES) {
      text = text.slice(0, MAX_OUTPUT_BYTES);
      truncated = true;
    }

    const target = path.join(cwd, outputName);
    const existing = await fsp.stat(target).catch(() => null);
    let outputSource = 'stdout';
    if (existing?.isFile() && existing.size > 0) {
      // A wrapper may have written the log itself. Never overwrite a non-empty
      // file a third-party program left in the fresh run folder.
      const fromFile = await fsp.readFile(target, 'utf8');
      if (!text.trim() || fromFile.length >= text.length) {
        text = fromFile.length > MAX_OUTPUT_BYTES ? fromFile.slice(0, MAX_OUTPUT_BYTES) : fromFile;
        truncated = truncated || fromFile.length > MAX_OUTPUT_BYTES;
        outputSource = 'file';
      }
    } else {
      await fsp.writeFile(target, text, 'utf8');
    }
    const stat = await fsp.stat(target).catch(() => null);

    return {
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: this.cancelled,
      outputText: text,
      outputName,
      outputSource,
      truncated,
      outputBytes: stat
        ? { size: stat.size, bytesRead: Math.min(stat.size, text.length), truncated, windows: [] }
        : null,
      stderr,
      recordText: recordText || null,
      recordFile,
    };
  }

  cancel() {
    const child = this.child;
    if (!child) return undefined;
    this.cancelled = true;
    return terminateTree(child);
  }
}
