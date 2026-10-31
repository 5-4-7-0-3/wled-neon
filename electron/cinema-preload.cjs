const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cinema', {
  room: () => ipcRenderer.invoke('cinema:room'),
  frame: (rgb) => ipcRenderer.send('cinema:frame', rgb),
})
