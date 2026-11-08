import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ENSEMBLE_BYTES = 64 * 1024 * 1024;

/**
 * Run one conformer search, or read an ensemble somebody else generated.
 *
 * CREST is an external program like Gaussian and xTB: it is never bundled, it
 * is invoked with an argument array and no shell, and its absence is a clear
 * failure rather than a silent fallback to a fabricated ensemble. The runner
 * returns the *text* of the ensemble it found; ranking and pruning live in
 * `src/shared/conformers.js` so they are testable without a process.
 */
export class CrestRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
  }

  async run({
    executable,
    argv = [],
    cwd,
    outputName = 'crest.out',
    onOutput = () => {},
    timeoutMs = 0,
  }) {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    if (args.length === 0) throw new Error('The conformer search has no arguments.');
    if (!executable) throw new Error('No CREST executable is configured; set it in the block or in Preferences.');

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
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

    const outputText = stderr.trim() ? `${stdout}\n${stderr}` : stdout;
    await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');

    const ensemble = await CrestRunner.readEnsemble(cwd);
    return {
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: this.cancelled,
      outputText,
      outputName,
      truncated,
      ...ensemble,
    };
  }

  /**
   * Locate and read what CREST wrote. `crest_conformers.xyz` is the ensemble;
   * `crest.energies` is the energy list, one per conformer. A missing ensemble
   * is an error even when the process exited 0 — a silent empty list would let
   * the block report "0 conformers" as if that were an answer.
   */
  static async readEnsemble(directory) {
    const ensemblePath = path.join(directory, 'crest_conformers.xyz');
    let text;
    try {
      const stat = await fsp.stat(ensemblePath);
      if (stat.size > MAX_ENSEMBLE_BYTES) {
        throw new Error(`The conformer ensemble is ${(stat.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_ENSEMBLE_BYTES / (1024 * 1024)} MB.`);
      }
      text = await fsp.readFile(ensemblePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('The conformer search finished without writing crest_conformers.xyz; there is no ensemble to rank.');
      }
      throw error;
    }
    let energies = [];
    try {
      energies = (await fsp.readFile(path.join(directory, 'crest.energies'), 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => Number.parseFloat(line.split(/\s+/).pop()));
    } catch {
      // An ensemble whose comment lines carry the energy is still usable.
      energies = [];
    }
    return { ensembleText: text, energies, ensemblePath };
  }

  /** Read an ensemble produced elsewhere. The path is user-chosen, so bound it. */
  static async readImport(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`The imported ensemble "${resolved}" does not exist.`);
    if (stat.size > MAX_ENSEMBLE_BYTES) {
      throw new Error(`The imported ensemble is ${(stat.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_ENSEMBLE_BYTES / (1024 * 1024)} MB.`);
    }
    return { ensembleText: await fsp.readFile(resolved, 'utf8'), energies: [], ensemblePath: resolved };
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
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000).unref();
    }
  }
}
