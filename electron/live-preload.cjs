const { contextBridge, ipcRenderer } = require('electron')

// Bridge for the hidden windows of the live modes (cinema, music) that stream frames to the room
contextBridge.exposeInMainWorld('live', {
  room: () => ipcRenderer.invoke('live:room'),
  frame: (rgb) => ipcRenderer.send('live:frame', rgb),
  // Genre of the playing track from its title, or null when it is unknown
  onGenre: (cb) => ipcRenderer.on('live:genre', (_e, genre) => cb(genre)),
})
