const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { ringIcon } = require('./icon.cjs')

if (!app.requestSingleInstanceLock()) app.quit()

const DEV_URL = process.argv.includes('--dev') ? 'http://localhost:5173' : null
const START_HIDDEN = process.argv.includes('--hidden')
const WIDTH = 360

const cfgFile = () => path.join(app.getPath('userData'), 'config.json')
let cfg = { host: '192.168.1.12', autostartSet: false }

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
    { label: 'Запускати з Windows', type: 'checkbox', checked: autostart, click: (i) => setAutostart(i.checked) },
    { type: 'separator' },
    { label: 'Вихід', click: () => app.exit(0) },
  ])
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
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
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

app.on('second-instance', showWindow)
app.on('window-all-closed', (e) => e.preventDefault())

app.whenReady().then(() => {
  app.setAppUserModelId('com.vladk.neon')
  loadConfig()

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
  if (!START_HIDDEN) win.once('ready-to-show', showWindow)
})
