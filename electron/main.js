import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { RunManager } from './runner/runManager.js';
import { QueueManager } from './runner/queue.js';
import { companionToolStatus } from './runner/companionTools.js';
import { preflight } from './runner/preflight.js';
import { defaultGaussianExecutablePath } from './runner/gaussianPlatform.js';
import { writeClusterExport, importClusterExport } from './runner/clusterFiles.js';
import { writeRunBundle } from './runner/runBundle.js';
import { isSafeRunId } from '../src/shared/runBundle.js';
import { fingerprint, writeGuardDecision } from '../src/shared/projectMerge.js';
import { MAX_PROJECT_BYTES, parseProjectText, stringifyProject, summarizeErrors } from '../src/shared/projectSchema.js';
import { createRecentStore, enginesForProject, pathKey } from '../src/shared/recentProjects.js';
import { buildDiagnostics } from '../src/shared/diagnostics.js';
import { checkForUpdate } from '../src/shared/updateCheck.js';
import { datasetCsv, datasetJson, runRows } from '../src/shared/datasetExport.js';
import { BATCH_MAX_LOG_BYTES, summarizeLog } from '../src/shared/logImport.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { methodsParagraphFor } from '../src/shared/methodsParagraph.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { convertParsed, convertWavefunctionFile } from '../src/shared/converters/index.js';
import { figureInputsFor, normaliseFigureLevel } from '../src/shared/report.js';
import {
  PROJECT_EXTENSIONS,
  classifySavePath,
  isProjectPath,
  projectFileName,
  withProjectExtension,
} from '../src/shared/projectFile.js';
import { ENGINES, engineOrDefault } from '../src/shared/engines/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isDev = process.argv.includes('--dev');
const DEV_URL = 'http://127.0.0.1:5173';
// Injected by the build (`scripts/stamp-build-info.mjs`) or by the launch
// environment. No git call and no network at runtime.
function packagedCommit() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    return String(info?.commit || '').trim();
  } catch {
    return '';
  }
}

const APP_COMMIT = String(process.env.GIT_COMMIT || '').trim() || packagedCommit() || 'unknown';

/**
 * The single description of this build. `app:info` and the diagnostics bundle
 * must agree; deriving both from one function prevents the About chip and a
 * bug report from disagreeing about which build produced the problem.
 */
/**
 * Which engine binaries this machine can actually launch, for the status bar.
 *
 * Presence on PATH only — a version probe would spawn every engine at startup.
 * The run console still does the real preflight (architecture, parameter files,
 * executable name) before anything is queued.
 */
const ENGINE_BINARIES = Object.freeze({
  xtb: ['xtb'],
  psi4: ['psi4'],
  gaussian: ['g16', 'g09'],
  orca: ['orca'],
});

function engineStatus() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const findOnPath = (names) => {
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // not here; keep looking
        }
      }
    }
    return null;
  };
  const status = {};
  for (const [engine, names] of Object.entries(ENGINE_BINARIES)) {
    const found = findOnPath(names);
    status[engine] = { ok: Boolean(found), path: found };
  }
  return status;
}

function currentAppInfo() {
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    commit: APP_COMMIT,
  };
}

/** Normalize a CLI/desktop file argument; `%U` may hand us a file:// URL. */
function projectPathFromArg(arg) {
  let value = typeof arg === 'string' ? arg.trim() : '';
  if (!value) return '';
  if (value.startsWith('file://')) {
    try {
      value = fileURLToPath(value);
    } catch {
      return '';
    }
  }
  return isProjectPath(value) ? path.resolve(value) : '';
}

/** A double-clicked `.ncs` arrives as argv on Windows/Linux (and open-file on macOS). */
function projectPathFromArgv(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const projectPath = projectPathFromArg(arg);
    if (projectPath) return projectPath;
  }
  return null;
}

let startupProjectPath = projectPathFromArgv(process.argv);

app.on('open-file', (event, filePath) => {
  if (!isProjectPath(filePath)) return;
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('project:open-path', filePath);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    startupProjectPath = path.resolve(filePath);
  }
});

// Electron derives the userData folder from the package name, but pin it
// explicitly so the storage location is a documented constant of the format
// rather than an implicit side effect of the package name.
const USER_DATA_DIR = path.join(app.getPath('appData'), 'nodechem-studio');
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath('userData', USER_DATA_DIR);

/**
 * Recent projects (issue 149). The renderer never reads or writes this file; it asks
 * for the list, and main only opens a path that is already in the list. That is
 * what keeps the menu from becoming a way to make main read an arbitrary file.
 */
function canonicalProjectPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    // A path that does not exist yet (a Save As target) has no realpath.
    return path.resolve(filePath);
  }
}

const recentProjects = createRecentStore({
  filePath: path.join(USER_DATA_DIR, 'recent-projects.json'),
  fs,
  platform: process.platform,
  canonical: canonicalProjectPath,
});

/**
 * Refresh one row's name/engines from the file itself, so a project renamed on
 * disk is not described by a stale menu entry. Parse failures return null and
 * the recorded values stand; nothing is invented.
 */
function readRecentProjectMetadata(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_PROJECT_BYTES) return null;
    const parsed = parseProjectText(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.ok) return null;
    return { name: parsed.project.name, engines: enginesForProject(parsed.project) };
  } catch {
    return null;
  }
}

function recentProjectRows() {
  return recentProjects.view({ readProject: readRecentProjectMetadata });
}

/** Record a successful open or save; a failed list write must not fail the open. */
function rememberRecentProject(target, project) {
  try {
    recentProjects.record({
      path: target,
      name: project?.name || '',
      engines: enginesForProject(project),
      openedAt: Date.now(),
    });
  } catch {
    // The project is open either way; the next successful record repairs the list.
  }
}

/**
 * Open a recent entry. Only a path main itself recorded is accepted — the
 * renderer cannot turn this channel into an arbitrary file read.
 */
async function openRecentProject(filePath) {
  const requested = typeof filePath === 'string' ? filePath.trim() : '';
  const known = requested
    ? recentProjects.entries().some((entry) => pathKey(entry.path, process.platform) === pathKey(requested, process.platform))
    : false;
  if (!known) {
    return { canceled: false, error: { message: 'That project is not in the recent list.' } };
  }
  return readProjectFile(requested);
}

/** Reveal only a project this window opened or saved, not any path asked for. */
function revealProject(filePath) {
  const target = typeof filePath === 'string' ? filePath.trim() : '';
  const recorded = target && (
    knownProjectHashes.has(target)
    || recentProjects.entries().some((entry) => pathKey(entry.path, process.platform) === pathKey(target, process.platform))
  );
  if (!recorded) {
    return { ok: false, error: { message: 'Only a project this window opened can be shown in the file manager.' } };
  }
  if (!isProjectPath(target) || !fs.existsSync(target)) {
    return { ok: false, error: { message: 'That project file is no longer on disk.' } };
  }
  shell.showItemInFolder(target);
  return { ok: true, path: target };
}

let mainWindow = null;
/**
 * Launch cache for the theme (#52). The renderer owns the preference in
 * localStorage; this file only lets the native window paint the right colour
 * before the renderer exists, so a light theme never flashes black.
 */
const THEME_CACHE = { mode: 'current', resolved: 'current' };
const THEME_WINDOW_COLOUR = { current: '#07090d', graphite: '#0A0B0D', paper: '#F6F3EC' };

function themeCachePath() {
  return path.join(USER_DATA_DIR, 'preferences.json');
}

function readThemeCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(themeCachePath(), 'utf8'));
    if (parsed && typeof parsed.theme === 'object' && parsed.theme) {
      if (typeof parsed.theme.mode === 'string') THEME_CACHE.mode = parsed.theme.mode;
      if (THEME_WINDOW_COLOUR[parsed.theme.resolved]) THEME_CACHE.resolved = parsed.theme.resolved;
    }
  } catch {
    // No cache yet: the defaults above match the shipped look.
  }
}

function writeThemeCache(payload) {
  const record = {
    version: 1,
    theme: { mode: String(payload?.mode || 'current'), resolved: THEME_WINDOW_COLOUR[payload?.resolved] ? payload.resolved : 'current' },
  };
  try {
    fs.writeFileSync(themeCachePath(), JSON.stringify(record, null, 2));
  } catch {
    // A read-only profile must not break the window.
  }
}

let runManager = null;
let queueManager = null;
let windowDirty = false;

/**
 * Close guard state. Closing is the last chance to lose a session's work, so
 * the close handler never lets the window go while the renderer reports unsaved
 * changes — unless the user explicitly discards them.
 *
 * `allowClose` is the one-shot permission the handler checks first: it is set
 * only after an explicit discard or after the renderer confirms the save, which
 * is what keeps our own `window.close()` from re-entering the dialog.
 * `closeSavePending` stops a second close attempt from stacking another
 * save request while the renderer is still saving.
 */
let allowClose = false;
let closeSavePending = false;
let closeSaveTimer = null;

/** How long to wait for the renderer's save before letting the user retry. */
const CLOSE_SAVE_TIMEOUT_MS = 20000;

/**
 * A cube the viewport will accept. The parser's own limit is 64 MB of text;
 * refusing here says so before the file crosses the bridge, and the number is
 * deliberately the same one `cubeFile.js` uses.
 */
const CUBE_PICK_MAX_BYTES = 64 * 1024 * 1024;

function emitRunEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gaussian:event', event);
  }
}

function emitQueueEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue:event', event);
  }
}

function createWindow() {
  readThemeCache();
  // Each window starts unguarded: a previous window's permission to close must
  // never carry over (macOS keeps the app alive after the last close), and the
  // stale dirty flag belongs to the window that owned it.
  allowClose = false;
  closeSavePending = false;
  windowDirty = false;
  clearTimeout(closeSaveTimer);
  closeSaveTimer = null;

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: THEME_WINDOW_COLOUR[THEME_CACHE.resolved],
    title: 'NodeChem Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(ROOT, 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  /**
   * Three-way close guard. The renderer owns the project and the native save
   * dialog, so "Save" cannot be performed here: the handler refuses the close,
   * asks the renderer to run its normal save flow, and waits for
   * `window:close-result` before closing for real.
   */
  mainWindow.on('close', (event) => {
    if (allowClose || !windowDirty) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Save', "Don't save"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      title: 'Unsaved changes',
      message: 'This project has unsaved changes.',
      detail: 'Save them before closing?',
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
    if (choice === 2) {
      // Explicit discard: let this close through without asking again.
      allowClose = true;
      return;
    }
    // Anything that is not an explicit "Save" (including a dialog dismissed
    // without a choice) keeps the window: silence must never mean discard.
    event.preventDefault();
    if (choice !== 1 || closeSavePending) return;
    closeSavePending = true;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('app:save-and-close');
    // A renderer that never answers (a wedged save) must not lock the window
    // shut forever. Dropping the flag only re-arms the dialog; it never closes
    // anything on its own, so nothing is lost by the timeout.
    clearTimeout(closeSaveTimer);
    closeSaveTimer = setTimeout(() => {
      closeSavePending = false;
      closeSaveTimer = null;
    }, CLOSE_SAVE_TIMEOUT_MS);
  });
}

function projectFailure(error) {
  return {
    code: 'invalid-project',
    message: summarizeErrors(error.errors),
    errors: error.errors,
    warnings: error.warnings,
  };
}

const EXECUTABLE_DIALOG = Object.freeze({
  gaussian: {
    title: 'Locate the licensed Gaussian executable',
    windowsDefault: () => defaultGaussianExecutablePath('win32'),
    windowsFilter: 'Gaussian for Windows',
  },
  xtb: {
    title: 'Locate the xTB executable',
    windowsDefault: () => 'C:\\xtb\\bin\\xtb.exe',
    windowsFilter: 'xTB executable',
  },
  psi4: {
    title: 'Locate the Psi4 executable',
    windowsDefault: () => 'C:\\Psi4\\bin\\psi4.exe',
    windowsFilter: 'Psi4 for Windows',
  },
  orca: {
    title: 'Locate the ORCA driver',
    windowsDefault: () => 'C:\\ORCA\\orca.exe',
    windowsFilter: 'ORCA for Windows',
  },
});

async function chooseExecutable(config = {}) {
  const engine = engineOrDefault(config.engine);
  const copy = EXECUTABLE_DIALOG[engine.id] || EXECUTABLE_DIALOG.gaussian;
  const posixDefault = engine.id === 'xtb' ? '/usr/local/bin/xtb'
    : engine.id === 'orca' ? '/opt/orca/orca'
      : engine.id === 'psi4' ? '/opt/conda/bin/psi4'
        : defaultGaussianExecutablePath(process.platform);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: copy.title,
    defaultPath: process.platform === 'win32' ? copy.windowsDefault() : posixDefault,
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: copy.windowsFilter, extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function chooseCrestExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate the CREST executable',
    defaultPath: process.platform === 'win32' ? 'C:\\crest\\crest.exe' : '/usr/local/bin/crest',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'CREST for Windows', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function chooseObabelExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate the Open Babel executable (obabel)',
    defaultPath: process.platform === 'win32'
      ? 'C:\\ProgramData\\miniforge3\\Library\\bin\\obabel.exe'
      : '/usr/local/bin/obabel',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Open Babel for Windows', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

/**
 * Issue #258: the optional scorer and tautomer sidecar are executable
 * programs, not presets, so they share one picker. The dialog is only a
 * fallback for a machine where detection found nothing.
 */
const COMPANION_DIALOG = Object.freeze({
  scorer: {
    title: 'Locate the ML scorer executable',
    windows: 'C:\\scorer\\aimnet2-scorer.exe',
    posix: '/opt/scorer/aimnet2-scorer',
  },
  tautomer: {
    title: 'Locate the tautomer sidecar interpreter',
    windows: 'C:\\Python\\python.exe',
    posix: '/usr/bin/python3',
  },
  multiwfn: {
    title: 'Locate the Multiwfn executable (version 3.8)',
    windows: 'C:\\Multiwfn\\Multiwfn.exe',
    posix: '/opt/Multiwfn/Multiwfn',
  },
});

async function chooseCompanionExecutable(tool) {
  const copy = COMPANION_DIALOG[tool] || COMPANION_DIALOG.scorer;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: copy.title,
    defaultPath: process.platform === 'win32' ? copy.windows : copy.posix,
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Executables', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function chooseEnsembleFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a multi-XYZ conformer ensemble',
    properties: ['openFile'],
    filters: [{ name: 'XYZ files', extensions: ['xyz', 'trj'] }, { name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function readProjectFile(filePath) {
  const target = projectPathFromArg(filePath);
  if (!target) {
    return { canceled: false, error: { message: `A project file must end in ${PROJECT_EXTENSIONS[0]}.` } };
  }
  try {
    const text = await fsp.readFile(target, 'utf8');
    knownProjectHashes.set(target, fingerprint(text));
    const parsed = parseProjectText(text);
    if (!parsed.ok) {
      return { canceled: false, path: target, error: projectFailure(parsed) };
    }
    // issue 149: a successful read is what "recent" means — the list is not touched
    // by a failed parse, so it never points at something this app could not open.
    rememberRecentProject(target, parsed.project);
    return {
      canceled: false,
      path: target,
      project: parsed.project,
      migrated: parsed.migrated,
      warnings: parsed.warnings,
    };
  } catch (error) {
    return { canceled: false, error: { message: `Could not read ${target}: ${error.message}` } };
  }
}

async function openProject() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open NodeChem Studio project',
    properties: ['openFile'],
    filters: [{ name: 'NodeChem Studio project', extensions: PROJECT_EXTENSIONS }],
  });
  if (result.canceled) return { canceled: true };
  return readProjectFile(result.filePaths[0]);
}

function suggestedProjectName(project) {
  return projectFileName(project);
}

/** Path → sha256 of the exact bytes the app last read or wrote. */
const knownProjectHashes = new Map();

async function saveProject(project, filePath) {
  const serialized = stringifyProject(project);
  if (!serialized.ok) {
    return { canceled: false, error: projectFailure(serialized) };
  }
  let target = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : null;
  const pathKind = classifySavePath(target);
  if (pathKind.kind === 'invalid') {
    return { canceled: false, error: { message: pathKind.message } };
  }
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save NodeChem Studio project',
      defaultPath: path.join(app.getPath('documents'), suggestedProjectName(project)),
      filters: [{ name: 'NodeChem Studio project', extensions: [PROJECT_EXTENSIONS[0]] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    target = withProjectExtension(result.filePath);
  }
  // Concurrency guard for a project on a shared drive: if the bytes on disk
  // are not the bytes this process last read or wrote, another editor changed
  // the file and a silent overwrite would destroy that change.
  const known = knownProjectHashes.get(target);
  const currentText = known ? await fsp.readFile(target, 'utf8').catch(() => null) : null;
  const decision = writeGuardDecision(known, currentText);
  if (!decision.allow) {
    return {
      canceled: false,
      error: {
        message: `${path.basename(target)} changed on disk since it was opened (another editor or machine). `
          + 'Reopen the project to load the current version, or save under a new name.',
      },
    };
  }
  await fsp.writeFile(target, serialized.text, 'utf8');
  knownProjectHashes.set(target, fingerprint(serialized.text));
  rememberRecentProject(target, serialized.project);
  return {
    canceled: false,
    path: target,
    project: serialized.project,
  };
}

async function exportGaussianInput({ filename, text } = {}) {
  const name = String(filename || '');
  if (!/^[A-Za-z0-9._-]+\.(gjf|com)$/i.test(name)) {
    return { canceled: false, error: { message: 'Input file name must be a safe .gjf or .com basename.' } };
  }
  const content = String(text || '');
  if (!content.trim()) return { canceled: false, error: { message: 'There is no Gaussian input to export.' } };
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    return { canceled: false, error: { message: 'Gaussian input is larger than 2 MiB.' } };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Gaussian input',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: 'Gaussian input', extensions: ['gjf'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fsp.writeFile(result.filePath, content, 'utf8');
  return { canceled: false, path: result.filePath };
}

async function exportClusterScripts({ format, files } = {}) {
  const scheduler = String(format || '');
  if (!['slurm', 'pbs'].includes(scheduler)) {
    return { canceled: false, error: { message: 'Choose either the SLURM or PBS script set.' } };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Choose a folder for the ${scheduler.toUpperCase()} script set`,
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Export here',
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    return await writeClusterExport({ parentDir: result.filePaths[0], format: scheduler, files });
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
}

async function importClusterResults() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the exported cluster folder that contains the returned outputs',
    properties: ['openDirectory'],
    buttonLabel: 'Import results',
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    return await importClusterExport({
      exportDir: result.filePaths[0],
      runsRoot: path.join(app.getPath('userData'), 'runs'),
    });
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
}

/**
 * Export one recorded run as a folder: exact input, parsed output, methods.md,
 * manifest.json and README.md. The renderer supplies only the run id; the path
 * is rebuilt here under the runs root after validating that id.
 */
async function exportRunBundle(runId) {
  const id = String(runId || '');
  if (!isSafeRunId(id)) {
    return { canceled: false, error: { message: 'Run id must be a safe run folder name.' } };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the run bundle',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Export bundle here',
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const bundleDir = path.join(result.filePaths[0], `run-bundle-${id}`);
  try {
    return await writeRunBundle({
      runDir: path.join(app.getPath('userData'), 'runs', id),
      bundleDir,
    });
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
}


/**
 * Export one run's parsed output in a format other software reads (#99).
 *
 * The converters are engine-neutral: this function hands them a parsed record
 * and nothing else, so a second engine needs no change here. A dry-run fixture
 * is refused outright — it is synthetic output, and a file on disk would not
 * carry that label any more.
 */
async function exportRunFormat(runId, formatId, spectrum) {
  const id = String(runId || '');
  if (!isSafeRunId(id)) {
    return { canceled: false, error: { message: 'Run id must be a safe run folder name.' } };
  }
  const runDir = path.join(app.getPath('userData'), 'runs', id);
  let record;
  try {
    record = JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'));
  } catch (error) {
    return { canceled: false, error: { message: `Could not read this run: ${error.message}` } };
  }
  if (record?.dryRun) {
    return {
      canceled: false,
      error: { message: 'This run is a dry-run fixture: its output is synthetic, so it is not exported.' },
    };
  }
  let converted;
  try {
    if (String(formatId) === 'molden') {
      // Molden is the one export that needs the basis, and the run record only
      // carries a summary of the checkpoint — so the file itself is read. An
      // attached artifact names it; otherwise the folder is searched, the same
      // convention `ncs cube <run-dir>` uses.
      const attached = (Array.isArray(record?.wavefunction?.artifacts) ? record.wavefunction.artifacts : [])
        .map((entry) => String(entry?.file || '').trim())
        .find((name) => /\.(fchk|fch)$/i.test(name));
      let entries = [];
      try {
        entries = await fsp.readdir(runDir);
      } catch {
        entries = [];
      }
      const checkpoint = attached && entries.includes(attached) ? attached
        : entries.filter((name) => /\.(fchk|fch)$/i.test(name)).sort((a, b) => a.localeCompare(b))[0];
      if (!checkpoint) {
        throw new Error(
          'Molden needs the basis functions and MO coefficients, which the saved output does not carry. '
          + 'This run folder holds no .fchk: run formchk -3 on the job\'s .chk, copy the .fchk beside run.json, '
          + 'and export again.',
        );
      }
      const text = await fsp.readFile(path.join(runDir, checkpoint), 'utf8');
      converted = convertWavefunctionFile(text, 'molden', { title: id, filename: checkpoint });
    } else {
      let logName = null;
      try {
        const entries = await fsp.readdir(runDir);
        const candidates = entries.filter((name) => /\.(log|out)$/i.test(name));
        if (candidates.length > 0) {
          logName = candidates.sort((a, b) => a.localeCompare(b))[0];
        }
      } catch {
        logName = null;
      }
      if (!logName) {
        return { canceled: false, error: { message: 'This run has no saved output file to convert.' } };
      }
      const text = await fsp.readFile(path.join(runDir, logName), 'utf8');
      converted = convertParsed(parseGaussianOutput(text), formatId, {
        spectrum: spectrum || 'ir',
        title: `${id}`,
        date: new Date(),
      });
    }
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }

  const target = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${converted.format}`,
    defaultPath: path.join(app.getPath('documents'), `${id}.${converted.extension}`),
    filters: [{ name: converted.format, extensions: [converted.extension] }],
  });
  if (target.canceled || !target.filePath) return { canceled: true };
  try {
    await fsp.writeFile(target.filePath, converted.text, 'utf8');
  } catch (error) {
    return { canceled: false, error: { message: `Could not write ${target.filePath}: ${error.message}` } };
  }
  return {
    canceled: false,
    path: target.filePath,
    format: converted.format,
    bytes: Buffer.byteLength(converted.text, 'utf8'),
    notes: converted.notes || [],
  };
}

/**
 * Read a folder of existing logs and return one summary row per file.
 *
 * Nothing is imported into a project: this is a read-only index so a user can
 * see what a directory contains before deciding what to open. A file larger
 * than the parse limit or unreadable is returned in `skipped` with a reason,
 * never silently dropped.
 */
async function importLogDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder of Gaussian or xTB logs',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory'],
    buttonLabel: 'Scan folder',
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const directory = result.filePaths[0];
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
  const files = entries
    .filter((entry) => entry.isFile() && /\.(log|out)$/i.test(entry.name))
    .slice(0, 500);
  const rows = [];
  const skipped = [];
  for (const file of files) {
    const full = path.join(directory, file.name);
    try {
      const stat = await fsp.stat(full);
      if (stat.size > BATCH_MAX_LOG_BYTES) {
        skipped.push({ name: file.name, reason: 'larger than the 32 MB parse limit' });
        continue;
      }
      rows.push(summarizeLog(await fsp.readFile(full, 'utf8'), { name: file.name, bytes: stat.size }));
    } catch (error) {
      skipped.push({ name: file.name, reason: error.message });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { canceled: false, directory, rows, skipped, scanned: files.length };
}

/**
 * Write one workflow report for a finished queue: a self-contained
 * `report.html` plus the `report.json` model beside it. The per-task run
 * records are read from their run folders, so the report reflects what was
 * actually written to disk rather than live renderer state.
 *
 * `figureLevel` is the window's choice of figure set (`basic`, `surfaces`,
 * `none`), mapped to the same three names `ncs report --figures` accepts. The
 * level reaches `buildWorkflowReport` as `figureLevel`; `basic` passes no extra
 * inputs, which is byte-for-byte the report the window wrote before the choice
 * existed. A window report is therefore the document a user already has unless
 * they ask for more.
 */
async function exportWorkflowReport(queueId, figureLevel = 'basic') {
  const id = String(queueId || '');
  const level = normaliseFigureLevel(figureLevel);
  if (!id) return { canceled: false, error: { message: 'No workflow queue is available yet.' } };
  let queue;
  try {
    queue = await queueManager.get(id);
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
  if (!queue) return { canceled: false, error: { message: `Workflow ${id} was not found.` } };

  const records = {};
  const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !task.runDir) continue;
    try {
      const record = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
      if (task.runId) records[task.runId] = record;
      if (task.nodeId) records[task.nodeId] = record;
    } catch {
      // A task whose run.json is unreadable stays "not reported" in the report.
    }
  }

  // `surfaces` meshes the cube files each run folder holds; `none` reads
  // nothing; `basic` is the report's own figures, as it has always been.
  let figures = { level, volumes: null, surfaces: null };
  if (level === 'surfaces') {
    figures = await figureInputsFor(queue, level);
  }

  const model = buildWorkflowReport(queue, records, {
    generatedAt: new Date().toISOString(),
    appVersion: currentAppInfo().version,
    figureLevel: figures.level,
    volumes: figures.volumes,
    surfaces: figures.surfaces,
  });

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save workflow report',
    defaultPath: path.join(app.getPath('documents'), `workflow-${id}.html`),
    filters: [{ name: 'HTML report', extensions: ['html'] }],
    buttonLabel: 'Save report',
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const html = workflowReportHtml(model, {
      methodsFor: (row) => {
        const record = records[row.runId] || records[row.nodeId] || null;
        if (!record) return null;
        const paragraph = methodsParagraphFor(record, { form: 'full' });
        return paragraph && paragraph.ok ? paragraph.markdown : null;
      },
    });
    await fsp.writeFile(result.filePath, html, 'utf8');
    const jsonPath = result.filePath.replace(/\.html?$/i, '') + '.json';
    await fsp.writeFile(jsonPath, JSON.stringify(model, null, 2), 'utf8');
    return {
      canceled: false,
      path: result.filePath,
      jsonPath,
      taskCount: model.counts.total,
      verdict: model.verdict,
      figures: figures.level,
    };
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
}

/**
 * Export every finished run as one dataset file. The rows come from the same
 * `run.json` records the results panel reads, so the export cannot disagree
 * with what the app shows. A dry run keeps its flag; a missing value is empty.
 */
async function exportDataset(format = 'csv') {
  const kind = format === 'json' ? 'json' : 'csv';
  let runs;
  try {
    runs = await runManager.list();
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
  const rows = runRows(runs);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export run dataset (${kind.toUpperCase()})`,
    defaultPath: path.join(app.getPath('documents'), `nodechem-dataset.${kind}`),
    filters: kind === 'csv'
      ? [{ name: 'CSV', extensions: ['csv'] }]
      : [{ name: 'JSON', extensions: ['json'] }],
    buttonLabel: 'Export',
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const body = kind === 'csv'
      ? datasetCsv(rows)
      : JSON.stringify(datasetJson(rows, {
        generatedAt: new Date().toISOString(),
        appVersion: currentAppInfo().version,
      }), null, 2);
    await fsp.writeFile(result.filePath, body, 'utf8');
    return { canceled: false, path: result.filePath, rowCount: rows.length, format: kind };
  } catch (error) {
    return { canceled: false, error: { message: error.message } };
  }
}

/**
 * Collect the one file a bug report needs. The renderer supplies only its
 * project summary; the build, platform and run history are read here so a
 * compromised renderer cannot mislabel the environment. Paths are passed to
 * the pure builder, which is responsible for replacing them with `~` and
 * `<userData>` before any text is produced.
 */
async function collectDiagnostics(summary = {}) {
  const info = currentAppInfo();
  let runs;
  try {
    runs = await runManager.list();
  } catch {
    // An unreadable runs folder is "not recorded", not an empty history.
    runs = undefined;
  }
  const project = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? summary.project ?? null
    : null;
  return buildDiagnostics({
    app: {
      version: info.version,
      commit: info.commit === 'unknown' ? null : info.commit,
      electron: info.electron,
      node: info.node,
      chrome: info.chrome,
    },
    platform: {
      os: os.type(),
      release: os.release(),
      arch: info.arch,
      home: os.homedir(),
      userData: info.userData,
    },
    engines: Object.values(ENGINES).map((engine) => ({
      id: engine.id,
      label: engine.label,
      inputExtension: engine.capabilities?.inputExtension,
      outputExtension: engine.capabilities?.outputExtension,
      restartArtifact: engine.capabilities?.restartArtifact,
    })),
    runs,
    project,
    generatedAt: new Date().toISOString(),
  }).markdown;
}

function diagnosticsFileName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `nodechem-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.md`;
}

/** Write exactly the text the user chose to save, at exactly the path they chose. */
async function saveDiagnostics(text) {
  const content = typeof text === 'string' ? text : '';
  if (!content.trim()) {
    return { saved: false, path: null, error: { message: 'There is no diagnostics text to save.' } };
  }
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    return { saved: false, path: null, error: { message: 'Diagnostics text is larger than 2 MiB.' } };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save NodeChem Studio diagnostics',
    defaultPath: path.join(app.getPath('documents'), diagnosticsFileName()),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false, path: null };
  try {
    await fsp.writeFile(result.filePath, content, 'utf8');
  } catch (error) {
    return { saved: false, path: result.filePath, error: { message: `Could not write ${result.filePath}: ${error.message}` } };
  }
  return { saved: true, path: result.filePath };
}

/**
 * Issue #82: the single outbound request this application makes, and only when
 * the user asks for it (the "Check for updates" action). There is no timer, no
 * startup call, no retry and no cache — a click is one request.
 *
 * Privacy: the request carries no identifier beyond a User-Agent naming the app
 * and its version, which GitHub's API requires. The response is parsed into the
 * pure comparison module and then dropped; nothing is written to disk and no
 * release is downloaded. The bounded timeout exists so a blocked network fails
 * a click instead of leaving a promise pending forever.
 */
const RELEASES_API = 'https://api.github.com/repos/xharl/nodechem-studio/releases?per_page=20';
const RELEASE_TAG_PAGE = 'https://github.com/xharl/nodechem-studio/releases/tag/';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

/** Keep only the fields the pure module reads; release bodies never cross IPC. */
function releaseFields(release) {
  if (!release || typeof release !== 'object') return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  return {
    tag_name: tag,
    html_url: typeof release.html_url === 'string'
      ? release.html_url
      : `${RELEASE_TAG_PAGE}${encodeURIComponent(tag)}`,
    published_at: release.published_at,
    prerelease: release.prerelease === true,
    draft: release.draft === true,
  };
}

async function checkForUpdates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(RELEASES_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `NodeChem-Studio/${app.getVersion()}`,
      },
    });
    if (!response.ok) return { ok: false, error: `GitHub answered ${response.status}` };
    const payload = await response.json();
    if (!Array.isArray(payload)) return { ok: false, error: 'Unexpected response from GitHub' };
    const releases = payload.map(releaseFields).filter(Boolean);
    return { ok: true, ...checkForUpdate({ currentVersion: app.getVersion(), releases }) };
  } catch (error) {
    // AbortError is the timeout; every other failure is a network or TLS one.
    // Neither is worth a stack trace in front of the user.
    return {
      ok: false,
      error: error?.name === 'AbortError' ? 'GitHub did not answer in time' : 'Could not reach GitHub',
    };
  } finally {
    clearTimeout(timer);
  }
}

app.whenReady().then(async () => {
  // No application menu on Windows/Linux: the app's own topbar carries every
  // command, and Electron's default File/Edit/View/Window menu is unbranded and
  // duplicates it (it also draws a second "View" next to the app's own). macOS
  // keeps its menu — the OS requires an app menu for Cmd+Q and the Edit roles.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  runManager = new RunManager({
    runsRoot: path.join(app.getPath('userData'), 'runs'),
    emit: emitRunEvent,
    appInfo: { version: app.getVersion(), commit: APP_COMMIT },
  });
  queueManager = new QueueManager({
    queuesRoot: path.join(app.getPath('userData'), 'queues'),
    runManager,
    emit: emitQueueEvent,
  });
  await queueManager.init();

  ipcMain.handle('app:info', () => currentAppInfo());
  // Issue #258: the engine answer keeps its shape and gains the companion
  // probes plus the platform, so one call seeds every path field in the console.
  ipcMain.handle('engines:status', () => ({
    ...engineStatus(),
    tools: companionToolStatus(),
    platform: process.platform,
  }));
  // Issue #82: one user-triggered request. Nothing else in the app calls out.
  ipcMain.handle('updates:check', () => checkForUpdates());
  // Theme switching (#52): repaint the native chrome, record the launch cache.
  // The window itself is not reloaded — the renderer swaps the token file.
  ipcMain.handle('app:set-theme', (_event, payload) => {
    const resolved = THEME_WINDOW_COLOUR[payload?.resolved] ? payload.resolved : 'current';
    THEME_CACHE.resolved = resolved;
    THEME_CACHE.mode = String(payload?.mode || 'current');
    writeThemeCache(payload);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(THEME_WINDOW_COLOUR[resolved]);
    nativeTheme.themeSource = resolved === 'paper' ? 'light' : 'dark';
    return { mode: THEME_CACHE.mode, resolved };
  });
  ipcMain.handle('diagnostics:collect', (_event, summary) => collectDiagnostics(summary));
  ipcMain.handle('diagnostics:save', (_event, text) => saveDiagnostics(text));
  ipcMain.handle('project:open', openProject);
  ipcMain.handle('project:startup', () => ({ path: startupProjectPath }));
  ipcMain.handle('project:open-path', (_event, filePath) => readProjectFile(filePath));
  ipcMain.handle('project:save', (_event, project, filePath) => saveProject(project, filePath));
  // issue 149: the recent list. `project:recent` returns entries with existence and
  // mtime, never a bare path; opening and forgetting are restricted to paths
  // main already recorded (see openRecentProject / revealProject).
  ipcMain.handle('project:recent', () => ({ entries: recentProjectRows() }));
  ipcMain.handle('project:open-recent', (_event, filePath) => openRecentProject(filePath));
  ipcMain.handle('project:forget-recent', (_event, filePath) => {
    recentProjects.forget(filePath);
    return { entries: recentProjectRows() };
  });
  ipcMain.handle('project:clear-recent', () => {
    recentProjects.clear();
    return { entries: [] };
  });
  ipcMain.handle('project:reveal', (_event, filePath) => revealProject(filePath));
  ipcMain.handle('input:export', (_event, payload) => exportGaussianInput(payload));
  ipcMain.handle('cluster:export', (_event, payload) => exportClusterScripts(payload));
  ipcMain.handle('cluster:import', () => importClusterResults());
  ipcMain.on('window:dirty', (_event, dirty) => { windowDirty = Boolean(dirty); });
  /**
   * The renderer's answer to `app:save-and-close`. `saved` is true only after
   * its save flow completed; anything else (cancelled dialog, write failure)
   * leaves the window open so the user can retry or copy their work out.
   */
  ipcMain.on('window:close-result', (event, saved) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Only the guarded window may decide its own fate.
    if (event.sender !== mainWindow.webContents) return;
    clearTimeout(closeSaveTimer);
    closeSaveTimer = null;
    closeSavePending = false;
    if (saved !== true) return;
    allowClose = true;
    mainWindow.close();
  });
  ipcMain.handle('gaussian:pick-executable', (_event, config) => chooseExecutable(config || {}));
  ipcMain.handle('crest:pick-executable', () => chooseCrestExecutable());
  ipcMain.handle('obabel:pick-executable', () => chooseObabelExecutable());
  ipcMain.handle('tool:pick-executable', (_event, tool) => chooseCompanionExecutable(tool));
  ipcMain.handle('conformers:pick-ensemble', () => chooseEnsembleFile());
  /**
   * A user-supplied volume file for the wavefunction viewport. The renderer
   * asks for text, not for a path, because it cannot read the filesystem; the
   * size cap keeps a 500 MB cube from crossing the bridge.
   */
  ipcMain.handle('wavefunction:pick-cube', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open a cube file',
      properties: ['openFile'],
      filters: [
        { name: 'Gaussian cube', extensions: ['cube', 'cub'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths?.length) return { canceled: true };
    const target = result.filePaths[0];
    try {
      const stats = await fsp.stat(target);
      if (stats.size > CUBE_PICK_MAX_BYTES) {
        return {
          canceled: false,
          error: `${path.basename(target)} is ${(stats.size / 1e6).toFixed(1)} MB; the limit is ${CUBE_PICK_MAX_BYTES / 1e6} MB.`,
        };
      }
      return { canceled: false, name: path.basename(target), text: await fsp.readFile(target, 'utf8') };
    } catch (error) {
      return { canceled: false, error: `Could not read ${path.basename(target)}: ${error.message}` };
    }
  });
  /**
   * A binary artifact (the isosurface PNG or its binary STL). Same rule as
   * `text:save`: the dialog and the write belong to the main process.
   */
  ipcMain.handle('file:save-binary', async (_event, payload) => {
    const bytes = payload?.bytes;
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) return { canceled: true };
    const buffer = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buffer.length === 0) return { canceled: true };
    const suggested = path.basename(String(payload?.suggestedName || 'export.bin')).replace(/[^A-Za-z0-9._-]/g, '_');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save export',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: suggested.endsWith('.png')
        ? [{ name: 'PNG image', extensions: ['png'] }]
        : [{ name: 'STL mesh', extensions: ['stl'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, buffer);
    return { canceled: false, path: result.filePath };
  });
  ipcMain.handle('gaussian:preflight', (_event, config) => preflight(config || {}, {
    platform: process.platform,
    env: process.env,
    userData: app.getPath('userData'),
  }));
  ipcMain.handle('gaussian:run', (_event, payload) => runManager.start(payload));
  ipcMain.handle('gaussian:cancel', (_event, runId) => runManager.cancel(runId));
  ipcMain.handle('runs:list', () => runManager.list());
  /**
   * Save a text artifact the renderer produced (the thermochemistry CSV). The
   * main process owns the dialog and the write; the renderer never touches the
   * filesystem.
   */
  ipcMain.handle('text:save', async (_event, payload) => {
    const textValue = typeof payload?.text === 'string' ? payload.text : '';
    if (!textValue) return { canceled: true };
    const suggested = path.basename(String(payload?.suggestedName || 'export.txt')).replace(/[^A-Za-z0-9._-]/g, '_');
    // The Export menu writes NWChem/GAMESS/Q-Chem decks through this handler.
    // Naming the filter matters: a save dialog opened on "Text (txt, md)" can
    // otherwise append .txt and leave a file the other program will not read.
    const deckFilter = {
      '.nw': { name: 'NWChem input', extensions: ['nw'] },
      '.inp': { name: 'GAMESS input', extensions: ['inp'] },
      '.qcin': { name: 'Q-Chem input', extensions: ['qcin'] },
    }[path.extname(suggested).toLowerCase()];
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save export',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: deckFilter
        ? [deckFilter, { name: 'All files', extensions: ['*'] }]
        : suggested.endsWith('.cube')
        // A cube written from the wavefunction card: name the format, so the
        // dialog does not open on "SVG figure" for a text volume.
        ? [{ name: 'Gaussian cube', extensions: ['cube'] }, { name: 'All files', extensions: ['*'] }]
        : [
          { name: 'SVG figure', extensions: ['svg'] },
          { name: 'Comma-separated values', extensions: ['csv'] },
          { name: 'Text', extensions: ['txt', 'md'] },
          { name: 'All files', extensions: ['*'] },
        ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, textValue, 'utf8');
    return { canceled: false, path: result.filePath };
  });
  ipcMain.handle('runs:verify', (_event, runId) => runManager.verify(runId));
  ipcMain.handle('runs:export-bundle', (_event, runId) => exportRunBundle(runId));
  ipcMain.handle('runs:export-format', (_event, payload) => exportRunFormat(
    payload?.runId,
    payload?.format,
    payload?.spectrum,
  ));
  ipcMain.handle('runs:export-dataset', (_event, format) => exportDataset(format));
  ipcMain.handle('queue:start', (_event, payload) => queueManager.start(payload));
  ipcMain.handle('queue:pause', (_event, queueId) => queueManager.pause(queueId));
  ipcMain.handle('queue:resume', (_event, queueId) => queueManager.resume(queueId));
  ipcMain.handle('queue:cancel', (_event, queueId) => queueManager.cancel(queueId));
  ipcMain.handle('queue:list', () => queueManager.list());
  ipcMain.handle('queue:get', (_event, queueId) => queueManager.get(queueId));
  ipcMain.handle('logs:import-directory', () => importLogDirectory());
  ipcMain.handle('queue:report', (_event, queueId, figureLevel) => exportWorkflowReport(queueId, figureLevel));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  runManager?.cancelAll();
});
