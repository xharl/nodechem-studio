/**
 * Issue #258 — detect the companion binaries the run console needs, using the
 * same presence-only rule as `engineStatus()` (#233): a PATH entry that exists
 * and is executable. No version probe at startup.
 *
 * Kept separate from `electron/main.js` so the candidate-name rule (including
 * `.exe` on Windows) is testable without booting Electron.
 */
import fs from 'node:fs';
import path from 'node:path';

export const COMPANION_BINARIES = Object.freeze({
  crest: ['crest'],
  obabel: ['obabel'],
  // A scorer is spawned as one executable, so only a wrapper command is
  // detectable. The shipped Python sidecar is not installed as a command.
  scorer: ['aimnet2-scorer', 'aimnet2_scorer'],
  // Issue #270: Multiwfn is user-installed and has no installer that puts it on
  // PATH; detection is a convenience, and the field is still the authority.
  multiwfn: ['Multiwfn', 'multiwfn'],
  // The tautomer field takes a Python interpreter when the user also names the
  // enumerator script; python3 is preferred so a Buster-style `python` shim
  // does not win over a real Python 3.
  tautomer: ['python3', 'python', 'py'],
});

/** Candidate file names for a platform; Windows needs the explicit `.exe`. */
export function companionCandidates(names, platform = process.platform) {
  if (platform !== 'win32') return [...names];
  const candidates = [];
  for (const name of names) {
    candidates.push(name);
    if (!path.extname(name)) candidates.push(`${name}.exe`);
  }
  return candidates;
}

/**
 * First executable file found in `dirs`, in candidate-name order. Injected
 * access/stat keep this testable without touching the real filesystem.
 */
export function findCompanionOnPath({
  names,
  dirs,
  platform = process.platform,
  access = (candidate) => fs.accessSync(candidate, fs.constants.X_OK),
  stat = (candidate) => fs.statSync(candidate),
}) {
  for (const name of companionCandidates(names, platform)) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        access(candidate);
        if (stat(candidate).isFile()) return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

/** Detection answer for every companion, extra keys on top of the engines. */
export function companionToolStatus({
  platform = process.platform,
  pathValue = process.env.PATH,
  access,
  stat,
} = {}) {
  const dirs = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const status = {};
  for (const [toolId, names] of Object.entries(COMPANION_BINARIES)) {
    const found = findCompanionOnPath({ names, dirs, platform, access, stat });
    status[toolId] = { ok: Boolean(found), path: found };
  }
  return status;
}
