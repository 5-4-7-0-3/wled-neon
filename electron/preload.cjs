const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('neonDesktop', {
  getHost: () => ipcRenderer.invoke('host:get'),
  findControllers: () => ipcRenderer.invoke('net:find'),
  setHost: (host) => ipcRenderer.invoke('host:set', host),
  resize: (height) => ipcRenderer.send('win:resize', height),
  hide: () => ipcRenderer.send('win:hide'),
  pin: (on) => ipcRenderer.send('win:pin', on),
  openWindow: () => ipcRenderer.send('win:open'),
  onLeave: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('win:leave', listener)
    return () => ipcRenderer.off('win:leave', listener)
  },
  onFlag: (cb) => ipcRenderer.on('flag', () => cb()),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setupChanged: () => ipcRenderer.send('setup:changed'),
})
