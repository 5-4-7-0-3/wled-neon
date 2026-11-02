// Hidden window shared by the screen-driven modes (cinema, game): samples the screen and turns
// each frame into colours for the room.
//
// Two layouts. 'picture' (cinema) spreads the picture over the walls: the screen wall continues
// the top of the picture around the monitor, the side walls repeat its left and right edges and
// fade towards the back of the room, the back wall glows faintly with the overall tone. 'mood'
// (game) lights the room with the scene's main colour instead, strongest above the monitor and
// fading round the room, the left and right halves of the room taking the left and right halves
// of the picture; the screen wall can mix in the picture itself for detail.
//
// A mode tunes it by setting window.screenProfile before this script loads, and can add its own
// light on top through window.screenOverlay(now, frame), which returns per-LED `gain` (scales the
// colour, -1 turns it off) and `add` (adds light), and use the capture via window.onScreenStream.

const W = 64
const H = 36
const LIFT_TO = 70
const MAX_LIFT = 4
const GAMMA = 1.6

const P = {
  fps: 30,
  layout: 'picture',
  // Share of the new frame taken per tick. Small changes (motion, grain, flicker) move slowly so
  // the walls stay calm; a big jump is a scene cut and is followed quickly to stay in sync.
  smoothCalm: 0.08, // small changes need about 0.4 s to get two thirds of the way
  smoothCut: 0.4,
  cut: 60, // colour jump that counts as a cut
  level: 1,
  // picture layout
  back: 0.15,
  aboveBed: 0.05, // null leaves the bed's stretch like the rest of the back wall
  sideFade: 0.65,
  screenBand: [0, 0.4], // part of the picture's height the screen wall is sampled from
  sideBand: [0, 1],
  // mood layout
  spread: 28, // LEDs over which the light fades away from the monitor
  floor: 0.1, // share of the light left at the far side of the room
  detail: 0, // how much the screen wall shows the picture itself rather than the mood colour
  audio: false,
  ...window.screenProfile,
}

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
  const room = await window.live.room()
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: P.fps, width: 640, height: 360 },
    audio: P.audio,
  })
  window.onScreenStream?.(stream, room)
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = stream
  await video.play()

  const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })
  const out = new Float32Array(room.len * 3)
  const target = new Float32Array(room.len * 3)
  let px, top, bottom, left, right, cw, ch

  const lit = (x, y) => {
    const i = (y * W + x) * 4
    return Math.max(px[i], px[i + 1], px[i + 2]) > 24
  }
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
  // The main colour of a region: vivid pixels count far more than grey ones, so mist, shadows
  // and HUD greys do not wash the colour out
  const mood = (x0, x1, y0, y1) => {
    let r = 0, g = 0, b = 0, n = 0
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const i = (y * W + x) * 4
        const mx = Math.max(px[i], px[i + 1], px[i + 2]), mn = Math.min(px[i], px[i + 1], px[i + 2])
        const w = mx - mn + 0.15 * mx + 1
        r += px[i] * w; g += px[i + 1] * w; b += px[i + 2] * w; n += w
      }
    }
    return [r / n, g / n, b / n]
  }
  const put = (v, [r, g, b], k = 1) => {
    const i = (((v % room.len) + room.len) % room.len) * 3
    target[i] = r * k * P.level; target[i + 1] = g * k * P.level; target[i + 2] = b * k * P.level
  }

  const paintPicture = () => {
    const all = tone(avg(left, right + 1, top, bottom + 1))
    for (let v = 0; v < room.len; v++) put(v, all, P.back)

    // The picture is centred on the monitor, so each half is stretched over its side of the wall
    const s = room.screen
    const mid = (s.center - s.start) / s.step
    const [sy0, sy1] = P.screenBand.map((f) => top + ch * f)
    for (let k = 0; k < s.count; k++) {
      const x = k < mid ? (0.5 * k) / mid : 0.5 + (0.5 * (k - mid)) / Math.max(1, s.count - 1 - mid)
      const x0 = left + Math.min(x, 0.98) * cw
      put(s.start + k * s.step, tone(avg(x0, x0 + Math.max(1, cw / s.count), sy0, sy1)))
    }
    if (P.aboveBed !== null) for (let k = 0; k < room.bed.count; k++) put(room.bed.start + k, all, P.aboveBed)
    const edge = cw * 0.15
    const [ey0, ey1] = P.sideBand.map((f) => top + ch * f)
    const sides = [[room.left, avg(left, left + edge, ey0, ey1)], [room.right, avg(right + 1 - edge, right + 1, ey0, ey1)]]
    for (const [wall, c] of sides) {
      const col = tone(c)
      for (let k = 0; k < wall.count; k++) put(wall.start + k * wall.step, col, 1 - (P.sideFade * k) / Math.max(1, wall.count - 1))
    }
  }

  const paintMood = () => {
    const half = left + cw / 2
    const moodL = tone(mood(left, half, top, bottom + 1))
    const moodR = tone(mood(half, right + 1, top, bottom + 1))
    const centre = room.screen.center
    for (let v = 0; v < room.len; v++) {
      // Distance round the room from the monitor; the screen wall's index grows to the left
      const towardsLeft = (v - centre + room.len) % room.len
      const onLeft = towardsLeft <= room.len / 2
      const d = onLeft ? towardsLeft : room.len - towardsLeft
      put(v, onLeft ? moodL : moodR, P.floor + (1 - P.floor) * Math.exp(-d / P.spread))
    }
    if (!P.detail) return
    // The screen wall mixes in the top of the picture across the wall, the way cinema does
    const s = room.screen
    const mid = (s.center - s.start) / s.step
    const [sy0, sy1] = P.screenBand.map((f) => top + ch * f)
    for (let k = 0; k < s.count; k++) {
      const x = k < mid ? (0.5 * k) / mid : 0.5 + (0.5 * (k - mid)) / Math.max(1, s.count - 1 - mid)
      const x0 = left + Math.min(x, 0.98) * cw
      const pic = tone(mood(x0, x0 + Math.max(1, cw / s.count), sy0, sy1))
      const i = (((s.start + k * s.step) % room.len) + room.len) % room.len * 3
      for (let c = 0; c < 3; c++) target[i + c] += (pic[c] * P.level - target[i + c]) * P.detail
    }
  }

  const tick = () => {
    const now = performance.now()
    ctx.drawImage(video, 0, 0, W, H)
    px = ctx.getImageData(0, 0, W, H).data

    // Letterbox and pillarbox bars would make every wall black; sample only the picture
    top = 0; bottom = H - 1; left = 0; right = W - 1
    const rowLit = (y) => { for (let x = 0; x < W; x++) if (lit(x, y)) return true; return false }
    const colLit = (x) => { for (let y = top; y <= bottom; y++) if (lit(x, y)) return true; return false }
    while (top < H / 3 && !rowLit(top)) top++
    while (bottom > (H * 2) / 3 && !rowLit(bottom)) bottom--
    while (left < W / 3 && !colLit(left)) left++
    while (right > (W * 2) / 3 && !colLit(right)) right--
    cw = right - left + 1
    ch = bottom - top + 1

    if (P.layout === 'mood') paintMood()
    else paintPicture()

    // The controller skips gamma for realtime data, so it is applied here; a full 2.2 crushes
    // the dim tones most scenes are made of
    const extra = window.screenOverlay?.(now, { px, W, H, top, bottom, left, right })
    const rgb = new Uint8Array(room.len * 3)
    for (let i = 0; i < out.length; i++) {
      const d = target[i] - out[i]
      const k = P.smoothCalm + (P.smoothCut - P.smoothCalm) * Math.min(1, Math.abs(d) / P.cut)
      out[i] += d * k
      const v = Math.min(255, Math.max(0, out[i] * (1 + (extra?.gain?.[i] ?? 0)) + (extra?.add?.[i] ?? 0)))
      rgb[i] = Math.round(255 * Math.pow(v / 255, GAMMA))
    }
    window.live.frame(rgb)
  }
  setInterval(tick, 1000 / P.fps)
}

start().catch((e) => console.error('screen', e))
