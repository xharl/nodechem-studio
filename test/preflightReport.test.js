import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  formatPreflightReport,
  preflightFailureMessage,
  preflightFixTarget,
  preflightRefusalToast,
  preflightRefusals,
} from '../src/renderer/preflightReport.js';

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

/**
 * Issue 362: the refusal toast said "Preflight is not ready. Fix the run
 * configuration or use dry run." — a sentence that names neither the failing
 * requirement nor the pane that fixes it, and the queue pane stayed `idle`, so
 * the click read as "nothing happened".
 */
describe('a refused run names its cause', () => {
  const refused = {
    ok: false,
    checks: [
      { id: 'platform', label: 'Operating system', ok: true, detail: 'linux 7.2.14' },
      { id: 'engine-xtb-executable', label: 'xTB executable configured', ok: false, detail: 'Not configured · needed by xTB SP' },
      { id: 'engine-gaussian-skipped', label: 'Gaussian 16 executable', ok: true, skipped: true, detail: 'Skipped' },
    ],
  };

  it('lists every blocking check, and only those', () => {
    const failures = preflightRefusals(refused);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      id: 'engine-xtb-executable',
      label: 'xTB executable configured',
      detail: 'Not configured · needed by xTB SP',
    });
  });

  it('puts the requirement, the block that needs it and the field in the toast', () => {
    expect(preflightRefusalToast(refused))
      .toBe('Preflight failed: xTB executable configured — Not configured · needed by xTB SP');
    expect(preflightRefusalToast(refused)).not.toContain('Fix the run configuration');
  });

  it('counts the remaining failures instead of hiding them behind the first', () => {
    const two = {
      ok: false,
      checks: [
        { id: 'executable', label: 'Gaussian 16 executable configured', ok: false, detail: 'Not configured' },
        { id: 'scratch', label: 'Scratch directory writable', ok: false, detail: 'EACCES: permission denied' },
      ],
    };
    expect(preflightRefusalToast(two)).toContain('(and 1 more)');
    expect(preflightRefusals(two).map((failure) => failure.target)).toEqual(['#run-exe', '#run-scratch']);
  });

  it('maps each blocking check to the console field that clears it', () => {
    expect(preflightFixTarget('executable')).toBe('#run-exe');
    expect(preflightFixTarget('engine-orca-executable')).toBe('#run-exe');
    expect(preflightFixTarget('tautomer')).toBe('#run-tautomer');
    expect(preflightFixTarget('scorer')).toBe('#run-scorer');
    // A platform or licence check has no field in the console.
    expect(preflightFixTarget('platform')).toBeNull();
    expect(preflightFixTarget('')).toBeNull();
  });

  it('keeps the generic sentence for a refusal with no check at all', () => {
    expect(preflightRefusalToast({ ok: false, checks: [] })).toContain('Preflight is not ready');
    expect(preflightRefusals(null)).toEqual([]);
  });
});

/** The wiring: both Run buttons, one refusal path, and a banner in the pane. */
describe('the queue pane shows the refusal (issue 362)', () => {
  const ROOT = new URL('..', import.meta.url);
  const app = readFileSync(new URL('src/renderer/app.js', ROOT), 'utf8');
  const html = readFileSync(new URL('index.html', ROOT), 'utf8');

  it('carries a banner with a fix action inside the queue pane', () => {
    const pane = html.slice(html.indexOf('data-pane="queue"'), html.indexOf('id="run-records"'));
    expect(pane).toContain('id="queue-refusal"');
    expect(pane).toContain('id="queue-refusal-list"');
    expect(pane).toContain('data-action="fix-run-refusal"');
  });

  it('sends both Run buttons through one refusal, and clears it on a start', () => {
    // The definition and the two call sites — Run selected block, Run workflow.
    expect(app.match(/refuseRun\(/g), 'both Run buttons must share the refusal').toHaveLength(3);
    expect(app.match(/clearRunRefusal\(\);/g)).toHaveLength(2);
    expect(app).toContain("case 'fix-run-refusal'");
  });
});
