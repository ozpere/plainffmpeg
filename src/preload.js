const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  modelStatus: () => ipcRenderer.invoke('model-status'),
  translatePrompt: (payload) => ipcRenderer.invoke('translate-prompt', payload),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickOutput: (payload) => ipcRenderer.invoke('pick-output', payload),
  outputExists: (outputPath) => ipcRenderer.invoke('output-exists', outputPath),
  saveDroppedFile: (name, buffer) => ipcRenderer.invoke('save-dropped-file', { name, buffer }),
  windowMin: () => ipcRenderer.invoke('window-min'),
  windowMax: () => ipcRenderer.invoke('window-max'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  probeMedia: (inputFile) => ipcRenderer.invoke('probe-media', inputFile),
  runFfmpeg: (payload) => ipcRenderer.invoke('run-ffmpeg', payload),
  onLog: (cb) => ipcRenderer.on('ffmpeg-log', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('ffmpeg-progress', (_e, p) => cb(p)),
});
