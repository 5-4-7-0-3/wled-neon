// Bridge exposed by electron/preload.cjs; absent on Android
interface DesktopBridge {
  getHost(): Promise<string>
  setHost(host: string): Promise<void>
  resize(height: number): void
  hide(): void
  // Fired by the main process when the Ukrainian anthem starts playing
  onFlag(cb: () => void): void
  getSettings(): Promise<DesktopSettings>
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>
  // The room setup on the controller changed; the live modes pick it up again
  setupChanged(): void
}

export interface ModeTuning {
  bright: number
  smooth?: number
  effects?: number
}

export interface GameEntry {
  name: string
  enabled: boolean
  profile: string | null
}

export interface DesktopSettings {
  anthem: boolean
  games: boolean
  autostart: boolean
  modes: { cinema: ModeTuning; game: ModeTuning; music: ModeTuning }
  // Games seen so far, by their exe path
  gameList: Record<string, GameEntry>
}

declare global {
  interface Window {
    neonDesktop?: DesktopBridge
  }
}

export const desktop = window.neonDesktop

const DEFAULT_HOST = '192.168.1.12'
const KEY = 'neon.host'

export async function getHost(): Promise<string> {
  if (desktop) return desktop.getHost()
  try {
    return localStorage.getItem(KEY) || DEFAULT_HOST
  } catch {
    return DEFAULT_HOST
  }
}

export async function setHost(host: string): Promise<void> {
  if (desktop) return desktop.setHost(host)
  try {
    localStorage.setItem(KEY, host)
  } catch {
    // Storage can be unavailable; the host then resets on restart
  }
}
