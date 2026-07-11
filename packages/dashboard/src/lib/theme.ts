import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

/**
 * Shared theme hook. Persists to `localStorage['ak-theme']` and toggles the
 * `dark` class on `document.documentElement`. Consumed by both the app shell
 * (which no longer renders a top-bar toggle) and `SettingsDialog` (which now
 * owns the user-visible control).
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('ak-theme')
      if (stored === 'light' || stored === 'dark') return stored
    } catch {}
    return 'dark'
  })
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    try {
      localStorage.setItem('ak-theme', theme)
    } catch {}
  }, [theme])
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}
