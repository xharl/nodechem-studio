import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Spawn one Psi4 process and capture its result.
 *
 * Psi4 prints its log to stdout: `psi4 job.dat` writes nothing useful to the
 * run folder, so the captured stream is the artifact, exactly as with ORCA.
 *
 * Psi4's process behaviour differs from the other engines in three ways this
 * runner has to respect:
 *
 * - It is a Python program. A failure prints a Python traceback and still exits
 *   0 in some paths, so the exit code is recorded and never treated as the
 *   verdict — the classifier reads the text.
 * - It reads `PSIDATADIR` to find its basis sets. An installation that has not
 *   exported it fails before any science; the environment is passed through
 *   untouched so a conda-installed Psi4 keeps working, and stderr is returned
 *   separately so that failure can be quoted.
 * - It writes scratch files into the working directory (`psi4.files`,
 *   `psi4_output.dat`, `timer.dat`). They are left alone: a user may want them,
 *   and deleting files a third-party program made is not this runner's job.
 */
export class Psi4Runner {
  constructor() {
    this.child = null;
    this.cancelled = false;
  }

  /** Threads come from the environment: Psi4 reads OMP_NUM_THREADS. */
  /**
   * The child environment.
   *
   * Issue 283: Psi4 writes its integrals and DIIS files to `PSI_SCRATCH`, which
   * defaults to `/tmp`. On a laptop that is a tmpfs of a few GiB, so an 84-atom
   * job at def2-TZVP fills it and dies with `WRITE failed … No space left on
   * device` — a message that never names the real cause. The queue already
   * creates a per-run scratch folder; this is what points Psi4 at it.
   */
  static environmentFor({ threads = null, scratchDir = null, env = process.env } = {}) {
    const configured = String(threads ?? '').trim();
    let count = null;
    if (configured !== '') {
      const parsed = Number(configured);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 256) {
        throw new Error('Psi4 thread count must be an integer between 1 and 256.');
      }
      count = parsed;
    }
    const inherited = Number(env.OMP_NUM_THREADS);
    const resolved = count ?? (Number.isInteger(inherited) && inherited > 0 ? inherited : null);
    const scratch = String(scratchDir ?? '').trim();
    const out = resolved
      ? { ...env, OMP_NUM_THREADS: String(resolved), MKL_NUM_THREADS: String(resolved) }
      : { ...env };
    if (scratch !== '') out.PSI_SCRATCH = scratch;
    return out;
  }

  async run({
    executable,
    argv = [],
    cwd,
    outputName,
    onOutput = () => {},
    timeoutMs = 0,
    threads = null,
    scratchDir = null,
  }) {
    const args = Array.isArray(argv) && argv.length > 0 ? argv.map(String) : [];
    if (args.length === 0) throw new Error('Psi4 run has no arguments.');
    if (!executable) throw new Error('Psi4 run has no executable.');

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, args, treeSpawnOptions({
      cwd,
      env: Psi4Runner.environmentFor({ threads, scratchDir }),
      // Psi4 starts helper processes; the group is what a signal has to reach
      // (issue 177).
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
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });

    // Psi4 1.9+ writes its formatted log to `<input>.out` in the working
    // directory and may print nothing to stdout. The run folder is fresh, so a
    // non-empty file at that name is Psi4's own log — reading it is right, and
    // writing our (empty) capture over it would destroy the only record of the
    // calculation.
    const target = path.join(cwd, outputName);
    const existing = await fsp.stat(target).catch(() => null);
    let text = stdout;
    let outputSource = 'stdout';
    if (existing?.isFile() && existing.size > 0) {
      const fromFile = await fsp.readFile(target, 'utf8');
      if (fromFile.length > MAX_OUTPUT_BYTES) {
        text = fromFile.slice(0, MAX_OUTPUT_BYTES);
        truncated = true;
      } else {
        text = fromFile;
      }
      outputSource = 'file';
    } else {
      await fsp.writeFile(target, stdout, 'utf8');
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
    };
  }

  cancel() {
    const child = this.child;
    if (!child) return undefined;
    this.cancelled = true;
    return terminateTree(child);
  }
}
