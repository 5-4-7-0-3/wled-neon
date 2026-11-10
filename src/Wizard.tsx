import { useEffect, useRef, useState } from 'react'
import { ledCount, loadSetup, setLedCount, type Wled } from './wled'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { desktop } from './platform'
import { RoomCalibration } from './Settings'

// First run: find the controller, say how long the strip is, then where it runs. Each step only
// shows when it is still needed, so someone who moves to a new phone just finds the controller.

interface Found { ip: string; name: string; leds: number }

// Home networks most routers hand out; the PC knows its own, a phone has to guess
const COMMON = ['192.168.0', '192.168.1', '192.168.31', '192.168.100', '192.168.88', '192.168.2', '10.0.0', '10.0.1']

// On the phone the app's own HTTP client asks: the WebView keeps a connection open to each silent
// address for a while, runs out of them, and then even the controller's answer waits in the queue
async function probe(ip: string): Promise<Found | null> {
  try {
    const url = `http://${ip}/json/info`
    const info = Capacitor.isNativePlatform()
      ? (await CapacitorHttp.get({ url, connectTimeout: 1000, readTimeout: 1500 })).data
      : await fetch(url, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
    return info?.leds?.count ? { ip, name: info.name || 'WLED', leds: info.leds.count } : null
  } catch {
    return null
  }
}

async function scan(onFound: (f: Found) => void, onProgress: (share: number) => void, signal: AbortSignal) {
  if (desktop) {
    for (const f of await desktop.findControllers()) onFound(f)
    onProgress(1)
    return
  }
  const ips = COMMON.flatMap((n) => Array.from({ length: 254 }, (_, i) => `${n}.${i + 1}`))
  let next = 0, done = 0
  const worker = async () => {
    while (next < ips.length && !signal.aborted) {
      const f = await probe(ips[next++])
      if (f && !signal.aborted) onFound(f)
      onProgress(++done / ips.length)
    }
  }
  await Promise.all(Array.from({ length: 48 }, worker))
}

function Find({ pick }: { pick(ip: string): void }) {
  const [found, setFound] = useState<Found[]>([])
  const [progress, setProgress] = useState(0)
  const [manual, setManual] = useState('')

  useEffect(() => {
    const stop = new AbortController()
    scan((f) => setFound((l) => [...l, f]), setProgress, stop.signal)
    return () => stop.abort()
  }, [])

  return (
    <>
      <header><h1>Вітаю!</h1></header>
      <section className="card">
        <div className="row"><span>Шукаю контролер WLED у мережі</span><span>{Math.round(progress * 100)}%</span></div>
        <small className="hint">Телефон чи ПК мають бути в тій самій Wi-Fi мережі, що й стрічка</small>
        {found.map((f) => (
          <button key={f.ip} className="current" onClick={() => pick(f.ip)}>
            <span className="label"><small>{f.ip} · {f.leds} діодів</small>{f.name}</span>
            <span className="chev">›</span>
          </button>
        ))}
        {progress === 1 && !found.length && <small className="hint warn">Не знайшов. Введи адресу контролера вручну</small>}
      </section>
      <section className="card">
        <small className="hint">Або введи адресу, наприклад 192.168.1.50</small>
        <form className="name-row" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) pick(manual.trim()) }}>
          <input value={manual} onChange={(e) => setManual(e.target.value)} spellCheck={false} inputMode="decimal" aria-label="Адреса контролера" />
          <button type="submit">OK</button>
        </form>
      </section>
    </>
  )
}

function Count({ host, next }: { host: string; next(): void }) {
  const [draft, setDraft] = useState('')
  const [now, setNow] = useState<number>()
  const [waiting, setWaiting] = useState(false)
  const [sure, setSure] = useState(false)

  useEffect(() => {
    ledCount(host).then((n) => { setNow(n); setDraft(String(n)) }, () => {})
  }, [host])

  const go = async () => {
    const n = Math.round(+draft)
    if (!n || n < 1 || n > 1500) return
    if (n === now) return next()
    if (!sure) return setSure(true)
    setWaiting(true)
    const s = await loadSetup(host)
    await setLedCount(host, n, s.shift % n).catch(() => {})
    // The controller restarts with the new length; wait until it answers with it
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if ((await ledCount(host).catch(() => 0)) === n) break
    }
    next()
  }

  return (
    <>
      <header><h1>Стрічка</h1></header>
      <section className="card">
        <div className="row"><span>Скільки діодів у стрічці</span></div>
        <form className="name-row" onSubmit={(e) => { e.preventDefault(); go() }}>
          <input value={draft} onChange={(e) => { setSure(false); setDraft(e.target.value.replace(/\D/g, '')) }} inputMode="numeric" aria-label="Кількість діодів" />
          <button type="submit" disabled={waiting}>{waiting ? '…' : sure ? 'Так, змінити' : 'Далі'}</button>
        </form>
        <small className="hint">
          {sure ? `Контролер зараз на ${now} діодів. Змінити на ${draft}? Він перезапуститься` : waiting ? 'Контролер перезапускається з новою довжиною…' : 'Кількість указана на упаковці або в налаштуваннях WLED. Якщо світиться не вся стрічка, збільш її'}
        </small>
      </section>
    </>
  )
}

export function Wizard({ host, wled, needHost, setHost, finish }: {
  host?: string; wled?: Wled; needHost: boolean; setHost(ip: string): void; finish(): void
}) {
  const [step, setStep] = useState<'find' | 'count' | 'place'>(needHost ? 'find' : 'count')
  const [len, setLen] = useState<number>()
  const picked = useRef(false)

  // After a controller is picked: one that was set up before (e.g. from another phone) needs nothing more
  useEffect(() => {
    if (step !== 'count' || !host || !picked.current) return
    loadSetup(host).then((s) => { if (s.done) finish() }, () => {})
  }, [step, host, finish])

  useEffect(() => {
    if (step === 'place' && host) ledCount(host).then(setLen, () => {})
  }, [step, host])

  if (step === 'find') return <Find pick={(ip) => { picked.current = true; setHost(ip); setStep('count') }} />
  if (step === 'count' && host) return <Count host={host} next={() => setStep('place')} />
  if (step === 'place' && host && wled && len) {
    return <RoomCalibration wled={wled} host={host} len={len} title="Де стрічка" finish="Готово" back={() => setStep('count')} done={finish} />
  }
  return <header><h1>Зачекай…</h1></header>
}
