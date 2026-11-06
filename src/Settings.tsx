import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SETUP, ledCount, loadSetup, rebalance, saveSetup, setLedCount, type RGB, type Setup, type Snapshot, type Wled,
} from './wled'
import { desktop, type DesktopSettings, type ModeTuning } from './platform'

type Page = 'main' | 'room' | 'balance' | 'games'

interface Props {
  wled?: Wled
  host?: string
  saveHost(host: string): void
  close(): void
}

const PROFILES: [string | null, string][] = [
  [null, 'Звичайний'], ['deathStranding', 'Death Stranding'], ['dontStarve', "Don't Starve"], ['sevenDays', '7 Days to Die'],
]

function Back({ title, onBack, children }: { title: string; onBack(): void; children?: React.ReactNode }) {
  return (
    <header>
      <button className="back" onClick={onBack} aria-label="Назад">‹</button>
      <h1>{title}</h1>
      <span className="spacer" />
      {children}
    </header>
  )
}

function Switch({ on, label, set }: { on: boolean; label: string; set(v: boolean): void }) {
  return (
    <div className="row">
      <span>{label}</span>
      <button role="switch" aria-checked={on} aria-label={label} className={on ? 'switch on' : 'switch'} onClick={() => set(!on)}>
        <span />
      </button>
    </div>
  )
}

function Slider({ label, value, min, max, set, track }: {
  label: string; value: number; min: number; max: number; set(v: number): void; track?: string
}) {
  return (
    <>
      <div className="row"><span>{label}</span><span>{Math.round(value * 100)}%</span></div>
      <input
        type="range" min={min * 100} max={max * 100} value={value * 100} onChange={(e) => set(+e.target.value / 100)}
        style={track ? { background: track } : undefined}
      />
    </>
  )
}

export function Settings({ wled, host, saveHost, close }: Props) {
  const [page, setPage] = useState<Page>('main')
  const [desk, setDesk] = useState<DesktopSettings>()
  const [count, setCount] = useState<number>()
  const [countDraft, setCountDraft] = useState('')
  const [restarting, setRestarting] = useState(false)

  useEffect(() => { desktop?.getSettings().then(setDesk) }, [])
  useEffect(() => {
    if (host) ledCount(host).then((n) => { setCount(n); setCountDraft(String(n)) }, () => {})
  }, [host])

  const patch = (p: Partial<DesktopSettings>) => desktop?.setSettings(p).then(setDesk)
  const tune = (mode: keyof DesktopSettings['modes'], t: Partial<ModeTuning>) =>
    desk && patch({ modes: { ...desk.modes, [mode]: { ...desk.modes[mode], ...t } } })

  const applyCount = async () => {
    const n = Math.round(+countDraft)
    if (!host || !n || n < 1 || n > 1500 || n === count) return
    setRestarting(true)
    const setup = await loadSetup(host)
    await setLedCount(host, n, setup.shift % n).catch(() => {})
    setCount(n)
    // The controller restarts; the connection comes back on its own
    setTimeout(() => setRestarting(false), 6000)
  }

  if (page === 'room' && wled && host && count) return <RoomCalibration wled={wled} host={host} len={count} back={() => setPage('main')} />
  if (page === 'balance' && wled && host && count) {
    return <Balance wled={wled} host={host} len={count} back={() => setPage('main')} />
  }
  if (page === 'games' && desk) {
    const games = Object.entries(desk.gameList)
    const setGame = (exe: string, g: Partial<DesktopSettings['gameList'][string]>) =>
      patch({ gameList: { ...desk.gameList, [exe]: { ...desk.gameList[exe], ...g } } })
    return (
      <>
        <Back title="Ігри" onBack={() => setPage('main')} />
        {!games.length && <section className="card"><small className="hint">Ігри з’являться тут, коли програма побачить їх уперше</small></section>}
        {games.map(([exe, g]) => (
          <section className="card" key={exe}>
            <Switch label={g.name} on={g.enabled} set={(enabled) => setGame(exe, { enabled })} />
            <div className="row">
              <span>Профіль</span>
              <select value={g.profile ?? ''} onChange={(e) => setGame(exe, { profile: e.target.value || null })}>
                {PROFILES.map(([id, name]) => <option key={name} value={id ?? ''}>{name}</option>)}
              </select>
            </div>
          </section>
        ))}
      </>
    )
  }

  return (
    <>
      <Back title="Налаштування" onBack={close} />

      <section className="card">
        <div className="row"><span>Стрічка</span></div>
        <small className="hint">Адреса контролера в мережі</small>
        <form className="name-row" onSubmit={(e) => { e.preventDefault(); saveHost(new FormData(e.currentTarget).get('host') as string) }}>
          <input name="host" defaultValue={host} spellCheck={false} aria-label="Адреса контролера" />
          <button type="submit">OK</button>
        </form>
        <small className="hint">
          {restarting ? 'Контролер перезапускається…' : `Кількість діодів${count ? ` (зараз ${count})` : ''}`}
        </small>
        <form className="name-row" onSubmit={(e) => { e.preventDefault(); applyCount() }}>
          <input inputMode="numeric" value={countDraft} onChange={(e) => setCountDraft(e.target.value.replace(/\D/g, ''))} aria-label="Кількість діодів" />
          <button type="submit" disabled={restarting}>{restarting ? '…' : 'OK'}</button>
        </form>
        <button className="current" onClick={() => setPage('room')} disabled={!count}>
          <span className="label"><small>Калібрування</small>Розмітка кімнати</span>
          <span className="chev">›</span>
        </button>
        <button className="current" onClick={() => setPage('balance')} disabled={!count}>
          <span className="label"><small>Калібрування</small>Баланс білого</span>
          <span className="chev">›</span>
        </button>
      </section>

      {desk && (
        <>
          <section className="card">
            <div className="row"><span>Кіно</span></div>
            <Slider label="Яскравість" value={desk.modes.cinema.bright} min={0.2} max={1.5} set={(bright) => tune('cinema', { bright })} />
            <Slider label="Плавність" value={desk.modes.cinema.smooth ?? 1} min={0.5} max={3} set={(smooth) => tune('cinema', { smooth })} />
          </section>
          <section className="card">
            <div className="row"><span>Гра</span></div>
            <Slider label="Яскравість" value={desk.modes.game.bright} min={0.2} max={1.5} set={(bright) => tune('game', { bright })} />
            <Slider label="Плавність" value={desk.modes.game.smooth ?? 1} min={0.5} max={3} set={(smooth) => tune('game', { smooth })} />
            <Slider label="Сила ефектів" value={desk.modes.game.effects ?? 1} min={0} max={2} set={(effects) => tune('game', { effects })} />
          </section>
          <section className="card">
            <div className="row"><span>Музика</span></div>
            <Slider label="Яскравість" value={desk.modes.music.bright} min={0.2} max={1.5} set={(bright) => tune('music', { bright })} />
            <Slider label="Сила ефектів" value={desk.modes.music.effects ?? 1} min={0} max={2} set={(effects) => tune('music', { effects })} />
          </section>
          <section className="card">
            <Switch label="Підсвітка для ігор" on={desk.games} set={(games) => patch({ games })} />
            <button className="current" onClick={() => setPage('games')}>
              <span className="label"><small>Профілі й винятки</small>Список ігор</span>
              <span className="chev">›</span>
            </button>
          </section>
          <section className="card">
            <Switch label="Прапор під гімн України" on={desk.anthem} set={(anthem) => patch({ anthem })} />
            <Switch label="Запускати з Windows" on={desk.autostart} set={(autostart) => patch({ autostart })} />
          </section>
        </>
      )}
    </>
  )
}

// ---- Room calibration: the strip shows the walls and marks, and each mark is moved by hand ----

const MARKS: { key: string; name: string; hint: string }[] = [
  { key: 'c0', name: 'Кут: права стіна → стіна з монітором', hint: 'Перший діод стіни з монітором' },
  { key: 'c1', name: 'Кут: стіна з монітором → ліва стіна', hint: 'Перший діод лівої стіни' },
  { key: 'c2', name: 'Кут: ліва стіна → задня стіна', hint: 'Перший діод задньої стіни' },
  { key: 'c3', name: 'Кут: задня стіна → права стіна', hint: 'Перший діод правої стіни' },
  { key: 'monitor', name: 'Центр монітора', hint: 'Діод рівно над серединою екрана' },
  { key: 'bed0', name: 'Ліжко: початок', hint: 'Перший діод над ліжком' },
  { key: 'bed1', name: 'Ліжко: кінець', hint: 'Останній діод над ліжком' },
]

const getMark = (s: Setup, key: string) =>
  key === 'monitor' ? s.monitor : key === 'bed0' ? s.bed[0] : key === 'bed1' ? s.bed[1] : s.corners[+key[1]]

// Marks keep their order round the room: corners in turn, the monitor on its wall, the bed on the back wall
function setMark(s: Setup, key: string, v: number, len: number): Setup {
  const c = [...s.corners] as Setup['corners']
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
  if (key[0] === 'c') {
    const i = +key[1]
    c[i] = clamp(v, i ? c[i - 1] + 1 : 0, i < 3 ? c[i + 1] - 1 : len - 1)
    return { ...s, corners: c }
  }
  if (key === 'monitor') return { ...s, monitor: clamp(v, c[0], c[1] - 1) }
  const bed: Setup['bed'] = key === 'bed0' ? [clamp(v, c[2], s.bed[1]), s.bed[1]] : [s.bed[0], clamp(v, s.bed[0], c[3] - 1)]
  return { ...s, bed }
}

function paintRoom(s: Setup, sel: string, len: number) {
  const [c0, c1, c2, c3] = s.corners
  // Walls dim in their own colours so the corners show where one ends and the next begins
  const i: (number | string)[] = [
    0, c0, '301800', c0, c1, '001848', c1, c2, '003010', c2, c3, '280038', c3, len, '301800',
    s.bed[0], s.bed[1] + 1, '806000',
  ]
  for (const m of MARKS) {
    const v = getMark(s, m.key)
    i.push(v, m.key === sel ? 'FFFFFF' : m.key === 'monitor' ? '00A0FF' : m.key.startsWith('bed') ? 'FFB000' : '909090')
  }
  return i
}

function RoomCalibration({ wled, host, len, back }: { wled: Wled; host: string; len: number; back(): void }) {
  const [setup, setSetup] = useState<Setup>()
  const [sel, setSel] = useState('c0')
  const saved = useRef<Snapshot>(undefined)

  useEffect(() => {
    let gone = false
    Promise.all([wled.snapshot(), loadSetup(host)]).then(([snap, s]) => {
      if (gone) return
      saved.current = snap
      setSetup(s)
    })
    return () => { gone = true; if (saved.current) wled.restore(saved.current) }
  }, [wled, host])

  // `lor: 1` keeps the PC's live modes from painting over the marks meanwhile
  useEffect(() => {
    if (!setup) return
    wled.sendRaw({
      on: true, bri: 160, lor: 1,
      seg: [{ id: 0, start: 0, stop: len, fx: 0, frz: false, i: paintRoom(setup, sel, len) }, { id: 1, stop: 0 }, { id: 2, stop: 0 }, { id: 3, stop: 0 }],
    })
  }, [setup, sel, len, wled])

  if (!setup) return <Back title="Розмітка кімнати" onBack={back} />
  const v = getMark(setup, sel)
  const move = (to: number) => setSetup(setMark(setup, sel, to, len))
  const save = () => {
    saveSetup(host, setup).then(() => desktop?.setupChanged(), () => {})
    back()
  }

  return (
    <>
      <Back title="Розмітка кімнати" onBack={back}>
        <button className="link" onClick={save}>Зберегти</button>
      </Back>
      <section className="card">
        <small className="hint">
          Вибери мітку й посувай її, доки біла точка на стрічці не стане на своє місце. Стіни підсвічені різними кольорами.
        </small>
        <div className="presets">
          {MARKS.map((m) => (
            <button key={m.key} className={m.key === sel ? 'preset on' : 'preset'} onClick={() => setSel(m.key)}>{m.name}</button>
          ))}
        </div>
      </section>
      <section className="card">
        {/* Numbered from the strip's own first LED, the way they are counted on the wall */}
        <div className="row"><span>{MARKS.find((m) => m.key === sel)!.hint}</span><span>№ {((v + setup.shift) % len) + 1}</span></div>
        <div className="stepper">
          <button type="button" onClick={() => move(v - 1)}>−</button>
          <input type="range" min={0} max={len - 1} value={v} onChange={(e) => move(+e.target.value)} />
          <button type="button" onClick={() => move(v + 1)}>+</button>
        </div>
        <button className="link" onClick={() => setSetup({ ...DEFAULT_SETUP, shift: setup.shift, balance: setup.balance })}>Повернути як було спочатку</button>
      </section>
    </>
  )
}

// ---- White balance: the strip shows white, and each channel is turned down until it looks white ----

function Balance({ wled, host, len, back }: { wled: Wled; host: string; len: number; back(): void }) {
  const [setup, setSetup] = useState<Setup>()
  const saved = useRef<Snapshot>(undefined)
  const done = useRef(false)

  useEffect(() => {
    let gone = false
    Promise.all([wled.snapshot(), loadSetup(host)]).then(([snap, s]) => {
      if (gone) return
      saved.current = snap
      setSetup(s)
    })
    return () => { gone = true; if (saved.current && !done.current) wled.restore(saved.current) }
  }, [wled, host])

  useEffect(() => {
    if (!setup) return
    const t = setTimeout(() => wled.sendRaw({
      on: true, bri: 200, lor: 1,
      seg: [{ id: 0, start: 0, stop: len, fx: 0, frz: false, col: [setup.balance.map((k) => 255 * k)] }, { id: 1, stop: 0 }, { id: 2, stop: 0 }, { id: 3, stop: 0 }],
    }), 40)
    return () => clearTimeout(t)
  }, [setup, len, wled])

  if (!setup) return <Back title="Баланс білого" onBack={back} />
  const set = (i: number, k: number) => setSetup({ ...setup, balance: setup.balance.map((v, j) => (j === i ? k : v)) as RGB })
  const save = async () => {
    done.current = true
    await saveSetup(host, setup).catch(() => {})
    // The light from before comes back with its colours under the new balance
    if (saved.current) wled.restore(rebalance(saved.current, wled.balance, setup.balance))
    wled.balance = setup.balance
    desktop?.setupChanged()
    back()
  }

  return (
    <>
      <Back title="Баланс білого" onBack={back}>
        <button className="link" onClick={save}>Зберегти</button>
      </Back>
      <section className="card">
        <small className="hint">Стрічка світить білим. Прибирай канал, якого забагато, доки білий не стане чистим білим.</small>
        {(['Червоний', 'Зелений', 'Синій'] as const).map((name, i) => (
          <Slider
            key={name} label={name} value={setup.balance[i]} min={0.3} max={1} set={(k) => set(i, k)}
            track={`linear-gradient(90deg, #222, ${['#ff3030', '#30ff60', '#3070ff'][i]})`}
          />
        ))}
        <button className="link" onClick={() => setSetup({ ...setup, balance: [1, 1, 1] })}>Скинути</button>
      </section>
    </>
  )
}
