/** Runtime flag injected at document start by the unprivileged Linux webview. */
export function isDesktopClient(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { __RUNLAB_DESKTOP__?: boolean }).__RUNLAB_DESKTOP__ === true
}
