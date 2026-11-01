export type RGB = [number, number, number]

export interface Light {
  on: boolean
  bri: number
  cols: [RGB, RGB, RGB]
  fx: number
  sx: number
  pal: number
  // Where each colour part starts, per colour count (index 2 and 3)
  bounds: number[][]
  len: number
  // Preset the controller says is active, -1 after any change
  ps: number
  // Live mode the desktop app paints the room with: from the screen or from the sound
  live: LiveMode | null
}

export type LiveMode = 'cinema' | 'music'
const LIVE_MODES: LiveMode[] = ['cinema', 'music']

export interface Preset {
  id: number
  name: string
}

interface WledSegment {
  start?: number
  stop?: number
  col?: number[][]
  fx?: number
  sx?: number
  pal?: number
  n?: string
}

interface WledState {
  on: boolean
  bri: number
  ps?: number
  seg?: WledSegment[]
}

export const STATIC = 0

// The number of colours is stored on the controller as the palette, which is also how
// animated effects pick them up: "* Colors 1&2" (3) for two, "* Color Gradient" (4) for three
export const PAL_FOR_COUNT = [0, 0, 3, 4]
export const countFromPal = (pal: number) => (pal === 4 ? 3 : pal === 3 ? 2 : 1)

// The strip runs around the room, so the parts are rarely equal: the user puts each boundary
// where it fits the walls. The boundaries are kept on the controller in segment 0's name
// ("2:0,68;3:0,55,111"), so every device shows the same split. The same name carries the
// live mode ("cinema", "music"), which the desktop app watches. The controller's LED map starts
// the strip in the middle of a short wall, so the default two-part split halves the room.
export const equalBounds = (n: number, len: number) =>
  Array.from({ length: n }, (_, i) => Math.round((len * i) / n))

const boundsFor = (l: Pick<Light, 'bounds' | 'len'>, n: number) => l.bounds[n] ?? equalBounds(n, l.len)

const encodeName = (l: Light) =>
  [...[2, 3].filter((n) => l.bounds[n]).map((n) => `${n}:${l.bounds[n].join(',')}`), ...(l.live ? [l.live] : [])]
    .join(';')

function decodeBounds(name: string | undefined, prev: number[][]) {
  const out = [...prev]
  for (const part of name?.split(';') ?? []) {
    const [n, list] = part.split(':')
    const b = list?.split(',').map(Number)
    if ((n === '2' || n === '3') && b?.length === +n && b.every(Number.isFinite)) out[+n] = b
  }
  return out
}

// Colour i covers [b[i], b[i+1]); the last part runs past the strip's end back to b[0]
function parts(b: number[], len: number) {
  return b.map((start, i) => [start, i + 1 < b.length ? b[i + 1] : b[0] + len] as const)
}

// Segments for the parts in strip order; a part that wraps past the strip's end is cut in two
export function pieces(b: number[], len: number) {
  const out: [number, number, number][] = []
  parts(b, len).forEach(([a, z], i) => {
    if (z <= len) out.push([a, z, i])
    else out.push([a, len, i], [0, z - len, i])
  })
  return out.filter(([a, z]) => z > a).sort((x, y) => x[0] - y[0])
}

// A static multi-colour light is one solid segment per part, effects a single segment.
// `stop: 0` deletes the segments that are not needed.
export function layout(l: Light, n: number) {
  const pal = PAL_FOR_COUNT[n]
  const name = encodeName(l)
  const used: object[] = []
  if (l.fx !== STATIC || n === 1) {
    used.push({ start: 0, stop: l.len, col: l.cols })
  } else {
    for (const [start, stop, i] of pieces(boundsFor(l, n), l.len))
      used.push({ start, stop, col: [l.cols[i]], on: true, bri: 255 })
  }
  return [
    ...used.map((g, id) => ({ id, fx: l.fx, sx: l.sx, pal, n: name, frz: false, rev: false, ...g })),
    ...[0, 1, 2, 3].slice(used.length).map((id) => ({ id, stop: 0 })),
  ]
}

export function toLight(s: WledState, prev: Light): Light {
  const segs = s.seg ?? []
  const seg = segs[0] ?? {}
  const len = segs.length ? Math.max(...segs.map((g) => g.stop ?? 0)) : prev.len
  const pal = seg.pal ?? prev.pal
  const n = countFromPal(pal)
  const bounds = decodeBounds(seg.n, prev.bounds)
  const split = segs.length > 1 && seg.fx === STATIC
  const ranges = parts(boundsFor({ bounds, len }, n), len)
  return {
    on: s.on,
    bri: s.bri,
    cols: prev.cols.map((c, i) => {
      // In split mode take each colour from the segment under the middle of its part
      const mid = i < n ? Math.floor((ranges[i][0] + ranges[i][1]) / 2) % len : -1
      const src = split
        ? segs.find((g) => (g.start ?? 0) <= mid && mid < (g.stop ?? 0))?.col?.[0]
        : seg.col?.[i]
      return (src?.slice(0, 3) as RGB) ?? c
    }) as Light['cols'],
    fx: seg.fx ?? prev.fx,
    sx: seg.sx ?? prev.sx,
    pal,
    bounds,
    len,
    ps: s.ps ?? prev.ps,
    live: seg.n === undefined
      ? prev.live
      : LIVE_MODES.find((m) => seg.n!.split(';').includes(m)) ?? null,
  }
}

// Live connection over the WLED WebSocket, so changes made from another
// device (phone, PC, button) show up immediately. Falls back to HTTP for sends.
export class Wled {
  private ws?: WebSocket
  private retry?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(
    private host: string,
    private onState: (s: WledState) => void,
    private onConnection: (ok: boolean) => void,
  ) {
    this.connect()
    fetch(`http://${host}/json/state`)
      .then((r) => r.json())
      .then(onState)
      .catch(() => {})
  }

  private connect() {
    if (this.closed) return
    const ws = new WebSocket(`ws://${this.host}/ws`)
    this.ws = ws
    ws.onopen = () => this.onConnection(true)
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.state) this.onState(d.state)
      } catch {
        // WLED also pushes non-JSON frames (e.g. live LED previews); ignore them
      }
    }
    ws.onclose = () => {
      this.onConnection(false)
      this.retry = setTimeout(() => this.connect(), 2000)
    }
  }

  send(patch: object) {
    const body = JSON.stringify(patch)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(body)
      return
    }
    fetch(`http://${this.host}/json/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {})
  }

  async presets(): Promise<Preset[]> {
    const all: Record<string, { n?: string }> = await fetch(`http://${this.host}/presets.json`).then((r) => r.json())
    return Object.entries(all)
      .filter(([id, p]) => +id > 0 && p.n)
      .map(([id, p]) => ({ id: +id, name: p.n! }))
      .sort((a, b) => a.id - b.id)
  }

  // The controller writes presets to flash, which takes a moment; callers re-read the list after
  savePreset(id: number, name: string) {
    this.send({ psave: id, n: name, ib: true, sb: true })
  }

  deletePreset(id: number) {
    this.send({ pdel: id })
  }

  close() {
    this.closed = true
    clearTimeout(this.retry)
    this.ws?.close()
  }
}
