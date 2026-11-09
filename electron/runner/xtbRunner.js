import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Spawn one xTB process and capture its result.
 *
 * xTB prints everything to stdout and writes no output file of its own, so this
 * runner persists the captured stream as the run's output artifact. The exit
 * code is recorded but never treated as a verdict — the caller classifies the
 * text as well (xTB exits 128 on any error stop).
 */
export class XtbRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
  }

  /**
   * Locate xTB's parameter directory. Release tarballs ship `bin/xtb` beside
   * `share/xtb`, and xTB resolves that itself, but an explicit XTBPATH makes a
   * relocated or packaged install work.
   */
  static parameterPathFor(executable, explicit) {
    if (explicit) return String(explicit);
    const sibling = path.join(path.dirname(executable), '..', 'share', 'xtb');
    try {
      if (fs.existsSync(sibling)) return path.resolve(sibling);
    } catch {
      // Fall through to xTB's own lookup.
    }
    return null;
  }

  /**
   * Resolve the thread count xTB should use. An explicit value from the
   * inspector wins; otherwise inherit OMP_NUM_THREADS, then fall back to one
   * deterministic thread. An invalid explicit value is an error, not a silent
   * fallback: the user asked for something xTB cannot honour.
   */
  static threadsFor(configured, environmentValue) {
    const text = String(configured ?? '').trim();
    if (text !== '') {
      const count = Number(text);
      if (!Number.isInteger(count) || count < 1 || count > 256) {
        throw new Error('xTB thread count must be an integer between 1 and 256.');
      }
      return count;
    }
    const inherited = Number(environmentValue);
    return Number.isInteger(inherited) && inherited > 0 ? inherited : 1;
  }

  /** The child environment, including the thread count mapped to OMP. */
  static environmentFor({ executable, threads = null, env = process.env } = {}) {
    const exeDir = path.dirname(executable);
    return {
      ...env,
      PATH: `${exeDir}${path.delimiter}${env.PATH || ''}`,
      OMP_NUM_THREADS: String(XtbRunner.threadsFor(threads, env.OMP_NUM_THREADS)),
    };
  }

  async run({
    executable,
    argv = [],
    cwd,
    outputName,
    onOutput = () => {},
    timeoutMs = 0,
    xtbPath = null,
    threads = null,
  }) {
    const env = XtbRunner.environmentFor({ executable, threads });
    const parameterPath = XtbRunner.parameterPathFor(executable, xtbPath);
    if (parameterPath) env.XTBPATH = parameterPath;

    const args = Array.isArray(argv) && argv.length > 0 ? argv : [];
    if (args.length === 0) throw new Error('xTB run has no arguments.');

    const runOnce = async (emitOutput) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timeout = null;

      const child = spawn(executable, args, treeSpawnOptions({
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      this.child = child;

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += text;
          if (stdout.length >= MAX_OUTPUT_BYTES) truncated = true;
        }
        emitOutput({ stream: 'stdout', text });
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += text;
        emitOutput({ stream: 'stderr', text });
      });

      if (timeoutMs > 0) {
        timeout = setTimeout(() => this.cancel(), timeoutMs);
      }

      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }).finally(() => {
        if (timeout) clearTimeout(timeout);
        this.child = null;
      });

      // stderr is merged into the artifact because xTB reports fatal errors there.
      const outputText = stderr.trim() ? `${stdout}\n${stderr}` : stdout;
      await fsp.writeFile(path.join(cwd, outputName), outputText, 'utf8');
      const stat = await fsp.stat(path.join(cwd, outputName)).catch(() => null);

      return {
        exitCode: exit.code,
        signal: exit.signal,
        cancelled: this.cancelled,
        outputText,
        outputName,
        outputSource: 'stdout',
        truncated,
        outputBytes: stat ? { size: stat.size, bytesRead: stat.size, truncated, windows: [] } : null,
        parameterPath,
      };
    };

    let result = await runOnce(onOutput);
    // xTB 6.8.0 emits "Could not read topology file" on the first GFN-FF
    // invocation in a fresh run directory after it has already written
    // gfnff_topo. A second invocation reads that topology and is clean. Keep
    // this as a setup pass so the scientific output is the clean second run;
    // a residual runtime exception is still classified as an error by the
    // parser, so this cannot hide a real failure.
    if (
      args.includes('--gfnff')
      && !result.cancelled
      && /gfnff_setup:\s*Could not read topology file/i.test(result.outputText)
      && fs.existsSync(path.join(cwd, 'gfnff_topo'))
    ) {
      result = await runOnce(() => {});
    }
    return result;
  }

  cancel() {
    const child = this.child;
    if (!child) return undefined;
    this.cancelled = true;
    // Issue 177: same whole-tree discipline as every other engine — xTB can
    // leave its parameter helper running if only the direct child is signalled.
    return terminateTree(child);
  }
}
