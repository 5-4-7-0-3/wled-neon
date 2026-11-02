// Game mode: the strip runs round the ceiling of the whole room, so it carries the scene's mood
// rather than flashing with every frame. The room takes the scene's main colour, strongest above
// the monitor, and the wall with the monitor also shows the picture's own colours. Sharp sounds
// send a soft wave out from the monitor along the ceiling, brightening the scene's own colour as it
// passes, towards the side the sound came from; loud heavy moments brighten the light above the
// monitor for a moment.
//
// Games with a profile get their own touches on top (see PROFILES below).

window.screenProfile = {
  layout: 'mood',
  fps: 40,
  smoothCalm: 0.06, // about half a second to get two thirds of the way
  smoothCut: 0.18,
  cut: 80,
  level: 0.95,
  spread: 40,
  floor: 0.18,
  detail: 0.6,
  screenBand: [0.1, 0.45],
  audio: true,
}

const WAVE_GAIN = 0.7 // how much brighter a wave makes the colour it passes over
const WAVE_SPEED = 55 // LEDs per second
const WAVE_WIDTH = 6
const WAVE_LIFE = 1.1 // seconds
const WAVE_GAP = 330 // ms, at most three waves a second
const PAN = 0.2 // how far off centre a sound must be to count as left or right
const SWELL = 0.35
const SWELL_REACH = 18

let room, gain, add, sound, fx = null

window.live.onProfile((p) => {
  fx = PROFILES[p]?.() ?? null
})
window.live.onInput((e) => fx?.input?.(e))

window.onScreenStream = (stream, r) => {
  room = r
  gain = new Float32Array(r.len * 3)
  add = new Float32Array(r.len * 3)
  const tracks = stream.getAudioTracks()
  if (!tracks.length) return

  // The sound is captured from the output that was the default when capture started; switching
  // speakers or headphones means starting over
  let restarting = false
  const restart = () => {
    if (restarting) return
    restarting = true
    setTimeout(() => location.reload(), 1000)
  }
  navigator.mediaDevices.addEventListener('devicechange', restart)
  tracks.forEach((t) => t.addEventListener('ended', restart))

  const audio = new AudioContext()
  const split = audio.createChannelSplitter(2)
  audio.createMediaStreamSource(new MediaStream(tracks)).connect(split)
  const mute = audio.createGain()
  mute.gain.value = 0
  mute.connect(audio.destination)
  const channel = (i) => {
    const a = audio.createAnalyser()
    a.fftSize = 512
    a.smoothingTimeConstant = 0
    split.connect(a, i)
    // An analyser that leads nowhere may not be processed; the muted output keeps it running
    a.connect(mute)
    return { a, bins: new Uint8Array(a.frequencyBinCount), prev: new Uint8Array(a.frequencyBinCount) }
  }
  sound = {
    L: channel(0), R: channel(1), hz: audio.sampleRate / 512,
    history: [], waves: [], last: 0, calm: 0, swell: 0,
  }
}

// Energy and rise of the sound between two frequencies, both channels together or one of them
function measure(lo, hi, ch) {
  const chans = ch ? [ch] : [sound.L, sound.R]
  const a = Math.max(1, Math.floor(lo / sound.hz)), b = Math.ceil(hi / sound.hz)
  let e = 0, f = 0
  for (const c of chans) {
    for (let i = a; i < b; i++) {
      e += c.bins[i]
      f += Math.max(0, c.bins[i] - c.prev[i])
    }
  }
  const n = (b - a) * chans.length * 255
  return { e: e / n, f: f / n }
}

// Signed position round the room from the monitor: `d` LEDs away, `dir` 1 to the left, -1 to the right
function fromMonitor(v) {
  const towardsLeft = (v - room.screen.center + room.len) % room.len
  return towardsLeft <= room.len / 2 ? { d: towardsLeft, dir: 1 } : { d: room.len - towardsLeft, dir: -1 }
}

const addLight = (v, [r, g, b], k) => {
  add[v * 3] += r * k
  add[v * 3 + 1] += g * k
  add[v * 3 + 2] += b * k
}

window.screenOverlay = (now, frame) => {
  if (!room) return null
  gain.fill(0)
  add.fill(0)
  if (!sound) return { gain, add }
  for (const ch of [sound.L, sound.R]) {
    ch.prev.set(ch.bins)
    ch.a.getByteFrequencyData(ch.bins)
  }
  const l = measure(60, 6000, sound.L), r = measure(60, 6000, sound.R)
  const low = measure(30, 300).e
  const rise = (l.f + r.f) / 2

  // A sharp sound is a rise well above what the last second or so was doing
  const h = sound.history
  h.push(rise)
  if (h.length > 40) h.shift()
  const mean = h.reduce((a, b) => a + b, 0) / h.length
  const sd = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / h.length)
  if (rise > mean + 3 * sd && rise > 0.04 && now - sound.last > WAVE_GAP) {
    sound.last = now
    const pan = (r.e - l.e) / (r.e + l.e + 1e-6)
    sound.waves.push({ born: now, side: pan < -PAN ? 1 : pan > PAN ? -1 : 0, power: Math.min(1, 0.4 + rise * 5) })
  }
  sound.waves = sound.waves.filter((w) => now - w.born < WAVE_LIFE * 1000)

  // Loud is measured against the last half minute or so, so a quiet game and a loud one both
  // swell only on their own big moments
  sound.calm += (low - sound.calm) * 0.002
  const want = low > sound.calm * 1.6 && low > 0.25 ? Math.min(1, (low / Math.max(sound.calm, 0.05) - 1.6) / 1.5) : 0
  sound.swell += (want - sound.swell) * (want > sound.swell ? 0.12 : 0.02)

  // A profile can quieten the general reactions, e.g. while sneaking past BTs
  const quiet = fx?.quiet?.() ?? 0
  for (let v = 0; v < room.len; v++) {
    const { d, dir } = fromMonitor(v)
    let g = SWELL * sound.swell * Math.exp(-d / SWELL_REACH)
    for (const w of sound.waves) {
      if (w.side && w.side !== dir) continue
      const age = (now - w.born) / 1000
      const x = (d - age * WAVE_SPEED) / WAVE_WIDTH
      if (x < -2 || x > 2) continue
      g += WAVE_GAIN * w.power * Math.exp(-x * x) * (1 - age / WAVE_LIFE)
    }
    gain[v * 3] = gain[v * 3 + 1] = gain[v * 3 + 2] = g * (1 - quiet)
  }
  fx?.tick(now, frame)
  return { gain, add }
}

// ---- Profiles ----

// Colour make-up of the picture: how grey it is, how bright, and how much of it is bright orange
function look({ px, W, top, bottom, left, right }) {
  let sat = 0, bright = 0, blue = 0, orange = 0, n = 0
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = (y * W + x) * 4
      const r = px[i], g = px[i + 1], b = px[i + 2]
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      n++
      bright += mx / 255
      if (mx > 20) sat += (mx - mn) / mx
      blue += (b - r) / 255
      // Bright saturated orange: the odradek's light when it opens
      if (mx > 200 && (mx - mn) / mx > 0.6 && r === mx && g > b && g < r * 0.75) orange++
    }
  }
  return { sat: sat / n, bright: bright / n, blue: blue / n, orange: orange / n }
}

const PROFILES = {
  // Death Stranding and Death Stranding 2
  //  - BTs: the picture turns grey and dark while the odradek glows orange; the room dims and an
  //    orange pulse beats above the monitor, faster the more of the odradek's glow is on screen
  //  - heartbeat: near BTs, low thumps in the sound pulse the room a faint red
  //  - holding the breath (left Alt, or holding the bumper): the room almost goes out and stays
  //    still until the breath is let go
  //  - scan (Q, or tapping the bumper): a white-blue ring runs from the monitor round the room
  //  - timefall: grey-blue picture with the hiss of rain; the room cools and grey drops creep along
  //    the ceiling
  deathStranding() {
    const ODRADEK = [255, 110, 20]
    const SCAN = [170, 225, 255]
    const HEART = [255, 25, 35]
    const DROP = [110, 140, 185]
    let bt = 0, breath = 0, holding = false, rain = 0
    let scans = [], beats = [], drops = [], beatHist = [], lastBeat = 0

    return {
      input(e) {
        if (e.scan) scans.push(performance.now())
        if ('breath' in e) holding = e.breath
      },
      quiet: () => Math.max(bt * 0.8, breath),
      tick(now, frame) {
        const s = look(frame)

        // BTs: a grey, dark picture with the odradek's orange glow in it
        const btWant = s.sat < 0.2 && s.bright < 0.45 && s.orange > 0.0015 ? Math.min(1, 0.5 + s.orange * 60) : 0
        bt += (btWant - bt) * (btWant > bt ? 0.05 : 0.008)

        // Holding the breath only matters near BTs; elsewhere the button does other things
        const breathWant = holding && bt > 0.15 ? 1 : 0
        breath += (breathWant - breath) * 0.08

        // Timefall: grey-blue picture and the steady hiss of rain
        const hiss = measure(4000, 11000)
        const raining = s.sat < 0.3 && s.blue > 0.01 && s.bright > 0.2 && hiss.e > 0.12 && hiss.f < hiss.e * 0.12
        rain += ((raining ? 1 : 0) - rain) * (raining ? 0.01 : 0.004)

        // Heartbeat near BTs: low thumps rising over the last second's level
        const thump = measure(30, 90).f
        beatHist.push(thump)
        if (beatHist.length > 40) beatHist.shift()
        const m = beatHist.reduce((a, b) => a + b, 0) / beatHist.length
        const sd = Math.sqrt(beatHist.reduce((a, b) => a + (b - m) ** 2, 0) / beatHist.length)
        if (bt > 0.3 && thump > m + 2.5 * sd && thump > 0.03 && now - lastBeat > 250) {
          lastBeat = now
          beats.push(now)
        }
        beats = beats.filter((t) => now - t < 300)
        scans = scans.filter((t) => now - t < 1600)

        if (rain > 0.05 && Math.random() < rain * 0.15) {
          drops.push({ born: now, at: Math.random() * room.len, dir: Math.random() < 0.5 ? 1 : -1 })
        }
        drops = drops.filter((d) => now - d.born < 2500)

        const pulseHz = 0.6 + 1.6 * bt
        const pulse = (0.5 + 0.5 * Math.sin((now / 1000) * Math.PI * 2 * pulseHz)) ** 2
        for (let v = 0; v < room.len; v++) {
          const { d } = fromMonitor(v)
          const i = v * 3
          const dim = Math.max(bt * 0.55, rain * 0.25, breath * 0.85)
          gain[i] = gain[i + 1] = gain[i + 2] = gain[i] * (1 - dim) - dim

          addLight(v, ODRADEK, 0.5 * bt * pulse * Math.exp(-d / 22) * (1 - breath * 0.7))
          for (const t of beats) {
            addLight(v, HEART, 0.4 * (1 - (now - t) / 300) * (0.4 + 0.6 * Math.exp(-d / 30)) * (1 - breath * 0.7))
          }
          for (const t of scans) {
            const age = (now - t) / 1000
            const x = (d - age * 110) / 7
            if (x > -2 && x < 2) addLight(v, SCAN, 0.9 * Math.exp(-x * x) * (1 - age / 1.6))
          }
        }
        for (const drop of drops) {
          const age = (now - drop.born) / 1000
          const head = drop.at + drop.dir * age * 8
          for (let k = 0; k < 3; k++) {
            const v = Math.floor(((head - drop.dir * k) % room.len + room.len) % room.len)
            addLight(v, DROP, 0.35 * rain * (1 - age / 2.5) * (1 - k / 3))
          }
        }
      },
    }
  },

  // Don't Starve Together (and Don't Starve)
  //  - night by a fire: the picture is dark around a warm spot; the room dims and firelight
  //    flickers above the monitor, dying away along the walls
  //  - darkness with no light at all: the room all but goes out
  //  - lightning: the whole picture flashes; so does the room
  //  - freezing / overheating: frost or heat creeps in from the picture's edges; the room slowly
  //    cools to icy blue with glints, or smoulders red
  //  - seasons, told apart by the daytime ground over the last minute or so: autumn glows amber
  //    with leaves drifting along the ceiling, winter is cold white with falling snow, spring a
  //    fresh green, summer a hot golden yellow
  dontStarve() {
    const FIRE = [255, 120, 30]
    const ICE = [150, 205, 255]
    const HEAT = [255, 50, 15]
    const SEASONS = {
      autumn: { tint: [255, 110, 20], fleck: [255, 70, 10] },
      winter: { tint: [170, 200, 255], fleck: [235, 245, 255] },
      spring: { tint: [60, 255, 90] },
      summer: { tint: [255, 190, 30] },
    }
    let fire = 0, dark = 0, cold = 0, hot = 0, flash = 0, avg = 0.3
    let glints = [], flecks = []
    const votes = { autumn: 0, winter: 0, spring: 0, summer: 0 }
    let season = null, seasonK = 0

    // Fire pixels, overall brightness, and pale-blue / red share of the edges against the middle
    const read = ({ px, W, top, bottom, left, right }) => {
      const bw = Math.max(2, Math.round((right - left) * 0.12)), bh = Math.max(2, Math.round((bottom - top) * 0.15))
      let bright = 0, flame = 0, n = 0, iceE = 0, iceM = 0, redE = 0, redM = 0, nE = 0, nM = 0
      const ground = { autumn: 0, winter: 0, spring: 0, summer: 0 }
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const i = (y * W + x) * 4
          const r = px[i], g = px[i + 1], b = px[i + 2]
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
          n++
          bright += mx / 255
          if (r > 170 && g > r * 0.3 && g < r * 0.8 && b < r * 0.45) flame++
          // Each season paints the ground its own way: snow, lush green, sun-bleached yellow, or
          // the orange-brown of autumn
          const sat = mx > 20 ? (mx - mn) / mx : 0
          if (mx > 170 && sat < 0.15) ground.winter++
          else if (sat > 0.25 && g === mx && g > r * 1.1 && g > b * 1.2) ground.spring++
          else if (sat > 0.3 && r > 140 && g > r * 0.75 && b < g * 0.6) ground.summer++
          else if (sat > 0.3 && r === mx && g < r * 0.75 && g > b * 1.1) ground.autumn++
          const ice = b > 150 && b >= r && g > r * 0.9 && b - r > 15 && r > 90
          const red = r > 120 && r > g * 1.8 && r > b * 1.8
          const edge = x < left + bw || x > right - bw || y < top + bh || y > bottom - bh
          if (edge) { nE++; iceE += ice; redE += red } else { nM++; iceM += ice; redM += red }
        }
      }
      for (const k in ground) ground[k] /= n
      return {
        bright: bright / n, flame: flame / n, ground,
        ice: iceE / nE - iceM / Math.max(1, nM), red: redE / nE - redM / Math.max(1, nM),
      }
    }

    return {
      quiet: () => Math.max(dark, fire * 0.7),
      tick(now, frame) {
        const s = read(frame)

        // A flash is a jump far above the last second's brightness
        if (s.bright > avg + 0.25 && s.bright > 0.5) flash = 1
        avg += (s.bright - avg) * 0.05
        flash *= 0.9

        const night = s.bright < 0.2
        fire += ((night && s.flame > 0.003 ? 1 : 0) - fire) * 0.04
        dark += ((s.bright < 0.06 && s.flame < 0.001 ? 1 : 0) - dark) * 0.03
        cold += ((s.ice > 0.2 ? Math.min(1, (s.ice - 0.2) * 3 + 0.4) : 0) - cold) * 0.02
        hot += ((s.red > 0.2 ? Math.min(1, (s.red - 0.2) * 3 + 0.4) : 0) - hot) * 0.02

        if (cold > 0.2 && Math.random() < cold * 0.2) glints.push({ born: now, at: Math.floor(Math.random() * room.len) })
        glints = glints.filter((g) => now - g.born < 900)

        // Seasons change over days of play, so only a long daytime look decides; the night, a fire
        // or a flash says nothing about the ground. A new season has to lead clearly to take over.
        if (s.bright > 0.25 && flash < 0.1) {
          for (const k in votes) votes[k] += (s.ground[k] - votes[k]) * 0.0006
        }
        const lead = Object.keys(votes).reduce((a, b) => (votes[b] > votes[a] ? b : a))
        if (lead !== season && votes[lead] > 0.08 && votes[lead] > (votes[season] ?? 0) * 1.3) {
          seasonK = Math.max(0, seasonK - 0.004)
          if (seasonK === 0) season = lead
        } else if (season) {
          seasonK = Math.min(1, seasonK + 0.004)
        }
        const theme = season && SEASONS[season]
        const tintK = seasonK * (1 - Math.max(dark, fire, cold, hot))
        if (theme?.fleck && tintK > 0.3 && Math.random() < 0.06) {
          flecks.push({ born: now, at: Math.random() * room.len, dir: Math.random() < 0.5 ? 1 : -1 })
        }
        flecks = flecks.filter((f) => now - f.born < 4000)

        const t = now / 1000
        const smoulder = 0.6 + 0.4 * Math.sin(t * 1.3)
        for (let v = 0; v < room.len; v++) {
          const { d } = fromMonitor(v)
          const i = v * 3
          const dim = Math.max(dark * 0.85, fire * 0.6)
          gain[i] = gain[i + 1] = gain[i + 2] = gain[i] * (1 - dim) - dim

          // Several slow waves out of step make the flame's flicker, a little different per LED
          const flicker = 0.65 + 0.2 * Math.sin(t * 7.3 + v * 0.4) + 0.15 * Math.sin(t * 13.1 + v * 0.9) + 0.1 * Math.sin(t * 3.1)
          addLight(v, FIRE, 0.55 * fire * flicker * Math.exp(-d / 20))
          addLight(v, ICE, 0.18 * cold)
          addLight(v, HEAT, 0.22 * hot * smoulder)
          addLight(v, [255, 255, 255], 0.8 * flash)
          if (theme) addLight(v, theme.tint, 0.12 * tintK)
        }
        // Snowflakes and leaves drift slowly along the ceiling, swaying as they go
        for (const f of flecks) {
          const age = (now - f.born) / 1000
          const v = Math.floor(((f.at + f.dir * age * 3 + Math.sin(age * 2.5) * 2) % room.len + room.len) % room.len)
          addLight(v, theme?.fleck ?? [0, 0, 0], 0.4 * tintK * Math.sin((Math.PI * age) / 4))
        }
        for (const g of glints) {
          const k = 1 - (now - g.born) / 900
          addLight(g.at, [230, 245, 255], 0.6 * cold * k * k)
        }
      },
    }
  },
}
