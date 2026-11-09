import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseCrestEnergies } from '../../src/shared/conformers.js';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ENSEMBLE_BYTES = 64 * 1024 * 1024;
// `crest.energies` is one short line per conformer; 4 MiB is thousands of
// times more than a real ensemble needs and still bounds an accidental read.
const MAX_ENERGIES_BYTES = 4 * 1024 * 1024;

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
    this.timedOut = false;
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

    this.timedOut = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, args, treeSpawnOptions({
      cwd,
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

    if (timeoutMs > 0) {
      // Issue 177: a conformer search that hangs holds a queue slot exactly like
      // a hung calculation. The limit is a wall clock, and reaching it is its
      // own outcome — not a cancellation the user asked for.
      timeout = setTimeout(() => {
        this.timedOut = true;
        this.cancel();
      }, timeoutMs);
    }

    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });

    const outputText = stderr.trim() ? `${stdout}\n${stderr}` : stdout;
    await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');

    // A killed search left a partial ensemble behind. Reading it would rank
    // frames the search never finished, so a timed-out run reports no ensemble.
    const ensemble = this.timedOut ? {} : await CrestRunner.readEnsemble(cwd);
    return {
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: this.cancelled,
      timedOut: this.timedOut,
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
      energies = parseCrestEnergies(await fsp.readFile(path.join(directory, 'crest.energies'), 'utf8'));
    } catch {
      // An ensemble whose comment lines carry the energy is still usable.
      energies = [];
    }
    return { ensembleText: text, energies, ensemblePath };
  }

  /**
   * Read an ensemble produced elsewhere. The path is user-chosen, so bound it.
   *
   * CREST writes its energies to `crest.energies` beside `crest_conformers.xyz`,
   * so an imported ensemble is read the same way (#103): frames whose comment is
   * a label or an index still rank, because the sibling energies file supplies
   * what the comment does not. `<stem>.energies` covers an ensemble that was
   * renamed on export (`run7.xyz` + `run7.energies`). A frame comment that does
   * carry an energy still wins: `withEnergies()` prefers it.
   */
  static async readImport(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`The imported ensemble "${resolved}" does not exist.`);
    if (stat.size > MAX_ENSEMBLE_BYTES) {
      throw new Error(`The imported ensemble is ${(stat.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_ENSEMBLE_BYTES / (1024 * 1024)} MB.`);
    }
    return {
      ensembleText: await fsp.readFile(resolved, 'utf8'),
      energies: await CrestRunner.readEnergiesBeside(resolved),
      ensemblePath: resolved,
    };
  }

  /**
   * The energy list that belongs to an ensemble file: `crest.energies` in the
   * same folder, then `<stem>.energies`. A missing or unusable file is `[]` —
   * the ensemble may still carry an energy in every frame comment.
   */
  static async readEnergiesBeside(ensemblePath) {
    const directory = path.dirname(ensemblePath);
    const stem = path.basename(ensemblePath, path.extname(ensemblePath));
    const candidates = [...new Set([
      path.join(directory, 'crest.energies'),
      path.join(directory, `${stem}.energies`),
    ])];
    for (const candidate of candidates) {
      let text;
      try {
        const stat = await fsp.stat(candidate);
        if (!stat.isFile() || stat.size > MAX_ENERGIES_BYTES) continue;
        text = await fsp.readFile(candidate, 'utf8');
      } catch {
        continue;
      }
      const energies = parseCrestEnergies(text);
      if (energies.length > 0) return energies;
    }
    return [];
  }

  cancel() {
    const child = this.child;
    if (!child) return undefined;
    this.cancelled = true;
    // Issue 177: CREST forks its own workers; the whole tree has to stop.
    return terminateTree(child);
  }
}
