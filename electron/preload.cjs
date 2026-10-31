const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('neonDesktop', {
  getHost: () => ipcRenderer.invoke('host:get'),
  setHost: (host) => ipcRenderer.invoke('host:set', host),
  resize: (height) => ipcRenderer.send('win:resize', height),
  hide: () => ipcRenderer.send('win:hide'),
})
