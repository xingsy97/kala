import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HIDDEN_WORKSPACES_STORAGE_KEY } from './hidden-workspaces.js'
import { useHiddenWorkspaces } from './useHiddenWorkspaces.js'

describe('useHiddenWorkspaces', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  it('starts empty when nothing is persisted', () => {
    const { result } = renderHook(() => useHiddenWorkspaces())
    expect(result.current.count).toBe(0)
    expect(result.current.isHidden('ws-a')).toBe(false)
  })

  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem(
      HIDDEN_WORKSPACES_STORAGE_KEY,
      JSON.stringify({ version: 1, ids: ['ws-a', 'ws-b'] }),
    )
    const { result } = renderHook(() => useHiddenWorkspaces())
    expect(result.current.count).toBe(2)
    expect(result.current.isHidden('ws-a')).toBe(true)
    expect(result.current.isHidden('ws-c')).toBe(false)
  })

  it('hide/unhide toggles state and persists', () => {
    const { result } = renderHook(() => useHiddenWorkspaces())
    act(() => result.current.hide('ws-a'))
    expect(result.current.isHidden('ws-a')).toBe(true)
    expect(window.localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)).toContain('ws-a')

    act(() => result.current.unhide('ws-a'))
    expect(result.current.isHidden('ws-a')).toBe(false)
    // Empty set clears the key to keep localStorage tidy.
    expect(window.localStorage.getItem(HIDDEN_WORKSPACES_STORAGE_KEY)).toBeNull()
  })

  it('ignores duplicate hide calls and empty ids', () => {
    const { result } = renderHook(() => useHiddenWorkspaces())
    act(() => result.current.hide('ws-a'))
    const first = result.current.hiddenIds
    act(() => result.current.hide('ws-a'))
    // Same reference means React would skip a re-render - proves we no-oped.
    expect(result.current.hiddenIds).toBe(first)
    act(() => result.current.hide(''))
    expect(result.current.hiddenIds).toBe(first)
  })

  it('reacts to storage events from other tabs', () => {
    const { result } = renderHook(() => useHiddenWorkspaces())
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: HIDDEN_WORKSPACES_STORAGE_KEY,
          newValue: JSON.stringify({ version: 1, ids: ['ws-x'] }),
        }),
      )
    })
    expect(result.current.isHidden('ws-x')).toBe(true)
  })

  it('ignores storage events for unrelated keys', () => {
    const { result } = renderHook(() => useHiddenWorkspaces())
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'unrelated',
          newValue: JSON.stringify({ version: 1, ids: ['ws-x'] }),
        }),
      )
    })
    expect(result.current.count).toBe(0)
  })

  it('clears state when another tab clears localStorage', () => {
    window.localStorage.setItem(
      HIDDEN_WORKSPACES_STORAGE_KEY,
      JSON.stringify({ version: 1, ids: ['ws-a'] }),
    )
    const { result } = renderHook(() => useHiddenWorkspaces())
    expect(result.current.isHidden('ws-a')).toBe(true)

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }))
    })

    expect(result.current.count).toBe(0)
    expect(result.current.isHidden('ws-a')).toBe(false)
  })
})
