import { useLayoutEffect } from 'react'
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_MIN, INTERFACE_SCALE_MAX } from './display-sizes.js'
import { PREF_INTERFACE_SCALE, readStringPref, useNumberPref } from './prefs.js'

export function useInterfaceScale(): number {
  const [percent] = useNumberPref(PREF_INTERFACE_SCALE, DEFAULT_INTERFACE_SCALE, { min: INTERFACE_SCALE_MIN, max: INTERFACE_SCALE_MAX })
  return percent / 100
}

export function initializeInterfaceScale(): void {
  const stored = Number(readStringPref(PREF_INTERFACE_SCALE, String(DEFAULT_INTERFACE_SCALE)))
  const percent = Number.isFinite(stored)
    ? Math.min(INTERFACE_SCALE_MAX, Math.max(INTERFACE_SCALE_MIN, Math.round(stored)))
    : DEFAULT_INTERFACE_SCALE
  document.documentElement.style.setProperty('--ak-interface-scale', String(percent / 100))
}

export function InterfaceScale(): null {
  const scale = useInterfaceScale()
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--ak-interface-scale', String(scale))
  }, [scale])
  return null
}
