import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePushActivityHeartbeat } from './push-activity.js'

describe('usePushActivityHeartbeat', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports a focused visible page active and refreshes every 15 seconds', () => {
    renderHook(() => usePushActivityHeartbeat())
    expect(lastPayload()).toMatchObject({ active: true })

    act(() => { vi.advanceTimersByTime(15_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lastPayload()).toMatchObject({ active: true })
  })

  it('reports inactive immediately when the window loses focus', () => {
    renderHook(() => usePushActivityHeartbeat())
    vi.mocked(document.hasFocus).mockReturnValue(false)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(lastPayload()).toMatchObject({ active: false })
  })

  it('reports inactive after five minutes without user interaction', () => {
    renderHook(() => usePushActivityHeartbeat())
    act(() => { vi.advanceTimersByTime(5 * 60_000 + 15_000) })
    expect(lastPayload()).toMatchObject({ active: false })
  })

  function lastPayload(): { deviceId: string; active: boolean } {
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    return JSON.parse(String(init.body)) as { deviceId: string; active: boolean }
  }
})
