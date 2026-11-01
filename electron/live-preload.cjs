const { contextBridge, ipcRenderer } = require('electron')

// Bridge for the hidden windows of the live modes (cinema, music) that stream frames to the room
contextBridge.exposeInMainWorld('live', {
  room: () => ipcRenderer.invoke('live:room'),
  frame: (rgb) => ipcRenderer.send('live:frame', rgb),
})
