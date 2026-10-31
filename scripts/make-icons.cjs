const fs = require('node:fs')
const path = require('node:path')
const { ringIcon } = require('../electron/icon.cjs')

const root = path.join(__dirname, '..')
const WARM = [255, 160, 60]
const TILE = [22, 22, 29]

function write(file, png) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, png)
  console.log(path.relative(root, file))
}

write(path.join(root, 'build', 'icon.png'), ringIcon(512, { color: WARM, glow: true, background: TILE }))

const res = path.join(root, 'android', 'app', 'src', 'main', 'res')
if (fs.existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [d, k] of Object.entries(densities)) {
    const dir = path.join(res, `mipmap-${d}`)
    const legacy = ringIcon(48 * k, { color: WARM, glow: true, background: TILE })
    write(path.join(dir, 'ic_launcher.png'), legacy)
    write(path.join(dir, 'ic_launcher_round.png'), legacy)
    // Adaptive icons get cropped to the inner 66 of 108 dp, so the ring is shrunk to fit
    write(path.join(dir, 'ic_launcher_foreground.png'),
      ringIcon(108 * k, { color: WARM, glow: true, scale: 0.62 }))
  }
  const bg = path.join(res, 'values', 'ic_launcher_background.xml')
  fs.writeFileSync(bg, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#16161D</color>\n</resources>\n')
  console.log(path.relative(root, bg))
}
