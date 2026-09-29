/** Runtime flag injected at document start by the unprivileged Linux webview. */
export function isDesktopClient(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { __KALA_DESKTOP__?: boolean }).__KALA_DESKTOP__ === true
}

type DesktopConnection = { confirmConnection(): Promise<void> }

/** Available even when remote HTTP is intentionally denied native desktop integration. */
export function getDesktopConnection(): DesktopConnection | null {
  if (!isDesktopClient()) return null
  const value: unknown = (window as Window & { __KALA_DESKTOP_CONNECTION__?: unknown }).__KALA_DESKTOP_CONNECTION__
  if (!value || typeof value !== 'object' || typeof (value as { confirmConnection?: unknown }).confirmConnection !== 'function') return null
  return value as DesktopConnection
}
