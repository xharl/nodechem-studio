const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  collectDiagnostics: (payload) => ipcRenderer.invoke('diagnostics:collect', payload),
  saveDiagnostics: (text) => ipcRenderer.invoke('diagnostics:save', text),
  openProject: () => ipcRenderer.invoke('project:open'),
  startupProject: () => ipcRenderer.invoke('project:startup'),
  openProjectPath: (filePath) => ipcRenderer.invoke('project:open-path', filePath),
  saveProject: (project, filePath) => ipcRenderer.invoke('project:save', project, filePath),
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
  preflight: (config) => ipcRenderer.invoke('gaussian:preflight', config),
  runTask: (payload) => ipcRenderer.invoke('gaussian:run', payload),
  cancelRun: (runId) => ipcRenderer.invoke('gaussian:cancel', runId),
  listRuns: () => ipcRenderer.invoke('runs:list'),
  verifyRun: (runId) => ipcRenderer.invoke('runs:verify', runId),
  exportRunBundle: (runId) => ipcRenderer.invoke('runs:export-bundle', runId),
  startQueue: (payload) => ipcRenderer.invoke('queue:start', payload),
  pauseQueue: (queueId) => ipcRenderer.invoke('queue:pause', queueId),
  resumeQueue: (queueId) => ipcRenderer.invoke('queue:resume', queueId),
  cancelQueue: (queueId) => ipcRenderer.invoke('queue:cancel', queueId),
  listQueues: () => ipcRenderer.invoke('queue:list'),
  getQueue: (queueId) => ipcRenderer.invoke('queue:get', queueId),
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
