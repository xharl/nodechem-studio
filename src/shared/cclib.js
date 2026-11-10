/**
 * cclib conversion boundary (issue 273).
 *
 * The app does not parse NWChem/GAMESS/Q-Chem logs. A user-installed Python
 * interpreter with cclib converts one log to Avogadro Chemical JSON; this
 * module only names the files, builds the command and reads the sidecar's
 * one-line summary. The conversion itself lives in `scripts/ncs_cclib.py`.
 *
 * The source log is never renamed or rewritten: the cjson sits beside it, and
 * `parseCjson()` imports the molecule, charge, final energy and origin.
 */

import path from 'node:path';

/** The cclib interpreter is a companion tool, like RDKit for tautomers. */
export const CCLIB_TOOL_ID = 'cclib';

/** Logs cclib is allowed to open. A wavefunction is pointed at the native readers. */
export const CCLIB_LOG_EXTENSIONS = Object.freeze(['log', 'out']);

/** Extensions the sidecar refuses by name. */
export const CCLIB_WAVEFUNCTION_EXTENSIONS = Object.freeze(['wfn', 'wfx', 'fchk', 'fch', 'molden', 'chk', 'cube']);

/** The bundled converter script, relative to the app root. */
export const CCLIB_SCRIPT_RELATIVE = 'scripts/ncs_cclib.py';

export function cclibExtension(name) {
  const lower = String(name ?? '').toLowerCase();
  return /\.([a-z0-9]+)$/.exec(lower)?.[1] || '';
}

/** A foreign log this sidecar may convert; Gaussian logs stay with the native parser. */
export function isCclibLogName(name) {
  const extension = cclibExtension(name);
  return CCLIB_LOG_EXTENSIONS.includes(extension)
    && !/gaussian|g16|g09/i.test(String(name ?? ''));
}

/** The default output name beside the input: `run.log` → `run.cjson`. */
export function cclibOutputName(inputName) {
  const base = path.basename(String(inputName || 'run.log')).replace(/\.(?:log|out)(?:\.gz)?$/i, '');
  return `${base || 'run'}.cjson`;
}

/**
 * The argv for `python scripts/ncs_cclib.py convert <input> <output> --json`.
 * Absolute paths are the sidecar's contract; it never guesses a project folder.
 */
export function cclibConversionArgs({ script, input, output }) {
  return [String(script), 'convert', String(input), String(output), '--json'];
}

/**
 * Read the sidecar's final JSON line. It writes one summary object; cclib's own
 * chatter is not allowed to become the conversion verdict.
 */
export function parseCclibSummary(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value;
    } catch {
      // A warning line is not the summary.
    }
  }
  return null;
}
