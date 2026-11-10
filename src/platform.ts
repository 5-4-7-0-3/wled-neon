// Bridge exposed by electron/preload.cjs; absent on Android
interface DesktopBridge {
  getHost(): Promise<string>
  // WLED controllers that answer on the PC's own networks
  findControllers(): Promise<{ ip: string; name: string; leds: number }[]>
  setHost(host: string): Promise<void>
  resize(height: number): void
  hide(): void
  // Keeps the popup open when it loses focus, while the user is looking at the strip
  pin(on: boolean): void
  // Swaps the tray popup for an ordinary resizable window
  openWindow(): void
  // The ordinary window is being closed while a calibration screen is open; returns the unsubscribe
  onLeave(cb: () => void): () => void
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
export const windowed = new URLSearchParams(location.search).has('window')

// Empty until the first-run setup finds the controller
const DEFAULT_HOST = ''
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
