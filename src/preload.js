const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  modelStatus: () => ipcRenderer.invoke('model-status'),
  translatePrompt: (payload) => ipcRenderer.invoke('translate-prompt', payload),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickOutput: (payload) => ipcRenderer.invoke('pick-output', payload),
  outputExists: (outputPath) => ipcRenderer.invoke('output-exists', outputPath),
  saveDroppedFile: (name, buffer) => ipcRenderer.invoke('save-dropped-file', { name, buffer }),
  // Native drop path: File.path is deprecated and arrives empty on modern
  // Electron, so resolve it here via webUtils (preload-direct, no IPC).
  // Returns '' for content with no file on disk. The renderer already
  // handles full paths (the file picker returns them), so exposing the
  // resolved drop path changes nothing about trust.
  getDroppedPath: async (file) => {
    try {
      return webUtils && typeof webUtils.getPathForFile === 'function'
        ? (webUtils.getPathForFile(file) || '')
        : '';
    } catch { return ''; }
  },
  openPath: (dirPath) => ipcRenderer.invoke('open-path', { dirPath }),
  windowMin: () => ipcRenderer.invoke('window-min'),
  windowMax: () => ipcRenderer.invoke('window-max'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  probeMedia: (inputFile) => ipcRenderer.invoke('probe-media', inputFile),
  runFfmpeg: (payload) => ipcRenderer.invoke('run-ffmpeg', payload),
  cancelFfmpeg: () => ipcRenderer.invoke('cancel-ffmpeg'),
  downloadModel: (payload) => ipcRenderer.invoke('download-model', payload || {}),
  // Subscribe helpers return an unsubscribe function - never the emitter
  // itself (returning ipcRenderer.on(...) would hand the page full
  // invoke/send access past the allowlist).
  onModelDownload: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('model-download-progress', handler);
    return () => ipcRenderer.removeListener('model-download-progress', handler);
  },
  onLog: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('ffmpeg-log', handler);
    return () => ipcRenderer.removeListener('ffmpeg-log', handler);
  },
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('ffmpeg-progress', handler);
    return () => ipcRenderer.removeListener('ffmpeg-progress', handler);
  },
});
