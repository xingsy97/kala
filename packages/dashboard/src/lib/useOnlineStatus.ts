/**
 * Online-status hook.
 *
 * `navigator.onLine` is famously optimistic — Chrome only flips it when the
 * OS confirms no interface has connectivity, which misses captive-portal /
 * dead-uplink cases entirely. We therefore combine three signals:
 *
 *  1. `navigator.onLine` + online/offline events (fast, coarse).
 *  2. A periodic HEAD probe against the SW-provided health endpoint
 *     (`/manifest.webmanifest` — always cached, tiny, guaranteed by the
 *     host static server; using it avoids adding a host route just for the
 *     health check).
 *  3. Global `fetch` failures raised through the imperative `reportOffline`
 *     helper so any component that noticed a real API error can nudge the
 *     hook without waiting for the next probe.
 *
 * Consumers read `{ online, lastCheckedAt }` and can call `refresh()` to
 * force an immediate probe.
 */

import { useCallback, useEffect, useState } from 'react'

type Listener = (online: boolean) => void

const listeners = new Set<Listener>()
let cachedOnline = typeof navigator === 'undefined' ? true : navigator.onLine
let lastReport = 0

function broadcast(next: boolean): void {
  cachedOnline = next
  lastReport = Date.now()
  listeners.forEach((listener) => listener(next))
}

/**
 * Notify the hook that we just observed a real network failure. Components
 * that own critical fetch/websocket paths call this instead of waiting for
 * the next probe cycle.
 */
export function reportOffline(): void {
  if (cachedOnline) broadcast(false)
}

async function probeOnce(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/manifest.webmanifest', {
      method: 'HEAD',
      cache: 'no-store',
      signal,
    })
    return res.ok
  } catch {
    return false
  }
}

const PROBE_INTERVAL_ONLINE_MS = 60_000
const PROBE_INTERVAL_OFFLINE_MS = 8_000

export type OnlineStatus = {
  online: boolean
  lastCheckedAt: number
  refresh: () => void
}

export function useOnlineStatus(): OnlineStatus {
  const [online, setOnline] = useState<boolean>(cachedOnline)
  const [lastCheckedAt, setLastCheckedAt] = useState<number>(lastReport)

  const refresh = useCallback((): void => {
    const controller = new AbortController()
    void probeOnce(controller.signal).then((next) => {
      broadcast(next)
      setLastCheckedAt(Date.now())
    })
  }, [])

  useEffect(() => {
    const listener: Listener = (next) => {
      setOnline(next)
      setLastCheckedAt(Date.now())
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleOnline = (): void => broadcast(true)
    const handleOffline = (): void => broadcast(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const schedule = (): void => {
      const delay = cachedOnline ? PROBE_INTERVAL_ONLINE_MS : PROBE_INTERVAL_OFFLINE_MS
      timer = setTimeout(async () => {
        if (cancelled) return
        const next = await probeOnce(controller.signal)
        if (cancelled) return
        if (next !== cachedOnline) broadcast(next)
        setLastCheckedAt(Date.now())
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }, [])

  return { online, lastCheckedAt, refresh }
}
