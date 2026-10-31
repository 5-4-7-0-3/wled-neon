import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Wled, toLight, type Light, type RGB } from './wled'
import { desktop, getHost, setHost } from './platform'

const COLORS: RGB[] = [
  [255, 160, 60], [255, 255, 255], [255, 0, 0], [255, 90, 0], [255, 200, 0],
  [0, 255, 0], [0, 255, 200], [0, 80, 255], [140, 0, 255], [255, 0, 120],
]

// IDs from the controller's /json/eff list (WLED 0.15)
const EFFECTS: [number, string][] = [
  [0, 'Статичний'], [2, 'Дихання'], [88, 'Свічка'], [66, 'Вогонь'],
  [9, 'Веселка'], [38, 'Аврора'], [17, 'Мерехтіння'], [67, 'Хвилі'],
]

function hsvToRgb(h: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return [f(5), f(3), f(1)]
}

function rgbToHue([r, g, b]: RGB): number {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b)
  if (!d) return 0
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return Math.round((h * 60 + 360) % 360)
}

// Sends at most once per `ms`, always delivering the last value
function useThrottle<T>(fn: (v: T) => void, ms = 80) {
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  return (v: T) => {
    clearTimeout(timer.current)
    const wait = ms - (Date.now() - last.current)
    const run = () => { last.current = Date.now(); fn(v) }
    if (wait <= 0) run()
    else timer.current = setTimeout(run, wait)
  }
}

export function App() {
  const [light, setLight] = useState<Light>({ on: false, bri: 128, col: [255, 160, 60], fx: 0, sx: 128 })
  const [online, setOnline] = useState(false)
  const [host, setHostState] = useState<string>()
  const [editing, setEditing] = useState(false)
  const wled = useRef<Wled>(undefined)
  // Pushes from the controller lag behind a dragged slider; ignore them briefly
  const quietUntil = useRef(0)
  const root = useRef<HTMLElement>(null)

  useEffect(() => { getHost().then(setHostState) }, [])

  useEffect(() => {
    if (!host) return
    const w = new Wled(
      host,
      (s) => { if (Date.now() > quietUntil.current) setLight((p) => toLight(s, p)) },
      setOnline,
    )
    wled.current = w
    return () => w.close()
  }, [host])

  // Desktop popup sizes itself to the content
  useLayoutEffect(() => {
    const d = desktop, el = root.current
    if (!d || !el) return
    const ro = new ResizeObserver(() => d.resize(Math.ceil(el.getBoundingClientRect().height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const d = desktop
    if (!d) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') d.hide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const send = (patch: object) => {
    quietUntil.current = Date.now() + 600
    wled.current?.send(patch)
  }
  const sendThrottled = useThrottle(send)

  const update = (next: Partial<Light>, patch: object, throttled = false) => {
    setLight((p) => ({ ...p, ...next }))
    // tt:0 skips WLED's 0.7 s crossfade, which feels like lag while dragging a slider
    throttled ? sendThrottled({ ...patch, tt: 0 }) : send(patch)
  }

  const setColor = (col: RGB, throttled = false) =>
    update({ col, on: true }, { on: true, seg: [{ col: [col] }] }, throttled)

  const saveHost = (value: string) => {
    const h = value.trim()
    setEditing(false)
    if (!h || h === host) return
    setHost(h).then(() => setHostState(h))
  }

  const colorful = Math.max(...light.col) - Math.min(...light.col) > 40
  const style = { '--c': light.col.join(',') } as React.CSSProperties

  return (
    <main ref={root} className={light.on ? 'panel' : 'panel off'} style={style}>
      <header>
        <h1>Неон</h1>
        <button className="icon" onClick={() => setEditing((v) => !v)} aria-label="Адреса контролера">
          <span className={online ? 'dot ok' : 'dot'} />
        </button>
      </header>

      {editing && (
        <form className="card host" onSubmit={(e) => { e.preventDefault(); saveHost(new FormData(e.currentTarget).get('host') as string) }}>
          <label htmlFor="host">Адреса контролера</label>
          <div className="host-row">
            <input id="host" name="host" defaultValue={host} autoFocus spellCheck={false} />
            <button type="submit">OK</button>
          </div>
        </form>
      )}

      <button
        className="power"
        aria-label={light.on ? 'Вимкнути' : 'Увімкнути'}
        onClick={() => update({ on: !light.on }, { on: !light.on })}
      >
        <svg viewBox="0 0 24 24"><path d="M12 3v9" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" /></svg>
      </button>

      <section className="card">
        <div className="row"><span>Яскравість</span><span>{Math.round(light.bri / 2.55)}%</span></div>
        <input
          className="bri" type="range" min={1} max={255} value={light.bri}
          onChange={(e) => update({ bri: +e.target.value, on: true }, { on: true, bri: +e.target.value }, true)}
        />
      </section>

      <section className="card">
        <div className="row"><span>Колір</span></div>
        <input
          className="hue" type="range" min={0} max={359}
          value={colorful ? rgbToHue(light.col) : 0}
          onChange={(e) => setColor(hsvToRgb(+e.target.value), true)}
        />
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c.join()} aria-label="Колір" style={{ background: `rgb(${c})` }}
              className={c.join() === light.col.join() ? 'on' : ''}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="row"><span>Режим</span></div>
        <div className="effects">
          {EFFECTS.map(([id, name]) => (
            <button
              key={id} className={id === light.fx ? 'on' : ''}
              onClick={() => update({ fx: id, on: true }, { on: true, seg: [{ fx: id }] })}
            >{name}</button>
          ))}
        </div>
        {light.fx !== 0 && (
          <>
            <div className="row"><span>Швидкість</span></div>
            <input
              type="range" min={0} max={255} value={light.sx}
              onChange={(e) => update({ sx: +e.target.value }, { seg: [{ sx: +e.target.value }] }, true)}
            />
          </>
        )}
      </section>
    </main>
  )
}
