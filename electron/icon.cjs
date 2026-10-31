// Draws the ring icon as a PNG in code, so the tray icon can take the
// neon's current colour without shipping an image per colour.
const zlib = require('node:zlib')

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * @param {number} size
 * @param {{ color: number[], glow?: boolean, background?: number[], scale?: number }} opts
 */
function ringIcon(size, { color, glow = false, background, scale = 1 }) {
  const px = Buffer.alloc(size * size * 4)
  const c = size / 2
  const radius = size * (background ? 0.3 : 0.36) * scale
  const half = size * (background ? 0.07 : 0.11) * scale
  const corner = size * 0.22

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c
      const dist = Math.abs(Math.hypot(dx, dy) - radius)
      // Ring with a 1px anti-aliased edge, plus an optional soft glow
      const ring = Math.max(0, Math.min(1, half - dist + 0.5))
      const halo = glow ? Math.max(0, 1 - dist / (size * 0.2)) ** 2 * 0.55 : 0
      const a = Math.max(ring, halo)

      let bg = [0, 0, 0, 0]
      if (background) {
        // Rounded-square app tile
        const qx = Math.max(Math.abs(dx) - (c - corner), 0)
        const qy = Math.max(Math.abs(dy) - (c - corner), 0)
        const inside = Math.max(0, Math.min(1, corner - Math.hypot(qx, qy) + 0.5))
        bg = [...background, inside]
      }

      const outA = a + bg[3] * (1 - a)
      const i = (y * size + x) * 4
      for (let k = 0; k < 3; k++) {
        px[i + k] = outA ? Math.round((color[k] * a + bg[k] * bg[3] * (1 - a)) / outA) : 0
      }
      px[i + 3] = Math.round(outA * 255)
    }
  }
  return encodePng(size, px)
}

module.exports = { ringIcon }
