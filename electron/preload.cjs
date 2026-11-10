const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  // Presence of each engine binary on PATH, for the status bar.
  engineStatus: () => ipcRenderer.invoke('engines:status'),
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
  pickExecutable: () => ipcRenderer.invoke('gaussian:pick-executable'),
  pickCrestExecutable: () => ipcRenderer.invoke('crest:pick-executable'),
  pickObabelExecutable: () => ipcRenderer.invoke('obabel:pick-executable'),
  pickToolExecutable: (tool) => ipcRenderer.invoke('tool:pick-executable', tool),
  pickEnsembleFile: () => ipcRenderer.invoke('conformers:pick-ensemble'),
  // The wavefunction viewport: a user-supplied cube (text, capped in main) and
  // the binary PNG/STL the surface viewport exports.
  pickCubeFile: () => ipcRenderer.invoke('wavefunction:pick-cube'),
  saveBinary: (payload) => ipcRenderer.invoke('file:save-binary', payload),
  preflight: (config) => ipcRenderer.invoke('gaussian:preflight', config),
  runTask: (payload) => ipcRenderer.invoke('gaussian:run', payload),
  cancelRun: (runId) => ipcRenderer.invoke('gaussian:cancel', runId),
  listRuns: () => ipcRenderer.invoke('runs:list'),
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
