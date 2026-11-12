const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  // Issue #375: one fire-and-forget mark for the first painted frame. It is
  // diagnostics only; main ignores it if the sender is not the window.
  reportStartup: (mark) => ipcRenderer.send('app:startup-mark', mark),
  // Presence of each engine binary on PATH, for the status bar.
  engineStatus: () => ipcRenderer.invoke('engines:status'),
  // Issue #252: machine/app settings stored outside every project.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  settingsPath: () => ipcRenderer.invoke('settings:path'),
  detectSettings: () => ipcRenderer.invoke('settings:detect'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  collectDiagnostics: (payload) => ipcRenderer.invoke('diagnostics:collect', payload),
  saveDiagnostics: (text) => ipcRenderer.invoke('diagnostics:save', text),
  openProject: () => ipcRenderer.invoke('project:open'),
  startupProject: () => ipcRenderer.invoke('project:startup'),
  openProjectPath: (filePath) => ipcRenderer.invoke('project:open-path', filePath),
  saveProject: (project, filePath) => ipcRenderer.invoke('project:save', project, filePath),
  // Recent projects (issue 149): the list, opening one of its recorded paths, and
  // forgetting/clearing. Main validates every path against that list.
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  openRecentProject: (filePath) => ipcRenderer.invoke('project:open-recent', filePath),
  forgetRecentProject: (filePath) => ipcRenderer.invoke('project:forget-recent', filePath),
  clearRecentProjects: () => ipcRenderer.invoke('project:clear-recent'),
  revealProject: (filePath) => ipcRenderer.invoke('project:reveal', filePath),
  exportInput: (payload) => ipcRenderer.invoke('input:export', payload),
  exportCluster: (payload) => ipcRenderer.invoke('cluster:export', payload),
  importCluster: () => ipcRenderer.invoke('cluster:import'),
  setDirty: (dirty) => ipcRenderer.send('window:dirty', Boolean(dirty)),
  // Close guard: main asks the renderer to save, and the renderer answers with
  // exactly one of these. Both are fire-and-forget sends — main owns the window.
  confirmClose: () => ipcRenderer.send('window:close-result', true),
  cancelClose: () => ipcRenderer.send('window:close-result', false),
  onSaveAndClose: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:save-and-close', handler);
    return () => ipcRenderer.removeListener('app:save-and-close', handler);
  },
  pickExecutable: (payload) => ipcRenderer.invoke('gaussian:pick-executable', payload),
  pickCrestExecutable: () => ipcRenderer.invoke('crest:pick-executable'),
  pickObabelExecutable: () => ipcRenderer.invoke('obabel:pick-executable'),
  pickToolExecutable: (tool) => ipcRenderer.invoke('tool:pick-executable', tool),
  // ADR 0003 §2.1: probe the chemistry interpreter once and report the RDKit
  // version plus any capability the build lacks.
  probeChemistry: (payload) => ipcRenderer.invoke('chem:probe', payload),
  // ADR 0003 §3.4: a validated SVG for the results panel (main owns the sidecar).
  depictChemistry: (payload) => ipcRenderer.invoke('chem:depict', payload),
  pickEnsembleFile: () => ipcRenderer.invoke('conformers:pick-ensemble'),
  // The wavefunction viewport: a user-supplied cube (text, capped in main) and
  // the binary PNG/STL the surface viewport exports.
  pickCubeFile: () => ipcRenderer.invoke('wavefunction:pick-cube'),
  saveBinary: (payload) => ipcRenderer.invoke('file:save-binary', payload),
  preflight: (config) => ipcRenderer.invoke('gaussian:preflight', config),
  runTask: (payload) => ipcRenderer.invoke('gaussian:run', payload),
  cancelRun: (runId) => ipcRenderer.invoke('gaussian:cancel', runId),
  listRuns: () => ipcRenderer.invoke('runs:list'),
  // Issue #371: full records for exactly the ids a consumer asks for.
  getRunRecords: (ids) => ipcRenderer.invoke('runs:records', ids),
  saveText: (payload) => ipcRenderer.invoke('text:save', payload),
  verifyRun: (runId) => ipcRenderer.invoke('runs:verify', runId),
  exportRunBundle: (runId) => ipcRenderer.invoke('runs:export-bundle', runId),
  exportRunFormat: (runId, format, spectrum) => ipcRenderer.invoke('runs:export-format', { runId, format, spectrum }),
  exportDataset: (format) => ipcRenderer.invoke('runs:export-dataset', format),
  startQueue: (payload) => ipcRenderer.invoke('queue:start', payload),
  pauseQueue: (queueId) => ipcRenderer.invoke('queue:pause', queueId),
  resumeQueue: (queueId) => ipcRenderer.invoke('queue:resume', queueId),
  cancelQueue: (queueId) => ipcRenderer.invoke('queue:cancel', queueId),
  setTheme: (payload) => ipcRenderer.invoke('app:set-theme', payload),
  listQueues: () => ipcRenderer.invoke('queue:list'),
  getQueue: (queueId) => ipcRenderer.invoke('queue:get', queueId),
  exportWorkflowReport: (queueId, figureLevel) => ipcRenderer.invoke('queue:report', queueId, figureLevel),
  // Progress for a report build: main sends phase/done/total/fraction while the
  // report is assembled, then `phase: 'done'`.
  onReportProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('queue:report-progress', handler);
    return () => ipcRenderer.removeListener('queue:report-progress', handler);
  },
  importLogDirectory: () => ipcRenderer.invoke('logs:import-directory'),
  onRunEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('gaussian:event', handler);
    return () => ipcRenderer.removeListener('gaussian:event', handler);
  },
  onQueueEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('queue:event', handler);
    return () => ipcRenderer.removeListener('queue:event', handler);
  },
  onOpenProjectPath: (callback) => {
    const handler = (_event, filePath) => callback(filePath);
    ipcRenderer.on('project:open-path', handler);
    return () => ipcRenderer.removeListener('project:open-path', handler);
  },
});
