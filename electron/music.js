// Hidden window: listens to what the PC plays and paints the room with it.
// Each beat sends a wave of light both ways round the room from a random spot (stronger hits make
// wider, faster waves), a drop flashes the whole room, the mids keep a soft glow breathing and the
// highs flash as sparks. The colour follows where the sound sits: bass-heavy music goes deep
// blue and violet, bright music warm.

const FPS = 60
const GLOW = 0.26
const GAMMA = 1.6
const MIN_GAP = 120 // ms between beats
const DROP_GAP = 2000 // ms between room flashes

function hsv(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))
  }
  return [f(5), f(3), f(1)]
}

// Loudness differs a lot between tracks; each band is measured against its own recent peak
function follower(decay = 0.996) {
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
  // Short window and little smoothing: beats are found from how fast the spectrum rises
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.2
  audio.createMediaStreamSource(stream).connect(analyser)
  // An analyser that leads nowhere may not be processed; a muted output keeps the graph running
  const mute = audio.createGain()
  mute.gain.value = 0
  analyser.connect(mute).connect(audio.destination)

  const bins = new Uint8Array(analyser.frequencyBinCount)
  const prev = new Uint8Array(analyser.frequencyBinCount)
  const hz = audio.sampleRate / analyser.fftSize
  const range = (lo, hi) => [Math.max(1, Math.floor(lo / hz)), Math.ceil(hi / hz)]
  const band = (lo, hi) => {
    const [a, b] = range(lo, hi)
    let s = 0
    for (let i = a; i < b; i++) s += bins[i]
    return s / (b - a) / 255
  }
  // Spectral flux: how much the band got louder since the last frame
  const flux = (lo, hi) => {
    const [a, b] = range(lo, hi)
    let s = 0
    for (let i = a; i < b; i++) s += Math.max(0, bins[i] - prev[i])
    return s / (b - a) / 255
  }

  const level = { mid: follower(), high: follower(), bass: follower() }
  const history = [] // recent bass flux, about 1.5 s
  const waves = []
  const sparks = new Float32Array(room.len)
  const glow = new Float32Array(3)
  let lastBeat = 0, lastDrop = 0, flash = 0, flashHue = 0
  let shortE = 0, longE = 0, tone = 0.5

  const tick = () => {
    const now = performance.now()
    analyser.getByteFrequencyData(bins)
    const bassFlux = flux(30, 160)
    const bassRaw = band(30, 160), midRaw = band(160, 2000), highRaw = band(2500, 9000)
    const bass = level.bass(bassRaw), mid = level.mid(midRaw), high = level.high(highRaw)
    const energy = (bassRaw + midRaw + highRaw) / 3
    const quiet = energy < 0.015

    // Where the sound sits, from bass (0) to treble (1), on a log scale and smoothed
    let w = 0, sum = 0
    for (let i = 1; i < bins.length; i++) { w += i * hz * bins[i]; sum += bins[i] }
    const centroid = sum ? w / sum : 500
    const t = Math.min(1, Math.max(0, Math.log(centroid / 150) / Math.log(4000 / 150)))
    tone += (t - tone) * 0.03
    const hue = 260 - tone * 240 + Math.sin(now / 9000) * 25

    // A beat is a bass rise well above what the last second and a half was doing
    history.push(bassFlux)
    if (history.length > FPS * 1.5) history.shift()
    const mean = history.reduce((a, b) => a + b, 0) / history.length
    const sd = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length)
    if (!quiet && bassFlux > mean + 1.5 * sd && bassFlux > 0.02 && now - lastBeat > MIN_GAP) {
      lastBeat = now
      const p = Math.min(1, 0.4 + bass * 0.6)
      waves.push({
        born: now,
        origin: Math.floor(Math.random() * room.len),
        hue: (hue + (Math.random() - 0.5) * 40 + 360) % 360,
        power: p,
        width: 3 + 5 * p,
        speed: 45 + 65 * p,
        life: 1.1 + 0.8 * p,
      })
    }
    for (let i = waves.length - 1; i >= 0; i--) if (now - waves[i].born > waves[i].life * 1000) waves.splice(i, 1)

    // A drop: the music suddenly gets much louder than it has been for the last few seconds
    shortE += (energy - shortE) * 0.25
    longE += (energy - longE) * 0.006
    if (!quiet && shortE > longE * 1.8 && shortE > 0.12 && now - lastDrop > DROP_GAP) {
      lastDrop = now
      flash = 0.85
      flashHue = hue
    }
    flash *= 0.9

    const g = hsv((hue + 35) % 360, 0.7, quiet ? 0 : GLOW * (0.2 + 0.8 * mid))
    for (let k = 0; k < 3; k++) glow[k] += (g[k] - glow[k]) * 0.12

    // Sparks: random LEDs flash with the highs and fade quickly
    for (let v = 0; v < room.len; v++) sparks[v] *= 0.85
    if (!quiet) {
      const n = Math.round(high * high * 4)
      for (let i = 0; i < n; i++) sparks[Math.floor(Math.random() * room.len)] = 0.55 + high * 0.45
    }

    const f = hsv(flashHue, 0.55, flash)
    const rgb = new Uint8Array(room.len * 3)
    for (let v = 0; v < room.len; v++) {
      let r = Math.max(glow[0], f[0]), gg = Math.max(glow[1], f[1]), b = Math.max(glow[2], f[2])
      for (const wv of waves) {
        // Distance along the ceiling from where the wave started, going either way round the room
        const d = Math.min(Math.abs(v - wv.origin), room.len - Math.abs(v - wv.origin))
        const age = (now - wv.born) / 1000
        const x = (d - age * wv.speed) / wv.width
        if (x < -2 || x > 2) continue
        const a = Math.exp(-x * x) * wv.power * (1 - age / wv.life)
        const c = hsv(wv.hue, 0.9, a)
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
    prev.set(bins)
  }
  setInterval(tick, 1000 / FPS)
}

start().catch((e) => console.error('music', e))
