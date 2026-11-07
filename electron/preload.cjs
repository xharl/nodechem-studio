const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ipcRenderer.invoke('app:info'),
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (project, filePath) => ipcRenderer.invoke('project:save', project, filePath),
  exportInput: (payload) => ipcRenderer.invoke('input:export', payload),
  setDirty: (dirty) => ipcRenderer.send('window:dirty', Boolean(dirty)),
  pickExecutable: () => ipcRenderer.invoke('gaussian:pick-executable'),
  preflight: (config) => ipcRenderer.invoke('gaussian:preflight', config),
  runTask: (payload) => ipcRenderer.invoke('gaussian:run', payload),
  cancelRun: (runId) => ipcRenderer.invoke('gaussian:cancel', runId),
  listRuns: () => ipcRenderer.invoke('runs:list'),
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
});
