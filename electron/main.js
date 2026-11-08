import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { RunManager } from './runner/runManager.js';
import { QueueManager } from './runner/queue.js';
import { preflight } from './runner/preflight.js';
import { defaultGaussianExecutablePath } from './runner/gaussianPlatform.js';
import { writeClusterExport, importClusterExport } from './runner/clusterFiles.js';
import { writeRunBundle } from './runner/runBundle.js';
import { isSafeRunId } from '../src/shared/runBundle.js';
import { fingerprint, writeGuardDecision } from '../src/shared/projectMerge.js';
import { parseProjectText, stringifyProject, summarizeErrors } from '../src/shared/projectSchema.js';
import { buildDiagnostics } from '../src/shared/diagnostics.js';
import { datasetCsv, datasetJson, runRows } from '../src/shared/datasetExport.js';
import { BATCH_MAX_LOG_BYTES, summarizeLog } from '../src/shared/logImport.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { methodsParagraphFor } from '../src/shared/methodsParagraph.js';
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

async function chooseExecutable(config = {}) {
  const engine = engineOrDefault(config.engine);
  const isXtb = engine.id === 'xtb';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isXtb ? 'Locate the xTB executable' : 'Locate the licensed Gaussian executable',
    defaultPath: isXtb
      ? (process.platform === 'win32' ? 'C:\\xtb\\bin\\xtb.exe' : '/usr/local/bin/xtb')
      : defaultGaussianExecutablePath(process.platform),
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: isXtb ? 'xTB executable' : 'Gaussian for Windows', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
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
 */
async function exportWorkflowReport(queueId) {
  const id = String(queueId || '');
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

  const model = buildWorkflowReport(queue, records, {
    generatedAt: new Date().toISOString(),
    appVersion: currentAppInfo().version,
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

app.whenReady().then(async () => {
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
  ipcMain.handle('conformers:pick-ensemble', () => chooseEnsembleFile());
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
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save export',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: [
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
  ipcMain.handle('runs:export-dataset', (_event, format) => exportDataset(format));
  ipcMain.handle('queue:start', (_event, payload) => queueManager.start(payload));
  ipcMain.handle('queue:pause', (_event, queueId) => queueManager.pause(queueId));
  ipcMain.handle('queue:resume', (_event, queueId) => queueManager.resume(queueId));
  ipcMain.handle('queue:cancel', (_event, queueId) => queueManager.cancel(queueId));
  ipcMain.handle('queue:list', () => queueManager.list());
  ipcMain.handle('queue:get', (_event, queueId) => queueManager.get(queueId));
  ipcMain.handle('logs:import-directory', () => importLogDirectory());
  ipcMain.handle('queue:report', (_event, queueId) => exportWorkflowReport(queueId));

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
