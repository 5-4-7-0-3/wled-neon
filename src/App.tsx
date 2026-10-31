import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  PAL_FOR_COUNT, STATIC, Wled, countFromPal, equalBounds, layout, pieces, toLight, type Light, type RGB,
} from './wled'
import { desktop, getHost, setHost } from './platform'

const COLORS: RGB[] = [
  [255, 160, 60], [255, 255, 255], [255, 0, 0], [255, 90, 0], [255, 200, 0],
  [0, 255, 0], [0, 255, 200], [0, 80, 255], [140, 0, 255], [255, 0, 120],
]

const FLAG: [RGB, RGB] = [[255, 200, 0], [0, 80, 255]]
const FLAG_ID = -1
const same = (a: RGB, b: RGB) => a.join() === b.join()
const css = (c: RGB) => `rgb(${c})`

// IDs from the controller's /json/eff list (WLED 0.15). `colors` marks styles that use the
// user's colours; the others bring their own palette.
interface Style { id: number; name: string; preview: string; colors?: boolean; moving?: boolean }
const STYLES: Style[] = [
  { id: STATIC, name: 'Статичний', preview: '', colors: true },
  { id: FLAG_ID, name: 'Прапор', preview: 'linear-gradient(90deg, #0057b7 50%, #ffd700 50%)' },
  { id: 17, name: 'Мерехтіння', preview: '', colors: true, moving: true },
  { id: 67, name: 'Хвилі', preview: '', colors: true, moving: true },
]

const DEFAULT_COLS: Light['cols'] = [[255, 160, 60], [0, 80, 255], [255, 0, 120]]

// The flag overwrites the colours on the controller, so the user's own ones are kept here to
// bring them back when another style is picked
const MEMO = 'neon.colors'
function remember(l: Light) {
  try {
    localStorage.setItem(MEMO, JSON.stringify({ cols: l.cols, pal: l.pal }))
  } catch {
    // Without storage the default colours come back instead
  }
}
function recall(): Pick<Light, 'cols' | 'pal'> {
  try {
    const m = JSON.parse(localStorage.getItem(MEMO) ?? '')
    if (Array.isArray(m?.cols) && typeof m.pal === 'number') return m
  } catch {
    // Fall through to defaults
  }
  return { cols: DEFAULT_COLS, pal: 0 }
}

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
function useThrottle<T>(fn: (v: T) => void, ms: number) {
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

function preview(s: Style, cols: RGB[]) {
  if (s.preview) return s.preview
  if (s.id === 17) return `radial-gradient(${css(cols[0])} 18%, transparent 22%) 0 0 / 14px 14px, #15151c`
  if (cols.length === 1) return css(cols[0])
  if (s.id === STATIC) {
    const stops = cols.map((c, i) => `${css(c)} ${(i * 100) / cols.length}% ${((i + 1) * 100) / cols.length}%`)
    return `linear-gradient(90deg, ${stops.join(', ')})`
  }
  return `linear-gradient(90deg, ${[...cols, cols[0]].map(css).join(', ')})`
}

export function App() {
  const [light, setLight] = useState<Light>({
    on: false, bri: 128, cols: DEFAULT_COLS, fx: 0, sx: 128, pal: 0, bounds: [], len: 166,
  })
  const [slot, setSlot] = useState(0)
  const [online, setOnline] = useState(false)
  const [host, setHostState] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState(false)
  const wled = useRef<Wled>(undefined)
  // Pushes from the controller lag behind a dragged slider; ignore them briefly
  const quietUntil = useRef(0)
  const root = useRef<HTMLElement>(null)
  const bar = useRef<HTMLDivElement>(null)

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (picking) setPicking(false)
      else d?.hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking])

  const send = (patch: object) => {
    quietUntil.current = Date.now() + 600
    wled.current?.send(patch)
  }
  // 20 updates a second is what the controller keeps up with (measured); small steps at
  // that rate look continuous at 60 fps
  const sendThrottled = useThrottle(send, 50)

  const update = (next: Partial<Light>, patch: object, throttled = false) => {
    setLight((p) => ({ ...p, ...next }))
    // While dragging, every crossfade would be cut short by the next update and restart from
    // a jumped colour, which flickers; dragged values are applied instantly instead
    throttled ? sendThrottled({ ...patch, tt: 0 }) : send(patch)
  }

  const count = countFromPal(light.pal)
  const active = Math.min(slot, count - 1)
  const split = light.fx === STATIC && count > 1
  const bounds = light.bounds[count] ?? equalBounds(count, light.len)
  const isFlag = split && count === 2 && same(light.cols[0], FLAG[0]) && same(light.cols[1], FLAG[1])
  const styleId = isFlag ? FLAG_ID : light.fx
  const style = STYLES.find((s) => s.id === styleId)
  const cols = light.cols.slice(0, count)

  const relayout = (next: Partial<Light>, throttled = false) => {
    const l = { ...light, ...next }
    const seg = layout(l, countFromPal(l.pal))
    update({ ...next, on: true }, { on: true, seg }, throttled)
  }

  // Segment ids in use, in strip order, with the colour part each one shows
  const liveSegs = () => (split ? pieces(bounds, light.len).map(([, , i]) => i) : layout(light, count).filter((g) => 'start' in g).map(() => -1))

  const setColor = (col: RGB, throttled = false) => {
    const next = light.cols.map((c, i) => (i === active ? col : c)) as Light['cols']
    // Only the segments of the changed part are touched, so a drag sends small messages
    const seg = split
      ? liveSegs().flatMap((part, id) => (part === active ? [{ id, col: [col] }] : []))
      : [{ id: 0, col: next }]
    update({ cols: next, on: true }, { on: true, seg }, throttled)
  }

  const setSpeed = (sx: number) =>
    update({ sx, on: true }, { on: true, seg: liveSegs().map((_, id) => ({ id, sx })) }, true)

  const addColor = () => {
    const n = count + 1
    // Extra slots start black on the controller; give the new one a visible colour
    const next = light.cols.map((c, i) =>
      i === count ? hsvToRgb((rgbToHue(light.cols[0]) + 120 * i) % 360) : c) as Light['cols']
    setSlot(count)
    relayout({ cols: next, pal: PAL_FOR_COUNT[n] })
  }

  const removeColor = () => {
    // The selected colour goes; it is moved past the used ones so the rest keep their order
    const rest = light.cols.filter((_, i) => i !== active)
    const next = [...rest.slice(0, count - 1), light.cols[active], ...rest.slice(count - 1)] as Light['cols']
    setSlot(Math.max(0, active - 1))
    relayout({ cols: next, pal: PAL_FOR_COUNT[count - 1] })
  }

  const setFlag = () => {
    if (!isFlag) remember(light)
    relayout({ fx: STATIC, pal: PAL_FOR_COUNT[2], cols: [FLAG[0], FLAG[1], light.cols[2]] })
  }

  const setStyle = (id: number) => {
    setPicking(false)
    if (id === FLAG_ID) return setFlag()
    relayout({ fx: id, ...(isFlag ? recall() : {}) })
  }

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

  const dragBound = (i: number) => (e: React.PointerEvent) => {
    if (!(e.buttons & 1) || !bar.current) return
    const r = bar.current.getBoundingClientRect()
    setBound(i, Math.round(((e.clientX - r.left) / r.width) * light.len))
  }

  const saveHost = (value: string) => {
    const h = value.trim()
    setEditing(false)
    if (!h || h === host) return
    setHost(h).then(() => setHostState(h))
  }

  const current = light.cols[active]
  const colorful = Math.max(...current) - Math.min(...current) > 40
  const vars = { '--c': light.cols[0].join(',') } as React.CSSProperties
  const showColors = !isFlag && (style?.colors ?? true)
  const pct = (v: number) => `${(v / light.len) * 100}%`

  if (picking) {
    return (
      <main ref={root} className="panel" style={vars}>
        <header>
          <button className="back" onClick={() => setPicking(false)} aria-label="Назад">‹</button>
          <h1>Стилі</h1>
          <span className="spacer" />
        </header>
        <div className="styles">
          {STYLES.map((s) => (
            <button key={s.id} className={s.id === styleId ? 'tile on' : 'tile'} onClick={() => setStyle(s.id)}>
              <span
                className={s.moving ? 'swatch moving' : 'swatch'}
                style={{ background: preview(s, s.id === STATIC && isFlag ? recall().cols.slice(0, countFromPal(recall().pal)) : cols) }}
              />
              <span>{s.name}</span>
            </button>
          ))}
        </div>
      </main>
    )
  }

  return (
    <main ref={root} className={light.on ? 'panel' : 'panel off'} style={vars}>
      <header>
        <h1>Неон</h1>
        <button className="icon" onClick={() => setEditing((v) => !v)} aria-label="Адреса контролера">
          <span className={online ? 'dot ok' : 'dot'} />
        </button>
        <span className="spacer" />
        <button
          role="switch" aria-checked={light.on} aria-label="Живлення"
          className={light.on ? 'switch on' : 'switch'}
          onClick={() => update({ on: !light.on }, { on: !light.on })}
        ><span /></button>
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

      <section className="card">
        <div className="row"><span>Яскравість</span><span>{Math.round(light.bri / 2.55)}%</span></div>
        <input
          className="bri" type="range" min={1} max={255} value={light.bri}
          onChange={(e) => update({ bri: +e.target.value, on: true }, { on: true, bri: +e.target.value }, true)}
        />
      </section>

      <section className="card">
        <button className="current" onClick={() => setPicking(true)}>
          <span className={style?.moving ? 'swatch moving' : 'swatch'} style={{ background: style ? preview(style, cols) : '#222' }} />
          <span className="label"><small>Стиль</small>{style?.name ?? 'Інший'}</span>
          <span className="chev">›</span>
        </button>
        {style?.moving && (
          <>
            <div className="row"><span>Швидкість</span></div>
            <input
              type="range" min={0} max={255} value={light.sx}
              onChange={(e) => setSpeed(+e.target.value)}
            />
          </>
        )}
      </section>

      {showColors && (
        <section className="card">
          <div className="row"><span>{count === 1 ? 'Колір' : 'Кольори'}</span></div>
          <div className="chips">
            {cols.map((c, i) => (
              <button
                key={i} aria-label={`Колір ${i + 1}`}
                className={i === active ? 'chip on' : 'chip'} style={{ background: css(c) }}
                onClick={() => setSlot(i)}
              />
            ))}
            {count < 3 && <button className="chip add" onClick={addColor} aria-label="Додати колір">+</button>}
            {count > 1 && <button className="chip add" onClick={removeColor} aria-label="Прибрати вибраний колір">−</button>}
          </div>

          {split && (
            <div className="room">
              <div className="bar" ref={bar}>
                {pieces(bounds, light.len).map(([a, z, i]) => (
                  <button
                    key={`${a}-${i}`} className={i === active ? 'part on' : 'part'} aria-label={`Колір ${i + 1}`}
                    style={{ left: pct(a), width: pct(z - a), background: css(light.cols[i]) }}
                    onClick={() => setSlot(i)}
                  />
                ))}
                {bounds.map((b, i) => (
                  <span
                    key={i} className="handle" style={{ left: pct(b) }}
                    onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                    onPointerMove={dragBound(i)}
                  />
                ))}
              </div>
              <small>Перетягуй межі, щоб поділити кімнату</small>
            </div>
          )}

          <input
            className="hue" type="range" min={0} max={359}
            value={colorful ? rgbToHue(current) : 0}
            onChange={(e) => setColor(hsvToRgb(+e.target.value), true)}
          />
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                key={c.join()} aria-label="Колір" style={{ background: css(c) }}
                className={same(c, current) ? 'on' : ''}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
