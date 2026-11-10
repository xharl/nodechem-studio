/**
 * The Multiwfn sidecar runner (issue #270).
 *
 * Multiwfn is a separately installed program, not an engine this app bundles.
 * The runner makes one batch invocation:
 *
 *     Multiwfn <wavefunction> -silent < menu.in > multiwfn.out
 *
 * The menu script is written to `multiwfn.in` and echoed into the run record,
 * so a reader can reproduce the exact prompts. `-silent` is the documented way
 * to keep Multiwfn out of its GUI; no window is ever opened.
 *
 * The runner is deliberately dumb: it spawns, captures text, finds the side
 * files the recipe asks for, and hands them back. Parsing and normalisation stay
 * in `src/shared/multiwfn.js`, where they are tested without a process.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { terminateTree, treeSpawnOptions } from './processTree.js';
import { multiwfnArgv } from '../../src/shared/multiwfn.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_SIDE_FILE_BYTES = 64 * 1024 * 1024;

/** The banner line Multiwfn prints, parsed without assuming the rest of it. */
export function multiwfnVersionFromText(text) {
  const source = String(text ?? '');
  const labelled = /Multiwfn\s*--\s*A Multifunctional Wavefunction Analyzer[\s\S]{0,400}?Version\s+([0-9][0-9A-Za-z.()\-]*)/i.exec(source);
  if (labelled) return labelled[1];
  const version = /\bVersion\s+([0-9][0-9A-Za-z.()\-]*)/i.exec(source);
  return version ? version[1] : '';
}

export class MultiwfnRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
    this.timedOut = false;
  }

  /**
   * Ask the binary for its banner. Multiwfn has no `--version` flag; started
   * with no input file it prints the banner and then asks for one, so `q` on
   * stdin ends it. A binary that cannot answer returns `''`, which the queue
   * turns into a named version refusal rather than a guess.
   */
  static async version(executable) {
    if (!executable) return '';
    return new Promise((resolve) => {
      let text = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(executable, [], treeSpawnOptions({ stdio: ['pipe', 'pipe', 'pipe'] }));
      } catch {
        finish('');
        return;
      }
      const timer = setTimeout(() => {
        try { terminateTree(child); } catch { /* already gone */ }
        finish(multiwfnVersionFromText(text));
      }, 8000);
      const capture = (chunk) => { text += chunk.toString('utf8'); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('error', () => {
        clearTimeout(timer);
        finish('');
      });
      child.once('close', () => {
        clearTimeout(timer);
        finish(multiwfnVersionFromText(text));
      });
      try {
        child.stdin.on('error', () => { /* the binary may exit before reading stdin */ });
        child.stdin.end('q\n');
      } catch {
        // The binary may have exited before stdin was ready; `close` decides.
      }
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.child) {
      try { terminateTree(this.child); } catch { /* already gone */ }
    }
  }

  /**
   * Run one analysis. `cwd` is the task's own run folder — the temporary
   * workdir — so concurrent analyses never share `output.txt` or `func1.cub`.
   */
  async run({
    executable,
    inputName,
    script,
    cwd,
    threads = null,
    timeoutMs = 0,
    onOutput = () => {},
  }) {
    if (!executable) {
      throw new Error('No Multiwfn executable is configured. Multiwfn is user-installed; '
        + 'choose its binary in the run console before queuing a Multiwfn analysis.');
    }
    if (!inputName) throw new Error('The Multiwfn task names no wavefunction input.');
    if (!script?.text) throw new Error('The Multiwfn task has no menu script.');
    await fsp.mkdir(cwd, { recursive: true });
    const scriptName = 'multiwfn.in';
    const outputName = 'multiwfn.out';
    // A retried task reuses its folder. Remove side files a previous attempt
    // could have left so `#collectFiles` cannot mistake them for this run's
    // output. Only Multiwfn's own `func*.cub` names are removed: a user's
    // `water.cube` input is not touched.
    for (const name of await fsp.readdir(cwd).catch(() => [])) {
      if (['cpprop.txt', 'output.txt', 'multiwfn.err', outputName].includes(name.toLowerCase())
        || /^func\d*\.(cub|cube)$/i.test(name)) {
        await fsp.rm(path.join(cwd, name), { force: true, recursive: false }).catch(() => {});
      }
    }
    await fsp.writeFile(path.join(cwd, scriptName), script.text, 'utf8');
    const before = await this.#snapshot(cwd);
    const argv = multiwfnArgv({ inputName, threads });
    let text = '';
    let stderr = '';
    let truncated = false;
    this.cancelled = false;
    this.timedOut = false;

    const child = spawn(executable, argv, treeSpawnOptions({ cwd, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.child = child;
    child.stdin.on('error', () => { /* exit before stdin is read is the program's choice */ });
    child.stdin.end(script.text);
    let timeout = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        this.timedOut = true;
        try { terminateTree(child); } catch { /* already gone */ }
      }, timeoutMs);
    }
    const capture = (chunk, isError = false) => {
      const piece = chunk.toString('utf8');
      onOutput({ stream: isError ? 'stderr' : 'stdout', text: piece });
      if (text.length < MAX_OUTPUT_BYTES) {
        text += piece;
        if (text.length >= MAX_OUTPUT_BYTES) truncated = true;
      }
      if (isError) stderr += piece;
    };
    child.stdout.on('data', (chunk) => capture(chunk, false));
    child.stderr.on('data', (chunk) => capture(chunk, true));

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });

    const header = `$ ${path.basename(executable)} ${argv.join(' ')}\n`
      + `# stdin: ${scriptName} (Multiwfn ${script.version} menu script)\n`;
    const outputText = `${header}${text}`;
    await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');
    if (stderr.trim()) await fsp.writeFile(path.join(cwd, 'multiwfn.err'), stderr, 'utf8');

    const files = await this.#collectFiles(cwd, before);
    return {
      ...result,
      cancelled: this.cancelled,
      timedOut: this.timedOut,
      truncated,
      outputText,
      stderr,
      version: multiwfnVersionFromText(text),
      argv,
      script,
      scriptName,
      outputName,
      files,
    };
  }

  async #snapshot(dir) {
    try {
      return new Set(await fsp.readdir(dir));
    } catch {
      return new Set();
    }
  }

  /**
   * The side files the recipe can have written: `CPprop.txt`, `output.txt` and
   * a cube (Multiwfn's default `func1.cub`). Only files that appeared during
   * this run are read, and each read is bounded.
   */
  async #collectFiles(dir, before) {
    const files = {};
    let names = [];
    try {
      names = (await fsp.readdir(dir)).filter((name) => !before.has(name)).sort();
    } catch {
      return files;
    }
    for (const name of names) {
      const target = path.join(dir, name);
      const lower = name.toLowerCase();
      const isCube = lower.endsWith('.cub') || lower.endsWith('.cube');
      if (lower !== 'cpprop.txt' && lower !== 'output.txt' && !isCube) continue;
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_SIDE_FILE_BYTES) continue;
      const content = await fsp.readFile(target, 'utf8').catch(() => '');
      if (lower === 'cpprop.txt') files.cpProp = content;
      else if (lower === 'output.txt') files.nciOutput = content;
      else if (isCube && !files.cubeText) {
        files.cubeText = content;
        files.cubeName = name;
        files.cubePath = target;
      }
    }
    return files;
  }
}
