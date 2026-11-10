const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, session, desktopCapturer } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const dgram = require('node:dgram')
const { ringIcon } = require('./icon.cjs')

if (!app.requestSingleInstanceLock()) app.quit()

const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : null
const START_HIDDEN = process.argv.includes('--hidden')
const WIDTH = 360

const cfgFile = () => path.join(app.getPath('userData'), 'config.json')
let cfg = {
  host: '', autostartSet: false, anthem: true, games: true,
  // How each live mode looks: brightness, smoothing and strength of its effects, 1 being as designed
  modes: { cinema: { bright: 1, smooth: 1 }, game: { bright: 1, smooth: 1, effects: 1 }, music: { bright: 1, effects: 1 } },
  // Games seen so far by exe path: whether to light up for them and which profile they get
  gameList: {},
  windowSize: [520, 820],
}

// Where the strip runs, as calibrated in the app and kept on the controller (/neon.json); the
// geometry is shared with the app in room.mjs
const roomLib = import('./room.mjs')
let setup, ledTotal = 0, room

async function loadSetup() {
  try {
    const [s, info] = await Promise.all([
      // Anything but a clear "no such file" throws, and the last known room stays
      fetch(`http://${cfg.host}/neon.json`).then((r) => (r.status === 404 ? null : r.json())),
      fetch(`http://${cfg.host}/json/info`).then((r) => r.json()),
    ])
    ledTotal = info.leds.count
    setup = (await roomLib).normalize(s, ledTotal)
    room = (await roomLib).buildRoom(setup, ledTotal)
  } catch {
    // Unreachable controller: keep what is known
  }
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
let pinned = false
let windowed = false
let leaving = false

// ---- Controller connection (tray icon + menu live in the main process) ----

let ws, retry
function connect() {
  clearTimeout(retry)
  ws?.close()
  // Until the first-run setup finds the controller there is nothing to connect to
  if (!cfg.host) return
  const sock = new WebSocket(`ws://${cfg.host}/ws`)
  ws = sock
  sock.onopen = () => { online = true; refreshTray(); loadSetup() }
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
const LIVE_MODES = ['cinema', 'music', 'game']
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
  liveWin.webContents.on('did-finish-load', () => {
    liveWin?.webContents.send('live:genre', genre)
    liveWin?.webContents.send('live:playing', mediaPlaying)
    liveWin?.webContents.send('live:profile', liveMode === 'game' ? gameProfile : null)
  })
}

ipcMain.handle('live:room', async () => {
  for (let i = 0; i < 10 && !room; i++) {
    await loadSetup()
    if (!room) await new Promise((r) => setTimeout(r, 1000))
  }
  return room
})
ipcMain.handle('live:settings', () => cfg.modes[liveMode] ?? {})
ipcMain.on('live:frame', (_e, rgb) => {
  if (!udp) return
  const k = setup?.balance ?? [1, 1, 1]
  for (let i = 0; i < rgb.length; i++) rgb[i] = room?.off[(i / 3) | 0] ? 0 : Math.round(rgb[i] * k[i % 3])
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

let trackKey, genre = null, mediaPlaying = false
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
let anthemOn = false, anthemSeen = 0, beforeAnthem
const watchers = []

// Runs a PowerShell script from electron/ that prints a JSON line now and then, and restarts it
// if it dies
function watch(file, onLine) {
  // PowerShell cannot run a script from inside app.asar, so pass it inline
  const script = fs.readFileSync(path.join(__dirname, file), 'utf8')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const handle = {
    stopped: false,
    proc: null,
    stop() {
      this.stopped = true
      this.proc?.kill()
    },
  }
  const run = () => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    handle.proc = proc
    let buf = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split(/\r?\n/)
      buf = lines.pop()
      for (const line of lines) {
        let data
        try {
          data = JSON.parse(line)
        } catch {
          continue // not a complete JSON line
        }
        onLine(data)
      }
    })
    proc.on('exit', () => {
      if (!app.isQuitting && !handle.stopped) setTimeout(() => { if (!handle.stopped) run() }, 5000)
    })
  }
  run()
  watchers.push(handle)
  return handle
}

function onMedia(list) {
  const sessions = [].concat(list ?? [])
  if (liveMode === 'music') lookUpGenre(sessions.find((s) => s.playing && s.title))
  const nowPlaying = sessions.some((s) => s.playing)
  if (nowPlaying !== mediaPlaying) {
    mediaPlaying = nowPlaying
    liveWin?.webContents.send('live:playing', mediaPlaying)
  }
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
  beforeAnthem = await snapshot()
  win?.webContents.send('flag')
}

function stopAnthem() {
  anthemOn = false
  restore(beforeAnthem)
  beforeAnthem = undefined
}

function snapshot() {
  return fetch(`http://${cfg.host}/json/state`).then((r) => r.json(), () => undefined)
}

function restore(saved) {
  if (!saved) return
  const { on, bri, seg = [] } = saved
  const restored = seg.map((g) => ({ ...g, frz: false }))
  // Segments added since must go, otherwise they stay over the restored layout
  for (let id = seg.length; id < 4; id++) restored.push({ id, stop: 0 })
  send({ on, bri, seg: restored })
}

// ---- Games: switch to the game mode while one is running ----

// Where launchers install games; anything started from there counts as a game
const GAME_DIRS = /\\steamapps\\common\\|\\Epic Games\\|\\GOG Galaxy\\Games\\|\\XboxGames\\|\\Riot Games\\|\\Ubisoft Game Launcher\\games\\|\\EA Games\\/i
// Tools that live among games but are not played (Wallpaper Engine sits in steamapps too)
const NOT_GAMES = /wallpaper|crash|launcher|unins|setup|redist|helper/i
// Programs often used full screen that are not games
const NOT_GAME_APPS = /\\(chrome|msedge|firefox|opera|brave|vivaldi|vlc|mpc-hc64|mpc-be64|PotPlayerMini64|wmplayer|Video\.UI|explorer|ApplicationFrameHost|Claude|Neon|Code|Telegram|Discord|obs64|POWERPNT)\.exe$/i

let gamePid, gameExe, gameWindow, gameSeen = 0, beforeGame, gameProfile = null, inGame = false, input

// Games with a profile of their own in game.js, by where they are installed
const PROFILES = [[/death stranding 2/i, 'deathStranding2'], [/death stranding/i, 'deathStranding'], [/don'?t ?starve/i, 'dontStarve'], [/7 ?days ?to ?die/i, 'sevenDays']]
// Profiles that react to game buttons; the others never need the input watcher
const INPUT_PROFILES = ['deathStranding', 'deathStranding2']

function isGame({ path: exe, full }) {
  if (!exe) return false
  const name = exe.split('\\').pop()
  if (GAME_DIRS.test(exe)) return !NOT_GAMES.test(name)
  return full && !NOT_GAME_APPS.test(exe) && !/\\Windows\\/i.test(exe)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function onForeground(fg) {
  inGame = !!gamePid && fg.pid === gamePid
  if (gamePid) {
    // The game counts as running until it exits, so alt-tabbing out does not end the mode
    if (!alive(gamePid)) stopGame()
    return
  }
  if (!cfg.games || !online || !isGame(fg) || cfg.gameList[fg.path]?.enabled === false) { gameSeen = 0; return }
  // Two checks in a row, so a game that only flashes to the front while loading is ignored
  if (gameSeen !== fg.pid) { gameSeen = fg.pid; return }
  startGame(fg.pid, fg.hwnd, fg.path)
}

async function startGame(pid, hwnd, exe) {
  gamePid = pid
  gameExe = exe
  gameWindow = hwnd
  // A game seen for the first time is listed in the settings, with the profile its name suggests
  if (!cfg.gameList[exe]) {
    const folder = exe.match(/\\steamapps\\common\\([^\\]+)/i)?.[1]
    const name = folder ?? exe.split('\\').pop().replace(/\.exe$/i, '')
    cfg.gameList[exe] = { name, enabled: true, profile: PROFILES.find(([re]) => re.test(exe))?.[1] ?? null }
    saveConfig()
  }
  gameProfile = cfg.gameList[exe].profile
  inGame = true
  if (INPUT_PROFILES.includes(gameProfile)) watchInput()
  // Already in the game mode (picked by hand, or left on): start the capture over on the window
  if (liveMode === 'game') setLive('game')
  beforeGame = await snapshot()
  const name = (beforeGame?.seg?.[0]?.n ?? '').split(';').filter((t) => t && !LIVE_MODES.includes(t))
  // The game mode may still be on from a game before (or picked by hand); putting that back after
  // the game would leave it on for good, so the plain light underneath comes back instead
  if (beforeGame?.seg?.[0]?.n?.split(';').includes('game')) beforeGame.seg[0].n = name.join(';')
  send({ on: true, seg: [{ id: 0, n: [...name, 'game'].join(';') }] })
}

function stopGame() {
  gamePid = undefined
  gameExe = undefined
  gameWindow = undefined
  gameProfile = null
  input?.stop()
  input = undefined
  gameSeen = 0
  // Only put the light back if it is still the game mode; a style picked meanwhile stays
  if (liveMode === 'game') restore(beforeGame)
  beforeGame = undefined
}

// The buttons a game profile reacts to. A controller has scan and hold breath on one bumper: a
// tap scans, holding it holds the breath. Presses only count while the game is in front, so
// typing in another window does not set anything off.
const HOLD = 450 // ms

function watchInput() {
  input?.stop()
  let bumperDown = 0, breath = false, holdTimer
  const tell = (event) => { if (inGame) liveWin?.webContents.send('live:input', event) }
  const setBreath = (on) => {
    if (on === breath) return
    breath = on
    tell({ breath })
  }
  let keys = { scan: false, breath: false, bumper: false }
  input = watch('input.ps1', (k) => {
    if (k.scan && !keys.scan) tell({ scan: true })
    if (k.bumper && !keys.bumper) {
      bumperDown = Date.now()
      holdTimer = setTimeout(() => setBreath(true), HOLD)
    }
    if (!k.bumper && keys.bumper) {
      clearTimeout(holdTimer)
      if (Date.now() - bumperDown < HOLD) tell({ scan: true })
    }
    setBreath(k.breath || (k.bumper && Date.now() - bumperDown >= HOLD))
    keys = k
  })
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
    { label: 'Відкрити у вікні', click: openWindow },
    { type: 'separator' },
    { label: 'Прапор під гімн України', type: 'checkbox', checked: cfg.anthem, click: (i) => setAnthem(i.checked) },
    { label: 'Підсвітка для ігор', type: 'checkbox', checked: cfg.games, click: (i) => setGames(i.checked) },
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

function setGames(enabled) {
  cfg.games = enabled
  saveConfig()
  if (!enabled && gamePid) stopGame()
}

function setAutostart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}

// ---- Popup window ----

// The panel is either the tray popup or an ordinary window. Only one exists at a time: the
// controller takes a handful of websocket clients, and a second copy of the app would use one up.
function createWindow(asWindow) {
  windowed = asWindow
  const [width, height] = cfg.windowSize
  const w = new BrowserWindow({
    ...(asWindow
      ? { width, height, minWidth: WIDTH, minHeight: 480, autoHideMenuBar: true, backgroundColor: '#0b0b0f', title: 'Неон' }
      : { width: WIDTH, height: 600, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true, backgroundColor: '#00000000' }),
    show: false,
    // The hidden popup still has to switch to the flag right away when the anthem starts
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  })
  win = w
  if (DEV_URL) w.loadURL(asWindow ? `${DEV_URL}?window` : DEV_URL)
  else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), asWindow ? { query: { window: '' } } : {})

  if (asWindow) {
    w.removeMenu()
    w.on('session-end', () => { app.isQuitting = true })
    w.on('close', (e) => {
      if (app.isQuitting) return
      e.preventDefault()
      // Calibration has to put the light back first, which it does when it is left
      if (pinned) {
        leaving = true
        w.webContents.send('win:leave')
      } else closeToTray()
    })
  } else {
    w.on('blur', () => {
      if (w.isDestroyed() || w.webContents.isDevToolsOpened() || pinned) return
      w.hide()
      lastHidden = Date.now()
    })
  }
}

function replaceWindow(asWindow) {
  const old = win
  createWindow(asWindow)
  old.destroy()
}

function closeToTray() {
  if (!win.isMaximized()) {
    cfg.windowSize = win.getSize()
    saveConfig()
  }
  replaceWindow(false)
}

function openWindow() {
  // Replacing the page mid-calibration would leave the strip showing the marks
  if (!windowed && pinned) return showWindow()
  if (!windowed) replaceWindow(true)
  if (win.webContents.isLoading()) win.once('ready-to-show', showWindow)
  else showWindow()
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
  if (windowed) {
    if (win.isMinimized()) win.restore()
  } else placeWindow()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (windowed) return showWindow()
  // A click on the tray icon blurs (and hides) the popup first; don't reopen it
  if (win.isVisible() || Date.now() - lastHidden < 300) win.hide()
  else showWindow()
}

// ---- IPC ----

ipcMain.handle('host:get', () => cfg.host)
// The PC's own networks, for the first-run setup to look for the controller in
const subnets = () => [...new Set(Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
  .map((n) => n.address.split('.').slice(0, 3).join('.')))]

// Asks every address of the PC's networks for WLED's info at once. Done here rather than in the
// window: the browser keeps a connection open to each silent address for a while and runs out of
// them, after which even the controller's answer waits in the queue.
function probe(ip) {
  return new Promise((done) => {
    const req = http.get({ host: ip, path: '/json/info', timeout: 1200 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          const info = JSON.parse(body)
          done(info?.leds?.count ? { ip, name: info.name || 'WLED', leds: info.leds.count } : null)
        } catch {
          done(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => done(null))
  })
}

ipcMain.handle('net:find', async () => {
  const ips = subnets().flatMap((n) => Array.from({ length: 254 }, (_, i) => `${n}.${i + 1}`))
  return (await Promise.all(ips.map(probe))).filter(Boolean)
})
ipcMain.handle('host:set', (_e, host) => {
  cfg.host = String(host)
  saveConfig()
  connect()
})
ipcMain.on('win:resize', (_e, height) => {
  if (windowed) return
  // Taller content than the screen scrolls inside the popup
  const room = screen.getDisplayNearestPoint(tray.getBounds()).workArea.height - 16
  const h = Math.max(200, Math.min(Math.round(height), room))
  if (win.getSize()[1] === h) return
  // A window that is not resizable has its limits locked to its size and would never get smaller
  win.setResizable(true)
  win.setSize(WIDTH, h)
  win.setResizable(false)
  if (win.isVisible()) placeWindow()
})
ipcMain.on('win:hide', () => { if (!windowed) win.hide() })
ipcMain.on('win:open', openWindow)
// Calibration paints over the light until it is left, so its window must not vanish behind a click
ipcMain.on('win:pin', (_e, on) => {
  pinned = !!on
  if (pinned || !leaving) return
  leaving = false
  // Gives the request that restores the light time to leave before the page goes
  setTimeout(closeToTray, 400)
})

const desktopSettings = () => ({
  anthem: cfg.anthem, games: cfg.games, autostart: app.getLoginItemSettings().openAtLogin,
  modes: cfg.modes, gameList: cfg.gameList,
})
ipcMain.handle('settings:get', desktopSettings)

// Sliders send many changes; the live mode starts over with them once the user lets go
let retune
ipcMain.handle('settings:set', (_e, p) => {
  if ('anthem' in p) setAnthem(p.anthem)
  if ('games' in p) setGames(p.games)
  if ('autostart' in p) setAutostart(p.autostart)
  if (p.modes) {
    cfg.modes = p.modes
    clearTimeout(retune)
    retune = setTimeout(() => liveMode && setLive(liveMode), 500)
  }
  if (p.gameList) {
    cfg.gameList = p.gameList
    const running = gameExe && cfg.gameList[gameExe]
    if (running?.enabled === false) stopGame()
    else if (running && running.profile !== gameProfile) {
      gameProfile = running.profile
      if (INPUT_PROFILES.includes(gameProfile)) watchInput()
      else { input?.stop(); input = undefined }
      if (liveMode === 'game') setLive('game')
    }
  }
  saveConfig()
  return desktopSettings()
})
ipcMain.on('setup:changed', () => loadSetup().then(() => liveMode && setLive(liveMode)))

// ---- App lifecycle ----

function quit() {
  app.isQuitting = true
  for (const w of watchers) w.stop()
  app.exit(0)
}

// Starting the app from its shortcut while it already runs in the tray
app.on('second-instance', () => openWindow())
app.on('window-all-closed', (e) => e.preventDefault())

app.whenReady().then(() => {
  app.setAppUserModelId('com.vladk.neon')
  loadConfig()

  // Live modes capture the main screen, and music the system sound, without asking each time
  // Many games draw past the desktop, so a screen capture only sees the frame from before the
  // game; the game mode captures the game's own window instead
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    const audio = req.audioRequested ? { audio: 'loopback' } : {}
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then(
      (sources) => {
        const game = liveMode === 'game' && gameWindow && sources.find((s) => s.id.startsWith(`window:${gameWindow}:`))
        callback({ video: game || sources.find((s) => s.id.startsWith('screen:')), ...audio })
      },
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

  createWindow(!START_HIDDEN)
  connect()
  watch('media.ps1', onMedia)
  watch('foreground.ps1', onForeground)
  if (!START_HIDDEN) win.once('ready-to-show', showWindow)
})
