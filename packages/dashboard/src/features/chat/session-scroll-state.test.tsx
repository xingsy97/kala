import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearSessionScrollStatesForTest,
  deleteSessionScrollState,
  readSessionScrollState,
  useSessionPinnedState,
} from './session-scroll-state.js'

describe('session scroll state', () => {
  beforeEach(clearSessionScrollStatesForTest)

  it('restores pinned state independently for each session', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionPinnedState(sessionId),
      { initialProps: { sessionId: 'a' as string | null } },
    )
    act(() => result.current.setPinned(false))

    rerender({ sessionId: 'b' })
    expect(result.current.pinned).toBe(true)

    rerender({ sessionId: 'a' })
    expect(result.current.pinned).toBe(false)
  })

  it('forgets state when a session is deleted', () => {
    const { result } = renderHook(() => useSessionPinnedState('a'))
    act(() => result.current.setPinned(false))
    deleteSessionScrollState('a')
    expect(readSessionScrollState('a').pinned).toBe(true)
  })
})
