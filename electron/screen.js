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
  // Brightness scales the light; smoothness slows how fast it follows the picture
  const S = { bright: 1, smooth: 1, effects: 1, ...(await window.live.settings()) }
  P.level *= S.bright
  P.smoothCalm /= S.smooth
  P.smoothCut /= S.smooth
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

  // Each LED shows the part of the picture its role in the room says (see room.mjs)
  const paintPicture = () => {
    const all = tone(avg(left, right + 1, top, bottom + 1))
    const [sy0, sy1] = P.screenBand.map((f) => top + ch * f)
    const [ey0, ey1] = P.sideBand.map((f) => top + ch * f)
    const X = (f) => left + f * cw, Y = (f) => top + f * ch
    room.roles.forEach((r, v) => {
      if (r.role === 'front') put(v, tone(avg(X(r.x0), Math.max(X(r.x1), X(r.x0) + 1), sy0, sy1)))
      else if (r.role === 'side') put(v, tone(avg(X(r.x0), X(r.x1), ey0, ey1)), 1 - P.sideFade * r.t)
      else if (r.role === 'edge') put(v, tone(avg(X(r.x0), Math.max(X(r.x1), X(r.x0) + 1), Y(r.y0), Math.max(Y(r.y1), Y(r.y0) + 1))))
      else if (r.role === 'bed' && P.aboveBed !== null) put(v, all, P.aboveBed)
      else if (r.role !== 'off') put(v, all, P.back)
      else put(v, [0, 0, 0])
    })
  }

  const paintMood = () => {
    const half = left + cw / 2
    const moodL = tone(mood(left, half, top, bottom + 1))
    const moodR = tone(mood(half, right + 1, top, bottom + 1))
    for (let v = 0; v < room.len; v++) {
      put(v, room.dir[v] === 1 ? moodL : moodR, P.floor + (1 - P.floor) * Math.exp(-room.d[v] / P.spread))
    }
    if (!P.detail) return
    // The LEDs facing the picture mix in the picture itself, the way cinema does
    const [sy0, sy1] = P.screenBand.map((f) => top + ch * f)
    room.roles.forEach((r, v) => {
      if (r.role !== 'front' && r.role !== 'edge') return
      const [y0, y1] = r.role === 'edge' ? [top + r.y0 * ch, top + r.y1 * ch] : [sy0, sy1]
      const x0 = left + r.x0 * cw
      const pic = tone(mood(x0, Math.max(left + r.x1 * cw, x0 + 1), y0, Math.max(y1, y0 + 1)))
      for (let c = 0; c < 3; c++) target[v * 3 + c] += (pic[c] * P.level - target[v * 3 + c]) * P.detail
    })
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
      const gain = (extra?.gain?.[i] ?? 0) * S.effects, add = (extra?.add?.[i] ?? 0) * S.effects * S.bright
      const v = Math.min(255, Math.max(0, out[i] * (1 + gain) + add))
      rgb[i] = Math.round(255 * Math.pow(v / 255, GAMMA))
    }
    window.live.frame(rgb)
  }
  setInterval(tick, 1000 / P.fps)
}

start().catch((e) => console.error('screen', e))
