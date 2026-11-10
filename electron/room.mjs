// Where the strip runs, shared by the app (calibration) and the PC's live modes.
//
// The user marks a few LEDs and the rest follows. Three placements:
//  - room: round the room under the ceiling. Marks: the two corners of the wall with the monitor
//    (left and right as seen facing it), the two far corners, the LED above the monitor, and
//    optionally the stretch above a bed.
//  - screen: round the back of a monitor or TV. Marks: its four corners.
//  - line: along one wall, a desk or a shelf. Marks: the left and right ends and the LED nearest
//    the middle of the monitor.
// The strip may start anywhere and run either way: the direction is read from the marks.
//
// Each LED gets a role saying what part of the picture it shows (used by the cinema mode), and
// its distance `d` from the monitor with the side `dir` it is on, 1 left and -1 right (used by
// the effects that spread out from the monitor). LEDs outside a line are off.

export const LAYOUTS = ['room', 'screen', 'line']

const mod = (v, n) => ((v % n) + n) % n

// LEDs from `a` to `b` inclusive, stepping `step` round a strip of `len`
function walk(a, b, step, len) {
  const out = [a]
  for (let v = a; v !== b && out.length <= len; ) out.push((v = mod(v + step, len)))
  return out
}

// Whether going from `a` to `b` in `step` passes none of `others`
const clear = (a, b, step, others, len) => {
  const inside = walk(a, b, step, len).slice(1, -1)
  return !others.some((o) => inside.includes(o))
}

export function defaultMarks(layout, len) {
  const at = (f) => Math.round(len * f) % len
  if (layout === 'room') return { fl: at(0.25), fr: 0, bl: at(0.5), br: at(0.75), monitor: at(0.125) }
  // Picture proportions 16:9, starting at the bottom left corner and going up
  if (layout === 'screen') return { bl: 0, tl: at(9 / 50), tr: at(25 / 50), br: at(34 / 50) }
  return { l: 0, r: len - 1, monitor: at(0.5) }
}

// The setup as stored on the controller, completed with defaults. The first version stored only
// a room as four corners counted in strip order; it is turned into marks here.
export function normalize(raw, len) {
  const base = { layout: 'line', marks: defaultMarks('line', len), bed: null, shift: 0, balance: [1, 1, 1], done: false }
  if (!raw) return base
  if (raw.corners && !raw.layout) {
    const [c0, c1, c2, c3] = raw.corners
    return {
      ...base, shift: raw.shift ?? 0, balance: raw.balance ?? base.balance, done: true,
      layout: 'room', marks: { fl: c1 - 1, fr: c0, bl: c2 - 1, br: c3, monitor: raw.monitor ?? 0 }, bed: raw.bed ?? null,
    }
  }
  const layout = LAYOUTS.includes(raw.layout) ? raw.layout : base.layout
  return { ...base, ...raw, layout, marks: { ...defaultMarks(layout, len), ...raw.marks } }
}

// Where along the picture's width an LED of the wall with the monitor sits: the picture is
// centred on the monitor, so each half is stretched over its side of the wall
function across(k, mid, n) {
  if (n < 2) return 0.5
  if (mid <= 0 || mid >= n - 1) return k / (n - 1)
  return k < mid ? (0.5 * k) / mid : 0.5 + (0.5 * (k - mid)) / (n - 1 - mid)
}

// What is wrong with the marks, in words for the user, or null
export function problem(s, len) {
  const m = s.marks
  const vals = Object.values(m)
  if (vals.some((v) => !Number.isInteger(v) || v < 0 || v >= len)) return 'Мітка поза стрічкою'
  if (s.layout === 'room') {
    if (new Set([m.fl, m.fr, m.bl, m.br]).size < 4) return 'Два кути на одному діоді'
    const step = clear(m.fl, m.fr, 1, [m.bl, m.br], len) ? 1 : clear(m.fl, m.fr, -1, [m.bl, m.br], len) ? -1 : 0
    if (!step || !clear(m.fr, m.br, step, [m.bl], len)) return 'Кути йдуть не по колу кімнати'
    if (!walk(m.fl, m.fr, step, len).includes(m.monitor)) return 'Монітор не на стіні між першими двома кутами'
    if (s.bed) {
      const back = walk(m.bl, m.br, -step, len)
      if (!back.includes(s.bed[0]) || !back.includes(s.bed[1])) return 'Ліжко не на дальній стіні'
    }
  }
  if (s.layout === 'screen') {
    if (new Set([m.tl, m.tr, m.br, m.bl]).size < 4) return 'Два кути на одному діоді'
    const step = clear(m.tl, m.tr, 1, [m.br, m.bl], len) ? 1 : -1
    if (!clear(m.tl, m.tr, step, [m.br, m.bl], len) || !clear(m.tr, m.br, step, [m.bl], len)) {
      return 'Кути йдуть не по колу екрана'
    }
  }
  if (s.layout === 'line') {
    if (m.l === m.r) return 'Початок і кінець на одному діоді'
    const step = walk(m.l, m.r, 1, len).includes(m.monitor) ? 1 : -1
    if (!walk(m.l, m.r, step, len).includes(m.monitor)) return 'Монітор не між кінцями'
  }
  return null
}

export function buildRoom(raw, len) {
  const s = normalize(raw, len)
  const m = s.marks
  const roles = Array.from({ length: len }, () => ({ role: 'off' }))
  const d = new Array(len).fill(len), dir = new Array(len).fill(1)
  let center = 0, step = 1, loop = true

  if (s.layout === 'room') {
    step = clear(m.fl, m.fr, 1, [m.bl, m.br], len) ? 1 : -1
    const front = walk(m.fl, m.fr, step, len)
    const mid = Math.max(0, front.indexOf(m.monitor))
    const w = 1 / Math.max(1, front.length)
    front.forEach((v, k) => { const x = across(k, mid, front.length); roles[v] = { role: 'front', x0: Math.max(0, x - w / 2), x1: Math.min(1, x + w / 2) } })
    const left = walk(m.fl, m.bl, -step, len).slice(1)
    left.forEach((v, k) => { roles[v] = { role: 'side', x0: 0, x1: 0.15, t: k / Math.max(1, left.length - 1) } })
    const right = walk(m.fr, m.br, step, len).slice(1)
    right.forEach((v, k) => { roles[v] = { role: 'side', x0: 0.85, x1: 1, t: k / Math.max(1, right.length - 1) } })
    const back = walk(m.bl, m.br, -step, len).slice(1, -1)
    back.forEach((v) => { roles[v] = { role: 'back' } })
    if (s.bed) {
      const [a, b] = [back.indexOf(s.bed[0]), back.indexOf(s.bed[1])].sort((x, y) => x - y)
      if (a >= 0) back.slice(a, b + 1).forEach((v) => { roles[v] = { role: 'bed' } })
    }
    center = m.monitor
  }

  if (s.layout === 'screen') {
    step = clear(m.tl, m.tr, 1, [m.br, m.bl], len) ? 1 : -1
    const edge = (from, to, cut, place) => {
      const list = walk(from, to, step, len).slice(cut[0], cut[1])
      list.forEach((v, k) => { roles[v] = { role: 'edge', ...place((k + 0.5) / list.length) } })
      return list
    }
    const band = 0.15, half = (f, n) => [Math.max(0, f - 0.5 / n), Math.min(1, f + 0.5 / n)]
    const top = edge(m.tl, m.tr, [0], (f) => { const [x0, x1] = half(f, 12); return { x0, x1, y0: 0, y1: band } })
    edge(m.tr, m.br, [1], (f) => { const [y0, y1] = half(f, 8); return { x0: 1 - band, x1: 1, y0, y1 } })
    edge(m.br, m.bl, [1], (f) => { const [x0, x1] = half(1 - f, 12); return { x0, x1, y0: 1 - band, y1: 1 } })
    edge(m.bl, m.tl, [1, -1], (f) => { const [y0, y1] = half(1 - f, 8); return { x0: 0, x1: band, y0, y1 } })
    center = top[Math.floor(top.length / 2)]
  }

  if (s.layout === 'line') {
    step = walk(m.l, m.r, 1, len).includes(m.monitor) ? 1 : -1
    const line = walk(m.l, m.r, step, len)
    const mid = Math.max(0, line.indexOf(m.monitor))
    const w = 1 / Math.max(1, line.length)
    line.forEach((v, k) => {
      const x = across(k, mid, line.length)
      roles[v] = { role: 'front', x0: Math.max(0, x - w / 2), x1: Math.min(1, x + w / 2) }
      d[v] = Math.abs(k - mid)
      dir[v] = k <= mid ? 1 : -1
    })
    center = m.monitor
    loop = false
  }

  if (loop) {
    for (let v = 0; v < len; v++) {
      // Going against the strip's direction from the monitor leads to the picture's left side
      const towardsLeft = mod((v - center) * -step, len)
      d[v] = Math.min(towardsLeft, len - towardsLeft)
      dir[v] = towardsLeft <= len / 2 ? 1 : -1
    }
  }

  return { len, center, roles, d, dir, off: roles.map((r) => r.role === 'off') }
}
