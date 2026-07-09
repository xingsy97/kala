import { useCallback, useEffect, useState } from 'react'

export type ComposerMode = 'full' | 'simple'

const STORAGE_KEY = 'ak-composer-mode'

function readInitialMode(): ComposerMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'simple' || raw === 'full') return raw
  } catch {}
  return 'full'
}

function isTogglingShortcut(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase()
  if (key !== 'm') return false
  if (!e.shiftKey) return false
  return e.metaKey || e.ctrlKey
}

export function useComposerMode(): {
  mode: ComposerMode
  setMode(next: ComposerMode): void
  toggle(): void
} {
  const [mode, setModeState] = useState<ComposerMode>(readInitialMode)

  const setMode = useCallback((next: ComposerMode) => {
    setModeState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
  }, [])

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next = prev === 'full' ? 'simple' : 'full'
      try { localStorage.setItem(STORAGE_KEY, next) } catch {}
      return next
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isTogglingShortcut(e)) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  return { mode, setMode, toggle }
}
