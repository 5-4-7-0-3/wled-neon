import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PAL_FOR_COUNT, SEA, STATIC, Wled, countFromPal, equalBounds, layout, toLight, type Light, type RGB } from './wled'
import { desktop, getHost, setHost } from './platform'

const COLORS: RGB[] = [
  [255, 160, 60], [255, 255, 255], [255, 0, 0], [255, 90, 0], [255, 200, 0],
  [0, 255, 0], [0, 255, 200], [0, 80, 255], [140, 0, 255], [255, 0, 120],
]

const FLAG: [RGB, RGB] = [[255, 200, 0], [0, 80, 255]]
const same = (a: RGB, b: RGB) => a.join() === b.join()

// IDs from the controller's /json/eff list (WLED 0.15)
const EFFECTS: [number, string][] = [
  [STATIC, 'Статичний'], [SEA, 'Море'], [2, 'Дихання'], [88, 'Свічка'], [66, 'Вогонь'],
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
function useThrottle<T>(fn: (v: T) => void, ms = 100) {
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
  const [light, setLight] = useState<Light>({
    on: false, bri: 128, cols: [[255, 160, 60], [0, 80, 255], [255, 0, 120]], fx: 0, sx: 128, pal: 0, bounds: [], len: 166,
  })
  const [slot, setSlot] = useState(0)
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
    // While dragging, a 100 ms crossfade matches the send interval: the default 0.7 s
    // fade restarts on every update and flickers, no fade at all looks steppy
    throttled ? sendThrottled({ ...patch, tt: 1 }) : send(patch)
  }

  const count = countFromPal(light.pal)
  const active = Math.min(slot, count - 1)
  const split = light.fx === STATIC && count > 1
  const bounds = light.bounds[count] ?? equalBounds(count, light.len)

  const relayout = (next: Partial<Light>, throttled = false) => {
    const l = { ...light, ...next }
    const seg = layout(l, countFromPal(l.pal))
    update({ ...next, on: true }, { on: true, seg }, throttled)
  }

  const setColor = (col: RGB, throttled = false) => {
    const cols = light.cols.map((c, i) => (i === active ? col : c)) as Light['cols']
    // Split parts may be cut in two at the strip's end, so the whole layout is resent
    if (split) relayout({ cols }, throttled)
    else update({ cols, on: true }, { on: true, seg: [{ id: 0, col: cols }] }, throttled)
  }

  const setCount = (n: number) => {
    // Extra slots start black on the controller; give them a visible colour
    const cols = light.cols.map((c, i) =>
      i > 0 && i < n && Math.max(...c) === 0 ? hsvToRgb((rgbToHue(light.cols[0]) + 120 * i) % 360) : c,
    ) as Light['cols']
    setSlot((s) => Math.min(s, n - 1))
    relayout({ cols, pal: PAL_FOR_COUNT[n] })
  }

  const setFx = (fx: number) => relayout({ fx })

  const setFlag = () =>
    relayout({ fx: STATIC, pal: PAL_FOR_COUNT[2], cols: [FLAG[0], FLAG[1], light.cols[2]] })
  const isFlag = split && count === 2 && same(light.cols[0], FLAG[0]) && same(light.cols[1], FLAG[1])

  // The anthem handler is registered once, so it reads the latest setFlag through a ref
  const flagRef = useRef(setFlag)
  flagRef.current = setFlag
  useEffect(() => desktop?.onFlag(() => flagRef.current()), [])

  // Each boundary stays between its neighbours so the colours keep their order
  const setBound = (i: number, v: number) => {
    const b = [...bounds]
    b[i] = Math.max(i ? b[i - 1] + 1 : 0, Math.min(v, i + 1 < count ? b[i + 1] - 1 : light.len - 1))
    const all = [...light.bounds]
    all[count] = b
    relayout({ bounds: all }, true)
  }

  const saveHost = (value: string) => {
    const h = value.trim()
    setEditing(false)
    if (!h || h === host) return
    setHost(h).then(() => setHostState(h))
  }

  const current = light.cols[active]
  const colorful = Math.max(...current) - Math.min(...current) > 40
  const style = { '--c': light.cols[0].join(',') } as React.CSSProperties

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
        <div className="row">
          <span>{count === 1 ? 'Колір' : 'Кольори'}</span>
          <div className="seg-ctl" role="group" aria-label="Кількість кольорів">
            {[1, 2, 3].map((n) => (
              <button key={n} className={n === count ? 'on' : ''} onClick={() => setCount(n)}>{n}</button>
            ))}
          </div>
        </div>
        {count > 1 && (
          <div className="slots">
            {light.cols.slice(0, count).map((c, i) => (
              <button
                key={i} aria-label={`Колір ${i + 1}`}
                className={i === active ? 'on' : ''}
                style={{ background: `rgb(${c})` }}
                onClick={() => setSlot(i)}
              >{i + 1}</button>
            ))}
          </div>
        )}
        {split && (
          <>
            {bounds.map((b, i) => (
              <div key={i} className="bound">
                <div className="row"><span>Межа {i + 1}</span><span>{b + 1}</span></div>
                <input
                  type="range" min={0} max={light.len - 1} value={b}
                  onChange={(e) => setBound(i, +e.target.value)}
                />
              </div>
            ))}
          </>
        )}
        <input
          className="hue" type="range" min={0} max={359}
          value={colorful ? rgbToHue(current) : 0}
          onChange={(e) => setColor(hsvToRgb(+e.target.value), true)}
        />
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c.join()} aria-label="Колір" style={{ background: `rgb(${c})` }}
              className={c.join() === current.join() ? 'on' : ''}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="row"><span>Режим</span></div>
        <div className="effects">
          {EFFECTS.map(([id, name]) => (
            <button key={id} className={id === light.fx && !isFlag ? 'on' : ''} onClick={() => setFx(id)}>
              {name}
            </button>
          ))}
          <button className={isFlag ? 'flag on' : 'flag'} onClick={setFlag}>Прапор</button>
        </div>
        {light.fx !== STATIC && (
          <>
            <div className="row"><span>Швидкість</span></div>
            <input
              type="range" min={0} max={255} value={light.sx}
              onChange={(e) => relayout({ sx: +e.target.value }, true)}
            />
          </>
        )}
      </section>
    </main>
  )
}
