import { SidecarRunner, SidecarRunError } from './sidecarRunner.js';

/**
 * Issue #226 — the RDKit tautomer-enumeration sidecar.
 *
 * Kept as a thin caller of `SidecarRunner` (ADR 0003 §2.1): the spawn contract,
 * the stdin/stdout rule, the wall clock and the process-tree teardown live in
 * one place, and this class only preserves the tautomer messages the queue and
 * its tests already rely on.
 */
export class TautomerRunner {
  constructor() {
    this.runner = new SidecarRunner({ label: 'tautomer enumerator' });
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
    try {
      return await this.runner.run({ executable, script, request, timeoutMs, cwd, onOutput });
    } catch (error) {
      if (!(error instanceof SidecarRunError)) throw error;
      if (error.code === 'timeout') throw new Error('The tautomer enumerator was stopped by its wall-clock limit.');
      if (error.code === 'cancelled') throw new Error('The tautomer enumeration was cancelled.');
      if (error.code === 'exit') {
        throw new Error(`The tautomer enumerator exited with code ${error.exitCode}: ${error.detail || 'no message'}`);
      }
      if (error.code === 'no-json') {
        throw new Error(`The tautomer enumerator did not return JSON: ${error.detail || 'empty output'}`);
      }
      throw error;
    }
  }

  cancel() {
    this.runner.cancel();
  }
}
