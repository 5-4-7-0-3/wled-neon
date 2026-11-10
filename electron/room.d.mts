export type Layout = 'room' | 'screen' | 'line'

export type Marks = Record<string, number>

export interface Setup {
  layout: Layout
  marks: Marks
  // First and last LED above the bed (room only), or null
  bed: [number, number] | null
  // How far the controller's LED map turns the strip
  shift: number
  balance: [number, number, number]
  // Set once the first-run setup has been gone through
  done: boolean
}

export interface Role {
  role: 'front' | 'side' | 'back' | 'bed' | 'edge' | 'off'
  x0?: number
  x1?: number
  y0?: number
  y1?: number
  t?: number
}

export interface Room {
  len: number
  center: number
  roles: Role[]
  d: number[]
  dir: number[]
  off: boolean[]
}

export const LAYOUTS: Layout[]
export function defaultMarks(layout: Layout, len: number): Marks
export function normalize(raw: unknown, len: number): Setup
export function problem(s: Setup, len: number): string | null
export function buildRoom(raw: unknown, len: number): Room
