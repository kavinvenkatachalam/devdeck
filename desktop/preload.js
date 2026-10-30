// What the welcome page may ask of the app: start devdeck, or look again.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devdeckApp', {
  start: () => ipcRenderer.invoke('start'),
  retry: () => ipcRenderer.invoke('retry'),
});
