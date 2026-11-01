const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, session, desktopCapturer } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const dgram = require('node:dgram')
const { ringIcon } = require('./icon.cjs')

if (!app.requestSingleInstanceLock()) app.quit()

const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : null
const START_HIDDEN = process.argv.includes('--hidden')
const WIDTH = 360

const cfgFile = () => path.join(app.getPath('userData'), 'config.json')
let cfg = { host: '192.168.1.12', autostartSet: false, anthem: true }

// The room as measured on the strip, in the controller's LED order (its LED map starts in the
// middle of the right short wall). Each wall: first LED, LED count and the direction the strip
// runs. The screen wall runs from the picture's left edge to its right with the monitor centre at
// `center`; side walls run from the screen towards the bed; `bed` is the stretch above the bed.
const ROOM = {
  len: 136,
  screen: { start: 54, count: 43, step: -1, center: 21 },
  left: { start: 55, count: 26, step: 1 },
  right: { start: 11, count: 25, step: -1 },
  bed: { start: 82, count: 17 },
}

function loadConfig() {
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }
  } catch {
    // First run: keep defaults
  }
}

function saveConfig() {
  fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2))
}

let tray
let win
let light = { on: false, col: [255, 160, 60] }
let online = false
let lastHidden = 0

// ---- Controller connection (tray icon + menu live in the main process) ----

let ws, retry
function connect() {
  clearTimeout(retry)
  ws?.close()
  const sock = new WebSocket(`ws://${cfg.host}/ws`)
  ws = sock
  sock.onopen = () => { online = true; refreshTray() }
  sock.onmessage = (e) => {
    try {
      const s = JSON.parse(e.data).state
      if (!s) return
      light = { on: s.on, col: s.seg?.[0]?.col?.[0]?.slice(0, 3) ?? light.col }
      refreshTray()
      const mode = s.on ? (s.seg?.[0]?.n ?? '').split(';').find((t) => LIVE_MODES.includes(t)) : undefined
      if (mode !== liveMode) setLive(mode)
    } catch {
      // Non-JSON frames are not state updates
    }
  }
  sock.onclose = () => {
    if (ws !== sock) return
    online = false
    refreshTray()
    retry = setTimeout(connect, 3000)
  }
}

function send(patch) {
  fetch(`http://${cfg.host}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {})
}

// ---- Live modes: paint the room from the screen (cinema) or the sound (music) ----

// Each mode is a hidden window (electron/<mode>.html) that streams finished frames back here
const LIVE_MODES = ['cinema', 'music']
let liveMode, liveWin, udp

function setLive(mode) {
  liveWin?.destroy()
  liveWin = undefined
  udp?.close()
  udp = undefined
  liveMode = mode
  if (!mode) {
    // Leave realtime mode right away instead of waiting for the controller's timeout
    send({ live: false })
    return
  }
  udp = dgram.createSocket('udp4')
  liveWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'live-preload.cjs'),
      backgroundThrottling: false,
      // Nobody clicks in a hidden window, and the music mode's audio must start on its own
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  liveWin.loadFile(path.join(__dirname, `${mode}.html`))
  liveWin.webContents.on('did-finish-load', () => liveWin?.webContents.send('live:genre', genre))
}

ipcMain.handle('live:room', () => ROOM)
ipcMain.on('live:frame', (_e, rgb) => {
  if (!udp) return
  // WLED "DRGB" realtime packet: protocol 2, then seconds to hold the frame if the stream stops
  udp.send(Buffer.concat([Buffer.from([2, 2]), Buffer.from(rgb)]), 21324, cfg.host)
})

// ---- Genre of the playing track, for the music mode's colours ----

// Rap styles, checked against an artist's tags in the order the tags are ranked
const RAP_STYLES = [
  [/phonk/i, 'phonk'],
  [/drill/i, 'drill'],
  [/lo-?fi|chillhop|instrumental hip.?hop/i, 'lofi'],
  [/cloud rap|emo|melodic rap|pop rap/i, 'cloud'],
  [/boom.?bap|east coast|golden age|conscious|jazz rap|hardcore hip.?hop/i, 'boombap'],
  [/trap|southern hip.?hop|crunk/i, 'trap'],
]
const RAP = /hip.?hop|rap/i

// Genre names (Deezer's and MusicBrainz') folded into the palettes the music mode knows
const GENRES = [
  [/metal/i, 'metal'],
  [/electro|dance|techno|house|edm|trance|drum/i, 'electro'],
  [/rap|hip.?hop|trap/i, 'hiphop'],
  [/r&b|soul|funk/i, 'rnb'],
  [/rock|alternative|indie|punk/i, 'rock'],
  [/jazz|blues/i, 'jazz'],
  [/classical|film|games|score|soundtrack/i, 'classical'],
  [/reggae|latin|reggaeton|african/i, 'latin'],
  [/folk|country|acoustic/i, 'folk'],
  [/ambient|chill|lounge|relax|new age/i, 'chill'],
  [/pop/i, 'pop'],
]

let trackKey, genre = null
const genreCache = new Map()
const artistCache = new Map()

// Video titles carry noise like "(Official Video)" or "| Lyrics"; channel names end in VEVO or
// " - Topic". Searching with that left in finds nothing.
function searchText({ title, artist }) {
  const clean = (t) => t
    .replace(/\(.*?\)|\[.*?\]|【.*?】/g, ' ')
    .replace(/\|.*$/, ' ')
    .replace(/\b(official|music video|video|lyrics?|audio|hd|4k|remaster(ed)?)\b/gi, ' ')
    .replace(/\s(ft|feat)\.?\s.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const channel = clean((artist ?? '').replace(/vevo$|\s-\stopic$/i, ''))
  const what = clean(title ?? '')
  // "Artist - Title" in the title names the artist better than the channel does
  const [named, song] = what.includes(' - ') ? what.split(' - ', 2) : [channel, what]
  const who = named.split(/,|&|\sx\s/i)[0].trim()
  return { who, text: who ? `${who} ${song}` : song }
}

// MusicBrainz: community genres and tags of the artist, which name rap styles that Deezer
// lumps together. Its rules ask for a descriptive User-Agent and at most one request a second.
const MB = { headers: { 'User-Agent': 'Neon/0.1 (https://github.com/5-4-7-0-3/wled-neon)' } }
let mbQueue = Promise.resolve()

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

// Requests go one after another with a gap, and a busy reply (503) is tried once more after a
// pause; a refusal throws so it is not cached as "no genre"
function mb(url) {
  const call = mbQueue.then(async () => {
    let res = await fetch(url, MB)
    if (res.status === 503) {
      await wait(3000)
      res = await fetch(url, MB)
    }
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`)
    return res.json()
  })
  mbQueue = call.catch(() => {}).then(() => wait(1500))
  return call
}

async function artistGenre(who) {
  if (!who) return null
  if (artistCache.has(who)) return artistCache.get(who)
  const found = await mb(`https://musicbrainz.org/ws/2/artist/?fmt=json&limit=1&query=${encodeURIComponent(`artist:"${who}"`)}`)
  const hit = found.artists?.[0]
  let result = null
  if (hit && hit.score >= 90) {
    const info = await mb(`https://musicbrainz.org/ws/2/artist/${hit.id}?fmt=json&inc=genres+tags`)
    const tags = [...(info.genres ?? []), ...(info.tags ?? [])].sort((a, b) => b.count - a.count).map((t) => t.name)
    const style = tags.map((t) => RAP_STYLES.find(([re]) => re.test(t))?.[1]).find(Boolean)
    if (style) result = style
    else if (tags.some((t) => RAP.test(t))) result = 'hiphop'
    else result = tags.map((t) => GENRES.find(([re]) => re.test(t))?.[1]).find(Boolean) ?? null
  }
  artistCache.set(who, result)
  return result
}

async function deezerGenre(text) {
  const found = await fetch(`https://api.deezer.com/search?limit=1&q=${encodeURIComponent(text)}`).then((r) => r.json())
  const album = found.data?.[0]?.album?.id
  if (!album) return null
  const info = await fetch(`https://api.deezer.com/album/${album}`).then((r) => r.json())
  const names = (info.genres?.data ?? []).map((g) => g.name).join(' ')
  return GENRES.find(([re]) => re.test(names))?.[1] ?? null
}

function lookUpGenre(session) {
  const q = session ? searchText(session) : { who: '', text: '' }
  const key = q.text
  if (key === trackKey) return
  trackKey = key
  const done = (g) => {
    if (key !== trackKey) return
    genre = g
    liveWin?.webContents.send('live:genre', genre)
  }
  if (!key) return done(null)
  if (genreCache.has(key)) return done(genreCache.get(key))
  // The artist's style first; a track's album genre from Deezer when the artist is unknown there.
  // When MusicBrainz refused, the answer is only a stand-in and the track is asked about again.
  let refused = false
  artistGenre(q.who)
    .catch(() => { refused = true; return null })
    .then((g) => g ?? deezerGenre(key))
    .then((g) => {
      if (!refused) genreCache.set(key, g)
      // Forgetting the track makes the next media update look it up again
      else setTimeout(() => { if (trackKey === key) trackKey = undefined }, 30000)
      done(g)
    })
    .catch(() => done(null))
}

// ---- Anthem: show the flag while the Ukrainian anthem plays ----

const ANTHEM = /гімн україни|гимн украины|ще не вмерла|national anthem of ukraine|ukrainian national anthem|anthem of ukraine|shche ne vmerla/i
let media, anthemOn = false, anthemSeen = 0, beforeAnthem

function watchMedia() {
  // PowerShell cannot run a script from inside app.asar, so pass it inline
  const script = fs.readFileSync(path.join(__dirname, 'media.ps1'), 'utf8')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  media = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
  let buf = ''
  media.stdout.setEncoding('utf8')
  media.stdout.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop()
    for (const line of lines) onMedia(line)
  })
  media.on('exit', () => { if (!app.isQuitting) setTimeout(watchMedia, 5000) })
}

function onMedia(line) {
  let sessions
  try {
    sessions = JSON.parse(line)
  } catch {
    return
  }
  sessions = [].concat(sessions ?? [])
  if (liveMode === 'music') lookUpGenre(sessions.find((s) => s.playing && s.title))
  const playing = sessions.some((s) => s.playing && ANTHEM.test(`${s.title} ${s.artist}`))
  if (playing) anthemSeen = Date.now()
  if (playing && !anthemOn && cfg.anthem && online) startAnthem()
  // A short pause or a track switch should not flip the light back and forth
  if (!playing && anthemOn && Date.now() - anthemSeen > 3000) stopAnthem()
}

// The light before the anthem is kept in memory: saving a preset writes the controller's
// flash, which stalls it for several seconds and delays the flag
async function startAnthem() {
  anthemOn = true
  try {
    beforeAnthem = await (await fetch(`http://${cfg.host}/json/state`)).json()
  } catch {
    beforeAnthem = undefined
  }
  win?.webContents.send('flag')
}

function stopAnthem() {
  anthemOn = false
  if (!beforeAnthem) return
  const { on, bri, seg = [] } = beforeAnthem
  const restored = seg.map((g) => ({ ...g, frz: false }))
  // Segments added for the flag must go, otherwise they stay over the restored layout
  for (let id = seg.length; id < 4; id++) restored.push({ id, stop: 0 })
  send({ on, bri, seg: restored })
  beforeAnthem = undefined
}

// ---- Tray ----

function trayImage() {
  const color = !online ? [110, 110, 120] : light.on ? light.col : [150, 150, 160]
  // Drawn at 2x so it stays crisp on high-DPI screens
  return nativeImage.createFromBuffer(ringIcon(32, { color, glow: online && light.on }), { scaleFactor: 2 })
}

function refreshTray() {
  if (!tray) return
  tray.setImage(trayImage())
  tray.setToolTip(!online ? 'Неон: немає звʼязку' : light.on ? 'Неон: увімкнено' : 'Неон: вимкнено')
}

function trayMenu() {
  const autostart = app.getLoginItemSettings().openAtLogin
  return Menu.buildFromTemplate([
    { label: light.on ? 'Вимкнути' : 'Увімкнути', enabled: online, click: () => send({ on: !light.on }) },
    { label: 'Відкрити панель', click: showWindow },
    { type: 'separator' },
    { label: 'Прапор під гімн України', type: 'checkbox', checked: cfg.anthem, click: (i) => setAnthem(i.checked) },
    { label: 'Запускати з Windows', type: 'checkbox', checked: autostart, click: (i) => setAutostart(i.checked) },
    { type: 'separator' },
    { label: 'Вихід', click: quit },
  ])
}

function setAnthem(enabled) {
  cfg.anthem = enabled
  saveConfig()
  if (!enabled && anthemOn) stopAnthem()
}

function setAutostart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

// ---- Popup window ----

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    // The hidden popup still has to switch to the flag right away when the anthem starts
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return
    win.hide()
    lastHidden = Date.now()
  })
}

function placeWindow() {
  const [w, h] = win.getSize()
  const t = tray.getBounds()
  const area = screen.getDisplayNearestPoint({ x: t.x, y: t.y }).workArea
  const gap = 8
  // Taskbar can be on any edge; open towards the screen centre from the tray icon
  let x = t.width ? Math.round(t.x + t.width / 2 - w / 2) : area.x + area.width - w - gap
  let y = t.y > area.y + area.height / 2 ? area.y + area.height - h - gap : area.y + gap
  if (t.x + t.width <= area.x) x = area.x + gap
  if (t.x >= area.x + area.width) x = area.x + area.width - w - gap
  x = Math.min(Math.max(x, area.x + gap), area.x + area.width - w - gap)
  win.setPosition(x, y)
}

function showWindow() {
  placeWindow()
  win.show()
  win.focus()
}

function toggleWindow() {
  // A click on the tray icon blurs (and hides) the popup first; don't reopen it
  if (win.isVisible() || Date.now() - lastHidden < 300) win.hide()
  else showWindow()
}

// ---- IPC ----

ipcMain.handle('host:get', () => cfg.host)
ipcMain.handle('host:set', (_e, host) => {
  cfg.host = String(host)
  saveConfig()
  connect()
})
ipcMain.on('win:resize', (_e, height) => {
  const h = Math.max(200, Math.min(Math.round(height), 900))
  if (win.getSize()[1] === h) return
  win.setSize(WIDTH, h)
  if (win.isVisible()) placeWindow()
})
ipcMain.on('win:hide', () => win.hide())

// ---- App lifecycle ----

function quit() {
  app.isQuitting = true
  media?.kill()
  app.exit(0)
}

app.on('second-instance', showWindow)
app.on('window-all-closed', (e) => e.preventDefault())

app.whenReady().then(() => {
  app.setAppUserModelId('com.vladk.neon')
  loadConfig()

  // Live modes capture the main screen, and music the system sound, without asking each time
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(
      (sources) => callback({ video: sources[0], ...(req.audioRequested ? { audio: 'loopback' } : {}) }),
      () => callback(null),
    )
  })

  // Launching with Windows is on by default; the tray menu can switch it off
  if (app.isPackaged && !cfg.autostartSet) {
    setAutostart(true)
    cfg.autostartSet = true
    saveConfig()
  }

  tray = new Tray(trayImage())
  tray.setToolTip('Неон')
  tray.on('click', toggleWindow)
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()))

  createWindow()
  connect()
  watchMedia()
  if (!START_HIDDEN) win.once('ready-to-show', showWindow)
})
