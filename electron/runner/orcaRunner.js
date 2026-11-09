import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Spawn one ORCA process and capture its result.
 *
 * ORCA differs from Gaussian in a way that matters to a runner: it writes its
 * log to **stdout**, and leaves the science in side files (`<job>.gbw`,
 * `<job>.xyz`, `<job>.hess`, `<job>_trj.xyz`). So the artifact this runner hands
 * the parser is the captured stream, written to the run's output name, exactly
 * as the user would have got with `orca job.inp > job.out`.
 *
 * Two things this runner deliberately does not do:
 *
 * - It does not trust the exit code. ORCA can exit 0 after an error banner (a
 *   missing module binary is the classic case), so the caller classifies the
 *   text; this class only records what the process did.
 * - It does not merge stderr into the artifact. The `.out` file is what a user
 *   may reopen in an ORCA-aware tool, and driver chatter does not belong in it.
 *   stderr comes back separately so the run record can quote it when there is
 *   nothing else to quote.
 */
export class OrcaRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
  }

  /**
   * ORCA's parallel driver must be started by its full path: a bare `orca`
   * resolves through PATH to the serial driver on most installs. The builder and
   * preflight already warn; this keeps the reason next to the code that spawns.
   */
  static driverIsAbsolute(executable) {
    const text = String(executable || '');
    return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text);
  }

  /** Side files ORCA writes next to the input; recorded so a run can be reopened. */
  static artifactNamesFor(inputName) {
    const base = String(inputName || '').replace(/\.inp$/i, '');
    return [`${base}.gbw`, `${base}.xyz`, `${base}.hess`, `${base}_trj.xyz`, `${base}.property.txt`];
  }

  async run({
    executable,
    argv = [],
    cwd,
    outputName,
    onOutput = () => {},
    timeoutMs = 0,
  }) {
    const args = Array.isArray(argv) && argv.length > 0 ? argv.map(String) : [];
    if (args.length === 0) throw new Error('ORCA run has no arguments.');
    if (!executable) throw new Error('ORCA run has no executable.');

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, args, treeSpawnOptions({
      cwd,
      // ORCA's driver is a script that starts the real modules as children. The
      // group is what lets cancellation stop the whole tree (issue 177).
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

    const target = path.join(cwd, outputName);
    await fsp.writeFile(target, stdout, 'utf8');
    const stat = await fsp.stat(target).catch(() => null);

    // Which side files the binary actually produced. A missing `.gbw` on a job
    // that should have written one is worth seeing in the record rather than
    // discovered later by a checkpoint hand-off that cannot find it.
    const artifacts = [];
    for (const name of OrcaRunner.artifactNamesFor(path.basename(args[0]))) {
      const info = await fsp.stat(path.join(cwd, name)).catch(() => null);
      if (info?.isFile()) artifacts.push({ file: name, bytes: info.size });
    }

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
      artifacts,
      driverAbsolute: OrcaRunner.driverIsAbsolute(executable),
    };
  }

  cancel() {
    const child = this.child;
    if (!child) return undefined;
    this.cancelled = true;
    return terminateTree(child);
  }
}
