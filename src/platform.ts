// Bridge exposed by electron/preload.cjs; absent on Android
interface DesktopBridge {
  getHost(): Promise<string>
  setHost(host: string): Promise<void>
  resize(height: number): void
  hide(): void
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
