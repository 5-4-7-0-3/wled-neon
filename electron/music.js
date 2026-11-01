// Hidden window: listens to what the PC plays and paints the room with it.
// Beats send waves of light round the room from a random spot, alternating direction with the
// beat (stronger hits make wider, faster waves); the tempo is tracked so the rhythm carries on
// through quiet hits and the colour steps on every bar. A drop flashes the whole room, the mids
// keep a soft glow breathing, the highs flash as sparks, and a soft ribbon of light drifts round
// the room while someone sings. The colours come from the genre, rap styles included: looked up
// from the track's artist or title when possible, otherwise guessed from the sound itself.

const FPS = 60
const GLOW = 0.24
const GAMMA = 1.6
const MIN_GAP = 120 // ms between beats
const DROP_GAP = 2000 // ms between room flashes
const BAR_STEP = 50 // degrees the colour moves on each bar
const TEMPO_WINDOW = 6 // seconds of rhythm used to find the tempo
const RIBBON = 0.32
const RIBBON_WIDTH = 14
const RIBBON_SPEED = 6 // LEDs per second

// Two hues per genre: beats alternate between them and bars swap which one leads
const PALETTES = {
  electro: [185, 300],
  hiphop: [275, 45],
  trap: [275, 350],
  drill: [220, 190],
  boombap: [42, 22],
  cloud: [320, 270],
  phonk: [350, 285],
  lofi: [35, 175],
  rock: [0, 28],
  metal: [350, 205],
  pop: [330, 15],
  rnb: [285, 35],
  jazz: [35, 225],
  classical: [45, 175],
  latin: [120, 55],
  folk: [30, 95],
  chill: [175, 220],
}

// Rough genre from how the music sounds, over the last ten seconds or so
function guessGenre({ bpm, steady, bassShare, brightness, loudness }) {
  if (loudness < 0.06 || steady < 0.15) return 'chill'
  if (bassShare > 0.5 && (bpm < 100 || bpm > 135) && brightness < 0.45) return 'hiphop'
  if (steady > 0.45 && bpm >= 115 && bpm <= 135 && bassShare > 0.38) return 'electro'
  if (brightness > 0.55 && loudness > 0.18) return 'rock'
  return 'pop'
}

// Rap style from the sound, for when only "hip hop" is known: half-time trap around 130-160 BPM,
// laid-back boom bap around 85-100 with little sub-bass, quiet even lo-fi, and vocal-led
// melodic rap with soft drums
function guessRap({ bpm, steady, bassShare, brightness, loudness, vocal }) {
  if (loudness < 0.1 && steady > 0.3) return 'lofi'
  if (vocal > 0.5 && bassShare < 0.45) return 'cloud'
  if (bpm >= 82 && bpm <= 100 && bassShare < 0.45) return 'boombap'
  if (bassShare > 0.55 && brightness < 0.35) return 'phonk'
  return 'trap'
}

// Shortest way round the colour wheel, so a palette change does not sweep through every hue
const towards = (from, to, k) => from + ((((to - from) % 360) + 540) % 360 - 180) * k

function hsv(h, s, v) {
  const f = (n) => {
    const k = (((n + h / 60) % 6) + 6) % 6
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

// Tempo from the repeating pattern of bass rises: the lag (in frames) at which the rhythm best
// matches itself, limited to 70-180 BPM. Returns the period and how clear the pattern is.
function tempo(hist) {
  const n = hist.length
  const mean = hist.reduce((a, b) => a + b, 0) / n
  const x = hist.map((v) => v - mean)
  const energy = x.reduce((a, b) => a + b * b, 0) || 1
  let best = 0, lag = 0
  for (let l = Math.round((FPS * 60) / 180); l <= Math.round((FPS * 60) / 70); l++) {
    let s = 0
    for (let i = l; i < n; i++) s += x[i] * x[i - l]
    // Gently favour the usual 100-140 BPM so half and double tempo lose close calls
    const bpm = (FPS * 60) / l
    const c = (s / energy) * (1 - Math.min(0.15, Math.abs(bpm - 120) / 600))
    if (c > best) { best = c; lag = l }
  }
  return { period: (lag / FPS) * 1000, confidence: best }
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

  const level = { mid: follower(), high: follower(), bass: follower(), voice: follower(0.998) }
  const recent = [] // bass flux over the last 1.5 s, for beat detection
  const rhythm = [] // bass flux over the tempo window
  const waves = []
  const sparks = new Float32Array(room.len)
  const glow = new Float32Array(3)
  let lastBeat = 0, lastDrop = 0, flash = 0, flashHue = 0
  let shortE = 0, longE = 0, tone = 0.5
  let period = 500, confidence = 0, nextGrid = 0, beatNo = 0, gridHit = false
  let barTarget = 0, voice = 0, ribbonPos = Math.random() * room.len
  let frame = 0, t0 = performance.now()
  let named = null, style = 'pop', hueA = 200, hueB = 300
  const feel = { bassShare: 0.4, brightness: 0.5, loudness: 0.1, vocal: 0.3 }
  window.live.onGenre((g) => { named = g })

  const wave = (now, power, hue) => {
    waves.push({
      born: now,
      origin: Math.floor(Math.random() * room.len),
      dir: beatNo % 2 ? 1 : -1,
      hue,
      power,
      width: 3 + 5 * power,
      speed: 45 + 65 * power,
      life: 1.1 + 0.8 * power,
    })
  }

  const tick = () => {
    const now = performance.now()
    const dt = (now - t0) / 1000
    t0 = now
    frame++
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

    // How the music feels over roughly ten seconds, for guessing the genre without a title
    const ease = 0.003
    feel.bassShare += ((energy ? bassRaw / (3 * energy) : 0) - feel.bassShare) * ease
    feel.brightness += (t - feel.brightness) * ease
    feel.loudness += (energy - feel.loudness) * ease
    feel.vocal += (voice - feel.vocal) * ease
    if (frame % (FPS * 2) === 0) {
      const sound = { bpm: 60000 / period, steady: confidence, ...feel }
      const base = named ?? guessGenre(sound)
      style = base === 'hiphop' ? guessRap(sound) : base
    }
    const [pa, pb] = PALETTES[style]
    // Bars swap the two hues, so the room changes colour on the bar
    const lead = (barTarget / BAR_STEP) % 2 ? [pb, pa] : [pa, pb]
    hueA = towards(hueA, lead[0], 0.05)
    hueB = towards(hueB, lead[1], 0.05)
    // The brightness of the sound nudges both hues a little, so the colours still breathe
    const nudge = (tone - 0.5) * 20
    const hue = hueA + nudge

    // Tempo, re-estimated four times a second
    rhythm.push(bassFlux)
    if (rhythm.length > FPS * TEMPO_WINDOW) rhythm.shift()
    if (frame % 15 === 0 && rhythm.length > FPS * 3) {
      const est = tempo(rhythm)
      confidence += (est.confidence - confidence) * 0.3
      if (est.period) period += (est.period - period) * 0.3
    }
    const steady = confidence > 0.25 && !quiet

    // A beat is a bass rise well above what the last second and a half was doing
    recent.push(bassFlux)
    if (recent.length > FPS * 1.5) recent.shift()
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length
    const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length)
    const hit = !quiet && bassFlux > mean + 1.5 * sd && bassFlux > 0.02 && now - lastBeat > MIN_GAP
    if (hit) {
      lastBeat = now
      // A hit close to where the grid expected one pulls the grid onto the music
      if (Math.abs(now - nextGrid) < period * 0.25 || !steady) nextGrid = now
      gridHit = true
      wave(now, Math.min(1, 0.4 + bass * 0.6), (beatNo % 2 ? hueA : hueB) + nudge + (Math.random() - 0.5) * 16)
    }

    // The beat grid keeps the rhythm going: it counts beats and bars, and fills in a soft wave
    // on a beat the detector missed
    if (now >= nextGrid) {
      if (steady && !gridHit && now - lastBeat > period * 0.5) wave(now, 0.3, beatNo % 2 ? hueA : hueB)
      gridHit = false
      beatNo++
      if (beatNo % 4 === 0) barTarget += BAR_STEP
      nextGrid += period
      if (nextGrid < now) nextGrid = now + period
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

    // Voice sits in 300-3400 Hz and holds steady, unlike drums: its level against the bass
    // rises drive the ribbon, so a kick drum alone does not light it up
    const vocal = quiet ? 0 : Math.max(0, level.voice(band(300, 3400)) - bassFlux * 4)
    voice += (Math.max(0, vocal - 0.45) / 0.55 - voice) * 0.06
    ribbonPos = (ribbonPos + RIBBON_SPEED * dt) % room.len

    const g = hsv(hueB + nudge, 0.7, quiet ? 0 : GLOW * (0.2 + 0.8 * mid))
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

      const rd = Math.min(Math.abs(v - ribbonPos), room.len - Math.abs(v - ribbonPos)) / RIBBON_WIDTH
      if (voice > 0.01 && rd < 2) {
        const c = hsv(hue, 0.25, RIBBON * voice * Math.exp(-rd * rd))
        r = Math.max(r, c[0]); gg = Math.max(gg, c[1]); b = Math.max(b, c[2])
      }

      for (const wv of waves) {
        // Distance from where the wave started in the direction it runs round the room
        const d = (((v - wv.origin) * wv.dir) % room.len + room.len) % room.len
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
