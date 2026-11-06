const { contextBridge, ipcRenderer } = require('electron')

// Bridge for the hidden windows of the live modes (cinema, music, game) that stream frames to the room
contextBridge.exposeInMainWorld('live', {
  room: () => ipcRenderer.invoke('live:room'),
  // The user's tuning of this mode: bright, smooth and effects, 1 being as designed
  settings: () => ipcRenderer.invoke('live:settings'),
  frame: (rgb) => ipcRenderer.send('live:frame', rgb),
  // Genre of the playing track from its title, or null when it is unknown
  onGenre: (cb) => ipcRenderer.on('live:genre', (_e, genre) => cb(genre)),
  // Whether Windows says some app is playing media right now
  onPlaying: (cb) => ipcRenderer.on('live:playing', (_e, playing) => cb(playing)),
  // Profile of the running game (e.g. "deathStranding"), or null
  onProfile: (cb) => ipcRenderer.on('live:profile', (_e, profile) => cb(profile)),
  // Game buttons pressed while the game is in front: a scan, or holding the breath starting/ending
  onInput: (cb) => ipcRenderer.on('live:input', (_e, event) => cb(event)),
})
