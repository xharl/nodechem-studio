import { spawn } from 'node:child_process';
import { terminateTree, treeSpawnOptions } from './processTree.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Issue #226 — spawn the RDKit tautomer-enumeration sidecar.
 *
 * Contract: the process is called with no arguments (or with one script path,
 * when the executable is an interpreter) and reads one JSON object from stdin.
 * It writes one JSON object to stdout: either `{ ok: true, candidates: [...] }`
 * or `{ ok: false, error: { code, message } }`. Nothing is parsed from a log,
 * because an enumerator has no canonical log.
 *
 * A refusal is returned, not thrown: `normalizeTautomerResponse()` turns it
 * into a `TautomerEnumerationError` carrying the sidecar's code, so the queue
 * can record *why* the block refused instead of an empty ensemble.
 */
export class TautomerRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
    this.timedOut = false;
  }

  async enumerate({
    executable,
    script = '',
    request,
    timeoutMs = 0,
    cwd = '',
    onOutput = () => {},
  }) {
    if (!executable) throw new Error('No tautomer sidecar is configured; set the RDKit sidecar path in the run console.');
    if (!request || typeof request !== 'object') throw new Error('The tautomer request is missing.');
    const args = script ? [String(script)] : [];
    this.cancelled = false;
    this.timedOut = false;
    let text = '';
    let stderr = '';
    let truncated = false;
    const child = spawn(String(executable), args, treeSpawnOptions({
      cwd: cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    this.child = child;
    const capture = (stream) => (chunk) => {
      const chunkText = chunk.toString('utf8');
      if (stream === 'stderr') stderr += chunkText;
      if (text.length < MAX_OUTPUT_BYTES) {
        if (stream === 'stdout') {
          text += chunkText;
          if (text.length >= MAX_OUTPUT_BYTES) truncated = true;
        }
      }
      // stdout *is* the protocol: a 20 kB JSON answer is not progress, and
      // echoing it into the run log buries the one line that matters. stderr is
      // where a sidecar's own diagnostics belong, so only that is forwarded.
      if (stream === 'stderr') onOutput({ stream, text: chunkText });
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));

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
        stderr,
      }));
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });
    if (result.timedOut) throw new Error('The tautomer enumerator was stopped by its wall-clock limit.');
    if (result.cancelled) throw new Error('The tautomer enumeration was cancelled.');

    // The sidecar writes exactly one JSON object on stdout, on success and on
    // refusal alike; keep the stderr tail only for the case where it wrote
    // nothing parseable.
    const line = result.text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).pop() || '';
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') return parsed;
    if (Number(result.exitCode) !== 0) {
      const detail = lastLine(result.stderr) || lastLine(result.text) || 'no message';
      throw new Error(`The tautomer enumerator exited with code ${result.exitCode}: ${detail}`);
    }
    throw new Error(`The tautomer enumerator did not return JSON: ${line.slice(0, 200) || 'empty output'}`);
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
