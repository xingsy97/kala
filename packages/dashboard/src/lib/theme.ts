import { useEffect, useState } from 'react'
import { applyCurrentVSCodeTheme, VSCODE_THEME_CHANGE_EVENT } from '../theme/vscode-theme.js'
import { PREF_THEME } from './prefs.js'

export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'

const THEME_STORAGE_KEY = PREF_THEME
const THEME_CHANGE_EVENT = 'ak-theme-change'

/**
 * Shared theme hook. Persists to `localStorage['ak-theme']` and toggles the
 * `dark` class on `document.documentElement`. Consumed by both the app shell
 * (which no longer renders a top-bar toggle) and `SettingsDialog` (which now
 * owns the user-visible control).
 */
export function useTheme(): [ThemePreference, () => void, (theme: ThemePreference) => void, Theme] {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference())
  const [systemTheme, setSystemTheme] = useState<Theme>(() => systemThemeNow())

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystemTheme(media.matches ? 'dark' : 'light')
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onThemePreferenceChange = (): void => setPreference(readThemePreference())
    window.addEventListener('storage', onThemePreferenceChange)
    window.addEventListener(THEME_CHANGE_EVENT, onThemePreferenceChange)
    return () => {
      window.removeEventListener('storage', onThemePreferenceChange)
      window.removeEventListener(THEME_CHANGE_EVENT, onThemePreferenceChange)
    }
  }, [])

  const effectiveTheme = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    applyCurrentVSCodeTheme(effectiveTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference)
    } catch {}
  }, [effectiveTheme, preference])

  useEffect(() => {
    const onVSCodeThemeChange = (): void => {
      applyCurrentVSCodeTheme(effectiveTheme)
    }
    window.addEventListener(VSCODE_THEME_CHANGE_EVENT, onVSCodeThemeChange)
    return () => window.removeEventListener(VSCODE_THEME_CHANGE_EVENT, onVSCodeThemeChange)
  }, [effectiveTheme])

  const setThemePreference = (next: ThemePreference): void => {
    setPreference(next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {}
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  }

  return [
    preference,
    () => setThemePreference(effectiveTheme === 'dark' ? 'light' : 'dark'),
    setThemePreference,
    effectiveTheme,
  ]
}

function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {}
  return 'system'
}

function systemThemeNow(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function initializeTheme(): void {
  const preference = readThemePreference()
  const effective = preference === 'system' ? systemThemeNow() : preference
  applyCurrentVSCodeTheme(effective)
}
