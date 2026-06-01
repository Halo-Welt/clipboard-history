const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipAPI', {
  onHistory: (callback) => ipcRenderer.on('clipboard-history', (_, data) => callback(data)),
  pasteItem: (item) => ipcRenderer.send('paste-item', item),
  deleteItem: (timestamp) => ipcRenderer.send('delete-item', timestamp),
  clearHistory: () => ipcRenderer.send('clear-history'),
  hideWindow: () => ipcRenderer.send('hide-window')
});
