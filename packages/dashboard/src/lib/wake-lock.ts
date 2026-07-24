import { useEffect, useState } from 'react'

export function wakeLockSupported(navigatorValue: Navigator = navigator): boolean {
  return 'wakeLock' in navigatorValue && typeof navigatorValue.wakeLock?.request === 'function'
}

export function useScreenWakeLock(enabled: boolean): { supported: boolean; active: boolean } {
  const supported = wakeLockSupported()
  const [active, setActive] = useState(false)

  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null
    let disposed = false

    const release = async (): Promise<void> => {
      const current = sentinel
      sentinel = null
      setActive(false)
      if (current && !current.released) await current.release().catch(() => {})
    }
    const acquire = async (): Promise<void> => {
      if (!enabled || !supported || document.visibilityState !== 'visible' || sentinel) return
      try {
        const next = await navigator.wakeLock.request('screen')
        if (disposed || !enabled || document.visibilityState !== 'visible') {
          await next.release().catch(() => {})
          return
        }
        sentinel = next
        setActive(true)
        next.addEventListener('release', () => {
          if (sentinel === next) sentinel = null
          setActive(false)
        }, { once: true })
      } catch {
        setActive(false)
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void acquire()
      else void release()
    }

    if (enabled) void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      void release()
    }
  }, [enabled, supported])

  return { supported, active }
}
