import { describe, expect, it } from 'vitest'

import {
  DASHBOARD_PREFERENCES,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_FILE_VIEW_FONT_SIZE,
  DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_CHAT_FONT_SIZE,
  PREF_FILE_VIEW_FONT_SIZE,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  dashboardPreferenceDefinitions,
  numberPreferenceOptions,
} from './prefs.js'

describe('dashboard preference registry', () => {
  it('keeps storage keys unique', () => {
    const keys = dashboardPreferenceDefinitions().map((definition) => definition.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps number defaults inside their configured bounds', () => {
    for (const definition of dashboardPreferenceDefinitions()) {
      if (definition.type !== 'number') continue
      if (definition.min !== undefined) expect(definition.defaultValue).toBeGreaterThanOrEqual(definition.min)
      if (definition.max !== undefined) expect(definition.defaultValue).toBeLessThanOrEqual(definition.max)
    }
  })

  it('exports legacy constants from the registry source of truth', () => {
    expect(PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT).toBe(DASHBOARD_PREFERENCES.liveToolActivityTailCount.key)
    expect(DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT).toBe(DASHBOARD_PREFERENCES.liveToolActivityTailCount.defaultValue)
    expect(PREF_CHAT_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.chatFontSize.key)
    expect(DEFAULT_CHAT_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.chatFontSize.defaultValue)
    expect(PREF_FILE_VIEW_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.fileViewFontSize.key)
    expect(DEFAULT_FILE_VIEW_FONT_SIZE).toBe(DASHBOARD_PREFERENCES.fileViewFontSize.defaultValue)
  })

  it('derives number hook bounds from number definitions', () => {
    expect(numberPreferenceOptions(DASHBOARD_PREFERENCES.sessionViewCacheMaxMb)).toEqual({ min: 0, max: 4096 })
  })
})
