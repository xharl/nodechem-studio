import { describe, expect, it } from 'vitest';
import { ERROR_SIGNATURES, explainFailure, explainRunFailure } from '../src/shared/errorSignatures.js';

describe('error signature table', () => {
  it('ships a non-trivial offline table with unique ids', () => {
    expect(ERROR_SIGNATURES.length).toBeGreaterThanOrEqual(15);
    const ids = ERROR_SIGNATURES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ERROR_SIGNATURES) {
      expect(entry.title).toBeTruthy();
      expect(entry.cause).toBeTruthy();
      expect(entry.action).toBeTruthy();
      expect(Array.isArray(entry.patterns)).toBe(true);
    }
  });

  it('explains an SCF convergence failure with a concrete next step', () => {
    const result = explainFailure({
      engine: 'gaussian',
      text: ' Convergence failure -- run terminated.\n SCF Done:  E(RB3LYP) = -76.0 A.U. after 128 cycles',
    });
    expect(result.matched).toBe(true);
    expect(result.signature.id).toBe('scf-convergence');
    expect(result.explanation.action).toMatch(/MaxCycle/);
  });

  it('recognises Link 9999 as an optimisation cycle limit', () => {
    const result = explainFailure({ engine: 'gaussian', text: ' Link 9999' });
    expect(result.matched).toBe(true);
    expect(result.signature.id).toBe('opt-not-converged');
    expect(result.explanation.title).toMatch(/Link 9999/);
  });

  it('recognises a charge/multiplicity inconsistency as fatal', () => {
    const result = explainFailure({
      engine: 'gaussian',
      text: ' The combination of multiplicity 1 and 9 electrons is impossible.',
    });
    expect(result.matched).toBe(true);
    expect(result.signature.id).toBe('multiplicity-impossible');
    expect(result.severity).toBe('fatal');
  });

  it('recognises a scratch-space failure', () => {
    const result = explainFailure({
      engine: 'gaussian',
      text: ' Erroneous write during file extend.  Erroneous Write.  Disk quota exceeded',
    });
    expect(result.matched).toBe(true);
    expect(result.signature.id).toBe('disk-quota');
  });

  it('recognises a missing Link 1', () => {
    const result = explainFailure({
      engine: 'gaussian',
      text: ' execvp on /opt/g16/l1.exe failed: No such file or directory',
    });
    expect(result.matched).toBe(true);
    expect(result.signature.id).toBe('link1-failure');
  });

  it('keeps xTB signatures out of Gaussian evidence', () => {
    const gaussian = explainFailure({
      engine: 'gaussian',
      text: ' xtb parameter file not found',
    });
    expect(gaussian.signature?.id).not.toBe('xtb-missing-parameters');

    const xtb = explainFailure({
      engine: 'xtb',
      text: ' xtb parameter file not found: /usr/share/xtb',
    });
    expect(xtb.matched).toBe(true);
    expect(xtb.signature.id).toBe('xtb-missing-parameters');
  });

  it('explains runner-level failures that are not engine text', () => {
    const result = explainFailure({ text: 'spawn g16 ENOENT' });
    expect(result.matched).toBe(true);
    expect(result.signature.id).toBe('engine-missing');
  });

  it('returns no explanation for unmatched evidence instead of guessing', () => {
    const result = explainFailure({ engine: 'gaussian', text: ' Error termination via Lnk1e in something' });
    expect(result.matched).toBe(false);
    expect(result.signature).toBeNull();
    expect(result.explanation).toBeNull();
  });

  it('returns no explanation for empty evidence', () => {
    expect(explainFailure({}).matched).toBe(false);
    expect(explainFailure().matched).toBe(false);
  });
});

describe('explainRunFailure', () => {
  it('is silent for a successful run', () => {
    expect(explainRunFailure({ status: 'completed', exitCode: 0, parsed: { status: 'completed' } })).toBeNull();
  });

  it('reads the parsed error-termination block', () => {
    const diagnosis = explainRunFailure({
      status: 'failed',
      exitCode: 0,
      engine: 'gaussian',
      parsed: {
        status: 'error',
        errorTermination: {
          cause: 'Convergence failure -- run terminated.',
          terminationLine: 'Error termination via Lnk1e',
          lines: ['Convergence criterion not met.'],
        },
      },
    });
    expect(diagnosis.matched).toBe(true);
    expect(diagnosis.signature.id).toBe('scf-convergence-short');
  });

  it('reads a runner error when the engine produced no text', () => {
    const diagnosis = explainRunFailure({ status: 'failed', error: 'spawn g16 ENOENT' });
    expect(diagnosis.matched).toBe(true);
    expect(diagnosis.signature.id).toBe('engine-missing');
  });
});
