export type RGB = [number, number, number]

export interface Light {
  on: boolean
  bri: number
  col: RGB
  fx: number
  sx: number
}

interface WledSegment {
  col?: number[][]
  fx?: number
  sx?: number
}

interface WledState {
  on: boolean
  bri: number
  seg?: WledSegment[]
}

export function toLight(s: WledState, prev: Light): Light {
  const seg = s.seg?.[0] ?? {}
  return {
    on: s.on,
    bri: s.bri,
    col: seg.col ? (seg.col[0].slice(0, 3) as RGB) : prev.col,
    fx: seg.fx ?? prev.fx,
    sx: seg.sx ?? prev.sx,
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

  close() {
    this.closed = true
    clearTimeout(this.retry)
    this.ws?.close()
  }
}
