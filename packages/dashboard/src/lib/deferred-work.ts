export type DeferredWorkHandle = {
  cancel(): void
}

export function scheduleDeferredWork(work: () => void, timeout = 750): DeferredWorkHandle {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    const idleWindow = window as Window & typeof globalThis & {
      requestIdleCallback(callback: IdleRequestCallback, options?: IdleRequestOptions): number
      cancelIdleCallback(handle: number): void
    }
    const handle = idleWindow.requestIdleCallback(work, { timeout })
    return { cancel: () => idleWindow.cancelIdleCallback(handle) }
  }
  const handle = globalThis.setTimeout(work, Math.min(timeout, 100))
  return { cancel: () => globalThis.clearTimeout(handle) }
}
