/**
 * Issue issue 233 — the run console's executable field seeds itself from the engine
 * the app already detected, without overwriting a stored override.
 *
 * Kept pure so the rule is testable without a DOM: a user's stored path always
 * wins; otherwise a detected path becomes the value and is marked "detected";
 * an engine that is not on PATH leaves the field empty.
 */

export function detectedExecutablePath(status, engineId) {
  const entry = status?.[engineId];
  if (!entry || entry.ok !== true) return '';
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  return path;
}

export function executableSeed({ engineId, stored = {}, status = null } = {}) {
  const storedPath = String(stored?.[engineId] || '').trim();
  if (storedPath) {
    return { value: storedPath, detected: false, path: storedPath };
  }
  const detected = detectedExecutablePath(status, engineId);
  return { value: detected, detected: Boolean(detected), path: detected };
}
