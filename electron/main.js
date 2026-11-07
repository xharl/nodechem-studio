import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { RunManager } from './runner/runManager.js';
import { QueueManager } from './runner/queue.js';
import { parseProjectText, stringifyProject, summarizeErrors } from '../src/shared/projectSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isDev = process.argv.includes('--dev');
const DEV_URL = 'http://127.0.0.1:5173';

let mainWindow = null;
let runManager = null;
let queueManager = null;
let windowDirty = false;

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
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#07090d',
    title: 'Gaussian Node Studio',
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

  mainWindow.on('close', (event) => {
    if (!windowDirty) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'This project has unsaved changes.',
      detail: 'Close the window and lose them?',
    });
    if (choice === 0) event.preventDefault();
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

async function chooseExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate the licensed Gaussian executable',
    defaultPath: process.platform === 'win32' ? 'C:\\G16W\\g16.exe' : '/usr/local/g16/g16',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Gaussian for Windows', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function preflight(config = {}) {
  const checks = [];
  const dryRun = Boolean(config.dryRun);
  const executable = String(config.executable || '').trim();
  const scratchDir = String(config.scratchDir || '').trim();
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok, detail });

  add('platform', 'Operating system', ['win32', 'linux', 'darwin'].includes(process.platform),
    `${process.platform} ${os.release()}`);
  add('architecture', 'Architecture', ['x64', 'arm64'].includes(process.arch), process.arch);

  if (dryRun) {
    add('dry-run', 'Dry-run fixture', true, 'No Gaussian process will be started.');
  } else {
    add('executable', 'Gaussian executable configured', Boolean(executable), executable || 'Not configured');
    if (executable) {
      try {
        const stat = await fsp.stat(executable);
        add('executable-exists', 'Executable exists', stat.isFile(), executable);
        if (process.platform === 'win32') {
          add('executable-name', 'Windows console executable', /^g16\.exe$/i.test(path.basename(executable)),
            `Found ${path.basename(executable)}; g16w.exe is the GUI, not the runner.`);
        }
        const exeDir = path.dirname(executable);
        add('gauss-exedir', 'Gaussian executable directory readable', fs.existsSync(exeDir), exeDir);
        const l1 = path.join(exeDir, process.platform === 'win32' ? 'l1.exe' : 'l1.exe');
        add('link1-present', 'Gaussian Link 1 present', fs.existsSync(l1), l1);
      } catch (error) {
        add('executable-exists', 'Executable exists', false, error.message);
      }
    }
  }

  const runsRoot = path.join(app.getPath('userData'), 'runs');
  try {
    await fsp.mkdir(runsRoot, { recursive: true });
    await fsp.access(runsRoot, fs.constants.W_OK);
    add('run-root', 'Run directory writable', true, runsRoot);
  } catch (error) {
    add('run-root', 'Run directory writable', false, error.message);
  }

  if (scratchDir) {
    try {
      await fsp.mkdir(scratchDir, { recursive: true });
      await fsp.access(scratchDir, fs.constants.W_OK);
      add('scratch', 'Scratch directory writable', true, scratchDir);
    } catch (error) {
      add('scratch', 'Scratch directory writable', false, error.message);
    }
  } else {
    add('scratch', 'Scratch directory', true, 'Defaults to a per-run scratch folder.');
  }

  const cores = os.cpus().length;
  const memoryGb = os.totalmem() / (1024 ** 3);
  add('resources', 'Host resources detected', cores > 0,
    `${cores} logical cores · ${memoryGb.toFixed(1)} GB RAM`);

  return {
    ok: checks.every((check) => check.ok),
    dryRun,
    checks,
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cores,
      memoryGb: Number(memoryGb.toFixed(1)),
      userData: app.getPath('userData'),
    },
  };
}

async function openProject() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Gaussian Studio project',
    properties: ['openFile'],
    filters: [{ name: 'Gaussian Studio project', extensions: ['json', 'ghproject'] }],
  });
  if (result.canceled) return { canceled: true };
  const filePath = result.filePaths[0];
  const text = await fsp.readFile(filePath, 'utf8');
  const parsed = parseProjectText(text);
  if (!parsed.ok) {
    return { canceled: false, path: filePath, error: projectFailure(parsed) };
  }
  return {
    canceled: false,
    path: filePath,
    project: parsed.project,
    migrated: parsed.migrated,
    warnings: parsed.warnings,
  };
}

function suggestedProjectName(project) {
  const base = String(project?.name || 'untitled')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .slice(0, 60)
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${base || 'untitled'}.ghproject.json`;
}

async function saveProject(project, filePath) {
  const serialized = stringifyProject(project);
  if (!serialized.ok) {
    return { canceled: false, error: projectFailure(serialized) };
  }
  let target = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : null;
  if (target && !/\.json$/i.test(target)) {
    return { canceled: false, error: { message: 'A project file must end in .json.' } };
  }
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Gaussian Studio project',
      defaultPath: path.join(app.getPath('documents'), suggestedProjectName(project)),
      filters: [{ name: 'Gaussian Studio project', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    target = result.filePath;
  }
  await fsp.writeFile(target, serialized.text, 'utf8');
  return { canceled: false, path: target, project: serialized.project };
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

app.whenReady().then(async () => {
  runManager = new RunManager({
    runsRoot: path.join(app.getPath('userData'), 'runs'),
    emit: emitRunEvent,
  });
  queueManager = new QueueManager({
    queuesRoot: path.join(app.getPath('userData'), 'queues'),
    runManager,
    emit: emitQueueEvent,
  });
  await queueManager.init();

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
  }));
  ipcMain.handle('project:open', openProject);
  ipcMain.handle('project:save', (_event, project, filePath) => saveProject(project, filePath));
  ipcMain.handle('input:export', (_event, payload) => exportGaussianInput(payload));
  ipcMain.on('window:dirty', (_event, dirty) => { windowDirty = Boolean(dirty); });
  ipcMain.handle('gaussian:pick-executable', chooseExecutable);
  ipcMain.handle('gaussian:preflight', (_event, config) => preflight(config));
  ipcMain.handle('gaussian:run', (_event, payload) => runManager.start(payload));
  ipcMain.handle('gaussian:cancel', (_event, runId) => runManager.cancel(runId));
  ipcMain.handle('runs:list', () => runManager.list());
  ipcMain.handle('queue:start', (_event, payload) => queueManager.start(payload));
  ipcMain.handle('queue:pause', (_event, queueId) => queueManager.pause(queueId));
  ipcMain.handle('queue:resume', (_event, queueId) => queueManager.resume(queueId));
  ipcMain.handle('queue:cancel', (_event, queueId) => queueManager.cancel(queueId));
  ipcMain.handle('queue:list', () => queueManager.list());
  ipcMain.handle('queue:get', (_event, queueId) => queueManager.get(queueId));

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
