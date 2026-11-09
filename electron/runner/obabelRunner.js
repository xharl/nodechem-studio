import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { terminateTree, treeSpawnOptions } from './processTree.js';
import {
  OBABEL_SCORED_OUTPUT,
  OBABEL_SEARCH_OUTPUT,
  obabelEnsembleText,
  obabelForceFieldKeyword,
  obabelScoreArgv,
  parseObabelScoredEnsemble,
  parseObabelSearchLog,
} from '../../src/shared/obabelConformers.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ENSEMBLE_BYTES = 64 * 1024 * 1024;

/**
 * Run Open Babel as the external force-field stage.
 *
 * Two invocations, because Open Babel splits the job: the genetic-algorithm
 * search writes conformers but logs only the best energy per generation, so a
 * second `--energy` pass attaches one MMFF94 energy to every frame. Both runs
 * are recorded in `obabel.log` — a search whose energies cannot be reproduced
 * from its own artifacts is not provenance.
 *
 * The runner is deliberately dumb: it spawns, reads the files Open Babel
 * wrote, and hands back text plus numbers. Parsing, ranking and pruning stay
 * in `src/shared/` where they can be tested without a process.
 */
export class ObabelRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
    this.timedOut = false;
  }

  /** `Open Babel 3.1.0 -- Feb 17 2026 -- …`, or '' when `-V` fails. */
  static async version(executable) {
    return new Promise((resolve) => {
      const child = spawn(executable, ['-V'], treeSpawnOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { text += chunk.toString('utf8'); });
      child.once('error', () => resolve(''));
      child.once('close', () => {
        const line = text.split(/\r?\n/).map((row) => row.trim()).find((row) => row.startsWith('Open Babel'));
        const version = line?.match(/Open Babel\s+([0-9][0-9A-Za-z.\-]*)/)?.[1];
        resolve(version || '');
      });
    });
  }

  async run({ executable, argv = [], cwd, outputName = 'obabel.log', ff = 'mmff94', timeoutMs = 0, onOutput = () => {} }) {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    if (args.length === 0) throw new Error('The Open Babel search has no arguments.');
    if (!executable) throw new Error('No Open Babel executable is configured; set it in the run console or choose a different generator.');

    const version = await ObabelRunner.version(executable);
    const scoredName = OBABEL_SCORED_OUTPUT;
    const search = await this.#spawnOnce({
      executable,
      argv: args,
      cwd,
      timeoutMs,
      onOutput,
      label: 'search',
    });
    let outputText = `$ obabel ${args.join(' ')}\n${search.text}\n`;

    if (search.timedOut || search.cancelled) {
      await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');
      return { ...search, outputText, ensembleText: '', energies: [], frames: [], version, log: parseObabelSearchLog(search.text) };
    }
    if (search.exitCode !== 0) {
      await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');
      return { ...search, outputText, ensembleText: '', energies: [], frames: [], version, log: parseObabelSearchLog(search.text) };
    }

    // Second pass: one MMFF94 energy per conformer, appended to its comment.
    const scoreArgv = obabelScoreArgv({ inputName: OBABEL_SEARCH_OUTPUT, outputName: scoredName, ff });
    const scoring = await this.#spawnOnce({
      executable,
      argv: scoreArgv,
      cwd,
      timeoutMs,
      onOutput,
      label: 'energy',
    });
    outputText += `$ obabel ${scoreArgv.join(' ')}\n${scoring.text}\n`;

    let ensembleText = '';
    let energies = [];
    let frames = [];
    if (!scoring.timedOut && !scoring.cancelled && scoring.exitCode === 0) {
      const scoredPath = path.join(cwd, scoredName);
      const stat = await fsp.stat(scoredPath).catch(() => null);
      if (stat && stat.size > 0 && stat.size <= MAX_ENSEMBLE_BYTES) {
        const text = await fsp.readFile(scoredPath, 'utf8');
        const parsed = parseObabelScoredEnsemble(text);
        if (parsed.errors.length === 0) {
          frames = parsed.frames;
          energies = parsed.frames.map((frame) => frame.energyKcal);
          ensembleText = obabelEnsembleText(parsed.frames, { version, ff });
        } else {
          outputText += `\nError: ${parsed.errors[0].message}\n`;
        }
      }
    }

    await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');
    return {
      exitCode: scoring.exitCode,
      signal: scoring.signal,
      cancelled: scoring.cancelled,
      timedOut: scoring.timedOut,
      truncated: search.truncated || scoring.truncated,
      outputText,
      version,
      log: parseObabelSearchLog(search.text),
      ensembleText,
      energies,
      frames,
    };
  }

  #spawnOnce({ executable, argv, cwd, timeoutMs, onOutput, label }) {
    this.timedOut = false;
    let text = '';
    let truncated = false;
    let timeout = null;

    const child = spawn(executable, argv, treeSpawnOptions({ cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    this.child = child;

    const capture = (stream) => (chunk) => {
      const chunkText = chunk.toString('utf8');
      if (text.length < MAX_OUTPUT_BYTES) {
        text += chunkText;
        if (text.length >= MAX_OUTPUT_BYTES) truncated = true;
      }
      onOutput({ stream, text: chunkText });
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));

    if (timeoutMs > 0) {
      // Issue 177: a hung search holds a queue slot exactly like a hung job.
      timeout = setTimeout(() => {
        this.timedOut = true;
        this.cancel();
      }, timeoutMs);
    }

    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({
        exitCode: code,
        signal,
        cancelled: this.cancelled,
        timedOut: this.timedOut,
        truncated,
        text,
        label,
      }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.child) terminateTree(this.child);
  }
}

export { obabelForceFieldKeyword };
