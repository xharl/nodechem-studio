import path from 'node:path';

/**
 * ADR 0003 §2.5 — where a shipped chemistry script lives.
 *
 * `electron-builder` copies `scripts/` through `extraResources`, so an installed
 * build resolves it under `process.resourcesPath`, not inside the asar (an
 * external Python cannot execute a file inside the archive). Development runs
 * resolve it from the app directory. Pure and injectable so the packaged branch
 * is testable without booting Electron.
 */
export function resolveChemScript({
  isPackaged = false,
  appPath = '',
  resourcesPath = '',
  name = 'nodechem-chem.py',
} = {}) {
  const root = isPackaged ? resourcesPath : appPath;
  if (!root) {
    throw new Error('resolveChemScript needs appPath (development) or resourcesPath (packaged).');
  }
  return path.join(String(root), 'scripts', String(name));
}

/** The tautomer enumerator ships through the same resources rule. */
export function resolveTautomerScript(options = {}) {
  return resolveChemScript({ ...options, name: 'tautomer-enumerator.py' });
}
