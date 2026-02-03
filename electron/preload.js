const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startDrag: (files, driveId) => ipcRenderer.send('ondragstart', files, driveId)
});