import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useScreenWakeLock, wakeLockSupported } from './wake-lock.js'

describe('screen wake lock', () => {
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')

  afterEach(() => {
    vi.unstubAllGlobals()
    if (visibility) Object.defineProperty(Document.prototype, 'visibilityState', visibility)
  })

  it('reports unsupported browsers without requesting a lock', () => {
    expect(wakeLockSupported({} as Navigator)).toBe(false)
  })

  it('acquires while enabled and visible, releases while hidden, and reacquires when visible', async () => {
    let visible: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible })
    const sentinels = [wakeLockSentinel(), wakeLockSentinel()]
    const request = vi.fn(async () => sentinels.shift()!.sentinel)
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })

    const { result, rerender, unmount } = renderHook(({ enabled }) => useScreenWakeLock(enabled), { initialProps: { enabled: true } })
    await waitFor(() => expect(result.current.active).toBe(true))
    expect(request).toHaveBeenCalledWith('screen')

    visible = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(result.current.active).toBe(false))
    expect(sentinels).toHaveLength(1)

    visible = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(result.current.active).toBe(true))
    expect(request).toHaveBeenCalledTimes(2)

    rerender({ enabled: false })
    await waitFor(() => expect(result.current.active).toBe(false))
    unmount()
  })
})

function wakeLockSentinel() {
  const target = new EventTarget()
  let released = false
  const sentinel = Object.assign(target, {
    get released() { return released },
    type: 'screen' as WakeLockType,
    async release() {
      if (released) return
      released = true
      target.dispatchEvent(new Event('release'))
    },
    onrelease: null,
  }) as WakeLockSentinel
  return { sentinel }
}
