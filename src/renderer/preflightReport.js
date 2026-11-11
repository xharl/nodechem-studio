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
 * The checks that blocked a run, with the field that fixes each one.
 *
 * Issue 362: the refusal used to be a toast with no cause ("Preflight is not
 * ready"), while the FAIL line lived in the other pane. A refusal now names
 * every failing requirement, and the queue pane can offer the field that
 * clears it. `target` is a run-console selector or null for a check the console
 * cannot fix (an operating system, a missing licence file).
 */
export function preflightRefusals(result) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  return checks
    .filter((check) => !check.ok && !check.skipped)
    .map((check) => ({
      id: String(check.id || ''),
      label: String(check.label || ''),
      detail: String(check.detail || ''),
      target: preflightFixTarget(check.id),
    }));
}

/**
 * Which run-console field clears a failing check. Engine executable rows carry
 * `engine-<id>-executable` when the flow runs several engines, and the plain
 * `executable` id for the primary one; the sidecars keep their own ids.
 */
export function preflightFixTarget(checkId) {
  const id = String(checkId || '');
  if (id === 'executable' || /^engine-[a-z0-9]+-executable$/.test(id)) return '#run-exe';
  if (id === 'tautomer' || id === 'tautomer-sidecar') return '#run-tautomer';
  if (id === 'scorer' || id === 'scorer-sidecar') return '#run-scorer';
  if (id === 'scratch' || id === 'scratch-writable') return '#run-scratch';
  return null;
}

/**
 * The one line a refusal should say out loud. It names the requirement, the
 * block that needs it (the row detail carries that), and nothing else — a toast
 * the user cannot act on is the bug this replaces.
 */
export function preflightRefusalToast(result) {
  const failing = preflightRefusals(result);
  if (failing.length === 0) return 'Preflight is not ready. Fix the run configuration or use dry run.';
  const [first] = failing;
  const more = failing.length > 1 ? ` (and ${failing.length - 1} more)` : '';
  return `Preflight failed: ${first.label}${first.detail ? ` — ${first.detail}` : ''}${more}`;
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
