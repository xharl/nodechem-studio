import { ChemError, probeRequest, normalizeChemResponse } from '../../src/shared/chemistry.js';
import { SidecarRunner, SidecarRunError } from './sidecarRunner.js';

/**
 * ADR 0003 §2.1 — the probe, not a version parse.
 *
 * Returns a result instead of throwing: a missing interpreter, a missing RDKit
 * and a failed capability are all answers Settings must be able to show. Only
 * the shape is fixed here — `{ok, program, version, capabilities}` or
 * `{ok: false, error: {code, message, detail}}`.
 */
export async function probeChem({ executable = '', script = '', timeoutMs = 15000 } = {}) {
  const target = String(executable || '').trim();
  if (!target) {
    return {
      ok: false,
      error: {
        code: 'chem-sidecar-missing',
        message: 'No chemistry interpreter is configured. Set one in Settings; it needs rdkit installed.',
        detail: '',
      },
    };
  }
  const runner = new SidecarRunner({ label: 'chemistry sidecar' });
  try {
    const raw = await runner.run({
      executable: target,
      script: String(script || '').trim(),
      request: probeRequest(),
      timeoutMs,
    });
    const answer = normalizeChemResponse(raw, { op: 'probe' });
    return {
      ok: true,
      program: answer.program,
      version: answer.version,
      capabilities: answer.capabilities && typeof answer.capabilities === 'object' ? answer.capabilities : {},
      result: answer.result && typeof answer.result === 'object' ? answer.result : {},
    };
  } catch (error) {
    if (error instanceof ChemError) {
      return { ok: false, error: { code: error.code, message: error.message, detail: error.detail } };
    }
    if (error instanceof SidecarRunError) {
      const code = error.code === 'no-executable' ? 'chem-sidecar-missing' : 'chem-probe-failed';
      return { ok: false, error: { code, message: error.message, detail: error.detail } };
    }
    return {
      ok: false,
      error: { code: 'chem-probe-failed', message: String(error?.message || error), detail: '' },
    };
  }
}
