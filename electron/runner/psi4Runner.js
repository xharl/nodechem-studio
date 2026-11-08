import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

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
  static environmentFor({ threads = null, env = process.env } = {}) {
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
    return resolved
      ? { ...env, OMP_NUM_THREADS: String(resolved), MKL_NUM_THREADS: String(resolved) }
      : { ...env };
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
    if (args.length === 0) throw new Error('Psi4 run has no arguments.');
    if (!executable) throw new Error('Psi4 run has no executable.');

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, args, {
      cwd,
      env: Psi4Runner.environmentFor({ threads }),
      windowsHide: true,
      shell: false,
      // Psi4 starts helper processes; a signal to the driver alone can leave
      // them holding the pipes open, so cancellation targets the group.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

    const target = path.join(cwd, outputName);
    await fsp.writeFile(target, stdout, 'utf8');
    const stat = await fsp.stat(target).catch(() => null);

    return {
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: this.cancelled,
      outputText: stdout,
      outputName,
      outputSource: 'stdout',
      truncated,
      outputBytes: stat ? { size: stat.size, bytesRead: stat.size, truncated, windows: [] } : null,
      stderr,
    };
  }

  cancel() {
    const child = this.child;
    if (!child) return;
    this.cancelled = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    } else {
      const signal = (name) => {
        try {
          process.kill(-child.pid, name);
        } catch {
          child.kill(name);
        }
      };
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 1000).unref();
    }
  }
}
