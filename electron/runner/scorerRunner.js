import { spawn } from 'node:child_process';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * ADR 0001 §2.10 — spawn the optional scorer sidecar.
 *
 * Contract: the executable is called with `--model <id>` and reads one JSON
 * object from stdin:
 *
 *   { model, charge, multiplicity, frames: [{ id, atoms: [{element,x,y,z}] }] }
 *
 * It writes one JSON object to stdout with provenance and `results[]`; see
 * `normalizeScorerResult()` for the required fields. Nothing is parsed from a
 * log, because a scorer has no canonical log.
 */
export class ScorerRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
    this.timedOut = false;
  }

  async score({ executable, model, charge, multiplicity, frames, timeoutMs = 0, cwd = '', onOutput = () => {} }) {
    if (!executable) throw new Error('No scorer executable is configured; set the ML scorer in the run console.');
    if (!model || !Array.isArray(frames) || frames.length === 0) {
      throw new Error('The scorer request needs a model and at least one structure.');
    }
    const payload = JSON.stringify({
      model,
      charge,
      multiplicity,
      frames: frames.map((frame) => ({
        id: String(frame.id),
        atoms: frame.atoms.map((atom) => ({
          element: atom.element,
          x: atom.x,
          y: atom.y,
          z: atom.z,
        })),
      })),
    });
    const args = ['--model', String(model)];
    this.cancelled = false;
    this.timedOut = false;
    let text = '';
    let truncated = false;
    const child = spawn(executable, args, treeSpawnOptions({ cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }));
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
    child.stdin.on('error', () => {});
    child.stdin.end(payload);

    let timeout = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        this.timedOut = true;
        this.cancel();
      }, timeoutMs);
    }
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({
        exitCode: code,
        signal,
        cancelled: this.cancelled,
        timedOut: this.timedOut,
        truncated,
        text,
      }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });
    if (result.timedOut) throw new Error('The scorer was stopped by its wall-clock limit.');
    if (result.cancelled) throw new Error('The scorer was cancelled.');
    if (Number(result.exitCode) !== 0) {
      throw new Error(`The scorer exited with code ${result.exitCode}: ${lastLine(result.text) || 'no message'}`);
    }
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).pop() || '';
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`The scorer did not return JSON: ${line.slice(0, 200) || 'empty output'}`);
    }
    return parsed;
  }

  cancel() {
    this.cancelled = true;
    if (this.child) terminateTree(this.child);
  }
}

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}
