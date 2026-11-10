/**
 * Issue 258 — the run console's companion-tool fields (CREST, Open Babel,
 * ML scorer, tautomer sidecar) seed themselves from the same detection answer
 * that already fills the engine field (issue 233).
 *
 * Kept pure so the rule is testable without a DOM: a stored path always wins;
 * otherwise a detected path becomes the value and is marked "detected"; a
 * missing tool leaves the field empty so the console can say "not found on
 * PATH" instead of showing a foreign placeholder.
 */

export const COMPANION_TOOL_IDS = Object.freeze(['crest', 'obabel', 'scorer', 'tautomer']);

/** The absolute path main's PATH probe found for a companion, or ''. */
export function detectedCompanionPath(status, toolId) {
  const entry = status?.tools?.[toolId];
  if (!entry || entry.ok !== true) return '';
  return typeof entry.path === 'string' ? entry.path.trim() : '';
}

export function companionSeed({ toolId, stored = '', status = null } = {}) {
  const storedPath = String(stored || '').trim();
  if (storedPath) return { value: storedPath, detected: false, path: storedPath };
  const detected = detectedCompanionPath(status, toolId);
  return { value: detected, detected: Boolean(detected), path: detected };
}

/** All four fields at once; the renderer walks this map to fill the console. */
export function companionSeeds({ status = null, stored = {} } = {}) {
  const seeds = {};
  for (const toolId of COMPANION_TOOL_IDS) {
    seeds[toolId] = companionSeed({ toolId, stored: stored?.[toolId], status });
  }
  return seeds;
}

/**
 * Example path shown in an empty field, with no foreign-platform example.
 * `platform` is `process.platform` as reported by main ('win32', 'darwin',
 * 'linux', …); anything non-Windows gets POSIX paths.
 */
export function companionPlaceholderFor(toolId, platform = 'linux') {
  const windows = platform === 'win32';
  switch (toolId) {
    case 'crest':
      return windows ? 'C:\\crest\\crest.exe' : '/usr/local/bin/crest';
    case 'obabel':
      return windows
        ? 'C:\\ProgramData\\miniforge3\\Library\\bin\\obabel.exe'
        : '/usr/local/bin/obabel';
    case 'scorer':
      // The runner spawns one executable, not a command line (#0.5.0 notes).
      return windows ? 'C:\\scorer\\aimnet2-scorer.exe' : '/opt/scorer/aimnet2-scorer';
    case 'tautomer':
      return windows ? 'C:\\Python\\python.exe' : '/usr/bin/python3';
    default:
      return '';
  }
}
