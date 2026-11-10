import type { Layout } from '../electron/room.mjs'

// A drawing of where the strip runs, seen from above with the monitor at the top, in the same
// colours the real strip shows during calibration. Each dot stands for one spot in the room, and
// the user puts it on the LED that is really there.

type Point = [number, number]

const SPOTS: Record<Layout, Record<string, Point>> = {
  room: { fl: [36, 28], fr: [264, 28], bl: [36, 192], br: [264, 192], monitor: [150, 28], bed0: [105, 192], bed1: [195, 192] },
  screen: { tl: [50, 36], tr: [250, 36], br: [250, 176], bl: [50, 176] },
  line: { l: [30, 130], r: [270, 130], monitor: [150, 130] },
}

const FRONT = '#3b7bff', LEFT = '#2fd07a', BACK = '#b04dff', RIGHT = '#ff9a3c', BED = '#ffc233'

function Wall({ from, to, color, wide = 7 }: { from: Point; to: Point; color: string; wide?: number }) {
  return <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke={color} strokeWidth={wide} strokeLinecap="round" />
}

function Monitor({ x, y }: { x: number; y: number }) {
  return (
    <g className="map-thing">
      <rect x={x - 34} y={y} width={68} height={12} rx={3} />
      <text x={x} y={y + 28}>монітор</text>
    </g>
  )
}

interface Props {
  layout: Layout
  hasBed: boolean
  marks: { key: string; name: string }[]
  selected: string
  placed: Set<string>
  led(key: string): number
  select(key: string): void
}

export function RoomMap({ layout, hasBed, marks, selected, placed, led, select }: Props) {
  const p = SPOTS[layout]
  return (
    <svg className="map" viewBox="0 0 300 220" role="group" aria-label="Схема розташування стрічки">
      {layout === 'room' && (
        <>
          <Wall from={p.fl} to={p.fr} color={FRONT} />
          <Wall from={p.fl} to={p.bl} color={LEFT} />
          <Wall from={p.bl} to={p.br} color={BACK} />
          <Wall from={p.fr} to={p.br} color={RIGHT} />
          {hasBed && <Wall from={p.bed0} to={p.bed1} color={BED} wide={11} />}
          <Monitor x={150} y={62} />
          {hasBed && <text className="map-label" x={150} y={176}>ліжко</text>}
          <text className="map-label" x={150} y={122}>кімната зверху</text>
        </>
      )}
      {layout === 'screen' && (
        <>
          <rect className="map-screen" x={50} y={36} width={200} height={140} rx={4} stroke={FRONT} />
          <text className="map-label" x={150} y={110}>екран</text>
        </>
      )}
      {layout === 'line' && (
        <>
          <Wall from={p.l} to={p.r} color={FRONT} />
          <Monitor x={150} y={76} />
        </>
      )}
      {marks.map((m, i) => {
        const [x, y] = p[m.key]
        const on = m.key === selected
        const set = placed.has(m.key)
        return (
          <g
            key={m.key} role="button" tabIndex={0} aria-label={m.name} aria-pressed={on}
            className={on ? 'dot-mark on' : set ? 'dot-mark set' : 'dot-mark'}
            onClick={() => select(m.key)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') select(m.key) }}
          >
            {/* A finger needs more room than the dot shows */}
            <circle className="hit" cx={x} cy={y} r={20} />
            {on && <circle className="ring" cx={x} cy={y} r={13} />}
            <circle className="body" cx={x} cy={y} r={11} />
            <text x={x} y={y + 4}>{set && !on ? '✓' : i + 1}</text>
            {set && (
              <text className="num" x={layout !== 'line' && x < 100 ? x + 24 : layout !== 'line' && x > 200 ? x - 24 : x} y={y < 110 ? y + 26 : y - 18}>
                {led(m.key)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
