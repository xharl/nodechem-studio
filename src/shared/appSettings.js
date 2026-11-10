/**
 * Issue 252 — machine and application settings, shared by the desktop app and
 * `ncs`.
 *
 * These values describe the computer the work runs on (engine binaries,
 * companion tools, scratch space) or the application itself (run defaults,
 * appearance, the directory runs are written under). They are deliberately not
 * part of a project: a project describes what to compute, and must be portable
 * to another machine.
 *
 * The file is versioned and normalised here so the renderer, main process and
 * CLI cannot disagree about what a valid setting is. Every rejected value
 * carries a reason; nothing is silently dropped.
 */

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_FILE_NAME = 'settings.json';

export const SETTINGS_ENGINE_IDS = Object.freeze(['gaussian', 'xtb', 'psi4', 'orca', 'pyscf']);
export const SETTINGS_TOOL_IDS = Object.freeze([
  'crest', 'obabel', 'scorer', 'multiwfn', 'tautomer', 'tautomerScript', 'scratch',
]);
export const SETTINGS_MEMORY_UNITS = Object.freeze(['MB', 'GB', 'MW']);
export const SETTINGS_XTB_METHODS = Object.freeze(['gfn2', 'gfn1', 'gfn0', 'gfnff']);
export const SETTINGS_XTB_OPT_LEVELS = Object.freeze([
  'crude', 'sloppy', 'loose', 'lax', 'normal', 'tight', 'vtight', 'extreme',
]);

/** A fresh settings document. A missing file behaves exactly like this. */
export function defaultAppSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    engines: {
      gaussian: '',
      xtb: '',
      psi4: '',
      orca: '',
      pyscf: '',
    },
    tools: {
      crest: '',
      obabel: '',
      scorer: '',
      multiwfn: '',
      tautomer: '',
      tautomerScript: '',
      scratch: '',
    },
    runs: {
      dryRun: true,
      // 0 means "use the built-in 3600 s default", so a fresh settings file
      // does not pin a number the user never chose.
      timeoutSeconds: 0,
      maxParallel: 1,
    },
    appearance: {
      // false keeps the pre-252 behaviour: a dragged console reopens where it
      // was left. true makes the corner authoritative at every start.
      runConsoleDock: false,
    },
    projectDefaults: {
      engine: 'gaussian',
      method: 'B3LYP',
      basis: 'def2-SVP',
      memory: '4',
      memoryUnit: 'GB',
      nproc: 4,
      xtbMethod: 'gfn2',
      xtbOptLevel: 'normal',
    },
    advanced: {
      // Blank means app.getPath('userData'); a set directory holds `runs/` and
      // `queues/`. It is read when the app starts.
      dataDir: '',
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pushUnknown(errors, source, allowed, prefix) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      errors.push({ field: prefix ? `${prefix}.${key}` : key, message: `unknown setting "${key}"` });
    }
  }
}

function section(raw, key, errors) {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    errors.push({ field: key, message: `"${key}" must be an object.` });
    return {};
  }
  return value;
}

function readString(value, field, errors, { max = 4096 } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be text.' });
    return '';
  }
  const text = value.trim();
  if (text.length > max) {
    errors.push({ field, message: `must be at most ${max} characters.` });
    return text.slice(0, max);
  }
  return text;
}

function readBoolean(value, field, errors, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    errors.push({ field, message: 'must be true or false.' });
    return fallback;
  }
  return value;
}

function readInteger(value, field, errors, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    errors.push({ field, message: `must be an integer between ${min} and ${max}.` });
    return fallback;
  }
  return number;
}

function readEnum(value, field, errors, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    errors.push({ field, message: `must be one of ${allowed.join(', ')}.` });
    return fallback;
  }
  return text;
}

/**
 * Normalise a settings document.
 *
 * @returns {{ ok: boolean, settings: object, errors: Array<{field: string, message: string}> }}
 *   `settings` always has every known field (invalid values fall back to the
 *   default so a caller can still render a form); `ok` is false when anything
 *   was rejected, and `errors` says which field and why.
 */
export function normalizeAppSettings(raw) {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      settings: defaultAppSettings(),
      errors: [{ field: '', message: 'settings must be an object.' }],
    };
  }

  const errors = [];
  const topLevel = new Set(['schemaVersion', 'engines', 'tools', 'runs', 'appearance', 'projectDefaults', 'advanced']);
  pushUnknown(errors, raw, topLevel, '');

  let version = SETTINGS_SCHEMA_VERSION;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== null) {
    if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
      errors.push({ field: 'schemaVersion', message: 'must be a positive integer.' });
    } else if (raw.schemaVersion > SETTINGS_SCHEMA_VERSION) {
      errors.push({
        field: 'schemaVersion',
        message: `version ${raw.schemaVersion} is newer than this build understands (${SETTINGS_SCHEMA_VERSION}).`,
      });
    } else if (raw.schemaVersion < SETTINGS_SCHEMA_VERSION) {
      errors.push({
        field: 'schemaVersion',
        message: `version ${raw.schemaVersion} is older than this build understands (${SETTINGS_SCHEMA_VERSION}).`,
      });
    } else {
      version = raw.schemaVersion;
    }
  }

  const settings = defaultAppSettings();
  settings.schemaVersion = version;

  const engines = section(raw, 'engines', errors);
  pushUnknown(errors, engines, new Set(SETTINGS_ENGINE_IDS), 'engines');
  for (const id of SETTINGS_ENGINE_IDS) {
    settings.engines[id] = readString(engines[id], `engines.${id}`, errors);
  }

  const tools = section(raw, 'tools', errors);
  pushUnknown(errors, tools, new Set(SETTINGS_TOOL_IDS), 'tools');
  for (const id of SETTINGS_TOOL_IDS) {
    settings.tools[id] = readString(tools[id], `tools.${id}`, errors);
  }

  const runs = section(raw, 'runs', errors);
  pushUnknown(errors, runs, new Set(['dryRun', 'timeoutSeconds', 'maxParallel']), 'runs');
  settings.runs.dryRun = readBoolean(runs.dryRun, 'runs.dryRun', errors, true);
  settings.runs.timeoutSeconds = readInteger(runs.timeoutSeconds, 'runs.timeoutSeconds', errors, {
    min: 0, max: 86400, fallback: 0,
  });
  settings.runs.maxParallel = readInteger(runs.maxParallel, 'runs.maxParallel', errors, {
    min: 1, max: 64, fallback: 1,
  });

  const appearance = section(raw, 'appearance', errors);
  pushUnknown(errors, appearance, new Set(['runConsoleDock']), 'appearance');
  settings.appearance.runConsoleDock = readBoolean(
    appearance.runConsoleDock,
    'appearance.runConsoleDock',
    errors,
    false,
  );

  const defaults = section(raw, 'projectDefaults', errors);
  pushUnknown(errors, defaults, new Set([
    'engine', 'method', 'basis', 'memory', 'memoryUnit', 'nproc', 'xtbMethod', 'xtbOptLevel',
  ]), 'projectDefaults');
  settings.projectDefaults.engine = readEnum(
    defaults.engine, 'projectDefaults.engine', errors, SETTINGS_ENGINE_IDS, 'gaussian',
  );
  settings.projectDefaults.method = readString(defaults.method, 'projectDefaults.method', errors, { max: 64 }) || 'B3LYP';
  settings.projectDefaults.basis = readString(defaults.basis, 'projectDefaults.basis', errors, { max: 64 }) || 'def2-SVP';
  const memory = readString(defaults.memory, 'projectDefaults.memory', errors, { max: 16 }) || '4';
  if (!/^\d+$/.test(memory) || Number(memory) < 1 || Number(memory) > 1048576) {
    errors.push({ field: 'projectDefaults.memory', message: 'must be a number between 1 and 1048576.' });
  } else {
    settings.projectDefaults.memory = String(Number(memory));
  }
  settings.projectDefaults.memoryUnit = readEnum(
    defaults.memoryUnit, 'projectDefaults.memoryUnit', errors, SETTINGS_MEMORY_UNITS, 'GB',
  );
  settings.projectDefaults.nproc = readInteger(defaults.nproc, 'projectDefaults.nproc', errors, {
    min: 1, max: 1024, fallback: 4,
  });
  settings.projectDefaults.xtbMethod = readEnum(
    defaults.xtbMethod, 'projectDefaults.xtbMethod', errors, SETTINGS_XTB_METHODS, 'gfn2',
  );
  settings.projectDefaults.xtbOptLevel = readEnum(
    defaults.xtbOptLevel, 'projectDefaults.xtbOptLevel', errors, SETTINGS_XTB_OPT_LEVELS, 'normal',
  );

  const advanced = section(raw, 'advanced', errors);
  pushUnknown(errors, advanced, new Set(['dataDir']), 'advanced');
  settings.advanced.dataDir = readString(advanced.dataDir, 'advanced.dataDir', errors);

  return { ok: errors.length === 0, settings, errors };
}

/** Deep-merge a partial settings update over a base document. */
export function mergeAppSettings(base, patch) {
  const out = JSON.parse(JSON.stringify(isPlainObject(base) ? base : defaultAppSettings()));
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeAppSettings(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function joinPath(directory, name) {
  const base = String(directory || '').replace(/[\\/]+$/, '');
  return base ? `${base}/${name}` : name;
}

/** `settings.json` under a user-data directory. */
export function settingsPathFor(userDataDir) {
  return joinPath(userDataDir, SETTINGS_FILE_NAME);
}

/**
 * The settings file a headless `ncs` should read when `--settings` is absent.
 *
 * This mirrors Electron's `app.getPath('userData')` naming for the package
 * (`nodechem-studio`) on each platform, without importing Electron or Node
 * path helpers — the renderer bundles this module too.
 */
export function defaultSettingsPath(options = {}) {
  const env = options.env || (typeof process !== 'undefined' ? process.env : {});
  if (env.NCS_SETTINGS_PATH) return String(env.NCS_SETTINGS_PATH);
  const platform = options.platform || (typeof process !== 'undefined' ? process.platform : 'linux');
  const home = options.home || env.HOME || env.USERPROFILE || '';
  if (platform === 'win32') {
    const appData = env.APPDATA || joinPath(home, 'AppData/Roaming');
    return joinPath(joinPath(appData, 'nodechem-studio'), SETTINGS_FILE_NAME);
  }
  if (platform === 'darwin') {
    return joinPath(joinPath(home, 'Library/Application Support/nodechem-studio'), SETTINGS_FILE_NAME);
  }
  const config = env.XDG_CONFIG_HOME || joinPath(home, '.config');
  return joinPath(joinPath(config, 'nodechem-studio'), SETTINGS_FILE_NAME);
}
