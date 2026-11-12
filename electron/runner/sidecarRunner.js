import { spawn } from 'node:child_process';
import { terminateTree, treeSpawnOptions } from './processTree.js';

/**
 * ADR 0003 §2.1 — one spawn path for every external chemistry sidecar.
 *
 * Contract: the process is called with no arguments (or with one script path,
 * when the executable is an interpreter) and reads one JSON object from stdin.
 * It writes one JSON object to stdout: either an answer or a refusal. Nothing
 * is parsed from a log, because a sidecar has no canonical log. stdout *is* the
 * protocol, so it is captured and never forwarded; stderr is where the sidecar's
 * own diagnostics belong and is forwarded to `onOutput`.
 *
 * This class owns transport only. Protocol validation, refusal codes and
 * provenance belong to the shared modules (`src/shared/chemistry.js` and the
 * per-op modules), so no op can invent a second wire or a second error shape.
 */

export const SIDECAR_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A transport failure, not a refusal: the sidecar never spoke the protocol. */
export class SidecarRunError extends Error {
  constructor(code, message, { detail = '', exitCode = null } = {}) {
    super(message);
    this.name = 'SidecarRunError';
    this.code = String(code || 'sidecar-failed');
    this.detail = detail === null ? '' : String(detail || '');
    this.exitCode = exitCode;
  }
}

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

export class SidecarRunner {
  constructor({ label = 'sidecar' } = {}) {
    this.label = String(label || 'sidecar');
    this.child = null;
    this.cancelled = false;
    this.timedOut = false;
  }

  /**
   * Run one request and return the JSON object the sidecar printed.
   *
   * @param {object} options
   * @param {string} options.executable interpreter or program to spawn
   * @param {string} [options.script] one script path passed as the only argv
   * @param {object} options.request the JSON object written to stdin
   * @param {number} [options.timeoutMs] wall clock; 0 means no limit
   * @param {string} [options.cwd]
   * @param {(event: {stream: string, text: string}) => void} [options.onOutput]
   */
  async run({
    executable,
    script = '',
    request,
    timeoutMs = 0,
    cwd = '',
    onOutput = () => {},
  }) {
    if (!executable) {
      throw new SidecarRunError('no-executable', `No ${this.label} executable is configured.`);
    }
    if (!request || typeof request !== 'object') {
      throw new SidecarRunError('bad-request', `The ${this.label} request is missing.`);
    }
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
      if (text.length < SIDECAR_MAX_OUTPUT_BYTES) {
        if (stream === 'stdout') {
          text += chunkText;
          if (text.length >= SIDECAR_MAX_OUTPUT_BYTES) truncated = true;
        }
      }
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
    let result;
    try {
      result = await new Promise((resolve, reject) => {
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
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new SidecarRunError('spawn', `The ${this.label} executable was not found: ${executable}`, {
          detail: String(error.message || ''),
        });
      }
      throw new SidecarRunError('spawn', `The ${this.label} could not be started: ${error?.message || error}`, {
        detail: String(error?.message || ''),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      this.child = null;
    }

    if (result.timedOut) {
      throw new SidecarRunError('timeout', `The ${this.label} was stopped by its wall-clock limit.`, {
        detail: lastLine(result.stderr),
      });
    }
    if (result.cancelled) {
      throw new SidecarRunError('cancelled', `The ${this.label} was cancelled.`, {
        detail: lastLine(result.stderr),
      });
    }

    const line = result.text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).pop() || '';
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') return parsed;
    if (Number(result.exitCode) !== 0) {
      throw new SidecarRunError(
        'exit',
        `The ${this.label} exited with code ${result.exitCode}: ${lastLine(result.stderr) || lastLine(result.text) || 'no message'}`,
        { detail: lastLine(result.stderr) || lastLine(result.text), exitCode: result.exitCode },
      );
    }
    throw new SidecarRunError(
      'no-json',
      `The ${this.label} did not return JSON: ${line.slice(0, 200) || 'empty output'}`,
      { detail: line.slice(0, 200) },
    );
  }

  cancel() {
    this.cancelled = true;
    if (this.child) terminateTree(this.child);
  }
}
