/**
 * Issue 252 — the main-process settings store.
 *
 * `settings.json` lives under `app.getPath('userData')`, outside every project.
 * Reads never throw: a missing or corrupt file yields the defaults so the app
 * can still start. Writes are normalised, path-checked and atomic (temporary
 * file in the same directory, then rename).
 *
 * The module takes its user-data directory as an argument instead of importing
 * Electron, so the CLI and the unit tests use the exact same reader/writer.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  defaultAppSettings,
  mergeAppSettings,
  normalizeAppSettings,
  settingsPathFor,
} from '../src/shared/appSettings.js';

const ENGINE_LABELS = Object.freeze({
  gaussian: 'Gaussian',
  xtb: 'xTB',
  psi4: 'Psi4',
  orca: 'ORCA',
});

const TOOL_LABELS = Object.freeze({
  crest: 'CREST',
  obabel: 'Open Babel',
  scorer: 'ML scorer',
  multiwfn: 'Multiwfn',
  tautomer: 'Tautomer sidecar',
});

function reasonFor(error) {
  switch (error?.code) {
    case 'ENOENT': return 'does not exist';
    case 'EACCES': return 'permission denied';
    case 'EPERM': return 'operation not permitted';
    case 'ENOTDIR': return 'a parent path is not a directory';
    case 'ELOOP': return 'too many symbolic links';
    default: return String(error?.message || error?.code || 'cannot be used');
  }
}

/**
 * Read and normalise a settings file.
 *
 * @returns {Promise<{settings: object, errors: Array, found: boolean, corrupt: boolean}>}
 */
export async function readSettingsFile(filePath, { fsPromises = fsp } = {}) {
  let text;
  try {
    text = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { settings: defaultAppSettings(), errors: [], found: false, corrupt: false };
    }
    return {
      settings: defaultAppSettings(),
      errors: [{ field: '', message: `could not read ${filePath}: ${reasonFor(error)}` }],
      found: false,
      corrupt: true,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      settings: defaultAppSettings(),
      errors: [{ field: '', message: `${filePath} is not valid JSON: ${error.message}` }],
      found: true,
      corrupt: true,
    };
  }

  const normalized = normalizeAppSettings(parsed);
  return {
    settings: normalized.settings,
    errors: normalized.errors,
    found: true,
    corrupt: !normalized.ok,
  };
}

/**
 * Every configured executable must exist and be executable. A blank optional
 * tool is valid; a non-blank path that cannot run is refused with the field and
 * the reason, so the Settings window can put the message next to the input.
 */
export async function validateSettingsPaths(settings, {
  access = fsp.access,
  stat = fsp.stat,
} = {}) {
  const errors = [];
  const checkExecutable = async (field, label, value) => {
    const target = String(value || '').trim();
    if (!target) return;
    try {
      // eslint-disable-next-line no-await-in-loop
      await access(target, fs.constants.X_OK);
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(target);
      if (!info.isFile()) {
        errors.push({ field, message: `${label} is not a file: ${target}` });
      }
    } catch (error) {
      errors.push({ field, message: `${label} at ${target} ${reasonFor(error)}.` });
    }
  };
  const checkReadableFile = async (field, label, value) => {
    const target = String(value || '').trim();
    if (!target) return;
    try {
      // eslint-disable-next-line no-await-in-loop
      await access(target, fs.constants.R_OK);
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(target);
      if (!info.isFile()) errors.push({ field, message: `${label} is not a file: ${target}` });
    } catch (error) {
      errors.push({ field, message: `${label} at ${target} ${reasonFor(error)}.` });
    }
  };
  const checkDirectory = async (field, label, value) => {
    const target = String(value || '').trim();
    if (!target) return;
    try {
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(target);
      if (!info.isDirectory()) errors.push({ field, message: `${label} is not a directory: ${target}` });
    } catch (error) {
      errors.push({ field, message: `${label} at ${target} ${reasonFor(error)}.` });
    }
  };

  for (const [id, label] of Object.entries(ENGINE_LABELS)) {
    // eslint-disable-next-line no-await-in-loop
    await checkExecutable(`engines.${id}`, `${label} executable`, settings?.engines?.[id]);
  }
  for (const [id, label] of Object.entries(TOOL_LABELS)) {
    // eslint-disable-next-line no-await-in-loop
    await checkExecutable(`tools.${id}`, `${label} executable`, settings?.tools?.[id]);
  }
  await checkReadableFile('tools.tautomerScript', 'Tautomer script', settings?.tools?.tautomerScript);
  await checkDirectory('tools.scratch', 'Scratch directory', settings?.tools?.scratch);
  await checkDirectory('advanced.dataDir', 'Data directory', settings?.advanced?.dataDir);
  return errors;
}

async function writeAtomic(filePath, settings) {
  const data = `${JSON.stringify(settings, null, 2)}\n`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fsp.writeFile(temp, data, 'utf8');
    await fsp.rename(temp, filePath);
  } catch (error) {
    // A Windows handle can refuse a rename over an existing file; a direct
    // write is the fallback. Either way a partial file is never left behind.
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (!['EPERM', 'EACCES', 'EEXIST', 'EBUSY'].includes(error?.code)) throw error;
    await fsp.writeFile(filePath, data, 'utf8');
  }
}

/**
 * Create the store the main process and the CLI share.
 *
 * `get()` returns `{ settings, path }`; `set(patch)` merges, normalises,
 * validates every non-empty path and only then writes.
 */
export function createSettingsStore({ userDataDir, fsPromises = fsp, access, stat } = {}) {
  if (!userDataDir) throw new Error('createSettingsStore needs a userDataDir.');
  const filePath = settingsPathFor(userDataDir);
  let current = null;

  const load = async () => {
    if (current) return current;
    const result = await readSettingsFile(filePath, { fsPromises });
    current = result.settings;
    return current;
  };

  return {
    get path() { return filePath; },

    async get() {
      return { settings: JSON.parse(JSON.stringify(await load())), path: filePath };
    },

    async reload() {
      current = null;
      return this.get();
    },

    async set(patch) {
      const base = await load();
      const merged = mergeAppSettings(base, patch);
      const normalized = normalizeAppSettings(merged);
      if (!normalized.ok) {
        return {
          ok: false,
          settings: JSON.parse(JSON.stringify(base)),
          errors: normalized.errors,
          path: filePath,
        };
      }
      const pathErrors = await validateSettingsPaths(normalized.settings, { access, stat });
      if (pathErrors.length > 0) {
        return {
          ok: false,
          settings: JSON.parse(JSON.stringify(base)),
          errors: pathErrors,
          path: filePath,
        };
      }
      try {
        await writeAtomic(filePath, normalized.settings);
      } catch (error) {
        return {
          ok: false,
          settings: JSON.parse(JSON.stringify(base)),
          errors: [{ field: '', message: `could not save settings: ${reasonFor(error)}` }],
          path: filePath,
        };
      }
      current = normalized.settings;
      return {
        ok: true,
        settings: JSON.parse(JSON.stringify(current)),
        errors: [],
        path: filePath,
      };
    },
  };
}
