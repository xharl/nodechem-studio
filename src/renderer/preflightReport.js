/**
 * Format a preflight result for the run console.
 *
 * PASS/FAIL lines keep exactly the shape they had before platform support, so
 * the console reads the same on Windows. Warnings are a third, explicit state:
 * a scratch path with spaces is neither reported as a pass nor as a blocking
 * failure, and `ok` is still computed by preflight from hard checks only.
 *
 * Issue 316 added a fourth: SKIP, for an engine no block in the flow uses. Its
 * absence must stay visible without reading as a pass or blocking the run.
 */
export function formatPreflightReport(result) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const lines = checks.map((check) => {
    const verdict = check.skipped ? 'SKIP' : (check.ok ? 'PASS' : 'FAIL');
    return `${verdict}  ${check.label}${check.detail ? ` — ${check.detail}` : ''}`;
  });
  const warned = warnings.map((warning) => `WARN  ${warning.label}${warning.detail ? ` — ${warning.detail}` : ''}`);
  const header = `Preflight · ${result?.ok ? 'ready' : 'issues found'}`;
  return `${[header, ...lines, ...warned].join('\n')}\n\n`;
}

/**
 * The one line a refusal should leave behind.
 *
 * Issue 316: the console printed the failing check and then a toast that
 * disappeared, while the status bar kept the *previous* run's message — so the
 * user was told about the wrong blocker. This is what goes in the status bar.
 */
export function preflightFailureMessage(result) {
  const failing = (Array.isArray(result?.checks) ? result.checks : [])
    .find((check) => !check.ok && !check.skipped);
  if (!failing) return 'Preflight: not ready. Fix the run configuration or use dry run.';
  return `Preflight: ${failing.label}${failing.detail ? ` — ${failing.detail}` : ''}`;
}
