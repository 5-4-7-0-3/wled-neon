// Hidden window: listens to what the PC plays and paints the room with it.
// Each bass hit sends a wave of light both ways round the room from a random spot, the mids keep a
// soft glow breathing, the highs flash as sparks. The colour drifts slowly and leans warmer or
// cooler with how bright the sound is.

const FPS = 40
const WAVE_SPEED = 70 // LEDs per second
const WAVE_WIDTH = 5
const WAVE_LIFE = 1.6 // seconds until a wave has faded out
const GLOW = 0.28
const GAMMA = 1.6

function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))
  }
  return [f(5), f(3), f(1)]
}

// Loudness differs a lot between tracks; each band is measured against its own recent peak
function follower(decay = 0.995) {
  let peak = 1e-3
  return (v) => {
    peak = Math.max(v, peak * decay, 1e-3)
    return v / peak
  }
}

async function start() {
  const room = await window.live.room()
  // Windows only hands out the system sound together with a screen capture; the video is dropped
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  stream.getVideoTracks().forEach((t) => t.stop())

  const audio = new AudioContext()
  const analyser = audio.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.55
  audio.createMediaStreamSource(stream).connect(analyser)
  // An analyser that leads nowhere may not be processed; a muted output keeps the graph running
  const mute = audio.createGain()
  mute.gain.value = 0
  analyser.connect(mute).connect(audio.destination)
  const bins = new Uint8Array(analyser.frequencyBinCount)
  const hz = audio.sampleRate / analyser.fftSize
  const band = (lo, hi) => {
    let s = 0
    const a = Math.floor(lo / hz), b = Math.ceil(hi / hz)
    for (let i = a; i < b; i++) s += bins[i]
    return s / (b - a) / 255
  }

  const level = { bass: follower(), mid: follower(), high: follower() }
  const waves = []
  const sparks = new Float32Array(room.len)
  const glow = new Float32Array(3)
  let bassAvg = 0, lastBeat = 0, hue = 200, t0 = performance.now()

  const tick = () => {
    const now = performance.now()
    const dt = (now - t0) / 1000
    t0 = now
    analyser.getByteFrequencyData(bins)
    const rawBass = band(30, 150)
    const bass = level.bass(rawBass), mid = level.mid(band(150, 2000)), high = level.high(band(2500, 9000))
    const quiet = rawBass + band(150, 2000) < 0.02

    // Brighter sound leans the colour warmer, darker sound cooler, on top of a slow drift
    const lean = (high - bass) * 40
    hue = (hue + dt * 8 + 360) % 360

    // A beat is a bass jump well above its running average, at most ~6 per second
    bassAvg += (rawBass - bassAvg) * 0.08
    if (!quiet && rawBass > bassAvg * 1.35 && rawBass > 0.12 && now - lastBeat > 160) {
      lastBeat = now
      waves.push({ born: now, origin: Math.floor(Math.random() * room.len), hue: (hue + lean + 360) % 360, power: Math.min(1, 0.5 + bass * 0.6) })
    }
    while (waves.length && now - waves[0].born > WAVE_LIFE * 1000) waves.shift()

    const g = hsv((hue + lean + 180) % 360, 0.75, quiet ? 0 : GLOW * (0.25 + 0.75 * mid))
    for (let k = 0; k < 3; k++) glow[k] += (g[k] - glow[k]) * 0.15

    // Sparks: random LEDs flash with the highs and fade quickly
    for (let v = 0; v < room.len; v++) sparks[v] *= 0.82
    if (!quiet) {
      const n = Math.round(high * high * 6)
      for (let i = 0; i < n; i++) sparks[Math.floor(Math.random() * room.len)] = 0.6 + high * 0.4
    }

    const rgb = new Uint8Array(room.len * 3)
    for (let v = 0; v < room.len; v++) {
      let r = glow[0], gg = glow[1], b = glow[2]
      for (const w of waves) {
        // Distance along the ceiling from where the wave started, going either way round the room
        const d = Math.min(Math.abs(v - w.origin), room.len - Math.abs(v - w.origin))
        const age = (now - w.born) / 1000
        const front = age * WAVE_SPEED
        const x = (d - front) / WAVE_WIDTH
        if (x < -2 || x > 2) continue
        const a = Math.exp(-x * x) * w.power * (1 - age / WAVE_LIFE)
        const c = hsv(w.hue, 0.9, a)
        r = Math.max(r, c[0]); gg = Math.max(gg, c[1]); b = Math.max(b, c[2])
      }
      const s = sparks[v]
      r = Math.max(r, s); gg = Math.max(gg, s * 0.9); b = Math.max(b, s * 0.8)
      // The controller skips gamma for realtime data, so it is applied here
      rgb[v * 3] = Math.round(255 * Math.pow(Math.min(1, r), GAMMA))
      rgb[v * 3 + 1] = Math.round(255 * Math.pow(Math.min(1, gg), GAMMA))
      rgb[v * 3 + 2] = Math.round(255 * Math.pow(Math.min(1, b), GAMMA))
    }
    window.live.frame(rgb)
  }
  setInterval(tick, 1000 / FPS)
}

start().catch((e) => console.error('music', e))
