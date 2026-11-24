const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipAPI', {
  onHistory: (callback) => ipcRenderer.on('clipboard-history', (_, data) => callback(data)),
  onShown: (callback) => ipcRenderer.on('window-shown', () => callback()),
  pasteItem: (id) => ipcRenderer.send('paste-item', id),
  copyItem: (id) => ipcRenderer.send('copy-item', id),
  deleteItem: (id) => ipcRenderer.send('delete-item', id),
  clearHistory: () => ipcRenderer.send('clear-history'),
  hideWindow: () => ipcRenderer.send('hide-window')
});
