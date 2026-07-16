import { useEffect, useState } from 'react'

const CHANGE_EVENT = 'ak-pref-change'

type PrefChangeDetail = { key: string; value: string | null }

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {}
  window.dispatchEvent(
    new CustomEvent<PrefChangeDetail>(CHANGE_EVENT, { detail: { key, value } }),
  )
}

/**
 * Read/write a boolean preference in localStorage. All hook instances mounted
 * against the same key stay in sync via a same-tab custom event and the
 * cross-tab `storage` event.
 */
export function useBooleanPref(
  key: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = readRaw(key)
    if (raw === null) return defaultValue
    return raw === '1' || raw === 'true'
  })

  useEffect(() => {
    const onCustom = (e: Event): void => {
      const detail = (e as CustomEvent<PrefChangeDetail>).detail
      if (detail.key !== key) return
      if (detail.value === null) {
        setValue(defaultValue)
        return
      }
      setValue(detail.value === '1' || detail.value === 'true')
    }
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      if (e.newValue === null) {
        setValue(defaultValue)
        return
      }
      setValue(e.newValue === '1' || e.newValue === 'true')
    }
    window.addEventListener(CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [key, defaultValue])

  const set = (next: boolean): void => {
    writeRaw(key, next ? '1' : '0')
    setValue(next)
  }

  return [value, set]
}

export function useNumberPref(
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): [number, (next: number) => void] {
  const normalize = (next: number): number => {
    if (!Number.isFinite(next)) return defaultValue
    const rounded = Math.round(next)
    const min = options.min ?? Number.NEGATIVE_INFINITY
    const max = options.max ?? Number.POSITIVE_INFINITY
    return Math.min(max, Math.max(min, rounded))
  }
  const parse = (raw: string | null): number => {
    if (raw === null) return defaultValue
    return normalize(Number(raw))
  }
  const [value, setValue] = useState<number>(() => parse(readRaw(key)))

  useEffect(() => {
    const onCustom = (e: Event): void => {
      const detail = (e as CustomEvent<PrefChangeDetail>).detail
      if (detail.key !== key) return
      setValue(parse(detail.value))
    }
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      setValue(parse(e.newValue))
    }
    window.addEventListener(CHANGE_EVENT, onCustom)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom)
      window.removeEventListener('storage', onStorage)
    }
  }, [key, defaultValue, options.min, options.max])

  const set = (next: number): void => {
    const normalized = normalize(next)
    writeRaw(key, String(normalized))
    setValue(normalized)
  }

  return [value, set]
}

export const PREF_SHOW_TOOL_CALL_TAB = 'ak-show-tool-call-tab'
export const PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT = 'ak-live-tool-activity-tail-count'
export const PREF_EXPLORER_OPEN = 'ak-explorer-open'
export const PREF_INSPECTOR_OPEN = 'ak-inspector-open'
export const PREF_TOPBAR_OPEN = 'ak-topbar-open'
export const PREF_CHAT_FONT_SIZE = 'ak-chat-font-size'
export const PREF_CHAT_CONTENT_WIDTH = 'ak-chat-content-width'
export const PREF_CHAT_SIDE_SPACE = 'ak-chat-side-space'
export const PREF_CHAT_LINE_HEIGHT = 'ak-chat-line-height'
export const PREF_CHAT_MATH_SCALE = 'ak-chat-math-scale'
export const DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT = 3
export const DEFAULT_CHAT_FONT_SIZE = 3
export const DEFAULT_CHAT_CONTENT_WIDTH = 1
export const DEFAULT_CHAT_SIDE_SPACE = 1
export const DEFAULT_CHAT_LINE_HEIGHT = 1
export const DEFAULT_CHAT_MATH_SCALE = 2
