import { describe, it, expect } from 'vitest';
import { formatPreflightReport, preflightFailureMessage } from '../src/renderer/preflightReport.js';

/**
 * The run console is the only place a preflight verdict is read. Warnings are
 * a third state: a user who chose a scratch path with spaces must see it, but
 * must not be told preflight failed — and a warning must never render as PASS.
 */
describe('preflight console report', () => {
  it('keeps the existing PASS/FAIL format byte for byte', () => {
    const text = formatPreflightReport({
      ok: true,
      checks: [
        { id: 'platform', label: 'Operating system', ok: true, detail: 'win32 10.0.26100' },
        { id: 'link1', label: 'Gaussian Link 1 present', ok: false, detail: '' },
      ],
    });
    expect(text).toBe([
      'Preflight · ready',
      'PASS  Operating system — win32 10.0.26100',
      'FAIL  Gaussian Link 1 present',
      '',
      '',
    ].join('\n'));
  });

  it('renders warnings as WARN after the checks', () => {
    const text = formatPreflightReport({
      ok: true,
      checks: [{ id: 'scratch', label: 'Scratch directory writable', ok: true, detail: '/tmp/scratch dir' }],
      warnings: [{ id: 'scratch-spaces', label: 'Scratch path contains spaces', detail: '/tmp/scratch dir' }],
    });
    expect(text).toContain('WARN  Scratch path contains spaces — /tmp/scratch dir');
    expect(text).not.toContain('PASS  Scratch path contains spaces');
    expect(text).toContain('Preflight · ready');
  });

  it('handles a result with no warnings array', () => {
    expect(formatPreflightReport({ ok: false, checks: [] }))
      .toBe('Preflight · issues found\n\n');
  });

  it('does not throw on a missing result', () => {
    expect(formatPreflightReport(null)).toBe('Preflight · issues found\n\n');
  });

  it('renders an engine no block uses as SKIP, not PASS (issue 316)', () => {
    const text = formatPreflightReport({
      ok: true,
      checks: [
        { id: 'psi4-executable', label: 'Psi4 executable configured', ok: true, detail: '/usr/bin/psi4' },
        { id: 'gaussian-skipped', label: 'Gaussian 16 executable', ok: true, skipped: true, detail: 'Skipped — no block in this flow runs Gaussian 16.' },
      ],
    });
    expect(text).toContain('PASS  Psi4 executable configured — /usr/bin/psi4');
    expect(text).toContain('SKIP  Gaussian 16 executable — Skipped — no block in this flow runs Gaussian 16.');
    expect(text).not.toContain('PASS  Gaussian 16 executable');
  });

  it('leaves the failing check in the status line, not only in a toast (issue 316)', () => {
    const result = {
      ok: false,
      checks: [
        { id: 'psi4-executable', label: 'Psi4 executable configured', ok: false, detail: 'Not configured' },
        { id: 'orca-skipped', label: 'ORCA 6 executable', ok: true, skipped: true, detail: 'Skipped' },
      ],
    };
    expect(preflightFailureMessage(result)).toBe('Preflight: Psi4 executable configured — Not configured');
  });

  it('falls back to a plain refusal when no check names a reason', () => {
    expect(preflightFailureMessage({ ok: false, checks: [] })).toBe('Preflight: not ready. Fix the run configuration or use dry run.');
    expect(preflightFailureMessage(null)).toContain('Preflight: not ready');
  });
});
