import { useLayoutEffect } from 'react'
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_MIN, INTERFACE_SCALE_MAX, interfaceDensityForPercent, interfaceScaleForPercent } from './display-sizes.js'
import { PREF_INTERFACE_SCALE, readStringPref, useNumberPref } from './prefs.js'

export function useInterfaceScale(): number {
  const [percent] = useNumberPref(PREF_INTERFACE_SCALE, DEFAULT_INTERFACE_SCALE, { min: INTERFACE_SCALE_MIN, max: INTERFACE_SCALE_MAX })
  return interfaceScaleForPercent(percent)
}

export function initializeInterfaceScale(): void {
  const stored = Number(readStringPref(PREF_INTERFACE_SCALE, String(DEFAULT_INTERFACE_SCALE)))
  const percent = Number.isFinite(stored)
    ? Math.min(INTERFACE_SCALE_MAX, Math.max(INTERFACE_SCALE_MIN, Math.round(stored)))
    : DEFAULT_INTERFACE_SCALE
  applyInterfaceScale(percent)
}

export function InterfaceScale(): null {
  const [percent] = useNumberPref(PREF_INTERFACE_SCALE, DEFAULT_INTERFACE_SCALE, { min: INTERFACE_SCALE_MIN, max: INTERFACE_SCALE_MAX })
  useLayoutEffect(() => {
    applyInterfaceScale(percent)
  }, [percent])
  return null
}

function applyInterfaceScale(percent: number): void {
  document.documentElement.dataset.akInterfaceDensity = interfaceDensityForPercent(percent)
  document.documentElement.style.setProperty('--ak-interface-scale', String(interfaceScaleForPercent(percent)))
}
