import { useEffect, useRef, useState } from 'react'
import { ledCount, loadSetup, rebalance, saveSetup, setLedCount, type RGB, type Setup, type Snapshot, type Wled } from './wled'
import { buildRoom, defaultMarks, problem, type Layout } from '../electron/room.mjs'
import { desktop, type DesktopSettings, type ModeTuning } from './platform'
import { RoomMap } from './RoomMap'

type Page = 'main' | 'room' | 'balance' | 'games'

interface Props {
  wled?: Wled
  host?: string
  saveHost(host: string): void
  close(): void
}

const PROFILES: [string | null, string][] = [
  [null, 'Звичайний'], ['deathStranding', 'Death Stranding'], ['deathStranding2', 'Death Stranding 2'],['dontStarve', "Don't Starve"], ['sevenDays', '7 Days to Die'],
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

// Keeps the panel on screen while the strip shows calibration, and leaves the screen (which puts
// the light back) when the ordinary window is closed in the middle of it
function useCalibrating(back: () => void) {
  const latest = useRef(back)
  latest.current = back
  useEffect(() => {
    desktop?.pin(true)
    const off = desktop?.onLeave(() => latest.current())
    return () => {
      off?.()
      desktop?.pin(false)
    }
  }, [])
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
  const [sure, setSure] = useState(false)

  useEffect(() => { desktop?.getSettings().then(setDesk) }, [])
  useEffect(() => { document.body.scrollTop = 0 }, [page])
  useEffect(() => {
    if (host) ledCount(host).then((n) => { setCount(n); setCountDraft(String(n)) }, () => {})
  }, [host])

  const patch = (p: Partial<DesktopSettings>) => desktop?.setSettings(p).then(setDesk)
  const tune = (mode: keyof DesktopSettings['modes'], t: Partial<ModeTuning>) =>
    desk && patch({ modes: { ...desk.modes, [mode]: { ...desk.modes[mode], ...t } } })

  const applyCount = async () => {
    const n = Math.round(+countDraft)
    if (!host || !n || n < 1 || n > 1500 || n === count) return
    // One mistyped digit would shift the whole room, so a change has to be confirmed
    if (!sure) return setSure(true)
    setSure(false)
    setRestarting(true)
    const setup = await loadSetup(host).catch(() => null)
    if (!setup) return setRestarting(false)
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
          {restarting ? 'Контролер перезапускається…'
            : sure ? `Змінити з ${count} на ${countDraft}? Контролер перезапуститься, а розмітку доведеться перевірити`
              : `Кількість діодів${count ? ` (зараз ${count})` : ''}`}
        </small>
        <form className="name-row" onSubmit={(e) => { e.preventDefault(); applyCount() }}>
          <input inputMode="numeric" value={countDraft} onChange={(e) => { setSure(false); setCountDraft(e.target.value.replace(/\D/g, '')) }} aria-label="Кількість діодів" />
          <button type="submit" disabled={restarting}>{restarting ? '…' : sure ? 'Так, змінити' : 'OK'}</button>
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

// ---- Room calibration: the strip shows where it runs, and each mark is moved by hand ----

const PLACES: [Layout, string, string][] = [
  ['room', 'Кімната', 'Під стелею по колу кімнати'],
  ['screen', 'За екраном', 'По краях за монітором чи телевізором'],
  ['line', 'Одна лінія', 'Вздовж стіни, столу чи полиці'],
]

interface Mark { key: string; name: string; hint: string }
const MARKS: Record<Layout, Mark[]> = {
  room: [
    { key: 'fl', name: 'Лівий кут біля монітора', hint: 'Діод у куті ліворуч від монітора, якщо дивитись на нього' },
    { key: 'fr', name: 'Правий кут біля монітора', hint: 'Діод у куті праворуч від монітора' },
    { key: 'bl', name: 'Дальній лівий кут', hint: 'Діод у куті за спиною ліворуч' },
    { key: 'br', name: 'Дальній правий кут', hint: 'Діод у куті за спиною праворуч' },
    { key: 'monitor', name: 'Над монітором', hint: 'Діод рівно над серединою екрана' },
  ],
  screen: [
    { key: 'tl', name: 'Верхній лівий кут', hint: 'Діод у верхньому лівому куті екрана' },
    { key: 'tr', name: 'Верхній правий кут', hint: 'Діод у верхньому правому куті екрана' },
    { key: 'br', name: 'Нижній правий кут', hint: 'Якщо знизу стрічки немає, останній діод праворуч' },
    { key: 'bl', name: 'Нижній лівий кут', hint: 'Якщо знизу стрічки немає, перший діод ліворуч' },
  ],
  line: [
    { key: 'l', name: 'Лівий кінець', hint: 'Крайній лівий діод, якщо дивитись на монітор' },
    { key: 'r', name: 'Правий кінець', hint: 'Крайній правий діод' },
    { key: 'monitor', name: 'Середина монітора', hint: 'Діод, найближчий до середини екрана' },
  ],
}
const BED: Mark[] = [
  { key: 'bed0', name: 'Ліжко: початок', hint: 'Перший діод над ліжком' },
  { key: 'bed1', name: 'Ліжко: кінець', hint: 'Останній діод над ліжком' },
]

const marksOf = (s: Setup) => [...MARKS[s.layout], ...(s.layout === 'room' && s.bed ? BED : [])]
const getMark = (s: Setup, key: string) => (key === 'bed0' ? s.bed![0] : key === 'bed1' ? s.bed![1] : s.marks[key])

// The strip is a loop for the marks: stepping past one end comes in at the other
function setMark(s: Setup, key: string, v: number, len: number): Setup {
  const to = ((v % len) + len) % len
  if (key === 'bed0') return { ...s, bed: [to, s.bed![1]] }
  if (key === 'bed1') return { ...s, bed: [s.bed![0], to] }
  return { ...s, marks: { ...s.marks, [key]: to } }
}

// Each part of the room dim in its own colour, so it shows where one wall ends and the next begins
const ROLE_COLOR: Record<string, string> = { front: '001848', back: '280038', bed: '806000', edge: '001848', off: '000000' }

function paintRoom(s: Setup, sel: string, len: number) {
  const room = buildRoom(s, len)
  const colour = (v: number) => {
    const r = room.roles[v]
    return r.role === 'side' ? (r.x0 === 0 ? '003010' : '301800') : ROLE_COLOR[r.role]
  }
  // Runs of one colour go as ranges, which keeps the message small
  const i: (number | string)[] = []
  for (let a = 0; a < len; ) {
    let b = a + 1
    while (b < len && colour(b) === colour(a)) b++
    i.push(a, b, colour(a))
    a = b
  }
  for (const m of marksOf(s)) {
    i.push(getMark(s, m.key), m.key === 'monitor' ? '00A0FF' : m.key.startsWith('bed') ? 'FFB000' : '909090')
  }
  // The selected mark last, so it shows even where two marks share an LED
  i.push(getMark(s, sel), 'FFFFFF')
  return i
}

export function RoomCalibration({ wled, host, len, back, title = 'Розмітка кімнати', finish = 'Зберегти', done }: {
  wled: Wled; host: string; len: number; back(): void; title?: string; finish?: string; done?(): void
}) {
  const [setup, setSetup] = useState<Setup>()
  const [sel, setSel] = useState('')
  const [placed, setPlaced] = useState<Set<string>>(new Set())
  const saved = useRef<Snapshot>(undefined)

  useEffect(() => {
    let gone = false
    Promise.all([wled.snapshot(), loadSetup(host)]).then(([snap, s]) => {
      if (gone) return
      saved.current = snap
      setSetup(s)
      setSel(MARKS[s.layout][0].key)
      // A setup saved before has all its dots in place already
      if (s.done) setPlaced(new Set(marksOf(s).map((m) => m.key)))
    }, () => {})
    return () => { gone = true; if (saved.current) wled.restore(saved.current) }
  }, [wled, host])

  useCalibrating(back)

  // `lor: 1` keeps the PC's live modes from painting over the marks meanwhile
  useEffect(() => {
    if (!setup || !sel) return
    const t = setTimeout(() => wled.sendRaw({
      on: true, bri: 160, lor: 1,
      seg: [{ id: 0, start: 0, stop: len, fx: 0, frz: false, i: paintRoom(setup, sel, len) }, { id: 1, stop: 0 }, { id: 2, stop: 0 }, { id: 3, stop: 0 }],
    }), 40)
    return () => clearTimeout(t)
  }, [setup, sel, len, wled])

  if (!setup || !sel) return <Back title={title} onBack={back} />
  const v = getMark(setup, sel)
  const move = (to: number) => {
    setSetup(setMark(setup, sel, to, len))
    setPlaced((p) => new Set(p).add(sel))
  }
  const issue = problem(setup, len)
  const list = marksOf(setup)
  const at = list.findIndex((m) => m.key === sel)
  const mark = list[at]
  const led = (key: string) => ((getMark(setup, key) + setup.shift) % len) + 1
  const allPlaced = list.every((m) => placed.has(m.key))
  // Accepting a dot where it stands counts too: the default can be right
  const nextDot = () => {
    setPlaced((p) => new Set(p).add(sel))
    setSel(list[(at + 1) % list.length].key)
  }
  const place = (layout: Layout) => {
    setSetup({ ...setup, layout, marks: defaultMarks(layout, len), bed: null })
    setSel(MARKS[layout][0].key)
    setPlaced(new Set())
  }
  const toggleBed = (on: boolean) => {
    if (!on) {
      setSetup({ ...setup, bed: null })
      if (sel.startsWith('bed')) setSel(MARKS.room[0].key)
      setPlaced((p) => new Set([...p].filter((k) => !k.startsWith('bed'))))
      return
    }
    // The bed starts on the far wall next to its left corner, for the user to move into place
    const far = buildRoom(setup, len).roles.flatMap((r, i) => (r.role === 'back' ? [i] : []))
    if (far.length < 2) return
    setSetup({ ...setup, bed: [far[0], far[Math.min(far.length - 1, Math.round(len / 8))]] })
    setSel('bed0')
  }
  const save = () => {
    saveSetup(host, { ...setup, done: true }).then(() => desktop?.setupChanged(), () => {})
    if (done) done()
    else back()
  }

  return (
    <>
      <Back title={title} onBack={back} />
      <section className="card">
        <div className="row"><span>Де стрічка</span></div>
        <div className="presets">
          {PLACES.map(([id, name]) => (
            <button key={id} className={id === setup.layout ? 'preset on' : 'preset'} onClick={() => place(id)}>{name}</button>
          ))}
        </div>
        <small className="hint">{PLACES.find(([id]) => id === setup.layout)![2]}</small>
        {setup.layout === 'room' && <Switch label="Ліжко під стрічкою (там світло тьмяніше)" on={!!setup.bed} set={toggleBed} />}
      </section>
      <section className="card">
        <RoomMap
          layout={setup.layout} hasBed={!!setup.bed} marks={list} selected={sel} placed={placed} led={led} select={setSel}
        />
        <small className="hint map-hint">Кольори на схемі такі самі, як на стрічці. Натисни на крапку, щоб вибрати її</small>
      </section>
      <section className="card">
        <div className="row"><strong>{at + 1}. {mark.name}</strong><span>діод № {led(sel)}</span></div>
        <small className="hint">{mark.hint}. Посувай, доки біла точка на стрічці не стане туди</small>
        <div className="stepper">
          <button type="button" onClick={() => move(v - 1)} aria-label="На діод назад">−</button>
          <input type="range" min={0} max={len - 1} value={v} onChange={(e) => move(+e.target.value)} aria-label="Положення мітки" />
          <button type="button" onClick={() => move(v + 1)} aria-label="На діод вперед">+</button>
        </div>
        {issue && allPlaced && <small className="hint warn">{issue}</small>}
        <div className="name-row">
          {allPlaced
            ? <button type="button" className="wide" onClick={save} disabled={!!issue}>{finish}</button>
            : <button type="button" className="wide" onClick={nextDot}>Тут правильно, далі</button>}
        </div>
      </section>
    </>
  )
}

// ---- White balance: the strip shows white, and each channel is turned down until it looks white ----

function Balance({ wled, host, len, back }: { wled: Wled; host: string; len: number; back(): void }) {
  const [setup, setSetup] = useState<Setup>()
  const saved = useRef<Snapshot>(undefined)
  const done = useRef(false)

  useCalibrating(back)

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
