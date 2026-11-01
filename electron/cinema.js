// Hidden window: samples the screen and turns each frame into colours for the room.
// The screen wall continues the top of the picture around the monitor, the side walls repeat its
// left and right edges and fade towards the bed, the back wall glows faintly with the overall
// tone and stays darkest right above the bed so it does not glare.

const W = 64
const H = 36
const FPS = 30
// Share of the new frame taken per tick. Small changes (motion, grain, flicker) move slowly so the
// walls stay calm; a big jump is a scene cut and is followed quickly to stay in sync with the film.
const SMOOTH_CALM = 0.08 // small changes need about 0.4 s to get two thirds of the way
const SMOOTH_CUT = 0.4
const CUT = 60 // colour jump that counts as a cut
const BACK = 0.15
const ABOVE_BED = 0.05
const SIDE_FADE = 0.65
const LIFT_TO = 70
const MAX_LIFT = 4
const GAMMA = 1.6

// Averages blend into grey; push them a bit away from it so walls keep the scene's colour.
// Dark scenes are lifted so the room keeps a dim glow of their tone instead of going black.
function tone([r, g, b], k = 1.35) {
  const grey = (r + g + b) / 3
  const c = [r, g, b].map((v) => Math.min(255, Math.max(0, grey + (v - grey) * k)))
  const peak = Math.max(...c)
  const lift = peak > 6 && peak < LIFT_TO ? Math.min(MAX_LIFT, LIFT_TO / peak) : 1
  return c.map((v) => Math.min(255, v * lift))
}

async function start() {
  const room = await window.cinema.room()
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: FPS, width: 640, height: 360 },
    audio: false,
  })
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = stream
  await video.play()

  const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })
  const out = new Float32Array(room.len * 3)
  const target = new Float32Array(room.len * 3)

  const tick = () => {
    ctx.drawImage(video, 0, 0, W, H)
    const px = ctx.getImageData(0, 0, W, H).data
    const lit = (x, y) => {
      const i = (y * W + x) * 4
      return Math.max(px[i], px[i + 1], px[i + 2]) > 24
    }

    // Letterbox and pillarbox bars would make every wall black; sample only the picture
    let top = 0, bottom = H - 1, left = 0, right = W - 1
    const rowLit = (y) => { for (let x = 0; x < W; x++) if (lit(x, y)) return true; return false }
    const colLit = (x) => { for (let y = top; y <= bottom; y++) if (lit(x, y)) return true; return false }
    while (top < H / 3 && !rowLit(top)) top++
    while (bottom > (H * 2) / 3 && !rowLit(bottom)) bottom--
    while (left < W / 3 && !colLit(left)) left++
    while (right > (W * 2) / 3 && !colLit(right)) right--
    const cw = right - left + 1, ch = bottom - top + 1

    const avg = (x0, x1, y0, y1) => {
      let r = 0, g = 0, b = 0, n = 0
      for (let y = Math.floor(y0); y < Math.max(Math.ceil(y1), Math.floor(y0) + 1); y++) {
        for (let x = Math.floor(x0); x < Math.max(Math.ceil(x1), Math.floor(x0) + 1); x++) {
          const i = (y * W + x) * 4
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
        }
      }
      return [r / n, g / n, b / n]
    }
    const put = (v, [r, g, b], k = 1) => {
      const i = (((v % room.len) + room.len) % room.len) * 3
      target[i] = r * k; target[i + 1] = g * k; target[i + 2] = b * k
    }

    const all = tone(avg(left, right + 1, top, bottom + 1))
    for (let v = 0; v < room.len; v++) put(v, all, BACK)

    // The picture is centred on the monitor, so each half is stretched over its side of the wall
    const s = room.screen
    const mid = (s.center - s.start) / s.step
    for (let k = 0; k < s.count; k++) {
      const x = k < mid ? (0.5 * k) / mid : 0.5 + (0.5 * (k - mid)) / Math.max(1, s.count - 1 - mid)
      const x0 = left + Math.min(x, 0.98) * cw
      put(s.start + k * s.step, tone(avg(x0, x0 + Math.max(1, cw / s.count), top, top + ch * 0.4)))
    }
    for (let k = 0; k < room.bed.count; k++) put(room.bed.start + k, all, ABOVE_BED)
    const edge = cw * 0.15
    const sides = [[room.left, avg(left, left + edge, top, bottom + 1)], [room.right, avg(right + 1 - edge, right + 1, top, bottom + 1)]]
    for (const [wall, c] of sides) {
      const col = tone(c)
      for (let k = 0; k < wall.count; k++) put(wall.start + k * wall.step, col, 1 - (SIDE_FADE * k) / Math.max(1, wall.count - 1))
    }

    // The controller skips gamma for realtime data, so it is applied here; a full 2.2 crushes
    // the dim tones film scenes are made of
    const rgb = new Uint8Array(room.len * 3)
    for (let i = 0; i < out.length; i++) {
      const d = target[i] - out[i]
      const k = SMOOTH_CALM + (SMOOTH_CUT - SMOOTH_CALM) * Math.min(1, Math.abs(d) / CUT)
      out[i] += d * k
      rgb[i] = Math.round(255 * Math.pow(out[i] / 255, GAMMA))
    }
    window.cinema.frame(rgb)
  }
  setInterval(tick, 1000 / FPS)
}

start().catch((e) => console.error('cinema', e))
