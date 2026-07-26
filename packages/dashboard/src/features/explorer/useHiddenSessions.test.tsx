import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PREF_HIDDEN_SESSIONS } from '../../lib/prefs.js'
import { useHiddenSessions } from './useHiddenSessions.js'

describe('useHiddenSessions', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => window.localStorage.clear())

  it('starts empty when nothing is persisted', () => {
    const { result } = renderHook(() => useHiddenSessions())
    expect(result.current.count).toBe(0)
    expect(result.current.isHidden('s-a')).toBe(false)
  })

  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem(
      PREF_HIDDEN_SESSIONS,
      JSON.stringify({ version: 1, ids: ['s-a', 's-b'] }),
    )
    const { result } = renderHook(() => useHiddenSessions())
    expect(result.current.count).toBe(2)
    expect(result.current.isHidden('s-a')).toBe(true)
    expect(result.current.isHidden('s-c')).toBe(false)
  })

  it('hide/unhide toggles state and persists under the sessions key', () => {
    const { result } = renderHook(() => useHiddenSessions())
    act(() => result.current.hide('s-a'))
    expect(result.current.isHidden('s-a')).toBe(true)
    expect(window.localStorage.getItem(PREF_HIDDEN_SESSIONS)).toContain('s-a')

    act(() => result.current.unhide('s-a'))
    expect(result.current.isHidden('s-a')).toBe(false)
    // Empty set clears the key to keep localStorage tidy.
    expect(window.localStorage.getItem(PREF_HIDDEN_SESSIONS)).toBeNull()
  })

  it('does not collide with the hidden-workspaces key', () => {
    const { result } = renderHook(() => useHiddenSessions())
    act(() => result.current.hide('s-a'))
    expect(window.localStorage.getItem('ak-hidden-workspaces')).toBeNull()
  })
})
